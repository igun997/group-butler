package main

import (
	"context"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// testManagerForLifecycle builds a manager whose instance repo, auth store and
// whatsmeow client are fakes, so a lifecycle event can be observed end to end
// without Mongo, SQLite or a socket.
func testManagerForLifecycle(repo instanceRepo, devices deviceStore, client whatsmeowClient) *manager {
	mgr := newManager(testConfig(), newFakeGroupStore(), repo, newFakePairingStore(), nil, devices)
	mgr.newClient = func(*store.Device, waLog.Logger) whatsmeowClient { return client }
	return mgr
}

func runLifecycle(t *testing.T, mgr *manager) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); mgr.lifecycle.run(ctx, mgr) }()
	t.Cleanup(func() {
		cancel()
		<-done
	})
}

// TestConnectedIsRoutedOffTheCallback is the blocker-1 proof for the connected
// transition: the callback may flip in-memory state (lookups depend on it) but
// must not touch the instance row itself.
func TestConnectedIsRoutedOffTheCallback(t *testing.T) {
	repo := newFakeInstanceRepo()
	devices := &fakeDeviceStore{device: &store.Device{}}
	client := newFakeClient()
	mgr := testManagerForLifecycle(repo, devices, client)
	s := testSession(mgr, client)
	mgr.put(s)

	handleEvent(s, &events.Connected{})

	if ops := repo.opLog(); len(ops) != 0 {
		t.Fatalf("the callback wrote to mongo inline: %v", ops)
	}
	if snap := s.snapshot(); snap.Status != stateConnected {
		t.Fatalf("in-memory status = %q, want connected so lookups work immediately", snap.Status)
	}
	if mgr.lifecycle.Depth() != 1 {
		t.Fatalf("lifecycle depth = %d, want the connected transition queued", mgr.lifecycle.Depth())
	}

	runLifecycle(t, mgr)
	waitFor(t, "the connected transition to be persisted", func() bool {
		for _, op := range repo.opLog() {
			if op == "setConnected" {
				return true
			}
		}
		return false
	})
	if q := mgr.lifecycle; q.Failed() != 0 {
		t.Errorf("lifecycle failed = %d, want 0", q.Failed())
	}
}

// TestLoggedOutIsRoutedOffTheCallbackAndDeletesTheDevice proves the permanent
// unlink does its Mongo and SQLite work off the event loop, while still
// releasing the live session immediately.
func TestLoggedOutIsRoutedOffTheCallbackAndDeletesTheDevice(t *testing.T) {
	deviceJID := types.NewJID("628990000009:5", types.DefaultUserServer)
	repo := newFakeInstanceRepo()
	devices := &fakeDeviceStore{device: &store.Device{ID: &deviceJID}}
	client := newFakeClient()
	mgr := testManagerForLifecycle(repo, devices, client)
	s := testSession(mgr, client)
	mgr.put(s)

	handleEvent(s, &events.LoggedOut{})

	if mgr.get("inst_1") != nil {
		t.Fatal("the live session must be released before the callback returns")
	}
	if ops := repo.opLog(); len(ops) != 0 {
		t.Fatalf("the callback wrote to mongo inline: %v", ops)
	}
	devices.mu.Lock()
	deleted := len(devices.deleted)
	devices.mu.Unlock()
	if deleted != 0 {
		t.Fatal("the callback deleted the auth device inline")
	}
	client.mu.Lock()
	disconnects := client.disconnects
	client.mu.Unlock()
	if disconnects == 0 {
		t.Error("logged out must disconnect the client")
	}

	runLifecycle(t, mgr)
	waitFor(t, "the device to be deleted off the callback", func() bool {
		devices.mu.Lock()
		defer devices.mu.Unlock()
		return len(devices.deleted) == 1
	})
	waitFor(t, "the logged-out status to be persisted", func() bool {
		for _, op := range repo.opLog() {
			if op == "setStatus:logged_out" {
				return true
			}
		}
		return false
	})
}

// TestLifecycleQueuePreservesEventOrder is the ordering proof: a connected
// transition followed immediately by a logout must be applied in that order, so
// the persisted row ends logged_out and never regresses to connected.
func TestLifecycleQueuePreservesEventOrder(t *testing.T) {
	repo := newFakeInstanceRepo()
	devices := &fakeDeviceStore{device: &store.Device{}}
	client := newFakeClient()
	mgr := testManagerForLifecycle(repo, devices, client)
	s := testSession(mgr, client)

	mgr.enqueueLifecycle(instanceConnectedJob{session: s})
	mgr.enqueueLifecycle(instanceStatusJob{instanceID: s.id, status: stateLoggedOut})

	runLifecycle(t, mgr)

	want := []string{"setConnected", "setStatus:logged_out"}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		ops := repo.opLog()
		if len(ops) >= len(want) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if ops := repo.opLog(); len(ops) != len(want) || ops[0] != want[0] || ops[1] != want[1] {
		t.Fatalf("lifecycle ops = %v, want %v (single consumer must preserve order)", ops, want)
	}
}

// TestConnectedThenLoggedOutEndsLoggedOut pins the observable consequence of
// that order, not just the call order.
func TestConnectedThenLoggedOutEndsLoggedOut(t *testing.T) {
	repo := newFakeInstanceRepo()
	devices := &fakeDeviceStore{device: &store.Device{}}
	client := newFakeClient()
	mgr := testManagerForLifecycle(repo, devices, client)
	s := testSession(mgr, client)
	mgr.put(s)

	handleEvent(s, &events.Connected{})
	handleEvent(s, &events.LoggedOut{})

	runLifecycle(t, mgr)
	waitFor(t, "the final status to be logged_out", func() bool {
		repo.mu.Lock()
		defer repo.mu.Unlock()
		return repo.statuses["inst_1"] == stateLoggedOut && repo.connected["inst_1"]
	})
}
