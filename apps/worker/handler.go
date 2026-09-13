package main

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"go.mongodb.org/mongo-driver/v2/bson"
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
		// The process is leaving; the ingest queue performs the final flush.
		return
	}
	ctx := context.WithoutCancel(m.ctx)
	switch evt := evt.(type) {
	case *events.Message:
		m.onMessage(ctx, s, evt)
	case *events.HistorySync:
		m.onHistorySync(ctx, s, evt)
	case *events.JoinedGroup:
		m.onJoinedGroup(ctx, s, evt)
	case *events.GroupInfo:
		m.onGroupInfo(ctx, s, evt)
	case *events.Connected:
		m.onConnected(ctx, s)
	case *events.PairSuccess:
		m.onPairSuccess(s, evt)
	case *events.Disconnected:
		// Auto-reconnect is whatsmeow's job; a transient socket drop is not a
		// state change worth persisting.
		logf("instance %s: disconnected, waiting for automatic reconnect", s.id)
	case *events.LoggedOut:
		logf("instance %s: logged out of whatsapp (%v)", s.id, evt.Reason)
		m.markLoggedOut(ctx, s)
	case *events.Receipt:
		m.onReceipt(ctx, s, evt)
	}
}

// onMessage parses every inbound message (including own messages, §6.1) and
// hands it to the ingest queue, then records the group and queues any
// attachment. The message document is enqueued before the media attempt, so a
// crash can only leave `media.status:"pending"`, never lose the message (§6.2).
func (m *manager) onMessage(ctx context.Context, s *session, evt *events.Message) {
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
		m.ensureGroupKnown(ctx, s.id, doc.GroupJID, doc.Timestamp)
	}
	m.attachMedia(ctx, s, evt, doc)
}

// onHistorySync replays the phone's backfill through the same parse/ingest path
// as live traffic, marked `flags.historical` and bounded by
// HISTORY_SYNC_MAX_DAYS so an old account cannot dump years of history into the
// worker (§6.2).
func (m *manager) onHistorySync(ctx context.Context, s *session, evt *events.HistorySync) {
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
				m.ensureGroupKnown(ctx, s.id, doc.GroupJID, doc.Timestamp)
			}
			m.attachMedia(ctx, s, msgEvt, doc)
			ingested++
		}
	}
	logf("instance %s: history sync ingested %d message(s), skipped %d older than %d day(s)",
		s.id, ingested, skipped, m.cfg.HistorySyncMaxDays)
}

// onJoinedGroup queues the embedded snapshot as a first-class observation
// (§6.6.1): the group exists from the moment we are added, even before any
// message or scheduled sync sees it.
func (m *manager) onJoinedGroup(_ context.Context, _ *session, evt *events.JoinedGroup) {
	if evt.JID.Server != types.GroupServer {
		return
	}
	m.enqueuePersist(joinedGroupJob{groupJID: evt.JID, info: evt.GroupInfo})
}

// onGroupInfo queues one metadata delta. The read-modify-write happens on the
// persistence worker, not on the event loop; an empty change list skips the
// Mongo write entirely — rename storms and membership churn must not amplify
// into writes (§6.6.3).
func (m *manager) onGroupInfo(_ context.Context, s *session, evt *events.GroupInfo) {
	if evt.JID.Server != types.GroupServer {
		return
	}
	m.enqueuePersist(groupDeltaJob{session: s, evt: *evt})
}

// onConnected is the authoritative transition to `connected`: persist the
// canonical bot identity, drop pairing material, and run the full group sync.
// A device already owned by another live session is refused before any of that
// (§6.1 duplicate-ownership guard).
func (m *manager) onConnected(ctx context.Context, s *session) {
	if deviceOwnedByOther(m.liveDevices(), s.id, s.deviceJID()) {
		logf("instance %s: device %s is already linked to another live session; disconnecting", s.id, s.deviceJID())
		if s.client != nil {
			s.client.Disconnect()
		}
		if err := m.markStatus(ctx, s.id, stateError, "device is already linked to another instance"); err != nil {
			logf("instance %s: persist duplicate-device error: %v", s.id, err)
		}
		return
	}
	m.markConnected(ctx, s)
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
func (m *manager) onReceipt(_ context.Context, s *session, evt *events.Receipt) {
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
func (m *manager) ensureGroupKnown(_ context.Context, instanceID, groupJID string, at time.Time) {
	m.enqueuePersist(groupTouchJob{instanceID: instanceID, groupJID: groupJID, at: at})
}

// attachMedia queues one attachment for the media runner. The descriptor comes
// straight from the parsed node (Task 9's `describeMedia`); the runner owns
// download, upload and the `media.*` write. With media unconfigured (no R2
// credentials) the runner is nil and the record stays `pending`, which is the
// documented recoverable state rather than a silent drop (R3).
func (m *manager) attachMedia(ctx context.Context, s *session, evt *events.Message, doc MessageDoc) {
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

// persistQueue is the §6.2 boundary between the protocol goroutine and the
// database: the callback only enqueues, and a fixed set of workers performs the
// writes. It is bounded, and overflow is counted — a slow database must degrade
// visibly, never stall WhatsApp event delivery.
type persistQueue struct {
	mu      sync.Mutex
	ch      chan persistJob
	stopped bool
	dropped atomic.Int64
	failed  atomic.Int64
	workers int

	stopOnce sync.Once
}

func newPersistQueue(size, workers int) *persistQueue {
	if size < 1 {
		size = 1
	}
	if workers < 1 {
		workers = 1
	}
	return &persistQueue{ch: make(chan persistJob, size), workers: workers}
}

// enqueue returns immediately. A full (or stopped) queue counts the job as
// dropped and says so rather than blocking the event loop.
func (q *persistQueue) enqueue(job persistJob) {
	if q == nil {
		return
	}
	q.mu.Lock()
	stopped := q.stopped
	sent := false
	if !stopped {
		select {
		case q.ch <- job:
			sent = true
		default:
		}
	}
	q.mu.Unlock()
	if sent {
		return
	}
	q.dropped.Add(1)
	if stopped {
		logf("event persistence stopped, dropping %T", job)
	} else {
		logf("event persistence queue full, dropping %T", job)
	}
}

// run owns the workers until ctx is cancelled, then drains what is left and
// counts it as dropped.
func (q *persistQueue) run(ctx context.Context, m *manager) {
	if q == nil {
		return
	}
	var wg sync.WaitGroup
	for i := 0; i < q.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			q.worker(ctx, m)
		}()
	}
	wg.Wait()
}

func (q *persistQueue) worker(ctx context.Context, m *manager) {
	for {
		select {
		case <-ctx.Done():
			q.stop()
			return
		case job := <-q.ch:
			if err := job.persist(ctx, m); err != nil {
				q.failed.Add(1)
				logf("event persistence %T: %v", job, err)
			}
		}
	}
}

// stop closes the queue to producers; the first caller drains the buffer so a
// shutdown counts exactly what it abandoned.
func (q *persistQueue) stop() {
	q.stopOnce.Do(func() {
		q.mu.Lock()
		q.stopped = true
		q.mu.Unlock()
		for {
			select {
			case <-q.ch:
				q.dropped.Add(1)
			default:
				return
			}
		}
	})
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
	store    *messageStore
	orgID    string
	workers  int
	jobs     chan mediaJob
}

func newMediaRunner(cfg Config, uploader mediaUploader, store *messageStore, orgID string) *mediaRunner {
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
	if err := r.persist(writeCtx, job.doc, media); err != nil {
		logf("media %s: persist result: %v", job.doc.WaMessageID, err)
	}
}

// persist updates only the `media` subdocument of the message the pipeline ran
// for. The identity triple is the unique index, so this can never touch another
// instance's row.
func (r *mediaRunner) persist(ctx context.Context, doc MessageDoc, media Media) error {
	filter := bson.D{
		{Key: "organizationId", Value: doc.OrganizationID},
		{Key: "instanceId", Value: doc.InstanceID},
		{Key: "waMessageId", Value: doc.WaMessageID},
	}
	if _, err := r.store.coll.UpdateOne(ctx, filter, bson.D{{Key: "$set", Value: mediaFields(media)}}); err != nil {
		return err
	}
	return nil
}

// mediaFields is the §5.1 spelling of the media subdocument.
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
		{Key: "media.r2Key", Value: m.R2Key},
		{Key: "media.publicUrl", Value: m.PublicURL},
		{Key: "media.reason", Value: m.Reason},
		{Key: "media.error", Value: m.Error},
		{Key: "media.attempts", Value: m.Attempts},
	}
}
