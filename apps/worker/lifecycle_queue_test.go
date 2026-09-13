package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/store"
)

// countingTransition records that it was applied.
type countingTransition struct{ n *atomic.Int64 }

func (j countingTransition) persist(context.Context, *manager) error {
	j.n.Add(1)
	return nil
}

// blockingTransition blocks until its processing context is cancelled, which is
// how a test reaches the bounded-drain deadline for the lossless queue.
type blockingTransition struct{ entered chan struct{} }

func (j blockingTransition) persist(ctx context.Context, _ *manager) error {
	close(j.entered)
	<-ctx.Done()
	return ctx.Err()
}

// TestLifecycleQueueNeverDropsATransitionUnderBacklog is the P1 claim: however
// far behind the consumer falls, an accepted control-plane transition stays in
// the queue (depth grows, nothing is lost).
func TestLifecycleQueueNeverDropsATransitionUnderBacklog(t *testing.T) {
	q := newLifecycleQueue()
	var applied atomic.Int64
	const n = 2000
	for range n {
		q.enqueue(countingTransition{&applied})
	}

	if got := q.Depth(); got != n {
		t.Fatalf("depth = %d, want all %d accepted transitions retained", got, n)
	}
	if q.Abandoned() != 0 {
		t.Fatalf("abandoned = %d, want 0", q.Abandoned())
	}

	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); q.run(ctx, mgr) }()

	waitFor(t, "every accepted transition to be applied", func() bool { return applied.Load() == n })
	cancel()
	<-done

	if q.Depth() != 0 || q.Abandoned() != 0 {
		t.Fatalf("depth=%d abandoned=%d, want a fully drained queue", q.Depth(), q.Abandoned())
	}
}

// TestLifecycleQueueNeverDropsAConnectedOrLoggedOutTransition is the same claim
// for the transitions the P1 is about, under enough backlog to overflow any
// bounded queue.
func TestLifecycleQueueNeverDropsAConnectedOrLoggedOutTransition(t *testing.T) {
	repo := newFakeInstanceRepo()
	devices := &fakeDeviceStore{device: &store.Device{}}
	client := newFakeClient()
	mgr := testManagerForLifecycle(repo, devices, client)
	s := testSession(mgr, client)

	for range 5000 {
		mgr.lifecycle.enqueue(okJob{})
	}
	mgr.enqueueLifecycle(instanceConnectedJob{session: s})
	mgr.enqueueLifecycle(instanceLoggedOutJob{session: s, botJID: s.deviceJID()})

	if got := mgr.lifecycle.Abandoned(); got != 0 {
		t.Fatalf("abandoned = %d, a connected/logged-out transition was dropped", got)
	}

	runLifecycle(t, mgr)
	waitFor(t, "the logged-out transition to be applied", func() bool {
		repo.mu.Lock()
		defer repo.mu.Unlock()
		return repo.statuses[s.id] == stateLoggedOut && repo.connected[s.id]
	})
	if mgr.lifecycle.Failed() != 0 {
		t.Errorf("failed = %d, want 0", mgr.lifecycle.Failed())
	}
}

// TestLifecycleQueueDrainsAcceptedTransitionsOnShutdown proves the bounded
// shutdown drain applies what was accepted rather than discarding it.
func TestLifecycleQueueDrainsAcceptedTransitionsOnShutdown(t *testing.T) {
	q := newLifecycleQueue()
	var applied atomic.Int64
	for range 10 {
		q.enqueue(countingTransition{&applied})
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // shutdown begins before the consumer starts
	q.run(ctx, testManagerWithDeps(newFakeGroupStore(), nil, nil))

	if applied.Load() != 10 {
		t.Fatalf("applied = %d, want all accepted transitions drained", applied.Load())
	}
	if q.Abandoned() != 0 {
		t.Errorf("abandoned = %d, want 0", q.Abandoned())
	}
}

// TestLifecycleQueueReportsTransitionsItCouldNotApply is the failure half of the
// contract: a transition the drain deadline cut off must be reported, never
// silently dropped.
func TestLifecycleQueueReportsTransitionsItCouldNotApply(t *testing.T) {
	q := newLifecycleQueue()
	q.drainTimeout = 50 * time.Millisecond
	entered := make(chan struct{})
	q.enqueue(blockingTransition{entered})
	q.enqueue(okJob{})

	// Shutdown begins before the consumer starts, so the drain itself is what
	// picks up the blocking transition.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	done := make(chan struct{})
	go func() { defer close(done); q.run(ctx, mgr) }()

	<-entered
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the lifecycle drain did not return after its deadline")
	}

	if q.Failed() != 1 {
		t.Errorf("failed = %d, want 1 (the in-flight transition could not finish)", q.Failed())
	}
	if q.Abandoned() != 1 {
		t.Errorf("abandoned = %d, want 1 (reported, not silently dropped)", q.Abandoned())
	}
}
