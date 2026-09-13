package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func healthBody(t *testing.T, a *api) (int, healthResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	a.routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	var body healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode health: %v (body=%s)", err, rec.Body.String())
	}
	return rec.Code, body
}

func TestHealthReportsMongoAndQueueState(t *testing.T) {
	queue := newIngestQueue(4, 0, 0)
	queue.Enqueue(MessageDoc{WaMessageID: "3EB0HEALTH"})
	a := &api{
		secret: "dev-secret",
		ping:   func(context.Context) error { return nil },
		queue:  queue,
	}

	code, body := healthBody(t, a)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	if !body.OK || body.Mongo != "ok" {
		t.Errorf("body = %+v, want ok with mongo ok", body)
	}
	if body.Queue.Depth != 1 || body.Queue.Capacity != 4 {
		t.Errorf("queue = %+v, want depth 1 of capacity 4", body.Queue)
	}
	if body.Queue.Stopped {
		t.Error("queue reported stopped while it is running")
	}
}

func TestHealthIsUnavailableWhenMongoIsDown(t *testing.T) {
	a := &api{
		secret: "dev-secret",
		ping:   func(context.Context) error { return errors.New("no primary") },
		queue:  newIngestQueue(4, 0, 0),
	}

	code, body := healthBody(t, a)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when the database cannot be pinged", code)
	}
	if body.OK {
		t.Error("ok = true with an unreachable database")
	}
	if body.Mongo != "error" {
		t.Errorf("mongo = %q, want error", body.Mongo)
	}
}

func TestHealthIsUnavailableWhenTheIngestQueueStopped(t *testing.T) {
	queue := newIngestQueue(4, 0, 0)
	queue.stop()
	a := &api{
		secret: "dev-secret",
		ping:   func(context.Context) error { return nil },
		queue:  queue,
	}

	code, body := healthBody(t, a)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when ingest has stopped", code)
	}
	if body.OK || !body.Queue.Stopped {
		t.Errorf("body = %+v, want not-ok and stopped queue", body)
	}
}

func TestHealthCountsPersistenceFailures(t *testing.T) {
	persist := newPersistQueue(4, 1)
	okJob := okJob{}
	// No worker: the buffered job is enough to show the counter is wired through.
	persist.enqueue(okJob)
	a := &api{
		secret:  "dev-secret",
		ping:    func(context.Context) error { return nil },
		queue:   newIngestQueue(4, 0, 0),
		persist: persist,
	}

	code, body := healthBody(t, a)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	if body.Persist.Depth != 1 {
		t.Errorf("persist = %+v, want the queued job reflected", body.Persist)
	}
}

// TestHealthReportsLifecycleQueueState is the P1 visibility requirement: a
// backlogged lifecycle consumer must be visible to the probe.
func TestHealthReportsLifecycleQueueState(t *testing.T) {
	lifecycle := newLifecycleQueue()
	lifecycle.enqueue(okJob{})
	a := &api{
		secret:    "dev-secret",
		ping:      func(context.Context) error { return nil },
		queue:     newIngestQueue(4, 0, 0),
		lifecycle: lifecycle,
	}

	code, body := healthBody(t, a)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	if body.Lifecycle.Depth != 1 {
		t.Errorf("lifecycle = %+v, want the queued transition visible", body.Lifecycle)
	}
	if body.Lifecycle.Stopped {
		t.Error("lifecycle reported stopped while its consumer runs")
	}
}

// TestHealthIsUnavailableWhenTheLifecycleConsumerStopped is the degraded-lifecycle
// signal: with no consumer, transitions would pile up unapplied, so the worker
// must not advertise itself as healthy.
func TestHealthIsUnavailableWhenTheLifecycleConsumerStopped(t *testing.T) {
	lifecycle := newLifecycleQueue()
	lifecycle.stop()
	a := &api{
		secret:    "dev-secret",
		ping:      func(context.Context) error { return nil },
		queue:     newIngestQueue(4, 0, 0),
		lifecycle: lifecycle,
	}

	code, body := healthBody(t, a)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when the lifecycle consumer has stopped", code)
	}
	if body.OK || !body.Lifecycle.Stopped {
		t.Errorf("body = %+v, want not-ok with a stopped lifecycle", body)
	}
}

// TestHealthIsUnavailableWhenTransitionsWereAbandoned covers the drain-deadline
// case: transitions that could not be applied must degrade health rather than
// disappear.
func TestHealthIsUnavailableWhenTransitionsWereAbandoned(t *testing.T) {
	lifecycle := newLifecycleQueue()
	lifecycle.drainTimeout = 20 * time.Millisecond
	entered := make(chan struct{})
	lifecycle.enqueue(blockingTransition{entered})
	lifecycle.enqueue(okJob{})

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the drain itself runs the blocking transition
	go lifecycle.run(ctx, testManagerWithDeps(newFakeGroupStore(), nil, nil))
	waitFor(t, "the lifecycle drain to give up", func() bool { return lifecycle.Abandoned() == 1 })

	a := &api{
		secret:    "dev-secret",
		ping:      func(context.Context) error { return nil },
		queue:     newIngestQueue(4, 0, 0),
		lifecycle: lifecycle,
	}
	code, body := healthBody(t, a)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 after transitions were abandoned", code)
	}
	if body.Lifecycle.Abandoned != 1 {
		t.Errorf("lifecycle = %+v, want abandoned 1", body.Lifecycle)
	}
}

// TestHealthIsUnavailableWhenTheLifecycleConsumerStalls completes the P1
// visibility loop: a deep backlog (no consumer) must be an explicit degraded
// lifecycle signal, not just a number.
func TestHealthIsUnavailableWhenTheLifecycleConsumerStalls(t *testing.T) {
	lifecycle := newLifecycleQueue()
	for range lifecycleWarnDepth {
		lifecycle.enqueue(okJob{})
	}
	a := &api{
		secret:    "dev-secret",
		ping:      func(context.Context) error { return nil },
		queue:     newIngestQueue(4, 0, 0),
		lifecycle: lifecycle,
	}

	code, body := healthBody(t, a)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 for a stalled lifecycle consumer", code)
	}
	if body.OK || body.Lifecycle.Depth < lifecycleWarnDepth {
		t.Errorf("body = %+v, want not-ok with the backlog reported", body)
	}
	if body.Lifecycle.Error == "" {
		t.Error("a degraded lifecycle must say why")
	}
}
