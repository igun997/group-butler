package main

import (
	"errors"
	"testing"
	"time"
)

// The console reads this registry to show what the worker does on a timer.
// Nothing else records whether a loop has ever run, succeeded or failed, so
// these assertions are the only place that a loop's pass reaches the operator.

func names(loops []loopReport) []string {
	out := make([]string, 0, len(loops))
	for _, loop := range loops {
		out = append(out, loop.Name)
	}
	return out
}

func TestLoopRegistryReportsEveryDeclaredLoop(t *testing.T) {
	reg := newLoopRegistry()
	reg.declare("group-sync", 30*time.Minute)
	reg.declare("media-janitor", 5*time.Minute)
	reg.declare("send-dispatch", 5*time.Second)

	got := reg.snapshot()

	if len(got) != 3 {
		t.Fatalf("loops = %d, want 3", len(got))
	}
	if names(got)[0] != "group-sync" || names(got)[2] != "send-dispatch" {
		t.Fatalf("order = %v, want declaration order", names(got))
	}
	// A loop that has not run yet says so, rather than claiming a run at the zero time.
	if got[0].Runs != 0 || got[0].LastRunAt != nil {
		t.Fatalf("unrun loop = %+v, want no runs and no last run", got[0])
	}
	if got[0].IntervalMs != (30 * time.Minute).Milliseconds() {
		t.Fatalf("interval = %d, want the declared one", got[0].IntervalMs)
	}
}

func TestLoopRegistryRecordsAPass(t *testing.T) {
	reg := newLoopRegistry()
	reg.declare("media-janitor", 5*time.Minute)
	at := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)

	reg.pass("media-janitor", at, nil)
	reg.pass("media-janitor", at.Add(5*time.Minute), nil)

	got := reg.snapshot()[0]
	if got.Runs != 2 {
		t.Fatalf("runs = %d, want 2", got.Runs)
	}
	if got.LastRunAt == nil || !got.LastRunAt.Equal(at.Add(5*time.Minute)) {
		t.Fatalf("last run = %v, want the most recent pass", got.LastRunAt)
	}
	if got.LastError != "" {
		t.Fatalf("last error = %q, want empty after two clean passes", got.LastError)
	}
}

func TestLoopRegistryReportsTheLastFailure(t *testing.T) {
	reg := newLoopRegistry()
	reg.declare("group-sync", 30*time.Minute)
	at := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)

	reg.pass("group-sync", at, errors.New("iq timeout"))

	got := reg.snapshot()[0]
	if got.LastError != "iq timeout" {
		t.Fatalf("last error = %q, want the failure it reported", got.LastError)
	}
	if got.Runs != 1 {
		t.Fatalf("runs = %d, want the failed pass counted too", got.Runs)
	}

	reg.pass("group-sync", at.Add(time.Minute), nil)

	if after := reg.snapshot()[0]; after.LastError != "" {
		t.Fatalf("last error = %q, want a clean pass to clear the previous failure", after.LastError)
	}
}

// A loop nobody declared still has to appear: a forgotten declaration would
// otherwise make a running loop invisible, which is the state this slice exists
// to end.
func TestLoopRegistryRecordsAPassForAnUndeclaredLoop(t *testing.T) {
	reg := newLoopRegistry()

	reg.pass("late-arrival", time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC), nil)

	got := reg.snapshot()
	if len(got) != 1 || got[0].Name != "late-arrival" || got[0].Runs != 1 {
		t.Fatalf("snapshot = %+v, want the undeclared loop recorded", got)
	}
}
