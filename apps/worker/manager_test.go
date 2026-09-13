package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// ---- fakes ---------------------------------------------------------------

// fakeInstanceRepo is the §5.1 `instances` surface with no Mongo. It records the
// worker-owned writes so the lifecycle contract is asserted, not the driver.
type fakeInstanceRepo struct {
	mu        sync.Mutex
	rows      map[string]InstanceRow
	statuses  map[string]sessionState
	connected map[string]bool
	deleted   map[string]bool
}

func newFakeInstanceRepo(rows ...InstanceRow) *fakeInstanceRepo {
	r := &fakeInstanceRepo{
		rows:      map[string]InstanceRow{},
		statuses:  map[string]sessionState{},
		connected: map[string]bool{},
		deleted:   map[string]bool{},
	}
	for _, row := range rows {
		r.rows[row.ID] = row
	}
	return r
}

func (r *fakeInstanceRepo) Create(_ context.Context, row InstanceRow) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.rows {
		if existing.Label == row.Label && !r.deleted[existing.ID] {
			return mongo.WriteException{WriteErrors: []mongo.WriteError{{Code: 11000, Message: "E11000 duplicate key error"}}}
		}
	}
	r.rows[row.ID] = row
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

func (r *fakeInstanceRepo) SetStatus(_ context.Context, _, id string, status sessionState, _ string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.statuses[id] = status
	return nil
}

func (r *fakeInstanceRepo) SetConnected(_ context.Context, _, id, phone, botJID, botLID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.connected[id] = true
	row := r.rows[id]
	row.Status = stateConnected
	row.PhoneNumber, row.BotJID, row.BotLID = phone, botJID, botLID
	r.rows[id] = row
	return nil
}

func (r *fakeInstanceRepo) SoftDelete(_ context.Context, _, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deleted[id] = true
	return nil
}

type fakePairingStore struct {
	mu    sync.Mutex
	items map[string]pairingSession
}

func newFakePairingStore() *fakePairingStore {
	return &fakePairingStore{items: map[string]pairingSession{}}
}

func (p *fakePairingStore) Put(_ context.Context, ps pairingSession) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.items[ps.InstanceID] = ps
	return nil
}

func (p *fakePairingStore) Get(_ context.Context, _, id string) (*pairingSession, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	ps, ok := p.items[id]
	if !ok {
		return nil, nil
	}
	return &ps, nil
}

func (p *fakePairingStore) Clear(_ context.Context, _, id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.items, id)
	return nil
}

// fakeDeviceStore stands in for the SQL auth store: it hands out devices and
// records deletions, which is the only part of the store logout touches.
type fakeDeviceStore struct {
	mu        sync.Mutex
	device    *store.Device
	deleted   []*store.Device
	deleteErr error
}

func (d *fakeDeviceStore) NewDevice() *store.Device {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.device
}

func (d *fakeDeviceStore) GetAllDevices(context.Context) ([]*store.Device, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.device == nil {
		return nil, nil
	}
	return []*store.Device{d.device}, nil
}

func (d *fakeDeviceStore) DeleteDevice(_ context.Context, device *store.Device) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.deleteErr != nil {
		return d.deleteErr
	}
	d.deleted = append(d.deleted, device)
	return nil
}

func (d *fakeDeviceStore) Close() error { return nil }

// fakeClient records the lifecycle calls and satisfies the whatsmeow surface
// the manager uses. It never touches a network.
type fakeClient struct {
	mu          sync.Mutex
	connects    int
	disconnects int
	logouts     int
	qr          chan whatsmeow.QRChannelItem
	pairCode    string
	logoutErr   error
	groups      []*types.GroupInfo
	groupCalls  int
	download    []byte
}

func newFakeClient() *fakeClient {
	return &fakeClient{qr: make(chan whatsmeow.QRChannelItem, 4)}
}

func (c *fakeClient) AddEventHandler(whatsmeow.EventHandler) uint32 { return 1 }
func (c *fakeClient) RemoveEventHandler(uint32) bool                { return true }
func (c *fakeClient) Connect() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.connects++
	return nil
}
func (c *fakeClient) Disconnect() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.disconnects++
}
func (c *fakeClient) Logout(context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.logouts++
	return c.logoutErr
}
func (c *fakeClient) IsConnected() bool { return true }
func (c *fakeClient) GetQRChannel(context.Context) (<-chan whatsmeow.QRChannelItem, error) {
	return c.qr, nil
}
func (c *fakeClient) PairPhone(context.Context, string, bool, whatsmeow.PairClientType, string) (string, error) {
	return c.pairCode, nil
}
func (c *fakeClient) ParseWebMessage(types.JID, *waWeb.WebMessageInfo) (*events.Message, error) {
	return nil, errors.New("unused in unit tests")
}
func (c *fakeClient) DownloadToFile(_ context.Context, _ whatsmeow.DownloadableMessage, file whatsmeow.File) error {
	if c.download == nil {
		return errors.New("unused in unit tests")
	}
	_, err := file.Write(c.download)
	return err
}
func (c *fakeClient) GetJoinedGroups(context.Context) ([]*types.GroupInfo, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.groupCalls++
	return c.groups, nil
}

func (c *fakeClient) groupCallCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.groupCalls
}
func (c *fakeClient) GetGroupInfo(context.Context, types.JID) (*types.GroupInfo, error) {
	return nil, errors.New("unused in unit tests")
}

func testManager(repo instanceRepo, pairing pairingStore, devices deviceStore, client whatsmeowClient) *manager {
	cfg := Config{
		OrganizationID:     "org_default",
		WorkerSecret:       "dev-secret",
		GroupSyncPrune:     true,
		HistorySyncMaxDays: 30,
		MediaConcurrency:   2,
	}
	mgr := newManager(cfg, nil, repo, pairing, nil, devices)
	mgr.newClient = func(*store.Device, waLog.Logger) whatsmeowClient { return client }
	return mgr
}

func callJSON(t *testing.T, handler *api, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.routes().ServeHTTP(rec, req)
	return rec
}

// ---- manager bookkeeping -------------------------------------------------

func TestManagerListActiveIsStable(t *testing.T) {
	mgr := testManager(newFakeInstanceRepo(), newFakePairingStore(), nil, newFakeClient())
	mgr.put(&session{id: "inst_b"})
	mgr.put(&session{id: "inst_a"})

	got := mgr.listActive()
	if len(got) != 2 || got[0].id != "inst_a" || got[1].id != "inst_b" {
		t.Fatalf("listActive = %v, want [inst_a inst_b]", []string{got[0].id, got[1].id})
	}
	if removed := mgr.remove("inst_a"); removed == nil {
		t.Fatal("remove must return the session it dropped")
	}
	if len(mgr.listActive()) != 1 {
		t.Fatalf("listActive after remove = %d, want 1", len(mgr.listActive()))
	}
}

func TestShutdownDisconnectsWithoutLoggingOut(t *testing.T) {
	client := newFakeClient()
	mgr := testManager(newFakeInstanceRepo(), newFakePairingStore(), nil, client)
	device := &store.Device{}
	mgr.put(newSession(mgr, InstanceRow{ID: "inst_1", OrganizationID: "org_default"}, device, client))

	mgr.shutdown(context.Background())

	client.mu.Lock()
	defer client.mu.Unlock()
	if client.disconnects != 1 {
		t.Errorf("disconnects = %d, want 1 (graceful shutdown disconnects)", client.disconnects)
	}
	if client.logouts != 0 {
		t.Errorf("logouts = %d, want 0 (a deploy must not invalidate linked devices)", client.logouts)
	}
}

// ---- HTTP lifecycle ------------------------------------------------------

func TestInstanceLifecycleEndpoints(t *testing.T) {
	phone := types.NewJID("628990000001:5", types.DefaultUserServer)
	repo := newFakeInstanceRepo()
	pairing := newFakePairingStore()
	devices := &fakeDeviceStore{device: &store.Device{ID: &phone}}
	client := newFakeClient()
	mgr := testManager(repo, pairing, devices, client)
	defer mgr.shutdown(context.Background())
	handler := mgr.api()

	if rec := callJSON(t, handler, http.MethodGet, "/instances", "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET /instances = %d, want 401", rec.Code)
	}

	if rec := callJSON(t, handler, http.MethodPost, "/instances", "dev-secret", `{"mode":"qr"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("create without label = %d, want 400", rec.Code)
	}

	rec := callJSON(t, handler, http.MethodPost, "/instances", "dev-secret",
		`{"label":"Support bot","mode":"code","phoneNumber":"628990000001"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d, body = %s", rec.Code, rec.Body.String())
	}
	var created instanceSnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if created.ID == "" || created.Status != string(statePairing) {
		t.Fatalf("create snapshot = %+v, want a pairing instance with an id", created)
	}

	// A duplicate label is a stable 409, not a 500.
	if rec := callJSON(t, handler, http.MethodPost, "/instances", "dev-secret",
		`{"label":"Support bot","mode":"qr"}`); rec.Code != http.StatusConflict {
		t.Fatalf("duplicate label = %d, want 409", rec.Code)
	}

	rec = callJSON(t, handler, http.MethodGet, "/instances", "dev-secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d", rec.Code)
	}
	var list instanceListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.Instances) != 1 {
		t.Fatalf("list = %d instances, want 1", len(list.Instances))
	}

	if rec := callJSON(t, handler, http.MethodGet, "/instances/"+created.ID, "dev-secret", ""); rec.Code != http.StatusOK {
		t.Fatalf("get = %d", rec.Code)
	}
	if rec := callJSON(t, handler, http.MethodGet, "/instances/unknown", "dev-secret", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("get unknown = %d, want 404", rec.Code)
	}

	if rec := callJSON(t, handler, http.MethodDelete, "/instances/"+created.ID, "dev-secret", ""); rec.Code != http.StatusOK {
		t.Fatalf("delete = %d, body = %s", rec.Code, rec.Body.String())
	}
	client.mu.Lock()
	logouts := client.logouts
	client.mu.Unlock()
	if logouts != 1 {
		t.Errorf("logouts = %d, want 1 (DELETE /instances is the one path that invalidates the device)", logouts)
	}
	devices.mu.Lock()
	deleted := len(devices.deleted)
	devices.mu.Unlock()
	if deleted != 1 {
		t.Errorf("deleted auth devices = %d, want 1", deleted)
	}
	if rec := callJSON(t, handler, http.MethodGet, "/instances/"+created.ID, "dev-secret", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("get after delete = %d, want 404", rec.Code)
	}
}

func TestPairingCodeRequiresCodeMode(t *testing.T) {
	repo := newFakeInstanceRepo(InstanceRow{ID: "inst_qr", OrganizationID: "org_default", Label: "QR", Mode: modeQR, Status: statePairing})
	client := newFakeClient()
	mgr := testManager(repo, newFakePairingStore(), &fakeDeviceStore{device: &store.Device{}}, client)
	defer mgr.shutdown(context.Background())
	// Register a live session so the mode check is what answers.
	mgr.put(newSession(mgr, InstanceRow{ID: "inst_qr", OrganizationID: "org_default", Label: "QR", Mode: modeQR}, &store.Device{}, client))

	rec := callJSON(t, mgr.api(), http.MethodPost, "/instances/inst_qr/pairing-code", "dev-secret", `{}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("pairing-code on a qr instance = %d, want 409", rec.Code)
	}
}

func TestPairingCodeReturnsThePhoneLinkCode(t *testing.T) {
	phone := "628990000001"
	client := newFakeClient()
	client.pairCode = "1234-5678"
	// The first channel item marks the login websocket ready, the documented
	// precondition for PairPhone.
	client.qr <- whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventCode, Code: "2@abc,def"}

	repo := newFakeInstanceRepo()
	devices := &fakeDeviceStore{device: &store.Device{}}
	mgr := testManager(repo, newFakePairingStore(), devices, client)
	defer mgr.shutdown(context.Background())

	created, err := mgr.createInstance(context.Background(), createInstanceRequest{Label: "Code bot", Mode: modeCode, PhoneNumber: phone})
	if err != nil {
		t.Fatalf("createInstance: %v", err)
	}
	snap, err := mgr.requestPairingCode(context.Background(), created.ID)
	if err != nil {
		t.Fatalf("requestPairingCode: %v", err)
	}
	if snap.PairingCode != "1234-5678" || snap.Status != string(statePairing) {
		t.Fatalf("snapshot = %+v, want pairing code 1234-5678 while pairing", snap)
	}
}

// ---- restore -------------------------------------------------------------

func TestRestoreInstancesReconnectsOnlyOwnDevice(t *testing.T) {
	deviceJID := types.NewJID("628990000001:5", types.DefaultUserServer)
	repo := newFakeInstanceRepo(
		InstanceRow{ID: "inst_1", OrganizationID: "org_default", Label: "One", Mode: modeQR, Status: stateConnected, PhoneNumber: "628990000001"},
		InstanceRow{ID: "inst_2", OrganizationID: "org_default", Label: "Two", Mode: modeQR, Status: stateConnected, PhoneNumber: "628990000002"},
	)
	devices := &fakeDeviceStore{device: &store.Device{ID: &deviceJID}}
	client := newFakeClient()
	mgr := testManager(repo, newFakePairingStore(), devices, client)
	defer mgr.shutdown(context.Background())

	restoreInstances(context.Background(), mgr)

	if mgr.get("inst_1") == nil {
		t.Error("inst_1 must be restored from its own auth device")
	}
	if mgr.get("inst_2") != nil {
		t.Error("inst_2 has no auth device of its own and must not borrow another")
	}
	client.mu.Lock()
	connects := client.connects
	client.mu.Unlock()
	if connects != 1 {
		t.Errorf("connects = %d, want 1", connects)
	}
}

// ---- DELETE must not claim success before cleanup succeeds (blocker 2) ----

func TestDeleteInstanceKeepsTheRowWhenLogoutFails(t *testing.T) {
	phone := types.NewJID("628990000001:5", types.DefaultUserServer)
	repo := newFakeInstanceRepo(InstanceRow{
		ID: "inst_1", OrganizationID: "org_default", Label: "Bot",
		Mode: modeQR, Status: stateConnected, PhoneNumber: "628990000001",
	})
	devices := &fakeDeviceStore{device: &store.Device{ID: &phone}}
	client := newFakeClient()
	client.logoutErr = errors.New("whatsapp refused the logout")
	mgr := testManager(repo, newFakePairingStore(), devices, client)
	defer mgr.shutdown(context.Background())
	mgr.put(newSession(mgr, InstanceRow{ID: "inst_1", OrganizationID: "org_default", Mode: modeQR}, &store.Device{ID: &phone}, client))

	rec := callJSON(t, mgr.api(), http.MethodDelete, "/instances/inst_1", "dev-secret", "")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 when logout fails: %s", rec.Code, rec.Body.String())
	}
	repo.mu.Lock()
	deleted := repo.deleted["inst_1"]
	repo.mu.Unlock()
	if deleted {
		t.Fatal("the row was soft-deleted even though logout failed")
	}
	if mgr.get("inst_1") == nil {
		t.Fatal("the live session was discarded on a failed logout")
	}
	if rec := callJSON(t, mgr.api(), http.MethodGet, "/instances/inst_1", "dev-secret", ""); rec.Code != http.StatusOK {
		t.Fatalf("instance unreadable after a failed delete: %d", rec.Code)
	}
}

func TestDeleteInstanceKeepsTheRowWhenDeviceDeleteFails(t *testing.T) {
	phone := types.NewJID("628990000001:5", types.DefaultUserServer)
	repo := newFakeInstanceRepo(InstanceRow{
		ID: "inst_1", OrganizationID: "org_default", Label: "Bot",
		Mode: modeQR, Status: stateConnected, PhoneNumber: "628990000001",
	})
	devices := &fakeDeviceStore{device: &store.Device{ID: &phone}, deleteErr: errors.New("auth store write failed")}
	client := newFakeClient()
	// Nothing is linked yet, so logout is a no-op; the device delete is the
	// step that fails and must stop the deletion.
	client.logoutErr = whatsmeow.ErrNotLoggedIn
	mgr := testManager(repo, newFakePairingStore(), devices, client)
	defer mgr.shutdown(context.Background())
	mgr.put(newSession(mgr, InstanceRow{ID: "inst_1", OrganizationID: "org_default", Mode: modeQR}, &store.Device{ID: &phone}, client))

	rec := callJSON(t, mgr.api(), http.MethodDelete, "/instances/inst_1", "dev-secret", "")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 when the auth device cannot be deleted: %s", rec.Code, rec.Body.String())
	}
	repo.mu.Lock()
	deleted := repo.deleted["inst_1"]
	repo.mu.Unlock()
	if deleted {
		t.Fatal("the row was soft-deleted even though the auth device was not deleted")
	}
}

func TestDeleteInstanceSucceedsWhenNothingIsLinkedYet(t *testing.T) {
	repo := newFakeInstanceRepo(InstanceRow{
		ID: "inst_1", OrganizationID: "org_default", Label: "Bot",
		Mode: modeQR, Status: statePairing, PhoneNumber: "",
	})
	client := newFakeClient()
	client.logoutErr = whatsmeow.ErrNotLoggedIn
	mgr := testManager(repo, newFakePairingStore(), &fakeDeviceStore{}, client)
	defer mgr.shutdown(context.Background())
	mgr.put(newSession(mgr, InstanceRow{ID: "inst_1", OrganizationID: "org_default", Mode: modeQR}, &store.Device{}, client))

	rec := callJSON(t, mgr.api(), http.MethodDelete, "/instances/inst_1", "dev-secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for an instance that was never linked: %s", rec.Code, rec.Body.String())
	}
	repo.mu.Lock()
	deleted := repo.deleted["inst_1"]
	repo.mu.Unlock()
	if !deleted {
		t.Fatal("an unlinked instance must still be deletable")
	}
}
