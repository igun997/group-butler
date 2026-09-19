package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"testing"
)

// The sync's only source of truth is the bridge's `GET /groups`: every group the
// linked account participates in. These tests drive the real HTTP client against
// a server standing where the Hermes bridge does, so what is asserted is the call
// the worker makes and the rows it writes — not a seam invented for the test.

// groupsAnswer is the bridge's own payload for `GET /groups`.
func groupsAnswer(groups ...bridgeGroupSummary) string {
	body, err := json.Marshal(map[string]any{"ok": true, "groups": groups})
	if err != nil {
		panic(err)
	}
	return string(body)
}

// seedSync writes one observation the way a previous sync would have left it.
func seedSync(t *testing.T, store *groupStore, ctx context.Context, jid, subject string, participants int) {
	t.Helper()
	if err := store.UpsertObserved(ctx, "org_default", "inst_1", jid, Observed{
		Subject: subject, SubjectSearch: foldText(subject), SubjectSource: SubjectFromSync,
		SubjectUpdatedAt: stamp(1), SubjectObservedAt: stamp(1),
		State: GroupActive, ParticipantCount: participants,
		LastSyncedAt: stamp(1), LastSyncSource: SyncOnTimer,
	}, true); err != nil {
		t.Fatalf("seed %s: %v", jid, err)
	}
}

func TestRunGroupSyncMarksAbsentGroupsLeft(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	seedSync(t, store, ctx, "120363043000000001@g.us", "A", 3)
	seedSync(t, store, ctx, "120363043000000002@g.us", "B", 4)
	seedSync(t, store, ctx, "120363043000000003@g.us", "C", 5)
	bridge := newFakeBridge(t).answering(http.StatusOK, groupsAnswer(
		bridgeGroup("120363043000000001", "A", 3),
		bridgeGroup("120363043000000002", "B", 4),
	))

	summary, err := runGroupSync(ctx, bridge.client(t), store, "org_default", "inst_1", SyncOnManual, true)
	if err != nil {
		t.Fatalf("runGroupSync: %v", err)
	}
	if summary.MarkedLeft != 1 {
		t.Errorf("MarkedLeft = %d, want 1", summary.MarkedLeft)
	}
	if summary.Total != 2 || summary.Unchanged != 2 {
		t.Errorf("Total/Unchanged = %d/%d, want 2/2", summary.Total, summary.Unchanged)
	}
	if summary.GroupsLeft != 1 {
		t.Errorf("GroupsLeft = %d, want 1: the gauge counts the groups we are known to have left", summary.GroupsLeft)
	}
	doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000003@g.us")
	if doc == nil {
		t.Fatal("group C disappeared: absence must mark state, not delete the row")
	}
	if doc.Observed.State != GroupLeft {
		t.Errorf("C.state = %q, want left", doc.Observed.State)
	}
	if doc.Observed.Subject != "C" {
		t.Error("the retained name must survive leaving the group")
	}
	if doc.Observed.LeftDetectedAt.IsZero() {
		t.Error("leftDetectedAt must be stamped: the dashboard shows when we lost the group")
	}
	if call := bridge.only(t); call.path != "/groups" || call.method != http.MethodGet {
		t.Errorf("the sync must ask the bridge for the group list, got %s %s", call.method, call.path)
	}
}

// A bridge that answered with a refusal describes no membership at all: the pass
// must report the failure and write nothing, because a refused snapshot read as
// an empty one would mark every stored group left (§6.6.5 rule 4).
func TestRunGroupSyncRefusalWritesNoMembershipChange(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	seedSync(t, store, ctx, "120363043000000001@g.us", "A", 3)
	bridge := newFakeBridge(t).refusing("rate-overlimit")

	summary, err := runGroupSync(ctx, bridge.client(t), store, "org_default", "inst_1", SyncOnTimer, true)
	if err == nil {
		t.Fatal("runGroupSync swallowed the bridge's refusal")
	}
	if summary.MarkedLeft != 0 {
		t.Errorf("MarkedLeft = %d, want 0: a failed call must never look like an empty membership", summary.MarkedLeft)
	}
	doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000001@g.us")
	if doc == nil {
		t.Fatal("group A missing after a failed sync")
	}
	if doc.Observed.State != GroupActive {
		t.Errorf("A.state = %q, want active: a refused sync writes nothing", doc.Observed.State)
	}
}

// A bridge this worker cannot reach is the same answer as a refusal, and the
// failure has to be identifiable as "no answer" rather than as a group-level
// refusal: that is what tells the caller there was no live session to ask.
func TestRunGroupSyncReportsAnUnreachableBridge(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	bridge := newFakeBridge(t)
	client := bridge.closedClient(t)

	summary, err := runGroupSync(ctx, client, store, "org_default", "inst_1", SyncOnManual, true)
	if err == nil {
		t.Fatal("runGroupSync reported success against a bridge that is not listening")
	}
	if !errors.Is(err, errBridgeUnreachable) {
		t.Errorf("err = %v, want the unreachable-bridge failure", err)
	}
	if summary.Total != 0 || summary.MarkedLeft != 0 {
		t.Errorf("summary = %+v, want nothing observed and nothing marked", summary)
	}
}

func TestRunGroupSyncIsIdempotent(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	seedSync(t, store, ctx, "120363043000000001@g.us", "A", 3)
	if _, err := store.collection().UpdateOne(ctx,
		map[string]any{"instanceId": "inst_1"},
		map[string]any{"$inc": map[string]any{"observed.messageCount": 5}},
	); err != nil {
		t.Fatalf("count messages: %v", err)
	}
	bridge := newFakeBridge(t).answering(http.StatusOK, groupsAnswer(bridgeGroup("120363043000000001", "A", 3)))

	for i := 0; i < 2; i++ {
		summary, err := runGroupSync(ctx, bridge.client(t), store, "org_default", "inst_1", SyncOnTimer, true)
		if err != nil {
			t.Fatalf("runGroupSync #%d: %v", i, err)
		}
		if summary.MarkedLeft != 0 || summary.Added != 0 {
			t.Fatalf("run #%d: summary = %+v, want a steady state", i, summary)
		}
	}
	count, err := store.collection().CountDocuments(ctx, map[string]any{})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("group count = %d, want 1", count)
	}
	if calls := len(bridge.recorded()); calls != 2 {
		t.Errorf("bridge calls = %d, want one per pass", calls)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000001@g.us"); doc == nil || doc.Observed.MessageCount != 5 {
		t.Errorf("messageCount missing or != 5: the sync clobbered the ingest counter (%+v)", doc)
	}
}

func TestRunGroupSyncCountsSubjectsAndMetadata(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	seedSync(t, store, ctx, "120363043000000001@g.us", "Old Name", 3)
	seedSync(t, store, ctx, "120363043000000002@g.us", "Bee", 4)
	bridge := newFakeBridge(t).answering(http.StatusOK, groupsAnswer(
		bridgeGroup("120363043000000001", "New Name", 3),
		bridgeGroup("120363043000000002", "Bee", 9),
	))

	summary, err := runGroupSync(ctx, bridge.client(t), store, "org_default", "inst_1", SyncOnManual, true)
	if err != nil {
		t.Fatalf("runGroupSync: %v", err)
	}
	if summary.SubjectUpdated != 1 || summary.MetadataUpdated != 1 || summary.Unchanged != 0 {
		t.Errorf("summary = %+v, want subjectUpdated=1 metadataUpdated=1 unchanged=0", summary)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000001@g.us"); doc == nil || doc.Observed.Subject != "New Name" {
		t.Errorf("stored subject = %+v, want the live name", doc)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000002@g.us"); doc == nil || doc.Observed.ParticipantCount != 9 {
		t.Errorf("participant count = %+v, want the live count", doc)
	}
}

func TestRunGroupSyncPruneDisabledKeepsGroups(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	seedSync(t, store, ctx, "120363043000000001@g.us", "A", 3)
	bridge := newFakeBridge(t).answering(http.StatusOK, groupsAnswer())

	summary, err := runGroupSync(ctx, bridge.client(t), store, "org_default", "inst_1", SyncOnTimer, false)
	if err != nil {
		t.Fatalf("runGroupSync: %v", err)
	}
	if summary.MarkedLeft != 0 {
		t.Errorf("MarkedLeft = %d, want 0 with GROUP_SYNC_PRUNE=false", summary.MarkedLeft)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000001@g.us"); doc == nil || doc.Observed.State != GroupActive {
		t.Errorf("state = %+v, want active: the operator safety valve must hold", doc)
	}

	// The same empty answer with pruning on is what marks it left — the switch,
	// not the answer, is what changed.
	if _, err := runGroupSync(ctx, bridge.client(t), store, "org_default", "inst_1", SyncOnTimer, true); err != nil {
		t.Fatalf("pruning runGroupSync: %v", err)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000001@g.us"); doc == nil || doc.Observed.State != GroupLeft {
		t.Errorf("state = %+v, want left once pruning is enabled", doc)
	}
}

// A group that shows up again after we marked it left is back: the bridge's
// answer is authoritative about membership, so the row is reactivated rather than
// re-inserted.
func TestRunGroupSyncReactivatesReturningGroup(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	seedSync(t, store, ctx, "120363043000000001@g.us", "A", 3)
	if err := store.MarkLeft(ctx, "org_default", "inst_1", "120363043000000001@g.us", GroupLeft); err != nil {
		t.Fatalf("MarkLeft: %v", err)
	}

	bridge := newFakeBridge(t).answering(http.StatusOK, groupsAnswer(bridgeGroup("120363043000000001", "A", 3)))
	summary, err := runGroupSync(ctx, bridge.client(t), store, "org_default", "inst_1", SyncOnTimer, true)
	if err != nil {
		t.Fatalf("runGroupSync: %v", err)
	}
	if summary.MetadataUpdated != 1 || summary.Added != 0 {
		t.Errorf("summary = %+v, want metadataUpdated=1 added=0", summary)
	}
	doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000001@g.us")
	if doc == nil {
		t.Fatal("group missing after reactivation")
	}
	if doc.Observed.State != GroupActive {
		t.Errorf("state = %q, want active (reactivated)", doc.Observed.State)
	}
	if doc.Observed.LeftDetectedAt.IsZero() {
		t.Error("leftDetectedAt must survive reactivation: when we last lost the group is still history")
	}
}

func TestRunGroupSyncCountsAddedGroups(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	bridge := newFakeBridge(t).answering(http.StatusOK, groupsAnswer(
		bridgeGroup("120363043000000001", "A", 3),
		bridgeGroup("120363043000000002", "B", 4),
	))

	summary, err := runGroupSync(ctx, bridge.client(t), store, "org_default", "inst_1", SyncOnConnect, true)
	if err != nil {
		t.Fatalf("runGroupSync: %v", err)
	}
	if summary.Total != 2 || summary.Added != 2 || summary.Unchanged != 0 {
		t.Errorf("summary = %+v, want total=2 added=2 unchanged=0", summary)
	}
	if summary.Source != SyncOnConnect {
		t.Errorf("Source = %q, want connect", summary.Source)
	}
}

// An entry that is not a group JID is a contract surprise: it must not become a
// document, and the rest of the snapshot still lands.
func TestRunGroupSyncIgnoresNonGroupEntries(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	bridge := newFakeBridge(t).answering(http.StatusOK, groupsAnswer(
		bridgeGroupSummary{JID: "628990000001@s.whatsapp.net", Subject: "not a group"},
		bridgeGroup("120363043000000001", "A", 3),
	))

	summary, err := runGroupSync(ctx, bridge.client(t), store, "org_default", "inst_1", SyncOnManual, true)
	if err != nil {
		t.Fatalf("runGroupSync: %v", err)
	}
	if summary.Total != 1 || summary.Added != 1 {
		t.Errorf("summary = %+v, want the one group only", summary)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", "628990000001@s.whatsapp.net"); doc != nil {
		t.Error("a non-group entry became a stored group")
	}
}

// mergeSnapshot is the pure half of reconciliation — the bridge's claim about one
// group against what we stored — so its rules are asserted directly.
func TestMergeSnapshotAppliesTheLiveName(t *testing.T) {
	cur := observedFixture()
	merged, changes := mergeSnapshot(cur, groupSnapshot{JID: "120363043123456789@g.us", Subject: "Ops Team", ParticipantCount: 12}, SyncOnTimer, stamp(30))

	if !slices.Contains(changes, "subject") {
		t.Errorf("changes = %v, want subject", changes)
	}
	if merged.Subject != "Ops Team" || merged.SubjectSearch != "ops team" {
		t.Errorf("subject = %q/%q, want Ops Team/ops team", merged.Subject, merged.SubjectSearch)
	}
	if merged.SubjectSource != SubjectFromSync {
		t.Errorf("subjectSource = %q, want sync", merged.SubjectSource)
	}
	if len(merged.SubjectHistory) != 1 || merged.SubjectHistory[0].Name != "Support" {
		t.Errorf("SubjectHistory = %+v, want the superseded name", merged.SubjectHistory)
	}
	if !merged.SubjectUpdatedAt.Equal(stamp(30)) {
		t.Errorf("SubjectUpdatedAt = %v, want the moment we observed the new name", merged.SubjectUpdatedAt)
	}
	if !merged.LastSyncedAt.Equal(stamp(30)) || merged.LastSyncSource != SyncOnTimer {
		t.Errorf("sync stamp = %v/%q, want %v/timer", merged.LastSyncedAt, merged.LastSyncSource, stamp(30))
	}
}

// A name that did not move is not a change: the stamp beside it means "when this
// name was set", and a live read that sees the same name has learnt nothing new.
func TestMergeSnapshotKeepsAConfirmedName(t *testing.T) {
	cur := observedFixture()
	merged, changes := mergeSnapshot(cur, groupSnapshot{JID: "120363043123456789@g.us", Subject: "Support", ParticipantCount: 12}, SyncOnTimer, stamp(30))

	if slices.Contains(changes, "subject") {
		t.Errorf("changes = %v, want no subject change", changes)
	}
	if !merged.SubjectUpdatedAt.Equal(cur.SubjectUpdatedAt) {
		t.Errorf("SubjectUpdatedAt = %v, want the stored stamp %v", merged.SubjectUpdatedAt, cur.SubjectUpdatedAt)
	}
	if len(merged.SubjectHistory) != 0 {
		t.Errorf("SubjectHistory = %+v, want empty", merged.SubjectHistory)
	}
}

// An answer without a subject is missing information, not a rename to "": it must
// not wipe a name we already know.
func TestMergeSnapshotIgnoresAnEmptyName(t *testing.T) {
	cur := observedFixture()
	merged, changes := mergeSnapshot(cur, groupSnapshot{JID: "120363043123456789@g.us", ParticipantCount: 12}, SyncOnTimer, stamp(30))

	if slices.Contains(changes, "subject") || merged.Subject != "Support" {
		t.Errorf("empty name applied: changes=%v subject=%q", changes, merged.Subject)
	}
}

// A stored name that was only a placeholder becomes a real one: the source moves
// to sync while the stamp stays, because the name has been confirmed, not moved.
func TestMergeSnapshotConfirmsAFallbackName(t *testing.T) {
	cur := observedFixture()
	cur.SubjectSource = SubjectFromFallback

	merged, changes := mergeSnapshot(cur, groupSnapshot{JID: "120363043123456789@g.us", Subject: "Support", ParticipantCount: 12}, SyncOnTimer, stamp(30))
	if !slices.Contains(changes, "subject") {
		t.Errorf("changes = %v, want the confirmation recorded", changes)
	}
	if merged.SubjectSource != SubjectFromSync || !merged.SubjectUpdatedAt.Equal(cur.SubjectUpdatedAt) {
		t.Errorf("merged = %+v, want source sync and the stored stamp", merged)
	}
}

func TestMergeSnapshotAppliesMetadataAndClearsDirty(t *testing.T) {
	cur := observedFixture()
	cur.State = GroupLeft
	cur.ParticipantCountDirty = true
	cur.Topic = "old topic"

	merged, changes := mergeSnapshot(cur, groupSnapshot{
		JID: "120363043123456789@g.us", Subject: "Support", Announce: true, Locked: true, ParticipantCount: 14,
	}, SyncOnTimer, stamp(30))
	for _, want := range []string{"state", "participantCount", "participantCountDirty", "announce", "locked"} {
		if !slices.Contains(changes, want) {
			t.Errorf("changes %v missing %q", changes, want)
		}
	}
	if merged.State != GroupActive || merged.ParticipantCount != 14 || merged.ParticipantCountDirty {
		t.Errorf("membership not refreshed: %+v", merged)
	}
	if !merged.IsAnnounce || !merged.IsLocked {
		t.Errorf("flags not applied: %+v", merged)
	}
	// The bridge's contract carries no topic: the stored one is left alone rather
	// than being erased by a snapshot that never mentioned it.
	if merged.Topic != "old topic" {
		t.Errorf("topic = %q, want the stored value kept", merged.Topic)
	}
}

// The activity counters belong to ingest: a snapshot carries none, and a merge
// must not invent one.
func TestMergeSnapshotKeepsIngestCounters(t *testing.T) {
	cur := observedFixture()
	cur.MessageCount, cur.MediaStored, cur.LastActivityAt = 4211, 88, stamp(12)

	merged, _ := mergeSnapshot(cur, groupSnapshot{JID: "120363043123456789@g.us", Subject: "Support", ParticipantCount: 12}, SyncOnTimer, stamp(30))
	if merged.MessageCount != 4211 || merged.MediaStored != 88 || !merged.LastActivityAt.Equal(stamp(12)) {
		t.Errorf("counters = %d/%d/%v, want the ingest values untouched", merged.MessageCount, merged.MediaStored, merged.LastActivityAt)
	}
}
