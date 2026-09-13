package main

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// countJob counts successful processing, so a test can tell an accepted job
// that was drained from one that was rejected.
type countJob struct{ n *atomic.Int64 }

func (j countJob) persist(context.Context, *manager) error {
	j.n.Add(1)
	return nil
}

// ctxBoundJob blocks until its processing context is cancelled, which is how a
// test reaches the drain deadline.
type ctxBoundJob struct{ entered chan struct{} }

func (j ctxBoundJob) persist(ctx context.Context, _ *manager) error {
	close(j.entered)
	<-ctx.Done()
	return ctx.Err()
}

// TestPersistQueueDrainsAcceptedJobsOnShutdown is blocker 2's core claim: a job
// that was accepted must be processed before the queue exits, not discarded.
func TestPersistQueueDrainsAcceptedJobsOnShutdown(t *testing.T) {
	q := newPersistQueue(8, 2)
	var processed atomic.Int64
	for range 5 {
		q.enqueue(countJob{&processed})
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // shutdown begins before the consumers even start
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	done := make(chan struct{})
	go func() { defer close(done); q.run(ctx, mgr) }()
	<-done

	if got := processed.Load(); got != 5 {
		t.Fatalf("processed = %d, want all 5 accepted jobs drained", got)
	}
	if q.Dropped() != 0 {
		t.Errorf("dropped = %d, want 0 (accepted jobs are processed, not counted as drops)", q.Dropped())
	}
	if q.Failed() != 0 {
		t.Errorf("failed = %d, want 0", q.Failed())
	}
}

// TestPersistQueueCountsOnlyGenuineOverflow keeps the rejection accounting
// honest: a full buffer is the one case where an unaccepted job is dropped.
func TestPersistQueueCountsOnlyGenuineOverflow(t *testing.T) {
	q := newPersistQueue(1, 1)
	q.enqueue(okJob{}) // fills the slot (no consumer running)
	q.enqueue(okJob{}) // overflow
	q.enqueue(okJob{}) // overflow

	if q.Depth() != 1 {
		t.Errorf("depth = %d, want 1", q.Depth())
	}
	if q.Dropped() != 2 {
		t.Errorf("dropped = %d, want 2", q.Dropped())
	}
	if q.Failed() != 0 {
		t.Errorf("failed = %d, want 0", q.Failed())
	}
}

// TestPersistQueueStopsAdmissionAtClose proves a producer that arrives after the
// shutdown began is rejected and counted, never silently buffered.
func TestPersistQueueStopsAdmissionAtClose(t *testing.T) {
	q := newPersistQueue(4, 1)
	q.close()
	var processed atomic.Int64
	q.enqueue(countJob{&processed})

	if q.Dropped() != 1 {
		t.Errorf("dropped = %d, want 1 (rejected after admission closed)", q.Dropped())
	}
	if q.Depth() != 0 {
		t.Errorf("depth = %d, want 0", q.Depth())
	}
	if processed.Load() != 0 {
		t.Error("a rejected job must not run")
	}
}

// TestPersistQueueDrainDeadlineBoundsShutdown differentiates the three
// outcomes: a job that could not finish before the deadline has failed, and only
// the jobs the deadline cut off are dropped.
func TestPersistQueueDrainDeadlineBoundsShutdown(t *testing.T) {
	q := newPersistQueue(4, 1)
	q.drainTimeout = 50 * time.Millisecond
	entered := make(chan struct{})
	q.enqueue(ctxBoundJob{entered}) // blocks until the drain context is cancelled
	q.enqueue(okJob{})              // still buffered when the deadline passes

	ctx, cancel := context.WithCancel(context.Background())
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	done := make(chan struct{})
	go func() { defer close(done); q.run(ctx, mgr) }()

	<-entered
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("run did not return after the drain deadline")
	}

	if q.Failed() != 1 {
		t.Errorf("failed = %d, want 1 (the in-flight job could not finish)", q.Failed())
	}
	if q.Dropped() != 1 {
		t.Errorf("dropped = %d, want 1 (only the job the deadline cut off)", q.Dropped())
	}
}

// TestPersistQueueConcurrentEnqueueAndShutdown is the race-detector test: every
// attempt ends in exactly one of processed, failed or rejected, whatever the
// interleaving.
func TestPersistQueueConcurrentEnqueueAndShutdown(t *testing.T) {
	q := newPersistQueue(4, 3)
	var processed, attempts atomic.Int64
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); q.run(ctx, mgr) }()

	var producers sync.WaitGroup
	for range 8 {
		producers.Add(1)
		go func() {
			defer producers.Done()
			for range 50 {
				attempts.Add(1)
				q.enqueue(countJob{&processed})
			}
		}()
	}
	// Cancel while the producers are still running, so admission and drain
	// overlap.
	time.Sleep(time.Millisecond)
	cancel()
	producers.Wait()
	<-done

	if total := processed.Load() + q.Failed() + q.Dropped(); total != attempts.Load() {
		t.Fatalf("processed+failed+dropped = %d, attempts = %d", total, attempts.Load())
	}
	if q.Dropped() == 0 {
		t.Log("no rejections occurred; the accounting invariant still held")
	}
}

// TestAwaitShutdownDrainsPersistenceBeforeReturning is blocker 2's ordering
// claim at the process boundary: run()'s dependency closes happen after
// awaitShutdown returns, so the drain must complete *inside* awaitShutdown.
func TestAwaitShutdownDrainsPersistenceBeforeReturning(t *testing.T) {
	orig := serveHTTP
	serveHTTP = func(*http.Server) error { return errors.New("listen tcp :4000: bind: address already in use") }
	t.Cleanup(func() { serveHTTP = orig })

	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.persist = newPersistQueue(8, 2)
	var processed atomic.Int64
	mgr.persist.enqueue(countJob{&processed})

	ctx, cancel := context.WithCancel(context.Background())
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		mgr.persist.run(ctx, mgr)
	}()

	if err := awaitShutdown(ctx, cancel, &http.Server{}, mgr, &workers); err == nil {
		t.Fatal("awaitShutdown swallowed the listen error")
	}
	if processed.Load() != 1 {
		t.Fatal("awaitShutdown returned before the accepted persistence job was drained")
	}
}
