package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// externalReceivedAt is the moment every mapping table row is "observed at": fixed,
// so the derived fields (receivedAt, the skew, and the object key) are comparable.
var externalReceivedAt = time.Date(2026, 9, 19, 10, 0, 0, 0, time.UTC)

const (
	externalGroup   = "120363043123456789@g.us"
	externalSender  = "628990000001@s.whatsapp.net"
	externalSeconds = 1757750000 // 2025-09-13T06:33:20Z
)

// externalWant is one row's expectations. It is a struct rather than a handful of
// inline assertions because the mapping is mostly "these fields, in this shape", and
// a table is what makes a missing one visible.
type externalWant struct {
	kind        Kind
	text        string
	textSearch  string
	groupJID    string
	chatJID     string
	isGroup     bool
	sender      string
	pushName    string
	fromMe      bool
	links       []string
	mentions    []string
	state       ParseState
	mediaStatus MediaStatus
	mediaKind   Kind
	declared    Kind
	fileName    string
}

// TestExternalDocMapsTheBridgeEvent is the mapping contract: one event in, the row
// the whatsmeow parser would have written for the same message out.
func TestExternalDocMapsTheBridgeEvent(t *testing.T) {
	cases := []struct {
		name  string
		event externalEvent
		want  externalWant
	}{
		{
			name: "plain text in a group",
			event: externalEvent{
				MessageID: "3EB0EXT1", ChatID: externalGroup, SenderID: externalSender,
				SenderName: "Alice", ChatName: "120363043123456789", IsGroup: true,
				Body: "deploy is green — see https://example.test/run/7", Timestamp: externalSeconds,
			},
			want: externalWant{
				kind: KindText, text: "deploy is green — see https://example.test/run/7",
				textSearch: "deploy is green see https example test run 7",
				groupJID:   externalGroup, chatJID: externalGroup, isGroup: true,
				sender: externalSender, pushName: "Alice",
				links: []string{"https://example.test/run/7"}, state: ParseOK, mediaStatus: MediaNone,
			},
		},
		{
			name: "direct message",
			event: externalEvent{
				MessageID: "3EB0EXT2", ChatID: externalSender, SenderID: externalSender,
				SenderName: "Owner", Body: "remind me tomorrow", Timestamp: externalSeconds,
			},
			want: externalWant{
				// A direct chat has no group, so the chat JID is the group key — the
				// convention the in-worker direct path already uses (§6.2).
				kind: KindText, text: "remind me tomorrow", textSearch: "remind me tomorrow",
				groupJID: externalSender, chatJID: externalSender,
				sender: externalSender, pushName: "Owner", state: ParseOK, mediaStatus: MediaNone,
			},
		},
		{
			name: "the linked account's own message",
			event: externalEvent{
				MessageID: "3EB0EXT3", ChatID: externalSender, SenderID: externalSender,
				SenderName: "Hermes", Body: "on it", FromMe: true, Timestamp: externalSeconds,
			},
			want: externalWant{
				kind: KindText, text: "on it", textSearch: "on it",
				groupJID: externalSender, chatJID: externalSender,
				sender: externalSender, pushName: "Hermes", fromMe: true,
				state: ParseOK, mediaStatus: MediaNone,
			},
		},
		{
			name: "image with a caption",
			event: externalEvent{
				MessageID: "3EB0EXT4", ChatID: externalGroup, SenderID: externalSender,
				SenderName: "Alice", IsGroup: true, Body: "the chart", HasMedia: true,
				MediaType: "image", Timestamp: externalSeconds,
				MediaURLs: []string{"/opt/data/.hermes/image_cache/img_0a1b2c.jpg"},
			},
			want: externalWant{
				kind: KindImage, text: "the chart", textSearch: "the chart",
				groupJID: externalGroup, chatJID: externalGroup, isGroup: true,
				sender: externalSender, pushName: "Alice", state: ParseOK,
				mediaStatus: MediaPending, mediaKind: KindImage, declared: KindImage,
			},
		},
		{
			name: "document with a file name",
			event: externalEvent{
				MessageID: "3EB0EXT5", ChatID: externalGroup, SenderID: externalSender,
				IsGroup: true, HasMedia: true, MediaType: "document", Timestamp: externalSeconds,
				// The bridge fills an empty caption with a placeholder of its own.
				Body:      "[document received]",
				MediaURLs: []string{"/opt/data/.hermes/document_cache/doc_9f8e7d_invoice-2026.pdf"},
			},
			want: externalWant{
				kind: KindDocument, text: "", textSearch: "",
				groupJID: externalGroup, chatJID: externalGroup, isGroup: true,
				sender: externalSender, state: ParseOK,
				mediaStatus: MediaPending, mediaKind: KindDocument, declared: KindDocument,
				fileName: "invoice-2026.pdf",
			},
		},
		{
			name: "voice note",
			event: externalEvent{
				MessageID: "3EB0EXT6", ChatID: externalGroup, SenderID: externalSender,
				IsGroup: true, HasMedia: true, MediaType: "ptt", Timestamp: externalSeconds,
				MediaURLs: []string{"/opt/data/.hermes/audio_cache/aud_112233.ogg"},
			},
			want: externalWant{
				// `ptt` is a push-to-talk voice note: audio here, because the worker's
				// `ptv` names a video note (see externalKind).
				kind: KindAudio, groupJID: externalGroup, chatJID: externalGroup, isGroup: true,
				sender: externalSender, state: ParseOK,
				mediaStatus: MediaPending, mediaKind: KindAudio, declared: KindAudio,
			},
		},
		{
			name: "mention",
			event: externalEvent{
				MessageID: "3EB0EXT7", ChatID: externalGroup, SenderID: externalSender,
				IsGroup: true, Body: "@628990000002 can you look?", Timestamp: externalSeconds,
				// The bridge repeats a mention per message variant, and an empty entry
				// is what a normalize step that found nothing leaves behind.
				MentionedIDs: []string{"628990000002@s.whatsapp.net", "628990000002@s.whatsapp.net", ""},
			},
			want: externalWant{
				kind: KindText, text: "@628990000002 can you look?",
				textSearch: "628990000002 can you look",
				groupJID:   externalGroup, chatJID: externalGroup, isGroup: true,
				sender: externalSender, state: ParseOK, mediaStatus: MediaNone,
				mentions: []string{"628990000002@s.whatsapp.net"},
			},
		},
		{
			name: "no body and no media",
			event: externalEvent{
				MessageID: "3EB0EXT8", ChatID: externalGroup, SenderID: externalSender,
				IsGroup: true, Timestamp: externalSeconds,
			},
			want: externalWant{
				// Nothing to classify is still a message: recorded `unknown`/`partial`,
				// never dropped (R3).
				kind: KindUnknown, groupJID: externalGroup, chatJID: externalGroup,
				isGroup: true, sender: externalSender, state: ParsePartial, mediaStatus: MediaNone,
			},
		},
		{
			name: "media type this build does not know",
			event: externalEvent{
				MessageID: "3EB0EXT9", ChatID: externalGroup, SenderID: externalSender,
				IsGroup: true, HasMedia: true, MediaType: "poll", Timestamp: externalSeconds,
				MediaURLs: []string{"/opt/data/.hermes/document_cache/doc_445566_poll.bin"},
			},
			want: externalWant{
				kind: KindUnknown, groupJID: externalGroup, chatJID: externalGroup,
				isGroup: true, sender: externalSender, state: ParsePartial,
				// The bytes are still kept: the descriptor is unknown, the attachment
				// is not.
				mediaStatus: MediaPending,
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := externalDoc(tc.event, "org_default", "inst_hermes", externalReceivedAt)
			if err != nil {
				t.Fatalf("externalDoc: %v", err)
			}
			want := tc.want
			if got.Kind != want.kind {
				t.Errorf("Kind = %q, want %q", got.Kind, want.kind)
			}
			if got.Text != want.text || got.TextSearch != want.textSearch {
				t.Errorf("Text/TextSearch = %q/%q, want %q/%q", got.Text, got.TextSearch, want.text, want.textSearch)
			}
			if got.GroupJID != want.groupJID || got.ChatJID != want.chatJID {
				t.Errorf("GroupJID/ChatJID = %q/%q, want %q/%q", got.GroupJID, got.ChatJID, want.groupJID, want.chatJID)
			}
			if got.IsGroup != want.isGroup || got.FromMe != want.fromMe {
				t.Errorf("IsGroup/FromMe = %v/%v, want %v/%v", got.IsGroup, got.FromMe, want.isGroup, want.fromMe)
			}
			if got.SenderJID != want.sender || got.PushName != want.pushName {
				t.Errorf("SenderJID/PushName = %q/%q, want %q/%q", got.SenderJID, got.PushName, want.sender, want.pushName)
			}
			if !equalStrings(got.Links, want.links) {
				t.Errorf("Links = %v, want %v", got.Links, want.links)
			}
			if !equalStrings(got.Mentions, want.mentions) {
				t.Errorf("Mentions = %v, want %v", got.Mentions, want.mentions)
			}
			if got.ParseState != want.state {
				t.Errorf("ParseState = %q (%v), want %q", got.ParseState, got.ParseErrors, want.state)
			}
			if got.Media.Status != want.mediaStatus || got.Media.Kind != want.mediaKind || got.Media.DeclaredType != want.declared {
				t.Errorf("Media = {status:%q kind:%q declared:%q}, want {%q %q %q}",
					got.Media.Status, got.Media.Kind, got.Media.DeclaredType, want.mediaStatus, want.mediaKind, want.declared)
			}
			if got.Media.FileName != want.fileName {
				t.Errorf("Media.FileName = %q, want %q", got.Media.FileName, want.fileName)
			}
			if got.InstanceID != "inst_hermes" || got.OrganizationID != "org_default" {
				t.Errorf("identity = %q/%q, want org_default/inst_hermes", got.OrganizationID, got.InstanceID)
			}
			if got.WaMessageID != tc.event.MessageID {
				t.Errorf("WaMessageID = %q, want %q", got.WaMessageID, tc.event.MessageID)
			}
			if got.SchemaVersion != messageSchemaVersion {
				t.Errorf("SchemaVersion = %d, want %d", got.SchemaVersion, messageSchemaVersion)
			}
			if got.ReceivedAt != externalReceivedAt {
				t.Errorf("ReceivedAt = %s, want the observation time", got.ReceivedAt)
			}
			// The event's own payload is what `raw` keeps, so the quote fields the
			// worker's schema has no place for are still inspectable.
			if _, ok := got.Raw.Message["quotedMessageId"]; !ok {
				t.Errorf("raw.message = %v, want the event's own fields", got.Raw.Message)
			}
		})
	}
}

// TestExternalDocRejectsAnUnidentifiableEvent pins the one failure: without an id or
// a chat there is no row to write, and the caller has to hear about it rather than
// get a document nothing can be matched to.
func TestExternalDocRejectsAnUnidentifiableEvent(t *testing.T) {
	cases := map[string]externalEvent{
		"no message id": {ChatID: externalGroup, Body: "hello", Timestamp: externalSeconds},
		"no chat":       {MessageID: "3EB0EXT10", Body: "hello", Timestamp: externalSeconds},
		"blank id":      {MessageID: "   ", ChatID: externalGroup, Body: "hello", Timestamp: externalSeconds},
	}
	for name, evt := range cases {
		if _, err := externalDoc(evt, "org_default", "inst_hermes", externalReceivedAt); err == nil {
			t.Errorf("%s: externalDoc accepted the event", name)
		}
	}
}

// TestExternalDocDropsTheBridgeMediaPlaceholder pins what an uncaptioned attachment
// stores: the bridge's `[image received]` is its own presentation, and keeping it
// would give the row a caption nobody sent and a phrase `textSearch` matches.
func TestExternalDocDropsTheBridgeMediaPlaceholder(t *testing.T) {
	evt := externalEvent{
		MessageID: "3EB0EXT11", ChatID: externalGroup, IsGroup: true, HasMedia: true,
		MediaType: "image", Body: "[image received]", Timestamp: externalSeconds,
		MediaURLs: []string{"/opt/data/.hermes/image_cache/img_778899.jpg"},
	}
	got, err := externalDoc(evt, "org_default", "inst_hermes", externalReceivedAt)
	if err != nil {
		t.Fatalf("externalDoc: %v", err)
	}
	if got.Text != "" || got.TextSearch != "" {
		t.Errorf("Text/TextSearch = %q/%q, want empty: the placeholder is the bridge's, not the sender's", got.Text, got.TextSearch)
	}
	// A caption that merely looks like the placeholder's shape is still a caption.
	evt.Body = "[screen received]"
	got, err = externalDoc(evt, "org_default", "inst_hermes", externalReceivedAt)
	if err != nil {
		t.Fatalf("externalDoc: %v", err)
	}
	if got.Text != "[screen received]" {
		t.Errorf("Text = %q, want the sender's own words kept", got.Text)
	}
}

// TestExternalDocTimestampUnits covers the one field every read is ordered by: the
// bridge sends seconds, the decoder accepts the three JSON shapes a JavaScript long
// can arrive in, and the two unusable cases are repaired rather than stored.
func TestExternalDocTimestampUnits(t *testing.T) {
	decode := func(t *testing.T, raw string) externalEvent {
		t.Helper()
		var evt externalEvent
		if err := json.Unmarshal([]byte(raw), &evt); err != nil {
			t.Fatalf("decode %s: %v", raw, err)
		}
		return evt
	}
	base := `{"messageId":"3EB0EXT12","chatId":"` + externalGroup + `","body":"hi","timestamp":%s}`

	cases := []struct {
		name      string
		timestamp string
		want      time.Time
		state     ParseState
	}{
		{"seconds", "1757750000", time.Unix(1757750000, 0).UTC(), ParseOK},
		{"milliseconds are scaled", "1757750000000", time.Unix(1757750000, 0).UTC(), ParsePartial},
		{"a numeric string", `"1757750000"`, time.Unix(1757750000, 0).UTC(), ParseOK},
		{"a protobufjs long", `{"low":1757750000,"high":0,"unsigned":true}`, time.Unix(1757750000, 0).UTC(), ParseOK},
		{"nothing usable", "0", externalReceivedAt, ParsePartial},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			evt := decode(t, strings.Replace(base, "%s", tc.timestamp, 1))
			got, err := externalDoc(evt, "org_default", "inst_hermes", externalReceivedAt)
			if err != nil {
				t.Fatalf("externalDoc: %v", err)
			}
			if !got.Timestamp.Equal(tc.want) {
				t.Errorf("Timestamp = %s, want %s", got.Timestamp, tc.want)
			}
			if got.ParseState != tc.state {
				t.Errorf("ParseState = %q (%v), want %q", got.ParseState, got.ParseErrors, tc.state)
			}
			if want := externalReceivedAt.Sub(tc.want).Milliseconds(); got.ServerSkewMs != want {
				t.Errorf("ServerSkewMs = %d, want %d", got.ServerSkewMs, want)
			}
		})
	}
}

// TestExternalDocKeepsTheEventAsRaw pins the evidence: the stored tree is the bridge's
// own payload, so a field this mapping does not model is still readable — and the
// search text is flattened from it by the same walk the protobuf tree gets.
func TestExternalDocKeepsTheEventAsRaw(t *testing.T) {
	evt := externalEvent{
		MessageID: "3EB0EXT13", ChatID: externalGroup, SenderID: externalSender,
		ChatName: "120363043123456789", IsGroup: true, Body: "forwarded", Timestamp: externalSeconds,
		QuotedMessageID: "3EB0QUOTED", QuotedParticipant: "628990000003@s.whatsapp.net",
		HasQuotedMessage: true, BotIDs: []string{"628990000009@s.whatsapp.net"},
		MentionedIDs: []string{"628990000004@s.whatsapp.net"},
	}
	got, err := externalDoc(evt, "org_default", "inst_hermes", externalReceivedAt)
	if err != nil {
		t.Fatalf("externalDoc: %v", err)
	}
	if got.Raw.Bytes == 0 || got.Raw.Truncated {
		t.Errorf("Raw = %+v, want the event stored whole", got.Raw)
	}
	if got.Raw.Message["quotedMessageId"] != "3EB0QUOTED" || got.Raw.Message["chatName"] != "120363043123456789" {
		t.Errorf("raw.message = %v, want the event verbatim", got.Raw.Message)
	}
	// The search text is the flattened tree, which is how a quote stays findable.
	for _, needle := range []string{"3EB0QUOTED", "628990000004@s.whatsapp.net"} {
		if !strings.Contains(got.RawSearch, needle) {
			t.Errorf("rawSearch = %q, want it to contain %q", got.RawSearch, needle)
		}
	}
}

// ---- media -----------------------------------------------------------------

// externalIngestFor builds the path under a temporary host root, so a test writes the
// cache file the bridge would have written and the worker reads it through the remap.
func externalIngestFor(t *testing.T, store mediaStore, uploader *r2Client) (*externalIngest, string) {
	t.Helper()
	root := t.TempDir()
	ingest := newExternalIngest(Config{
		OrganizationID: "org_default", HermesInstanceID: "inst_hermes", HermesDataDir: root,
		MediaMaxBytes: 1 << 20, MediaConcurrency: 1, MediaDownloadTimeout: 5 * time.Second,
	}, store, uploader)
	ingest.now = func() time.Time { return mediaNow }
	return ingest, root
}

// writeCache writes one attachment where the bridge would have: under the container
// path, which is the host root once the prefix is remapped.
func writeCache(t *testing.T, root, containerPath string, data []byte) string {
	t.Helper()
	path := filepath.Join(root, strings.TrimPrefix(containerPath, hermesContainerDataDir))
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write attachment: %v", err)
	}
	return path
}

// TestExternalMediaStoresTheAttachmentUnderTheWorkerKey is the whole attachment
// promise: bytes the container wrote land in the bucket under the worker's own key,
// with the metadata that makes them fetchable, and with the kind the bytes prove
// rather than the one the event claimed (§6.3.3, §6.3.4).
func TestExternalMediaStoresTheAttachmentUnderTheWorkerKey(t *testing.T) {
	data := pngHeader(4, 3)
	const containerPath = "/opt/data/.hermes/image_cache/img_0a1b2c.png"
	api := &fakeS3{}
	ingest, root := externalIngestFor(t, nil, newR2Client(api, "butler-media", "", 1<<20))
	writeCache(t, root, containerPath, data)

	doc, err := ingest.doc(context.Background(), externalEvent{
		MessageID: "3EB0MED1", ChatID: externalGroup, SenderID: externalSender, IsGroup: true,
		HasMedia: true, MediaType: "image", Body: "[image received]",
		MediaURLs: []string{containerPath}, Timestamp: externalSeconds,
	})
	if err != nil {
		t.Fatalf("doc: %v", err)
	}

	wantKey := objectKeyAt("org_default", "inst_hermes", externalGroup, "3EB0MED1", "png", mediaNow)
	put := api.stored(wantKey)
	if put == nil {
		t.Fatalf("no object at %s (puts: %v)", wantKey, putKeys(api))
	}
	if string(put.body) != string(data) {
		t.Errorf("stored %d bytes, want the bridge's %d", len(put.body), len(data))
	}
	if api.stored(objectKeyAt("org_default", "inst_hermes", externalGroup, "3EB0MED1", sidecarExt, mediaNow)) == nil {
		t.Errorf("no descriptor sidecar (puts: %v)", putKeys(api))
	}

	media := doc.Media
	if media.Status != MediaStored || media.Mime != "image/png" || media.Kind != KindImage {
		t.Errorf("media = %+v, want stored image/png as an image", media)
	}
	if media.R2Key != wantKey || media.SHA256 != sha256Hex(data) || media.Size != int64(len(data)) {
		t.Errorf("media = %+v, want the key, digest and size of the stored bytes", media)
	}
	if media.Width != 4 || media.Height != 3 {
		t.Errorf("dimensions = %dx%d, want 4x3 read from the bytes", media.Width, media.Height)
	}
	if media.DeclaredType != KindImage {
		t.Errorf("DeclaredType = %q, want what the event claimed", media.DeclaredType)
	}
	if doc.Text != "" {
		t.Errorf("Text = %q, want the placeholder dropped", doc.Text)
	}
}

// TestExternalMediaIsRecordedAfterTheRowExists covers the second half of the write:
// `Save` carries the parse-time descriptor, so the outcome (key, size, digest) has to
// be recorded once the row is durable — and only for the documents that carry one.
func TestExternalMediaIsRecordedAfterTheRowExists(t *testing.T) {
	store := &externalMediaRecorder{}
	ingest, _ := externalIngestFor(t, store, nil)

	ingest.recordSaved([]MessageDoc{
		{WaMessageID: "3EB0MED2", Media: Media{Status: MediaStored, R2Key: "org/…/a.png"}},
		{WaMessageID: "3EB0MED3", Media: Media{Status: MediaUnavailable, Reason: reasonDownloadFailed}},
		// The parse path's own descriptor: `pending` and `none` are the media
		// runner's business, not this hook's.
		{WaMessageID: "3EB0MED4", Media: Media{Status: MediaPending}},
		{WaMessageID: "3EB0MED5", Media: Media{Status: MediaNone}},
	})

	waitFor(t, "the media outcomes to be recorded", func() bool { return len(store.saved()) == 2 })
	recorded := store.saved()
	if recorded[0].doc.WaMessageID != "3EB0MED2" || recorded[1].doc.WaMessageID != "3EB0MED3" {
		t.Fatalf("recorded %q/%q, want only the two attachments this path stored",
			recorded[0].doc.WaMessageID, recorded[1].doc.WaMessageID)
	}
	if recorded[0].media.R2Key != "org/…/a.png" || recorded[1].media.Reason != reasonDownloadFailed {
		t.Errorf("recorded %+v, want each document's own outcome", recorded)
	}
}

// TestExternalMediaUnavailableWithoutStorage pins the disabled case: a worker with no
// bucket must record the attachment as unusable rather than claim it stored one.
func TestExternalMediaUnavailableWithoutStorage(t *testing.T) {
	const containerPath = "/opt/data/.hermes/image_cache/img_0a1b2c.png"
	ingest, root := externalIngestFor(t, nil, nil)
	writeCache(t, root, containerPath, pngHeader(4, 3))

	doc, err := ingest.doc(context.Background(), externalEvent{
		MessageID: "3EB0MED6", ChatID: externalGroup, IsGroup: true, HasMedia: true,
		MediaType: "image", MediaURLs: []string{containerPath}, Timestamp: externalSeconds,
	})
	if err != nil {
		t.Fatalf("doc: %v", err)
	}
	if doc.Media.Status != MediaUnavailable || doc.Media.Reason != reasonDownloadFailed {
		t.Errorf("media = %+v, want unavailable/download_failed with no R2 configured", doc.Media)
	}
	if doc.Media.R2Key != "" {
		t.Errorf("media.r2Key = %q, want no locator claimed", doc.Media.R2Key)
	}
	if !strings.Contains(doc.Media.Error, "not configured") {
		t.Errorf("media.error = %q, want the reason it could not be stored", doc.Media.Error)
	}
}

// TestExternalMediaRefusesAPathOutsideTheHermesRoot pins the file-read guard: the path
// arrives over HTTP, so anything that leaves the bridge's own directory tree is
// refused before the filesystem is touched (§11.4).
func TestExternalMediaRefusesAPathOutsideTheHermesRoot(t *testing.T) {
	api := &fakeS3{}
	ingest, _ := externalIngestFor(t, nil, newR2Client(api, "butler-media", "", 1<<20))

	for _, path := range []string{
		"/etc/passwd",
		"/opt/data/../etc/passwd",
		"/opt/data/.hermes/../../../../etc/passwd",
		"/opt/data",
		"",
	} {
		doc, err := ingest.doc(context.Background(), externalEvent{
			MessageID: "3EB0MED7", ChatID: externalGroup, IsGroup: true, HasMedia: true,
			MediaType: "document", MediaURLs: []string{path}, Timestamp: externalSeconds,
		})
		if err != nil {
			t.Fatalf("doc(%q): %v", path, err)
		}
		if doc.Media.Status != MediaUnavailable {
			t.Errorf("path %q: status = %q, want unavailable", path, doc.Media.Status)
		}
		if doc.Media.Reason != reasonDownloadFailed {
			t.Errorf("path %q: reason = %q, want %q", path, doc.Media.Reason, reasonDownloadFailed)
		}
	}
	if len(api.puts) != 0 {
		t.Errorf("uploaded %v, want nothing stored from a path outside the root", putKeys(api))
	}
}

// TestExternalMediaReportsAnUnreadableAttachment covers the cache file that is no
// longer there: the bytes are gone, so nothing is claimed as stored, and the row keeps
// both the reason and the path an operator needs to see.
func TestExternalMediaReportsAnUnreadableAttachment(t *testing.T) {
	api := &fakeS3{}
	ingest, _ := externalIngestFor(t, nil, newR2Client(api, "butler-media", "", 1<<20))

	doc, err := ingest.doc(context.Background(), externalEvent{
		MessageID: "3EB0MED8", ChatID: externalGroup, IsGroup: true, HasMedia: true,
		MediaType: "video", MediaURLs: []string{"/opt/data/.hermes/document_cache/vid_missing.mp4"},
		Timestamp: externalSeconds,
	})
	if err != nil {
		t.Fatalf("doc: %v", err)
	}
	if doc.Media.Status != MediaFailed {
		t.Errorf("status = %q, want failed: a redelivery of the message can bring the bytes again", doc.Media.Status)
	}
	if doc.Media.Kind != KindVideo || doc.Media.DeclaredType != KindVideo {
		t.Errorf("media = %+v, want the declared video kept even without bytes", doc.Media)
	}
	if doc.Media.R2Key != "" || !strings.Contains(doc.Media.Error, "vid_missing.mp4") {
		t.Errorf("media = %+v, want no locator and the path that failed", doc.Media)
	}
	if len(api.puts) != 0 {
		t.Errorf("uploaded %v, want nothing", putKeys(api))
	}
}

// TestExternalMediaStopsAtTheByteCap pins MEDIA_MAX_BYTES on this source too: the
// bridge's file is read under the same cap as a WhatsApp download, and bytes past it
// are a refusal no retry can change.
func TestExternalMediaStopsAtTheByteCap(t *testing.T) {
	const containerPath = "/opt/data/.hermes/document_cache/doc_1a2b3c_big.bin"
	root := t.TempDir()
	ingest := newExternalIngest(Config{
		OrganizationID: "org_default", HermesInstanceID: "inst_hermes", HermesDataDir: root,
		MediaMaxBytes: 16, MediaConcurrency: 1, MediaDownloadTimeout: 5 * time.Second,
	}, nil, newR2Client(&fakeS3{}, "butler-media", "", 1<<20))
	ingest.now = func() time.Time { return mediaNow }
	writeCache(t, root, containerPath, make([]byte, 4096))

	doc, err := ingest.doc(context.Background(), externalEvent{
		MessageID: "3EB0MED9", ChatID: externalGroup, IsGroup: true, HasMedia: true,
		MediaType: "document", MediaURLs: []string{containerPath}, Timestamp: externalSeconds,
	})
	if err != nil {
		t.Fatalf("doc: %v", err)
	}
	if doc.Media.Status != MediaUnavailable || doc.Media.Reason != reasonTooLarge {
		t.Errorf("media = %+v, want unavailable/too_large", doc.Media)
	}
}

// ---- persistence -----------------------------------------------------------

// TestExternalDocUsesTheIngestUpsertSplit is the redelivery guarantee: the document a
// Hermes event produces goes through the same field split as a whatsmeow one, so a
// re-posted event updates the row it created instead of writing a second one.
func TestExternalDocUsesTheIngestUpsertSplit(t *testing.T) {
	first, err := externalDoc(externalEvent{
		MessageID: "3EB0EXT20", ChatID: externalGroup, SenderID: externalSender, IsGroup: true,
		Body: "first", HasMedia: true, MediaType: "image", Timestamp: externalSeconds,
		MediaURLs: []string{"/opt/data/.hermes/image_cache/img_0a1b2c.png"},
	}, "org_default", "inst_hermes", externalReceivedAt)
	if err != nil {
		t.Fatalf("externalDoc: %v", err)
	}
	// The same message re-posted by the bridge, with the row's own facts a moment
	// later: the bytes are the same, the observation is not.
	redelivered, err := externalDoc(externalEvent{
		MessageID: "3EB0EXT20", ChatID: externalGroup, SenderID: externalSender, IsGroup: true,
		Body: "first", HasMedia: true, MediaType: "image", Timestamp: externalSeconds,
		MediaURLs: []string{"/opt/data/.hermes/image_cache/img_deadbe.png"},
	}, "org_default", "inst_hermes", externalReceivedAt.Add(time.Minute))
	if err != nil {
		t.Fatalf("externalDoc(redelivery): %v", err)
	}

	// Save's filter is the unique index key; every one of its keys has to be written
	// on insert, or an upsert would create a document the filter cannot find again.
	filter := bson.D{
		{Key: "organizationId", Value: first.OrganizationID},
		{Key: "instanceId", Value: first.InstanceID},
		{Key: "waMessageId", Value: first.WaMessageID},
	}
	insert := fieldMap(identityFields(first))
	for _, key := range filter {
		value, ok := insert[key.Key]
		if !ok {
			t.Fatalf("identityFields is missing %q, so the upsert filter would never match the row it created", key.Key)
		}
		if value != key.Value {
			t.Errorf("identityFields[%q] = %v, want %v", key.Key, value, key.Value)
		}
	}
	// The parse-time descriptor is a first-arrival fact: it belongs to the insert, so
	// a redelivery (or the media pipeline's own write) cannot be overwritten by it.
	for _, key := range []string{"media.status", "media.kind", "media.declaredType"} {
		if _, ok := insert[key]; !ok {
			t.Errorf("identityFields is missing %q", key)
		}
	}

	update := fieldMap(messageFields(first))
	for _, key := range []string{"kind", "text", "textSearch", "rawSearch", "links", "mentions", "raw.message", "parse.state", "parse.version"} {
		if _, ok := update[key]; !ok {
			t.Errorf("messageFields is missing %q: the external row would not be persisted", key)
		}
	}
	if _, ok := insert["text"]; ok {
		t.Error("identityFields writes `text`: a redelivery would be unable to correct it")
	}

	// The two documents differ in `receivedAt` — the observation that stays first —
	// and in nothing the filter or the parse-time descriptor depends on.
	if fieldMap(identityFields(redelivered))["receivedAt"] != redelivered.ReceivedAt {
		t.Error("identityFields does not carry receivedAt")
	}
	for key, value := range insert {
		if key == "receivedAt" {
			continue
		}
		if fieldMap(identityFields(redelivered))[key] != value {
			t.Errorf("identityFields[%q] changed on redelivery: the row would be rewritten, not updated", key)
		}
	}
	if fieldMap(messageFields(redelivered))["text"] != "first" {
		t.Error("messageFields lost the text on redelivery")
	}
}

// fieldMap indexes a bson.D by key, which is how a test can ask what a field mapper
// writes without depending on its order.
func fieldMap(fields bson.D) map[string]any {
	out := make(map[string]any, len(fields))
	for _, field := range fields {
		out[field.Key] = field.Value
	}
	return out
}

// ---- http ------------------------------------------------------------------

// externalMediaRecorder is the store the external path owes its outcomes to, with the
// document kept beside the media so a test can tell the two apart.
type externalMediaRecorder struct {
	mu      sync.Mutex
	records []externalMediaRecord
}

type externalMediaRecord struct {
	doc   MessageDoc
	media Media
}

func (r *externalMediaRecorder) saveMedia(_ context.Context, doc MessageDoc, media Media) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.records = append(r.records, externalMediaRecord{doc: doc, media: media})
	return nil
}

func (r *externalMediaRecorder) saved() []externalMediaRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]externalMediaRecord(nil), r.records...)
}

// postIngest drives the route with a body, the way the bridge does.
func postIngest(t *testing.T, handler *api, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/ingest", strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	handler.routes().ServeHTTP(rec, req)
	return rec
}

// TestExternalIngestEndpoint covers the route's contract: an event is accepted into
// the same queue whatsmeow messages use, and the three ways it can be refused are told
// apart — a bad payload, a missing token, and a worker that is not accepting.
func TestExternalIngestEndpoint(t *testing.T) {
	body := `{"messageId":"3EB0HTTP1","chatId":"` + externalGroup + `","senderId":"` + externalSender + `",` +
		`"senderName":"Alice","isGroup":true,"body":"deploy is green","timestamp":1757750000,"fromMe":false}`

	newHandler := func(t *testing.T) (*api, *manager) {
		t.Helper()
		mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
		mgr.cfg.HermesInstanceID = "inst_hermes"
		mgr.ingest = newIngestQueue(8, time.Hour, 10)
		mgr.external = newExternalIngest(mgr.cfg, nil, nil)
		return &api{manager: mgr, secret: "dev-secret", orgID: "org_default"}, mgr
	}

	t.Run("accepted into the ingest queue", func(t *testing.T) {
		handler, mgr := newHandler(t)
		rec := postIngest(t, handler, "dev-secret", body)
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
		}
		docs := mgr.ingest.stop()
		if len(docs) != 1 {
			t.Fatalf("queued %d documents, want 1", len(docs))
		}
		doc := docs[0]
		if doc.InstanceID != "inst_hermes" || doc.WaMessageID != "3EB0HTTP1" || doc.Kind != KindText {
			t.Errorf("doc = %+v, want the event mapped onto the configured instance", doc)
		}
		if doc.GroupJID != externalGroup || doc.Media.Status != MediaNone {
			t.Errorf("doc = %+v, want a group row with no attachment", doc)
		}
	})

	t.Run("malformed body", func(t *testing.T) {
		handler, _ := newHandler(t)
		for _, payload := range []string{"{", `{"chatId":"` + externalGroup + `","body":"no id"}`} {
			rec := postIngest(t, handler, "dev-secret", payload)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("payload %q: status = %d, want 400", payload, rec.Code)
			}
		}
	})

	t.Run("bearer required", func(t *testing.T) {
		handler, _ := newHandler(t)
		rec := postIngest(t, handler, "", body)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401: the bridge is a service of this deployment, not a public collector", rec.Code)
		}
	})

	t.Run("method", func(t *testing.T) {
		handler, _ := newHandler(t)
		rec := call(handler, http.MethodGet, "/ingest", "dev-secret")
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("status = %d, want 405", rec.Code)
		}
	})

	t.Run("a stopped worker refuses", func(t *testing.T) {
		handler, mgr := newHandler(t)
		mgr.ingest.stop()
		rec := postIngest(t, handler, "dev-secret", body)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, body = %s, want 503", rec.Code, rec.Body.String())
		}
		var payload struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if payload.Code != "ingest_closed" {
			t.Errorf("code = %q, want ingest_closed", payload.Code)
		}
	})
}

// ---- end to end ------------------------------------------------------------

// TestExternalIngestPersistsThroughTheQueue is the whole path against a real
// database: an event the bridge would post becomes exactly one `messages` row — with
// its attachment's key, digest and size on it — and a redelivery of the same event
// updates that row instead of writing a second one. It is skipped in short mode, like
// every test that needs Mongo.
func TestExternalIngestPersistsThroughTheQueue(t *testing.T) {
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
	root := t.TempDir()
	mgr := testManagerWithDeps(newFakeGroupStore(), nil, nil)
	mgr.cfg.HermesInstanceID = "inst_hermes"
	mgr.cfg.HermesDataDir = root
	mgr.cfg.MediaMaxBytes = 1 << 20
	mgr.cfg.MediaConcurrency = 1
	mgr.cfg.MediaDownloadTimeout = 5 * time.Second
	mgr.external = newExternalIngest(mgr.cfg, store, newR2Client(&fakeS3{}, "butler-media", "", 1<<20))
	queue := newIngestQueue(8, 20*time.Millisecond, 100)
	queue.setAfterSave(mgr.afterIngestFlush)
	mgr.ingest = queue

	runCtx, shutdown := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); queue.Run(runCtx, store) }()
	defer func() {
		shutdown()
		<-done
	}()

	const containerPath = "/opt/data/.hermes/image_cache/img_0a1b2c.png"
	writeCache(t, root, containerPath, pngHeader(4, 3))
	event := func(body string) externalEvent {
		return externalEvent{
			MessageID: "3EB0E2E1", ChatID: externalGroup, SenderID: externalSender,
			SenderName: "Alice", IsGroup: true, Body: body, HasMedia: true, MediaType: "image",
			MediaURLs: []string{containerPath}, Timestamp: externalSeconds,
		}
	}
	key := bson.M{"organizationId": "org_default", "instanceId": "inst_hermes", "waMessageId": "3EB0E2E1"}
	_, _ = db.Collection(collMessages).DeleteMany(ctx, key)
	defer func() { _, _ = db.Collection(collMessages).DeleteMany(ctx, key) }()

	if err := mgr.ingestExternalEvent(ctx, event("the chart")); err != nil {
		t.Fatalf("ingestExternalEvent: %v", err)
	}
	// The flush is asynchronous, and the attachment's own record follows the row
	// (the row is created with the parse-time descriptor, which is why waiting for
	// `media.status` would prove nothing): wait for the key, which only the media
	// write can produce.
	wantKey := objectKeyAt("org_default", "inst_hermes", externalGroup, "3EB0E2E1", "png", mediaNow)
	waitFor(t, "the attachment to be recorded on the row", func() bool {
		return mediaField(readMessageOrNil(ctx, db, key), "r2Key") == wantKey
	})

	row := readMessage(t, ctx, db, key)
	if row["kind"] != string(KindImage) || row["text"] != "the chart" || row["groupJid"] != externalGroup {
		t.Errorf("row = %v, want the mapped image row", row)
	}
	for field, want := range map[string]any{
		"media.r2Key": wantKey, "media.sha256": sha256Hex(pngHeader(4, 3)), "media.mime": "image/png",
	} {
		if got := dotted(row, field); got != want {
			t.Errorf("%s = %v, want %v", field, got, want)
		}
	}
	if dotted(row, "parse.version") != int32(messageSchemaVersion) {
		t.Errorf("parse.version = %v, want %d", dotted(row, "parse.version"), messageSchemaVersion)
	}

	// The same message posted again — the bridge re-notifying after a reconnect — is
	// the case the unique index exists for: one row, the parse fields corrected, and
	// the first observation kept.
	if err := mgr.ingestExternalEvent(ctx, event("the chart, restated")); err != nil {
		t.Fatalf("ingestExternalEvent(redelivery): %v", err)
	}
	waitFor(t, "the redelivery to land", func() bool {
		return readMessageOrNil(ctx, db, key)["text"] == "the chart, restated"
	})
	count, err := db.Collection(collMessages).CountDocuments(ctx, key)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("rows = %d, want 1: a redelivery updates the message, it does not duplicate it", count)
	}
	redelivered := readMessage(t, ctx, db, key)
	if !sameTime(redelivered["receivedAt"], row["receivedAt"]) {
		t.Errorf("receivedAt = %v, want the first observation %v kept", redelivered["receivedAt"], row["receivedAt"])
	}
}

// readMessage reads one `messages` row as it is stored, so an assertion can name a
// dotted field the way the database holds it.
func readMessage(t *testing.T, ctx context.Context, db *mongo.Database, key bson.M) bson.M {
	t.Helper()
	row := readMessageOrNil(ctx, db, key)
	if row == nil {
		t.Fatalf("no message row for %v", key)
	}
	return row
}

// readMessageOrNil is readMessage for a poll: the flush is asynchronous, so a test
// that waits for a write has to tolerate the row not being there yet.
func readMessageOrNil(ctx context.Context, db *mongo.Database, key bson.M) bson.M {
	var row bson.M
	if err := db.Collection(collMessages).FindOne(ctx, key).Decode(&row); err != nil {
		return nil
	}
	return row
}

// dotted reads one dotted field of a stored row, e.g. `media.r2Key`. The driver hands
// a nested document back as bson.D, so both shapes are walked.
func dotted(row bson.M, field string) any {
	var value any = row
	for _, part := range strings.Split(field, ".") {
		switch doc := value.(type) {
		case bson.M:
			value = doc[part]
		case bson.D:
			value = nil
			for _, element := range doc {
				if element.Key == part {
					value = element.Value
					break
				}
			}
		default:
			return nil
		}
	}
	return value
}

// mediaField reads one field of the row's media subdocument.
func mediaField(row bson.M, field string) string {
	value, _ := dotted(row, "media."+field).(string)
	return value
}

// sameTime compares two stored times, which the driver hands back as time.Time.
func sameTime(a, b any) bool {
	first, okA := a.(bson.DateTime)
	second, okB := b.(bson.DateTime)
	if okA && okB {
		return first == second
	}
	return a == b
}

// putKeys names what a fake bucket holds, so a failure says which objects were written.
func putKeys(api *fakeS3) []string {
	keys := make([]string, 0, len(api.puts))
	for _, put := range api.puts {
		keys = append(keys, aws.ToString(put.input.Key))
	}
	return keys
}

// equalStrings compares two lists the way the mapping asserts them: a nil list and an
// empty one are the same answer.
func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
