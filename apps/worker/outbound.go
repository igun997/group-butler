package main

import (
	"errors"
	"fmt"
	"strings"
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
// quote at all. The quoted message itself is not rebuilt: neither WhatsApp nor the
// bridge needs its body to resolve a reply, only what it is addressed to.
type quotedMessage struct {
	ID          string
	Participant string
}

// outboundText is the stored request reduced to the only data a send needs.
// `GroupJID` carries the chat JID, which for a direct chat is the owner's own
// user JID; `ChatKind` says which of the two it is.
type outboundText struct {
	GroupJID string
	ChatKind string
	Text     string
	// Quote is the message this send answers. The zero value — the shape every
	// send without reply provenance has — sends the plain text below.
	Quote quotedMessage
}

// outboundSend is one send as the Hermes bridge is asked for it: the chat, the
// text, and the reply target. The bridge owns the envelope from here — it decides
// the WhatsApp id, the chunking and the quoting node — which is why this carries
// no message tree of its own.
type outboundSend struct {
	ChatID string
	Text   string
	Reply  quotedMessage
}

// buildOutboundSend has no network or storage effects, so the exact chat and
// content sent after a claim are proven before the bridge is ever called: the row
// says where a message goes, and a row that contradicts itself is refused rather
// than delivered to whichever half was believed.
func buildOutboundSend(request outboundText) (outboundSend, error) {
	text := strings.TrimSpace(request.Text)
	if text == "" {
		return outboundSend{}, errors.New("send request text is empty")
	}
	jid, err := parseAddress(request.GroupJID)
	if err != nil {
		return outboundSend{}, fmt.Errorf("send target %q is not a jid: %w", request.GroupJID, err)
	}
	if err := checkChatKind(request.ChatKind, jid); err != nil {
		return outboundSend{}, err
	}
	// A quote carries both halves or it is not a quote: a reply that named a
	// sender but no message, or a message but no sender, would be sent as something
	// WhatsApp cannot resolve — worse than the plain text it replaced.
	quote := quotedMessage{
		ID:          strings.TrimSpace(request.Quote.ID),
		Participant: strings.TrimSpace(request.Quote.Participant),
	}
	if quote.ID == "" && quote.Participant == "" {
		return outboundSend{ChatID: jid.String(), Text: text}, nil
	}
	if quote.ID == "" {
		return outboundSend{}, errors.New("send request quotes a message without its id")
	}
	if quote.Participant == "" {
		return outboundSend{}, fmt.Errorf("quoted message %s has no sender jid", quote.ID)
	}
	participant, err := parseAddress(quote.Participant)
	if err != nil || participant.user == "" {
		return outboundSend{}, fmt.Errorf("quoted message %s names an unusable sender %q", quote.ID, quote.Participant)
	}
	return outboundSend{ChatID: jid.String(), Text: text, Reply: quotedMessage{ID: quote.ID, Participant: participant.String()}}, nil
}

// checkChatKind keeps a row's kind and its JID server in agreement: a group chat
// is addressed by a group JID, a direct chat by the user's own JID. Without it a
// mislabelled row would send a group message into a private chat — or the
// reverse — which is the mistake the stored kind exists to prevent.
func checkChatKind(kind string, jid waAddress) error {
	if jid.user == "" {
		return fmt.Errorf("send target %q has no user part", jid)
	}
	switch kind {
	case "", chatKindGroup:
		if !jid.isGroup() {
			return fmt.Errorf("send target %q is not a group jid", jid)
		}
	case chatKindUser:
		if !jid.isUser() {
			return fmt.Errorf("send target %q is not a user jid", jid)
		}
	default:
		return fmt.Errorf("send request has unknown chat kind %q", kind)
	}
	return nil
}
