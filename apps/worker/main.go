package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// This worker holds no WhatsApp session, and nothing in it may create one.
//
// Hermes Agent owns the linked device: it holds the credential, the socket and
// the event stream, and its bridge answers every question the worker used to ask
// WhatsApp itself (hermes_bridge.go). The worker's job is what is left — archive
// the messages the bridge forwards, keep the group read model, perform the group
// writes an operator approved, answer the console — so its startup opens a
// database and nothing else. There is deliberately no auth store, no device
// restore and no reconnect path here: a worker that could connect would race the
// console's own session for the same account.

// serveHTTP is the listen call as a seam: a failed bind must cancel and drain
// every worker before the process exits, and that path is otherwise unreachable
// from a test.
var serveHTTP = func(srv *http.Server) error { return srv.ListenAndServe() }

func main() {
	if err := run(); err != nil {
		logf("fatal: %v", err)
		os.Exit(1)
	}
}

// run is main's whole lifetime in one function so every resource has a defer
// and the fatal paths are testable by inspection. It returns only when the
// process has finished shutting down.
func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}

	// The signal context is the process lifecycle. A cancellable child owns the
	// workers, so every exit path — a failed listen as much as a SIGTERM — stops
	// them and waits before returning.
	signalCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(signalCtx)
	defer cancel()

	client, db, err := connectMongo(ctx, cfg.MongoURI, cfg.MongoDB)
	if err != nil {
		return err
	}
	defer func() {
		closeCtx, cancelClose := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancelClose()
		if err := client.Disconnect(closeCtx); err != nil {
			logf("mongo disconnect: %v", err)
		}
	}()

	// The worker refuses to start against a database where a redelivered
	// message would duplicate, so a failed index creation is fatal.
	if err := ensureIngestIndexes(ctx, db); err != nil {
		return err
	}

	// Every background loop is registered here, so awaitShutdown can drain them.
	var workers sync.WaitGroup
	start := func(fn func()) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			fn()
		}()
	}

	queue := newIngestQueue(cfg.IngestQueueSize, cfg.IngestFlush, cfg.IngestFlushMax)
	messages := newMessageStore(db)
	start(func() { queue.Run(ctx, messages) })

	mgr := newManager(cfg, newGroupStore(db), newInstanceMongo(db), queue)
	mgr.stats = newStatsStore(db)
	mgr.audit = newAuditStore(db)
	// What a flush created lands in the day counters and the instance counters,
	// which is what the console's usage section reads (§10).
	queue.setOnStored(mgr.recordStored)
	// The Hermes ingest path stores and maps the messages the bridge forwards
	// (§6.2). It is built even when R2 is unconfigured: that path must exist in
	// every deployment, and it then records each attachment `unavailable` instead
	// of claiming it stored one (R3).
	mgr.external = newExternalIngest(cfg, messages, newR2(cfg))
	// What follows a flush: the automatic replies, and the media subdocument of an
	// attachment the Hermes path stored before its row existed.
	queue.setAfterSave(mgr.afterIngestFlush)
	// The health probe reports the database the worker is actually using.
	mgr.ping = func(ctx context.Context) error { return client.Ping(ctx, nil) }
	// The periodic reconcile (GROUP_SYNC_INTERVAL) reads the whole group list from
	// the bridge — it is the offline-rename safety net, and it is the only
	// background loop left that touches the group read model.
	start(func() { mgr.runGroupSyncScheduler(ctx) })
	// Memory batches and the send dispatcher own their own cadence; both work off
	// stored state, so neither needs a WhatsApp session.
	memoryBatches := newMemoryBatchWorker(db, cfg)
	start(func() { memoryBatches.Run(ctx, mgr.newTicker, mgr.loops) })
	dispatcher := newSendDispatcher(db, cfg)
	start(func() { dispatcher.run(ctx, mgr) })

	server := &http.Server{
		Addr:              cfg.ListenAddr(),
		Handler:           mgr.api().routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	return awaitShutdown(ctx, cancel, server, &workers)
}

// awaitShutdown runs the HTTP server until it fails or ctx is cancelled, then
// stops admission on every background queue and drains what was accepted —
// before it returns. run() closes Mongo in its defer, which therefore runs
// *after* the drain: no accepted write is rejected by a closed dependency, and
// the worker WaitGroup is always drained, so a failed listen cannot leave half a
// process running.
func awaitShutdown(ctx context.Context, cancel context.CancelFunc, srv *http.Server, workers *sync.WaitGroup) error {
	serveErr := make(chan error, 1)
	go func() {
		err := serveHTTP(srv)
		if errors.Is(err, http.ErrServerClosed) {
			// Somebody closed the listener; that is a normal exit, not a fault.
			err = nil
		}
		serveErr <- err
	}()

	select {
	case err := <-serveErr:
		// The listener failed (or closed): stop the workers before reporting,
		// so nothing is left running against a server that will never serve.
		cancel()
		workers.Wait()
		return err
	case <-ctx.Done():
	}

	logf("shutting down — draining accepted work")
	cancel()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	err := srv.Shutdown(shutdownCtx)
	workers.Wait()
	return err
}
