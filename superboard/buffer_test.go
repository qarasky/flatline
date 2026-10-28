package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func testPayload(percent float64) *Payload {
	return &Payload{V: 1, CPU: CPU{Percent: percent}}
}

func TestBufferRoundTripPreservesOrder(t *testing.T) {
	b, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}

	for i := 1; i <= 3; i++ {
		if !b.append(testPayload(float64(i))) {
			t.Fatalf("append %d failed", i)
		}
	}
	if got := b.pending(); got != 3 {
		t.Fatalf("pending = %d, want 3", got)
	}

	for i := 1; i <= 3; i++ {
		entry, payload, ok := b.next()
		if !ok {
			t.Fatalf("next %d missing", i)
		}
		if payload.CPU.Percent != float64(i) {
			t.Fatalf("order violated: got %v at position %d", payload.CPU.Percent, i)
		}
		b.ack(entry)
	}
	if got := b.pending(); got != 0 {
		t.Fatalf("pending after ack = %d, want 0", got)
	}
	if _, _, ok := b.next(); ok {
		t.Fatal("empty buffer must report no sample")
	}
}

func sampledAt(p *Payload, at time.Time) *Payload {
	p.SampledAt = at.UTC().Format(sampleTimeFormat)
	return p
}

func TestBufferKeepsOneSamplePerArchiveInterval(t *testing.T) {
	// An outage at one sample a second queued 18,000 samples in five hours,
	// more than a drain paced by a 0.5 s round trip ever caught up with. The
	// server archives one sample per 30 s, so the queue keeps only those.
	b, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 10, 28, 6, 0, 0, 0, time.UTC)
	for i := range 95 {
		b.append(sampledAt(testPayload(float64(i)), start.Add(time.Duration(i)*time.Second)))
	}

	var kept []float64
	for {
		entry, payload, ok := b.next()
		if !ok {
			break
		}
		kept = append(kept, payload.CPU.Percent)
		b.ack(entry)
	}
	want := []float64{0, 30, 60, 90}
	if !slices.Equal(kept, want) {
		t.Fatalf("kept samples %v, want %v", kept, want)
	}
}

func TestBufferCapEvictsOldestAndCountsDrops(t *testing.T) {
	// Cap well below ten samples: eviction must drop the oldest first.
	b, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 250)
	if err != nil {
		t.Fatal(err)
	}
	before := agentInfoSnapshot().SamplesDropped

	for i := 1; i <= 10; i++ {
		b.append(testPayload(float64(i)))
	}

	if got := b.pending(); got >= 10 || got == 0 {
		t.Fatalf("pending = %d, want a bounded middle", got)
	}
	if drops := agentInfoSnapshot().SamplesDropped - before; drops == 0 {
		t.Fatal("evictions must be counted as drops")
	}
	_, payload, ok := b.next()
	if !ok {
		t.Fatal("buffer must still hold the newest samples")
	}
	if payload.CPU.Percent == 1 {
		t.Fatal("oldest sample should have been evicted, not the newest kept")
	}
}

func TestBufferRecoversAfterRestart(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "buf")
	b1, err := openSampleBuffer(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	b1.append(testPayload(1))
	b1.append(testPayload(2))
	entry, _, ok := b1.next()
	if !ok {
		t.Fatal("first next failed")
	}
	b1.ack(entry) // sample 1 delivered; sample 2 must survive a restart

	b2, err := openSampleBuffer(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if got := b2.pending(); got != 1 {
		t.Fatalf("recovered pending = %d, want 1", got)
	}
	entry2, payload, ok := b2.next()
	if !ok || payload.CPU.Percent != 2 {
		t.Fatalf("recovered sample = %+v, want 2", payload)
	}
	b2.ack(entry2)

	// The sequence continues past recovered names, so new samples sort last.
	b2.append(testPayload(3))
	_, payload, ok = b2.next()
	if !ok || payload.CPU.Percent != 3 {
		t.Fatalf("post-restart append = %+v, want 3", payload)
	}
}

func TestBufferSkipsCorruptEntries(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "buf")
	b, err := openSampleBuffer(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	b.append(testPayload(1))
	// Crash debris: a correctly named file with unparseable content.
	if err := os.WriteFile(filepath.Join(dir, "000000000001.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	reopened, err := openSampleBuffer(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	before := agentInfoSnapshot().SamplesDropped
	entry, payload, ok := reopened.next()
	if !ok || payload.CPU.Percent != 1 {
		t.Fatalf("valid entry must come first: %+v", payload)
	}
	reopened.ack(entry)

	// The corrupt entry is skipped, counted, and does not wedge the queue.
	if _, _, ok := reopened.next(); ok {
		t.Fatal("corrupt entry must not be returned")
	}
	if drops := agentInfoSnapshot().SamplesDropped - before; drops != 1 {
		t.Fatalf("corrupt drops = %d, want 1", drops)
	}
}

func TestBufferCleansTempFilesOnOpen(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "buf")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(dir, "000000000009.json.tmp")
	if err := os.WriteFile(tmp, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := openSampleBuffer(dir, 1<<20); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Fatal("stale temp file must be removed on open")
	}
}

func TestBufferOpenFailureIsAnError(t *testing.T) {
	file := filepath.Join(t.TempDir(), "plain.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A path under a regular file cannot become a directory: the caller
	// must see an error so it can fall back to the in-memory queue.
	if _, err := openSampleBuffer(filepath.Join(file, "sub"), 1<<20); err == nil {
		t.Fatal("expected an error for an unwritable buffer path")
	}
}

func TestStampSampleFormat(t *testing.T) {
	p := &Payload{}
	stampSample(p)
	if p.SampledAt == "" {
		t.Fatal("sampledAt must be stamped")
	}
	if _, err := time.Parse(time.RFC3339, p.SampledAt); err != nil {
		t.Fatalf("sampledAt %q is not RFC3339: %v", p.SampledAt, err)
	}
	if !strings.HasSuffix(p.SampledAt, "Z") {
		t.Fatalf("sampledAt %q must be UTC", p.SampledAt)
	}
}

func TestBufferConfigDefaults(t *testing.T) {
	plain := &Config{}
	if plain.bufferDir() != DefaultBufferDir {
		t.Fatalf("default dir = %q", plain.bufferDir())
	}
	if plain.bufferMaxBytes() != DefaultBufferMaxBytes {
		t.Fatalf("default cap = %d", plain.bufferMaxBytes())
	}

	custom := &Config{BufferDir: "/tmp/custom-buffer", BufferMaxBytes: 1024}
	if custom.bufferDir() != "/tmp/custom-buffer" || custom.bufferMaxBytes() != 1024 {
		t.Fatalf("custom config ignored: %q %d", custom.bufferDir(), custom.bufferMaxBytes())
	}
}
