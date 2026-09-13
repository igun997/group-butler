package main

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"
)

// startTestWorker registers a worker that only exits when the run context is
// cancelled, then reports whether it actually did.
func startTestWorker(ctx context.Context, workers *sync.WaitGroup) <-chan struct{} {
	stopped := make(chan struct{})
	workers.Add(1)
	go func() {
		defer workers.Done()
		<-ctx.Done()
		close(stopped)
	}()
	return stopped
}

func workerExited(t *testing.T, stopped <-chan struct{}) {
	t.Helper()
	select {
	case <-stopped:
	default:
		t.Fatal("the worker was still running when run() returned")
	}
}

func TestListenFailureCancelsAndDrainsWorkers(t *testing.T) {
	orig := serveHTTP
	serveHTTP = func(*http.Server) error { return errors.New("listen tcp :4000: bind: address already in use") }
	t.Cleanup(func() { serveHTTP = orig })

	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var workers sync.WaitGroup
	stopped := startTestWorker(ctx, &workers)

	err := awaitShutdown(ctx, cancel, &http.Server{}, mgr, &workers)
	if err == nil {
		t.Fatal("awaitShutdown swallowed the listen error")
	}
	if !errors.Is(err, context.Canceled) && err.Error() == "" {
		t.Fatalf("unexpected error: %v", err)
	}
	workerExited(t, stopped)
}

func TestServerCloseDrainsWorkers(t *testing.T) {
	orig := serveHTTP
	// A closed server is a normal exit, not a failure.
	serveHTTP = func(*http.Server) error { return http.ErrServerClosed }
	t.Cleanup(func() { serveHTTP = orig })

	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var workers sync.WaitGroup
	stopped := startTestWorker(ctx, &workers)

	if err := awaitShutdown(ctx, cancel, &http.Server{}, mgr, &workers); err != nil {
		t.Fatalf("awaitShutdown = %v, want nil for a normal close", err)
	}
	workerExited(t, stopped)
}

func TestSignalShutdownDrainsWorkersAndDisconnects(t *testing.T) {
	orig := serveHTTP
	// Block the listener until the test releases it, so the signal path (not
	// the listen-error path) is the one that runs. `finished` orders the
	// restore of the package var after the fake has read it.
	release := make(chan struct{})
	finished := make(chan struct{})
	serveHTTP = func(*http.Server) error {
		<-release
		close(finished)
		return http.ErrServerClosed
	}
	t.Cleanup(func() {
		close(release)
		<-finished
		serveHTTP = orig
	})

	client := newFakeClient()
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.put(newSession(mgr, InstanceRow{ID: "inst_1", OrganizationID: "org_default"}, nil, client))

	ctx, cancel := context.WithCancel(context.Background())
	var workers sync.WaitGroup
	stopped := startTestWorker(ctx, &workers)

	done := make(chan error, 1)
	go func() { done <- awaitShutdown(ctx, cancel, &http.Server{}, mgr, &workers) }()

	// The process receives SIGTERM: the signal context is cancelled.
	time.Sleep(20 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("awaitShutdown = %v, want nil on graceful shutdown", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("awaitShutdown did not return after the signal context was cancelled")
	}
	workerExited(t, stopped)
	client.mu.Lock()
	disconnects, logouts := client.disconnects, client.logouts
	client.mu.Unlock()
	if disconnects == 0 {
		t.Error("graceful shutdown must disconnect the client")
	}
	if logouts != 0 {
		t.Error("graceful shutdown must not log out (it would invalidate every linked device)")
	}
}
