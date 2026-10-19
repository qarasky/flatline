package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeUploadServer struct {
	mu sync.Mutex

	runID        string
	status       string
	received     int64
	chunks       map[int64][]byte
	starts       []map[string]any
	runsCreated  int
	completeHits int

	dropStartOnce    bool
	dropChunkOnce    bool
	dropCompleteOnce bool
	expireOnChunk    bool
	allowReopen      bool

	server *httptest.Server
}

func newFakeUploadServer(t *testing.T) *fakeUploadServer {
	t.Helper()
	fake := &fakeUploadServer{runID: "run-1", status: "uploading", chunks: make(map[int64][]byte)}
	fake.server = httptest.NewServer(http.HandlerFunc(fake.handle))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *fakeUploadServer) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/backup/v1/runs":
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.starts = append(f.starts, body)
		if f.status == "expired" && f.allowReopen {
			f.status = "uploading"
			f.received = 0
			f.chunks = make(map[int64][]byte)
		}
		if f.runsCreated == 0 {
			f.runsCreated = 1
		}
		if f.dropStartOnce {
			f.dropStartOnce = false
			f.drop(w)
			return
		}
		writeRun(w, f.runID, f.status, f.received, f.received)

	case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/chunks/"):
		body, _ := io.ReadAll(r.Body)
		var offset int64
		fmt.Sscanf(r.Header.Get("X-Backup-Offset"), "%d", &offset)
		index := offset / uploadChunkBytes
		if f.status == "expired" {
			http.Error(w, "expired", http.StatusConflict)
			return
		}
		if f.expireOnChunk && index == 1 && offset == uploadChunkBytes {
			f.expireOnChunk = false
			f.status = "expired"
			http.Error(w, "expired", http.StatusInsufficientStorage)
			return
		}
		if offset < f.received {
			stored := f.chunks[offset]
			sum := sha256.Sum256(body)
			if !bytes.Equal(stored, body) || hex.EncodeToString(sum[:]) != r.Header.Get("X-Backup-Sha256") {
				http.Error(w, "conflict", http.StatusConflict)
				return
			}
			writeRun(w, f.runID, f.status, f.received, f.received)
			return
		}
		if offset != f.received {
			http.Error(w, "offset", http.StatusConflict)
			return
		}
		f.chunks[offset] = body
		f.received += int64(len(body))
		if f.dropChunkOnce {
			f.dropChunkOnce = false
			f.drop(w)
			return
		}
		writeRun(w, f.runID, f.status, f.received, f.received)

	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/complete"):
		f.completeHits++
		if f.dropCompleteOnce {
			f.dropCompleteOnce = false
			f.status = "completed"
			f.drop(w)
			return
		}
		f.status = "completed"
		writeRun(w, f.runID, f.status, f.received, f.received)

	case r.Method == http.MethodPost && r.URL.Path == "/api/backup/v1/failures":
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"run":{"id":"failed"}}`))

	default:
		http.NotFound(w, r)
	}
}

func (f *fakeUploadServer) drop(w http.ResponseWriter) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return
	}
	connection, _, err := hijacker.Hijack()
	if err == nil {
		_ = connection.Close()
	}
}

func writeRun(w http.ResponseWriter, id, status string, received, offset int64) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": true,
		"run": map[string]any{
			"id":            id,
			"agentId":       "agent-1",
			"clientRunId":   "run-1",
			"status":        status,
			"receivedBytes": received,
		},
		"offset": offset,
	})
}

func makeBundle(t *testing.T, size int) Bundle {
	t.Helper()
	data := make([]byte, size)
	for index := range data {
		data[index] = byte(index % 251)
	}
	path := filepath.Join(t.TempDir(), "bundle.age")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return Bundle{
		Path:             path,
		Size:             int64(size),
		SHA256:           hex.EncodeToString(sum[:]),
		ClientRunID:      "run-1",
		ExportStartedAt:  "2026-01-01T00:00:00Z",
		ExportFinishedAt: "2026-01-01T01:00:00Z",
		Summary:          BundleSummary{ObjectCount: 1, SourceBytes: int64(size)},
	}
}

func testUploadClient(t *testing.T, serverURL string) *UploadClient {
	t.Helper()
	client := &UploadClient{
		baseURL: serverURL + "/api/backup/v1",
		token:   "test-token",
		http: &http.Client{
			Timeout: 2 * time.Minute,
			CheckRedirect: func(request *http.Request, via []*http.Request) error {
				return errRedirectRefused
			},
		},
		retry: defaultRetryPolicy(),
	}
	client.retry.Sleep = func(ctx context.Context, duration time.Duration) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			return nil
		}
	}
	client.retry.Jitter = func(duration time.Duration) time.Duration { return duration }
	return client
}

func TestUploadResumesAfterLostResponses(t *testing.T) {
	fake := newFakeUploadServer(t)
	fake.dropStartOnce = true
	fake.dropChunkOnce = true
	fake.dropCompleteOnce = true
	client := testUploadClient(t, fake.server.URL)
	bundle := makeBundle(t, uploadChunkBytes+1024)

	run, err := uploadBundleWith(context.Background(), client, bundle)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != "completed" {
		t.Fatalf("status = %q", run.Status)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.runsCreated != 1 {
		t.Fatalf("a lost response created %d runs", fake.runsCreated)
	}
	if fake.received != bundle.Size {
		t.Fatalf("received %d of %d", fake.received, bundle.Size)
	}
	if len(fake.chunks) != 2 {
		t.Fatalf("chunks = %d", len(fake.chunks))
	}
	if fake.completeHits < 2 {
		t.Fatalf("lost completion response was not retried: %d", fake.completeHits)
	}
}

func TestStalePendingExportKeepsOriginalTime(t *testing.T) {
	fixture := newFixture(t)
	cfg := runnerConfig(t, fixture, "meks")
	exportCalls := 0
	var uploads []Bundle

	runner := DefaultRunner()
	runner.ReportFailure = func(context.Context, Config, string, string, string) error { return nil }
	runner.Export = func(ctx context.Context, cfg Config, spool *Spool, clientRunID string) (Export, error) {
		exportCalls++
		writer, err := spool.Create("objects/000001")
		if err != nil {
			return Export{}, err
		}
		if _, err := writer.Write([]byte("object body")); err != nil {
			return Export{}, err
		}
		if err := writer.Close(); err != nil {
			return Export{}, err
		}
		return Export{
			Manifest: Manifest{
				FormatVersion:    1,
				ClientRunID:      clientRunID,
				AgentName:        cfg.Name,
				ExportStartedAt:  "2026-01-01T00:00:00Z",
				ExportFinishedAt: "2026-01-01T01:00:00Z",
			},
			Files: []ExportFile{{
				Path: "objects/000001", SourcePath: filepath.Join(spool.Root(), "objects/000001"),
				Kind: kindObject, Bucket: "b", Key: "k",
			}},
		}, nil
	}
	runner.Upload = func(ctx context.Context, cfg Config, bundle Bundle) (RunSummary, error) {
		uploads = append(uploads, bundle)
		if len(uploads) == 1 {
			return RunSummary{}, errors.New("office offline")
		}
		return RunSummary{ID: "run-1", Status: "completed"}, nil
	}

	if err := runner.Run(context.Background(), cfg); err == nil {
		t.Fatal("the first upload must fail")
	}
	if err := runner.Run(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if exportCalls != 1 {
		t.Fatalf("export ran %d times; a pending bundle must be retried first", exportCalls)
	}
	if len(uploads) != 2 {
		t.Fatalf("uploads = %d", len(uploads))
	}
	for _, upload := range uploads {
		if upload.ExportStartedAt != "2026-01-01T00:00:00Z" ||
			upload.ExportFinishedAt != "2026-01-01T01:00:00Z" {
			t.Fatalf("manifest times changed on retry: %+v", upload)
		}
	}
	if _, err := os.Stat(pendingPath(cfg)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pending descriptor was not cleared: %v", err)
	}
}

func TestPendingBundleSurvivesRestart(t *testing.T) {
	fixture := newFixture(t)
	cfg := runnerConfig(t, fixture, "meks")
	exportCalls := 0

	runner := DefaultRunner()
	runner.ReportFailure = func(context.Context, Config, string, string, string) error { return nil }
	runner.Export = func(ctx context.Context, cfg Config, spool *Spool, clientRunID string) (Export, error) {
		exportCalls++
		writer, err := spool.Create("objects/000001")
		if err != nil {
			return Export{}, err
		}
		if _, err := writer.Write([]byte("body")); err != nil {
			return Export{}, err
		}
		if err := writer.Close(); err != nil {
			return Export{}, err
		}
		return Export{
			Manifest: Manifest{
				FormatVersion:    1,
				ClientRunID:      clientRunID,
				AgentName:        cfg.Name,
				ExportStartedAt:  "2026-01-01T00:00:00Z",
				ExportFinishedAt: "2026-01-01T01:00:00Z",
			},
			Files: []ExportFile{{
				Path: "objects/000001", SourcePath: filepath.Join(spool.Root(), "objects/000001"),
				Kind: kindObject, Bucket: "b", Key: "k",
			}},
		}, nil
	}
	runner.Upload = func(ctx context.Context, cfg Config, bundle Bundle) (RunSummary, error) {
		return RunSummary{}, errors.New("office offline")
	}

	for attempt := 0; attempt < 2; attempt++ {
		if err := runner.Run(context.Background(), cfg); err == nil {
			t.Fatal("upload must fail while the office is offline")
		}
	}
	if exportCalls != 1 {
		t.Fatalf("export ran %d times before delivery", exportCalls)
	}

	entries, err := os.ReadDir(filepath.Join(cfg.StateDir, "spool"))
	if err != nil {
		t.Fatal(err)
	}
	bundles := 0
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".age") {
			bundles++
		}
	}
	if bundles != 1 {
		t.Fatalf("pending bundles = %d", bundles)
	}
	if _, err := os.Stat(pendingPath(cfg)); err != nil {
		t.Fatalf("pending descriptor missing: %v", err)
	}
}

func TestExpiredUploadReopensWithoutNewExport(t *testing.T) {
	fake := newFakeUploadServer(t)
	fake.expireOnChunk = true
	client := testUploadClient(t, fake.server.URL)
	bundle := makeBundle(t, uploadChunkBytes+1024)

	if _, err := uploadBundleWith(context.Background(), client, bundle); err == nil {
		t.Fatal("the first upload must fail when the run expires")
	}

	// The next run is allowed by the server to reopen the expired run at zero.
	fake.mu.Lock()
	fake.allowReopen = true
	fake.mu.Unlock()
	if _, err := uploadBundleWith(context.Background(), client, bundle); err != nil {
		t.Fatalf("the expired run did not reopen: %v", err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.starts) < 2 {
		t.Fatalf("starts = %d", len(fake.starts))
	}
	for _, start := range fake.starts {
		if start["exportStartedAt"] != bundle.ExportStartedAt {
			t.Fatalf("start time changed after expiry: %v", start["exportStartedAt"])
		}
	}
	if fake.received != bundle.Size {
		t.Fatalf("received %d of %d", fake.received, bundle.Size)
	}
}

func TestRetryClassificationAndSecretRedaction(t *testing.T) {
	newServer := func(handler http.HandlerFunc) *httptest.Server {
		server := httptest.NewServer(handler)
		t.Cleanup(server.Close)
		return server
	}
	client := func(server *httptest.Server) *UploadClient {
		return testUploadClient(t, server.URL)
	}
	report := func(client *UploadClient) error {
		return client.reportFailure(context.Background(), "run-1", "2026-01-01T00:00:00Z", "export_failed")
	}

	t.Run("401 stops", func(t *testing.T) {
		calls := 0
		server := newServer(func(w http.ResponseWriter, r *http.Request) {
			calls++
			http.Error(w, "secret-token", http.StatusUnauthorized)
		})
		err := report(client(server))
		if err == nil || calls != 1 {
			t.Fatalf("401 must be permanent: calls=%d err=%v", calls, err)
		}
		if strings.Contains(err.Error(), "secret-token") {
			t.Fatalf("server body leaked: %v", err)
		}
	})

	t.Run("403 stops", func(t *testing.T) {
		calls := 0
		server := newServer(func(w http.ResponseWriter, r *http.Request) {
			calls++
			http.Error(w, "no", http.StatusForbidden)
		})
		if err := report(client(server)); err == nil || calls != 1 {
			t.Fatalf("403 must be permanent: calls=%d err=%v", calls, err)
		}
	})

	t.Run("5xx retries then succeeds", func(t *testing.T) {
		calls := 0
		server := newServer(func(w http.ResponseWriter, r *http.Request) {
			calls++
			if calls < 3 {
				http.Error(w, "temporary", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		})
		if err := report(client(server)); err != nil {
			t.Fatal(err)
		}
		if calls != 3 {
			t.Fatalf("calls = %d", calls)
		}
	})

	t.Run("429 retry-after is capped", func(t *testing.T) {
		calls := 0
		var slept []time.Duration
		server := newServer(func(w http.ResponseWriter, r *http.Request) {
			calls++
			if calls == 1 {
				w.Header().Set("Retry-After", "60")
				http.Error(w, "slow down", http.StatusTooManyRequests)
				return
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
		})
		c := client(server)
		c.retry.Sleep = func(ctx context.Context, duration time.Duration) error {
			slept = append(slept, duration)
			return nil
		}
		if err := report(c); err != nil {
			t.Fatal(err)
		}
		if len(slept) != 1 || slept[0] > 30*time.Second {
			t.Fatalf("retry-after was not capped: %v", slept)
		}
	})

	t.Run("network errors retry", func(t *testing.T) {
		server := newServer(func(w http.ResponseWriter, r *http.Request) {})
		c := client(server)
		server.Close()
		if err := report(c); err == nil {
			t.Fatal("a dead server must fail eventually")
		}
	})

	t.Run("redirects are refused", func(t *testing.T) {
		targetHit := false
		target := newServer(func(w http.ResponseWriter, r *http.Request) {
			targetHit = true
		})
		server := newServer(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, target.URL, http.StatusFound)
		})
		if err := report(client(server)); err == nil {
			t.Fatal("redirects must not be followed")
		}
		if targetHit {
			t.Fatal("the redirect target was contacted")
		}
	})
}

func runnerConfig(t *testing.T, fixture *configFixture, name string) Config {
	t.Helper()
	path := fixture.writeConfig(t, name, fixture.config(name))
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg.SpoolMaxBytes = 64 << 20
	return cfg
}

func TestCorruptPendingDoesNotWedgeFutureBackups(t *testing.T) {
	fixture := newFixture(t)
	cfg := runnerConfig(t, fixture, "meks")
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pendingPath(cfg), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	exportCalls := 0
	runner := DefaultRunner()
	runner.ReportFailure = func(context.Context, Config, string, string, string) error { return nil }
	runner.Export = func(ctx context.Context, cfg Config, spool *Spool, clientRunID string) (Export, error) {
		exportCalls++
		writer, err := spool.Create("objects/000001")
		if err != nil {
			return Export{}, err
		}
		_, _ = writer.Write([]byte("body"))
		_ = writer.Close()
		return Export{
			Manifest: Manifest{FormatVersion: 1, ClientRunID: clientRunID, AgentName: cfg.Name,
				ExportStartedAt: "2026-01-01T00:00:00Z", ExportFinishedAt: "2026-01-01T01:00:00Z"},
			Files: []ExportFile{{Path: "objects/000001", SourcePath: filepath.Join(spool.Root(), "objects/000001"),
				Kind: kindObject, Bucket: "b", Key: "k"}},
		}, nil
	}
	runner.Upload = func(context.Context, Config, Bundle) (RunSummary, error) {
		return RunSummary{ID: "run-1", Status: "completed"}, nil
	}
	if err := runner.Run(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if exportCalls != 1 {
		t.Fatalf("a corrupt pending descriptor blocked the export: %d", exportCalls)
	}
	entries, err := os.ReadDir(filepath.Join(cfg.StateDir, "quarantine"))
	if err != nil || len(entries) == 0 {
		t.Fatalf("the corrupt descriptor was not quarantined: %v", err)
	}
	if _, err := os.Stat(pendingPath(cfg)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the corrupt descriptor was not removed")
	}
}

func TestTerminalServerRunReExports(t *testing.T) {
	fixture := newFixture(t)
	cfg := runnerConfig(t, fixture, "meks")
	exportCalls := 0
	uploads := 0
	runner := DefaultRunner()
	runner.ReportFailure = func(context.Context, Config, string, string, string) error { return nil }
	runner.Export = func(ctx context.Context, cfg Config, spool *Spool, clientRunID string) (Export, error) {
		exportCalls++
		writer, err := spool.Create("objects/000001")
		if err != nil {
			return Export{}, err
		}
		_, _ = writer.Write([]byte("body"))
		_ = writer.Close()
		return Export{
			Manifest: Manifest{FormatVersion: 1, ClientRunID: clientRunID, AgentName: cfg.Name,
				ExportStartedAt: "2026-01-01T00:00:00Z", ExportFinishedAt: "2026-01-01T01:00:00Z"},
			Files: []ExportFile{{Path: "objects/000001", SourcePath: filepath.Join(spool.Root(), "objects/000001"),
				Kind: kindObject, Bucket: "b", Key: "k"}},
		}, nil
	}
	runner.Upload = func(context.Context, Config, Bundle) (RunSummary, error) {
		uploads++
		if uploads == 1 {
			return RunSummary{}, errors.New("office offline")
		}
		if uploads == 2 {
			return RunSummary{}, errRunTerminal
		}
		return RunSummary{ID: "run-2", Status: "completed"}, nil
	}

	if err := runner.Run(context.Background(), cfg); err == nil {
		t.Fatal("the first upload must fail")
	}
	if err := runner.Run(context.Background(), cfg); err != nil {
		t.Fatalf("terminal pending bundle must not wedge: %v", err)
	}
	if exportCalls != 2 || uploads != 3 {
		t.Fatalf("exportCalls=%d uploads=%d", exportCalls, uploads)
	}
	if _, err := os.Stat(pendingPath(cfg)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the terminal bundle was not cleared after a fresh success")
	}
}
