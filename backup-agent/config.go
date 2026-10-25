package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"filippo.io/age"
	"golang.org/x/sys/unix"
)

const (
	maxConfigBytes    = 1 << 20
	defaultSchedule   = "*-*-* 02:00:00 Asia/Almaty"
	defaultSpoolBytes = int64(8 * 1024 * 1024 * 1024)
	namePattern       = `^[a-z0-9][a-z0-9_-]{0,63}$`
)

var validName = regexp.MustCompile(namePattern)

// PostgresSource is one Docker PostgreSQL container and the databases to
// export from it.
type PostgresSource struct {
	Container      string   `json:"container"`
	User           string   `json:"user"`
	Databases      []string `json:"databases"`
	IncludeGlobals bool     `json:"includeGlobals"`
}

// S3Source is one S3-compatible endpoint (Garage) and the bucket to export.
type S3Source struct {
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	Bucket          string `json:"bucket"`
	CredentialsFile string `json:"credentialsFile"`
}

// Config is one named agent instance. Version 1 is the only supported
// on-disk format; secrets live in separate mode-0600 files.
//
// Recipient is optional: empty (the default) writes plain tar bundles; an
// age X25519 public key encrypts every bundle, for sensitive data.
type Config struct {
	Version              int              `json:"version"`
	Name                 string           `json:"name"`
	ServerURL            string           `json:"serverUrl"`
	TokenFile            string           `json:"tokenFile"`
	Recipient            string           `json:"recipient,omitempty"`
	StateDir             string           `json:"stateDir"`
	SpoolMaxBytes        int64            `json:"spoolMaxBytes"`
	UploadBytesPerSecond int64            `json:"uploadBytesPerSecond"`
	Schedule             string           `json:"schedule"`
	Postgres             []PostgresSource `json:"postgres"`
	S3                   []S3Source       `json:"s3"`

	// Parsed recipient, not part of the JSON shape. Nil when encryption is
	// off.
	recipient age.Recipient `json:"-"`
}

// Encrypted reports whether bundles are age-encrypted to a recipient.
func (c Config) Encrypted() bool {
	return c.recipient != nil
}

// S3Credentials is the separate credentials file referenced by a source.
type S3Credentials struct {
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
}

// LoadConfig reads and strictly validates a named instance configuration.
// It never rewrites the source file and never logs secret values.
func LoadConfig(path string) (Config, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Config{}, fmt.Errorf("open config: %w", err)
	}
	if !info.Mode().IsRegular() {
		return Config{}, errors.New("config must be a regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return Config{}, errors.New("config must be mode 0600 (owner-only)")
	}
	if info.Size() > maxConfigBytes {
		return Config{}, errors.New("config is too large")
	}

	file, err := os.Open(path)
	if err != nil {
		return Config{}, fmt.Errorf("open config: %w", err)
	}
	defer file.Close()

	decoder := json.NewDecoder(io.LimitReader(file, maxConfigBytes+1))
	decoder.DisallowUnknownFields()
	var cfg Config
	if err := decoder.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("parse config: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return Config{}, errors.New("parse config: trailing data")
	}

	if err := cfg.normalizeAndValidate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c *Config) normalizeAndValidate() error {
	if c.Version == 0 {
		c.Version = 1
	}
	if c.Version != 1 {
		return fmt.Errorf("unsupported config version %d", c.Version)
	}
	if !validName.MatchString(c.Name) {
		return errors.New("name must be lowercase ASCII letters, digits, hyphens or underscores (1-64, starting with a letter or digit)")
	}

	server, err := url.Parse(c.ServerURL)
	if err != nil || server.Host == "" {
		return errors.New("serverUrl must be an absolute URL")
	}
	if server.User != nil {
		return errors.New("serverUrl must not contain credentials")
	}
	if err := requireSecureURL(server, "serverUrl"); err != nil {
		return err
	}

	if c.TokenFile == "" {
		return errors.New("tokenFile is required")
	}
	if err := requireSecretFile(c.TokenFile, "tokenFile"); err != nil {
		return err
	}

	// Encryption is opt-in. A recipient that is present but malformed is an
	// error, never a silent fallback to plain bundles.
	if c.Recipient != "" {
		recipient, err := age.ParseX25519Recipient(c.Recipient)
		if err != nil {
			return fmt.Errorf("recipient must be an age X25519 public key: %w", err)
		}
		c.recipient = recipient
	}

	if c.StateDir == "" {
		return errors.New("stateDir is required")
	}
	stateDir, err := filepath.Abs(c.StateDir)
	if err != nil {
		return fmt.Errorf("stateDir: %w", err)
	}
	if filepath.Base(stateDir) != c.Name {
		return fmt.Errorf("stateDir must end with the instance name %q", c.Name)
	}
	c.StateDir = filepath.Clean(stateDir)
	if info, err := os.Stat(stateDir); err == nil {
		if !info.IsDir() {
			return errors.New("stateDir must be a directory")
		}
		if info.Mode().Perm()&0o077 != 0 {
			return errors.New("stateDir must be mode 0700 (owner-only)")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("stateDir: %w", err)
	}

	if c.SpoolMaxBytes == 0 {
		c.SpoolMaxBytes = defaultSpoolBytes
	}
	if c.SpoolMaxBytes < 0 {
		return errors.New("spoolMaxBytes must be positive")
	}
	if c.UploadBytesPerSecond < 0 {
		return errors.New("uploadBytesPerSecond must not be negative")
	}
	if c.Schedule == "" {
		c.Schedule = defaultSchedule
	}

	databases := make(map[string]string)
	for index := range c.Postgres {
		source := &c.Postgres[index]
		source.Container = strings.TrimSpace(source.Container)
		source.User = strings.TrimSpace(source.User)
		if source.Container == "" || source.User == "" {
			return errors.New("postgres sources need container and user")
		}
		if len(source.Databases) == 0 {
			return errors.New("postgres sources need at least one database")
		}
		for _, database := range source.Databases {
			if database == "" {
				return errors.New("database names must not be empty")
			}
			if previous, exists := databases[database]; exists {
				return fmt.Errorf("database %q appears in both %q and %q", database, previous, source.Container)
			}
			databases[database] = source.Container
		}
	}

	buckets := make(map[string]string)
	for index := range c.S3 {
		source := &c.S3[index]
		if source.Endpoint == "" || source.Bucket == "" || source.Region == "" {
			return errors.New("s3 sources need endpoint, region and bucket")
		}
		endpoint, err := url.Parse(source.Endpoint)
		if err != nil || endpoint.Host == "" {
			return errors.New("s3 endpoint must be an absolute URL")
		}
		if endpoint.User != nil {
			return errors.New("s3 endpoint must not contain credentials")
		}
		if err := requireSecureURL(endpoint, "s3 endpoint"); err != nil {
			return err
		}
		if previous, exists := buckets[source.Bucket]; exists {
			return fmt.Errorf("bucket %q appears in both %q and %q", source.Bucket, previous, source.Endpoint)
		}
		buckets[source.Bucket] = source.Endpoint

		if source.CredentialsFile == "" {
			return errors.New("s3 credentialsFile is required")
		}
		if err := requireSecretFile(source.CredentialsFile, "credentialsFile"); err != nil {
			return err
		}
		if _, err := loadS3Credentials(source.CredentialsFile); err != nil {
			return err
		}
	}

	return nil
}

// requireSecureURL enforces HTTPS for Flatline and remote S3. Cleartext is
// permitted only for literal loopback endpoints (locally exposed Garage).
func requireSecureURL(parsed *url.URL, label string) error {
	switch parsed.Scheme {
	case "https":
		return nil
	case "http":
		host := parsed.Hostname()
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			return nil
		}
		return fmt.Errorf("%s must use HTTPS unless the host is a literal loopback address", label)
	default:
		return fmt.Errorf("%s must be an http(s) URL", label)
	}
}

func requireSecretFile(path, label string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s must be a regular file", label)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s must be mode 0600 (owner-only)", label)
	}
	return nil
}

// instanceLock is one named instance's exclusive lock. The kernel releases
// it if the process dies; no stale-lock cleanup is needed.
type instanceLock struct {
	file *os.File
}

func (l *instanceLock) Close() error {
	_ = unix.Flock(int(l.file.Fd()), unix.LOCK_UN)
	return l.file.Close()
}

// AcquireInstanceLock serializes timer and manual runs for one state
// directory. A second live instance gets an immediate error.
func AcquireInstanceLock(stateDir string) (io.Closer, error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, fmt.Errorf("create state dir: %w", err)
	}
	if info, err := os.Stat(stateDir); err != nil {
		return nil, fmt.Errorf("state dir: %w", err)
	} else if !info.IsDir() {
		return nil, errors.New("state dir must be a directory")
	}

	file, err := os.OpenFile(filepath.Join(stateDir, "instance.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open instance lock: %w", err)
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("another instance is running: %w", err)
	}
	return &instanceLock{file: file}, nil
}

// acquireInstanceLockWait retries AcquireInstanceLock once a second until it
// succeeds or wait elapses. Self-update uses it so a binary swap waits for a
// running backup instead of happening under it.
func acquireInstanceLockWait(stateDir string, wait time.Duration) (io.Closer, error) {
	deadline := time.Now().Add(wait)
	for {
		lock, err := AcquireInstanceLock(stateDir)
		if err == nil {
			return lock, nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, err
		}
		time.Sleep(min(time.Second, remaining))
	}
}

func loadS3Credentials(path string) (S3Credentials, error) {
	file, err := os.Open(path)
	if err != nil {
		return S3Credentials{}, fmt.Errorf("credentialsFile: %w", err)
	}
	defer file.Close()

	decoder := json.NewDecoder(io.LimitReader(file, 16*1024))
	decoder.DisallowUnknownFields()
	var credentials S3Credentials
	if err := decoder.Decode(&credentials); err != nil {
		return S3Credentials{}, fmt.Errorf("credentialsFile: %w", err)
	}
	if credentials.AccessKeyID == "" || credentials.SecretAccessKey == "" {
		return S3Credentials{}, errors.New("credentialsFile needs accessKeyId and secretAccessKey")
	}
	return credentials, nil
}
