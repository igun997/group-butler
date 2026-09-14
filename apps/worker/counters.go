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
	dayCounterReceipts       = "receipts"
	dayCounterMessages       = "messages"
	runtimeCounterMessagesIn = "messagesIn"
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

	if m.stats != nil {
		for key, count := range byGroup {
			if err := m.stats.bump(ctx, m.orgID, key.instance, key.group, dayCounterMessages, count, latest[key]); err != nil {
				logf("message counter for %s/%s: %v", key.instance, key.group, err)
			}
		}
	}

	if m.instances != nil {
		for instance, count := range byInstance {
			if err := m.instances.BumpCounters(ctx, m.orgID, instance, map[string]int64{runtimeCounterMessagesIn: count}); err != nil {
				logf("instance counters for %s: %v", instance, err)
			}
		}
	}
}
