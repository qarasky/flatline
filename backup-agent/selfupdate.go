package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Self-update outcomes, reported to the server on every check-in. Bounded
// codes, never free text: the server stores and shows them as they are.
const (
	updateOK               = "ok"
	updateDownloadFailed   = "download_failed"
	updateChecksumMismatch = "checksum_mismatch"
	updateVersionMismatch  = "version_mismatch"
	updateDowngradeRefused = "downgrade_refused"
	updateLockTimeout      = "lock_timeout"
	updateServerMismatch   = "server_mismatch"
	updateSwapFailed       = "swap_failed"
	updateNoAsset          = "no_asset"
)

const (
	defaultStagingDir   = "/var/lib/flatline-backup/update"
	defaultDisabledFile = "/etc/flatline-backup/self-update.disabled"
	// selfUpdateLockWait bounds the wait for a running backup to finish
	// before the binary is swapped. Past it the swap is skipped until the
	// next daily check.
	selfUpdateLockWait = 30 * time.Minute
	// reexecEnv marks the post-swap run of the new binary so it reports and
	// stops instead of looking for a further update.
	reexecEnv = "FLATLINE_BACKUP_SELF_UPDATE_REEXEC"
)

// updateOptions are the host paths and seams of one self-update. Zero
// values take the production defaults.
type updateOptions struct {
	unitDir      string
	binaryPath   string
	stagingDir   string
	disabledFile string
	lockWait     time.Duration
	// clientFor builds the per-instance API client (its token, its server).
	clientFor func(cfg Config) (*UploadClient, error)
	// probeVersion runs a binary's `version` command.
	probeVersion func(path string) (string, error)
	// refreshUnits makes the new binary re-render every unit.
	refreshUnits func(binary string) error
	// reexec runs the new binary once so it reports its own version.
	reexec func(binary string) error
}

func (o *updateOptions) defaults() {
	if o.unitDir == "" {
		o.unitDir = defaultUnitDir
	}
	if o.binaryPath == "" {
		o.binaryPath = defaultBinaryPath
	}
	if o.stagingDir == "" {
		o.stagingDir = defaultStagingDir
	}
	if o.disabledFile == "" {
		o.disabledFile = defaultDisabledFile
	}
	if o.lockWait == 0 {
		o.lockWait = selfUpdateLockWait
	}
	if o.clientFor == nil {
		o.clientFor = newUploadClient
	}
	if o.probeVersion == nil {
		o.probeVersion = probeBinaryVersion
	}
	if o.refreshUnits == nil {
		o.refreshUnits = func(binary string) error { return runBinary(binary, "install", "--refresh-units") }
	}
	if o.reexec == nil {
		o.reexec = func(binary string) error { return runBinary(binary, "self-update") }
	}
}

// instance is one installed backup agent and its API client.
type instance struct {
	cfg    Config
	client *UploadClient
}

// SelfUpdate checks in for every instance installed on this host and, when
// the server ships a newer build for this platform, installs it: download,
// verify size, sha256 and the build's own version, wait for running backups,
// keep the current binary as .prev, swap, refresh units, and let the new
// binary report itself. It returns the outcome code; a non-nil error carries
// the detail for the log.
func SelfUpdate(ctx context.Context, options updateOptions) (status string, installed string, err error) {
	options.defaults()
	if err := os.MkdirAll(options.stagingDir, 0o700); err != nil {
		return updateSwapFailed, "", fmt.Errorf("staging dir: %w", err)
	}
	previous := readLastStatus(options.stagingDir)

	paths, err := discoverInstances(options.unitDir)
	if err != nil {
		return updateOK, "", err
	}
	if len(paths) == 0 {
		return updateOK, "", nil
	}
	instances := make([]instance, 0, len(paths))
	for _, path := range paths {
		cfg, err := LoadConfig(path)
		if err != nil {
			log.Printf("self-update: skipping %s: %v", path, err)
			continue
		}
		client, err := options.clientFor(cfg)
		if err != nil {
			log.Printf("self-update: skipping %s: %v", cfg.Name, err)
			continue
		}
		instances = append(instances, instance{cfg: cfg, client: client})
	}
	if len(instances) == 0 {
		return updateOK, "", errors.New("no usable instance configuration")
	}

	// Every instance reports first, with the previous run's outcome, so each
	// project's version on the board stays current even when nothing updates.
	var release Release
	var reported bool
	// The download uses the credential that just worked: an instance whose
	// token was revoked must not block the host's updates.
	var source *UploadClient
	for _, inst := range instances {
		got, err := inst.client.checkin(ctx, platformID(), previous)
		if err != nil {
			log.Printf("self-update: check-in for %s failed: %v", inst.cfg.Name, err)
			continue
		}
		if !reported {
			release, reported, source = got, true, inst.client
		}
	}
	if !reported {
		return finishNone(ctx, options, instances, updateDownloadFailed, errors.New("no instance could check in"))
	}
	if os.Getenv(reexecEnv) != "" {
		return updateOK, "", nil
	}

	server := normalizeServer(instances[0].cfg.ServerURL)
	for _, inst := range instances[1:] {
		if normalizeServer(inst.cfg.ServerURL) != server {
			return finishNone(ctx, options, instances, updateServerMismatch,
				fmt.Errorf("instances report to different servers (%s, %s)", server, inst.cfg.ServerURL))
		}
	}
	if _, err := os.Stat(options.disabledFile); err == nil {
		return finishNone(ctx, options, instances, updateOK, nil)
	}

	if release.Version == "" {
		return finishNone(ctx, options, instances, updateOK, nil)
	}
	switch order := compareVersions(release.Version, version); {
	case order == 0:
		return finishNone(ctx, options, instances, updateOK, nil)
	case order < 0:
		return finishNone(ctx, options, instances, updateDowngradeRefused,
			fmt.Errorf("server ships %s, older than the running %s", release.Version, version))
	}
	var asset *ReleaseAsset
	for index := range release.Assets {
		if release.Assets[index].Platform == platformID() {
			asset = &release.Assets[index]
		}
	}
	if asset == nil {
		return finishNone(ctx, options, instances, updateNoAsset, fmt.Errorf("release %s has no %s build", release.Version, platformID()))
	}

	staged := filepath.Join(options.stagingDir, "flatline-backup.new")
	if err := source.downloadRelease(ctx, asset.File, staged, asset.Size); err != nil {
		return finishNone(ctx, options, instances, updateDownloadFailed, err)
	}
	defer os.Remove(staged)
	size, digest, err := hashFile(staged)
	if err != nil || size != asset.Size || !strings.EqualFold(digest, asset.SHA256) {
		return finishNone(ctx, options, instances, updateChecksumMismatch,
			fmt.Errorf("staged build does not match the release (%d bytes, sha256 %s)", size, digest))
	}
	if err := os.Chmod(staged, 0o755); err != nil {
		return finishNone(ctx, options, instances, updateSwapFailed, err)
	}
	if got, err := options.probeVersion(staged); err != nil || got != release.Version {
		return finishNone(ctx, options, instances, updateVersionMismatch,
			fmt.Errorf("staged build reports %q (%v), want %q", got, err, release.Version))
	}

	locks, err := lockAll(instances, options.lockWait)
	if err != nil {
		return finishNone(ctx, options, instances, updateLockTimeout, err)
	}
	swapErr := swapBinary(staged, options.binaryPath)
	for _, lock := range locks {
		lock.Close()
	}
	if swapErr != nil {
		return finishNone(ctx, options, instances, updateSwapFailed, swapErr)
	}
	log.Printf("self-update: installed %s (was %s); previous build kept at %s.prev", release.Version, version, options.binaryPath)

	writeLastStatus(options.stagingDir, updateOK)
	if err := options.refreshUnits(options.binaryPath); err != nil {
		log.Printf("self-update: refreshing units failed: %v", err)
	}
	// The new build checks in with its own version.
	if err := options.reexec(options.binaryPath); err != nil {
		log.Printf("self-update: the new build could not report itself: %v", err)
	}
	return updateOK, release.Version, nil
}

// finishNone is finish for the paths that installed nothing.
func finishNone(ctx context.Context, options updateOptions, instances []instance, status string, cause error) (string, string, error) {
	status, err := finish(ctx, options, instances, status, cause)
	return status, "", err
}

// selfUpdateMessage is the command's closing line. After a swap the running
// process is the old build, so it names the build it installed instead of
// its own version.
func selfUpdateMessage(status, installed string) string {
	if installed != "" {
		return fmt.Sprintf("self-update: installed %s (was %s)", installed, version)
	}
	return fmt.Sprintf("self-update: %s (running %s)", status, version)
}

// finish records the outcome for the next run and, when it is a failure,
// reports it now so the board does not wait a day to show it.
func finish(ctx context.Context, options updateOptions, instances []instance, status string, cause error) (string, error) {
	writeLastStatus(options.stagingDir, status)
	if status != updateOK {
		for _, inst := range instances {
			if _, err := inst.client.checkin(ctx, platformID(), status); err != nil {
				log.Printf("self-update: reporting %s for %s failed: %v", status, inst.cfg.Name, err)
			}
		}
	}
	return status, cause
}

// discoverInstances lists the config paths of installed instances, read
// from the `ExecStart=… run-once --config <path>` line of each
// `flatline-backup@<name>.service`. The units are the source of truth: the
// config directory also holds credentials files.
func discoverInstances(unitDir string) ([]string, error) {
	units, err := filepath.Glob(filepath.Join(unitDir, "flatline-backup@*.service"))
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, unit := range units {
		file, err := os.Open(unit)
		if err != nil {
			return nil, err
		}
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "ExecStart=") {
				continue
			}
			_, rest, found := strings.Cut(line, " run-once --config ")
			if !found {
				continue
			}
			path, err := unescapeSystemd(strings.TrimSpace(rest))
			if err != nil {
				_ = file.Close()
				return nil, fmt.Errorf("%s: %w", unit, err)
			}
			paths = append(paths, path)
		}
		_ = file.Close()
		if err := scanner.Err(); err != nil {
			return nil, err
		}
	}
	sort.Strings(paths)
	return paths, nil
}

// unescapeSystemd reverses systemdEscape: a bare word, or a double-quoted
// value with \\ and \" escapes.
func unescapeSystemd(value string) (string, error) {
	if !strings.HasPrefix(value, `"`) {
		return value, nil
	}
	if len(value) < 2 || !strings.HasSuffix(value, `"`) {
		return "", errors.New("unterminated quoted config path")
	}
	var out strings.Builder
	inner := value[1 : len(value)-1]
	for index := 0; index < len(inner); index++ {
		if inner[index] == '\\' && index+1 < len(inner) {
			index++
		}
		out.WriteByte(inner[index])
	}
	return out.String(), nil
}

func normalizeServer(raw string) string {
	return strings.TrimRight(strings.TrimSpace(raw), "/")
}

// lockAll takes every instance's run lock at once, or none: while one
// backup runs, the others stay free to start, and the locks are only held
// together for the swap. It retries each second until wait elapses.
func lockAll(instances []instance, wait time.Duration) ([]io.Closer, error) {
	deadline := time.Now().Add(wait)
	for {
		locks := make([]io.Closer, 0, len(instances))
		var busy string
		var busyErr error
		for _, inst := range instances {
			lock, err := AcquireInstanceLock(inst.cfg.StateDir)
			if err != nil {
				busy, busyErr = inst.cfg.Name, err
				break
			}
			locks = append(locks, lock)
		}
		if busyErr == nil {
			return locks, nil
		}
		for _, held := range locks {
			held.Close()
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, fmt.Errorf("backup %s is still running: %w", busy, busyErr)
		}
		time.Sleep(min(time.Second, remaining))
	}
}

// swapBinary keeps a copy of the current binary as <binary>.prev and
// atomically renames the staged build into place (staged next to the target
// first, so the rename never crosses filesystems).
func swapBinary(staged, binary string) error {
	if err := copyFile(binary, binary+".prev", 0o755); err != nil {
		return fmt.Errorf("keep previous build: %w", err)
	}
	next := filepath.Join(filepath.Dir(binary), ".flatline-backup.new")
	if err := copyFile(staged, next, 0o755); err != nil {
		_ = os.Remove(next)
		return fmt.Errorf("stage next to the binary: %w", err)
	}
	if err := os.Rename(next, binary); err != nil {
		_ = os.Remove(next)
		return fmt.Errorf("replace binary: %w", err)
	}
	return nil
}

func copyFile(from, to string, mode os.FileMode) error {
	source, err := os.Open(from)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(target, source); err != nil {
		_ = target.Close()
		return err
	}
	if err := target.Sync(); err != nil {
		_ = target.Close()
		return err
	}
	if err := target.Close(); err != nil {
		return err
	}
	return os.Chmod(to, mode)
}

// downloadRelease fetches one release build to dest, refusing more than
// size bytes, without the upload client's retry loop (the next daily check
// is the retry).
func (c *UploadClient) downloadRelease(ctx context.Context, file, dest string, size int64) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/release/"+file, nil)
	if err != nil {
		return errors.New("build download request")
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	response, err := c.http.Do(request)
	if err != nil {
		return errors.New("server unreachable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download answered %d", response.StatusCode)
	}
	target, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
	if err != nil {
		return err
	}
	if _, err := io.Copy(target, io.LimitReader(response.Body, size+1)); err != nil {
		_ = target.Close()
		return err
	}
	return target.Close()
}

func probeBinaryVersion(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, path, "version").Output()
	if err != nil {
		return "", err
	}
	// `flatline-backup 0.3.0`
	fields := strings.Fields(string(output))
	if len(fields) != 2 || fields[0] != "flatline-backup" {
		return "", fmt.Errorf("unexpected version output %q", strings.TrimSpace(string(output)))
	}
	return fields[1], nil
}

func runBinary(binary string, args ...string) error {
	command := exec.Command(binary, args...)
	command.Env = append(os.Environ(), reexecEnv+"=1")
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	return command.Run()
}

func readLastStatus(stagingDir string) string {
	data, err := os.ReadFile(filepath.Join(stagingDir, "last-status"))
	if err != nil {
		return ""
	}
	status := strings.TrimSpace(string(data))
	if validUpdateStatus(status) {
		return status
	}
	return ""
}

func writeLastStatus(stagingDir, status string) {
	if err := atomicWriteMode(filepath.Join(stagingDir, "last-status"), []byte(status+"\n"), 0o600); err != nil {
		log.Printf("self-update: could not record status: %v", err)
	}
}

func validUpdateStatus(status string) bool {
	if status == "" || len(status) > 40 {
		return false
	}
	for _, r := range status {
		if (r < 'a' || r > 'z') && r != '_' {
			return false
		}
	}
	return true
}

// compareVersions orders dotted numeric versions the way the telemetry
// agent does: a -pre/+build suffix is dropped and missing parts read as 0.
func compareVersions(a, b string) int {
	split := func(value string) []int {
		value = strings.TrimPrefix(strings.TrimSpace(value), "v")
		if index := strings.IndexAny(value, "-+"); index >= 0 {
			value = value[:index]
		}
		parts := strings.Split(value, ".")
		out := make([]int, 0, len(parts))
		for _, part := range parts {
			number, err := strconv.Atoi(part)
			if err != nil {
				number = 0
			}
			out = append(out, number)
		}
		return out
	}
	as, bs := split(a), split(b)
	for index := 0; index < len(as) || index < len(bs); index++ {
		var av, bv int
		if index < len(as) {
			av = as[index]
		}
		if index < len(bs) {
			bv = bs[index]
		}
		if av != bv {
			return av - bv
		}
	}
	return 0
}
