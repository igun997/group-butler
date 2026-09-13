package main

import "time"

// subjectUpdate is the name state the acceptance rule needs: the value,
// WhatsApp's own stamp, which path produced it, and when we observed it.
type subjectUpdate struct {
	name       string
	setAt      time.Time
	source     string // "sync" | "event" | "fallback"
	observedAt time.Time
}

// acceptSubject decides whether `next` may overwrite `cur` (docs/architecture-draft.md §6.6.4).
// A rename must never regress to a known-older value, and must never be lost
// merely because a sync snapshot arrived without a `s_t` stamp:
//
//	first observation                       -> accept
//	both stamped, next.setAt >= cur.setAt   -> accept (monotonic; equal = replay)
//	next stamped, cur unstamped             -> accept if observed later
//	both unstamped, next is a sync snapshot -> accept (fetched later, by definition)
//	otherwise                               -> reject as stale
func acceptSubject(cur, next subjectUpdate) bool {
	if cur.name == "" && cur.observedAt.IsZero() {
		return true
	}
	curStamped := !cur.setAt.IsZero()
	nextStamped := !next.setAt.IsZero()
	switch {
	case curStamped && nextStamped:
		return !next.setAt.Before(cur.setAt)
	case nextStamped && !curStamped:
		return next.observedAt.After(cur.observedAt)
	case !nextStamped && !curStamped:
		return next.source == "sync"
	default:
		return false
	}
}
