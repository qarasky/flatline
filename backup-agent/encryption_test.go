package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writePlainObjectBundle writes a one-object bundle with no recipient, the
// default for an instance without encryption configured.
func writePlainObjectBundle(t *testing.T) Bundle {
	t.Helper()
	spool, err := NewSpool(t.TempDir(), 64<<20)
	if err != nil {
		t.Fatal(err)
	}
	path := "objects/000001"
	source := writeSource(t, spool, path, []byte("object body"))
	export := newTestExport(nil, []ExportFile{{
		Path: path, SourcePath: source, Kind: kindObject, Bucket: "b", Key: "k",
	}})
	bundle, err := WriteBundle(context.Background(), Config{Name: "meks"}, spool, export)
	if err != nil {
		t.Fatal(err)
	}
	return bundle
}

func TestConfigRecipientIsOptional(t *testing.T) {
	fixture := newFixture(t)

	plain := fixture.config("plain")
	delete(plain, "recipient")
	cfg, err := LoadConfig(fixture.writeConfig(t, "plain", plain))
	if err != nil {
		t.Fatalf("a config without recipient must load: %v", err)
	}
	if cfg.Encrypted() {
		t.Fatal("no recipient means no encryption")
	}

	encrypted, err := LoadConfig(fixture.writeConfig(t, "sealed", nil))
	if err != nil {
		t.Fatal(err)
	}
	if !encrypted.Encrypted() {
		t.Fatal("a recipient turns encryption on")
	}

	invalid := fixture.config("invalid")
	invalid["recipient"] = "age1notakey"
	if _, err := LoadConfig(fixture.writeConfig(t, "invalid", invalid)); err == nil {
		t.Fatal("a malformed recipient must still be rejected, never silently ignored")
	}
}

func TestPlainBundleRoundTrip(t *testing.T) {
	bundle := writePlainObjectBundle(t)

	if bundle.Summary.Encrypted {
		t.Fatal("summary must report a plain bundle as not encrypted")
	}
	if !strings.HasSuffix(bundle.Path, ".tar") {
		t.Fatalf("plain bundle path %q must end in .tar", bundle.Path)
	}
	head := make([]byte, len(ageMagic))
	file, err := os.Open(bundle.Path)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Read(head)
	_ = file.Close()
	if string(head) == ageMagic {
		t.Fatal("plain bundle must not be age-encrypted")
	}

	verified, err := VerifyBundle(context.Background(), bundle.Path, "")
	if err != nil {
		t.Fatalf("plain bundle must verify without an identity: %v", err)
	}
	if len(verified.Manifest.Entries) != 1 || verified.Manifest.Entries[0].Key != "k" {
		t.Fatalf("manifest = %+v", verified.Manifest)
	}
}

func TestPlainBundleIntegrity(t *testing.T) {
	mutate := func(t *testing.T, change func([]byte) []byte) string {
		t.Helper()
		bundle := writePlainObjectBundle(t)
		data, err := os.ReadFile(bundle.Path)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "mutated.tar")
		if err := os.WriteFile(path, change(data), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}

	t.Run("tampered entry body", func(t *testing.T) {
		path := mutate(t, func(data []byte) []byte {
			index := strings.Index(string(data), "object body")
			data[index] ^= 0xFF
			return data
		})
		if _, err := VerifyBundle(context.Background(), path, ""); err == nil {
			t.Fatal("a changed entry must fail its manifest hash")
		}
	})

	t.Run("truncated", func(t *testing.T) {
		path := mutate(t, func(data []byte) []byte { return data[:len(data)/2] })
		if _, err := VerifyBundle(context.Background(), path, ""); err == nil {
			t.Fatal("truncation must fail")
		}
	})

	t.Run("trailing data", func(t *testing.T) {
		path := mutate(t, func(data []byte) []byte { return append(data, []byte("appended")...) })
		if _, err := VerifyBundle(context.Background(), path, ""); err == nil {
			t.Fatal("bytes after the archive end must fail")
		}
	})
}

func TestEncryptedBundleStillNeedsIdentity(t *testing.T) {
	identity, identityFile := testIdentity(t)
	bundle := makeRestoreBundle(t, identity, map[string][]byte{"a": []byte("body")}, false, false)

	if _, err := VerifyBundle(context.Background(), bundle, ""); err == nil ||
		!strings.Contains(err.Error(), "identity") {
		t.Fatalf("encrypted bundle without identity must name the missing identity: %v", err)
	}
	if _, err := VerifyBundle(context.Background(), bundle, identityFile); err != nil {
		t.Fatalf("encrypted bundle with identity must verify: %v", err)
	}
}

func TestPlainBundleRestores(t *testing.T) {
	fixture := newFixture(t)
	objects := map[string][]byte{"a": []byte("first"), "b/c": []byte("nested")}
	bundle := makeRestoreBundle(t, nil, objects, true, false)
	target := writeRestoreTarget(t, fixture, "meks-media", "restore-media", "modernization", "restore_db", false)
	executor := &fakeRestoreExecutor{tables: map[string]map[string]int64{"restore_db": {`"public"."items"`: 3}}}

	report, err := restoreBundleWith(context.Background(), bundle, "", mustLoadTarget(t, target), executor)
	if err != nil {
		t.Fatalf("plain restore: %v", err)
	}
	if !report.ArchiveVerified || len(executor.puts) != len(objects) || len(report.Databases) != 1 {
		t.Fatalf("report = %+v puts = %d", report, len(executor.puts))
	}
}

func TestPendingDerivesEncryptionFromBundleBytes(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "meks")
	spool, err := NewSpool(filepath.Join(stateDir, "spool"), 64<<20)
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{Name: "meks", StateDir: stateDir}
	path := "objects/000001"
	source := writeSource(t, spool, path, []byte("body"))
	bundle, err := WriteBundle(context.Background(), cfg, spool, newTestExport(nil, []ExportFile{{
		Path: path, SourcePath: source, Kind: kindObject, Bucket: "b", Key: "k",
	}}))
	if err != nil {
		t.Fatal(err)
	}

	// A descriptor that claims encryption (an older agent, or a hand edit)
	// must not override what the bundle actually is.
	bundle.Summary.Encrypted = true
	if err := savePending(cfg, spool, bundle); err != nil {
		t.Fatal(err)
	}
	loaded, exists, err := loadPending(cfg, spool)
	if err != nil || !exists {
		t.Fatalf("load pending: %v %v", exists, err)
	}
	if loaded.Summary.Encrypted {
		t.Fatal("a plain bundle on disk must load as not encrypted")
	}
}
