package main

import (
	"context"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type storedSend struct {
	Status   string `bson:"status"`
	Dispatch struct {
		WaMessageID string `bson:"waMessageId"`
		Attempts    int    `bson:"attempts"`
		ErrorClass  string `bson:"errorClass"`
	} `bson:"dispatch"`
}

func newTestDispatcher(t *testing.T) (*sendDispatcher, *manager, *sendRecorder, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	t.Cleanup(cancel)
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_dispatch_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	t.Cleanup(func() { _ = client.Disconnect(context.Background()) })
	for _, coll := range []string{collSendRequests, collMessages} {
		if err := db.Collection(coll).Drop(ctx); err != nil {
			t.Fatalf("drop %s: %v", coll, err)
		}
	}
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensure indexes: %v", err)
	}
	cfg := testConfig()
	cfg.SendMaxAttempts = 3
	cfg.DispatchInterval = time.Hour
	dispatcher := newSendDispatcher(db, cfg)
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	recorder := &sendRecorder{fakeClient: newFakeClient()}
	session := testSession(mgr, recorder)
	session.status = stateConnected
	mgr.put(session)
	return dispatcher, mgr, recorder, ctx
}

func TestDispatcherClaimsDueApprovalAndStoresWhatsAppAcknowledgement(t *testing.T) {
	dispatcher, mgr, _, ctx := newTestDispatcher(t)
	now := time.Now().UTC()
	_, err := dispatcher.requests.InsertOne(ctx, bson.M{
		"id": "send_123", "organizationId": "org_default", "instanceId": "inst_1",
		"groupJid": "120363043123456789@g.us", "text": "Ship it", "status": "approved", "scheduledFor": now,
		"dispatch": bson.M{"attempts": 0, "lockedAt": nil, "lockedBy": nil},
	})
	if err != nil {
		t.Fatalf("seed send: %v", err)
	}

	dispatcher.dispatchDue(ctx, mgr)

	var stored storedSend
	if err := dispatcher.requests.FindOne(ctx, bson.M{"id": "send_123"}).Decode(&stored); err != nil {
		t.Fatalf("read send: %v", err)
	}
	if got, want := stored.Status, "sent"; got != want {
		t.Fatalf("status = %v, want %q", got, want)
	}
	if got, want := stored.Dispatch.WaMessageID, "sent_by_fake"; got != want {
		t.Fatalf("waMessageId = %v, want %q", got, want)
	}
	if got, want := stored.Dispatch.Attempts, 1; got != want {
		t.Fatalf("attempts = %v, want %v", got, want)
	}
}

func TestDispatcherDoesNotClaimFutureSchedule(t *testing.T) {
	dispatcher, mgr, _, ctx := newTestDispatcher(t)
	_, err := dispatcher.requests.InsertOne(ctx, bson.M{
		"id": "send_future", "organizationId": "org_default", "instanceId": "inst_1",
		"groupJid": "120363043123456789@g.us", "text": "Later", "status": "scheduled", "scheduledFor": time.Now().Add(time.Hour),
		"dispatch": bson.M{"attempts": 0, "lockedAt": nil, "lockedBy": nil},
	})
	if err != nil {
		t.Fatalf("seed send: %v", err)
	}

	dispatcher.dispatchDue(ctx, mgr)

	var stored storedSend
	if err := dispatcher.requests.FindOne(ctx, bson.M{"id": "send_future"}).Decode(&stored); err != nil {
		t.Fatalf("read send: %v", err)
	}
	if got, want := stored.Status, "scheduled"; got != want {
		t.Fatalf("status = %v, want %q", got, want)
	}
	if got, want := stored.Dispatch.Attempts, 0; got != want {
		t.Fatalf("attempts = %v, want %v", got, want)
	}
}

// The send numbers the console shows are written by the dispatch path itself, in
// both directions: this drives a due claim for a connected instance and one for
// an instance with no live session, and reads the counters each produced.
func TestDispatcherCountsBothSendOutcomes(t *testing.T) {
	dispatcher, mgr, _, ctx := newTestDispatcher(t)
	stats := &fakeDayCounters{}
	repo := newFakeInstanceRepo()
	mgr.stats = stats
	mgr.instances = repo

	seed := func(id, instanceID string) {
		t.Helper()
		_, err := dispatcher.requests.InsertOne(ctx, bson.M{
			"id": id, "organizationId": "org_default", "instanceId": instanceID,
			"groupJid": "120363043123456789@g.us", "text": "Ship it", "status": "approved", "scheduledFor": time.Now().UTC(),
			"dispatch": bson.M{"attempts": 0, "lockedAt": nil, "lockedBy": nil},
		})
		if err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}
	seed("send_ok", "inst_1")
	// No session for this id: the dispatcher's own offline classification is the
	// failure path a real deployment hits on a disconnected phone.
	seed("send_failed", "inst_gone")

	if err := dispatcher.dispatchDue(ctx, mgr); err != nil {
		t.Fatalf("dispatchDue: %v", err)
	}

	if got := repo.counters["inst_1"][runtimeCounterSendOk]; got != 1 {
		t.Errorf("%s = %d, want 1 for the acknowledged send", runtimeCounterSendOk, got)
	}
	if got := repo.counters["inst_gone"][runtimeCounterSendFailed]; got != 1 {
		t.Errorf("%s = %d, want 1 for the refused send", runtimeCounterSendFailed, got)
	}

	counters := map[string]int64{}
	for _, call := range stats.recorded() {
		if call.groupJID != "120363043123456789@g.us" {
			t.Errorf("group = %q, want the group the send went to", call.groupJID)
		}
		counters[call.counter] += call.count
	}
	if counters[dayCounterSendsSent] != 1 {
		t.Errorf("%s = %d, want 1", dayCounterSendsSent, counters[dayCounterSendsSent])
	}
	if counters[dayCounterSendsFailed] != 1 {
		t.Errorf("%s = %d, want 1", dayCounterSendsFailed, counters[dayCounterSendsFailed])
	}
}

// The stored row is a shared schema: the BFF writes it and the dispatcher reads
// it, so the field the direct chat is carried in is pinned here without Mongo.
// A row written before that field existed decodes to no kind, which dispatches
// as a group.
func TestDispatchRequestCarriesChatKind(t *testing.T) {
	raw, err := bson.Marshal(dispatchRequest{ID: "send_123", GroupJID: "628990000009@s.whatsapp.net", ChatKind: chatKindUser, Text: "hi"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var doc bson.M
	if err := bson.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got := doc["chatKind"]; got != chatKindUser {
		t.Errorf("chatKind = %v, want %q", got, chatKindUser)
	}

	legacy := bson.M{"id": "send_123", "groupJid": "120363043123456789@g.us", "text": "hi"}
	legacyRaw, err := bson.Marshal(legacy)
	if err != nil {
		t.Fatalf("marshal legacy: %v", err)
	}
	var request dispatchRequest
	if err := bson.Unmarshal(legacyRaw, &request); err != nil {
		t.Fatalf("unmarshal legacy: %v", err)
	}
	if request.ChatKind != "" {
		t.Errorf("chatKind = %q for a row without the field, want empty", request.ChatKind)
	}
}

// The reply a send answers is carried by the stored row — the BFF writes
// `provenance.replyToMessageId` and the dispatcher reads it — so the nested
// field is pinned here, without Mongo, in both directions. A send created any
// other way has no provenance at all and must decode to no reply target.
func TestDispatchRequestCarriesReplyToMessageID(t *testing.T) {
	raw, err := bson.Marshal(bson.M{
		"id": "send_123", "groupJid": "120363043123456789@g.us", "text": "Answered",
		"provenance": bson.M{"source": "owner_mention", "replyToMessageId": "3EB0OWNER"},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var request dispatchRequest
	if err := bson.Unmarshal(raw, &request); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got, want := request.Provenance.ReplyToMessageID, "3EB0OWNER"; got != want {
		t.Errorf("replyToMessageId = %q, want %q", got, want)
	}

	encoded, err := bson.Marshal(dispatchRequest{ID: "send_123", Provenance: sendProvenance{ReplyToMessageID: "3EB0OWNER"}})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	var stored struct {
		Provenance map[string]any `bson:"provenance"`
	}
	if err := bson.Unmarshal(encoded, &stored); err != nil {
		t.Fatalf("unmarshal request: %v", err)
	}
	if got := stored.Provenance["replyToMessageId"]; got != "3EB0OWNER" {
		t.Errorf("stored replyToMessageId = %v, want 3EB0OWNER", got)
	}

	plain, err := bson.Marshal(bson.M{"id": "send_124", "groupJid": "120363043123456789@g.us", "text": "hi"})
	if err != nil {
		t.Fatalf("marshal plain: %v", err)
	}
	var withoutProvenance dispatchRequest
	if err := bson.Unmarshal(plain, &withoutProvenance); err != nil {
		t.Fatalf("unmarshal plain: %v", err)
	}
	if withoutProvenance.Provenance.ReplyToMessageID != "" {
		t.Errorf("replyToMessageId = %q for a row without provenance, want empty", withoutProvenance.Provenance.ReplyToMessageID)
	}
}

// seedSend writes one approved request as the BFF leaves it: the queue's own
// fields plus, when the send answers a message, the reply provenance.
func seedSend(t *testing.T, dispatcher *sendDispatcher, ctx context.Context, id, text, replyTo string) {
	t.Helper()
	row := bson.M{
		"id": id, "organizationId": "org_default", "instanceId": "inst_1",
		"groupJid": "120363043123456789@g.us", "text": text, "status": "approved", "scheduledFor": time.Now().UTC(),
		"dispatch": bson.M{"attempts": 0, "lockedAt": nil, "lockedBy": nil},
	}
	if replyTo != "" {
		row["provenance"] = bson.M{"source": "owner_mention", "replyToMessageId": replyTo}
	}
	if _, err := dispatcher.requests.InsertOne(ctx, row); err != nil {
		t.Fatalf("seed send %s: %v", id, err)
	}
}

// A send that answers a stored message leaves as a quoted reply to it: the id is
// the request row's, and the participant is the sender of the message that id
// names, read from the stored message. Nothing here is decided by the dispatcher
// itself.
func TestDispatcherQuotesTheStoredMessageBeingAnswered(t *testing.T) {
	dispatcher, mgr, recorder, ctx := newTestDispatcher(t)
	const (
		group       = "120363043123456789@g.us"
		answered    = "3EB0OWNER"
		participant = "628990000001@s.whatsapp.net"
	)
	if _, err := dispatcher.messages.InsertOne(ctx, bson.M{
		"organizationId": "org_default", "instanceId": "inst_1", "waMessageId": answered,
		"groupJid": group, "senderJid": participant,
	}); err != nil {
		t.Fatalf("seed the message being answered: %v", err)
	}
	seedSend(t, dispatcher, ctx, "send_123", "Answered", answered)

	if err := dispatcher.dispatchDue(ctx, mgr); err != nil {
		t.Fatalf("dispatchDue: %v", err)
	}

	if len(recorder.sent) != 1 {
		t.Fatalf("sends = %d, want 1", len(recorder.sent))
	}
	context := recorder.sent[0].message.GetExtendedTextMessage().GetContextInfo()
	if got, want := context.GetStanzaID(), answered; got != want {
		t.Errorf("StanzaID = %q, want %q", got, want)
	}
	if got, want := context.GetParticipant(), participant; got != want {
		t.Errorf("Participant = %q, want %q", got, want)
	}
	var stored storedSend
	if err := dispatcher.requests.FindOne(ctx, bson.M{"id": "send_123"}).Decode(&stored); err != nil {
		t.Fatalf("read send: %v", err)
	}
	if got, want := stored.Status, "sent"; got != want {
		t.Errorf("status = %q, want %q", got, want)
	}
}

// A row with no reply provenance keeps the plain envelope: this is what every
// send written before the field existed looks like, and it must not change.
func TestDispatcherLeavesSendsWithoutReplyProvenancePlain(t *testing.T) {
	dispatcher, mgr, recorder, ctx := newTestDispatcher(t)
	seedSend(t, dispatcher, ctx, "send_123", "Ship it", "")

	if err := dispatcher.dispatchDue(ctx, mgr); err != nil {
		t.Fatalf("dispatchDue: %v", err)
	}

	if len(recorder.sent) != 1 {
		t.Fatalf("sends = %d, want 1", len(recorder.sent))
	}
	if got := recorder.sent[0].message.GetConversation(); got != "Ship it" {
		t.Errorf("Conversation = %q, want Ship it", got)
	}
	if got := recorder.sent[0].message.GetExtendedTextMessage(); got != nil {
		t.Errorf("extended text = %v, want no quote at all", got)
	}
}

// A request that answers a message the worker does not hold is refused rather
// than sent unquoted: the row says the send answers that message, so delivering
// it as a plain send would drop part of the instruction while looking delivered.
func TestDispatcherRefusesAQuoteItCannotResolve(t *testing.T) {
	dispatcher, mgr, recorder, ctx := newTestDispatcher(t)
	seedSend(t, dispatcher, ctx, "send_123", "Answered", "3EB0GONE")

	if err := dispatcher.dispatchDue(ctx, mgr); err != nil {
		t.Fatalf("dispatchDue: %v", err)
	}

	if len(recorder.sent) != 0 {
		t.Fatalf("an unresolvable quote reached the client: %+v", recorder.sent)
	}
	var stored storedSend
	if err := dispatcher.requests.FindOne(ctx, bson.M{"id": "send_123"}).Decode(&stored); err != nil {
		t.Fatalf("read send: %v", err)
	}
	if got, want := stored.Status, "failed"; got != want {
		t.Fatalf("status = %q, want %q", got, want)
	}
	// Nothing was handed to WhatsApp, so the retry a `rejected` row offers is
	// safe: it cannot double-post.
	if got, want := stored.Dispatch.ErrorClass, "rejected"; got != want {
		t.Errorf("errorClass = %q, want %q", got, want)
	}
}
