package main

import (
	"sync"
	"time"
)

// The loops this worker runs on a timer. Each declares itself with its interval
// when it starts, so `/scheduler` reports what is actually running rather than a
// list maintained somewhere else that can drift.
const (
	loopGroupSync     = "group-sync"
	loopMediaJanitor  = "media-janitor"
	loopSendDispatch  = "send-dispatch"
	loopMemoryBatches = "memory-batches"
)

// loopReport is one scheduled loop as the console shows it: what it is, how often
// it runs, and what happened on its last pass. `LastRunAt` is a pointer so "never
// ran" survives JSON as null instead of pretending to be the zero time.
type loopReport struct {
	Name       string     `json:"name"`
	IntervalMs int64      `json:"intervalMs"`
	LastRunAt  *time.Time `json:"lastRunAt"`
	LastError  string     `json:"lastError"`
	Runs       int64      `json:"runs"`
}

// loopRegistry is where a scheduled loop writes down its last pass. The loops run
// on their own tickers and until now nothing recorded whether they had ever run,
// succeeded or failed (§6.5 reports queues, not cadences).
type loopRegistry struct {
	mu    sync.Mutex
	order []string
	state map[string]*loopReport
}

func newLoopRegistry() *loopRegistry {
	return &loopRegistry{state: map[string]*loopReport{}}
}

// declare names a loop and its cadence before the first pass, so a loop that has
// not run yet is visible with "never" as its last run rather than absent.
func (r *loopRegistry) declare(name string, interval time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ensure(name).IntervalMs = interval.Milliseconds()
}

// pass records one completed pass. It is called after the work rather than when
// the ticker fires, so `runs` counts passes that finished and `lastRunAt` is when
// the loop last did something, not when it was woken.
func (r *loopRegistry) pass(name string, at time.Time, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	entry := r.ensure(name)
	stamp := at.UTC()
	entry.LastRunAt = &stamp
	entry.Runs++
	if err != nil {
		entry.LastError = err.Error()
		return
	}
	entry.LastError = ""
}

func (r *loopRegistry) snapshot() []loopReport {
	r.mu.Lock()
	defer r.mu.Unlock()

	out := make([]loopReport, 0, len(r.order))
	for _, name := range r.order {
		out = append(out, *r.state[name])
	}
	return out
}

// ensure returns a loop's entry, adding it on first mention. A pass from a loop
// nobody declared is recorded rather than dropped: a forgotten declaration must
// not be the reason a running loop is invisible.
func (r *loopRegistry) ensure(name string) *loopReport {
	if entry, ok := r.state[name]; ok {
		return entry
	}
	entry := &loopReport{Name: name}
	r.state[name] = entry
	r.order = append(r.order, name)
	return entry
}
