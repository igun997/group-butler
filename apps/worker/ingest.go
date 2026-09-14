package main

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// ingestFlushTimeout bounds one bulk write. The final flush runs while the
// process is shutting down, so it cannot inherit a context that is already
// cancelled — it gets its own deadline instead.
const ingestFlushTimeout = 10 * time.Second

// ingestQueue decouples the WhatsApp event handler from MongoDB: a message is
// accepted into memory and written in batches, so a slow or unreachable
// database can never stall the event loop (§6.2).
type ingestQueue struct {
	mu         sync.Mutex
	ch         chan MessageDoc
	stopped    bool
	dropped    atomic.Int64
	flushEvery time.Duration
	flushMax   int
	afterSave  func([]MessageDoc)
	// onStored receives the documents a flush created, which is what the counters
	// count: a redelivery updates a document rather than creating one.
	onStored func(context.Context, []MessageDoc)
}

// newIngestQueue builds a queue of the configured size. A non-positive size
// would make every enqueue drop, which is a data-loss misconfiguration rather
// than a behaviour, so it is clamped to one.
func newIngestQueue(size int, flushEvery time.Duration, flushMax int) *ingestQueue {
	if size < 1 {
		size = 1
	}
	return &ingestQueue{
		ch:         make(chan MessageDoc, size),
		flushEvery: flushEvery,
		flushMax:   flushMax,
	}
}

func (q *ingestQueue) setAfterSave(fn func([]MessageDoc)) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.afterSave = fn
}

// setOnStored registers the sink for the messages a flush actually created. It is
// separate from `afterSave` because the two want different things: the reply
// path wants the batch that was observed, while the counters want only what was
// new, and a redelivery is neither a message nor a reason to answer again.
func (q *ingestQueue) setOnStored(fn func(context.Context, []MessageDoc)) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.onStored = fn
}

// Enqueue accepts one parsed message without blocking on the buffer. Overflow is
// counted rather than buffered: unbounded growth would exhaust the worker's
// memory, and a counted drop is a visible degradation the dashboard can show
// (§6.2). A handover after the consumer terminated is counted the same way — the
// alternative is a document nothing will ever read.
func (q *ingestQueue) Enqueue(doc MessageDoc) {
	q.mu.Lock()
	if q.stopped {
		q.mu.Unlock()
		q.dropped.Add(1)
		return
	}
	select {
	case q.ch <- doc:
		q.mu.Unlock()
	default:
		q.mu.Unlock()
		q.dropped.Add(1)
	}
}

// stop closes the queue to producers and returns everything still buffered.
// Holding the lock across the flip and the send is what makes the handover
// race-free: a producer either completed its send before this ran — so the
// document is in the returned batch — or it observes `stopped` and counts the
// document as dropped.
func (q *ingestQueue) stop() []MessageDoc {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.stopped = true
	var buffered []MessageDoc
	for {
		select {
		case doc := <-q.ch:
			buffered = append(buffered, doc)
		default:
			return buffered
		}
	}
}

// Dropped reports how many messages never reached MongoDB: those dropped by a
// full queue, those handed over after the consumer stopped, and those lost in a
// flush that failed.
func (q *ingestQueue) Dropped() int64 {
	return q.dropped.Load()
}

// Depth is the number of messages buffered but not yet written, Capacity its
// bound, and Stopped whether the consumer has closed to producers. They are the
// `/health` queue report (§6.5).
func (q *ingestQueue) Depth() int    { return len(q.ch) }
func (q *ingestQueue) Capacity() int { return cap(q.ch) }

func (q *ingestQueue) Stopped() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.stopped
}

// Run drains the queue into the store until ctx is cancelled, then closes the
// queue and flushes what it holds. From the moment ctx is done, every accepted
// message is either written or counted as dropped — none is left in a buffer
// with no reader. It is meant to run in its own goroutine for the process
// lifetime.
func (q *ingestQueue) Run(ctx context.Context, store *messageStore) {
	var batch []MessageDoc
	var ticks <-chan time.Time
	if q.flushEvery > 0 {
		ticker := time.NewTicker(q.flushEvery)
		defer ticker.Stop()
		ticks = ticker.C
	}
	flush := func() {
		if len(batch) == 0 {
			return
		}
		// The batch is handed to the store under its own deadline: on the
		// shutdown path ctx is already cancelled and the write must still land.
		flushCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ingestFlushTimeout)
		defer cancel()
		stored, err := store.Save(flushCtx, batch)
		if err != nil {
			// Retrying forever would grow the batch without bound, so the batch
			// is dropped and counted — the same visible degradation as an
			// overflow, and the unique index makes any later replay a no-op.
			logf("ingest flush failed, dropping %d messages: %v", len(batch), err)
			q.dropped.Add(int64(len(batch)))
		} else {
			// Only what the store created is new; a redelivery is not a message.
			// The counters get their own deadline, for the same reason the flush
			// does: on the shutdown path ctx is already cancelled and the count
			// must still land.
			if q.onStored != nil && len(stored) > 0 {
				counterCtx, cancelCounters := context.WithTimeout(context.WithoutCancel(ctx), ingestFlushTimeout)
				q.onStored(counterCtx, stored)
				cancelCounters()
			}
			if q.afterSave != nil {
				q.afterSave(batch)
			}
		}
		batch = nil
	}

	for {
		select {
		case doc := <-q.ch:
			batch = append(batch, doc)
			if q.flushMax > 0 && len(batch) >= q.flushMax {
				flush()
			}
		case <-ticks:
			flush()
		case <-ctx.Done():
			// Close the queue before the final flush: from here on a producer's
			// handover is counted as dropped instead of landing in a buffer that
			// nothing will drain.
			batch = append(batch, q.stop()...)
			flush()
			return
		}
	}
}

// messageStore writes the `messages` collection. Ingestion is a bulk upsert, so a
// redelivered event costs one idempotent update instead of a duplicate row.
type messageStore struct {
	coll *mongo.Collection
}

func newMessageStore(db *mongo.Database) *messageStore {
	return &messageStore{coll: db.Collection(collMessages)}
}

// Save upserts a batch of parsed messages and returns the ones that were actually
// new. The upsert filter is the unique index key, so re-delivered events collapse
// onto the document they already created (§6.2) — and only this call site knows
// which writes created a document rather than updating one, which is why the
// counters are fed from here rather than from the batch that went in.
func (s *messageStore) Save(ctx context.Context, docs []MessageDoc) ([]MessageDoc, error) {
	if len(docs) == 0 {
		// The driver rejects an empty bulk write, and an empty flush is normal.
		return nil, nil
	}
	writes := make([]mongo.WriteModel, 0, len(docs))
	for _, doc := range docs {
		filter := bson.D{
			{Key: "organizationId", Value: doc.OrganizationID},
			{Key: "instanceId", Value: doc.InstanceID},
			{Key: "waMessageId", Value: doc.WaMessageID},
		}
		update := bson.D{
			{Key: "$set", Value: messageFields(doc)},
			{Key: "$setOnInsert", Value: identityFields(doc)},
		}
		writes = append(writes, mongo.NewUpdateOneModel().
			SetFilter(filter).
			SetUpdate(update).
			SetUpsert(true))
	}
	// Unordered: one rejected document must not stop the rest of the batch, and
	// the unique index makes a retry of the whole batch safe.
	result, err := s.coll.BulkWrite(ctx, writes, options.BulkWrite().SetOrdered(false))
	if err != nil {
		return nil, fmt.Errorf("save messages: %w", err)
	}
	stored := make([]MessageDoc, 0, len(result.UpsertedIDs))
	for index := range result.UpsertedIDs {
		stored = append(stored, docs[index])
	}
	return stored, nil
}

// mediaCandidate is one attachment the janitor may retry (§6.3.5): the identity
// triple it is stored under plus the raw protobuf tree the download node is
// rebuilt from.
type mediaCandidate struct {
	OrganizationID string
	InstanceID     string
	WaMessageID    string
	GroupJID       string
	Raw            map[string]any
}

// mediaCandidateDoc is the projection `pendingMedia` reads. MessageDoc has no
// bson tags (ingest.go maps fields explicitly), so the scan uses its own shape.
type mediaCandidateDoc struct {
	OrganizationID string `bson:"organizationId"`
	InstanceID     string `bson:"instanceId"`
	WaMessageID    string `bson:"waMessageId"`
	GroupJID       string `bson:"groupJid"`
	Raw            struct {
		Message map[string]any `bson:"message"`
	} `bson:"raw"`
}

// pendingMedia returns the attachments a retry could still improve: a pending
// or failed status, fewer attempts than MEDIA_MAX_ATTEMPTS, and a raw tree that
// was not pruned (a pruned tree cannot be rebuilt into a downloadable node, so
// it is terminal for the janitor).
func (s *messageStore) pendingMedia(ctx context.Context, orgID string, maxAttempts int) ([]mediaCandidate, error) {
	cursor, err := s.coll.Find(ctx, bson.D{
		{Key: "organizationId", Value: orgID},
		{Key: "media.status", Value: bson.D{{Key: "$in", Value: []MediaStatus{MediaPending, MediaFailed}}}},
		// `$not: {$gte: max}` matches both a lower value and a missing
		// `media.attempts` — a message enqueued while media storage was
		// disabled never got a first attempt at all.
		{Key: "media.attempts", Value: bson.D{{Key: "$not", Value: bson.D{{Key: "$gte", Value: maxAttempts}}}}},
		{Key: "raw.truncated", Value: bson.D{{Key: "$ne", Value: true}}},
	})
	if err != nil {
		return nil, fmt.Errorf("scan pending media: %w", err)
	}
	defer func() { _ = cursor.Close(ctx) }()
	candidates := make([]mediaCandidate, 0)
	for cursor.Next(ctx) {
		var doc mediaCandidateDoc
		if err := cursor.Decode(&doc); err != nil {
			return nil, fmt.Errorf("decode pending media: %w", err)
		}
		candidates = append(candidates, mediaCandidate{
			OrganizationID: doc.OrganizationID,
			InstanceID:     doc.InstanceID,
			WaMessageID:    doc.WaMessageID,
			GroupJID:       doc.GroupJID,
			Raw:            doc.Raw.Message,
		})
	}
	if err := cursor.Err(); err != nil {
		return nil, fmt.Errorf("scan pending media: %w", err)
	}
	return candidates, nil
}

// saveMedia records one media attempt on the message it belongs to. `attempts`
// is incremented rather than set, so the janitor's retry budget is cumulative
// across the live path and every later tick (§6.3.5).
func (s *messageStore) saveMedia(ctx context.Context, doc MessageDoc, media Media) error {
	filter := bson.D{
		{Key: "organizationId", Value: doc.OrganizationID},
		{Key: "instanceId", Value: doc.InstanceID},
		{Key: "waMessageId", Value: doc.WaMessageID},
	}
	update := bson.D{
		{Key: "$set", Value: mediaFields(media)},
		{Key: "$inc", Value: bson.D{{Key: "media.attempts", Value: 1}}},
	}
	if _, err := s.coll.UpdateOne(ctx, filter, update); err != nil {
		return fmt.Errorf("save media: %w", err)
	}
	return nil
}

// identityFields are written only when the document is created: they describe
// the message as it first arrived. A redelivery of the same message must not
// rewrite them, and `receivedAt` is the observation that stays first (§6.2).
//
// The parse-time media descriptor belongs here for the same reason: once the
// document exists, `media.*` is the media pipeline's subdocument (§5.2). Were it
// part of the update, the next redelivery — the very case the unique index
// exists for — would write the parser's empty mime/r2Key/sha256 back over what
// the pipeline stored, and reset `stored` to `pending`.
func identityFields(doc MessageDoc) bson.D {
	return bson.D{
		{Key: "organizationId", Value: doc.OrganizationID},
		{Key: "instanceId", Value: doc.InstanceID},
		{Key: "waMessageId", Value: doc.WaMessageID},
		{Key: "groupJid", Value: doc.GroupJID},
		{Key: "chatJid", Value: doc.ChatJID},
		{Key: "isGroup", Value: doc.IsGroup},
		{Key: "senderJid", Value: doc.SenderJID},
		{Key: "fromMe", Value: doc.FromMe},
		{Key: "flags.historical", Value: doc.Historical},
		{Key: "timestamp", Value: doc.Timestamp},
		{Key: "receivedAt", Value: doc.ReceivedAt},
		{Key: "media.status", Value: doc.Media.Status},
		{Key: "media.kind", Value: doc.Media.Kind},
		{Key: "media.declaredType", Value: doc.Media.DeclaredType},
	}
}

// messageFields are the values a re-parse may improve, in the MongoDB spelling
// of §5.1. The parse subdocument is flattened into dotted keys so a later
// re-parse can update one field without replacing the others.
func messageFields(doc MessageDoc) bson.D {
	return bson.D{
		{Key: "senderLid", Value: doc.SenderLID},
		{Key: "pushName", Value: doc.PushName},
		{Key: "serverSkewMs", Value: doc.ServerSkewMs},
		{Key: "kind", Value: doc.Kind},
		{Key: "text", Value: doc.Text},
		{Key: "textSearch", Value: doc.TextSearch},
		{Key: "rawSearch", Value: doc.RawSearch},
		{Key: "links", Value: doc.Links},
		{Key: "mentions", Value: doc.Mentions},
		{Key: "raw.message", Value: doc.Raw.Message},
		{Key: "raw.truncated", Value: doc.Raw.Truncated},
		{Key: "raw.bytes", Value: doc.Raw.Bytes},
		{Key: "parse.state", Value: doc.ParseState},
		{Key: "parse.errors", Value: doc.ParseErrors},
		{Key: "parse.version", Value: doc.SchemaVersion},
	}
}
