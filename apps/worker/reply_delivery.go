package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// replyCallbackPayload is what the BFF needs to resolve one triggering message.
// `groupJid` is the chat the message belongs to: a group JID for a group
// message, and the owner's own JID for a direct one, which `isGroup` tells
// apart — the BFF resolves a group row in the first case and a chat in the
// second.
type replyCallbackPayload struct {
	OrganizationID string `json:"organizationId"`
	InstanceID     string `json:"instanceId"`
	GroupJID       string `json:"groupJid"`
	WaMessageID    string `json:"waMessageId"`
	IsGroup        bool   `json:"isGroup"`
}

// replyCallbackTimeout bounds one reply-job callback.
//
// This is a model-call deadline, not a request deadline: the BFF answers a job
// by assembling a prompt and calling the model, so a healthy round trip runs
// from a few seconds to tens of seconds. A shorter deadline does not fail fast —
// it cuts the connection while the BFF is still working, which strands the run
// in `processing` and leaves the owner with no answer at all.
var replyCallbackTimeout = 120 * time.Second

// deliverSavedReplies runs only after Mongo acknowledged the exact triggering
// message. The deterministic idempotency key in the BFF makes a redelivery safe.
//
// Delivery is deliberately run off the caller's path: this is the ingest flush,
// and waiting here for a model call would stall every later message behind one
// reply. One goroutine per flush — sequential inside it — keeps the batch from
// stampeding the BFF while leaving ingestion unblocked.
func (m *manager) deliverSavedReplies(docs []MessageDoc) {
	if m.cfg.ReplyCallbackURL == "" {
		return
	}
	candidates := make([]MessageDoc, 0, len(docs))
	for _, doc := range docs {
		if doc.AutoReplyCandidate {
			candidates = append(candidates, doc)
		}
	}
	if len(candidates) == 0 {
		return
	}
	go func() {
		for _, doc := range candidates {
			m.deliverReplyCallback(doc)
		}
	}()
}

// deliverReplyCallback posts one job and logs what came of it. The BFF is the
// only authority on the outcome: a non-2xx is reported as it arrived, because
// guessing at what it means here would hide a real refusal.
func (m *manager) deliverReplyCallback(doc MessageDoc) {
	payload, err := json.Marshal(replyCallbackPayload{
		OrganizationID: doc.OrganizationID,
		InstanceID:     doc.InstanceID,
		GroupJID:       doc.GroupJID,
		WaMessageID:    doc.WaMessageID,
		IsGroup:        doc.IsGroup,
	})
	if err != nil {
		logf("automatic reply callback for %s could not be encoded: %v", doc.WaMessageID, err)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), replyCallbackTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.cfg.ReplyCallbackURL, bytes.NewReader(payload))
	if err != nil {
		logf("automatic reply callback request for %s: %v", doc.WaMessageID, err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+m.cfg.ReplyCallbackSecret)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		logf("automatic reply callback for %s failed: %v", doc.WaMessageID, err)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		logf("automatic reply callback for %s was refused: HTTP %d", doc.WaMessageID, resp.StatusCode)
	}
}
