package main

import (
	"context"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

func TestBuildTextEnvelopeUsesAssignedGroupAndStableMessageID(t *testing.T) {
	jid, message, err := buildTextEnvelope(outboundText{ID: "send_123", GroupJID: "120363043123456789@g.us", Text: "  Hello team  "})
	if err != nil {
		t.Fatalf("buildTextEnvelope: %v", err)
	}
	if got, want := jid.String(), "120363043123456789@g.us"; got != want {
		t.Fatalf("JID = %q, want %q", got, want)
	}
	if got, want := message.GetConversation(), "Hello team"; got != want {
		t.Fatalf("Conversation = %q, want %q", got, want)
	}
}

// A row whose chat is a user is a direct chat: the message goes to that user
// JID itself, which for an owner DM is the owner's own JID.
func TestBuildTextEnvelopeAddressesDirectChat(t *testing.T) {
	const owner = "628990000009@s.whatsapp.net"
	jid, message, err := buildTextEnvelope(outboundText{ID: "send_123", GroupJID: owner, ChatKind: chatKindUser, Text: "  Hello owner  "})
	if err != nil {
		t.Fatalf("buildTextEnvelope: %v", err)
	}
	if got, want := jid.String(), owner; got != want {
		t.Fatalf("JID = %q, want %q", got, want)
	}
	if got, want := message.GetConversation(), "Hello owner"; got != want {
		t.Fatalf("Conversation = %q, want %q", got, want)
	}
}

// The absent chat kind is the group kind, so every row written before the field
// existed keeps dispatching to its group.
func TestBuildTextEnvelopeKeepsGroupRowsOnTheGroupBranch(t *testing.T) {
	const group = "120363043123456789@g.us"
	for _, request := range []outboundText{
		{ID: "send_123", GroupJID: group, Text: "hi"},
		{ID: "send_123", GroupJID: group, ChatKind: chatKindGroup, Text: "hi"},
	} {
		jid, _, err := buildTextEnvelope(request)
		if err != nil {
			t.Fatalf("buildTextEnvelope(%+v): %v", request, err)
		}
		if got := jid.String(); got != group {
			t.Fatalf("JID = %q, want %q", got, group)
		}
	}
}

// Each kind still refuses the other's JID, so a mislabelled row can never send a
// group message into a private chat or the reverse.
func TestBuildTextEnvelopeRefusesMismatchedChatKinds(t *testing.T) {
	for _, request := range []outboundText{
		{ID: "send_123", GroupJID: "120363043123456789@g.us", ChatKind: chatKindUser, Text: "hi"},
		{ID: "send_123", GroupJID: "628990000009@s.whatsapp.net", ChatKind: chatKindGroup, Text: "hi"},
		{ID: "send_123", GroupJID: "628990000009@s.whatsapp.net", Text: "hi"},
		{ID: "send_123", GroupJID: "120363043123456789@g.us", ChatKind: "channel", Text: "hi"},
	} {
		if _, _, err := buildTextEnvelope(request); err == nil {
			t.Fatalf("buildTextEnvelope(%+v) succeeded", request)
		}
	}
}

// A send that answers a message leaves as a quoted reply: the quote lives in
// ContextInfo, so the body has to be an extended text rather than a bare
// Conversation, and both halves of the quote come from the caller — this builder
// never invents the message a send is answering.
func TestBuildTextEnvelopeQuotesTheMessageBeingAnswered(t *testing.T) {
	const (
		group       = "120363043123456789@g.us"
		participant = "628990000001@s.whatsapp.net"
	)
	jid, message, err := buildTextEnvelope(outboundText{
		ID: "send_123", GroupJID: group, Text: "  Answered  ",
		Quote: quotedMessage{ID: "3EB0OWNER", Participant: participant},
	})
	if err != nil {
		t.Fatalf("buildTextEnvelope: %v", err)
	}
	if got, want := jid.String(), group; got != want {
		t.Fatalf("JID = %q, want %q", got, want)
	}
	if got := message.GetConversation(); got != "" {
		t.Errorf("Conversation = %q, want the text in the extended text that carries the quote", got)
	}
	if got, want := message.GetExtendedTextMessage().GetText(), "Answered"; got != want {
		t.Errorf("extended text = %q, want %q", got, want)
	}
	context := message.GetExtendedTextMessage().GetContextInfo()
	if got, want := context.GetStanzaID(), "3EB0OWNER"; got != want {
		t.Errorf("StanzaID = %q, want %q", got, want)
	}
	if got, want := context.GetParticipant(), participant; got != want {
		t.Errorf("Participant = %q, want %q", got, want)
	}
}

// A send with nothing to answer keeps the exact envelope every send has had: a
// bare Conversation and no context at all.
func TestBuildTextEnvelopeWithoutAQuoteKeepsThePlainConversation(t *testing.T) {
	_, message, err := buildTextEnvelope(outboundText{ID: "send_123", GroupJID: "120363043123456789@g.us", Text: "  Hello team  "})
	if err != nil {
		t.Fatalf("buildTextEnvelope: %v", err)
	}
	if want := (&waE2E.Message{Conversation: proto.String("Hello team")}); !proto.Equal(message, want) {
		t.Errorf("message = %v, want exactly %v", message, want)
	}
}

// A quote missing its id or its sender is refused before any client call: a
// half-built quote would be sent as a reply no WhatsApp client can resolve, and
// the send would look delivered while saying less than the row asked for.
func TestBuildTextEnvelopeRefusesAnIncompleteQuote(t *testing.T) {
	const group = "120363043123456789@g.us"
	for _, request := range []outboundText{
		{ID: "send_123", GroupJID: group, Text: "hi", Quote: quotedMessage{ID: "3EB0OWNER"}},
		{ID: "send_123", GroupJID: group, Text: "hi", Quote: quotedMessage{Participant: "628990000001@s.whatsapp.net"}},
		{ID: "send_123", GroupJID: group, Text: "hi", Quote: quotedMessage{ID: "3EB0OWNER", Participant: "not a jid"}},
	} {
		if _, _, err := buildTextEnvelope(request); err == nil {
			t.Fatalf("buildTextEnvelope(%+v) succeeded", request)
		}
	}
}

func TestBuildTextEnvelopeRejectsUnsafeTargets(t *testing.T) {
	for _, request := range []outboundText{
		{ID: "send_123", GroupJID: "not a jid", Text: "hello"},
		{ID: "send_123", GroupJID: "120363043123456789@g.us", Text: " \t "},
		{ID: "", GroupJID: "120363043123456789@g.us", Text: "hello"},
	} {
		if _, _, err := buildTextEnvelope(request); err == nil {
			t.Fatalf("buildTextEnvelope(%+v) succeeded", request)
		}
	}
}

// sendRecorder is the send surface `sendText` uses: it keeps the chat every
// message went to and the envelope itself, which is what a delivered direct chat
// and a delivered quote are proved by.
type sendRecorder struct {
	*fakeClient
	sent []recordedMessage
}

type recordedMessage struct {
	to      types.JID
	text    string
	message *waE2E.Message
}

func (s *sendRecorder) SendMessage(_ context.Context, to types.JID, message *waE2E.Message, _ ...whatsmeow.SendRequestExtra) (whatsmeow.SendResponse, error) {
	s.sent = append(s.sent, recordedMessage{to: to, text: message.GetConversation(), message: message})
	// The same acknowledgement the plain fake client returns: a test that reads
	// the stored message id gets one answer whichever double is wired.
	return whatsmeow.SendResponse{ID: types.MessageID("sent_by_fake")}, nil
}

func connectedSendRecorder(t *testing.T) (*manager, *sendRecorder) {
	t.Helper()
	recorder := &sendRecorder{fakeClient: newFakeClient()}
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	session := testSession(mgr, recorder)
	session.status = stateConnected
	mgr.put(session)
	return mgr, recorder
}

// The dispatcher hands `sendText` the stored row, so this drives the stored row
// through the same function the dispatcher calls and reads the chat the client
// was asked to send to.
func TestSendTextDeliversDirectChatToTheChatJID(t *testing.T) {
	mgr, recorder := connectedSendRecorder(t)
	const owner = "628990000009@s.whatsapp.net"

	id, err := mgr.sendText(context.Background(), dispatchRequest{
		ID: "send_123", InstanceID: "inst_1", GroupJID: owner, ChatKind: chatKindUser, Text: "ping",
	}, quotedMessage{})
	if err != nil {
		t.Fatalf("sendText: %v", err)
	}
	if id != "sent_by_fake" {
		t.Errorf("message id = %q, want sent_by_fake", id)
	}
	if len(recorder.sent) != 1 {
		t.Fatalf("sends = %d, want 1", len(recorder.sent))
	}
	if got := recorder.sent[0].to.String(); got != owner {
		t.Errorf("sent to %q, want %q", got, owner)
	}
	if got := recorder.sent[0].text; got != "ping" {
		t.Errorf("sent %q, want ping", got)
	}
}

// The dispatcher resolves the message a send answers and hands it to `sendText`
// with the request, so this drives both through the function the dispatcher
// calls and reads the envelope the client was asked to send.
func TestSendTextQuotesTheMessageItAnswers(t *testing.T) {
	mgr, recorder := connectedSendRecorder(t)
	const (
		group       = "120363043123456789@g.us"
		participant = "628990000001@s.whatsapp.net"
	)

	if _, err := mgr.sendText(context.Background(), dispatchRequest{
		ID: "send_123", InstanceID: "inst_1", GroupJID: group, Text: "Answered",
	}, quotedMessage{ID: "3EB0OWNER", Participant: participant}); err != nil {
		t.Fatalf("sendText: %v", err)
	}
	if len(recorder.sent) != 1 {
		t.Fatalf("sends = %d, want 1", len(recorder.sent))
	}
	if got := recorder.sent[0].to.String(); got != group {
		t.Errorf("sent to %q, want %q", got, group)
	}
	if got, want := recorder.sent[0].message.GetExtendedTextMessage().GetText(), "Answered"; got != want {
		t.Errorf("sent text = %q, want %q", got, want)
	}
	context := recorder.sent[0].message.GetExtendedTextMessage().GetContextInfo()
	if got, want := context.GetStanzaID(), "3EB0OWNER"; got != want {
		t.Errorf("StanzaID = %q, want %q", got, want)
	}
	if got, want := context.GetParticipant(), participant; got != want {
		t.Errorf("Participant = %q, want %q", got, want)
	}
}

// A group row is untouched by the direct-chat branch — it stays on its group —
// and a row whose JID contradicts its kind is refused before any client call.
func TestSendTextKeepsGroupRowsOnTheGroupBranch(t *testing.T) {
	mgr, recorder := connectedSendRecorder(t)
	const group = "120363043123456789@g.us"

	if _, err := mgr.sendText(context.Background(), dispatchRequest{
		ID: "send_123", InstanceID: "inst_1", GroupJID: group, Text: "ping",
	}, quotedMessage{}); err != nil {
		t.Fatalf("sendText: %v", err)
	}
	if len(recorder.sent) != 1 || recorder.sent[0].to.String() != group {
		t.Fatalf("group row sent to %+v, want %s", recorder.sent, group)
	}

	if _, err := mgr.sendText(context.Background(), dispatchRequest{
		ID: "send_124", InstanceID: "inst_1", GroupJID: "628990000009@s.whatsapp.net", ChatKind: chatKindGroup, Text: "ping",
	}, quotedMessage{}); err == nil {
		t.Fatal("a user JID under the group kind must be refused")
	}
	if len(recorder.sent) != 1 {
		t.Errorf("a refused target reached SendMessage: %+v", recorder.sent)
	}
}
