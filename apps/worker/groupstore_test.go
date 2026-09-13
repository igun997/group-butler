package main

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/types"
)

// newTestGroupStore hands each test a `groups` collection with the canonical
// unique index and nothing in it, against the real replica set: the one-writer
// rule is a claim about what MongoDB ends up holding, so it is asserted there
// and not against a fake (§14.2).
func newTestGroupStore(t *testing.T) (*groupStore, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	t.Cleanup(cancel)
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	t.Cleanup(func() { _ = client.Disconnect(context.Background()) })
	if err := db.Collection(collGroups).Drop(ctx); err != nil {
		t.Fatalf("drop groups: %v", err)
	}
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensureIngestIndexes: %v", err)
	}
	return newGroupStore(db), ctx
}

func groupInfo(id, name string, participants int) *types.GroupInfo {
	return &types.GroupInfo{
		JID:              types.NewJID(id, types.GroupServer),
		GroupName:        types.GroupName{Name: name, NameSetAt: time.Unix(1757750000, 0)},
		ParticipantCount: participants,
	}
}

func TestUpsertGroupFromSync_PreservesConfig(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	info := groupInfo("120363043123456789", "Ops Team", 12)
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", info, SyncOnConnect); err != nil {
		t.Fatalf("UpsertFromSync: %v", err)
	}
	// The BFF owns config.*: simulate an owner assigning and whitelisting it.
	if _, err := store.collection().UpdateOne(ctx,
		map[string]any{"instanceId": "inst_1", "groupJid": info.JID.String()},
		map[string]any{"$set": map[string]any{"config.assigned": true, "config.whitelisted": true, "config.notes": "keep me"}},
	); err != nil {
		t.Fatalf("seed config: %v", err)
	}

	info.ParticipantCount = 14
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", info, SyncOnTimer); err != nil {
		t.Fatalf("second UpsertFromSync: %v", err)
	}

	doc := store.FindOne(ctx, "org_default", "inst_1", info.JID.String())
	if doc == nil {
		t.Fatal("group missing after upsert")
	}
	want := groupConfig{Assigned: true, Whitelisted: true, Active: true, Notes: "keep me", Tags: []string{}}
	if !reflect.DeepEqual(doc.Config, want) {
		t.Fatalf("config = %+v, want %+v (the worker must never write config.*)", doc.Config, want)
	}
	if doc.Observed.ParticipantCount != 14 {
		t.Errorf("observed.participantCount = %d, want 14", doc.Observed.ParticipantCount)
	}
	if doc.Observed.Subject != "Ops Team" || doc.Observed.SubjectSearch != "ops team" {
		t.Errorf("subject = %q/%q, want Ops Team/ops team", doc.Observed.Subject, doc.Observed.SubjectSearch)
	}
	if doc.Observed.SubjectSource != SubjectFromSync || doc.Observed.LastSyncSource != SyncOnTimer {
		t.Errorf("provenance = %q/%q, want sync/timer", doc.Observed.SubjectSource, doc.Observed.LastSyncSource)
	}
}

func TestUpsertGroupFromSync_SeedsDefaultsOnInsert(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	info := groupInfo("120363043123456789", "Ops Team", 12)
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", info, SyncOnConnect); err != nil {
		t.Fatalf("UpsertFromSync: %v", err)
	}
	doc := store.FindOne(ctx, "org_default", "inst_1", info.JID.String())
	if doc == nil {
		t.Fatal("group missing after upsert")
	}
	if doc.OrganizationID != "org_default" || doc.InstanceID != "inst_1" || doc.GroupJID != info.JID.String() {
		t.Errorf("identity = %q/%q/%q, want the org/instance/JID triple", doc.OrganizationID, doc.InstanceID, doc.GroupJID)
	}
	if doc.Observed.State != GroupActive {
		t.Errorf("state = %q, want active", doc.Observed.State)
	}
	want := groupConfig{Active: true, Tags: []string{}}
	if !reflect.DeepEqual(doc.Config, want) {
		t.Errorf("config = %+v, want the BFF defaults %+v", doc.Config, want)
	}
	if doc.CreatedAt.IsZero() || doc.UpdatedAt.IsZero() {
		t.Error("createdAt/updatedAt must be stamped on insert")
	}
}

func TestUpsertGroupFromSync_IsIdempotent(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	info := groupInfo("120363043123456789", "Ops Team", 12)
	for i := 0; i < 3; i++ {
		if err := store.UpsertFromSync(ctx, "org_default", "inst_1", info, SyncOnTimer); err != nil {
			t.Fatalf("UpsertFromSync #%d: %v", i, err)
		}
	}
	count, err := store.collection().CountDocuments(ctx, map[string]any{})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("group count = %d, want 1", count)
	}
}

// The activity counters inside `observed` belong to the ingest path: a sync must
// not carry a stale read of messageCount back over a concurrent increment, or
// the counter silently loses every message counted between the read and the
// write (one-writer-per-subdocument, §5.2).
func TestUpsertGroupFromSync_KeepsIngestOwnedCounters(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	info := groupInfo("120363043123456789", "Ops Team", 12)
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", info, SyncOnConnect); err != nil {
		t.Fatalf("UpsertFromSync: %v", err)
	}
	if _, err := store.collection().UpdateOne(ctx,
		map[string]any{"instanceId": "inst_1", "groupJid": info.JID.String()},
		map[string]any{"$inc": map[string]any{"observed.messageCount": 4211, "observed.mediaStored": 7}},
	); err != nil {
		t.Fatalf("count activity: %v", err)
	}

	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", info, SyncOnTimer); err != nil {
		t.Fatalf("second UpsertFromSync: %v", err)
	}
	doc := store.FindOne(ctx, "org_default", "inst_1", info.JID.String())
	if doc.Observed.MessageCount != 4211 || doc.Observed.MediaStored != 7 {
		t.Errorf("counters = %d/%d, want 4211/7: the sync write clobbered another writer",
			doc.Observed.MessageCount, doc.Observed.MediaStored)
	}
}

// Leaving a group keeps the name: absence from a snapshot is a membership fact,
// not a reason to forget what the group was called (§6.6.5 rule 2).
func TestMarkLeft_KeepsSubject(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	info := groupInfo("120363043123456789", "Ops Team", 12)
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", info, SyncOnConnect); err != nil {
		t.Fatalf("UpsertFromSync: %v", err)
	}
	if err := store.MarkLeft(ctx, "org_default", "inst_1", info.JID.String(), GroupLeft); err != nil {
		t.Fatalf("MarkLeft: %v", err)
	}
	doc := store.FindOne(ctx, "org_default", "inst_1", info.JID.String())
	if doc.Observed.State != GroupLeft || doc.Observed.LeftDetectedAt.IsZero() {
		t.Errorf("state/leftDetectedAt = %q/%v, want left/stamped", doc.Observed.State, doc.Observed.LeftDetectedAt)
	}
	if doc.Observed.Subject != "Ops Team" {
		t.Errorf("subject = %q, want the name retained", doc.Observed.Subject)
	}

	known, err := store.KnownGroupJIDs(ctx, "org_default", "inst_1")
	if err != nil {
		t.Fatalf("KnownGroupJIDs: %v", err)
	}
	if len(known) != 0 {
		t.Errorf("KnownGroupJIDs = %v, want the left group excluded from membership", known)
	}
}

// TestObservedFieldsCoverEveryColumn is the drift guard for the hand-written
// `$set` list: a field added to Observed but never written would decode as its
// zero value forever, and the sync would silently stop persisting it.
func TestObservedFieldsCoverEveryColumn(t *testing.T) {
	var observed Observed
	written := map[string]bool{}
	for _, entry := range observedFields(observed, true) {
		key := entry.Key
		written[key] = true
		if !strings.HasPrefix(key, "observed.") {
			t.Errorf("observedFields writes %q: the worker owns observed.* and nothing else", key)
		}
	}
	typ := reflect.TypeOf(observed)
	for i := range typ.NumField() {
		field := typ.Field(i)
		tag := strings.Split(field.Tag.Get("bson"), ",")[0]
		if tag == "" || tag == "-" {
			t.Fatalf("Observed.%s has no bson tag", field.Name)
		}
		if counterFields[tag] {
			continue
		}
		if !written["observed."+tag] {
			t.Errorf("Observed.%s (%q) is never written by the group store", field.Name, tag)
		}
	}
}

// A metadata delta must not move the sync stamp: `lastSyncedAt` drives the
// staleness repair threshold, and a delta that claimed a sync would keep a stale
// group from ever being repaired (§6.6.2).
func TestObservedFieldsDeltaOmitsSyncStamp(t *testing.T) {
	for _, entry := range observedFields(Observed{}, false) {
		if entry.Key == "observed.lastSyncedAt" || entry.Key == "observed.lastSyncSource" {
			t.Errorf("delta write includes %v: only a snapshot may move the sync stamp", entry.Key)
		}
	}
}
