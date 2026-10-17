package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config is the agent's entire configuration: where to push and with what
// credential. Everything else has sane defaults so provisioning is one token
// plus one URL.
type Config struct {
	// ServerURL is the Flatline origin, e.g. https://uptime.mediaboost.kz.
	ServerURL string `json:"server_url"`
	// PushToken is the monitor's push token. Bearer secret: the file holding
	// it must be 0600, and rotation is one server-side regenerate plus one
	// line changed here.
	PushToken string `json:"push_token"`
	// IntervalSeconds between live samples. Keep the monitor timeout at least
	// three times this interval, independently of telemetry refresh cadence.
	IntervalSeconds int `json:"interval_seconds,omitempty"`
	// AllowInsecure permits plain HTTP. The agent refuses it by default
	// because metrics (hostnames, container names, versions) are genuinely
	// useful recon travelling in cleartext otherwise.
	AllowInsecure bool `json:"allow_insecure,omitempty"`
	// BufferDir holds samples waiting for delivery (disk-backed queue).
	// Contains hostnames and container names: keep it 0700, root-owned.
	BufferDir string `json:"buffer_dir,omitempty"`
	// BufferMaxBytes caps that directory; oldest samples are dropped first
	// when full, so an endless outage cannot fill the disk.
	BufferMaxBytes int64 `json:"buffer_max_bytes,omitempty"`
	// SelfUpdate lets the agent replace its own binary when the server ships
	// a newer release (verified by sha256 over the same authenticated
	// channel). Default ON — an agent that cannot be updated is a fleet of
	// stale root daemons; set it false on a host you update by hand.
	SelfUpdate *bool `json:"self_update,omitempty"`
	// SelfUpdateIntervalHours paces the version check (default 24h).
	SelfUpdateIntervalHours int `json:"self_update_interval_hours,omitempty"`
	// SelfUpdateAllowDowngrade permits installing an older release, for
	// recovering a bad rollout without operator access to the host.
	SelfUpdateAllowDowngrade bool `json:"self_update_allow_downgrade,omitempty"`
}

// Fast live telemetry; existing explicitly configured intervals are preserved.
const DefaultIntervalSeconds = 1

// DefaultBufferDir is where undelivered samples wait across restarts.
const DefaultBufferDir = "/var/lib/superboard/buffer"

// DefaultBufferMaxBytes caps the buffer at 32 MiB: at 1Hz and ~1.5KB per
// sample that is many hours of telemetry — long enough for any realistic
// outage, small enough to be harmless on a tiny VPS disk.
const DefaultBufferMaxBytes = 32 << 20

// bufferDir resolves the configured buffer directory, applying the default.
func (c *Config) bufferDir() string {
	if c.BufferDir != "" {
		return c.BufferDir
	}
	return DefaultBufferDir
}

// bufferMaxBytes resolves the configured cap, applying the default.
func (c *Config) bufferMaxBytes() int64 {
	if c.BufferMaxBytes > 0 {
		return c.BufferMaxBytes
	}
	return DefaultBufferMaxBytes
}

// DefaultConfigPath is where `install` writes and `run` reads.
const DefaultConfigPath = "/etc/superboard/config.json"

/**
 * Load configuration from disk, applying defaults for unset fields.
 */
func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w (run `superboard install` first or pass --config)", path, err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}

	if cfg.ServerURL == "" {
		return nil, fmt.Errorf("config %s: server_url is required", path)
	}
	if cfg.PushToken == "" {
		return nil, fmt.Errorf("config %s: push_token is required", path)
	}
	if cfg.IntervalSeconds <= 0 {
		cfg.IntervalSeconds = DefaultIntervalSeconds
	}
	if cfg.BufferMaxBytes < 0 {
		cfg.BufferMaxBytes = DefaultBufferMaxBytes
	}

	return &cfg, nil
}

/**
 * Write configuration to disk with owner-only permissions.
 *
 * The push token is a bearer secret: anyone who can read this file can
 * impersonate the host. 0600 is not optional.
 */
func saveConfig(path string, cfg *Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}

	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}

	return nil
}
