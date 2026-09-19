package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// This file is the worker's WhatsApp connection now.
//
// Hermes Agent owns the linked device: the session, the keys and the socket live
// in its container, where the bridge sees every message as it arrives. The
// operations the worker used to perform on a session of its own — reading a group,
// renaming one, changing who is in it, sending a message — are exposed by
// that bridge over loopback HTTP, alongside the endpoints Hermes already had
// (infra/hermes). What is left here is the client for them.
//
// WHY an HTTP client rather than an abstraction with several implementations:
// there is exactly one bridge, its contract is fixed by the service that serves
// it, and each surface's job is to keep the *worker's* HTTP contract unchanged
// while its answers now come from across the loopback. The refusals an owner can
// act on (a group we cannot see, a bot that is not an admin, a membership change
// WhatsApp confirmed only in part) are mapped onto the worker's existing codes in
// groupadmin.go; everything else stays an unconfirmed change.

const (
	// defaultHermesBridgeURL is where the bridge listens. Loopback, because the
	// bridge binds 127.0.0.1 inside the Hermes container and carries no
	// authentication of its own — a routable address would expose every group
	// action to anyone who can reach the port.
	defaultHermesBridgeURL = "http://127.0.0.1:3000"

	// hermesBridgeTimeout bounds one call. The bridge answers when WhatsApp has
	// answered, so a call that outlives this is one whose fate the worker cannot
	// report — which is why a timeout is kept apart from a refusal below.
	hermesBridgeTimeout = 15 * time.Second

	// hermesBridgeBodyMaxBytes bounds one answer before it is decoded. The largest
	// documented answer is a group's membership; the cap is a memory bound, not a
	// tuned size, and an answer past it is refused rather than buffered.
	hermesBridgeBodyMaxBytes = 256 * 1024
)

// The ways a bridge call can come back without an answer, kept apart because the
// sender's safety depends on the difference: a call that never reached the bridge
// cannot have been applied, while one that timed out may already have been.
var (
	// errBridgeUnreachable: the call produced no answer — the bridge is not
	// running, not listening on the configured address, or answered something
	// unusable. Nothing was applied.
	errBridgeUnreachable = errors.New("the hermes bridge did not answer")

	// errBridgeTimeout wraps it: the call was made and no answer came in time, so a
	// write may or may not have been applied. It is matched before its parent,
	// which is what lets the send path treat the two differently.
	errBridgeTimeout = fmt.Errorf("%w: no answer in time", errBridgeUnreachable)

	// errBridgeNotConnected wraps it: the bridge answered that its WhatsApp session
	// is down. That is a refusal rather than an unknown fate — nothing was applied —
	// and it is the one state the worker's own `instance_offline` still describes.
	errBridgeNotConnected = fmt.Errorf("%w: whatsapp is not connected", errBridgeUnreachable)

	// errNoBridge: this process has no bridge address at all. loadConfig rejects an
	// unusable URL, so this only surfaces in a worker assembled without one, and it
	// reads to a caller exactly like a bridge that is not there.
	errNoBridge = errors.New("this worker has no hermes bridge configured")
)

// bridgeRefusal is the bridge's answer to a call it would not perform: the status
// it chose and the message it gave. The message is the only place WhatsApp's own
// reason survives — the bridge reports every library refusal as the same 500 —
// which is why groupadmin.go reads it for the two codes an operator can act on.
type bridgeRefusal struct {
	Status  int
	Message string
}

func (e *bridgeRefusal) Error() string {
	return fmt.Sprintf("hermes bridge refused (%d): %s", e.Status, e.Message)
}

// hermesBridge calls the bridge. One value serves the process: it holds a client
// whose deadline is the per-call one, so no caller can leave a call unbounded by
// forgetting a context deadline.
type hermesBridge struct {
	base   *url.URL
	client *http.Client
}

// newHermesBridge parses the configured base URL. A URL the worker cannot call is
// reported as errNoBridge rather than kept for the next call to trip over: every
// group route answers the same "no live session" refusal whether the address is
// missing or unusable.
func newHermesBridge(rawURL string) (*hermesBridge, error) {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return nil, errNoBridge
	}
	base, err := url.ParseRequestURI(trimmed)
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") {
		return nil, fmt.Errorf("%w: %q is not an absolute HTTP(S) URL", errNoBridge, rawURL)
	}
	return &hermesBridge{base: base, client: &http.Client{Timeout: hermesBridgeTimeout}}, nil
}

// target is the absolute URL of one bridge endpoint. `path` always starts with a
// slash, so the base's own path (when a deployment mounts the bridge under one)
// is preserved rather than replaced.
func (b *hermesBridge) target(path string) string {
	return strings.TrimSuffix(b.base.String(), "/") + path
}

// do performs one call and decodes its answer.
//
// The two failure kinds a caller must tell apart are decided here: a transport
// failure that produced no answer at all (errBridgeUnreachable, or errBridgeTimeout
// when the deadline is what ended the call), and a bridge that answered and
// refused (bridgeRefusal, or errBridgeNotConnected for its own "not connected").
func (b *hermesBridge) do(ctx context.Context, method, path string, payload, out any) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("encoding the %s request: %w", path, err)
		}
		body = bytes.NewReader(encoded)
	}
	// The caller's deadline can be shorter than the per-call cap — a dashboard that
	// has already given up, or a shutting-down worker — so both are applied and the
	// first one to fire ends the call.
	ctx, cancel := context.WithTimeout(ctx, hermesBridgeTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, method, b.target(path), body)
	if err != nil {
		return fmt.Errorf("%w: %s: %v", errBridgeUnreachable, path, err)
	}
	request.Header.Set("Accept", "application/json")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := b.client.Do(request)
	if err != nil {
		return b.transportFailure(path, err)
	}
	defer func() { _ = response.Body.Close() }()

	answer, err := readBridgeAnswer(response.Body)
	if err != nil {
		// The call went out and its answer cannot be used: that is a refusal this
		// worker cannot confirm, not an unreachable bridge.
		return &bridgeRefusal{Status: response.StatusCode, Message: err.Error()}
	}
	// 503 is the bridge's only "WhatsApp is not connected" answer, on every route.
	if response.StatusCode == http.StatusServiceUnavailable {
		return errBridgeNotConnected
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return &bridgeRefusal{Status: response.StatusCode, Message: refusalMessage(answer, response.Status)}
	}
	if out == nil {
		return nil
	}
	if len(bytes.TrimSpace(answer)) == 0 {
		// A call that carries data must answer with it: an empty 200 is an answer
		// this worker cannot use, and reading it as an empty group would claim a
		// membership nobody reported.
		return &bridgeRefusal{Status: response.StatusCode, Message: "the bridge answered with an empty body"}
	}
	if err := json.Unmarshal(answer, out); err != nil {
		return &bridgeRefusal{Status: response.StatusCode, Message: fmt.Sprintf("unreadable answer: %v", err)}
	}
	return nil
}

// transportFailure classifies a call that produced no HTTP answer.
//
// A deadline is separated from a refused connection because the two mean
// different things to a write: a connection this worker could not open cannot
// have delivered anything, while a call that timed out may have been applied
// already. The distinction is what the send path's retry rule is built on.
func (b *hermesBridge) transportFailure(path string, err error) error {
	sentinel := errBridgeUnreachable
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		sentinel = errBridgeTimeout
	}
	return fmt.Errorf("%w: %s: %v", sentinel, path, err)
}

// readBridgeAnswer reads one bounded answer. A body past the cap is refused
// rather than buffered, and so is a body that cannot be read to the end.
func readBridgeAnswer(body io.Reader) ([]byte, error) {
	answer, err := io.ReadAll(io.LimitReader(body, hermesBridgeBodyMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(answer) > hermesBridgeBodyMaxBytes {
		return nil, fmt.Errorf("answer is larger than %d bytes", hermesBridgeBodyMaxBytes)
	}
	return answer, nil
}

// refusalMessage reads the bridge's own error text, falling back to the status
// line when it answered something else entirely (an HTML error page, a proxy).
func refusalMessage(answer []byte, status string) string {
	var envelope struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(answer, &envelope); err == nil && strings.TrimSpace(envelope.Error) != "" {
		return strings.TrimSpace(envelope.Error)
	}
	return status
}

// ---- group reads ---------------------------------------------------------

// bridgeGroupInfo is `GET /group/:jid`: the group as WhatsApp reports it now.
//
// The bridge's contract carries no topic and no display names, so the worker's
// own responses keep their fields and report them empty rather than inventing a
// value — see groupadmin.go for the response shapes that do not change.
type bridgeGroupInfo struct {
	Subject      string              `json:"subject"`
	Announce     bool                `json:"announce"`
	Locked       bool                `json:"locked"`
	Participants []bridgeParticipant `json:"participants"`
}

// bridgeParticipant is one member: the address the group lists, and the badge
// WhatsApp gave it — "superadmin", "admin", or empty for a plain member.
type bridgeParticipant struct {
	JID   string `json:"jid"`
	Admin string `json:"admin"`
}

// GroupInfo asks the bridge for one group's live metadata. The JID is escaped
// into the path because it is caller input, exactly as the payloads below carry
// it as data.
func (b *hermesBridge) GroupInfo(ctx context.Context, jid string) (bridgeGroupInfo, error) {
	var answer bridgeGroupInfo
	if err := b.do(ctx, http.MethodGet, "/group/"+url.PathEscape(jid), nil, &answer); err != nil {
		return bridgeGroupInfo{}, err
	}
	return answer, nil
}

// bridgeGroupSummary is one row of `GET /groups`: every group the linked account
// participates in, as WhatsApp lists it. It carries the same four facts the
// single-group read does — the id, the subject and the two switches — plus the
// member count, and deliberately nothing else (no topic, no roster, no rename
// stamp), which is why a full sync refreshes only those.
type bridgeGroupSummary struct {
	JID              string `json:"jid"`
	Subject          string `json:"subject"`
	Announce         bool   `json:"announce"`
	Locked           bool   `json:"locked"`
	ParticipantCount int    `json:"participantCount"`
}

// Groups asks the bridge for every group the account is in. It is the one
// question a caller cannot answer from a JID it already knows, which is what a
// full group sync is: without it the stored read model could only hold groups
// somebody had mentioned, and a group the account was added to would stay
// invisible. The worker's own session used to ask this of WhatsApp; the bridge
// asks the same account the console is paired to.
func (b *hermesBridge) Groups(ctx context.Context) ([]bridgeGroupSummary, error) {
	var answer struct {
		Groups []bridgeGroupSummary `json:"groups"`
	}
	if err := b.do(ctx, http.MethodGet, "/groups", nil, &answer); err != nil {
		return nil, err
	}
	return answer.Groups, nil
}

// ---- group writes --------------------------------------------------------

// RenameGroup changes a group's subject.
func (b *hermesBridge) RenameGroup(ctx context.Context, jid, subject string) error {
	return b.do(ctx, http.MethodPost, "/group/rename", map[string]string{"jid": jid, "subject": subject}, nil)
}

// SetGroupSettings flips the two switches the bridge knows. A nil field is left
// out of the body, which is how "change only this one" is expressed on the wire;
// the bridge refuses a call that carries neither.
func (b *hermesBridge) SetGroupSettings(ctx context.Context, jid string, announce, locked *bool) error {
	payload := struct {
		JID      string `json:"jid"`
		Announce *bool  `json:"announce,omitempty"`
		Locked   *bool  `json:"locked,omitempty"`
	}{JID: jid, Announce: announce, Locked: locked}
	return b.do(ctx, http.MethodPost, "/group/settings", payload, nil)
}

// SetGroupPhoto sets a group's icon and returns the picture id WhatsApp assigned.
// The data URL is forwarded as the caller wrote it: the bridge decodes it itself,
// and groupadmin.go has already refused anything that is not a base64 image
// within the size cap.
func (b *hermesBridge) SetGroupPhoto(ctx context.Context, jid, dataURL string) (string, error) {
	payload := struct {
		JID     string `json:"jid"`
		DataURL string `json:"dataUrl"`
	}{JID: jid, DataURL: dataURL}
	var answer struct {
		PictureID string `json:"pictureId"`
	}
	if err := b.do(ctx, http.MethodPost, "/group/photo", payload, &answer); err != nil {
		return "", err
	}
	return answer.PictureID, nil
}

// bridgeMemberResult is one requested JID's fate. `ok` is the bridge's own
// reading of WhatsApp's answer — the only status it treats as applied — and
// `error` carries the status it gave instead, as a string ("403").
type bridgeMemberResult struct {
	JID   string `json:"jid"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// bridgeMembersAnswer is the membership payload. `ok` is true only when WhatsApp
// confirmed every JID, which is exactly the invariant the worker's own response
// re-derives from the per-JID results below rather than trusting.
type bridgeMembersAnswer struct {
	OK      bool                 `json:"ok"`
	Results []bridgeMemberResult `json:"results"`
	Failed  []string             `json:"failed"`
}

// UpdateParticipants applies one membership change and reports what WhatsApp
// answered for each JID. A partial change is a successful call carrying failures:
// it is not an error, and groupadmin.go turns its results into the worker's own
// per-JID outcome list.
func (b *hermesBridge) UpdateParticipants(ctx context.Context, jid, membership string, participants []string) (bridgeMembersAnswer, error) {
	payload := struct {
		JID          string   `json:"jid"`
		Membership   string   `json:"membership"`
		Participants []string `json:"participants"`
	}{JID: jid, Membership: membership, Participants: participants}
	var answer bridgeMembersAnswer
	if err := b.do(ctx, http.MethodPost, "/group/participants", payload, &answer); err != nil {
		return bridgeMembersAnswer{}, err
	}
	return answer, nil
}

// LeaveGroup removes the linked account from a group.
func (b *hermesBridge) LeaveGroup(ctx context.Context, jid string) error {
	return b.do(ctx, http.MethodPost, "/group/leave", map[string]string{"jid": jid}, nil)
}

// RevokeMessage deletes a message the account sent, and returns the id the bridge
// addressed it by.
func (b *hermesBridge) RevokeMessage(ctx context.Context, jid, messageID string) (string, error) {
	payload := struct {
		JID       string `json:"jid"`
		MessageID string `json:"messageId"`
	}{JID: jid, MessageID: messageID}
	var answer struct {
		RevokeMessageID string `json:"revokeMessageId"`
	}
	if err := b.do(ctx, http.MethodPost, "/message/revoke", payload, &answer); err != nil {
		return "", err
	}
	return answer.RevokeMessageID, nil
}

// ---- sends ---------------------------------------------------------------

// bridgeReply names the message a send answers. Both halves are sent: WhatsApp
// resolves a group quote by the quoted message's id *and* its author, so an id
// alone cannot be addressed to the right participant.
type bridgeReply struct {
	MessageID   string `json:"messageId"`
	Participant string `json:"participant"`
}

// SendText posts one message and returns the WhatsApp id the bridge assigned it.
//
// The acknowledgement is that id: the dispatcher stores it on the request row, so
// a send the bridge accepted without one is refused here rather than recorded as
// delivered. The bridge's own success flag is deliberately not read — a bridge
// that answers with an id has sent it, and one that answers without has not.
func (b *hermesBridge) SendText(ctx context.Context, chatID, text string, reply quotedMessage) (string, error) {
	payload := struct {
		ChatID  string       `json:"chatId"`
		Message string       `json:"message"`
		ReplyTo *bridgeReply `json:"replyTo,omitempty"`
	}{ChatID: chatID, Message: text}
	if strings.TrimSpace(reply.ID) != "" {
		payload.ReplyTo = &bridgeReply{MessageID: reply.ID, Participant: reply.Participant}
	}
	var answer struct {
		MessageID string `json:"messageId"`
	}
	if err := b.do(ctx, http.MethodPost, "/send", payload, &answer); err != nil {
		return "", err
	}
	if strings.TrimSpace(answer.MessageID) == "" {
		return "", &bridgeRefusal{Status: http.StatusOK, Message: "whatsapp acknowledged the send without a message id"}
	}
	return answer.MessageID, nil
}

// membershipErrorCode reads the bridge's per-JID error as the numeric WhatsApp
// status the worker's own response carries. Baileys reports that status as a
// string ("403", "409"); anything that is not a number is not a code, and the
// outcome is then reported without one — the failure itself is still reported.
func membershipErrorCode(raw string) int {
	code, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || code == 0 {
		return 0
	}
	return code
}
