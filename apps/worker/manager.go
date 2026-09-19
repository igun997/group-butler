package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// sessionState is the §5.1 `instances.runtime.status` vocabulary. It is the
// same set the reference worker used, so the BFF maps one enum to one badge.
//
// The whole set is kept even though this worker can no longer enter any of these
// states by itself: the row's status is written by whoever owns the WhatsApp
// link — the Hermes pairing wizard through the BFF — and the worker must be able
// to read and report every value the shared contract defines
// (`packages/shared/src/worker-contract.ts`).
type sessionState string

const (
	stateDisconnected sessionState = "disconnected"
	statePairing      sessionState = "pairing"
	stateConnected    sessionState = "connected"
	stateLoggedOut    sessionState = "logged_out"
	stateError        sessionState = "error"
)

// Accepted errors the HTTP layer maps to stable codes.
var (
	errInstanceNotFound = errors.New("instance not found")
	errInvalidRequest   = errors.New("invalid request")

	// errPairingMoved is the refusal every route that used to link a device into
	// this worker's own session answers with. It names where pairing went, so an
	// operator reading the worker's answer is not left guessing whether the
	// console is broken.
	errPairingMoved = errors.New("pairing is handled by the Hermes pairing wizard; this worker holds no whatsapp session")
)

// InstanceRow is the worker's view of one `instances` document: the identity
// and the worker-owned `runtime.*` state, without the BFF's `config.*`. It is
// deliberately flat because the rules over it are pure functions (§14.2) and
// Mongo spelling belongs to the repository, not the rules.
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

// normalizePhone strips a JID suffix and surrounding space from a stored phone
// number, so the value compared against WhatsApp's own identity is always bare
// digits.
func normalizePhone(raw string) string {
	raw = strings.TrimSpace(raw)
	if i := strings.IndexAny(raw, "@:"); i >= 0 {
		raw = raw[:i]
	}
	return raw
}

// groupStoreAPI is every `groups` write and read the worker performs. It is an
// interface so the sync and the read model are provable without Mongo, and
// *groupStore satisfies it as-is.
type groupStoreAPI interface {
	FindOne(ctx context.Context, orgID, instanceID, groupJID string) *groupDoc
	UpsertObserved(ctx context.Context, orgID, instanceID, groupJID string, observed Observed, fromSync bool) error
	MarkLeft(ctx context.Context, orgID, instanceID, groupJID string, state GroupState) error
	KnownGroupJIDs(ctx context.Context, orgID, instanceID string) ([]string, error)
	CountLeft(ctx context.Context, orgID, instanceID string) (int, error)
	ListForInstance(ctx context.Context, orgID, instanceID string) ([]groupListRow, *string, error)
	loadObserved(ctx context.Context, orgID, instanceID string) (map[string]Observed, error)
}

// dayCounters is the §10 live-counter write: one `$inc` on a day's row, keyed by
// organization, instance, group and day. A receipt and a stored message are the
// same write under a different counter name, which is why this is one method
// rather than one per event.
type dayCounters interface {
	bump(ctx context.Context, orgID, instanceID, groupJID, counter string, count int64, at time.Time) error
}

// manager owns the worker's dependencies and the instance rows it reports. It
// holds no WhatsApp session, no auth device and no pairing material: WhatsApp is
// Hermes's, and every live call leaves through the bridge (hermes_bridge.go).
type manager struct {
	cfg    Config
	orgID  string
	secret string

	groups    groupStoreAPI
	instances instanceRepo
	stats     dayCounters
	audit     *auditStore
	ingest    *ingestQueue

	// external is the Hermes ingest path: the bridge in the Hermes container owns
	// WhatsApp now, and forwards every message it observes — including the ones the
	// agent ignores — to this worker, which owns the row shape and the bucket.
	external *externalIngest

	// bridge is the worker's WhatsApp connection: every live group read, group
	// write and outbound send goes through it (hermes_bridge.go). It is built once
	// at startup because it holds one HTTP client with the per-call deadline, and
	// it is nil only in a worker assembled without a bridge address.
	bridge *hermesBridge

	// loops is where the scheduled loops record their last pass, so the console
	// can show a cadence this worker owns rather than only its queues (§6.5).
	loops *loopRegistry

	// ping is the `/health` database reachability check (§6.5).
	ping func(ctx context.Context) error

	// newTicker is the periodic-loop seam: production returns a time.Ticker,
	// tests push ticks by hand so the group-sync scheduler is provable without
	// sleeping.
	newTicker func(time.Duration) (<-chan time.Time, func())
}

// newManager builds the manager. It starts nothing: the HTTP server and the
// scheduled loops are the caller's next steps, so a bridge this worker cannot
// call is still diagnosable over the control plane.
func newManager(cfg Config, groups groupStoreAPI, instances instanceRepo, ingest *ingestQueue) *manager {
	mgr := &manager{
		cfg:       cfg,
		orgID:     cfg.OrganizationID,
		secret:    cfg.WorkerSecret,
		groups:    groups,
		instances: instances,
		ingest:    ingest,
		loops:     newLoopRegistry(),
		newTicker: func(d time.Duration) (<-chan time.Time, func()) {
			ticker := time.NewTicker(d)
			return ticker.C, ticker.Stop
		},
	}
	bridge, err := newHermesBridge(cfg.HermesBridgeURL)
	switch {
	case err == nil:
		mgr.bridge = bridge
	case cfg.HermesBridgeURL != "":
		// loadConfig refuses a URL the worker cannot call, so this is a deployment
		// that got past validation with something unusable. Say so here: every group
		// route would otherwise answer "offline" with no clue why.
		logf("hermes bridge %q is unusable: %v", cfg.HermesBridgeURL, err)
	}
	return mgr
}

// api builds the control-plane handler with the manager's dependencies and the
// bridge every live group call goes through (§6.5).
func (m *manager) api() *api {
	return &api{
		store:      m.groups,
		bridge:     m.bridge,
		manager:    m,
		orgID:      m.orgID,
		secret:     m.secret,
		prune:      m.cfg.GroupSyncPrune,
		staleAfter: m.cfg.GroupStaleAfter,
		ping:       m.ping,
		queue:      m.ingest,
	}
}

// ---- API snapshots -------------------------------------------------------

// instanceSnapshot is the §6.5 JSON the BFF reads. It is the stored row: this
// worker has no live session to overlay, and pairing material belongs to the
// wizard that produces it, so `qr`, `pairingCode` and `pairingError` are only
// ever reported if a row (or a deployment's own writer) holds them.
type instanceSnapshot struct {
	ID           string     `json:"id"`
	Label        string     `json:"label"`
	Mode         string     `json:"mode"`
	Status       string     `json:"status"`
	PhoneNumber  string     `json:"phoneNumber,omitempty"`
	BotJID       string     `json:"botJid,omitempty"`
	BotLID       string     `json:"botLid,omitempty"`
	PairingError string     `json:"pairingError,omitempty"`
	ConnectedAt  *time.Time `json:"connectedAt,omitempty"`
	LastSeenAt   *time.Time `json:"lastSeenAt,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
}

type instanceListResponse struct {
	Instances []instanceSnapshot `json:"instances"`
}

// rowSnapshot projects a stored row into the wire snapshot.
func rowSnapshot(row InstanceRow) instanceSnapshot {
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
	return snap
}

// listInstances reports every non-deleted instance.
func (m *manager) listInstances(ctx context.Context) ([]instanceSnapshot, error) {
	rows, err := m.instances.List(ctx, m.orgID)
	if err != nil {
		return nil, err
	}
	out := make([]instanceSnapshot, 0, len(rows))
	for _, row := range rows {
		out = append(out, rowSnapshot(row))
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
	return rowSnapshot(*row), nil
}

// deleteInstance soft-deletes one instance row (§6.5).
//
// It used to be the path that invalidated a linked device — log out, delete the
// stored credential. There is no credential here any more: the device belongs to
// the Hermes session, and refusing to forget the row until that session is gone
// would be claiming an authority this worker no longer has. What remains is what
// this worker actually owns: the row stops being listed, and the audit trail
// records who removed it.
func (m *manager) deleteInstance(ctx context.Context, id string) error {
	row, err := m.instances.Get(ctx, m.orgID, id)
	if err != nil {
		return err
	}
	if row == nil {
		return errInstanceNotFound
	}
	if err := m.instances.SoftDelete(ctx, m.orgID, id); err != nil {
		return err
	}
	if m.audit != nil {
		meta := bson.M{"deletedAt": now().UTC()}
		if err := m.audit.append(ctx, m.orgID, "instance.deleted", "instance", id, meta); err != nil {
			// The row is already gone from every read; a failed audit write is
			// reported, not turned into a failed DELETE the owner would retry.
			logf("instance %s: audit delete: %v", id, err)
		}
	}
	return nil
}

// ---- Mongo repositories --------------------------------------------------

// instanceRepo is the worker's write surface over `instances.runtime.*`. The
// BFF owns `config.*` and the document root timestamps; every write here touches
// only the worker-owned subdocument (§5.2, one writer per subdocument).
//
// There is no `Create` and no `SetConnected` any more: an `instances` row is
// created by whoever runs the pairing wizard, and the identity fields
// (`phoneNumber`, `botJid`, `botLid`, `connectedAt`) are facts only the process
// holding the WhatsApp session can observe. The worker keeps the reads and the
// status/summary writes it owns.
type instanceRepo interface {
	Get(ctx context.Context, orgID, id string) (*InstanceRow, error)
	List(ctx context.Context, orgID string) ([]InstanceRow, error)
	SetStatus(ctx context.Context, orgID, id string, status sessionState, pairingError string) error
	BumpCounters(ctx context.Context, orgID, id string, counters map[string]int64) error
	SetGroupSync(ctx context.Context, orgID, id string, sync groupSyncState) error
	SetGroupSyncError(ctx context.Context, orgID, id, message string) error
	SoftDelete(ctx context.Context, orgID, id string) error
}

// groupSyncState is the worker-owned §5.1 `instances.runtime.groupSync` summary
// the dashboard reads: how many groups the last full sync observed, how many are
// currently known to be gone, and when it ran. It is the one place a sync's
// membership number is reported, so the console's "Observed" count and the
// instance list can never disagree with what was actually seen.
type groupSyncState struct {
	GroupsObserved int
	GroupsLeft     int
	LastSyncAt     time.Time
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

// BumpCounters adds to an instance's live counters (§5.1). It is the only writer
// of `runtime.counters`: the fields are summed by `$inc`, so two events landing at
// once add up instead of overwriting each other, and a removed instance is not
// counted at all.
func (r *instanceMongo) BumpCounters(ctx context.Context, orgID, id string, counters map[string]int64) error {
	if len(counters) == 0 {
		return nil
	}
	increments := bson.D{}
	for name, count := range counters {
		increments = append(increments, bson.E{Key: "runtime.counters." + name, Value: count})
	}
	if _, err := r.coll.UpdateOne(ctx, liveInstanceFilter(orgID, id), bson.D{{Key: "$inc", Value: increments}}); err != nil {
		return fmt.Errorf("bump instance counters %s: %w", id, err)
	}
	return nil
}

// SetGroupSync writes the §5.1 `runtime.groupSync` summary a successful full
// sync observed: the membership it held, how many groups are currently known to
// be gone, and when it ran. `lastError` is cleared, because this write only
// happens after a snapshot arrived. Same one-writer rule as BumpCounters: a
// removed instance is not written at all.
func (r *instanceMongo) SetGroupSync(ctx context.Context, orgID, id string, sync groupSyncState) error {
	_, err := r.coll.UpdateOne(ctx, liveInstanceFilter(orgID, id), bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "runtime.groupSync.groupsObserved", Value: sync.GroupsObserved},
			{Key: "runtime.groupSync.groupsLeft", Value: sync.GroupsLeft},
			{Key: "runtime.groupSync.lastSyncAt", Value: sync.LastSyncAt},
			{Key: "runtime.groupSync.lastError", Value: nil},
		}},
	})
	if err != nil {
		return fmt.Errorf("set instance group sync %s: %w", id, err)
	}
	return nil
}

// SetGroupSyncError records a refused sync and nothing else. The last observed
// total, the left count and the stamp all stand: a call that failed says nothing
// about membership, and overwriting them would report "we left every group" on
// the dashboard because an IQ timed out (§6.6.5 rule 4).
func (r *instanceMongo) SetGroupSyncError(ctx context.Context, orgID, id, message string) error {
	_, err := r.coll.UpdateOne(ctx, liveInstanceFilter(orgID, id), bson.D{
		{Key: "$set", Value: bson.D{{Key: "runtime.groupSync.lastError", Value: message}}},
	})
	if err != nil {
		return fmt.Errorf("set instance group sync error %s: %w", id, err)
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

// bump adds to one counter on the instance/group/day row. A receipt is live-only —
// evidence of delivery, not a message — so it has its own counter rather than
// inflating `messages`, and every other §10 counter arrives here the same way.
func (s *statsStore) bump(ctx context.Context, orgID, instanceID, groupJID, counter string, count int64, at time.Time) error {
	day := at.UTC().Format("2006-01-02")
	_, err := s.coll.UpdateOne(ctx,
		bson.D{
			{Key: "organizationId", Value: orgID},
			{Key: "day", Value: day},
			{Key: "instanceId", Value: instanceID},
			{Key: "groupJid", Value: groupJID},
		},
		bson.D{
			{Key: "$inc", Value: bson.D{{Key: "counters." + counter, Value: count}}},
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
