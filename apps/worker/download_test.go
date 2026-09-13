package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
)

// writingClient stands in for the whatsmeow client's download call: it writes
// the payload into the File the adapter handed it, in chunks, which is what the
// library's own io.Copy does (download-to-file.go:downloadMediaToFile). The
// production path calls the real client; this only drives the adapter's capping
// and cleanup logic without a socket.
type writingClient struct {
	payload  []byte
	chunk    int
	requests int
	written  int
	scratch  string
	err      error
}

func (c *writingClient) DownloadToFile(ctx context.Context, msg whatsmeow.DownloadableMessage, file whatsmeow.File) error {
	c.requests++
	if named, ok := file.(interface{ Name() string }); ok {
		c.scratch = named.Name()
	}
	if c.err != nil {
		return c.err
	}
	for off := 0; off < len(c.payload); off += c.chunk {
		end := min(off+c.chunk, len(c.payload))
		n, err := file.Write(c.payload[off:end])
		c.written += n
		if err != nil {
			return err
		}
	}
	return nil
}

func TestCappedFileRefusesToGrowPastTheCap(t *testing.T) {
	raw, err := os.CreateTemp(t.TempDir(), "scratch")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	t.Cleanup(func() { _ = raw.Close() })
	capped := &cappedFile{File: raw, max: 8}

	if _, err := capped.Write(make([]byte, 8)); err != nil {
		t.Fatalf("writing exactly the cap: %v", err)
	}
	if _, err := capped.Write([]byte("x")); !errors.Is(err, errMediaTooLarge) {
		t.Fatalf("write past the cap = %v, want errMediaTooLarge", err)
	}
	if info, err := capped.Stat(); err != nil || info.Size() != 8 {
		t.Errorf("scratch size = %v (err %v), want the cap and not one byte more", info, err)
	}

	// whatsmeow rewinds and rewrites the same bytes when a download is retried
	// (downloadPossiblyEncryptedMediaWithRetriesToFile), so the cap has to bound
	// the file's length, not the number of bytes ever written.
	if _, err := capped.Seek(0, io.SeekStart); err != nil {
		t.Fatalf("Seek: %v", err)
	}
	if _, err := capped.Write(make([]byte, 8)); err != nil {
		t.Errorf("rewriting a rewound scratch file: %v", err)
	}
}

func TestWhatsmeowDownloaderStopsAnOversizedStreamMidFlight(t *testing.T) {
	limits := newMediaLimits(Config{MediaMaxBytes: 16, MediaDownloadTimeout: time.Second, MediaConcurrency: 1})
	client := &writingClient{payload: bytes.Repeat([]byte("a"), 4096), chunk: 256}
	downloader := newWhatsmeowDownloader(client, limits)

	stream, err := downloader.Download(context.Background(), MediaDescriptor{Node: &waE2E.ImageMessage{}})
	if !errors.Is(err, errMediaTooLarge) {
		t.Fatalf("Download = %v, want errMediaTooLarge", err)
	}
	if stream != nil {
		t.Error("a failed download handed back a stream")
	}
	if client.written > 16+256 {
		t.Errorf("wrote %d bytes past a 16-byte cap: the download was not stopped mid-stream", client.written)
	}
	if client.scratch == "" {
		t.Fatal("the adapter did not hand its own scratch file to whatsmeow: nothing capped the write")
	}
	if _, err := os.Stat(client.scratch); !os.IsNotExist(err) {
		t.Errorf("scratch file %s survived a failed download", client.scratch)
	}
}

func TestWhatsmeowDownloaderStreamsTheStoredBytesAndCleansUp(t *testing.T) {
	payload := bytes.Repeat([]byte("b"), 64)
	limits := newMediaLimits(Config{MediaMaxBytes: 128, MediaDownloadTimeout: time.Second, MediaConcurrency: 1})
	client := &writingClient{payload: payload, chunk: 8}
	downloader := newWhatsmeowDownloader(client, limits)

	stream, err := downloader.Download(context.Background(), MediaDescriptor{Node: &waE2E.ImageMessage{}})
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	got, err := io.ReadAll(stream)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("streamed %d bytes, want the %d the client wrote", len(got), len(payload))
	}
	if err := stream.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
	if client.scratch == "" {
		t.Fatal("no scratch file was used")
	}
	if _, err := os.Stat(client.scratch); !os.IsNotExist(err) {
		t.Errorf("scratch file %s survived Close", client.scratch)
	}
}

func TestWhatsmeowDownloaderNeedsADownloadableNode(t *testing.T) {
	downloader := newWhatsmeowDownloader(&writingClient{}, testMediaLimits())
	if _, err := downloader.Download(context.Background(), MediaDescriptor{MessageID: "3EB0F1"}); !errors.Is(err, errNoMediaNode) {
		t.Errorf("Download = %v, want errNoMediaNode: the request is built from the node's keys", err)
	}
}

// TestWhatsmeowDownloaderReportsTheClientError keeps the library's own failure
// mapping intact: the adapter does not invent an outcome for a refused download.
func TestWhatsmeowDownloaderReportsTheClientError(t *testing.T) {
	client := &writingClient{err: whatsmeow.ErrMediaDownloadFailedWith410}
	downloader := newWhatsmeowDownloader(client, testMediaLimits())

	if _, err := downloader.Download(context.Background(), MediaDescriptor{Node: &waE2E.ImageMessage{}}); !errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith410) {
		t.Errorf("Download = %v, want the client's error", err)
	}
	if client.scratch == "" {
		t.Fatal("no scratch file was created")
	}
	if _, err := os.Stat(client.scratch); !os.IsNotExist(err) {
		t.Errorf("scratch file %s survived a refused download", client.scratch)
	}
	if _, err := os.Stat(filepath.Dir(client.scratch)); err != nil {
		t.Errorf("scratch directory %s is gone: the test cannot tell cleanup from a missing temp dir", err)
	}
}
