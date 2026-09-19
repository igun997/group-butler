package main

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestBuildOutboundSendUsesAssignedGroupAndTrimmedText(t *testing.T) {
	send, err := buildOutboundSend(outboundText{GroupJID: "120363043123456789@g.us", Text: "  Hello team  "})
	if err != nil {
		t.Fatalf("buildOutboundSend: %v", err)
	}
	if want := "120363043123456789@g.us"; send.ChatID != want {
		t.Fatalf("ChatID = %q, want %q", send.ChatID, want)
	}
	if want := "Hello team"; send.Text != want {
		t.Fatalf("Text = %q, want %q", send.Text, want)
	}
	if send.Reply != (quotedMessage{}) {
		t.Fatalf("Reply = %+v, want none", send.Reply)
	}
}

// A row whose chat is a user is a direct chat: the message goes to that user JID
// itself, which for an owner DM is the owner's own JID.
func TestBuildOutboundSendAddressesDirectChat(t *testing.T) {
	const owner = "628990000009@s.whatsapp.net"
	send, err := buildOutboundSend(outboundText{GroupJID: owner, ChatKind: chatKindUser, Text: "  Hello owner  "})
	if err != nil {
		t.Fatalf("buildOutboundSend: %v", err)
	}
	if send.ChatID != owner {
		t.Fatalf("ChatID = %q, want %q", send.ChatID, owner)
	}
	if want := "Hello owner"; send.Text != want {
		t.Fatalf("Text = %q, want %q", send.Text, want)
	}
}

// The absent chat kind is the group kind, so every row written before the field
// existed keeps dispatching to its group.
func TestBuildOutboundSendKeepsGroupRowsOnTheGroupBranch(t *testing.T) {
	const group = "120363043123456789@g.us"
	for _, request := range []outboundText{
		{GroupJID: group, Text: "hi"},
		{GroupJID: group, ChatKind: chatKindGroup, Text: "hi"},
	} {
		send, err := buildOutboundSend(request)
		if err != nil {
			t.Fatalf("buildOutboundSend(%+v): %v", request, err)
		}
		if send.ChatID != group {
			t.Fatalf("ChatID = %q, want %q", send.ChatID, group)
		}
	}
}

// Each kind still refuses the other's JID, so a mislabelled row can never send a
// group message into a private chat or the reverse.
func TestBuildOutboundSendRefusesMismatchedChatKinds(t *testing.T) {
	for _, request := range []outboundText{
		{GroupJID: "120363043123456789@g.us", ChatKind: chatKindUser, Text: "hi"},
		{GroupJID: "628990000009@s.whatsapp.net", ChatKind: chatKindGroup, Text: "hi"},
		{GroupJID: "628990000009@s.whatsapp.net", Text: "hi"},
		{GroupJID: "120363043123456789@g.us", ChatKind: "channel", Text: "hi"},
	} {
		if _, err := buildOutboundSend(request); err == nil {
			t.Fatalf("buildOutboundSend(%+v) succeeded", request)
		}
	}
}

// A send that answers a message leaves as a quoted reply, and both halves of the
// quote come from the caller — this builder never invents the message a send is
// answering, and it canonicalizes the address it hands the bridge.
func TestBuildOutboundSendQuotesTheMessageBeingAnswered(t *testing.T) {
	const group = "120363043123456789@g.us"
	send, err := buildOutboundSend(outboundText{
		GroupJID: group, Text: "  Answered  ",
		Quote: quotedMessage{ID: "3EB0OWNER", Participant: "628990000001:3@s.whatsapp.net"},
	})
	if err != nil {
		t.Fatalf("buildOutboundSend: %v", err)
	}
	if send.ChatID != group {
		t.Fatalf("ChatID = %q, want %q", send.ChatID, group)
	}
	if send.Reply.ID != "3EB0OWNER" {
		t.Errorf("reply id = %q, want the id being answered", send.Reply.ID)
	}
	if want := "628990000001@s.whatsapp.net"; send.Reply.Participant != want {
		t.Errorf("reply participant = %q, want %q", send.Reply.Participant, want)
	}
}

// A send with nothing to answer stays a plain send: no reply target is invented
// for a row that carries no provenance.
func TestBuildOutboundSendWithoutAQuoteKeepsAPlainSend(t *testing.T) {
	send, err := buildOutboundSend(outboundText{GroupJID: "120363043123456789@g.us", Text: "Hello team"})
	if err != nil {
		t.Fatalf("buildOutboundSend: %v", err)
	}
	if send.Reply != (quotedMessage{}) {
		t.Errorf("Reply = %+v, want none", send.Reply)
	}
}

// A quote missing its id or its sender is refused before any call: a half-built
// quote would be sent as a reply no WhatsApp client can resolve, and the send
// would look delivered while saying less than the row asked for.
func TestBuildOutboundSendRefusesAnIncompleteQuote(t *testing.T) {
	const group = "120363043123456789@g.us"
	for _, request := range []outboundText{
		{GroupJID: group, Text: "hi", Quote: quotedMessage{ID: "3EB0OWNER"}},
		{GroupJID: group, Text: "hi", Quote: quotedMessage{Participant: "628990000001@s.whatsapp.net"}},
		{GroupJID: group, Text: "hi", Quote: quotedMessage{ID: "3EB0OWNER", Participant: "not a jid"}},
	} {
		if _, err := buildOutboundSend(request); err == nil {
			t.Fatalf("buildOutboundSend(%+v) succeeded", request)
		}
	}
}

func TestBuildOutboundSendRejectsUnsafeTargets(t *testing.T) {
	for _, request := range []outboundText{
		{GroupJID: "not a jid", Text: "hello"},
		{GroupJID: "120363043123456789@g.us", Text: " \t "},
	} {
		if _, err := buildOutboundSend(request); err == nil {
			t.Fatalf("buildOutboundSend(%+v) succeeded", request)
		}
	}
}

// sendBridge wires a manager whose bridge is this server, which is all a send needs
// now: the session that used to be checked for liveness lives in Hermes, and the
// acknowledgement comes back as the id the bridge assigned.
func sendBridge(t *testing.T) (*manager, *fakeBridge) {
	t.Helper()
	bridge := newFakeBridge(t).answering(http.StatusOK, `{"success":true,"messageId":"`+sentMessageID+`","messageIds":["`+sentMessageID+`"]}`)
	return bridge.manager(t, newFakeGroupStore(), newFakeInstanceRepo()), bridge
}

// The dispatcher hands `sendText` the stored row, so this drives the stored row
// through the same function the dispatcher calls and reads the chat the bridge was
// asked to send to.
func TestSendTextDeliversDirectChatToTheChatJID(t *testing.T) {
	mgr, bridge := sendBridge(t)
	const owner = "628990000009@s.whatsapp.net"

	id, err := mgr.sendText(context.Background(), dispatchRequest{
		ID: "send_123", InstanceID: "inst_1", GroupJID: owner, ChatKind: chatKindUser, Text: "  ping  ",
	}, quotedMessage{})
	if err != nil {
		t.Fatalf("sendText: %v", err)
	}
	if id != "wa_sent_1" {
		t.Errorf("message id = %q, want the id the bridge assigned", id)
	}
	call := bridge.only(t)
	if call.path != "/send" {
		t.Fatalf("call = %s, want POST /send", call.path)
	}
	if call.body["chatId"] != owner {
		t.Errorf("chatId = %v, want %q", call.body["chatId"], owner)
	}
	if call.body["message"] != "ping" {
		t.Errorf("message = %v, want the trimmed text", call.body["message"])
	}
	if _, ok := call.body["replyTo"]; ok {
		t.Errorf("replyTo = %v, want none for a send that answers nothing", call.body["replyTo"])
	}
}

// The dispatcher resolves the message a send answers and hands it to `sendText`
// with the request, so this drives both through the function the dispatcher calls
// and reads the reply the bridge was asked for.
func TestSendTextQuotesTheMessageItAnswers(t *testing.T) {
	mgr, bridge := sendBridge(t)
	const (
		group       = "120363043123456789@g.us"
		participant = "628990000001@s.whatsapp.net"
	)

	id, err := mgr.sendText(context.Background(), dispatchRequest{
		ID: "send_123", InstanceID: "inst_1", GroupJID: group, Text: "Answered",
	}, quotedMessage{ID: "3EB0OWNER", Participant: participant})
	if err != nil {
		t.Fatalf("sendText: %v", err)
	}
	if id != "wa_sent_1" {
		t.Errorf("message id = %q, want the id the bridge assigned", id)
	}
	call := bridge.only(t)
	if !equalJSON(call.body["replyTo"], map[string]any{"messageId": "3EB0OWNER", "participant": participant}) {
		t.Errorf("replyTo = %#v, want the message and its author", call.body["replyTo"])
	}
}

// A group row is untouched by the direct-chat branch — it stays on its group — and
// a row whose JID contradicts its kind is refused before the bridge is called.
func TestSendTextKeepsGroupRowsOnTheGroupBranch(t *testing.T) {
	mgr, bridge := sendBridge(t)
	const group = "120363043123456789@g.us"

	if _, err := mgr.sendText(context.Background(), dispatchRequest{ID: "send_123", GroupJID: group, Text: "hi"}, quotedMessage{}); err != nil {
		t.Fatalf("sendText: %v", err)
	}
	if got := bridge.only(t).body["chatId"]; got != group {
		t.Errorf("chatId = %v, want %q", got, group)
	}

	mislabelled := newFakeBridge(t).answering(http.StatusOK, `{"messageId":"wa_sent_1"}`)
	cfg := testConfig()
	cfg.HermesBridgeURL = mislabelled.server.URL
	broken := newManager(cfg, newFakeGroupStore(), newFakeInstanceRepo(), nil)
	if _, err := broken.sendText(context.Background(), dispatchRequest{
		ID: "send_123", GroupJID: group, ChatKind: chatKindUser, Text: "hi",
	}, quotedMessage{}); err == nil {
		t.Error("a group JID labelled as a direct chat was sent")
	}
	if calls := mislabelled.recorded(); len(calls) != 0 {
		t.Errorf("a mislabelled row reached the bridge: %+v", calls)
	}
}

// A worker with no bridge address cannot send at all, and says so instead of
// reporting a delivery that never happened.
func TestSendTextWithoutABridgeIsRefused(t *testing.T) {
	mgr := newManager(testConfig(), newFakeGroupStore(), newFakeInstanceRepo(), nil)
	if _, err := mgr.sendText(context.Background(), dispatchRequest{
		ID: "send_123", GroupJID: "120363043123456789@g.us", Text: "hi",
	}, quotedMessage{}); !errors.Is(err, errNoBridge) {
		t.Errorf("sendText = %v, want errNoBridge", err)
	}
}
