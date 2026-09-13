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

	// CGO SQLite is the whatsmeow auth store's driver (§6.1). It is imported
	// here, at the process edge, so the store package itself stays driver-free.
	_ "github.com/mattn/go-sqlite3"
)

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

	// The auth store must open before the manager exists: a worker that cannot
	// persist device credentials cannot pair or restore anything.
	authStore, err := newWhatsmeowStore(ctx, cfg.WhatsmeowDB)
	if err != nil {
		return err
	}
	defer func() {
		if err := authStore.Close(); err != nil {
			logf("auth store close: %v", err)
		}
	}()

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

	mgr := newManager(cfg, newGroupStore(db), newInstanceMongo(db), newPairingMongo(db), queue, authStore)
	mgr.stats = newStatsStore(db)
	mgr.audit = newAuditStore(db)
	// The health probe reports the database the worker is actually using.
	mgr.ping = func(ctx context.Context) error { return client.Ping(ctx, nil) }
	// Media is enabled only by present R2 credentials; nil keeps every
	// attachment `pending` rather than pretending it was stored (R3).
	mgr.media = mediaRunnerFor(cfg, messages, cfg.OrganizationID)
	if mgr.media != nil {
		start(func() { mgr.media.run(ctx) })
	}
	// Mongo work that originates on the whatsmeow event loop lands here.
	start(func() { mgr.persist.run(ctx, mgr) })
	// Instance transitions run on a single consumer so they stay ordered.
	start(func() { mgr.lifecycle.run(ctx, mgr) })
	// The periodic reconcile (GROUP_SYNC_INTERVAL) and the attachment retry
	// loop (MEDIA_JANITOR_INTERVAL) own their own cadence.
	start(func() { mgr.runGroupSyncScheduler(ctx) })
	start(func() { mgr.runMediaJanitor(ctx) })

	// Reconcile persisted status against the auth store before reconnecting:
	// a transition lost with the previous process is repaired here.
	reconcileInstances(ctx, mgr)
	restoreInstances(ctx, mgr)

	server := &http.Server{
		Addr:              cfg.ListenAddr(),
		Handler:           mgr.api().routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	return awaitShutdown(ctx, cancel, server, mgr, &workers)
}

// mediaRunnerFor builds the media runner only when R2 is actually configured.
// The concrete pointer is checked before it is wrapped in the mediaUploader
// interface: a nil *r2Client converted to that interface is *non-nil*, and a
// runner built from it would start the janitor against an uploader that panics
// on the first attachment. Nil here means "this build does not store media".
func mediaRunnerFor(cfg Config, messages mediaStore, orgID string) *mediaRunner {
	uploader := newR2(cfg)
	if uploader == nil {
		return nil
	}
	return newMediaRunner(cfg, uploader, messages, orgID)
}

// awaitShutdown runs the HTTP server until it fails or ctx is cancelled, then
// stops admission on every background queue and drains what was accepted —
// before it returns. run() closes Mongo and the auth store in its defers, which
// therefore run *after* the drain: no accepted write is rejected by a closed
// dependency, and the worker WaitGroup is always drained, so a failed listen
// cannot leave half a process running.
func awaitShutdown(ctx context.Context, cancel context.CancelFunc, srv *http.Server, mgr *manager, workers *sync.WaitGroup) error {
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
		mgr.shutdown(ctx)
		workers.Wait()
		return err
	case <-ctx.Done():
	}

	// Graceful shutdown disconnects clients **without logging out** (§6.1):
	// logging out would invalidate every linked device on every deploy.
	logf("shutting down — disconnecting instances (auth state kept on disk)")
	mgr.shutdown(ctx)
	cancel()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	err := srv.Shutdown(shutdownCtx)
	workers.Wait()
	return err
}
