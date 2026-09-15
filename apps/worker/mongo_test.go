package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// integrationTimeout bounds every test that talks to a real MongoDB, so a hung
// or unreachable replica set fails the test instead of wedging the suite.
const integrationTimeout = 30 * time.Second

func testMongoURI(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("short mode: skipping mongo integration test")
	}
	return env("TEST_MONGODB_URI", "mongodb://127.0.0.1:27017/?replicaSet=rs0")
}

func TestWorkerIndexesCoverIngestAndMemoryContracts(t *testing.T) {
	indexes := ingestIndexes()
	cases := []struct {
		coll   string
		name   string
		keys   []string
		unique bool
	}{
		{collMessages, "uniq_message", []string{"organizationId", "instanceId", "waMessageId"}, true},
		{collMessages, "memory_batch_scan", []string{"organizationId", "instanceId", "groupJid", "flags.revoked", "timestamp", "waMessageId"}, false},
		{collGroups, "uniq_group", []string{"organizationId", "instanceId", "groupJid"}, true},
		{collSendRequests, "send_due", []string{"status", "scheduledFor"}, false},
		{collMemoryBatches, "uniq_memory_batch_range", []string{"organizationId", "instanceId", "groupJid", "first.timestamp", "first.waMessageId", "last.timestamp", "last.waMessageId"}, true},
		{collMemoryBatches, "uniq_memory_batch_predecessor", []string{"organizationId", "instanceId", "groupJid", "predecessor"}, true},
		{collMemoryBatches, "memory_batch_claim", []string{"organizationId", "state", "nextAttemptAt", "lease.expiresAt", "createdAt"}, false},
		{collMemoryBatches, "memory_batch_group_history", []string{"organizationId", "instanceId", "groupJid", "completedAt"}, false},
		{collMemorySummaries, "uniq_memory_summary_batch", []string{"organizationId", "batchId"}, true},
		{collMemorySummaries, "memory_summary_recent", []string{"organizationId", "instanceId", "groupJid", "period.to"}, false},
		{collMemorySummaries, "memory_summary_text", []string{"summary", "topics", "decisions", "openQuestions", "actionItems"}, false},
		{collMemoryFacts, "uniq_memory_fact_in_batch", []string{"organizationId", "batchId", "kind", "textSearch"}, true},
		{collMemoryFacts, "memory_fact_recent", []string{"organizationId", "instanceId", "groupJid", "kind", "occurredAt"}, false},
		{collMemoryFacts, "memory_fact_text", []string{"text", "subject"}, false},
		{collMemoryFacts, "memory_fact_summary", []string{"organizationId", "summaryId"}, false},
		{collAgentReplyRuns, "uniq_agent_reply_source", []string{"organizationId", "instanceId", "groupJid", "waMessageId"}, true},
		{collAgentReplyRuns, "agent_reply_recovery", []string{"organizationId", "state", "lease.expiresAt"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.coll+"/"+tc.name, func(t *testing.T) {
			var found *indexSpec
			for i := range indexes[tc.coll] {
				if indexes[tc.coll][i].Name == tc.name {
					found = &indexes[tc.coll][i]
					break
				}
			}
			if found == nil {
				t.Fatalf("missing %s index %q", tc.coll, tc.name)
			}
			if found.Unique != tc.unique {
				t.Errorf("%s unique = %t, want %t", tc.name, found.Unique, tc.unique)
			}
			if len(found.Keys) != len(tc.keys) {
				t.Fatalf("%s keys = %v, want %v", tc.name, found.Keys, tc.keys)
			}
			for i := range tc.keys {
				if found.Keys[i] != tc.keys[i] {
					t.Errorf("%s key %d = %q, want %q", tc.name, i, found.Keys[i], tc.keys[i])
				}
			}
		})
	}
}

func TestMemoryIndexSemanticsPreserveDirectionsTextAndPartialGuard(t *testing.T) {
	indexes := ingestIndexes()
	var predecessor, history, summaryText *indexSpec
	for i := range indexes[collMemoryBatches] {
		switch indexes[collMemoryBatches][i].Name {
		case "uniq_memory_batch_predecessor":
			predecessor = &indexes[collMemoryBatches][i]
		case "memory_batch_group_history":
			history = &indexes[collMemoryBatches][i]
		}
	}
	for i := range indexes[collMemorySummaries] {
		if indexes[collMemorySummaries][i].Name == "memory_summary_text" {
			summaryText = &indexes[collMemorySummaries][i]
		}
	}
	if predecessor == nil || !predecessor.Unique || !predecessor.Partial {
		t.Fatalf("predecessor index = %#v, want a unique partial generation guard", predecessor)
	}
	if history == nil || len(history.Directions) != 4 || history.Directions[3] != -1 {
		t.Fatalf("history directions = %#v, want completedAt descending", history)
	}
	if summaryText == nil || !summaryText.Text {
		t.Fatalf("summary text index = %#v, want text key semantics", summaryText)
	}
}

// TestConnectMongoDisconnectsOnPingFailure pins the failure path: a client
// whose handshake fails must be closed before connectMongo returns, or its
// connection pool and topology monitor outlive the call. The assertion is the
// driver's own post-Disconnect state — the handshake is forced to fail, the
// driver internals are not mocked.
func TestConnectMongoDisconnectsOnPingFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()
	uri := testMongoURI(t)

	var handshakeClient *mongo.Client
	origPing := mongoPing
	mongoPing = func(_ context.Context, client *mongo.Client) error {
		handshakeClient = client
		return errors.New("handshake refused")
	}
	t.Cleanup(func() { mongoPing = origPing })

	client, db, err := connectMongo(ctx, uri, "group_butler_test")
	if err == nil {
		t.Fatal("connectMongo succeeded although the handshake failed")
	}
	if client != nil || db != nil {
		t.Fatalf("connectMongo = (%v, %v) on error, want (nil, nil)", client, db)
	}
	if handshakeClient == nil {
		t.Fatal("no client was handed to the handshake: connectMongo never pinged")
	}
	if pingErr := handshakeClient.Ping(ctx, nil); pingErr == nil {
		t.Fatal("the client of a failed connectMongo still pings: it was leaked instead of disconnected")
	}
}

func TestEnsureIndexesIsIdempotent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()
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
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()
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
