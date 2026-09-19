package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	adminGroupJID    = "120363043123456789@g.us"
	adminBotJID      = "628990000009@s.whatsapp.net"
	adminPath        = "/instances/inst_1/groups/" + adminGroupJID + "/admin"
	infoPath         = "/instances/inst_1/groups/" + adminGroupJID + "/info"
	participantsPath = "/instances/inst_1/groups/" + adminGroupJID + "/participants"
)

// ---- harness -------------------------------------------------------------

// adminRow is one instance the group surface may address, carrying the identity the
// linked account was last known by — which is what the info read matches the bot's
// own rights against now that the session lives in Hermes.
func adminRow(id, botJID, botLID string) InstanceRow {
	return InstanceRow{ID: id, OrganizationID: "org_default", Status: stateConnected, BotJID: botJID, BotLID: botLID}
}

// adminSession wires the group surface the way a running worker does: a manager
// whose configured bridge is this server, and instance rows that name the accounts
// a call may address. Nothing test-only stands between the route and the bridge, so
// a route that works here works in production.
func adminSession(t *testing.T, bridge *fakeBridge, rows ...InstanceRow) *api {
	t.Helper()
	return bridge.manager(t, newFakeGroupStore(), newFakeInstanceRepo(rows...)).api()
}

// adminAPI is adminSession with the one identity every test but the LID one uses.
func adminAPI(t *testing.T, bridge *fakeBridge, instances ...string) *api {
	t.Helper()
	rows := make([]InstanceRow, 0, len(instances))
	for _, id := range instances {
		rows = append(rows, adminRow(id, adminBotJID, ""))
	}
	return adminSession(t, bridge, rows...)
}

// adminRefusal is the one error envelope every route on this surface answers with,
// decoded so the code — not the status alone — is asserted.
type adminRefusal struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func decodeRefusal(t *testing.T, rec *httptest.ResponseRecorder) adminRefusal {
	t.Helper()
	var body adminRefusal
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode refusal %s: %v", rec.Body.String(), err)
	}
	return body
}

// ---- reads ---------------------------------------------------------------

func TestGroupInfoEndpointServesTheLiveGroup(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{
		"ok": true,
		"subject": "Ops Team",
		"announce": true,
		"locked": true,
		"participants": [
			{"jid": "628990000009@s.whatsapp.net", "admin": "admin"},
			{"jid": "628111111111@s.whatsapp.net", "admin": null},
			{"jid": "628222222222@s.whatsapp.net", "admin": null}
		]
	}`)
	handler := adminAPI(t, bridge, "inst_1")

	rec := callJSON(t, handler, http.MethodGet, infoPath, "dev-secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		OK               bool   `json:"ok"`
		GroupJID         string `json:"groupJid"`
		Name             string `json:"name"`
		Topic            string `json:"topic"`
		IsAnnounce       bool   `json:"isAnnounce"`
		IsLocked         bool   `json:"isLocked"`
		ParticipantCount int    `json:"participantCount"`
		BotIsAdmin       bool   `json:"botIsAdmin"`
		BotIsSuperAdmin  bool   `json:"botIsSuperAdmin"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.OK || body.GroupJID != adminGroupJID {
		t.Errorf("ok = %t, groupJid = %q, want true and %q", body.OK, body.GroupJID, adminGroupJID)
	}
	if body.Name != "Ops Team" {
		t.Errorf("name = %q, want the subject the bridge reported", body.Name)
	}
	// The bridge's contract carries no topic, so the field the BFF's schema
	// requires is answered empty rather than dropped or invented.
	if body.Topic != "" {
		t.Errorf("topic = %q, want empty: the bridge reports none", body.Topic)
	}
	if !body.IsAnnounce || !body.IsLocked {
		t.Errorf("isAnnounce = %t, isLocked = %t, want both true (the live flags)", body.IsAnnounce, body.IsLocked)
	}
	if body.ParticipantCount != 3 {
		t.Errorf("participantCount = %d, want 3 (the membership just listed)", body.ParticipantCount)
	}
	if !body.BotIsAdmin || body.BotIsSuperAdmin {
		t.Errorf("botIsAdmin = %t, botIsSuperAdmin = %t, want true and false", body.BotIsAdmin, body.BotIsSuperAdmin)
	}

	call := bridge.only(t)
	if call.method != http.MethodGet || call.path != "/group/"+adminGroupJID {
		t.Errorf("call = %s %s, want GET /group/%s", call.method, call.path, adminGroupJID)
	}
}

// A group that addresses its members by LID must still recognise the bot, so the
// admin flags are matched against the bot's LID as well as its phone JID.
func TestGroupInfoEndpointMatchesTheBotByLID(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{
		"ok": true, "subject": "Ops",
		"participants": [{"jid": "111222333@lid", "admin": "superadmin"}]
	}`)
	handler := adminSession(t, bridge, adminRow("inst_1", "", "111222333@lid"))

	rec := callJSON(t, handler, http.MethodGet, infoPath, "dev-secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		BotIsAdmin      bool `json:"botIsAdmin"`
		BotIsSuperAdmin bool `json:"botIsSuperAdmin"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.BotIsAdmin || !body.BotIsSuperAdmin {
		t.Errorf("botIsAdmin = %t, botIsSuperAdmin = %t, want both true", body.BotIsAdmin, body.BotIsSuperAdmin)
	}
}

// The identity the read matches against comes from the instance row, so a row that
// does not know it answers "not an admin" rather than matching a member by accident.
func TestGroupInfoEndpointReportsNoRightsWithoutAKnownIdentity(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{
		"ok": true, "subject": "Ops",
		"participants": [{"jid": "628111111111@s.whatsapp.net", "admin": "superadmin"}]
	}`)
	handler := adminSession(t, bridge, adminRow("inst_1", "", ""))

	rec := callJSON(t, handler, http.MethodGet, infoPath, "dev-secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		BotIsAdmin      bool `json:"botIsAdmin"`
		BotIsSuperAdmin bool `json:"botIsSuperAdmin"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.BotIsAdmin || body.BotIsSuperAdmin {
		t.Errorf("botIsAdmin = %t, botIsSuperAdmin = %t, want both false", body.BotIsAdmin, body.BotIsSuperAdmin)
	}
}

func TestGroupParticipantsEndpointServesTheLiveMembership(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{
		"ok": true, "subject": "Ops",
		"participants": [
			{"jid": "628111111111@s.whatsapp.net", "admin": "admin"},
			{"jid": "628222222222@s.whatsapp.net", "admin": "superadmin"}
		]
	}`)
	handler := adminAPI(t, bridge, "inst_1")

	rec := callJSON(t, handler, http.MethodGet, participantsPath, "dev-secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		OK           bool `json:"ok"`
		GroupJID     string
		Participants []struct {
			JID          string `json:"jid"`
			IsAdmin      bool   `json:"isAdmin"`
			IsSuperAdmin bool   `json:"isSuperAdmin"`
			DisplayName  string `json:"displayName"`
		}
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.OK || body.GroupJID != adminGroupJID {
		t.Errorf("ok = %t, groupJid = %q, want true and %q", body.OK, body.GroupJID, adminGroupJID)
	}
	if len(body.Participants) != 2 {
		t.Fatalf("participants = %d, want 2", len(body.Participants))
	}
	first, second := body.Participants[0], body.Participants[1]
	if first.JID != "628111111111@s.whatsapp.net" || !first.IsAdmin || first.IsSuperAdmin {
		t.Errorf("first = %+v, want an admin 628111111111", first)
	}
	if second.JID != "628222222222@s.whatsapp.net" || !second.IsSuperAdmin || !second.IsAdmin {
		t.Errorf("second = %+v, want a superadmin 628222222222", second)
	}
	// Display names have no source in the bridge's contract: the field stays absent
	// rather than being filled with something that is not a name.
	if first.DisplayName != "" || second.DisplayName != "" {
		t.Errorf("displayName = %q/%q, want it absent: the bridge reports no names", first.DisplayName, second.DisplayName)
	}
	if got := bridge.recorded()[0].path; got != "/group/"+adminGroupJID {
		t.Errorf("read %s, want the group the path named", got)
	}
}

// A group with no members is an empty list, not a null the BFF would have to
// special-case.
func TestGroupParticipantsEndpointAnswersAnEmptyList(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{"ok":true,"subject":"Ops","participants":[]}`)
	handler := adminAPI(t, bridge, "inst_1")

	rec := callJSON(t, handler, http.MethodGet, participantsPath, "dev-secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"participants":[]`) {
		t.Errorf("body = %s, want an empty participants array", rec.Body.String())
	}
}

// Both reads tell the refusals apart: an unknown instance, a group this account
// cannot see, a bot that is not an admin, a bridge whose session is down — and a
// bridge that is not there at all, which is the instance-offline answer too,
// because the Hermes session *is* the WhatsApp connection the read would have used.
func TestGroupReadsReportRefusalsHonestly(t *testing.T) {
	cases := []struct {
		name       string
		answer     func(*fakeBridge)
		instances  []string
		wantStatus int
		wantCode   string
	}{
		{"unknown instance", func(f *fakeBridge) { f.answering(http.StatusOK, `{"ok":true}`) }, nil, http.StatusNotFound, codeNotFound},
		{"not a participant", func(f *fakeBridge) { f.refusing("item-not-found") }, []string{"inst_1"}, http.StatusNotFound, codeGroupNotFound},
		{"not an admin", func(f *fakeBridge) { f.refusing("not-authorized") }, []string{"inst_1"}, http.StatusForbidden, codeNotAdmin},
		{"not confirmed", func(f *fakeBridge) { f.refusing("partial-server-error") }, []string{"inst_1"}, http.StatusBadGateway, codeGroupAdminFailed},
		{"bridge session down", func(f *fakeBridge) { f.notConnected() }, []string{"inst_1"}, http.StatusConflict, codeInstanceOffline},
		{"bridge not listening", func(f *fakeBridge) { f.server.Close() }, []string{"inst_1"}, http.StatusConflict, codeInstanceOffline},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bridge := newFakeBridge(t)
			tc.answer(bridge)
			handler := adminAPI(t, bridge, tc.instances...)
			for _, path := range []string{infoPath, participantsPath} {
				rec := callJSON(t, handler, http.MethodGet, path, "dev-secret", "")
				if rec.Code != tc.wantStatus {
					t.Fatalf("%s: status = %d, body = %s", path, rec.Code, rec.Body.String())
				}
				if got := decodeRefusal(t, rec).Code; got != tc.wantCode {
					t.Errorf("%s: code = %q, want %q", path, got, tc.wantCode)
				}
			}
		})
	}
}

// The path is caller input, so a non-group JID is refused before the bridge is
// asked anything.
func TestGroupReadsRejectANonGroupPath(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{"ok":true}`)
	handler := adminAPI(t, bridge, "inst_1")

	rec := callJSON(t, handler, http.MethodGet, "/instances/inst_1/groups/"+adminBotJID+"/info", "dev-secret", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s, want 400", rec.Code, rec.Body.String())
	}
	if got := decodeRefusal(t, rec).Code; got != codeInvalidRequest {
		t.Errorf("code = %q, want %q", got, codeInvalidRequest)
	}
	if calls := bridge.recorded(); len(calls) != 0 {
		t.Errorf("the bridge was asked about a non-group path: %+v", calls)
	}
}

// ---- writes --------------------------------------------------------------

func TestGroupAdminRenameReachesTheBridge(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{"ok":true}`)
	handler := adminAPI(t, bridge, "inst_1")

	rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", `{"action":"rename","name":"  Ops Team  "}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	call := bridge.only(t)
	if call.path != "/group/rename" {
		t.Fatalf("call = %s %s, want POST /group/rename", call.method, call.path)
	}
	if call.body["jid"] != adminGroupJID || call.body["subject"] != "Ops Team" {
		t.Errorf("body = %#v, want the group and the trimmed name", call.body)
	}
}

func TestGroupAdminAnnounceAndLockedReachTheBridge(t *testing.T) {
	for _, tc := range []struct {
		body   string
		field  string
		absent string
		want   bool
	}{
		{`{"action":"announce","announce":true}`, "announce", "locked", true},
		{`{"action":"announce","announce":false}`, "announce", "locked", false},
		{`{"action":"locked","locked":true}`, "locked", "announce", true},
		{`{"action":"locked","locked":false}`, "locked", "announce", false},
	} {
		bridge := newFakeBridge(t).answering(http.StatusOK, `{"ok":true}`)
		handler := adminAPI(t, bridge, "inst_1")
		rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", tc.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, body = %s", tc.body, rec.Code, rec.Body.String())
		}
		call := bridge.only(t)
		if call.path != "/group/settings" {
			t.Fatalf("%s: call = %s, want POST /group/settings", tc.body, call.path)
		}
		if call.body["jid"] != adminGroupJID {
			t.Errorf("%s: jid = %v, want %s", tc.body, call.body["jid"], adminGroupJID)
		}
		if got, ok := call.body[tc.field].(bool); !ok || got != tc.want {
			t.Errorf("%s: body[%q] = %#v, want %t", tc.body, tc.field, call.body[tc.field], tc.want)
		}
		// One action, one switch: sending the other one would change a setting the
		// owner did not approve.
		if _, ok := call.body[tc.absent]; ok {
			t.Errorf("%s: body carries %q, want only %q", tc.body, tc.absent, tc.field)
		}
	}
}

func TestGroupAdminPhotoDecodesTheDataURL(t *testing.T) {
	raw := []byte{0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03}
	dataURL := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(raw)
	bridge := newFakeBridge(t).answering(http.StatusOK, `{"ok":true,"pictureId":"pic_1"}`)
	handler := adminAPI(t, bridge, "inst_1")

	body := `{"action":"photo","dataUrl":"` + dataURL + `"}`
	rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var response struct {
		OK        bool   `json:"ok"`
		PictureID string `json:"pictureId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !response.OK || response.PictureID != "pic_1" {
		t.Errorf("response = %+v, want ok with pictureId pic_1", response)
	}
	call := bridge.only(t)
	if call.path != "/group/photo" || call.body["jid"] != adminGroupJID {
		t.Errorf("call = %s %+v, want POST /group/photo for %s", call.path, call.body, adminGroupJID)
	}
	if call.body["dataUrl"] != dataURL {
		t.Errorf("dataUrl = %v, want the image the operator approved", call.body["dataUrl"])
	}
}

// Membership answers per JID: a partial result must never be reported as a full
// one, and the JIDs WhatsApp did not confirm are named.
func TestGroupAdminMembershipReportsEveryJID(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{
		"ok": false,
		"results": [
			{"jid": "628111111111@s.whatsapp.net", "ok": true, "error": ""},
			{"jid": "628222222222@s.whatsapp.net", "ok": false, "error": "403"}
		],
		"failed": ["628222222222@s.whatsapp.net"]
	}`)
	handler := adminAPI(t, bridge, "inst_1")

	body := `{"action":"members","membership":"add","jids":["628111111111@s.whatsapp.net","628222222222@s.whatsapp.net","628333333333@s.whatsapp.net"]}`
	rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var response struct {
		OK      bool `json:"ok"`
		Results []struct {
			JID       string `json:"jid"`
			Status    string `json:"status"`
			ErrorCode int    `json:"errorCode"`
		} `json:"results"`
		Failed []string `json:"failed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.OK {
		t.Error("ok = true, want false: two of the three JIDs were not confirmed")
	}
	if len(response.Results) != 3 {
		t.Fatalf("results = %+v, want one per requested JID", response.Results)
	}
	want := []struct {
		jid    string
		status string
		code   int
	}{
		{"628111111111@s.whatsapp.net", "ok", 0},
		{"628222222222@s.whatsapp.net", "failed", 403},
		{"628333333333@s.whatsapp.net", "unreported", 0},
	}
	for i, w := range want {
		got := response.Results[i]
		if got.JID != w.jid || got.Status != w.status || got.ErrorCode != w.code {
			t.Errorf("result %d = %+v, want %s/%s/%d", i, got, w.jid, w.status, w.code)
		}
	}
	if len(response.Failed) != 2 || response.Failed[0] != want[1].jid || response.Failed[1] != want[2].jid {
		t.Errorf("failed = %v, want the two JIDs that were not confirmed", response.Failed)
	}

	call := bridge.only(t)
	if call.path != "/group/participants" {
		t.Fatalf("call = %s, want POST /group/participants", call.path)
	}
	if call.body["jid"] != adminGroupJID || call.body["membership"] != "add" {
		t.Errorf("body = %#v, want the group and the verb", call.body)
	}
	if !equalJSON(call.body["participants"], []string{"628111111111@s.whatsapp.net", "628222222222@s.whatsapp.net", "628333333333@s.whatsapp.net"}) {
		t.Errorf("participants = %#v, want the three requested JIDs in order", call.body["participants"])
	}
}

func TestGroupAdminMembershipCarriesTheVerbToTheBridge(t *testing.T) {
	for _, verb := range []string{"add", "remove", "promote", "demote"} {
		bridge := newFakeBridge(t).answering(http.StatusOK, `{
			"ok": true, "results": [{"jid": "628111111111@s.whatsapp.net", "ok": true, "error": ""}], "failed": []
		}`)
		handler := adminAPI(t, bridge, "inst_1")
		body := `{"action":"members","membership":"` + verb + `","jids":["628111111111@s.whatsapp.net"]}`
		rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, body = %s", verb, rec.Code, rec.Body.String())
		}
		if got := bridge.only(t).body["membership"]; got != verb {
			t.Fatalf("%s: bridge received membership %v, want the same verb", verb, got)
		}
		if !strings.Contains(rec.Body.String(), `"ok":true`) || !strings.Contains(rec.Body.String(), `"failed":[]`) {
			t.Errorf("%s: body = %s, want a confirmed change with no failures", verb, rec.Body.String())
		}
	}
}

// The answer is matched by address. A bridge that answers about a JID nobody asked
// about leaves the requested one unconfirmed — the worker never upgrades an
// unmentioned JID to a success, which is what keeps a partial change partial.
func TestGroupAdminMembershipTreatsAnUnmentionedAddressAsUnconfirmed(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{
		"ok": true, "results": [{"jid": "111222333@lid", "ok": true, "error": ""}], "failed": []
	}`)
	handler := adminAPI(t, bridge, "inst_1")

	body := `{"action":"members","membership":"add","jids":["628111111111@s.whatsapp.net"]}`
	rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var response struct {
		OK      bool `json:"ok"`
		Results []struct {
			Status string `json:"status"`
		} `json:"results"`
		Failed []string `json:"failed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.OK || len(response.Results) != 1 || response.Results[0].Status != membershipUnreported {
		t.Errorf("response = %+v, want one unconfirmed result", response)
	}
	if len(response.Failed) != 1 || response.Failed[0] != "628111111111@s.whatsapp.net" {
		t.Errorf("failed = %v, want the JID that was not confirmed", response.Failed)
	}
}

func TestGroupAdminLeaveAndRevokeReachTheBridge(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{"ok":true,"revokeMessageId":"3EB0A1B2C3"}`)
	handler := adminAPI(t, bridge, "inst_1")

	rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", `{"action":"leave"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("leave: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	call := bridge.only(t)
	if call.path != "/group/leave" || call.body["jid"] != adminGroupJID {
		t.Fatalf("leave: call = %s %+v, want POST /group/leave for %s", call.path, call.body, adminGroupJID)
	}

	rec = callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", `{"action":"revoke","waMessageId":"3EB0A1B2C3"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var response struct {
		OK              bool   `json:"ok"`
		RevokeMessageID string `json:"revokeMessageId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !response.OK || response.RevokeMessageID != "3EB0A1B2C3" {
		t.Errorf("response = %+v, want ok with the revoke's own message id", response)
	}
	call = bridge.recorded()[1]
	if call.path != "/message/revoke" || call.body["jid"] != adminGroupJID || call.body["messageId"] != "3EB0A1B2C3" {
		t.Errorf("revoke: call = %s %+v, want the group and the message id", call.path, call.body)
	}
}

// ---- refusals ------------------------------------------------------------

// Every way WhatsApp can say no is a documented code, with the status the BFF
// should show — never a 500, which would read as a worker bug.
func TestGroupAdminRefusalsBecomeDocumentedCodes(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		answer     func(*fakeBridge)
		wantStatus int
		wantCode   string
	}{
		{"not an admin", `{"action":"rename","name":"Ops"}`, func(f *fakeBridge) { f.refusing("forbidden") }, http.StatusForbidden, codeNotAdmin},
		{"left the group", `{"action":"leave"}`, func(f *fakeBridge) { f.refusing("item-not-found") }, http.StatusNotFound, codeGroupNotFound},
		{"group gone", `{"action":"locked","locked":true}`, func(f *fakeBridge) { f.refusing("item-not-found") }, http.StatusNotFound, codeGroupNotFound},
		{"membership refused", `{"action":"members","membership":"promote","jids":["628111111111@s.whatsapp.net"]}`, func(f *fakeBridge) { f.refusing("not-authorized") }, http.StatusForbidden, codeNotAdmin},
		{"revoke of an unknown message", `{"action":"revoke","waMessageId":"3EB0"}`, func(f *fakeBridge) { f.refusing("unknown message") }, http.StatusBadGateway, codeRevokeFailed},
		{"write not confirmed", `{"action":"announce","announce":true}`, func(f *fakeBridge) { f.refusing("partial-server-error") }, http.StatusBadGateway, codeGroupAdminFailed},
		{"bridge session down", `{"action":"leave"}`, func(f *fakeBridge) { f.notConnected() }, http.StatusConflict, codeInstanceOffline},
		{"bridge not listening", `{"action":"leave"}`, func(f *fakeBridge) { f.server.Close() }, http.StatusConflict, codeInstanceOffline},
		{"unknown instance", `{"action":"leave"}`, func(f *fakeBridge) { f.answering(http.StatusOK, `{"ok":true}`) }, http.StatusNotFound, codeNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bridge := newFakeBridge(t)
			tc.answer(bridge)
			instances := []string{"inst_1"}
			if tc.name == "unknown instance" {
				instances = nil
			}
			handler := adminAPI(t, bridge, instances...)
			rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", tc.body)
			if rec.Code == http.StatusInternalServerError {
				t.Fatalf("status = 500, body = %s, want a documented refusal", rec.Body.String())
			}
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, body = %s, want %d", rec.Code, rec.Body.String(), tc.wantStatus)
			}
			if got := decodeRefusal(t, rec).Code; got != tc.wantCode {
				t.Errorf("code = %q, want %q", got, tc.wantCode)
			}
		})
	}
}

// An unusable body is the caller's error and never reaches the bridge, so a bug in
// staging cannot move a group.
func TestGroupAdminInvalidRequestsReachNoBridge(t *testing.T) {
	bodies := map[string]string{
		"unknown action":              `{"action":"delete-everything"}`,
		"missing action":              `{}`,
		"announce without flag":       `{"action":"announce"}`,
		"locked without flag":         `{"action":"locked"}`,
		"empty name":                  `{"action":"rename","name":"   "}`,
		"over-long name":              `{"action":"rename","name":"` + strings.Repeat("n", maxGroupNameLength+1) + `"}`,
		"photo without data url":      `{"action":"photo","dataUrl":"notadataurl"}`,
		"photo with bad base64":       `{"action":"photo","dataUrl":"data:image/jpeg;base64,!!!"}`,
		"membership without jids":     `{"action":"members","membership":"add"}`,
		"membership with a group jid": `{"action":"members","membership":"add","jids":["` + adminGroupJID + `"]}`,
		"unknown membership verb":     `{"action":"members","membership":"elevate","jids":["628111111111@s.whatsapp.net"]}`,
		"revoke without message id":   `{"action":"revoke"}`,
		"malformed json":              `{"action":`,
	}
	for name, body := range bodies {
		t.Run(name, func(t *testing.T) {
			bridge := newFakeBridge(t).answering(http.StatusOK, `{"ok":true}`)
			handler := adminAPI(t, bridge, "inst_1")
			rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s, want 400", rec.Code, rec.Body.String())
			}
			if got := decodeRefusal(t, rec).Code; got != codeInvalidRequest {
				t.Errorf("code = %q, want %q", got, codeInvalidRequest)
			}
			if calls := bridge.recorded(); len(calls) != 0 {
				t.Errorf("an unusable body reached the bridge: %+v", calls)
			}
		})
	}
}

// The path names the chat, so a non-group JID is refused the same way a bad body
// is: it never reaches the bridge.
func TestGroupAdminRejectsANonGroupPath(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{"ok":true}`)
	handler := adminAPI(t, bridge, "inst_1")

	rec := callJSON(t, handler, http.MethodPost, "/instances/inst_1/groups/"+adminBotJID+"/admin", "dev-secret", `{"action":"leave"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s, want 400", rec.Code, rec.Body.String())
	}
	if got := decodeRefusal(t, rec).Code; got != codeInvalidRequest {
		t.Errorf("code = %q, want %q", got, codeInvalidRequest)
	}
	if calls := bridge.recorded(); len(calls) != 0 {
		t.Errorf("the bridge was asked about a non-group path: %+v", calls)
	}
}

// The whole surface stays behind the worker secret like every other
// control-plane route: these endpoints are destructive, so an unauthenticated
// caller must not reach one.
func TestGroupAdminSurfaceRequiresBearer(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{"ok":true}`)
	handler := adminAPI(t, bridge, "inst_1")

	for _, request := range []struct{ method, path, body string }{
		{http.MethodGet, infoPath, ""},
		{http.MethodGet, participantsPath, ""},
		{http.MethodPost, adminPath, `{"action":"leave"}`},
	} {
		rec := callJSON(t, handler, request.method, request.path, "wrong-secret", request.body)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: status = %d, want 401", request.method, request.path, rec.Code)
		}
	}
	if calls := bridge.recorded(); len(calls) != 0 {
		t.Errorf("an unauthorized request reached the bridge: %+v", calls)
	}
}

// A method the route does not serve is a 405, not a silent write.
func TestGroupAdminRejectsWrongMethods(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{"ok":true}`)
	handler := adminAPI(t, bridge, "inst_1")

	if rec := callJSON(t, handler, http.MethodGet, adminPath, "dev-secret", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET admin: status = %d, want 405", rec.Code)
	}
	for _, path := range []string{infoPath, participantsPath} {
		if rec := callJSON(t, handler, http.MethodPost, path, "dev-secret", ""); rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("POST %s: status = %d, want 405", path, rec.Code)
		}
	}
	if calls := bridge.recorded(); len(calls) != 0 {
		t.Errorf("a wrong method reached the bridge: %+v", calls)
	}
}
