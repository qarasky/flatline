package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// drainTestServer records the cpu percent of every received push, failing
// the first failFirst attempts to exercise the retry path.
func drainTestServer(t *testing.T, failFirst int) (*httptest.Server, func() []float64) {
	t.Helper()
	var mu sync.Mutex
	var received []float64
	failures := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var envelope struct {
			Metrics Payload `json:"metrics"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Errorf("undecodable push body: %v", err)
		}
		mu.Lock()
		defer mu.Unlock()
		if failures < failFirst {
			failures++
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		received = append(received, envelope.Metrics.CPU.Percent)
		w.Write([]byte(`{"ok":true}`))
	}))

	return server, func() []float64 {
		mu.Lock()
		defer mu.Unlock()
		return append([]float64(nil), received...)
	}
}

func waitForDrain(t *testing.T, buffer *sampleBuffer, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if buffer.pending() == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("buffer did not drain: %d pending", buffer.pending())
}

// rejectionServer answers the first `rejectFirst` pushes with the given
// status, then accepts everything. It records which sample indices were
// accepted and how many times a payload was offered.
func rejectionServer(t *testing.T, status int, rejectFirst int) (*httptest.Server, func() []float64, func() int) {
	t.Helper()
	var mu sync.Mutex
	var received []float64
	seen := 0
	rejections := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var envelope struct {
			Metrics Payload `json:"metrics"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Errorf("undecodable push body: %v", err)
		}
		mu.Lock()
		defer mu.Unlock()
		seen++
		if rejections < rejectFirst {
			rejections++
			w.WriteHeader(status)
			w.Write([]byte(`{"ok":false,"msg":"nope"}`))
			return
		}
		received = append(received, envelope.Metrics.CPU.Percent)
		w.Write([]byte(`{"ok":true}`))
	}))

	return server, func() []float64 {
			mu.Lock()
			defer mu.Unlock()
			return append([]float64(nil), received...)
		}, func() int {
			mu.Lock()
			defer mu.Unlock()
			return seen
		}
}

// A rejected (400) head must not block the samples behind it: the audit's
// reproduction retried the first sample forever while the second never
// reached the server.
func TestDeliverBufferedQuarantinesRejectedHead(t *testing.T) {
	server, received, _ := rejectionServer(t, http.StatusBadRequest, 1)
	defer server.Close()

	dir := filepath.Join(t.TempDir(), "buf")
	buffer, err := openSampleBuffer(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		buffer.append(testPayload(float64(i)))
	}

	cfg := &Config{ServerURL: server.URL, PushToken: "tok", AllowInsecure: true}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- deliverBuffered(ctx, buffer, newPushClient(cfg), 20*time.Millisecond) }()

	waitForDrain(t, buffer, 5*time.Second)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("deliverBuffered: %v", err)
	}

	// The poisoned sample left the queue; the two healthy ones behind it
	// were delivered in order.
	if got := received(); len(got) != 2 || got[0] != 2 || got[1] != 3 {
		t.Fatalf("received = %v, want [2 3]", got)
	}

	// The rejected payload is kept for inspection, not silently deleted.
	quarantined, err := filepath.Glob(filepath.Join(dir, "quarantine", "*.json"))
	if err != nil || len(quarantined) != 1 {
		t.Fatalf("quarantine = %v (err %v), want the one rejected sample", quarantined, err)
	}
}

// A too-large payload (413) is just as permanent as a 400.
func TestDeliverBufferedQuarantinesTooLargePayload(t *testing.T) {
	server, received, _ := rejectionServer(t, http.StatusRequestEntityTooLarge, 1)
	defer server.Close()

	buffer, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2; i++ {
		buffer.append(testPayload(float64(i)))
	}

	cfg := &Config{ServerURL: server.URL, PushToken: "tok", AllowInsecure: true}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- deliverBuffered(ctx, buffer, newPushClient(cfg), 20*time.Millisecond) }()

	waitForDrain(t, buffer, 5*time.Second)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("deliverBuffered: %v", err)
	}

	if got := received(); len(got) != 1 || got[0] != 2 {
		t.Fatalf("received = %v, want [2]", got)
	}
}

// A configuration answer (404 unknown token, here fixed after two attempts)
// must keep the backlog: the samples accumulated while the token was wrong
// are delivered once it is right, not deleted one by one.
func TestDeliverBufferedKeepsBacklogOnConfigError(t *testing.T) {
	server, received, _ := rejectionServer(t, http.StatusNotFound, 2)
	defer server.Close()

	buffer, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		buffer.append(testPayload(float64(i)))
	}

	cfg := &Config{ServerURL: server.URL, PushToken: "tok", AllowInsecure: true}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- deliverBuffered(ctx, buffer, newPushClient(cfg), 20*time.Millisecond) }()

	waitForDrain(t, buffer, 5*time.Second)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("deliverBuffered: %v", err)
	}

	if got := received(); len(got) != 3 || got[0] != 1 || got[1] != 2 || got[2] != 3 {
		t.Fatalf("received = %v, want the full backlog [1 2 3]", got)
	}
}

func TestQuarantineIsBounded(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "buf")
	buffer, err := openSampleBuffer(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < quarantineMaxFiles+5; i++ {
		buffer.append(testPayload(float64(i)))
		entry, _, ok := buffer.next()
		if !ok {
			t.Fatalf("sample %d missing from queue", i)
		}
		buffer.quarantine(entry)
	}

	files, err := filepath.Glob(filepath.Join(dir, "quarantine", "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != quarantineMaxFiles {
		t.Fatalf("quarantine holds %d files, want %d", len(files), quarantineMaxFiles)
	}
	if buffer.pending() != 0 {
		t.Fatalf("queue still holds %d entries", buffer.pending())
	}
}

func TestDeliverBufferedDrainsOldestFirst(t *testing.T) {
	server, received := drainTestServer(t, 0)
	defer server.Close()

	buffer, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		buffer.append(testPayload(float64(i)))
	}

	cfg := &Config{ServerURL: server.URL, PushToken: "tok", AllowInsecure: true}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- deliverBuffered(ctx, buffer, newPushClient(cfg), 50*time.Millisecond) }()

	waitForDrain(t, buffer, 5*time.Second)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("deliverBuffered: %v", err)
	}

	got := received()
	if len(got) != 3 || got[0] != 1 || got[1] != 2 || got[2] != 3 {
		t.Fatalf("delivery order = %v, want [1 2 3]", got)
	}
}

func TestDeliverBufferedRetriesSameSample(t *testing.T) {
	server, received := drainTestServer(t, 1)
	defer server.Close()

	buffer, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	buffer.append(testPayload(1))

	cfg := &Config{ServerURL: server.URL, PushToken: "tok", AllowInsecure: true}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- deliverBuffered(ctx, buffer, newPushClient(cfg), 20*time.Millisecond) }()

	waitForDrain(t, buffer, 5*time.Second)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("deliverBuffered: %v", err)
	}

	// The failed push was retried (same sample), not skipped: exactly one
	// delivery reached the server and the queue is empty.
	if got := received(); len(got) != 1 || got[0] != 1 {
		t.Fatalf("received = %v, want a single delivery of sample 1", got)
	}
}
