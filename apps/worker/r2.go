package main

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// s3API is the narrow slice of the AWS SDK v2 S3 client this worker uses. The
// concrete `*s3.Client` satisfies it, and the tests substitute a recording fake
// so the private-object rules can be asserted without a network. There is no
// other SDK in the project: object storage is AWS SDK v2 against R2 only.
type s3API interface {
	PutObject(ctx context.Context, in *s3.PutObjectInput, opt ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	GetObject(ctx context.Context, in *s3.GetObjectInput, opt ...func(*s3.Options)) (*s3.GetObjectOutput, error)
}

// uploadResult is what one stored object tells its caller: where it lives, how
// many bytes went in, and the locator the dashboard may show (empty while the
// bucket is private and reads are presigned, §11.4).
type uploadResult struct {
	Key       string
	Size      int64
	PublicURL string
}

// r2Client is the worker's whole object-storage surface: put the bytes we were
// given, read back what we stored. It is nil whenever media is unconfigured —
// the reference worker's no-op convention, kept because a worker with no bucket
// must still ingest every message (§6.1).
type r2Client struct {
	api           s3API
	bucket        string
	publicBaseURL string
	maxDownload   int64
}

// r2Endpoint derives the account-scoped R2 host — the only endpoint this
// program can produce. It is derived from R2_ACCOUNT_ID rather than configured,
// so there is no endpoint override, no path-style addressing and no local
// emulator to point it at (§6.3.3, assumption 12). An absent account id yields
// "", which keeps media disabled instead of reaching somewhere else.
func r2Endpoint(cfg Config) string {
	if cfg.R2AccountID == "" {
		return ""
	}
	return "https://" + cfg.R2AccountID + ".r2.cloudflarestorage.com"
}

// r2Options builds the AWS SDK v2 options for that endpoint and reports whether
// media is configured at all. Without static credentials the SDK would hunt for
// an instance role and sign anonymous requests, so credentials are part of
// "configured" rather than a request-time error.
func r2Options(cfg Config) (s3.Options, bool) {
	endpoint := r2Endpoint(cfg)
	if endpoint == "" || cfg.R2AccessKeyID == "" || cfg.R2SecretKey == "" {
		return s3.Options{}, false
	}
	return s3.Options{
		// R2 ignores the region but the SDK must sign with one, and "auto" is
		// the value Cloudflare documents.
		Region:       "auto",
		BaseEndpoint: aws.String(endpoint),
		Credentials:  credentials.NewStaticCredentialsProvider(cfg.R2AccessKeyID, cfg.R2SecretKey, ""),
		// UsePathStyle is deliberately left false: R2 is addressed
		// virtually-hosted, and a path-style request is a different shape.
	}, true
}

// newR2 builds the client, or returns nil when media is not configured. The
// caller treats nil as "media disabled" and never reaches the pipeline, which
// is why the disabled case is logged loudly here (§6.9).
func newR2(cfg Config) *r2Client {
	opts, ok := r2Options(cfg)
	if !ok || cfg.R2Bucket == "" {
		logf("r2: media handling disabled — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET to store attachments")
		return nil
	}
	return newR2Client(s3.New(opts), cfg.R2Bucket, cfg.R2PublicURL, cfg.MediaMaxBytes)
}

// newR2Client is the injectable half of newR2: the bucket, the optional public
// base URL, and the byte cap that bounds a read.
func newR2Client(api s3API, bucket, publicBaseURL string, maxDownloadBytes int64) *r2Client {
	return &r2Client{
		api:           api,
		bucket:        bucket,
		publicBaseURL: strings.TrimRight(publicBaseURL, "/"),
		maxDownload:   maxDownloadBytes,
	}
}

// Upload stores one object under the key the pipeline derived. No ACL is sent:
// the bucket is private, R2 rejects a public-read ACL, and the dashboard reads
// through a presigned URL — or through R2_PUBLIC_URL when an operator points it
// at a CDN fronting a private-read policy (§11.4).
func (r *r2Client) Upload(ctx context.Context, data []byte, key, mime string) (uploadResult, error) {
	if _, err := r.api.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(r.bucket),
		Key:           aws.String(key),
		Body:          bytes.NewReader(data),
		ContentLength: aws.Int64(int64(len(data))),
		ContentType:   aws.String(mime),
	}); err != nil {
		return uploadResult{}, fmt.Errorf("r2 put %s: %w", key, err)
	}
	result := uploadResult{Key: key, Size: int64(len(data))}
	if r.publicBaseURL != "" {
		result.PublicURL = r.publicBaseURL + "/" + key
	}
	return result, nil
}

// Download reads one object back under the same byte cap that bounds the
// WhatsApp download, so a pathological object cannot exhaust worker memory
// (§6.3.2). The MIME comes from the object's own content type, and from the
// bytes themselves when something else stored it without one (§11.4).
func (r *r2Client) Download(ctx context.Context, key string) ([]byte, string, error) {
	out, err := r.api.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(r.bucket), Key: aws.String(key)})
	if err != nil {
		return nil, "", fmt.Errorf("r2 get %s: %w", key, err)
	}
	defer func() { _ = out.Body.Close() }()

	var buf bytes.Buffer
	if _, err := copyCapped(&buf, out.Body, r.maxDownload); err != nil {
		return nil, "", fmt.Errorf("r2 get %s: %w", key, err)
	}

	mime := aws.ToString(out.ContentType)
	if mime == "" {
		if sniffed, ok := sniffMedia(buf.Bytes()); ok {
			mime = sniffed
		} else {
			mime = unparsedMime
		}
	}
	return buf.Bytes(), mime, nil
}

// jidKeyReplacer escapes the characters a JID may carry that are meaningful in
// an object key (the `@` of the server and the `:` of a device suffix).
var jidKeyReplacer = strings.NewReplacer("@", "_", ":", "_")

// objectKeyAt is the §6.3.3 key:
//
//	org/<organizationId>/instance/<instanceId>/group/<groupJid-safe>/<YYYY>/<MM>/<waMessageId>.<ext>
//
// Partitioning by year and month keeps listings and lifecycle rules cheap. The
// date is passed in rather than read from the clock so a caller retrying a
// backlog files an object under the day it is handling.
func objectKeyAt(orgID, instanceID, groupJID, messageID, ext string, at time.Time) string {
	utc := at.UTC()
	return fmt.Sprintf("org/%s/instance/%s/group/%s/%s/%s/%s.%s",
		orgID, instanceID, jidKeyReplacer.Replace(groupJID), utc.Format("2006"), utc.Format("01"), messageID, ext)
}

// mimeExtensions maps a sniffed or declared MIME type to the object key's
// extension, following the reference worker's table (§6.3.3).
var mimeExtensions = map[string]string{
	"image/jpeg": "jpg",
	"image/jpg":  "jpg",
	"image/png":  "png",
	"image/webp": "webp",
	"image/gif":  "gif",

	"video/mp4":        "mp4",
	"video/3gpp":       "3gp",
	"video/quicktime":  "mov",
	"video/webm":       "webm",
	"video/x-matroska": "mkv",

	"audio/ogg":   "ogg",
	"audio/mpeg":  "mp3",
	"audio/mp4":   "m4a",
	"audio/x-m4a": "m4a",
	"audio/wav":   "wav",

	"application/pdf": "pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":       "xlsx",
	"text/plain":      "txt",
	"text/csv":        "csv",
	"application/zip": "zip",
}

// genericContainerMimes are the types whose container says nothing about the
// real format: a ZIP is also a docx, an xlsx or a plain archive, and only the
// declared file name can say which.
var genericContainerMimes = map[string]bool{"application/zip": true}

// knownExtensions are the extensions a declared file name may select. The name
// travels from the sender, so it can never introduce an extension this program
// does not already store — it only chooses between containers we handle.
var knownExtensions = map[string]bool{
	"jpg": true, "jpeg": true, "png": true, "webp": true, "gif": true,
	"mp4": true, "mov": true, "3gp": true, "webm": true, "mkv": true,
	"ogg": true, "mp3": true, "m4a": true, "wav": true,
	"pdf": true, "docx": true, "xlsx": true, "txt": true, "csv": true, "zip": true,
}

// extensionForMime picks the key's extension. Content wins: the MIME comes from
// the bytes we hold, never from what a sender claimed (§11.4). Only a generic
// container leaves the choice to the file name, and anything unknown is stored
// as an opaque `bin` (§6.3.3).
func extensionForMime(mime, fileName string) string {
	mime = normalizeMime(mime)
	if ext, ok := mimeExtensions[mime]; ok && !genericContainerMimes[mime] {
		return ext
	}
	if ext := declaredExtension(fileName); ext != "" {
		return ext
	}
	if ext, ok := mimeExtensions[mime]; ok {
		return ext
	}
	return unparsedExt
}

// normalizeMime lowercases a MIME value and drops its parameters, so
// `audio/ogg; codecs=opus` is recognized as the container it is.
func normalizeMime(mime string) string {
	mime = strings.ToLower(strings.TrimSpace(mime))
	if i := strings.IndexByte(mime, ';'); i >= 0 {
		mime = strings.TrimSpace(mime[:i])
	}
	return mime
}

// declaredExtension returns the file name's extension only when it names a
// container this program stores; dotted paths and unknown types yield "".
func declaredExtension(fileName string) string {
	dot := strings.LastIndexByte(fileName, '.')
	if dot < 0 || dot == len(fileName)-1 {
		return ""
	}
	ext := strings.ToLower(fileName[dot+1:])
	if !knownExtensions[ext] {
		return ""
	}
	return ext
}
