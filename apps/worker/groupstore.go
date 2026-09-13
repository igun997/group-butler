package main

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"go.mau.fi/whatsmeow/types"
)

// groupConfig is the BFF-owned half of a `groups` document (§5.1). The worker
// reads it back only to prove it never wrote it (TDD slice T8), and the field
// list is here so a drift in the config shape is a compile-time fact instead of
// a silent loss in a round-trip test.
type groupConfig struct {
	Assigned    bool     `bson:"assigned"`
	Whitelisted bool     `bson:"whitelisted"`
	Active      bool     `bson:"active"`
	Notes       string   `bson:"notes"`
	Tags        []string `bson:"tags"`
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

// groupStore owns the `observed.*` half of the `groups` collection. Every write
// it makes is a dotted `$set` of the fields this path owns, an upsert keyed on
// the unique identity triple, so a redelivery or a racing event costs one
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
	fields := bson.D{
		{Key: "observed.subject", Value: o.Subject},
		{Key: "observed.subjectSearch", Value: o.SubjectSearch},
		{Key: "observed.subjectUpdatedAt", Value: o.SubjectUpdatedAt},
		{Key: "observed.subjectObservedAt", Value: o.SubjectObservedAt},
		{Key: "observed.subjectSetBy", Value: o.SubjectSetBy},
		{Key: "observed.subjectSetByLid", Value: o.SubjectSetByLID},
		{Key: "observed.subjectSource", Value: o.SubjectSource},
		{Key: "observed.subjectHistory", Value: o.SubjectHistory},
		{Key: "observed.topic", Value: o.Topic},
		{Key: "observed.topicUpdatedAt", Value: o.TopicUpdatedAt},
		{Key: "observed.isAnnounce", Value: o.IsAnnounce},
		{Key: "observed.isLocked", Value: o.IsLocked},
		{Key: "observed.isEphemeral", Value: o.IsEphemeral},
		{Key: "observed.isDefaultSubGroup", Value: o.IsDefaultSubGroup},
		{Key: "observed.participantCount", Value: o.ParticipantCount},
		{Key: "observed.participantCountDirty", Value: o.ParticipantCountDirty},
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

// ObservedFromGroupInfo turns one snapshot entry — a `GetJoinedGroups` row or a
// single `GetGroupInfo` repair — into the observation it stands for (§6.6.1).
// The name is authoritative here, so it is stamped from the snapshot's own
// `s_t`/`s_o`, not from the clock.
func ObservedFromGroupInfo(info *types.GroupInfo, source SyncSource, at time.Time) Observed {
	pn, lid := subjectProvenance(&info.GroupName)
	subjectSource := SubjectFromSync
	if info.Name == "" {
		// A snapshot without a subject tells us nothing about the name; the
		// empty value is labelled a fallback rather than passed off as synced.
		subjectSource = SubjectFromFallback
	}
	state := GroupActive
	if info.Suspended {
		state = GroupSuspended
	}
	return Observed{
		Subject:           info.Name,
		SubjectSearch:     foldText(info.Name),
		SubjectUpdatedAt:  info.NameSetAt,
		SubjectObservedAt: at,
		SubjectSetBy:      pn,
		SubjectSetByLID:   lid,
		SubjectSource:     subjectSource,
		Topic:             info.Topic,
		TopicUpdatedAt:    info.TopicSetAt,
		IsAnnounce:        info.IsAnnounce,
		IsLocked:          info.IsLocked,
		IsEphemeral:       info.IsEphemeral,
		IsDefaultSubGroup: info.IsDefaultSubGroup,
		ParticipantCount:  info.ParticipantCount,
		GroupCreatedAt:    info.GroupCreated,
		State:             state,
		LastSyncedAt:      at,
		LastSyncSource:    source,
	}
}

// UpsertFromSync persists one snapshot entry under the identity triple,
// preserving whatever the BFF has configured for that group.
func (s *groupStore) UpsertFromSync(ctx context.Context, orgID, instanceID string, info *types.GroupInfo, source SyncSource) error {
	at := now().UTC()
	return s.UpsertObserved(ctx, orgID, instanceID, info.JID.String(), ObservedFromGroupInfo(info, source, at), true)
}

// UpsertObserved writes one observation. The filter is the unique index key and
// the insert branch seeds the org/instance/JID triple plus the BFF's default
// config; the update branch never touches `config.*`, which is what makes the
// worker's writes and the BFF's writes commute (§6.6, TDD slice T8).
func (s *groupStore) UpsertObserved(ctx context.Context, orgID, instanceID, groupJID string, observed Observed, fromSync bool) error {
	at := now().UTC()
	update := bson.D{
		{Key: "$set", Value: append(observedFields(observed, fromSync), bson.E{Key: "updatedAt", Value: at})},
		{Key: "$setOnInsert", Value: bson.D{
			{Key: "organizationId", Value: orgID},
			{Key: "instanceId", Value: instanceID},
			{Key: "groupJid", Value: groupJID},
			{Key: "config", Value: groupConfig{Active: true, Tags: []string{}}},
			{Key: "createdAt", Value: at},
		}},
	}
	if _, err := s.coll.UpdateOne(ctx, groupIdentity(orgID, instanceID, groupJID), update, options.UpdateOne().SetUpsert(true)); err != nil {
		return fmt.Errorf("upsert group %s: %w", groupJID, err)
	}
	return nil
}

// MarkLeft records that this instance no longer sees a group: absence from a
// snapshot (§6.6.5 rule 2) or a repair that answered not-found. The retained
// subject is deliberately left alone — the name a group had is still useful
// history, and losing it would make the dashboard forget the group entirely.
func (s *groupStore) MarkLeft(ctx context.Context, orgID, instanceID, groupJID string, state GroupState) error {
	at := now().UTC()
	_, err := s.coll.UpdateOne(ctx, groupIdentity(orgID, instanceID, groupJID), bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "observed.state", Value: state},
			{Key: "observed.leftDetectedAt", Value: at},
			{Key: "updatedAt", Value: at},
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
