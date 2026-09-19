package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The control plane's group surface talks to exactly one live thing — the Hermes
// bridge — so these tests point a real api at a real HTTP server standing where
// the container does. A route that works here works in production.

// newTestAPI wires the group surface the way a running worker is wired: a manager
// whose configured bridge is this server. A nil bridge is a worker that has none,
// which every live route answers as `instance_offline`.
func newTestAPI(t *testing.T, bridge *fakeBridge) (*api, *groupStore, context.Context) {
	t.Helper()
	store, ctx := newTestGroupStore(t)
	handler := &api{
		store: store, orgID: "org_default",
		secret: "dev-secret", prune: true, staleAfter: time.Hour,
	}
	if bridge != nil {
		handler.bridge = bridge.client(t)
	}
	return handler, store, ctx
}

// call drives the handler with the bearer token the control plane requires.
func call(handler *api, method, path string, token string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	handler.routes().ServeHTTP(rec, req)
	return rec
}

// groupReadAnswer is the bridge's own payload for `GET /group/:jid`: the subject,
// the two switches and the membership, with the badges WhatsApp gave each member.
func groupReadAnswer(subject string, announce, locked bool, participants ...bridgeParticipant) string {
	body, err := json.Marshal(map[string]any{
		"ok": true, "subject": subject, "announce": announce, "locked": locked, "participants": participants,
	})
	if err != nil {
		panic(err)
	}
	return string(body)
}

func TestGetInstanceGroups_HTTP(t *testing.T) {
	handler, store, ctx := newTestAPI(t, newFakeBridge(t))
	storeSeed(t, store, ctx, "120363043123456789@g.us", "Ops Team", 12)
	// A group whose subject WhatsApp has not given us yet.
	if err := store.UpsertObserved(ctx, "org_default", "inst_1", "120363043999999999@g.us",
		Observed{Subject: "", State: GroupActive, SubjectSource: SubjectFromFallback}, false); err != nil {
		t.Fatalf("seed fallback: %v", err)
	}

	rec := call(handler, http.MethodGet, "/instances/inst_1/groups", "dev-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		InstanceID string `json:"instanceId"`
		SyncedAt   string `json:"syncedAt"`
		Groups     []struct {
			GroupJID   string `json:"groupJid"`
			Name       string `json:"name"`
			NameSource string `json:"nameSource"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.InstanceID != "inst_1" {
		t.Errorf("instanceId = %q, want inst_1", payload.InstanceID)
	}
	if len(payload.Groups) != 2 {
		t.Fatalf("groups = %d, want 2", len(payload.Groups))
	}
	names := map[string]string{}
	sources := map[string]string{}
	for _, g := range payload.Groups {
		names[g.GroupJID] = g.Name
		sources[g.GroupJID] = g.NameSource
	}
	if names["120363043123456789@g.us"] != "Ops Team" {
		t.Errorf("name = %q, want Ops Team (R11: ID + current name)", names["120363043123456789@g.us"])
	}
	if _, ok := names["120363043999999999@g.us"]; !ok {
		t.Error("an unnamed group must still be listed with its group ID")
	}
	if sources["120363043999999999@g.us"] != "fallback" {
		t.Errorf("nameSource = %q, want fallback", sources["120363043999999999@g.us"])
	}
	if _, err := time.Parse(time.RFC3339, payload.SyncedAt); err != nil {
		t.Errorf("syncedAt = %q, want RFC3339: %v", payload.SyncedAt, err)
	}
}

func TestGroupEndpoints_RequireBearer(t *testing.T) {
	handler, _, _ := newTestAPI(t, newFakeBridge(t))
	for _, token := range []string{"", "wrong-secret"} {
		rec := call(handler, http.MethodGet, "/instances/inst_1/groups", token)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("status = %d for token %q, want 401", rec.Code, token)
		}
		var body struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body.Code != "unauthorized" {
			t.Errorf("code = %q, want unauthorized", body.Code)
		}
	}
}

func TestGroupSyncEndpoint_Summary(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, groupsAnswer(
		bridgeGroup("120363043000000001", "A", 3),
		bridgeGroup("120363043000000002", "B", 4),
	))
	handler, store, ctx := newTestAPI(t, bridge)
	storeSeed(t, store, ctx, "120363043000000003@g.us", "C", 5)

	rec := call(handler, http.MethodPost, "/instances/inst_1/groups/sync", "dev-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var summary struct {
		OK         bool   `json:"ok"`
		InstanceID string `json:"instanceId"`
		Source     string `json:"source"`
		Total      int    `json:"total"`
		Added      int    `json:"added"`
		MarkedLeft int    `json:"markedLeft"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !summary.OK || summary.InstanceID != "inst_1" || summary.Total != 2 || summary.Added != 2 ||
		summary.MarkedLeft != 1 || summary.Source != "manual" {
		t.Errorf("summary = %+v, want ok/inst_1/total=2/added=2/markedLeft=1/source=manual", summary)
	}
	// The manual sync left the C row behind: absence marks state, never deletes.
	if doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000003@g.us"); doc == nil || doc.Observed.State != GroupLeft {
		t.Errorf("C = %+v, want state left", doc)
	}
	if call := bridge.only(t); call.path != "/groups" {
		t.Errorf("the sync asked %s, want the group list endpoint", call.path)
	}
}

// The bridge *is* the WhatsApp connection the sync would have used, so a worker
// without one — or one whose bridge cannot be reached — answers `instance_offline`
// rather than serving a snapshot that never arrived.
func TestGroupSyncEndpoint_NoBridgeIsOffline(t *testing.T) {
	handler, _, _ := newTestAPI(t, nil)
	rec := call(handler, http.MethodPost, "/instances/offline/groups/sync", "dev-secret")
	if rec.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409 when there is no live session to ask", rec.Code)
	}
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Code != "instance_offline" {
		t.Errorf("code = %q, want instance_offline", body.Code)
	}
}

func TestGroupSyncEndpoint_UnreachableBridgeIsOffline(t *testing.T) {
	bridge := newFakeBridge(t)
	handler, _, _ := newTestAPI(t, bridge)
	handler.bridge = bridge.closedClient(t)

	rec := call(handler, http.MethodPost, "/instances/inst_1/groups/sync", "dev-secret")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 for a bridge nothing is listening on: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Code != "instance_offline" {
		t.Errorf("code = %q, want instance_offline", body.Code)
	}
}

func TestGroupSyncEndpoint_FailedSyncIsReported(t *testing.T) {
	handler, store, ctx := newTestAPI(t, newFakeBridge(t).refusing("rate-overlimit"))
	storeSeed(t, store, ctx, "120363043000000001@g.us", "A", 3)

	rec := call(handler, http.MethodPost, "/instances/inst_1/groups/sync", "dev-secret")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 for a refused sync", rec.Code)
	}
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Code != "group_admin_failed" || body.Error == "" {
		t.Errorf("body = %+v, want the group-failure code the group surface uses", body)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000001@g.us"); doc == nil || doc.Observed.State != GroupActive {
		t.Errorf("A = %+v, want it untouched by the failed sync", doc)
	}
}

func TestGroupEndpoints_MethodAndRouteErrors(t *testing.T) {
	handler, store, ctx := newTestAPI(t, newFakeBridge(t))
	storeSeed(t, store, ctx, "120363043123456789@g.us", "Ops Team", 12)
	cases := []struct {
		method string
		path   string
		want   int
	}{
		{http.MethodPost, "/instances/inst_1/groups", http.StatusMethodNotAllowed},
		{http.MethodGet, "/instances/inst_1/groups/sync", http.StatusMethodNotAllowed},
		{http.MethodGet, "/instances/inst_1/groups/120363043999999999@g.us", http.StatusNotFound},
		{http.MethodGet, "/instances/inst_1/messages", http.StatusNotFound},
	}
	for _, tc := range cases {
		rec := call(handler, tc.method, tc.path, "dev-secret")
		if rec.Code != tc.want {
			t.Errorf("%s %s = %d, want %d", tc.method, tc.path, rec.Code, tc.want)
		}
	}
}

// TestGroupList_OrderingAndShape pins the read model §6.6.6 promises the
// dashboard: assigned groups first, most recently active within each band, and
// every row carrying both the ID and the current name.
func TestGroupList_OrderingAndShape(t *testing.T) {
	handler, store, ctx := newTestAPI(t, newFakeBridge(t))
	storeSeed(t, store, ctx, "120363043000000001@g.us", "Quiet", 3)
	storeSeed(t, store, ctx, "120363043000000002@g.us", "Busy", 4)
	storeSeed(t, store, ctx, "120363043000000003@g.us", "Assigned", 5)
	// lastActivityAt/messageCount belong to ingest, so the fixtures set them the
	// way ingest does: a raw field update, not a group-store write.
	if _, err := store.collection().UpdateOne(ctx, map[string]any{"groupJid": "120363043000000001@g.us"},
		map[string]any{"$set": map[string]any{"observed.lastActivityAt": stamp(1)}}); err != nil {
		t.Fatalf("seed activity: %v", err)
	}
	if _, err := store.collection().UpdateOne(ctx, map[string]any{"groupJid": "120363043000000002@g.us"},
		map[string]any{"$set": map[string]any{"observed.lastActivityAt": stamp(9), "observed.messageCount": 4211}}); err != nil {
		t.Fatalf("seed activity: %v", err)
	}
	if _, err := store.collection().UpdateOne(ctx, map[string]any{"groupJid": "120363043000000003@g.us"},
		map[string]any{"$set": map[string]any{"config.assigned": true}}); err != nil {
		t.Fatalf("assign: %v", err)
	}

	rec := call(handler, http.MethodGet, "/instances/inst_1/groups", "dev-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Groups []struct {
			GroupJID         string `json:"groupJid"`
			Name             string `json:"name"`
			NameSource       string `json:"nameSource"`
			NameSetAt        string `json:"nameSetAt"`
			ParticipantCount int    `json:"participantCount"`
			State            string `json:"state"`
			MessageCount     int    `json:"messageCount"`
			Assigned         bool   `json:"assigned"`
			Whitelisted      bool   `json:"whitelisted"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := make([]string, 0, len(payload.Groups))
	for _, row := range payload.Groups {
		got = append(got, row.Name)
	}
	want := []string{"Assigned", "Busy", "Quiet"}
	if len(got) != len(want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v (assigned first, then most recently active)", got, want)
		}
	}
	busy := payload.Groups[1]
	if busy.GroupJID != "120363043000000002@g.us" || busy.ParticipantCount != 4 || busy.State != "active" ||
		busy.MessageCount != 4211 || busy.Assigned || busy.Whitelisted {
		t.Errorf("row = %+v, want the ID/name/count/state/activity the dashboard renders", busy)
	}
	if busy.NameSource != "sync" {
		t.Errorf("nameSource = %q, want sync", busy.NameSource)
	}
	if _, err := time.Parse(time.RFC3339, busy.NameSetAt); err != nil {
		t.Errorf("nameSetAt = %q, want RFC3339: %v", busy.NameSetAt, err)
	}
	if payload.Groups[0].NameSource != "sync" || !payload.Groups[0].Assigned {
		t.Errorf("assigned row = %+v, want nameSource sync and assigned true", payload.Groups[0])
	}
}

// A stale group is repaired from the bridge on demand (§6.6.2), and the row the
// dashboard receives is the repaired one.
func TestGroupByJID_RepairsStaleGroup(t *testing.T) {
	jid := "120363043123456789@g.us"
	bridge := newFakeBridge(t).answering(http.StatusOK,
		groupReadAnswer("Repaired", false, false, bridgeParticipant{JID: "628990000009@s.whatsapp.net", Admin: participantSuperAdmin}))
	handler, store, ctx := newTestAPI(t, bridge)
	if err := store.UpsertObserved(ctx, "org_default", "inst_1", jid, Observed{
		Subject: "Stale", SubjectSearch: "stale", SubjectSource: SubjectFromSync,
		State: GroupActive, LastSyncedAt: stamp(0), LastSyncSource: SyncOnConnect,
	}, true); err != nil {
		t.Fatalf("seed: %v", err)
	}

	rec := call(handler, http.MethodGet, "/instances/inst_1/groups/"+jid, "dev-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var row struct {
		GroupJID         string `json:"groupJid"`
		Name             string `json:"name"`
		ParticipantCount int    `json:"participantCount"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &row); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if row.Name != "Repaired" || row.ParticipantCount != 1 || row.GroupJID != jid {
		t.Errorf("row = %+v, want the repaired group", row)
	}
	if call := bridge.only(t); call.path != "/group/"+jid {
		t.Errorf("the repair asked %s, want the single-group read", call.path)
	}
	doc := store.FindOne(ctx, "org_default", "inst_1", jid)
	if doc == nil || doc.Observed.Subject != "Repaired" {
		t.Errorf("stored = %+v, want the repair persisted", doc)
	}
	if doc.Observed.LastSyncedAt.Before(now().Add(-time.Minute)) {
		t.Errorf("lastSyncedAt = %v, want it refreshed so the next read is not stale", doc.Observed.LastSyncedAt)
	}
}

// A group the account can no longer see is marked gone, keeping the name it had.
// The bridge reports "removed" and "deleted" as the same not-found, and `left` is
// the honest state of the pair: the row survives with its history and a later
// snapshot can reactivate it.
func TestGroupByJID_RepairNotFoundMarksState(t *testing.T) {
	jid := "120363043123456789@g.us"
	handler, store, ctx := newTestAPI(t, newFakeBridge(t).refusing("item-not-found"))
	if err := store.UpsertObserved(ctx, "org_default", "inst_1", jid, Observed{
		Subject: "Ops Team", SubjectSearch: "ops team", SubjectSource: SubjectFromSync,
		State: GroupActive, LastSyncedAt: stamp(0), LastSyncSource: SyncOnConnect,
	}, true); err != nil {
		t.Fatalf("seed: %v", err)
	}

	rec := call(handler, http.MethodGet, "/instances/inst_1/groups/"+jid, "dev-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var row struct {
		Name  string `json:"name"`
		State string `json:"state"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &row)
	if row.State != string(GroupLeft) {
		t.Errorf("state = %q, want %q", row.State, GroupLeft)
	}
	if row.Name != "Ops Team" {
		t.Errorf("name = %q, want the retained name", row.Name)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", jid); doc == nil || doc.Observed.State != GroupLeft {
		t.Errorf("stored = %+v, want the state persisted", doc)
	}
}

// A repair that fails for any other reason must not turn a served read into an
// error: the dashboard shows what we know and the next read retries.
func TestGroupByJID_RepairFailureServesStoredRow(t *testing.T) {
	jid := "120363043123456789@g.us"
	handler, store, ctx := newTestAPI(t, newFakeBridge(t).refusing("rate-overlimit"))
	if err := store.UpsertObserved(ctx, "org_default", "inst_1", jid, Observed{
		Subject: "Ops Team", SubjectSearch: "ops team", SubjectSource: SubjectFromSync,
		State: GroupActive, LastSyncedAt: stamp(0), LastSyncSource: SyncOnConnect,
	}, true); err != nil {
		t.Fatalf("seed: %v", err)
	}

	rec := call(handler, http.MethodGet, "/instances/inst_1/groups/"+jid, "dev-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var row struct {
		Name  string `json:"name"`
		State string `json:"state"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &row)
	if row.Name != "Ops Team" || row.State != "active" {
		t.Errorf("row = %+v, want the stored row served unchanged", row)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", jid); doc == nil || doc.Observed.State != GroupActive {
		t.Errorf("stored = %+v, want no state change from a failed repair", doc)
	}
}

func TestGroupByJID_NoBridgeServesStoredRow(t *testing.T) {
	jid := "120363043123456789@g.us"
	handler, store, ctx := newTestAPI(t, nil)
	if err := store.UpsertObserved(ctx, "org_default", "inst_1", jid, Observed{
		Subject: "Ops Team", SubjectSource: SubjectFromSync, State: GroupActive,
	}, false); err != nil {
		t.Fatalf("seed: %v", err)
	}
	rec := call(handler, http.MethodGet, "/instances/inst_1/groups/"+jid, "dev-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want the persisted row even with no live session", rec.Code)
	}
}

// ---- the retired pairing surface -----------------------------------------

// Every route that used to link a device into this worker's own session answers a
// refusal that names where pairing went, rather than a 404 a caller would read as
// a broken deployment.
func TestPairingRoutesRefuseAndNameHermes(t *testing.T) {
	handler, _, _ := newTestAPI(t, newFakeBridge(t))
	handler.manager = testManagerWithDeps(newFakeGroupStore(), nil, nil)

	cases := []struct {
		method string
		path   string
		body   string
		want   int
	}{
		{http.MethodPost, "/instances", `{"label":"work","mode":"qr"}`, http.StatusConflict},
		{http.MethodPost, "/instances/inst_1/pair", "", http.StatusConflict},
		{http.MethodPost, "/instances/inst_1/pairing-code", "", http.StatusConflict},
		{http.MethodPost, "/instances/inst_1/check", "", http.StatusConflict},
	}
	for _, tc := range cases {
		rec := callJSON(t, handler, tc.method, tc.path, "dev-secret", tc.body)
		if rec.Code != tc.want {
			t.Errorf("%s %s = %d, want %d", tc.method, tc.path, rec.Code, tc.want)
		}
		var body struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode %s: %v", rec.Body.String(), err)
		}
		if body.Code != "invalid_state" {
			t.Errorf("%s %s code = %q, want invalid_state (the BFF's vocabulary for this)", tc.method, tc.path, body.Code)
		}
		if !strings.Contains(body.Error, "Hermes") {
			t.Errorf("%s %s error = %q, want a refusal that names where pairing moved", tc.method, tc.path, body.Error)
		}
	}
}

// Creating an instance is the one route the console's own form still calls; its
// refusal must not be a 404 or a 500 that would read as a broken deployment.
func TestCreateInstanceRefusesWithoutTouchingWhatsApp(t *testing.T) {
	bridge := newFakeBridge(t)
	handler, _, _ := newTestAPI(t, bridge)
	handler.manager = testManagerWithDeps(newFakeGroupStore(), nil, nil)

	rec := callJSON(t, handler, http.MethodPost, "/instances", "dev-secret", `{"label":"work","mode":"code","phoneNumber":"628990000001"}`)
	if rec.Code == http.StatusCreated {
		t.Fatal("the worker created an instance it can no longer pair")
	}
	if calls := bridge.recorded(); len(calls) != 0 {
		t.Errorf("bridge calls = %d, want none: pairing is not a bridge operation either", len(calls))
	}
}

// GET /instances is what the console lists, and it must keep answering the row.
func TestListInstancesServesTheStoredRows(t *testing.T) {
	handler, _, _ := newTestAPI(t, newFakeBridge(t))
	handler.manager = testManagerWithDeps(newFakeGroupStore(), nil, newFakeInstanceRepo(InstanceRow{
		ID: "inst_1", OrganizationID: "org_default", Label: "work", Mode: "qr",
		Status: stateConnected, PhoneNumber: "628990000001", CreatedAt: stamp(1),
	}))

	rec := call(handler, http.MethodGet, "/instances", "dev-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Instances []instanceSnapshot `json:"instances"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Instances) != 1 || body.Instances[0].ID != "inst_1" || body.Instances[0].Status != string(stateConnected) {
		t.Fatalf("instances = %+v, want the stored row", body.Instances)
	}
}

// DELETE still removes the row — the credential it used to invalidate belongs to
// the Hermes session now — and it must not reach for anything WhatsApp-side.
func TestDeleteInstanceSoftDeletesTheRow(t *testing.T) {
	repo := newFakeInstanceRepo(InstanceRow{ID: "inst_1", OrganizationID: "org_default", Label: "work", Mode: "qr", Status: stateConnected})
	bridge := newFakeBridge(t)
	handler, _, _ := newTestAPI(t, bridge)
	handler.manager = testManagerWithDeps(newFakeGroupStore(), nil, repo)

	rec := call(handler, http.MethodDelete, "/instances/inst_1", "dev-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rows, _ := repo.List(context.Background(), "org_default"); len(rows) != 0 {
		t.Errorf("rows = %+v, want the instance gone from every read", rows)
	}
	if calls := bridge.recorded(); len(calls) != 0 {
		t.Errorf("bridge calls = %d, want none", len(calls))
	}
}

// ---- GET /scheduler: what the loops are doing (§6.5 reports queues, not cadences) ----

func TestSchedulerEndpointReportsEachLoop(t *testing.T) {
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	at := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	mgr.loops.declare("group-sync", 30*time.Minute)
	mgr.loops.declare("send-dispatch", 5*time.Minute)
	mgr.loops.pass("group-sync", at, context.DeadlineExceeded)

	rec := callJSON(t, mgr.api(), http.MethodGet, "/scheduler", "dev-secret", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Loops []loopReport `json:"loops"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	if len(body.Loops) != 2 {
		t.Fatalf("loops = %d, want the two declared", len(body.Loops))
	}
	first := body.Loops[0]
	if first.Name != "group-sync" || first.Runs != 1 || first.LastError != "context deadline exceeded" {
		t.Fatalf("first loop = %+v, want the failed pass it recorded", first)
	}
	if first.LastRunAt == nil || !first.LastRunAt.Equal(at) {
		t.Fatalf("last run = %v, want %v", first.LastRunAt, at)
	}
	if second := body.Loops[1]; second.IntervalMs != (5*time.Minute).Milliseconds() || second.LastRunAt != nil {
		t.Fatalf("second loop = %+v, want its interval and no run yet", second)
	}
}

func TestSchedulerEndpointRequiresTheToken(t *testing.T) {
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.loops.declare("group-sync", 30*time.Minute)

	rec := callJSON(t, mgr.api(), http.MethodGet, "/scheduler", "not-the-secret", "")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 without the control-plane token", rec.Code)
	}
}
