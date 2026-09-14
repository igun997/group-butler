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
		if call.counter != dayCounterMessages {
			t.Fatalf("counter = %q, want %q", call.counter, dayCounterMessages)
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
