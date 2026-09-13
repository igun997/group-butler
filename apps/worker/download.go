package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"go.mau.fi/whatsmeow"
)

// The seam is satisfied by the real thing: this asserts the installed
// *whatsmeow.Client has the streaming method the adapter calls, and that the
// capped wrapper is a whatsmeow.File, so a library change breaks the build here
// rather than a download in production.
var (
	_ whatsmeowMediaClient = (*whatsmeow.Client)(nil)
	_ whatsmeow.File       = (*cappedFile)(nil)
	_ mediaDownloader      = (*whatsmeowDownloader)(nil)
)

// errNoMediaNode is returned when a descriptor carries no protobuf media node,
// which is the only thing that can build an authenticated download request.
var errNoMediaNode = errors.New("media descriptor has no downloadable node")

// whatsmeowMediaClient is the one whatsmeow method this worker uses. The
// installed `*whatsmeow.Client` satisfies it, and nothing else in the project
// reaches into the library's download API.
type whatsmeowMediaClient interface {
	DownloadToFile(ctx context.Context, msg whatsmeow.DownloadableMessage, file whatsmeow.File) error
}

// whatsmeowDownloader is the production mediaDownloader.
//
// whatsmeow's `Download` returns the whole attachment as a `[]byte`, which is
// exactly the unbounded allocation MEDIA_MAX_BYTES exists to prevent, so this
// uses the streaming API the installed version exposes instead:
// `Client.DownloadToFile` writes the ciphertext into a `whatsmeow.File`, checks
// the message's own HMAC, decrypts in place and rewinds. The file handed to it
// here is capped, so an oversized attachment ends the transfer mid-stream
// rather than being materialised in full anywhere (§6.3.2).
type whatsmeowDownloader struct {
	client whatsmeowMediaClient
	limits *mediaLimits
}

func newWhatsmeowDownloader(client whatsmeowMediaClient, limits *mediaLimits) *whatsmeowDownloader {
	return &whatsmeowDownloader{client: client, limits: limits}
}

// Download streams one attachment. The returned reader releases the scratch
// file when it is closed, which the caller must do; a crash leaves at most one
// scratch file in the OS temp directory for the platform to reap.
func (d *whatsmeowDownloader) Download(ctx context.Context, desc MediaDescriptor) (io.ReadCloser, error) {
	if desc.Node == nil {
		return nil, fmt.Errorf("%w: %s", errNoMediaNode, desc.MessageID)
	}
	scratch, err := os.CreateTemp("", "butler-media-*")
	if err != nil {
		return nil, fmt.Errorf("media scratch file: %w", err)
	}
	if err := d.client.DownloadToFile(ctx, desc.Node, &cappedFile{File: scratch, max: d.limits.maxBytes}); err != nil {
		discardScratch(scratch)
		return nil, err
	}
	if _, err := scratch.Seek(0, io.SeekStart); err != nil {
		discardScratch(scratch)
		return nil, fmt.Errorf("media scratch file: %w", err)
	}
	return &scratchReader{File: scratch}, nil
}

// cappedFile is the whatsmeow.File a download writes into: it refuses any write
// that would take the file past the cap, so an oversized attachment stops the
// transfer instead of filling the disk. The cap bounds the file's length rather
// than the number of bytes ever written, because a failed attempt rewinds and
// rewrites the same bytes (whatsmeow's downloadPossiblyEncryptedMediaWithRetriesToFile);
// Seek, Truncate and Stat come from the embedded file. whatsmeow's
// preallocation shortcut deliberately does not apply to this type: a declared
// Content-Length must never reserve disk in advance.
type cappedFile struct {
	*os.File
	max int64
}

func (f *cappedFile) Write(p []byte) (int, error) {
	pos, err := f.File.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, fmt.Errorf("media scratch file: %w", err)
	}
	if pos+int64(len(p)) > f.max {
		return 0, fmt.Errorf("%w: %d bytes exceeds the %d-byte cap", errMediaTooLarge, pos+int64(len(p)), f.max)
	}
	return f.File.Write(p)
}

// scratchReader hands the decrypted attachment to the pipeline and removes the
// scratch file along with it.
type scratchReader struct{ *os.File }

func (s *scratchReader) Close() error {
	name := s.File.Name()
	err := s.File.Close()
	if rmErr := os.Remove(name); err == nil {
		err = rmErr
	}
	return err
}

// discardScratch drops a scratch file whose download failed.
func discardScratch(file *os.File) {
	name := file.Name()
	_ = file.Close()
	_ = os.Remove(name)
}
