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
	} `bson:"dispatch"`
}

func newTestDispatcher(t *testing.T) (*sendDispatcher, *manager, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	t.Cleanup(cancel)
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_dispatch_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	t.Cleanup(func() { _ = client.Disconnect(context.Background()) })
	if err := db.Collection(collSendRequests).Drop(ctx); err != nil {
		t.Fatalf("drop send requests: %v", err)
	}
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensure indexes: %v", err)
	}
	cfg := testConfig()
	cfg.SendMaxAttempts = 3
	cfg.DispatchInterval = time.Hour
	dispatcher := newSendDispatcher(db, cfg)
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	clientForInstance := newFakeClient()
	session := testSession(mgr, clientForInstance)
	session.status = stateConnected
	mgr.put(session)
	return dispatcher, mgr, ctx
}

func TestDispatcherClaimsDueApprovalAndStoresWhatsAppAcknowledgement(t *testing.T) {
	dispatcher, mgr, ctx := newTestDispatcher(t)
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
	dispatcher, mgr, ctx := newTestDispatcher(t)
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
	dispatcher, mgr, ctx := newTestDispatcher(t)
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
