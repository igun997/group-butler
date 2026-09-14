package main

import (
	"context"
	"testing"
	"time"
)

// A flush's messages reach both documents as totals, not as one write per
// message, and a batch that spans midnight or several groups is split where the
// documents say it should be: a day row is keyed by its day.

func TestRecordStoredAggregatesByDayInstanceAndGroup(t *testing.T) {
	stats := &fakeDayCounters{}
	repo := newFakeInstanceRepo()
	mgr := testManagerWithDeps(newFakeGroupStore(), stats, nil)
	mgr.instances = repo

	lateOnThe14th := time.Date(2026, 9, 14, 23, 59, 30, 0, time.UTC)
	afterMidnight := time.Date(2026, 9, 15, 0, 1, 0, 0, time.UTC)
	mgr.recordStored(context.Background(), []MessageDoc{
		{OrganizationID: "org_default", InstanceID: "inst_1", GroupJID: "group_a@g.us", Timestamp: lateOnThe14th},
		{OrganizationID: "org_default", InstanceID: "inst_1", GroupJID: "group_a@g.us", Timestamp: lateOnThe14th.Add(10 * time.Second)},
		{OrganizationID: "org_default", InstanceID: "inst_1", GroupJID: "group_b@g.us", Timestamp: lateOnThe14th},
		{OrganizationID: "org_default", InstanceID: "inst_2", GroupJID: "group_a@g.us", Timestamp: afterMidnight},
	})

	calls := stats.recorded()
	if len(calls) != 3 {
		t.Fatalf("bumps = %d, want one per day/instance/group: %+v", len(calls), calls)
	}
	type key struct{ day, instance, group string }
	counts := map[key]int64{}
	for _, call := range calls {
		if call.counter != dayCounterMessagesIn {
			t.Fatalf("counter = %q, want %q", call.counter, dayCounterMessagesIn)
		}
		if call.orgID != "org_default" {
			t.Fatalf("org = %q", call.orgID)
		}
		counts[key{call.at.UTC().Format(time.DateOnly), call.instanceID, call.groupJID}] += call.count
	}
	if counts[key{"2026-09-14", "inst_1", "group_a@g.us"}] != 2 {
		t.Fatalf("inst_1/group_a on the 14th = %d, want 2", counts[key{"2026-09-14", "inst_1", "group_a@g.us"}])
	}
	if counts[key{"2026-09-14", "inst_1", "group_b@g.us"}] != 1 {
		t.Fatalf("inst_1/group_b on the 14th = %d, want 1", counts[key{"2026-09-14", "inst_1", "group_b@g.us"}])
	}
	if counts[key{"2026-09-15", "inst_2", "group_a@g.us"}] != 1 {
		t.Fatalf("inst_2/group_a on the 15th = %d, want 1", counts[key{"2026-09-15", "inst_2", "group_a@g.us"}])
	}

	// The instance's own counter sums per instance, across groups and days.
	if got := repo.counters["inst_1"][runtimeCounterMessagesIn]; got != 3 {
		t.Fatalf("inst_1 %s = %d, want 3", runtimeCounterMessagesIn, got)
	}
	if got := repo.counters["inst_2"][runtimeCounterMessagesIn]; got != 1 {
		t.Fatalf("inst_2 %s = %d, want 1", runtimeCounterMessagesIn, got)
	}
}

// The day row is stamped with the newest message in its bucket, so the row's
// `updatedAt` describes the data rather than the flush that wrote it.
func TestRecordStoredStampsEachDayWithItsNewestMessage(t *testing.T) {
	stats := &fakeDayCounters{}
	mgr := testManagerWithDeps(newFakeGroupStore(), stats, nil)

	older := time.Date(2026, 9, 14, 8, 0, 0, 0, time.UTC)
	newer := time.Date(2026, 9, 14, 9, 30, 0, 0, time.UTC)
	mgr.recordStored(context.Background(), []MessageDoc{
		{OrganizationID: "org_default", InstanceID: "inst_1", GroupJID: "group_a@g.us", Timestamp: newer},
		{OrganizationID: "org_default", InstanceID: "inst_1", GroupJID: "group_a@g.us", Timestamp: older},
	})

	calls := stats.recorded()
	if len(calls) != 1 {
		t.Fatalf("bumps = %d, want one", len(calls))
	}
	if !calls[0].at.Equal(newer) {
		t.Fatalf("stamp = %v, want the newest message in the batch", calls[0].at)
	}
}

// An empty batch is not a write, and a manager without its dependencies (the
// group-surface test harness) must not panic on the shutdown path.
func TestRecordStoredIgnoresNothing(t *testing.T) {
	stats := &fakeDayCounters{}
	mgr := testManagerWithDeps(newFakeGroupStore(), stats, nil)

	mgr.recordStored(context.Background(), nil)
	if got := stats.count(); got != 0 {
		t.Fatalf("bumps = %d, want none for an empty batch", got)
	}
}

// ---- media ---------------------------------------------------------------

// Media that the pipeline resolved has to land in both documents §10 reads: the
// day row under the group it belongs to, and the instance's own counter. A
// retry by the janitor is an outcome like any other, which is why the runner
// reports through this method rather than only the live path counting.
func TestRecordMediaCountsStoredAndUnparsedPerGroup(t *testing.T) {
	stats := &fakeDayCounters{}
	repo := newFakeInstanceRepo()
	mgr := testManagerWithDeps(newFakeGroupStore(), stats, nil)
	mgr.instances = repo

	stored := MessageDoc{OrganizationID: "org_default", InstanceID: "inst_1", GroupJID: "group_a@g.us"}
	other := MessageDoc{OrganizationID: "org_default", InstanceID: "inst_1", GroupJID: "group_b@g.us"}
	mgr.recordMedia(context.Background(), stored, Media{Status: MediaStored})
	mgr.recordMedia(context.Background(), other, Media{Status: MediaStored})
	mgr.recordMedia(context.Background(), stored, Media{Status: MediaUnparsed})

	type key struct{ counter, group string }
	counts := map[key]int64{}
	for _, call := range stats.recorded() {
		if call.orgID != "org_default" {
			t.Fatalf("org = %q", call.orgID)
		}
		if call.count != 1 {
			t.Fatalf("count = %d, want one attachment per call", call.count)
		}
		counts[key{call.counter, call.groupJID}]++
	}
	if counts[key{dayCounterMediaStored, "group_a@g.us"}] != 1 {
		t.Errorf("stored on group_a = %d, want 1: %+v", counts[key{dayCounterMediaStored, "group_a@g.us"}], stats.recorded())
	}
	if counts[key{dayCounterMediaStored, "group_b@g.us"}] != 1 {
		t.Errorf("stored on group_b = %d, want 1", counts[key{dayCounterMediaStored, "group_b@g.us"}])
	}
	if counts[key{dayCounterMediaUnparsed, "group_a@g.us"}] != 1 {
		t.Errorf("unparsed on group_a = %d, want 1", counts[key{dayCounterMediaUnparsed, "group_a@g.us"}])
	}
	if got := repo.counters["inst_1"][runtimeCounterMediaStored]; got != 2 {
		t.Errorf("inst_1 %s = %d, want 2", runtimeCounterMediaStored, got)
	}
	if got := repo.counters["inst_1"][runtimeCounterMediaUnparsed]; got != 1 {
		t.Errorf("inst_1 %s = %d, want 1", runtimeCounterMediaUnparsed, got)
	}
}

// An outcome that holds no media is not media: `pending` is work not yet done,
// `failed` is work that must be retried, and `unavailable` is media WhatsApp
// will not give us. Counting any of them as stored or unparsed would claim bytes
// the bucket does not have (R3).
func TestRecordMediaIgnoresOutcomesThatHoldNoMedia(t *testing.T) {
	stats := &fakeDayCounters{}
	repo := newFakeInstanceRepo()
	mgr := testManagerWithDeps(newFakeGroupStore(), stats, nil)
	mgr.instances = repo

	doc := MessageDoc{OrganizationID: "org_default", InstanceID: "inst_1", GroupJID: "group_a@g.us"}
	for _, status := range []MediaStatus{MediaNone, MediaPending, MediaFailed, MediaUnavailable} {
		mgr.recordMedia(context.Background(), doc, Media{Status: status})
	}

	if got := stats.count(); got != 0 {
		t.Fatalf("day bumps = %d, want none for media we do not hold: %+v", got, stats.recorded())
	}
	if got := len(repo.counters["inst_1"]); got != 0 {
		t.Fatalf("instance counters = %v, want none", repo.counters["inst_1"])
	}
}

// ---- sends ---------------------------------------------------------------

// A dispatch outcome moves two counters in opposite directions, so both are
// asserted: an incident that only ever recorded `sendOk` would leave the console
// reporting a send success rate of 100% (R8).
func TestRecordSendCountsBothOutcomes(t *testing.T) {
	stats := &fakeDayCounters{}
	repo := newFakeInstanceRepo()
	mgr := testManagerWithDeps(newFakeGroupStore(), stats, nil)
	mgr.instances = repo

	mgr.recordSend(context.Background(), "inst_1", "group_a@g.us", true, time.Now())
	mgr.recordSend(context.Background(), "inst_1", "group_a@g.us", false, time.Now())

	calls := stats.recorded()
	if len(calls) != 2 {
		t.Fatalf("day bumps = %d, want one per send: %+v", len(calls), calls)
	}
	counters := map[string]int64{}
	for _, call := range calls {
		if call.groupJID != "group_a@g.us" {
			t.Errorf("group = %q, want the group the send went to", call.groupJID)
		}
		counters[call.counter] += call.count
	}
	if counters[dayCounterSendsSent] != 1 {
		t.Errorf("%s = %d, want 1", dayCounterSendsSent, counters[dayCounterSendsSent])
	}
	if counters[dayCounterSendsFailed] != 1 {
		t.Errorf("%s = %d, want 1", dayCounterSendsFailed, counters[dayCounterSendsFailed])
	}
	if got := repo.counters["inst_1"][runtimeCounterSendOk]; got != 1 {
		t.Errorf("%s = %d, want 1", runtimeCounterSendOk, got)
	}
	if got := repo.counters["inst_1"][runtimeCounterSendFailed]; got != 1 {
		t.Errorf("%s = %d, want 1", runtimeCounterSendFailed, got)
	}
}

// ---- groups --------------------------------------------------------------

// `groups` describes the membership the last sync observed, so it is a gauge
// and not a tally: adding the snapshot's size on every pass would grow with the
// number of syncs and answer nothing.
func TestRecordGroupsSetsTheObservedTotal(t *testing.T) {
	stats := &fakeDayCounters{}
	repo := newFakeInstanceRepo()
	mgr := testManagerWithDeps(newFakeGroupStore(), stats, nil)
	mgr.instances = repo

	mgr.recordGroups(context.Background(), "inst_1", 12)
	mgr.recordGroups(context.Background(), "inst_1", 4)

	if got := repo.counters["inst_1"][runtimeCounterGroups]; got != 4 {
		t.Fatalf("%s = %d, want the last snapshot's total", runtimeCounterGroups, got)
	}
	if got := stats.count(); got != 0 {
		t.Fatalf("day bumps = %d, want none: §10 counts groups per instance, not per day", got)
	}
}

// The counter paths run on the event loop, the flush and the dispatcher, and the
// manager is shared with surfaces that wire only some of them (the group-surface
// harness). A missing dependency is a no-op, never a panic.
func TestRecordCountersTolerateMissingDependencies(t *testing.T) {
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.instances = nil

	ctx := context.Background()
	mgr.recordMedia(ctx, MessageDoc{InstanceID: "inst_1", GroupJID: "group_a@g.us"}, Media{Status: MediaStored})
	mgr.recordSend(ctx, "inst_1", "group_a@g.us", true, time.Now())
	mgr.recordGroups(ctx, "inst_1", 3)
}
