package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type fakeObject struct {
	key         string
	body        []byte
	contentType string
	etag        string
}

type fakeS3 struct {
	objects            []fakeObject
	pageSize           int
	getErr             map[string]error
	contentLengthDelta int64
	getETagSuffix      string
	stall              bool
	started            chan struct{}
	listCalls          int
}

func (f *fakeS3) ListObjectsV2(ctx context.Context, input *s3.ListObjectsV2Input, optFns ...func(*s3.Options)) (*s3.ListObjectsV2Output, error) {
	f.listCalls++
	start := 0
	if input.ContinuationToken != nil {
		parsed, err := strconv.Atoi(*input.ContinuationToken)
		if err != nil {
			return nil, err
		}
		start = parsed
	}
	size := f.pageSize
	if size <= 0 {
		size = 1000
	}
	end := start + size
	if end > len(f.objects) {
		end = len(f.objects)
	}

	contents := make([]types.Object, 0, end-start)
	for index := start; index < end; index++ {
		object := f.objects[index]
		etag := object.etag
		if etag == "" {
			etag = `"etag-` + object.key + `"`
		}
		contents = append(contents, types.Object{
			Key:  aws.String(object.key),
			Size: aws.Int64(int64(len(object.body))),
			ETag: aws.String(etag),
		})
	}
	output := &s3.ListObjectsV2Output{Contents: contents, KeyCount: aws.Int32(int32(len(contents)))}
	if end < len(f.objects) {
		token := strconv.Itoa(end)
		output.IsTruncated = aws.Bool(true)
		output.NextContinuationToken = &token
	}
	return output, nil
}

func (f *fakeS3) PutObject(ctx context.Context, input *s3.PutObjectInput, optFns ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	return &s3.PutObjectOutput{}, nil
}

func (f *fakeS3) GetObject(ctx context.Context, input *s3.GetObjectInput, optFns ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	key := aws.ToString(input.Key)
	if err := f.getErr[key]; err != nil {
		return nil, err
	}
	for _, object := range f.objects {
		if object.key != key {
			continue
		}
		var body io.ReadCloser
		if f.stall {
			body = &blockingBody{ctx: ctx, started: f.started}
		} else {
			body = io.NopCloser(bytes.NewReader(object.body))
		}
		etag := object.etag
		if etag == "" {
			etag = `"etag-` + key + `"`
		}
		return &s3.GetObjectOutput{
			Body:          body,
			ContentLength: aws.Int64(int64(len(object.body)) + f.contentLengthDelta),
			ETag:          aws.String(etag + f.getETagSuffix),
			ContentType:   aws.String(object.contentType),
		}, nil
	}
	return nil, errors.New("NoSuchKey")
}

type blockingBody struct {
	ctx     context.Context
	started chan struct{}
	once    sync.Once
}

func (b *blockingBody) Read(buffer []byte) (int, error) {
	b.once.Do(func() {
		if b.started != nil {
			close(b.started)
		}
	})
	select {
	case <-b.ctx.Done():
		return 0, b.ctx.Err()
	case <-time.After(time.Hour):
		return 0, io.EOF
	}
}

func (b *blockingBody) Close() error { return nil }

func TestBucketPaginationAndExactKeys(t *testing.T) {
	keys := []string{"a", "a/b", "/lead", "x//y", "../x", "trail/", "юникод/ключ", "empty", "a b"}
	objects := make([]fakeObject, 0, 1001)
	for index, key := range keys {
		body := []byte(fmt.Sprintf("body-%d", index))
		if key == "empty" {
			body = nil
		}
		objects = append(objects, fakeObject{
			key: key, body: body, contentType: "image/png", etag: `"etag-` + key + `"`,
		})
	}
	for index := len(keys); index < 1001; index++ {
		key := fmt.Sprintf("prefix/%04d", index)
		objects = append(objects, fakeObject{key: key, body: []byte("body-" + key), contentType: "application/octet-stream"})
	}

	spool, err := NewSpool(t.TempDir(), 64<<20)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeS3{objects: objects, pageSize: 100}
	state := newExportState(Config{Name: "meks"}, "run-1", nowUTC())
	source := S3Source{Endpoint: "http://127.0.0.1:3900", Region: "garage", Bucket: "meks-media"}

	if err := exportBucketInto(context.Background(), source, spool, state, fake); err != nil {
		t.Fatal(err)
	}
	if fake.listCalls < 11 {
		t.Fatalf("pagination made only %d list calls", fake.listCalls)
	}
	if len(state.files) != len(objects) {
		t.Fatalf("exported %d objects, want %d", len(state.files), len(objects))
	}

	files := make(map[string]ExportFile)
	for _, file := range state.files {
		files[file.Key] = file
	}
	for _, object := range objects {
		file, exists := files[object.key]
		if !exists {
			t.Fatalf("key %q was lost", object.key)
		}
		handle, err := openSpoolFile(spool, file.Path)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(handle)
		_ = handle.Close()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(body, object.body) {
			t.Fatalf("body for key %q changed", object.key)
		}
		if file.ContentType != object.contentType {
			t.Fatalf("content type for key %q = %q", object.key, file.ContentType)
		}
	}
}

func TestBucketChangesFailExplicitly(t *testing.T) {
	object := func(key string, etag string) fakeObject {
		return fakeObject{key: key, body: []byte("body"), contentType: "text/plain", etag: etag}
	}
	run := func(t *testing.T, fake *fakeS3, ctx context.Context) error {
		t.Helper()
		spool, err := NewSpool(t.TempDir(), 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		state := newExportState(Config{Name: "meks"}, "run-1", nowUTC())
		source := S3Source{Endpoint: "http://127.0.0.1:3900", Region: "garage", Bucket: "media"}
		err = exportBucketInto(ctx, source, spool, state, fake)
		if len(state.files) != 0 || spool.Used() != 0 {
			t.Fatalf("failed export left files: %+v used=%d", state.files, spool.Used())
		}
		return err
	}

	t.Run("unclassified get error", func(t *testing.T) {
		// Only a typed NoSuchKey counts as deleted-after-listing (see
		// TestBucketToleratesObjectsDeletedAfterListing).
		fake := &fakeS3{
			objects: []fakeObject{object("k", `"etag"`)},
			getErr:  map[string]error{"k": errors.New("404 secret-key")},
		}
		err := run(t, fake, context.Background())
		if err == nil {
			t.Fatal("an unclassified read error must fail the export")
		}
		if strings.Contains(err.Error(), "secret") {
			t.Fatalf("error leaked details: %v", err)
		}
	})

	t.Run("get 412", func(t *testing.T) {
		fake := &fakeS3{
			objects: []fakeObject{object("k", `"etag"`)},
			getErr:  map[string]error{"k": errors.New("412 precondition failed")},
		}
		if err := run(t, fake, context.Background()); err == nil {
			t.Fatal("a precondition failure must fail the export")
		}
	})

	t.Run("size mismatch", func(t *testing.T) {
		fake := &fakeS3{objects: []fakeObject{object("k", `"etag"`)}, contentLengthDelta: 1}
		if err := run(t, fake, context.Background()); err == nil {
			t.Fatal("a size mismatch must fail the export")
		}
	})

	t.Run("etag change", func(t *testing.T) {
		fake := &fakeS3{objects: []fakeObject{object("k", `"etag"`)}, getETagSuffix: "-changed"}
		if err := run(t, fake, context.Background()); err == nil {
			t.Fatal("a changed ETag must fail the export")
		}
	})

	t.Run("opaque multipart etag", func(t *testing.T) {
		fake := &fakeS3{objects: []fakeObject{object("k", `"abc-2"`)}, getETagSuffix: ""}
		spool, err := NewSpool(t.TempDir(), 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		state := newExportState(Config{Name: "meks"}, "run-1", nowUTC())
		source := S3Source{Endpoint: "http://127.0.0.1:3900", Region: "garage", Bucket: "media"}
		if err := exportBucketInto(context.Background(), source, spool, state, fake); err != nil {
			t.Fatalf("an opaque multipart ETag must not be treated as an MD5: %v", err)
		}
		if len(state.files) != 1 {
			t.Fatalf("files = %+v", state.files)
		}
	})

	t.Run("stalled read", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		fake := &fakeS3{
			objects: []fakeObject{object("k", `"etag"`)},
			stall:   true,
			started: make(chan struct{}),
		}
		spool, err := NewSpool(t.TempDir(), 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		state := newExportState(Config{Name: "meks"}, "run-1", nowUTC())
		source := S3Source{Endpoint: "http://127.0.0.1:3900", Region: "garage", Bucket: "media"}
		done := make(chan error, 1)
		go func() {
			done <- exportBucketInto(ctx, source, spool, state, fake)
		}()
		<-fake.started
		cancel()
		if err := <-done; err == nil {
			t.Fatal("a stalled read must be canceled")
		}
		if spool.Used() != 0 {
			t.Fatalf("stalled read left bytes: %d", spool.Used())
		}
	})
}

// Review M5: the export failed as a whole when an object was deleted
// between listing and reading. Deletions are recorded in the manifest.
func TestBucketToleratesObjectsDeletedAfterListing(t *testing.T) {
	fake := &fakeS3{
		objects: []fakeObject{
			{key: "kept", body: []byte("kept"), contentType: "text/plain"},
			{key: "gone", body: []byte("gone"), contentType: "text/plain"},
			{key: "also-kept", body: []byte("also"), contentType: "text/plain"},
		},
		getErr: map[string]error{"gone": &types.NoSuchKey{Message: aws.String("secret detail")}},
	}
	spool, err := NewSpool(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	state := newExportState(Config{Name: "meks"}, "run-1", nowUTC())
	source := S3Source{Endpoint: "http://127.0.0.1:3900", Region: "garage", Bucket: "media"}
	if err := exportBucketInto(context.Background(), source, spool, state, fake); err != nil {
		t.Fatalf("a deleted object must not fail the export: %v", err)
	}
	if len(state.files) != 2 {
		t.Fatalf("files = %+v", state.files)
	}
	vanished := state.manifest.Vanished
	if len(vanished) != 1 || vanished[0].Bucket != "media" || vanished[0].Key != "gone" {
		t.Fatalf("vanished = %+v", vanished)
	}

	// A missing bucket is not a missing object.
	fake.getErr = map[string]error{"kept": &types.NoSuchBucket{}}
	state = newExportState(Config{Name: "meks"}, "run-2", nowUTC())
	spool, _ = NewSpool(t.TempDir(), 1<<20)
	if err := exportBucketInto(context.Background(), source, spool, state, fake); err == nil {
		t.Fatal("a missing bucket must fail the export")
	}
}

func TestManifestVanishedObjectsAreValidated(t *testing.T) {
	base := Manifest{
		FormatVersion: 1, ClientRunID: "run-1", AgentName: "meks",
		ExportStartedAt: "2026-01-01T00:00:00Z", ExportFinishedAt: "2026-01-01T01:00:00Z",
		Entries: []Entry{{Path: "objects/000001", Kind: kindObject, Size: 1, SHA256: strings.Repeat("a", 64),
			Bucket: "media", Key: "kept"}},
	}
	valid := base
	valid.Vanished = []VanishedObject{{Bucket: "media", Key: "gone"}}
	if err := validateManifest(&valid); err != nil {
		t.Fatalf("valid vanished list rejected: %v", err)
	}
	for name, vanished := range map[string][]VanishedObject{
		"duplicate of an archived object": {{Bucket: "media", Key: "kept"}},
		"empty key":                       {{Bucket: "media"}},
		"repeated":                        {{Bucket: "media", Key: "x"}, {Bucket: "media", Key: "x"}},
	} {
		manifest := base
		manifest.Vanished = vanished
		if err := validateManifest(&manifest); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}
