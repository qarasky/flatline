package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"filippo.io/age"
)

// RestoreTargetConfig maps manifest sources to explicit scratch targets.
// There are deliberately no defaults: a missing mapping is an error, never
// the configured production source.
type RestoreTargetConfig struct {
	Version  int                     `json:"version"`
	Postgres []RestorePostgresTarget `json:"postgres"`
	S3       []RestoreS3Target       `json:"s3"`
	Globals  *RestoreGlobalsTarget   `json:"globals,omitempty"`
	// TempDir holds decrypted entries (up to 8 GiB each) while they are
	// verified and restored. It must be an absolute, existing, real
	// directory on a disk-backed filesystem; os.TempDir may be a small
	// tmpfs. Defaults to the bundle's directory.
	TempDir string `json:"tempDir,omitempty"`
}

type RestorePostgresTarget struct {
	Container string                   `json:"container"`
	User      string                   `json:"user"`
	Databases []RestoreDatabaseMapping `json:"databases"`
}

type RestoreDatabaseMapping struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

type RestoreS3Target struct {
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	CredentialsFile string `json:"credentialsFile"`
	SourceBucket    string `json:"sourceBucket"`
}

type RestoreGlobalsTarget struct {
	Container string `json:"container"`
	User      string `json:"user"`
}

// RestoreReport is redacted JSON suitable for an operator verification note.
// Archive verification and actual restore status are separate fields.
type RestoreReport struct {
	ArchiveVerified bool     `json:"archiveVerified"`
	RestoreStatus   string   `json:"restoreStatus"`
	Databases       []string `json:"databases,omitempty"`
	Objects         int      `json:"objects"`
	// Vanished counts listed objects deleted before export could read
	// them; they are named in the manifest and are not restored.
	Vanished   int    `json:"vanished,omitempty"`
	Error      string `json:"error,omitempty"`
	StartedAt  string `json:"startedAt"`
	FinishedAt string `json:"finishedAt"`
}

// RestoreExecutor is injectable so offline tests prove target checks,
// exact keys/content types and failure reporting without Docker or Garage.
type RestoreExecutor interface {
	DatabaseEmpty(ctx context.Context, target RestorePostgresTarget, database string) (bool, error)
	RestoreDatabase(ctx context.Context, target RestorePostgresTarget, database string, dump io.Reader) error
	TableCounts(ctx context.Context, target RestorePostgresTarget, database string) (map[string]int64, error)
	BucketEmpty(ctx context.Context, target RestoreS3Target) (bool, error)
	PutObject(ctx context.Context, target RestoreS3Target, key, contentType string, body *os.File, size int64) error
	ListObjects(ctx context.Context, target RestoreS3Target) (map[string]int64, error)
	ObjectDigest(ctx context.Context, target RestoreS3Target, key string) (int64, string, string, error)
	Extensions(ctx context.Context, target RestorePostgresTarget, database string) ([]string, error)
	RestoreGlobals(ctx context.Context, target RestoreGlobalsTarget, sql io.Reader) error
}

func LoadRestoreTarget(path string) (RestoreTargetConfig, error) {
	if err := requireSecretFile(path, "target config"); err != nil {
		return RestoreTargetConfig{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return RestoreTargetConfig{}, err
	}
	defer file.Close()

	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	decoder.DisallowUnknownFields()
	var target RestoreTargetConfig
	if err := decoder.Decode(&target); err != nil {
		return RestoreTargetConfig{}, fmt.Errorf("parse target config: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return RestoreTargetConfig{}, errors.New("parse target config: trailing data")
	}
	if target.Version == 0 {
		target.Version = 1
	}
	if target.Version != 1 {
		return RestoreTargetConfig{}, fmt.Errorf("unsupported target config version %d", target.Version)
	}
	if target.TempDir != "" {
		if err := requireRealDirectory(target.TempDir); err != nil {
			return RestoreTargetConfig{}, fmt.Errorf("tempDir: %w", err)
		}
	}

	databases := make(map[string]struct{})
	targetDatabases := make(map[string]struct{})
	for _, source := range target.Postgres {
		if source.Container == "" || source.User == "" || len(source.Databases) == 0 {
			return RestoreTargetConfig{}, errors.New("postgres targets need container, user and database mappings")
		}
		for _, mapping := range source.Databases {
			if mapping.Source == "" || mapping.Target == "" {
				return RestoreTargetConfig{}, errors.New("database mappings need source and target")
			}
			if mapping.Source == mapping.Target {
				return RestoreTargetConfig{}, fmt.Errorf("database %q must be restored to a different name", mapping.Source)
			}
			if _, exists := databases[mapping.Source]; exists {
				return RestoreTargetConfig{}, fmt.Errorf("duplicate database mapping for %q", mapping.Source)
			}
			if _, exists := targetDatabases[mapping.Target]; exists {
				return RestoreTargetConfig{}, fmt.Errorf("two sources cannot share target database %q", mapping.Target)
			}
			databases[mapping.Source] = struct{}{}
			targetDatabases[mapping.Target] = struct{}{}
		}
	}

	buckets := make(map[string]struct{})
	targetBuckets := make(map[string]struct{})
	for _, source := range target.S3 {
		if source.Endpoint == "" || source.Region == "" || source.Bucket == "" || source.SourceBucket == "" {
			return RestoreTargetConfig{}, errors.New("s3 targets need endpoint, region, sourceBucket and bucket")
		}
		if source.Bucket == source.SourceBucket {
			return RestoreTargetConfig{}, fmt.Errorf("bucket %q must be restored to a different bucket", source.SourceBucket)
		}
		if _, exists := buckets[source.SourceBucket]; exists {
			return RestoreTargetConfig{}, fmt.Errorf("duplicate bucket mapping for %q", source.SourceBucket)
		}
		buckets[source.SourceBucket] = struct{}{}
		if _, exists := targetBuckets[source.Bucket]; exists {
			return RestoreTargetConfig{}, fmt.Errorf("two sources cannot share target bucket %q", source.Bucket)
		}
		targetBuckets[source.Bucket] = struct{}{}
		endpoint, err := url.Parse(source.Endpoint)
		if err != nil || endpoint.Host == "" {
			return RestoreTargetConfig{}, errors.New("s3 target endpoint must be an absolute URL")
		}
		if endpoint.User != nil {
			return RestoreTargetConfig{}, errors.New("s3 target endpoint must not contain credentials")
		}
		if err := requireSecureURL(endpoint, "s3 target endpoint"); err != nil {
			return RestoreTargetConfig{}, err
		}
		if err := requireSecretFile(source.CredentialsFile, "credentialsFile"); err != nil {
			return RestoreTargetConfig{}, err
		}
		if _, err := loadS3Credentials(source.CredentialsFile); err != nil {
			return RestoreTargetConfig{}, err
		}
	}
	return target, nil
}

// RestoreBundle verifies the whole archive before touching any target, checks
// every target is empty and explicit, then restores databases and objects.
func RestoreBundle(ctx context.Context, bundlePath, identityFile, targetConfigPath string) (RestoreReport, error) {
	target, err := LoadRestoreTarget(targetConfigPath)
	if err != nil {
		return failedReport(err), err
	}
	return restoreBundleWith(ctx, bundlePath, identityFile, target, dockerRestoreExecutor{})
}

func restoreBundleWith(ctx context.Context, bundlePath, identityFile string, target RestoreTargetConfig, executor RestoreExecutor) (RestoreReport, error) {
	report := RestoreReport{
		RestoreStatus: "failed",
		StartedAt:     time.Now().UTC().Format(time.RFC3339),
	}
	before, err := os.Stat(bundlePath)
	if err != nil {
		return report, err
	}

	verified, err := VerifyBundle(ctx, bundlePath, identityFile)
	if err != nil {
		report.Error = "archive verification failed"
		return report, err
	}
	report.ArchiveVerified = true
	report.Vanished = len(verified.Manifest.Vanished)
	if err := validateRestoreMappings(verified.Manifest, target, false); err != nil {
		report.Error = err.Error()
		return report, err
	}

	after, err := os.Stat(bundlePath)
	if err != nil {
		return report, err
	}
	if before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		err := errors.New("bundle changed between verification and restore")
		report.Error = err.Error()
		return report, err
	}

	if err := checkTargetsEmpty(ctx, verified.Manifest, target, executor); err != nil {
		report.Error = err.Error()
		return report, err
	}

	work, err := restoreWorkDir(target, bundlePath)
	if err != nil {
		report.Error = "restore temp directory unavailable"
		return report, err
	}
	defer os.RemoveAll(work)

	if err := restoreEntries(ctx, bundlePath, identityFile, work, verified.Manifest, target, executor, &report); err != nil {
		report.Error = "restore failed; scratch targets were left for inspection"
		return report, err
	}

	report.RestoreStatus = "passed"
	report.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	return report, nil
}

// CompareRestore checks a completed scratch restore against the manifest.
func CompareRestore(ctx context.Context, bundlePath, identityFile, targetConfigPath string) (RestoreReport, error) {
	target, err := LoadRestoreTarget(targetConfigPath)
	if err != nil {
		return failedReport(err), err
	}
	return compareRestoreWith(ctx, bundlePath, identityFile, target, dockerRestoreExecutor{})
}

func compareRestoreWith(ctx context.Context, bundlePath, identityFile string, target RestoreTargetConfig, executor RestoreExecutor) (RestoreReport, error) {
	report := RestoreReport{
		RestoreStatus: "failed",
		StartedAt:     time.Now().UTC().Format(time.RFC3339),
	}
	verified, err := VerifyBundle(ctx, bundlePath, identityFile)
	if err != nil {
		report.Error = "archive verification failed"
		return report, err
	}
	report.ArchiveVerified = true
	report.Vanished = len(verified.Manifest.Vanished)
	if err := validateRestoreMappings(verified.Manifest, target, false); err != nil {
		report.Error = err.Error()
		return report, err
	}

	// Object keys, sizes, bodies and content types must match exactly.
	byBucket := make(map[string]map[string]Entry)
	for _, entry := range verified.Manifest.Entries {
		if entry.Kind != kindObject {
			continue
		}
		if byBucket[entry.Bucket] == nil {
			byBucket[entry.Bucket] = make(map[string]Entry)
		}
		byBucket[entry.Bucket][entry.Key] = entry
	}
	for sourceBucket, expected := range byBucket {
		targetSource := targetForBucket(target, sourceBucket)
		actual, err := executor.ListObjects(ctx, targetSource)
		if err != nil {
			report.Error = "target object listing failed"
			return report, err
		}
		if len(actual) != len(expected) {
			err := fmt.Errorf("bucket %q has %d objects, expected %d", targetSource.Bucket, len(actual), len(expected))
			report.Error = err.Error()
			return report, err
		}
		for key, entry := range expected {
			size, digest, contentType, err := executor.ObjectDigest(ctx, targetSource, key)
			if err != nil {
				report.Error = "target object read failed"
				return report, err
			}
			if size != entry.Size || digest != entry.SHA256 {
				err := fmt.Errorf("bucket %q object %q body does not match", targetSource.Bucket, key)
				report.Error = err.Error()
				return report, err
			}
			expectedType := entry.ContentType
			if expectedType == "" {
				expectedType = "application/octet-stream"
			}
			if contentType != expectedType {
				err := fmt.Errorf("bucket %q object %q content type does not match", targetSource.Bucket, key)
				report.Error = err.Error()
				return report, err
			}
		}
	}

	// Database table counts must match the exported snapshot.
	for _, summary := range verified.Manifest.Postgres {
		targetDatabase, postgresTarget := targetForDatabase(target, summary.Database)
		actual, err := executor.TableCounts(ctx, postgresTarget, targetDatabase)
		if err != nil {
			report.Error = "target table count failed"
			return report, err
		}
		if len(actual) != len(summary.TableCounts) {
			err := fmt.Errorf("database %q table count differs from the manifest", targetDatabase)
			report.Error = err.Error()
			return report, err
		}
		for table, count := range summary.TableCounts {
			if actual[table] != count {
				err := fmt.Errorf("database %q table %q count differs from the manifest", targetDatabase, table)
				report.Error = err.Error()
				return report, err
			}
		}
		extensions, err := executor.Extensions(ctx, postgresTarget, targetDatabase)
		if err != nil {
			report.Error = "target extension check failed"
			return report, err
		}
		if !sameStrings(extensions, summary.Extensions) {
			err := fmt.Errorf("database %q extension set differs from the manifest", targetDatabase)
			report.Error = err.Error()
			return report, err
		}
	}

	report.RestoreStatus = "passed"
	report.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	return report, nil
}

// RestoreGlobals is separate and explicit: cluster globals are not restored
// by a normal bundle restore.
func RestoreGlobals(ctx context.Context, bundlePath, identityFile, targetConfigPath string) (RestoreReport, error) {
	target, err := LoadRestoreTarget(targetConfigPath)
	if err != nil {
		return failedReport(err), err
	}
	return restoreGlobalsWith(ctx, bundlePath, identityFile, target, dockerRestoreExecutor{})
}

func restoreGlobalsWith(ctx context.Context, bundlePath, identityFile string, target RestoreTargetConfig, executor RestoreExecutor) (RestoreReport, error) {
	report := RestoreReport{RestoreStatus: "failed", StartedAt: time.Now().UTC().Format(time.RFC3339)}
	verified, err := VerifyBundle(ctx, bundlePath, identityFile)
	if err != nil {
		return report, err
	}
	report.ArchiveVerified = true
	if target.Globals == nil {
		err := errors.New("restore-globals needs an explicit globals target")
		report.Error = err.Error()
		return report, err
	}
	if err := validateRestoreMappings(verified.Manifest, target, true); err != nil {
		report.Error = err.Error()
		return report, err
	}

	globalsPath := ""
	for _, entry := range verified.Manifest.Entries {
		if entry.Kind == kindGlobals {
			globalsPath = entry.Path
			break
		}
	}
	if globalsPath == "" {
		err := errors.New("bundle has no globals entry")
		report.Error = err.Error()
		return report, err
	}

	if err := restoreGlobalsEntry(ctx, bundlePath, identityFile, globalsPath, target, executor); err != nil {
		report.Error = "globals restore failed"
		return report, err
	}
	report.RestoreStatus = "passed"
	report.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	return report, nil
}

func validateRestoreMappings(manifest Manifest, target RestoreTargetConfig, globals bool) error {
	for _, entry := range manifest.Entries {
		switch entry.Kind {
		case kindObject:
			if targetForBucketOK(target, entry.Bucket) == nil {
				return fmt.Errorf("no explicit target bucket for source %q", entry.Bucket)
			}
		case kindPostgres:
			if _, postgresTarget := targetForDatabaseOK(target, entry.Database); postgresTarget == nil {
				return fmt.Errorf("no explicit target database for source %q", entry.Database)
			}
			for _, summary := range manifest.Postgres {
				if summary.Database == entry.Database && summary.Container != "" {
					if targetContainer, _ := targetContainerForDatabase(target, entry.Database); targetContainer == summary.Container {
						return fmt.Errorf("database %q must be restored to a different container and name", entry.Database)
					}
				}
			}
		case kindGlobals:
			// Normal restores skip globals; the explicit restore-globals
			// command handles them. A bundle must not become unusable because
			// it contains an optional globals entry.
			_ = globals
		}
	}
	return nil
}

func checkTargetsEmpty(ctx context.Context, manifest Manifest, target RestoreTargetConfig, executor RestoreExecutor) error {
	seenBuckets := make(map[string]struct{})
	for _, entry := range manifest.Entries {
		if entry.Kind == kindObject {
			targetSource := targetForBucket(target, entry.Bucket)
			if _, seen := seenBuckets[targetSource.Bucket]; seen {
				continue
			}
			seenBuckets[targetSource.Bucket] = struct{}{}
			empty, err := executor.BucketEmpty(ctx, targetSource)
			if err != nil {
				return fmt.Errorf("check target bucket %q: %w", targetSource.Bucket, err)
			}
			if !empty {
				return fmt.Errorf("target bucket %q is not empty", targetSource.Bucket)
			}
		}
	}
	seenDatabases := make(map[string]struct{})
	for _, entry := range manifest.Entries {
		if entry.Kind != kindPostgres {
			continue
		}
		targetDatabase, postgresTarget := targetForDatabase(target, entry.Database)
		if _, seen := seenDatabases[targetDatabase]; seen {
			continue
		}
		seenDatabases[targetDatabase] = struct{}{}
		empty, err := executor.DatabaseEmpty(ctx, postgresTarget, targetDatabase)
		if err != nil {
			return fmt.Errorf("check target database %q: %w", targetDatabase, err)
		}
		if !empty {
			return fmt.Errorf("target database %q is not empty", targetDatabase)
		}
	}
	return nil
}

func requireRealDirectory(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("must be an absolute path")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("must be a real directory")
	}
	return nil
}

// restoreWorkDir creates a private (0700) directory for decrypted entries
// under the configured tempDir, or next to the bundle. The caller removes it.
func restoreWorkDir(target RestoreTargetConfig, bundlePath string) (string, error) {
	root := target.TempDir
	if root == "" {
		absolute, err := filepath.Abs(bundlePath)
		if err != nil {
			return "", err
		}
		root = filepath.Dir(absolute)
	}
	work, err := os.MkdirTemp(root, ".flatline-restore-")
	if err != nil {
		return "", err
	}
	if err := os.Chmod(work, 0o700); err != nil {
		_ = os.RemoveAll(work)
		return "", err
	}
	return work, nil
}

func restoreEntries(ctx context.Context, bundlePath, identityFile, work string, manifest Manifest, target RestoreTargetConfig, executor RestoreExecutor, report *RestoreReport) error {
	identities, err := readIdentities(identityFile)
	if err != nil {
		return err
	}
	bundle, err := os.Open(bundlePath)
	if err != nil {
		return err
	}
	defer bundle.Close()
	decrypted, err := age.Decrypt(bundle, identities...)
	if err != nil {
		return err
	}

	byPath := make(map[string]Entry, len(manifest.Entries))
	for _, entry := range manifest.Entries {
		byPath[entry.Path] = entry
	}

	archive := tar.NewReader(decrypted)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		if header.Name == "manifest.json" {
			if _, err := io.Copy(io.Discard, archive); err != nil {
				return err
			}
			continue
		}
		entry, exists := byPath[header.Name]
		if !exists {
			return fmt.Errorf("unexpected archive entry %q", header.Name)
		}

		switch entry.Kind {
		case kindPostgres:
			targetDatabase, postgresTarget := targetForDatabase(target, entry.Database)
			temporary, err := spillVerifiedEntry(archive, entry, work)
			if err != nil {
				return err
			}
			restoreErr := executor.RestoreDatabase(ctx, postgresTarget, targetDatabase, temporary)
			_ = temporary.Close()
			_ = os.Remove(temporary.Name())
			if restoreErr != nil {
				return restoreErr
			}
			report.Databases = append(report.Databases, targetDatabase)
		case kindObject:
			targetSource := targetForBucket(target, entry.Bucket)
			if err := restoreObject(ctx, archive, entry, work, targetSource, executor); err != nil {
				return err
			}
			report.Objects++
		case kindGlobals:
			if _, err := io.Copy(io.Discard, archive); err != nil {
				return err
			}
		}
	}
	// The second pass must reach an authenticated end with no trailing
	// plaintext, matching VerifyBundle's integrity contract.
	buffer := make([]byte, 1)
	for {
		read, err := decrypted.Read(buffer)
		if read > 0 {
			return errors.New("archive has trailing plaintext")
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func restoreObject(ctx context.Context, archive *tar.Reader, entry Entry, work string, target RestoreS3Target, executor RestoreExecutor) error {
	temporary, err := spillVerifiedEntry(archive, entry, work)
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	contentType := entry.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	err = executor.PutObject(ctx, target, entry.Key, contentType, temporary, entry.Size)
	closeErr := temporary.Close()
	if err != nil {
		return err
	}
	return closeErr
}

// spillVerifiedEntry writes one archive entry to a private temporary file and
// verifies its size and SHA-256 before any target write. Database dumps and
// objects share this guard.
func spillVerifiedEntry(archive *tar.Reader, entry Entry, work string) (*os.File, error) {
	temporary, err := os.CreateTemp(work, "entry-*")
	if err != nil {
		return nil, err
	}
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		_ = os.Remove(temporary.Name())
		return nil, err
	}
	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(temporary, hasher), archive)
	if err != nil {
		_ = temporary.Close()
		_ = os.Remove(temporary.Name())
		return nil, err
	}
	if written != entry.Size || hex.EncodeToString(hasher.Sum(nil)) != entry.SHA256 {
		_ = temporary.Close()
		_ = os.Remove(temporary.Name())
		return nil, fmt.Errorf("entry %q does not match the manifest", entry.Path)
	}
	if _, err := temporary.Seek(0, io.SeekStart); err != nil {
		_ = temporary.Close()
		_ = os.Remove(temporary.Name())
		return nil, err
	}
	return temporary, nil
}

func restoreGlobalsEntry(ctx context.Context, bundlePath, identityFile, globalsPath string, target RestoreTargetConfig, executor RestoreExecutor) error {
	identities, err := readIdentities(identityFile)
	if err != nil {
		return err
	}
	bundle, err := os.Open(bundlePath)
	if err != nil {
		return err
	}
	defer bundle.Close()
	decrypted, err := age.Decrypt(bundle, identities...)
	if err != nil {
		return err
	}
	archive := tar.NewReader(decrypted)
	for {
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			return errors.New("bundle has no globals entry")
		}
		if err != nil {
			return err
		}
		if header.Name == "manifest.json" {
			return errors.New("bundle has no globals entry")
		}
		if header.Name == globalsPath {
			data, err := io.ReadAll(io.LimitReader(archive, 64<<20+1))
			if err != nil {
				return err
			}
			if len(data) > 64<<20 {
				return errors.New("globals entry is too large")
			}
			if err := validateGlobalsSQL(data); err != nil {
				return err
			}
			return executor.RestoreGlobals(ctx, *target.Globals, bytes.NewReader(data))
		}
	}
}

func readIdentities(path string) ([]age.Identity, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return age.ParseIdentities(file)
}

func targetForBucket(target RestoreTargetConfig, source string) RestoreS3Target {
	if found := targetForBucketOK(target, source); found != nil {
		return *found
	}
	return RestoreS3Target{}
}

func targetForBucketOK(target RestoreTargetConfig, source string) *RestoreS3Target {
	for index := range target.S3 {
		if target.S3[index].SourceBucket == source {
			return &target.S3[index]
		}
	}
	return nil
}

func targetForDatabase(target RestoreTargetConfig, source string) (string, RestorePostgresTarget) {
	database, postgres := targetForDatabaseOK(target, source)
	if postgres == nil {
		return "", RestorePostgresTarget{}
	}
	return database, *postgres
}

func targetForDatabaseOK(target RestoreTargetConfig, source string) (string, *RestorePostgresTarget) {
	for index := range target.Postgres {
		for _, mapping := range target.Postgres[index].Databases {
			if mapping.Source == source {
				return mapping.Target, &target.Postgres[index]
			}
		}
	}
	return "", nil
}

func targetContainerForDatabase(target RestoreTargetConfig, source string) (string, *RestorePostgresTarget) {
	_, postgres := targetForDatabaseOK(target, source)
	if postgres == nil {
		return "", nil
	}
	return postgres.Container, postgres
}

// GenerateIdentity writes a new age identity with mode 0600 and returns only
// the public recipient. It refuses to overwrite an existing file.
func GenerateIdentity(path string) (string, error) {
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		return "", err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", fmt.Errorf("create identity: %w", err)
	}
	if _, err := io.WriteString(file, identity.String()+"\n"); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return identity.Recipient().String(), nil
}

func failedReport(err error) RestoreReport {
	return RestoreReport{
		RestoreStatus: "failed",
		Error:         err.Error(),
		StartedAt:     time.Now().UTC().Format(time.RFC3339),
	}
}

type dockerRestoreExecutor struct {
	binary string
}

func (d dockerRestoreExecutor) docker() string {
	if d.binary == "" {
		return "docker"
	}
	return d.binary
}

func (d dockerRestoreExecutor) s3Client(ctx context.Context, target RestoreS3Target) (S3API, error) {
	return newS3Client(ctx, S3Source{
		Endpoint:        target.Endpoint,
		Region:          target.Region,
		Bucket:          target.Bucket,
		CredentialsFile: target.CredentialsFile,
	})
}

func (d dockerRestoreExecutor) BucketEmpty(ctx context.Context, target RestoreS3Target) (bool, error) {
	client, err := d.s3Client(ctx, target)
	if err != nil {
		return false, err
	}
	maximum := int32(1)
	output, err := client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket:  aws.String(target.Bucket),
		MaxKeys: &maximum,
	})
	if err != nil {
		return false, err
	}
	return len(output.Contents) == 0, nil
}

func (d dockerRestoreExecutor) PutObject(ctx context.Context, target RestoreS3Target, key, contentType string, body *os.File, size int64) error {
	client, err := d.s3Client(ctx, target)
	if err != nil {
		return err
	}
	_, err = client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(target.Bucket),
		Key:           aws.String(key),
		Body:          body,
		ContentLength: aws.Int64(size),
		ContentType:   aws.String(contentType),
	})
	return err
}

func (d dockerRestoreExecutor) ObjectDigest(ctx context.Context, target RestoreS3Target, key string) (int64, string, string, error) {
	client, err := d.s3Client(ctx, target)
	if err != nil {
		return 0, "", "", err
	}
	output, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(target.Bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return 0, "", "", err
	}
	defer output.Body.Close()
	hasher := sha256.New()
	size, err := io.Copy(hasher, output.Body)
	if err != nil {
		return 0, "", "", err
	}
	if output.ContentLength != nil && *output.ContentLength != size {
		return 0, "", "", errors.New("target object length changed while reading")
	}
	return size, hex.EncodeToString(hasher.Sum(nil)), aws.ToString(output.ContentType), nil
}

func (d dockerRestoreExecutor) Extensions(ctx context.Context, target RestorePostgresTarget, database string) ([]string, error) {
	lines, err := d.psql(ctx, target, database, "SELECT extname FROM pg_extension ORDER BY 1")
	if err != nil {
		return nil, errors.New("target extension list failed")
	}
	return nonEmpty(lines), nil
}

func (d dockerRestoreExecutor) ListObjects(ctx context.Context, target RestoreS3Target) (map[string]int64, error) {
	client, err := d.s3Client(ctx, target)
	if err != nil {
		return nil, err
	}
	objects := make(map[string]int64)
	paginator := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{Bucket: aws.String(target.Bucket)})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, object := range page.Contents {
			objects[aws.ToString(object.Key)] = aws.ToInt64(object.Size)
		}
	}
	return objects, nil
}

func (d dockerRestoreExecutor) DatabaseEmpty(ctx context.Context, target RestorePostgresTarget, database string) (bool, error) {
	lines, err := d.psql(ctx, target, database,
		"SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")
	if err != nil || len(lines) == 0 {
		return false, errors.New("target database is not reachable")
	}
	var count int
	if _, err := fmt.Sscanf(strings.TrimSpace(lines[0]), "%d", &count); err != nil {
		return false, errors.New("target database emptiness could not be read")
	}
	return count == 0, nil
}

func (d dockerRestoreExecutor) TableCounts(ctx context.Context, target RestorePostgresTarget, database string) (map[string]int64, error) {
	lines, err := d.psql(ctx, target, database,
		"SELECT format('%I.%I', schemaname, tablename) FROM pg_tables "+
			"WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1")
	if err != nil {
		return nil, errors.New("target table list failed")
	}
	tables := nonEmpty(lines)
	if len(tables) == 0 {
		return map[string]int64{}, nil
	}
	countLines, err := d.psql(ctx, target, database, buildCountQuery(tables)+" ORDER BY 1")
	if err != nil {
		return nil, errors.New("target table counts failed")
	}
	counts := make(map[string]int64, len(countLines))
	for _, line := range countLines {
		fields := strings.Split(line, "\t")
		if len(fields) != 2 {
			return nil, errors.New("target table counts could not be parsed")
		}
		var count int64
		if _, err := fmt.Sscanf(fields[1], "%d", &count); err != nil {
			return nil, errors.New("target table counts could not be parsed")
		}
		counts[fields[0]] = count
	}
	return counts, nil
}

func (d dockerRestoreExecutor) RestoreDatabase(ctx context.Context, target RestorePostgresTarget, database string, dump io.Reader) error {
	command := exec.CommandContext(ctx, d.docker(), restoreDatabaseArgs(target, database)...)
	command.Stdin = dump
	command.Stderr = &limitedBuffer{limit: 4096}
	if err := command.Run(); err != nil {
		return errors.New("pg_restore failed")
	}
	return nil
}

func (d dockerRestoreExecutor) RestoreGlobals(ctx context.Context, target RestoreGlobalsTarget, sql io.Reader) error {
	command := exec.CommandContext(ctx, d.docker(), restoreGlobalsArgs(target)...)
	command.Stdin = sql
	command.Stderr = &limitedBuffer{limit: 4096}
	if err := command.Run(); err != nil {
		return errors.New("globals restore failed")
	}
	return nil
}

func (d dockerRestoreExecutor) psql(ctx context.Context, target RestorePostgresTarget, database, sql string) ([]string, error) {
	command := exec.CommandContext(ctx, d.docker(), restorePsqlArgs(target, database, sql)...)
	output, err := command.Output()
	if err != nil {
		return nil, err
	}
	raw := strings.Split(string(output), "\n")
	return nonEmpty(raw), nil
}

// Docker argument vectors. `--` ends docker's own option parsing, so a
// container name beginning with "-" can never be read as a docker flag.
func restoreDatabaseArgs(target RestorePostgresTarget, database string) []string {
	return []string{"exec", "-i", "--", target.Container,
		"pg_restore", "--no-owner", "--no-privileges", "--dbname=" + database, "-U", target.User}
}

func restoreGlobalsArgs(target RestoreGlobalsTarget) []string {
	return []string{"exec", "-i", "--", target.Container,
		"psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", target.User, "--dbname=postgres", "-f", "-"}
}

func restorePsqlArgs(target RestorePostgresTarget, database, sql string) []string {
	return []string{"exec", "--", target.Container,
		"psql", "-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1",
		"-U", target.User, "--dbname=" + database, "-c", sql}
}

// validateGlobalsSQL rejects psql meta-commands in bundle-provided SQL. The
// globals entry is data, not a script: \! and \copy would escape the target
// database into the container shell or filesystem.
func validateGlobalsSQL(data []byte) error {
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, `\`) {
			return errors.New("globals entry contains a psql meta-command")
		}
	}
	return nil
}

func sameStrings(left, right []string) bool {
	leftCopy := append([]string(nil), left...)
	rightCopy := append([]string(nil), right...)
	sort.Strings(leftCopy)
	sort.Strings(rightCopy)
	if len(leftCopy) != len(rightCopy) {
		return false
	}
	for index := range leftCopy {
		if leftCopy[index] != rightCopy[index] {
			return false
		}
	}
	return true
}
