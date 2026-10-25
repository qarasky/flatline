package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var (
	oldBinary = []byte("#!old flatline-backup build")
	newBinary = []byte("#!new flatline-backup build, a little longer")
)

// releaseServer fakes the check-in and release routes of one Flatline server.
type releaseServer struct {
	mu        sync.Mutex
	version   string
	asset     []byte
	sha256    string // overrides the real digest when set
	checkins  []map[string]any
	downloads int
	server    *httptest.Server
}

func newReleaseServer(t *testing.T, version string, asset []byte) *releaseServer {
	t.Helper()
	fake := &releaseServer{version: version, asset: asset}
	fake.server = httptest.NewServer(http.HandlerFunc(fake.handle))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *releaseServer) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	file := "flatline-backup-" + platformID()
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/backup/v1/checkin":
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		body["authorization"] = r.Header.Get("Authorization")
		f.checkins = append(f.checkins, body)
		digest := f.sha256
		if digest == "" {
			sum := sha256.Sum256(f.asset)
			digest = hex.EncodeToString(sum[:])
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ok":true,"release":{"version":%q,"assets":[{"platform":%q,"file":%q,"size":%d,"sha256":%q}]}}`,
			f.version, platformID(), file, len(f.asset), digest)
	case r.Method == http.MethodGet && r.URL.Path == "/api/backup/v1/release/"+file:
		f.downloads++
		_, _ = w.Write(f.asset)
	default:
		http.NotFound(w, r)
	}
}

func (f *releaseServer) statuses() []any {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]any, 0, len(f.checkins))
	for _, body := range f.checkins {
		out = append(out, body["updateStatus"])
	}
	return out
}

// updateHost is one host: two installed instances, a binary and a staging dir.
type updateHost struct {
	options   updateOptions
	configs   []Config
	refreshed int
	reexecs   int
}

func newUpdateHost(t *testing.T, servers ...string) *updateHost {
	t.Helper()
	fixture := newFixture(t)
	host := &updateHost{}
	unitDir := t.TempDir()
	binDir := t.TempDir()
	binary := filepath.Join(binDir, "flatline-backup")
	if err := os.WriteFile(binary, oldBinary, 0o755); err != nil {
		t.Fatal(err)
	}
	for index, name := range []string{"modernization", "zhkh"} {
		value := fixture.config(name)
		value["serverUrl"] = servers[index%len(servers)]
		path := fixture.writeConfig(t, name, value)
		cfg, err := LoadConfig(path)
		if err != nil {
			t.Fatal(err)
		}
		host.configs = append(host.configs, cfg)
		unit := renderService(name, binary, path)
		if err := os.WriteFile(filepath.Join(unitDir, "flatline-backup@"+name+".service"), []byte(unit), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	host.options = updateOptions{
		unitDir:      unitDir,
		binaryPath:   binary,
		stagingDir:   filepath.Join(t.TempDir(), "update"),
		disabledFile: filepath.Join(t.TempDir(), "self-update.disabled"),
		lockWait:     2 * time.Second,
		clientFor: func(cfg Config) (*UploadClient, error) {
			return testUploadClient(t, cfg.ServerURL), nil
		},
		probeVersion: func(path string) (string, error) {
			data, err := os.ReadFile(path)
			if err != nil {
				return "", err
			}
			if bytes.Equal(data, newBinary) {
				return "0.4.0", nil
			}
			return "0.2.9", nil
		},
		refreshUnits: func(binary string) error { host.refreshed++; return nil },
		reexec:       func(binary string) error { host.reexecs++; return nil },
	}
	return host
}

func readBinary(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestDiscoverInstancesFromUnits(t *testing.T) {
	unitDir := t.TempDir()
	spaced := filepath.Join(t.TempDir(), "with space", "zhkh.json")
	if err := os.WriteFile(filepath.Join(unitDir, "flatline-backup@modernization.service"),
		[]byte(renderService("modernization", "/usr/local/bin/flatline-backup", "/etc/flatline-backup/modernization.json")), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(unitDir, "flatline-backup@zhkh.service"),
		[]byte(renderService("zhkh", "/usr/local/bin/flatline-backup", spaced)), 0o644); err != nil {
		t.Fatal(err)
	}
	// Not instances: the update unit, a timer, a stray credentials file.
	for _, name := range []string{"flatline-backup-update.service", "flatline-backup@zhkh.timer", "meks-s3.json"} {
		if err := os.WriteFile(filepath.Join(unitDir, name), []byte("ExecStart=/x run-once --config /etc/flatline-backup/meks-s3.json\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	got, err := discoverInstances(unitDir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/etc/flatline-backup/modernization.json", spaced}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("discoverInstances = %q, want %q", got, want)
	}
}

func TestSelfUpdateSwapsVerifiedBinary(t *testing.T) {
	server := newReleaseServer(t, "0.4.0", newBinary)
	host := newUpdateHost(t, server.server.URL)

	status, installed, err := SelfUpdate(context.Background(), host.options)
	if err != nil || status != "ok" {
		t.Fatalf("status = %q, err = %v", status, err)
	}
	if installed != "0.4.0" {
		t.Fatalf("installed = %q, want the release it swapped in", installed)
	}
	if !bytes.Equal(readBinary(t, host.options.binaryPath), newBinary) {
		t.Fatal("the verified build must replace the binary")
	}
	if !bytes.Equal(readBinary(t, host.options.binaryPath+".prev"), oldBinary) {
		t.Fatal("the previous build must be kept as .prev")
	}
	info, err := os.Stat(host.options.binaryPath)
	if err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("the new binary must be executable: %v %v", info.Mode(), err)
	}
	if host.refreshed != 1 || host.reexecs != 1 {
		t.Fatalf("units refreshed %d times, re-exec %d times; want 1 and 1", host.refreshed, host.reexecs)
	}
	// Every instance checked in with its own token, once, before the swap.
	if len(server.checkins) != 2 {
		t.Fatalf("check-ins = %d, want one per instance", len(server.checkins))
	}
	if server.checkins[0]["version"] != version {
		t.Fatalf("check-in reports %v, want the running %q", server.checkins[0]["version"], version)
	}
}

func TestSelfUpdateRejectsChecksumMismatch(t *testing.T) {
	server := newReleaseServer(t, "0.4.0", newBinary)
	server.sha256 = strings.Repeat("0", 64)
	host := newUpdateHost(t, server.server.URL)

	status, _, _ := SelfUpdate(context.Background(), host.options)
	if status != "checksum_mismatch" {
		t.Fatalf("status = %q", status)
	}
	if !bytes.Equal(readBinary(t, host.options.binaryPath), oldBinary) {
		t.Fatal("a build with the wrong digest must never be installed")
	}
	if statuses := server.statuses(); statuses[len(statuses)-1] != "checksum_mismatch" {
		t.Fatalf("the failure must be reported: %v", statuses)
	}
}

func TestSelfUpdateRejectsWrongVersion(t *testing.T) {
	server := newReleaseServer(t, "0.4.0", newBinary)
	host := newUpdateHost(t, server.server.URL)
	host.options.probeVersion = func(string) (string, error) { return "0.3.9", nil }

	status, _, _ := SelfUpdate(context.Background(), host.options)
	if status != "version_mismatch" {
		t.Fatalf("status = %q", status)
	}
	if !bytes.Equal(readBinary(t, host.options.binaryPath), oldBinary) {
		t.Fatal("a build reporting another version must never be installed")
	}
}

func TestSelfUpdateWaitsForRunningBackup(t *testing.T) {
	server := newReleaseServer(t, "0.4.0", newBinary)
	host := newUpdateHost(t, server.server.URL)
	lock, err := AcquireInstanceLock(host.configs[1].StateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()

	started := time.Now()
	status, _, _ := SelfUpdate(context.Background(), host.options)
	if status != "lock_timeout" {
		t.Fatalf("status = %q", status)
	}
	if time.Since(started) < host.options.lockWait {
		t.Fatal("self-update must wait for the running backup before giving up")
	}
	if !bytes.Equal(readBinary(t, host.options.binaryPath), oldBinary) {
		t.Fatal("the binary must not change under a running backup")
	}
	// The other instance's lock was released, so its next backup can run.
	other, err := AcquireInstanceLock(host.configs[0].StateDir)
	if err != nil {
		t.Fatalf("locks taken before the timeout must be released: %v", err)
	}
	other.Close()
}

func TestSelfUpdateRefusesMixedServers(t *testing.T) {
	first := newReleaseServer(t, "0.4.0", newBinary)
	second := newReleaseServer(t, "0.4.0", newBinary)
	host := newUpdateHost(t, first.server.URL, second.server.URL)

	status, _, _ := SelfUpdate(context.Background(), host.options)
	if status != "server_mismatch" {
		t.Fatalf("status = %q", status)
	}
	if first.downloads+second.downloads != 0 {
		t.Fatal("nothing may be downloaded when instances disagree on the server")
	}
	if len(first.checkins) == 0 || len(second.checkins) == 0 {
		t.Fatal("every instance still reports its version")
	}
}

func TestSelfUpdateRefusesDowngrade(t *testing.T) {
	server := newReleaseServer(t, "0.2.0", newBinary)
	host := newUpdateHost(t, server.server.URL)

	status, _, _ := SelfUpdate(context.Background(), host.options)
	if status != "downgrade_refused" {
		t.Fatalf("status = %q", status)
	}
	if server.downloads != 0 || !bytes.Equal(readBinary(t, host.options.binaryPath), oldBinary) {
		t.Fatal("an older release must not be downloaded or installed")
	}
}

func TestSelfUpdateCurrentIsOK(t *testing.T) {
	server := newReleaseServer(t, version, newBinary)
	host := newUpdateHost(t, server.server.URL)

	status, installed, err := SelfUpdate(context.Background(), host.options)
	if installed != "" {
		t.Fatalf("nothing was installed, got %q", installed)
	}
	if err != nil || status != "ok" || server.downloads != 0 {
		t.Fatalf("status = %q err = %v downloads = %d", status, err, server.downloads)
	}
}

func TestSelfUpdateDisabledStillChecksIn(t *testing.T) {
	server := newReleaseServer(t, "0.4.0", newBinary)
	host := newUpdateHost(t, server.server.URL)
	if err := os.WriteFile(host.options.disabledFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	status, _, err := SelfUpdate(context.Background(), host.options)
	if err != nil || status != "ok" {
		t.Fatalf("status = %q, err = %v", status, err)
	}
	if server.downloads != 0 || !bytes.Equal(readBinary(t, host.options.binaryPath), oldBinary) {
		t.Fatal("a disabled host must not update")
	}
	if len(server.checkins) != 2 {
		t.Fatalf("a disabled host still reports its version per instance: %d", len(server.checkins))
	}
}

func TestSelfUpdateReportsPreviousStatusOnNextRun(t *testing.T) {
	server := newReleaseServer(t, "0.4.0", newBinary)
	server.sha256 = strings.Repeat("0", 64)
	host := newUpdateHost(t, server.server.URL)
	if status, _, _ := SelfUpdate(context.Background(), host.options); status != "checksum_mismatch" {
		t.Fatalf("first run status = %q", status)
	}
	server.mu.Lock()
	server.checkins = nil
	server.mu.Unlock()

	_, _, _ = SelfUpdate(context.Background(), host.options)
	if statuses := server.statuses(); len(statuses) == 0 || statuses[0] != "checksum_mismatch" {
		t.Fatalf("the next run's first check-in carries the previous outcome: %v", statuses)
	}
}

func TestSelfUpdateDownloadsWithTheInstanceThatCheckedIn(t *testing.T) {
	server := newReleaseServer(t, "0.4.0", newBinary)
	revoked := "Bearer modernization"
	inner := server.server.Config.Handler
	server.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == revoked {
			http.Error(w, `{"ok":false,"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		inner.ServeHTTP(w, r)
	})
	host := newUpdateHost(t, server.server.URL)
	host.options.clientFor = func(cfg Config) (*UploadClient, error) {
		client := testUploadClient(t, cfg.ServerURL)
		client.token = cfg.Name // one credential per instance; modernization's is revoked
		return client, nil
	}

	status, _, err := SelfUpdate(context.Background(), host.options)
	if err != nil || status != "ok" {
		t.Fatalf("a revoked first instance must not block the host's update: status = %q, err = %v", status, err)
	}
	if !bytes.Equal(readBinary(t, host.options.binaryPath), newBinary) {
		t.Fatal("the build must be downloaded with a working credential")
	}
}

func TestSelfUpdateNeverHoldsOneLockWhileWaitingForAnother(t *testing.T) {
	server := newReleaseServer(t, "0.4.0", newBinary)
	host := newUpdateHost(t, server.server.URL)
	busy, err := AcquireInstanceLock(host.configs[1].StateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()

	// While self-update waits for zhkh's running backup, modernization's
	// own backup must still be able to start.
	free := make(chan error, 1)
	go func() {
		time.Sleep(700 * time.Millisecond)
		lock, err := AcquireInstanceLock(host.configs[0].StateDir)
		if err == nil {
			lock.Close()
		}
		free <- err
	}()

	status, _, _ := SelfUpdate(context.Background(), host.options)
	if status != "lock_timeout" {
		t.Fatalf("status = %q", status)
	}
	if err := <-free; err != nil {
		t.Fatalf("an idle instance's lock was held during the wait: %v", err)
	}
}

func TestSelfUpdateMessageNamesTheInstalledBuild(t *testing.T) {
	// The old process prints the last line after swapping: it must name the
	// build it installed, not its own (now replaced) version.
	if got, want := selfUpdateMessage("ok", "0.4.0"), "self-update: installed 0.4.0 (was "+version+")"; got != want {
		t.Fatalf("after a swap: %q, want %q", got, want)
	}
	if got, want := selfUpdateMessage("ok", ""), "self-update: ok (running "+version+")"; got != want {
		t.Fatalf("already current: %q, want %q", got, want)
	}
}
