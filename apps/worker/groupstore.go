package main

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// groupConfig is the BFF-owned half of a `groups` document (§5.1). The worker
// reads it back only to prove it never wrote it (TDD slice T8), and the field
// list is here so a drift in the config shape is a compile-time fact instead of
// a silent loss in a round-trip test.
type groupConfig struct {
	Assigned      bool     `bson:"assigned"`
	Whitelisted   bool     `bson:"whitelisted"`
	ConfigVersion int64    `bson:"configVersion"`
	Active        bool     `bson:"active"`
	Notes         string   `bson:"notes"`
	Tags          []string `bson:"tags"`
}

// groupDoc is a whole `groups` document as read back: the identity triple, the
// worker-owned observation and the BFF-owned config.
type groupDoc struct {
	OrganizationID string      `bson:"organizationId"`
	InstanceID     string      `bson:"instanceId"`
	GroupJID       string      `bson:"groupJid"`
	Observed       Observed    `bson:"observed"`
	Config         groupConfig `bson:"config"`
	CreatedAt      time.Time   `bson:"createdAt"`
	UpdatedAt      time.Time   `bson:"updatedAt"`
}

// now is the clock seam (docs/architecture-draft.md §14.2): every observation
// timestamp the group path writes is produced here, so tests are deterministic
// without touching the system clock.
var now = time.Now

// GroupState is `observed.state` — the membership lifecycle WhatsApp reports
// (§5.1). A group that disappears from a sync snapshot becomes `left`, it is
// never deleted: the name it had is still useful history.
type GroupState string

const (
	GroupActive    GroupState = "active"
	GroupLeft      GroupState = "left"
	GroupDeleted   GroupState = "deleted"
	GroupSuspended GroupState = "suspended"
)

// SubjectSource is `observed.subjectSource`: which path produced the current
// name. It is what makes a rename auditable, and it is also the BFF's own
// vocabulary (`packages/shared/src/worker-contract.ts`), so the whole set is
// kept: `event` is what the worker used to write when a rename arrived on the
// WhatsApp event loop, and nothing produces it now that the session is gone.
type SubjectSource string

const (
	SubjectFromSync     SubjectSource = "sync"
	SubjectFromEvent    SubjectSource = "event"
	SubjectFromFallback SubjectSource = "fallback"
)

// SyncSource is `observed.lastSyncSource`: the trigger that last refreshed the
// snapshot-owned fields (§6.6.2). `connect` and `event` are part of the same
// shared vocabulary; the worker's remaining triggers are the timer and the
// operator's manual sync, both of which read the Hermes bridge.
type SyncSource string

const (
	SyncOnConnect SyncSource = "connect"
	SyncOnTimer   SyncSource = "timer"
	SyncOnManual  SyncSource = "manual"
	SyncOnEvent   SyncSource = "event"
	SyncOnMessage SyncSource = "message"
)

// subjectHistoryMax caps the rename ring (§5.1). The history is newest-first;
// the oldest entry falls off rather than growing the document without bound.
const subjectHistoryMax = 20

// SubjectHistoryEntry is one superseded name: what it was, the stamp the worker
// observed it under, and who set it. The tags are the §5.1 ring spelling.
type SubjectHistoryEntry struct {
	Name string    `bson:"name"`
	At   time.Time `bson:"at"`
	By   string    `bson:"by"`
}

// GroupMember is one stored membership entry. Nothing writes it any more: the
// bridge's snapshot carries a member *count*, not a member list, so the field
// stays part of the stored document's vocabulary (and is decoded and re-encoded
// unchanged) rather than being dropped from a row that still holds it.
type GroupMember struct {
	JID          string `bson:"jid"`
	PhoneJID     string `bson:"phoneJid"`
	LID          string `bson:"lid"`
	IsAdmin      bool   `bson:"isAdmin"`
	IsSuperAdmin bool   `bson:"isSuperAdmin"`
	DisplayName  string `bson:"displayName"`
}

// Observed is the worker-owned half of a `groups` document (§5.1) in Go form.
// The BFF's `config.*` is deliberately absent: the worker never writes it. The
// bson tags are the decode spelling of §5.1; the write path spells the same keys
// as dotted `$set` entries in groupstore.go, where the ingest-owned counters are
// filtered out.
type Observed struct {
	Subject               string                `bson:"subject"`
	SubjectSearch         string                `bson:"subjectSearch"`
	SubjectUpdatedAt      time.Time             `bson:"subjectUpdatedAt"`
	SubjectObservedAt     time.Time             `bson:"subjectObservedAt"`
	SubjectSetBy          string                `bson:"subjectSetBy"`
	SubjectSetByLID       string                `bson:"subjectSetByLid"`
	SubjectSource         SubjectSource         `bson:"subjectSource"`
	SubjectHistory        []SubjectHistoryEntry `bson:"subjectHistory"`
	Topic                 string                `bson:"topic"`
	TopicUpdatedAt        time.Time             `bson:"topicUpdatedAt"`
	IsAnnounce            bool                  `bson:"isAnnounce"`
	IsLocked              bool                  `bson:"isLocked"`
	IsEphemeral           bool                  `bson:"isEphemeral"`
	IsDefaultSubGroup     bool                  `bson:"isDefaultSubGroup"`
	ParticipantCount      int                   `bson:"participantCount"`
	ParticipantCountDirty bool                  `bson:"participantCountDirty"`
	Members               []GroupMember         `bson:"members"`
	GroupCreatedAt        time.Time             `bson:"groupCreatedAt"`
	State                 GroupState            `bson:"state"`
	LastActivityAt        time.Time             `bson:"lastActivityAt"`
	MessageCount          int                   `bson:"messageCount"`
	MediaStored           int                   `bson:"mediaStored"`
	LastSyncedAt          time.Time             `bson:"lastSyncedAt"`
	LastSyncSource        SyncSource            `bson:"lastSyncSource"`
	LeftDetectedAt        time.Time             `bson:"leftDetectedAt"`
}

// groupSnapshot is one group as the Hermes bridge reported it: the identity, the
// name, the two switches and the member count — everything a caller can learn
// about a group without holding a WhatsApp session.
//
// It is deliberately not the bridge's own wire struct: translating the transport
// shape (hermes_bridge.go) into the worker's own vocabulary is what keeps the
// merge rules below written against a group, not against a JSON payload.
type groupSnapshot struct {
	JID              string
	Subject          string
	Announce         bool
	Locked           bool
	ParticipantCount int
}

// groupStore owns the `observed.*` half of the `groups` collection. Every write
// it makes is a dotted `$set` of the fields this path owns, an upsert keyed on
// the unique identity triple, so a redelivery or a racing read costs one
// idempotent update instead of a duplicate row (§6.6).
type groupStore struct {
	coll *mongo.Collection
}

func newGroupStore(db *mongo.Database) *groupStore {
	return &groupStore{coll: db.Collection(collGroups)}
}

func (s *groupStore) collection() *mongo.Collection { return s.coll }

// groupIdentity is the unique index key, in one place: the store, the sync and
// the read model all address a group by exactly this triple (§5.1).
func groupIdentity(orgID, instanceID, groupJID string) bson.D {
	return bson.D{
		{Key: "organizationId", Value: orgID},
		{Key: "instanceId", Value: instanceID},
		{Key: "groupJid", Value: groupJID},
	}
}

// counterFields are the `observed` fields the ingest path owns: they count
// traffic as it happens. A group write must never carry a stale read of them
// back over a concurrent increment, so they are excluded from every `$set` here
// even though decode read them (§5.2, one writer per field).
var counterFields = map[string]bool{
	"lastActivityAt": true,
	"messageCount":   true,
	"mediaStored":    true,
}

// observedFields is the `$set` payload for one group observation: the §5.1
// spelling, dotted under `observed`, and nothing else. `config.*` is absent by
// construction — that is the one-writer rule slice T8 defends — and so are the
// ingest-owned counters above.
//
// `fromSync` decides whether the snapshot stamp moves: a metadata delta must not
// claim the group was just synced, or the staleness/repair threshold computed
// from `lastSyncedAt` would never fire again.
func observedFields(o Observed, fromSync bool) bson.D {
	// A nil slice marshals to BSON null, and the read model expects the
	// documented ring: a group with no renames yet must have an empty array, not
	// a null the BFF would have to special-case (and cannot fix — it never writes
	// observed.*).
	history := o.SubjectHistory
	if history == nil {
		history = []SubjectHistoryEntry{}
	}
	fields := bson.D{
		{Key: "observed.subject", Value: o.Subject},
		{Key: "observed.subjectSearch", Value: o.SubjectSearch},
		{Key: "observed.subjectUpdatedAt", Value: o.SubjectUpdatedAt},
		{Key: "observed.subjectObservedAt", Value: o.SubjectObservedAt},
		{Key: "observed.subjectSetBy", Value: o.SubjectSetBy},
		{Key: "observed.subjectSetByLid", Value: o.SubjectSetByLID},
		{Key: "observed.subjectSource", Value: o.SubjectSource},
		{Key: "observed.subjectHistory", Value: history},
		{Key: "observed.topic", Value: o.Topic},
		{Key: "observed.topicUpdatedAt", Value: o.TopicUpdatedAt},
		{Key: "observed.isAnnounce", Value: o.IsAnnounce},
		{Key: "observed.isLocked", Value: o.IsLocked},
		{Key: "observed.isEphemeral", Value: o.IsEphemeral},
		{Key: "observed.isDefaultSubGroup", Value: o.IsDefaultSubGroup},
		{Key: "observed.participantCount", Value: o.ParticipantCount},
		{Key: "observed.participantCountDirty", Value: o.ParticipantCountDirty},
		{Key: "observed.members", Value: o.Members},
		{Key: "observed.groupCreatedAt", Value: o.GroupCreatedAt},
		{Key: "observed.state", Value: o.State},
		{Key: "observed.leftDetectedAt", Value: o.LeftDetectedAt},
	}
	if fromSync {
		fields = append(fields,
			bson.E{Key: "observed.lastSyncedAt", Value: o.LastSyncedAt},
			bson.E{Key: "observed.lastSyncSource", Value: o.LastSyncSource},
		)
	}
	return fields
}

// observedFromSnapshot turns one bridge snapshot entry — a `GET /groups` row, or
// a single `GET /group/:jid` repair — into the observation it stands for
// (§6.6.1).
//
// Only the fields the bridge's contract actually carries are filled. Topic,
// renamer, creation time and the membership list have no source there, so they
// stay empty here and the merge below leaves the stored values alone rather than
// erasing what a richer reader once recorded.
//
// The name is stamped with the moment it was observed: WhatsApp's own `s_t` for
// a rename does not survive the bridge's contract, and the honest value for "when
// this name was set" is then the moment the worker learnt it (§6.6.4).
func observedFromSnapshot(snap groupSnapshot, source SyncSource, at time.Time) Observed {
	subjectSource := SubjectFromSync
	if snap.Subject == "" {
		// A snapshot without a subject tells us nothing about the name; the
		// empty value is labelled a fallback rather than passed off as synced.
		subjectSource = SubjectFromFallback
	}
	return Observed{
		Subject: snap.Subject, SubjectSearch: foldText(snap.Subject),
		SubjectUpdatedAt: at, SubjectObservedAt: at, SubjectSource: subjectSource,
		IsAnnounce: snap.Announce, IsLocked: snap.Locked,
		ParticipantCount: snap.ParticipantCount,
		// A group a live read returned is one the account is in, so the
		// snapshot is the state: `suspended` and `deleted` have no representation
		// in the bridge's contract and stay as stored.
		State:        GroupActive,
		LastSyncedAt: at, LastSyncSource: source,
	}
}

// UpsertObserved writes one observation. The filter is the unique index key and
// the insert branch seeds the org/instance/JID triple, the root timestamps and
// the BFF's default config; the update branch touches `observed.*` only. That is
// what makes the worker's writes and the BFF's writes commute: `config.*` and the
// document root belong to the BFF, and a worker observation — including the
// every-30-minutes sync — must never rewrite what the dashboard reads as "last
// changed" (§6.6, TDD slice T8).
func (s *groupStore) UpsertObserved(ctx context.Context, orgID, instanceID, groupJID string, observed Observed, fromSync bool) error {
	at := now().UTC()
	update := bson.D{
		{Key: "$set", Value: observedFields(observed, fromSync)},
		{Key: "$setOnInsert", Value: bson.D{
			{Key: "organizationId", Value: orgID},
			{Key: "instanceId", Value: instanceID},
			{Key: "groupJid", Value: groupJID},
			{Key: "config", Value: groupConfig{Active: true, Tags: []string{}}},
			{Key: "createdAt", Value: at},
			{Key: "updatedAt", Value: at},
		}},
	}
	if _, err := s.coll.UpdateOne(ctx, groupIdentity(orgID, instanceID, groupJID), update, options.UpdateOne().SetUpsert(true)); err != nil {
		return fmt.Errorf("upsert group %s: %w", groupJID, err)
	}
	return nil
}

// Touch records traffic for a group the ingest path has just seen. A group that
// carried a message exists even before any sync lists it, so a missing document
// is inserted as a fallback observation; an existing one only has its
// ingest-owned counters moved. `observed.*` metadata and the BFF's `config.*`
// are left exactly as they were (§6.2, §5.2).
func (s *groupStore) Touch(ctx context.Context, orgID, instanceID, groupJID string, at time.Time) error {
	if at.IsZero() {
		at = now().UTC()
	}
	_, err := s.coll.UpdateOne(ctx, groupIdentity(orgID, instanceID, groupJID), bson.D{
		{Key: "$setOnInsert", Value: bson.D{
			{Key: "organizationId", Value: orgID},
			{Key: "instanceId", Value: instanceID},
			{Key: "groupJid", Value: groupJID},
			{Key: "config", Value: groupConfig{Active: true, Tags: []string{}}},
			{Key: "observed.state", Value: GroupActive},
			{Key: "observed.subjectSource", Value: SubjectFromFallback},
			{Key: "observed.subjectHistory", Value: []SubjectHistoryEntry{}},
			{Key: "createdAt", Value: at},
			{Key: "updatedAt", Value: at},
		}},
		{Key: "$set", Value: bson.D{{Key: "observed.lastActivityAt", Value: at}}},
		{Key: "$inc", Value: bson.D{{Key: "observed.messageCount", Value: 1}}},
	}, options.UpdateOne().SetUpsert(true))
	if err != nil {
		return fmt.Errorf("touch group %s: %w", groupJID, err)
	}
	return nil
}

// MarkLeft records that this instance no longer sees a group: absence from a
// snapshot (§6.6.5 rule 2) or a repair that answered not-found. The retained
// subject is deliberately left alone — the name a group had is still useful
// history, and losing it would make the dashboard forget the group entirely —
// and so is the document root, which belongs to the BFF.
func (s *groupStore) MarkLeft(ctx context.Context, orgID, instanceID, groupJID string, state GroupState) error {
	at := now().UTC()
	_, err := s.coll.UpdateOne(ctx, groupIdentity(orgID, instanceID, groupJID), bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "observed.state", Value: state},
			{Key: "observed.leftDetectedAt", Value: at},
		}},
	})
	if err != nil {
		return fmt.Errorf("mark group %s %s: %w", groupJID, state, err)
	}
	return nil
}

// KnownGroupJIDs is the membership baseline a full sync reconciles absence
// against: the groups this instance is still believed to be in. Groups already
// known to be gone are excluded, so their state is not re-derived on every sync
// and a `deleted` group is never downgraded to a vaguer `left`.
func (s *groupStore) KnownGroupJIDs(ctx context.Context, orgID, instanceID string) ([]string, error) {
	known, err := s.loadObserved(ctx, orgID, instanceID)
	if err != nil {
		return nil, err
	}
	jids := make([]string, 0, len(known))
	for jid, observed := range known {
		if observed.State == GroupLeft || observed.State == GroupDeleted {
			continue
		}
		jids = append(jids, jid)
	}
	return jids, nil
}

// CountLeft is how many groups this instance is currently known to have left or
// lost. It is the gauge §5.1 keeps next to `groupsObserved`, so a dashboard can
// say "12 observed, 1 left" without re-deriving the second number from the list
// it renders.
func (s *groupStore) CountLeft(ctx context.Context, orgID, instanceID string) (int, error) {
	count, err := s.coll.CountDocuments(ctx, bson.D{
		{Key: "organizationId", Value: orgID},
		{Key: "instanceId", Value: instanceID},
		{Key: "observed.state", Value: bson.D{{Key: "$in", Value: bson.A{GroupLeft, GroupDeleted}}}},
	})
	if err != nil {
		return 0, fmt.Errorf("count left groups for %s/%s: %w", orgID, instanceID, err)
	}
	return int(count), nil
}

// loadObserved reads every stored observation for one instance in a single
// query: a sync merges each returned group against this baseline, and doing it
// per group would turn one snapshot into N round trips.
func (s *groupStore) loadObserved(ctx context.Context, orgID, instanceID string) (map[string]Observed, error) {
	cursor, err := s.coll.Find(ctx, bson.D{
		{Key: "organizationId", Value: orgID},
		{Key: "instanceId", Value: instanceID},
	}, options.Find().SetProjection(bson.D{{Key: "groupJid", Value: 1}, {Key: "observed", Value: 1}}))
	if err != nil {
		return nil, fmt.Errorf("find groups for %s/%s: %w", orgID, instanceID, err)
	}
	defer func() { _ = cursor.Close(ctx) }()

	stored := make(map[string]Observed)
	for cursor.Next(ctx) {
		var doc struct {
			GroupJID string   `bson:"groupJid"`
			Observed Observed `bson:"observed"`
		}
		if err := cursor.Decode(&doc); err != nil {
			return nil, fmt.Errorf("decode group %s: %w", doc.GroupJID, err)
		}
		stored[doc.GroupJID] = doc.Observed
	}
	if err := cursor.Err(); err != nil {
		return nil, fmt.Errorf("iterate groups for %s/%s: %w", orgID, instanceID, err)
	}
	return stored, nil
}

// FindOne reads a single group document for diagnostics and tests. It returns
// nil when the group is unknown — a missing row is a fact, not an error.
func (s *groupStore) FindOne(ctx context.Context, orgID, instanceID, groupJID string) *groupDoc {
	var doc groupDoc
	if err := s.coll.FindOne(ctx, groupIdentity(orgID, instanceID, groupJID)).Decode(&doc); err != nil {
		return nil
	}
	return &doc
}

// ListForInstance is the R11 read model: every group this instance has observed,
// with its ID and current name. Assigned groups come first, then the most
// recently active — the order the dashboard list renders and the order the
// canonical index serves (§5.1). The returned stamp is the newest sync any row
// has seen, which is what the dashboard shows as "last synced".
func (s *groupStore) ListForInstance(ctx context.Context, orgID, instanceID string) ([]groupListRow, *string, error) {
	cursor, err := s.coll.Find(ctx, bson.D{
		{Key: "organizationId", Value: orgID},
		{Key: "instanceId", Value: instanceID},
	}, options.Find().SetSort(bson.D{
		{Key: "config.assigned", Value: -1},
		{Key: "observed.lastActivityAt", Value: -1},
	}))
	if err != nil {
		return nil, nil, fmt.Errorf("list groups for %s/%s: %w", orgID, instanceID, err)
	}
	defer func() { _ = cursor.Close(ctx) }()

	rows := make([]groupListRow, 0, 8)
	var newest time.Time
	var syncedAt *string
	for cursor.Next(ctx) {
		var doc groupDoc
		if err := cursor.Decode(&doc); err != nil {
			return nil, nil, fmt.Errorf("decode group row: %w", err)
		}
		if last := doc.Observed.LastSyncedAt; last.After(newest) {
			newest = last
			stamp := last.UTC().Format(time.RFC3339)
			syncedAt = &stamp
		}
		rows = append(rows, rowFromDoc(&doc))
	}
	if err := cursor.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate groups for %s/%s: %w", orgID, instanceID, err)
	}
	return rows, syncedAt, nil
}

// rowFromDoc projects a stored document into the wire row. It is the one place
// that decides what the dashboard sees, so an unknown name is always labelled
// rather than served as an empty string with no explanation (§6.6.6).
func rowFromDoc(doc *groupDoc) groupListRow {
	row := groupListRow{
		GroupJID:         doc.GroupJID,
		Name:             doc.Observed.Subject,
		NameSource:       nameSource(doc.Observed),
		NameSetBy:        doc.Observed.SubjectSetBy,
		ParticipantCount: doc.Observed.ParticipantCount,
		IsAnnounce:       doc.Observed.IsAnnounce,
		IsLocked:         doc.Observed.IsLocked,
		State:            string(doc.Observed.State),
		MessageCount:     doc.Observed.MessageCount,
		Assigned:         doc.Config.Assigned,
		Whitelisted:      doc.Config.Whitelisted,
	}
	if !doc.Observed.SubjectUpdatedAt.IsZero() {
		stamp := doc.Observed.SubjectUpdatedAt.UTC().Format(time.RFC3339)
		row.NameSetAt = &stamp
	}
	if !doc.Observed.LastActivityAt.IsZero() {
		stamp := doc.Observed.LastActivityAt.UTC().Format(time.RFC3339)
		row.LastActivityAt = &stamp
	}
	return row
}

// nameSource reports where the row's name came from. A missing name is reported
// as a fallback even if no source was ever recorded: the dashboard must be able
// to say "we do not know this group's name yet" instead of showing a blank.
func nameSource(o Observed) string {
	if o.Subject == "" || o.SubjectSource == "" {
		return string(SubjectFromFallback)
	}
	return string(o.SubjectSource)
}

// appendSubjectHistory pushes an entry onto the newest-first rename ring and
// caps it, so a group renamed every day does not grow its document forever.
func appendSubjectHistory(history []SubjectHistoryEntry, entry SubjectHistoryEntry) []SubjectHistoryEntry {
	if len(history) > 0 && history[0].Name == entry.Name && history[0].At.Equal(entry.At) {
		return history
	}
	grown := make([]SubjectHistoryEntry, 0, len(history)+1)
	grown = append(grown, entry)
	grown = append(grown, history...)
	if len(grown) > subjectHistoryMax {
		grown = grown[:subjectHistoryMax]
	}
	return grown
}
