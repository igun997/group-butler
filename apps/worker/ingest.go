package main

import (
	"context"
	"fmt"
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
	ch         chan MessageDoc
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

// Enqueue accepts one parsed message without blocking. Overflow is counted
// rather than buffered: unbounded growth would exhaust the worker's memory, and
// a counted drop is a visible degradation the dashboard can show (§6.2).
func (q *ingestQueue) Enqueue(doc MessageDoc) {
	select {
	case q.ch <- doc:
	default:
		q.dropped.Add(1)
	}
}

// Dropped reports how many messages never reached MongoDB: those dropped by a
// full queue plus those lost in a flush that failed.
func (q *ingestQueue) Dropped() int64 {
	return q.dropped.Load()
}

// Run drains the queue into the store until ctx is cancelled and then flushes
// what it still holds, so a graceful shutdown does not discard accepted
// messages. It is meant to run in its own goroutine for the process lifetime.
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
			for {
				select {
				case doc := <-q.ch:
					batch = append(batch, doc)
				default:
					flush()
					return
				}
			}
		}
	}
}

// messageStore writes the `messages` collection. Ingestion is a bulk upsert, so
// a redelivered event costs one no-op write instead of a duplicate row.
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
		{Key: "timestamp", Value: doc.Timestamp},
		{Key: "receivedAt", Value: doc.ReceivedAt},
	}
}

// messageFields are the values a re-parse may improve, in the MongoDB spelling
// of §5.1. The media and parse subdocuments are flattened into dotted keys so
// the media pipeline and a later re-parse can update a single field without
// replacing the others. `media.status` here is what the parser saw (none or
// pending); the media pipeline owns every later transition.
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
		{Key: "media.status", Value: doc.Media.Status},
		{Key: "media.kind", Value: doc.Media.Kind},
		{Key: "media.declaredType", Value: doc.Media.DeclaredType},
		{Key: "media.mime", Value: doc.Media.Mime},
		{Key: "media.fileName", Value: doc.Media.FileName},
		{Key: "media.size", Value: doc.Media.Size},
		{Key: "media.sha256", Value: doc.Media.SHA256},
		{Key: "media.width", Value: doc.Media.Width},
		{Key: "media.height", Value: doc.Media.Height},
		{Key: "media.durationSec", Value: doc.Media.DurationSec},
		{Key: "media.r2Key", Value: doc.Media.R2Key},
		{Key: "media.publicUrl", Value: doc.Media.PublicURL},
		{Key: "media.reason", Value: doc.Media.Reason},
		{Key: "media.error", Value: doc.Media.Error},
		{Key: "media.attempts", Value: doc.Media.Attempts},
		{Key: "raw.message", Value: doc.Raw.Message},
		{Key: "raw.truncated", Value: doc.Raw.Truncated},
		{Key: "raw.bytes", Value: doc.Raw.Bytes},
		{Key: "parse.state", Value: doc.ParseState},
		{Key: "parse.errors", Value: doc.ParseErrors},
		{Key: "parse.version", Value: doc.SchemaVersion},
	}
}
