package main

import (
	"context"
	"fmt"
	"slices"
	"time"

	"go.mau.fi/whatsmeow/types"
)

// groupClient is the whatsmeow surface the group paths need (§14.2). The ISP
// round trips live behind it so reconciliation and repair are provable without a
// socket, a live account or an event loop; *whatsmeow.Client satisfies it as-is.
type groupClient interface {
	GetJoinedGroups(ctx context.Context) ([]*types.GroupInfo, error)
	GetGroupInfo(ctx context.Context, jid types.JID) (*types.GroupInfo, error)
}

// SyncSummary is the §6.6.6 report of one full sync: what the snapshot held and
// what it changed. `Unchanged` is the write-amplification witness — a steady
// state must not look like work. The JSON tags are the wire spelling the BFF
// mirrors in `packages/shared`.
type SyncSummary struct {
	Source          SyncSource `json:"source"`
	DurationMs      int64      `json:"durationMs"`
	Total           int        `json:"total"`
	Added           int        `json:"added"`
	SubjectUpdated  int        `json:"subjectUpdated"`
	MetadataUpdated int        `json:"metadataUpdated"`
	MarkedLeft      int        `json:"markedLeft"`
	SubjectRejected int        `json:"subjectRejected"`
	Unchanged       int        `json:"unchanged"`
	// GroupsLeft is the stored gauge this pass leaves behind — how many groups
	// the instance is known to have left — not a count of this pass's changes,
	// which is `MarkedLeft`. It is persisted to `runtime.groupSync.groupsLeft`
	// and is deliberately not on the wire, so the §6.6.6 JSON contract every BFF
	// parses is unchanged.
	GroupsLeft int `json:"-"`
}

// runGroupSync performs the authoritative membership snapshot (§6.6.5):
//
//  1. one GetJoinedGroups call (no pagination: it returns every group);
//  2. every returned group is merged into its stored observation and upserted;
//  3. stored groups the instance is still believed to be in but that the
//     response does not mention are marked `left`, keeping their name;
//  4. a failed call writes nothing about membership at all — a timed-out IQ must
//     never look like "we left every group". The caller records
//     `runtime.groupSync.lastError` and backs off; this function only reports.
//
// `prune` is GROUP_SYNC_PRUNE: operators can keep rule 3 off entirely.
func runGroupSync(ctx context.Context, client groupClient, store groupStoreAPI, orgID, instanceID string, source SyncSource, prune bool) (SyncSummary, error) {
	started := now()
	summary := SyncSummary{Source: source}
	finish := func() SyncSummary {
		summary.DurationMs = now().Sub(started).Milliseconds()
		return summary
	}

	groups, err := client.GetJoinedGroups(ctx)
	if err != nil {
		return finish(), fmt.Errorf("group sync: get joined groups: %w", err)
	}
	// One timestamp for the whole snapshot: a sync's writes must agree on when
	// they were observed, or the staleness thresholds measure our own loop.
	stored, err := store.loadObserved(ctx, orgID, instanceID)
	if err != nil {
		return finish(), err
	}

	at := now().UTC()
	returned := make(map[string]bool, len(groups))
	for _, info := range groups {
		if info == nil || info.JID.Server != types.GroupServer {
			// A membership snapshot can only contain groups; anything else is a
			// parser surprise and must not become a document.
			continue
		}
		jid := info.JID.String()
		returned[jid] = true
		cur, exists := stored[jid]
		merged, changes, rejected := mergeSnapshot(cur, info, source, at)
		if rejected {
			summary.SubjectRejected++
		}
		summary.Total++
		switch {
		case !exists:
			summary.Added++
		case slices.Contains(changes, "subject"):
			summary.SubjectUpdated++
		case len(changes) > 0:
			summary.MetadataUpdated++
		default:
			summary.Unchanged++
		}
		if err := store.UpsertObserved(ctx, orgID, instanceID, jid, merged, true); err != nil {
			return finish(), err
		}
	}
	if prune {
		// The baseline is read only after the snapshot succeeded: deriving
		// absence from a half-applied sync would mark groups left that simply
		// came later in the response.
		baseline, err := store.KnownGroupJIDs(ctx, orgID, instanceID)
		if err != nil {
			return finish(), err
		}
		for _, jid := range baseline {
			if returned[jid] {
				continue
			}
			if err := store.MarkLeft(ctx, orgID, instanceID, jid, GroupLeft); err != nil {
				return finish(), err
			}
			summary.MarkedLeft++
		}
	}
	// The stored gauge is read last, after any absence reconciliation, so it
	// describes the state this pass leaves behind rather than the one it found.
	left, err := store.CountLeft(ctx, orgID, instanceID)
	if err != nil {
		return finish(), err
	}
	summary.GroupsLeft = left
	return finish(), nil
}

// mergeSnapshot folds one authoritative snapshot entry into the stored
// observation, and reports the fields it changed plus whether the snapshot's
// name had to be refused as stale (§6.6.5 rule 1).
//
// The snapshot owns membership and metadata outright, so those are refreshed
// wholesale. The name is different: a snapshot can be older than a rename event
// that arrived first, so it goes through the same ordering rule as an event
// (§6.6.4). The ingest-owned counters are carried over from the stored
// observation, because a snapshot carries no traffic counts and inventing zeroes
// would erase them.
func mergeSnapshot(cur Observed, info *types.GroupInfo, source SyncSource, at time.Time) (Observed, []string, bool) {
	snap := ObservedFromGroupInfo(info, source, at)
	next := cur
	changes := make([]string, 0, 8)
	rejected := false

	if snap.Subject != "" {
		// A snapshot is a "sync" observation: it is fetched later than any
		// unstamped value we hold, which is what acceptSubject grants.
		accepted := acceptSubject(
			subjectUpdate{name: cur.Subject, setAt: cur.SubjectUpdatedAt, source: cur.SubjectSource, observedAt: cur.SubjectObservedAt},
			subjectUpdate{name: snap.Subject, setAt: snap.SubjectUpdatedAt, source: SubjectFromSync, observedAt: at},
		)
		switch {
		case !accepted:
			rejected = true
		case snap.Subject != cur.Subject || !snap.SubjectUpdatedAt.Equal(cur.SubjectUpdatedAt) || cur.SubjectSource == SubjectFromFallback:
			if snap.Subject != cur.Subject && cur.Subject != "" {
				next.SubjectHistory = appendSubjectHistory(cur.SubjectHistory, SubjectHistoryEntry{
					Name: cur.Subject, At: cur.SubjectUpdatedAt, By: cur.SubjectSetBy,
				})
			}
			next.Subject = snap.Subject
			next.SubjectSearch = snap.SubjectSearch
			next.SubjectUpdatedAt = snap.SubjectUpdatedAt
			next.SubjectObservedAt = snap.SubjectObservedAt
			next.SubjectSetBy = snap.SubjectSetBy
			next.SubjectSetByLID = snap.SubjectSetByLID
			next.SubjectSource = snap.SubjectSource
			changes = append(changes, "subject")
		}
	}
	if snap.State != cur.State {
		next.State = snap.State
		changes = append(changes, "state")
	}
	if snap.ParticipantCount != cur.ParticipantCount {
		next.ParticipantCount = snap.ParticipantCount
		changes = append(changes, "participantCount")
	}
	if cur.ParticipantCountDirty {
		// The snapshot is exactly the authoritative count the dirty flag was
		// waiting for.
		next.ParticipantCountDirty = false
		changes = append(changes, "participantCountDirty")
	}
	if snap.Topic != cur.Topic || !snap.TopicUpdatedAt.Equal(cur.TopicUpdatedAt) {
		next.Topic, next.TopicUpdatedAt = snap.Topic, snap.TopicUpdatedAt
		changes = append(changes, "topic")
	}
	if snap.IsAnnounce != cur.IsAnnounce {
		next.IsAnnounce = snap.IsAnnounce
		changes = append(changes, "announce")
	}
	if snap.IsLocked != cur.IsLocked {
		next.IsLocked = snap.IsLocked
		changes = append(changes, "locked")
	}
	if snap.IsEphemeral != cur.IsEphemeral {
		next.IsEphemeral = snap.IsEphemeral
		changes = append(changes, "ephemeral")
	}
	if snap.IsDefaultSubGroup != cur.IsDefaultSubGroup {
		next.IsDefaultSubGroup = snap.IsDefaultSubGroup
		changes = append(changes, "isDefaultSubGroup")
	}
	if cur.GroupCreatedAt.IsZero() && !snap.GroupCreatedAt.IsZero() {
		// Creation is immutable: it is recorded once and never rewritten.
		next.GroupCreatedAt = snap.GroupCreatedAt
		changes = append(changes, "groupCreatedAt")
	}
	next.LastSyncedAt = snap.LastSyncedAt
	next.LastSyncSource = snap.LastSyncSource
	return next, changes, rejected
}
