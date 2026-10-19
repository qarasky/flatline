package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	manifestFormatVersion = 1
	maxManifestBytes      = 32 << 20
	maxManifestEntries    = 100000
	maxBundleBytes        = int64(8) << 30

	kindPostgres = "postgres"
	kindGlobals  = "globals"
	kindObject   = "object"
)

var (
	entryPathPattern = regexp.MustCompile(`^(databases/[0-9]{6}\.dump|globals/[0-9]{6}\.sql|objects/[0-9]{6})$`)
	clientRunPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
)

// PostgresSummary records one exported database's versions and, under the
// same exported snapshot, per-table row counts.
type PostgresSummary struct {
	Container     string           `json:"container"`
	Database      string           `json:"database"`
	ServerVersion string           `json:"serverVersion"`
	ClientVersion string           `json:"clientVersion"`
	Extensions    []string         `json:"extensions"`
	TableCounts   map[string]int64 `json:"tableCounts"`
}

// Entry maps one generated archive path to its exact source object or
// database. Object keys never become filesystem paths.
type Entry struct {
	Path        string `json:"path"`
	Kind        string `json:"kind"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	Bucket      string `json:"bucket,omitempty"`
	Key         string `json:"key,omitempty"`
	ContentType string `json:"contentType,omitempty"`
	Database    string `json:"database,omitempty"`
}

// Manifest is the last archive entry. Times and counts never substitute for
// content hashes.
type Manifest struct {
	FormatVersion    int               `json:"formatVersion"`
	ClientRunID      string            `json:"clientRunId"`
	AgentName        string            `json:"agentName"`
	ExportStartedAt  string            `json:"exportStartedAt"`
	ExportFinishedAt string            `json:"exportFinishedAt"`
	Postgres         []PostgresSummary `json:"postgres"`
	Entries          []Entry           `json:"entries"`
}

// ExportFile is one generated body file waiting to be archived. The manifest
// entry hash and size are computed while writing, not trusted from input.
type ExportFile struct {
	Path        string
	SourcePath  string
	Kind        string
	Bucket      string
	Key         string
	ContentType string
	Database    string
}

// Export is a full run's manifest metadata plus body files.
type Export struct {
	Manifest Manifest
	Files    []ExportFile
}

// BundleSummary is the agent-reported source summary sent with the upload.
type BundleSummary struct {
	DatabaseCount int   `json:"databaseCount"`
	ObjectCount   int   `json:"objectCount"`
	SourceBytes   int64 `json:"sourceBytes"`
}

// Bundle is the encrypted, hashed output of WriteBundle.
type Bundle struct {
	Path             string
	Size             int64
	SHA256           string
	ClientRunID      string
	ExportStartedAt  string
	ExportFinishedAt string
	Manifest         Manifest
	Summary          BundleSummary
}

// VerifiedBundle is the validated manifest of a decrypted archive.
type VerifiedBundle struct {
	Manifest Manifest
}

func validateManifest(manifest *Manifest) error {
	if manifest.FormatVersion != manifestFormatVersion {
		return fmt.Errorf("unsupported archive format version %d", manifest.FormatVersion)
	}
	if !clientRunPattern.MatchString(manifest.ClientRunID) {
		return errors.New("manifest clientRunId is not a safe identifier")
	}
	if !validName.MatchString(manifest.AgentName) {
		return errors.New("manifest agentName is invalid")
	}
	started, err := time.Parse(time.RFC3339, manifest.ExportStartedAt)
	if err != nil {
		return errors.New("manifest exportStartedAt must be RFC3339")
	}
	finished, err := time.Parse(time.RFC3339, manifest.ExportFinishedAt)
	if err != nil {
		return errors.New("manifest exportFinishedAt must be RFC3339")
	}
	if finished.Before(started) {
		return errors.New("manifest exportFinishedAt precedes exportStartedAt")
	}

	if len(manifest.Entries) > maxManifestEntries {
		return fmt.Errorf("manifest has more than %d entries", maxManifestEntries)
	}
	paths := make(map[string]struct{}, len(manifest.Entries))
	objects := make(map[string]struct{}, len(manifest.Entries))
	for index := range manifest.Entries {
		entry := &manifest.Entries[index]
		if !entryPathPattern.MatchString(entry.Path) {
			return fmt.Errorf("entry path %q is not a generated identifier", entry.Path)
		}
		if _, exists := paths[entry.Path]; exists {
			return fmt.Errorf("duplicate archive path %q", entry.Path)
		}
		paths[entry.Path] = struct{}{}
		if entry.Size < 0 {
			return fmt.Errorf("entry %q has a negative size", entry.Path)
		}
		if len(entry.SHA256) != 64 {
			return fmt.Errorf("entry %q has an invalid sha256", entry.Path)
		}
		if _, err := hex.DecodeString(entry.SHA256); err != nil {
			return fmt.Errorf("entry %q has an invalid sha256", entry.Path)
		}

		switch entry.Kind {
		case kindObject:
			if !strings.HasPrefix(entry.Path, "objects/") {
				return fmt.Errorf("object entry %q must use objects/ path", entry.Path)
			}
			if entry.Bucket == "" || entry.Key == "" {
				return fmt.Errorf("object entry %q needs bucket and key", entry.Path)
			}
			mapping := entry.Bucket + "\x00" + entry.Key
			if _, exists := objects[mapping]; exists {
				return fmt.Errorf("duplicate object mapping %q/%q", entry.Bucket, entry.Key)
			}
			objects[mapping] = struct{}{}
		case kindPostgres:
			if !strings.HasPrefix(entry.Path, "databases/") {
				return fmt.Errorf("postgres entry %q must use databases/ path", entry.Path)
			}
			if entry.Database == "" {
				return fmt.Errorf("database entry %q needs a database", entry.Path)
			}
		case kindGlobals:
			if !strings.HasPrefix(entry.Path, "globals/") {
				return fmt.Errorf("globals entry %q must use globals/ path", entry.Path)
			}
			// Cluster globals are not tied to one database.
		default:
			return fmt.Errorf("entry %q has unsupported kind %q", entry.Path, entry.Kind)
		}
	}

	for _, database := range manifest.Postgres {
		if database.Container == "" || database.Database == "" {
			return errors.New("manifest postgres summaries need container and database")
		}
		for table, count := range database.TableCounts {
			if table == "" || count < 0 {
				return fmt.Errorf("manifest table count for %q is invalid", table)
			}
		}
	}
	return nil
}

func encodeManifest(manifest Manifest) ([]byte, error) {
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return nil, fmt.Errorf("encode manifest: %w", err)
	}
	if len(encoded) > maxManifestBytes {
		return nil, fmt.Errorf("manifest exceeds %d bytes", maxManifestBytes)
	}
	return encoded, nil
}

func summarize(manifest Manifest) BundleSummary {
	summary := BundleSummary{}
	for _, entry := range manifest.Entries {
		switch entry.Kind {
		case kindObject:
			summary.ObjectCount++
			summary.SourceBytes += entry.Size
		case kindPostgres, kindGlobals:
			summary.DatabaseCount++
		}
	}
	return summary
}
