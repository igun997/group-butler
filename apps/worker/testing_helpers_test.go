package main

import (
	"context"
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- shared fixtures -----------------------------------------------------

func mustDate(iso string) time.Time {
	t, err := time.Parse("2006-01-02", iso)
	if err != nil {
		panic(err)
	}
	return t
}

// stamp is a deterministic instant a test can order by: minute `min` past a
// fixed base, so `stamp(5)` is later than `stamp(1)` and nothing depends on the
// wall clock.
func stamp(min int) time.Time { return time.Unix(1757750000+int64(min)*60, 0) }

// observedFixture is a stored observation: a synced group named "Support" with
// twelve participants and no history yet.
func observedFixture() Observed {
	return Observed{
		Subject: "Support", SubjectSearch: "support",
		SubjectUpdatedAt: stamp(1), SubjectObservedAt: stamp(1),
		SubjectSource: SubjectFromSync,
		State:         GroupActive, ParticipantCount: 12,
	}
}

// bridgeGroup is one `GET /groups` row: the id, the name and the member count,
// which is everything the bridge's contract carries.
func bridgeGroup(id, name string, participants int) bridgeGroupSummary {
	return bridgeGroupSummary{JID: id + "@g.us", Subject: name, ParticipantCount: participants}
}

// testConfig is the configuration the routing and scheduler tests run under:
// the real defaults that matter, with nothing that needs a socket.
func testConfig() Config {
	return Config{
		OrganizationID:       "org_default",
		WorkerSecret:         "dev-secret",
		GroupSyncPrune:       true,
		MediaConcurrency:     2,
		MediaMaxBytes:        1 << 20,
		MediaDownloadTimeout: 5 * time.Second,
		GroupSyncInterval:    time.Hour,
	}
}

// testManagerWithDeps builds a manager whose persistence dependencies are fakes,
// so the routes and the loops are provable without Mongo, a bridge or a socket.
// A nil `instances` gets an empty fake repo; a nil `stats` leaves the counters
// unwired, which every counter write tolerates (counters.go).
func testManagerWithDeps(groups groupStoreAPI, stats dayCounters, instances instanceRepo) *manager {
	if instances == nil {
		instances = newFakeInstanceRepo()
	}
	mgr := newManager(testConfig(), groups, instances, nil)
	if stats != nil {
		mgr.stats = stats
	}
	return mgr
}

// ---- group store ---------------------------------------------------------

// fakeGroupStore records every group write so a route's effect is provable
// without Mongo. Reads answer from the documents the test seeded.
type fakeGroupStore struct {
	mu       sync.Mutex
	docs     map[string]*groupDoc
	observed []string
	upserts  []string
}

func newFakeGroupStore() *fakeGroupStore {
	return &fakeGroupStore{docs: map[string]*groupDoc{}}
}

func (f *fakeGroupStore) FindOne(_ context.Context, _, _, groupJID string) *groupDoc {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.docs[groupJID]
}

func (f *fakeGroupStore) UpsertObserved(_ context.Context, _, _, groupJID string, observed Observed, _ bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.observed = append(f.observed, groupJID)
	f.upserts = append(f.upserts, groupJID)
	f.docs[groupJID] = &groupDoc{GroupJID: groupJID, Observed: observed}
	return nil
}

func (f *fakeGroupStore) MarkLeft(_ context.Context, _, _, groupJID string, state GroupState) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if doc, ok := f.docs[groupJID]; ok {
		doc.Observed.State = state
	}
	return nil
}

func (f *fakeGroupStore) KnownGroupJIDs(context.Context, string, string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	jids := make([]string, 0, len(f.docs))
	for jid := range f.docs {
		jids = append(jids, jid)
	}
	return jids, nil
}

func (f *fakeGroupStore) CountLeft(context.Context, string, string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, doc := range f.docs {
		if doc.Observed.State == GroupLeft || doc.Observed.State == GroupDeleted {
			count++
		}
	}
	return count, nil
}

func (f *fakeGroupStore) ListForInstance(context.Context, string, string) ([]groupListRow, *string, error) {
	return nil, nil, nil
}

func (f *fakeGroupStore) loadObserved(context.Context, string, string) (map[string]Observed, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string]Observed, len(f.docs))
	for jid, doc := range f.docs {
		out[jid] = doc.Observed
	}
	return out, nil
}

// ---- counters ------------------------------------------------------------

// fakeDayCounters records every live-counter write, so a test can assert both how
// many writes a batch cost and what each one carried.
type fakeDayCounters struct {
	mu    sync.Mutex
	calls []dayCounterCall
}

type dayCounterCall struct {
	orgID      string
	instanceID string
	groupJID   string
	counter    string
	count      int64
	at         time.Time
}

func (f *fakeDayCounters) bump(_ context.Context, orgID, instanceID, groupJID, counter string, count int64, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, dayCounterCall{orgID, instanceID, groupJID, counter, count, at})
	return nil
}

func (f *fakeDayCounters) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeDayCounters) recorded() []dayCounterCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]dayCounterCall(nil), f.calls...)
}

// ---- instance repository -------------------------------------------------

type fakeInstanceRepo struct {
	mu       sync.Mutex
	rows     map[string]InstanceRow
	statuses map[string]sessionState
	deleted  map[string]bool
	ops      []string
	// counters is what BumpCounters added, per instance and counter name.
	counters map[string]map[string]int64
	// pairingErrors is the last `runtime.pairingError` each SetStatus wrote.
	pairingErrors map[string]string
	// groupSync is the last §5.1 summary SetGroupSync wrote, per instance, and
	// groupSyncError the last refused-sync message (§6.6.5 rule 4).
	groupSync      map[string]groupSyncState
	groupSyncError map[string]string
}

func newFakeInstanceRepo(rows ...InstanceRow) *fakeInstanceRepo {
	r := &fakeInstanceRepo{
		rows:     map[string]InstanceRow{},
		statuses: map[string]sessionState{},
		deleted:  map[string]bool{},
	}
	for _, row := range rows {
		r.rows[row.ID] = row
	}
	return r
}

func (r *fakeInstanceRepo) opLog() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.ops...)
}

func (r *fakeInstanceRepo) BumpCounters(_ context.Context, orgID, id string, counters map[string]int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.counters == nil {
		r.counters = map[string]map[string]int64{}
	}
	if r.counters[id] == nil {
		r.counters[id] = map[string]int64{}
	}
	for name, count := range counters {
		r.counters[id][name] += count
	}
	return nil
}

func (r *fakeInstanceRepo) SetGroupSync(_ context.Context, _, id string, sync groupSyncState) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.groupSync == nil {
		r.groupSync = map[string]groupSyncState{}
	}
	r.groupSync[id] = sync
	// The real write clears `lastError`, because this only happens after a
	// snapshot arrived.
	delete(r.groupSyncError, id)
	return nil
}

func (r *fakeInstanceRepo) SetGroupSyncError(_ context.Context, _, id, message string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.groupSyncError == nil {
		r.groupSyncError = map[string]string{}
	}
	r.groupSyncError[id] = message
	return nil
}

func (r *fakeInstanceRepo) Get(_ context.Context, _, id string) (*InstanceRow, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	row, ok := r.rows[id]
	if !ok || r.deleted[id] {
		return nil, nil
	}
	return &row, nil
}

func (r *fakeInstanceRepo) List(context.Context, string) ([]InstanceRow, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]InstanceRow, 0, len(r.rows))
	for id, row := range r.rows {
		if r.deleted[id] {
			continue
		}
		out = append(out, row)
	}
	return out, nil
}

func (r *fakeInstanceRepo) SetStatus(_ context.Context, _, id string, status sessionState, pairingError string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.statuses[id] = status
	if r.pairingErrors == nil {
		r.pairingErrors = map[string]string{}
	}
	r.pairingErrors[id] = pairingError
	// The real write moves `runtime.status` and `runtime.pairingError`, so a read
	// after it returns the transition rather than the row the caller started from.
	row := r.rows[id]
	row.Status = status
	row.PairingError = pairingError
	r.rows[id] = row
	r.ops = append(r.ops, "setStatus:"+string(status))
	return nil
}

func (r *fakeInstanceRepo) SoftDelete(_ context.Context, _, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deleted[id] = true
	r.ops = append(r.ops, "softDelete")
	return nil
}

// ---- loops ---------------------------------------------------------------

// manualTicker is the injectable periodic-loop seam: a test pushes the exact
// number of ticks it wants, so nothing sleeps and nothing is timing-dependent.
type manualTicker struct {
	ch     chan time.Time
	once   sync.Once
	closed chan struct{}
}

func newManualTicker() *manualTicker {
	return &manualTicker{ch: make(chan time.Time, 4), closed: make(chan struct{})}
}

func (m *manualTicker) new(time.Duration) (<-chan time.Time, func()) {
	return m.ch, func() { m.once.Do(func() { close(m.closed) }) }
}

func (m *manualTicker) tick() { m.ch <- time.Now() }

// stopped reports whether the loop released its ticker.
func (m *manualTicker) stopped() bool {
	select {
	case <-m.closed:
		return true
	default:
		return false
	}
}

// waitFor polls a condition with a deadline, so a test asserts an eventual fact
// (a goroutine's write) without sleeping a fixed guess.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// ---- control plane -------------------------------------------------------

// callJSON drives one route through the real router with the bearer token the
// control plane requires and an optional JSON body.
func callJSON(t *testing.T, handler *api, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	handler.routes().ServeHTTP(rec, req)
	return rec
}

// storeSeed writes one observation the way a sync would have left it, so a read
// model test starts from a realistic row.
func storeSeed(t *testing.T, store *groupStore, ctx context.Context, jid, subject string, participants int) {
	t.Helper()
	if err := store.UpsertObserved(ctx, "org_default", "inst_1", jid, Observed{
		Subject: subject, SubjectSearch: foldText(subject), SubjectSource: SubjectFromSync,
		SubjectUpdatedAt: stamp(1), SubjectObservedAt: stamp(1),
		State: GroupActive, ParticipantCount: participants,
		LastSyncedAt: stamp(1), LastSyncSource: SyncOnConnect,
	}, true); err != nil {
		t.Fatalf("seed %s: %v", jid, err)
	}
}
