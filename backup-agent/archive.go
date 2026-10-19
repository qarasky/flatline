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
	"hash"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"filippo.io/age"
)

// WriteBundle creates a versioned tar archive, encrypts it to the configured
// age recipient, fsyncs it and publishes it under an immutable name. The
// manifest is the last entry and records every generated path's size and
// SHA-256. On failure the partial file is removed; an existing pending
// bundle is never overwritten.
func WriteBundle(ctx context.Context, cfg Config, spool *Spool, export Export) (Bundle, error) {
	manifest := export.Manifest
	manifest.FormatVersion = manifestFormatVersion
	if manifest.AgentName == "" {
		manifest.AgentName = cfg.Name
	}
	if manifest.AgentName != cfg.Name {
		return Bundle{}, errors.New("manifest agentName must match the instance name")
	}
	if len(export.Files) == 0 {
		return Bundle{}, errors.New("export contains no files")
	}
	if len(export.Files) > maxManifestEntries {
		return Bundle{}, errors.New("export contains too many files")
	}

	paths := make(map[string]struct{}, len(export.Files))
	objects := make(map[string]struct{}, len(export.Files))
	for _, file := range export.Files {
		if !entryPathPattern.MatchString(file.Path) {
			return Bundle{}, fmt.Errorf("archive path %q is not a generated identifier", file.Path)
		}
		if _, exists := paths[file.Path]; exists {
			return Bundle{}, fmt.Errorf("duplicate archive path %q", file.Path)
		}
		paths[file.Path] = struct{}{}
		switch file.Kind {
		case kindPostgres:
			if file.Database == "" || !strings.HasPrefix(file.Path, "databases/") {
				return Bundle{}, fmt.Errorf("postgres file %q needs a database and databases/ path", file.Path)
			}
		case kindGlobals:
			if !strings.HasPrefix(file.Path, "globals/") {
				return Bundle{}, fmt.Errorf("globals file %q must use globals/ path", file.Path)
			}
		case kindObject:
			if file.Bucket == "" || file.Key == "" || !strings.HasPrefix(file.Path, "objects/") {
				return Bundle{}, fmt.Errorf("object file %q needs bucket, key and objects/ path", file.Path)
			}
			mapping := file.Bucket + "\x00" + file.Key
			if _, exists := objects[mapping]; exists {
				return Bundle{}, fmt.Errorf("duplicate object mapping %q/%q", file.Bucket, file.Key)
			}
			objects[mapping] = struct{}{}
		default:
			return Bundle{}, fmt.Errorf("file %q has unsupported kind %q", file.Path, file.Kind)
		}
		if file.SourcePath == "" {
			return Bundle{}, fmt.Errorf("file %q has no source path", file.Path)
		}
	}

	partialName := manifest.ClientRunID + ".partial.age"
	finalName := manifest.ClientRunID + ".age"
	if _, err := os.Lstat(filepath.Join(spool.Root(), finalName)); err == nil {
		return Bundle{}, errors.New("a pending bundle already exists for this run")
	} else if !errors.Is(err, fs.ErrNotExist) {
		return Bundle{}, err
	}

	spooled, err := spool.Create(partialName)
	if err != nil {
		return Bundle{}, fmt.Errorf("create bundle: %w", err)
	}
	cleanup := func() {
		_ = spooled.Close()
		_ = spool.Remove(partialName)
	}

	ciphertext := &hashCounter{writer: spooled, hash: sha256.New()}
	encrypted, err := age.Encrypt(ciphertext, cfg.recipient)
	if err != nil {
		cleanup()
		return Bundle{}, fmt.Errorf("encrypt bundle: %w", err)
	}
	archive := tar.NewWriter(encrypted)

	manifest.Entries = make([]Entry, 0, len(export.Files))
	for _, file := range export.Files {
		if err := ctx.Err(); err != nil {
			cleanup()
			return Bundle{}, err
		}
		entry, err := writeArchiveFile(archive, spool.Root(), file)
		if err != nil {
			cleanup()
			return Bundle{}, err
		}
		manifest.Entries = append(manifest.Entries, entry)
	}

	encoded, err := encodeManifest(manifest)
	if err != nil {
		cleanup()
		return Bundle{}, err
	}
	if err := writeArchiveBytes(archive, "manifest.json", encoded); err != nil {
		cleanup()
		return Bundle{}, fmt.Errorf("write manifest: %w", err)
	}

	if err := archive.Close(); err != nil {
		cleanup()
		return Bundle{}, fmt.Errorf("close archive: %w", err)
	}
	if err := encrypted.Close(); err != nil {
		cleanup()
		return Bundle{}, fmt.Errorf("close age stream: %w", err)
	}
	if err := spooled.Close(); err != nil {
		cleanup()
		return Bundle{}, fmt.Errorf("close bundle: %w", err)
	}

	if err := validateManifest(&manifest); err != nil {
		_ = spool.Remove(partialName)
		return Bundle{}, err
	}
	if err := spool.Rename(partialName, finalName); err != nil {
		_ = spool.Remove(partialName)
		return Bundle{}, fmt.Errorf("publish bundle: %w", err)
	}

	return Bundle{
		Path:             filepath.Join(spool.Root(), finalName),
		Size:             ciphertext.n,
		SHA256:           hex.EncodeToString(ciphertext.hash.Sum(nil)),
		ClientRunID:      manifest.ClientRunID,
		ExportStartedAt:  manifest.ExportStartedAt,
		ExportFinishedAt: manifest.ExportFinishedAt,
		Manifest:         manifest,
		Summary:          summarize(manifest),
	}, nil
}

func writeArchiveFile(archive *tar.Writer, spoolRoot string, file ExportFile) (Entry, error) {
	source := filepath.Clean(file.SourcePath)
	relative, err := filepath.Rel(spoolRoot, source)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return Entry{}, fmt.Errorf("source for %q is outside the spool", file.Path)
	}

	info, err := os.Lstat(source)
	if err != nil {
		return Entry{}, fmt.Errorf("stat %q: %w", file.Path, err)
	}
	if !info.Mode().IsRegular() {
		return Entry{}, fmt.Errorf("source for %q is not a regular file", file.Path)
	}

	handle, err := os.Open(source)
	if err != nil {
		return Entry{}, fmt.Errorf("open %q: %w", file.Path, err)
	}
	defer handle.Close()

	header := &tar.Header{
		Name:     file.Path,
		Mode:     0o600,
		Size:     info.Size(),
		ModTime:  time.Unix(0, 0).UTC(),
		Typeflag: tar.TypeReg,
	}
	if err := archive.WriteHeader(header); err != nil {
		return Entry{}, fmt.Errorf("write header for %q: %w", file.Path, err)
	}

	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(archive, hasher), handle)
	if err != nil {
		return Entry{}, fmt.Errorf("write %q: %w", file.Path, err)
	}
	if written != info.Size() {
		return Entry{}, fmt.Errorf("source for %q changed while archiving", file.Path)
	}

	return Entry{
		Path:        file.Path,
		Kind:        file.Kind,
		Size:        written,
		SHA256:      hex.EncodeToString(hasher.Sum(nil)),
		Bucket:      file.Bucket,
		Key:         file.Key,
		ContentType: file.ContentType,
		Database:    file.Database,
	}, nil
}

func writeArchiveBytes(archive *tar.Writer, name string, data []byte) error {
	header := &tar.Header{
		Name:     name,
		Mode:     0o600,
		Size:     int64(len(data)),
		ModTime:  time.Unix(0, 0).UTC(),
		Typeflag: tar.TypeReg,
	}
	if err := archive.WriteHeader(header); err != nil {
		return err
	}
	_, err := archive.Write(data)
	return err
}

// VerifyBundle decrypts and validates every entry without extracting it.
// It rejects authentication failures, trailing plaintext, duplicate or
// unexpected entries, unsupported versions, oversized manifests, missing
// entries, forged sizes and duplicate object mappings. It returns only the
// validated manifest; restore rereads the bundle.
func VerifyBundle(ctx context.Context, bundlePath, identityFile string) (VerifiedBundle, error) {
	info, err := os.Stat(bundlePath)
	if err != nil {
		return VerifiedBundle{}, fmt.Errorf("open bundle: %w", err)
	}
	if !info.Mode().IsRegular() {
		return VerifiedBundle{}, errors.New("bundle must be a regular file")
	}
	if info.Size() > maxBundleBytes {
		return VerifiedBundle{}, errors.New("bundle exceeds the 8 GiB limit")
	}
	if err := requireSecretFile(identityFile, "identityFile"); err != nil {
		return VerifiedBundle{}, err
	}

	identityReader, err := os.Open(identityFile)
	if err != nil {
		return VerifiedBundle{}, fmt.Errorf("open identity: %w", err)
	}
	defer identityReader.Close()
	identities, err := age.ParseIdentities(identityReader)
	if err != nil {
		return VerifiedBundle{}, fmt.Errorf("parse identity: %w", err)
	}

	bundle, err := os.Open(bundlePath)
	if err != nil {
		return VerifiedBundle{}, fmt.Errorf("open bundle: %w", err)
	}
	defer bundle.Close()

	decrypted, err := age.Decrypt(bundle, identities...)
	if err != nil {
		return VerifiedBundle{}, fmt.Errorf("decrypt bundle: %w", err)
	}

	archive := tar.NewReader(decrypted)
	seen := make(map[string]Entry)
	var manifest *Manifest

	for {
		if err := ctx.Err(); err != nil {
			return VerifiedBundle{}, err
		}
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return VerifiedBundle{}, fmt.Errorf("read archive: %w", err)
		}
		if header.Typeflag != tar.TypeReg {
			return VerifiedBundle{}, fmt.Errorf("archive entry %q is not a regular file", header.Name)
		}
		if !entryPathPattern.MatchString(header.Name) && header.Name != "manifest.json" {
			return VerifiedBundle{}, fmt.Errorf("unexpected archive entry %q", header.Name)
		}
		if header.Name == "manifest.json" {
			if manifest != nil {
				return VerifiedBundle{}, errors.New("duplicate manifest entry")
			}
			data, err := io.ReadAll(io.LimitReader(archive, maxManifestBytes+1))
			if err != nil {
				return VerifiedBundle{}, fmt.Errorf("read manifest: %w", err)
			}
			if len(data) > maxManifestBytes {
				return VerifiedBundle{}, fmt.Errorf("manifest exceeds %d bytes", maxManifestBytes)
			}
			decoder := json.NewDecoder(bytes.NewReader(data))
			decoder.DisallowUnknownFields()
			var decoded Manifest
			if err := decoder.Decode(&decoded); err != nil {
				return VerifiedBundle{}, fmt.Errorf("parse manifest: %w", err)
			}
			if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
				return VerifiedBundle{}, errors.New("parse manifest: trailing data")
			}
			manifest = &decoded
			continue
		}

		if manifest != nil {
			return VerifiedBundle{}, errors.New("manifest must be the last archive entry")
		}
		if _, exists := seen[header.Name]; exists {
			return VerifiedBundle{}, fmt.Errorf("duplicate archive entry %q", header.Name)
		}
		if len(seen) >= maxManifestEntries {
			return VerifiedBundle{}, fmt.Errorf("archive has more than %d entries", maxManifestEntries)
		}

		hasher := sha256.New()
		written, err := io.Copy(hasher, archive)
		if err != nil {
			return VerifiedBundle{}, fmt.Errorf("read %q: %w", header.Name, err)
		}
		if written != header.Size {
			return VerifiedBundle{}, fmt.Errorf("entry %q length does not match its header", header.Name)
		}
		seen[header.Name] = Entry{
			Path:   header.Name,
			Size:   written,
			SHA256: hex.EncodeToString(hasher.Sum(nil)),
		}
	}

	if manifest == nil {
		return VerifiedBundle{}, errors.New("archive has no manifest")
	}

	// Read through the age stream to its authenticated end. Anything left
	// after the tar end markers is unexpected plaintext.
	buffer := make([]byte, 1)
	for {
		read, err := decrypted.Read(buffer)
		if read > 0 {
			return VerifiedBundle{}, errors.New("archive has trailing plaintext")
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return VerifiedBundle{}, fmt.Errorf("verify age stream: %w", err)
		}
	}

	if err := validateManifest(manifest); err != nil {
		return VerifiedBundle{}, err
	}
	if len(manifest.Entries) != len(seen) {
		return VerifiedBundle{}, errors.New("manifest entry count does not match the archive")
	}
	for _, expected := range manifest.Entries {
		actual, exists := seen[expected.Path]
		if !exists {
			return VerifiedBundle{}, fmt.Errorf("manifest lists missing entry %q", expected.Path)
		}
		if actual.Size != expected.Size || actual.SHA256 != expected.SHA256 {
			return VerifiedBundle{}, fmt.Errorf("entry %q does not match the manifest hash or size", expected.Path)
		}
	}

	return VerifiedBundle{Manifest: *manifest}, nil
}

type hashCounter struct {
	writer io.Writer
	hash   hash.Hash
	n      int64
}

func (c *hashCounter) Write(data []byte) (int, error) {
	written, err := c.writer.Write(data)
	c.n += int64(written)
	if written > 0 {
		_, _ = c.hash.Write(data[:written])
	}
	return written, err
}
