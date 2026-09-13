package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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

	// Every stored object gets a descriptor sidecar beside it (§6.3.3).
	sidecarExt  = "meta.json"
	sidecarMime = "application/json"
)

// kindForMime derives `media.kind` from the container we actually stored, so a
// record can never claim media it does not hold (§6.3.4). A video note, a
// sticker or a view-once image keeps its WhatsApp wording in `declaredType`.
func kindForMime(mime string) Kind {
	switch {
	case strings.HasPrefix(mime, "image/"):
		return KindImage
	case strings.HasPrefix(mime, "video/"):
		return KindVideo
	case strings.HasPrefix(mime, "audio/"):
		return KindAudio
	case strings.HasPrefix(mime, "text/"):
		return KindDocument
	}
	switch mime {
	case "application/pdf", "application/zip",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
		return KindDocument
	}
	// Only reachable if a sniffer starts reporting a container with no kind;
	// calling those bytes raw is the honest answer.
	return KindRaw
}

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

// mediaLimits are the operational bounds of §6.3.2 — MEDIA_MAX_BYTES,
// MEDIA_DOWNLOAD_TIMEOUT and MEDIA_CONCURRENCY — derived from the worker
// configuration once per process. The semaphore is deliberately shared: the
// spec asks for a *global* concurrency bound, so a pipeline built per media job
// must not carry its own.
type mediaLimits struct {
	maxBytes  int64
	timeout   time.Duration
	semaphore chan struct{}
}

// newMediaLimits derives the download policy from the worker configuration.
// Config.validate has already rejected non-positive caps, timeouts and
// concurrency, so the three values are used as they are rather than validated a
// second time.
func newMediaLimits(cfg Config) *mediaLimits {
	return &mediaLimits{
		maxBytes:  cfg.MediaMaxBytes,
		timeout:   cfg.MediaDownloadTimeout,
		semaphore: make(chan struct{}, cfg.MediaConcurrency),
	}
}

// acquire takes one MEDIA_CONCURRENCY slot and returns its release, or the
// context's error when the caller gave up waiting for one.
func (l *mediaLimits) acquire(ctx context.Context) (func(), error) {
	select {
	case l.semaphore <- struct{}{}:
		return func() { <-l.semaphore }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// mediaPipeline runs one attachment through download → classify → upload →
// metadata and returns the `media` subdocument the message row keeps (§6.3).
// It deliberately holds no clock of its own: `now` is passed in, so the
// year/month partition of the key is the date of the attempt rather than of
// process start, and tests are deterministic.
type mediaPipeline struct {
	limits     *mediaLimits
	downloader mediaDownloader
	uploader   mediaUploader
	orgID      string
	instanceID string
	now        time.Time
}

// newMediaPipeline builds one pipeline for one media job. limits comes from
// newMediaLimits(cfg) and is shared by every pipeline in the process, which is
// what makes MEDIA_CONCURRENCY a bound on the worker rather than on one job.
func newMediaPipeline(limits *mediaLimits, downloader mediaDownloader, uploader mediaUploader, orgID, instanceID string, now time.Time) *mediaPipeline {
	return &mediaPipeline{
		limits:     limits,
		downloader: downloader,
		uploader:   uploader,
		orgID:      orgID,
		instanceID: instanceID,
		now:        now,
	}
}

// download fetches one attachment under the whole §6.3.2 policy: a
// MEDIA_CONCURRENCY slot, a MEDIA_DOWNLOAD_TIMEOUT deadline, and MEDIA_MAX_BYTES
// on what comes back. Every download the worker performs goes through here, so
// no path can fetch an attachment outside the configured bounds.
func (p *mediaPipeline) download(ctx context.Context, desc MediaDescriptor) ([]byte, error) {
	release, err := p.limits.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()

	ctx, cancel := context.WithTimeout(ctx, p.limits.timeout)
	defer cancel()

	// The downloader's MIME hint is deliberately ignored: the stored mime, the
	// key's extension and media.kind all come from the bytes we hold, never from
	// what a sender claimed (§11.4).
	data, _, err := p.downloader.Download(ctx, desc)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > p.limits.maxBytes {
		// A downloader that streams to a temp file aborts under the same cap
		// (copyCapped); this is the bound on whatever one hands back instead.
		return nil, fmt.Errorf("%w: %d bytes", errMediaTooLarge, len(data))
	}
	return data, nil
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

	data, err := p.download(ctx, desc)
	if err != nil {
		media.Status, media.Reason = classifyDownloadFailure(err)
		media.Error = err.Error()
		return media
	}

	mime, readable := sniffMedia(data)
	if !readable {
		return p.persist(ctx, unparsedMedia(media, data), desc, data, unparsedExt)
	}

	media.Status = MediaStored
	// media.kind describes the bytes we stored, never the descriptor that asked
	// for them: an image node carrying an MP4 is a video here, and what
	// WhatsApp declared stays in `declaredType` (§6.3.4).
	media.Kind = kindForMime(mime)
	media.Mime = mime
	media.Size = int64(len(data))
	media.SHA256 = sha256Hex(data)
	media.Width, media.Height = imageDimensions(data)
	media.DurationSec = mediaDurationSeconds(data)

	return p.persist(ctx, media, desc, data, extensionForMime(mime, desc.FileName))
}

// unparsedMedia is the R3 record: the bytes are held, the container is not
// understood, so what WhatsApp claimed about them is all we can say (§6.3.4).
// `unparsed` is terminal — a retry would fetch the same unreadable bytes.
func unparsedMedia(media Media, data []byte) Media {
	media.Status = MediaUnparsed
	media.Kind = KindRaw
	media.Mime = unparsedMime
	media.Reason = reasonUnsupportedType
	media.Size = int64(len(data))
	media.SHA256 = sha256Hex(data)
	return media
}

// persist writes the bytes and, beside them, the immutable descriptor sidecar
// of §6.3.3. Both keys derive from the same descriptor, so a retry rewrites the
// same two objects rather than a different record.
func (p *mediaPipeline) persist(ctx context.Context, media Media, desc MediaDescriptor, data []byte, ext string) Media {
	upload, err := p.uploader.Upload(ctx, data, p.key(desc, ext), media.Mime)
	if err != nil {
		return failedMedia(media, err)
	}
	media.R2Key, media.PublicURL = upload.Key, upload.PublicURL

	sidecar, err := sidecarJSON(p.orgID, p.instanceID, desc, media)
	if err != nil {
		return failedMedia(media, err)
	}
	if _, err := p.uploader.Upload(ctx, sidecar, p.key(desc, sidecarExt), sidecarMime); err != nil {
		// The bytes are in the bucket but their descriptor is not. The record
		// must not claim a stored attachment it cannot describe, so the attempt
		// fails and the janitor rewrites both objects at the same keys (§6.3.5).
		return failedMedia(media, err)
	}
	return media
}

// failedMedia ends one attempt: nothing the record could point at is complete,
// so the error is kept and no locator is claimed (§6.3.1).
func failedMedia(media Media, err error) Media {
	media.Status = MediaFailed
	media.Reason = ""
	media.Error = err.Error()
	media.R2Key, media.PublicURL = "", ""
	return media
}

// mediaSidecar is the JSON object written at <waMessageId>.meta.json (§6.3.3):
// the descriptor and the outcome, readable even if Mongo is lost. Every field
// is a plain value derived from the descriptor and the stored bytes — no
// timestamp, no attempt counter — which is what makes the sidecar immutable in
// effect: the same media always produces the same bytes at the same key.
type mediaSidecar struct {
	OrganizationID string      `json:"organizationId"`
	InstanceID     string      `json:"instanceId"`
	GroupJID       string      `json:"groupJid"`
	WaMessageID    string      `json:"waMessageId"`
	Status         MediaStatus `json:"status"`
	Kind           Kind        `json:"kind"`
	DeclaredType   Kind        `json:"declaredType"`
	Mime           string      `json:"mime"`
	FileName       string      `json:"fileName,omitempty"`
	Size           int64       `json:"size"`
	SHA256         string      `json:"sha256"`
	Width          int         `json:"width,omitempty"`
	Height         int         `json:"height,omitempty"`
	DurationSec    float64     `json:"durationSec,omitempty"`
	Reason         string      `json:"reason,omitempty"`
	R2Key          string      `json:"r2Key"`
}

// sidecarJSON serializes one descriptor sidecar. Indented because "useful even
// if Mongo is lost" means a human may open it, and never derived from a map or
// the clock, so the encoding is stable.
func sidecarJSON(orgID, instanceID string, desc MediaDescriptor, media Media) ([]byte, error) {
	payload, err := json.MarshalIndent(mediaSidecar{
		OrganizationID: orgID,
		InstanceID:     instanceID,
		GroupJID:       desc.GroupJID,
		WaMessageID:    desc.MessageID,
		Status:         media.Status,
		Kind:           media.Kind,
		DeclaredType:   media.DeclaredType,
		Mime:           media.Mime,
		FileName:       media.FileName,
		Size:           media.Size,
		SHA256:         media.SHA256,
		Width:          media.Width,
		Height:         media.Height,
		DurationSec:    media.DurationSec,
		Reason:         media.Reason,
		R2Key:          media.R2Key,
	}, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("media sidecar: %w", err)
	}
	return append(payload, '\n'), nil
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
	pngSignature  = []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}
	webpSignature = []byte("RIFF")
	zipSignature  = []byte{'P', 'K', 0x03, 0x04}
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
	case isWebP(data):
		return "image/webp", true
	case bytes.HasPrefix(data, []byte("RIFF")) && len(data) >= 12 && string(data[8:12]) == "WAVE":
		return "audio/wav", true
	case isEBML(data):
		return ebmlMime(data), true
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

// isWebP reports a WebP RIFF container.
func isWebP(data []byte) bool {
	return len(data) >= 16 && bytes.HasPrefix(data, webpSignature) && string(data[8:12]) == "WEBP"
}

// isEBML reports a Matroska/WebM file, which starts with the EBML header magic.
func isEBML(data []byte) bool { return bytes.HasPrefix(data, []byte{0x1A, 0x45, 0xDF, 0xA3}) }

// ebmlMime reads the DocType of an EBML header: "webm" for WebM, anything else
// (in practice "matroska") for the broader Matroska container. The DocType sits
// in the first handful of bytes, so a bounded scan is enough and no EBML parser
// is needed to name the container.
func ebmlMime(data []byte) string {
	head := data
	if len(head) > 128 {
		head = head[:128]
	}
	if bytes.Contains(head, []byte("webm")) {
		return "video/webm"
	}
	return "video/x-matroska"
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

// imageDimensions reads the size out of a PNG, GIF, JPEG or WebP header
// (§6.3.4). A truncated or unexpected header yields 0×0 rather than an error:
// the object is stored either way.
func imageDimensions(data []byte) (int, int) {
	switch {
	case len(data) >= 24 && bytes.HasPrefix(data, pngSignature):
		return int(binary.BigEndian.Uint32(data[16:20])), int(binary.BigEndian.Uint32(data[20:24]))
	case len(data) >= 10 && bytes.HasPrefix(data, []byte("GIF")):
		return int(binary.LittleEndian.Uint16(data[6:8])), int(binary.LittleEndian.Uint16(data[8:10]))
	case isWebP(data):
		return webpDimensions(data)
	case len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8:
		return jpegDimensions(data)
	}
	return 0, 0
}

// webpDimensions reads the canvas size out of a WebP container, whose layout
// depends on the frame it carries: VP8X states the canvas explicitly, VP8 holds
// the lossy frame's size after its start code, and VP8L packs both 14-bit
// sizes into one little-endian word. A container without a known frame chunk
// reports 0×0 rather than a guessed size.
func webpDimensions(data []byte) (int, int) {
	switch string(data[12:16]) {
	case "VP8X":
		if len(data) < 30 {
			return 0, 0
		}
		return uint24LE(data[24:27]) + 1, uint24LE(data[27:30]) + 1
	case "VP8L":
		if len(data) < 25 {
			return 0, 0
		}
		bits := binary.LittleEndian.Uint32(data[21:25])
		return int(bits&0x3FFF) + 1, int((bits>>14)&0x3FFF) + 1
	case "VP8 ":
		if len(data) < 30 {
			return 0, 0
		}
		return int(binary.LittleEndian.Uint16(data[26:28]) & 0x3FFF), int(binary.LittleEndian.Uint16(data[28:30]) & 0x3FFF)
	}
	return 0, 0
}

// uint24LE reads the 24-bit little-endian canvas size a VP8X chunk carries.
func uint24LE(b []byte) int { return int(b[0]) | int(b[1])<<8 | int(b[2])<<16 }

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
//
// Kind here is what the parser can know before the bytes exist; the pipeline
// replaces it with the kind the stored bytes prove, keeping this value in
// `declaredType` (§6.3.4).
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
