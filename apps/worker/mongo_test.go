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

func TestWorkerIndexesCoverIngestAndDispatch(t *testing.T) {
	indexes := ingestIndexes()
	cases := []struct {
		coll   string
		name   string
		keys   []string
		unique bool
	}{
		{coll: collMessages, name: "uniq_message", keys: []string{"organizationId", "instanceId", "waMessageId"}, unique: true},
		{coll: collGroups, name: "uniq_group", keys: []string{"organizationId", "instanceId", "groupJid"}, unique: true},
		{coll: collSendRequests, name: "send_due", keys: []string{"status", "scheduledFor"}, unique: false},
	}
	if len(indexes) != len(cases) {
		t.Fatalf("worker index set covers %d collections, want %d", len(indexes), len(cases))
	}
	for _, tc := range cases {
		t.Run(tc.coll, func(t *testing.T) {
			specs := indexes[tc.coll]
			if len(specs) != 1 {
				t.Fatalf("expected exactly one %s index in the worker set, got %d", tc.coll, len(specs))
			}
			if specs[0].Unique != tc.unique {
				t.Errorf("%s unique = %t, want %t", tc.coll, specs[0].Unique, tc.unique)
			}
			if specs[0].Name != tc.name {
				t.Errorf("%s index name = %q, want %q", tc.coll, specs[0].Name, tc.name)
			}
			got := specs[0].Keys
			if len(got) != len(tc.keys) {
				t.Fatalf("%s index keys = %v, want %v", tc.coll, got, tc.keys)
			}
			for i := range tc.keys {
				if got[i] != tc.keys[i] {
					t.Errorf("%s index key %d = %q, want %q (key order defines the index)", tc.coll, i, got[i], tc.keys[i])
				}
			}
		})
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
