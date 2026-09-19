package main

import (
	"context"
	"net/http"
	"testing"
)

// The timer-driven reconcile is the offline-rename safety net, and it is the only
// scheduled loop left that touches the group read model. These tests drive the
// loop with a ticker a test controls, against a real bridge server, so a pass is
// proved by the call the worker made and the rows it wrote.

func TestGroupSyncSchedulerSyncsOnTick(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, groupsAnswer(bridgeGroup("120363043000000001", "A", 3)))
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.bridge = bridge.client(t)
	mgr.cfg.HermesInstanceID = "inst_hermes"
	ticker := newManualTicker()
	mgr.newTicker = ticker.new

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); mgr.runGroupSyncScheduler(ctx) }()
	defer func() {
		cancel()
		<-done
	}()

	ticker.tick()
	waitFor(t, "the interval sync to ask the bridge for the group list", func() bool {
		return len(bridge.recorded()) > 0
	})
	if call := bridge.recorded()[0]; call.path != "/groups" || call.method != http.MethodGet {
		t.Errorf("the scheduler asked %s %s, want GET /groups", call.method, call.path)
	}
}

// A worker assembled without a bridge address has nothing to ask: the pass must
// report the failure rather than record an empty membership.
func TestGroupSyncSchedulerReportsAMissingBridge(t *testing.T) {
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	if mgr.bridge != nil {
		t.Fatal("this worker was built with a bridge it was not configured for")
	}
	if err := mgr.runGroupSyncOnce(context.Background(), SyncOnTimer); err == nil {
		t.Fatal("a sync with no bridge must be reported as a failure")
	}
}

// A sync's number describes the membership the snapshot held, so only a snapshot
// that arrived moves it: a refused call must leave the last observed total
// standing, never record the refusal as an empty membership (§6.6.5, R11).
func TestGroupSyncRecordsTheGroupsAPassObserved(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, groupsAnswer(
		bridgeGroup("120363043123456789", "Ops Team", 12),
		bridgeGroup("120363043000000001", "Ops Team Two", 5),
	))
	stats := &fakeDayCounters{}
	repo := newFakeInstanceRepo()
	mgr := testManagerWithDeps(newFakeGroupStore(), stats, repo)
	mgr.bridge = bridge.client(t)
	mgr.cfg.HermesInstanceID = "inst_hermes"

	if err := mgr.runGroupSyncOnce(context.Background(), SyncOnTimer); err != nil {
		t.Fatalf("runGroupSyncOnce: %v", err)
	}
	if got := repo.groupSync["inst_hermes"].GroupsObserved; got != 2 {
		t.Fatalf("groupsObserved = %d, want the 2 groups the snapshot held", got)
	}

	bridge.refusing("rate-overlimit")
	if err := mgr.runGroupSyncOnce(context.Background(), SyncOnTimer); err == nil {
		t.Fatal("a refused sync must be reported")
	}
	if got := repo.groupSync["inst_hermes"].GroupsObserved; got != 2 {
		t.Errorf("groupsObserved = %d, want the last snapshot's total", got)
	}
	if got := repo.groupSyncError["inst_hermes"]; got == "" {
		t.Error("a refused sync must record why it failed")
	}
	if got := stats.count(); got != 0 {
		t.Errorf("day bumps = %d, want none: §10 keeps groups per instance, not per day", got)
	}
}

// A tick has to reach the operator, not just the work: this is the wiring the
// console reads, and a refactor that kept syncing without recording would leave
// /scheduler claiming the loop never ran.
func TestGroupSyncSchedulerRecordsThePassItRan(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, groupsAnswer())
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.bridge = bridge.client(t)
	ticker := newManualTicker()
	mgr.newTicker = ticker.new

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); mgr.runGroupSyncScheduler(ctx) }()
	defer func() {
		cancel()
		<-done
	}()

	// The loop declares itself as it starts, which is inside its goroutine, so the
	// registry is empty for a moment. Waiting for the declaration is the honest
	// assertion: the endpoint can be read at any time, including that moment.
	waitFor(t, "the loop to declare itself", func() bool {
		loops := mgr.loops.snapshot()
		return len(loops) == 1 && loops[0].Name == loopGroupSync && loops[0].Runs == 0
	})

	ticker.tick()
	waitFor(t, "the pass to be recorded", func() bool {
		loops := mgr.loops.snapshot()
		return len(loops) == 1 && loops[0].Runs == 1
	})

	got := mgr.loops.snapshot()[0]
	if got.IntervalMs != mgr.cfg.GroupSyncInterval.Milliseconds() {
		t.Fatalf("interval = %d, want the configured one", got.IntervalMs)
	}
	if got.LastRunAt == nil {
		t.Fatal("a recorded pass must carry when it happened")
	}
	if got.LastError != "" {
		t.Fatalf("last error = %q, want a clean pass", got.LastError)
	}
}

// A clean pass must actually clear the ticker it registered: a loop that left its
// ticker running would keep firing after shutdown.
func TestGroupSyncSchedulerStopsItsTickerOnExit(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, groupsAnswer())
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.bridge = bridge.client(t)
	ticker := newManualTicker()
	mgr.newTicker = ticker.new

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); mgr.runGroupSyncScheduler(ctx) }()
	waitFor(t, "the scheduler to stop", func() bool {
		cancel()
		select {
		case <-done:
			return true
		default:
			return false
		}
	})
	if !ticker.stopped() {
		t.Error("the scheduler left its ticker running")
	}
}
