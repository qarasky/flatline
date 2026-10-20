package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ErrSpoolLimit is returned before a write would exceed the instance cap.
var ErrSpoolLimit = errors.New("spool limit exceeded")

// Spool is a byte-capped directory. Every regular file under it counts,
// including intermediate export files and the pending encrypted bundle, so a
// run can never exceed the cap by keeping several files at once.
type Spool struct {
	root string
	max  int64

	mu   sync.Mutex
	used int64
}

// NewSpool opens an existing-or-new spool directory and counts its current
// contents. A missing directory is created with mode 0700.
func NewSpool(root string, maxBytes int64) (*Spool, error) {
	if maxBytes <= 0 {
		return nil, errors.New("spool cap must be positive")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create spool: %w", err)
	}

	spool := &Spool{root: root, max: maxBytes}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("spool contains a non-regular entry %q", path)
		}
		spool.used += info.Size()
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("scan spool: %w", err)
	}
	if spool.used > maxBytes {
		return nil, fmt.Errorf("spool already uses %d bytes, above the %d cap", spool.used, maxBytes)
	}
	return spool, nil
}

func (s *Spool) Root() string { return s.root }

// Used reports the currently retained bytes.
func (s *Spool) Used() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.used
}

// Create starts a new owner-only file. Existing names are refused so a
// caller can never truncate an unrelated retained file.
func (s *Spool) Create(name string) (io.WriteCloser, error) {
	if err := validateSpoolName(name); err != nil {
		return nil, err
	}
	path := filepath.Join(s.root, name)

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := os.Lstat(path); err == nil {
		return nil, fmt.Errorf("spool file %q already exists", name)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	return &spoolWriter{spool: s, file: file, path: path}, nil
}

// Remove deletes a file and releases its bytes. Missing files are ignored.
func (s *Spool) Remove(name string) error {
	if err := validateSpoolName(name); err != nil {
		return err
	}
	path := filepath.Join(s.root, name)

	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("refusing to remove non-regular spool entry %q", name)
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	s.used -= info.Size()
	if s.used < 0 {
		s.used = 0
	}
	return nil
}

// Rename changes a spool file's name without changing its counted bytes.
// Quarantine moves the whole spool aside and starts an empty one. Used only
// for a corrupt or terminal pending bundle; bytes are preserved under the
// state directory for operator inspection.
func (s *Spool) Quarantine(destination string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	if err := os.Rename(s.root, destination); err != nil {
		return err
	}
	if err := os.MkdirAll(s.root, 0o700); err != nil {
		return err
	}
	s.used = 0
	return nil
}

func (s *Spool) Rename(oldName, newName string) error {
	if err := validateSpoolName(oldName); err != nil {
		return err
	}
	if err := validateSpoolName(newName); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	oldPath := filepath.Join(s.root, oldName)
	newPath := filepath.Join(s.root, newName)
	if err := os.Rename(oldPath, newPath); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(newPath))
	if err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func validateSpoolName(name string) error {
	if name == "" || strings.Contains(name, `\`) || filepath.IsAbs(name) {
		return fmt.Errorf("invalid spool file name %q", name)
	}
	cleaned := filepath.Clean(name)
	if cleaned != name || cleaned == "." || cleaned == ".." ||
		strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return fmt.Errorf("invalid spool file name %q", name)
	}
	for _, part := range strings.Split(cleaned, string(filepath.Separator)) {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("invalid spool file name %q", name)
		}
	}
	return nil
}

type spoolWriter struct {
	spool *Spool
	file  *os.File
	path  string

	written int64
	closed  bool
	failed  bool
}

func (w *spoolWriter) Write(data []byte) (int, error) {
	w.spool.mu.Lock()
	defer w.spool.mu.Unlock()

	if w.closed {
		return 0, fs.ErrClosed
	}
	if w.failed {
		return 0, ErrSpoolLimit
	}
	if w.spool.used+int64(len(data)) > w.spool.max {
		w.failed = true
		return 0, ErrSpoolLimit
	}

	written, err := w.file.Write(data)
	w.spool.used += int64(written)
	w.written += int64(written)
	if err != nil {
		w.failed = true
	}
	return written, err
}

func (w *spoolWriter) Close() error {
	w.spool.mu.Lock()
	defer w.spool.mu.Unlock()

	if w.closed {
		return nil
	}
	w.closed = true

	syncErr := w.file.Sync()
	closeErr := w.file.Close()
	if w.failed || syncErr != nil || closeErr != nil {
		w.spool.used -= w.written
		if w.spool.used < 0 {
			w.spool.used = 0
		}
		_ = os.Remove(w.path)
		if syncErr != nil {
			return syncErr
		}
		if closeErr != nil {
			return closeErr
		}
		return ErrSpoolLimit
	}
	return nil
}
