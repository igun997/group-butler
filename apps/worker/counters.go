package main

import (
	"context"
	"time"
)

// The counter names §10 reads. Each is a field under `counters.*` on a day's
// statsDaily row, or on an instance's `runtime.counters`. The same event carries
// two names on purpose: the day row answers "how much happened, here, today", and
// the instance row answers "what has this account seen".
const (
	dayCounterReceipts      = "receipts"
	dayCounterMessagesIn    = "messagesIn"
	dayCounterMediaStored   = "mediaStored"
	dayCounterMediaUnparsed = "mediaUnparsed"
	dayCounterSendsSent     = "sendsSent"
	dayCounterSendsFailed   = "sendsFailed"

	runtimeCounterMessagesIn    = "messagesIn"
	runtimeCounterMediaStored   = "mediaStored"
	runtimeCounterMediaUnparsed = "mediaUnparsed"
	runtimeCounterSendOk        = "sendOk"
	runtimeCounterSendFailed    = "sendFailed"
)

// recordStored writes a flush's new messages into both places §10 reads.
//
// Documents are aggregated before anything is written: a batch that spans
// midnight or several groups costs a handful of updates rather than one per
// message, and the totals are what the two documents actually mean. Only messages
// the store created reach here, so a redelivery changes nothing.
func (m *manager) recordStored(ctx context.Context, docs []MessageDoc) {
	if len(docs) == 0 {
		return
	}

	type groupKey struct {
		day      string
		instance string
		group    string
	}
	byGroup := map[groupKey]int64{}
	latest := map[groupKey]time.Time{}
	byInstance := map[string]int64{}

	for _, doc := range docs {
		at := doc.Timestamp
		if at.IsZero() {
			at = time.Now()
		}
		key := groupKey{day: at.UTC().Format(time.DateOnly), instance: doc.InstanceID, group: doc.GroupJID}
		byGroup[key]++
		if at.After(latest[key]) {
			latest[key] = at
		}
		byInstance[doc.InstanceID]++
	}

	for key, count := range byGroup {
		m.bumpDay(ctx, key.instance, key.group, dayCounterMessagesIn, count, latest[key])
	}
	for instance, count := range byInstance {
		m.bumpRuntime(ctx, instance, map[string]int64{runtimeCounterMessagesIn: count})
	}
}

// recordMedia writes one attachment's outcome into both places §10 reads. Only
// media the pipeline actually holds is counted: `pending` is work not yet done,
// `failed` is work to retry, and `unavailable` is bytes WhatsApp will not give
// us — none of them is a stored attachment, and counting one would report an
// object the bucket does not have (R3).
//
// The stamp is the moment the pipeline resolved the attachment rather than the
// message's own timestamp: this is the work the worker did, so a janitor retry
// of an older message is today's media, not the day that message arrived.
func (m *manager) recordMedia(ctx context.Context, doc MessageDoc, media Media) {
	var dayCounter, runtimeCounter string
	switch media.Status {
	case MediaStored:
		dayCounter, runtimeCounter = dayCounterMediaStored, runtimeCounterMediaStored
	case MediaUnparsed:
		dayCounter, runtimeCounter = dayCounterMediaUnparsed, runtimeCounterMediaUnparsed
	default:
		return
	}
	m.bumpDay(ctx, doc.InstanceID, doc.GroupJID, dayCounter, 1, now())
	m.bumpRuntime(ctx, doc.InstanceID, map[string]int64{runtimeCounter: 1})
}

// recordSend writes one dispatch outcome. Both directions are recorded: a
// console that only learned about the sends that worked would report a success
// rate of 100% (§10).
func (m *manager) recordSend(ctx context.Context, instanceID, groupJID string, ok bool, at time.Time) {
	dayCounter, runtimeCounter := dayCounterSendsFailed, runtimeCounterSendFailed
	if ok {
		dayCounter, runtimeCounter = dayCounterSendsSent, runtimeCounterSendOk
	}
	m.bumpDay(ctx, instanceID, groupJID, dayCounter, 1, at)
	m.bumpRuntime(ctx, instanceID, map[string]int64{runtimeCounter: 1})
}

// recordGroupSync records the membership a successful full sync observed into
// the §5.1 `runtime.groupSync` summary the dashboard reads — `groupsObserved`,
// `groupsLeft` and `lastSyncAt`. It is a gauge rather than a tally: the snapshot
// *is* the membership, so it is set, never added. §10 keeps this per instance,
// not per day.
func (m *manager) recordGroupSync(ctx context.Context, instanceID string, summary SyncSummary) {
	if m.instances == nil {
		return
	}
	if err := m.instances.SetGroupSync(ctx, m.orgID, instanceID, groupSyncState{
		GroupsObserved: summary.Total,
		GroupsLeft:     summary.GroupsLeft,
		LastSyncAt:     now().UTC(),
	}); err != nil {
		logf("group sync summary for %s: %v", instanceID, err)
	}
}

// recordGroupSyncError records that a full sync was refused. It moves only
// `lastError`: a snapshot that never arrived says nothing about membership, so
// the last observed total and stamp stand and a timed-out IQ is never mistaken
// for "we left every group" (§6.6.5 rule 4).
func (m *manager) recordGroupSyncError(ctx context.Context, instanceID, message string) {
	if m.instances == nil {
		return
	}
	if err := m.instances.SetGroupSyncError(ctx, m.orgID, instanceID, message); err != nil {
		logf("group sync error for %s: %v", instanceID, err)
	}
}

// bumpDay adds to one counter on a day's row. A failed statistic is logged
// rather than returned: the event it describes has already happened, and losing
// a message, an attachment or a send because the counter write failed would be
// the statistic costing more than it is worth.
func (m *manager) bumpDay(ctx context.Context, instanceID, groupJID, counter string, count int64, at time.Time) {
	if m.stats == nil {
		return
	}
	if err := m.stats.bump(ctx, m.orgID, instanceID, groupJID, counter, count, at); err != nil {
		logf("%s counter for %s/%s: %v", counter, instanceID, groupJID, err)
	}
}

// bumpRuntime adds to the instance's own live counters (§5.1). It is the same
// tolerance as bumpDay and the same reason.
func (m *manager) bumpRuntime(ctx context.Context, instanceID string, counters map[string]int64) {
	if m.instances == nil {
		return
	}
	if err := m.instances.BumpCounters(ctx, m.orgID, instanceID, counters); err != nil {
		logf("instance counters for %s: %v", instanceID, err)
	}
}
