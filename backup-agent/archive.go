package main

import (
	"archive/tar"
	"bufio"
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

// ageMagic opens every binary age v1 file. A plain bundle starts with a tar
// header whose name is a generated identifier, so the two never collide.
const ageMagic = "age-encryption.org/v1\n"

// bundleExtension names a bundle by its format: ".age" when encrypted,
// ".tar" when plain.
func bundleExtension(encrypted bool) string {
	if encrypted {
		return ".age"
	}
	return ".tar"
}

// WriteBundle creates a versioned tar archive, encrypts it to the configured
// age recipient when there is one, fsyncs it and publishes it under an
// immutable name. The manifest is the last entry and records every generated
// path's size and SHA-256. On failure the partial file is removed; an
// existing pending bundle is never overwritten.
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

	extension := bundleExtension(cfg.Encrypted())
	partialName := manifest.ClientRunID + ".partial" + extension
	finalName := manifest.ClientRunID + extension
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

	// output hashes exactly the bytes that are stored and uploaded.
	output := &hashCounter{writer: spooled, hash: sha256.New()}
	var payload io.WriteCloser = nopWriteCloser{output}
	if cfg.Encrypted() {
		encrypted, err := age.Encrypt(output, cfg.recipient)
		if err != nil {
			cleanup()
			return Bundle{}, fmt.Errorf("encrypt bundle: %w", err)
		}
		payload = encrypted
	}
	archive := tar.NewWriter(payload)

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
	if err := payload.Close(); err != nil {
		cleanup()
		return Bundle{}, fmt.Errorf("close bundle stream: %w", err)
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
		Size:             output.n,
		SHA256:           hex.EncodeToString(output.hash.Sum(nil)),
		ClientRunID:      manifest.ClientRunID,
		ExportStartedAt:  manifest.ExportStartedAt,
		ExportFinishedAt: manifest.ExportFinishedAt,
		Manifest:         manifest,
		Summary:          summarize(manifest, cfg.Encrypted()),
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

// VerifyBundle validates every entry without extracting it, decrypting first
// when the bundle is age-encrypted (identityFile is required then and
// ignored for a plain bundle). It rejects authentication failures, trailing
// data, duplicate or unexpected entries, unsupported versions, oversized
// manifests, missing entries, forged sizes and duplicate object mappings.
// A plain bundle has no authenticated stream: its integrity rests on the
// per-entry SHA-256 in the manifest, the manifest-last rule and the
// receiver's whole-bundle hash. It returns only the validated manifest;
// restore rereads the bundle.
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
	decrypted, closer, err := openPayload(bundlePath, identityFile)
	if err != nil {
		return VerifiedBundle{}, err
	}
	defer closer.Close()

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

	if err := requireCleanEnd(decrypted); err != nil {
		return VerifiedBundle{}, err
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

// openPayload opens a bundle and returns its tar stream: decrypted when the
// file is age-encrypted, the file itself when it is plain. An encrypted
// bundle without an identity is an error that says so; a plain bundle
// ignores identityFile. The caller closes the returned closer.
func openPayload(bundlePath, identityFile string) (io.Reader, io.Closer, error) {
	bundle, err := os.Open(bundlePath)
	if err != nil {
		return nil, nil, fmt.Errorf("open bundle: %w", err)
	}
	reader := bufio.NewReader(bundle)
	head, err := reader.Peek(len(ageMagic))
	if err != nil && !errors.Is(err, io.EOF) {
		_ = bundle.Close()
		return nil, nil, fmt.Errorf("read bundle: %w", err)
	}
	if string(head) != ageMagic {
		return reader, bundle, nil
	}

	if identityFile == "" {
		_ = bundle.Close()
		return nil, nil, errors.New("bundle is age-encrypted: pass --identity-file")
	}
	if err := requireSecretFile(identityFile, "identityFile"); err != nil {
		_ = bundle.Close()
		return nil, nil, err
	}
	identities, err := readIdentities(identityFile)
	if err != nil {
		_ = bundle.Close()
		return nil, nil, fmt.Errorf("parse identity: %w", err)
	}
	decrypted, err := age.Decrypt(reader, identities...)
	if err != nil {
		_ = bundle.Close()
		return nil, nil, fmt.Errorf("decrypt bundle: %w", err)
	}
	return decrypted, bundle, nil
}

// requireCleanEnd reads the payload past the tar end markers. For an
// encrypted bundle this reaches the authenticated end of the age stream;
// for either format, any byte left over is unexpected trailing data.
func requireCleanEnd(payload io.Reader) error {
	buffer := make([]byte, 1)
	for {
		read, err := payload.Read(buffer)
		if read > 0 {
			return errors.New("archive has trailing data")
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("verify bundle stream: %w", err)
		}
	}
}

// isEncryptedBundle reports whether the file at path is age-encrypted.
func isEncryptedBundle(path string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	head := make([]byte, len(ageMagic))
	read, err := io.ReadFull(file, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return false, err
	}
	return string(head[:read]) == ageMagic, nil
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }

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
