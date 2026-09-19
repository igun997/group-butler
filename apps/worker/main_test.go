package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var workers sync.WaitGroup
	stopped := startTestWorker(ctx, &workers)

	err := awaitShutdown(ctx, cancel, &http.Server{}, &workers)
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

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var workers sync.WaitGroup
	stopped := startTestWorker(ctx, &workers)

	if err := awaitShutdown(ctx, cancel, &http.Server{}, &workers); err != nil {
		t.Fatalf("awaitShutdown = %v, want nil for a normal close", err)
	}
	workerExited(t, stopped)
}

func TestSignalShutdownDrainsWorkers(t *testing.T) {
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

	ctx, cancel := context.WithCancel(context.Background())
	var workers sync.WaitGroup
	stopped := startTestWorker(ctx, &workers)

	done := make(chan error, 1)
	go func() { done <- awaitShutdown(ctx, cancel, &http.Server{}, &workers) }()

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
}

// TestWorkerCannotReachWhatsApp is the invariant this worker's whole shape exists
// for: WhatsApp is Hermes's, and a second process holding a credential would race
// the console's own session for the same account ("conflict / replaced").
//
// It is asserted at the one boundary that cannot be talked around — the package's
// own source. A behavioural test can only prove that *some* path does not
// connect; the absence of the protocol library and of an auth store is what
// proves that none can. Every route that used to link a device answers a refusal
// instead (httpapi.go), and startup opens a database and nothing else (main.go).
func TestWorkerCannotReachWhatsApp(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package directory: %v", err)
	}
	forbidden := []string{
		"go.mau.fi/whatsmeow", // the protocol client and its event loop
		"whatsmeow.NewClient", // the one constructor that opens a socket
		"newWhatsmeowStore",   // the auth store: device credentials on disk
		"WHATSMEOW_DB_URI",    // the address of that store
		"QRChannel",           // pairing material
		"PairPhone",           // the phone-code pairing path
		"GetJoinedGroups",     // the membership read that now comes from the bridge
		"DownloadToFile",      // the authenticated media download
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		source, err := os.ReadFile(filepath.Join(".", name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, needle := range forbidden {
			if strings.Contains(string(source), needle) {
				t.Errorf("%s mentions %q: this worker must hold no WhatsApp session, not even a disabled one", name, needle)
			}
		}
	}
}

// TestGoModDropsTheProtocolLibrary is the same invariant one level down: the
// dependency is what would come back first if someone re-added a session.
func TestGoModDropsTheProtocolLibrary(t *testing.T) {
	mod, err := os.ReadFile("go.mod")
	if err != nil {
		t.Fatalf("read go.mod: %v", err)
	}
	if strings.Contains(string(mod), "whatsmeow") {
		t.Error("go.mod still requires whatsmeow: the worker's WhatsApp session must be fully dropped")
	}
}
