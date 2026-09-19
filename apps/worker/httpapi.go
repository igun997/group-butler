package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// api is the worker control plane (§6.5). `store` serves the persisted group read
// model, `bridge` is the WhatsApp connection every live group call goes through,
// and `manager` owns the instance routes. A nil manager leaves those routes
// answering 404, which keeps the group surface testable on its own.
type api struct {
	store groupStoreAPI
	// bridge is the Hermes bridge: the process that owns the linked device answers
	// these calls, so no route on this surface needs a session of its own.
	bridge     *hermesBridge
	manager    *manager
	orgID      string
	secret     string
	prune      bool
	staleAfter time.Duration

	// Health dependencies. `ping` is the database reachability check and `queue`
	// is the bounded ingest queue whose state the probe reports (§6.5).
	ping  func(ctx context.Context) error
	queue *ingestQueue
}

// healthResponse is the §6.5 liveness payload: `ok` is the aggregate a load
// balancer acts on, and the parts say which dependency degraded.
type healthResponse struct {
	OK    bool        `json:"ok"`
	Mongo string      `json:"mongo"`
	Queue queueHealth `json:"queue"`
}

type queueHealth struct {
	Depth    int    `json:"depth"`
	Capacity int    `json:"capacity"`
	Dropped  int64  `json:"dropped"`
	Stopped  bool   `json:"stopped"`
	Error    string `json:"error,omitempty"`
}

// healthTimeout bounds the probe: a hung database must fail the check, not hang
// the load balancer.
const healthTimeout = 2 * time.Second

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
	// The scheduled loops are operational detail, so they sit behind the same
	// bearer token as the instance surface rather than beside the open probe.
	mux.HandleFunc("/scheduler", a.auth(a.handleScheduler))
	// The Hermes bridge posts every message it sees here, with the same shared
	// token: it is another service of this deployment, not a public collector.
	mux.HandleFunc("/ingest", a.auth(a.handleIngest))
	instances := a.auth(a.handleInstanceSubresource)
	mux.HandleFunc("/instances", instances)
	mux.HandleFunc("/instances/", instances)
	return mux
}

// externalEventBodyMaxBytes bounds one bridge event. It is far larger than the rest
// of the control plane because the body is a WhatsApp message — a long text plus
// its mention list — rather than a command, and still finite, because the route is
// reachable with a token that could be leaked.
const externalEventBodyMaxBytes = 128 * 1024

// handleIngest is the worker's second ingest door (§6.2): the Hermes bridge POSTs
// one event per inbound WhatsApp message, and this accepts it into the same queue
// whatever the agent decides to do with the message.
//
// 202 — not 200 — because nothing is durable yet: the row is accepted into memory
// and written with the batch behind it, which is what keeps this answer fast enough
// for a bridge whose callback is not allowed to stall. A malformed body and an event
// that cannot be identified are 400 (the bridge should fix the payload); a worker
// that is shutting down, or one built without this path, is 503 (the bridge should
// keep the event for a later attempt).
func (a *api) handleIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST /ingest")
		return
	}
	if a.manager == nil {
		writeError(w, http.StatusServiceUnavailable, "ingest_unavailable", "this worker has no ingest path")
		return
	}
	var evt externalEvent
	if !decodeBodyLimited(w, r, &evt, externalEventBodyMaxBytes) {
		return
	}
	if err := a.manager.ingestExternalEvent(r.Context(), evt); err != nil {
		switch {
		case errors.Is(err, errInvalidRequest):
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		case errors.Is(err, errIngestClosed):
			writeError(w, http.StatusServiceUnavailable, "ingest_closed", err.Error())
		default:
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
		}
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "messageId": evt.MessageID})
}

// handleScheduler reports what this worker's timers are doing: each loop's
// cadence and the outcome of its last pass. `/health` answers whether the worker
// is usable; this answers what it is up to.
func (a *api) handleScheduler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET only")
		return
	}
	if a.manager == nil {
		writeError(w, http.StatusNotFound, "not_found", "no scheduled loops to report")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"loops": a.manager.loops.snapshot()})
}

// handleHealth is the §6.5 probe: `/health` stays open for container probes and
// reports the database and the bounded ingest queue. `ok` is false — with 503 —
// when a dependency the worker cannot function without has failed, so a load
// balancer stops routing here instead of sending work into a stalled worker.
func (a *api) handleHealth(w http.ResponseWriter, r *http.Request) {
	body := healthResponse{OK: true, Mongo: "ok"}
	if a.queue != nil {
		body.Queue = queueHealth{
			Depth:    a.queue.Depth(),
			Capacity: a.queue.Capacity(),
			Dropped:  a.queue.Dropped(),
			Stopped:  a.queue.Stopped(),
		}
		if body.Queue.Stopped {
			body.OK = false
			body.Queue.Error = "ingest consumer stopped"
		}
	}
	if a.ping != nil {
		ctx, cancel := context.WithTimeout(r.Context(), healthTimeout)
		defer cancel()
		if err := a.ping(ctx); err != nil {
			body.OK = false
			body.Mongo = "error"
		}
	}
	status := http.StatusOK
	if !body.OK {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, body)
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
// first segment selects the instance surface or, for a known instance, one of its
// subresources (groups, and the pairing routes that now refuse).
//
// The pairing subresources are still routed rather than removed so a caller gets
// a refusal that names where pairing went instead of a bare 404. The BFF keeps
// calling this worker's `POST /instances`; its answer is now the honest one.
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
		a.refusePairing(w)
	case len(tail) == 2 && tail[0] != "" && tail[1] == "pair":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST /instances/{id}/pair")
			return
		}
		a.refusePairing(w)
	case len(tail) == 2 && tail[0] != "" && tail[1] == "check":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST /instances/{id}/check")
			return
		}
		a.refusePairing(w)
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
		writeError(w, http.StatusNotFound, "not_found", "instance surface is not available")
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
		// Creating an instance used to mean "link a device": mint a row, open an
		// auth-store device, start a QR/pairing-code attempt. The credential is
		// Hermes's now, so there is nothing here to pair — the BFF's wizard
		// (apps/web/src/server/hermes/pairing.ts) starts the attempt and the
		// console reads the QR from its own poll.
		a.refusePairing(w)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET /instances")
	}
}

// refusePairing answers every route that used to link a device into a WhatsApp
// session held by this worker. `invalid_state` is the BFF's vocabulary for "the
// instance is not in a state that allows this" — the closest honest code, since
// the operation itself has moved — and the message names where pairing went so an
// operator reading the worker's answer knows the console is not broken.
func (a *api) refusePairing(w http.ResponseWriter) {
	writeError(w, http.StatusConflict, "invalid_state", errPairingMoved.Error())
}

func (a *api) handleInstanceItem(w http.ResponseWriter, r *http.Request, instanceID string) {
	if a.manager == nil {
		writeError(w, http.StatusNotFound, "not_found", "instance surface is not available")
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

// writeInstanceError maps the manager's sentinel errors to the §6.5 stable
// codes the BFF turns into UI messages.
func (a *api) writeInstanceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errInstanceNotFound):
		writeError(w, http.StatusNotFound, "not_found", err.Error())
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
	return decodeBodyLimited(w, r, dst, controlBodyMaxBytes)
}

// decodeBodyLimited is decodeBody for the routes whose body is larger than a
// create/pairing request — the group-admin photo, whose size is bounded by the
// photo's own limit instead.
func decodeBodyLimited(w http.ResponseWriter, r *http.Request, dst any, maxBytes int64) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBytes))
	if err := decoder.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
		return false
	}
	return true
}

// controlBodyMaxBytes bounds every control-plane request body that is not a
// group-admin write. The largest of those is a create/pairing request, which is
// a few hundred bytes; the admin route carries an image and has its own limit
// (groupAdminBodyMaxBytes).
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
	case len(rest) == 2 && rest[0] != "" && rest[1] == "info":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET /instances/{id}/groups/{groupJid}/info")
			return
		}
		a.handleGroupInfo(w, r, instanceID, rest[0])
	case len(rest) == 2 && rest[0] != "" && rest[1] == "participants":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET /instances/{id}/groups/{groupJid}/participants")
			return
		}
		a.handleGroupParticipants(w, r, instanceID, rest[0])
	case len(rest) == 2 && rest[0] != "" && rest[1] == "admin":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST /instances/{id}/groups/{groupJid}/admin")
			return
		}
		a.handleGroupAdmin(w, r, instanceID, rest[0])
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
//
// The snapshot comes from the bridge's `GET /groups`: every group the linked
// account participates in, which is the one question a per-JID read cannot
// answer. A bridge this worker cannot reach is `instance_offline` — there is no
// live session to ask, on either side of the loopback — and a bridge that
// answered with a refusal is a failed sync, recorded against the instance so the
// dashboard shows the failure the operator just triggered.
func (a *api) handleGroupSync(w http.ResponseWriter, r *http.Request, instanceID string) {
	if _, ok := a.groupInstance(w, r, instanceID); !ok {
		return
	}
	bridge, ok := a.liveBridge(w)
	if !ok {
		return
	}
	summary, err := runGroupSync(r.Context(), bridge, a.store, a.orgID, instanceID, SyncOnManual, a.prune)
	if err != nil {
		if a.manager != nil {
			a.manager.recordGroupSyncError(r.Context(), instanceID, err.Error())
		}
		a.writeGroupReadError(w, classifyGroupFailure(err))
		return
	}
	// A manual sync describes the membership just as a timer-driven one does, so
	// it moves the same summary. The harness that wires this handler without a
	// manager (the group surface on its own) has no summary to move.
	if a.manager != nil {
		a.manager.recordGroupSync(r.Context(), instanceID, summary)
	}
	writeJSON(w, http.StatusOK, syncResponse{OK: true, InstanceID: instanceID, SyncSummary: summary})
}

// repairStale refreshes one group from WhatsApp when the stored observation is
// nameless or older than GROUP_STALE_AFTER. The read is the bridge's
// `GET /group/:jid`, the same call the admin surface's info route makes, so what
// lands in the read model is what the console sees.
//
// A repair that fails for any other reason serves what we already have: the
// dashboard must not lose a row because WhatsApp was slow, and the next read
// retries. A group the account can no longer see is marked gone instead —
// keeping the name it had — because that is a fact, not a failure.
func (a *api) repairStale(ctx context.Context, instanceID string, doc *groupDoc) *groupDoc {
	if a.bridge == nil || !a.stale(doc.Observed) {
		return doc
	}
	address, err := parseAddress(doc.GroupJID)
	if err != nil || !address.isGroup() {
		logf("group %s: unparseable JID, serving stored row: %v", doc.GroupJID, err)
		return doc
	}
	info, err := a.bridge.GroupInfo(ctx, address.String())
	switch {
	case errors.Is(classifyGroupFailure(err), errGroupNotFound):
		// The account was removed, or the group no longer exists. The bridge's
		// contract collapses the two — every group call answers the same
		// not-found — and `left` is the honest one of the pair: it keeps the
		// name the group had, and a later snapshot that lists the group again
		// moves it back to `active` (§6.6.5 rule 5).
		return a.markGone(ctx, instanceID, doc, GroupLeft)
	case err != nil:
		logf("group %s: repair failed, serving stored row: %v", doc.GroupJID, err)
		return doc
	}
	repaired := *doc
	repaired.Observed, _ = mergeSnapshot(doc.Observed, groupSnapshot{
		JID:              address.String(),
		Subject:          info.Subject,
		Announce:         info.Announce,
		Locked:           info.Locked,
		ParticipantCount: len(info.Participants),
	}, SyncOnManual, now().UTC())
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
