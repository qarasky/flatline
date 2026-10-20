package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// roundTrip captures what the agent actually sends.
func TestPushSendsMetricsBody(t *testing.T) {
	var gotPath string
	var gotBody map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotBody)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	cfg := &Config{ServerURL: server.URL, PushToken: "tok123", IntervalSeconds: 60, AllowInsecure: true}
	client := newPushClient(cfg)

	payload := &Payload{V: 1, CPU: CPU{Percent: 10, Cores: 4}}
	if err := client.push(payload); err != nil {
		t.Fatalf("push: %v", err)
	}

	if gotPath != "/api/push/tok123" {
		t.Fatalf("path = %q", gotPath)
	}
	metrics, ok := gotBody["metrics"].(map[string]any)
	if !ok {
		t.Fatalf("no metrics object in body: %v", gotBody)
	}
	if metrics["v"] != float64(1) {
		t.Fatalf("metrics.v = %v", metrics["v"])
	}
	if gotBody["status"] != "up" {
		t.Fatalf("status = %v", gotBody["status"])
	}
}

func TestPushRefusesPlainHTTP(t *testing.T) {
	cfg := &Config{ServerURL: "http://example.com", PushToken: "tok", IntervalSeconds: 60}
	err := newPushClient(cfg).push(&Payload{})
	if err == nil {
		t.Fatal("expected plain HTTP refusal")
	}
}

func TestPushRejectsAreNotRetried(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"ok":false,"msg":"Heartbeat recorded, metrics dropped: nope"}`))
	}))
	defer server.Close()

	cfg := &Config{ServerURL: server.URL, PushToken: "tok", IntervalSeconds: 60, AllowInsecure: true}
	err := newPushClient(cfg).push(&Payload{})
	var rejected *pushRejectedError
	if !errors.As(err, &rejected) {
		t.Fatalf("expected a rejection error, got %v", err)
	}
	if calls != 1 {
		t.Fatalf("400 was retried %d times; deterministic failures must not retry", calls)
	}
}

func TestConfigRoundTripKeeps0600(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := &Config{ServerURL: "https://x.example", PushToken: "secret", IntervalSeconds: 30}

	if err := saveConfig(path, cfg); err != nil {
		t.Fatalf("save: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("perms = %o, want 600", info.Mode().Perm())
	}

	loaded, err := loadConfig(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.PushToken != "secret" || loaded.IntervalSeconds != 30 {
		t.Fatalf("round trip mismatch: %+v", loaded)
	}
}

func TestLoadConfigRejectsMissingFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"server_url":""}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConfig(path); err == nil {
		t.Fatal("expected error for empty config")
	}
}
