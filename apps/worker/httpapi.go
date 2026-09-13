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

// api is the worker control plane's group surface (§6.5, §6.6.6). A nil
// `groups` means the instance has no live whatsmeow client: reads still serve the
// persisted rows, and the sync route answers 409 rather than pretending the
// snapshot is empty.
type api struct {
	store      *groupStore
	groups     groupClient
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
// probes, every instance route is behind the shared bearer token.
func (a *api) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", a.handleHealth)
	mux.HandleFunc("/instances/", a.auth(a.handleInstanceSubresource))
	return mux
}

func (a *api) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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

// handleInstanceSubresource routes `/instances/{id}/{subresource}[/…]`. Only the
// group surface exists here; the instance lifecycle routes belong to the
// manager.
func (a *api) handleInstanceSubresource(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/instances/"), "/"), "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] != "groups" {
		writeError(w, http.StatusNotFound, "not_found", "unknown worker route")
		return
	}
	instanceID := parts[0]
	switch {
	case len(parts) == 2:
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET /instances/{id}/groups")
			return
		}
		a.handleGroupList(w, r, instanceID)
	case len(parts) == 3 && parts[2] == "sync":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST /instances/{id}/groups/sync")
			return
		}
		a.handleGroupSync(w, r, instanceID)
	case len(parts) == 3:
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET /instances/{id}/groups/{groupJid}")
			return
		}
		a.handleGroupByJID(w, r, instanceID, parts[2])
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
	if a.groups == nil {
		writeError(w, http.StatusConflict, "instance_offline", "instance has no live whatsapp client")
		return
	}
	summary, err := runGroupSync(r.Context(), a.groups, a.store, a.orgID, instanceID, SyncOnManual, a.prune)
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
	if a.groups == nil || !a.stale(doc.Observed) {
		return doc
	}
	jid, err := types.ParseJID(doc.GroupJID)
	if err != nil {
		logf("group %s: unparseable JID, serving stored row: %v", doc.GroupJID, err)
		return doc
	}
	info, err := a.groups.GetGroupInfo(ctx, jid)
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
