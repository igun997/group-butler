package main

import (
	"errors"
	"fmt"
	"strings"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// The two kinds of chat a stored send request can name. A row without the field
// is a group, which is what every row written before the field existed is.
const (
	chatKindGroup = "group"
	chatKindUser  = "user"
)

// quotedMessage is the message a send answers: the WhatsApp id of the message
// being replied to, and the JID of whoever sent it. Both are read from stored
// rows before the send — the id from the request, the sender from the message it
// names — because a quote that named the wrong sender would be worse than no
// quote at all. The quoted message itself is not rebuilt: `ContextInfo.StanzaID`
// is what WhatsApp resolves the quote with, and reconstructing the tree would
// need a decoder this worker does not have.
type quotedMessage struct {
	ID          string
	Participant string
}

// outboundText is the stored request reduced to the only data a text envelope needs.
// `GroupJID` carries the chat JID, which for a direct chat is the owner's own
// user JID; `ChatKind` says which of the two it is.
type outboundText struct {
	ID       string
	GroupJID string
	ChatKind string
	Text     string
	// Quote is the message this send answers. The zero value — the shape every
	// send without reply provenance has — sends the plain text below.
	Quote quotedMessage
}

// buildTextEnvelope has no network or storage effects, so the exact chat and content
// sent after a claim are proven before a WhatsApp client is ever called.
func buildTextEnvelope(request outboundText) (types.JID, *waE2E.Message, error) {
	if request.ID == "" {
		return types.EmptyJID, nil, errors.New("send request has no id")
	}
	text := strings.TrimSpace(request.Text)
	if text == "" {
		return types.EmptyJID, nil, errors.New("send request text is empty")
	}
	jid, err := types.ParseJID(request.GroupJID)
	if err != nil {
		return types.EmptyJID, nil, fmt.Errorf("send target %q is not a jid: %w", request.GroupJID, err)
	}
	if err := checkChatKind(request.ChatKind, jid); err != nil {
		return types.EmptyJID, nil, err
	}
	// A quote carries both halves or it is not a quote: a reply that named a
	// sender but no message, or a message but no sender, would be sent as
	// something WhatsApp cannot resolve — worse than the plain text it replaced.
	quote := quotedMessage{ID: strings.TrimSpace(request.Quote.ID), Participant: strings.TrimSpace(request.Quote.Participant)}
	if quote.ID == "" && quote.Participant == "" {
		return jid, &waE2E.Message{Conversation: proto.String(text)}, nil
	}
	if quote.ID == "" {
		return types.EmptyJID, nil, errors.New("send request quotes a message without its id")
	}
	if quote.Participant == "" {
		return types.EmptyJID, nil, fmt.Errorf("quoted message %s has no sender jid", quote.ID)
	}
	participant, err := types.ParseJID(quote.Participant)
	if err != nil || participant.User == "" {
		return types.EmptyJID, nil, fmt.Errorf("quoted message %s names an unusable sender %q", quote.ID, quote.Participant)
	}
	// A quote lives in ContextInfo, which only an extended text carries, so a
	// reply is one rather than the plain Conversation above.
	return jid, &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
		Text: proto.String(text),
		ContextInfo: &waE2E.ContextInfo{
			StanzaID:    proto.String(quote.ID),
			Participant: proto.String(participant.String()),
		},
	}}, nil
}

// checkChatKind keeps a row's kind and its JID server in agreement: a group chat
// is addressed by a group JID, a direct chat by the user's own JID. Without it a
// mislabelled row would send a group message into a private chat — or the
// reverse — which is the mistake the stored kind exists to prevent.
func checkChatKind(kind string, jid types.JID) error {
	if jid.User == "" {
		return fmt.Errorf("send target %q has no user part", jid)
	}
	switch kind {
	case "", chatKindGroup:
		if jid.Server != types.GroupServer {
			return fmt.Errorf("send target %q is not a group jid", jid)
		}
	case chatKindUser:
		if jid.Server != types.DefaultUserServer && jid.Server != types.HiddenUserServer {
			return fmt.Errorf("send target %q is not a user jid", jid)
		}
	default:
		return fmt.Errorf("send request has unknown chat kind %q", kind)
	}
	return nil
}
