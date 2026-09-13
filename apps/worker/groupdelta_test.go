package main

import (
	"reflect"
	"slices"
	"strconv"
	"testing"
	"time"

	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

func stamp(min int) time.Time { return time.Unix(1757750000+int64(min)*60, 0) }

func TestAcceptSubject(t *testing.T) {
	observed := time.Unix(1757751120, 0)
	cases := []struct {
		name string
		cur  subjectUpdate
		next subjectUpdate
		want bool
	}{
		{"first observation always wins", subjectUpdate{},
			subjectUpdate{name: "Ops Team", setAt: stamp(1), source: "event", observedAt: observed}, true},
		{"newer stamp wins", subjectUpdate{name: "Support", setAt: stamp(1), source: "event", observedAt: observed},
			subjectUpdate{name: "Ops Team", setAt: stamp(5), source: "event", observedAt: observed.Add(time.Minute)}, true},
		{"older stamp is rejected as stale", subjectUpdate{name: "Ops Team", setAt: stamp(5), source: "event", observedAt: observed},
			subjectUpdate{name: "Support", setAt: stamp(1), source: "event", observedAt: observed.Add(time.Minute)}, false},
		{"equal stamp is accepted (idempotent replay)", subjectUpdate{name: "Ops Team", setAt: stamp(5), source: "event", observedAt: observed},
			subjectUpdate{name: "Ops Team", setAt: stamp(5), source: "event", observedAt: observed.Add(time.Minute)}, true},
		{"stamped beats an earlier unstamped value", subjectUpdate{name: "Support", source: "fallback", observedAt: observed},
			subjectUpdate{name: "Ops Team", setAt: stamp(2), source: "event", observedAt: observed.Add(time.Minute)}, true},
		{"unstamped sync snapshot wins over an unstamped event", subjectUpdate{name: "Support", source: "event", observedAt: observed},
			subjectUpdate{name: "Ops Team", source: "sync", observedAt: observed.Add(time.Hour)}, true},
		{"unstamped event never overrides a stored value", subjectUpdate{name: "Support", source: "sync", observedAt: observed},
			subjectUpdate{name: "Ops Team", source: "event", observedAt: observed.Add(time.Hour)}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := acceptSubject(tc.cur, tc.next); got != tc.want {
				t.Errorf("acceptSubject(%+v, %+v) = %v, want %v", tc.cur, tc.next, got, tc.want)
			}
		})
	}
}

// observedFixture is a stored observation: a synced group named "Support" with
// twelve participants and no history yet.
func observedFixture() Observed {
	return Observed{
		Subject: "Support", SubjectSearch: "support",
		SubjectUpdatedAt: stamp(1), SubjectObservedAt: stamp(1),
		SubjectSetBy: testAdminPN.String(), SubjectSource: "sync",
		State: "active", ParticipantCount: 12,
	}
}

func TestApplyGroupDelta_Rename(t *testing.T) {
	cur := observedFixture()
	evt := events.GroupInfo{JID: testGroupJID, Name: &types.GroupName{Name: "Ops Team", NameSetAt: stamp(9), NameSetBy: testAdminPN}}

	next, changes, err := applyGroupDelta(cur, evt, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if len(changes) != 1 || changes[0] != "subject" {
		t.Fatalf("changes = %v, want [subject]", changes)
	}
	if next.Subject != "Ops Team" || next.SubjectSearch != "ops team" {
		t.Errorf("subject = %q/%q", next.Subject, next.SubjectSearch)
	}
	if !next.SubjectUpdatedAt.Equal(stamp(9)) || next.SubjectSource != "event" {
		t.Errorf("provenance not updated: %+v", next)
	}
	if len(next.SubjectHistory) != 1 || next.SubjectHistory[0].Name != "Support" {
		t.Errorf("SubjectHistory = %+v, want the previous name recorded", next.SubjectHistory)
	}
}

func TestApplyGroupDelta_StaleRenameIsIgnored(t *testing.T) {
	cur := observedFixture()
	cur.SubjectUpdatedAt = stamp(9)
	evt := events.GroupInfo{JID: testGroupJID, Name: &types.GroupName{Name: "Old Name", NameSetAt: stamp(2)}}

	next, changes, err := applyGroupDelta(cur, evt, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if len(changes) != 0 || next.Subject != "Support" {
		t.Errorf("stale rename applied: changes=%v subject=%q", changes, next.Subject)
	}
}

func TestApplyGroupDelta_NoChangeNoWrite(t *testing.T) {
	cur := observedFixture()
	unknown := waBinary.Node{Tag: "future_feature"}
	evt := events.GroupInfo{JID: testGroupJID, UnknownChanges: []*waBinary.Node{&unknown}}

	next, changes, err := applyGroupDelta(cur, evt, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if len(changes) != 0 {
		t.Fatalf("changes = %v, want none (no Mongo write may happen)", changes)
	}
	if !reflect.DeepEqual(cur, next) {
		t.Error("observed state must be untouched when nothing changed")
	}
}

func TestApplyGroupDelta_SelfRemovedKeepsName(t *testing.T) {
	cur := observedFixture()
	next, changes, err := applyGroupDelta(cur, events.GroupInfo{JID: testGroupJID, Leave: []types.JID{testSelfPN}}, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if !slices.Contains(changes, "state") || next.State != "left" {
		t.Errorf("state not marked left: changes=%v state=%q", changes, next.State)
	}
	if next.Subject != "Support" {
		t.Error("the name must be retained after leaving: it is still useful history")
	}
}

func TestApplyGroupDelta_DeleteAndMetadata(t *testing.T) {
	cur := observedFixture()
	evt := events.GroupInfo{
		JID:      testGroupJID,
		Delete:   &types.GroupDelete{Deleted: true, DeleteReason: "user_left"},
		Announce: &types.GroupAnnounce{IsAnnounce: true},
		Locked:   &types.GroupLocked{IsLocked: true},
		Topic:    &types.GroupTopic{Topic: "on-call rota", TopicSetAt: stamp(3)},
	}
	next, changes, err := applyGroupDelta(cur, evt, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if next.State != "deleted" || !next.IsAnnounce || !next.IsLocked || next.Topic != "on-call rota" {
		t.Errorf("metadata not applied: %+v", next)
	}
	if next.Subject != "Support" {
		t.Error("delete must not wipe the retained subject")
	}
	for _, want := range []string{"state", "announce", "locked", "topic"} {
		if !slices.Contains(changes, want) {
			t.Errorf("changes %v missing %q", changes, want)
		}
	}
}

func TestApplyGroupDelta_MembershipMarksCountDirty(t *testing.T) {
	cur := observedFixture()
	next, _, err := applyGroupDelta(cur, events.GroupInfo{JID: testGroupJID, Join: []types.JID{testAdminPN}}, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if !next.ParticipantCountDirty {
		t.Error("ParticipantCountDirty = false: deltas must not invent a count")
	}
	if next.ParticipantCount != 12 {
		t.Errorf("ParticipantCount = %d, want the stored value until the next sync", next.ParticipantCount)
	}
}

func TestApplyGroupDelta_SuspendAndUnsuspend(t *testing.T) {
	cur := observedFixture()
	suspended, changes, err := applyGroupDelta(cur, events.GroupInfo{JID: testGroupJID, Suspended: true}, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if suspended.State != "suspended" || !slices.Contains(changes, "state") {
		t.Fatalf("state = %q changes = %v, want suspended", suspended.State, changes)
	}

	reactivated, changes, err := applyGroupDelta(suspended, events.GroupInfo{JID: testGroupJID, Unsuspended: true}, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if reactivated.State != "active" || !slices.Contains(changes, "state") {
		t.Errorf("state = %q changes = %v, want active", reactivated.State, changes)
	}
}

// A topic deletion carries no text: it must not blank the stored topic, and it
// must not produce a write.
func TestApplyGroupDelta_TopicDeletedIsSkipped(t *testing.T) {
	cur := observedFixture()
	cur.Topic = "on-call rota"
	next, changes, err := applyGroupDelta(cur, events.GroupInfo{
		JID:   testGroupJID,
		Topic: &types.GroupTopic{TopicDeleted: true},
	}, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if len(changes) != 0 || next.Topic != "on-call rota" {
		t.Errorf("topic deletion applied: changes=%v topic=%q", changes, next.Topic)
	}
}

func TestApplyGroupDelta_Ephemeral(t *testing.T) {
	cur := observedFixture()
	next, changes, err := applyGroupDelta(cur, events.GroupInfo{
		JID:       testGroupJID,
		Ephemeral: &types.GroupEphemeral{IsEphemeral: true, DisappearingTimer: 86400},
	}, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if !next.IsEphemeral || !slices.Contains(changes, "ephemeral") {
		t.Errorf("IsEphemeral = %v changes = %v, want true/[ephemeral]", next.IsEphemeral, changes)
	}
}

// A renamer addressed by LID is stored as the PN the UI can show plus the raw
// LID, and an unresolvable LID keeps the LID rather than inventing a PN (§5.1).
func TestApplyGroupDelta_LIDProvenance(t *testing.T) {
	cur := observedFixture()
	lid := types.NewJID("99887766554433", types.HiddenUserServer)
	next, _, err := applyGroupDelta(cur, events.GroupInfo{
		JID:  testGroupJID,
		Name: &types.GroupName{Name: "Ops Team", NameSetAt: stamp(9), NameSetBy: lid, NameSetByPN: testAdminPN},
	}, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if next.SubjectSetBy != testAdminPN.String() || next.SubjectSetByLID != lid.String() {
		t.Errorf("provenance = %q/%q, want %q/%q", next.SubjectSetBy, next.SubjectSetByLID, testAdminPN, lid)
	}

	unresolved, _, err := applyGroupDelta(cur, events.GroupInfo{
		JID:  testGroupJID,
		Name: &types.GroupName{Name: "Ops Team", NameSetAt: stamp(9), NameSetBy: lid},
	}, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if unresolved.SubjectSetBy != "" || unresolved.SubjectSetByLID != lid.String() {
		t.Errorf("unresolved provenance = %q/%q, want \"\"/%q", unresolved.SubjectSetBy, unresolved.SubjectSetByLID, lid)
	}
}

func TestApplyGroupDelta_SubjectHistoryIsCapped(t *testing.T) {
	cur := observedFixture()
	cur.SubjectUpdatedAt = stamp(0)
	for i := 1; i <= subjectHistoryMax+5; i++ {
		next, changes, err := applyGroupDelta(cur, events.GroupInfo{
			JID:  testGroupJID,
			Name: &types.GroupName{Name: "name-" + strconv.Itoa(i), NameSetAt: stamp(i)},
		}, testSelfPN)
		if err != nil {
			t.Fatalf("applyGroupDelta #%d: %v", i, err)
		}
		if len(changes) != 1 {
			t.Fatalf("rename #%d changes = %v, want [subject]", i, changes)
		}
		cur = next
	}
	if len(cur.SubjectHistory) != subjectHistoryMax {
		t.Fatalf("history length = %d, want the ring capped at %d", len(cur.SubjectHistory), subjectHistoryMax)
	}
	if newest := cur.SubjectHistory[0].Name; newest != "name-"+strconv.Itoa(subjectHistoryMax+4) {
		t.Errorf("history[0] = %q, want the entry superseded by the last rename", newest)
	}
	if oldest := cur.SubjectHistory[len(cur.SubjectHistory)-1].Name; oldest != "name-5" {
		t.Errorf("oldest kept entry = %q, want name-5", oldest)
	}
}

// A replayed rename (same name, same stamp) is accepted by the ordering rule but
// must not produce a write, and the change list is how the caller knows.
func TestApplyGroupDelta_ReplayedRenameWritesNothing(t *testing.T) {
	cur := observedFixture()
	evt := events.GroupInfo{JID: testGroupJID, Name: &types.GroupName{Name: "Support", NameSetAt: stamp(1), NameSetBy: testAdminPN}}
	next, changes, err := applyGroupDelta(cur, evt, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if len(changes) != 0 || !reflect.DeepEqual(cur, next) {
		t.Errorf("replay produced changes=%v state=%+v", changes, next)
	}
}

// A doc seeded from first traffic carries no stamp and source "fallback"; a
// later event for the same name must upgrade its provenance, because "named by
// sync" and "named by a rename event" are different facts.
func TestApplyGroupDelta_UpgradesFallbackProvenance(t *testing.T) {
	cur := Observed{Subject: "Support", SubjectSearch: "support", SubjectSource: SubjectFromFallback, State: GroupActive}
	next, changes, err := applyGroupDelta(cur, events.GroupInfo{
		JID:  testGroupJID,
		Name: &types.GroupName{Name: "Support", NameSetAt: stamp(4), NameSetBy: testAdminPN},
	}, testSelfPN)
	if err != nil {
		t.Fatalf("applyGroupDelta: %v", err)
	}
	if !slices.Contains(changes, "subject") || next.SubjectSource != "event" || !next.SubjectUpdatedAt.Equal(stamp(4)) {
		t.Errorf("provenance not upgraded: changes=%v state=%+v", changes, next)
	}
	if len(next.SubjectHistory) != 0 {
		t.Errorf("SubjectHistory = %+v, want no entry: the name did not change", next.SubjectHistory)
	}
}

// A delta for a JID that is not a group is a caller bug, not data: it is refused
// so it can never be stored under the wrong document.
func TestApplyGroupDelta_RejectsNonGroupJID(t *testing.T) {
	cur := observedFixture()
	next, _, err := applyGroupDelta(cur, events.GroupInfo{JID: testSelfPN}, testSelfPN)
	if err == nil {
		t.Fatal("applyGroupDelta accepted a direct-chat JID")
	}
	if !reflect.DeepEqual(cur, next) {
		t.Error("the observed state must be untouched on a refused delta")
	}
}
