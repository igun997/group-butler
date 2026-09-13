package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

// api is the worker control plane (§6.5). `store` serves the persisted group
// read model, `clientFor` resolves the live client for an instance (nil when it
// has none), and `manager` owns the instance lifecycle routes. A nil manager
// leaves those routes answering 404, which keeps the group surface testable on
// its own.
type api struct {
	store      *groupStore
	clientFor  func(instanceID string) groupClient
	manager    *manager
	orgID      string
	secret     string
	prune      bool
	staleAfter time.Duration
}

// groupListRow is one row of `GET /instances/{id}/groups` in the §6.6.6 shape.
// The dashboard needs the ID and the current name (R11); everything else is the
// context that makes the row actionable.
type groupListRow struct {
	GroupJID         string  `json:"groupJid"`
	Name             string  `json:"name"`
	NameSource       string  `json:"nameSource"`
	NameSetAt        *string `json:"nameSetAt,omitempty"`
	NameSetBy        string  `json:"nameSetBy,omitempty"`
	ParticipantCount int     `json:"participantCount"`
	IsAnnounce       bool    `json:"isAnnounce"`
	IsLocked         bool    `json:"isLocked"`
	State            string  `json:"state"`
	LastActivityAt   *string `json:"lastActivityAt,omitempty"`
	MessageCount     int     `json:"messageCount"`
	Assigned         bool    `json:"assigned"`
	Whitelisted      bool    `json:"whitelisted"`
}

type groupListResponse struct {
	InstanceID string         `json:"instanceId"`
	SyncedAt   *string        `json:"syncedAt"`
	Groups     []groupListRow `json:"groups"`
}

// syncResponse is the §6.6.6 manual-sync payload: the summary plus the identity
// of the instance it describes.
type syncResponse struct {
	OK         bool   `json:"ok"`
	InstanceID string `json:"instanceId"`
	SyncSummary
}

// routes is the §6.5 control-plane shape: `/health` stays open for container
// probes, every instance route is behind the shared bearer token. Both
// `/instances` and the `/instances/` subtree are registered so the collection
// path is authorised rather than answered by ServeMux's redirect.
func (a *api) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", a.handleHealth)
	instances := a.auth(a.handleInstanceSubresource)
	mux.HandleFunc("/instances", instances)
	mux.HandleFunc("/instances/", instances)
	return mux
}

func (a *api) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// client resolves the live whatsmeow client for an instance. A nil resolver
// (the group-surface-only test harness) means no live client.
func (a *api) client(instanceID string) groupClient {
	if a.clientFor == nil {
		return nil
	}
	return a.clientFor(instanceID)
}

// auth is the §11.2 bearer check. The comparison is constant-time so a wrong
// token cannot be searched for byte by byte.
func (a *api) auth(next http.HandlerFunc) http.HandlerFunc {
	want := []byte("Bearer " + a.secret)
	return func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token")
			return
		}
		next(w, r)
	}
}

// handleInstanceSubresource routes `/instances[/{id}[/{subresource}]]`. The
// first segment selects the lifecycle surface or, for a known instance, one of
// its subresources (groups, pairing-code).
func (a *api) handleInstanceSubresource(w http.ResponseWriter, r *http.Request) {
	tail := splitPath(r.URL.Path)
	switch {
	case len(tail) == 0:
		a.handleInstanceCollection(w, r)
	case len(tail) == 1 && tail[0] != "":
		a.handleInstanceItem(w, r, tail[0])
	case len(tail) >= 2 && tail[0] != "" && tail[1] == "groups":
		a.handleGroupSubresource(w, r, tail[0], tail[2:])
	case len(tail) == 2 && tail[0] != "" && tail[1] == "pairing-code":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST /instances/{id}/pairing-code")
			return
		}
		a.handlePairingCode(w, r, tail[0])
	default:
		writeError(w, http.StatusNotFound, "not_found", "unknown worker route")
	}
}

// splitPath returns the non-empty segments of an `/instances[/…]` path, so both
// `/instances` and `/instances/` yield none and a trailing slash is ignored.
func splitPath(path string) []string {
	rest := strings.Trim(strings.TrimPrefix(strings.Trim(path, "/"), "instances"), "/")
	if rest == "" {
		return nil
	}
	return strings.Split(rest, "/")
}

func (a *api) handleInstanceCollection(w http.ResponseWriter, r *http.Request) {
	if a.manager == nil {
		writeError(w, http.StatusNotFound, "not_found", "instance lifecycle is not available")
		return
	}
	switch r.Method {
	case http.MethodGet:
		instances, err := a.manager.listInstances(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, instanceListResponse{Instances: instances})
	case http.MethodPost:
		var req createInstanceRequest
		if !decodeBody(w, r, &req) {
			return
		}
		snap, err := a.manager.createInstance(r.Context(), req)
		if err != nil {
			a.writeInstanceError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, snap)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or POST /instances")
	}
}

func (a *api) handleInstanceItem(w http.ResponseWriter, r *http.Request, instanceID string) {
	if a.manager == nil {
		writeError(w, http.StatusNotFound, "not_found", "instance lifecycle is not available")
		return
	}
	switch r.Method {
	case http.MethodGet:
		snap, err := a.manager.getInstance(r.Context(), instanceID)
		if err != nil {
			a.writeInstanceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, snap)
	case http.MethodDelete:
		if err := a.manager.deleteInstance(r.Context(), instanceID); err != nil {
			a.writeInstanceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or DELETE /instances/{id}")
	}
}

func (a *api) handlePairingCode(w http.ResponseWriter, r *http.Request, instanceID string) {
	snap, err := a.manager.requestPairingCode(r.Context(), instanceID)
	if err != nil {
		a.writeInstanceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// writeInstanceError maps the manager's sentinel errors to the §6.5 stable
// codes the BFF turns into UI messages.
func (a *api) writeInstanceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errInstanceNotFound):
		writeError(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, errLabelConflict):
		writeError(w, http.StatusConflict, "label_conflict", err.Error())
	case errors.Is(err, errWrongMode), errors.Is(err, errPairingNotReady):
		writeError(w, http.StatusConflict, "invalid_state", err.Error())
	case errors.Is(err, errInvalidRequest):
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

// decodeBody reads a bounded JSON body. The control plane is called only by the
// BFF, but an unbounded body would still be a memory-exhaustion primitive, so
// the limit is part of the contract rather than an assumption.
func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, controlBodyMaxBytes))
	if err := decoder.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
		return false
	}
	return true
}

// controlBodyMaxBytes bounds every control-plane request body. The largest
// documented body is a create/pairing request, which is a few hundred bytes.
const controlBodyMaxBytes = 8 * 1024

// handleGroupSubresource routes `/instances/{id}/groups[/…]`.
func (a *api) handleGroupSubresource(w http.ResponseWriter, r *http.Request, instanceID string, rest []string) {
	switch {
	case len(rest) == 0:
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET /instances/{id}/groups")
			return
		}
		a.handleGroupList(w, r, instanceID)
	case len(rest) == 1 && rest[0] == "sync":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST /instances/{id}/groups/sync")
			return
		}
		a.handleGroupSync(w, r, instanceID)
	case len(rest) == 1 && rest[0] != "":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET /instances/{id}/groups/{groupJid}")
			return
		}
		a.handleGroupByJID(w, r, instanceID, rest[0])
	default:
		writeError(w, http.StatusNotFound, "not_found", "unknown worker route")
	}
}

func (a *api) handleGroupList(w http.ResponseWriter, r *http.Request, instanceID string) {
	groups, syncedAt, err := a.store.ListForInstance(r.Context(), a.orgID, instanceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, groupListResponse{InstanceID: instanceID, SyncedAt: syncedAt, Groups: groups})
}

// handleGroupByJID serves one group, repairing it from WhatsApp first when the
// stored observation is too stale to trust (§6.6.2).
func (a *api) handleGroupByJID(w http.ResponseWriter, r *http.Request, instanceID, groupJID string) {
	doc := a.store.FindOne(r.Context(), a.orgID, instanceID, groupJID)
	if doc == nil {
		writeError(w, http.StatusNotFound, "not_found", "unknown group")
		return
	}
	if doc = a.repairStale(r.Context(), instanceID, doc); doc == nil {
		writeError(w, http.StatusNotFound, "not_found", "unknown group")
		return
	}
	writeJSON(w, http.StatusOK, rowFromDoc(doc))
}

// handleGroupSync forces a full sync. A failure is reported, never disguised as
// an empty membership — the caller must not act on a snapshot that never
// arrived.
func (a *api) handleGroupSync(w http.ResponseWriter, r *http.Request, instanceID string) {
	client := a.client(instanceID)
	if client == nil {
		writeError(w, http.StatusConflict, "instance_offline", "instance has no live whatsapp client")
		return
	}
	summary, err := runGroupSync(r.Context(), client, a.store, a.orgID, instanceID, SyncOnManual, a.prune)
	if err != nil {
		writeError(w, http.StatusBadGateway, "group_sync_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, syncResponse{OK: true, InstanceID: instanceID, SyncSummary: summary})
}

// repairStale refreshes one group from WhatsApp when the stored observation is
// nameless or older than GROUP_STALE_AFTER. A repair that fails for any other
// reason serves what we already have: the dashboard must not lose a row because
// WhatsApp was slow, and the next read retries.
func (a *api) repairStale(ctx context.Context, instanceID string, doc *groupDoc) *groupDoc {
	client := a.client(instanceID)
	if client == nil || !a.stale(doc.Observed) {
		return doc
	}
	jid, err := types.ParseJID(doc.GroupJID)
	if err != nil {
		logf("group %s: unparseable JID, serving stored row: %v", doc.GroupJID, err)
		return doc
	}
	info, err := client.GetGroupInfo(ctx, jid)
	switch {
	case errors.Is(err, whatsmeow.ErrNotInGroup):
		// The account was removed: §6.6.5 rule 5 applies the same marking as a
		// snapshot that no longer lists the group.
		return a.markGone(ctx, instanceID, doc, GroupLeft)
	case errors.Is(err, whatsmeow.ErrGroupNotFound):
		return a.markGone(ctx, instanceID, doc, GroupDeleted)
	case err != nil:
		logf("group %s: repair failed, serving stored row: %v", doc.GroupJID, err)
		return doc
	}
	repaired := *doc
	repaired.Observed, _, _ = mergeSnapshot(doc.Observed, info, SyncOnManual, now().UTC())
	if err := a.store.UpsertObserved(ctx, a.orgID, instanceID, doc.GroupJID, repaired.Observed, true); err != nil {
		logf("group %s: repair write failed, serving stored row: %v", doc.GroupJID, err)
		return doc
	}
	return &repaired
}

// markGone records a group we can no longer read, keeping the name it had.
func (a *api) markGone(ctx context.Context, instanceID string, doc *groupDoc, state GroupState) *groupDoc {
	at := now().UTC()
	if err := a.store.MarkLeft(ctx, a.orgID, instanceID, doc.GroupJID, state); err != nil {
		logf("group %s: could not record state %s: %v", doc.GroupJID, state, err)
		return doc
	}
	marked := *doc
	marked.Observed.State = state
	marked.Observed.LeftDetectedAt = at
	return &marked
}

// stale is the §6.6.2 repair trigger. A zero threshold disables time-based
// repair instead of turning every read into a network call; a group we have no
// name for is always worth one request.
func (a *api) stale(o Observed) bool {
	if o.Subject == "" {
		return true
	}
	return a.staleAfter > 0 && now().Sub(o.LastSyncedAt) > a.staleAfter
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		// The status line is already out; all that is left is to say so.
		logf("write json response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": message, "code": code})
}
