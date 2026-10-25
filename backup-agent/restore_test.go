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
	"os"
	"path/filepath"
	"strings"
	"testing"

	"filippo.io/age"
)

type fakeRestoreExecutor struct {
	bucketEmpty   map[string]bool
	databaseEmpty map[string]bool
	tables        map[string]map[string]int64
	extensions    map[string][]string
	puts          []fakePut
	putErrAt      int
	databaseErr   bool
	writes        int
	globalsUsed   bool
}

type fakePut struct {
	bucket      string
	key         string
	contentType string
	body        []byte
}

func (f *fakeRestoreExecutor) BucketEmpty(ctx context.Context, target RestoreS3Target) (bool, error) {
	if empty, exists := f.bucketEmpty[target.Bucket]; exists {
		return empty, nil
	}
	return true, nil
}

func (f *fakeRestoreExecutor) DatabaseEmpty(ctx context.Context, target RestorePostgresTarget, database string) (bool, error) {
	if empty, exists := f.databaseEmpty[database]; exists {
		return empty, nil
	}
	return true, nil
}

func (f *fakeRestoreExecutor) RestoreDatabase(ctx context.Context, target RestorePostgresTarget, database string, dump io.Reader) error {
	f.writes++
	if f.databaseErr {
		return errors.New("pg_restore failed")
	}
	_, err := io.Copy(io.Discard, dump)
	return err
}

func (f *fakeRestoreExecutor) TableCounts(ctx context.Context, target RestorePostgresTarget, database string) (map[string]int64, error) {
	if counts, exists := f.tables[database]; exists {
		return counts, nil
	}
	return map[string]int64{}, nil
}

func (f *fakeRestoreExecutor) PutObject(ctx context.Context, target RestoreS3Target, key, contentType string, body *os.File, size int64) error {
	f.writes++
	if f.putErrAt > 0 && f.writes == f.putErrAt {
		return errors.New("put failed")
	}
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	f.puts = append(f.puts, fakePut{bucket: target.Bucket, key: key, contentType: contentType, body: data})
	return nil
}

func (f *fakeRestoreExecutor) ObjectDigest(ctx context.Context, target RestoreS3Target, key string) (int64, string, string, error) {
	for _, put := range f.puts {
		if put.bucket == target.Bucket && put.key == key {
			sum := sha256.Sum256(put.body)
			return int64(len(put.body)), hex.EncodeToString(sum[:]), put.contentType, nil
		}
	}
	return 0, "", "", errors.New("object missing")
}

func (f *fakeRestoreExecutor) Extensions(ctx context.Context, target RestorePostgresTarget, database string) ([]string, error) {
	return f.extensions[database], nil
}

func (f *fakeRestoreExecutor) ListObjects(ctx context.Context, target RestoreS3Target) (map[string]int64, error) {
	objects := make(map[string]int64)
	for _, put := range f.puts {
		if put.bucket == target.Bucket {
			objects[put.key] = int64(len(put.body))
		}
	}
	return objects, nil
}

func (f *fakeRestoreExecutor) RestoreGlobals(ctx context.Context, target RestoreGlobalsTarget, sql io.Reader) error {
	f.writes++
	f.globalsUsed = true
	_, err := io.Copy(io.Discard, sql)
	return err
}

func makeRestoreBundle(t *testing.T, identity *age.X25519Identity, objects map[string][]byte, database, globals bool) string {
	return makeRestoreBundleWithGlobalsSQL(t, identity, objects, database, globals, []byte("-- globals"))
}

func makeRestoreBundleWithGlobalsSQL(t *testing.T, identity *age.X25519Identity, objects map[string][]byte, database, globals bool, globalsBody []byte) string {
	t.Helper()
	spool, err := NewSpool(t.TempDir(), 64<<20)
	if err != nil {
		t.Fatal(err)
	}
	files := make([]ExportFile, 0, len(objects)+2)
	index := 0
	for key, body := range objects {
		index++
		path := fmt.Sprintf("objects/%06d", index)
		files = append(files, ExportFile{
			Path: path, SourcePath: writeSource(t, spool, path, body),
			Kind: kindObject, Bucket: "meks-media", Key: key, ContentType: "text/plain",
		})
	}
	manifest := Manifest{
		FormatVersion:    1,
		ClientRunID:      "restore-run",
		AgentName:        "meks",
		ExportStartedAt:  "2026-01-01T00:00:00Z",
		ExportFinishedAt: "2026-01-01T01:00:00Z",
	}
	if database {
		dump := writeSource(t, spool, "databases/000001.dump", []byte("dump"))
		files = append(files, ExportFile{Path: "databases/000001.dump", SourcePath: dump, Kind: kindPostgres, Database: "modernization"})
		manifest.Postgres = []PostgresSummary{{
			Container: "modernization-postgres-1", Database: "modernization",
			ServerVersion: "16", ClientVersion: "16",
			TableCounts: map[string]int64{`"public"."items"`: 3},
		}}
	}
	if globals {
		sql := writeSource(t, spool, "globals/000001.sql", globalsBody)
		files = append(files, ExportFile{Path: "globals/000001.sql", SourcePath: sql, Kind: kindGlobals})
	}
	cfg := Config{Name: "meks"}
	if identity != nil {
		cfg.recipient = identity.Recipient()
	}
	bundle, err := WriteBundle(context.Background(), cfg, spool, Export{
		Manifest: manifest,
		Files:    files,
	})
	if err != nil {
		t.Fatal(err)
	}
	return bundle.Path
}

func writeRestoreTarget(t *testing.T, fixture *configFixture, sourceBucket, targetBucket, sourceDatabase, targetDatabase string, globals bool) string {
	t.Helper()
	target := map[string]any{
		"version":  1,
		"postgres": []any{},
		"s3":       []any{},
	}
	if sourceBucket != "" {
		target["s3"] = []any{map[string]any{
			"endpoint": "http://127.0.0.1:3900", "region": "garage",
			"bucket": targetBucket, "sourceBucket": sourceBucket,
			"credentialsFile": filepath.Join(fixture.dir, "credentials.json"),
		}}
	}
	if sourceDatabase != "" {
		target["postgres"] = []any{map[string]any{
			"container": "scratch-postgres", "user": "postgres",
			"databases": []any{map[string]string{"source": sourceDatabase, "target": targetDatabase}},
		}}
	}
	if globals {
		target["globals"] = map[string]string{"container": "scratch-postgres", "user": "postgres"}
	}
	encoded, err := json.Marshal(target)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "target.json")
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRestoreRequiresEmptyExplicitTargets(t *testing.T) {
	identity, identityFile := testIdentity(t)
	fixture := newFixture(t)
	bundle := makeRestoreBundle(t, identity, map[string][]byte{"a": []byte("body")}, true, false)

	t.Run("missing mappings", func(t *testing.T) {
		target := writeRestoreTarget(t, fixture, "", "", "", "", false)
		executor := &fakeRestoreExecutor{}
		report, err := restoreBundleWith(context.Background(), bundle, identityFile, mustLoadTarget(t, target), executor)
		if err == nil || report.RestoreStatus != "failed" {
			t.Fatalf("missing mappings must fail: %+v %v", report, err)
		}
		if executor.writes != 0 {
			t.Fatalf("writes = %d", executor.writes)
		}
	})

	t.Run("same database", func(t *testing.T) {
		target := writeRestoreTarget(t, fixture, "meks-media", "restore-media", "modernization", "modernization", false)
		if _, err := LoadRestoreTarget(target); err == nil {
			t.Fatal("a target equal to the source database must be rejected")
		}
	})

	t.Run("same bucket", func(t *testing.T) {
		target := writeRestoreTarget(t, fixture, "meks-media", "meks-media", "", "", false)
		if _, err := LoadRestoreTarget(target); err == nil {
			t.Fatal("a target equal to the source bucket must be rejected")
		}
	})

	t.Run("populated bucket", func(t *testing.T) {
		target := writeRestoreTarget(t, fixture, "meks-media", "restore-media", "", "", false)
		executor := &fakeRestoreExecutor{bucketEmpty: map[string]bool{"restore-media": false}}
		if _, err := restoreBundleWith(context.Background(), bundle, identityFile, mustLoadTarget(t, target), executor); err == nil {
			t.Fatal("a populated target bucket must be rejected")
		}
		if executor.writes != 0 {
			t.Fatalf("writes = %d", executor.writes)
		}
	})

	t.Run("populated database", func(t *testing.T) {
		target := writeRestoreTarget(t, fixture, "", "", "modernization", "restore_modernization", false)
		executor := &fakeRestoreExecutor{databaseEmpty: map[string]bool{"restore_modernization": false}}
		if _, err := restoreBundleWith(context.Background(), bundle, identityFile, mustLoadTarget(t, target), executor); err == nil {
			t.Fatal("a populated target database must be rejected")
		}
		if executor.writes != 0 {
			t.Fatalf("writes = %d", executor.writes)
		}
	})
}

func mustLoadTarget(t *testing.T, path string) RestoreTargetConfig {
	t.Helper()
	target, err := LoadRestoreTarget(path)
	if err != nil {
		t.Fatal(err)
	}
	return target
}

func TestRestoreVerifiesBeforeWriting(t *testing.T) {
	identity, identityFile := testIdentity(t)
	fixture := newFixture(t)
	bundle := makeRestoreBundle(t, identity, map[string][]byte{"a": []byte("body")}, false, false)

	data, err := os.ReadFile(bundle)
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)-12] ^= 0xFF
	corrupt := filepath.Join(t.TempDir(), "corrupt.age")
	if err := os.WriteFile(corrupt, data, 0o600); err != nil {
		t.Fatal(err)
	}
	target := writeRestoreTarget(t, fixture, "meks-media", "restore-media", "", "", false)
	executor := &fakeRestoreExecutor{}
	report, err := restoreBundleWith(context.Background(), corrupt, identityFile, mustLoadTarget(t, target), executor)
	if err == nil || report.ArchiveVerified {
		t.Fatalf("a corrupt archive must not verify: %+v %v", report, err)
	}
	if executor.writes != 0 {
		t.Fatalf("corrupt archive wrote %d entries", executor.writes)
	}
}

func TestRestoreKeysAndContentTypesExactly(t *testing.T) {
	identity, identityFile := testIdentity(t)
	fixture := newFixture(t)
	objects := map[string][]byte{
		"a":      []byte("first"),
		"a/b":    []byte("nested"),
		"zero":   nil,
		"юникод": []byte("unicode"),
	}
	bundle := makeRestoreBundle(t, identity, objects, false, false)
	target := writeRestoreTarget(t, fixture, "meks-media", "restore-media", "", "", false)
	executor := &fakeRestoreExecutor{}

	report, err := restoreBundleWith(context.Background(), bundle, identityFile, mustLoadTarget(t, target), executor)
	if err != nil {
		t.Fatal(err)
	}
	if report.RestoreStatus != "passed" || !report.ArchiveVerified {
		t.Fatalf("report = %+v", report)
	}
	if len(executor.puts) != len(objects) {
		t.Fatalf("puts = %d", len(executor.puts))
	}
	for _, put := range executor.puts {
		expected, exists := objects[put.key]
		if !exists {
			t.Fatalf("unexpected key %q", put.key)
		}
		if !bytes.Equal(put.body, expected) {
			t.Fatalf("body for %q changed", put.key)
		}
		if put.contentType != "text/plain" {
			t.Fatalf("content type for %q = %q", put.key, put.contentType)
		}
		if put.bucket != "restore-media" {
			t.Fatalf("bucket = %q", put.bucket)
		}
	}

	// Compare sees the same keys and sizes and passes.
	comparison, err := compareRestoreWith(context.Background(), bundle, identityFile, mustLoadTarget(t, target), executor)
	if err != nil || comparison.RestoreStatus != "passed" {
		t.Fatalf("comparison = %+v err=%v", comparison, err)
	}
}

func TestPartialRestoreNeverClaimsVerification(t *testing.T) {
	identity, identityFile := testIdentity(t)
	fixture := newFixture(t)

	t.Run("object failure", func(t *testing.T) {
		bundle := makeRestoreBundle(t, identity, map[string][]byte{"a": []byte("1"), "b": []byte("2")}, false, false)
		target := writeRestoreTarget(t, fixture, "meks-media", "restore-media", "", "", false)
		executor := &fakeRestoreExecutor{putErrAt: 2}
		report, err := restoreBundleWith(context.Background(), bundle, identityFile, mustLoadTarget(t, target), executor)
		if err == nil {
			t.Fatal("a failed PUT must fail the restore")
		}
		if report.RestoreStatus == "passed" || !report.ArchiveVerified || report.Error == "" {
			t.Fatalf("report claims success: %+v", report)
		}
	})

	t.Run("pg_restore failure", func(t *testing.T) {
		bundle := makeRestoreBundle(t, identity, nil, true, false)
		target := writeRestoreTarget(t, fixture, "", "", "modernization", "restore_modernization", false)
		executor := &fakeRestoreExecutor{databaseErr: true}
		report, err := restoreBundleWith(context.Background(), bundle, identityFile, mustLoadTarget(t, target), executor)
		if err == nil {
			t.Fatal("a failed pg_restore must fail the restore")
		}
		if report.RestoreStatus == "passed" || !report.ArchiveVerified {
			t.Fatalf("report claims success: %+v", report)
		}
	})
}

func TestGlobalsRequireSeparateCommand(t *testing.T) {
	identity, identityFile := testIdentity(t)
	fixture := newFixture(t)
	bundle := makeRestoreBundle(t, identity, nil, true, true)

	target := writeRestoreTarget(t, fixture, "", "", "modernization", "restore_modernization", true)
	executor := &fakeRestoreExecutor{}
	report, err := restoreBundleWith(context.Background(), bundle, identityFile, mustLoadTarget(t, target), executor)
	if err != nil || report.RestoreStatus != "passed" {
		t.Fatalf("normal restore must skip globals but restore the database: %+v %v", report, err)
	}
	if executor.globalsUsed {
		t.Fatal("normal restore executed globals")
	}
	if len(report.Databases) != 1 {
		t.Fatalf("normal restore databases = %v", report.Databases)
	}

	report, err = restoreGlobalsWith(context.Background(), bundle, identityFile, mustLoadTarget(t, target), executor)
	if err != nil || report.RestoreStatus != "passed" || !executor.globalsUsed {
		t.Fatalf("explicit globals restore = %+v err=%v used=%v", report, err, executor.globalsUsed)
	}
}

func TestGlobalsRejectMetaCommands(t *testing.T) {
	identity, identityFile := testIdentity(t)
	fixture := newFixture(t)
	bundle := makeRestoreBundleWithGlobalsSQL(t, identity, nil, false, true, []byte("\\! touch /tmp/pwned\n"))
	target := writeRestoreTarget(t, fixture, "", "", "", "", true)
	executor := &fakeRestoreExecutor{}
	report, err := restoreGlobalsWith(context.Background(), bundle, identityFile, mustLoadTarget(t, target), executor)
	if err == nil || report.RestoreStatus == "passed" {
		t.Fatalf("psql meta-command must be refused: %+v %v", report, err)
	}
	if executor.globalsUsed {
		t.Fatal("meta-command SQL reached the executor")
	}
}

func TestKeygenRefusesOverwrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "recovery.txt")
	recipient, err := GenerateIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(recipient, "age1") {
		t.Fatalf("recipient = %q", recipient)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("identity mode = %o", info.Mode().Perm())
	}
	first, _ := os.ReadFile(path)
	if _, err := GenerateIdentity(path); err == nil {
		t.Fatal("keygen must not overwrite an existing identity")
	}
	second, _ := os.ReadFile(path)
	if !bytes.Equal(first, second) {
		t.Fatal("refused keygen changed the identity file")
	}
}

// recordingTempExecutor records where decrypted entries were spilled.
type recordingTempExecutor struct {
	fakeRestoreExecutor
	spilled []string
}

func (r *recordingTempExecutor) PutObject(ctx context.Context, target RestoreS3Target, key, contentType string, body *os.File, size int64) error {
	r.spilled = append(r.spilled, body.Name())
	return r.fakeRestoreExecutor.PutObject(ctx, target, key, contentType, body, size)
}

// Review L4: decrypted entries of up to 8 GiB went to os.TempDir, which may
// be a small tmpfs. They now go to a private directory under the configured
// tempDir (default: next to the bundle) that is removed afterwards.
func TestRestoreSpillsIntoConfiguredTempDir(t *testing.T) {
	identity, identityFile := testIdentity(t)
	fixture := newFixture(t)
	bundle := makeRestoreBundle(t, identity, map[string][]byte{"a": []byte("one"), "b": []byte("two")}, false, false)
	target := mustLoadTarget(t, writeRestoreTarget(t, fixture, "meks-media", "restore-media", "", "", false))
	target.TempDir = t.TempDir()
	executor := &recordingTempExecutor{}

	report, err := restoreBundleWith(context.Background(), bundle, identityFile, target, executor)
	if err != nil || report.RestoreStatus != "passed" {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	if len(executor.spilled) != 2 {
		t.Fatalf("spilled = %v", executor.spilled)
	}
	for _, path := range executor.spilled {
		if !strings.HasPrefix(path, target.TempDir+string(os.PathSeparator)) {
			t.Fatalf("entry spilled outside tempDir: %s", path)
		}
	}
	left, _ := os.ReadDir(target.TempDir)
	if len(left) != 0 {
		t.Fatalf("restore left %d items in tempDir", len(left))
	}

	// Without tempDir the bundle's own directory is used, not os.TempDir.
	target.TempDir = ""
	work, err := restoreWorkDir(target, bundle)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(work)
	if filepath.Dir(work) != filepath.Dir(bundle) {
		t.Fatalf("default work dir %s is not beside the bundle", work)
	}
	if info, _ := os.Stat(work); info.Mode().Perm() != 0o700 {
		t.Fatalf("work dir mode = %v", info.Mode().Perm())
	}
	for _, bad := range []string{"relative/dir", filepath.Join(t.TempDir(), "missing")} {
		if err := requireRealDirectory(bad); err == nil {
			t.Fatalf("tempDir %q must be rejected", bad)
		}
	}
}

// Review L4: docker exec argument vectors end docker's option parsing with
// "--" before the container name.
func TestRestoreDockerArgsSeparateContainer(t *testing.T) {
	postgres := RestorePostgresTarget{Container: "--privileged", User: "postgres"}
	for name, args := range map[string][]string{
		"pg_restore": restoreDatabaseArgs(postgres, "restore_check"),
		"psql":       restorePsqlArgs(postgres, "restore_check", "SELECT 1"),
		"globals":    restoreGlobalsArgs(RestoreGlobalsTarget{Container: "--privileged", User: "postgres"}),
	} {
		separator := -1
		for index, arg := range args {
			if arg == "--" {
				separator = index
				break
			}
		}
		if separator < 0 || args[0] != "exec" || args[separator+1] != "--privileged" {
			t.Fatalf("%s: container is not after --: %q", name, args)
		}
	}
}
