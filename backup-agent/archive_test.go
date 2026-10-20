package main

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
)

func testIdentity(t *testing.T) (*age.X25519Identity, string) {
	t.Helper()
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "identity.txt")
	if err := os.WriteFile(path, []byte(identity.String()+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return identity, path
}

func writeSource(t *testing.T, spool *Spool, name string, body []byte) string {
	t.Helper()
	writer, err := spool.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(spool.Root(), name)
}

func newTestExport(identity *age.X25519Identity, files []ExportFile) Export {
	now := time.Now().UTC()
	return Export{
		Manifest: Manifest{
			FormatVersion:    1,
			ClientRunID:      "run-1",
			AgentName:        "meks",
			ExportStartedAt:  now.Add(-time.Hour).Format(time.RFC3339),
			ExportFinishedAt: now.Format(time.RFC3339),
			Postgres: []PostgresSummary{{
				Container:     "modernization-postgres-1",
				Database:      "modernization",
				ServerVersion: "16.4",
				ClientVersion: "16.4",
				Extensions:    []string{"plpgsql"},
				TableCounts:   map[string]int64{"public.items": 3},
			}},
		},
		Files: files,
	}
}

func TestArchiveExactKeys(t *testing.T) {
	identity, identityFile := testIdentity(t)
	spool, err := NewSpool(t.TempDir(), 64<<20)
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{Name: "meks", recipient: identity.Recipient()}

	keys := []string{"a", "a/b", "/lead", "x//y", "../x", "trail/", "юникод/ключ", "zero", "a b", "a\tb"}
	files := make([]ExportFile, 0, len(keys)+1)
	expectedBodies := make(map[string][]byte, len(keys))
	for index, key := range keys {
		body := []byte(fmt.Sprintf("body for %q", key))
		if key == "zero" {
			body = nil
		}
		path := fmt.Sprintf("objects/%06d", index+1)
		source := writeSource(t, spool, path, body)
		files = append(files, ExportFile{
			Path:        path,
			SourcePath:  source,
			Kind:        kindObject,
			Bucket:      "meks-media",
			Key:         key,
			ContentType: "application/octet-stream",
		})
		expectedBodies[key] = body
	}

	dumpBody := []byte("custom-format dump")
	dumpPath := "databases/000001.dump"
	dumpSource := writeSource(t, spool, dumpPath, dumpBody)
	files = append(files, ExportFile{
		Path:       dumpPath,
		SourcePath: dumpSource,
		Kind:       kindPostgres,
		Database:   "modernization",
	})

	bundle, err := WriteBundle(context.Background(), cfg, spool, newTestExport(identity, files))
	if err != nil {
		t.Fatalf("WriteBundle: %v", err)
	}
	if bundle.Summary.ObjectCount != len(keys) || bundle.Summary.DatabaseCount != 1 {
		t.Fatalf("summary = %+v", bundle.Summary)
	}

	verified, err := VerifyBundle(context.Background(), bundle.Path, identityFile)
	if err != nil {
		t.Fatalf("VerifyBundle: %v", err)
	}
	if len(verified.Manifest.Entries) != len(files) {
		t.Fatalf("entries = %d", len(verified.Manifest.Entries))
	}

	objects := make(map[string]Entry)
	for _, entry := range verified.Manifest.Entries {
		if entry.Kind == kindObject {
			objects[entry.Key] = entry
		}
	}
	if len(objects) != len(keys) {
		t.Fatalf("object keys = %d, want %d", len(objects), len(keys))
	}
	for _, key := range keys {
		if _, exists := objects[key]; !exists {
			t.Fatalf("key %q was normalized away", key)
		}
	}

	extracted := decryptTar(t, bundle.Path, identity)
	for _, entry := range verified.Manifest.Entries {
		body, exists := extracted[entry.Path]
		if !exists {
			t.Fatalf("archive is missing %q", entry.Path)
		}
		if int64(len(body)) != entry.Size {
			t.Fatalf("entry %q size mismatch", entry.Path)
		}
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != entry.SHA256 {
			t.Fatalf("entry %q hash mismatch", entry.Path)
		}
		if entry.Kind == kindObject && string(body) != string(expectedBodies[entry.Key]) {
			t.Fatalf("body for key %q changed", entry.Key)
		}
		if entry.Kind == kindPostgres && string(body) != string(dumpBody) {
			t.Fatalf("dump body changed")
		}
	}
}

func TestVerifyRejectsMalformedArchives(t *testing.T) {
	identity, identityFile := testIdentity(t)
	valid := func(t *testing.T) (string, Manifest) {
		spool, err := NewSpool(t.TempDir(), 64<<20)
		if err != nil {
			t.Fatal(err)
		}
		path := "objects/000001"
		source := writeSource(t, spool, path, []byte("body"))
		export := newTestExport(identity, []ExportFile{{
			Path: path, SourcePath: source, Kind: kindObject, Bucket: "b", Key: "k",
		}})
		bundle, err := WriteBundle(context.Background(), Config{Name: "meks", recipient: identity.Recipient()}, spool, export)
		if err != nil {
			t.Fatal(err)
		}
		return bundle.Path, bundle.Manifest
	}

	t.Run("tampered ciphertext", func(t *testing.T) {
		path, _ := valid(t)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		data[len(data)/2] ^= 0xFF
		corrupt := filepath.Join(t.TempDir(), "corrupt.age")
		if err := os.WriteFile(corrupt, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyBundle(context.Background(), corrupt, identityFile); err == nil {
			t.Fatal("tampered ciphertext must fail")
		}
	})

	t.Run("truncated", func(t *testing.T) {
		path, _ := valid(t)
		data, _ := os.ReadFile(path)
		truncated := filepath.Join(t.TempDir(), "truncated.age")
		if err := os.WriteFile(truncated, data[:len(data)-40], 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := VerifyBundle(context.Background(), truncated, identityFile); err == nil {
			t.Fatal("truncation must fail")
		}
	})

	t.Run("duplicate entry", func(t *testing.T) {
		manifest := rawManifest("objects/000001", "b", "k", []byte("body"))
		path := rawBundle(t, identity, []rawEntry{
			{"objects/000001", []byte("body")},
			{"objects/000001", []byte("body")},
		}, manifest)
		if _, err := VerifyBundle(context.Background(), path, identityFile); err == nil {
			t.Fatal("duplicate entries must fail")
		}
	})

	t.Run("unexpected entry", func(t *testing.T) {
		manifest := rawManifest("objects/000001", "b", "k", []byte("body"))
		path := rawBundle(t, identity, []rawEntry{
			{"objects/000001", []byte("body")},
			{"evil", []byte("body")},
		}, manifest)
		if _, err := VerifyBundle(context.Background(), path, identityFile); err == nil {
			t.Fatal("unexpected paths must fail")
		}
	})

	t.Run("unsupported version", func(t *testing.T) {
		manifest := rawManifest("objects/000001", "b", "k", []byte("body"))
		manifest.FormatVersion = 2
		path := rawBundle(t, identity, []rawEntry{{"objects/000001", []byte("body")}}, manifest)
		if _, err := VerifyBundle(context.Background(), path, identityFile); err == nil {
			t.Fatal("unsupported format version must fail")
		}
	})

	t.Run("forged length", func(t *testing.T) {
		manifest := rawManifest("objects/000001", "b", "k", []byte("body"))
		manifest.Entries[0].Size++
		path := rawBundle(t, identity, []rawEntry{{"objects/000001", []byte("body")}}, manifest)
		if _, err := VerifyBundle(context.Background(), path, identityFile); err == nil {
			t.Fatal("a forged length must fail")
		}
	})

	t.Run("oversized manifest", func(t *testing.T) {
		manifest := rawManifest("objects/000001", "b", strings.Repeat("k", maxManifestBytes+1), []byte("body"))
		path := rawBundle(t, identity, []rawEntry{{"objects/000001", []byte("body")}}, manifest)
		if _, err := VerifyBundle(context.Background(), path, identityFile); err == nil {
			t.Fatal("an oversized manifest must fail")
		}
	})

	t.Run("missing entry", func(t *testing.T) {
		manifest := rawManifest("objects/000002", "b", "k", []byte("body"))
		path := rawBundle(t, identity, []rawEntry{{"objects/000001", []byte("body")}}, manifest)
		if _, err := VerifyBundle(context.Background(), path, identityFile); err == nil {
			t.Fatal("a manifest entry missing from the archive must fail")
		}
	})

	t.Run("duplicate object mapping", func(t *testing.T) {
		manifest := rawManifest("objects/000001", "b", "k", []byte("body"))
		second := Entry{Path: "objects/000002", Kind: kindObject, Size: 4, Bucket: "b", Key: "k"}
		sum := sha256.Sum256([]byte("body"))
		second.SHA256 = hex.EncodeToString(sum[:])
		manifest.Entries = append(manifest.Entries, second)
		path := rawBundle(t, identity, []rawEntry{
			{"objects/000001", []byte("body")},
			{"objects/000002", []byte("body")},
		}, manifest)
		if _, err := VerifyBundle(context.Background(), path, identityFile); err == nil {
			t.Fatal("duplicate bucket/key mappings must fail")
		}
	})
}

type rawEntry struct {
	name string
	body []byte
}

func rawManifest(path, bucket, key string, body []byte) Manifest {
	now := time.Now().UTC()
	sum := sha256.Sum256(body)
	return Manifest{
		FormatVersion:    1,
		ClientRunID:      "raw-run",
		AgentName:        "meks",
		ExportStartedAt:  now.Add(-time.Hour).Format(time.RFC3339),
		ExportFinishedAt: now.Format(time.RFC3339),
		Entries: []Entry{{
			Path:   path,
			Kind:   kindObject,
			Size:   int64(len(body)),
			SHA256: hex.EncodeToString(sum[:]),
			Bucket: bucket,
			Key:    key,
		}},
	}
}

func rawBundle(t *testing.T, identity *age.X25519Identity, entries []rawEntry, manifest Manifest) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "raw.age")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := age.Encrypt(file, identity.Recipient())
	if err != nil {
		t.Fatal(err)
	}
	archive := tar.NewWriter(encrypted)
	for _, entry := range entries {
		header := &tar.Header{
			Name: entry.name, Mode: 0o600, Size: int64(len(entry.body)),
			ModTime: time.Unix(0, 0).UTC(), Typeflag: tar.TypeReg,
		}
		if err := archive.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.Write(entry.body); err != nil {
			t.Fatal(err)
		}
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	header := &tar.Header{
		Name: "manifest.json", Mode: 0o600, Size: int64(len(encoded)),
		ModTime: time.Unix(0, 0).UTC(), Typeflag: tar.TypeReg,
	}
	if err := archive.WriteHeader(header); err != nil {
		t.Fatal(err)
	}
	if _, err := archive.Write(encoded); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := encrypted.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func decryptTar(t *testing.T, path string, identity *age.X25519Identity) map[string][]byte {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	decrypted, err := age.Decrypt(file, identity)
	if err != nil {
		t.Fatal(err)
	}
	archive := tar.NewReader(decrypted)
	entries := make(map[string][]byte)
	for {
		header, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(archive)
		if err != nil {
			t.Fatal(err)
		}
		entries[header.Name] = body
	}
	_, _ = io.Copy(io.Discard, decrypted)
	return entries
}
