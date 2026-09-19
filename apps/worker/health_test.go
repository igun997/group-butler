package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func healthBody(t *testing.T, a *api) (int, healthResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	a.routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	var body healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode health: %v (body=%s)", err, rec.Body.String())
	}
	return rec.Code, body
}

func TestHealthReportsMongoAndQueueState(t *testing.T) {
	queue := newIngestQueue(4, 0, 0)
	queue.Enqueue(MessageDoc{WaMessageID: "3EB0HEALTH"})
	a := &api{
		secret: "dev-secret",
		ping:   func(context.Context) error { return nil },
		queue:  queue,
	}

	code, body := healthBody(t, a)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	if !body.OK || body.Mongo != "ok" {
		t.Errorf("body = %+v, want ok with mongo ok", body)
	}
	if body.Queue.Depth != 1 || body.Queue.Capacity != 4 {
		t.Errorf("queue = %+v, want depth 1 of capacity 4", body.Queue)
	}
	if body.Queue.Stopped {
		t.Error("queue reported stopped while it is running")
	}
}

func TestHealthIsUnavailableWhenMongoIsDown(t *testing.T) {
	a := &api{
		secret: "dev-secret",
		ping:   func(context.Context) error { return errors.New("no primary") },
		queue:  newIngestQueue(4, 0, 0),
	}

	code, body := healthBody(t, a)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when the database cannot be pinged", code)
	}
	if body.OK {
		t.Error("ok = true with an unreachable database")
	}
	if body.Mongo != "error" {
		t.Errorf("mongo = %q, want error", body.Mongo)
	}
}

func TestHealthIsUnavailableWhenTheIngestQueueStopped(t *testing.T) {
	queue := newIngestQueue(4, 0, 0)
	queue.stop()
	a := &api{
		secret: "dev-secret",
		ping:   func(context.Context) error { return nil },
		queue:  queue,
	}

	code, body := healthBody(t, a)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when ingest has stopped", code)
	}
	if body.OK || !body.Queue.Stopped {
		t.Errorf("body = %+v, want not-ok and stopped queue", body)
	}
}
