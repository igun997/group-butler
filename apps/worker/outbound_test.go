package main

import "testing"

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

func TestBuildTextEnvelopeRejectsUnsafeTargets(t *testing.T) {
	for _, request := range []outboundText{
		{ID: "send_123", GroupJID: "628123@s.whatsapp.net", Text: "hello"},
		{ID: "send_123", GroupJID: "120363043123456789@g.us", Text: " \t "},
		{ID: "", GroupJID: "120363043123456789@g.us", Text: "hello"},
	} {
		if _, _, err := buildTextEnvelope(request); err == nil {
			t.Fatalf("buildTextEnvelope(%+v) succeeded", request)
		}
	}
}
