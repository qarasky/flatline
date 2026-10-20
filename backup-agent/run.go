package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Runner holds the side effects RunOnce performs. Tests replace the export,
// upload and clock while keeping descriptor, spool and lock behaviour real.
type Runner struct {
	Export        func(context.Context, Config, *Spool, string) (Export, error)
	WriteBundle   func(context.Context, Config, *Spool, Export) (Bundle, error)
	Upload        func(context.Context, Config, Bundle) (RunSummary, error)
	ReportFailure func(context.Context, Config, string, string, string) error
	Now           func() time.Time
	NewRunID      func() string
}

func DefaultRunner() Runner {
	return Runner{
		Export:      ExportSources,
		WriteBundle: WriteBundle,
		Upload:      UploadBundle,
		ReportFailure: func(ctx context.Context, cfg Config, clientRunID, exportStartedAt, code string) error {
			client, err := newUploadClient(cfg)
			if err != nil {
				return err
			}
			return client.reportFailure(ctx, clientRunID, exportStartedAt, code)
		},
		Now:      time.Now,
		NewRunID: randomRunID,
	}
}

// RunOnce performs the locked retry-pending → export → encrypt → persist →
// upload sequence. On success every local artifact is removed.
func RunOnce(ctx context.Context, cfg Config) error {
	return DefaultRunner().Run(ctx, cfg)
}

func (r Runner) Run(ctx context.Context, cfg Config) error {
	if r.Export == nil || r.WriteBundle == nil || r.Upload == nil {
		return errors.New("runner is missing required operations")
	}
	if r.Now == nil {
		r.Now = time.Now
	}
	if r.NewRunID == nil {
		r.NewRunID = randomRunID
	}

	lock, err := AcquireInstanceLock(cfg.StateDir)
	if err != nil {
		return err
	}
	defer lock.Close()

	spool, err := NewSpool(filepath.Join(cfg.StateDir, "spool"), cfg.SpoolMaxBytes)
	if err != nil {
		return err
	}

	// A queued failure report from an offline export is best-effort; it must
	// never block a new backup.
	r.deliverQueuedFailure(ctx, cfg)
	// Earlier versions never pruned quarantine/; enforce the caps on every
	// run, before anything new is written.
	if err := pruneQuarantine(cfg, maxQuarantineEntries, cfg.SpoolMaxBytes); err != nil {
		return fmt.Errorf("prune quarantine: %w", err)
	}

	pending, exists, err := loadPending(cfg, spool)
	if err != nil {
		// A corrupt descriptor or bundle must not wedge every future backup.
		// Preserve it under quarantine/ and start a fresh export.
		if quarantineErr := r.quarantine(ctx, cfg, spool, "invalid-pending"); quarantineErr != nil {
			return fmt.Errorf("quarantine invalid pending bundle: %w", quarantineErr)
		}
		exists = false
	}
	if exists {
		if err := cleanSpool(spool, filepath.Base(pending.Path)); err != nil {
			return err
		}
		if _, err := r.Upload(ctx, cfg, pending); err != nil {
			if !errors.Is(err, errRunTerminal) {
				return fmt.Errorf("deliver pending bundle: %w", err)
			}
			// The server refused to reopen a terminal run (run_terminal or
			// params_conflict, never active_run). Preserve the bundle for
			// inspection and create a new client run below.
			if quarantineErr := r.quarantine(ctx, cfg, spool, "terminal-run"); quarantineErr != nil {
				return fmt.Errorf("quarantine terminal pending bundle: %w", quarantineErr)
			}
			exists = false
		} else {
			return clearPending(cfg, spool)
		}
	}
	if err := cleanSpool(spool, ""); err != nil {
		return err
	}

	clientRunID := r.NewRunID()
	started := r.Now().UTC()
	export, err := r.Export(ctx, cfg, spool, clientRunID)
	if err != nil {
		r.reportExportFailure(ctx, cfg, clientRunID, started, failureCode(err))
		_ = cleanSpool(spool, "")
		return fmt.Errorf("export sources: %w", err)
	}
	if export.Manifest.ClientRunID == "" {
		export.Manifest.ClientRunID = clientRunID
	}
	clientRunID = export.Manifest.ClientRunID

	bundle, err := r.WriteBundle(ctx, cfg, spool, export)
	if err != nil {
		r.reportExportFailure(ctx, cfg, clientRunID, started, "archive_failed")
		_ = cleanSpool(spool, "")
		return fmt.Errorf("write bundle: %w", err)
	}

	if err := savePending(cfg, spool, bundle); err != nil {
		_ = cleanSpool(spool, "")
		return fmt.Errorf("persist pending bundle: %w", err)
	}
	if _, err := r.Upload(ctx, cfg, bundle); err != nil {
		return fmt.Errorf("upload bundle: %w", err)
	}
	return clearPending(cfg, spool)
}

func (r Runner) reportExportFailure(ctx context.Context, cfg Config, clientRunID string, started time.Time, code string) {
	r.report(ctx, cfg, clientRunID, started.UTC().Format(time.RFC3339), code)
}

// report sends one safe failure code. A delivery problem that may clear
// (offline, 5xx) queues the report for the next run; a permanent refusal
// is dropped so it is not retried forever.
func (r Runner) report(ctx context.Context, cfg Config, clientRunID, exportStartedAt, code string) {
	if r.ReportFailure == nil {
		return
	}
	reportCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := r.ReportFailure(reportCtx, cfg, clientRunID, exportStartedAt, code); err != nil && reportRetryable(err) {
		_ = saveFailure(cfg, failureRecord{
			ClientRunID:     clientRunID,
			ExportStartedAt: exportStartedAt,
			Code:            code,
		})
	}
}

func reportRetryable(err error) bool {
	var permanent *permanentError
	if errors.As(err, &permanent) {
		return permanent.status == 408 || permanent.status == 429 || permanent.status >= 500
	}
	return true
}

// Quarantine keeps at most this many preserved bundles, and never more
// bytes than one spool cap, so a repeating refusal cannot fill the disk.
const maxQuarantineEntries = 2

// quarantine moves the pending bundle aside, prunes older quarantined
// bundles to the count and byte caps, and reports bundle_quarantined so the
// office alerts: a quarantined bundle is a backup that was not delivered.
func (r Runner) quarantine(ctx context.Context, cfg Config, spool *Spool, reason string) error {
	if err := quarantinePending(cfg, spool, reason); err != nil {
		return err
	}
	if err := pruneQuarantine(cfg, maxQuarantineEntries, cfg.SpoolMaxBytes); err != nil {
		return fmt.Errorf("prune quarantine: %w", err)
	}
	r.report(ctx, cfg, r.NewRunID(), r.Now().UTC().Format(time.RFC3339), "bundle_quarantined")
	return nil
}

func (r Runner) deliverQueuedFailure(ctx context.Context, cfg Config) {
	record, exists, err := loadFailure(cfg)
	if err != nil || !exists {
		return
	}
	if r.ReportFailure == nil {
		return
	}
	reportCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := r.ReportFailure(reportCtx, cfg, record.ClientRunID, record.ExportStartedAt, record.Code); err == nil || !reportRetryable(err) {
		_ = os.Remove(failurePath(cfg))
	}
}

func failureCode(err error) string {
	if errors.Is(err, ErrSpoolLimit) {
		return "spool_limit"
	}
	return "export_failed"
}

// pendingDescriptor survives a reboot: it names the one encrypted bundle
// that may be delivered, never a source file or an untrusted path.
type pendingDescriptor struct {
	ClientRunID      string        `json:"clientRunId"`
	BundleName       string        `json:"bundleName"`
	SHA256           string        `json:"sha256"`
	Size             int64         `json:"size"`
	ExportStartedAt  string        `json:"exportStartedAt"`
	ExportFinishedAt string        `json:"exportFinishedAt"`
	Summary          BundleSummary `json:"sourceSummary"`
}

type failureRecord struct {
	ClientRunID     string `json:"clientRunId"`
	ExportStartedAt string `json:"exportStartedAt"`
	Code            string `json:"code"`
}

func pendingPath(cfg Config) string { return filepath.Join(cfg.StateDir, "pending.json") }

func failurePath(cfg Config) string { return filepath.Join(cfg.StateDir, "failure.json") }

func savePending(cfg Config, spool *Spool, bundle Bundle) error {
	if filepath.Dir(bundle.Path) != spool.Root() {
		return errors.New("bundle is not inside the spool")
	}
	descriptor := pendingDescriptor{
		ClientRunID:      bundle.ClientRunID,
		BundleName:       filepath.Base(bundle.Path),
		SHA256:           bundle.SHA256,
		Size:             bundle.Size,
		ExportStartedAt:  bundle.ExportStartedAt,
		ExportFinishedAt: bundle.ExportFinishedAt,
		Summary:          bundle.Summary,
	}
	encoded, err := json.Marshal(descriptor)
	if err != nil {
		return err
	}
	return atomicWrite(pendingPath(cfg), encoded)
}

func loadPending(cfg Config, spool *Spool) (Bundle, bool, error) {
	data, err := os.ReadFile(pendingPath(cfg))
	if errors.Is(err, fs.ErrNotExist) {
		return Bundle{}, false, nil
	}
	if err != nil {
		return Bundle{}, false, fmt.Errorf("read pending descriptor: %w", err)
	}
	var descriptor pendingDescriptor
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&descriptor); err != nil {
		return Bundle{}, false, fmt.Errorf("parse pending descriptor: %w", err)
	}
	if descriptor.BundleName == "" || filepath.Base(descriptor.BundleName) != descriptor.BundleName {
		return Bundle{}, false, errors.New("pending descriptor has an unsafe bundle name")
	}

	path := filepath.Join(spool.Root(), descriptor.BundleName)
	info, err := os.Stat(path)
	if err != nil {
		return Bundle{}, false, fmt.Errorf("pending bundle is missing: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() != descriptor.Size {
		return Bundle{}, false, errors.New("pending bundle size does not match its descriptor")
	}
	size, digest, err := hashFile(path)
	if err != nil {
		return Bundle{}, false, fmt.Errorf("hash pending bundle: %w", err)
	}
	if size != descriptor.Size || digest != descriptor.SHA256 {
		return Bundle{}, false, errors.New("pending bundle hash does not match its descriptor")
	}

	return Bundle{
		Path:             path,
		Size:             descriptor.Size,
		SHA256:           descriptor.SHA256,
		ClientRunID:      descriptor.ClientRunID,
		ExportStartedAt:  descriptor.ExportStartedAt,
		ExportFinishedAt: descriptor.ExportFinishedAt,
		Summary:          descriptor.Summary,
	}, true, nil
}

func quarantinePending(cfg Config, spool *Spool, reason string) error {
	stamp := time.Now().UTC().Format("20060102T150405.000000000")
	directory := filepath.Join(cfg.StateDir, "quarantine", stamp+"-"+reason)
	if err := spool.Quarantine(filepath.Join(directory, "spool")); err != nil {
		return err
	}
	if err := os.Rename(pendingPath(cfg), filepath.Join(directory, "pending.json")); err != nil &&
		!errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func quarantineRoot(cfg Config) string { return filepath.Join(cfg.StateDir, "quarantine") }

// pruneQuarantine removes the oldest quarantined bundles until at most
// maxEntries remain and they hold at most maxBytes. The newest entry is
// always kept for inspection. Entry names start with a sortable UTC stamp.
func pruneQuarantine(cfg Config, maxEntries int, maxBytes int64) error {
	entries, err := os.ReadDir(quarantineRoot(cfg))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	type quarantined struct {
		path string
		size int64
	}
	var kept []quarantined
	var total int64
	for _, entry := range entries {
		path := filepath.Join(quarantineRoot(cfg), entry.Name())
		size, err := treeSize(path)
		if err != nil {
			return err
		}
		kept = append(kept, quarantined{path: path, size: size})
		total += size
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].path < kept[j].path })
	for len(kept) > 1 && (len(kept) > maxEntries || total > maxBytes) {
		if err := os.RemoveAll(kept[0].path); err != nil {
			return err
		}
		total -= kept[0].size
		kept = kept[1:]
	}
	return nil
}

// treeSize counts regular-file bytes without following symlinks.
func treeSize(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			total += info.Size()
		}
		return nil
	})
	return total, err
}

func clearPending(cfg Config, spool *Spool) error {
	if err := os.Remove(pendingPath(cfg)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return cleanSpool(spool, "")
}

func saveFailure(cfg Config, record failureRecord) error {
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return atomicWrite(failurePath(cfg), encoded)
}

func loadFailure(cfg Config) (failureRecord, bool, error) {
	data, err := os.ReadFile(failurePath(cfg))
	if errors.Is(err, fs.ErrNotExist) {
		return failureRecord{}, false, nil
	}
	if err != nil {
		return failureRecord{}, false, err
	}
	var record failureRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return failureRecord{}, false, err
	}
	return record, true, nil
}

// cleanSpool removes every file except keep (a base name). Orphan partials
// and unknown bundles are never treated as delivered.
func cleanSpool(spool *Spool, keep string) error {
	root := spool.Root()
	var remove []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative != keep {
			remove = append(remove, relative)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, name := range remove {
		if err := spool.Remove(name); err != nil {
			return err
		}
	}
	return nil
}

func atomicWrite(path string, data []byte) error {
	return atomicWriteMode(path, data, 0o600)
}

func atomicWriteMode(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func hashFile(path string) (int64, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	hasher := sha256.New()
	size, err := io.Copy(hasher, file)
	if err != nil {
		return 0, "", err
	}
	return size, hex.EncodeToString(hasher.Sum(nil)), nil
}

func randomRunID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("run-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}
