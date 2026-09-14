package main

import (
	"errors"
	"strings"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// outboundText is the stored request reduced to the only data a text envelope needs.
type outboundText struct {
	ID       string
	GroupJID string
	Text     string
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
	if err != nil || jid.Server != types.GroupServer {
		return types.EmptyJID, nil, errors.New("send target is not a group jid")
	}
	return jid, &waE2E.Message{Conversation: proto.String(text)}, nil
}
