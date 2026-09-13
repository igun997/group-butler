package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func TestObjectKeyShape(t *testing.T) {
	got := objectKeyAt("org_default", "inst_1", "120363043123456789@g.us", "3EB0A1", "bin", mustDate("2026-09-13"))
	want := "org/org_default/instance/inst_1/group/120363043123456789_g.us/2026/09/3EB0A1.bin"
	if got != want {
		t.Errorf("objectKeyAt = %q, want %q", got, want)
	}
}

func TestExtensionForMime(t *testing.T) {
	cases := map[string]string{
		"image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4",
		"audio/ogg; codecs=opus": "ogg", "application/pdf": "pdf",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
		"application/x-unknown": "bin",
	}
	for mime, want := range cases {
		if got := extensionForMime(mime, ""); got != want {
			t.Errorf("extensionForMime(%q) = %q, want %q", mime, got, want)
		}
	}
}

func TestR2EndpointDerivation(t *testing.T) {
	// Config deliberately has no endpoint field: the only endpoint that can ever
	// be produced is the account-scoped Cloudflare R2 host.
	if got := r2Endpoint(Config{R2AccountID: "abc123"}); got != "https://abc123.r2.cloudflarestorage.com" {
		t.Errorf("derived endpoint = %q, want the account-scoped R2 host", got)
	}
	if got := r2Endpoint(Config{}); got != "" {
		t.Errorf("endpoint with no account id = %q, want empty so media stays disabled", got)
	}
}

// fakeS3 records what the SDK would have sent and replays a canned response, so
// the private-object rules below are asserted without a network. A test double
// is not an emulator: nothing here stands in for R2 in a running worker — the
// opt-in test at the bottom of this file is the only place real bytes move.
type putCall struct {
	input *s3.PutObjectInput
	body  []byte
}

type fakeS3 struct {
	puts []putCall
	get  *s3.GetObjectInput
	data []byte
	mime string
	err  error
}

func (f *fakeS3) PutObject(_ context.Context, in *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	call := putCall{input: in}
	if in.Body != nil {
		call.body, _ = io.ReadAll(in.Body)
	}
	f.puts = append(f.puts, call)
	if f.err != nil {
		return nil, f.err
	}
	return &s3.PutObjectOutput{}, nil
}

// stored returns the call that wrote key, or nil: a PutObject the SDK built is
// the only thing this double knows about.
func (f *fakeS3) stored(key string) *putCall {
	for i := range f.puts {
		if aws.ToString(f.puts[i].input.Key) == key {
			return &f.puts[i]
		}
	}
	return nil
}

func (f *fakeS3) GetObject(_ context.Context, in *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	f.get = in
	if f.err != nil {
		return nil, f.err
	}
	// An unset data field serves what PutObject carried for this key, so a test
	// can round-trip through both halves of the client.
	body := f.data
	if body == nil {
		if put := f.stored(aws.ToString(in.Key)); put != nil {
			body = put.body
		}
	}
	out := &s3.GetObjectOutput{Body: io.NopCloser(bytes.NewReader(body))}
	if f.mime != "" {
		out.ContentType = aws.String(f.mime)
	}
	return out, nil
}

// TestPipelineStoresThroughTheR2Client joins the two halves: the real key
// scheme, the real upload call, and the real reader, with only the HTTP
// transport replaced. It is the worker-side proof that a parsed attachment
// comes out as a private object at the documented key (§6.3.3, §11.4).
func TestPipelineStoresThroughTheR2Client(t *testing.T) {
	api := &fakeS3{}
	r2 := newR2Client(api, "butler-media", "https://cdn.example", 1<<20)
	pipe := newMediaPipeline(testMediaLimits(), fakeDownloader{data: pngHeader(4, 3)}, r2, "org_default", "inst_1", mediaNow)

	got := pipe.Store(context.Background(), MediaDescriptor{
		Kind: KindImage, DeclaredType: KindImage, Mime: "image/png",
		MessageID: "3EB0C1", GroupJID: "120363043123456789@g.us",
	})
	if got.Status != MediaStored {
		t.Fatalf("media = %+v, want stored", got)
	}
	wantKey := "org/org_default/instance/inst_1/group/120363043123456789_g.us/2026/09/3EB0C1.png"
	if got.R2Key != wantKey {
		t.Errorf("R2Key = %q, want %q", got.R2Key, wantKey)
	}
	if len(api.puts) != 2 {
		t.Fatalf("puts = %d, want the object and its descriptor sidecar", len(api.puts))
	}
	for _, put := range api.puts {
		if aws.ToString(put.input.Bucket) != "butler-media" {
			t.Errorf("put bucket = %q, want the configured bucket", aws.ToString(put.input.Bucket))
		}
		if put.input.ACL != "" {
			t.Errorf("put %q carries ACL %q: every object we write stays private (§11.4)", aws.ToString(put.input.Key), put.input.ACL)
		}
	}
	if ct := aws.ToString(api.puts[0].input.ContentType); ct != "image/png" {
		t.Errorf("object content type = %q, want the sniffed mime", ct)
	}
	if ct := aws.ToString(api.puts[1].input.ContentType); ct != "application/json" {
		t.Errorf("sidecar content type = %q, want application/json", ct)
	}
	if want := "https://cdn.example/" + wantKey; got.PublicURL != want {
		t.Errorf("PublicURL = %q, want %q", got.PublicURL, want)
	}

	data, mime, err := r2.Download(context.Background(), got.R2Key)
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if !bytes.Equal(data, pngHeader(4, 3)) || mime != "image/png" {
		t.Errorf("round trip = (%d bytes, %q), want the stored png", len(data), mime)
	}
}

func TestR2OptionsCarryTheAccountScopedEndpointAndNoPathStyle(t *testing.T) {
	opts, ok := r2Options(Config{R2AccountID: "abc123", R2AccessKeyID: "key", R2SecretKey: "secret"})
	if !ok {
		t.Fatal("r2Options called an account with credentials unconfigured")
	}
	if got := aws.ToString(opts.BaseEndpoint); got != "https://abc123.r2.cloudflarestorage.com" {
		t.Errorf("BaseEndpoint = %q, want the account-scoped R2 host", got)
	}
	if opts.UsePathStyle {
		t.Error("UsePathStyle is set: R2 is addressed virtually-hosted and path style is a different request shape")
	}
	if opts.Region != "auto" {
		t.Errorf("Region = %q, want auto: R2 ignores regions but the SDK must sign with one", opts.Region)
	}

	for _, cfg := range []Config{
		{},
		{R2AccountID: "abc123"},
		{R2AccountID: "abc123", R2AccessKeyID: "key"},
		{R2AccessKeyID: "key", R2SecretKey: "secret"},
	} {
		if _, ok := r2Options(cfg); ok {
			t.Errorf("r2Options(%+v) reported media as configured", cfg)
		}
	}
}

func TestNewR2IsNilUnlessTheBucketIsConfigured(t *testing.T) {
	full := Config{
		R2AccountID: "abc123", R2AccessKeyID: "key", R2SecretKey: "secret",
		R2Bucket: "butler-media", MediaMaxBytes: 1 << 20,
	}
	if got := newR2(full); got == nil {
		t.Fatal("newR2 returned nil for a fully configured account: media would be disabled silently")
	}
	if got := newR2(Config{R2AccountID: "abc123", R2AccessKeyID: "key", R2SecretKey: "secret"}); got != nil {
		t.Error("newR2 built a client without a bucket")
	}
	if got := newR2(Config{}); got != nil {
		t.Error("newR2 built a client with no account id: media must stay disabled rather than reach anywhere else")
	}
}

func TestUploadStoresAPrivateObject(t *testing.T) {
	const key = "org/org_default/instance/inst_1/group/120363043123456789_g.us/2026/09/3EB0A1.png"
	api := &fakeS3{}
	r2 := newR2Client(api, "butler-media", "", 1<<20)
	data := pngHeader(4, 3)

	got, err := r2.Upload(context.Background(), data, key, "image/png")
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	put := api.stored(key)
	if put == nil {
		t.Fatal("Upload issued no PutObject for the key it was given")
	}
	if bucket := aws.ToString(put.input.Bucket); bucket != "butler-media" {
		t.Errorf("put bucket = %q, want the configured bucket", bucket)
	}
	if ct := aws.ToString(put.input.ContentType); ct != "image/png" {
		t.Errorf("put content type = %q, want the sniffed mime", ct)
	}
	if put.input.ACL != "" {
		t.Errorf("put ACL = %q: the bucket is private and R2 rejects a public-read ACL (§11.4)", put.input.ACL)
	}
	if !bytes.Equal(put.body, data) {
		t.Error("the object body is not the bytes handed to Upload")
	}
	if got.Key != key || got.Size != int64(len(data)) {
		t.Errorf("uploadResult = %+v, want key=%q size=%d", got, key, len(data))
	}
	if got.PublicURL != "" {
		t.Errorf("PublicURL = %q without R2_PUBLIC_URL: a private object has no public locator (§11.4)", got.PublicURL)
	}
}

func TestUploadUsesThePublicBaseURLOnlyWhenConfigured(t *testing.T) {
	const key = "org/org_default/instance/inst_1/group/120363043123456789_g.us/2026/09/3EB0A1.png"
	r2 := newR2Client(&fakeS3{}, "butler-media", "https://cdn.example/base/", 1<<20)

	got, err := r2.Upload(context.Background(), []byte("x"), key, "image/png")
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if want := "https://cdn.example/base/" + key; got.PublicURL != want {
		t.Errorf("PublicURL = %q, want %q", got.PublicURL, want)
	}
}

func TestDownloadReturnsTheStoredBytesAndMime(t *testing.T) {
	data := pngHeader(4, 3)
	api := &fakeS3{data: data, mime: "image/png"}
	r2 := newR2Client(api, "butler-media", "", 1<<20)

	gotData, gotMime, err := r2.Download(context.Background(), "org/org_default/instance/inst_1/group/g_g.us/2026/09/3EB0A1.png")
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if !bytes.Equal(gotData, data) {
		t.Error("Download did not return the stored bytes")
	}
	if gotMime != "image/png" {
		t.Errorf("mime = %q, want the object's content type", gotMime)
	}
	if api.get == nil || aws.ToString(api.get.Bucket) != "butler-media" {
		t.Errorf("get request = %+v, want the configured bucket", api.get)
	}
}

func TestDownloadSniffsAnObjectWithoutAContentType(t *testing.T) {
	api := &fakeS3{data: pngHeader(4, 3)}
	r2 := newR2Client(api, "butler-media", "", 1<<20)

	_, mime, err := r2.Download(context.Background(), "org/org_default/instance/inst_1/group/g_g.us/2026/09/3EB0A1.png")
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if mime != "image/png" {
		t.Errorf("mime = %q, want the sniffed content type", mime)
	}
}

func TestDownloadRejectsAnObjectPastTheCap(t *testing.T) {
	api := &fakeS3{data: bytes.Repeat([]byte("a"), 11), mime: "text/plain"}
	r2 := newR2Client(api, "butler-media", "", 10)

	if _, _, err := r2.Download(context.Background(), "org/org_default/instance/inst_1/group/g_g.us/2026/09/3EB0A1.txt"); !errors.Is(err, errMediaTooLarge) {
		t.Errorf("Download error = %v, want errMediaTooLarge so a pathological object cannot exhaust memory (§6.3.2)", err)
	}
}

// liveR2Config returns a real-R2 configuration for the opt-in integration test,
// or skips naming the exact missing piece. Two gates are deliberate: `-short`
// keeps the default suite offline, and R2_INTEGRATION=1 is required so a
// developer with `.env` sourced never writes to the live bucket by accident.
func liveR2Config(t *testing.T) Config {
	t.Helper()
	if testing.Short() {
		t.Skip("short mode: skipping the real-R2 integration test")
	}
	if env("R2_INTEGRATION", "") != "1" {
		t.Skip("real-R2 test is opt-in: set R2_INTEGRATION=1 with the R2_* credentials to exercise the live bucket")
	}
	cfg := Config{
		R2AccountID:   env("R2_ACCOUNT_ID", ""),
		R2AccessKeyID: env("R2_ACCESS_KEY_ID", ""),
		R2SecretKey:   env("R2_SECRET_ACCESS_KEY", ""),
		R2Bucket:      env("R2_BUCKET", ""),
		R2PublicURL:   env("R2_PUBLIC_URL", ""),
		MediaMaxBytes: 1 << 20,
	}
	var missing []string
	for _, v := range []struct{ key, value string }{
		{"R2_ACCOUNT_ID", cfg.R2AccountID},
		{"R2_ACCESS_KEY_ID", cfg.R2AccessKeyID},
		{"R2_SECRET_ACCESS_KEY", cfg.R2SecretKey},
		{"R2_BUCKET", cfg.R2Bucket},
	} {
		if v.value == "" || strings.HasPrefix(v.value, "REPLACE_WITH") {
			missing = append(missing, v.key)
		}
	}
	if len(missing) > 0 {
		t.Skipf("real-R2 test needs %s without placeholder values (see .env.example)", strings.Join(missing, ", "))
	}
	return cfg
}

// TestR2LiveRoundTrip is the only test that touches Cloudflare R2: the real
// service, the derived account endpoint, the real credentials — the same code
// path development and production run, with no emulator and no override
// (assumption 12). It writes one small object under a per-run key.
func TestR2LiveRoundTrip(t *testing.T) {
	cfg := liveR2Config(t)
	r2 := newR2(cfg)
	if r2 == nil {
		t.Fatal("newR2 returned nil for a fully configured account")
	}
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	key := objectKeyAt("org_default", "inst_r2test", "120363043123456789@g.us",
		"r2live"+strconv.FormatInt(time.Now().UnixNano(), 10), "png", time.Now().UTC())
	payload := pngHeader(4, 3)

	up, err := r2.Upload(ctx, payload, key, "image/png")
	if err != nil {
		t.Fatalf("Upload to the real bucket: %v", err)
	}
	if up.Key != key {
		t.Errorf("uploaded key = %q, want %q", up.Key, key)
	}

	data, mime, err := r2.Download(ctx, key)
	if err != nil {
		t.Fatalf("Download from the real bucket: %v", err)
	}
	if !bytes.Equal(data, payload) {
		t.Error("the round-tripped object is not byte-identical to what was uploaded")
	}
	if mime != "image/png" {
		t.Errorf("mime = %q, want the content type we stored", mime)
	}

	assertAnonymousGetRefused(t, r2Endpoint(cfg), cfg.R2Bucket, key)
}

// assertAnonymousGetRefused pins the §11.4 property that cannot be faked: an
// unauthenticated read of the bucket's S3 endpoint must not serve the object.
func assertAnonymousGetRefused(t *testing.T, endpoint, bucket, key string) {
	t.Helper()
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(strings.TrimRight(endpoint, "/") + "/" + bucket + "/" + key)
	if err != nil {
		t.Fatalf("anonymous GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode == http.StatusOK {
		t.Errorf("an unauthenticated GET of %s returned 200: the bucket is public and must not be (§11.4)", key)
	}
}
