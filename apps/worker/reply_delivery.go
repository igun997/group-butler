package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type replyCallbackPayload struct {
	OrganizationID string `json:"organizationId"`
	InstanceID     string `json:"instanceId"`
	GroupJID       string `json:"groupJid"`
	WaMessageID    string `json:"waMessageId"`
}

// deliverSavedReplies runs only after Mongo acknowledged the exact triggering
// message. The deterministic idempotency key in the BFF makes a redelivery safe.
func (m *manager) deliverSavedReplies(docs []MessageDoc) {
	if m.cfg.ReplyCallbackURL == "" {
		return
	}
	for _, doc := range docs {
		if !doc.AutoReplyCandidate {
			continue
		}
		payload, err := json.Marshal(replyCallbackPayload{doc.OrganizationID, doc.InstanceID, doc.GroupJID, doc.WaMessageID})
		if err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.cfg.ReplyCallbackURL, bytes.NewReader(payload))
		if err == nil {
			req.Header.Set("Authorization", "Bearer "+m.cfg.ReplyCallbackSecret)
			req.Header.Set("Content-Type", "application/json")
			resp, callErr := http.DefaultClient.Do(req)
			if callErr != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
				if resp != nil {
					_ = resp.Body.Close()
				}
				logf("automatic reply callback for %s failed: %v", doc.WaMessageID, callErr)
			} else {
				_ = resp.Body.Close()
			}
		} else {
			logf("automatic reply callback request for %s: %v", doc.WaMessageID, fmt.Errorf("%w", err))
		}
		cancel()
	}
}
