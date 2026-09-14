package main

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

func TestEnqueueIngestIsBoundedAndCountsDrops(t *testing.T) {
	q := newIngestQueue(2, 0, 0)
	for i := range 5 {
		q.Enqueue(MessageDoc{WaMessageID: string(rune('a' + i))})
	}
	if got := q.Dropped(); got != 3 {
		t.Errorf("Dropped() = %d, want 3 (bounded queue must count, not grow)", got)
	}
}

func TestFlushIngestUpsertsIdempotently(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensureIngestIndexes: %v", err)
	}
	store := newMessageStore(db)
	doc := MessageDoc{
		OrganizationID: "org_default", InstanceID: "inst_1",
		GroupJID: "120363043123456789@g.us", WaMessageID: "3EB0A1",
		Kind: KindText, Text: "hello", TextSearch: "hello", Media: Media{Status: MediaNone},
	}
	// A previous run may have left the message behind; the guarantee, not the
	// starting state, is what the test asserts.
	_, _ = db.Collection(collMessages).DeleteMany(ctx, map[string]any{"waMessageId": "3EB0A1"})
	if _, err := store.Save(ctx, []MessageDoc{doc, doc}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	count, err := db.Collection(collMessages).CountDocuments(ctx, map[string]any{"waMessageId": "3EB0A1"})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("message count = %d, want 1 (the unique index must collapse redelivery)", count)
	}
}

// TestIngestQueueFlushesWhatItHoldsOnShutdown pins the shutdown path: a batch that
// never reached the flush size must still be written when the worker stops, not
// discarded with the process.
func TestIngestQueueFlushesWhatItHoldsOnShutdown(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensureIngestIndexes: %v", err)
	}
	key := map[string]any{"organizationId": "org_default", "instanceId": "inst_queue", "waMessageId": "3EB0QUEUE"}
	_, _ = db.Collection(collMessages).DeleteMany(ctx, key)
	defer func() { _, _ = db.Collection(collMessages).DeleteMany(ctx, key) }()

	// A batch cap the single message never reaches and a ticker that never
	// fires: only the final flush can persist it.
	q := newIngestQueue(4, time.Hour, 100)
	runCtx, shutdown := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		q.Run(runCtx, newMessageStore(db))
	}()

	q.Enqueue(MessageDoc{
		OrganizationID: "org_default", InstanceID: "inst_queue", WaMessageID: "3EB0QUEUE",
		Kind: KindText, Text: "queued before shutdown", Media: Media{Status: MediaNone},
	})
	shutdown()
	<-done

	count, err := db.Collection(collMessages).CountDocuments(ctx, key)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("count = %d, want the queued message flushed on shutdown", count)
	}
	if dropped := q.Dropped(); dropped != 0 {
		t.Errorf("Dropped() = %d, want 0: a shutdown flush is not a drop", dropped)
	}
}

// TestIngestQueueDoesNotStrandMessagesAcrossShutdown races producers against the
// consumer's termination: every message a producer hands over must end up either
// persisted or counted as dropped. A queue that keeps accepting into its buffer
// after its consumer stopped would silently strand those documents.
func TestIngestQueueDoesNotStrandMessagesAcrossShutdown(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensureIngestIndexes: %v", err)
	}
	const (
		instanceID  = "inst_race"
		perProducer = 2000
		producers   = 4
	)
	_, _ = db.Collection(collMessages).DeleteMany(ctx, map[string]any{"instanceId": instanceID})
	defer func() { _, _ = db.Collection(collMessages).DeleteMany(ctx, map[string]any{"instanceId": instanceID}) }()

	// A flush interval and batch cap the producers never reach, so the only
	// writes are the ones the shutdown flush performs.
	q := newIngestQueue(64, time.Hour, 1<<20)
	runCtx, shutdown := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		q.Run(runCtx, newMessageStore(db))
	}()

	var attempted atomic.Int64
	stopProducers := make(chan struct{})
	var running sync.WaitGroup
	for range producers {
		running.Add(1)
		go func() {
			defer running.Done()
			for range perProducer {
				select {
				case <-stopProducers:
					return
				default:
				}
				n := attempted.Add(1)
				q.Enqueue(MessageDoc{
					OrganizationID: "org_default", InstanceID: instanceID,
					WaMessageID: fmt.Sprintf("3EB0RACE%06d", n),
					Kind:        KindText, Text: "racing the shutdown", Media: Media{Status: MediaNone},
				})
				// Space the handovers out so the producers are still working when
				// the consumer dies, which is the window under test.
				time.Sleep(50 * time.Microsecond)
			}
		}()
	}

	// Let a slice of the traffic land, then pull the consumer out from under the
	// producers.
	time.Sleep(5 * time.Millisecond)
	shutdown()
	<-done
	close(stopProducers)
	running.Wait()

	// The consumer is gone for good now: one more handover must be counted, never
	// buffered where nothing will ever read it.
	q.Enqueue(MessageDoc{
		OrganizationID: "org_default", InstanceID: instanceID,
		WaMessageID: "3EB0RACE999999", Kind: KindText, Text: "after termination", Media: Media{Status: MediaNone},
	})
	attempted.Add(1)

	count, err := db.Collection(collMessages).CountDocuments(ctx, map[string]any{"instanceId": instanceID})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if persisted, dropped, want := int64(count), q.Dropped(), attempted.Load(); persisted+dropped != want {
		t.Errorf("persisted(%d) + dropped(%d) = %d, want %d: %d messages were stranded",
			persisted, dropped, persisted+dropped, want, want-persisted-dropped)
	}
	if count == 0 || q.Dropped() == 0 {
		t.Errorf("persisted=%d dropped=%d, want both non-zero: the race was not exercised", count, q.Dropped())
	}
}

type storedMessage struct {
	OrganizationID string    `bson:"organizationId"`
	InstanceID     string    `bson:"instanceId"`
	GroupJID       string    `bson:"groupJid"`
	ChatJID        string    `bson:"chatJid"`
	IsGroup        bool      `bson:"isGroup"`
	WaMessageID    string    `bson:"waMessageId"`
	SenderJID      string    `bson:"senderJid"`
	PushName       string    `bson:"pushName"`
	FromMe         bool      `bson:"fromMe"`
	Timestamp      time.Time `bson:"timestamp"`
	ReceivedAt     time.Time `bson:"receivedAt"`
	ServerSkewMs   int64     `bson:"serverSkewMs"`
	Kind           string    `bson:"kind"`
	Text           string    `bson:"text"`
	TextSearch     string    `bson:"textSearch"`
	RawSearch      string    `bson:"rawSearch"`
	Links          []string  `bson:"links"`
	Mentions       []string  `bson:"mentions"`

	Media struct {
		Status       string `bson:"status"`
		Kind         string `bson:"kind"`
		DeclaredType string `bson:"declaredType"`
		Mime         string `bson:"mime"`
		R2Key        string `bson:"r2Key"`
		Attempts     int    `bson:"attempts"`
	} `bson:"media"`
	Raw struct {
		Bytes     int            `bson:"bytes"`
		Truncated bool           `bson:"truncated"`
		Message   map[string]any `bson:"message"`
	} `bson:"raw"`
	Parse struct {
		State   string   `bson:"state"`
		Errors  []string `bson:"errors"`
		Version int      `bson:"version"`
	} `bson:"parse"`
}

// TestSaveMessageEnvelopeRoundTrip proves the document the worker persists is
// the one §5.1 describes — nested media/raw/parse subdocuments with camelCase
// keys, arrays rather than nulls — and that a redelivery enriches the mutable
// fields while leaving the identity and first-observation timestamp alone.
func TestSaveMessageEnvelopeRoundTrip(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensureIngestIndexes: %v", err)
	}
	coll := db.Collection(collMessages)
	key := map[string]any{"organizationId": "org_default", "instanceId": "inst_envelope", "waMessageId": "3EB0ENVELOPE"}
	_, _ = coll.DeleteMany(ctx, key)
	defer func() { _, _ = coll.DeleteMany(ctx, key) }()

	mention := "628990000002@s.whatsapp.net"
	evt := evtMessage(
		types.NewJID("120363043123456789", types.GroupServer),
		types.NewJID("628990000001", types.DefaultUserServer),
		"3EB0ENVELOPE",
		&waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text:        proto.String("Deploy is green, see https://status.test/deploy"),
			ContextInfo: &waE2E.ContextInfo{MentionedJID: []string{mention}},
		}},
	)
	evt.Info.IsFromMe = true
	doc, err := parseInbound(evt, "org_default", "inst_envelope")
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	store := newMessageStore(db)
	if _, err := store.Save(ctx, []MessageDoc{doc}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	var got storedMessage
	if err := coll.FindOne(ctx, key).Decode(&got); err != nil {
		t.Fatalf("decode stored message: %v", err)
	}
	if got.OrganizationID != "org_default" || got.InstanceID != "inst_envelope" || got.WaMessageID != "3EB0ENVELOPE" {
		t.Errorf("identity = %+v", got)
	}
	if got.GroupJID != "120363043123456789@g.us" || got.ChatJID != "120363043123456789@g.us" || !got.IsGroup {
		t.Errorf("group jids = %q/%q isGroup=%v", got.GroupJID, got.ChatJID, got.IsGroup)
	}
	if got.SenderJID != "628990000001@s.whatsapp.net" || !got.FromMe || got.PushName != "Nadia" {
		t.Errorf("sender = %q fromMe=%v pushName=%q", got.SenderJID, got.FromMe, got.PushName)
	}
	if !got.Timestamp.Equal(evt.Info.Timestamp.UTC()) || got.ReceivedAt.IsZero() || got.ServerSkewMs == 0 {
		t.Errorf("timestamps: %v / %v skew=%d", got.Timestamp, got.ReceivedAt, got.ServerSkewMs)
	}
	if got.Kind != string(KindText) || got.Text != "Deploy is green, see https://status.test/deploy" {
		t.Errorf("kind=%q text=%q", got.Kind, got.Text)
	}
	if got.TextSearch != "deploy is green see https status test deploy" {
		t.Errorf("textSearch = %q", got.TextSearch)
	}
	if !strings.Contains(got.RawSearch, "Deploy is green") || got.Raw.Truncated || got.Raw.Bytes == 0 {
		t.Errorf("raw = %+v rawSearch=%q", got.Raw, got.RawSearch)
	}
	if len(got.Raw.Message) == 0 {
		t.Error("raw.message is empty: the protobuf tree was not persisted")
	}
	if got.Links == nil || len(got.Links) != 1 || got.Links[0] != "https://status.test/deploy" {
		t.Errorf("links = %v, want one-element array (never null)", got.Links)
	}
	if got.Mentions == nil || len(got.Mentions) != 1 || got.Mentions[0] != mention {
		t.Errorf("mentions = %v, want one-element array (never null)", got.Mentions)
	}
	if got.Media.Status != string(MediaNone) || got.Media.Kind != "" || got.Media.DeclaredType != "" {
		t.Errorf("media = %+v, want none with no declared type for a text message", got.Media)
	}
	if got.Parse.State != string(ParseOK) || got.Parse.Errors == nil || got.Parse.Version != messageSchemaVersion {
		t.Errorf("parse = %+v, want ok/empty-array/version %d", got.Parse, messageSchemaVersion)
	}

	// The media pipeline writes media.* after the document exists (§6.2). A
	// redelivery must not undo that work, which is the whole point of the unique
	// index being a redelivery guard rather than a duplicate guard.
	if _, err := coll.UpdateOne(ctx, key, bson.D{{Key: "$set", Value: bson.D{
		{Key: "media.status", Value: string(MediaStored)},
		{Key: "media.mime", Value: "image/png"},
		{Key: "media.r2Key", Value: "org/org_default/instance/inst_envelope/3EB0ENVELOPE.png"},
		{Key: "media.attempts", Value: 1},
	}}}); err != nil {
		t.Fatalf("simulate media pipeline write: %v", err)
	}

	// A redelivery of the same message must not rewrite what the message is, but
	// a better parse of it (a name learned later) is worth storing. The
	// redelivery is parsed again, so its observation time is strictly later —
	// which is exactly what `$setOnInsert` has to refuse.
	redelivered := evtMessage(
		types.NewJID("120363043123456789", types.GroupServer),
		types.NewJID("628990000001", types.DefaultUserServer),
		"3EB0ENVELOPE",
		&waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text: proto.String("Deploy is green"),
		}},
	)
	redelivered.Info.PushName = "Nadia (work)"
	redelivered.Info.IsFromMe = true
	second, err := parseInbound(redelivered, "org_default", "inst_envelope")
	if err != nil {
		t.Fatalf("parseInbound(redelivery): %v", err)
	}
	if !second.ReceivedAt.After(doc.ReceivedAt) {
		t.Fatal("the redelivery was not observed later; the test would not detect a rewritten receivedAt")
	}
	if _, err := store.Save(ctx, []MessageDoc{second}); err != nil {
		t.Fatalf("Save(redelivery): %v", err)
	}
	var again storedMessage
	if err := coll.FindOne(ctx, key).Decode(&again); err != nil {
		t.Fatalf("decode redelivered message: %v", err)
	}
	count, err := coll.CountDocuments(ctx, key)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("count = %d, want the redelivery to collapse onto one document", count)
	}
	if again.Text != "Deploy is green" || again.PushName != "Nadia (work)" {
		t.Errorf("redelivery did not update the mutable fields: text=%q pushName=%q", again.Text, again.PushName)
	}
	if !again.ReceivedAt.Equal(got.ReceivedAt) || !again.Timestamp.Equal(got.Timestamp) {
		t.Errorf("redelivery rewrote the identity timestamps: %v/%v", again.ReceivedAt, again.Timestamp)
	}
	if again.Media.Status != string(MediaStored) || again.Media.Mime != "image/png" ||
		again.Media.R2Key != "org/org_default/instance/inst_envelope/3EB0ENVELOPE.png" || again.Media.Attempts != 1 {
		t.Errorf("redelivery clobbered the media pipeline's subdocument: %+v", again.Media)
	}
}

// TestPendingMediaScanAndAttemptCounting pins the janitor's scan contract
// (§6.3.5): only retryable attachments are returned, a message that never got a
// first attempt still qualifies, and each saved attempt advances the budget.
func TestPendingMediaScanAndAttemptCounting(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensureIngestIndexes: %v", err)
	}
	store := newMessageStore(db)
	coll := db.Collection(collMessages)
	const org = "org_media_scan"
	if _, err := coll.DeleteMany(ctx, map[string]any{"organizationId": org}); err != nil {
		t.Fatalf("clean: %v", err)
	}

	seed := func(id string, media Media, truncated bool, attempts int) {
		t.Helper()
		doc := MessageDoc{
			OrganizationID: org, InstanceID: "inst_1", GroupJID: "120363043123456789@g.us",
			WaMessageID: id, Kind: KindImage, Media: media,
			Raw: RawMessage{Message: map[string]any{"imageMessage": map[string]any{}}, Truncated: truncated},
		}
		if _, err := store.Save(ctx, []MessageDoc{doc}); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
		if attempts > 0 {
			if _, err := coll.UpdateOne(ctx, map[string]any{"waMessageId": id}, bson.D{{Key: "$set", Value: bson.D{{Key: "media.attempts", Value: attempts}}}}); err != nil {
				t.Fatalf("seed attempts %s: %v", id, err)
			}
		}
	}

	seed("3EB0PEND", Media{Status: MediaPending, Kind: KindImage}, false, 0)   // candidate despite no attempts field
	seed("3EB0TRUNC", Media{Status: MediaPending, Kind: KindImage}, true, 0)   // pruned: not retryable
	seed("3EB0STORED", Media{Status: MediaStored, Kind: KindImage}, false, 1)  // terminal
	seed("3EB0EXHAUST", Media{Status: MediaFailed, Kind: KindImage}, false, 3) // budget spent

	ids := func() map[string]bool {
		candidates, err := store.pendingMedia(ctx, org, 3)
		if err != nil {
			t.Fatalf("pendingMedia: %v", err)
		}
		out := map[string]bool{}
		for _, c := range candidates {
			out[c.WaMessageID] = true
		}
		return out
	}

	got := ids()
	if len(got) != 1 || !got["3EB0PEND"] {
		t.Fatalf("candidates = %v, want exactly the pending, unpruned, unexhausted message", got)
	}

	// One saved attempt must not exhaust the budget, and must be cumulative.
	for i := 1; i <= 3; i++ {
		if err := store.saveMedia(ctx, MessageDoc{OrganizationID: org, InstanceID: "inst_1", WaMessageID: "3EB0PEND"}, Media{Status: MediaFailed, Kind: KindImage}); err != nil {
			t.Fatalf("saveMedia #%d: %v", i, err)
		}
		var doc struct {
			Media struct {
				Attempts int `bson:"attempts"`
			} `bson:"media"`
		}
		if err := coll.FindOne(ctx, map[string]any{"organizationId": org, "waMessageId": "3EB0PEND"}).Decode(&doc); err != nil {
			t.Fatalf("decode #%d: %v", i, err)
		}
		if doc.Media.Attempts != i {
			t.Fatalf("attempts after %d save(s) = %d", i, doc.Media.Attempts)
		}
	}
	if got := ids(); len(got) != 0 {
		t.Fatalf("candidates after the budget was spent = %v, want none", got)
	}
}

// Messages the store already holds are not new messages: WhatsApp redelivers
// after a reconnect, and counting redelivery would inflate every figure the
// console reports. The store is the only component that knows which writes were
// actually new, so it is the component that reports them.
func TestSaveReportsOnlyTheMessagesItStored(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := ensureIngestIndexes(ctx, db); err != nil {
		t.Fatalf("ensureIngestIndexes: %v", err)
	}
	store := newMessageStore(db)
	first := MessageDoc{
		OrganizationID: "org_default", InstanceID: "inst_1", GroupJID: "120363043123456789@g.us",
		WaMessageID: "3EB0A1", Kind: KindText, Text: "hello", TextSearch: "hello", Media: Media{Status: MediaNone},
	}
	second := first
	second.WaMessageID = "3EB0A2"
	_, _ = db.Collection(collMessages).DeleteMany(ctx, map[string]any{"waMessageId": bson.M{"$in": []string{"3EB0A1", "3EB0A2"}}})

	stored, err := store.Save(ctx, []MessageDoc{first, second})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if len(stored) != 2 {
		t.Fatalf("stored = %d, want both new messages reported", len(stored))
	}

	again, err := store.Save(ctx, []MessageDoc{first, second})
	if err != nil {
		t.Fatalf("Save again: %v", err)
	}
	if len(again) != 0 {
		t.Fatalf("stored = %d, want nothing reported for a redelivery", len(again))
	}
}
