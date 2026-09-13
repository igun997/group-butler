package main

import (
	"context"
	"strings"
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
	if err := store.Save(ctx, []MessageDoc{doc, doc}); err != nil {
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

// TestIngestQueueFlushesWhatItHoldsOnShutdown pins the only moment the queue can
// lose an accepted message: a batch that never reached the flush size must still
// be written when the worker shuts down, not discarded with the process.
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
	if err := store.Save(ctx, []MessageDoc{doc}); err != nil {
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
	if err := store.Save(ctx, []MessageDoc{second}); err != nil {
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
