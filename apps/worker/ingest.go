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
		if err := store.Save(flushCtx, batch); err != nil {
			// Retrying forever would grow the batch without bound, so the batch
			// is dropped and counted — the same visible degradation as an
			// overflow, and the unique index makes any later replay a no-op.
			logf("ingest flush failed, dropping %d messages: %v", len(batch), err)
			q.dropped.Add(int64(len(batch)))
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

// Save upserts a batch of parsed messages. The upsert filter is the unique
// index key, so re-delivered events collapse onto the document they already
// created (§6.2).
func (s *messageStore) Save(ctx context.Context, docs []MessageDoc) error {
	if len(docs) == 0 {
		// The driver rejects an empty bulk write, and an empty flush is normal.
		return nil
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
	if _, err := s.coll.BulkWrite(ctx, writes, options.BulkWrite().SetOrdered(false)); err != nil {
		return fmt.Errorf("save messages: %w", err)
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
