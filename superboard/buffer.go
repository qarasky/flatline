package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// sampleBuffer is a bounded, disk-backed FIFO of samples awaiting delivery.
//
// The capacity-one in-memory queue it replaces dropped every superseded
// sample: a backend restart, a network outage, or an agent restart erased the
// window. Keeping samples on disk until the server accepts them turns an
// outage into late history instead of missing history — the trade every
// serious collector makes (Prometheus agent-mode WAL, Telegraf's disk buffer,
// Alloy's retrying forwarder).
//
// Bounds are explicit: the directory is capped by bytes and the oldest
// samples are dropped first when full, so an endless outage cannot fill the
// disk. Files are written atomically (temp + rename) and carry 0600 inside a
// 0700 directory — telemetry includes hostnames and container names.
type sampleBuffer struct {
	dir      string
	maxBytes int64

	mu      sync.Mutex
	entries []bufferEntry // oldest first
	bytes   int64
	seq     uint64

	// wake is signalled (non-blocking, capacity one) whenever a sample is
	// appended, so an idle sender does not poll.
	wake chan struct{}

	// writes counts samples written to disk, so tests can prove the healthy
	// path never touches it.
	writes atomic.Uint64
}

type bufferEntry struct {
	path string
	size int64
	seq  uint64
}

// seqFromPath recovers the sequence number from a buffer file name.
func seqFromPath(path string) uint64 {
	v, _ := strconv.ParseUint(strings.TrimSuffix(filepath.Base(path), ".json"), 10, 64)
	return v
}

// openSampleBuffer prepares the directory and recovers pending samples from
// a previous run. Any failure returns an error and the caller falls back to
// the in-memory queue: buffering is an upgrade, never a requirement.
func openSampleBuffer(dir string, maxBytes int64) (*sampleBuffer, error) {
	if dir == "" {
		return nil, fmt.Errorf("empty buffer directory")
	}
	if maxBytes <= 0 {
		maxBytes = DefaultBufferMaxBytes
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create buffer dir: %w", err)
	}

	b := &sampleBuffer{dir: dir, maxBytes: maxBytes, wake: make(chan struct{}, 1)}

	names, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, fmt.Errorf("scan buffer: %w", err)
	}
	sort.Strings(names)
	for _, path := range names {
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		b.entries = append(b.entries, bufferEntry{path: path, size: info.Size(), seq: seqFromPath(path)})
		b.bytes += info.Size()
	}

	// Temp files are crash debris from a write that never completed; the
	// sample is gone either way and the file is not worth keeping.
	if tmps, err := filepath.Glob(filepath.Join(dir, "*.tmp")); err == nil {
		for _, path := range tmps {
			_ = os.Remove(path)
		}
	}

	// Continue the sequence past the highest existing name so new samples
	// always sort after recovered ones.
	if n := len(b.entries); n > 0 {
		base := strings.TrimSuffix(filepath.Base(b.entries[n-1].path), ".json")
		if v, err := strconv.ParseUint(base, 10, 64); err == nil {
			b.seq = v + 1
		}
	}

	b.enforceCapLocked()
	return b, nil
}

// reserveSeq hands out the next position in the queue. The live path
// reserves one when a sample is taken, before it knows whether the sample
// will ever touch disk, so a sample that spills late (its push failed while
// newer samples were already spilling) still sorts into its true place.
func (b *sampleBuffer) reserveSeq() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	seq := b.seq
	b.seq++
	return seq
}

// append writes one sample to disk, at its reserved position when it has
// one. A write failure is logged and counted: a full disk must degrade to
// lost samples, never to a stopped agent.
func (b *sampleBuffer) append(payload *Payload) bool {
	data, err := json.Marshal(payload)
	if err != nil {
		log.Printf("buffer: encode failed: %v", err)
		stats.recordDrop()
		return false
	}

	seq, reserved := payload.seq, payload.seqSet
	if !reserved {
		seq = b.reserveSeq()
	}
	final := filepath.Join(b.dir, fmt.Sprintf("%012d.json", seq))

	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		bufferWriteLog.fail("write", "buffer: write failed (samples dropped until it recovers): %v", err)
		_ = os.Remove(tmp)
		stats.recordDrop()
		return false
	}
	if err := os.Rename(tmp, final); err != nil {
		bufferWriteLog.fail("write", "buffer: rename failed (samples dropped until it recovers): %v", err)
		_ = os.Remove(tmp)
		stats.recordDrop()
		return false
	}
	bufferWriteLog.ok("write", "buffer: writes recovered")

	b.writes.Add(1)

	b.mu.Lock()
	entry := bufferEntry{path: final, size: int64(len(data)), seq: seq}
	// Sorted insert by sequence; almost always the tail.
	i := sort.Search(len(b.entries), func(i int) bool { return b.entries[i].seq > seq })
	b.entries = slices.Insert(b.entries, i, entry)
	b.bytes += int64(len(data))
	b.enforceCapLocked()
	b.mu.Unlock()

	select {
	case b.wake <- struct{}{}:
	default:
	}
	return true
}

// enforceCapLocked drops oldest samples until the directory fits its cap.
func (b *sampleBuffer) enforceCapLocked() {
	for b.bytes > b.maxBytes && len(b.entries) > 0 {
		oldest := b.entries[0]
		b.entries = b.entries[1:]
		b.bytes -= oldest.size
		if err := os.Remove(oldest.path); err != nil && !os.IsNotExist(err) {
			log.Printf("buffer: evict failed: %v", err)
		}
		stats.recordDrop()
	}
}

// next returns the oldest undelivered sample without removing it; the caller
// acks after a successful push. Corrupt or vanished entries are discarded
// and counted rather than wedging the queue forever.
func (b *sampleBuffer) next() (bufferEntry, *Payload, bool) {
	for {
		b.mu.Lock()
		if len(b.entries) == 0 {
			b.mu.Unlock()
			return bufferEntry{}, nil, false
		}
		entry := b.entries[0]
		b.mu.Unlock()

		data, err := os.ReadFile(entry.path)
		if err != nil {
			log.Printf("buffer: read %s failed: %v", entry.path, err)
			b.discard(entry.path)
			stats.recordDrop()
			continue
		}

		var payload Payload
		if err := json.Unmarshal(data, &payload); err != nil {
			log.Printf("buffer: corrupt entry %s dropped: %v", entry.path, err)
			b.discard(entry.path)
			stats.recordDrop()
			continue
		}
		return entry, &payload, true
	}
}

// ack removes a delivered sample from disk and from the queue.
func (b *sampleBuffer) ack(entry bufferEntry) {
	if err := os.Remove(entry.path); err != nil && !os.IsNotExist(err) {
		log.Printf("buffer: ack remove failed: %v", err)
	}
	b.discard(entry.path)
}

// quarantineMaxFiles bounds the rejected-payload directory: enough recent
// evidence to debug a broken collector, bounded so an agent with a
// permanently invalid payload cannot fill the disk with samples nobody will
// read.
const quarantineMaxFiles = 20

// quarantine moves a rejected sample out of the delivery queue and keeps it
// under <dir>/quarantine/ for inspection. A payload the server refuses
// (400/413) will fail identically on every retry, so it must leave the queue
// head instead of blocking healthy samples behind it. Removal from the queue
// always succeeds; keeping a copy is best-effort.
func (b *sampleBuffer) quarantine(entry bufferEntry) {
	dir := filepath.Join(b.dir, "quarantine")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("buffer: quarantine dir unavailable (%v); dropping %s", err, entry.path)
	} else {
		target := filepath.Join(dir, fmt.Sprintf("%d-%s", time.Now().UnixNano(), filepath.Base(entry.path)))
		if err := os.Rename(entry.path, target); err != nil {
			log.Printf("buffer: quarantine of %s failed (%v)", entry.path, err)
			_ = os.Remove(entry.path)
		} else {
			b.trimQuarantine(dir)
		}
	}
	b.discard(entry.path)
}

// quarantinePayload keeps a rejected sample that never reached the queue (a
// live sample sent from memory) as evidence, best-effort and bounded.
func (b *sampleBuffer) quarantinePayload(payload *Payload) {
	dir := filepath.Join(b.dir, "quarantine")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("buffer: quarantine dir unavailable (%v); rejected sample dropped", err)
		return
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	target := filepath.Join(dir, fmt.Sprintf("%d-live.json", time.Now().UnixNano()))
	if err := os.WriteFile(target, data, 0o600); err != nil {
		log.Printf("buffer: quarantine write failed: %v", err)
		return
	}
	b.trimQuarantine(dir)
}

// trimQuarantine keeps the newest quarantineMaxFiles rejected payloads.
func (b *sampleBuffer) trimQuarantine(dir string) {
	names, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return
	}
	sort.Strings(names)
	for len(names) > quarantineMaxFiles {
		_ = os.Remove(names[0])
		names = names[1:]
	}
}

// discard forgets an entry by path (bytes accounting included).
func (b *sampleBuffer) discard(path string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i, e := range b.entries {
		if e.path == path {
			b.entries = append(b.entries[:i], b.entries[i+1:]...)
			b.bytes -= e.size
			return
		}
	}
}

// pending reports how many samples are waiting; the sender paces its drain
// while a backlog exists.
func (b *sampleBuffer) pending() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.entries)
}

// bufferWriteLog keeps a full or read-only disk to one journal line per
// episode instead of one per sample.
var bufferWriteLog episodeLog
