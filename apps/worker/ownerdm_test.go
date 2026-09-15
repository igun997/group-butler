package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// fakeOwnerAllowlist is the storage gate's answer without Mongo. The gate's
// behaviour for an authorization — not the read that produced it — is what the
// direct-message tests assert.
type fakeOwnerAllowlist struct {
	phones map[string]struct{}
	err    error
	calls  int
}

func (f *fakeOwnerAllowlist) allowedPhones(context.Context, string) (map[string]struct{}, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return f.phones, nil
}

func ownerPhones(phones ...string) *fakeOwnerAllowlist {
	set := make(map[string]struct{}, len(phones))
	for _, phone := range phones {
		set[phone] = struct{}{}
	}
	return &fakeOwnerAllowlist{phones: set}
}

// testDirectManager wires the pieces the direct-chat gate needs: an owner list
// the test controls, an ingest queue the helper below swaps per attempt, and a
// group store that must stay untouched by a direct chat.
func testDirectManager(t *testing.T, owners ownerAllowlist) (*manager, *fakeGroupStore, *session) {
	t.Helper()
	groups := newFakeGroupStore()
	mgr := testManagerWithDeps(groups, nil, nil)
	mgr.owners = owners
	mgr.ingest = newIngestQueue(8, time.Hour, 10)
	return mgr, groups, testSession(mgr, newFakeClient())
}

// persistedBy runs one job against a fresh ingest queue and returns the
// documents the gate handed to storage. The queue is the write the gate
// produces, so an empty result is the proof that nothing was written — stronger
// than a return value that says the same.
func persistedBy(t *testing.T, mgr *manager, job inboundMessageJob) []MessageDoc {
	t.Helper()
	ingest := newIngestQueue(8, time.Hour, 10)
	mgr.ingest = ingest
	if err := job.persist(context.Background(), mgr); err != nil {
		t.Fatalf("persist: %v", err)
	}
	if ingest.Dropped() != 0 {
		t.Fatalf("ingest dropped %d message(s): the gate's decision was counted as loss", ingest.Dropped())
	}
	return ingest.stop()
}

// directMessage builds one inbound 1:1 message and parses it the way the event
// loop does, so the gate is exercised on the document it really sees.
func directMessage(t *testing.T, mgr *manager, s *session, sender types.JID, id string, msg *waE2E.Message) (*events.Message, MessageDoc) {
	t.Helper()
	evt := evtMessage(sender, sender, id, msg)
	doc, err := parseInbound(evt, mgr.orgID, s.id)
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if doc.IsGroup || doc.ChatJID != sender.String() {
		t.Fatalf("fixture is not a direct chat: isGroup=%v chat=%q", doc.IsGroup, doc.ChatJID)
	}
	return evt, doc
}

func textDM(text string) *waE2E.Message { return &waE2E.Message{Conversation: proto.String(text)} }

// An owner's direct message is stored like a group message: the chat JID is the
// group key and `isGroup` stays false, so every existing group query — which
// filters on a group JID — misses it.
func TestOwnerDirectMessageIsStoredAndMarkedACandidate(t *testing.T) {
	owner := types.NewJID("628996926184", types.DefaultUserServer)
	mgr, groups, s := testDirectManager(t, ownerPhones("628996926184"))
	evt, doc := directMessage(t, mgr, s, owner, "3EB0DMOWNER", textDM("summarise today"))

	docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc})

	if len(docs) != 1 {
		t.Fatalf("ingest received %d documents, want the owner's one", len(docs))
	}
	stored := docs[0]
	if stored.IsGroup {
		t.Error("stored.IsGroup = true, want a direct message to stay out of the group queries")
	}
	if stored.GroupJID != owner.String() {
		t.Errorf("stored.GroupJID = %q, want the chat JID %q", stored.GroupJID, owner)
	}
	if !stored.AutoReplyCandidate {
		t.Error("AutoReplyCandidate = false, want every owner text in a direct chat to be a candidate")
	}
	if touch, observed, upsert := groups.calls(); touch+observed+upsert != 0 {
		t.Errorf("a direct message touched the groups collection: touch=%d observed=%d upsert=%d", touch, observed, upsert)
	}
}

// Everyone else's direct chat is still dropped, and dropped before anything is
// written: storage is handed nothing at all.
func TestDirectMessageFromAnyoneElseWritesNothing(t *testing.T) {
	stranger := types.NewJID("628990000777", types.DefaultUserServer)
	owners := ownerPhones("628996926184")
	mgr, groups, s := testDirectManager(t, owners)
	evt, doc := directMessage(t, mgr, s, stranger, "3EB0DMSTRANGER", textDM("are you there?"))

	docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc})

	if len(docs) != 0 {
		t.Fatalf("an unauthorized direct message reached storage: %+v", docs)
	}
	if touch, observed, upsert := groups.calls(); touch+observed+upsert != 0 {
		t.Errorf("an unauthorized direct message touched the groups collection: touch=%d observed=%d upsert=%d", touch, observed, upsert)
	}
	if owners.calls == 0 {
		t.Error("the owner list was never consulted: the drop was an accident, not a decision")
	}
}

// The list holds canonical JIDs and the wire carries whichever form WhatsApp
// used: a device suffix is the same account, and an account addressed by LID
// names its phone JID in the message's alternate address.
func TestOwnerMatchStripsTheDeviceSuffixAndReadsTheAlternateAddress(t *testing.T) {
	t.Run("device suffix", func(t *testing.T) {
		mgr, _, s := testDirectManager(t, ownerPhones("628996926184"))
		sender := types.NewJID("628996926184:5", types.DefaultUserServer)
		evt, doc := directMessage(t, mgr, s, sender, "3EB0DMSUFFIX", textDM("hello"))

		if docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc}); len(docs) != 1 {
			t.Fatalf("ingest received %d documents, want the owner's device-suffixed one", len(docs))
		}
	})

	t.Run("lidded owner", func(t *testing.T) {
		// whatsmeow addresses a migrated account by LID and puts its phone JID
		// in SenderAlt, which is the only form the owner list can hold.
		mgr, _, s := testDirectManager(t, ownerPhones("628996926184"))
		lid := types.NewJID("1730922213397", types.HiddenUserServer)
		evt := evtMessage(lid, lid, "3EB0DMLID", textDM("hello"))
		evt.Info.SenderAlt = types.NewJID("628996926184", types.DefaultUserServer)
		doc, err := parseInbound(evt, mgr.orgID, s.id)
		if err != nil {
			t.Fatalf("parseInbound: %v", err)
		}

		if docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc}); len(docs) != 1 {
			t.Fatalf("ingest received %d documents, want the LID-addressed owner's message", len(docs))
		}
	})
}

// A direct message with no text addresses nothing: it is stored, like any other
// owner message, but it can never be a candidate.
func TestOwnerDirectMessageWithoutTextIsNotACandidate(t *testing.T) {
	owner := types.NewJID("628996926184", types.DefaultUserServer)
	mgr, _, s := testDirectManager(t, ownerPhones("628996926184"))
	evt, doc := directMessage(t, mgr, s, owner, "3EB0DMPHOTO", &waE2E.Message{
		ImageMessage: &waE2E.ImageMessage{Caption: proto.String("")},
	})

	docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc})

	if len(docs) != 1 {
		t.Fatalf("ingest received %d documents, want the stored attachment message", len(docs))
	}
	if docs[0].AutoReplyCandidate {
		t.Error("a direct message with no text was marked a candidate")
	}
	if docs[0].Kind == KindText {
		t.Errorf("stored kind = %q, want the attachment's kind", docs[0].Kind)
	}
}

// The bot's own outgoing direct message is stored but never an answer target,
// exactly as an own group message is.
func TestOwnDirectMessageIsStoredButNeverACandidate(t *testing.T) {
	bot := types.NewJID("628990000009", types.DefaultUserServer)
	mgr, _, s := testDirectManager(t, ownerPhones("628990000009"))
	evt := evtMessage(bot, bot, "3EB0DMSENT", textDM("reminder: standup at 9"))
	evt.Info.IsFromMe = true
	doc, err := parseInbound(evt, mgr.orgID, s.id)
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}

	docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc})

	if len(docs) != 1 {
		t.Fatalf("ingest received %d documents, want the bot's own message stored", len(docs))
	}
	if docs[0].AutoReplyCandidate {
		t.Error("the bot's own direct message was marked a candidate")
	}
}

// The BFF can rewrite the owner list while this worker runs, so the gate must
// pick up a newly authorized owner without a restart — and only after the
// interval, so the steady state is not a read per message.
func TestANewlyAuthorizedOwnerStartsWorkingAfterTheListTTL(t *testing.T) {
	clock := newFakeClock(time.Unix(1757750000, 0))
	read := newStubOwnerRead("org_default", "628996926184@s.whatsapp.net")
	mgr, _, s := testDirectManager(t, testOwnerStore(clock, read))

	sender := types.NewJID("628996926185", types.DefaultUserServer)
	evt, doc := directMessage(t, mgr, s, sender, "3EB0DMNEWOWNER", textDM("deploy is green"))
	job := inboundMessageJob{session: s, evt: evt, doc: doc}

	if docs := persistedBy(t, mgr, job); len(docs) != 0 {
		t.Fatalf("a stranger's message was stored before the list was refreshed: %+v", docs)
	}

	// The operator authorizes them from the dashboard.
	read.set("org_default", []string{"628996926184@s.whatsapp.net", "628996926185@s.whatsapp.net"}, nil)

	if docs := persistedBy(t, mgr, job); len(docs) != 0 {
		t.Fatal("the list was re-read inside its interval: the refresh is not bounded")
	}

	clock.advance(ownerListTTL)
	docs := persistedBy(t, mgr, job)
	if len(docs) != 1 {
		t.Fatalf("ingest received %d documents, want the newly authorized owner stored without a restart", len(docs))
	}
	if !docs[0].AutoReplyCandidate {
		t.Error("a newly authorized owner's text was stored but not marked a candidate")
	}
}

// A group message is unaffected by the owner list: the group's own scope is what
// lets it through, and the mention rules still decide candidacy. Scope means
// both flags — the same pair the BFF reply route and the memory-batch builder
// demand — so an assigned-but-ungranted group stays unread.
func TestGroupMessageIsGatedByGroupScopeNotTheOwnerList(t *testing.T) {
	groupJID := types.NewJID("120363043123456789", types.GroupServer)
	// No owner list at all: a group message must not depend on one.
	mgr, groups, s := testDirectManager(t, nil)
	evt := evtMessage(groupJID, types.NewJID("628990000001", types.DefaultUserServer), "3EB0GROUP", textDM("group traffic"))
	doc, err := parseInbound(evt, mgr.orgID, s.id)
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if !doc.IsGroup || doc.GroupJID != groupJID.String() {
		t.Fatalf("fixture is not a group message: isGroup=%v group=%q", doc.IsGroup, doc.GroupJID)
	}

	groups.docs[groupJID.String()] = &groupDoc{Config: groupConfig{Assigned: true, Whitelisted: true}}
	if docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc}); len(docs) != 1 {
		t.Fatalf("ingest received %d documents, want the in-scope group's message", len(docs))
	}

	groups.docs[groupJID.String()] = &groupDoc{Config: groupConfig{Assigned: false, Whitelisted: true}}
	if docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc}); len(docs) != 0 {
		t.Fatalf("an unassigned group message was stored: %+v", docs)
	}

	groups.docs[groupJID.String()] = &groupDoc{Config: groupConfig{Assigned: true, Whitelisted: false}}
	if docs := persistedBy(t, mgr, inboundMessageJob{session: s, evt: evt, doc: doc}); len(docs) != 0 {
		t.Fatalf("a group the operator never granted was stored: %+v", docs)
	}
}

// The reply callback is how the BFF learns there is something to answer. A
// direct message sends the chat JID in the group slot and says so, because the
// BFF resolves a group row for a group message and the chat for a direct one.
func TestReplyCallbackPayloadDistinguishesADirectChat(t *testing.T) {
	bodies := make(chan map[string]any, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode callback body: %v", err)
		}
		bodies <- body
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.cfg.ReplyCallbackURL = srv.URL
	mgr.cfg.ReplyCallbackSecret = "secret"

	const ownerChat = "628996926184@s.whatsapp.net"
	mgr.deliverSavedReplies([]MessageDoc{
		{OrganizationID: "org_default", InstanceID: "inst_1", GroupJID: ownerChat, WaMessageID: "3EB0DM", AutoReplyCandidate: true},
		{OrganizationID: "org_default", InstanceID: "inst_1", GroupJID: "120363043123456789@g.us", IsGroup: true, WaMessageID: "3EB0GROUP", AutoReplyCandidate: true},
	})

	direct := <-bodies
	if direct["isGroup"] != false {
		t.Errorf("direct payload isGroup = %v, want false", direct["isGroup"])
	}
	if direct["groupJid"] != ownerChat {
		t.Errorf("direct payload groupJid = %v, want the chat JID %q", direct["groupJid"], ownerChat)
	}
	if direct["waMessageId"] != "3EB0DM" || direct["organizationId"] != "org_default" || direct["instanceId"] != "inst_1" {
		t.Errorf("direct payload lost its identity fields: %v", direct)
	}

	group := <-bodies
	if group["isGroup"] != true {
		t.Errorf("group payload isGroup = %v, want true", group["isGroup"])
	}
}
