package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// This file is the worker's other door into the `messages` collection (§6.2).
//
// WhatsApp is Hermes's now: the Go worker holds no linked device, but it still
// owns the row shape, the object-key convention and the ingest queue, so the
// bridge in the Hermes container forwards every message it observes — including
// the ones the agent never looks at — and this path maps it onto exactly the
// document §5.1 describes. This is the worker's only message producer: the session
// that used to deliver WhatsApp events is gone (main.go), and the row helpers that
// outlived it (foldText, collectLinks, dedupeStrings, pruneRaw, rawSearchText) are
// what this mapping reuses rather than restating.

// externalEvent is one inbound WhatsApp message as the Hermes bridge observed it.
//
// The field names are the bridge's own camelCase (infra/hermes/build/bridge.js,
// plus `fromMe` which the archive forwarder adds), so the payload is accepted
// exactly as it is sent. Fields this mapping does not use are still declared: the
// struct is what `raw` is serialized from, and a field the bridge grows for
// something this worker does not model yet has to survive in the stored payload —
// dropping it here would be the one place evidence could be lost.
type externalEvent struct {
	MessageID  string `json:"messageId"`
	ChatID     string `json:"chatId"`
	SenderID   string `json:"senderId"`
	SenderName string `json:"senderName"`
	// ChatName is the bridge's own label: for a group it is the group's numeric
	// id, not its subject, so it is never used as a group name — those keep coming
	// from the group store, which reads them from WhatsApp.
	ChatName string `json:"chatName"`
	IsGroup  bool   `json:"isGroup"`
	// FromMe is the linked account's own message. Hermes reports its replies to
	// itself (self-chat mode) and the bridge forwards them with this flag, so it is
	// a first-arrival fact and lands in identityFields.
	FromMe   bool   `json:"fromMe"`
	Body     string `json:"body"`
	HasMedia bool   `json:"hasMedia"`
	// MediaType is the bridge's media vocabulary: `image`, `video`, `audio`,
	// `ptt`, `document`, and empty when the message carries no attachment.
	MediaType string `json:"mediaType"`
	// MediaURLs are paths, not URLs: the bridge downloaded the attachment itself
	// and wrote it into its cache (§6.3.2), so these are the files this path reads.
	MediaURLs    []string `json:"mediaUrls"`
	MentionedIDs []string `json:"mentionedIds"`
	// The quote fields are carried for the raw tree only. The `messages` row has no
	// field of its own for a quote, so they stay in the payload where an operator
	// (and a later re-parse) can still see what was answered.
	QuotedMessageID   string   `json:"quotedMessageId"`
	QuotedParticipant string   `json:"quotedParticipant"`
	QuotedRemoteJID   string   `json:"quotedRemoteJid"`
	HasQuotedMessage  bool     `json:"hasQuotedMessage"`
	BotIDs            []string `json:"botIds"`
	// Timestamp is Unix SECONDS (the bridge forwards Baileys' own message
	// timestamp), decoded tolerantly — see externalTimestamp.
	Timestamp externalTimestamp `json:"timestamp"`
}

// externalTimestamp decodes the event's `timestamp` whatever JSON shape the
// bridge's runtime gave it.
//
// The value is Baileys' `msg.messageTimestamp`, a 64-bit long. JSON turns a long
// into a number in some builds and into `{low, high, unsigned}` in others (and a
// client may hand-write the seconds as a string), and a decoder that accepted only
// the number form would reject the entire event — losing the message, which is the
// one thing this path must never do. All three shapes are therefore read here, and
// the *unit* is settled separately by externalTimestampAt.
type externalTimestamp int64

func (t *externalTimestamp) UnmarshalJSON(data []byte) error {
	trimmed := strings.Trim(strings.TrimSpace(string(data)), `"`)
	if seconds, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
		*t = externalTimestamp(seconds)
		return nil
	}
	if seconds, err := strconv.ParseFloat(trimmed, 64); err == nil {
		*t = externalTimestamp(int64(seconds))
		return nil
	}
	// The protobufjs long: `low` is the unsigned low word, `high` the signed high
	// one, so the two together are the 64-bit value. A long of zero is still a long
	// — the next shape check would be an error, and whether a timestamp of zero is
	// usable is settled by externalTimestampAt, not here.
	if len(data) > 0 && data[0] == '{' {
		var long struct {
			Low  uint32 `json:"low"`
			High int32  `json:"high"`
		}
		if err := json.Unmarshal(data, &long); err == nil {
			*t = externalTimestamp(int64(long.High)<<32 | int64(long.Low))
			return nil
		}
	}
	return fmt.Errorf("timestamp %s is not a number of seconds", data)
}

// millisecondsEpoch is the first 13-digit Unix epoch: no WhatsApp message is
// dated past it for another 250 years, so a value at or beyond it is milliseconds.
const millisecondsEpoch = 10_000_000_000

// externalTimestampAt turns the event's timestamp into a UTC instant and reports
// whether it was taken as given.
//
// Ordering every read — the transcript, the day counters, the memory batches — hangs
// on this one field, so the two ways it can be wrong are handled here rather than
// stored: a millisecond value is 1000× a second one and would file the message
// ~50 000 years out, and a missing one would put it in 1970, before everything the
// group ever said. Either way the row is marked `partial` downstream, because a
// timestamp this worker had to repair means the bridge's contract moved.
func externalTimestampAt(value externalTimestamp, receivedAt time.Time) (time.Time, bool) {
	seconds := int64(value)
	switch {
	case seconds <= 0:
		return receivedAt, false
	case seconds >= millisecondsEpoch:
		return time.Unix(seconds/1000, 0).UTC(), false
	default:
		return time.Unix(seconds, 0).UTC(), true
	}
}

// externalKind maps the bridge's media type onto the worker's kind vocabulary
// (§5.1, §6.3.1).
//
// Each type is mapped onto the media node the worker's own vocabulary names, so the
// `kind` and `declaredType` a reader sees are the ones §5.1 defines.
//
// `ptt` is a push-to-talk *voice* note, which in this vocabulary is plain audio:
// the parser's `ptv` is a *video* note (classifyKind maps a ptvMessage to kind
// video with declaredType `ptv`), and the worker has no audio node that declares
// `ptv`. Inventing that pairing would put a declaredType on the row that every
// reader — the transcript badge, the media filters — reads as a video note. The
// bytes settle it anyway: the pipeline records `media.kind` from the container it
// actually stored (kindForMime), so an attachment that turns out to be a video is
// stored as one.
//
// A media type this build does not know (a newer bridge, or a hand-written client)
// yields no kind at all: the row is stored `unknown`/`partial`, and the bytes are
// still kept under whatever the sniffer says they are — the same bargain the parser
// strikes for a message variant it does not model.
func externalKind(evt externalEvent) (kind, mediaKind, declared Kind) {
	if !evt.HasMedia {
		if strings.TrimSpace(evt.Body) != "" {
			return KindText, "", ""
		}
		return KindUnknown, "", ""
	}
	switch strings.ToLower(strings.TrimSpace(evt.MediaType)) {
	case "image":
		return KindImage, KindImage, KindImage
	case "video":
		return KindVideo, KindVideo, KindVideo
	case "audio", "ptt":
		return KindAudio, KindAudio, KindAudio
	case "document":
		return KindDocument, KindDocument, KindDocument
	default:
		return KindUnknown, "", ""
	}
}

// externalText is the event's human-typed text.
//
// The bridge substitutes a placeholder body for an attachment with no caption
// (`[image received]`) so its own API never sees an empty message. That placeholder
// is presentation, not something the sender wrote, so it is dropped here: the row has
// to read like the row the parser writes for the same message — empty text, kind
// image — instead of gaining a caption the operator never sent and a phrase that
// `textSearch` would match.
func externalText(evt externalEvent) string {
	if evt.HasMedia && evt.Body == "["+evt.MediaType+" received]" {
		return ""
	}
	return evt.Body
}

// externalFileName recovers a document's original name from the cache path the
// bridge wrote it to.
//
// The event carries no file name, but the bridge keeps it inside the cache name
// (`doc_<hex>_invoice-2026.pdf`). The name is worth recovering: extensionForMime
// falls back to it for the generic containers (a ZIP that is really a workbook),
// and the transcript shows it. A cache name that does not follow that shape yields
// "", which is the honest answer for bytes that cannot be named.
func externalFileName(evt externalEvent) string {
	if !evt.HasMedia || !strings.EqualFold(strings.TrimSpace(evt.MediaType), "document") {
		return ""
	}
	for _, path := range evt.MediaURLs {
		rest, ok := strings.CutPrefix(filepath.Base(path), "doc_")
		if !ok {
			continue
		}
		if _, name, ok := strings.Cut(rest, "_"); ok && name != "" {
			return name
		}
	}
	return ""
}

// externalRaw keeps the bridge's own payload as the row's `raw` tree.
//
// The caps and the flattened search text are the ones the protobuf tree gets
// (pruneRaw, rawSearchText, RAW_JSON_MAX_BYTES), so an external row is searchable
// and inspectable exactly like an internal one — and a field this mapping does not
// model (a quote, the chat's label) stays readable because it is still in there.
func externalRaw(evt externalEvent) (RawMessage, string, error) {
	encoded, err := json.Marshal(evt)
	if err != nil {
		return RawMessage{}, "", fmt.Errorf("encode external event: %w", err)
	}
	var tree map[string]any
	if err := json.Unmarshal(encoded, &tree); err != nil {
		return RawMessage{}, "", fmt.Errorf("decode external event: %w", err)
	}
	raw := RawMessage{Message: tree, Bytes: len(encoded)}
	if len(encoded) > rawJSONMaxBytes {
		raw.Message, raw.Truncated = pruneRaw(tree, rawJSONMaxBytes)
	}
	return raw, rawSearchText(tree), nil
}

// externalDoc maps one bridge event onto the row §5.1 describes — the same search
// folding, link and mention extraction, and parse-time media descriptor the other
// producers used — because a forwarded message and a delivered one are the same
// message, and two row shapes for one thing would make every reader downstream of
// this collection branch on which door it came through.
//
// It fails only when the event cannot be identified. An event without a message id
// or without a chat is not a message, and storing it would put an unattributable row
// in a group's transcript; everything else — no text, no media, a media type this
// build does not know — is recorded `partial`, never dropped (R3).
func externalDoc(evt externalEvent, organizationID, instanceID string, receivedAt time.Time) (MessageDoc, error) {
	messageID := strings.TrimSpace(evt.MessageID)
	chatID := strings.TrimSpace(evt.ChatID)
	if messageID == "" || chatID == "" {
		return MessageDoc{}, fmt.Errorf("%w: event without a messageId or chatId", errInvalidRequest)
	}

	receivedAt = receivedAt.UTC()
	timestamp, dated := externalTimestampAt(evt.Timestamp, receivedAt)
	kind, mediaKind, declared := externalKind(evt)
	text := externalText(evt)

	parseErrors := []string{}
	if !dated {
		parseErrors = append(parseErrors, "event carried no usable timestamp; receivedAt was used instead")
	}
	if kind == KindUnknown {
		parseErrors = append(parseErrors, "no text and no recognized media type")
	}

	// The event's own payload is the row's evidence, so a payload that cannot be
	// turned into a tree is a partial record rather than a failure — the same
	// bargain the parser strikes for a tree it cannot marshal.
	raw, rawSearch, err := externalRaw(evt)
	if err != nil {
		parseErrors = append(parseErrors, err.Error())
	}

	doc := MessageDoc{
		OrganizationID: organizationID,
		InstanceID:     instanceID,
		// A group message's chat *is* the group, and a direct chat has no group, so
		// the chat JID is the group key either way — the convention persistDirect
		// uses for the same reason (a direct JID can never collide with a group's).
		GroupJID:     chatID,
		ChatJID:      chatID,
		IsGroup:      evt.IsGroup,
		WaMessageID:  messageID,
		SenderJID:    strings.TrimSpace(evt.SenderID),
		PushName:     evt.SenderName,
		FromMe:       evt.FromMe,
		Timestamp:    timestamp,
		ReceivedAt:   receivedAt,
		ServerSkewMs: receivedAt.Sub(timestamp).Milliseconds(),
		Kind:         kind,
		Text:         text,
		TextSearch:   foldText(text),
		Links:        collectLinks(text),
		Mentions:     dedupeStrings(evt.MentionedIDs),
		// Status and kind are what the parser can know before the bytes exist; the
		// outcome replaces them once storeMedia has run (§6.3.1).
		Media:         Media{Status: MediaNone, Kind: mediaKind, DeclaredType: declared, FileName: externalFileName(evt)},
		Raw:           raw,
		RawSearch:     rawSearch,
		ParseState:    ParseOK,
		ParseErrors:   parseErrors,
		SchemaVersion: messageSchemaVersion,
	}
	if evt.HasMedia {
		doc.Media.Status = MediaPending
	}
	if len(parseErrors) > 0 {
		doc.ParseState = ParsePartial
	}
	return doc, nil
}

// errIngestClosed is the answer to an event this worker will not accept: the
// process is shutting down, or the Hermes ingest path was never configured. Both
// mean "send this somewhere else", which is what the route answers with 503.
var errIngestClosed = errors.New("this worker is not accepting Hermes events")

// externalIngest is the Hermes side of ingestion (§6.2): it maps one event onto a
// `messages` row and stores the attachment that came with it, under the worker's
// own object key — the bytes never pass through the BFF.
type externalIngest struct {
	orgID      string
	instanceID string
	// dataDir is the host mount of the Hermes container's data volume
	// (HERMES_DATA_DIR). Empty means the worker reads the same filesystem the bridge
	// wrote to, so the container path is already valid.
	dataDir  string
	uploader *r2Client
	store    mediaStore
	// limits is the §6.3.2 media policy (MEDIA_MAX_BYTES, MEDIA_DOWNLOAD_TIMEOUT,
	// MEDIA_CONCURRENCY). This path opens a file the bridge already wrote and puts
	// it to R2, so the pipeline it builds is the only one the worker runs.
	limits *mediaLimits
	now    func() time.Time
}

// newExternalIngest builds the path from the process configuration. `uploader` is
// newR2's answer: nil means object storage is not configured, and every attachment
// is then recorded `unavailable` rather than claimed as stored (§6.9).
func newExternalIngest(cfg Config, store mediaStore, uploader *r2Client) *externalIngest {
	return &externalIngest{
		orgID:      cfg.OrganizationID,
		instanceID: cfg.HermesInstanceID,
		dataDir:    strings.TrimSuffix(strings.TrimSpace(cfg.HermesDataDir), "/"),
		uploader:   uploader,
		store:      store,
		limits:     newMediaLimits(cfg),
		now:        func() time.Time { return now().UTC() },
	}
}

// doc maps one event and stores the attachment it carries, returning the row to
// persist.
func (x *externalIngest) doc(ctx context.Context, evt externalEvent) (MessageDoc, error) {
	receivedAt := x.now()
	doc, err := externalDoc(evt, x.orgID, x.instanceID, receivedAt)
	if err != nil {
		return MessageDoc{}, err
	}
	x.storeMedia(ctx, &doc, evt, receivedAt)
	return doc, nil
}

// storeMedia stores the one attachment the event carries and fills `media`.
//
// The work is the media pipeline's (§6.3), with the bridge's cache file standing in
// for the WhatsApp download: the same byte cap enforced while reading, the same
// sniffing (the bytes decide the MIME and the kind, never a declared value), the same
// object key, and the same descriptor sidecar. Failures are classified by the
// pipeline's policy too, and each outcome means what it says: an unreadable cache file
// and a failed put are `failed` — a redelivery of the same message brings fresh bytes,
// so that record is worth retrying — bytes past MEDIA_MAX_BYTES are
// `unavailable`/`too_large`, and a container nothing can identify is `unparsed`, with
// the bytes still kept as an opaque object (§6.3.4). Nothing retries these rows — the
// bridge downloads an attachment once, and a redelivery of the same message is what
// brings fresh bytes — so what the status buys is the dashboard's honest answer, not
// a background repair.
func (x *externalIngest) storeMedia(ctx context.Context, doc *MessageDoc, evt externalEvent, at time.Time) {
	if doc.Media.Status != MediaPending {
		return
	}
	if x.uploader == nil {
		doc.Media = externalMediaUnavailable(doc.Media, "media storage is not configured (no R2 credentials)")
		return
	}
	path, err := x.hostPath(firstMediaPath(evt))
	if err != nil {
		doc.Media = externalMediaUnavailable(doc.Media, err.Error())
		return
	}
	pipeline := newMediaPipeline(x.limits, externalFileDownloader{path: path}, x.uploader, x.orgID, x.instanceID, at)
	doc.Media = pipeline.Store(ctx, MediaDescriptor{
		Kind:         doc.Media.Kind,
		DeclaredType: doc.Media.DeclaredType,
		FileName:     doc.Media.FileName,
		MessageID:    doc.WaMessageID,
		GroupJID:     doc.GroupJID,
	})
}

// firstMediaPath is the attachment the event carries. The array holds the single
// file the bridge wrote for the single media node the message had; an event whose
// array is empty is one whose download failed in the bridge, which storeMedia
// records as unavailable.
func firstMediaPath(evt externalEvent) string {
	if len(evt.MediaURLs) == 0 {
		return ""
	}
	return evt.MediaURLs[0]
}

// externalMediaUnavailable ends an attachment record that never reached the bucket.
// `download_failed` is the vocabulary's value for "the bytes could not be obtained":
// the other candidates say something specific that is not true here (nothing
// expired, nothing was a view-once, nothing was too large), and the cause itself is
// kept in `media.error` for an operator.
func externalMediaUnavailable(m Media, cause string) Media {
	m.Status = MediaUnavailable
	m.Reason = reasonDownloadFailed
	m.Error = cause
	m.R2Key, m.PublicURL = "", ""
	return m
}

// externalFileDownloader hands the media pipeline the bytes the bridge already
// wrote. It is the pipeline's only source: everything downstream of the read is the
// same code either way (§6.3.2).
type externalFileDownloader struct{ path string }

// Download opens the cache file. The pipeline copies it under MEDIA_MAX_BYTES and
// closes it, so nothing here has to bound the read itself.
func (d externalFileDownloader) Download(context.Context, MediaDescriptor) (io.ReadCloser, error) {
	file, err := os.Open(d.path)
	if err != nil {
		return nil, fmt.Errorf("read hermes attachment: %w", err)
	}
	return file, nil
}

// hermesContainerDataDir is the bridge's HOME inside the Hermes container: every
// attachment path it reports lives below it.
const hermesContainerDataDir = "/opt/data"

// hostPath resolves one attachment path the bridge reported into a path this
// process can read.
//
// The bridge writes attachments under its own container HOME, so the path arrives in
// the container's namespace. HERMES_DATA_DIR names the host directory that volume is
// mounted at, and the container prefix is remapped onto it; with it unset — the
// worker reading the same filesystem the bridge wrote to — the path is used as it
// arrived.
//
// Either way the result has to stay below the root. The path travels over HTTP, so
// an unchecked one would be a file-read primitive: `filepath.Clean` resolves `..`
// first and the prefix test then rejects anything that left the root — the worker's
// own auth database, say (§11.4: bytes we did not produce are untrusted).
func (x *externalIngest) hostPath(raw string) (string, error) {
	path := filepath.Clean(strings.TrimSpace(raw))
	if !strings.HasPrefix(path, hermesContainerDataDir+"/") {
		return "", fmt.Errorf("attachment path %q is not below %s", raw, hermesContainerDataDir)
	}
	if x.dataDir == "" {
		return path, nil
	}
	return filepath.Clean(x.dataDir + strings.TrimPrefix(path, hermesContainerDataDir)), nil
}

// recordSaved writes the media subdocument for the documents a flush persisted whose
// bytes this path stored itself.
//
// Save writes the parse-time descriptor (status, kind, declaredType) when it creates
// the row and nothing else about `media`: the subdocument belongs to whoever stored
// the bytes, afterwards. This path stores the bytes before the row exists, so its
// outcome is recorded the same way — after the row does (§6.3.1). Without it an
// attachment would sit `stored` with no key, no size and no digest: a row promising
// bytes nothing can fetch.
func (x *externalIngest) recordSaved(docs []MessageDoc) {
	if x == nil || x.store == nil {
		return
	}
	observed := make([]MessageDoc, 0, len(docs))
	for _, doc := range docs {
		if externalStoredMedia(doc.Media) {
			observed = append(observed, doc)
		}
	}
	if len(observed) == 0 {
		return
	}
	// Off the flush path: this runs on the ingest goroutine, where one round trip per
	// attachment would delay every message behind it. The documents are already
	// durable, so nothing here has to finish before the caller returns.
	go func() {
		// Its own context: the flush may be running because the process is leaving,
		// and the write it already paid for must still land.
		ctx, cancel := context.WithTimeout(context.Background(), ingestFlushTimeout)
		defer cancel()
		for _, doc := range observed {
			if err := x.store.saveMedia(ctx, doc, doc.Media); err != nil {
				logf("external media %s: record outcome: %v", doc.WaMessageID, err)
			}
		}
	}()
}

// externalStoredMedia reports whether a document carries a media outcome this path
// produced. Ingest only ever enqueues `none` (no attachment) and `pending` (bytes the
// media runner has yet to fetch), so any other value can only come from an event whose
// attachment was stored — or refused — here.
func externalStoredMedia(m Media) bool {
	switch m.Status {
	case MediaStored, MediaUnparsed, MediaUnavailable, MediaFailed:
		return true
	default:
		return false
	}
}

// ingestExternalEvent accepts one event from the Hermes bridge (§6.2).
//
// The queue is asked first: an event that cannot be stored must not cost a file read
// and an upload before it is refused, because a worker on its way out would otherwise
// spend its last seconds storing attachments for rows it is about to drop. Between
// that check and the handover the consumer may still stop, and a handover nothing will
// read is counted on the queue as a drop rather than reported as accepted.
//
// The instance id comes from configuration and is the seam for multi-instance support:
// the day one worker serves two bridges, it becomes a field of the request and this
// argument is where it would enter.
//
// Nothing here re-decides what may be kept. The worker's own gates — an assigned and
// whitelisted group, an authorized owner for a direct chat — exist because the worker
// used to be what talked to WhatsApp, and it had to be kept away from conversations it
// was not pointed at. Hermes owns that decision now, and the whole point of this path
// is that a message the agent declines is still recorded, so the gate is deliberately
// not repeated: a deployment that wants it back applies it here. `AutoReplyCandidate`
// is likewise left unset — the agent already answers what it answers, and marking these
// rows would have the BFF's reply path answer a second time.
func (m *manager) ingestExternalEvent(ctx context.Context, evt externalEvent) error {
	if m.external == nil || m.ingest == nil || m.ingest.Stopped() {
		return errIngestClosed
	}
	doc, err := m.external.doc(ctx, evt)
	if err != nil {
		return err
	}
	m.ingest.Enqueue(doc)
	return nil
}

// afterIngestFlush is what follows a flush that landed: the messages asking for a
// reply are delivered, an attachment the Hermes path stored for itself gets its
// media subdocument written — the row has to exist before `media.*` can be
// recorded — and the attachment outcomes reach the §10 counters.
//
// The media counter used to move with the runner that downloaded from WhatsApp.
// This is the same number for the one ingest path that exists: an outcome is
// already final when the document is enqueued, because this path stores the bytes
// on the way in, so the flush is the first moment it can be counted.
//
// The queue has one afterSave seam and this is it. None of the three may stall the
// ingest goroutine: the first two hand their work to their own goroutine and
// return, and so does the third (countMediaOutcomes).
func (m *manager) afterIngestFlush(docs []MessageDoc) {
	m.deliverSavedReplies(docs)
	m.external.recordSaved(docs)
	m.countMediaOutcomes(docs)
}
