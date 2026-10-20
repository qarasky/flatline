package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
	if err := applyAndVerify(newPath, target, backup, func() error { restarts++; return nil }, func() error { return nil }); err != nil {
		t.Fatalf("healthy apply failed: %v", err)
	}
	if got, _ := os.ReadFile(target); string(got) != "new" {
		t.Fatalf("target = %q, want the new build", got)
	}
	if got, _ := os.ReadFile(backup); string(got) != "old" {
		t.Fatalf("backup = %q, want the previous build", got)
	}
	if restarts != 1 {
		t.Fatalf("restarts = %d, want 1", restarts)
	}

	// Unhealthy restart: roll back, restart again, and report failure.
	write(target, "old2")
	write(newPath, "new2")
	restarts = 0
	if err := applyAndVerify(newPath, target, backup, func() error { restarts++; return nil }, func() error { return errors.New("crash loop") }); err == nil {
		t.Fatal("an unhealthy build must report an error")
	}
	if got, _ := os.ReadFile(target); string(got) != "old2" {
		t.Fatalf("target after rollback = %q, want the previous build", got)
	}
	if restarts != 2 {
		t.Fatalf("restarts = %d, want the update restart plus the rollback restart", restarts)
	}
}

// Rollback replaces the live binary by rename: a process still executing
// the bad build keeps its inode (no ETXTBSY, no truncation under it) and
// the path flips atomically to the complete previous build.
func TestRollbackRenamesOverTheTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "superboard")
	backup := filepath.Join(dir, "superboard.bak")
	if err := os.WriteFile(target, []byte("bad build"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backup, []byte("good build"), 0o755); err != nil {
		t.Fatal(err)
	}
	running, err := os.Open(target) // stands in for the executing image
	if err != nil {
		t.Fatal(err)
	}
	defer running.Close()
	before, _ := os.Stat(target)

	if err := rollback(backup, target, func() error { return nil }); err == nil {
		t.Fatal("rollback must still report the failed update")
	}

	if got, _ := os.ReadFile(target); string(got) != "good build" {
		t.Fatalf("target = %q, want the backup", got)
	}
	after, _ := os.Stat(target)
	if os.SameFile(before, after) {
		t.Fatal("rollback wrote into the live inode; it must rename a new file over it")
	}
	old, _ := io.ReadAll(running)
	if string(old) != "bad build" {
		t.Fatalf("the running image was modified under it: %q", old)
	}
	if _, err := os.Stat(target + ".new"); !os.IsNotExist(err) {
		t.Fatal("the .new staging file must be gone")
	}
}

// fakeService scripts systemctl show answers, one per poll.
func fakeService(states ...serviceState) func() (serviceState, error) {
	i := 0
	return func() (serviceState, error) {
		st := states[min(i, len(states)-1)]
		i++
		return st, nil
	}
}

func TestHealthCheck(t *testing.T) {
	up := serviceState{Active: true, MainPID: 100, NRestarts: 0, HasRestarts: true}
	down := serviceState{Active: false}
	check := func(probe func() (serviceState, error), marker func() (int, bool)) error {
		return healthCheck{probe: probe, marker: marker, startTimeout: 40 * time.Millisecond, window: 30 * time.Millisecond, poll: time.Millisecond}.wait()
	}
	markerFor := func(pid int) func() (int, bool) { return func() (int, bool) { return pid, true } }
	noMarker := func() (int, bool) { return 0, false }

	if err := check(fakeService(down, down, up), markerFor(100)); err != nil {
		t.Fatalf("stable build with marker: %v", err)
	}
	if err := check(fakeService(up), nil); err != nil {
		t.Fatalf("stable build, marker not required: %v", err)
	}
	if err := check(fakeService(down), nil); err == nil {
		t.Fatal("never active must fail")
	}
	// Crash loop: active, then Restart=always brings up a new process.
	crashed := up
	crashed.MainPID, crashed.NRestarts = 200, 1
	if err := check(fakeService(up, up, crashed), nil); err == nil || !strings.Contains(err.Error(), "PID") {
		t.Fatalf("PID change must fail, got %v", err)
	}
	restarted := up
	restarted.NRestarts = 1
	if err := check(fakeService(up, restarted), nil); err == nil || !strings.Contains(err.Error(), "NRestarts") {
		t.Fatalf("NRestarts change must fail, got %v", err)
	}
	if err := check(fakeService(up, up, down), nil); err == nil {
		t.Fatal("leaving active during the window must fail")
	}
	if err := check(fakeService(up), noMarker); err == nil || !strings.Contains(err.Error(), "push") {
		t.Fatalf("missing first-push marker must fail, got %v", err)
	}
	if err := check(fakeService(up), markerFor(99)); err == nil {
		t.Fatal("a marker from another process must not count")
	}
	// systemd < 235 has no NRestarts: PID stability alone decides.
	old := serviceState{Active: true, MainPID: 5}
	if err := check(fakeService(old), nil); err != nil {
		t.Fatalf("no NRestarts property: %v", err)
	}
}

func TestParseServiceState(t *testing.T) {
	st := parseServiceState("ActiveState=active\nMainPID=4242\nNRestarts=3\n")
	if !st.Active || st.MainPID != 4242 || st.NRestarts != 3 || !st.HasRestarts {
		t.Fatalf("parsed %+v", st)
	}
	st = parseServiceState("MainPID=0\nActiveState=activating\n")
	if st.Active || st.HasRestarts {
		t.Fatalf("parsed %+v", st)
	}
}

func TestFirstPushMarkerRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), selfUpdateMarker)
	if err := writeMarker(path, "1.8.0", 321); err != nil {
		t.Fatal(err)
	}
	ver, pid, ok := readMarker(path)
	if !ok || ver != "1.8.0" || pid != 321 {
		t.Fatalf("marker = %q %d %v", ver, pid, ok)
	}
	os.WriteFile(path, []byte("junk"), 0o600)
	if _, _, ok := readMarker(path); ok {
		t.Fatal("a malformed marker must not count")
	}
}

func TestHelperRunsOutsideTheServiceCgroup(t *testing.T) {
	unit := helperUnitName(time.Unix(1700000000, 0))
	if unit != "superboard-update-1700000000" {
		t.Fatalf("unit = %q", unit)
	}
	args := systemdRunArgs(unit, true, "/var/lib/superboard/update/superboard-helper", []string{"apply-update", "--new", "x"})
	joined := strings.Join(args, " ")
	for _, want := range []string{"--unit=superboard-update-1700000000", "--collect", "-- /var/lib/superboard/update/superboard-helper apply-update --new x"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("systemd-run args %q lack %q", joined, want)
		}
	}
	if strings.Contains(strings.Join(systemdRunArgs(unit, false, "h", nil), " "), "--collect") {
		t.Fatal("the old-systemd retry must drop --collect")
	}
}

func TestSelfUpdateScheduleIsJittered(t *testing.T) {
	for i := 0; i < 500; i++ {
		if d := selfUpdateStartDelay(); d < 0 || d > selfUpdateStartupSpread {
			t.Fatalf("start delay %s outside [0, %s]", d, selfUpdateStartupSpread)
		}
		if d := jitterInterval(24 * time.Hour); d < 24*time.Hour*9/10 || d > 24*time.Hour*11/10 {
			t.Fatalf("interval %s outside 24h ±10%%", d)
		}
	}
	withJitter(t, func(n int64) int64 { return 0 })
	if d := jitterInterval(10 * time.Hour); d != 9*time.Hour {
		t.Fatalf("minimum interval = %s, want 9h", d)
	}
}

func TestUnitKillModeAndRefresh(t *testing.T) {
	fresh := unitFile("/usr/local/bin/superboard", "/etc/superboard/config.json")
	if !strings.Contains(fresh, "KillMode=process") {
		t.Fatal("the unit must keep the update helper alive across restarts")
	}

	// A unit written by 1.7.0 (no KillMode) is upgraded in place, keeping
	// the host's own ExecStart.
	legacy := strings.Replace(renderUnit("/opt/sb/superboard run --config /srv/sb.json"), "KillMode=process\n", "", 1)
	path := filepath.Join(t.TempDir(), "superboard.service")
	os.WriteFile(path, []byte(legacy), 0o644)
	changed, err := refreshUnitFile(path)
	if err != nil || !changed {
		t.Fatalf("refresh = %v, %v; want a rewrite", changed, err)
	}
	got, _ := os.ReadFile(path)
	if !strings.Contains(string(got), "KillMode=process") || !strings.Contains(string(got), "ExecStart=/opt/sb/superboard run --config /srv/sb.json") {
		t.Fatalf("refreshed unit:\n%s", got)
	}
	if changed, err := refreshUnitFile(path); err != nil || changed {
		t.Fatalf("second refresh = %v, %v; want a no-op", changed, err)
	}

	foreign := filepath.Join(t.TempDir(), "other.service")
	os.WriteFile(foreign, []byte("[Service]\nExecStart=/bin/true\n"), 0o644)
	if _, err := refreshUnitFile(foreign); err == nil {
		t.Fatal("a unit this tool did not write must be left alone")
	}
}
