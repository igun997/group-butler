package main

import (
	"testing"

	"go.mau.fi/whatsmeow/types"
)

// A hand-typed mention needs the bot's own number, which a live session learns
// when it connects (`markConnectedLocal`); the parsing tests below only exercise
// the identity match, so the fixture sets it directly.
func testSessionWithPhone(mgr *manager, client whatsmeowClient, phone string) *session {
	s := testSession(mgr, client)
	s.phoneNumber = phone
	return s
}

// A mention the bot must recognise. WhatsApp addresses one account several
// ways, and a group that has migrated to LIDs mentions the LID while an older
// group mentions the phone JID — both are the same account, and a bot that only
// answers one of them looks broken to the operator.
func TestReplyCandidateRecognizesTheBotAcrossItsIdentities(t *testing.T) {
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, newPersistQueue(4, 1))
	s := testSession(mgr, newFakeClient())
	// The fixture session's device is phone `628990000009` device 5; its LID is
	// what a migrated group carries in `mentionedJID`.
	s.botLID = "1730922213397:5@lid"

	for _, tt := range []struct {
		name     string
		mentions []string
		want     bool
	}{
		{"the phone JID as stored", []string{"628990000009@s.whatsapp.net"}, true},
		{"the phone JID with a device suffix", []string{"628990000009:5@s.whatsapp.net"}, true},
		{"the LID a migrated group sends", []string{"1730922213397@lid"}, true},
		{"the LID with a device suffix", []string{"1730922213397:5@lid"}, true},
		{"somebody else", []string{"628990000001@s.whatsapp.net"}, false},
		{"a group JID", []string{"120363043123456789@g.us"}, false},
		{"no mention at all", nil, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			doc := MessageDoc{Text: "ping", IsGroup: true, Mentions: tt.mentions}
			if got := mgr.replyCandidate(doc, s); got != tt.want {
				t.Errorf("replyCandidate(%v) = %v, want %v", tt.mentions, got, tt.want)
			}
		})
	}
}

// An operator types the bot's number by hand far more often than they pick it
// from WhatsApp's mention list, and that text carries no structured mention.
func TestReplyCandidateRecognizesAHandTypedPhoneMention(t *testing.T) {
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, newPersistQueue(4, 1))
	s := testSessionWithPhone(mgr, newFakeClient(), "628990000009")

	for _, tt := range []struct {
		name string
		text string
		want bool
	}{
		{"the bare number", "@628990000009 please summarise", true},
		{"the international spelling", "@+62 899-000-0009 please summarise", true},
		{"spaced digits", "@62 899 000 0009 hi", true},
		{"mid-sentence", "hey @628990000009 can you help", true},
		{"another number", "@628990000001 hello", false},
		{"the number without a mention marker", "call 628990000009 today", false},
		{"a partial prefix of the bot", "@62899000000 hi", false},
		{"a longer number that starts with the bot's", "@6289900000099 hi", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			doc := MessageDoc{Text: tt.text, IsGroup: true}
			if got := mgr.replyCandidate(doc, s); got != tt.want {
				t.Errorf("replyCandidate(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}

// The candidacy rule is about the bot being addressed, never about who is
// allowed to drive it: the BFF authorizes the sender against the owner list it
// owns, so a message from anyone that mentions the bot is a candidate here.
func TestReplyCandidateIsNotAnAuthorizationDecision(t *testing.T) {
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, newPersistQueue(4, 1))
	s := testSessionWithPhone(mgr, newFakeClient(), "628990000009")

	doc := MessageDoc{
		Text:      "@628990000009 do it",
		IsGroup:   true,
		SenderJID: "628111111111@s.whatsapp.net",
		Mentions:  []string{"628990000009@s.whatsapp.net"},
	}
	if !mgr.replyCandidate(doc, s) {
		t.Fatal("a mention from a non-owner must still be a candidate; the BFF authorizes the sender")
	}

	// A direct chat is the other way the bot is addressed, and it needs no
	// mention: the bot is one end of the chat, so the text alone makes it a
	// candidate — from any sender, since authorizing the sender is the BFF's.
	direct := MessageDoc{Text: "hi", SenderJID: "628111111111@s.whatsapp.net"}
	if !mgr.replyCandidate(direct, s) {
		t.Fatal("a direct chat with text must be a candidate: the direct chat is the mention")
	}
	if !mgr.replyCandidate(direct, nil) {
		t.Fatal("a direct chat's candidacy must not depend on the bot's own identities")
	}
	if mgr.replyCandidate(MessageDoc{SenderJID: "628111111111@s.whatsapp.net"}, s) {
		t.Fatal("a direct message with no text produced a reply candidate")
	}
}

// The bot's own outgoing message is never a candidate.
func TestReplyCandidateIgnoresOwnMessages(t *testing.T) {
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, newPersistQueue(4, 1))
	s := testSession(mgr, newFakeClient())

	if mgr.replyCandidate(MessageDoc{Text: "@628990000009", FromMe: true, IsGroup: true}, s) {
		t.Fatal("a message sent by the bot itself produced a reply candidate")
	}
	if mgr.replyCandidate(MessageDoc{Text: "", IsGroup: true, Mentions: []string{"628990000009@s.whatsapp.net"}}, s) {
		t.Fatal("a message with no text produced a reply candidate")
	}
}

// Guard the identity set itself: an unpaired session has no identities to match,
// so nothing is a candidate rather than everything.
func TestReplyCandidateOnASessionWithoutIdentity(t *testing.T) {
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, newPersistQueue(4, 1))
	client := newFakeClient()
	s := newSession(mgr, InstanceRow{ID: "inst_1", OrganizationID: "org_default"}, nil, client)

	if mgr.replyCandidate(MessageDoc{Text: "@628990000009 hi", IsGroup: true}, s) {
		t.Fatal("a session with no device identity matched a mention")
	}
	if ids := botMentionIdentities(s); len(ids) != 0 {
		t.Errorf("botMentionIdentities = %v, want none", ids)
	}
}

// botMentionIdentities must produce the non-AD forms, because a mention that
// carries a device suffix names the same account as the bare JID.
func TestBotMentionIdentitiesAreNonAD(t *testing.T) {
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, newPersistQueue(4, 1))
	s := testSession(mgr, newFakeClient())
	s.botLID = "1730922213397:5@lid"

	ids := botMentionIdentities(s)
	if _, ok := ids["628990000009@s.whatsapp.net"]; !ok {
		t.Errorf("missing the phone identity: %v", ids)
	}
	if _, ok := ids["1730922213397@lid"]; !ok {
		t.Errorf("missing the LID identity: %v", ids)
	}
	if len(ids) != 2 {
		t.Errorf("identities = %v, want exactly the two non-AD forms", ids)
	}
}

// The typed-number scan must match the bot exactly, and only the characters a
// formatted phone number can contain may follow the `@`.
func TestMentionsPhoneInText(t *testing.T) {
	for _, tt := range []struct {
		text string
		want bool
	}{
		{"@628990000009", true},
		{"@+62 899-000-0009", true},
		{"@62 899 000 0009", true},
		{"see @628990000009 now", true},
		{"@628990000009 please call 628111111111", true}, // the later number is not attributed to the `@`
		{"the national form @08990000009", true},
		{"mentioning (parenthesised) @(62) 899-000-0009 ok", true},
		{"no mention", false},
		{"@6289900000099", false},
		{"@62899000000", false},
		{"@notanumber", false},
		{"@", false},
	} {
		if got := mentionsPhoneInText(tt.text, "628990000009", "62"); got != tt.want {
			t.Errorf("mentionsPhoneInText(%q) = %v, want %v", tt.text, got, tt.want)
		}
	}

	if mentionsPhoneInText("@628990000009", "", "62") {
		t.Error("a session with no phone number matched a typed mention")
	}
}

var _ = types.EmptyJID
