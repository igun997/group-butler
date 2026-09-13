package main

import (
	"context"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

func testMongoURI(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("short mode: skipping mongo integration test")
	}
	return env("TEST_MONGODB_URI", "mongodb://127.0.0.1:27017/?replicaSet=rs0")
}

func TestIndexForMessagesIsUniqueOnWaMessageID(t *testing.T) {
	idx := ingestIndexes()[collMessages]
	if len(idx) != 1 {
		t.Fatalf("expected exactly one messages index in the worker subset, got %d", len(idx))
	}
	if !idx[0].Unique {
		t.Error("messages waMessageId index must be unique (idempotent ingest)")
	}
	keys := idx[0].Keys
	if len(keys) != 3 || keys[0] != "organizationId" || keys[1] != "instanceId" || keys[2] != "waMessageId" {
		t.Errorf("index keys = %v, want organizationId/instanceId/waMessageId", keys)
	}
}

func TestEnsureIndexesIsIdempotent(t *testing.T) {
	ctx := context.Background()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("first ensureIngestIndexes: %v", err)
	}
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("second ensureIngestIndexes: %v", err)
	}
}

// TestIngestIndexesRejectRedeliveredMessage is the behavioural half of the
// guarantee: the unique index, not application code, is what makes a
// redelivered WhatsApp message a no-op instead of a duplicate row.
func TestIngestIndexesRejectRedeliveredMessage(t *testing.T) {
	ctx := context.Background()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensureIngestIndexes: %v", err)
	}
	coll := db.Collection(collMessages)
	key := bson.D{
		{Key: "organizationId", Value: "org_default"},
		{Key: "instanceId", Value: "inst_redelivery"},
		{Key: "waMessageId", Value: "3EB0TESTREDELIVERY"},
	}
	// A previous run may have left the duplicate behind; the guarantee, not the
	// starting state, is what the test asserts.
	_, _ = coll.DeleteMany(ctx, key)
	if _, err := coll.InsertOne(ctx, key); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	defer func() { _, _ = coll.DeleteMany(ctx, key) }()
	if _, err := coll.InsertOne(ctx, key); err == nil {
		t.Fatal("second insert of the same waMessageId succeeded: the unique index is missing")
	} else if !mongo.IsDuplicateKeyError(err) {
		t.Fatalf("second insert failed with %v, want a duplicate-key error", err)
	}
}
