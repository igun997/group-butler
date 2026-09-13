package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

type fakeDownloader struct {
	data []byte
	typ  string
	err  error
}

func (f fakeDownloader) Download(ctx context.Context, msg MediaDescriptor) ([]byte, string, error) {
	if f.err != nil {
		return nil, "", f.err
	}
	return f.data, f.typ, nil
}

type fakeUploader struct {
	key   string
	calls int
	mime  string
	err   error
}

func (f *fakeUploader) Upload(ctx context.Context, data []byte, key, mime string) (uploadResult, error) {
	f.calls++
	f.key = key
	f.mime = mime
	if f.err != nil {
		return uploadResult{}, f.err
	}
	return uploadResult{Key: key, Size: int64(len(data)), PublicURL: "http://cdn.local/" + key}, nil
}

var mediaNow = time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC)

func TestStoreMedia_StoredWhenReadable(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'I', 'H', 'D', 'R', 0, 0, 0, 4, 0, 0, 0, 3}
	up := &fakeUploader{}
	pipe := newMediaPipeline(fakeDownloader{data: png, typ: "image/png"}, up, "org_default", "inst_1", mediaNow)
	got := pipe.Store(context.Background(), MediaDescriptor{
		DeclaredType: "image", Kind: "image", Mime: "image/png", MessageID: "3EB0A1", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaStored {
		t.Fatalf("Status = %q (err=%q), want stored", got.Status, got.Error)
	}
	if got.Width != 4 || got.Height != 3 {
		t.Errorf("dimensions = %dx%d, want 4x3", got.Width, got.Height)
	}
	if got.R2Key == "" || up.calls != 1 {
		t.Errorf("expected one upload, got key=%q calls=%d", got.R2Key, up.calls)
	}
}

func TestStoreMedia_UnparsedKeepsDeclaredTypeAndLink(t *testing.T) {
	up := &fakeUploader{}
	pipe := newMediaPipeline(fakeDownloader{data: []byte{0x00, 0x01, 0x02, 0x03}}, up, "org_default", "inst_1", mediaNow)
	got := pipe.Store(context.Background(), MediaDescriptor{
		DeclaredType: "ptv", Kind: "video", MessageID: "3EB0A2", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaUnparsed {
		t.Fatalf("Status = %q, want unparsed", got.Status)
	}
	if got.DeclaredType != "ptv" {
		t.Errorf("DeclaredType = %q, want ptv (R3)", got.DeclaredType)
	}
	if got.R2Key == "" || got.PublicURL == "" {
		t.Errorf("unparsed media must still carry the R2 locator, got key=%q url=%q", got.R2Key, got.PublicURL)
	}
	if got.Reason != "unsupported_type" {
		t.Errorf("Reason = %q, want unsupported_type", got.Reason)
	}
}

func TestStoreMedia_DownloadFailureIsUnavailableNotFatal(t *testing.T) {
	up := &fakeUploader{}
	pipe := newMediaPipeline(fakeDownloader{err: errors.New("media key missing")}, up, "org_default", "inst_1", mediaNow)
	got := pipe.Store(context.Background(), MediaDescriptor{
		DeclaredType: "image", Kind: "image", Mime: "image/jpeg", MessageID: "3EB0A3", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaUnavailable || got.R2Key != "" || up.calls != 0 {
		t.Errorf("media = %+v, want unavailable with no key and no upload", got)
	}
	if got.DeclaredType != "image" {
		t.Errorf("DeclaredType = %q, want image", got.DeclaredType)
	}
}

func TestMediaDescriptorFromMessage(t *testing.T) {
	msg := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Mimetype: proto.String("image/jpeg"), Caption: proto.String("chart"), FileLength: proto.Uint64(2048),
	}}
	desc, ok := describeMedia(msg)
	if !ok || desc.Kind != "image" || desc.DeclaredType != "image" || desc.Mime != "image/jpeg" {
		t.Fatalf("describeMedia = %+v ok=%v", desc, ok)
	}
}

// countingDownloader records that a descriptor was fetched, for the cases where
// the pipeline must not fetch at all.
type countingDownloader struct{ calls *int }

func (c countingDownloader) Download(context.Context, MediaDescriptor) ([]byte, string, error) {
	*c.calls++
	return nil, "", errors.New("a descriptor that must not be fetched was fetched")
}

func TestStoreMedia_ViewOnceIsUnavailableWithoutFetching(t *testing.T) {
	downloads := 0
	up := &fakeUploader{}
	pipe := newMediaPipeline(countingDownloader{calls: &downloads}, up, "org_default", "inst_1", mediaNow)

	got := pipe.Store(context.Background(), MediaDescriptor{
		Kind: KindImage, DeclaredType: declaredViewOnce, Mime: "image/jpeg", ViewOnce: true,
		MessageID: "3EB0B4", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaUnavailable || got.Reason != "view_once" {
		t.Errorf("media = %+v, want unavailable/view_once (§6.3.1)", got)
	}
	if downloads != 0 {
		t.Error("a view-once node was fetched: the phone that opened it consumed the bytes (assumption 7)")
	}
	if up.calls != 0 || got.R2Key != "" || got.PublicURL != "" {
		t.Errorf("view-once media = %+v, want no R2 locator: a link cannot exist for bytes we never received (R3)", got)
	}
}

func TestStoreMedia_UnparsedKeepsTheBytesAsAnOpaqueObject(t *testing.T) {
	data := []byte("this container is not something any sniffer knows")
	up := &fakeUploader{}
	pipe := newMediaPipeline(fakeDownloader{data: data}, up, "org_default", "inst_1", mediaNow)

	got := pipe.Store(context.Background(), MediaDescriptor{
		Kind: KindDocument, DeclaredType: KindDocument, Mime: "application/pdf",
		FileName: "invoice.pdf", MessageID: "3EB0B5", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaUnparsed || got.Kind != KindRaw {
		t.Fatalf("media = %+v, want unparsed/raw (§6.3.4)", got)
	}
	if got.Mime != unparsedMime || got.Reason != "unsupported_type" {
		t.Errorf("mime=%q reason=%q, want the opaque-object record of §6.3.4", got.Mime, got.Reason)
	}
	if !strings.HasSuffix(got.R2Key, "3EB0B5.bin") {
		t.Errorf("R2Key = %q, want the .bin key of §6.3.3", got.R2Key)
	}
	if got.SHA256 != sha256Hex(data) || got.Size != int64(len(data)) {
		t.Errorf("sha256=%q size=%d, want the bytes we actually hold", got.SHA256, got.Size)
	}
	if got.Attempts != 1 {
		t.Errorf("Attempts = %d, want 1: Store performs exactly one attempt (§6.3.5)", got.Attempts)
	}
}

func TestStoreMedia_TransientDownloadFailureStaysRetryable(t *testing.T) {
	up := &fakeUploader{}
	pipe := newMediaPipeline(fakeDownloader{err: context.DeadlineExceeded}, up, "org_default", "inst_1", mediaNow)

	got := pipe.Store(context.Background(), MediaDescriptor{
		Kind: KindImage, DeclaredType: KindImage, MessageID: "3EB0B6", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaFailed {
		t.Errorf("Status = %q, want failed: the janitor retries failed records until MEDIA_MAX_ATTEMPTS (§6.3.5)", got.Status)
	}
	if got.Reason != "" {
		t.Errorf("Reason = %q, want empty: the reason vocabulary is WhatsApp's, not the network's (§5.1)", got.Reason)
	}
	if got.Error == "" || up.calls != 0 {
		t.Errorf("media = %+v, want the error recorded and nothing uploaded", got)
	}
}

func TestStoreMedia_OversizedDownloadIsUnavailable(t *testing.T) {
	pipe := newMediaPipeline(fakeDownloader{err: errMediaTooLarge}, &fakeUploader{}, "org_default", "inst_1", mediaNow)

	got := pipe.Store(context.Background(), MediaDescriptor{
		Kind: KindVideo, DeclaredType: KindVideo, MessageID: "3EB0B7", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaUnavailable || got.Reason != "too_large" {
		t.Errorf("media = %+v, want unavailable/too_large: no retry will shrink the attachment (§6.3.2)", got)
	}
}

func TestStoreMedia_UploadFailureIsFailed(t *testing.T) {
	up := &fakeUploader{err: errors.New("r2 put: ServiceUnavailable")}
	pipe := newMediaPipeline(fakeDownloader{data: pngHeader(4, 3)}, up, "org_default", "inst_1", mediaNow)

	got := pipe.Store(context.Background(), MediaDescriptor{
		Kind: KindImage, DeclaredType: KindImage, MessageID: "3EB0B8", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaFailed || got.Error == "" || got.R2Key != "" || got.PublicURL != "" {
		t.Errorf("media = %+v, want failed with the error recorded and no locator", got)
	}
	if up.calls != 1 {
		t.Errorf("upload calls = %d, want exactly one attempt", up.calls)
	}
}

func TestClassifyDownloadFailure(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status MediaStatus
		reason string
	}{
		{"media keys gone", errors.New("media key missing"), MediaUnavailable, "no_keys"},
		{"expired", errors.New("attachment expired"), MediaUnavailable, "expired"},
		{"consumed view-once", errors.New("view once already consumed"), MediaUnavailable, "view_once"},
		{"over the cap", errMediaTooLarge, MediaUnavailable, "too_large"},
		{"unknown refusal", errors.New("whatsapp said no"), MediaUnavailable, "download_failed"},
		{"timeout", context.DeadlineExceeded, MediaFailed, ""},
		{"reset stream", errors.New("read tcp: connection reset by peer"), MediaFailed, ""},
		{"throttled", errors.New("429 Too Many Requests: slow down"), MediaFailed, ""},
		{"cancelled shutdown", context.Canceled, MediaFailed, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, reason := classifyDownloadFailure(tc.err)
			if status != tc.status || reason != tc.reason {
				t.Errorf("classifyDownloadFailure(%v) = (%q, %q), want (%q, %q)", tc.err, status, reason, tc.status, tc.reason)
			}
		})
	}
}

func TestSniffMedia(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		mime string
		ext  string
	}{
		{"png", pngHeader(4, 3), "image/png", "png"},
		{"jpeg", jpegHeader(5, 2), "image/jpeg", "jpg"},
		{"gif", []byte("GIF89a\x04\x00\x03\x00"), "image/gif", "gif"},
		{"webp", []byte("RIFF\x10\x00\x00\x00WEBPVP8 "), "image/webp", "webp"},
		{"mp4", mp4Header("isom"), "video/mp4", "mp4"},
		{"m4a", mp4Header("M4A "), "audio/mp4", "m4a"},
		{"3gp", mp4Header("3gp4"), "video/3gpp", "3gp"},
		{"mov", mp4Header("qt  "), "video/quicktime", "mov"},
		{"ogg", []byte("OggS\x00\x02\x00\x00\x00\x00\x00\x00"), "audio/ogg", "ogg"},
		{"mp3 with id3", []byte("ID3\x04\x00\x00\x00\x00\x00\x00"), "audio/mpeg", "mp3"},
		{"mp3 frame sync", []byte{0xFF, 0xFB, 0x90, 0x00}, "audio/mpeg", "mp3"},
		{"pdf", []byte("%PDF-1.7\n"), "application/pdf", "pdf"},
		{"zip container", []byte("PK\x03\x04\x14\x00\x00\x00"), "application/zip", "zip"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mime, ok := sniffMedia(tc.data)
			if !ok || mime != tc.mime {
				t.Errorf("sniffMedia = (%q, %v), want (%q, true)", mime, ok, tc.mime)
			}
			if ext := extensionForMime(mime, ""); ext != tc.ext {
				t.Errorf("extensionForMime(%q) = %q, want %q", mime, ext, tc.ext)
			}
		})
	}

	for _, data := range [][]byte{nil, {0x00, 0x01, 0x02, 0x03}, []byte("plain text")} {
		if mime, ok := sniffMedia(data); ok {
			t.Errorf("sniffMedia(%q) = (%q, true), want unidentifiable", data, mime)
		}
	}
}

func TestImageDimensions(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		w, h int
	}{
		{"png", pngHeader(4, 3), 4, 3},
		{"gif", []byte("GIF87a\x04\x00\x03\x00"), 4, 3},
		{"jpeg", jpegHeader(5, 2), 5, 2},
		{"pdf", []byte("%PDF-1.7\n"), 0, 0},
		{"truncated png", pngHeader(4, 3)[:12], 0, 0},
		{"truncated jpeg", jpegHeader(5, 2)[:12], 0, 0},
		{"empty", nil, 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w, h := imageDimensions(tc.data)
			if w != tc.w || h != tc.h {
				t.Errorf("imageDimensions = %dx%d, want %dx%d", w, h, tc.w, tc.h)
			}
		})
	}
}

func TestMediaDurationSeconds(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		want float64
	}{
		{"mvhd v0", moovWithMvhd(0, 1000, 2500), 2.5},
		{"mvhd v1", moovWithMvhd(1, 48000, 96000), 2},
		{"no movie header", mp4Header("isom"), 0},
		{"truncated movie header", moovWithMvhd(0, 1000, 2500)[:20], 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := mediaDurationSeconds(tc.data)
			if diff := got - tc.want; diff > 0.001 || diff < -0.001 {
				t.Errorf("mediaDurationSeconds = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCopyCappedAbortsPastTheLimit(t *testing.T) {
	var exact bytes.Buffer
	if _, err := copyCapped(&exact, bytes.NewReader(bytes.Repeat([]byte("a"), 100)), 100); err != nil {
		t.Errorf("copyCapped at exactly the cap: %v", err)
	}
	if exact.Len() != 100 {
		t.Errorf("copied %d bytes, want the whole payload when it fits the cap", exact.Len())
	}

	src := bytes.NewReader(bytes.Repeat([]byte("a"), 1<<20))
	var over bytes.Buffer
	if _, err := copyCapped(&over, src, 10); !errors.Is(err, errMediaTooLarge) {
		t.Fatalf("copyCapped error = %v, want errMediaTooLarge", err)
	}
	if over.Len() > 11 {
		t.Errorf("buffered %d bytes past a 10-byte cap, want the copy aborted at the cap", over.Len())
	}
	if consumed := (1 << 20) - src.Len(); consumed > 11 {
		t.Errorf("read %d bytes past a 10-byte cap: an oversized attachment must not be streamed to the end (§6.3.2)", consumed)
	}
}

func TestDescribeMediaMapsEveryDownloadableVariant(t *testing.T) {
	viewOnce := &waE2E.Message{ViewOnceMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{
		ImageMessage: &waE2E.ImageMessage{Mimetype: proto.String("image/jpeg"), FileLength: proto.Uint64(7)},
	}}}
	cases := []struct {
		name string
		msg  *waE2E.Message
		want MediaDescriptor
	}{
		{"image", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Mimetype: proto.String("image/jpeg"), FileLength: proto.Uint64(7),
		}}, MediaDescriptor{Kind: KindImage, DeclaredType: KindImage, Mime: "image/jpeg", Size: 7}},
		{"video note", &waE2E.Message{PtvMessage: &waE2E.VideoMessage{
			Mimetype: proto.String("video/mp4"), FileLength: proto.Uint64(8),
		}}, MediaDescriptor{Kind: KindPtv, DeclaredType: KindPtv, Mime: "video/mp4", Size: 8}},
		{"voice note", &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
			Mimetype: proto.String("audio/ogg; codecs=opus"), FileLength: proto.Uint64(9),
		}}, MediaDescriptor{Kind: KindAudio, DeclaredType: KindAudio, Mime: "audio/ogg; codecs=opus", Size: 9}},
		{"document", &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
			Mimetype: proto.String("application/pdf"), FileName: proto.String("invoice.pdf"), FileLength: proto.Uint64(10),
		}}, MediaDescriptor{Kind: KindDocument, DeclaredType: KindDocument, Mime: "application/pdf", FileName: "invoice.pdf", Size: 10}},
		{"sticker", &waE2E.Message{StickerMessage: &waE2E.StickerMessage{
			Mimetype: proto.String("image/webp"), FileLength: proto.Uint64(11),
		}}, MediaDescriptor{Kind: KindSticker, DeclaredType: KindSticker, Mime: "image/webp", Size: 11}},
		{"view-once wrapper", viewOnce, MediaDescriptor{
			Kind: KindImage, DeclaredType: declaredViewOnce, Mime: "image/jpeg", Size: 7, ViewOnce: true,
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := describeMedia(tc.msg)
			if !ok {
				t.Fatalf("describeMedia(%s) reported no media", tc.name)
			}
			if got != tc.want {
				t.Errorf("describeMedia = %+v, want %+v", got, tc.want)
			}
		})
	}

	for _, msg := range []*waE2E.Message{
		nil,
		{Conversation: proto.String("no media here")},
		{DocumentMessage: nil},
	} {
		if got, ok := describeMedia(msg); ok {
			t.Errorf("describeMedia(%v) = %+v, want no descriptor", msg, got)
		}
	}
}

func TestExtensionForMimeOnlyTrustsTheNameForAGenericContainer(t *testing.T) {
	cases := []struct {
		mime     string
		fileName string
		want     string
	}{
		{"application/zip", "quarterly.xlsx", "xlsx"},
		{"application/zip", "report.docx", "docx"},
		{"application/zip", "payload.exe", "zip"},
		{"application/zip", "no-extension", "zip"},
		{"application/octet-stream", "../etc/passwd", "bin"},
		{"application/octet-stream", "photo.JPEG", "jpeg"},
		{"image/png", "photo.exe", "png"},
	}
	for _, tc := range cases {
		if got := extensionForMime(tc.mime, tc.fileName); got != tc.want {
			t.Errorf("extensionForMime(%q, %q) = %q, want %q", tc.mime, tc.fileName, got, tc.want)
		}
	}

	for mime, ext := range mimeExtensions {
		if !knownExtensions[ext] {
			t.Errorf("the mime table maps %s to %q, which declaredExtension would reject", mime, ext)
		}
	}
}

func TestObjectKeyEscapesEveryJIDSeparator(t *testing.T) {
	got := objectKeyAt("org_default", "inst_1", "628990000001:12@s.whatsapp.net", "3EB0A1", "jpg", mustDate("2026-09-13"))
	want := "org/org_default/instance/inst_1/group/628990000001_12_s.whatsapp.net/2026/09/3EB0A1.jpg"
	if got != want {
		t.Errorf("objectKeyAt = %q, want %q", got, want)
	}
}

// pngHeader builds a PNG signature and an IHDR of the requested size — enough
// for the sniffer and the dimension reader, which is all the pipeline looks at.
func pngHeader(w, h int) []byte {
	out := append([]byte{}, pngSignature...)
	out = append(out, 0, 0, 0, 13)
	out = append(out, "IHDR"...)
	out = binary.BigEndian.AppendUint32(out, uint32(w))
	out = binary.BigEndian.AppendUint32(out, uint32(h))
	return append(out, 8, 6, 0, 0, 0)
}

// jpegHeader builds a JFIF APP0 segment followed by a baseline SOF0 carrying
// the requested size.
func jpegHeader(w, h int) []byte {
	out := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10}
	out = append(out, "JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"...)
	out = append(out, 0xFF, 0xC0, 0x00, 0x11, 0x08)
	out = binary.BigEndian.AppendUint16(out, uint16(h))
	out = binary.BigEndian.AppendUint16(out, uint16(w))
	return append(out, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xFF, 0xD9)
}

// mp4Header builds an ISO base media file header with the given file-type brand.
func mp4Header(brand string) []byte {
	out := binary.BigEndian.AppendUint32(nil, 24)
	out = append(out, "ftyp"...)
	out = append(out, brand...)
	out = append(out, 0, 0, 0, 0)
	return append(out, "isom"...)
}

// moovWithMvhd builds the smallest movie header the duration reader accepts.
func moovWithMvhd(version byte, timescale uint32, duration uint64) []byte {
	body := []byte{version, 0, 0, 0}
	if version == 1 {
		body = binary.BigEndian.AppendUint64(body, 0)
		body = binary.BigEndian.AppendUint64(body, 0)
		body = binary.BigEndian.AppendUint32(body, timescale)
		body = binary.BigEndian.AppendUint64(body, duration)
	} else {
		body = binary.BigEndian.AppendUint32(body, 0)
		body = binary.BigEndian.AppendUint32(body, 0)
		body = binary.BigEndian.AppendUint32(body, timescale)
		body = binary.BigEndian.AppendUint32(body, uint32(duration))
	}
	mvhd := binary.BigEndian.AppendUint32(nil, uint32(8+len(body)))
	mvhd = append(mvhd, "mvhd"...)
	mvhd = append(mvhd, body...)

	moov := binary.BigEndian.AppendUint32(nil, uint32(8+len(mvhd)))
	moov = append(moov, "moov"...)
	return append(moov, mvhd...)
}
