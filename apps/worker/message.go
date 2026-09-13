package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/encoding/protojson"
)

// Kind is the message vocabulary of `messages.kind` (docs/architecture-draft.md
// §5.1). Media kinds reuse the same string domain and add the two values only a
// media node can have: `ptv` (a video note) and `raw` (bytes we hold but cannot
// identify).
type Kind string

const (
	KindText     Kind = "text"
	KindImage    Kind = "image"
	KindVideo    Kind = "video"
	KindAudio    Kind = "audio"
	KindDocument Kind = "document"
	KindSticker  Kind = "sticker"
	KindLocation Kind = "location"
	KindContact  Kind = "contact"
	KindPoll     Kind = "poll"
	KindReaction Kind = "reaction"
	KindSystem   Kind = "system"
	KindRevoked  Kind = "revoked"
	KindUnknown  Kind = "unknown"

	// Media-only kinds and declared types (§6.3.1).
	KindPtv          Kind = "ptv"
	KindRaw          Kind = "raw"
	declaredViewOnce Kind = "view_once"
)

// MediaStatus is the worker-owned lifecycle of one attachment (§6.3.1). Ingest
// only ever writes `none` (no media node) and `pending` (descriptor recorded,
// bytes not fetched yet); the media pipeline owns the later transitions.
type MediaStatus string

const (
	MediaNone        MediaStatus = "none"
	MediaPending     MediaStatus = "pending"
	MediaStored      MediaStatus = "stored"
	MediaUnparsed    MediaStatus = "unparsed"
	MediaUnavailable MediaStatus = "unavailable"
	MediaFailed      MediaStatus = "failed"
)

// ParseState records how much of a message the worker understood. `partial` is
// still persisted: R3 requires the message to be recorded even when the worker
// cannot classify it.
type ParseState string

const (
	ParseOK      ParseState = "ok"
	ParsePartial ParseState = "partial"
	ParseFailed  ParseState = "failed"
)

// messageSchemaVersion is stamped into `parse.version` so a later re-parse pass
// can tell which parser produced a document (§6.4).
const messageSchemaVersion = 1

// messageWrapperDepth caps the future-proof unwrapping. Wrappers nest (an
// ephemeral view-once document with a caption is three deep), and the cap keeps
// a malformed tree from looping.
const messageWrapperDepth = 8

// Raw-tree caps are the parser's effective limits (§6.4). parseInbound keeps a
// two-argument signature — it runs in the event handler, not in configuration —
// so the limits live here and the process binds its configuration to them once
// with applyRawLimits.
var (
	rawJSONMaxBytes   = 32768
	rawSearchMaxBytes = 8192
)

// applyRawLimits binds the process configuration to the parser's raw-tree caps.
// Config.validate has already rejected non-positive caps, so this is a plain
// assignment rather than a second validation of the same values.
func applyRawLimits(cfg Config) {
	rawJSONMaxBytes = cfg.RawJSONMaxBytes
	rawSearchMaxBytes = cfg.RawSearchMax
}

// Media is the worker-owned attachment subdocument (§5.1, §6.3). Ingest fills
// status, kind and declaredType; the media pipeline fills the rest.
type Media struct {
	Status       MediaStatus
	Kind         Kind
	DeclaredType Kind
	Mime         string
	FileName     string
	Size         int64
	SHA256       string
	Width        int
	Height       int
	DurationSec  float64
	R2Key        string
	PublicURL    string
	Reason       string
	Error        string
	Attempts     int
}

// RawMessage is the protobuf-derived message tree kept for re-parsing (§6.4).
// Bytes always reports the size of the full serialization, so a truncated tree
// is distinguishable from a message that really was that small.
type RawMessage struct {
	Message   map[string]any
	Truncated bool
	Bytes     int
}

// MessageDoc is one row of `messages` (§5.1). Field names here are the Go
// spelling; ingest.go owns the MongoDB spelling.
type MessageDoc struct {
	OrganizationID string
	InstanceID     string
	GroupJID       string
	ChatJID        string
	IsGroup        bool
	WaMessageID    string
	SenderJID      string
	SenderLID      string
	PushName       string
	FromMe         bool
	Timestamp      time.Time
	ReceivedAt     time.Time
	ServerSkewMs   int64

	Kind       Kind
	Text       string
	TextSearch string
	RawSearch  string
	Links      []string
	Mentions   []string

	Media Media
	Raw   RawMessage

	// Historical marks a message replayed from the phone's backfill rather than
	// observed live (§6.2). It is a property of first arrival and is persisted
	// as `flags.historical`.
	Historical bool

	ParseState    ParseState
	ParseErrors   []string
	SchemaVersion int
}

// parseInbound normalizes one WhatsApp message event into the document the
// worker persists. It fails only when the event cannot be identified: a
// message the parser does not understand is stored as unknown/partial, never
// dropped (R3).
func parseInbound(evt *events.Message, organizationID, instanceID string) (MessageDoc, error) {
	if evt == nil || evt.Info.ID == "" {
		return MessageDoc{}, errors.New("message event without an id")
	}

	// WhatsApp's timestamp is the ordering key; receivedAt exists only to make
	// clock skew diagnosable (§6.2).
	timestamp := evt.Info.Timestamp.UTC()
	receivedAt := time.Now().UTC()

	// Wrappers (ephemeral, view-once, edited, document-with-caption) hold the
	// node the user actually sent; classification and text extraction need the
	// inner one, while `raw` keeps the tree exactly as it arrived.
	inner, viewOnce := unwrapMessage(evt.Message)
	kind, mediaKind, declared := classifyKind(inner)
	if viewOnce && mediaKind != "" {
		declared = declaredViewOnce
	}

	text := extractText(inner)
	raw, rawSearch, rawErr := rawFields(evt.Message)

	doc := MessageDoc{
		OrganizationID: organizationID,
		InstanceID:     instanceID,
		ChatJID:        evt.Info.Chat.String(),
		WaMessageID:    string(evt.Info.ID),
		SenderJID:      evt.Info.Sender.String(),
		SenderLID:      senderLID(evt.Info.MessageSource),
		PushName:       evt.Info.PushName,
		FromMe:         evt.Info.IsFromMe,
		IsGroup:        evt.Info.IsGroup,
		Timestamp:      timestamp,
		ReceivedAt:     receivedAt,
		ServerSkewMs:   receivedAt.Sub(timestamp).Milliseconds(),
		Kind:           kind,
		Text:           text,
		TextSearch:     foldText(text),
		Links:          collectLinks(text),
		Mentions:       collectMentionedJIDs(evt.Message),
		Media:          Media{Status: MediaNone, DeclaredType: declared},
		Raw:            raw,
		RawSearch:      rawSearch,
		ParseState:     ParseOK,
		ParseErrors:    []string{},
		SchemaVersion:  messageSchemaVersion,
	}
	if evt.Info.IsGroup {
		// A group message's chat *is* the group, so the group key is derived
		// rather than read from a second source that could disagree.
		doc.GroupJID = evt.Info.Chat.String()
	}
	if mediaKind != "" {
		doc.Media.Status = MediaPending
		doc.Media.Kind = mediaKind
	}

	switch {
	case evt.Message == nil:
		doc.ParseState = ParsePartial
		doc.ParseErrors = append(doc.ParseErrors, "event carried no message payload")
	case kind == KindUnknown:
		doc.ParseState = ParsePartial
		doc.ParseErrors = append(doc.ParseErrors, "unrecognized message variant")
	}
	if rawErr != nil {
		doc.ParseState = ParsePartial
		doc.ParseErrors = append(doc.ParseErrors, rawErr.Error())
	}
	return doc, nil
}

// senderLID returns the LID form of the sender. An account is addressed either
// by phone number or by LID, and whatsmeow puts the other form in SenderAlt, so
// the sender is stored both ways (§6.1) whichever one the message used.
func senderLID(source types.MessageSource) string {
	if source.Sender.Server == types.HiddenUserServer {
		return source.Sender.String()
	}
	if source.SenderAlt.Server == types.HiddenUserServer {
		return source.SenderAlt.String()
	}
	return ""
}

// unwrapMessage peels the future-proof wrappers WhatsApp uses for ephemeral,
// view-once, edited and caption-bearing documents so classification sees the
// node the user sent. It reports whether any wrapper claimed view-once, which
// is what `media.declaredType` has to say even though the inner node is an
// ordinary image or video (§6.3.1).
func unwrapMessage(msg *waE2E.Message) (*waE2E.Message, bool) {
	viewOnce := false
	for range messageWrapperDepth {
		if msg == nil {
			return nil, viewOnce
		}
		var next *waE2E.Message
		switch {
		case msg.GetViewOnceMessage() != nil:
			next, viewOnce = msg.GetViewOnceMessage().GetMessage(), true
		case msg.GetViewOnceMessageV2() != nil:
			next, viewOnce = msg.GetViewOnceMessageV2().GetMessage(), true
		case msg.GetViewOnceMessageV2Extension() != nil:
			next, viewOnce = msg.GetViewOnceMessageV2Extension().GetMessage(), true
		case msg.GetEphemeralMessage() != nil:
			next = msg.GetEphemeralMessage().GetMessage()
		case msg.GetDocumentWithCaptionMessage() != nil:
			next = msg.GetDocumentWithCaptionMessage().GetMessage()
		case msg.GetEditedMessage() != nil:
			next = msg.GetEditedMessage().GetMessage()
		default:
			return msg, viewOnce
		}
		if next == nil {
			// A wrapper with no payload is all we were given; returning it keeps
			// the document recording what WhatsApp sent instead of an empty one.
			return msg, viewOnce
		}
		msg = next
	}
	return msg, viewOnce
}

// classifyKind maps one unwrapped message node to the document kind and the
// media it declares. mediaKind is empty when the node carries no downloadable
// media, and declared is empty when WhatsApp declared no media type at all;
// a poll declares `poll` without having bytes to fetch.
func classifyKind(msg *waE2E.Message) (kind, mediaKind, declared Kind) {
	switch {
	case msg == nil:
		return KindUnknown, "", ""
	case msg.GetConversation() != "" || msg.GetExtendedTextMessage() != nil:
		return KindText, "", ""
	case msg.GetListResponseMessage() != nil || msg.GetButtonsResponseMessage() != nil ||
		msg.GetTemplateButtonReplyMessage() != nil || msg.GetInteractiveResponseMessage() != nil:
		// A tapped control — list row, quick reply, or native flow — is user
		// input: it is recorded as text so a button press is a readable message
		// instead of an empty row (§6.2).
		return KindText, "", ""
	case msg.GetPtvMessage() != nil:
		// A video note is a video document whose media kind is its own (§5.1).
		return KindVideo, KindPtv, KindPtv
	case msg.GetVideoMessage() != nil:
		return KindVideo, KindVideo, KindVideo
	case msg.GetImageMessage() != nil:
		return KindImage, KindImage, KindImage
	case msg.GetAudioMessage() != nil:
		return KindAudio, KindAudio, KindAudio
	case msg.GetDocumentMessage() != nil:
		return KindDocument, KindDocument, KindDocument
	case msg.GetStickerMessage() != nil:
		return KindSticker, KindSticker, KindSticker
	case msg.GetLocationMessage() != nil || msg.GetLiveLocationMessage() != nil:
		return KindLocation, "", ""
	case msg.GetContactMessage() != nil || msg.GetContactsArrayMessage() != nil:
		return KindContact, "", ""
	case isPollNode(msg):
		return KindPoll, "", KindPoll
	case msg.GetReactionMessage() != nil || msg.GetEncReactionMessage() != nil:
		return KindReaction, "", ""
	case msg.GetProtocolMessage() != nil:
		if msg.GetProtocolMessage().GetType() == waE2E.ProtocolMessage_REVOKE {
			return KindRevoked, "", ""
		}
		return KindSystem, "", ""
	case msg.GetCallLogMesssage() != nil || msg.GetCall() != nil:
		return KindSystem, "", ""
	default:
		// Every variant this parser does not model ends up here. That is a
		// recorded, visibly incomplete document — the alternative was dropping
		// group activity (R3).
		return KindUnknown, "", ""
	}
}

// isPollNode reports whether the node is any generation of poll message. Polls
// are versioned per WhatsApp release (V1..V6 plus snapshots), and a poll the
// worker does not recognize is still a poll to the group.
func isPollNode(msg *waE2E.Message) bool {
	return msg.GetPollCreationMessage() != nil ||
		msg.GetPollCreationMessageV2() != nil ||
		msg.GetPollCreationMessageV3() != nil ||
		msg.GetPollCreationMessageV4() != nil ||
		msg.GetPollCreationMessageV5() != nil ||
		msg.GetPollCreationMessageV6() != nil ||
		msg.GetPollUpdateMessage() != nil ||
		msg.GetPollResultSnapshotMessage() != nil ||
		msg.GetPollResultSnapshotMessageV3() != nil
}

// extractText returns the message's human-typed text: a body, a caption, or the
// label of a tapped control. Messages with no text of their own return "" — the
// document still records their kind and raw tree.
func extractText(msg *waE2E.Message) string {
	switch {
	case msg.GetConversation() != "":
		return msg.GetConversation()
	case msg.GetExtendedTextMessage().GetText() != "":
		return msg.GetExtendedTextMessage().GetText()
	case msg.GetImageMessage().GetCaption() != "":
		return msg.GetImageMessage().GetCaption()
	case msg.GetVideoMessage().GetCaption() != "":
		return msg.GetVideoMessage().GetCaption()
	case msg.GetPtvMessage().GetCaption() != "":
		return msg.GetPtvMessage().GetCaption()
	case msg.GetDocumentMessage().GetCaption() != "":
		return msg.GetDocumentMessage().GetCaption()
	case msg.GetListResponseMessage().GetTitle() != "":
		// The row the user tapped lives in SingleSelectReply, but the message
		// title is the label WhatsApp renders; storing it is what keeps a
		// single-select answer from being an empty message.
		return msg.GetListResponseMessage().GetTitle()
	case msg.GetButtonsResponseMessage().GetSelectedDisplayText() != "":
		return msg.GetButtonsResponseMessage().GetSelectedDisplayText()
	case msg.GetTemplateButtonReplyMessage().GetSelectedDisplayText() != "":
		return msg.GetTemplateButtonReplyMessage().GetSelectedDisplayText()
	}
	return interactiveResponseText(msg)
}

// nativeFlowLabelKeys are the keys a native flow response carries the tapped
// label under, and nativeFlowIDKeys the ones a client that omits the label
// falls back to. The plural keys hold a multi-select's labels.
var (
	nativeFlowLabelKeys = []string{
		"selectedDisplayText", "selected_display_text",
		"display_text", "displayText",
		"selectedDisplayTexts", "selected_display_texts",
		"title", "text",
	}
	nativeFlowIDKeys = []string{"selectedId", "selected_id", "id"}
)

// interactiveResponseText returns the readable label of a tapped native flow
// control (list row, quick reply, or a flow form submission). The label travels
// in body.text and the machine payload in paramsJson holds it again; clients in
// the wild use camelCase, snake_case, a plain id, or nothing readable at all.
// Without this a native flow tap was recorded as an empty unknown message even
// though §6.2 requires every variant to be stored readably.
func interactiveResponseText(msg *waE2E.Message) string {
	response := msg.GetInteractiveResponseMessage()
	if response == nil {
		return ""
	}
	if body := response.GetBody().GetText(); body != "" {
		return body
	}
	params := response.GetNativeFlowResponseMessage().GetParamsJSON()
	if label := nativeFlowLabel(params); label != "" {
		return label
	}
	// A flow payload with no label we recognize is still the only record of what
	// the user submitted, so the payload itself is kept rather than nothing.
	return params
}

// nativeFlowLabel reads the label out of a paramsJson payload. It returns "" when
// the payload is not JSON or holds no readable value at all.
func nativeFlowLabel(params string) string {
	if params == "" {
		return ""
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(params), &parsed); err != nil {
		return ""
	}
	for _, keys := range [][]string{nativeFlowLabelKeys, nativeFlowIDKeys} {
		for _, key := range keys {
			switch value := parsed[key].(type) {
			case string:
				if strings.TrimSpace(value) != "" {
					return value
				}
			case []any:
				if labels := stringItems(value); len(labels) > 0 {
					return strings.Join(labels, ", ")
				}
			}
		}
	}
	return ""
}

// stringItems returns the non-empty strings of a decoded JSON array.
func stringItems(items []any) []string {
	labels := make([]string, 0, len(items))
	for _, item := range items {
		if label, ok := item.(string); ok && strings.TrimSpace(label) != "" {
			labels = append(labels, label)
		}
	}
	return labels
}

// foldText builds `textSearch`: case-folded, punctuation turned into word
// boundaries, whitespace collapsed. Punctuation becomes a space rather than
// disappearing so "deploy-green" still matches a search for "deploy green"
// (§6.4).
func foldText(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToLower(s) {
		switch {
		case unicode.IsLetter(r) || unicode.IsNumber(r):
			b.WriteRune(r)
		default:
			b.WriteRune(' ')
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// allContextInfos returns the ContextInfo of every message variant walked below.
// Quotes, mentions and forwarding metadata live on the variant, so a variant this
// list does not walk would silently lose them (§6.1).
func allContextInfos(msg *waE2E.Message) []*waE2E.ContextInfo {
	if msg == nil {
		return nil
	}
	var out []*waE2E.ContextInfo
	add := func(ci *waE2E.ContextInfo) {
		if ci != nil {
			out = append(out, ci)
		}
	}
	add(msg.GetExtendedTextMessage().GetContextInfo())
	add(msg.GetImageMessage().GetContextInfo())
	add(msg.GetVideoMessage().GetContextInfo())
	add(msg.GetPtvMessage().GetContextInfo())
	add(msg.GetAudioMessage().GetContextInfo())
	add(msg.GetDocumentMessage().GetContextInfo())
	add(msg.GetStickerMessage().GetContextInfo())
	add(msg.GetLocationMessage().GetContextInfo())
	add(msg.GetLiveLocationMessage().GetContextInfo())
	add(msg.GetContactMessage().GetContextInfo())
	add(msg.GetContactsArrayMessage().GetContextInfo())
	add(msg.GetGroupInviteMessage().GetContextInfo())
	add(msg.GetListMessage().GetContextInfo())
	add(msg.GetListResponseMessage().GetContextInfo())
	add(msg.GetButtonsMessage().GetContextInfo())
	add(msg.GetButtonsResponseMessage().GetContextInfo())
	add(msg.GetTemplateMessage().GetContextInfo())
	add(msg.GetTemplateButtonReplyMessage().GetContextInfo())
	add(msg.GetInteractiveMessage().GetContextInfo())
	add(msg.GetInteractiveResponseMessage().GetContextInfo())
	add(msg.GetProductMessage().GetContextInfo())
	add(msg.GetOrderMessage().GetContextInfo())
	add(msg.GetCall().GetContextInfo())
	add(msg.GetEventMessage().GetContextInfo())
	add(msg.GetEventInviteMessage().GetContextInfo())
	add(msg.GetPollCreationMessage().GetContextInfo())
	add(msg.GetPollCreationMessageV2().GetContextInfo())
	add(msg.GetPollCreationMessageV3().GetContextInfo())
	add(msg.GetPollCreationMessageV5().GetContextInfo())
	add(msg.GetPollCreationMessageV6().GetContextInfo())
	add(msg.GetPollResultSnapshotMessage().GetContextInfo())
	add(msg.GetPollResultSnapshotMessageV3().GetContextInfo())
	add(msg.GetRequestPhoneNumberMessage().GetContextInfo())
	add(msg.GetMessageHistoryBundle().GetContextInfo())
	add(msg.GetMessageHistoryNotice().GetContextInfo())
	add(msg.GetAlbumMessage().GetContextInfo())
	add(msg.GetStickerPackMessage().GetContextInfo())
	add(msg.GetSplitPaymentMessage().GetContextInfo())
	add(msg.GetNewsletterAdminInviteMessage().GetContextInfo())
	add(msg.GetNewsletterFollowerInviteMessageV2().GetContextInfo())
	add(msg.GetRichResponseMessage().GetContextInfo())
	// The wrappers add a level: a mention inside an ephemeral, view-once or
	// poll-wrapper message is still a mention.
	for _, wrapper := range []*waE2E.FutureProofMessage{
		msg.GetViewOnceMessage(),
		msg.GetViewOnceMessageV2(),
		msg.GetViewOnceMessageV2Extension(),
		msg.GetEphemeralMessage(),
		msg.GetDocumentWithCaptionMessage(),
		msg.GetEditedMessage(),
		msg.GetPollCreationMessageV4(),
	} {
		if wrapper != nil {
			out = append(out, allContextInfos(wrapper.GetMessage())...)
		}
	}
	return out
}

// collectMentionedJIDs returns the JIDs the message explicitly mentioned.
func collectMentionedJIDs(msg *waE2E.Message) []string {
	var jids []string
	for _, ci := range allContextInfos(msg) {
		jids = append(jids, ci.GetMentionedJID()...)
	}
	return dedupeStrings(jids)
}

// linkPattern matches a bare or scheme-qualified URL in message text. The
// character class stops at whitespace and at the quotes/angle brackets a
// message cannot contain raw.
var linkPattern = regexp.MustCompile(`(?i)\b(?:https?://|www\.)[^\s"'<>]+`)

// collectLinks extracts the links of one text body, without the sentence
// punctuation that usually follows a link.
func collectLinks(text string) []string {
	matches := linkPattern.FindAllString(text, -1)
	links := make([]string, 0, len(matches))
	for _, match := range matches {
		links = append(links, strings.TrimRight(match, ".,;:!?"))
	}
	return dedupeStrings(links)
}

// dedupeStrings drops the empty strings and repeats a parse can produce (a
// forwarded message repeats its mention list per variant) while keeping the
// order in which they first appeared.
func dedupeStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

// rawBytesPrefix is what a truncated tree is reduced to when even its keys do
// not fit the cap.
const rawBytesPrefix = "<truncated>"

// rawFields serializes the message tree once (bytes as base64, enums by name)
// and returns both the stored `raw` subdocument and the flattened search text
// derived from it. The tree is pruned to the cap, and the search text is
// collected under its own cap while walking it, so a pathological payload cannot
// approach the document limit or the parse cost. `Bytes` always reports the full
// size so an operator can see how much was dropped (§6.4).
func rawFields(msg *waE2E.Message) (RawMessage, string, error) {
	if msg == nil {
		return RawMessage{Message: map[string]any{}}, "", nil
	}
	encoded, err := protojson.Marshal(msg)
	if err != nil {
		return RawMessage{}, "", fmt.Errorf("marshal raw message: %w", err)
	}
	var tree map[string]any
	if err := json.Unmarshal(encoded, &tree); err != nil {
		return RawMessage{}, "", fmt.Errorf("decode raw message: %w", err)
	}
	raw := RawMessage{Message: tree, Bytes: len(encoded)}
	if len(encoded) > rawJSONMaxBytes {
		raw.Message, raw.Truncated = pruneRaw(tree, rawJSONMaxBytes)
	}
	// The search text comes from the tree as it arrived, not from the pruned
	// copy: the point of `rawSearch` is to find a message whose stored tree had
	// to be cut down to fit.
	return raw, rawSearchText(tree), nil
}

// pruneRaw keeps the entries whose serialization fits the budget, in the same
// sortRawKeys order the search text uses: when the cap forces a choice, the
// caption is worth more than the base64 payload beside it. That order is total,
// so the same message always yields the same stored tree and two re-parses stay
// diffable. When even the largest entry that fits leaves no room, the tree is
// reduced to a marker rather than an empty object.
func pruneRaw(tree map[string]any, max int) (map[string]any, bool) {
	keys := make([]string, 0, len(tree))
	for key := range tree {
		keys = append(keys, key)
	}
	sortRawKeys(keys)

	kept := make(map[string]any, len(tree))
	used := 2 // the enclosing braces
	for _, key := range keys {
		// The per-entry estimate is the exact serialized cost of an entry that
		// is followed by another one, so the budget can never be overshot.
		size := len(key) + 4
		if value, err := json.Marshal(tree[key]); err == nil {
			size += len(value)
		}
		if used+size > max {
			continue
		}
		kept[key] = tree[key]
		used += size
	}
	if len(kept) == 0 {
		// Everything was too large: storing the reason is more useful than
		// storing an empty object that looks like a message with no content.
		return map[string]any{rawBytesPrefix: map[string]any{}}, true
	}
	return kept, len(kept) != len(tree)
}

// sortRawKeys orders the keys of a protobuf-derived node. The comparison is
// case-insensitive so the readable fields sort before the media payloads:
// protojson emits `caption` alongside `JPEGThumbnail`/`fileSha256`, and byte
// order would put the base64 blob first and spend a tight byte cap entirely on
// noise. The raw key breaks ties, so the order is total and identical across
// re-parses.
func sortRawKeys(keys []string) {
	sort.Slice(keys, func(i, j int) bool {
		lowerI, lowerJ := strings.ToLower(keys[i]), strings.ToLower(keys[j])
		if lowerI == lowerJ {
			return keys[i] < keys[j]
		}
		return lowerI < lowerJ
	})
}

// rawSearchText flattens the string leaves of the message tree into searchable
// text (R4). It walks the tree as it arrived rather than the stored, possibly
// pruned copy: the point of `rawSearch` is to find a message whose stored tree
// had to be cut down to fit.
func rawSearchText(tree map[string]any) string {
	text := newBoundedText(rawSearchMaxBytes)
	collectStringLeaves(tree, text)
	return text.String()
}

// collectStringLeaves appends every string leaf in sortRawKeys order and stops as
// soon as the cap is reached, so a payload far larger than the cap is never
// walked to the end.
func collectStringLeaves(value any, out *boundedText) {
	if out.full {
		return
	}
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sortRawKeys(keys)
		for _, key := range keys {
			collectStringLeaves(typed[key], out)
			if out.full {
				return
			}
		}
	case []any:
		for _, item := range typed {
			collectStringLeaves(item, out)
			if out.full {
				return
			}
		}
	case string:
		out.Add(typed)
	}
}

// boundedText accumulates search text up to a byte cap while the tree is walked,
// so a message carrying a 32 KiB thumbnail never materialises the flattened tree
// only to cut it back to 8 KiB. The result is always valid UTF-8: the leaf that
// crosses the cap is trimmed on a rune boundary.
type boundedText struct {
	buf  strings.Builder
	max  int
	full bool
}

func newBoundedText(max int) *boundedText {
	return &boundedText{max: max}
}

// Add appends one leaf, preceded by the separator that joins leaves.
func (b *boundedText) Add(leaf string) {
	if b.full || leaf == "" {
		return
	}
	if b.buf.Len() > 0 {
		if b.buf.Len()+1 > b.max {
			b.full = true
			return
		}
		b.buf.WriteByte('\n')
	}
	room := b.max - b.buf.Len()
	if room <= 0 {
		b.full = true
		return
	}
	if len(leaf) > room {
		leaf = truncateUTF8(leaf, room)
		b.full = true
	}
	b.buf.WriteString(leaf)
}

func (b *boundedText) String() string {
	return b.buf.String()
}

// truncateUTF8 cuts s to at most max bytes without splitting a rune, so the
// result stays valid UTF-8 and MongoDB accepts it.
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	return s[:cut]
}

// utf8Start reports whether b begins a UTF-8 sequence.
func utf8Start(b byte) bool {
	return b&0xc0 != 0x80
}
