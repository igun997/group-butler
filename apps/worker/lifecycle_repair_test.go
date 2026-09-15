package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

// repairInstance is one persisted instance in a state a re-pair has to fix.
func repairInstance(id string, status sessionState) InstanceRow {
	return InstanceRow{
		ID:             id,
		OrganizationID: "org_default",
		Label:          "Bot " + id,
		Mode:           modeQR,
		Status:         status,
		PhoneNumber:    "628990000001",
	}
}

// repairDevice is the auth device behind that row: a registered companion, so
// its JID carries the device suffix the worker has to strip to match the phone.
func repairDevice(phone string) *store.Device {
	jid := types.NewJID(phone+":5", types.DefaultUserServer)
	return &store.Device{ID: &jid}
}

// verifyFixture wires one live session for the check endpoint. The client is the
// only thing that knows the real state, which is what the endpoint is for.
func verifyFixture(t *testing.T, status sessionState, client *fakeClient) (*manager, *fakeInstanceRepo, *session) {
	t.Helper()
	row := repairInstance("inst_1", stateConnected)
	repo := newFakeInstanceRepo(row)
	mgr := testManager(repo, newFakePairingStore(), &fakeDeviceStore{device: repairDevice("628990000001")}, client)
	t.Cleanup(func() { mgr.shutdown(context.Background()) })
	s := newSession(mgr, row, repairDevice("628990000001"), client)
	s.status = status
	mgr.put(s)
	return mgr, repo, s
}

// ---- POST /instances/{id}/pair -------------------------------------------

// A linked account must not be re-paired behind the owner's back: the only way
// to pair a fresh device is to unlink the one WhatsApp already honours, and that
// is DELETE's job.
func TestRepairPairingRefusesAConnectedInstance(t *testing.T) {
	ctx := context.Background()
	row := repairInstance("inst_1", stateConnected)
	client := newFakeClient()
	devices := &fakeDeviceStore{device: repairDevice("628990000001")}
	mgr := testManager(newFakeInstanceRepo(row), newFakePairingStore(), devices, client)
	defer mgr.shutdown(ctx)
	s := newSession(mgr, row, devices.device, client)
	s.status = stateConnected
	mgr.put(s)

	if _, err := mgr.repairPairing(ctx, "inst_1"); !errors.Is(err, errAlreadyConnected) {
		t.Fatalf("err = %v, want errAlreadyConnected (the route answers invalid_state)", err)
	}
	if mgr.get("inst_1") != s {
		t.Error("a refused re-pair must leave the linked session alone")
	}
	if client.logouts != 0 || client.disconnects != 0 {
		t.Errorf("a refused re-pair touched the linked account: logouts=%d disconnects=%d", client.logouts, client.disconnects)
	}
	if devices.created != 0 {
		t.Error("a refused re-pair must not link a new device")
	}
}

// A session whose credential died — the exact instance the owner cannot pair
// again today — must reach the pairing stage with fresh material.
func TestRepairPairingRestartsAPairingFromADeadSession(t *testing.T) {
	ctx := context.Background()
	row := repairInstance("inst_1", stateDisconnected)
	client := newFakeClient()
	client.loggedIn, client.connected = false, false
	devices := &fakeDeviceStore{device: &store.Device{}}
	mgr := testManager(newFakeInstanceRepo(row), newFakePairingStore(), devices, client)
	defer mgr.shutdown(ctx)
	s := newSession(mgr, row, devices.device, client)
	s.status = stateDisconnected
	mgr.put(s)
	// The abandoned attempt left a QR and a failure behind.
	if err := mgr.pairing.Put(ctx, pairingSession{
		InstanceID: "inst_1", OrganizationID: "org_default", Mode: modeQR, Error: "pairing interrupted",
	}); err != nil {
		t.Fatalf("seed pairing material: %v", err)
	}
	client.qr <- whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventCode, Code: "2@restart"}

	snap, err := mgr.repairPairing(ctx, "inst_1")
	if err != nil {
		t.Fatalf("repairPairing: %v", err)
	}
	if snap.Status != string(statePairing) {
		t.Fatalf("status = %q, want pairing", snap.Status)
	}
	if mgr.get("inst_1") == s {
		t.Error("the dead session must be replaced by the new pairing attempt")
	}
	waitFor(t, "the fresh QR to be published", func() bool {
		ps, err := mgr.pairing.Get(ctx, "org_default", "inst_1")
		return err == nil && ps != nil && ps.QRDataURL != "" && ps.Error == ""
	})
	if client.logouts != 0 {
		t.Error("a session with nothing linked has nothing to log out")
	}
}

// Re-pairing invalidates a credential that is still linked: leaving the old
// device behind would let the boot restore pick it up for the same instance.
func TestRepairPairingInvalidatesAStaleLinkedCredential(t *testing.T) {
	ctx := context.Background()
	row := repairInstance("inst_1", stateError)
	row.PairingError = "pairing failed"
	client := newFakeClient()
	client.connected = false
	devices := &fakeDeviceStore{device: repairDevice("628990000001")}
	repo := newFakeInstanceRepo(row)
	mgr := testManager(repo, newFakePairingStore(), devices, client)
	defer mgr.shutdown(ctx)
	s := newSession(mgr, row, devices.device, client)
	s.status = stateError
	mgr.put(s)
	if err := mgr.pairing.Put(ctx, pairingSession{
		InstanceID: "inst_1", OrganizationID: "org_default", Mode: modeQR, Error: "pairing failed",
	}); err != nil {
		t.Fatalf("seed pairing material: %v", err)
	}
	// The failure the previous attempt recorded, as failPairing would have left it.
	if err := repo.SetStatus(ctx, "org_default", "inst_1", stateError, "pairing failed"); err != nil {
		t.Fatalf("seed pairing error: %v", err)
	}

	if _, err := mgr.repairPairing(ctx, "inst_1"); err != nil {
		t.Fatalf("repairPairing: %v", err)
	}
	if client.logouts != 1 {
		t.Errorf("logouts = %d, want the still-linked credential unlinked first", client.logouts)
	}
	if len(devices.deleted) != 1 {
		t.Errorf("deleted auth devices = %d, want the stale credential gone", len(devices.deleted))
	}
	if ps, _ := mgr.pairing.Get(ctx, "org_default", "inst_1"); ps != nil {
		t.Errorf("pairing material = %+v, want the failed attempt's material cleared", ps)
	}
	if got := repo.pairingErrors["inst_1"]; got != "" {
		t.Errorf("persisted pairing error = %q, want it cleared for the new attempt", got)
	}
}

// A second call must not race the first attempt: two devices would fight for the
// same phone scan and the second one would overwrite the QR on screen.
func TestRepairPairingTwiceKeepsTheAttemptInFlight(t *testing.T) {
	ctx := context.Background()
	row := repairInstance("inst_1", stateDisconnected)
	client := newFakeClient()
	client.loggedIn, client.connected = false, false
	devices := &fakeDeviceStore{device: &store.Device{}}
	mgr := testManager(newFakeInstanceRepo(row), newFakePairingStore(), devices, client)
	defer mgr.shutdown(ctx)
	s := newSession(mgr, row, devices.device, client)
	s.status = stateDisconnected
	mgr.put(s)
	client.qr <- whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventCode, Code: "2@once"}

	if _, err := mgr.repairPairing(ctx, "inst_1"); err != nil {
		t.Fatalf("first repairPairing: %v", err)
	}
	waitFor(t, "the QR to be published", func() bool {
		ps, err := mgr.pairing.Get(ctx, "org_default", "inst_1")
		return err == nil && ps != nil && ps.QRDataURL != ""
	})
	first := mgr.get("inst_1")

	second, err := mgr.repairPairing(ctx, "inst_1")
	if err != nil {
		t.Fatalf("second repairPairing: %v", err)
	}
	if mgr.get("inst_1") != first {
		t.Error("a second re-pair must not replace the attempt already in flight")
	}
	if live := len(mgr.listActive()); live != 1 {
		t.Errorf("live sessions = %d, want the one attempt", live)
	}
	if devices.created != 1 {
		t.Errorf("devices linked = %d, want 1: a second call must not spawn a second device", devices.created)
	}
	if second.QR == "" || second.QR != first.snapshot().QRDataURL {
		t.Error("the second call must report the QR already on screen, not a new one")
	}
}

func TestRepairPairingUnknownInstanceIsNotFound(t *testing.T) {
	mgr := testManager(newFakeInstanceRepo(), newFakePairingStore(), &fakeDeviceStore{}, newFakeClient())
	defer mgr.shutdown(context.Background())

	if _, err := mgr.repairPairing(context.Background(), "nope"); !errors.Is(err, errInstanceNotFound) {
		t.Fatalf("err = %v, want errInstanceNotFound", err)
	}
}

// A code-mode instance has no QR to publish, so the stage it has to reach is the
// one the phone code is requested from: the login websocket ready.
func TestRepairPairingReachesTheCodeStage(t *testing.T) {
	ctx := context.Background()
	row := repairInstance("inst_1", stateLoggedOut)
	row.Mode = modeCode
	client := newFakeClient()
	client.loggedIn, client.connected = false, false
	client.pairCode = "1234-5678"
	devices := &fakeDeviceStore{device: &store.Device{}}
	mgr := testManager(newFakeInstanceRepo(row), newFakePairingStore(), devices, client)
	defer mgr.shutdown(ctx)
	s := newSession(mgr, row, devices.device, client)
	s.status = stateLoggedOut
	mgr.put(s)
	// The first channel item is what marks the login websocket ready.
	client.qr <- whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventCode, Code: "2@code"}

	snap, err := mgr.repairPairing(ctx, "inst_1")
	if err != nil {
		t.Fatalf("repairPairing: %v", err)
	}
	if snap.Status != string(statePairing) {
		t.Fatalf("status = %q, want pairing", snap.Status)
	}
	waitFor(t, "the login websocket to report ready", func() bool {
		ready := mgr.get("inst_1")
		if ready == nil {
			return false
		}
		select {
		case <-ready.pairingReady:
			return true
		default:
			return false
		}
	})
	got, err := mgr.requestPairingCode(ctx, "inst_1")
	if err != nil {
		t.Fatalf("requestPairingCode after a re-pair: %v", err)
	}
	if got.PairingCode != "1234-5678" || got.Status != string(statePairing) {
		t.Errorf("snapshot = %+v, want the phone code while pairing", got)
	}
}

// ---- POST /instances/{id}/check ------------------------------------------

// The check endpoint asks the client instead of repeating the cached field.
func TestVerifyConnectionReportsWhatTheClientProves(t *testing.T) {
	cases := []struct {
		name                string
		loggedIn, connected bool
		status              sessionState
		want                sessionState
		wantConnects        int
	}{
		{name: "authenticated and live", loggedIn: true, connected: true, status: stateConnected, want: stateConnected},
		{name: "socket silently dropped", loggedIn: true, connected: false, status: stateConnected, want: stateConnected, wantConnects: 1},
		{name: "credential revoked", loggedIn: false, connected: false, status: stateConnected, want: stateLoggedOut},
		{name: "stale disconnected row, live account", loggedIn: true, connected: true, status: stateDisconnected, want: stateConnected},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client := newFakeClient()
			client.loggedIn, client.connected = tc.loggedIn, tc.connected
			mgr, repo, _ := verifyFixture(t, tc.status, client)

			snap, err := mgr.verifyConnection(context.Background(), "inst_1")
			if err != nil {
				t.Fatalf("verifyConnection: %v", err)
			}
			if snap.Status != string(tc.want) {
				t.Errorf("status = %q, want %q", snap.Status, tc.want)
			}
			if client.connects != tc.wantConnects {
				t.Errorf("connects = %d, want %d", client.connects, tc.wantConnects)
			}
			if got := repo.statuses["inst_1"]; got != tc.want {
				t.Errorf("persisted status = %q, want %q", got, tc.want)
			}
		})
	}
}

// A dropped socket is repaired by reconnecting, and a refused reconnect is
// reported with its reason rather than left as "connected".
func TestVerifyConnectionReconnectsADeadSocket(t *testing.T) {
	client := newFakeClient()
	client.connected = false
	client.connectErr = errors.New("dial tcp 1.2.3.4:443: connection refused")
	mgr, repo, _ := verifyFixture(t, stateConnected, client)

	snap, err := mgr.verifyConnection(context.Background(), "inst_1")
	if err != nil {
		t.Fatalf("verifyConnection: %v", err)
	}
	if snap.Status != string(stateError) {
		t.Errorf("status = %q, want error", snap.Status)
	}
	if !strings.Contains(snap.PairingError, "connection refused") {
		t.Errorf("pairingError = %q, want the reconnect failure", snap.PairingError)
	}
	if repo.statuses["inst_1"] != stateError {
		t.Errorf("persisted status = %q, want error", repo.statuses["inst_1"])
	}
}

// A revoked credential is the end of the link, so the pairing material of a dead
// attempt goes with it.
func TestVerifyConnectionClearsMaterialWhenTheCredentialIsRevoked(t *testing.T) {
	ctx := context.Background()
	client := newFakeClient()
	client.loggedIn, client.connected = false, false
	mgr, _, _ := verifyFixture(t, stateConnected, client)
	if err := mgr.pairing.Put(ctx, pairingSession{
		InstanceID: "inst_1", OrganizationID: "org_default", Mode: modeQR, QRDataURL: "data:image/png;base64,AAAA",
	}); err != nil {
		t.Fatalf("seed pairing material: %v", err)
	}

	snap, err := mgr.verifyConnection(ctx, "inst_1")
	if err != nil {
		t.Fatalf("verifyConnection: %v", err)
	}
	if snap.Status != string(stateLoggedOut) {
		t.Errorf("status = %q, want logged_out", snap.Status)
	}
	if ps, _ := mgr.pairing.Get(ctx, "org_default", "inst_1"); ps != nil {
		t.Error("a logged-out instance must not keep pairing material")
	}
}

// A pairing that is still in flight has no credential by design; checking it
// must not read that as a logout and cancel the attempt on screen.
func TestVerifyConnectionLeavesAPairingAttemptAlone(t *testing.T) {
	ctx := context.Background()
	client := newFakeClient()
	client.loggedIn, client.connected = false, true
	mgr, _, _ := verifyFixture(t, statePairing, client)
	if err := mgr.pairing.Put(ctx, pairingSession{
		InstanceID: "inst_1", OrganizationID: "org_default", Mode: modeQR, QRDataURL: "data:image/png;base64,AAAA",
	}); err != nil {
		t.Fatalf("seed pairing material: %v", err)
	}

	snap, err := mgr.verifyConnection(ctx, "inst_1")
	if err != nil {
		t.Fatalf("verifyConnection: %v", err)
	}
	if snap.Status != string(statePairing) || snap.QR == "" {
		t.Errorf("snapshot = %+v, want the pairing attempt untouched", snap)
	}
	if client.logouts != 0 || client.disconnects != 0 {
		t.Errorf("the pairing attempt was torn down: logouts=%d disconnects=%d", client.logouts, client.disconnects)
	}
}

// With no live session, the check rebuilds one from the instance's own auth
// device — the single-instance form of the boot restore.
func TestVerifyConnectionRebuildsTheSessionFromTheAuthStore(t *testing.T) {
	row := repairInstance("inst_1", stateDisconnected)
	client := newFakeClient()
	mgr := testManager(newFakeInstanceRepo(row), newFakePairingStore(),
		&fakeDeviceStore{device: repairDevice("628990000001")}, client)
	defer mgr.shutdown(context.Background())

	snap, err := mgr.verifyConnection(context.Background(), "inst_1")
	if err != nil {
		t.Fatalf("verifyConnection: %v", err)
	}
	if snap.Status != string(stateConnected) {
		t.Errorf("status = %q, want connected", snap.Status)
	}
	if mgr.get("inst_1") == nil {
		t.Error("the check must leave a live session behind, not a one-shot probe")
	}
	if client.connects != 1 {
		t.Errorf("connects = %d, want the device reconnected once", client.connects)
	}
}

// One linked account must never back two instances (§6.1): the second instance
// is reported as broken instead of being given the device in use.
func TestVerifyConnectionNeverHandsOneDeviceToTwoInstances(t *testing.T) {
	phone := "628990000001"
	first, second := repairInstance("inst_1", stateConnected), repairInstance("inst_2", stateDisconnected)
	client := newFakeClient()
	mgr := testManager(newFakeInstanceRepo(first, second), newFakePairingStore(),
		&fakeDeviceStore{device: repairDevice(phone)}, client)
	defer mgr.shutdown(context.Background())
	live := newSession(mgr, first, repairDevice(phone), client)
	live.status = stateConnected
	mgr.put(live)

	snap, err := mgr.verifyConnection(context.Background(), "inst_2")
	if err != nil {
		t.Fatalf("verifyConnection: %v", err)
	}
	if snap.Status != string(stateError) {
		t.Errorf("status = %q, want error: the device belongs to inst_1", snap.Status)
	}
	if mgr.get("inst_2") != nil {
		t.Error("the device in use by another instance must not be opened twice")
	}
	if client.connects != 0 {
		t.Errorf("connects = %d, want 0", client.connects)
	}
}

// A row whose credential is gone is logged out, whatever it claimed before.
func TestVerifyConnectionReportsLoggedOutWhenTheCredentialIsGone(t *testing.T) {
	ctx := context.Background()
	row := repairInstance("inst_1", stateDisconnected)
	client := newFakeClient()
	mgr := testManager(newFakeInstanceRepo(row), newFakePairingStore(), &fakeDeviceStore{}, client)
	defer mgr.shutdown(ctx)
	if err := mgr.pairing.Put(ctx, pairingSession{
		InstanceID: "inst_1", OrganizationID: "org_default", Mode: modeQR, QRDataURL: "data:image/png;base64,AAAA",
	}); err != nil {
		t.Fatalf("seed pairing material: %v", err)
	}

	snap, err := mgr.verifyConnection(ctx, "inst_1")
	if err != nil {
		t.Fatalf("verifyConnection: %v", err)
	}
	if snap.Status != string(stateLoggedOut) {
		t.Errorf("status = %q, want logged_out", snap.Status)
	}
	if mgr.get("inst_1") != nil {
		t.Error("there is no credential to open a session with")
	}
	if ps, _ := mgr.pairing.Get(ctx, "org_default", "inst_1"); ps != nil {
		t.Error("the material of a dead pairing attempt must go")
	}
}

func TestVerifyConnectionUnknownInstanceIsNotFound(t *testing.T) {
	mgr := testManager(newFakeInstanceRepo(), newFakePairingStore(), &fakeDeviceStore{}, newFakeClient())
	defer mgr.shutdown(context.Background())

	if _, err := mgr.verifyConnection(context.Background(), "nope"); !errors.Is(err, errInstanceNotFound) {
		t.Fatalf("err = %v, want errInstanceNotFound", err)
	}
}

// ---- reads: the reported status must be the socket's, not the cache's ------

// A row that says `connected` is what the dashboard shows; when the socket died
// without an event, every read has to say so instead of echoing the row.
func TestMergedSnapshotReportsTheRealSocketState(t *testing.T) {
	cases := []struct {
		name      string
		loggedIn  bool
		connected bool
		want      sessionState
	}{
		{name: "authenticated and live", loggedIn: true, connected: true, want: stateConnected},
		{name: "socket dropped without an event", loggedIn: true, connected: false, want: stateDisconnected},
		{name: "credential revoked", loggedIn: false, connected: false, want: stateLoggedOut},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			client := newFakeClient()
			client.loggedIn, client.connected = tc.loggedIn, tc.connected
			mgr, _, _ := verifyFixture(t, stateConnected, client)

			snap, err := mgr.getInstance(ctx, "inst_1")
			if err != nil {
				t.Fatalf("getInstance: %v", err)
			}
			if snap.Status != string(tc.want) {
				t.Errorf("status = %q, want %q", snap.Status, tc.want)
			}
			list, err := mgr.listInstances(ctx)
			if err != nil {
				t.Fatalf("listInstances: %v", err)
			}
			if len(list) != 1 || list[0].Status != string(tc.want) {
				t.Errorf("list = %+v, want the same status as the single read", list)
			}
		})
	}
}

// The pairing overlay outlives the truth check: while a QR is on screen the
// instance reads `pairing` with its material.
func TestMergedSnapshotKeepsThePairingMaterial(t *testing.T) {
	ctx := context.Background()
	const qr = "data:image/png;base64,AAAA"
	client := newFakeClient()
	mgr, _, s := verifyFixture(t, statePairing, client)
	s.qrDataURL = qr
	if err := mgr.pairing.Put(ctx, pairingSession{
		InstanceID: "inst_1", OrganizationID: "org_default", Mode: modeQR, QRDataURL: qr,
	}); err != nil {
		t.Fatalf("seed pairing material: %v", err)
	}

	snap, err := mgr.getInstance(ctx, "inst_1")
	if err != nil {
		t.Fatalf("getInstance: %v", err)
	}
	if snap.Status != string(statePairing) || snap.QR != qr {
		t.Errorf("snapshot = %+v, want pairing with the QR on screen", snap)
	}
}

// ---- the routes -----------------------------------------------------------

func TestInstancePairEndpoint(t *testing.T) {
	ctx := context.Background()
	row := repairInstance("inst_1", stateDisconnected)
	client := newFakeClient()
	client.qr <- whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventCode, Code: "2@http"}
	mgr := testManager(newFakeInstanceRepo(row), newFakePairingStore(), &fakeDeviceStore{device: &store.Device{}}, client)
	defer mgr.shutdown(ctx)
	handler := mgr.api()

	rec := callJSON(t, handler, http.MethodPost, "/instances/inst_1/pair", "dev-secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var snap instanceSnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if snap.ID != "inst_1" || snap.Status != string(statePairing) {
		t.Errorf("snapshot = %+v, want the inst_1 pairing state", snap)
	}

	if rec := callJSON(t, handler, http.MethodPost, "/instances/unknown/pair", "dev-secret", ""); rec.Code != http.StatusNotFound {
		t.Errorf("unknown instance = %d, want 404", rec.Code)
	}
	if rec := callJSON(t, handler, http.MethodGet, "/instances/inst_1/pair", "dev-secret", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /pair = %d, want 405", rec.Code)
	}
}

func TestInstancePairEndpointRefusesAConnectedInstance(t *testing.T) {
	row := repairInstance("inst_1", stateConnected)
	client := newFakeClient()
	mgr := testManager(newFakeInstanceRepo(row), newFakePairingStore(),
		&fakeDeviceStore{device: repairDevice("628990000001")}, client)
	defer mgr.shutdown(context.Background())
	s := newSession(mgr, row, repairDevice("628990000001"), client)
	s.status = stateConnected
	mgr.put(s)

	rec := callJSON(t, mgr.api(), http.MethodPost, "/instances/inst_1/pair", "dev-secret", "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Code != "invalid_state" {
		t.Errorf("code = %q, want invalid_state", body.Code)
	}
}

func TestInstanceCheckEndpoint(t *testing.T) {
	client := newFakeClient()
	client.connected = false
	mgr, _, _ := verifyFixture(t, stateConnected, client)
	handler := mgr.api()

	rec := callJSON(t, handler, http.MethodPost, "/instances/inst_1/check", "dev-secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var snap instanceSnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if snap.Status != string(stateConnected) {
		t.Errorf("status = %q, want connected after the reconnect", snap.Status)
	}
	if client.connects != 1 {
		t.Errorf("connects = %d, want the dropped socket reconnected", client.connects)
	}

	if rec := callJSON(t, handler, http.MethodPost, "/instances/unknown/check", "dev-secret", ""); rec.Code != http.StatusNotFound {
		t.Errorf("unknown instance = %d, want 404", rec.Code)
	}
	if rec := callJSON(t, handler, http.MethodGet, "/instances/inst_1/check", "dev-secret", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /check = %d, want 405", rec.Code)
	}
}
