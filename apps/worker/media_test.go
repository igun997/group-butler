package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

type fakeDownloader struct {
	data []byte
	err  error
}

func (f fakeDownloader) Download(ctx context.Context, msg MediaDescriptor) (io.ReadCloser, error) {
	if f.err != nil {
		return nil, f.err
	}
	return io.NopCloser(bytes.NewReader(f.data)), nil
}

// streamDownloader hands back whatever stream a test built, including one that
// never ends.
type streamDownloader struct{ stream io.ReadCloser }

func (d streamDownloader) Download(context.Context, MediaDescriptor) (io.ReadCloser, error) {
	return d.stream, nil
}

// countingStream never ends and reports how much was read from it: with it a
// test proves the pipeline aborted at MEDIA_MAX_BYTES instead of draining (and
// allocating) the whole attachment.
type countingStream struct {
	read   int
	closed bool
}

func (s *countingStream) Read(p []byte) (int, error) {
	clear(p)
	s.read += len(p)
	return len(p), nil
}

func (s *countingStream) Close() error {
	s.closed = true
	return nil
}

// uploadCall is one recorded upload, so a test can tell the media object from
// the descriptor sidecar that rides beside it (§6.3.3).
type uploadCall struct {
	data []byte
	key  string
	mime string
}

type fakeUploader struct {
	key   string
	calls int
	mime  string
	err   error

	// uploads records every call in order; failKeySuffix narrows err to the
	// object whose key ends with it (used to fail only the sidecar).
	uploads       []uploadCall
	failKeySuffix string
}

func (f *fakeUploader) Upload(ctx context.Context, data []byte, key, mime string) (uploadResult, error) {
	f.calls++
	f.key = key
	f.mime = mime
	f.uploads = append(f.uploads, uploadCall{data: data, key: key, mime: mime})
	if f.err != nil && (f.failKeySuffix == "" || strings.HasSuffix(key, f.failKeySuffix)) {
		return uploadResult{}, f.err
	}
	return uploadResult{Key: key, Size: int64(len(data)), PublicURL: "http://cdn.local/" + key}, nil
}

// noopUploader stores nothing and records nothing. The concurrency test drives
// several Store calls at once, and a recording double would then need a lock of
// its own — this one has no state to race on.
type noopUploader struct{}

func (noopUploader) Upload(_ context.Context, data []byte, key, _ string) (uploadResult, error) {
	return uploadResult{Key: key, Size: int64(len(data))}, nil
}

// testMediaLimits mirrors the documented media defaults (§6.9) so the pipeline
// tests run with the same shape the worker configures from the environment.
func testMediaLimits() *mediaLimits {
	return newMediaLimits(Config{MediaMaxBytes: 25 << 20, MediaDownloadTimeout: 45 * time.Second, MediaConcurrency: 4})
}

var mediaNow = time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC)

func TestStoreMedia_StoredWhenReadable(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'I', 'H', 'D', 'R', 0, 0, 0, 4, 0, 0, 0, 3}
	up := &fakeUploader{}
	pipe := newMediaPipeline(testMediaLimits(), fakeDownloader{data: png}, up, "org_default", "inst_1", mediaNow)
	got := pipe.Store(context.Background(), MediaDescriptor{
		DeclaredType: "image", Kind: "image", Mime: "image/png", MessageID: "3EB0A1", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaStored {
		t.Fatalf("Status = %q (err=%q), want stored", got.Status, got.Error)
	}
	if got.Width != 4 || got.Height != 3 {
		t.Errorf("dimensions = %dx%d, want 4x3", got.Width, got.Height)
	}
	if got.R2Key == "" || len(up.uploads) != 2 {
		t.Fatalf("expected the object then its sidecar, got key=%q uploads=%d", got.R2Key, len(up.uploads))
	}
	if up.uploads[0].key != got.R2Key || up.uploads[1].key != got.R2Key[:len(got.R2Key)-len(".png")]+".meta.json" {
		t.Errorf("upload keys = %q, %q, want the object and its descriptor sidecar", up.uploads[0].key, up.uploads[1].key)
	}
}

func TestStoreMedia_ExtractsUTF8DocumentText(t *testing.T) {
	pipe := newMediaPipeline(testMediaLimits(), fakeDownloader{data: []byte("status,owner\nready,alice\n")}, &fakeUploader{}, "org_default", "inst_1", mediaNow)
	got := pipe.Store(context.Background(), MediaDescriptor{
		DeclaredType: KindDocument, Kind: KindDocument, Mime: "text/csv", MessageID: "3EB0DOC", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaStored || got.Kind != KindDocument || got.Mime != "text/plain" {
		t.Fatalf("document = %+v, want stored text document", got)
	}
	if got.Text != "status,owner\nready,alice" {
		t.Fatalf("extracted text = %q", got.Text)
	}
}

func TestStoreMedia_UnparsedKeepsDeclaredTypeAndLink(t *testing.T) {
	up := &fakeUploader{}
	pipe := newMediaPipeline(testMediaLimits(), fakeDownloader{data: []byte{0x00, 0x01, 0x02, 0x03}}, up, "org_default", "inst_1", mediaNow)
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
	pipe := newMediaPipeline(testMediaLimits(), fakeDownloader{err: errors.New("media key missing")}, up, "org_default", "inst_1", mediaNow)
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

func (c countingDownloader) Download(context.Context, MediaDescriptor) (io.ReadCloser, error) {
	*c.calls++
	return nil, errors.New("a descriptor that must not be fetched was fetched")
}

func TestStoreMedia_ViewOnceIsUnavailableWithoutFetching(t *testing.T) {
	downloads := 0
	up := &fakeUploader{}
	pipe := newMediaPipeline(testMediaLimits(), countingDownloader{calls: &downloads}, up, "org_default", "inst_1", mediaNow)

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
	pipe := newMediaPipeline(testMediaLimits(), fakeDownloader{data: data}, up, "org_default", "inst_1", mediaNow)

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
	if len(up.uploads) != 2 {
		t.Fatalf("uploads = %d, want the opaque object and its descriptor sidecar", len(up.uploads))
	}
	if up.uploads[0].key != got.R2Key || up.uploads[1].key != got.R2Key[:len(got.R2Key)-len(".bin")]+".meta.json" {
		t.Errorf("upload keys = %q, %q, want <id>.bin and <id>.meta.json (§6.3.3)", up.uploads[0].key, up.uploads[1].key)
	}
}

func TestStoreMedia_TransientDownloadFailureStaysRetryable(t *testing.T) {
	up := &fakeUploader{}
	pipe := newMediaPipeline(testMediaLimits(), fakeDownloader{err: context.DeadlineExceeded}, up, "org_default", "inst_1", mediaNow)

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
	pipe := newMediaPipeline(testMediaLimits(), fakeDownloader{err: errMediaTooLarge}, &fakeUploader{}, "org_default", "inst_1", mediaNow)

	got := pipe.Store(context.Background(), MediaDescriptor{
		Kind: KindVideo, DeclaredType: KindVideo, MessageID: "3EB0B7", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaUnavailable || got.Reason != "too_large" {
		t.Errorf("media = %+v, want unavailable/too_large: no retry will shrink the attachment (§6.3.2)", got)
	}
}

func TestStoreMedia_UploadFailureIsFailed(t *testing.T) {
	up := &fakeUploader{err: errors.New("r2 put: ServiceUnavailable")}
	pipe := newMediaPipeline(testMediaLimits(), fakeDownloader{data: pngHeader(4, 3)}, up, "org_default", "inst_1", mediaNow)

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

func TestStoreMedia_KindFollowsTheBytesNotTheDescriptor(t *testing.T) {
	cases := []struct {
		name         string
		descKind     Kind
		declared     Kind
		data         []byte
		wantKind     Kind
		wantDeclared Kind
	}{
		{"image descriptor, image bytes", KindImage, KindImage, pngHeader(4, 3), KindImage, KindImage},
		{"image descriptor, video bytes", KindImage, KindImage, mp4Header("isom"), KindVideo, KindImage},
		{"video note, video bytes", KindPtv, KindPtv, mp4Header("isom"), KindVideo, KindPtv},
		{"sticker, webp bytes", KindSticker, KindSticker, []byte("RIFF\x10\x00\x00\x00WEBPVP8 "), KindImage, KindSticker},
		{"document descriptor, pdf bytes", KindDocument, KindDocument, []byte("%PDF-1.7\n"), KindDocument, KindDocument},
		{"audio descriptor, ogg bytes", KindAudio, KindAudio, []byte("OggS\x00\x02\x00\x00\x00\x00\x00\x00"), KindAudio, KindAudio},
		{"image descriptor, zip bytes", KindImage, KindImage, []byte("PK\x03\x04\x14\x00\x00\x00"), KindDocument, KindImage},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			up := &fakeUploader{}
			pipe := newMediaPipeline(testMediaLimits(), fakeDownloader{data: tc.data}, up, "org_default", "inst_1", mediaNow)
			got := pipe.Store(context.Background(), MediaDescriptor{
				Kind: tc.descKind, DeclaredType: tc.declared, MessageID: "3EB0D1", GroupJID: "120363043123456789@g.us",
			})
			if got.Status != MediaStored {
				t.Fatalf("media = %+v, want stored", got)
			}
			if got.Kind != tc.wantKind {
				t.Errorf("Kind = %q, want %q: media.kind describes the bytes we stored, not what the descriptor claimed (§6.3.4)", got.Kind, tc.wantKind)
			}
			if got.DeclaredType != tc.wantDeclared {
				t.Errorf("DeclaredType = %q, want %q: WhatsApp's claim is what keeps a sticker or video note visible (R3)", got.DeclaredType, tc.wantDeclared)
			}
		})
	}
}

// blockingDownloader models an attachment that never arrives: only the deadline
// the pipeline imposed can end the call.
type blockingDownloader struct{}

func (blockingDownloader) Download(ctx context.Context, _ MediaDescriptor) (io.ReadCloser, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestStoreMedia_CapsAnOversizedDownloaderResponse(t *testing.T) {
	up := &fakeUploader{}
	limits := newMediaLimits(Config{MediaMaxBytes: 8, MediaDownloadTimeout: time.Second, MediaConcurrency: 1})
	pipe := newMediaPipeline(limits, fakeDownloader{data: bytes.Repeat([]byte("a"), 9)}, up, "org_default", "inst_1", mediaNow)

	got := pipe.Store(context.Background(), MediaDescriptor{
		Kind: KindDocument, DeclaredType: KindDocument, MessageID: "3EB0D2", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaUnavailable || got.Reason != "too_large" {
		t.Errorf("media = %+v, want unavailable/too_large: MEDIA_MAX_BYTES bounds what a downloader may hand back (§6.3.2)", got)
	}
	if !strings.Contains(got.Error, "MEDIA_MAX_BYTES") {
		t.Errorf("Error = %q, want it to name the cap that was hit", got.Error)
	}
	if up.calls != 0 {
		t.Error("an attachment past the cap was uploaded anyway")
	}
}

func TestStoreMedia_StopsReadingAStreamPastTheCap(t *testing.T) {
	limits := newMediaLimits(Config{MediaMaxBytes: 8, MediaDownloadTimeout: time.Second, MediaConcurrency: 1})
	stream := &countingStream{}
	up := &fakeUploader{}
	pipe := newMediaPipeline(limits, streamDownloader{stream: stream}, up, "org_default", "inst_1", mediaNow)

	got := pipe.Store(context.Background(), MediaDescriptor{
		Kind: KindDocument, DeclaredType: KindDocument, MessageID: "3EB0F2", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaUnavailable || got.Reason != "too_large" {
		t.Errorf("media = %+v, want unavailable/too_large", got)
	}
	if stream.read > 9 {
		t.Errorf("read %d bytes from an endless stream under an 8-byte cap: the copy must abort at the cap rather than consume the attachment (§6.3.2)", stream.read)
	}
	if !stream.closed {
		t.Error("the stream was not closed: a downloader releases its scratch space on Close")
	}
	if up.calls != 0 {
		t.Error("an attachment past the cap was uploaded")
	}
}

func TestStoreMedia_AppliesTheConfiguredDownloadTimeout(t *testing.T) {
	limits := newMediaLimits(Config{MediaMaxBytes: 1 << 20, MediaDownloadTimeout: 25 * time.Millisecond, MediaConcurrency: 1})
	pipe := newMediaPipeline(limits, blockingDownloader{}, &fakeUploader{}, "org_default", "inst_1", mediaNow)

	start := time.Now()
	got := pipe.Store(context.Background(), MediaDescriptor{
		Kind: KindImage, DeclaredType: KindImage, MessageID: "3EB0D3", GroupJID: "120363043123456789@g.us",
	})
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("Store took %s, want the configured 25ms MEDIA_DOWNLOAD_TIMEOUT to cut the download short", elapsed)
	}
	if got.Status != MediaFailed || !strings.Contains(got.Error, context.DeadlineExceeded.Error()) {
		t.Errorf("media = %+v, want failed with the deadline error: the per-download timeout is the configured one (§6.3.2)", got)
	}
}

func TestStoreMedia_BoundsConcurrentDownloads(t *testing.T) {
	const (
		concurrency = 2
		callers     = 6
	)
	limits := newMediaLimits(Config{MediaMaxBytes: 1 << 20, MediaDownloadTimeout: 5 * time.Second, MediaConcurrency: concurrency})
	probe := newConcurrencyProbe(concurrency)
	// Two pipelines built from one limits value: the manager builds a pipeline
	// per media job, so MEDIA_CONCURRENCY has to bound the process, not one job.
	pipes := []*mediaPipeline{
		newMediaPipeline(limits, probe, noopUploader{}, "org_default", "inst_1", mediaNow),
		newMediaPipeline(limits, probe, noopUploader{}, "org_default", "inst_1", mediaNow),
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range callers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			pipes[i%len(pipes)].Store(context.Background(), MediaDescriptor{
				Kind: KindImage, DeclaredType: KindImage, MessageID: "3EB0D4", GroupJID: "120363043123456789@g.us",
			})
		}(i)
	}
	close(start)

	if !probe.waitFor(concurrency, 2*time.Second) {
		t.Fatal("fewer than MEDIA_CONCURRENCY downloads ever ran at once: the semaphore is blocking everything")
	}
	// The settle window is what makes an over-subscribed semaphore observable:
	// the remaining callers are runnable, so without a bound they enter Download.
	time.Sleep(50 * time.Millisecond)
	probe.releaseAll()
	wg.Wait()

	if got := probe.maxInFlight(); got > concurrency {
		t.Errorf("%d downloads ran at once, want at most MEDIA_CONCURRENCY=%d (§6.3.2)", got, concurrency)
	}
	if got := probe.maxInFlight(); got != concurrency {
		t.Errorf("max in flight = %d, want exactly %d: the bound must be reachable, not a global lock", got, concurrency)
	}
}

// concurrencyProbe is a downloader that reports how many downloads the pipeline
// let run at once by holding each call inside Download until releaseAll.
type concurrencyProbe struct {
	limit   int
	done    chan struct{}
	reached chan struct{}
	once    sync.Once

	mu       sync.Mutex
	inFlight int
	max      int
}

func newConcurrencyProbe(limit int) *concurrencyProbe {
	return &concurrencyProbe{limit: limit, done: make(chan struct{}), reached: make(chan struct{})}
}

func (c *concurrencyProbe) Download(_ context.Context, _ MediaDescriptor) (io.ReadCloser, error) {
	c.mu.Lock()
	c.inFlight++
	if c.inFlight > c.max {
		c.max = c.inFlight
	}
	if c.inFlight >= c.limit {
		c.once.Do(func() { close(c.reached) })
	}
	c.mu.Unlock()

	<-c.done

	c.mu.Lock()
	c.inFlight--
	c.mu.Unlock()
	return io.NopCloser(bytes.NewReader(pngHeader(1, 1))), nil
}

func (c *concurrencyProbe) waitFor(n int, timeout time.Duration) bool {
	select {
	case <-c.reached:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (c *concurrencyProbe) releaseAll() { close(c.done) }

func (c *concurrencyProbe) maxInFlight() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.max
}

func TestStoreMedia_WritesTheDeterministicDescriptorSidecar(t *testing.T) {
	desc := MediaDescriptor{
		Kind: KindImage, DeclaredType: KindImage, Mime: "image/jpeg", FileName: "chart.png",
		MessageID: "3EB0E1", GroupJID: "120363043123456789@g.us",
	}
	png := pngHeader(4, 3)
	up := &fakeUploader{}
	pipe := newMediaPipeline(testMediaLimits(), fakeDownloader{data: png}, up, "org_default", "inst_1", mediaNow)

	got := pipe.Store(context.Background(), desc)
	if got.Status != MediaStored {
		t.Fatalf("media = %+v, want stored", got)
	}
	if len(up.uploads) != 2 {
		t.Fatalf("uploads = %d, want the object and its descriptor sidecar (§6.3.3)", len(up.uploads))
	}
	object, sidecar := up.uploads[0], up.uploads[1]
	const prefix = "org/org_default/instance/inst_1/group/120363043123456789_g.us/2026/09/"
	if object.key != prefix+"3EB0E1.png" || object.mime != "image/png" {
		t.Errorf("media upload = %q (%s), want the sniffed object", object.key, object.mime)
	}
	if sidecar.key != prefix+"3EB0E1.meta.json" || sidecar.mime != "application/json" {
		t.Errorf("sidecar upload = %q (%s), want <waMessageId>.meta.json beside the object", sidecar.key, sidecar.mime)
	}

	var doc map[string]any
	if err := json.Unmarshal(sidecar.data, &doc); err != nil {
		t.Fatalf("sidecar is not JSON: %v", err)
	}
	for key, want := range map[string]any{
		"organizationId": "org_default",
		"instanceId":     "inst_1",
		"groupJid":       "120363043123456789@g.us",
		"waMessageId":    "3EB0E1",
		"status":         "stored",
		"kind":           "image",
		"declaredType":   "image",
		"mime":           "image/png",
		"fileName":       "chart.png",
		"size":           float64(len(png)),
		"sha256":         sha256Hex(png),
		"width":          float64(4),
		"height":         float64(3),
		"r2Key":          object.key,
	} {
		if got := doc[key]; got != want {
			t.Errorf("sidecar %s = %v, want %v", key, got, want)
		}
	}

	// Immutable in effect: the payload is a pure function of the descriptor and
	// the key is stable, so a retry rewrites identical bytes rather than a
	// different record.
	again := &fakeUploader{}
	newMediaPipeline(testMediaLimits(), fakeDownloader{data: png}, again, "org_default", "inst_1", mediaNow).Store(context.Background(), desc)
	if len(again.uploads) != 2 {
		t.Fatalf("second attempt uploads = %d, want 2", len(again.uploads))
	}
	if again.uploads[1].key != sidecar.key || !bytes.Equal(again.uploads[1].data, sidecar.data) {
		t.Error("the sidecar is not deterministic: a retry would rewrite a different record")
	}
}

func TestStoreMedia_SidecarFailureFailsTheAttemptWithoutALocator(t *testing.T) {
	up := &fakeUploader{err: errors.New("r2 put sidecar: ServiceUnavailable"), failKeySuffix: ".meta.json"}
	pipe := newMediaPipeline(testMediaLimits(), fakeDownloader{data: pngHeader(4, 3)}, up, "org_default", "inst_1", mediaNow)

	got := pipe.Store(context.Background(), MediaDescriptor{
		Kind: KindImage, DeclaredType: KindImage, MessageID: "3EB0E2", GroupJID: "120363043123456789@g.us",
	})
	if len(up.uploads) != 2 {
		t.Fatalf("uploads = %d, want the object and the attempted sidecar", len(up.uploads))
	}
	if got.Status != MediaFailed {
		t.Errorf("Status = %q, want failed: a record must not claim a stored attachment without its descriptor", got.Status)
	}
	if got.Error == "" {
		t.Error("Error is empty: the attempt failed for a reason worth recording")
	}
	if got.R2Key != "" || got.PublicURL != "" {
		t.Errorf("media = %+v, want no locator while the descriptor is missing (the janitor retries both writes)", got)
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
		{"media gone (410)", whatsmeow.ErrMediaDownloadFailedWith410, MediaUnavailable, "expired"},
		{"media forbidden (403)", whatsmeow.ErrMediaDownloadFailedWith403, MediaUnavailable, "expired"},
		{"media missing (404)", whatsmeow.ErrMediaDownloadFailedWith404, MediaUnavailable, "expired"},
		{"no longer on the phone", whatsmeow.ErrMediaNotAvailableOnPhone, MediaUnavailable, "expired"},
		{"nothing downloadable", whatsmeow.ErrNothingDownloadableFound, MediaUnavailable, "unsupported_type"},
		{"no url present", whatsmeow.ErrNoURLPresent, MediaUnavailable, "unsupported_type"},
		{"unknown media type", whatsmeow.ErrUnknownMediaType, MediaUnavailable, "unsupported_type"},
		{"corrupt hmac", whatsmeow.ErrInvalidMediaHMAC, MediaUnavailable, "download_failed"},
		{"plaintext hash mismatch", whatsmeow.ErrInvalidMediaSHA256, MediaUnavailable, "download_failed"},
		{"truncated payload", whatsmeow.ErrTooShortFile, MediaUnavailable, "download_failed"},
		{"host having a bad day (503)", whatsmeow.DownloadHTTPError{Response: &http.Response{StatusCode: http.StatusServiceUnavailable}}, MediaFailed, ""},
		{"host throttling (429)", whatsmeow.DownloadHTTPError{Response: &http.Response{StatusCode: http.StatusTooManyRequests}}, MediaFailed, ""},
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
		{"webp", webpHeader("VP8 ", 4, 3), "image/webp", "webp"},
		{"webm", webmHeader("webm"), "video/webm", "webm"},
		{"matroska", webmHeader("matroska"), "video/x-matroska", "mkv"},
		{"wav", wavHeader(), "audio/wav", "wav"},
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
		{"webp vp8", webpHeader("VP8 ", 6, 4), 6, 4},
		{"webp vp8l", webpHeader("VP8L", 7, 5), 7, 5},
		{"webp vp8x", webpHeader("VP8X", 8, 6), 8, 6},
		{"webp without a frame header", []byte("RIFF\x10\x00\x00\x00WEBPJUNK"), 0, 0},
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
	// Each node is built once so the descriptor can be expected to carry that
	// exact node: the authenticated download request is built from it.
	image := &waE2E.ImageMessage{Mimetype: proto.String("image/jpeg"), FileLength: proto.Uint64(7)}
	ptv := &waE2E.VideoMessage{Mimetype: proto.String("video/mp4"), FileLength: proto.Uint64(8)}
	voice := &waE2E.AudioMessage{Mimetype: proto.String("audio/ogg; codecs=opus"), FileLength: proto.Uint64(9)}
	document := &waE2E.DocumentMessage{
		Mimetype: proto.String("application/pdf"), FileName: proto.String("invoice.pdf"), FileLength: proto.Uint64(10),
	}
	sticker := &waE2E.StickerMessage{Mimetype: proto.String("image/webp"), FileLength: proto.Uint64(11)}
	wrapped := &waE2E.ImageMessage{Mimetype: proto.String("image/jpeg"), FileLength: proto.Uint64(7)}

	cases := []struct {
		name string
		msg  *waE2E.Message
		want MediaDescriptor
	}{
		{"image", &waE2E.Message{ImageMessage: image},
			MediaDescriptor{Kind: KindImage, DeclaredType: KindImage, Mime: "image/jpeg", Size: 7, Node: image}},
		{"video note", &waE2E.Message{PtvMessage: ptv},
			MediaDescriptor{Kind: KindPtv, DeclaredType: KindPtv, Mime: "video/mp4", Size: 8, Node: ptv}},
		{"voice note", &waE2E.Message{AudioMessage: voice},
			MediaDescriptor{Kind: KindAudio, DeclaredType: KindAudio, Mime: "audio/ogg; codecs=opus", Size: 9, Node: voice}},
		{"document", &waE2E.Message{DocumentMessage: document},
			MediaDescriptor{Kind: KindDocument, DeclaredType: KindDocument, Mime: "application/pdf", FileName: "invoice.pdf", Size: 10, Node: document}},
		{"sticker", &waE2E.Message{StickerMessage: sticker},
			MediaDescriptor{Kind: KindSticker, DeclaredType: KindSticker, Mime: "image/webp", Size: 11, Node: sticker}},
		{"view-once wrapper", &waE2E.Message{ViewOnceMessage: &waE2E.FutureProofMessage{
			Message: &waE2E.Message{ImageMessage: wrapped},
		}}, MediaDescriptor{
			Kind: KindImage, DeclaredType: declaredViewOnce, Mime: "image/jpeg", Size: 7, ViewOnce: true, Node: wrapped,
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
			if got.Node == nil {
				t.Error("the descriptor carries no node: nothing could build the authenticated download request")
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

// webpHeader builds a WebP RIFF container in one of its three frame layouts:
// VP8X (extended), VP8 (lossy) or VP8L (lossless).
func webpHeader(fourcc string, w, h int) []byte {
	switch fourcc {
	case "VP8X":
		out := []byte("RIFF")
		out = binary.LittleEndian.AppendUint32(out, 4+8+10)
		out = append(out, "WEBP"...)
		out = append(out, "VP8X"...)
		out = binary.LittleEndian.AppendUint32(out, 10)
		out = append(out, 0, 0, 0, 0) // flags + reserved
		out = append(out, be24(w-1)...)
		out = append(out, be24(h-1)...)
		return out
	case "VP8L":
		bits := uint32(w-1) | uint32(h-1)<<14
		out := []byte("RIFF")
		out = binary.LittleEndian.AppendUint32(out, 4+8+5)
		out = append(out, "WEBP"...)
		out = append(out, "VP8L"...)
		out = binary.LittleEndian.AppendUint32(out, 5)
		out = append(out, 0x2F)
		return binary.LittleEndian.AppendUint32(out, bits)
	default:
		out := []byte("RIFF")
		out = binary.LittleEndian.AppendUint32(out, 4+8+10)
		out = append(out, "WEBP"...)
		out = append(out, "VP8 "...)
		out = binary.LittleEndian.AppendUint32(out, 10)
		out = append(out, 0, 0, 0)          // frame tag
		out = append(out, 0x9D, 0x01, 0x2A) // start code
		out = binary.LittleEndian.AppendUint16(out, uint16(w))
		return binary.LittleEndian.AppendUint16(out, uint16(h))
	}
}

// be24 is the 24-bit little-endian canvas size a VP8X chunk carries.
func be24(v int) []byte { return []byte{byte(v), byte(v >> 8), byte(v >> 16)} }

// webmHeader builds an EBML header carrying the DocType, which is the only
// part of a WebM/Matroska file the sniffer reads.
func webmHeader(docType string) []byte {
	out := []byte{0x1A, 0x45, 0xDF, 0xA3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
	out = append(out, 0x42, 0x82, byte(len(docType)))
	return append(out, docType...)
}

// wavHeader builds the RIFF/WAVE header of an uncompressed audio file.
func wavHeader() []byte {
	out := []byte("RIFF")
	out = binary.LittleEndian.AppendUint32(out, 36)
	out = append(out, "WAVE"...)
	out = append(out, "fmt "...)
	out = binary.LittleEndian.AppendUint32(out, 16)
	return append(out, make([]byte, 16)...)
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
