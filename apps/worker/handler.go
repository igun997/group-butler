package main

import (
	"context"
	"sync"
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

// onJoinedGroup persists the embedded snapshot as a first-class observation
// (§6.6.1): the group exists from the moment we are added, even before any
// message or scheduled sync sees it.
func (m *manager) onJoinedGroup(ctx context.Context, s *session, evt *events.JoinedGroup) {
	if evt.JID.Server != types.GroupServer || m.groups == nil {
		return
	}
	if err := m.groups.UpsertFromSync(ctx, m.orgID, s.id, &evt.GroupInfo, SyncOnEvent); err != nil {
		logf("instance %s: upsert joined group %s: %v", s.id, evt.JID, err)
	}
}

// onGroupInfo folds one metadata delta into the stored observation. An empty
// change list skips the Mongo write entirely — rename storms and membership
// churn must not amplify into writes (§6.6.3).
func (m *manager) onGroupInfo(ctx context.Context, s *session, evt *events.GroupInfo) {
	if evt.JID.Server != types.GroupServer || m.groups == nil {
		return
	}
	cur := Observed{State: GroupActive, SubjectSource: SubjectFromFallback}
	if stored := m.groups.FindOne(ctx, m.orgID, s.id, evt.JID.String()); stored != nil {
		cur = stored.Observed
	}
	next, changes, err := applyGroupDelta(cur, *evt, s.deviceJID())
	if err != nil {
		logf("instance %s: %v", s.id, err)
		return
	}
	if len(changes) == 0 {
		return
	}
	if err := m.groups.UpsertObserved(ctx, m.orgID, s.id, evt.JID.String(), next, false); err != nil {
		logf("instance %s: apply group delta for %s: %v", s.id, evt.JID, err)
	}
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

// onReceipt records delivery/read receipts as the §10 live counter. A receipt
// is not a message, so it bumps its own counter instead of inflating
// `messagesIn`; the BFF's rollup reconciles the day.
func (m *manager) onReceipt(ctx context.Context, s *session, evt *events.Receipt) {
	if m.stats == nil {
		return
	}
	groupJID := ""
	if evt.Chat.Server == types.GroupServer {
		groupJID = evt.Chat.String()
	}
	at := evt.Timestamp
	if at.IsZero() {
		at = now().UTC()
	}
	if err := m.stats.bumpReceipt(ctx, m.orgID, s.id, groupJID, at); err != nil {
		logf("instance %s: record receipt: %v", s.id, err)
	}
}

// ensureGroupKnown records that a group carried traffic before any sync saw it,
// so a missed sync can never hide a group (R1, §6.2). The ingest-owned counters
// are incremented, never read-modify-written, so this commutes with the BFF's
// `config.*` writes (§5.2).
func (m *manager) ensureGroupKnown(ctx context.Context, instanceID, groupJID string, at time.Time) {
	if m.groups == nil {
		return
	}
	if err := m.groups.Touch(ctx, m.orgID, instanceID, groupJID, at); err != nil {
		logf("instance %s: ensure group %s known: %v", instanceID, groupJID, err)
	}
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
