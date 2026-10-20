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
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// DefaultSelfUpdateInterval is how often the agent asks the server whether a
// newer release exists. Releases are operator-driven and rare, so a daily
// check is plenty and keeps the load on the backend trivial.
const DefaultSelfUpdateInterval = 24 * time.Hour

// selfUpdateStartupSpread is the range of the random delay before the first
// check after start. It used to be a fixed two minutes, so a fleet rebooted
// (or redeployed) together checked — and downloaded — in the same second.
const selfUpdateStartupSpread = 60 * time.Minute

// selfUpdateIntervalJitter spreads every later check by ±10%, so hosts that
// happened to start together drift apart instead of staying in lockstep.
const selfUpdateIntervalJitter = 0.10

// selfUpdateDir holds the staged binary and the swap helper. Root-only: the
// helper runs as root and the staged binary is executable.
const selfUpdateDir = "/var/lib/superboard/update"

// selfUpdateStartTimeout is how long the helper waits for the restarted
// service to report active with a main PID at all.
const selfUpdateStartTimeout = 30 * time.Second

// selfUpdateHealthWindow is how long the new build must then stay up — same
// MainPID, no automatic restarts — and deliver its first push. It must
// exceed the unit's RestartSec (10s) plus collection warm-up, so a build
// that crashes shortly after start is caught by the PID/NRestarts change.
const selfUpdateHealthWindow = 45 * time.Second

// selfUpdateMarker is written by a newly started agent after its first
// accepted push; the helper waits for it (see markFirstPush).
const selfUpdateMarker = "first-push-ok"

// featureFirstPushMarker is advertised by `superboard features` in builds
// that write the marker. An older build being installed (a permitted
// downgrade) does not, and is judged on process stability alone.
const featureFirstPushMarker = "first-push-marker"

// versionProbeTimeout bounds `<binary> version` and similar probes of a
// staged build: a binary that hangs is as broken as one that crashes.
const versionProbeTimeout = 15 * time.Second

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

// probeVersion runs `<binary> version` under a deadline.
func probeVersion(binary string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), versionProbeTimeout)
	defer cancel()
	out, err := boundedCommand(ctx, binary, "version").Output()
	return strings.TrimSpace(string(out)), err
}

// binaryHasFeature asks a build whether it supports a capability. Builds
// that predate `features` exit non-zero and report none.
func binaryHasFeature(binary, feature string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), versionProbeTimeout)
	defer cancel()
	out, err := boundedCommand(ctx, binary, "features").Output()
	if err != nil {
		return false
	}
	return slices.Contains(strings.Fields(string(out)), feature)
}

// agentFeatures is what this build prints for `superboard features`.
var agentFeatures = []string{featureFirstPushMarker}

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
	out, err := probeVersion(staged)
	if err != nil {
		os.Remove(staged)
		return fmt.Errorf("staged binary failed to run: %w", err)
	}
	if !strings.Contains(out, manifest.Version) {
		os.Remove(staged)
		return fmt.Errorf("staged binary reports %q, want %q", out, manifest.Version)
	}

	helper := filepath.Join(selfUpdateDir, "superboard-helper")
	if err := copyFile(exe, helper+".new", 0o755); err != nil {
		return fmt.Errorf("stage helper: %w", err)
	}
	if err := os.Rename(helper+".new", helper); err != nil {
		return fmt.Errorf("stage helper: %w", err)
	}

	logPath := filepath.Join(selfUpdateDir, "apply.log")
	args := []string{"apply-update",
		"--new", staged, "--target", exe, "--backup", exe + ".bak",
		"--service", systemdUnitName, "--expect", manifest.Version, "--log", logPath}
	how, err := launchHelper(helper, args, logPath)
	if err != nil {
		return fmt.Errorf("start update helper: %w", err)
	}

	log.Printf("superboard: update to %s staged; helper started %s (log %s)", manifest.Version, how, logPath)
	return nil
}

// helperUnitName names the transient unit the helper runs in. Unique per
// attempt, so a failed earlier attempt never blocks the next one.
func helperUnitName(now time.Time) string {
	return fmt.Sprintf("superboard-update-%d", now.Unix())
}

// systemdRunArgs is the systemd-run command line for the helper.
//
// The helper must not live in superboard.service's cgroup: `systemctl
// restart superboard` kills the whole control group, and setsid does not
// leave it — the old helper died with the agent it restarted, so the health
// check and the rollback never ran. systemd-run starts it as its own
// transient service; --collect unloads the unit even when the helper fails.
func systemdRunArgs(unit string, collect bool, helper string, args []string) []string {
	out := []string{"--unit=" + unit, "--quiet", "--description=Flatline Superboard self-update"}
	if collect {
		out = append(out, "--collect")
	}
	out = append(out, "--", helper)
	return append(out, args...)
}

// launchHelper starts the swap helper outside the agent's service cgroup.
// It reports how the helper was started.
//
// Order: systemd-run with --collect (systemd ≥ 236), systemd-run without it
// (older hosts; the unit name is unique per attempt), and finally a setsid'd
// child. The last one survives the restart only because the unit sets
// KillMode=process (see unitFile); it is a fallback for hosts whose
// systemd-run is missing or refuses to run, not the normal path.
func launchHelper(helper string, args []string, logPath string) (string, error) {
	if path, err := exec.LookPath("systemd-run"); err == nil {
		unit := helperUnitName(time.Now())
		for _, collect := range []bool{true, false} {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			out, err := boundedCommand(ctx, path, systemdRunArgs(unit, collect, helper, args)...).CombinedOutput()
			cancel()
			if err == nil {
				return "as transient unit " + unit, nil
			}
			log.Printf("superboard: systemd-run (collect=%v) failed: %v: %s", collect, err, strings.TrimSpace(string(out)))
		}
	}

	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return "", err
	}
	defer logFile.Close()
	cmd := exec.Command(helper, args...)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return "", err
	}
	go cmd.Wait() // reap it if it ever finishes before we are restarted
	return "detached with setsid (fallback; relies on KillMode=process)", nil
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

// selfUpdateStartDelay is the random delay before the first check.
func selfUpdateStartDelay() time.Duration {
	return randomDuration(selfUpdateStartupSpread)
}

// jitterInterval spreads an interval by ±selfUpdateIntervalJitter.
func jitterInterval(d time.Duration) time.Duration {
	spread := time.Duration(float64(d) * selfUpdateIntervalJitter)
	return d - spread + randomDuration(2*spread)
}

// selfUpdateLoop checks for a newer release on a jittered schedule: a
// random 0-60 min after start, then every interval ±10%.
func selfUpdateLoop(ctx context.Context, cfg *Config) {
	if !cfg.selfUpdateEnabled() {
		log.Printf("superboard: self-update disabled by config")
		return
	}

	if !sleepCtx(ctx, selfUpdateStartDelay()) {
		return
	}
	for {
		if err := selfUpdateOnce(ctx, cfg); err != nil {
			log.Printf("superboard: self-update: %v", err)
		}
		if !sleepCtx(ctx, jitterInterval(cfg.selfUpdateInterval())) {
			return
		}
	}
}

// firstPushOnce makes markFirstPush write at most once per process.
var firstPushOnce sync.Once

// markFirstPush records that this process delivered a push the server
// accepted. The update helper waits for it before declaring a new build
// healthy: "the process stayed up" is necessary, "it can actually deliver"
// is the point. Only written when the update directory exists (the helper
// creates it), so ordinary hosts get no stray files.
func markFirstPush() {
	firstPushOnce.Do(func() {
		if info, err := os.Stat(selfUpdateDir); err != nil || !info.IsDir() {
			return
		}
		if err := writeMarker(filepath.Join(selfUpdateDir, selfUpdateMarker), version, os.Getpid()); err != nil {
			log.Printf("superboard: first-push marker: %v", err)
		}
	})
}

// writeMarker writes "<version> <pid>" atomically.
func writeMarker(path, ver string, pid int) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, fmt.Appendf(nil, "%s %d\n", ver, pid), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// readMarker parses a marker file.
func readMarker(path string) (ver string, pid int, ok bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) != 2 {
		return "", 0, false
	}
	pid, err = strconv.Atoi(fields[1])
	if err != nil {
		return "", 0, false
	}
	return fields[0], pid, true
}

// cmdApplyUpdate is the swap the helper performs: keep the previous build,
// replace the target, restart and verify, and roll back when the new build
// does not come up. It runs in its own transient unit precisely so it can
// outlive the restart.
func cmdApplyUpdate(newPath, target, backup, service, expect, logPath string) error {
	if logPath != "" {
		if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			defer f.Close()
			log.SetOutput(io.MultiWriter(os.Stderr, f))
		}
	}
	if newPath == "" || target == "" || backup == "" || service == "" {
		return fmt.Errorf("apply-update requires --new, --target, --backup and --service")
	}
	if out, err := probeVersion(newPath); err != nil || !strings.Contains(out, expect) {
		return fmt.Errorf("refusing to apply: %s does not report version %s", newPath, expect)
	}
	needMarker := binaryHasFeature(newPath, featureFirstPushMarker)
	markerPath := filepath.Join(filepath.Dir(newPath), selfUpdateMarker)
	_ = os.Remove(markerPath)

	log.Printf("apply-update: %s -> %s (backup %s, first-push marker required: %v)", newPath, target, backup, needMarker)
	check := healthCheck{
		probe:        func() (serviceState, error) { return systemctlState(service) },
		startTimeout: selfUpdateStartTimeout,
		window:       selfUpdateHealthWindow,
		poll:         2 * time.Second,
	}
	if needMarker {
		check.marker = func() (int, bool) {
			ver, pid, ok := readMarker(markerPath)
			return pid, ok && compareVersions(ver, expect) == 0
		}
	}
	restart := func() error {
		// The new build rewrites the unit (KillMode and future changes)
		// before it is started; a build without the command just fails here.
		refreshUnitVia(target)
		return systemctl("restart", service)
	}
	return applyAndVerify(newPath, target, backup, restart, check.wait)
}

// refreshUnitVia asks a binary to rewrite the service unit. Best-effort.
func refreshUnitVia(binary string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if out, err := boundedCommand(ctx, binary, "refresh-unit").CombinedOutput(); err != nil {
		log.Printf("apply-update: refresh-unit: %v: %s", err, strings.TrimSpace(string(out)))
	}
}

// applyAndVerify performs the file swap and the health check, rolling back to
// the backup when the service does not come back healthy. The restart and
// verify hooks are parameters so the swap can be tested without systemd.
func applyAndVerify(newPath, target, backup string, restart func() error, verify func() error) error {
	if err := atomicCopy(target, backup, 0o755); err != nil {
		return fmt.Errorf("keep previous build: %w", err)
	}
	if err := replaceFile(newPath, target); err != nil {
		return fmt.Errorf("replace binary: %w", err)
	}
	if err := restart(); err != nil {
		log.Printf("apply-update: restart failed (%v); rolling back", err)
		return rollback(backup, target, restart)
	}
	if err := verify(); err != nil {
		log.Printf("apply-update: new build unhealthy (%v); rolling back", err)
		return rollback(backup, target, restart)
	}
	log.Printf("apply-update: new build stayed up and delivered; update complete")
	return nil
}

// rollback restores the previous build and restarts. The backup is copied
// next to the target and renamed over it: writing into the live path with
// O_TRUNC fails with ETXTBSY while the binary runs, and an interruption
// half-way would leave a truncated binary behind — the one outcome a
// rollback exists to prevent.
func rollback(backup, target string, restart func() error) error {
	if err := atomicCopy(backup, target, 0o755); err != nil {
		return fmt.Errorf("rollback failed: %w", err)
	}
	if err := restart(); err != nil {
		return fmt.Errorf("rollback restart failed: %w", err)
	}
	log.Printf("apply-update: rolled back to the previous build")
	return fmt.Errorf("new build did not become healthy; rolled back")
}

// serviceState is the subset of `systemctl show` the health check reads.
type serviceState struct {
	Active    bool
	MainPID   int
	NRestarts int
	// HasRestarts is false on systemd < 235, which has no NRestarts.
	HasRestarts bool
}

// parseServiceState reads `systemctl show --property=...` output.
func parseServiceState(text string) serviceState {
	var st serviceState
	for _, line := range strings.Split(text, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch key {
		case "ActiveState":
			st.Active = value == "active"
		case "MainPID":
			st.MainPID, _ = strconv.Atoi(value)
		case "NRestarts":
			if n, err := strconv.Atoi(value); err == nil {
				st.NRestarts, st.HasRestarts = n, true
			}
		}
	}
	return st
}

// systemctlState reads the unit's state.
func systemctlState(service string) (serviceState, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := boundedCommand(ctx, "systemctl", "show", service, "--property=ActiveState,MainPID,NRestarts").Output()
	if err != nil {
		return serviceState{}, err
	}
	return parseServiceState(string(out)), nil
}

// healthCheck decides whether a restarted build is healthy.
//
// The old check returned on the first `is-active`, which is true the moment
// the process exists: a build that crashed two seconds later, and kept
// crash-looping under Restart=always, was reported "update complete". Now
// the service must reach active with a main PID within startTimeout, then
// keep that same MainPID and NRestarts for the whole window — any restart
// in between is a crash — and, when the build supports it, prove that it
// delivered a push (the marker, carrying the same PID).
type healthCheck struct {
	probe        func() (serviceState, error)
	marker       func() (pid int, ok bool) // nil: not required
	startTimeout time.Duration
	window       time.Duration
	poll         time.Duration
}

func (h healthCheck) wait() error {
	start := time.Now()
	var base *serviceState
	var stableUntil time.Time
	markerSeen := h.marker == nil

	for {
		now := time.Now()
		st, err := h.probe()
		up := err == nil && st.Active && st.MainPID > 0
		switch {
		case base == nil && up:
			base, stableUntil = &st, now.Add(h.window)
		case base != nil && !up:
			return fmt.Errorf("service left the active state during the health window (%v)", err)
		case base != nil && st.MainPID != base.MainPID:
			return fmt.Errorf("main PID changed %d -> %d: the new build restarted", base.MainPID, st.MainPID)
		case base != nil && st.HasRestarts && base.HasRestarts && st.NRestarts != base.NRestarts:
			return fmt.Errorf("NRestarts changed %d -> %d: the new build is crash-looping", base.NRestarts, st.NRestarts)
		}
		if base != nil && !markerSeen {
			if pid, ok := h.marker(); ok && pid == base.MainPID {
				markerSeen = true
			}
		}

		if base == nil && now.Sub(start) >= h.startTimeout {
			return fmt.Errorf("service not active within %s", h.startTimeout)
		}
		if base != nil && !now.Before(stableUntil) {
			if !markerSeen {
				return fmt.Errorf("no accepted push from the new build within %s", h.window)
			}
			return nil
		}
		time.Sleep(h.poll)
	}
}

// systemctl runs one systemctl command, surfacing its output on failure.
func systemctl(args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	out, err := boundedCommand(ctx, "systemctl", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// replaceFile moves newPath onto target, falling back to a copy when the two
// live on different filesystems (rename would then fail with EXDEV).
func replaceFile(newPath, target string) error {
	if err := os.Rename(newPath, target); err == nil {
		return nil
	}
	if err := atomicCopy(newPath, target, 0o755); err != nil {
		return err
	}
	os.Remove(newPath)
	return nil
}

// atomicCopy copies src over dst via dst.new and a rename, so dst is at
// every moment either the old file or the complete new one, and a running
// binary at dst is replaced (new inode) rather than written into.
func atomicCopy(src, dst string, mode os.FileMode) error {
	tmp := dst + ".new"
	if err := copyFile(src, tmp, mode); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
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
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
