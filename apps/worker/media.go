package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
)

const (
	// unparsedMime and unparsedExt describe an object whose bytes we hold but
	// cannot identify (§6.3.3, §6.3.4).
	unparsedMime = "application/octet-stream"
	unparsedExt  = "bin"
)

// errMediaTooLarge is returned when a download would exceed MEDIA_MAX_BYTES.
// It is a sentinel so the pipeline can map it to `too_large` instead of
// mistaking it for WhatsApp refusing the bytes (§6.3.2).
var errMediaTooLarge = errors.New("media exceeds MEDIA_MAX_BYTES")

// The reason vocabulary of `media.reason` (§5.1) is WhatsApp's: every value
// says *why* an attachment is not readable. A transport failure is not one of
// these — it is a `failed` status, which the janitor retries until the attempt
// budget is spent (§6.3.5).
const (
	reasonViewOnce        = "view_once"
	reasonExpired         = "expired"
	reasonNoKeys          = "no_keys"
	reasonDownloadFailed  = "download_failed"
	reasonUnsupportedType = "unsupported_type"
	reasonTooLarge        = "too_large"
)

// MediaDescriptor is one attachment as the parser saw it: what WhatsApp called
// it, what the node declared, and enough identity to build the object key. It
// is the only thing the download seam needs, so the download can be tested —
// and later re-run by the janitor — without an event or a socket (§14.2).
type MediaDescriptor struct {
	Kind         Kind
	DeclaredType Kind
	Mime         string
	FileName     string
	Size         int64
	MessageID    string
	GroupJID     string
	ViewOnce     bool
}

// mediaDownloader fetches the bytes of one attachment. The whatsmeow-backed
// implementation streams the ciphertext under MEDIA_MAX_BYTES and with
// MEDIA_DOWNLOAD_TIMEOUT before handing back a buffer; tests substitute a fake
// so the state machine runs with no network (§6.3.2).
type mediaDownloader interface {
	Download(ctx context.Context, desc MediaDescriptor) ([]byte, string, error)
}

// mediaUploader stores one object and reports the locator the dashboard shows.
// *r2Client is the production implementation; it is nil when media is
// unconfigured, and the pipeline is never built in that case (§6.9).
type mediaUploader interface {
	Upload(ctx context.Context, data []byte, key, mime string) (uploadResult, error)
}

// mediaPipeline runs one attachment through download → classify → upload →
// metadata and returns the `media` subdocument the message row keeps (§6.3).
// It deliberately holds no clock of its own: `now` is passed in, so the
// year/month partition of the key is the date of the attempt rather than of
// process start, and tests are deterministic.
type mediaPipeline struct {
	downloader mediaDownloader
	uploader   mediaUploader
	orgID      string
	instanceID string
	now        time.Time
}

func newMediaPipeline(downloader mediaDownloader, uploader mediaUploader, orgID, instanceID string, now time.Time) *mediaPipeline {
	return &mediaPipeline{
		downloader: downloader,
		uploader:   uploader,
		orgID:      orgID,
		instanceID: instanceID,
		now:        now,
	}
}

// Store performs one attempt at one attachment and reports the resulting media
// subdocument. It never returns an error and never drops anything: every
// outcome is a status the dashboard can render, which is what R3 asks for — the
// alternative (the reference worker's silent `nil`) hides the attachment.
func (p *mediaPipeline) Store(ctx context.Context, desc MediaDescriptor) Media {
	media := Media{
		Status:       MediaPending,
		Kind:         desc.Kind,
		DeclaredType: desc.DeclaredType,
		// Size and Mime start as what WhatsApp declared. Both are replaced by
		// the bytes we actually hold the moment a download succeeds, so a
		// record left `unavailable` reports what was claimed and a `stored` or
		// `unparsed` one reports what was received.
		Mime:     desc.Mime,
		FileName: desc.FileName,
		Size:     desc.Size,
		// One call is one attempt; a retry is a separate call and increments
		// this (§6.3.5).
		Attempts: 1,
	}
	if desc.ViewOnce || desc.DeclaredType == declaredViewOnce {
		// The phone that opened a view-once message consumed it, so there are
		// no bytes to fetch and no retry that could find some (assumption 7).
		media.Status = MediaUnavailable
		media.Reason = reasonViewOnce
		return media
	}

	data, _, err := p.downloader.Download(ctx, desc)
	if err != nil {
		media.Status, media.Reason = classifyDownloadFailure(err)
		media.Error = err.Error()
		return media
	}

	// The downloader's MIME hint is deliberately not used: the stored mime and
	// the key's extension come from the bytes we now hold, never from what a
	// sender claimed (§11.4).
	mime, readable := sniffMedia(data)
	if !readable {
		return p.storeOpaque(ctx, media, data, desc)
	}

	media.Status = MediaStored
	media.Mime = mime
	media.Size = int64(len(data))
	media.SHA256 = sha256Hex(data)
	media.Width, media.Height = imageDimensions(data)
	media.DurationSec = mediaDurationSeconds(data)

	upload, err := p.uploader.Upload(ctx, data, p.key(desc, extensionForMime(mime, desc.FileName)), mime)
	if err != nil {
		media.Status = MediaFailed
		media.Error = err.Error()
		return media
	}
	media.R2Key, media.PublicURL = upload.Key, upload.PublicURL
	return media
}

// storeOpaque is the R3 path: the bytes arrived but no sniffer knows their
// container, so they are stored as an opaque object and the record keeps what
// WhatsApp claimed about them (§6.3.4). `unparsed` is terminal by design — a
// retry would fetch the same unreadable bytes — so it is only reported once the
// object is really in the bucket.
func (p *mediaPipeline) storeOpaque(ctx context.Context, media Media, data []byte, desc MediaDescriptor) Media {
	upload, err := p.uploader.Upload(ctx, data, p.key(desc, unparsedExt), unparsedMime)
	if err != nil {
		media.Status = MediaFailed
		media.Error = err.Error()
		return media
	}
	media.Status = MediaUnparsed
	media.Kind = KindRaw
	media.Mime = unparsedMime
	media.Reason = reasonUnsupportedType
	media.Size = int64(len(data))
	media.SHA256 = sha256Hex(data)
	media.R2Key, media.PublicURL = upload.Key, upload.PublicURL
	return media
}

// key is the object key for this attempt's descriptor (§6.3.3).
func (p *mediaPipeline) key(desc MediaDescriptor, ext string) string {
	return objectKeyAt(p.orgID, p.instanceID, desc.GroupJID, desc.MessageID, ext, p.now)
}

// classifyDownloadFailure maps a failed download attempt to the media state the
// record keeps. WhatsApp's refusals are terminal (`unavailable`); anything that
// looks like a transport problem is `failed`, which the janitor retries until
// MEDIA_MAX_ATTEMPTS is spent (§6.3.1, §6.3.5).
func classifyDownloadFailure(err error) (MediaStatus, string) {
	if reason := permanentDownloadReason(err); reason != "" {
		return MediaUnavailable, reason
	}
	return MediaFailed, ""
}

// permanentDownloadReason names the failures no retry can change; it returns ""
// for a transient one.
func permanentDownloadReason(err error) string {
	if errors.Is(err, errMediaTooLarge) {
		return reasonTooLarge
	}
	if isTransientMediaError(err) {
		return ""
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "view once"), strings.Contains(msg, "viewonce"):
		return reasonViewOnce
	case strings.Contains(msg, "expired"), strings.Contains(msg, "too old"), strings.Contains(msg, "not available"):
		return reasonExpired
	case strings.Contains(msg, "media key"), strings.Contains(msg, "keys"):
		return reasonNoKeys
	default:
		return reasonDownloadFailed
	}
}

// isTransientMediaError reports whether an error is worth another attempt: a
// deadline, a cancelled context (a shutdown), a broken connection, or the
// back-pressure of a rate limit.
func isTransientMediaError(err error) bool {
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled),
		errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, io.EOF):
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	msg := strings.ToLower(err.Error())
	for _, needle := range []string{
		"timeout", "timed out", "connection reset", "connection refused", "broken pipe",
		"temporarily", "too many requests", "slow down", "throttl", "service unavailable",
		"internal error", "unexpected eof",
	} {
		if strings.Contains(msg, needle) {
			return true
		}
	}
	return false
}

var (
	pngSignature = []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}
	zipSignature = []byte{'P', 'K', 0x03, 0x04}
)

// sniffMedia identifies the containers the worker can read from their magic
// bytes — never from a declared MIME or file name (§11.4) — and reports the
// MIME. Identified bytes are `stored`; everything else is the R3 `unparsed`
// path. The key's extension comes from extensionForMime, so there is exactly
// one place that decides it (§6.3.3).
func sniffMedia(data []byte) (string, bool) {
	switch {
	case bytes.HasPrefix(data, pngSignature):
		return "image/png", true
	case len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF:
		return "image/jpeg", true
	case len(data) >= 12 && bytes.HasPrefix(data, []byte("RIFF")) && string(data[8:12]) == "WEBP":
		return "image/webp", true
	case bytes.HasPrefix(data, []byte("GIF87a")), bytes.HasPrefix(data, []byte("GIF89a")):
		return "image/gif", true
	case len(data) >= 12 && string(data[4:8]) == "ftyp":
		return isoBMFFMime(data), true
	case bytes.HasPrefix(data, []byte("OggS")):
		return "audio/ogg", true
	case bytes.HasPrefix(data, []byte("ID3")), isMP3Frame(data):
		return "audio/mpeg", true
	case bytes.HasPrefix(data, []byte("%PDF")):
		return "application/pdf", true
	case bytes.HasPrefix(data, zipSignature):
		return "application/zip", true
	}
	return "", false
}

// isMP3Frame matches an MPEG audio frame header (no ID3 tag in front of it).
func isMP3Frame(data []byte) bool {
	return len(data) >= 2 && data[0] == 0xFF && data[1]&0xE0 == 0xE0 && data[1]&0x06 != 0
}

// isoBMFFMime reads the file-type brand of an ISO base media file. The brand is
// the only cheap signal that separates a video from an audio-only container.
func isoBMFFMime(data []byte) string {
	switch brand := string(data[8:12]); brand {
	case "M4A ", "M4B ":
		return "audio/mp4"
	case "3gp4", "3gp5", "3gp6", "3gp7", "3ge6", "3gg6":
		return "video/3gpp"
	case "qt  ":
		return "video/quicktime"
	default:
		return "video/mp4"
	}
}

// sha256Hex is the object's digest, kept so the same bytes can be recognized
// after a re-download.
func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// imageDimensions reads the size out of a PNG, GIF or JPEG header (§6.3.4). A
// truncated or unexpected header yields 0×0 rather than an error: the object is
// stored either way.
func imageDimensions(data []byte) (int, int) {
	switch {
	case len(data) >= 24 && bytes.HasPrefix(data, pngSignature):
		return int(binary.BigEndian.Uint32(data[16:20])), int(binary.BigEndian.Uint32(data[20:24]))
	case len(data) >= 10 && bytes.HasPrefix(data, []byte("GIF")):
		return int(binary.LittleEndian.Uint16(data[6:8])), int(binary.LittleEndian.Uint16(data[8:10]))
	case len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8:
		return jpegDimensions(data)
	}
	return 0, 0
}

// jpegDimensions walks the JPEG segments to the frame header, which is the only
// place the size lives; every other segment (APPn, comments, quantization
// tables) is skipped by its declared length.
func jpegDimensions(data []byte) (int, int) {
	for off := 2; off+4 <= len(data); {
		if data[off] != 0xFF {
			return 0, 0
		}
		marker := data[off+1]
		switch {
		case marker == 0x01 || marker >= 0xD0 && marker <= 0xD8:
			off += 2
			continue
		case marker == 0xD9 || marker == 0xDA: // end of image / start of scan
			return 0, 0
		}
		size := int(binary.BigEndian.Uint16(data[off+2 : off+4]))
		if size < 2 || off+2+size > len(data) {
			return 0, 0
		}
		if isSOFMarker(marker) {
			if size < 7 {
				return 0, 0
			}
			h := int(binary.BigEndian.Uint16(data[off+5 : off+7]))
			w := int(binary.BigEndian.Uint16(data[off+7 : off+9]))
			return w, h
		}
		off += 2 + size
	}
	return 0, 0
}

// isSOFMarker reports whether a JPEG marker is a frame header, excluding the
// three markers that share the 0xC0-0xCF range without carrying a size.
func isSOFMarker(marker byte) bool {
	return marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
}

// mediaDurationSeconds reads a movie header's duration — the one container
// timing worth parsing without decoding the stream. Anything else reports 0,
// which the record stores as "unknown" rather than as a wrong number (§6.3.4).
func mediaDurationSeconds(data []byte) float64 {
	for _, outer := range isoBoxes(data) {
		if outer.typ != "moov" {
			continue
		}
		content := data[outer.content:outer.end]
		for _, inner := range isoBoxes(content) {
			if inner.typ != "mvhd" {
				continue
			}
			timescale, duration, ok := parseMvhd(content[inner.start:inner.end])
			if ok && timescale > 0 {
				return float64(duration) / float64(timescale)
			}
		}
	}
	return 0
}

// isoBox is one ISO base media file box: where it starts, where its content
// starts (past the header, which is 16 bytes in the 64-bit size form), where it
// ends, and its type.
type isoBox struct {
	start, content, end int
	typ                 string
}

// isoBoxes walks the sibling boxes of data, tolerating the 64-bit size form and
// a final box declared to run to the end. A malformed size stops the walk: a
// truncated container has no duration to report.
func isoBoxes(data []byte) []isoBox {
	var boxes []isoBox
	for off := 0; off+8 <= len(data); {
		size := int(binary.BigEndian.Uint32(data[off : off+4]))
		typ := string(data[off+4 : off+8])
		header := 8
		switch {
		case size == 1:
			if off+16 > len(data) {
				return boxes
			}
			size = int(binary.BigEndian.Uint64(data[off+8 : off+16]))
			header = 16
		case size == 0:
			size = len(data) - off
		}
		if size < header || off+size > len(data) {
			return boxes
		}
		boxes = append(boxes, isoBox{start: off, content: off + header, end: off + size, typ: typ})
		off += size
	}
	return boxes
}

// parseMvhd reads the timescale and duration out of a movie header box, in
// either of its two versions.
func parseMvhd(box []byte) (uint32, uint64, bool) {
	if len(box) < 12 {
		return 0, 0, false
	}
	body := box[12:] // past the size, the type, and version+flags
	switch version := box[8]; version {
	case 1:
		if len(body) < 28 {
			return 0, 0, false
		}
		return binary.BigEndian.Uint32(body[16:20]), binary.BigEndian.Uint64(body[20:28]), true
	default:
		if len(body) < 16 {
			return 0, 0, false
		}
		return binary.BigEndian.Uint32(body[8:12]), uint64(binary.BigEndian.Uint32(body[12:16])), true
	}
}

// copyCapped streams src into dst and fails with errMediaTooLarge as soon as
// the payload passes max bytes. The copy stops there — the reader is never
// drained to the end — so an oversized attachment cannot exhaust worker memory
// however large it turns out to be (§6.3.2). At most one byte past the cap is
// buffered, which is what keeps "exactly at the cap" a success.
func copyCapped(dst io.Writer, src io.Reader, max int64) (int64, error) {
	limited := &io.LimitedReader{R: src, N: max + 1}
	n, err := io.Copy(dst, limited)
	if err != nil {
		return n, err
	}
	if n > max {
		return n, errMediaTooLarge
	}
	return n, nil
}

// describeMedia turns the media node of one message into the descriptor the
// pipeline works from, mapping every downloadable variant to the type WhatsApp
// declared for it (§6.3.1). It reports false when the node holds nothing
// downloadable — text, a location, a poll — which keeps `media.status:"none"`.
// The message id and group JID belong to the event, so the caller adds them.
func describeMedia(msg *waE2E.Message) (MediaDescriptor, bool) {
	inner, viewOnce := unwrapMessage(msg)
	if inner == nil {
		return MediaDescriptor{}, false
	}
	_, mediaKind, declared := classifyKind(inner)
	if mediaKind == "" {
		return MediaDescriptor{}, false
	}
	desc := MediaDescriptor{Kind: mediaKind, DeclaredType: declared, ViewOnce: viewOnce}
	switch mediaKind {
	case KindPtv:
		if m := inner.GetPtvMessage(); m != nil {
			desc.Mime, desc.Size, desc.ViewOnce = m.GetMimetype(), int64(m.GetFileLength()), desc.ViewOnce || m.GetViewOnce()
		}
	case KindVideo:
		if m := inner.GetVideoMessage(); m != nil {
			desc.Mime, desc.Size, desc.ViewOnce = m.GetMimetype(), int64(m.GetFileLength()), desc.ViewOnce || m.GetViewOnce()
		}
	case KindImage:
		if m := inner.GetImageMessage(); m != nil {
			desc.Mime, desc.Size, desc.ViewOnce = m.GetMimetype(), int64(m.GetFileLength()), desc.ViewOnce || m.GetViewOnce()
		}
	case KindAudio:
		if m := inner.GetAudioMessage(); m != nil {
			desc.Mime, desc.Size = m.GetMimetype(), int64(m.GetFileLength())
		}
	case KindDocument:
		if m := inner.GetDocumentMessage(); m != nil {
			desc.Mime, desc.FileName, desc.Size = m.GetMimetype(), m.GetFileName(), int64(m.GetFileLength())
		}
	case KindSticker:
		if m := inner.GetStickerMessage(); m != nil {
			desc.Mime, desc.Size = m.GetMimetype(), int64(m.GetFileLength())
		}
	}
	if desc.ViewOnce && desc.DeclaredType != declaredViewOnce {
		// A view-once node is declared as the wrapper, not as the image or video
		// it wraps; the dashboard filters on exactly that value (§6.3.1).
		desc.DeclaredType = declaredViewOnce
	}
	return desc, true
}
