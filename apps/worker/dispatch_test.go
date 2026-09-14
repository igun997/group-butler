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
