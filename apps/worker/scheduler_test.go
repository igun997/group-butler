package main

import (
	"context"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

// ---- fakes ---------------------------------------------------------------

type fakeMediaStore struct {
	mu          sync.Mutex
	candidates  []mediaCandidate
	saved       []Media
	maxAttempts int
}

func (f *fakeMediaStore) pendingMedia(_ context.Context, _ string, maxAttempts int) ([]mediaCandidate, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.maxAttempts = maxAttempts
	return f.candidates, nil
}

func (f *fakeMediaStore) saveMedia(_ context.Context, _ MessageDoc, media Media) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saved = append(f.saved, media)
	return nil
}

func (f *fakeMediaStore) savedMedia() []Media {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Media(nil), f.saved...)
}

// manualTicker is the injectable periodic-loop seam: a test pushes the exact
// number of ticks it wants, so nothing sleeps and nothing is timing-dependent.
type manualTicker struct {
	ch      chan time.Time
	stopped chan struct{}
	once    sync.Once
}

func newManualTicker() *manualTicker {
	return &manualTicker{ch: make(chan time.Time, 4), stopped: make(chan struct{})}
}

func (m *manualTicker) new(time.Duration) (<-chan time.Time, func()) {
	return m.ch, func() { m.once.Do(func() { close(m.stopped) }) }
}

func (m *manualTicker) tick() { m.ch <- time.Now() }

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// ---- GROUP_SYNC_INTERVAL scheduler ---------------------------------------

func TestGroupSyncSchedulerSyncsConnectedInstancesOnTick(t *testing.T) {
	client := newFakeClient()
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	ticker := newManualTicker()
	mgr.newTicker = ticker.new
	s := testSession(mgr, client)
	s.status = stateConnected
	mgr.put(s)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); mgr.runGroupSyncScheduler(ctx) }()

	ticker.tick()
	waitFor(t, "the interval sync to call GetJoinedGroups", func() bool { return client.groupCallCount() > 0 })

	cancel()
	waitFor(t, "the scheduler to stop", func() bool {
		select {
		case <-done:
			return true
		default:
			return false
		}
	})
	select {
	case <-ticker.stopped:
	default:
		t.Error("the scheduler must stop its ticker when its context is cancelled")
	}
}

func TestGroupSyncSchedulerSkipsOfflineInstances(t *testing.T) {
	client := newFakeClient()
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	s := testSession(mgr, client)
	s.status = stateDisconnected
	mgr.put(s)

	mgr.syncAllConnected(context.Background())

	if got := client.groupCallCount(); got != 0 {
		t.Fatalf("GetJoinedGroups calls = %d, want 0 for an offline instance", got)
	}
}

// ---- MEDIA_JANITOR_INTERVAL retry loop -----------------------------------

func pngBytes() []byte {
	return []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'I', 'H', 'D', 'R', 0, 0, 0, 4, 0, 0, 0, 3}
}

func storedImageCandidate(t *testing.T, instanceID, messageID string) mediaCandidate {
	t.Helper()
	msg := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Mimetype:   proto.String("image/png"),
		FileLength: proto.Uint64(3),
	}}
	raw, _, err := rawFields(msg)
	if err != nil {
		t.Fatalf("rawFields: %v", err)
	}
	return mediaCandidate{
		OrganizationID: "org_default",
		InstanceID:     instanceID,
		WaMessageID:    messageID,
		GroupJID:       "120363043123456789@g.us",
		Raw:            raw.Message,
	}
}

func TestMediaJanitorEnqueuesPendingAttachmentsForLiveInstances(t *testing.T) {
	store := &fakeMediaStore{candidates: []mediaCandidate{
		storedImageCandidate(t, "online", "3EB0JAN1"),
		storedImageCandidate(t, "offline", "3EB0JAN2"),
	}}
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.media = newMediaRunner(mgr.cfg, &fakeUploader{}, store, "org_default")

	online := testSession(mgr, newFakeClient())
	online.status = stateConnected
	online.id = "online"
	mgr.put(online)
	offline := testSession(mgr, newFakeClient())
	offline.status = stateDisconnected
	offline.id = "offline"
	mgr.put(offline)

	mgr.janitorSweep(context.Background())

	if store.maxAttempts != mgr.cfg.MediaMaxAttempts {
		t.Errorf("janitor queried attempts < %d, want MEDIA_MAX_ATTEMPTS=%d", store.maxAttempts, mgr.cfg.MediaMaxAttempts)
	}
	if got := len(mgr.media.jobs); got != 1 {
		t.Fatalf("queued retries = %d, want 1 (offline instances cannot download)", got)
	}
}

func TestMediaJanitorSweepsOnTick(t *testing.T) {
	store := &fakeMediaStore{candidates: []mediaCandidate{storedImageCandidate(t, "inst_1", "3EB0JAN3")}}
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.media = newMediaRunner(mgr.cfg, &fakeUploader{}, store, "org_default")
	ticker := newManualTicker()
	mgr.newTicker = ticker.new

	s := testSession(mgr, newFakeClient())
	s.status = stateConnected
	mgr.put(s)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); mgr.runMediaJanitor(ctx) }()

	ticker.tick()
	waitFor(t, "the janitor to queue a retry", func() bool { return len(mgr.media.jobs) == 1 })

	cancel()
	waitFor(t, "the janitor to stop", func() bool {
		select {
		case <-done:
			return true
		default:
			return false
		}
	})
}

// TestMediaJanitorRetryLandsTheStoredStatus is the whole-loop proof: the tick
// queues a retry, the worker downloads through the existing pipeline and the
// result is persisted with the attempt counted.
func TestMediaJanitorRetryLandsTheStoredStatus(t *testing.T) {
	store := &fakeMediaStore{candidates: []mediaCandidate{storedImageCandidate(t, "inst_1", "3EB0JAN4")}}
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	uploader := &fakeUploader{}
	mgr.media = newMediaRunner(mgr.cfg, uploader, store, "org_default")

	client := newFakeClient()
	client.download = pngBytes()
	s := testSession(mgr, client)
	s.status = stateConnected
	mgr.put(s)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go mgr.media.run(ctx)

	mgr.janitorSweep(ctx)
	waitFor(t, "the retry to be persisted", func() bool { return len(store.savedMedia()) == 1 })

	saved := store.savedMedia()[0]
	if saved.Status != MediaStored {
		t.Fatalf("persisted media = %+v, want stored", saved)
	}
	if saved.Width != 4 || saved.Height != 3 {
		t.Errorf("dimensions = %dx%d, want the bytes that were downloaded", saved.Width, saved.Height)
	}
}

func TestMediaJanitorIsInertWhenMediaIsDisabled(t *testing.T) {
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	ticker := newManualTicker()
	mgr.newTicker = ticker.new

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); mgr.runMediaJanitor(ctx) }()
	// With no media runner the loop returns immediately rather than ticking.
	waitFor(t, "the janitor to return when media is disabled", func() bool {
		select {
		case <-done:
			return true
		default:
			return false
		}
	})
	cancel()
}
