package main

import (
	"context"
	"errors"
	"slices"
	"testing"

	"go.mau.fi/whatsmeow/types"
)

// fakeGroupClient is the seam §14.2 asks for: *whatsmeow.Client satisfies
// groupClient, so reconciliation is provable with no socket, no live account and
// no event loop.
type fakeGroupClient struct {
	groups  []*types.GroupInfo
	err     error
	calls   int
	info    map[string]*types.GroupInfo
	infoErr map[string]error
}

func (f *fakeGroupClient) GetJoinedGroups(context.Context) ([]*types.GroupInfo, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return f.groups, nil
}

func (f *fakeGroupClient) GetGroupInfo(_ context.Context, jid types.JID) (*types.GroupInfo, error) {
	if err, ok := f.infoErr[jid.String()]; ok {
		return nil, err
	}
	if info, ok := f.info[jid.String()]; ok {
		return info, nil
	}
	return nil, errors.New("group not found")
}

// seedGroups writes a set of snapshot entries straight into the store, which is
// how a previous sync (or a connection-time sync) would have left the baseline.
func seedGroups(t *testing.T, store *groupStore, ctx context.Context, infos ...*types.GroupInfo) {
	t.Helper()
	for _, info := range infos {
		if err := store.UpsertFromSync(ctx, "org_default", "inst_1", info, SyncOnConnect); err != nil {
			t.Fatalf("seed %s: %v", info.JID, err)
		}
	}
}

func TestSyncGroupReconciliation_MarksAbsentGroupsLeft(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	seedGroups(t, store, ctx,
		groupInfo("120363043000000001", "A", 3),
		groupInfo("120363043000000002", "B", 4),
		groupInfo("120363043000000003", "C", 5),
	)
	client := &fakeGroupClient{groups: []*types.GroupInfo{
		groupInfo("120363043000000001", "A", 3),
		groupInfo("120363043000000002", "B", 4),
	}}

	summary, err := runGroupSync(ctx, client, store, "org_default", "inst_1", SyncOnManual, true)
	if err != nil {
		t.Fatalf("runGroupSync: %v", err)
	}
	if summary.MarkedLeft != 1 {
		t.Errorf("MarkedLeft = %d, want 1", summary.MarkedLeft)
	}
	if summary.Total != 2 || summary.Unchanged != 2 {
		t.Errorf("Total/Unchanged = %d/%d, want 2/2", summary.Total, summary.Unchanged)
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
}

func TestSyncGroupReconciliation_ErrorWritesNoMembershipChange(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	seedGroups(t, store, ctx, groupInfo("120363043000000001", "A", 3))
	client := &fakeGroupClient{err: errors.New("iq timeout")}

	summary, err := runGroupSync(ctx, client, store, "org_default", "inst_1", SyncOnTimer, true)
	if err == nil {
		t.Fatal("runGroupSync swallowed the IQ failure")
	}
	if summary.MarkedLeft != 0 {
		t.Errorf("MarkedLeft = %d, want 0: a failed call must never look like an empty membership", summary.MarkedLeft)
	}
	doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000001@g.us")
	if doc == nil {
		t.Fatal("group A missing after a failed sync")
	}
	if doc.Observed.State != GroupActive {
		t.Errorf("A.state = %q, want active: a timed-out sync writes nothing", doc.Observed.State)
	}
}

func TestSyncGroupReconciliation_Idempotent(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	seedGroups(t, store, ctx, groupInfo("120363043000000001", "A", 3))
	if _, err := store.collection().UpdateOne(ctx,
		map[string]any{"instanceId": "inst_1"},
		map[string]any{"$inc": map[string]any{"observed.messageCount": 5}},
	); err != nil {
		t.Fatalf("count messages: %v", err)
	}
	client := &fakeGroupClient{groups: []*types.GroupInfo{groupInfo("120363043000000001", "A", 3)}}

	for i := 0; i < 2; i++ {
		summary, err := runGroupSync(ctx, client, store, "org_default", "inst_1", SyncOnTimer, true)
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
	if client.calls != 2 {
		t.Errorf("GetJoinedGroups calls = %d, want 2", client.calls)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000001@g.us"); doc == nil || doc.Observed.MessageCount != 5 {
		t.Errorf("messageCount missing or != 5: the sync clobbered the ingest counter (%+v)", doc)
	}
}

func TestSyncGroupSummary_CountsSubjectsAndPrune(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	renamed := groupInfo("120363043000000001", "Old Name", 3)
	renamed.NameSetAt = stamp(1)
	steady := groupInfo("120363043000000002", "Bee", 4)
	steady.NameSetAt = stamp(1)
	seedGroups(t, store, ctx, renamed, steady)

	client := &fakeGroupClient{groups: []*types.GroupInfo{
		{GroupName: types.GroupName{Name: "New Name", NameSetAt: stamp(5)}, JID: renamed.JID, ParticipantCount: 3},
		steady,
	}}
	summary, err := runGroupSync(ctx, client, store, "org_default", "inst_1", SyncOnManual, true)
	if err != nil {
		t.Fatalf("runGroupSync: %v", err)
	}
	if summary.SubjectUpdated != 1 || summary.Unchanged != 1 || summary.MetadataUpdated != 0 {
		t.Errorf("summary = %+v, want subjectUpdated=1 unchanged=1 metadataUpdated=0", summary)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", renamed.JID.String()); doc == nil || doc.Observed.Subject != "New Name" {
		t.Errorf("stored subject = %+v, want the newer snapshot name", doc)
	}
}

func TestSyncGroupReconciliation_PruneDisabledKeepsGroups(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	seedGroups(t, store, ctx, groupInfo("120363043000000001", "A", 3))
	client := &fakeGroupClient{}

	summary, err := runGroupSync(ctx, client, store, "org_default", "inst_1", SyncOnTimer, false)
	if err != nil {
		t.Fatalf("runGroupSync: %v", err)
	}
	if summary.MarkedLeft != 0 {
		t.Errorf("MarkedLeft = %d, want 0 with GROUP_SYNC_PRUNE=false", summary.MarkedLeft)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000001@g.us"); doc == nil || doc.Observed.State != GroupActive {
		t.Errorf("state = %+v, want active: the operator safety valve must hold", doc)
	}

	// The same empty response with pruning on is what marks it left — the switch,
	// not the response, is what changed.
	if _, err := runGroupSync(ctx, client, store, "org_default", "inst_1", SyncOnTimer, true); err != nil {
		t.Fatalf("pruning runGroupSync: %v", err)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000001@g.us"); doc == nil || doc.Observed.State != GroupLeft {
		t.Errorf("state = %+v, want left once pruning is enabled", doc)
	}
}

// A snapshot whose stamp is older than a rename event we already applied must
// lose: the sync is authoritative about membership, not about a name that
// arrived out of order (§6.6.4, §6.6.5).
func TestSyncGroupSummary_RejectsStaleSnapshotSubject(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	current := groupInfo("120363043000000001", "New Name", 3)
	current.NameSetAt = stamp(9)
	seedGroups(t, store, ctx, current)

	stale := *current
	stale.Name = "Old Name"
	stale.NameSetAt = stamp(2)
	client := &fakeGroupClient{groups: []*types.GroupInfo{&stale}}
	summary, err := runGroupSync(ctx, client, store, "org_default", "inst_1", SyncOnTimer, true)
	if err != nil {
		t.Fatalf("runGroupSync: %v", err)
	}
	if summary.SubjectRejected != 1 {
		t.Errorf("SubjectRejected = %d, want 1: an out-of-order name must be counted, not silently accepted", summary.SubjectRejected)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", current.JID.String()); doc == nil || doc.Observed.Subject != "New Name" {
		t.Errorf("subject = %+v, want the newer stored name", doc)
	}
}

// A group that shows up again after we marked it left is back: the snapshot is
// authoritative about membership, so the row is reactivated rather than
// re-inserted.
func TestSyncGroupReconciliation_ReactivatesReturningGroup(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	info := groupInfo("120363043000000001", "A", 3)
	seedGroups(t, store, ctx, info)
	if err := store.MarkLeft(ctx, "org_default", "inst_1", info.JID.String(), GroupLeft); err != nil {
		t.Fatalf("MarkLeft: %v", err)
	}

	client := &fakeGroupClient{groups: []*types.GroupInfo{info}}
	summary, err := runGroupSync(ctx, client, store, "org_default", "inst_1", SyncOnTimer, true)
	if err != nil {
		t.Fatalf("runGroupSync: %v", err)
	}
	if summary.MetadataUpdated != 1 || summary.Added != 0 {
		t.Errorf("summary = %+v, want metadataUpdated=1 added=0", summary)
	}
	doc := store.FindOne(ctx, "org_default", "inst_1", info.JID.String())
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

func TestSyncGroupSummary_CountsAddedGroups(t *testing.T) {
	store, ctx := newTestGroupStore(t)
	client := &fakeGroupClient{groups: []*types.GroupInfo{
		groupInfo("120363043000000001", "A", 3),
		groupInfo("120363043000000002", "B", 4),
	}}
	summary, err := runGroupSync(ctx, client, store, "org_default", "inst_1", SyncOnConnect, true)
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

// mergeSnapshot is the pure half of reconciliation — the snapshot's claim about
// one group against what we stored — so its rules are asserted directly.
func TestMergeSnapshot_NewerNameWins(t *testing.T) {
	cur := observedFixture()
	newer := groupInfo("120363043123456789", "Ops Team", 12)
	newer.NameSetAt = stamp(5)
	merged, changes, rejected := mergeSnapshot(cur, newer, SyncOnTimer, stamp(30))
	if rejected {
		t.Error("a newer snapshot name must not be reported as rejected")
	}
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
	if !merged.LastSyncedAt.Equal(stamp(30)) || merged.LastSyncSource != SyncOnTimer {
		t.Errorf("sync stamp = %v/%q, want %v/timer", merged.LastSyncedAt, merged.LastSyncSource, stamp(30))
	}
}

func TestMergeSnapshot_RefusesStaleAndEmptyNames(t *testing.T) {
	cur := observedFixture()
	cur.SubjectUpdatedAt = stamp(9)

	stale := groupInfo("120363043123456789", "Old Name", 12)
	stale.NameSetAt = stamp(2)
	merged, changes, rejected := mergeSnapshot(cur, stale, SyncOnTimer, stamp(30))
	if !rejected {
		t.Error("an older snapshot name must be reported as rejected")
	}
	if slices.Contains(changes, "subject") || merged.Subject != "Support" {
		t.Errorf("stale name applied: changes=%v subject=%q", changes, merged.Subject)
	}

	unnamed := groupInfo("120363043123456789", "", 12)
	merged, changes, rejected = mergeSnapshot(cur, unnamed, SyncOnTimer, stamp(30))
	if rejected {
		t.Error("an empty snapshot name is missing information, not a stale claim")
	}
	if slices.Contains(changes, "subject") || merged.Subject != "Support" {
		t.Errorf("empty name applied: changes=%v subject=%q", changes, merged.Subject)
	}
}

func TestMergeSnapshot_AppliesMetadataAndClearsDirty(t *testing.T) {
	cur := observedFixture()
	cur.State = GroupLeft
	cur.ParticipantCountDirty = true
	cur.Topic = "old topic"

	info := groupInfo("120363043123456789", "Support", 14)
	info.Topic = "on-call rota"
	info.TopicSetAt = stamp(7)
	info.IsAnnounce = true
	info.IsLocked = true
	info.GroupCreated = stamp(0)

	merged, changes, _ := mergeSnapshot(cur, info, SyncOnTimer, stamp(30))
	for _, want := range []string{"state", "participantCount", "participantCountDirty", "topic", "announce", "locked", "groupCreatedAt"} {
		if !slices.Contains(changes, want) {
			t.Errorf("changes %v missing %q", changes, want)
		}
	}
	if merged.State != GroupActive || merged.ParticipantCount != 14 || merged.ParticipantCountDirty {
		t.Errorf("membership not refreshed: %+v", merged)
	}
	if merged.Topic != "on-call rota" || !merged.TopicUpdatedAt.Equal(stamp(7)) {
		t.Errorf("topic = %q/%v, want on-call rota/%v", merged.Topic, merged.TopicUpdatedAt, stamp(7))
	}
	if !merged.IsAnnounce || !merged.IsLocked || !merged.GroupCreatedAt.Equal(stamp(0)) {
		t.Errorf("flags/creation not applied: %+v", merged)
	}
	if len(merged.SubjectHistory) != 0 {
		t.Errorf("SubjectHistory = %+v, want empty: the name did not change", merged.SubjectHistory)
	}
}

// A snapshot without a suspended marker means the group is running; a snapshot
// with one must not be overwritten by the inference.
func TestMergeSnapshot_SuspendedState(t *testing.T) {
	cur := observedFixture()
	suspended := groupInfo("120363043123456789", "Support", 12)
	suspended.Suspended = true

	merged, changes, _ := mergeSnapshot(cur, suspended, SyncOnTimer, stamp(30))
	if merged.State != GroupSuspended || !slices.Contains(changes, "state") {
		t.Errorf("state = %q changes = %v, want suspended", merged.State, changes)
	}
}

// The activity counters belong to ingest: a snapshot carries none, and a merge
// must not invent one.
func TestMergeSnapshot_KeepsIngestCounters(t *testing.T) {
	cur := observedFixture()
	cur.MessageCount, cur.MediaStored, cur.LastActivityAt = 4211, 88, stamp(12)

	merged, _, _ := mergeSnapshot(cur, groupInfo("120363043123456789", "Support", 12), SyncOnTimer, stamp(30))
	if merged.MessageCount != 4211 || merged.MediaStored != 88 || !merged.LastActivityAt.Equal(stamp(12)) {
		t.Errorf("counters = %d/%d/%v, want the ingest values untouched", merged.MessageCount, merged.MediaStored, merged.LastActivityAt)
	}
}
