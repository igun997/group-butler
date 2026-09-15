package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

func newMemoryBatchTestStore(t *testing.T) (*mongo.Client, *memoryBatchStore, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	t.Cleanup(cancel)
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	t.Cleanup(func() { _ = client.Disconnect(context.Background()) })
	resetMemoryIndexes(t, ctx, db)
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensure indexes: %v", err)
	}
	store := newMemoryBatchStore(db, "memory-batch-test")
	for _, coll := range []*mongo.Collection{store.groups, store.messages, store.batches, store.settings} {
		if _, err := coll.DeleteMany(ctx, bson.D{{Key: "organizationId", Value: store.organizationID}}); err != nil {
			t.Fatalf("clear %s: %v", coll.Name(), err)
		}
	}
	return client, store, ctx
}

func resetMemoryIndexes(t *testing.T, ctx context.Context, db *mongo.Database) {
	t.Helper()
	for _, index := range []struct {
		collection string
		name       string
	}{
		{collMessages, "memory_batch_scan"},
		{collMemoryBatches, "uniq_memory_batch_range"},
		{collMemoryBatches, "uniq_memory_batch_predecessor"},
		{collMemoryBatches, "memory_batch_claim"},
		{collMemoryBatches, "memory_batch_group_history"},
		{collMemorySummaries, "uniq_memory_summary_batch"},
		{collMemorySummaries, "memory_summary_recent"},
		{collMemorySummaries, "memory_summary_text"},
		{collMemoryFacts, "uniq_memory_fact_in_batch"},
		{collMemoryFacts, "memory_fact_recent"},
		{collMemoryFacts, "memory_fact_text"},
		{collMemoryFacts, "memory_fact_summary"},
		{collAgentReplyRuns, "uniq_agent_reply_source"},
		{collAgentReplyRuns, "agent_reply_recovery"},
	} {
		_ = db.Collection(index.collection).Indexes().DropOne(ctx, index.name)
	}
}

func insertEligibleGroup(t *testing.T, ctx context.Context, store *memoryBatchStore, instanceID, groupJID string) {
	t.Helper()
	_, err := store.groups.InsertOne(ctx, bson.D{
		{Key: "organizationId", Value: store.organizationID},
		{Key: "instanceId", Value: instanceID},
		{Key: "groupJid", Value: groupJID},
		{Key: "config", Value: bson.D{{Key: "assigned", Value: true}, {Key: "whitelisted", Value: true}}},
	})
	if err != nil {
		t.Fatalf("insert eligible group: %v", err)
	}
}

func insertMemoryMessage(t *testing.T, ctx context.Context, store *memoryBatchStore, instanceID, groupJID, id string, at time.Time, revoked bool) {
	t.Helper()
	_, err := store.messages.InsertOne(ctx, bson.D{
		{Key: "organizationId", Value: store.organizationID},
		{Key: "instanceId", Value: instanceID},
		{Key: "groupJid", Value: groupJID},
		{Key: "waMessageId", Value: id},
		{Key: "timestamp", Value: at},
		{Key: "text", Value: id},
		{Key: "flags", Value: bson.D{{Key: "revoked", Value: revoked}}},
	})
	if err != nil {
		t.Fatalf("insert message %s: %v", id, err)
	}
}

func TestMemoryBatchBuildsDeterministicEligibleRanges(t *testing.T) {
	_, store, ctx := newMemoryBatchTestStore(t)
	at := time.Date(2026, 9, 15, 10, 0, 0, 0, time.UTC)
	insertEligibleGroup(t, ctx, store, "inst", "allowed@g.us")
	for i := 0; i < 101; i++ {
		insertMemoryMessage(t, ctx, store, "inst", "allowed@g.us", memoryMessageID(i), at.Add(time.Duration(i)*time.Minute), false)
	}
	insertMemoryMessage(t, ctx, store, "inst", "allowed@g.us", "revoked", at.Add(102*time.Minute), true)
	if err := store.BuildReady(ctx, at.Add(3*time.Hour)); err != nil {
		t.Fatalf("BuildReady: %v", err)
	}
	var batch memoryBatch
	if err := store.batches.FindOne(ctx, bson.D{{Key: "organizationId", Value: store.organizationID}}).Decode(&batch); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if batch.SourceCount != 100 || len(batch.SourceWaMessageIDs) != 100 || batch.SourceWaMessageIDs[0] != memoryMessageID(0) || batch.SourceWaMessageIDs[99] != memoryMessageID(99) || batch.First.WaMessageID != memoryMessageID(0) || batch.Last.WaMessageID != memoryMessageID(99) {
		t.Fatalf("range = count %d, ids %#v, %s..%s; want immutable 100-row provenance", batch.SourceCount, batch.SourceWaMessageIDs, batch.First.WaMessageID, batch.Last.WaMessageID)
	}
	if err := store.BuildReady(ctx, at.Add(3*time.Hour)); err != nil {
		t.Fatalf("duplicate BuildReady: %v", err)
	}
	count, err := store.batches.CountDocuments(ctx, bson.D{{Key: "organizationId", Value: store.organizationID}})
	if err != nil || count != 1 {
		t.Fatalf("duplicate materialization count = %d, %v; want 1", count, err)
	}
}

func TestMemoryBatchBuildsNextRangeAfterAuthorizationRedactionCompletesPriorRange(t *testing.T) {
	_, store, ctx := newMemoryBatchTestStore(t)
	at := time.Date(2026, 9, 15, 10, 0, 0, 0, time.UTC)
	insertEligibleGroup(t, ctx, store, "inst", "redacted@g.us")
	insertMemoryMessage(t, ctx, store, "inst", "redacted@g.us", "first", at, false)
	if err := store.BuildReady(ctx, at); err != nil {
		t.Fatalf("BuildReady first range: %v", err)
	}
	if _, err := store.batches.UpdateOne(ctx, bson.D{{Key: "organizationId", Value: store.organizationID}, {Key: "groupJid", Value: "redacted@g.us"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "state", Value: memoryBatchComplete}, {Key: "lease", Value: nil}}}}); err != nil {
		t.Fatalf("complete redacted range: %v", err)
	}
	insertMemoryMessage(t, ctx, store, "inst", "redacted@g.us", "second", at.Add(time.Minute), false)
	if err := store.BuildReady(ctx, at.Add(2*time.Minute)); err != nil {
		t.Fatalf("BuildReady next range: %v", err)
	}
	count, err := store.batches.CountDocuments(ctx, bson.D{{Key: "organizationId", Value: store.organizationID}, {Key: "groupJid", Value: "redacted@g.us"}})
	if err != nil || count != 2 {
		t.Fatalf("completed authorization redaction froze subsequent materialization: count %d, err %v", count, err)
	}
}

func TestMemoryBatchExtendsEqualTimestampRunAndHonorsDayWindow(t *testing.T) {
	_, store, ctx := newMemoryBatchTestStore(t)
	at := time.Date(2026, 9, 15, 10, 0, 0, 0, time.UTC)
	insertEligibleGroup(t, ctx, store, "inst", "equal@g.us")
	for i := 0; i < 105; i++ {
		insertMemoryMessage(t, ctx, store, "inst", "equal@g.us", memoryMessageID(i), at, false)
	}
	insertMemoryMessage(t, ctx, store, "inst", "equal@g.us", "outside-day", at.Add(25*time.Hour), false)
	if err := store.BuildReady(ctx, at.Add(26*time.Hour)); err != nil {
		t.Fatalf("BuildReady: %v", err)
	}
	var batch memoryBatch
	if err := store.batches.FindOne(ctx, bson.D{{Key: "groupJid", Value: "equal@g.us"}}).Decode(&batch); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if batch.SourceCount != 105 || batch.Last.WaMessageID != memoryMessageID(104) {
		t.Fatalf("equal timestamp range = %d through %s, want all 105", batch.SourceCount, batch.Last.WaMessageID)
	}
}

func TestMemoryBatchClaimLeaseRecoveryAndRetry(t *testing.T) {
	_, store, ctx := newMemoryBatchTestStore(t)
	at := time.Date(2026, 9, 15, 10, 0, 0, 0, time.UTC)
	batch := memoryBatch{OrganizationID: store.organizationID, InstanceID: "inst", GroupJID: "group@g.us", First: memoryBatchKey{Timestamp: at, WaMessageID: "a"}, Last: memoryBatchKey{Timestamp: at, WaMessageID: "a"}, State: memoryBatchReady, NextAttemptAt: &at, CreatedAt: at, UpdatedAt: at}
	result, err := store.batches.InsertOne(ctx, batch)
	if err != nil {
		t.Fatalf("insert batch: %v", err)
	}
	id := result.InsertedID.(bson.ObjectID)
	first, err := store.Claim(ctx, at, "worker-a")
	if err != nil || first == nil {
		t.Fatalf("first claim = %#v, %v", first, err)
	}
	if second, err := store.Claim(ctx, at, "worker-b"); err != nil || second != nil {
		t.Fatalf("concurrent claim = %#v, %v; want none", second, err)
	}
	if err := store.RecoverExpired(ctx, at.Add(memoryBatchLease+time.Second)); err != nil {
		t.Fatalf("RecoverExpired: %v", err)
	}
	reclaimed, err := store.Claim(ctx, at.Add(memoryBatchLease+time.Second), "worker-b")
	if err != nil || reclaimed == nil || reclaimed.ID != id || reclaimed.Attempts != 2 {
		t.Fatalf("reclaimed = %#v, %v; want second lease on same batch", reclaimed, err)
	}
	if err := store.Fail(ctx, reclaimed.ID, reclaimed.Lease.Token, at, memoryFailureRetryable, "callback", "unavailable"); err != nil {
		t.Fatalf("Fail: %v", err)
	}
	var retry memoryBatch
	if err := store.batches.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&retry); err != nil {
		t.Fatalf("read retry batch: %v", err)
	}
	if retry.State != memoryBatchRetryWait || retry.NextAttemptAt.Before(at.Add(8*time.Minute)) || retry.NextAttemptAt.After(at.Add(12*time.Minute)) || retry.Lease != nil {
		t.Fatalf("retry = state %s next %s lease %#v; want retry_wait within the 20%% jittered 10m window and no lease", retry.State, retry.NextAttemptAt, retry.Lease)
	}
}

func TestMemoryBatchExpiredFinalAttemptBecomesDeadAndCannotBeClaimed(t *testing.T) {
	_, store, ctx := newMemoryBatchTestStore(t)
	at := time.Date(2026, 9, 15, 10, 0, 0, 0, time.UTC)
	expired := at.Add(-time.Second)
	result, err := store.batches.InsertOne(ctx, memoryBatch{
		OrganizationID: store.organizationID,
		InstanceID:     "inst",
		GroupJID:       "exhausted@g.us",
		First:          memoryBatchKey{Timestamp: at, WaMessageID: "message"},
		Last:           memoryBatchKey{Timestamp: at, WaMessageID: "message"},
		State:          memoryBatchProcessing,
		Lease:          &memoryBatchLeaseDoc{Owner: "lost-worker", Token: "lost-token", ExpiresAt: expired},
		Attempts:       memoryBatchMaxAttempts,
		CreatedAt:      at,
		UpdatedAt:      at,
	})
	if err != nil {
		t.Fatalf("insert exhausted batch: %v", err)
	}
	id := result.InsertedID.(bson.ObjectID)
	if err := store.RecoverExpired(ctx, at); err != nil {
		t.Fatalf("RecoverExpired: %v", err)
	}
	var recovered memoryBatch
	if err := store.batches.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&recovered); err != nil {
		t.Fatalf("read recovered batch: %v", err)
	}
	if recovered.State != memoryBatchDead || recovered.Lease != nil || recovered.NextAttemptAt != nil {
		t.Fatalf("exhausted recovered batch = state %s lease %#v next %#v; want dead without a lease or retry", recovered.State, recovered.Lease, recovered.NextAttemptAt)
	}
	if claimed, err := store.Claim(ctx, at, "new-worker"); err != nil || claimed != nil {
		t.Fatalf("Claim exhausted batch = %#v, %v; want no claim", claimed, err)
	}
}

func TestMemoryBatchBuildSkipsGroupWithOutstandingRange(t *testing.T) {
	_, store, ctx := newMemoryBatchTestStore(t)
	at := time.Date(2026, 9, 15, 10, 0, 0, 0, time.UTC)
	insertEligibleGroup(t, ctx, store, "inst", "outstanding@g.us")
	insertMemoryMessage(t, ctx, store, "inst", "outstanding@g.us", "first", at, false)
	if err := store.BuildReady(ctx, at); err != nil {
		t.Fatalf("first BuildReady: %v", err)
	}
	if _, err := store.batches.UpdateOne(ctx, bson.D{{Key: "organizationId", Value: store.organizationID}, {Key: "groupJid", Value: "outstanding@g.us"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "state", Value: memoryBatchDead}}}}); err != nil {
		t.Fatalf("mark outstanding generation dead: %v", err)
	}
	insertMemoryMessage(t, ctx, store, "inst", "outstanding@g.us", "later", at.Add(time.Minute), false)
	if err := store.BuildReady(ctx, at.Add(2*time.Minute)); err != nil {
		t.Fatalf("second BuildReady: %v", err)
	}
	count, err := store.batches.CountDocuments(ctx, bson.D{
		{Key: "organizationId", Value: store.organizationID},
		{Key: "instanceId", Value: "inst"},
		{Key: "groupJid", Value: "outstanding@g.us"},
	})
	if err != nil {
		t.Fatalf("count outstanding batches: %v", err)
	}
	if count != 1 {
		t.Fatalf("outstanding range count = %d, want 1 so raw ranges cannot overlap", count)
	}
}

func memoryMessageID(n int) string { return string(rune('a'+n/26)) + string(rune('a'+n%26)) }

func TestMemoryRetryDelayIsBoundedExponential(t *testing.T) {
	if got := memoryRetryDelay(1); got != 5*time.Minute {
		t.Fatalf("first retry = %s, want 5m", got)
	}
	if got := memoryRetryDelay(99); got != 6*time.Hour {
		t.Fatalf("late retry = %s, want 6h cap", got)
	}
}

func TestMemoryCallbackFailureClassifiesTerminalStatuses(t *testing.T) {
	for _, status := range []int{http.StatusBadRequest, http.StatusUnauthorized, http.StatusUnprocessableEntity} {
		if got := memoryCallbackFailureClass(status); got != memoryFailureTerminal {
			t.Fatalf("status %d class = %s, want terminal", status, got)
		}
	}
	for _, status := range []int{http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		if got := memoryCallbackFailureClass(status); got != memoryFailureRetryable {
			t.Fatalf("status %d class = %s, want retryable", status, got)
		}
	}
}

func TestMemoryBatchWorkerPostsOnlyBatchIDAndRetriesNonSuccess(t *testing.T) {
	_, store, ctx := newMemoryBatchTestStore(t)
	at := time.Now().UTC()
	due := at
	result, err := store.batches.InsertOne(ctx, memoryBatch{
		OrganizationID: store.organizationID,
		InstanceID:     "inst",
		GroupJID:       "callback@g.us",
		First:          memoryBatchKey{Timestamp: at, WaMessageID: "message"},
		Last:           memoryBatchKey{Timestamp: at, WaMessageID: "message"},
		State:          memoryBatchReady,
		NextAttemptAt:  &due,
		CreatedAt:      at,
		UpdatedAt:      at,
	})
	if err != nil {
		t.Fatalf("insert batch: %v", err)
	}
	id := result.InsertedID.(bson.ObjectID)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if got := r.URL.Path; got != "/prefix/api/internal/memory-batches" {
			t.Errorf("callback path = %q, want configured callback path", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer callback-secret" {
			t.Errorf("Authorization = %q", got)
		}
		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode callback payload: %v", err)
		}
		if len(payload) != 1 || payload["batchId"] != id.Hex() {
			t.Errorf("callback payload = %#v, want only batchId %s", payload, id.Hex())
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	worker := &memoryBatchWorker{
		store:  store,
		cfg:    Config{MemoryCallbackURL: server.URL + "/prefix/api/internal/memory-batches", MemoryCallbackSecret: "callback-secret", MemoryBatchConcurrency: 2},
		owner:  "test-worker",
		client: server.Client(),
	}
	if err := worker.RunOnce(ctx, at); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("callback calls = %d, want 1", calls.Load())
	}
	var batch memoryBatch
	if err := store.batches.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&batch); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if batch.State != memoryBatchRetryWait || batch.Lease != nil || batch.NextAttemptAt == nil {
		t.Fatalf("non-2xx batch = state %s lease %#v next %#v; want retry_wait without lease", batch.State, batch.Lease, batch.NextAttemptAt)
	}
}

func TestMemoryBatchWorkerCapsActiveClaimsAcrossConcurrentPasses(t *testing.T) {
	_, store, ctx := newMemoryBatchTestStore(t)
	at := time.Date(2026, 9, 15, 10, 0, 0, 0, time.UTC)
	due := at
	for i := range 4 {
		if _, err := store.batches.InsertOne(ctx, memoryBatch{
			OrganizationID: store.organizationID,
			InstanceID:     "inst",
			GroupJID:       "slot-" + memoryMessageID(i) + "@g.us",
			First:          memoryBatchKey{Timestamp: at, WaMessageID: memoryMessageID(i)},
			Last:           memoryBatchKey{Timestamp: at, WaMessageID: memoryMessageID(i)},
			State:          memoryBatchReady,
			NextAttemptAt:  &due,
			CreatedAt:      at,
			UpdatedAt:      at,
		}); err != nil {
			t.Fatalf("insert batch %d: %v", i, err)
		}
	}
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	released := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		entered <- struct{}{}
		<-release
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	defer func() {
		if !released {
			close(release)
		}
	}()
	workerA := &memoryBatchWorker{
		store:  store,
		cfg:    Config{MemoryCallbackURL: server.URL, MemoryCallbackSecret: "callback-secret", MemoryBatchConcurrency: 2},
		owner:  "worker-a",
		client: server.Client(),
	}
	workerB := &memoryBatchWorker{
		store:  store,
		cfg:    Config{MemoryCallbackURL: server.URL, MemoryCallbackSecret: "callback-secret", MemoryBatchConcurrency: 2},
		owner:  "worker-b",
		client: server.Client(),
	}
	runCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	done := make(chan error, 2)
	go func() { done <- workerA.RunOnce(runCtx, at) }()
	go func() { done <- workerB.RunOnce(runCtx, at) }()
	for range 2 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("worker did not start both configured processor slots")
		}
	}
	select {
	case <-entered:
		t.Fatal("more than MEMORY_BATCH_CONCURRENCY batches became actively claimed")
	case <-time.After(150 * time.Millisecond):
	}
	close(release)
	released = true
	for range 2 {
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("RunOnce: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("RunOnce did not finish after blocked callbacks were released")
		}
	}
}

func TestMemoryBatchConcurrentBuildersUseOnePredecessorGeneration(t *testing.T) {
	_, store, ctx := newMemoryBatchTestStore(t)
	at := time.Date(2026, 9, 15, 10, 0, 0, 0, time.UTC)
	insertEligibleGroup(t, ctx, store, "inst", "generation@g.us")
	insertMemoryMessage(t, ctx, store, "inst", "generation@g.us", "first", at, false)

	firstScanned := make(chan struct{})
	secondScanned := make(chan struct{})
	release := make(chan struct{})
	var scans atomic.Int32
	store.beforeMemoryBatchMaterialize = func() {
		if scans.Add(1) == 1 {
			firstScanned <- struct{}{}
		} else {
			secondScanned <- struct{}{}
		}
		<-release
	}
	done := make(chan error, 2)
	go func() { done <- store.BuildReady(ctx, at) }()
	select {
	case <-firstScanned:
	case <-time.After(time.Second):
		t.Fatal("first builder did not scan its raw range")
	}
	insertMemoryMessage(t, ctx, store, "inst", "generation@g.us", "later", at.Add(time.Minute), false)
	go func() { done <- store.BuildReady(ctx, at.Add(time.Minute)) }()
	select {
	case <-secondScanned:
	case <-time.After(time.Second):
		t.Fatal("second builder did not scan the later raw range")
	}
	close(release)
	for range 2 {
		if err := <-done; err != nil {
			t.Fatalf("BuildReady: %v", err)
		}
	}
	count, err := store.batches.CountDocuments(ctx, bson.D{{Key: "organizationId", Value: store.organizationID}, {Key: "groupJid", Value: "generation@g.us"}})
	if err != nil {
		t.Fatalf("count materialized generations: %v", err)
	}
	if count != 1 {
		t.Fatalf("competing ranges from the same predecessor created %d batches, want 1", count)
	}
}
func TestMemoryBatchWorkerSuccessfulCallbackLeavesBFFHandoffAndReleasesSlot(t *testing.T) {
	_, store, ctx := newMemoryBatchTestStore(t)
	at := time.Now().UTC()
	due := at
	result, err := store.batches.InsertOne(ctx, memoryBatch{
		OrganizationID: store.organizationID,
		InstanceID:     "inst",
		GroupJID:       "success@g.us",
		First:          memoryBatchKey{Timestamp: at, WaMessageID: "message"},
		Last:           memoryBatchKey{Timestamp: at, WaMessageID: "message"},
		Predecessor:    memoryBatchOrigin,
		State:          memoryBatchReady,
		NextAttemptAt:  &due,
		CreatedAt:      at,
		UpdatedAt:      at,
	})
	if err != nil {
		t.Fatalf("insert batch: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer server.Close()
	worker := &memoryBatchWorker{store: store, cfg: Config{MemoryCallbackURL: server.URL, MemoryCallbackSecret: "callback-secret", MemoryBatchConcurrency: 1}, owner: "worker", client: server.Client()}
	if err := worker.RunOnce(ctx, at); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	var batch memoryBatch
	if err := store.batches.FindOne(ctx, bson.D{{Key: "_id", Value: result.InsertedID}}).Decode(&batch); err != nil {
		t.Fatalf("read handoff batch: %v", err)
	}
	if batch.State != memoryBatchProcessing {
		t.Fatalf("successful callback state = %s, want processing for BFF handoff", batch.State)
	}
	var slot memoryProcessorSlot
	if err := store.settings.FindOne(ctx, bson.D{{Key: "organizationId", Value: store.organizationID}}).Decode(&slot); err != nil {
		t.Fatalf("read released slot: %v", err)
	}
	if slot.ExpiresAt.After(time.Now().UTC()) {
		t.Fatalf("slot remains leased until %s after callback success", slot.ExpiresAt)
	}
}
func TestMemoryCleanupContextSurvivesParentCancellationWithDeadline(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	cancelParent()
	cleanup, cancelCleanup := memoryCleanupContext(parent)
	defer cancelCleanup()
	if err := cleanup.Err(); err != nil {
		t.Fatalf("cleanup context inherited cancellation: %v", err)
	}
	deadline, ok := cleanup.Deadline()
	if !ok || time.Until(deadline) > memoryCleanupTimeout || time.Until(deadline) <= 0 {
		t.Fatalf("cleanup deadline = %s, %t; want a live bounded deadline", deadline, ok)
	}
}

func TestMemoryBatchWorkerCancellationUsesBoundedCleanupForRetryAndSlotRelease(t *testing.T) {
	_, store, ctx := newMemoryBatchTestStore(t)
	at := time.Now().UTC()
	due := at
	result, err := store.batches.InsertOne(ctx, memoryBatch{
		OrganizationID: store.organizationID,
		InstanceID:     "inst",
		GroupJID:       "cancel@g.us",
		First:          memoryBatchKey{Timestamp: at, WaMessageID: "message"},
		Last:           memoryBatchKey{Timestamp: at, WaMessageID: "message"},
		Predecessor:    memoryBatchOrigin,
		State:          memoryBatchReady,
		NextAttemptAt:  &due,
		CreatedAt:      at,
		UpdatedAt:      at,
	})
	if err != nil {
		t.Fatalf("insert batch: %v", err)
	}
	requestStarted := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		requestStarted <- struct{}{}
		<-r.Context().Done()
	}))
	t.Cleanup(func() {
		server.CloseClientConnections()
		_ = server.Listener.Close()
	})
	worker := &memoryBatchWorker{store: store, cfg: Config{MemoryCallbackURL: server.URL, MemoryCallbackSecret: "callback-secret", MemoryBatchConcurrency: 1}, owner: "worker", client: server.Client()}
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- worker.RunOnce(runCtx, at) }()
	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("callback request did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("RunOnce did not return after callback request cancellation")
	}
	var batch memoryBatch
	if err := store.batches.FindOne(ctx, bson.D{{Key: "_id", Value: result.InsertedID}}).Decode(&batch); err != nil {
		t.Fatalf("read cancelled batch: %v", err)
	}
	if batch.State != memoryBatchRetryWait || batch.Lease != nil {
		t.Fatalf("cancelled batch = state %s lease %#v, want retry_wait without lease", batch.State, batch.Lease)
	}
	var slot memoryProcessorSlot
	if err := store.settings.FindOne(ctx, bson.D{{Key: "organizationId", Value: store.organizationID}}).Decode(&slot); err != nil {
		t.Fatalf("read cancelled slot: %v", err)
	}
	if slot.ExpiresAt.After(time.Now().UTC()) {
		t.Fatalf("slot remains leased until %s after cancellation", slot.ExpiresAt)
	}
}
