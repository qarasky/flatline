package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func nowUTC() time.Time { return time.Now().UTC() }

func openSpoolFile(spool *Spool, name string) (*os.File, error) {
	return os.Open(filepath.Join(spool.Root(), name))
}

func TestExportSpoolBoundedAndNoSecretsInErrors(t *testing.T) {
	t.Run("postgres dump", func(t *testing.T) {
		spool, err := NewSpool(t.TempDir(), 10)
		if err != nil {
			t.Fatal(err)
		}
		executor := &fakePostgresExecutor{writeBytes: 100}
		state := newExportState(Config{Name: "meks"}, "run-1", nowUTC())
		source := PostgresSource{Container: "pg", User: "postgres", Databases: []string{"modernization"}}

		err = exportPostgresInto(context.Background(), source, spool, state, executor)
		if !errors.Is(err, ErrSpoolLimit) {
			t.Fatalf("expected the spool cap, got %v", err)
		}
		if len(state.files) != 0 || spool.Used() != 0 {
			t.Fatalf("bounded export left files: %+v used=%d", state.files, spool.Used())
		}
		if strings.Contains(err.Error(), "secret") {
			t.Fatalf("secret leaked: %v", err)
		}
	})

	t.Run("s3 object", func(t *testing.T) {
		spool, err := NewSpool(t.TempDir(), 10)
		if err != nil {
			t.Fatal(err)
		}
		fake := &fakeS3{objects: []fakeObject{{
			key: "large", body: make([]byte, 100), contentType: "application/octet-stream", etag: `"etag"`,
		}}}
		state := newExportState(Config{Name: "meks"}, "run-1", nowUTC())
		source := S3Source{Endpoint: "http://127.0.0.1:3900", Region: "garage", Bucket: "media"}

		err = exportBucketInto(context.Background(), source, spool, state, fake)
		if !errors.Is(err, ErrSpoolLimit) {
			t.Fatalf("expected the spool cap, got %v", err)
		}
		if len(state.files) != 0 || spool.Used() != 0 {
			t.Fatalf("bounded export left files: %+v used=%d", state.files, spool.Used())
		}
		if strings.Contains(err.Error(), "secret") {
			t.Fatalf("secret leaked: %v", err)
		}
	})
}
