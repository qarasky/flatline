package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// DefaultSelfUpdateInterval is how often the agent asks the server whether a
// newer release exists. Releases are operator-driven and rare, so a daily
// check is plenty and keeps the load on the backend trivial.
const DefaultSelfUpdateInterval = 24 * time.Hour

// selfUpdateStartupDelay staggers the first check after boot, so a fleet
// rebooted together does not hit /agent/version in one thundering herd.
const selfUpdateStartupDelay = 2 * time.Minute

// selfUpdateDir holds the staged binary and the swap helper. Root-only: the
// helper runs as root and the staged binary is executable.
const selfUpdateDir = "/var/lib/superboard/update"

// selfUpdateHealthWindow is how long the helper waits for the restarted
// service to become active before rolling back. It must exceed the unit's
// RestartSec plus collection warm-up.
const selfUpdateHealthWindow = 45 * time.Second

// updateAsset is one downloadable agent build advertised by the server.
type updateAsset struct {
	Platform string `json:"platform"`
	File     string `json:"file"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
	URL      string `json:"url"`
}

// updateManifest is the payload of `GET /agent/version`.
type updateManifest struct {
	OK      bool          `json:"ok"`
	Version string        `json:"version"`
	Agents  []updateAsset `json:"agents"`
}

// selfUpdateEnabled reports whether the agent may replace its own binary.
// Default ON: an agent that cannot be updated is a fleet of stale root
// daemons. Only an explicit false turns it off (hand-updated hosts).
func (c *Config) selfUpdateEnabled() bool {
	return c.SelfUpdate == nil || *c.SelfUpdate
}

// selfUpdateInterval resolves the configured check cadence.
func (c *Config) selfUpdateInterval() time.Duration {
	if c.SelfUpdateIntervalHours > 0 {
		return time.Duration(c.SelfUpdateIntervalHours) * time.Hour
	}
	return DefaultSelfUpdateInterval
}

// platformID matches the server's asset naming, e.g. "linux-amd64".
func platformID() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}

// compareVersions orders dotted numeric versions: negative when a is older
// than b, zero when equal, positive when newer. A pre-release suffix is
// dropped, so "1.7.0-rc1" compares equal to "1.7.0" and never triggers a
// spurious upgrade or downgrade. Missing components read as zero, so "1.7"
// and "1.7.0" are equal.
func compareVersions(a, b string) int {
	split := func(value string) []int {
		value = strings.TrimPrefix(strings.TrimSpace(value), "v")
		if i := strings.IndexAny(value, "-+"); i >= 0 {
			value = value[:i]
		}
		parts := strings.Split(value, ".")
		out := make([]int, 0, len(parts))
		for _, part := range parts {
			n, err := strconv.Atoi(part)
			if err != nil {
				n = 0
			}
			out = append(out, n)
		}
		return out
	}

	as, bs := split(a), split(b)
	for i := 0; i < len(as) || i < len(bs); i++ {
		var av, bv int
		if i < len(as) {
			av = as[i]
		}
		if i < len(bs) {
			bv = bs[i]
		}
		if av != bv {
			return av - bv
		}
	}
	return 0
}

// pickAsset returns the build for this platform, or nil when the release
// ships nothing this host can run.
func pickAsset(m *updateManifest) *updateAsset {
	want := platformID()
	for i := range m.Agents {
		if m.Agents[i].Platform == want && m.Agents[i].SHA256 != "" {
			return &m.Agents[i]
		}
	}
	return nil
}

// fetchManifest asks the server what it ships.
func fetchManifest(ctx context.Context, cfg *Config) (*updateManifest, error) {
	server := strings.TrimRight(cfg.ServerURL, "/")
	if strings.HasPrefix(server, "http://") && !cfg.AllowInsecure {
		return nil, fmt.Errorf("refusing plain HTTP to %s (set allow_insecure to override)", server)
	}

	endpoint := fmt.Sprintf("%s/agent/version?token=%s", server, url.QueryEscape(cfg.PushToken))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("agent version: HTTP %d", resp.StatusCode)
	}

	var manifest updateManifest
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&manifest); err != nil {
		return nil, fmt.Errorf("agent version: %w", err)
	}
	return &manifest, nil
}

// checkForUpdate returns the release to install, or nil when the running
// build is current, newer than the server's, or has no matching artifact.
func checkForUpdate(ctx context.Context, cfg *Config) (*updateManifest, *updateAsset, error) {
	manifest, err := fetchManifest(ctx, cfg)
	if err != nil {
		return nil, nil, err
	}
	if manifest.Version == "" {
		return manifest, nil, nil
	}
	order := compareVersions(manifest.Version, version)
	if order == 0 {
		return manifest, nil, nil
	}
	if order < 0 && !cfg.SelfUpdateAllowDowngrade {
		return manifest, nil, nil
	}
	return manifest, pickAsset(manifest), nil
}

// downloadAsset streams an asset to dest, verifying the advertised sha256.
// The bytes land in dest+".part" and are renamed on success, so a truncated
// download can never be mistaken for a binary.
//
// The URL is built from the agent's own configured origin rather than taken
// from the manifest: the server may report an absolute URL that is wrong for
// this host (a proxy scheme, a public hostname the agent cannot resolve), and
// the agent already knows where it pushes.
func downloadAsset(ctx context.Context, cfg *Config, asset *updateAsset, dest string) error {
	link := fmt.Sprintf("%s/agent/%s?token=%s",
		strings.TrimRight(cfg.ServerURL, "/"), url.PathEscape(asset.File), url.QueryEscape(cfg.PushToken))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: 10 * time.Minute}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", asset.File, resp.StatusCode)
	}

	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return err
	}
	part := dest + ".part"
	out, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}

	digest := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(out, digest), resp.Body)
	syncErr := out.Sync()
	closeErr := out.Close()
	if copyErr != nil {
		os.Remove(part)
		return copyErr
	}
	if syncErr != nil || closeErr != nil {
		os.Remove(part)
		return fmt.Errorf("flush %s: %v%v", part, syncErr, closeErr)
	}

	if got := hex.EncodeToString(digest.Sum(nil)); !strings.EqualFold(got, asset.SHA256) {
		os.Remove(part)
		return fmt.Errorf("checksum mismatch for %s: got %s want %s", asset.File, got, asset.SHA256)
	}
	return os.Rename(part, dest)
}

// applySelfUpdate downloads the new build and hands the swap to a detached
// helper. The helper must be a separate process because it restarts the
// service it lives in, and it must be a copy of the *current* binary so it
// survives the binary being replaced under it.
func applySelfUpdate(ctx context.Context, cfg *Config, manifest *updateManifest, asset *updateAsset) error {
	if !hasSystemd() {
		return fmt.Errorf("systemd not detected; cannot restart automatically (release %s available — run install.sh --update)", manifest.Version)
	}

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate own binary: %w", err)
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return fmt.Errorf("resolve own binary: %w", err)
	}

	if err := os.MkdirAll(selfUpdateDir, 0o700); err != nil {
		return err
	}

	staged := filepath.Join(selfUpdateDir, asset.File)
	if err := downloadAsset(ctx, cfg, asset, staged); err != nil {
		return err
	}

	// Refuse to install something that cannot even print its version: a
	// corrupt or wrong-architecture binary must never reach the target path.
	out, err := exec.Command(staged, "version").Output()
	if err != nil {
		os.Remove(staged)
		return fmt.Errorf("staged binary failed to run: %w", err)
	}
	if !strings.Contains(string(out), manifest.Version) {
		os.Remove(staged)
		return fmt.Errorf("staged binary reports %q, want %q", strings.TrimSpace(string(out)), manifest.Version)
	}

	helper := filepath.Join(selfUpdateDir, "superboard-helper")
	if err := copyFile(exe, helper, 0o755); err != nil {
		return fmt.Errorf("stage helper: %w", err)
	}

	logPath := filepath.Join(selfUpdateDir, "apply.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()

	// setsid detaches the helper from this process group, so the service
	// restart that kills the agent does not kill the helper too.
	cmd := exec.Command(helper, "apply-update",
		"--new", staged, "--target", exe, "--backup", exe+".bak",
		"--service", systemdUnitName, "--expect", manifest.Version)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start update helper: %w", err)
	}

	log.Printf("superboard: update to %s staged; helper will swap and restart (log %s)", manifest.Version, logPath)
	return nil
}

// selfUpdateOnce runs one check-and-apply cycle. Errors are the caller's to
// log: an update problem must never disturb telemetry.
func selfUpdateOnce(ctx context.Context, cfg *Config) error {
	manifest, asset, err := checkForUpdate(ctx, cfg)
	if err != nil {
		return err
	}
	if asset == nil {
		return nil
	}
	return applySelfUpdate(ctx, cfg, manifest, asset)
}

// selfUpdateLoop checks for a newer release on a jittered schedule.
func selfUpdateLoop(ctx context.Context, cfg *Config) {
	if !cfg.selfUpdateEnabled() {
		log.Printf("superboard: self-update disabled by config")
		return
	}

	select {
	case <-ctx.Done():
		return
	case <-time.After(selfUpdateStartupDelay):
	}

	for {
		if err := selfUpdateOnce(ctx, cfg); err != nil {
			log.Printf("superboard: self-update: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(cfg.selfUpdateInterval()):
		}
	}
}

// cmdApplyUpdate is the swap the helper performs: keep the previous build,
// replace the target, restart and verify, and roll back when the new build
// does not come up. It runs in its own process precisely so it can outlive
// the restart.
func cmdApplyUpdate(newPath, target, backup, service, expect string) error {
	if newPath == "" || target == "" || backup == "" || service == "" {
		return fmt.Errorf("apply-update requires --new, --target, --backup and --service")
	}
	if out, err := exec.Command(newPath, "version").Output(); err != nil || !strings.Contains(string(out), expect) {
		return fmt.Errorf("refusing to apply: %s does not report version %s", newPath, expect)
	}
	log.Printf("apply-update: %s -> %s (backup %s)", newPath, target, backup)
	return applyAndVerify(newPath, target, backup,
		func() error { return systemctl("restart", service) },
		func() bool { return systemctlActive(service) },
		selfUpdateHealthWindow)
}

// applyAndVerify performs the file swap and the health check, rolling back to
// the backup when the service does not come back. The restart/health hooks
// are parameters so the swap can be tested without systemd.
func applyAndVerify(newPath, target, backup string, restart func() error, healthy func() bool, window time.Duration) error {
	if err := copyFile(target, backup, 0o755); err != nil {
		return fmt.Errorf("keep previous build: %w", err)
	}
	if err := replaceFile(newPath, target); err != nil {
		return fmt.Errorf("replace binary: %w", err)
	}
	if err := restart(); err != nil {
		log.Printf("apply-update: restart failed (%v); rolling back", err)
		return rollback(backup, target, restart)
	}

	deadline := time.Now().Add(window)
	for time.Now().Before(deadline) {
		if healthy() {
			log.Printf("apply-update: service active; update complete")
			return nil
		}
		time.Sleep(2 * time.Second)
	}
	log.Printf("apply-update: service not active within %s; rolling back", window)
	return rollback(backup, target, restart)
}

// rollback restores the previous build and restarts.
func rollback(backup, target string, restart func() error) error {
	if err := copyFile(backup, target, 0o755); err != nil {
		return fmt.Errorf("rollback failed: %w", err)
	}
	if err := restart(); err != nil {
		return fmt.Errorf("rollback restart failed: %w", err)
	}
	log.Printf("apply-update: rolled back to the previous build")
	return fmt.Errorf("new build did not become healthy; rolled back")
}

// systemctl runs one systemctl command, surfacing its output on failure.
func systemctl(args ...string) error {
	out, err := exec.Command("systemctl", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// systemctlActive reports whether the unit is running.
func systemctlActive(service string) bool {
	return exec.Command("systemctl", "is-active", "--quiet", service).Run() == nil
}

// replaceFile moves newPath onto target, falling back to a copy when the two
// live on different filesystems (rename would then fail with EXDEV).
func replaceFile(newPath, target string) error {
	if err := os.Rename(newPath, target); err == nil {
		return nil
	}
	tmp := target + ".new"
	if err := copyFile(newPath, tmp, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		os.Remove(tmp)
		return err
	}
	os.Remove(newPath)
	return nil
}

// copyFile copies src to dst with the given mode, creating parent dirs.
func copyFile(src, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
