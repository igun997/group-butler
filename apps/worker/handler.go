package main

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"go.mongodb.org/mongo-driver/v2/bson"
	"google.golang.org/protobuf/encoding/protojson"
)

// handleEvent is the single type-switch dispatcher (§6.1): every whatsmeow
// event arrives here, and each branch does the minimum that cannot be deferred.
// Nothing in this switch may block on I/O — the event loop is shared with the
// protocol handshake, so persistence goes through the ingest queue and media
// work goes to the media runner.
func handleEvent(s *session, evt any) {
	if s == nil || s.mgr == nil {
		return
	}
	m := s.mgr
	if m.ctx.Err() != nil {
		// The process is leaving; the persistence queues drain what they
		// accepted, and nothing new is worth starting.
		return
	}
	switch evt := evt.(type) {
	case *events.Message:
		m.onMessage(s, evt)
	case *events.HistorySync:
		m.onHistorySync(s, evt)
	case *events.JoinedGroup:
		m.onJoinedGroup(s, evt)
	case *events.GroupInfo:
		m.onGroupInfo(s, evt)
	case *events.Connected:
		m.onConnected(s)
	case *events.PairSuccess:
		m.onPairSuccess(s, evt)
	case *events.Disconnected:
		// Auto-reconnect is whatsmeow's job; a transient socket drop is not a
		// state change worth persisting.
		logf("instance %s: disconnected, waiting for automatic reconnect", s.id)
	case *events.LoggedOut:
		logf("instance %s: logged out of whatsapp (%v)", s.id, evt.Reason)
		m.onLoggedOut(s)
	case *events.Receipt:
		m.onReceipt(s, evt)
	}
}

// onMessage parses every inbound message (including own messages, §6.1) and
// hands it to the ingest queue, then records the group and queues any
// attachment. The message document is enqueued before the media attempt, so a
// crash can only leave `media.status:"pending"`, never lose the message (§6.2).
func (m *manager) onMessage(s *session, evt *events.Message) {
	doc, err := parseInbound(evt, m.orgID, s.id)
	if err != nil {
		logf("instance %s: parse inbound: %v", s.id, err)
		return
	}
	s.touch(now().UTC())
	if m.ingest != nil {
		m.ingest.Enqueue(doc)
	}
	if doc.IsGroup {
		m.ensureGroupKnown(s.id, doc.GroupJID, doc.Timestamp)
	}
	m.attachMedia(s, evt, doc)
}

// onHistorySync replays the phone's backfill through the same parse/ingest path
// as live traffic, marked `flags.historical` and bounded by
// HISTORY_SYNC_MAX_DAYS so an old account cannot dump years of history into the
// worker (§6.2).
func (m *manager) onHistorySync(s *session, evt *events.HistorySync) {
	if evt == nil || evt.Data == nil {
		return
	}
	client := s.client
	if client == nil {
		return
	}
	cutoff := now().UTC().AddDate(0, 0, -m.cfg.HistorySyncMaxDays)
	ingested, skipped := 0, 0
	for _, conv := range evt.Data.GetConversations() {
		chatJID, err := types.ParseJID(conv.GetID())
		if err != nil {
			continue
		}
		for _, history := range conv.GetMessages() {
			webMsg := history.GetMessage()
			if webMsg == nil {
				continue
			}
			msgEvt, err := client.ParseWebMessage(chatJID, webMsg)
			if err != nil {
				// A conversation member's message can be unparseable (unknown
				// sender); the rest of the blob must still be ingested.
				continue
			}
			if !msgEvt.Info.Timestamp.IsZero() && msgEvt.Info.Timestamp.Before(cutoff) {
				skipped++
				continue
			}
			doc, err := parseInbound(msgEvt, m.orgID, s.id)
			if err != nil {
				continue
			}
			doc.Historical = true
			if m.ingest != nil {
				m.ingest.Enqueue(doc)
			}
			if doc.IsGroup {
				m.ensureGroupKnown(s.id, doc.GroupJID, doc.Timestamp)
			}
			m.attachMedia(s, msgEvt, doc)
			ingested++
		}
	}
	logf("instance %s: history sync ingested %d message(s), skipped %d older than %d day(s)",
		s.id, ingested, skipped, m.cfg.HistorySyncMaxDays)
}

// onJoinedGroup queues the embedded snapshot as a first-class observation
// (§6.6.1): the group exists from the moment we are added, even before any
// message or scheduled sync sees it.
func (m *manager) onJoinedGroup(_ *session, evt *events.JoinedGroup) {
	if evt.JID.Server != types.GroupServer {
		return
	}
	m.enqueuePersist(joinedGroupJob{groupJID: evt.JID, info: evt.GroupInfo})
}

// onGroupInfo queues one metadata delta. The read-modify-write happens on the
// persistence worker, not on the event loop; an empty change list skips the
// Mongo write entirely — rename storms and membership churn must not amplify
// into writes (§6.6.3).
func (m *manager) onGroupInfo(s *session, evt *events.GroupInfo) {
	if evt.JID.Server != types.GroupServer {
		return
	}
	m.enqueuePersist(groupDeltaJob{session: s, evt: *evt})
}

// onConnected is the authoritative transition to `connected`. The duplicate
// ownership guard and the in-memory status run here because later events depend
// on them; the instance row, pairing cleanup and the full group sync are queued
// so the protocol goroutine never waits on Mongo or WhatsApp I/O (§6.1, §6.2).
func (m *manager) onConnected(s *session) {
	if deviceOwnedByOther(m.liveDevices(), s.id, s.deviceJID()) {
		const reason = "device is already linked to another instance"
		logf("instance %s: device %s is already linked to another live session; disconnecting", s.id, s.deviceJID())
		if s.client != nil {
			s.client.Disconnect()
		}
		s.setStatus(stateError, reason)
		m.enqueueLifecycle(instanceStatusJob{instanceID: s.id, status: stateError, pairingError: reason})
		return
	}
	m.markConnectedLocal(s)
	m.enqueueLifecycle(instanceConnectedJob{session: s})
}

// onLoggedOut releases the session synchronously (nothing else may use it) and
// queues the persistence and credential cleanup.
func (m *manager) onLoggedOut(s *session) {
	m.releaseLoggedOut(s)
}

// onPairSuccess captures the canonical JID/LID as soon as the phone confirms the
// link, before the follow-up Connected event.
func (m *manager) onPairSuccess(s *session, evt *events.PairSuccess) {
	s.mu.Lock()
	s.botJID = evt.ID.String()
	s.botLID = evt.LID.String()
	s.mu.Unlock()
}

// onReceipt queues the §10 live counter. A receipt is not a message, so it
// bumps its own counter instead of inflating `messagesIn`; the BFF's rollup
// reconciles the day.
func (m *manager) onReceipt(s *session, evt *events.Receipt) {
	groupJID := ""
	if evt.Chat.Server == types.GroupServer {
		groupJID = evt.Chat.String()
	}
	at := evt.Timestamp
	if at.IsZero() {
		at = now().UTC()
	}
	m.enqueuePersist(receiptJob{instanceID: s.id, groupJID: groupJID, at: at})
}

// ensureGroupKnown queues a traffic record for a group, so a missed sync can
// never hide a group (R1, §6.2). The ingest-owned counters are incremented by
// the persistence worker, never read-modify-written here, so this commutes with
// the BFF's `config.*` writes (§5.2).
func (m *manager) ensureGroupKnown(instanceID, groupJID string, at time.Time) {
	m.enqueuePersist(groupTouchJob{instanceID: instanceID, groupJID: groupJID, at: at})
}

// attachMedia queues one attachment for the media runner. The descriptor comes
// straight from the parsed node (Task 9's `describeMedia`); the runner owns
// download, upload and the `media.*` write. With media unconfigured (no R2
// credentials) the runner is nil and the record stays `pending`, which is the
// documented recoverable state rather than a silent drop (R3).
func (m *manager) attachMedia(s *session, evt *events.Message, doc MessageDoc) {
	if m.media == nil || doc.Media.Status != MediaPending || evt == nil || evt.Message == nil {
		return
	}
	desc, ok := describeMedia(evt.Message)
	if !ok {
		return
	}
	desc.MessageID = doc.WaMessageID
	desc.GroupJID = doc.GroupJID
	m.media.enqueue(mediaJob{doc: doc, desc: desc, client: s.client})
}

// ---- off-callback persistence --------------------------------------------

// persistJob is one unit of Mongo work that originated on the whatsmeow event
// loop. Jobs are values (not closures) so the queue can log and count them by
// type.
type persistJob interface {
	persist(ctx context.Context, m *manager) error
}

// persistDrainTimeout bounds the shutdown drain. The worker context is already
// cancelled by then, so the drain gets its own deadline rather than inheriting a
// dead one; a job that cannot finish inside it is the only kind counted as
// dropped at shutdown.
const persistDrainTimeout = 10 * time.Second

// persistQueue is the §6.2 boundary between the protocol goroutine and the
// database: the callback only enqueues, and a fixed set of workers performs the
// writes. It is bounded, and overflow is counted — a slow database must degrade
// visibly, never stall WhatsApp event delivery.
//
// Shutdown stops admission and then *drains every accepted job* under a bounded
// context before the workers exit: work that was accepted is processed, not
// discarded, and only a full buffer, a rejected admission, or a deadline cut-off
// is counted as dropped.
type persistQueue struct {
	mu      sync.Mutex
	ch      chan persistJob
	stopped bool
	dropped atomic.Int64
	failed  atomic.Int64
	workers int

	closeOnce   sync.Once
	abandonOnce sync.Once

	// drainTimeout bounds the shutdown drain; a test can shorten it.
	drainTimeout time.Duration
}

func newPersistQueue(size, workers int) *persistQueue {
	if size < 1 {
		size = 1
	}
	if workers < 1 {
		workers = 1
	}
	return &persistQueue{
		ch:           make(chan persistJob, size),
		workers:      workers,
		drainTimeout: persistDrainTimeout,
	}
}

// enqueue returns immediately. A full (or closed) queue counts the job as
// dropped and says so rather than blocking the event loop.
func (q *persistQueue) enqueue(job persistJob) {
	if q == nil {
		return
	}
	q.mu.Lock()
	if q.stopped {
		q.mu.Unlock()
		q.dropped.Add(1)
		logf("event persistence stopped, dropping %T", job)
		return
	}
	select {
	case q.ch <- job:
		q.mu.Unlock()
	default:
		q.mu.Unlock()
		q.dropped.Add(1)
		logf("event persistence queue full, dropping %T", job)
	}
}

// close stops admission and closes the channel, which is what lets the workers
// drain the buffer. Admission and the close share the lock, so a producer can
// never send on a closed channel.
func (q *persistQueue) close() {
	if q == nil {
		return
	}
	q.closeOnce.Do(func() {
		q.mu.Lock()
		q.stopped = true
		close(q.ch)
		q.mu.Unlock()
	})
}

// run owns the workers until ctx is cancelled, then stops admission and drains
// every accepted job under the drain deadline before returning. Jobs still in
// flight when the deadline passes fail (their context is cancelled); jobs the
// deadline cut off are the only shutdown drops.
func (q *persistQueue) run(ctx context.Context, m *manager) {
	if q == nil {
		return
	}
	// The workers use their own context: on the shutdown path ctx is already
	// cancelled, and the accepted work must still be allowed to land.
	drainCtx, cancelDrain := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for i := 0; i < q.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			q.worker(drainCtx, m)
		}()
	}

	<-ctx.Done()
	q.close()
	timer := time.AfterFunc(q.drainTimeout, cancelDrain)
	wg.Wait()
	timer.Stop()
	cancelDrain()
	q.abandon()
}

func (q *persistQueue) worker(ctx context.Context, m *manager) {
	for {
		if ctx.Err() != nil {
			// The drain deadline passed: stop pulling jobs. Whatever is left is
			// counted once by abandon().
			return
		}
		select {
		case <-ctx.Done():
			return
		case job, ok := <-q.ch:
			if !ok {
				return
			}
			if ctx.Err() != nil {
				// The deadline landed between the select and here; the job was
				// accepted but cannot be allowed to run with a dead context.
				q.dropped.Add(1)
				return
			}
			if err := job.persist(ctx, m); err != nil {
				q.failed.Add(1)
				logf("event persistence %T: %v", job, err)
			}
		}
	}
}

// abandon counts the accepted jobs the drain deadline cut off. It is the only
// shutdown-time drop, and it is attempted exactly once.
func (q *persistQueue) abandon() {
	q.abandonOnce.Do(func() {
		for {
			_, ok := <-q.ch
			if !ok {
				return
			}
			q.dropped.Add(1)
		}
	})
}

// lifecycleDrainTimeout bounds the shutdown drain of the lifecycle queue. It is
// deliberately shorter than the metadata queue's: these transitions are rare, so
// a drain that still has work after this long is a stuck dependency, and the
// startup reconcile is what repairs the rows it could not apply.
const lifecycleDrainTimeout = 5 * time.Second

// lifecycleWarnDepth is where a stalled lifecycle consumer becomes loud. The
// queue never drops a transition, so backlog is its only symptom.
const lifecycleWarnDepth = 1000

// lifecycleQueue is the ordered, lossless queue for instance state transitions
// (connected, logged out, duplicate-device refusal). It is deliberately *not*
// bounded the way the metadata queue is: a `Connected` or `LoggedOut` event is a
// rare control-plane transition, and silently discarding one would leave
// `instances.runtime` describing a link that does not exist — state no metadata
// touch can repair. Admission therefore always succeeds; the queue is an
// in-memory FIFO whose depth /health reports, shutdown drains every accepted
// transition under a bounded deadline, and whatever the deadline cuts off is
// counted as abandoned and repaired by the startup reconcile.
type lifecycleQueue struct {
	mu           sync.Mutex
	jobs         []persistJob
	stopped      bool
	drainTimeout time.Duration

	notify  chan struct{}
	failed  atomic.Int64
	applied atomic.Int64

	abandonOnce sync.Once
	abandoned   atomic.Int64

	// rejected counts transitions that arrived after admission closed. They are
	// the one case where a control-plane transition is not applied, and they are
	// always visible: /health degrades and the next start reconciles the row.
	rejected atomic.Int64
}

func newLifecycleQueue() *lifecycleQueue {
	return &lifecycleQueue{
		notify:       make(chan struct{}, 1),
		drainTimeout: lifecycleDrainTimeout,
	}
}

// enqueue never blocks. It returns false when admission has closed — a
// transition that arrives after the drain finished is *rejected and counted*,
// never appended to a queue that nothing will consume. Acceptance and the stop
// share the lock, so the handoff (producer passes a liveness check, shutdown
// closes admission, producer enqueues) can never lose a transition silently.
func (q *lifecycleQueue) enqueue(job persistJob) bool {
	if q == nil {
		return false
	}
	q.mu.Lock()
	if q.stopped {
		q.mu.Unlock()
		q.rejected.Add(1)
		logf("lifecycle transition %T rejected after admission closed; /health is degraded and the next start reconciles the row", job)
		return false
	}
	q.jobs = append(q.jobs, job)
	depth := len(q.jobs)
	q.mu.Unlock()
	if depth == lifecycleWarnDepth {
		logf("lifecycle queue backlog at %d transitions; the consumer may be stalled", depth)
	}
	select {
	case q.notify <- struct{}{}:
	default:
	}
	return true
}

// stop closes admission. It does not discard anything: what is already queued is
// still drained.
func (q *lifecycleQueue) stop() {
	q.mu.Lock()
	q.stopped = true
	q.mu.Unlock()
}

// run owns the single consumer. Instance transitions are applied in arrival
// order; when ctx is cancelled admission stops and the remaining accepted
// transitions are drained under the bounded deadline rather than applied with a
// dead context.
func (q *lifecycleQueue) run(ctx context.Context, m *manager) {
	if q == nil {
		return
	}
	for {
		if ctx.Err() != nil {
			break
		}
		job, ok := q.next(ctx)
		if !ok {
			break
		}
		if ctx.Err() != nil {
			// Shutdown landed between the pop and here: hand the transition to
			// the bounded drain instead of applying it with a dead context.
			q.requeueFront(job)
			break
		}
		q.apply(ctx, m, job)
	}
	q.drain(m)
}

func (q *lifecycleQueue) requeueFront(job persistJob) {
	q.mu.Lock()
	q.jobs = append([]persistJob{job}, q.jobs...)
	q.mu.Unlock()
}

// next blocks until a job is available or ctx is cancelled. Admission never
// closes the queue, so a job can always still arrive while ctx is alive.
func (q *lifecycleQueue) next(ctx context.Context) (persistJob, bool) {
	for {
		if job, ok := q.pop(); ok {
			return job, true
		}
		select {
		case <-ctx.Done():
			return nil, false
		case <-q.notify:
		}
	}
}

func (q *lifecycleQueue) pop() (persistJob, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.jobs) == 0 {
		return nil, false
	}
	job := q.jobs[0]
	q.jobs = q.jobs[1:]
	return job, true
}

func (q *lifecycleQueue) apply(ctx context.Context, m *manager, job persistJob) {
	if err := job.persist(ctx, m); err != nil {
		q.failed.Add(1)
		logf("lifecycle transition %T: %v", job, err)
		return
	}
	q.applied.Add(1)
}

// drain applies the transitions accepted before shutdown, under its own bounded
// context (the run context is already cancelled). Whatever the deadline cuts off
// is counted as abandoned and logged: the consumer reports it rather than
// pretending it was applied.
func (q *lifecycleQueue) drain(m *manager) {
	q.stop()
	q.mu.Lock()
	remaining := len(q.jobs)
	q.mu.Unlock()
	if remaining == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), q.drainTimeout)
	defer cancel()
	for {
		job, ok := q.pop()
		if !ok {
			break
		}
		if ctx.Err() != nil {
			q.requeueFront(job)
			break
		}
		q.apply(ctx, m, job)
	}
	q.abandonOnce.Do(func() {
		q.mu.Lock()
		left := len(q.jobs)
		q.mu.Unlock()
		if left > 0 {
			q.abandoned.Store(int64(left))
			logf("lifecycle: %d transition(s) not applied before the drain deadline; the next start reconciles them", left)
		}
	})
}

func (q *lifecycleQueue) Depth() int {
	if q == nil {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.jobs)
}

func (q *lifecycleQueue) Stopped() bool {
	if q == nil {
		return false
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.stopped
}

func (q *lifecycleQueue) Applied() int64 {
	if q == nil {
		return 0
	}
	return q.applied.Load()
}

func (q *lifecycleQueue) Failed() int64 {
	if q == nil {
		return 0
	}
	return q.failed.Load()
}

// Abandoned is the number of accepted transitions the shutdown drain could not
// apply. It is the one number that must never be silently non-zero.
func (q *lifecycleQueue) Abandoned() int64 {
	if q == nil {
		return 0
	}
	return q.abandoned.Load()
}

// Rejected is the number of transitions that arrived after admission closed.
func (q *lifecycleQueue) Rejected() int64 {
	if q == nil {
		return 0
	}
	return q.rejected.Load()
}

func (q *persistQueue) Depth() int {
	if q == nil {
		return 0
	}
	return len(q.ch)
}

func (q *persistQueue) Dropped() int64 {
	if q == nil {
		return 0
	}
	return q.dropped.Load()
}

func (q *persistQueue) Failed() int64 {
	if q == nil {
		return 0
	}
	return q.failed.Load()
}

// groupTouchJob records traffic for one group (§6.2).
type groupTouchJob struct {
	instanceID string
	groupJID   string
	at         time.Time
}

func (j groupTouchJob) persist(ctx context.Context, m *manager) error {
	if m.groups == nil {
		return nil
	}
	return m.groups.Touch(ctx, m.orgID, j.instanceID, j.groupJID, j.at)
}

// groupDeltaJob folds one `events.GroupInfo` into the stored observation. The
// read and the write are both here so the event loop does neither.
type groupDeltaJob struct {
	session *session
	evt     events.GroupInfo
}

func (j groupDeltaJob) persist(ctx context.Context, m *manager) error {
	if m.groups == nil || j.session == nil {
		return nil
	}
	groupJID := j.evt.JID.String()
	cur := Observed{State: GroupActive, SubjectSource: SubjectFromFallback}
	if stored := m.groups.FindOne(ctx, m.orgID, j.session.id, groupJID); stored != nil {
		cur = stored.Observed
	}
	next, changes, err := applyGroupDelta(cur, j.evt, j.session.deviceJID())
	if err != nil {
		return err
	}
	if len(changes) == 0 {
		// Nothing moved: the write is skipped, not issued empty (§6.6.3).
		return nil
	}
	return m.groups.UpsertObserved(ctx, m.orgID, j.session.id, groupJID, next, false)
}

// joinedGroupJob persists a newly joined group's embedded snapshot (§6.6.1).
type joinedGroupJob struct {
	groupJID types.JID
	info     types.GroupInfo
}

func (j joinedGroupJob) persist(ctx context.Context, m *manager) error {
	if m.groups == nil {
		return nil
	}
	info := j.info
	return m.groups.UpsertFromSync(ctx, m.orgID, j.info.JID.String(), &info, SyncOnEvent)
}

// receiptJob records one inbound receipt in the §10 live counter.
type receiptJob struct {
	instanceID string
	groupJID   string
	at         time.Time
}

func (j receiptJob) persist(ctx context.Context, m *manager) error {
	if m.stats == nil {
		return nil
	}
	return m.stats.bumpReceipt(ctx, m.orgID, j.instanceID, j.groupJID, j.at)
}

// ---- media runner --------------------------------------------------------

// mediaStore is the janitor's Mongo surface (§6.3.5): the pending/failed scan
// and the retry write.
type mediaStore interface {
	pendingMedia(ctx context.Context, orgID string, maxAttempts int) ([]mediaCandidate, error)
	saveMedia(ctx context.Context, doc MessageDoc, media Media) error
}

// mediaJob is one attachment to fetch, store and record.
type mediaJob struct {
	doc    MessageDoc
	desc   MediaDescriptor
	client whatsmeowMediaClient
}

// mediaRunner is the §6.2 bounded queue: MEDIA_CONCURRENCY workers, a bounded
// buffer, and an overflow that logs rather than growing without bound. It is
// nil when media is not configured, which the handler treats as "not this
// build's job".
type mediaRunner struct {
	limits   *mediaLimits
	uploader mediaUploader
	store    mediaStore
	orgID    string
	workers  int
	jobs     chan mediaJob
}

func newMediaRunner(cfg Config, uploader mediaUploader, store mediaStore, orgID string) *mediaRunner {
	if uploader == nil || store == nil {
		return nil
	}
	workers := cfg.MediaConcurrency
	if workers < 1 {
		workers = 1
	}
	return &mediaRunner{
		limits:   newMediaLimits(cfg),
		uploader: uploader,
		store:    store,
		orgID:    orgID,
		workers:  workers,
		jobs:     make(chan mediaJob, workers*8),
	}
}

// enqueue never blocks the event loop: a full queue leaves the attachment
// `pending` and says so.
func (r *mediaRunner) enqueue(job mediaJob) {
	if r == nil {
		return
	}
	select {
	case r.jobs <- job:
	default:
		logf("media queue full, leaving %s pending for the janitor", job.doc.WaMessageID)
	}
}

// run owns the worker pool for the process lifetime; ctx cancellation drains it.
func (r *mediaRunner) run(ctx context.Context) {
	if r == nil {
		return
	}
	var wg sync.WaitGroup
	for i := 0; i < r.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.worker(ctx)
		}()
	}
	wg.Wait()
}

func (r *mediaRunner) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-r.jobs:
			r.attempt(ctx, job)
		}
	}
}

func (r *mediaRunner) attempt(ctx context.Context, job mediaJob) {
	pipeline := newMediaPipeline(r.limits, newWhatsmeowDownloader(job.client, r.limits), r.uploader, r.orgID, job.doc.InstanceID, now())
	media := pipeline.Store(ctx, job.desc)
	// The write never inherits a cancelled ctx: a shutdown must still land the
	// result it already paid for.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ingestFlushTimeout)
	defer cancel()
	if err := r.store.saveMedia(writeCtx, job.doc, media); err != nil {
		logf("media %s: persist result: %v", job.doc.WaMessageID, err)
	}
}

// ---- media janitor -------------------------------------------------------

// runMediaJanitor retries attachments the live path could not finish, on the
// MEDIA_JANITOR_INTERVAL cadence (§6.3.5). With media storage unconfigured there
// is no runner and nothing to retry, so the loop exits instead of ticking.
func (m *manager) runMediaJanitor(ctx context.Context) {
	if m.media == nil {
		logf("media janitor disabled: media storage is not configured")
		return
	}
	ticks, stop := m.newTicker(m.cfg.MediaJanitorEvery)
	defer stop()
	logf("media janitor started (every %s)", m.cfg.MediaJanitorEvery)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			m.janitorSweep(ctx)
		}
	}
}

// janitorSweep queues one retry per candidate whose instance has a live client.
// An attachment whose owner is disconnected is left pending: it is recoverable
// by definition, and marking it exhausted would lie about what happened.
func (m *manager) janitorSweep(ctx context.Context) {
	if m.media == nil {
		return
	}
	candidates, err := m.media.store.pendingMedia(ctx, m.orgID, m.cfg.MediaMaxAttempts)
	if err != nil {
		logf("media janitor: %v", err)
		return
	}
	queued := 0
	for _, candidate := range candidates {
		client := m.mediaClient(candidate.InstanceID)
		if client == nil {
			continue
		}
		desc, ok := descriptorFromStored(candidate)
		if !ok {
			continue
		}
		m.media.enqueue(mediaJob{
			doc: MessageDoc{
				OrganizationID: candidate.OrganizationID,
				InstanceID:     candidate.InstanceID,
				WaMessageID:    candidate.WaMessageID,
			},
			desc:   desc,
			client: client,
		})
		queued++
	}
	if len(candidates) > 0 {
		logf("media janitor: queued %d of %d pending attachment(s) for retry", queued, len(candidates))
	}
}

// descriptorFromStored rebuilds the downloadable descriptor for a stored message
// by decoding its raw protobuf tree, so a retry downloads exactly the node the
// live path would have used. A tree that no longer parses is not retryable.
func descriptorFromStored(candidate mediaCandidate) (MediaDescriptor, bool) {
	if len(candidate.Raw) == 0 {
		return MediaDescriptor{}, false
	}
	encoded, err := json.Marshal(candidate.Raw)
	if err != nil {
		return MediaDescriptor{}, false
	}
	var msg waE2E.Message
	if err := protojson.Unmarshal(encoded, &msg); err != nil {
		return MediaDescriptor{}, false
	}
	desc, ok := describeMedia(&msg)
	if !ok {
		return MediaDescriptor{}, false
	}
	desc.MessageID = candidate.WaMessageID
	desc.GroupJID = candidate.GroupJID
	return desc, true
}

// mediaClient returns the live client able to download for an instance, or nil
// when the instance is offline.
func (m *manager) mediaClient(instanceID string) whatsmeowMediaClient {
	s := m.get(instanceID)
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status != stateConnected || s.client == nil {
		return nil
	}
	return s.client
}

// mediaFields is the §5.1 spelling of the media subdocument. `attempts` is
// absent on purpose: it is incremented by saveMedia, not overwritten per
// attempt.
func mediaFields(m Media) bson.D {
	return bson.D{
		{Key: "media.status", Value: m.Status},
		{Key: "media.kind", Value: m.Kind},
		{Key: "media.declaredType", Value: m.DeclaredType},
		{Key: "media.mime", Value: m.Mime},
		{Key: "media.fileName", Value: m.FileName},
		{Key: "media.size", Value: m.Size},
		{Key: "media.sha256", Value: m.SHA256},
		{Key: "media.width", Value: m.Width},
		{Key: "media.height", Value: m.Height},
		{Key: "media.durationSec", Value: m.DurationSec},
		{Key: "media.text", Value: m.Text},
		{Key: "media.r2Key", Value: m.R2Key},
		{Key: "media.publicUrl", Value: m.PublicURL},
		{Key: "media.reason", Value: m.Reason},
		{Key: "media.error", Value: m.Error},
	}
}
