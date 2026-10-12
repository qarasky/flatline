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
