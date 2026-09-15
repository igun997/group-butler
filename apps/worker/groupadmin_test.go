package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

const (
	adminGroupJID    = "120363043123456789@g.us"
	adminBotJID      = "628990000009@s.whatsapp.net"
	adminPath        = "/instances/inst_1/groups/" + adminGroupJID + "/admin"
	infoPath         = "/instances/inst_1/groups/" + adminGroupJID + "/info"
	participantsPath = "/instances/inst_1/groups/" + adminGroupJID + "/participants"
)

// ---- fakes ---------------------------------------------------------------

// fakeAdminClient is the whatsmeow group surface the admin routes reach. Every
// call is recorded, so each route is proved by the call WhatsApp would have
// received — the arguments and all — rather than by the handler's return value.
// It embeds the lifecycle fake, so the same value can be the live session's
// client: the routes are then driven through the wiring production uses.
type fakeAdminClient struct {
	*fakeClient

	info    *types.GroupInfo
	infoErr error
	infoJID types.JID

	nameCalls     []recordedName
	announceCalls []recordedFlag
	lockedCalls   []recordedFlag
	photoCalls    []recordedPhoto
	memberCalls   []recordedMembers
	leaveCalls    []types.JID
	revokeCalls   []recordedRevoke

	// writeErr is what every write answers; a test sets the whatsmeow error it
	// wants the route to translate.
	writeErr error
	// photoID is the picture id SetGroupPhoto answers with.
	photoID string
	// members is the per-participant answer UpdateGroupParticipants returns.
	members []types.GroupParticipant
}

type recordedName struct {
	jid  types.JID
	name string
}

type recordedFlag struct {
	jid  types.JID
	flag bool
}

type recordedPhoto struct {
	jid    types.JID
	avatar []byte
}

type recordedMembers struct {
	jid    types.JID
	action whatsmeow.ParticipantChange
	jids   []types.JID
}

type recordedRevoke struct {
	chat types.JID
	id   types.MessageID
}

func (f *fakeAdminClient) GetGroupInfo(_ context.Context, jid types.JID) (*types.GroupInfo, error) {
	f.infoJID = jid
	if f.infoErr != nil {
		return nil, f.infoErr
	}
	if f.info == nil {
		return nil, whatsmeow.ErrGroupNotFound
	}
	return f.info, nil
}

func (f *fakeAdminClient) SetGroupName(_ context.Context, jid types.JID, name string) error {
	f.nameCalls = append(f.nameCalls, recordedName{jid: jid, name: name})
	return f.writeErr
}

func (f *fakeAdminClient) SetGroupAnnounce(_ context.Context, jid types.JID, announce bool) error {
	f.announceCalls = append(f.announceCalls, recordedFlag{jid: jid, flag: announce})
	return f.writeErr
}

func (f *fakeAdminClient) SetGroupLocked(_ context.Context, jid types.JID, locked bool) error {
	f.lockedCalls = append(f.lockedCalls, recordedFlag{jid: jid, flag: locked})
	return f.writeErr
}

func (f *fakeAdminClient) SetGroupPhoto(_ context.Context, jid types.JID, avatar []byte) (string, error) {
	f.photoCalls = append(f.photoCalls, recordedPhoto{jid: jid, avatar: avatar})
	return f.photoID, f.writeErr
}

func (f *fakeAdminClient) UpdateGroupParticipants(_ context.Context, jid types.JID, jids []types.JID, action whatsmeow.ParticipantChange) ([]types.GroupParticipant, error) {
	f.memberCalls = append(f.memberCalls, recordedMembers{jid: jid, action: action, jids: jids})
	return f.members, f.writeErr
}

func (f *fakeAdminClient) LeaveGroup(_ context.Context, jid types.JID) error {
	f.leaveCalls = append(f.leaveCalls, jid)
	return f.writeErr
}

func (f *fakeAdminClient) RevokeMessage(_ context.Context, chat types.JID, id types.MessageID) (whatsmeow.SendResponse, error) {
	f.revokeCalls = append(f.revokeCalls, recordedRevoke{chat: chat, id: id})
	return whatsmeow.SendResponse{ID: types.MessageID("wa_revoke_1")}, f.writeErr
}

// writeCalls counts every write the fake recorded, which is how a refused
// request is proved never to have reached WhatsApp.
func (f *fakeAdminClient) writeCalls() int {
	return len(f.nameCalls) + len(f.announceCalls) + len(f.lockedCalls) +
		len(f.photoCalls) + len(f.memberCalls) + len(f.leaveCalls) + len(f.revokeCalls)
}

// ---- the client surface's group-admin methods ----------------------------
//
// whatsmeowClient covers the group-admin writes the POST .../admin route makes,
// so the session fake must answer them. No test drives that route through a
// session — the admin surface is proved against fakeAdminClient above, which
// records every call — so reaching one of these is a mistake and says so.

func (c *fakeClient) SetGroupName(context.Context, types.JID, string) error {
	return errors.New("group admin is not exercised through the session fake")
}

func (c *fakeClient) SetGroupAnnounce(context.Context, types.JID, bool) error {
	return errors.New("group admin is not exercised through the session fake")
}

func (c *fakeClient) SetGroupLocked(context.Context, types.JID, bool) error {
	return errors.New("group admin is not exercised through the session fake")
}

func (c *fakeClient) SetGroupPhoto(context.Context, types.JID, []byte) (string, error) {
	return "", errors.New("group admin is not exercised through the session fake")
}

func (c *fakeClient) UpdateGroupParticipants(context.Context, types.JID, []types.JID, whatsmeow.ParticipantChange) ([]types.GroupParticipant, error) {
	return nil, errors.New("group admin is not exercised through the session fake")
}

func (c *fakeClient) LeaveGroup(context.Context, types.JID) error {
	return errors.New("group admin is not exercised through the session fake")
}

func (c *fakeClient) RevokeMessage(context.Context, types.JID, types.MessageID) (whatsmeow.SendResponse, error) {
	return whatsmeow.SendResponse{}, errors.New("group admin is not exercised through the session fake")
}

// ---- harness -------------------------------------------------------------

// adminSession wires the group surface the way a running worker does: a manager
// that knows the named instances, a connected session whose client is the
// recording fake, and the control-plane handler the manager itself builds. No
// test-only seam stands between the route and the client, so a route that works
// here works in production.
func adminSession(t *testing.T, client *fakeAdminClient, bot botIdentity, instances ...string) *api {
	t.Helper()
	rows := make([]InstanceRow, 0, len(instances))
	for _, id := range instances {
		rows = append(rows, InstanceRow{ID: id, OrganizationID: "org_default", Status: stateConnected})
	}
	mgr := testManager(newFakeInstanceRepo(rows...), newFakePairingStore(), nil, newFakeClient())
	if client != nil {
		session := testSession(mgr, client)
		session.status = stateConnected
		session.botJID = bot.JID.String()
		session.botLID = bot.LID.String()
		mgr.put(session)
	}
	return mgr.api()
}

// newAdminAPI is adminSession with the one bot identity every test but the LID
// one uses.
func newAdminAPI(t *testing.T, client *fakeAdminClient, instances ...string) *api {
	t.Helper()
	return adminSession(t, client, botIdentity{JID: types.NewJID("628990000009", types.DefaultUserServer)}, instances...)
}

// newFakeAdminClient is the recorded group surface with the lifecycle fake
// behind it, so it can be a session's client.
func newFakeAdminClient() *fakeAdminClient {
	return &fakeAdminClient{fakeClient: newFakeClient()}
}

// adminRefusal is the one error envelope every route on this surface answers
// with, decoded so the code — not the status alone — is asserted.
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
	client := &fakeAdminClient{fakeClient: newFakeClient(), info: &types.GroupInfo{
		JID:              types.NewJID("120363043123456789", types.GroupServer),
		GroupName:        types.GroupName{Name: "Ops Team"},
		GroupTopic:       types.GroupTopic{Topic: "Only ops talk here"},
		GroupAnnounce:    types.GroupAnnounce{IsAnnounce: true},
		GroupLocked:      types.GroupLocked{IsLocked: true},
		ParticipantCount: 3,
		Participants: []types.GroupParticipant{
			{JID: types.NewJID("628990000009", types.DefaultUserServer), IsAdmin: true},
			{JID: types.NewJID("628111111111", types.DefaultUserServer)},
			{JID: types.NewJID("628222222222", types.DefaultUserServer)},
		},
	}}
	handler := newAdminAPI(t, client, "inst_1")

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
	if body.Name != "Ops Team" || body.Topic != "Only ops talk here" {
		t.Errorf("name = %q, topic = %q", body.Name, body.Topic)
	}
	if !body.IsAnnounce || !body.IsLocked {
		t.Errorf("isAnnounce = %t, isLocked = %t, want both true (the live flags)", body.IsAnnounce, body.IsLocked)
	}
	if body.ParticipantCount != 3 {
		t.Errorf("participantCount = %d, want 3", body.ParticipantCount)
	}
	if !body.BotIsAdmin || body.BotIsSuperAdmin {
		t.Errorf("botIsAdmin = %t, botIsSuperAdmin = %t, want true and false", body.BotIsAdmin, body.BotIsSuperAdmin)
	}
	if got := client.infoJID.String(); got != adminGroupJID {
		t.Errorf("GetGroupInfo asked for %q, want %q", got, adminGroupJID)
	}
}

// A group that addresses its members by LID must still recognise the bot, so the
// admin flags are matched against the bot's LID as well as its phone JID.
func TestGroupInfoEndpointMatchesTheBotByLID(t *testing.T) {
	client := &fakeAdminClient{fakeClient: newFakeClient(), info: &types.GroupInfo{
		JID:              types.NewJID("120363043123456789", types.GroupServer),
		ParticipantCount: 1,
		Participants: []types.GroupParticipant{
			{JID: types.NewJID("111222333", types.HiddenUserServer), IsAdmin: true, IsSuperAdmin: true},
		},
	}}
	handler := adminSession(t, client, botIdentity{LID: types.NewJID("111222333", types.HiddenUserServer)}, "inst_1")

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

func TestGroupParticipantsEndpointServesTheLiveMembership(t *testing.T) {
	client := &fakeAdminClient{fakeClient: newFakeClient(), info: &types.GroupInfo{
		JID:              types.NewJID("120363043123456789", types.GroupServer),
		ParticipantCount: 2,
		Participants: []types.GroupParticipant{
			{JID: types.NewJID("628111111111", types.DefaultUserServer), IsAdmin: true, DisplayName: "anon-11"},
			{JID: types.NewJID("628222222222", types.DefaultUserServer), IsAdmin: true, IsSuperAdmin: true},
		},
	}}
	handler := newAdminAPI(t, client, "inst_1")

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
	if first.DisplayName != "anon-11" {
		t.Errorf("displayName = %q, want the name WhatsApp supplied", first.DisplayName)
	}
	if second.JID != "628222222222@s.whatsapp.net" || !second.IsSuperAdmin || !second.IsAdmin {
		t.Errorf("second = %+v, want a superadmin 628222222222", second)
	}
	if second.DisplayName != "" {
		t.Errorf("displayName = %q, want it absent when WhatsApp supplies none", second.DisplayName)
	}
}

// A group with no members is an empty list, not a null the BFF would have to
// special-case.
func TestGroupParticipantsEndpointAnswersAnEmptyList(t *testing.T) {
	client := &fakeAdminClient{fakeClient: newFakeClient(), info: &types.GroupInfo{JID: types.NewJID("120363043123456789", types.GroupServer)}}
	handler := newAdminAPI(t, client, "inst_1")

	rec := callJSON(t, handler, http.MethodGet, participantsPath, "dev-secret", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"participants":[]`) {
		t.Errorf("body = %s, want an empty participants array", rec.Body.String())
	}
}

// Both reads tell the three refusals apart: an unknown instance, a group this
// account cannot see, and an instance with no live client at all.
func TestGroupReadsReportRefusalsHonestly(t *testing.T) {
	cases := []struct {
		name       string
		client     *fakeAdminClient
		instances  []string
		wantStatus int
		wantCode   string
	}{
		{"unknown instance", nil, nil, http.StatusNotFound, codeNotFound},
		{"not a participant", &fakeAdminClient{fakeClient: newFakeClient(), infoErr: whatsmeow.ErrNotInGroup}, []string{"inst_1"}, http.StatusNotFound, codeGroupNotFound},
		{"group does not exist", &fakeAdminClient{fakeClient: newFakeClient(), infoErr: whatsmeow.ErrGroupNotFound}, []string{"inst_1"}, http.StatusNotFound, codeGroupNotFound},
		{"instance offline", nil, []string{"inst_1"}, http.StatusConflict, codeInstanceOffline},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler := newAdminAPI(t, tc.client, tc.instances...)
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

// ---- writes --------------------------------------------------------------

func TestGroupAdminRenameReachesWhatsmeow(t *testing.T) {
	client := newFakeAdminClient()
	handler := newAdminAPI(t, client, "inst_1")

	rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", `{"action":"rename","name":"  Ops Team  "}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if len(client.nameCalls) != 1 {
		t.Fatalf("SetGroupName calls = %d, want 1", len(client.nameCalls))
	}
	call := client.nameCalls[0]
	if call.jid.String() != adminGroupJID || call.name != "Ops Team" {
		t.Errorf("SetGroupName(%s, %q), want (%s, %q)", call.jid, call.name, adminGroupJID, "Ops Team")
	}
}

func TestGroupAdminAnnounceAndLockedReachWhatsmeow(t *testing.T) {
	for _, tc := range []struct {
		body string
		want bool
	}{
		{`{"action":"announce","announce":true}`, true},
		{`{"action":"announce","announce":false}`, false},
	} {
		client := newFakeAdminClient()
		handler := newAdminAPI(t, client, "inst_1")
		rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", tc.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, body = %s", tc.body, rec.Code, rec.Body.String())
		}
		if len(client.announceCalls) != 1 || client.announceCalls[0].flag != tc.want {
			t.Fatalf("%s: SetGroupAnnounce calls = %+v, want one with %t", tc.body, client.announceCalls, tc.want)
		}
		if client.announceCalls[0].jid.String() != adminGroupJID {
			t.Errorf("%s: announce addressed %s, want %s", tc.body, client.announceCalls[0].jid, adminGroupJID)
		}
	}

	client := newFakeAdminClient()
	handler := newAdminAPI(t, client, "inst_1")
	rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", `{"action":"locked","locked":false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if len(client.lockedCalls) != 1 || client.lockedCalls[0].flag {
		t.Fatalf("SetGroupLocked calls = %+v, want one with false", client.lockedCalls)
	}
}

func TestGroupAdminPhotoDecodesTheDataURL(t *testing.T) {
	raw := []byte{0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03}
	client := &fakeAdminClient{fakeClient: newFakeClient(), photoID: "pic_1"}
	handler := newAdminAPI(t, client, "inst_1")

	body := `{"action":"photo","dataUrl":"data:image/jpeg;base64,` + base64.StdEncoding.EncodeToString(raw) + `"}`
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
	if len(client.photoCalls) != 1 {
		t.Fatalf("SetGroupPhoto calls = %d, want 1", len(client.photoCalls))
	}
	call := client.photoCalls[0]
	if call.jid.String() != adminGroupJID {
		t.Errorf("photo addressed %s, want %s", call.jid, adminGroupJID)
	}
	if string(call.avatar) != string(raw) {
		t.Errorf("avatar = %v, want the decoded image bytes %v", call.avatar, raw)
	}
}

// Membership answers per JID: a partial result must never be reported as a full
// one, and the JIDs WhatsApp did not confirm are named.
func TestGroupAdminMembershipReportsEveryJID(t *testing.T) {
	client := &fakeAdminClient{fakeClient: newFakeClient(), members: []types.GroupParticipant{
		{JID: types.NewJID("628111111111", types.DefaultUserServer)},
		{JID: types.NewJID("628222222222", types.DefaultUserServer), Error: 403},
	}}
	handler := newAdminAPI(t, client, "inst_1")

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

	if len(client.memberCalls) != 1 {
		t.Fatalf("UpdateGroupParticipants calls = %d, want 1", len(client.memberCalls))
	}
	call := client.memberCalls[0]
	if call.action != whatsmeow.ParticipantChangeAdd || call.jid.String() != adminGroupJID {
		t.Errorf("UpdateGroupParticipants(%s, %v, %s), want add on %s", call.jid, call.jids, call.action, adminGroupJID)
	}
	if len(call.jids) != 3 || call.jids[0].String() != want[0].jid || call.jids[2].String() != want[2].jid {
		t.Errorf("participants = %v, want the three requested JIDs in order", call.jids)
	}
}

func TestGroupAdminMembershipCarriesTheVerbToWhatsmeow(t *testing.T) {
	for verb, want := range map[string]whatsmeow.ParticipantChange{
		"add":     whatsmeow.ParticipantChangeAdd,
		"remove":  whatsmeow.ParticipantChangeRemove,
		"promote": whatsmeow.ParticipantChangePromote,
		"demote":  whatsmeow.ParticipantChangeDemote,
	} {
		client := &fakeAdminClient{fakeClient: newFakeClient(), members: []types.GroupParticipant{{JID: types.NewJID("628111111111", types.DefaultUserServer)}}}
		handler := newAdminAPI(t, client, "inst_1")
		body := `{"action":"members","membership":"` + verb + `","jids":["628111111111@s.whatsapp.net"]}`
		rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, body = %s", verb, rec.Code, rec.Body.String())
		}
		if len(client.memberCalls) != 1 || client.memberCalls[0].action != want {
			t.Fatalf("%s: calls = %+v, want action %s", verb, client.memberCalls, want)
		}
		if !strings.Contains(rec.Body.String(), `"ok":true`) || !strings.Contains(rec.Body.String(), `"failed":[]`) {
			t.Errorf("%s: body = %s, want a confirmed change with no failures", verb, rec.Body.String())
		}
	}
}

// A member WhatsApp answers about under the account's other address is still
// confirmed: the caller must not see a spurious failure because a LID and a
// phone JID name the same person.
func TestGroupAdminMembershipMatchesTheAccountsOtherAddress(t *testing.T) {
	client := &fakeAdminClient{fakeClient: newFakeClient(), members: []types.GroupParticipant{{
		JID:         types.NewJID("111222333", types.HiddenUserServer),
		PhoneNumber: types.NewJID("628111111111", types.DefaultUserServer),
	}}}
	handler := newAdminAPI(t, client, "inst_1")

	body := `{"action":"members","membership":"add","jids":["628111111111@s.whatsapp.net"]}`
	rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var response struct {
		OK      bool `json:"ok"`
		Results []struct {
			JID    string `json:"jid"`
			Status string `json:"status"`
		} `json:"results"`
		Failed []string `json:"failed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !response.OK || len(response.Results) != 1 || response.Results[0].Status != membershipOK {
		t.Errorf("response = %+v, want one confirmed result", response)
	}
	if len(response.Failed) != 0 {
		t.Errorf("failed = %v, want none", response.Failed)
	}
}

func TestGroupAdminLeaveAndRevokeReachWhatsmeow(t *testing.T) {
	client := newFakeAdminClient()
	handler := newAdminAPI(t, client, "inst_1")

	rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", `{"action":"leave"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("leave: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if len(client.leaveCalls) != 1 || client.leaveCalls[0].String() != adminGroupJID {
		t.Fatalf("LeaveGroup calls = %v, want one for %s", client.leaveCalls, adminGroupJID)
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
	if !response.OK || response.RevokeMessageID != "wa_revoke_1" {
		t.Errorf("response = %+v, want ok with the revoke's own message id", response)
	}
	if len(client.revokeCalls) != 1 {
		t.Fatalf("RevokeMessage calls = %d, want 1", len(client.revokeCalls))
	}
	call := client.revokeCalls[0]
	if call.chat.String() != adminGroupJID || call.id != types.MessageID("3EB0A1B2C3") {
		t.Errorf("RevokeMessage(%s, %s), want (%s, 3EB0A1B2C3)", call.chat, call.id, adminGroupJID)
	}
}

// ---- refusals ------------------------------------------------------------

// Every way WhatsApp can say no is a documented code, with the status the BFF
// should show — never a 500, which would read as a worker bug.
func TestGroupAdminRefusalsBecomeDocumentedCodes(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		client     *fakeAdminClient
		wantStatus int
		wantCode   string
	}{
		{"not an admin", `{"action":"rename","name":"Ops"}`, &fakeAdminClient{fakeClient: newFakeClient(), writeErr: whatsmeow.ErrIQForbidden}, http.StatusForbidden, codeNotAdmin},
		{"left the group", `{"action":"leave"}`, &fakeAdminClient{fakeClient: newFakeClient(), writeErr: whatsmeow.ErrNotInGroup}, http.StatusNotFound, codeGroupNotFound},
		{"group gone", `{"action":"locked","locked":true}`, &fakeAdminClient{fakeClient: newFakeClient(), writeErr: whatsmeow.ErrGroupNotFound}, http.StatusNotFound, codeGroupNotFound},
		{"membership refused", `{"action":"members","membership":"promote","jids":["628111111111@s.whatsapp.net"]}`, &fakeAdminClient{fakeClient: newFakeClient(), writeErr: whatsmeow.ErrIQForbidden}, http.StatusForbidden, codeNotAdmin},
		{"revoke of an unknown message", `{"action":"revoke","waMessageId":"3EB0"}`, &fakeAdminClient{fakeClient: newFakeClient(), writeErr: errors.New("unknown message")}, http.StatusBadGateway, codeRevokeFailed},
		{"write not confirmed", `{"action":"announce","announce":true}`, &fakeAdminClient{fakeClient: newFakeClient(), writeErr: errors.New("partial-server-error")}, http.StatusBadGateway, codeGroupAdminFailed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handler := newAdminAPI(t, tc.client, "inst_1")
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

// An unusable body is the caller's error and never reaches WhatsApp, so a bug in
// staging cannot move a group.
func TestGroupAdminInvalidRequestsReachNoClient(t *testing.T) {
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
			client := newFakeAdminClient()
			handler := newAdminAPI(t, client, "inst_1")
			rec := callJSON(t, handler, http.MethodPost, adminPath, "dev-secret", body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s, want 400", rec.Code, rec.Body.String())
			}
			if got := decodeRefusal(t, rec).Code; got != codeInvalidRequest {
				t.Errorf("code = %q, want %q", got, codeInvalidRequest)
			}
			if calls := client.writeCalls(); calls != 0 {
				t.Errorf("write calls = %d, want 0", calls)
			}
		})
	}
}

// The path names the chat, so a non-group JID is refused the same way a bad body
// is: it never reaches WhatsApp.
func TestGroupAdminRejectsANonGroupPath(t *testing.T) {
	client := newFakeAdminClient()
	handler := newAdminAPI(t, client, "inst_1")

	rec := callJSON(t, handler, http.MethodPost, "/instances/inst_1/groups/628990000009@s.whatsapp.net/admin", "dev-secret", `{"action":"leave"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s, want 400", rec.Code, rec.Body.String())
	}
	if got := decodeRefusal(t, rec).Code; got != codeInvalidRequest {
		t.Errorf("code = %q, want %q", got, codeInvalidRequest)
	}
	if client.writeCalls() != 0 {
		t.Errorf("write calls = %d, want 0", client.writeCalls())
	}
}

// The whole surface stays behind the worker secret like every other
// control-plane route: these endpoints are destructive, so an unauthenticated
// caller must not reach one.
func TestGroupAdminSurfaceRequiresBearer(t *testing.T) {
	client := &fakeAdminClient{fakeClient: newFakeClient(), info: &types.GroupInfo{JID: types.NewJID("120363043123456789", types.GroupServer)}}
	handler := newAdminAPI(t, client, "inst_1")

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
	if client.writeCalls() != 0 || !client.infoJID.IsEmpty() {
		t.Errorf("an unauthorized request reached the client: writes = %d, info = %s", client.writeCalls(), client.infoJID)
	}
}

// A method the route does not serve is a 405, not a silent write.
func TestGroupAdminRejectsWrongMethods(t *testing.T) {
	client := newFakeAdminClient()
	handler := newAdminAPI(t, client, "inst_1")

	if rec := callJSON(t, handler, http.MethodGet, adminPath, "dev-secret", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET admin: status = %d, want 405", rec.Code)
	}
	for _, path := range []string{infoPath, participantsPath} {
		if rec := callJSON(t, handler, http.MethodPost, path, "dev-secret", ""); rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("POST %s: status = %d, want 405", path, rec.Code)
		}
	}
	if client.writeCalls() != 0 {
		t.Errorf("write calls = %d, want 0", client.writeCalls())
	}
}
