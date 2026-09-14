package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// ---- blocker 1 fakes -----------------------------------------------------

// fakeGroupStore records every group write so a test can prove the whatsmeow
// callback did *not* perform one inline.
type fakeGroupStore struct {
	mu       sync.Mutex
	docs     map[string]*groupDoc
	touched  []string
	observed []string
	upserts  []string
}

func newFakeGroupStore() *fakeGroupStore {
	return &fakeGroupStore{docs: map[string]*groupDoc{}}
}

func (f *fakeGroupStore) calls() (touch, observed, upsert int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.touched), len(f.observed), len(f.upserts)
}

func (f *fakeGroupStore) FindOne(_ context.Context, _, _, groupJID string) *groupDoc {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.docs[groupJID]
}

func (f *fakeGroupStore) Touch(_ context.Context, _, _, groupJID string, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touched = append(f.touched, groupJID)
	return nil
}

func (f *fakeGroupStore) UpsertObserved(_ context.Context, _, _, groupJID string, _ Observed, _ bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.observed = append(f.observed, groupJID)
	return nil
}

func (f *fakeGroupStore) UpsertFromSync(_ context.Context, _, _ string, info *types.GroupInfo, _ SyncSource) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upserts = append(f.upserts, info.JID.String())
	return nil
}

func (f *fakeGroupStore) MarkLeft(context.Context, string, string, string, GroupState) error {
	return nil
}

func (f *fakeGroupStore) KnownGroupJIDs(context.Context, string, string) ([]string, error) {
	return nil, nil
}

func (f *fakeGroupStore) ListForInstance(context.Context, string, string) ([]groupListRow, *string, error) {
	return nil, nil, nil
}

func (f *fakeGroupStore) loadObserved(context.Context, string, string) (map[string]Observed, error) {
	return nil, nil
}

type fakeReceiptWriter struct {
	mu    sync.Mutex
	calls int
}

func (f *fakeReceiptWriter) bumpReceipt(context.Context, string, string, string, time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return nil
}

func (f *fakeReceiptWriter) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

type okJob struct{}

func (okJob) persist(context.Context, *manager) error { return nil }

type errorJob struct{}

func (errorJob) persist(context.Context, *manager) error { return errors.New("boom") }

// testConfig is the configuration the routing and scheduler tests run under:
// the real defaults that matter, with nothing that needs a socket.
func testConfig() Config {
	return Config{
		OrganizationID:       "org_default",
		WorkerSecret:         "dev-secret",
		GroupSyncPrune:       true,
		HistorySyncMaxDays:   30,
		MediaConcurrency:     2,
		MediaMaxBytes:        1 << 20,
		MediaMaxAttempts:     3,
		MediaDownloadTimeout: 5 * time.Second,
		MediaJanitorEvery:    time.Hour,
		EventQueueSize:       8,
		EventWorkers:         1,
		GroupSyncInterval:    time.Hour,
	}
}

// testManagerWithDeps builds a manager whose persistence dependencies are fakes,
// so event routing is provable without Mongo or a socket.
func testManagerWithDeps(groups groupStoreAPI, stats receiptWriter, persist *persistQueue) *manager {
	mgr := newManager(testConfig(), groups, newFakeInstanceRepo(), newFakePairingStore(), nil, &fakeDeviceStore{})
	if stats != nil {
		mgr.stats = stats
	}
	if persist != nil {
		mgr.persist = persist
	}
	return mgr
}

func testSession(mgr *manager, client whatsmeowClient) *session {
	deviceJID := types.NewJID("628990000009:5", types.DefaultUserServer)
	return newSession(mgr, InstanceRow{ID: "inst_1", OrganizationID: "org_default"}, &store.Device{ID: &deviceJID}, client)
}

// ---- persist queue -------------------------------------------------------

func TestPersistQueueIsBoundedAndCountsOverflow(t *testing.T) {
	q := newPersistQueue(1, 1)
	// No worker is running, so the single buffer slot fills and the rest drop.
	q.enqueue(okJob{})
	q.enqueue(okJob{})
	q.enqueue(okJob{})

	if q.Depth() != 1 {
		t.Errorf("depth = %d, want 1 (the buffer bound)", q.Depth())
	}
	if q.Dropped() != 2 {
		t.Errorf("dropped = %d, want 2 (overflow is counted, never buffered)", q.Dropped())
	}
	if q.Failed() != 0 {
		t.Errorf("failed = %d, want 0", q.Failed())
	}
}

func TestPersistQueueCountsFailures(t *testing.T) {
	q := newPersistQueue(4, 1)
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); q.run(ctx, mgr) }()

	q.enqueue(errorJob{})
	q.enqueue(okJob{})

	deadline := time.Now().Add(2 * time.Second)
	for q.Failed() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if q.Failed() != 1 {
		t.Fatalf("failed = %d, want 1", q.Failed())
	}
	cancel()
	<-done
}

// TestGroupDeltaIsRoutedOffTheCallback is the blocker-1 proof: handling a
// *events.GroupInfo must enqueue the Mongo work and return without touching the
// store, because that goroutine is shared with the protocol handshake.
func TestGroupDeltaIsRoutedOffTheCallback(t *testing.T) {
	groups := newFakeGroupStore()
	persist := newPersistQueue(8, 1)
	mgr := testManagerWithDeps(groups, nil, persist)
	s := testSession(mgr, newFakeClient())

	evt := &events.GroupInfo{
		JID:  types.NewJID("120363043123456789", types.GroupServer),
		Name: &types.GroupName{Name: "Renamed", NameSetAt: time.Unix(1757750000, 0)},
	}
	handleEvent(s, evt)

	if touch, observed, upsert := groups.calls(); touch+observed+upsert != 0 {
		t.Fatalf("the callback wrote to the store inline (touch=%d observed=%d upsert=%d)", touch, observed, upsert)
	}
	if persist.Depth() != 1 {
		t.Fatalf("persist depth = %d, want the delta queued", persist.Depth())
	}

	// Running the workers must actually land the delta.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); persist.run(ctx, mgr) }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, observed, _ := groups.calls(); observed == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("delta never reached the store: %+v", groups)
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-done
}

func TestReceiptIsRoutedOffTheCallback(t *testing.T) {
	stats := &fakeReceiptWriter{}
	persist := newPersistQueue(8, 1)
	mgr := testManagerWithDeps(newFakeGroupStore(), stats, persist)
	s := testSession(mgr, newFakeClient())

	handleEvent(s, &events.Receipt{
		MessageSource: types.MessageSource{Chat: types.NewJID("120363043123456789", types.GroupServer)},
		Timestamp:     time.Unix(1757750000, 0),
	})

	if stats.count() != 0 {
		t.Fatal("the callback wrote the receipt counter inline")
	}
	if persist.Depth() != 1 {
		t.Fatalf("persist depth = %d, want the receipt queued", persist.Depth())
	}
}

func TestGroupTouchIsRoutedOffTheCallback(t *testing.T) {
	groups := newFakeGroupStore()
	persist := newPersistQueue(8, 1)
	mgr := testManagerWithDeps(groups, nil, persist)
	s := testSession(mgr, newFakeClient())

	handleEvent(s, &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:    types.NewJID("120363043123456789", types.GroupServer),
				IsGroup: true,
			},
			ID:        "3EB0OFFCALLBACK",
			Timestamp: time.Unix(1757750000, 0),
		},
		Message: nil,
	})

	if touch, _, _ := groups.calls(); touch != 0 {
		t.Fatal("the callback touched the group inline")
	}
	if persist.Depth() != 2 {
		t.Fatalf("persist depth = %d, want the group touch and assignment gate queued", persist.Depth())
	}
}

// TestHistorySyncIsRoutedOffTheCallback proves the backfill path shares the same
// off-callback routing rather than writing per message on the event loop.
func TestHistorySyncIsRoutedOffTheCallback(t *testing.T) {
	groups := newFakeGroupStore()
	persist := newPersistQueue(8, 1)
	mgr := testManagerWithDeps(groups, nil, persist)
	s := testSession(mgr, newFakeClient())

	handleEvent(s, &events.HistorySync{Data: nil})

	if _, _, _ = groups.calls(); persist.Depth() != 0 {
		t.Fatalf("an empty history sync must queue nothing, depth = %d", persist.Depth())
	}
}

func TestInboundMessageJobPersistsOnlyAssignedGroups(t *testing.T) {
	groupJID := types.NewJID("120363043123456789", types.GroupServer).String()
	groups := newFakeGroupStore()
	ingest := newIngestQueue(2, time.Hour, 10)
	mgr := testManagerWithDeps(groups, nil, nil)
	mgr.ingest = ingest
	s := testSession(mgr, newFakeClient())
	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:    types.NewJID("120363043123456789", types.GroupServer),
				Sender:  types.NewJID("628990000001", types.DefaultUserServer),
				IsGroup: true,
			},
			ID:        "3EB0ASSIGNED",
			Timestamp: time.Unix(1757750000, 0),
		},
		Message: &waE2E.Message{Conversation: proto.String("private group message")},
	}
	doc, err := parseInbound(evt, mgr.orgID, s.id)
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}

	t.Run("unassigned", func(t *testing.T) {
		groups.docs[groupJID] = &groupDoc{Config: groupConfig{Assigned: false}}
		if err := (inboundMessageJob{session: s, evt: evt, doc: doc}).persist(context.Background(), mgr); err != nil {
			t.Fatalf("persist: %v", err)
		}
		if ingest.Depth() != 0 {
			t.Fatal("unassigned group message reached the ingest queue")
		}
	})

	t.Run("assigned", func(t *testing.T) {
		groups.docs[groupJID] = &groupDoc{Config: groupConfig{Assigned: true}}
		if err := (inboundMessageJob{session: s, evt: evt, doc: doc}).persist(context.Background(), mgr); err != nil {
			t.Fatalf("persist: %v", err)
		}
		if ingest.Depth() != 1 {
			t.Fatalf("assigned group ingest depth = %d, want 1", ingest.Depth())
		}
	})
}
