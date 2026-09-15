package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

// This file is the group-admin surface: the two live reads that tell the BFF
// what a group currently is on WhatsApp, and the one write route that performs
// the single action a human approved. Nothing here stages, approves or retries
// anything — the BFF owns that, and this layer executes exactly what it is told.
//
// Every way WhatsApp can say no is reported as one of the documented codes
// below, so a refusal is a message the owner can act on rather than a 500.
const (
	// codeNotFound: no such instance.
	codeNotFound = "not_found"
	// codeInstanceOffline: the instance is known but has no live WhatsApp
	// client, so nothing could be asked of it.
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

// The refusals of this surface, before they are mapped to a code. They are
// deliberately separate from the ones manager.go already has: a group write can
// fail in ways an instance lifecycle cannot.
var (
	errGroupNotFound    = errors.New("the account cannot see this group")
	errNotGroupAdmin    = errors.New("whatsapp refused: not an admin")
	errGroupAdminFailed = errors.New("whatsapp did not confirm the change")
	errRevokeFailed     = errors.New("whatsapp did not confirm the revoke")
)

// groupAdminClient is the whatsmeow write surface the admin route needs. It is
// deliberately narrower than groupClient — and separate from it — because every
// method here changes a group on WhatsApp: keeping the two apart means a read
// path cannot reach a write by accident. *whatsmeow.Client satisfies it as-is.
type groupAdminClient interface {
	SetGroupName(ctx context.Context, jid types.JID, name string) error
	SetGroupPhoto(ctx context.Context, jid types.JID, avatar []byte) (string, error)
	SetGroupAnnounce(ctx context.Context, jid types.JID, announce bool) error
	SetGroupLocked(ctx context.Context, jid types.JID, locked bool) error
	UpdateGroupParticipants(ctx context.Context, jid types.JID, participantChanges []types.JID, action whatsmeow.ParticipantChange) ([]types.GroupParticipant, error)
	LeaveGroup(ctx context.Context, jid types.JID) error
	RevokeMessage(ctx context.Context, chat types.JID, id types.MessageID) (whatsmeow.SendResponse, error)
}

// botIdentity is the linked account's own addressing. A group may list the bot
// under either address — the phone JID or its LID — so both are matched when the
// reads report whether the bot itself is an admin.
type botIdentity struct {
	JID types.JID
	LID types.JID
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
// which parameters are read, and validate resolves them into the exact values
// the whatsmeow call takes so no action parses the same body twice.
type groupAdminRequest struct {
	Action      string   `json:"action"`
	Name        string   `json:"name"`
	Announce    *bool    `json:"announce"`
	Locked      *bool    `json:"locked"`
	DataURL     string   `json:"dataUrl"`
	Membership  string   `json:"membership"`
	JIDs        []string `json:"jids"`
	WaMessageID string   `json:"waMessageId"`

	photo        []byte
	participants []types.JID
	change       whatsmeow.ParticipantChange
}

// validate checks the named action and resolves its parameters. An unknown
// action, or parameters an action cannot use, is the caller's error: it is
// answered with invalid_request and never reaches WhatsApp.
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
		photo, err := decodePhotoDataURL(r.DataURL)
		if err != nil {
			return err
		}
		r.photo = photo
	case actionMembers:
		change, err := participantChange(r.Membership)
		if err != nil {
			return err
		}
		if len(r.JIDs) == 0 {
			return fmt.Errorf("%w: jids is required", errInvalidRequest)
		}
		r.participants = make([]types.JID, 0, len(r.JIDs))
		for _, raw := range r.JIDs {
			jid, err := participantTarget(raw)
			if err != nil {
				return err
			}
			r.participants = append(r.participants, jid)
		}
		r.change = change
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

// decodePhotoDataURL accepts the data URL the BFF stages an approved photo as.
// A bare base64 string is refused rather than guessed at, so the bytes that
// reach a group are always the image the operator saw.
func decodePhotoDataURL(dataURL string) ([]byte, error) {
	header, payload, ok := strings.Cut(dataURL, ",")
	if !ok || !strings.HasPrefix(header, "data:image/") || !strings.HasSuffix(header, ";base64") {
		return nil, fmt.Errorf("%w: dataUrl must be a base64 image data URL", errInvalidRequest)
	}
	if base64.StdEncoding.DecodedLen(len(payload)) > maxGroupPhotoBytes {
		return nil, fmt.Errorf("%w: photo is larger than %d bytes", errInvalidRequest, maxGroupPhotoBytes)
	}
	photo, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, fmt.Errorf("%w: dataUrl is not valid base64", errInvalidRequest)
	}
	if len(photo) == 0 {
		return nil, fmt.Errorf("%w: photo is empty", errInvalidRequest)
	}
	return photo, nil
}

// participantChange maps the membership verb onto whatsmeow's own constant,
// which is what decides the protocol node the library sends.
func participantChange(verb string) (whatsmeow.ParticipantChange, error) {
	switch verb {
	case string(whatsmeow.ParticipantChangeAdd):
		return whatsmeow.ParticipantChangeAdd, nil
	case string(whatsmeow.ParticipantChangeRemove):
		return whatsmeow.ParticipantChangeRemove, nil
	case string(whatsmeow.ParticipantChangePromote):
		return whatsmeow.ParticipantChangePromote, nil
	case string(whatsmeow.ParticipantChangeDemote):
		return whatsmeow.ParticipantChangeDemote, nil
	default:
		return "", fmt.Errorf("%w: membership must be add, remove, promote or demote", errInvalidRequest)
	}
}

// participantTarget accepts the two addresses a human may name for a person: the
// phone JID or its LID. A group JID is not a participant, so it is refused.
func participantTarget(raw string) (types.JID, error) {
	jid, err := types.ParseJID(strings.TrimSpace(raw))
	if err != nil || jid.User == "" ||
		(jid.Server != types.DefaultUserServer && jid.Server != types.HiddenUserServer) {
		return types.EmptyJID, fmt.Errorf("%w: %q is not a participant jid", errInvalidRequest, raw)
	}
	return jid, nil
}

// groupTarget parses the group JID a route was addressed to. The path is caller
// input too, so a non-group JID is the same invalid_request a bad body is.
func groupTarget(raw string) (types.JID, error) {
	jid, err := types.ParseJID(raw)
	if err != nil || jid.User == "" || jid.Server != types.GroupServer {
		return types.EmptyJID, fmt.Errorf("%w: %q is not a group jid", errInvalidRequest, raw)
	}
	return jid, nil
}

// jidOrEmpty reads a stored JID string. An absent or unparsable one becomes
// EmptyJID, which matches no participant: a missing bot identity must not fail a
// read of the group itself.
func jidOrEmpty(raw string) types.JID {
	jid, err := types.ParseJID(raw)
	if err != nil {
		return types.EmptyJID
	}
	return jid
}

// ---- the two reads -------------------------------------------------------

// handleGroupInfo serves GET /instances/{id}/groups/{groupJid}/info from the
// live account, not from the stored row: the BFF asks it just before offering a
// write, so a stale name or a lost admin right must not come from our cache.
func (a *api) handleGroupInfo(w http.ResponseWriter, r *http.Request, instanceID, groupJID string) {
	group, err := groupTarget(groupJID)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	client, ok := a.liveGroupClient(w, r, instanceID)
	if !ok {
		return
	}
	info, err := client.GetGroupInfo(r.Context(), group)
	if err != nil {
		a.writeGroupReadError(w, err)
		return
	}
	admin, super := botAdminFlags(info, a.bot(instanceID))
	writeJSON(w, http.StatusOK, groupInfoResponse{
		OK:               true,
		GroupJID:         group.String(),
		Name:             info.Name,
		Topic:            info.Topic,
		IsAnnounce:       info.IsAnnounce,
		IsLocked:         info.IsLocked,
		ParticipantCount: participantCount(info),
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
	client, ok := a.liveGroupClient(w, r, instanceID)
	if !ok {
		return
	}
	info, err := client.GetGroupInfo(r.Context(), group)
	if err != nil {
		a.writeGroupReadError(w, err)
		return
	}
	rows := make([]groupParticipantRow, 0, len(info.Participants))
	for _, participant := range info.Participants {
		rows = append(rows, groupParticipantRow{
			JID:          participant.JID.String(),
			IsAdmin:      participant.IsAdmin,
			IsSuperAdmin: participant.IsSuperAdmin,
			DisplayName:  participant.DisplayName,
		})
	}
	writeJSON(w, http.StatusOK, groupParticipantsResponse{OK: true, GroupJID: group.String(), Participants: rows})
}

// participantCount reports WhatsApp's own count when it sent one, and otherwise
// the participants it listed — never a number that disagrees with the list the
// BFF can fetch beside it.
func participantCount(info *types.GroupInfo) int {
	if info.ParticipantCount > 0 || len(info.Participants) == 0 {
		return info.ParticipantCount
	}
	return len(info.Participants)
}

// botAdminFlags reports the bot's own rights from the membership WhatsApp just
// returned. A superadmin is an admin too, which is how WhatsApp reports it.
func botAdminFlags(info *types.GroupInfo, bot botIdentity) (admin, super bool) {
	for _, participant := range info.Participants {
		if !sameAccount(participant.JID, bot.JID) && !sameAccount(participant.JID, bot.LID) {
			continue
		}
		if participant.IsSuperAdmin {
			return true, true
		}
		return participant.IsAdmin, false
	}
	return false, false
}

// ---- the write -----------------------------------------------------------

// handleGroupAdmin serves POST /instances/{id}/groups/{groupJid}/admin, the one
// write route for every group capability. It validates the action before it
// resolves the client, so a malformed request is answered as the caller's error
// even when the instance is offline, and it performs exactly the one action the
// body names.
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
	client, ok := a.liveGroupAdmin(w, r, instanceID)
	if !ok {
		return
	}
	payload, err := applyGroupAdmin(r.Context(), client, group, request)
	if err != nil {
		a.writeGroupAdminError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// applyGroupAdmin performs the one action the request resolved to and reports
// what WhatsApp answered. It is separate from the handler so the exact call each
// action makes is provable against a recording client rather than through the
// handler's return value.
func applyGroupAdmin(ctx context.Context, client groupAdminClient, group types.JID, request groupAdminRequest) (any, error) {
	switch request.Action {
	case actionRename:
		if err := client.SetGroupName(ctx, group, request.Name); err != nil {
			return nil, classifyGroupFailure(err)
		}
	case actionAnnounce:
		if err := client.SetGroupAnnounce(ctx, group, *request.Announce); err != nil {
			return nil, classifyGroupFailure(err)
		}
	case actionLocked:
		if err := client.SetGroupLocked(ctx, group, *request.Locked); err != nil {
			return nil, classifyGroupFailure(err)
		}
	case actionPhoto:
		pictureID, err := client.SetGroupPhoto(ctx, group, request.photo)
		if err != nil {
			return nil, classifyGroupFailure(err)
		}
		return actionResponse{OK: true, PictureID: pictureID}, nil
	case actionMembers:
		updated, err := client.UpdateGroupParticipants(ctx, group, request.participants, request.change)
		if err != nil {
			return nil, classifyGroupFailure(err)
		}
		return membershipOutcomes(request.participants, updated), nil
	case actionLeave:
		if err := client.LeaveGroup(ctx, group); err != nil {
			return nil, classifyGroupFailure(err)
		}
	case actionRevoke:
		response, err := client.RevokeMessage(ctx, group, types.MessageID(request.WaMessageID))
		if err != nil {
			return nil, classifyRevokeFailure(err)
		}
		return actionResponse{OK: true, RevokeMessageID: string(response.ID)}, nil
	}
	return actionResponse{OK: true}, nil
}

// membershipOutcomes reports WhatsApp's answer for every JID that was asked
// about, in the order it was asked. A JID the answer never mentioned is
// `unreported`, which is a failure to confirm rather than a success.
func membershipOutcomes(requested []types.JID, updated []types.GroupParticipant) membershipResponse {
	response := membershipResponse{
		OK:      true,
		Results: make([]membershipOutcome, 0, len(requested)),
		Failed:  []string{},
	}
	for _, want := range requested {
		outcome := membershipOutcome{JID: want.String(), Status: membershipUnreported}
		for _, participant := range updated {
			if !participantMatches(participant, want) {
				continue
			}
			if participant.Error != 0 {
				outcome.Status = membershipFailed
				outcome.ErrorCode = participant.Error
			} else {
				outcome.Status = membershipOK
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

// participantMatches asks whether WhatsApp's answer is about the JID the caller
// named. The answer may address that account by its phone JID or by its LID,
// whichever WhatsApp prefers for the group, so both are matched — a confirmed
// change must not be reported as unreported because the address changed shape.
func participantMatches(participant types.GroupParticipant, want types.JID) bool {
	return sameAccount(participant.JID, want) ||
		sameAccount(participant.PhoneNumber, want) ||
		sameAccount(participant.LID, want)
}

// sameAccount matches a participant to a JID under either address WhatsApp may
// use for one account: the phone JID or its LID. It is the only comparison the
// group surface needs, and it deliberately ignores the device suffix.
func sameAccount(candidate, want types.JID) bool {
	if candidate.IsEmpty() || want.IsEmpty() {
		return false
	}
	return candidate.User == want.User && candidate.Server == want.Server
}

// ---- refusals ------------------------------------------------------------

// writeGroupReadError maps a failed live read onto the same vocabulary the writes
// use, so the BFF reads one set of codes across the whole surface.
func (a *api) writeGroupReadError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, whatsmeow.ErrGroupNotFound), errors.Is(err, whatsmeow.ErrNotInGroup):
		writeError(w, http.StatusNotFound, codeGroupNotFound, err.Error())
	case errors.Is(err, whatsmeow.ErrIQForbidden), errors.Is(err, whatsmeow.ErrIQNotAuthorized):
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

// classifyGroupFailure turns a whatsmeow error into the documented refusal. The
// library reports "you are not in that group" and "that group does not exist"
// the same way for every group call, which is the one thing the owner has to act
// on; anything else is a change we cannot confirm.
func classifyGroupFailure(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, whatsmeow.ErrGroupNotFound), errors.Is(err, whatsmeow.ErrNotInGroup):
		return fmt.Errorf("%w: %v", errGroupNotFound, err)
	case errors.Is(err, whatsmeow.ErrIQForbidden), errors.Is(err, whatsmeow.ErrIQNotAuthorized):
		return fmt.Errorf("%w: %v", errNotGroupAdmin, err)
	case errors.Is(err, whatsmeow.ErrInvalidImageFormat):
		return fmt.Errorf("%w: %v", errInvalidRequest, err)
	default:
		return fmt.Errorf("%w: %v", errGroupAdminFailed, err)
	}
}

// classifyRevokeFailure is separate from classifyGroupFailure only in its
// fallback: a revoke fails as a revoke, which the BFF shows against the message
// being removed rather than against the group's settings.
func classifyRevokeFailure(err error) error {
	switch {
	case errors.Is(err, whatsmeow.ErrGroupNotFound), errors.Is(err, whatsmeow.ErrNotInGroup):
		return fmt.Errorf("%w: %v", errGroupNotFound, err)
	case errors.Is(err, whatsmeow.ErrIQForbidden), errors.Is(err, whatsmeow.ErrIQNotAuthorized):
		return fmt.Errorf("%w: %v", errNotGroupAdmin, err)
	default:
		return fmt.Errorf("%w: %v", errRevokeFailed, err)
	}
}

// ---- client resolution ---------------------------------------------------

// bot resolves the linked account's own addressing for an instance. A nil
// resolver leaves it unknown, and no participant then matches it.
func (a *api) bot(instanceID string) botIdentity {
	if a.botFor == nil {
		return botIdentity{}
	}
	return a.botFor(instanceID)
}

// liveGroupClient resolves the live client a read needs, writing the refusal
// when the instance is unknown or has no client.
func (a *api) liveGroupClient(w http.ResponseWriter, r *http.Request, instanceID string) (groupClient, bool) {
	if client := a.client(instanceID); client != nil {
		return client, true
	}
	a.writeNoLiveClient(w, r, instanceID)
	return nil, false
}

// liveGroupAdmin resolves the live client a write needs, writing the refusal
// when the instance is unknown or has no client.
func (a *api) liveGroupAdmin(w http.ResponseWriter, r *http.Request, instanceID string) (groupAdminClient, bool) {
	if client := a.admin(instanceID); client != nil {
		return client, true
	}
	a.writeNoLiveClient(w, r, instanceID)
	return nil, false
}

// admin resolves the live client for an instance as the write surface, or nil.
func (a *api) admin(instanceID string) groupAdminClient {
	if a.adminFor == nil {
		return nil
	}
	return a.adminFor(instanceID)
}

// writeNoLiveClient separates the two reasons an instance has no client: an
// unknown instance is a not_found, while an instance we know but cannot reach is
// one the caller may retry against.
func (a *api) writeNoLiveClient(w http.ResponseWriter, r *http.Request, instanceID string) {
	if a.manager != nil {
		if _, err := a.manager.getInstance(r.Context(), instanceID); err != nil {
			a.writeInstanceError(w, err)
			return
		}
	}
	writeError(w, http.StatusConflict, codeInstanceOffline, "instance has no live whatsapp client")
}
