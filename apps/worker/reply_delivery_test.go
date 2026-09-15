package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The reply callback carries a job the BFF answers by running a model call, so
// it outlives any sane request deadline: the old 15s cut the connection while
// the BFF was still working, which left the run stranded in `processing` and the
// owner without an answer. This is the floor that made it a bug.
func TestReplyCallbackDeadlineOutlivesAModelCall(t *testing.T) {
	if replyCallbackTimeout < 60*time.Second {
		t.Fatalf("replyCallbackTimeout = %s; a model call does not fit in it", replyCallbackTimeout)
	}
}

// The callback runs off the ingest flush path. Waiting for a model call inside
// that flush would stall every later message behind one reply, so delivery must
// return immediately and land the request in the background.
func TestReplyCallbackDoesNotBlockTheFlush(t *testing.T) {
	release := make(chan struct{})
	arrived := make(chan map[string]any, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode callback body: %v", err)
		}
		arrived <- body
		<-release // hold the response, the way a model call does
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	defer close(release)

	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.cfg.ReplyCallbackURL = srv.URL
	mgr.cfg.ReplyCallbackSecret = "secret"

	done := make(chan struct{})
	go func() {
		defer close(done)
		mgr.deliverSavedReplies([]MessageDoc{{
			OrganizationID:     "org_default",
			InstanceID:         "inst_1",
			GroupJID:           "120363043123456789@g.us",
			IsGroup:            true,
			WaMessageID:        "3EB0SLOWCALLBACK",
			AutoReplyCandidate: true,
		}})
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("deliverSavedReplies waited for the callback instead of returning to the flush")
	}

	select {
	case body := <-arrived:
		if body["waMessageId"] != "3EB0SLOWCALLBACK" {
			t.Errorf("callback carried %v, want the candidate message", body["waMessageId"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the callback was never sent")
	}
}

// A non-candidate is never sent, and a candidate list with nothing in it must
// not leave a goroutine or a request behind.
func TestReplyCallbackSkipsNonCandidates(t *testing.T) {
	requests := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests <- struct{}{}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.cfg.ReplyCallbackURL = srv.URL
	mgr.cfg.ReplyCallbackSecret = "secret"

	mgr.deliverSavedReplies([]MessageDoc{{OrganizationID: "org_default", InstanceID: "inst_1", WaMessageID: "3EB0PLAIN"}})

	select {
	case <-requests:
		t.Fatal("a message that is not a reply candidate produced a callback")
	case <-time.After(500 * time.Millisecond):
	}
}
