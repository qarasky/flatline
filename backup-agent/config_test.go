package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"filippo.io/age"
)

type configFixture struct {
	dir      string
	identity *age.X25519Identity
}

func newFixture(t *testing.T) *configFixture {
	t.Helper()
	dir := t.TempDir()
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	fixture := &configFixture{dir: dir, identity: identity}
	fixture.writeSecret(t, "token", "flatline_backup_test\n")
	fixture.writeSecret(t, "credentials.json", `{"accessKeyId":"key","secretAccessKey":"secret"}`)
	return fixture
}

func (f *configFixture) writeSecret(t *testing.T, name, contents string) string {
	t.Helper()
	path := filepath.Join(f.dir, name)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func (f *configFixture) config(name string) map[string]any {
	return map[string]any{
		"version":              1,
		"name":                 name,
		"serverUrl":            "https://uptime.example",
		"tokenFile":            filepath.Join(f.dir, "token"),
		"recipient":            f.identity.Recipient().String(),
		"stateDir":             filepath.Join(f.dir, name),
		"spoolMaxBytes":        int64(1024),
		"postgres":             []any{},
		"s3":                   []any{},
		"uploadBytesPerSecond": int64(0),
	}
}

func (f *configFixture) writeConfig(t *testing.T, name string, value map[string]any) string {
	t.Helper()
	if value == nil {
		value = f.config(name)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(f.dir, name+".json")
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestNamedConfigIsolation(t *testing.T) {
	t.Run("valid defaults", func(t *testing.T) {
		fixture := newFixture(t)
		value := fixture.config("meks")
		delete(value, "spoolMaxBytes")
		delete(value, "uploadBytesPerSecond")
		cfg, err := LoadConfig(fixture.writeConfig(t, "meks", value))
		if err != nil {
			t.Fatalf("valid config rejected: %v", err)
		}
		if cfg.SpoolMaxBytes != defaultSpoolBytes {
			t.Fatalf("spool default = %d", cfg.SpoolMaxBytes)
		}
		if cfg.Schedule != defaultSchedule {
			t.Fatalf("schedule default = %q", cfg.Schedule)
		}
		if cfg.recipient == nil {
			t.Fatal("recipient was not parsed")
		}
	})

	t.Run("invalid names", func(t *testing.T) {
		fixture := newFixture(t)
		for _, name := range []string{"", "MEKS", "-meks", "_meks", "me ks", strings.Repeat("a", 65)} {
			value := fixture.config("meks")
			value["name"] = name
			value["stateDir"] = filepath.Join(fixture.dir, "state")
			if _, err := LoadConfig(fixture.writeConfig(t, "invalid", value)); err == nil {
				t.Fatalf("name %q must be rejected", name)
			}
		}
	})

	t.Run("insecure modes", func(t *testing.T) {
		fixture := newFixture(t)
		path := fixture.writeConfig(t, "meks", nil)
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadConfig(path); err == nil {
			t.Fatal("world-readable config must be rejected")
		}
	})

	t.Run("remote cleartext", func(t *testing.T) {
		fixture := newFixture(t)
		value := fixture.config("meks")
		value["serverUrl"] = "http://uptime.example"
		if _, err := LoadConfig(fixture.writeConfig(t, "meks", value)); err == nil {
			t.Fatal("remote HTTP must be rejected")
		}
		value["serverUrl"] = "http://127.0.0.1:3001"
		if _, err := LoadConfig(fixture.writeConfig(t, "meks", value)); err != nil {
			t.Fatalf("loopback HTTP must be accepted: %v", err)
		}
	})

	t.Run("state dir is name specific", func(t *testing.T) {
		fixture := newFixture(t)
		value := fixture.config("meks")
		value["stateDir"] = filepath.Join(fixture.dir, "shared")
		if _, err := LoadConfig(fixture.writeConfig(t, "meks", value)); err == nil {
			t.Fatal("a state dir not ending in the instance name must be rejected")
		}
	})

	t.Run("duplicate sources", func(t *testing.T) {
		fixture := newFixture(t)
		value := fixture.config("meks")
		value["postgres"] = []any{
			map[string]any{"container": "pg1", "user": "u", "databases": []string{"modernization"}},
			map[string]any{"container": "pg2", "user": "u", "databases": []string{"modernization"}},
		}
		if _, err := LoadConfig(fixture.writeConfig(t, "meks", value)); err == nil {
			t.Fatal("duplicate database names must be rejected")
		}

		value = fixture.config("meks")
		credentials := filepath.Join(fixture.dir, "credentials.json")
		value["s3"] = []any{
			map[string]any{"endpoint": "http://127.0.0.1:3900", "region": "garage", "bucket": "media", "credentialsFile": credentials},
			map[string]any{"endpoint": "http://127.0.0.1:3901", "region": "garage", "bucket": "media", "credentialsFile": credentials},
		}
		if _, err := LoadConfig(fixture.writeConfig(t, "meks", value)); err == nil {
			t.Fatal("duplicate bucket names must be rejected")
		}
	})

	t.Run("distinct locks", func(t *testing.T) {
		fixture := newFixture(t)
		meks := filepath.Join(fixture.dir, "meks")
		zhkh := filepath.Join(fixture.dir, "zhkhteam")
		first, err := AcquireInstanceLock(meks)
		if err != nil {
			t.Fatal(err)
		}
		defer first.Close()
		second, err := AcquireInstanceLock(zhkh)
		if err != nil {
			t.Fatalf("distinct named state dirs must not share a lock: %v", err)
		}
		defer second.Close()
		if _, err := AcquireInstanceLock(meks); err == nil {
			t.Fatal("a second live holder of the same lock must fail")
		}
	})
}
