package main

import (
	"fmt"
	"slices"
	"time"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// now is the clock seam (docs/architecture-draft.md §14.2): every observation
// timestamp the group path writes is produced here, so tests are deterministic
// without touching the system clock.
var now = time.Now

// GroupState is `observed.state` — the membership lifecycle WhatsApp reports
// (§5.1). A group that disappears from a sync snapshot becomes `left`, it is
// never deleted: the name it had is still useful history.
type GroupState string

const (
	GroupActive    GroupState = "active"
	GroupLeft      GroupState = "left"
	GroupDeleted   GroupState = "deleted"
	GroupSuspended GroupState = "suspended"
)

// SubjectSource is `observed.subjectSource`: which path produced the current
// name. It is what makes a rename auditable when the two paths disagree.
type SubjectSource string

const (
	SubjectFromSync     SubjectSource = "sync"
	SubjectFromEvent    SubjectSource = "event"
	SubjectFromFallback SubjectSource = "fallback"
)

// SyncSource is `observed.lastSyncSource`: the trigger that last refreshed the
// snapshot-owned fields (§6.6.2).
type SyncSource string

const (
	SyncOnConnect SyncSource = "connect"
	SyncOnTimer   SyncSource = "timer"
	SyncOnManual  SyncSource = "manual"
	SyncOnEvent   SyncSource = "event"
	SyncOnMessage SyncSource = "message"
)

// subjectHistoryMax caps the rename ring (§5.1). The history is newest-first;
// the oldest entry falls off rather than growing the document without bound.
const subjectHistoryMax = 20

// SubjectHistoryEntry is one superseded name: what it was, WhatsApp's own stamp
// for it, and who set it. The tags are the §5.1 ring spelling.
type SubjectHistoryEntry struct {
	Name string    `bson:"name"`
	At   time.Time `bson:"at"`
	By   string    `bson:"by"`
}

type GroupMember struct {
	JID          string `bson:"jid"`
	PhoneJID     string `bson:"phoneJid"`
	LID          string `bson:"lid"`
	IsAdmin      bool   `bson:"isAdmin"`
	IsSuperAdmin bool   `bson:"isSuperAdmin"`
	DisplayName  string `bson:"displayName"`
}

// Observed is the worker-owned half of a `groups` document (§5.1) in Go form.
// The BFF's `config.*` is deliberately absent: the worker never writes it. The
// bson tags are the decode spelling of §5.1; the write path spells the same keys
// as dotted `$set` entries in groupstore.go, where the ingest-owned counters are
// filtered out.
type Observed struct {
	Subject               string                `bson:"subject"`
	SubjectSearch         string                `bson:"subjectSearch"`
	SubjectUpdatedAt      time.Time             `bson:"subjectUpdatedAt"`
	SubjectObservedAt     time.Time             `bson:"subjectObservedAt"`
	SubjectSetBy          string                `bson:"subjectSetBy"`
	SubjectSetByLID       string                `bson:"subjectSetByLid"`
	SubjectSource         SubjectSource         `bson:"subjectSource"`
	SubjectHistory        []SubjectHistoryEntry `bson:"subjectHistory"`
	Topic                 string                `bson:"topic"`
	TopicUpdatedAt        time.Time             `bson:"topicUpdatedAt"`
	IsAnnounce            bool                  `bson:"isAnnounce"`
	IsLocked              bool                  `bson:"isLocked"`
	IsEphemeral           bool                  `bson:"isEphemeral"`
	IsDefaultSubGroup     bool                  `bson:"isDefaultSubGroup"`
	ParticipantCount      int                   `bson:"participantCount"`
	ParticipantCountDirty bool                  `bson:"participantCountDirty"`
	Members               []GroupMember         `bson:"members"`
	GroupCreatedAt        time.Time             `bson:"groupCreatedAt"`
	State                 GroupState            `bson:"state"`
	LastActivityAt        time.Time             `bson:"lastActivityAt"`
	MessageCount          int                   `bson:"messageCount"`
	MediaStored           int                   `bson:"mediaStored"`
	LastSyncedAt          time.Time             `bson:"lastSyncedAt"`
	LastSyncSource        SyncSource            `bson:"lastSyncSource"`
	LeftDetectedAt        time.Time             `bson:"leftDetectedAt"`
}

// subjectUpdate is the name state the acceptance rule needs: the value,
// WhatsApp's own stamp, which path produced it, and when we observed it.
type subjectUpdate struct {
	name       string
	setAt      time.Time
	source     SubjectSource
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
		return next.source == SubjectFromSync
	default:
		return false
	}
}

// applyGroupDelta folds one `events.GroupInfo` into the stored observation and
// returns the observed state plus the names of the fields it changed
// (docs/architecture-draft.md §6.6.3). An empty change list means nothing moved
// and the caller must skip the Mongo write entirely — rename storms, membership
// churn and `Promote` noise must not amplify into writes.
//
// It is pure apart from the clock seam: the same inputs always produce the same
// patch, which is what makes the reconcile/rename rules testable without a
// socket (§14.2). The error is a misuse guard for the event handler — a delta
// for a JID that is not a group would otherwise be stored under another
// instance's document.
func applyGroupDelta(cur Observed, evt events.GroupInfo, self types.JID) (Observed, []string, error) {
	if evt.JID.Server != types.GroupServer {
		return cur, nil, fmt.Errorf("group delta for non-group JID %q", evt.JID)
	}
	next := cur
	changes := make([]string, 0, 4)

	if evt.Name != nil {
		applySubjectDelta(&next, cur, evt.JID, evt.Name, &changes)
	}
	switch {
	case evt.Delete != nil && evt.Delete.Deleted:
		next.setState(GroupDeleted, &changes)
	case containsJID(evt.Leave, self):
		next.setState(GroupLeft, &changes)
	case len(evt.Join) > 0 && next.State != GroupActive:
		next.setState(GroupActive, &changes)
	}
	// Suspended/Unsuspended arrive as their own child elements and win over the
	// membership inference above: they describe the group, not our membership.
	if evt.Suspended {
		next.setState(GroupSuspended, &changes)
	}
	if evt.Unsuspended {
		next.setState(GroupActive, &changes)
	}
	if (len(evt.Join)+len(evt.Leave)+len(evt.Promote)+len(evt.Demote)) > 0 && !next.ParticipantCountDirty {
		// Deltas never compute a count: the next sync or GetGroupInfo sets it
		// authoritatively, and the flag is what tells that path the stored one
		// is now wrong.
		next.ParticipantCountDirty = true
		changes = append(changes, "participantCountDirty")
	}
	if evt.Announce != nil && next.IsAnnounce != evt.Announce.IsAnnounce {
		next.IsAnnounce = evt.Announce.IsAnnounce
		changes = append(changes, "announce")
	}
	if evt.Locked != nil && next.IsLocked != evt.Locked.IsLocked {
		next.IsLocked = evt.Locked.IsLocked
		changes = append(changes, "locked")
	}
	if evt.Ephemeral != nil && next.IsEphemeral != evt.Ephemeral.IsEphemeral {
		next.IsEphemeral = evt.Ephemeral.IsEphemeral
		changes = append(changes, "ephemeral")
	}
	if evt.Topic != nil && !evt.Topic.TopicDeleted &&
		(evt.Topic.Topic != next.Topic || !evt.Topic.TopicSetAt.Equal(next.TopicUpdatedAt)) {
		next.Topic = evt.Topic.Topic
		next.TopicUpdatedAt = evt.Topic.TopicSetAt
		changes = append(changes, "topic")
	}
	return next, changes, nil
}

// applySubjectDelta applies §6.6.4 to one rename, recording the previous name in
// the capped history. The ordering rule accepts a replayed rename, but a replay
// is not an observable change: when the name and WhatsApp's stamp are the same
// as what we stored, nothing is patched, so the caller skips the write (§6.6.3).
func applySubjectDelta(next *Observed, cur Observed, jid types.JID, name *types.GroupName, changes *[]string) {
	setBy, setByLID := subjectProvenance(name)
	candidate := subjectUpdate{
		name: name.Name, setAt: name.NameSetAt,
		source: SubjectFromEvent, observedAt: now(),
	}
	// An empty subject is a parse artifact, never a rename: it must not wipe a
	// name we already know.
	if candidate.name == "" {
		return
	}
	if !acceptSubject(subjectUpdate{
		name: cur.Subject, setAt: cur.SubjectUpdatedAt,
		source: cur.SubjectSource, observedAt: cur.SubjectObservedAt,
	}, candidate) {
		// Rejected renames are logged rather than silently dropped: a WhatsApp
		// ordering quirk must be visible (§6.6.4).
		logf("group %s: rejected stale subject %q (set at %s)", jid, candidate.name, candidate.setAt)
		return
	}
	if candidate.name == cur.Subject && candidate.setAt.Equal(cur.SubjectUpdatedAt) {
		return
	}
	if candidate.name != cur.Subject && cur.Subject != "" {
		next.SubjectHistory = appendSubjectHistory(cur.SubjectHistory, SubjectHistoryEntry{
			Name: cur.Subject, At: cur.SubjectUpdatedAt, By: cur.SubjectSetBy,
		})
	}
	next.Subject = candidate.name
	next.SubjectSearch = foldText(candidate.name)
	next.SubjectUpdatedAt = candidate.setAt
	next.SubjectObservedAt = candidate.observedAt
	next.SubjectSetBy = setBy
	next.SubjectSetByLID = setByLID
	next.SubjectSource = candidate.source
	*changes = append(*changes, "subject")
}

// subjectProvenance normalizes "who renamed this" to the PN the UI shows, while
// keeping the raw LID: WhatsApp may address the renamer by LID, and the LID is
// the only identity we can resolve later (§5.1).
func subjectProvenance(name *types.GroupName) (pn, lid string) {
	by := name.NameSetBy
	if by.IsEmpty() {
		return "", ""
	}
	if by.Server == types.HiddenUserServer {
		if !name.NameSetByPN.IsEmpty() {
			return name.NameSetByPN.String(), by.String()
		}
		return "", by.String()
	}
	return by.String(), ""
}

// appendSubjectHistory pushes an entry onto the newest-first rename ring and
// caps it, so a group renamed every day does not grow its document forever.
func appendSubjectHistory(history []SubjectHistoryEntry, entry SubjectHistoryEntry) []SubjectHistoryEntry {
	if len(history) > 0 && history[0].Name == entry.Name && history[0].At.Equal(entry.At) {
		return history
	}
	grown := make([]SubjectHistoryEntry, 0, len(history)+1)
	grown = append(grown, entry)
	grown = append(grown, history...)
	if len(grown) > subjectHistoryMax {
		grown = grown[:subjectHistoryMax]
	}
	return grown
}

// setState records a membership transition, counting it only when it moves.
func (o *Observed) setState(state GroupState, changes *[]string) {
	if o.State == state {
		return
	}
	o.State = state
	*changes = append(*changes, "state")
}

// containsJID reports whether want is among jids, comparing device-less
// addresses: the same account is addressed as `…:12@s.whatsapp.net` by one
// device and `…@s.whatsapp.net` by another, and "we were removed" must not
// depend on which one the server happened to name.
func containsJID(jids []types.JID, want types.JID) bool {
	return slices.ContainsFunc(jids, func(jid types.JID) bool {
		return jid.ToNonAD() == want.ToNonAD()
	})
}
