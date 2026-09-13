package main

import (
	"testing"
	"time"
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
