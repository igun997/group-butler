package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	// CGO SQLite is the whatsmeow auth store's driver (§6.1). It is imported
	// here, at the process edge, so the store package itself stays driver-free.
	_ "github.com/mattn/go-sqlite3"
)

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

	// The signal context is the process lifecycle: cancelling it disconnects
	// every client and flushes the ingest queue, in that order.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	client, db, err := connectMongo(ctx, cfg.MongoURI, cfg.MongoDB)
	if err != nil {
		return err
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
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

	queue := newIngestQueue(cfg.IngestQueueSize, cfg.IngestFlush, cfg.IngestFlushMax)
	messages := newMessageStore(db)
	go queue.Run(ctx, messages)

	mgr := newManager(cfg, newGroupStore(db), newInstanceMongo(db), newPairingMongo(db), queue, authStore)
	mgr.stats = newStatsStore(db)
	mgr.audit = newAuditStore(db)
	// The health probe reports the database the worker is actually using.
	mgr.ping = func(ctx context.Context) error { return client.Ping(ctx, nil) }
	// Media is enabled only by present R2 credentials; nil keeps every
	// attachment `pending` rather than pretending it was stored (R3).
	mgr.media = newMediaRunner(cfg, newR2(cfg), messages, cfg.OrganizationID)
	if mgr.media != nil {
		go mgr.media.run(ctx)
	}
	// Mongo work that originates on the whatsmeow event loop lands here.
	go mgr.persist.run(ctx, mgr)
	// The periodic reconcile (GROUP_SYNC_INTERVAL) and the attachment retry
	// loop (MEDIA_JANITOR_INTERVAL) own their own cadence.
	go mgr.runGroupSyncScheduler(ctx)
	go mgr.runMediaJanitor(ctx)

	restoreInstances(ctx, mgr)

	server := &http.Server{
		Addr:              cfg.ListenAddr(),
		Handler:           mgr.api().routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() {
		logf("worker listening on %s", cfg.ListenAddr())
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	select {
	case err := <-serveErr:
		mgr.shutdown(ctx)
		return err
	case <-ctx.Done():
	}

	// Graceful shutdown disconnects clients **without logging out** (§6.1):
	// logging out would invalidate every linked device on every deploy.
	logf("shutting down — disconnecting instances (auth state kept on disk)")
	mgr.shutdown(ctx)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return err
	}
	return nil
}
