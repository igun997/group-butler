package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// This file is the group-admin surface: the two live reads that tell the BFF
// what a group currently is on WhatsApp, and the one write route that performs
// the single action a human approved. Nothing here stages, approves or retries
// anything — the BFF owns that, and this layer executes exactly what it is told.
//
// The live side of that is the Hermes bridge now (hermes_bridge.go): the worker
// holds no session, so a read is `GET /group/:jid` and a write is one POST on the
// same surface. What does not change is everything the BFF sees — the routes, the
// response bodies, the per-JID membership semantics, and the codes WhatsApp's
// refusals are reported as.
//
// Every way WhatsApp can say no is reported as one of the documented codes
// below, so a refusal is a message the owner can act on rather than a 500.
const (
	// codeNotFound: no such instance.
	codeNotFound = "not_found"
	// codeInstanceOffline: the instance is known but has no live WhatsApp
	// client, so nothing could be asked of it. With Hermes owning the connection
	// this is also what an unreachable bridge answers: there is no live session
	// to ask, whichever side of the loopback it would have run on.
	codeInstanceOffline = "instance_offline"
	// codeGroupNotFound: the linked account cannot see the group — it was
	// removed, or the group no longer exists. Nothing was changed.
	codeGroupNotFound = "group_not_found"
	// codeNotAdmin: WhatsApp refused because the bot lacks the admin right the
	// action needs.
	codeNotAdmin = "not_admin"
	// codeInvalidRequest: the action or its parameters are unusable. No request
	// was made.
	codeInvalidRequest = "invalid_request"
	// codeGroupAdminFailed: the call reached WhatsApp and was refused, or could
	// not be completed. For a write, nothing is known to have changed.
	codeGroupAdminFailed = "group_admin_failed"
	// codeRevokeFailed: the revoke did not reach WhatsApp — an unknown message
	// id, or a failed request.
	codeRevokeFailed = "revoke_failed"
)

// The actions POST .../admin accepts, and the verbs `members` accepts. They are
// the BFF's staging vocabulary, so they are matched exactly.
const (
	actionRename   = "rename"
	actionAnnounce = "announce"
	actionLocked   = "locked"
	actionPhoto    = "photo"
	actionMembers  = "members"
	actionLeave    = "leave"
	actionRevoke   = "revoke"
)

// maxGroupNameLength is WhatsApp's own subject limit: a longer name is refused
// by the server, so it is refused here instead of costing a round trip.
const maxGroupNameLength = 25

// maxGroupPhotoBytes bounds the decoded photo: far above the icon an operator
// would send, and small enough that decoding it cannot exhaust a worker.
const maxGroupPhotoBytes = 4 << 20

// groupAdminBodyMaxBytes bounds the admin body, which unlike every other
// control-plane body carries an image. Base64 costs about a third more than the
// bytes it encodes, hence the headroom above maxGroupPhotoBytes.
const groupAdminBodyMaxBytes = 6 << 20

// The admin flags WhatsApp reports for one participant, as the bridge spells them.
const (
	participantSuperAdmin = "superadmin"
	participantAdmin      = "admin"
)

// The refusals of this surface, before they are mapped to a code. They are
// deliberately separate from the ones manager.go already has: a group write can
// fail in ways an instance lifecycle cannot.
var (
	errGroupNotFound    = errors.New("the account cannot see this group")
	errNotGroupAdmin    = errors.New("whatsapp refused: not an admin")
	errGroupAdminFailed = errors.New("whatsapp did not confirm the change")
	errRevokeFailed     = errors.New("whatsapp did not confirm the revoke")
)

// botIdentity is the linked account's own addressing. A group may list the bot
// under either address — the phone JID or its LID — so both are matched when the
// reads report whether the bot itself is an admin.
type botIdentity struct {
	JID string
	LID string
}

// groupInfoResponse is GET .../info: the group as WhatsApp has it now, plus the
// bot's own rights, which decide what the BFF may offer to write.
type groupInfoResponse struct {
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

// groupParticipantRow is one row of GET .../participants. The admin flags are
// two booleans rather than one enum because WhatsApp's superadmin implies admin,
// and the BFF compares badges: the flags say exactly what WhatsApp said.
type groupParticipantRow struct {
	JID          string `json:"jid"`
	IsAdmin      bool   `json:"isAdmin"`
	IsSuperAdmin bool   `json:"isSuperAdmin"`
	DisplayName  string `json:"displayName,omitempty"`
}

type groupParticipantsResponse struct {
	OK           bool                  `json:"ok"`
	GroupJID     string                `json:"groupJid"`
	Participants []groupParticipantRow `json:"participants"`
}

// The per-JID fates a `members` call can report.
const (
	// membershipOK: WhatsApp confirmed the change for this JID.
	membershipOK = "ok"
	// membershipFailed: WhatsApp answered for this JID and refused it, with the
	// error code it gave.
	membershipFailed = "failed"
	// membershipUnreported: WhatsApp's answer did not mention this JID, so
	// nothing is known about it and it must not be treated as done.
	membershipUnreported = "unreported"
)

// membershipOutcome is one requested JID's fate in a `members` call.
type membershipOutcome struct {
	JID       string `json:"jid"`
	Status    string `json:"status"`
	ErrorCode int    `json:"errorCode,omitempty"`
}

// membershipResponse is the `members` payload. `OK` is true only when every JID
// was confirmed, so a partial result can never be read as a complete one, and
// `failed` names the JIDs that were not.
type membershipResponse struct {
	OK      bool                `json:"ok"`
	Results []membershipOutcome `json:"results"`
	Failed  []string            `json:"failed"`
}

// actionResponse is the payload of every action that produces no data of its
// own, plus the id of what it created or addressed.
type actionResponse struct {
	OK              bool   `json:"ok"`
	PictureID       string `json:"pictureId,omitempty"`
	RevokeMessageID string `json:"revokeMessageId,omitempty"`
}

// groupAdminRequest is the one body POST .../admin accepts. `action` selects
// which parameters are read, and validate resolves them into the exact values the
// bridge call takes so no action parses the same body twice.
type groupAdminRequest struct {
	Action      string   `json:"action"`
	Name        string   `json:"name"`
	Announce    *bool    `json:"announce"`
	Locked      *bool    `json:"locked"`
	DataURL     string   `json:"dataUrl"`
	Membership  string   `json:"membership"`
	JIDs        []string `json:"jids"`
	WaMessageID string   `json:"waMessageId"`

	// participants is the validated, canonical spelling of JIDs, in the order the
	// caller asked for them: the answer is reported in that order and the bridge is
	// asked about exactly these addresses.
	participants []string
}

// validate checks the named action and resolves its parameters. An unknown
// action, or parameters an action cannot use, is the caller's error: it is
// answered with invalid_request and never reaches the bridge.
func (r *groupAdminRequest) validate() error {
	switch r.Action {
	case actionRename:
		r.Name = strings.TrimSpace(r.Name)
		if r.Name == "" {
			return fmt.Errorf("%w: name is required", errInvalidRequest)
		}
		if len([]rune(r.Name)) > maxGroupNameLength {
			return fmt.Errorf("%w: name is longer than %d characters", errInvalidRequest, maxGroupNameLength)
		}
	case actionAnnounce:
		if r.Announce == nil {
			return fmt.Errorf("%w: announce is required", errInvalidRequest)
		}
	case actionLocked:
		if r.Locked == nil {
			return fmt.Errorf("%w: locked is required", errInvalidRequest)
		}
	case actionPhoto:
		if err := validatePhotoDataURL(r.DataURL); err != nil {
			return err
		}
	case actionMembers:
		verb, err := membershipVerb(r.Membership)
		if err != nil {
			return err
		}
		if len(r.JIDs) == 0 {
			return fmt.Errorf("%w: jids is required", errInvalidRequest)
		}
		r.participants = make([]string, 0, len(r.JIDs))
		for _, raw := range r.JIDs {
			participant, err := participantTarget(raw)
			if err != nil {
				return err
			}
			r.participants = append(r.participants, participant)
		}
		r.Membership = verb
	case actionLeave:
	case actionRevoke:
		r.WaMessageID = strings.TrimSpace(r.WaMessageID)
		if r.WaMessageID == "" {
			return fmt.Errorf("%w: waMessageId is required", errInvalidRequest)
		}
	default:
		return fmt.Errorf("%w: unknown action %q", errInvalidRequest, r.Action)
	}
	return nil
}

// validatePhotoDataURL accepts the data URL the BFF stages an approved photo as.
// A bare base64 string is refused rather than guessed at, so the bytes that reach
// a group are always the image the operator saw. The payload is decoded here even
// though the bridge decodes it again: that is what refuses a photo past the size
// cap and a body that only looks like base64 before either costs a round trip.
func validatePhotoDataURL(dataURL string) error {
	header, payload, ok := strings.Cut(dataURL, ",")
	if !ok || !strings.HasPrefix(header, "data:image/") || !strings.HasSuffix(header, ";base64") {
		return fmt.Errorf("%w: dataUrl must be a base64 image data URL", errInvalidRequest)
	}
	if base64.StdEncoding.DecodedLen(len(payload)) > maxGroupPhotoBytes {
		return fmt.Errorf("%w: photo is larger than %d bytes", errInvalidRequest, maxGroupPhotoBytes)
	}
	photo, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return fmt.Errorf("%w: dataUrl is not valid base64", errInvalidRequest)
	}
	if len(photo) == 0 {
		return fmt.Errorf("%w: photo is empty", errInvalidRequest)
	}
	return nil
}

// membershipVerb validates the membership verb, which is also the exact string
// the bridge takes: both vocabularies are the same four words.
func membershipVerb(verb string) (string, error) {
	switch verb {
	case "add", "remove", "promote", "demote":
		return verb, nil
	default:
		return "", fmt.Errorf("%w: membership must be add, remove, promote or demote", errInvalidRequest)
	}
}

// participantTarget accepts the two addresses a human may name for a person: the
// phone JID or its LID. A group JID is not a participant, so it is refused. The
// returned spelling is the canonical one, which is what the answer is matched
// against.
func participantTarget(raw string) (string, error) {
	address, err := parseAddress(raw)
	if err != nil || !address.isUser() {
		return "", fmt.Errorf("%w: %q is not a participant jid", errInvalidRequest, raw)
	}
	return address.String(), nil
}

// groupTarget parses the group JID a route was addressed to. The path is caller
// input too, so a non-group JID is the same invalid_request a bad body is.
func groupTarget(raw string) (waAddress, error) {
	address, err := parseAddress(raw)
	if err != nil || !address.isGroup() {
		return waAddress{}, fmt.Errorf("%w: %q is not a group jid", errInvalidRequest, raw)
	}
	return address, nil
}

// ---- the two reads -------------------------------------------------------

// handleGroupInfo serves GET /instances/{id}/groups/{groupJid}/info from the live
// account, not from the stored row: the BFF asks it just before offering a write,
// so a stale name or a lost admin right must not come from our cache.
//
// Two of the response's fields have no source in the bridge's contract — the topic
// and the participants' display names — so they are reported empty instead of
// being invented; every field the dashboard branches on (the name, the two flags,
// the count, the bot's rights) is live.
func (a *api) handleGroupInfo(w http.ResponseWriter, r *http.Request, instanceID, groupJID string) {
	group, err := groupTarget(groupJID)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	instance, ok := a.groupInstance(w, r, instanceID)
	if !ok {
		return
	}
	bridge, ok := a.liveBridge(w)
	if !ok {
		return
	}
	info, err := bridge.GroupInfo(r.Context(), group.String())
	if err != nil {
		a.writeGroupReadError(w, classifyGroupFailure(err))
		return
	}
	admin, super := botAdminFlags(info, botIdentity{JID: instance.BotJID, LID: instance.BotLID})
	writeJSON(w, http.StatusOK, groupInfoResponse{
		OK:               true,
		GroupJID:         group.String(),
		Name:             info.Subject,
		IsAnnounce:       info.Announce,
		IsLocked:         info.Locked,
		ParticipantCount: len(info.Participants),
		BotIsAdmin:       admin,
		BotIsSuperAdmin:  super,
	})
}

// handleGroupParticipants serves GET /instances/{id}/groups/{groupJid}/participants.
// The membership comes from the same live call as the info route: WhatsApp has
// no separate per-group participant query, and the answer must be one snapshot.
func (a *api) handleGroupParticipants(w http.ResponseWriter, r *http.Request, instanceID, groupJID string) {
	group, err := groupTarget(groupJID)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	if _, ok := a.groupInstance(w, r, instanceID); !ok {
		return
	}
	bridge, ok := a.liveBridge(w)
	if !ok {
		return
	}
	info, err := bridge.GroupInfo(r.Context(), group.String())
	if err != nil {
		a.writeGroupReadError(w, classifyGroupFailure(err))
		return
	}
	rows := make([]groupParticipantRow, 0, len(info.Participants))
	for _, participant := range info.Participants {
		admin := participant.Admin == participantAdmin || participant.Admin == participantSuperAdmin
		rows = append(rows, groupParticipantRow{
			JID:          normalizeAddress(participant.JID),
			IsAdmin:      admin,
			IsSuperAdmin: participant.Admin == participantSuperAdmin,
		})
	}
	writeJSON(w, http.StatusOK, groupParticipantsResponse{OK: true, GroupJID: group.String(), Participants: rows})
}

// botAdminFlags reports the bot's own rights from the membership the bridge
// returned. A superadmin is an admin too, which is how WhatsApp reports it, and an
// account the group does not list — or one whose own identity is not known — is
// not an admin.
func botAdminFlags(info bridgeGroupInfo, bot botIdentity) (admin, super bool) {
	for _, participant := range info.Participants {
		if !sameAccount(participant.JID, bot.JID) && !sameAccount(participant.JID, bot.LID) {
			continue
		}
		switch participant.Admin {
		case participantSuperAdmin:
			return true, true
		case participantAdmin:
			return true, false
		}
		return false, false
	}
	return false, false
}

// ---- the write -----------------------------------------------------------

// handleGroupAdmin serves POST /instances/{id}/groups/{groupJid}/admin, the one
// write route for every group capability. It validates the action before it
// resolves the bridge, so a malformed request is answered as the caller's error
// even when nothing is reachable, and it performs exactly the one action the body
// names.
func (a *api) handleGroupAdmin(w http.ResponseWriter, r *http.Request, instanceID, groupJID string) {
	var request groupAdminRequest
	if !decodeBodyLimited(w, r, &request, groupAdminBodyMaxBytes) {
		return
	}
	if err := request.validate(); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	group, err := groupTarget(groupJID)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	if _, ok := a.groupInstance(w, r, instanceID); !ok {
		return
	}
	bridge, ok := a.liveBridge(w)
	if !ok {
		return
	}
	payload, err := applyGroupAdmin(r.Context(), bridge, group, request)
	if err != nil {
		a.writeGroupAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// applyGroupAdmin performs the one action the request resolved to and reports what
// WhatsApp answered. It is separate from the handler so the exact bridge call each
// action makes is provable against a recording bridge rather than through the
// handler's return value.
func applyGroupAdmin(ctx context.Context, bridge *hermesBridge, group waAddress, request groupAdminRequest) (any, error) {
	switch request.Action {
	case actionRename:
		if err := bridge.RenameGroup(ctx, group.String(), request.Name); err != nil {
			return nil, classifyGroupFailure(err)
		}
	case actionAnnounce:
		if err := bridge.SetGroupSettings(ctx, group.String(), request.Announce, nil); err != nil {
			return nil, classifyGroupFailure(err)
		}
	case actionLocked:
		if err := bridge.SetGroupSettings(ctx, group.String(), nil, request.Locked); err != nil {
			return nil, classifyGroupFailure(err)
		}
	case actionPhoto:
		pictureID, err := bridge.SetGroupPhoto(ctx, group.String(), request.DataURL)
		if err != nil {
			return nil, classifyGroupFailure(err)
		}
		return actionResponse{OK: true, PictureID: pictureID}, nil
	case actionMembers:
		answer, err := bridge.UpdateParticipants(ctx, group.String(), request.Membership, request.participants)
		if err != nil {
			return nil, classifyGroupFailure(err)
		}
		return membershipOutcomes(request.participants, answer), nil
	case actionLeave:
		if err := bridge.LeaveGroup(ctx, group.String()); err != nil {
			return nil, classifyGroupFailure(err)
		}
	case actionRevoke:
		messageID, err := bridge.RevokeMessage(ctx, group.String(), request.WaMessageID)
		if err != nil {
			return nil, classifyRevokeFailure(err)
		}
		return actionResponse{OK: true, RevokeMessageID: messageID}, nil
	}
	return actionResponse{OK: true}, nil
}

// membershipOutcomes reports the bridge's answer for every JID that was asked
// about, in the order it was asked. A JID the answer never mentioned is
// `unreported`, which is a failure to confirm rather than a success.
//
// The overall `ok` is derived from those outcomes rather than taken from the
// bridge's own: the invariant the BFF acts on is that a partial change can never be
// read as a complete one, and deriving it here is what makes that true however the
// bridge spells its answer.
func membershipOutcomes(requested []string, answer bridgeMembersAnswer) membershipResponse {
	response := membershipResponse{
		OK:      true,
		Results: make([]membershipOutcome, 0, len(requested)),
		Failed:  []string{},
	}
	for _, want := range requested {
		outcome := membershipOutcome{JID: want, Status: membershipUnreported}
		for _, result := range answer.Results {
			if !sameAccount(result.JID, want) {
				continue
			}
			if result.OK {
				outcome.Status = membershipOK
			} else {
				outcome.Status = membershipFailed
				outcome.ErrorCode = membershipErrorCode(result.Error)
			}
			break
		}
		if outcome.Status != membershipOK {
			response.OK = false
			response.Failed = append(response.Failed, outcome.JID)
		}
		response.Results = append(response.Results, outcome)
	}
	return response
}

// ---- refusals ------------------------------------------------------------

// writeGroupReadError maps a failed live read onto the same vocabulary the writes
// use, so the BFF reads one set of codes across the whole surface. A bridge this
// worker cannot reach is `instance_offline`: the Hermes session *is* the WhatsApp
// connection the read would have used, and there is none to ask.
func (a *api) writeGroupReadError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errBridgeUnreachable), errors.Is(err, errNoBridge):
		writeError(w, http.StatusConflict, codeInstanceOffline, err.Error())
	case errors.Is(err, errGroupNotFound):
		writeError(w, http.StatusNotFound, codeGroupNotFound, err.Error())
	case errors.Is(err, errNotGroupAdmin):
		writeError(w, http.StatusForbidden, codeNotAdmin, err.Error())
	default:
		writeError(w, http.StatusBadGateway, codeGroupAdminFailed, err.Error())
	}
}

// writeGroupAdminError maps a refused write. Every branch is a code the BFF can
// turn into a message; the fallback is a 502 because a write that was not
// confirmed is not a worker bug.
func (a *api) writeGroupAdminError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errInstanceNotFound):
		writeError(w, http.StatusNotFound, codeNotFound, err.Error())
	case errors.Is(err, errBridgeUnreachable), errors.Is(err, errNoBridge):
		writeError(w, http.StatusConflict, codeInstanceOffline, err.Error())
	case errors.Is(err, errGroupNotFound):
		writeError(w, http.StatusNotFound, codeGroupNotFound, err.Error())
	case errors.Is(err, errNotGroupAdmin):
		writeError(w, http.StatusForbidden, codeNotAdmin, err.Error())
	case errors.Is(err, errInvalidRequest):
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
	case errors.Is(err, errRevokeFailed):
		writeError(w, http.StatusBadGateway, codeRevokeFailed, err.Error())
	default:
		writeError(w, http.StatusBadGateway, codeGroupAdminFailed, err.Error())
	}
}

// classifyGroupFailure turns a bridge answer into the documented refusal. The
// bridge reports "you are not in that group" and "that group does not exist" the
// same way for every group call, which is the one thing the owner has to act on;
// anything else is a change we cannot confirm.
//
// A bridge this worker could not reach is passed through untouched: it is not a
// group-level refusal, and the handlers answer it as `instance_offline` — there
// was no live session to ask.
func classifyGroupFailure(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, errBridgeUnreachable), errors.Is(err, errNoBridge):
		return err
	}
	var refusal *bridgeRefusal
	if errors.As(err, &refusal) {
		return refusal.asGroupFailure()
	}
	return fmt.Errorf("%w: %v", errGroupAdminFailed, err)
}

// classifyRevokeFailure is separate from classifyGroupFailure only in its
// fallback: a revoke fails as a revoke, which the BFF shows against the message
// being removed rather than against the group's settings.
func classifyRevokeFailure(err error) error {
	switch {
	case errors.Is(err, errBridgeUnreachable), errors.Is(err, errNoBridge):
		return err
	}
	var refusal *bridgeRefusal
	if errors.As(err, &refusal) {
		return refusal.asRevokeFailure()
	}
	return fmt.Errorf("%w: %v", errRevokeFailed, err)
}

// WhatsApp's own reasons, as the text the bridge forwards them in. Baileys raises
// one error per refusal whose message is the server's error text, so this is the
// only place the two refusals an owner can act on survive the trip.
const (
	refusalNotAuthorized = "not-authorized"
	refusalForbidden     = "forbidden"
	refusalItemNotFound  = "item-not-found"
)

// asGroupFailure reads a bridge refusal as the group refusal the owner can act on.
func (e *bridgeRefusal) asGroupFailure() error { return e.classify(errGroupAdminFailed) }

// asRevokeFailure is asGroupFailure with the revoke's own fallback: an unknown
// message id is not a group setting that could not be changed, and the BFF shows
// it against the message being removed.
func (e *bridgeRefusal) asRevokeFailure() error { return e.classify(errRevokeFailed) }

// classify reads a refusal against the two reasons an owner can act on, falling
// back to the caller's own refusal.
//
// WHY the message and not the status: the bridge answers every library refusal
// with the same 500, so WhatsApp's "not-authorized" and "item-not-found" arrive as
// text and nothing else. The match is deliberately narrow — an unrecognised
// message stays an unconfirmed change rather than being reported as a right the
// operator does not have, or as a group that no longer exists.
func (e *bridgeRefusal) classify(fallback error) error {
	switch e.reason() {
	case refusalNotAuthorized, refusalForbidden:
		return fmt.Errorf("%w: %v", errNotGroupAdmin, e)
	case refusalItemNotFound:
		return fmt.Errorf("%w: %v", errGroupNotFound, e)
	default:
		return fmt.Errorf("%w: %v", fallback, e)
	}
}

// reason is the one marker in the refusal's message, lower-cased so the two
// spellings a library may use (`not-authorized`, `Not-Authorized`) land together.
func (e *bridgeRefusal) reason() string {
	message := strings.ToLower(e.Message)
	for _, marker := range []string{refusalNotAuthorized, refusalForbidden, refusalItemNotFound} {
		if strings.Contains(message, marker) {
			return marker
		}
	}
	return ""
}

// ---- resolution ----------------------------------------------------------

// groupInstance resolves the instance a group call names. An unknown id is a
// not_found, exactly as it was when a missing session was what refused the call,
// and the row is also where the linked account's own identity comes from — which
// is what the info read answers `botIsAdmin` with when no session holds it.
func (a *api) groupInstance(w http.ResponseWriter, r *http.Request, instanceID string) (instanceSnapshot, bool) {
	if a.manager == nil {
		// The harness that wires this surface without a manager has no instance
		// rows to check; it is the group read model's own tests, not a worker.
		return instanceSnapshot{}, true
	}
	instance, err := a.manager.getInstance(r.Context(), instanceID)
	if err != nil {
		a.writeInstanceError(w, err)
		return instanceSnapshot{}, false
	}
	return instance, true
}

// liveBridge resolves the bridge every live group call goes through. A worker
// assembled without one cannot serve this surface at all, and says so in the same
// words as an instance with no live session.
func (a *api) liveBridge(w http.ResponseWriter) (*hermesBridge, bool) {
	if a.bridge != nil {
		return a.bridge, true
	}
	writeError(w, http.StatusConflict, codeInstanceOffline, errNoBridge.Error())
	return nil, false
}
