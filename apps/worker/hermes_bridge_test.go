package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- the bridge as a test can drive it -----------------------------------

// bridgeCall is one call the worker made, decoded: the path says which endpoint,
// and the body is what the endpoint was told.
type bridgeCall struct {
	method string
	path   string
	body   map[string]any
}

// fakeBridge is one Hermes bridge: a real HTTP server standing where the container
// does, recording every call and answering with whatever the test set. A route's
// contract is proved by the call the bridge would have received — and by what its
// answer turned into — rather than by the handler's return value.
type fakeBridge struct {
	server *httptest.Server

	mu     sync.Mutex
	calls  []bridgeCall
	answer func(bridgeCall) (int, string)
}

func newFakeBridge(t *testing.T) *fakeBridge {
	t.Helper()
	bridge := &fakeBridge{}
	bridge.server = httptest.NewServer(http.HandlerFunc(bridge.serve))
	t.Cleanup(bridge.server.Close)
	return bridge
}

// answering replaces the answer every call gets: an HTTP status and a raw body, so
// a test can serve exactly what the bridge would (including nothing valid at all).
func (f *fakeBridge) answering(status int, body string) *fakeBridge {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answer = func(bridgeCall) (int, string) { return status, body }
	return f
}

// refusing makes every call answer the way the bridge reports a library refusal:
// the same 500 and the library's own message.
func (f *fakeBridge) refusing(message string) *fakeBridge {
	return f.answering(http.StatusInternalServerError, `{"ok":false,"error":`+quoteJSON(message)+`}`)
}

// notConnected makes every call answer as the bridge does when its WhatsApp
// session is down, which is the one state the worker still calls `instance_offline`.
func (f *fakeBridge) notConnected() *fakeBridge {
	return f.answering(http.StatusServiceUnavailable, `{"ok":false,"error":"whatsapp is not connected"}`)
}

func (f *fakeBridge) serve(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)); err == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &body)
	}
	call := bridgeCall{method: r.Method, path: r.URL.Path, body: body}
	f.mu.Lock()
	f.calls = append(f.calls, call)
	answer := f.answer
	f.mu.Unlock()

	status, payload := http.StatusOK, `{"ok":true}`
	if answer != nil {
		status, payload = answer(call)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, payload)
}

// recorded is every call the bridge received, in order.
func (f *fakeBridge) recorded() []bridgeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bridgeCall(nil), f.calls...)
}

// only returns the single call the bridge received, failing the test when the
// worker made none or more than one: an action is exactly one call, and a test
// that asserts the call must not silently accept two.
func (f *fakeBridge) only(t *testing.T) bridgeCall {
	t.Helper()
	calls := f.recorded()
	if len(calls) != 1 {
		t.Fatalf("bridge calls = %d (%+v), want exactly 1", len(calls), calls)
	}
	return calls[0]
}

// client is the production bridge client, pointed at this server.
func (f *fakeBridge) client(t *testing.T) *hermesBridge {
	t.Helper()
	bridge, err := newHermesBridge(f.server.URL)
	if err != nil {
		t.Fatalf("newHermesBridge(%q): %v", f.server.URL, err)
	}
	return bridge
}

// manager builds the manager a worker would build from a configuration that names
// this server as its bridge, so nothing test-only stands between a route and the
// bridge the route calls.
func (f *fakeBridge) manager(t *testing.T, groups groupStoreAPI, instances instanceRepo) *manager {
	t.Helper()
	cfg := testConfig()
	cfg.HermesBridgeURL = f.server.URL
	return newManager(cfg, groups, instances, nil)
}

// closedClient is the same client for a bridge that is not listening at all: the
// server is stopped first, so the next call cannot open a connection.
func (f *fakeBridge) closedClient(t *testing.T) *hermesBridge {
	t.Helper()
	bridge := f.client(t)
	f.server.Close()
	return bridge
}

// quoteJSON encodes a string as a JSON literal, so a refusal message carrying
// quotes or a backslash still parses on the other side.
func quoteJSON(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return `""`
	}
	return string(encoded)
}

// ---- the address the worker was pointed at -------------------------------

// TestNewHermesBridgeRejectsAnUnusableAddress is the configuration boundary: an
// address this worker cannot call is reported when it is built, not on the first
// group action, and it reads as "no bridge" — the same answer as a bridge that is
// not there.
func TestNewHermesBridgeRejectsAnUnusableAddress(t *testing.T) {
	for _, address := range []string{
		"",
		"   ",
		"127.0.0.1:3000",
		"ftp://127.0.0.1:3000",
		"http://",
		"not a url",
	} {
		if _, err := newHermesBridge(address); !errors.Is(err, errNoBridge) {
			t.Errorf("newHermesBridge(%q) = %v, want errNoBridge", address, err)
		}
	}
	bridge, err := newHermesBridge("http://127.0.0.1:3000/")
	if err != nil {
		t.Fatalf("newHermesBridge: %v", err)
	}
	if got, want := bridge.target("/group/x@g.us"), "http://127.0.0.1:3000/group/x@g.us"; got != want {
		t.Errorf("target = %q, want %q", got, want)
	}
}

// ---- the wire -------------------------------------------------------------

// TestHermesBridgeCallsTheEndpointEachOperationNames pins the worker's side of the
// bridge contract: which endpoint each operation is, and which fields it carries.
// A field renamed on either side fails here rather than in production.
func TestHermesBridgeCallsTheEndpointEachOperationNames(t *testing.T) {
	const (
		group = "120363043123456789@g.us"
		user  = "628990000009@s.whatsapp.net"
		other = "628111111111@s.whatsapp.net"
	)
	announce, locked := true, false
	cases := []struct {
		name   string
		call   func(t *testing.T, bridge *hermesBridge) error
		method string
		path   string
		want   map[string]any
	}{
		{
			name: "read a group",
			call: func(t *testing.T, b *hermesBridge) error {
				_, err := b.GroupInfo(context.Background(), group)
				return err
			},
			method: http.MethodGet, path: "/group/" + group, want: nil,
		},
		{
			name: "rename",
			call: func(t *testing.T, b *hermesBridge) error {
				return b.RenameGroup(context.Background(), group, "Ops Team")
			},
			method: http.MethodPost, path: "/group/rename",
			want: map[string]any{"jid": group, "subject": "Ops Team"},
		},
		{
			name: "announce",
			call: func(t *testing.T, b *hermesBridge) error {
				return b.SetGroupSettings(context.Background(), group, &announce, nil)
			},
			method: http.MethodPost, path: "/group/settings",
			want: map[string]any{"jid": group, "announce": true},
		},
		{
			name: "locked",
			call: func(t *testing.T, b *hermesBridge) error {
				return b.SetGroupSettings(context.Background(), group, nil, &locked)
			},
			method: http.MethodPost, path: "/group/settings",
			want: map[string]any{"jid": group, "locked": false},
		},
		{
			name: "photo",
			call: func(t *testing.T, b *hermesBridge) error {
				_, err := b.SetGroupPhoto(context.Background(), group, "data:image/jpeg;base64,AAAA")
				return err
			},
			method: http.MethodPost, path: "/group/photo",
			want: map[string]any{"jid": group, "dataUrl": "data:image/jpeg;base64,AAAA"},
		},
		{
			name: "membership",
			call: func(t *testing.T, b *hermesBridge) error {
				_, err := b.UpdateParticipants(context.Background(), group, "promote", []string{user, other})
				return err
			},
			method: http.MethodPost, path: "/group/participants",
			want: map[string]any{"jid": group, "membership": "promote", "participants": []any{user, other}},
		},
		{
			name: "leave",
			call: func(t *testing.T, b *hermesBridge) error {
				return b.LeaveGroup(context.Background(), group)
			},
			method: http.MethodPost, path: "/group/leave",
			want: map[string]any{"jid": group},
		},
		{
			name: "revoke",
			call: func(t *testing.T, b *hermesBridge) error {
				_, err := b.RevokeMessage(context.Background(), group, "3EB0A1B2C3")
				return err
			},
			method: http.MethodPost, path: "/message/revoke",
			want: map[string]any{"jid": group, "messageId": "3EB0A1B2C3"},
		},
		{
			name: "send plain text",
			call: func(t *testing.T, b *hermesBridge) error {
				_, err := b.SendText(context.Background(), group, "Ship it", quotedMessage{})
				return err
			},
			method: http.MethodPost, path: "/send",
			want: map[string]any{"chatId": group, "message": "Ship it"},
		},
		{
			name: "send a reply",
			call: func(t *testing.T, b *hermesBridge) error {
				_, err := b.SendText(context.Background(), group, "Answered", quotedMessage{ID: "3EB0OWNER", Participant: other})
				return err
			},
			method: http.MethodPost, path: "/send",
			want: map[string]any{
				"chatId": group, "message": "Answered",
				"replyTo": map[string]any{"messageId": "3EB0OWNER", "participant": other},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bridge := newFakeBridge(t).answering(http.StatusOK, `{"ok":true,"pictureId":"pic_1","revokeMessageId":"3EB0A1B2C3","messageId":"wa_sent_1"}`)
			if err := tc.call(t, bridge.client(t)); err != nil {
				t.Fatalf("call: %v", err)
			}
			call := bridge.only(t)
			if call.method != tc.method || call.path != tc.path {
				t.Fatalf("call = %s %s, want %s %s", call.method, call.path, tc.method, tc.path)
			}
			for key, want := range tc.want {
				if got := call.body[key]; !equalJSON(got, want) {
					t.Errorf("body[%q] = %#v, want %#v", key, got, want)
				}
			}
			if len(call.body) != len(tc.want) {
				t.Errorf("body = %#v, want exactly the fields %#v", call.body, tc.want)
			}
		})
	}
}

// equalJSON compares a decoded field with what the contract says it must be. Lists
// decode as []any, so the comparison is by value rather than by Go type.
func equalJSON(got, want any) bool {
	gotJSON, err := json.Marshal(got)
	if err != nil {
		return false
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		return false
	}
	return string(gotJSON) == string(wantJSON)
}

// TestHermesBridgeDecodesTheGroupRead reads the one answer with structure in it:
// the subject, the two switches, and every member's badge — including the null a
// plain member arrives as.
func TestHermesBridgeDecodesTheGroupRead(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{
		"ok": true,
		"subject": "Ops Team",
		"announce": true,
		"locked": false,
		"participants": [
			{"jid": "628990000009@s.whatsapp.net", "admin": "superadmin"},
			{"jid": "628111111111@s.whatsapp.net", "admin": "admin"},
			{"jid": "111222333@lid", "admin": null}
		]
	}`)

	info, err := bridge.client(t).GroupInfo(context.Background(), "120363043123456789@g.us")
	if err != nil {
		t.Fatalf("GroupInfo: %v", err)
	}
	if info.Subject != "Ops Team" || !info.Announce || info.Locked {
		t.Errorf("info = %+v, want the group's own subject and flags", info)
	}
	want := []bridgeParticipant{
		{JID: "628990000009@s.whatsapp.net", Admin: "superadmin"},
		{JID: "628111111111@s.whatsapp.net", Admin: "admin"},
		{JID: "111222333@lid"},
	}
	if len(info.Participants) != len(want) {
		t.Fatalf("participants = %+v, want %d", info.Participants, len(want))
	}
	for i := range want {
		if info.Participants[i] != want[i] {
			t.Errorf("participant %d = %+v, want %+v", i, info.Participants[i], want[i])
		}
	}
}

// TestHermesBridgeKeepsThePerJIDMembershipAnswer pins the partial-success payload:
// a JID WhatsApp refused and a JID it never mentioned both survive the trip, so
// the route above can report them. A bridge answer that dropped either would make
// an unconfirmed change look complete.
func TestHermesBridgeKeepsThePerJIDMembershipAnswer(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{
		"ok": false,
		"results": [
			{"jid": "628111111111@s.whatsapp.net", "ok": true, "error": ""},
			{"jid": "628222222222@s.whatsapp.net", "ok": false, "error": "403"}
		],
		"failed": ["628222222222@s.whatsapp.net"]
	}`)

	answer, err := bridge.client(t).UpdateParticipants(context.Background(), "120363043123456789@g.us", "add",
		[]string{"628111111111@s.whatsapp.net", "628222222222@s.whatsapp.net", "628333333333@s.whatsapp.net"})
	if err != nil {
		t.Fatalf("UpdateParticipants: %v", err)
	}
	if answer.OK {
		t.Error("ok = true, want the bridge's own false (not every JID was confirmed)")
	}
	if len(answer.Results) != 2 {
		t.Fatalf("results = %+v, want both entries", answer.Results)
	}
	if answer.Results[1].OK || answer.Results[1].Error != "403" {
		t.Errorf("second result = %+v, want the refused entry with its status", answer.Results[1])
	}
	if len(answer.Failed) != 1 || answer.Failed[0] != "628222222222@s.whatsapp.net" {
		t.Errorf("failed = %v, want the JID WhatsApp refused", answer.Failed)
	}
}

// TestHermesBridgeRefusesASendWithoutAnID is the acknowledgement rule: the id the
// bridge assigned is what the dispatcher stores, so a send the bridge answered
// without one is refused rather than recorded as delivered.
func TestHermesBridgeRefusesASendWithoutAnID(t *testing.T) {
	bridge := newFakeBridge(t).answering(http.StatusOK, `{"success":true}`)

	_, err := bridge.client(t).SendText(context.Background(), "120363043123456789@g.us", "Ship it", quotedMessage{})
	var refusal *bridgeRefusal
	if !errors.As(err, &refusal) {
		t.Fatalf("SendText = %v, want a refusal", err)
	}
	if refusal.Status != http.StatusOK {
		t.Errorf("refusal status = %d, want %d", refusal.Status, http.StatusOK)
	}
}

// ---- failures -------------------------------------------------------------

// TestHermesBridgeMapsATimeoutToTheUnreachableFailure is the deadline rule: a call
// no answer came back for is unreachable *and* a timeout, and the timeout is
// matched first — which is what stops the send path from retrying a message that
// may already have been delivered.
func TestHermesBridgeMapsATimeoutToTheUnreachableFailure(t *testing.T) {
	bridge := newFakeBridge(t)
	bridge.mu.Lock()
	bridge.answer = func(bridgeCall) (int, string) {
		time.Sleep(200 * time.Millisecond)
		return http.StatusOK, `{"ok":true}`
	}
	bridge.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := bridge.client(t).GroupInfo(ctx, "120363043123456789@g.us")
	if !errors.Is(err, errBridgeTimeout) {
		t.Errorf("GroupInfo = %v, want errBridgeTimeout", err)
	}
	if !errors.Is(err, errBridgeUnreachable) {
		t.Errorf("GroupInfo = %v, want it matched as errBridgeUnreachable too", err)
	}
	var refusal *bridgeRefusal
	if errors.As(err, &refusal) {
		t.Errorf("GroupInfo = %v, want a transport failure rather than a refusal", err)
	}
}

// TestHermesBridgeMapsARefusedConnectionToTheUnreachableFailure is the other half
// of that rule: a bridge this worker could not open a connection to is retryable,
// because nothing was handed over.
func TestHermesBridgeMapsARefusedConnectionToTheUnreachableFailure(t *testing.T) {
	bridge := newFakeBridge(t)
	client := bridge.closedClient(t)

	_, err := client.GroupInfo(context.Background(), "120363043123456789@g.us")
	if !errors.Is(err, errBridgeUnreachable) {
		t.Errorf("GroupInfo = %v, want errBridgeUnreachable", err)
	}
	if errors.Is(err, errBridgeTimeout) {
		t.Errorf("GroupInfo = %v, want a refused connection, not a timeout", err)
	}
}

// TestHermesBridgeMapsARefusal covers every answer that is not a usable success:
// the bridge's own "WhatsApp is not connected", a status it chose with a message,
// and answers this worker cannot read at all. Each is a refusal the caller can
// classify — never a panic, and never a silent success.
func TestHermesBridgeMapsARefusal(t *testing.T) {
	cases := []struct {
		name       string
		answer     func(*fakeBridge)
		wantStatus int
		wantIs     error
		wantMsg    string
	}{
		{
			name:   "session down",
			answer: func(f *fakeBridge) { f.notConnected() },
			// 503 has its own sentinel: the bridge refused, and nothing was applied.
			wantIs: errBridgeNotConnected,
		},
		{
			name:       "library refusal",
			answer:     func(f *fakeBridge) { f.refusing("not-authorized") },
			wantStatus: http.StatusInternalServerError,
			wantMsg:    "not-authorized",
		},
		{
			name:       "bad request",
			answer:     func(f *fakeBridge) { f.answering(http.StatusBadRequest, `{"ok":false,"error":"jid is required"}`) },
			wantStatus: http.StatusBadRequest,
			wantMsg:    "jid is required",
		},
		{
			name:       "unreadable answer",
			answer:     func(f *fakeBridge) { f.answering(http.StatusOK, `{"participants":`) },
			wantStatus: http.StatusOK,
			wantMsg:    "unreadable answer",
		},
		{
			name:       "empty answer",
			answer:     func(f *fakeBridge) { f.answering(http.StatusOK, "") },
			wantStatus: http.StatusOK,
			wantMsg:    "empty body",
		},
		{
			name:       "not even JSON",
			answer:     func(f *fakeBridge) { f.answering(http.StatusBadGateway, "<html>502</html>") },
			wantStatus: http.StatusBadGateway,
			wantMsg:    "502",
		},
		{
			name: "past the cap",
			answer: func(f *fakeBridge) {
				f.answering(http.StatusOK, `{"subject":"`+strings.Repeat("n", hermesBridgeBodyMaxBytes)+`"}`)
			},
			wantStatus: http.StatusOK,
			wantMsg:    "larger than",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bridge := newFakeBridge(t)
			tc.answer(bridge)

			_, err := bridge.client(t).GroupInfo(context.Background(), "120363043123456789@g.us")
			if err == nil {
				t.Fatal("GroupInfo succeeded, want a refusal")
			}
			if tc.wantIs != nil {
				if !errors.Is(err, tc.wantIs) {
					t.Fatalf("GroupInfo = %v, want %v", err, tc.wantIs)
				}
				return
			}
			var refusal *bridgeRefusal
			if !errors.As(err, &refusal) {
				t.Fatalf("GroupInfo = %v, want a refusal", err)
			}
			if refusal.Status != tc.wantStatus {
				t.Errorf("refusal status = %d, want %d", refusal.Status, tc.wantStatus)
			}
			if !strings.Contains(refusal.Message, tc.wantMsg) {
				t.Errorf("refusal message = %q, want it to carry %q", refusal.Message, tc.wantMsg)
			}
		})
	}
}

// TestMembershipErrorCodeReadsTheBridgeStatus pins the one field that has to change
// shape on the way through: the bridge reports WhatsApp's status as a string, the
// worker's own response carries it as the number the BFF's schema declares.
func TestMembershipErrorCodeReadsTheBridgeStatus(t *testing.T) {
	for raw, want := range map[string]int{
		"403":         403,
		" 409 ":       409,
		"":            0,
		"forbidden":   0,
		"0":           0,
		"not-num-ber": 0,
	} {
		if got := membershipErrorCode(raw); got != want {
			t.Errorf("membershipErrorCode(%q) = %d, want %d", raw, got, want)
		}
	}
}

// TestSameAccountMatchesTheTwoSpellingsOfOneAccount is the comparison the
// membership answer and the bot's own rights are both read with: a device suffix
// is a session of one account, and an address this worker cannot parse matches
// nothing — an empty identity must never look like a member.
func TestSameAccountMatchesTheTwoSpellingsOfOneAccount(t *testing.T) {
	cases := []struct {
		one, other string
		want       bool
	}{
		{"628990000009@s.whatsapp.net", "628990000009:5@s.whatsapp.net", true},
		{"111222333@lid", "111222333@lid", true},
		{"628990000009@s.whatsapp.net", "628990000009@lid", false},
		{"", "", false},
		{"", "628990000009@s.whatsapp.net", false},
		{"not a jid", "not a jid", true},
	}
	for _, tc := range cases {
		if got := sameAccount(tc.one, tc.other); got != tc.want {
			t.Errorf("sameAccount(%q, %q) = %t, want %t", tc.one, tc.other, got, tc.want)
		}
	}
}

// TestParseAddressRefusesWhatIsNotAnAddress keeps the path and body validation
// honest: what this parser refuses is what the routes answer 400 to.
func TestParseAddressRefusesWhatIsNotAnAddress(t *testing.T) {
	for _, raw := range []string{"", " ", "not a jid", "@g.us", "user@", "user@@g.us", "a b@g.us", "us er@s.whatsapp.net"} {
		if _, err := parseAddress(raw); err == nil {
			t.Errorf("parseAddress(%q) succeeded, want a refusal", raw)
		}
	}
	// A numeric user part is a legitimate group id, not a malformed address.
	group, err := parseAddress("120363043123456789@g.us")
	if err != nil {
		t.Fatalf("parseAddress: %v", err)
	}
	if !group.isGroup() || group.isUser() {
		t.Errorf("address = %+v, want a group address", group)
	}
	address, err := parseAddress(" 628990000009:12@s.whatsapp.net ")
	if err != nil {
		t.Fatalf("parseAddress: %v", err)
	}
	if got, want := address.String(), "628990000009@s.whatsapp.net"; got != want {
		t.Errorf("address = %q, want %q (the device suffix is not part of the account)", got, want)
	}
	if address.isGroup() || !address.isUser() {
		t.Errorf("address = %+v, want a user address", address)
	}
	if fmt.Sprint(waAddress{}) != "" {
		t.Errorf("the zero address must spell nothing, got %q", waAddress{}.String())
	}
}
