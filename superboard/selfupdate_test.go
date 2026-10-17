package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.6.1", "1.6.1", 0},
		{"1.7.0", "1.6.1", 1},
		{"1.6.1", "1.7.0", -1},
		{"1.6", "1.6.0", 0},
		{"1.10.0", "1.9.9", 1},
		{"v2.0.0", "1.9.9", 1},
		{"1.7.0-rc1", "1.7.0", 0},
		{"1.7.0+build5", "1.7.0", 0},
		{"", "1.0.0", -1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q,%q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestPickAsset(t *testing.T) {
	manifest := &updateManifest{
		Version: "1.7.0",
		Agents: []updateAsset{
			{Platform: "linux-amd64", File: "superboard-linux-amd64", SHA256: "aa"},
			{Platform: platformID(), File: "superboard-current", SHA256: "bb"},
			{Platform: "linux-arm64", File: "superboard-linux-arm64"},
		},
	}
	got := pickAsset(manifest)
	if got == nil || got.SHA256 != "bb" {
		t.Fatalf("expected the current platform's asset, got %+v", got)
	}

	// An asset with no checksum must never be selected: it cannot be verified.
	only := &updateManifest{Agents: []updateAsset{{Platform: platformID(), File: "x"}}}
	if pickAsset(only) != nil {
		t.Fatal("an asset without a sha256 must not be chosen")
	}
	if pickAsset(&updateManifest{}) != nil {
		t.Fatal("no agents means nothing to install")
	}
}

func TestSelfUpdateDefaultsOn(t *testing.T) {
	cfg := &Config{}
	if !cfg.selfUpdateEnabled() {
		t.Fatal("self-update must default to on")
	}
	if cfg.selfUpdateInterval() != DefaultSelfUpdateInterval {
		t.Fatalf("default interval = %s, want %s", cfg.selfUpdateInterval(), DefaultSelfUpdateInterval)
	}

	off := false
	cfg.SelfUpdate = &off
	if cfg.selfUpdateEnabled() {
		t.Fatal("explicit false must disable self-update")
	}
	on := true
	cfg.SelfUpdate = &on
	cfg.SelfUpdateIntervalHours = 6
	if !cfg.selfUpdateEnabled() || cfg.selfUpdateInterval() != 6*time.Hour {
		t.Fatal("configured interval must be honoured")
	}
}

func TestDownloadAssetVerifiesChecksum(t *testing.T) {
	body := []byte("#!/bin/false\nsuperboard fake binary\n")
	sum := sha256.Sum256(body)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != "tok" {
			http.Error(w, "no token", http.StatusUnauthorized)
			return
		}
		w.Write(body)
	}))
	defer server.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "superboard-test")
	// The agent downloads from its own configured origin, not from whatever
	// URL the manifest advertises.
	cfg := &Config{ServerURL: server.URL, AllowInsecure: true, PushToken: "tok"}
	asset := &updateAsset{File: "superboard-test", SHA256: hex.EncodeToString(sum[:])}

	if err := downloadAsset(context.Background(), cfg, asset, dest); err != nil {
		t.Fatalf("valid download failed: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil || string(got) != string(body) {
		t.Fatalf("downloaded bytes differ: %v", err)
	}
	if _, err := os.Stat(dest + ".part"); !os.IsNotExist(err) {
		t.Fatal("the .part staging file must be gone after a successful rename")
	}

	// A checksum mismatch must leave no binary behind at all.
	bad := &updateAsset{File: "superboard-test", SHA256: "deadbeef"}
	if err := downloadAsset(context.Background(), cfg, bad, dest); err == nil {
		t.Fatal("expected a checksum failure")
	}
	os.Remove(dest)
	if err := downloadAsset(context.Background(), cfg, bad, dest); err == nil {
		t.Fatal("expected a checksum failure")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("a mismatched download must not be left in place")
	}
}

func TestApplyAndVerifySwapsAndRollsBack(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "superboard")
	backup := filepath.Join(dir, "superboard.bak")
	newPath := filepath.Join(dir, "staged")

	write := func(path, content string) {
		if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// Healthy restart: the new build stays, the old one is kept as backup.
	write(target, "old")
	write(newPath, "new")
	restarts := 0
	if err := applyAndVerify(newPath, target, backup, func() error { restarts++; return nil }, func() bool { return true }, time.Second); err != nil {
		t.Fatalf("healthy apply failed: %v", err)
	}
	if got, _ := os.ReadFile(target); string(got) != "new" {
		t.Fatalf("target = %q, want the new build", got)
	}
	if got, _ := os.ReadFile(backup); string(got) != "old" {
		t.Fatalf("backup = %q, want the previous build", got)
	}
	if restarts == 0 {
		t.Fatal("the service must be restarted")
	}

	// Unhealthy restart: roll back and report failure.
	write(target, "old2")
	write(newPath, "new2")
	if err := applyAndVerify(newPath, target, backup, func() error { return nil }, func() bool { return false }, 50*time.Millisecond); err == nil {
		t.Fatal("an unhealthy build must report an error")
	}
	if got, _ := os.ReadFile(target); string(got) != "old2" {
		t.Fatalf("target after rollback = %q, want the previous build", got)
	}
}
