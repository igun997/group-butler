package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

func newTestAPI(t *testing.T, client groupClient) (*api, *groupStore, context.Context) {
	t.Helper()
	store, ctx := newTestGroupStore(t)
	return &api{
		store: store, clientFor: func(string) groupClient { return client }, orgID: "org_default",
		secret: "dev-secret", prune: true, staleAfter: time.Hour,
	}, store, ctx
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

func TestGetInstanceGroups_HTTP(t *testing.T) {
	handler, store, ctx := newTestAPI(t, &fakeGroupClient{})
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", groupInfo("120363043123456789", "Ops Team", 12), SyncOnConnect); err != nil {
		t.Fatalf("seed: %v", err)
	}
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
	handler, _, _ := newTestAPI(t, &fakeGroupClient{})
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
	client := &fakeGroupClient{groups: []*types.GroupInfo{
		groupInfo("120363043000000001", "A", 3),
		groupInfo("120363043000000002", "B", 4),
	}}
	handler, store, ctx := newTestAPI(t, client)
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", groupInfo("120363043000000003", "C", 5), SyncOnConnect); err != nil {
		t.Fatalf("seed: %v", err)
	}

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
}

func TestGroupSyncEndpoint_OfflineInstance(t *testing.T) {
	handler, _, _ := newTestAPI(t, nil)
	rec := call(handler, http.MethodPost, "/instances/offline/groups/sync", "dev-secret")
	if rec.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409 when the instance has no live client", rec.Code)
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
	handler, store, ctx := newTestAPI(t, &fakeGroupClient{err: errors.New("iq timeout")})
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", groupInfo("120363043000000001", "A", 3), SyncOnConnect); err != nil {
		t.Fatalf("seed: %v", err)
	}
	rec := call(handler, http.MethodPost, "/instances/inst_1/groups/sync", "dev-secret")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 for a failed sync", rec.Code)
	}
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Code != "group_sync_failed" || body.Error == "" {
		t.Errorf("body = %+v, want a group_sync_failed error", body)
	}
	if doc := store.FindOne(ctx, "org_default", "inst_1", "120363043000000001@g.us"); doc == nil || doc.Observed.State != GroupActive {
		t.Errorf("A = %+v, want it untouched by the failed sync", doc)
	}
}

func TestGroupEndpoints_MethodAndRouteErrors(t *testing.T) {
	handler, store, ctx := newTestAPI(t, &fakeGroupClient{})
	if err := store.UpsertFromSync(ctx, "org_default", "inst_1", groupInfo("120363043123456789", "Ops Team", 12), SyncOnConnect); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cases := []struct {
		method string
		path   string
		want   int
	}{
		{http.MethodPost, "/instances/inst_1/groups", http.StatusMethodNotAllowed},
		{http.MethodGet, "/instances/inst_1/groups/sync", http.StatusMethodNotAllowed},
		{http.MethodGet, "/instances/inst_1/groups/120363043999999999@g.us", http.StatusNotFound},
		{http.MethodGet, "/instances/inst_1/messages", http.StatusNotFound},
		{http.MethodGet, "/instances/inst_1", http.StatusNotFound},
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
	handler, store, ctx := newTestAPI(t, &fakeGroupClient{})
	seedGroups(t, store, ctx,
		groupInfo("120363043000000001", "Quiet", 3),
		groupInfo("120363043000000002", "Busy", 4),
		groupInfo("120363043000000003", "Assigned", 5),
	)
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

// A stale group is repaired from WhatsApp on demand (§6.6.2), and the row the
// dashboard receives is the repaired one.
func TestGroupByJID_RepairsStaleGroup(t *testing.T) {
	jid := "120363043123456789@g.us"
	info := groupInfo("120363043123456789", "Repaired", 9)
	info.NameSetAt = stamp(5)
	handler, store, ctx := newTestAPI(t, &fakeGroupClient{info: map[string]*types.GroupInfo{jid: info}})
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
	if row.Name != "Repaired" || row.ParticipantCount != 9 || row.GroupJID != jid {
		t.Errorf("row = %+v, want the repaired group", row)
	}
	doc := store.FindOne(ctx, "org_default", "inst_1", jid)
	if doc == nil || doc.Observed.Subject != "Repaired" {
		t.Errorf("stored = %+v, want the repair persisted", doc)
	}
	if doc.Observed.LastSyncedAt.Before(now().Add(-time.Minute)) {
		t.Errorf("lastSyncedAt = %v, want it refreshed so the next read is not stale", doc.Observed.LastSyncedAt)
	}
}

func TestGroupByJID_RepairNotFoundMarksState(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want GroupState
	}{
		{"removed from the group", whatsmeow.ErrNotInGroup, GroupLeft},
		{"group no longer exists", whatsmeow.ErrGroupNotFound, GroupDeleted},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			jid := "120363043123456789@g.us"
			handler, store, ctx := newTestAPI(t, &fakeGroupClient{infoErr: map[string]error{jid: tc.err}})
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
			if row.State != string(tc.want) {
				t.Errorf("state = %q, want %q", row.State, tc.want)
			}
			if row.Name != "Ops Team" {
				t.Errorf("name = %q, want the retained name", row.Name)
			}
			if doc := store.FindOne(ctx, "org_default", "inst_1", jid); doc == nil || doc.Observed.State != tc.want {
				t.Errorf("stored = %+v, want state %q persisted", doc, tc.want)
			}
		})
	}
}

// A repair that fails for any other reason must not turn a served read into an
// error: the dashboard shows what we know and the next read retries.
func TestGroupByJID_RepairFailureServesStoredRow(t *testing.T) {
	jid := "120363043123456789@g.us"
	handler, store, ctx := newTestAPI(t, &fakeGroupClient{infoErr: map[string]error{jid: errors.New("iq timeout")}})
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

func TestGroupByJID_OfflineInstanceServesStoredRow(t *testing.T) {
	jid := "120363043123456789@g.us"
	handler, store, ctx := newTestAPI(t, nil)
	if err := store.UpsertObserved(ctx, "org_default", "inst_1", jid, Observed{
		Subject: "Ops Team", SubjectSource: SubjectFromSync, State: GroupActive,
	}, false); err != nil {
		t.Fatalf("seed: %v", err)
	}
	rec := call(handler, http.MethodGet, "/instances/inst_1/groups/"+jid, "dev-secret")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want the persisted row even with no live client", rec.Code)
	}
}

// ---- GET /scheduler: what the loops are doing (§6.5 reports queues, not cadences) ----

func TestSchedulerEndpointReportsEachLoop(t *testing.T) {
	mgr := testManager(newFakeInstanceRepo(), newFakePairingStore(), &fakeDeviceStore{}, newFakeClient())
	defer mgr.shutdown(context.Background())
	at := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	mgr.loops.declare("group-sync", 30*time.Minute)
	mgr.loops.declare("media-janitor", 5*time.Minute)
	mgr.loops.pass("group-sync", at, errors.New("iq timeout"))

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
	if first.Name != "group-sync" || first.Runs != 1 || first.LastError != "iq timeout" {
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
	mgr := testManager(newFakeInstanceRepo(), newFakePairingStore(), &fakeDeviceStore{}, newFakeClient())
	defer mgr.shutdown(context.Background())
	mgr.loops.declare("group-sync", 30*time.Minute)

	rec := callJSON(t, mgr.api(), http.MethodGet, "/scheduler", "not-the-secret", "")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 without the control-plane token", rec.Code)
	}
}
