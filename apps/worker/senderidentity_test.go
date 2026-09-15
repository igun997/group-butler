package main

import (
	"context"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// lidStore is the auth store's LID↔phone table as the resolution reads it.
type lidStore struct {
	store.LIDStore
	byLID map[types.JID]types.JID
	err   error
}

func (l lidStore) GetPNForLID(_ context.Context, lid types.JID) (types.JID, error) {
	if l.err != nil {
		return types.EmptyJID, l.err
	}
	return l.byLID[lid], nil
}

// WhatsApp now addresses a participant by their LID, and the owner list is
// written in phone numbers. Storing the LID verbatim is what made an
// authorized owner's mention 404 at the BFF: it compares the two.
func TestLIDSenderIsStoredAsItsPhoneJID(t *testing.T) {
	groupJID := types.NewJID("120363043123456789", types.GroupServer)
	senderLID := types.NewJID("239959873196218:67", types.HiddenUserServer)
	senderPN := types.NewJID("628996926184", types.DefaultUserServer)

	mgr, groups, s := testDirectManager(t, nil)
	s.device.LIDs = lidStore{byLID: map[types.JID]types.JID{types.NewJID("239959873196218", types.HiddenUserServer): senderPN}}
	groups.docs[groupJID.String()] = &groupDoc{Config: groupConfig{Assigned: true, Whitelisted: true}}

	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:      groupJID,
				Sender:    senderLID,
				SenderAlt: senderLID,
				IsGroup:   true,
			},
			ID:        "3EB0LIDSENDER",
			Timestamp: time.Unix(1757750000, 0),
		},
		Message: &waE2E.Message{Conversation: proto.String("hi")},
	}
	doc, err := parseInbound(evt, mgr.orgID, s.id)
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if doc.SenderJID != senderLID.String() {
		t.Fatalf("fixture sender = %q, want the LID as parsed", doc.SenderJID)
	}

	docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc})
	if len(docs) != 1 {
		t.Fatalf("stored %d documents, want 1", len(docs))
	}
	if docs[0].SenderJID != senderPN.String() {
		t.Errorf("senderJid = %q, want the resolved phone JID %q", docs[0].SenderJID, senderPN.String())
	}
	// The LID is kept: it is the addressing the message actually arrived under.
	if docs[0].SenderLID != senderLID.String() {
		t.Errorf("senderLid = %q, want %q", docs[0].SenderLID, senderLID.String())
	}
}

// An unmapped LID must still be stored, exactly as it arrived: dropping the
// message because a lookup missed would lose data the operator can still see
// in the console.
func TestUnmappedLIDSenderIsStoredUnchanged(t *testing.T) {
	groupJID := types.NewJID("120363043123456789", types.GroupServer)
	senderLID := types.NewJID("239959873196218:67", types.HiddenUserServer)

	mgr, groups, s := testDirectManager(t, nil)
	s.device.LIDs = lidStore{byLID: map[types.JID]types.JID{}}
	groups.docs[groupJID.String()] = &groupDoc{Config: groupConfig{Assigned: true, Whitelisted: true}}

	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: groupJID, Sender: senderLID, SenderAlt: senderLID, IsGroup: true},
			ID:            "3EB0UNMAPPED",
			Timestamp:     time.Unix(1757750000, 0),
		},
		Message: &waE2E.Message{Conversation: proto.String("hi")},
	}
	doc, err := parseInbound(evt, mgr.orgID, s.id)
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}

	docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc})
	if len(docs) != 1 {
		t.Fatalf("stored %d documents, want the unmapped message kept", len(docs))
	}
	if docs[0].SenderJID != senderLID.String() {
		t.Errorf("senderJid = %q, want the LID left alone", docs[0].SenderJID)
	}
}

// A phone-addressed sender must not pay for a lookup that cannot help, and must
// come out byte-identical.
func TestPhoneSenderIsLeftAlone(t *testing.T) {
	groupJID := types.NewJID("120363043123456789", types.GroupServer)
	senderPN := types.NewJID("628990000001", types.DefaultUserServer)

	mgr, groups, s := testDirectManager(t, nil)
	// A store that would answer wrongly if it were consulted.
	s.device.LIDs = lidStore{byLID: map[types.JID]types.JID{senderPN: types.NewJID("999", types.HiddenUserServer)}}
	groups.docs[groupJID.String()] = &groupDoc{Config: groupConfig{Assigned: true, Whitelisted: true}}

	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: groupJID, Sender: senderPN, IsGroup: true},
			ID:            "3EB0PHONE",
			Timestamp:     time.Unix(1757750000, 0),
		},
		Message: &waE2E.Message{Conversation: proto.String("hi")},
	}
	doc, err := parseInbound(evt, mgr.orgID, s.id)
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}

	docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc})
	if len(docs) != 1 {
		t.Fatalf("stored %d documents, want 1", len(docs))
	}
	if docs[0].SenderJID != senderPN.String() {
		t.Errorf("senderJid = %q, want %q", docs[0].SenderJID, senderPN.String())
	}
	if docs[0].SenderLID != "" {
		t.Errorf("senderLid = %q, want empty for a phone sender", docs[0].SenderLID)
	}
}

// A lookup that fails must not change the message or stop it being stored.
func TestLIDLookupFailureLeavesTheMessageAlone(t *testing.T) {
	groupJID := types.NewJID("120363043123456789", types.GroupServer)
	senderLID := types.NewJID("239959873196218:67", types.HiddenUserServer)

	mgr, groups, s := testDirectManager(t, nil)
	s.device.LIDs = lidStore{err: context.DeadlineExceeded}
	groups.docs[groupJID.String()] = &groupDoc{Config: groupConfig{Assigned: true, Whitelisted: true}}

	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: groupJID, Sender: senderLID, SenderAlt: senderLID, IsGroup: true},
			ID:            "3EB0LIDFAIL",
			Timestamp:     time.Unix(1757750000, 0),
		},
		Message: &waE2E.Message{Conversation: proto.String("hi")},
	}
	doc, err := parseInbound(evt, mgr.orgID, s.id)
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}

	docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc})
	if len(docs) != 1 {
		t.Fatalf("stored %d documents, want the message kept", len(docs))
	}
	if docs[0].SenderJID != senderLID.String() {
		t.Errorf("senderJid = %q, want the LID left alone after a failed lookup", docs[0].SenderJID)
	}
}

// A direct chat whose address is a LID is the same person as the sender, and the
// reply has to go back to an address the send path accepts. The stored row is
// the whole conversation key, so it must be the phone JID too.
func TestLIDDirectChatIsStoredAtTheOwnersPhoneJID(t *testing.T) {
	senderLID := types.NewJID("239959873196218:67", types.HiddenUserServer)
	senderPN := types.NewJID("628996926184", types.DefaultUserServer)

	mgr, _, s := testDirectManager(t, ownerPhones("628996926184"))
	s.device.LIDs = lidStore{byLID: map[types.JID]types.JID{
		types.NewJID("239959873196218", types.HiddenUserServer): senderPN,
	}}

	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: senderLID, Sender: senderLID, SenderAlt: senderLID},
			ID:            "3EB0DMLIDCHAT",
			Timestamp:     time.Unix(1757750000, 0),
		},
		Message: &waE2E.Message{Conversation: proto.String("hello")},
	}
	doc, err := parseInbound(evt, mgr.orgID, s.id)
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}

	docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc})
	if len(docs) != 1 {
		t.Fatalf("stored %d documents, want the owner's direct message", len(docs))
	}
	if docs[0].SenderJID != senderPN.String() {
		t.Errorf("senderJid = %q, want %q", docs[0].SenderJID, senderPN.String())
	}
	if docs[0].GroupJID != senderPN.String() || docs[0].ChatJID != senderPN.String() {
		t.Errorf("chat addressed at %q/%q, want the phone JID %q", docs[0].GroupJID, docs[0].ChatJID, senderPN.String())
	}
	if !docs[0].AutoReplyCandidate {
		t.Error("an owner's direct message was not marked a reply candidate")
	}
}

var _ = store.Device{}
