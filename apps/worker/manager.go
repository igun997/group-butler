package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// sessionState is the §5.1 `instances.runtime.status` vocabulary. It is the
// same set the reference worker used, so the BFF maps one enum to one badge.
type sessionState string

const (
	stateDisconnected sessionState = "disconnected"
	statePairing      sessionState = "pairing"
	stateConnected    sessionState = "connected"
	stateLoggedOut    sessionState = "logged_out"
	stateError        sessionState = "error"
)

// pairing modes accepted by POST /instances (§6.5).
const (
	modeQR   = "qr"
	modeCode = "code"
)

// pairingMaterialTTL bounds how long a QR data URL or pairing code is offered
// to the BFF. The TTL index in `pairingSessions` deletes it after that, so a
// forgotten pairing attempt cannot be presented as current hours later.
const pairingMaterialTTL = 5 * time.Minute

// Accepted errors the HTTP layer maps to stable codes.
var (
	errInstanceNotFound = errors.New("instance not found")
	errInvalidRequest   = errors.New("invalid request")
	errLabelConflict    = errors.New("instance label already exists")
	errWrongMode        = errors.New("instance is not in code-pairing mode")
	errPairingNotReady  = errors.New("pairing is not ready for a code yet")

	// Cleanup errors are recoverable: DELETE failed, but the instance and its
	// credentials are still in the state they were, so the owner can retry.
	errLogoutFailed       = errors.New("logout failed")
	errDeviceDeleteFailed = errors.New("delete auth device failed")
	errCleanupFailed      = errors.New("cleanup failed")
)

// InstanceRow is the worker's view of one `instances` document: the identity
// and the worker-owned `runtime.*` state, without the BFF's `config.*`. It is
// deliberately flat because the lifecycle rules below are pure functions over
// it (§14.2) and Mongo spelling belongs to the repository, not the rules.
type InstanceRow struct {
	ID             string
	OrganizationID string
	Label          string
	Mode           string
	Status         sessionState
	PhoneNumber    string
	BotJID         string
	BotLID         string
	PairingError   string
	ConnectedAt    time.Time
	LastSeenAt     time.Time
	DeletedAt      time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// phoneDigitsFromJID extracts the phone number from a user JID. Group JIDs
// carry no phone number and yield ""; an AD device suffix (`:12`, or the
// `user.agent:device` spelling) is stripped, because the same account appears
// under several device JIDs and they must not look like several instances.
func phoneDigitsFromJID(jid types.JID) string {
	if jid.Server != types.DefaultUserServer {
		return ""
	}
	user := jid.User
	if i := strings.IndexAny(user, ":."); i >= 0 {
		user = user[:i]
	}
	return user
}

// normalizePhone strips a JID suffix and surrounding space from a stored phone
// number, so the value compared against auth devices is always bare digits.
func normalizePhone(raw string) string {
	raw = strings.TrimSpace(raw)
	if i := strings.IndexAny(raw, "@:"); i >= 0 {
		raw = raw[:i]
	}
	return raw
}

// deviceOwnedByOther reports whether a device is already owned by a different
// live session. Comparing the non-AD form means the phone number and its
// per-device JID spellings are recognised as the same account — the reference
// bug that let one linked device back two instances (§6.1, §14).
func deviceOwnedByOther(live map[string]types.JID, selfID string, device types.JID) bool {
	target := device.ToNonAD()
	if target.IsEmpty() || target.User == "" {
		return false
	}
	for id, owned := range live {
		if id == selfID {
			continue
		}
		if owned.ToNonAD() == target {
			return true
		}
	}
	return false
}

// restorableInstances decides which persisted rows reconnect at boot. A row is
// restorable only when it has a phone number, is not logged out, and its own
// auth device still exists. The `hasDevice` lookup is per-phone on purpose:
// falling back to "the only registered device" is exactly the shortcut that
// made one account appear as several instances (§6.1).
func restorableInstances(rows []InstanceRow, hasDevice func(phone string) bool) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.Status == stateLoggedOut || !row.DeletedAt.IsZero() {
			continue
		}
		phone := normalizePhone(row.PhoneNumber)
		if phone == "" || !hasDevice(phone) {
			continue
		}
		ids = append(ids, row.ID)
	}
	return ids
}

// session is one live WhatsApp client plus the state the API reads. Every
// mutable field is behind the mutex: whatsmeow event handlers mutate it from
// its own goroutines while HTTP handlers read snapshots.
type session struct {
	mu   sync.Mutex
	mgr  *manager
	id   string
	mode string

	client    whatsmeowClient
	device    *store.Device
	handlerID uint32

	status       sessionState
	phoneNumber  string
	botJID       string
	botLID       string
	pairingError string
	qrDataURL    string
	pairingCode  string
	connectedAt  time.Time
	lastSeenAt   time.Time

	// pairingReady is closed once the login websocket has produced its first
	// QR payload, which is the moment whatsmeow documents for PairPhone.
	pairingReady chan struct{}
	readyOnce    sync.Once
}

func newSession(mgr *manager, row InstanceRow, device *store.Device, client whatsmeowClient) *session {
	return &session{
		mgr:          mgr,
		id:           row.ID,
		mode:         row.Mode,
		client:       client,
		device:       device,
		status:       statePairing,
		phoneNumber:  normalizePhone(row.PhoneNumber),
		pairingReady: make(chan struct{}),
	}
}

// sessionSnapshot is the race-free read of a session (§6.1). Callers never see
// a half-written field.
type sessionSnapshot struct {
	Status       sessionState
	PhoneNumber  string
	BotJID       string
	BotLID       string
	PairingError string
	QRDataURL    string
	PairingCode  string
	ConnectedAt  time.Time
	LastSeenAt   time.Time
}

func (s *session) snapshot() sessionSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return sessionSnapshot{
		Status:       s.status,
		PhoneNumber:  s.phoneNumber,
		BotJID:       s.botJID,
		BotLID:       s.botLID,
		PairingError: s.pairingError,
		QRDataURL:    s.qrDataURL,
		PairingCode:  s.pairingCode,
		ConnectedAt:  s.connectedAt,
		LastSeenAt:   s.lastSeenAt,
	}
}

func (s *session) deviceJID() types.JID {
	if s.device == nil {
		return types.EmptyJID
	}
	return s.device.GetJID()
}

// touch records the last activity the session observed, so a status poll can
// show a live-but-quiet instance.
func (s *session) touch(at time.Time) {
	s.mu.Lock()
	s.lastSeenAt = at
	s.mu.Unlock()
}

// groupStoreAPI is every `groups` write and read the worker performs. It is an
// interface so the event-handler routing (what runs off the whatsmeow callback)
// is provable without Mongo, and *groupStore satisfies it as-is.
type groupStoreAPI interface {
	FindOne(ctx context.Context, orgID, instanceID, groupJID string) *groupDoc
	Touch(ctx context.Context, orgID, instanceID, groupJID string, at time.Time) error
	UpsertObserved(ctx context.Context, orgID, instanceID, groupJID string, observed Observed, fromSync bool) error
	UpsertFromSync(ctx context.Context, orgID, instanceID string, info *types.GroupInfo, source SyncSource) error
	MarkLeft(ctx context.Context, orgID, instanceID, groupJID string, state GroupState) error
	KnownGroupJIDs(ctx context.Context, orgID, instanceID string) ([]string, error)
	ListForInstance(ctx context.Context, orgID, instanceID string) ([]groupListRow, *string, error)
	loadObserved(ctx context.Context, orgID, instanceID string) (map[string]Observed, error)
}

// receiptWriter is the §10 live-counter write for one receipt.
type receiptWriter interface {
	bumpReceipt(ctx context.Context, orgID, instanceID, groupJID string, at time.Time) error
}

// manager owns every live session, its auth device and its pairing material
// (§6.1). It is the only component that talks to whatsmeow.
type manager struct {
	cfg    Config
	orgID  string
	secret string

	groups    groupStoreAPI
	instances instanceRepo
	pairing   pairingStore
	stats     receiptWriter
	audit     *auditStore
	ingest    *ingestQueue
	media     *mediaRunner
	devices   deviceStore

	// persist carries Mongo work that originates on the whatsmeow event loop
	// onto its own bounded workers, so the protocol goroutine never waits on the
	// database (§6.2).
	persist *persistQueue

	// newClient is the whatsmeow seam: the production value builds a real
	// client, tests inject a fake so lifecycle and pairing are provable without
	// a socket or a live account.
	newClient func(*store.Device, waLog.Logger) whatsmeowClient

	// newTicker is the periodic-loop seam: production returns a time.Ticker,
	// tests push ticks by hand so the group-sync scheduler and media janitor
	// are provable without sleeping.
	newTicker func(time.Duration) (<-chan time.Time, func())

	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	sessions map[string]*session
	wg       sync.WaitGroup
}

// newManager builds the manager and the background context pairing goroutines
// run under. It starts nothing: restoreInstances and the HTTP server are the
// caller's next steps, so a failed restore can still be served and diagnosed.
func newManager(cfg Config, groups groupStoreAPI, instances instanceRepo, pairing pairingStore, ingest *ingestQueue, devices deviceStore) *manager {
	ctx, cancel := context.WithCancel(context.Background())
	return &manager{
		cfg:       cfg,
		orgID:     cfg.OrganizationID,
		secret:    cfg.WorkerSecret,
		groups:    groups,
		instances: instances,
		pairing:   pairing,
		ingest:    ingest,
		devices:   devices,
		persist:   newPersistQueue(cfg.EventQueueSize, cfg.EventWorkers),
		newClient: func(device *store.Device, log waLog.Logger) whatsmeowClient {
			return whatsmeowNewClient(device, log)
		},
		newTicker: func(d time.Duration) (<-chan time.Time, func()) {
			ticker := time.NewTicker(d)
			return ticker.C, ticker.Stop
		},
		ctx:      ctx,
		cancel:   cancel,
		sessions: make(map[string]*session),
	}
}

// enqueuePersist hands Mongo work to the persistence queue. A nil queue (a test
// manager that never touches Mongo) drops the job rather than writing inline —
// the callback must never fall back to synchronous I/O.
func (m *manager) enqueuePersist(job persistJob) {
	m.persist.enqueue(job)
}

func (m *manager) get(id string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

func (m *manager) put(s *session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[s.id] = s
}

func (m *manager) remove(id string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[id]
	delete(m.sessions, id)
	return s
}

// listActive returns the live sessions in a stable order so list responses and
// restores are deterministic.
func (m *manager) listActive() []*session {
	m.mu.Lock()
	out := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s)
	}
	m.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].id < out[j].id })
	return out
}

func (m *manager) snapshot(id string) (sessionSnapshot, bool) {
	s := m.get(id)
	if s == nil {
		return sessionSnapshot{}, false
	}
	return s.snapshot(), true
}

// liveDevices maps each live session to the device JID it owns. It backs the
// duplicate-ownership guard.
func (m *manager) liveDevices() map[string]types.JID {
	out := make(map[string]types.JID)
	for _, s := range m.listActive() {
		if jid := s.deviceJID(); !jid.IsEmpty() {
			out[s.id] = jid
		}
	}
	return out
}

// groupClient returns the live client for an instance, or nil when the
// instance has no connected session. The group endpoints answer 409 on nil
// rather than pretending an empty membership arrived (§6.6.6).
func (m *manager) groupClient(instanceID string) groupClient {
	s := m.get(instanceID)
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status != stateConnected || s.client == nil {
		return nil
	}
	return s.client
}

// api builds the control-plane handler with the manager's dependencies and
// live-client lookup (§6.5).
func (m *manager) api() *api {
	return &api{
		store:      m.groups,
		clientFor:  m.groupClient,
		manager:    m,
		orgID:      m.orgID,
		secret:     m.secret,
		prune:      m.cfg.GroupSyncPrune,
		staleAfter: m.cfg.GroupStaleAfter,
	}
}

// shutdown disconnects every client without logging out (§6.1): a deploy must
// not invalidate every linked device. It stops the pairing goroutines first so
// nothing reconnects while the process is leaving.
func (m *manager) shutdown(context.Context) {
	m.cancel()
	for _, s := range m.listActive() {
		s.mu.Lock()
		client := s.client
		s.mu.Unlock()
		if client != nil {
			client.Disconnect()
		}
	}
	m.wg.Wait()
}

// discard tears one session down locally: its event handler stops receiving
// events and the map no longer reports it. The auth device is left alone —
// callers that mean to invalidate a device must log out first.
func (m *manager) discard(s *session) {
	if s == nil {
		return
	}
	if s.client != nil {
		s.client.RemoveEventHandler(s.handlerID)
	}
	m.remove(s.id)
}

// ---- API snapshots -------------------------------------------------------

// instanceSnapshot is the §6.5 JSON the BFF polls. QR data and the pairing code
// are exposed only while the instance is pairing, so a connected instance never
// carries stale pairing material.
type instanceSnapshot struct {
	ID           string     `json:"id"`
	Label        string     `json:"label"`
	Mode         string     `json:"mode"`
	Status       string     `json:"status"`
	PhoneNumber  string     `json:"phoneNumber,omitempty"`
	BotJID       string     `json:"botJid,omitempty"`
	BotLID       string     `json:"botLid,omitempty"`
	PairingError string     `json:"pairingError,omitempty"`
	QR           string     `json:"qr,omitempty"`
	PairingCode  string     `json:"pairingCode,omitempty"`
	ConnectedAt  *time.Time `json:"connectedAt,omitempty"`
	LastSeenAt   *time.Time `json:"lastSeenAt,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
}

type instanceListResponse struct {
	Instances []instanceSnapshot `json:"instances"`
}

// mergedSnapshot overlays the live session and the persisted pairing material
// on a stored row, which is what the BFF polls during pairing.
func (m *manager) mergedSnapshot(ctx context.Context, row InstanceRow) instanceSnapshot {
	snap := instanceSnapshot{
		ID:           row.ID,
		Label:        row.Label,
		Mode:         row.Mode,
		Status:       string(row.Status),
		PhoneNumber:  row.PhoneNumber,
		BotJID:       row.BotJID,
		BotLID:       row.BotLID,
		PairingError: row.PairingError,
		CreatedAt:    row.CreatedAt,
	}
	if !row.ConnectedAt.IsZero() {
		t := row.ConnectedAt
		snap.ConnectedAt = &t
	}
	if !row.LastSeenAt.IsZero() {
		t := row.LastSeenAt
		snap.LastSeenAt = &t
	}
	if s := m.get(row.ID); s != nil {
		live := s.snapshot()
		snap.Status = string(live.Status)
		for _, v := range []struct {
			dst *string
			src string
		}{
			{&snap.PhoneNumber, live.PhoneNumber},
			{&snap.BotJID, live.BotJID},
			{&snap.BotLID, live.BotLID},
			{&snap.PairingError, live.PairingError},
		} {
			if v.src != "" {
				*v.dst = v.src
			}
		}
		if !live.ConnectedAt.IsZero() {
			t := live.ConnectedAt
			snap.ConnectedAt = &t
		}
		if !live.LastSeenAt.IsZero() {
			t := live.LastSeenAt
			snap.LastSeenAt = &t
		}
		if live.Status == statePairing {
			snap.QR = live.QRDataURL
			snap.PairingCode = live.PairingCode
		}
	}
	// Pairing material outlives a process restart in `pairingSessions`; a
	// connected instance has already had it cleared.
	if ps, err := m.pairing.Get(ctx, m.orgID, row.ID); err == nil && ps != nil {
		if ps.Error != "" && snap.PairingError == "" {
			snap.PairingError = ps.Error
		}
		// Only a live QR payload or code makes an instance "pairing"; a row
		// that holds nothing but a recorded failure must not look pairable.
		pairable := ps.Error == "" && (ps.QRDataURL != "" || ps.PairingCode != "")
		if pairable && snap.Status != string(stateConnected) {
			snap.Status = string(statePairing)
			if ps.QRDataURL != "" {
				snap.QR = ps.QRDataURL
			}
			if ps.PairingCode != "" {
				snap.PairingCode = ps.PairingCode
			}
		}
	}
	return snap
}

// listInstances reports every non-deleted instance, live state merged in.
func (m *manager) listInstances(ctx context.Context) ([]instanceSnapshot, error) {
	rows, err := m.instances.List(ctx, m.orgID)
	if err != nil {
		return nil, err
	}
	out := make([]instanceSnapshot, 0, len(rows))
	for _, row := range rows {
		out = append(out, m.mergedSnapshot(ctx, row))
	}
	return out, nil
}

// getInstance reports one instance or errInstanceNotFound.
func (m *manager) getInstance(ctx context.Context, id string) (instanceSnapshot, error) {
	row, err := m.instances.Get(ctx, m.orgID, id)
	if err != nil {
		return instanceSnapshot{}, err
	}
	if row == nil {
		return instanceSnapshot{}, errInstanceNotFound
	}
	return m.mergedSnapshot(ctx, *row), nil
}

type createInstanceRequest struct {
	Label       string `json:"label"`
	Mode        string `json:"mode"`
	PhoneNumber string `json:"phoneNumber"`
}

func (r createInstanceRequest) validate() error {
	if strings.TrimSpace(r.Label) == "" {
		return fmt.Errorf("%w: label is required", errInvalidRequest)
	}
	switch r.Mode {
	case modeQR:
	case modeCode:
		if normalizePhone(r.PhoneNumber) == "" {
			return fmt.Errorf("%w: phoneNumber is required for code pairing", errInvalidRequest)
		}
	default:
		return fmt.Errorf("%w: mode must be %q or %q", errInvalidRequest, modeQR, modeCode)
	}
	return nil
}

// createInstance persists the row, then links a fresh device and starts
// pairing. The returned snapshot is the pairing state, which the BFF polls
// until it turns connected or errors.
func (m *manager) createInstance(ctx context.Context, req createInstanceRequest) (instanceSnapshot, error) {
	if err := req.validate(); err != nil {
		return instanceSnapshot{}, err
	}
	at := now().UTC()
	row := InstanceRow{
		ID:             newID(),
		OrganizationID: m.orgID,
		Label:          strings.TrimSpace(req.Label),
		Mode:           req.Mode,
		Status:         statePairing,
		PhoneNumber:    normalizePhone(req.PhoneNumber),
		CreatedAt:      at,
		UpdatedAt:      at,
	}
	if err := m.instances.Create(ctx, row); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return instanceSnapshot{}, errLabelConflict
		}
		return instanceSnapshot{}, err
	}
	if _, err := m.beginPairing(row); err != nil {
		// The row exists but could not begin pairing: record why so the
		// dashboard can show it instead of a silent stuck "pairing".
		if markErr := m.markStatus(context.WithoutCancel(ctx), row.ID, stateError, err.Error()); markErr != nil {
			logf("instance %s: record pairing error: %v", row.ID, markErr)
		}
		return instanceSnapshot{}, err
	}
	return m.getInstance(ctx, row.ID)
}

// deleteInstance is the one path that must invalidate a device: log out,
// delete the auth device, clear pairing material and soft-delete the row
// (§6.5). Each step is a precondition for the next: a failed logout or device
// deletion leaves the row and the session untouched so the owner can retry,
// because claiming a soft-delete over a live credential would hide a device
// that still exists. Graceful shutdown deliberately does none of this.
func (m *manager) deleteInstance(ctx context.Context, id string) error {
	row, err := m.instances.Get(ctx, m.orgID, id)
	if err != nil {
		return err
	}
	if row == nil {
		return errInstanceNotFound
	}
	if s := m.get(id); s != nil {
		if err := m.logoutSession(ctx, s); err != nil {
			return err
		}
	}
	if err := m.deleteAuthDevice(ctx, *row); err != nil {
		return err
	}
	if err := m.pairing.Clear(ctx, m.orgID, id); err != nil {
		return fmt.Errorf("%w: clear pairing material: %v", errCleanupFailed, err)
	}
	return m.instances.SoftDelete(ctx, m.orgID, id)
}

// logoutSession invalidates one linked device. ErrNotLoggedIn means there is
// nothing to unlink — an unpaired instance — which is a success, not a failure;
// any other error leaves the session live and is reported so DELETE can refuse.
func (m *manager) logoutSession(ctx context.Context, s *session) error {
	s.mu.Lock()
	client := s.client
	s.mu.Unlock()
	if client == nil {
		m.discard(s)
		return nil
	}
	if err := client.Logout(ctx); err != nil && !errors.Is(err, whatsmeow.ErrNotLoggedIn) {
		return fmt.Errorf("%w: %v", errLogoutFailed, err)
	}
	m.discard(s)
	return nil
}

// deleteAuthDevice removes the stored credential for the instance's own phone.
// A successful Logout already deleted it, so this only finds work in the
// not-logged-in case (an orphaned device row); a store error is reported rather
// than ignored.
func (m *manager) deleteAuthDevice(ctx context.Context, row InstanceRow) error {
	phone := normalizePhone(row.PhoneNumber)
	if phone == "" {
		return nil
	}
	device, err := m.deviceForPhone(ctx, phone)
	if err != nil {
		return fmt.Errorf("%w: %v", errDeviceDeleteFailed, err)
	}
	if device == nil {
		return nil
	}
	if err := m.devices.DeleteDevice(ctx, device); err != nil {
		return fmt.Errorf("%w: %v", errDeviceDeleteFailed, err)
	}
	return nil
}

// ---- Mongo repositories --------------------------------------------------

// instanceRepo is the worker's write surface over `instances.runtime.*`. The
// BFF owns `config.*` and the document root timestamps; every write here touches
// only the worker-owned subdocument (§5.2, one writer per subdocument).
type instanceRepo interface {
	Create(ctx context.Context, row InstanceRow) error
	Get(ctx context.Context, orgID, id string) (*InstanceRow, error)
	List(ctx context.Context, orgID string) ([]InstanceRow, error)
	SetStatus(ctx context.Context, orgID, id string, status sessionState, pairingError string) error
	SetConnected(ctx context.Context, orgID, id, phoneNumber, botJID, botLID string) error
	SoftDelete(ctx context.Context, orgID, id string) error
}

type instanceMongo struct {
	coll *mongo.Collection
}

func newInstanceMongo(db *mongo.Database) *instanceMongo {
	return &instanceMongo{coll: db.Collection(collInstances)}
}

type instanceRuntimeDoc struct {
	Status       string    `bson:"status"`
	PhoneNumber  string    `bson:"phoneNumber"`
	BotJID       string    `bson:"botJid"`
	BotLID       string    `bson:"botLid"`
	PairingError *string   `bson:"pairingError"`
	ConnectedAt  time.Time `bson:"connectedAt"`
	LastSeenAt   time.Time `bson:"lastSeenAt"`
}

type instanceDoc struct {
	ID             string             `bson:"_id"`
	OrganizationID string             `bson:"organizationId"`
	Label          string             `bson:"label"`
	Mode           string             `bson:"mode"`
	Runtime        instanceRuntimeDoc `bson:"runtime"`
	DeletedAt      *time.Time         `bson:"deletedAt"`
	CreatedAt      time.Time          `bson:"createdAt"`
	UpdatedAt      time.Time          `bson:"updatedAt"`
}

func (d instanceDoc) row() InstanceRow {
	row := InstanceRow{
		ID:             d.ID,
		OrganizationID: d.OrganizationID,
		Label:          d.Label,
		Mode:           d.Mode,
		Status:         sessionState(d.Runtime.Status),
		PhoneNumber:    d.Runtime.PhoneNumber,
		BotJID:         d.Runtime.BotJID,
		BotLID:         d.Runtime.BotLID,
		ConnectedAt:    d.Runtime.ConnectedAt,
		LastSeenAt:     d.Runtime.LastSeenAt,
		CreatedAt:      d.CreatedAt,
		UpdatedAt:      d.UpdatedAt,
	}
	if d.Runtime.PairingError != nil {
		row.PairingError = *d.Runtime.PairingError
	}
	if d.DeletedAt != nil {
		row.DeletedAt = *d.DeletedAt
	}
	return row
}

func liveInstanceFilter(orgID, id string) bson.D {
	return bson.D{
		{Key: "_id", Value: id},
		{Key: "organizationId", Value: orgID},
		{Key: "deletedAt", Value: nil},
	}
}

func (r *instanceMongo) Create(ctx context.Context, row InstanceRow) error {
	at := row.CreatedAt
	if at.IsZero() {
		at = now().UTC()
	}
	_, err := r.coll.InsertOne(ctx, bson.D{
		{Key: "_id", Value: row.ID},
		{Key: "organizationId", Value: row.OrganizationID},
		{Key: "label", Value: row.Label},
		{Key: "mode", Value: row.Mode},
		{Key: "runtime", Value: bson.D{
			{Key: "status", Value: string(row.Status)},
			{Key: "phoneNumber", Value: normalizePhone(row.PhoneNumber)},
			{Key: "botJid", Value: ""},
			{Key: "botLid", Value: ""},
			{Key: "pairingError", Value: nil},
		}},
		{Key: "deletedAt", Value: nil},
		{Key: "createdAt", Value: at},
		{Key: "updatedAt", Value: at},
	})
	if err != nil {
		return fmt.Errorf("create instance: %w", err)
	}
	return nil
}

func (r *instanceMongo) Get(ctx context.Context, orgID, id string) (*InstanceRow, error) {
	var doc instanceDoc
	err := r.coll.FindOne(ctx, liveInstanceFilter(orgID, id)).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get instance %s: %w", id, err)
	}
	row := doc.row()
	return &row, nil
}

func (r *instanceMongo) List(ctx context.Context, orgID string) ([]InstanceRow, error) {
	cursor, err := r.coll.Find(ctx,
		bson.D{{Key: "organizationId", Value: orgID}, {Key: "deletedAt", Value: nil}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}, {Key: "_id", Value: 1}}),
	)
	if err != nil {
		return nil, fmt.Errorf("list instances: %w", err)
	}
	defer func() { _ = cursor.Close(ctx) }()
	rows := make([]InstanceRow, 0)
	for cursor.Next(ctx) {
		var doc instanceDoc
		if err := cursor.Decode(&doc); err != nil {
			return nil, fmt.Errorf("decode instance: %w", err)
		}
		rows = append(rows, doc.row())
	}
	if err := cursor.Err(); err != nil {
		return nil, fmt.Errorf("list instances: %w", err)
	}
	return rows, nil
}

func (r *instanceMongo) SetStatus(ctx context.Context, orgID, id string, status sessionState, pairingError string) error {
	pairing := bson.D{{Key: "runtime.pairingError", Value: nil}}
	if pairingError != "" {
		pairing = bson.D{{Key: "runtime.pairingError", Value: pairingError}}
	}
	_, err := r.coll.UpdateOne(ctx, liveInstanceFilter(orgID, id), bson.D{
		{Key: "$set", Value: append(bson.D{{Key: "runtime.status", Value: string(status)}}, pairing...)},
	})
	if err != nil {
		return fmt.Errorf("set instance %s status: %w", id, err)
	}
	return nil
}

func (r *instanceMongo) SetConnected(ctx context.Context, orgID, id, phoneNumber, botJID, botLID string) error {
	at := now().UTC()
	_, err := r.coll.UpdateOne(ctx, liveInstanceFilter(orgID, id), bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "runtime.status", Value: string(stateConnected)},
			{Key: "runtime.phoneNumber", Value: phoneNumber},
			{Key: "runtime.botJid", Value: botJID},
			{Key: "runtime.botLid", Value: botLID},
			{Key: "runtime.pairingError", Value: nil},
			{Key: "runtime.connectedAt", Value: at},
			{Key: "runtime.lastSeenAt", Value: at},
		}},
	})
	if err != nil {
		return fmt.Errorf("set instance %s connected: %w", id, err)
	}
	return nil
}

func (r *instanceMongo) SoftDelete(ctx context.Context, orgID, id string) error {
	_, err := r.coll.UpdateOne(ctx, liveInstanceFilter(orgID, id), bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "runtime.status", Value: string(stateLoggedOut)},
			{Key: "deletedAt", Value: now().UTC()},
		}},
	})
	if err != nil {
		return fmt.Errorf("soft-delete instance %s: %w", id, err)
	}
	return nil
}

// pairingSession is the §5.1 `pairingSessions` document: transient pairing
// material kept outside `instances` so the TTL index can never delete an
// instance.
type pairingSession struct {
	InstanceID     string    `bson:"_id"`
	OrganizationID string    `bson:"organizationId"`
	Mode           string    `bson:"mode"`
	QRDataURL      string    `bson:"qrDataUrl"`
	PairingCode    string    `bson:"pairingCode"`
	Error          string    `bson:"error"`
	ExpiresAt      time.Time `bson:"expiresAt"`
	UpdatedAt      time.Time `bson:"updatedAt"`
}

type pairingStore interface {
	Put(ctx context.Context, ps pairingSession) error
	Get(ctx context.Context, orgID, id string) (*pairingSession, error)
	Clear(ctx context.Context, orgID, id string) error
}

type pairingMongo struct {
	coll *mongo.Collection
}

func newPairingMongo(db *mongo.Database) *pairingMongo {
	return &pairingMongo{coll: db.Collection(collPairingSession)}
}

func (p *pairingMongo) Put(ctx context.Context, ps pairingSession) error {
	at := now().UTC()
	_, err := p.coll.UpdateOne(ctx,
		bson.D{{Key: "_id", Value: ps.InstanceID}, {Key: "organizationId", Value: ps.OrganizationID}},
		bson.D{
			{Key: "$set", Value: bson.D{
				{Key: "organizationId", Value: ps.OrganizationID},
				{Key: "mode", Value: ps.Mode},
				{Key: "qrDataUrl", Value: ps.QRDataURL},
				{Key: "pairingCode", Value: ps.PairingCode},
				{Key: "error", Value: ps.Error},
				{Key: "expiresAt", Value: at.Add(pairingMaterialTTL)},
				{Key: "updatedAt", Value: at},
			}},
		},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return fmt.Errorf("put pairing session %s: %w", ps.InstanceID, err)
	}
	return nil
}

func (p *pairingMongo) Get(ctx context.Context, orgID, id string) (*pairingSession, error) {
	var ps pairingSession
	err := p.coll.FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "organizationId", Value: orgID}}).Decode(&ps)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get pairing session %s: %w", id, err)
	}
	return &ps, nil
}

func (p *pairingMongo) Clear(ctx context.Context, orgID, id string) error {
	_, err := p.coll.DeleteOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "organizationId", Value: orgID}})
	if err != nil {
		return fmt.Errorf("clear pairing session %s: %w", id, err)
	}
	return nil
}

// statsStore owns the worker's live `$inc` on the `statsDaily` today-row
// (§10 layer 1). The BFF's nightly `$merge` recompute reconciles these.
type statsStore struct {
	coll *mongo.Collection
}

func newStatsStore(db *mongo.Database) *statsStore {
	return &statsStore{coll: db.Collection(collStatsDaily)}
}

// bumpReceipt records one inbound receipt for the instance/group/day. A receipt
// is live-only: it is evidence of delivery, not a message, so it has its own
// counter rather than inflating `messagesIn`.
func (s *statsStore) bumpReceipt(ctx context.Context, orgID, instanceID, groupJID string, at time.Time) error {
	day := at.UTC().Format("2006-01-02")
	_, err := s.coll.UpdateOne(ctx,
		bson.D{
			{Key: "organizationId", Value: orgID},
			{Key: "day", Value: day},
			{Key: "instanceId", Value: instanceID},
			{Key: "groupJid", Value: groupJID},
		},
		bson.D{
			{Key: "$inc", Value: bson.D{{Key: "counters.receipts", Value: 1}}},
			{Key: "$set", Value: bson.D{{Key: "updatedAt", Value: at}}},
			{Key: "$setOnInsert", Value: bson.D{
				{Key: "organizationId", Value: orgID},
				{Key: "day", Value: day},
				{Key: "instanceId", Value: instanceID},
				{Key: "groupJid", Value: groupJID},
			}},
		},
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return fmt.Errorf("bump receipt stats: %w", err)
	}
	return nil
}

// auditStore appends worker actions to `auditLog` (§5.1). Pairing and logout
// are security-relevant state changes, so they leave a durable trace.
type auditStore struct {
	coll *mongo.Collection
}

func newAuditStore(db *mongo.Database) *auditStore {
	return &auditStore{coll: db.Collection(collAuditLog)}
}

func (a *auditStore) append(ctx context.Context, orgID, action, targetType, targetID string, meta bson.M) error {
	_, err := a.coll.InsertOne(ctx, bson.D{
		{Key: "organizationId", Value: orgID},
		{Key: "actor", Value: "worker"},
		{Key: "action", Value: action},
		{Key: "target", Value: bson.D{{Key: "type", Value: targetType}, {Key: "id", Value: targetID}}},
		{Key: "meta", Value: meta},
		{Key: "createdAt", Value: now().UTC()},
	})
	if err != nil {
		return fmt.Errorf("append audit %s: %w", action, err)
	}
	return nil
}
