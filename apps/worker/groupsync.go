package main

import (
	"context"
	"fmt"
	"slices"
	"time"
)

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
//  1. one `GET /groups` call — every group the linked account participates in.
//     The Hermes bridge asks WhatsApp for it on the account the console uses,
//     which is the same question the worker used to put to its own session;
//  2. every returned group is merged into its stored observation and upserted;
//  3. stored groups the instance is still believed to be in but that the
//     response does not mention are marked `left`, keeping their name;
//  4. a failed call writes nothing about membership at all — an unreachable
//     bridge must never look like "we left every group". The caller records
//     `runtime.groupSync.lastError` and backs off; this function only reports.
//
// `SubjectRejected` is always zero now: the refusal rule exists to keep a
// snapshot that is older than a stored rename from winning, and the bridge's
// contract carries no rename stamp to compare — a `GET /groups` answer is a live
// read of WhatsApp's current state, so it is what the name is (§6.6.4). The
// field stays on the wire because the BFF's schema has it.
//
// `prune` is GROUP_SYNC_PRUNE: operators can keep rule 3 off entirely.
func runGroupSync(ctx context.Context, bridge *hermesBridge, store groupStoreAPI, orgID, instanceID string, source SyncSource, prune bool) (SyncSummary, error) {
	started := now()
	summary := SyncSummary{Source: source}
	finish := func() SyncSummary {
		summary.DurationMs = now().Sub(started).Milliseconds()
		return summary
	}

	groups, err := bridge.Groups(ctx)
	if err != nil {
		return finish(), fmt.Errorf("group sync: list groups: %w", err)
	}
	// One timestamp for the whole snapshot: a sync's writes must agree on when
	// they were observed, or the staleness thresholds measure our own loop.
	stored, err := store.loadObserved(ctx, orgID, instanceID)
	if err != nil {
		return finish(), err
	}

	at := now().UTC()
	returned := make(map[string]bool, len(groups))
	for _, entry := range groups {
		address, err := parseAddress(entry.JID)
		if err != nil || !address.isGroup() {
			// A membership snapshot can only contain groups; anything else is a
			// contract surprise and must not become a document.
			continue
		}
		jid := address.String()
		returned[jid] = true
		cur, exists := stored[jid]
		merged, changes := mergeSnapshot(cur, groupSnapshot{
			JID:              jid,
			Subject:          entry.Subject,
			Announce:         entry.Announce,
			Locked:           entry.Locked,
			ParticipantCount: entry.ParticipantCount,
		}, source, at)
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
// observation and reports the fields it changed.
//
// The snapshot owns membership and metadata outright, so those are refreshed
// wholesale — with one exception. The name is compared rather than copied when it
// is unchanged, because the stamp beside it means "when this name was set" and a
// live read that sees the same name has learnt nothing new about it; a rename we
// have just observed is stamped with the moment we observed it. The previous name
// goes into the capped ring either way (§6.6.4).
//
// Field by field: the bridge's contract carries identity, subject, the two
// switches and the member count, so `topic`, `isEphemeral`, `groupCreatedAt` and
// the membership list keep their stored values — the merge never invents what it
// did not read. The ingest-owned counters are likewise carried over from the
// stored observation, because a snapshot carries no traffic counts and inventing
// zeroes would erase them.
func mergeSnapshot(cur Observed, entry groupSnapshot, source SyncSource, at time.Time) (Observed, []string) {
	snap := observedFromSnapshot(entry, source, at)
	next := cur
	changes := make([]string, 0, 8)

	if snap.Subject != "" && snap.Subject != cur.Subject {
		if cur.Subject != "" {
			next.SubjectHistory = appendSubjectHistory(cur.SubjectHistory, SubjectHistoryEntry{
				Name: cur.Subject, At: cur.SubjectUpdatedAt, By: cur.SubjectSetBy,
			})
		}
		next.Subject = snap.Subject
		next.SubjectSearch = snap.SubjectSearch
		next.SubjectUpdatedAt = at
		next.SubjectObservedAt = at
		next.SubjectSetBy = ""
		next.SubjectSetByLID = ""
		next.SubjectSource = snap.SubjectSource
		changes = append(changes, "subject")
	} else if snap.Subject != "" && cur.SubjectSource == SubjectFromFallback {
		// The name we had was a placeholder (a group first seen through a message
		// that never carried one). Learning the real name is a change, and it
		// keeps the stored stamp: the name has not moved, it has been confirmed.
		next.SubjectSource = snap.SubjectSource
		changes = append(changes, "subject")
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
	if snap.IsAnnounce != cur.IsAnnounce {
		next.IsAnnounce = snap.IsAnnounce
		changes = append(changes, "announce")
	}
	if snap.IsLocked != cur.IsLocked {
		next.IsLocked = snap.IsLocked
		changes = append(changes, "locked")
	}
	next.LastSyncedAt = snap.LastSyncedAt
	next.LastSyncSource = snap.LastSyncSource
	return next, changes
}
