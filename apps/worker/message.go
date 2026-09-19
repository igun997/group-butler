package main

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
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
	Text         string
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

	// AutoReplyCandidate is an in-memory delivery marker. ingest.go does not
	// serialize it; it is evaluated only after this exact message is durable.
	AutoReplyCandidate bool

	ParseState    ParseState
	ParseErrors   []string
	SchemaVersion int
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
