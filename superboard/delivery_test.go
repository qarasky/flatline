package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakePusher records every attempt and answers with fn.
type fakePusher struct {
	mu       sync.Mutex
	got      []float64
	timeouts []time.Duration
	fn       func(attempt int, p *Payload) error
}

func (f *fakePusher) pushWithTimeout(p *Payload, timeout time.Duration) error {
	f.mu.Lock()
	attempt := len(f.timeouts)
	f.timeouts = append(f.timeouts, timeout)
	fn := f.fn
	f.mu.Unlock()
	var err error
	if fn != nil {
		err = fn(attempt, p)
	}
	if err == nil {
		f.mu.Lock()
		f.got = append(f.got, p.CPU.Percent)
		f.mu.Unlock()
	}
	return err
}

func (f *fakePusher) delivered() []float64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]float64(nil), f.got...)
}

func (f *fakePusher) attempts() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.timeouts)
}

func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func withJitter(t *testing.T, fn func(n int64) int64) {
	t.Helper()
	old := jitterSource
	jitterSource = fn
	t.Cleanup(func() { jitterSource = old })
}

func equalFloats(a, b []float64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestBackoffFullJitterBounds(t *testing.T) {
	base := time.Second
	b := newBackoff(base)
	for attempt := 0; attempt < 12; attempt++ {
		ceiling := min(backoffMax, base<<attempt)
		if got := b.ceiling(); got != ceiling {
			t.Fatalf("attempt %d ceiling = %s, want %s", attempt, got, ceiling)
		}
		for i := 0; i < 200; i++ {
			probe := *b
			wait := probe.next(0)
			if wait < backoffFloor || wait > ceiling {
				t.Fatalf("attempt %d wait %s outside [%s, %s]", attempt, wait, backoffFloor, ceiling)
			}
		}
		b.next(0)
	}
	b.reset()
	if b.ceiling() != base {
		t.Fatal("reset must return to the base ceiling")
	}

	// The extremes of the random source map to the extremes of the range:
	// the draw really is full jitter, not "wait plus a little".
	withJitter(t, func(n int64) int64 { return 0 })
	if got := newBackoff(8 * time.Second).next(0); got != backoffFloor {
		t.Fatalf("minimum draw = %s, want the floor %s", got, backoffFloor)
	}
	withJitter(t, func(n int64) int64 { return n - 1 })
	if got := newBackoff(8 * time.Second).next(0); got != 8*time.Second {
		t.Fatalf("maximum draw = %s, want 8s", got)
	}
}

func TestBackoffHonoursRetryAfter(t *testing.T) {
	for i := 0; i < 200; i++ {
		wait := newBackoff(time.Second).next(20 * time.Second)
		if wait < 20*time.Second || wait > 30*time.Second {
			t.Fatalf("Retry-After 20s gave %s, want [20s, 30s]", wait)
		}
	}
	// An absurd Retry-After is capped.
	wait := newBackoff(time.Second).next(24 * time.Hour)
	if wait < retryAfterMax || wait > retryAfterMax+retryAfterMax/2 {
		t.Fatalf("capped Retry-After gave %s", wait)
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	h := func(kv ...string) http.Header {
		out := http.Header{}
		for i := 0; i < len(kv); i += 2 {
			out.Set(kv[i], kv[i+1])
		}
		return out
	}
	cases := []struct {
		name string
		h    http.Header
		want time.Duration
	}{
		{"absent", h(), 0},
		{"seconds", h("Retry-After", "7"), 7 * time.Second},
		{"zero", h("Retry-After", "0"), 0},
		{"negative", h("Retry-After", "-3"), 0},
		{"huge", h("Retry-After", "999999"), retryAfterMax},
		{"garbage", h("Retry-After", "soon"), 0},
		{"date vs server Date", h("Retry-After", "Tue, 20 Oct 2026 12:00:30 GMT", "Date", "Tue, 20 Oct 2026 12:00:10 GMT"), 20 * time.Second},
		{"date vs local clock", h("Retry-After", "Tue, 20 Oct 2026 12:00:45 GMT"), 45 * time.Second},
		{"date in the past", h("Retry-After", "Tue, 20 Oct 2026 11:00:00 GMT"), 0},
	}
	for _, c := range cases {
		if got := parseRetryAfter(c.h, now); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

func TestPushClassifiesStatuses(t *testing.T) {
	status := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if status == http.StatusServiceUnavailable || status == http.StatusTooManyRequests {
			w.Header().Set("Retry-After", "7")
		}
		w.WriteHeader(status)
	}))
	defer server.Close()
	client := newPushClient(&Config{ServerURL: server.URL, PushToken: "t", AllowInsecure: true})

	for _, s := range []int{http.StatusServiceUnavailable, http.StatusTooManyRequests} {
		status = s
		var retry *pushRetryError
		if err := client.push(&Payload{}); !errors.As(err, &retry) || retry.retryAfter != 7*time.Second {
			t.Fatalf("%d: got %v, want retryable with Retry-After 7s", s, err)
		}
	}
	status = http.StatusInternalServerError
	var retry *pushRetryError
	if err := client.push(&Payload{}); !errors.As(err, &retry) || retry.retryAfter != 0 {
		t.Fatalf("500: got %v, want retryable without Retry-After", err)
	}
	status = http.StatusBadRequest
	var rejected *pushRejectedError
	if err := client.push(&Payload{}); !errors.As(err, &rejected) {
		t.Fatalf("400: got %v, want permanent rejection", err)
	}
	status = http.StatusNotFound
	var configErr *pushConfigError
	if err := client.push(&Payload{}); !errors.As(err, &configErr) {
		t.Fatalf("404: got %v, want a configuration error", err)
	}
}

// 503 (storage failure) keeps the sample and waits as asked; it must never
// reach the quarantine.
func TestDeliveryRetries503HonouringRetryAfter(t *testing.T) {
	var mu sync.Mutex
	var times []time.Time
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		times = append(times, time.Now())
		first := len(times) == 1
		mu.Unlock()
		if first {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	dir := filepath.Join(t.TempDir(), "buf")
	buffer, err := openSampleBuffer(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	buffer.append(testPayload(1))

	cfg := &Config{ServerURL: server.URL, PushToken: "tok", AllowInsecure: true}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- testDeliver(ctx, buffer, newPushClient(cfg), 10*time.Millisecond) }()
	waitForDrain(t, buffer, 5*time.Second)
	cancel()
	<-done

	mu.Lock()
	defer mu.Unlock()
	if len(times) != 2 {
		t.Fatalf("attempts = %d, want 2", len(times))
	}
	if gap := times[1].Sub(times[0]); gap < time.Second {
		t.Fatalf("retried after %s, before the server's Retry-After of 1s", gap)
	}
	if q, _ := filepath.Glob(filepath.Join(dir, "quarantine", "*.json")); len(q) != 0 {
		t.Fatalf("a 503 must never quarantine: %v", q)
	}
}

// Past the per-minute cap, 400s stop discarding: the rest stays buffered.
func TestDeliveryQuarantineCapKeepsTheBacklog(t *testing.T) {
	fake := &fakePusher{fn: func(int, *Payload) error { return &pushRejectedError{msg: "400"} }}
	dir := filepath.Join(t.TempDir(), "buf")
	buffer, err := openSampleBuffer(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 6; i++ {
		buffer.append(testPayload(float64(i)))
	}
	d := newTestDelivery(fake, buffer, 10*time.Millisecond)
	d.quarantine = newQuarantineLimiter(3, time.Minute)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- d.run(ctx) }()
	waitFor(t, 5*time.Second, "four attempts", func() bool { return fake.attempts() >= 4 })
	cancel()
	<-done

	q, _ := filepath.Glob(filepath.Join(dir, "quarantine", "*.json"))
	if len(q) != 3 {
		t.Fatalf("quarantined %d, want exactly the cap of 3", len(q))
	}
	if buffer.pending() != 3 {
		t.Fatalf("pending = %d, want the 3 samples past the cap kept", buffer.pending())
	}
}

func TestQuarantineLimiterWindow(t *testing.T) {
	q := newQuarantineLimiter(2, time.Minute)
	now := time.Now()
	if !q.allow(now) || !q.allow(now) {
		t.Fatal("the first two must pass")
	}
	if q.allow(now) {
		t.Fatal("the third within the window must be refused")
	}
	if wait := q.retryIn(now); wait != time.Minute {
		t.Fatalf("retryIn = %s, want 1m", wait)
	}
	if !q.allow(now.Add(61 * time.Second)) {
		t.Fatal("the window must reopen")
	}
}

// Healthy delivery never touches the disk.
func TestDeliveryHealthyPathStaysInMemory(t *testing.T) {
	fake := &fakePusher{}
	buffer, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	d := newTestDelivery(fake, buffer, 10*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- d.run(ctx) }()
	for i := 1; i <= 5; i++ {
		d.offer(testPayload(float64(i)))
		waitFor(t, 2*time.Second, "delivery", func() bool { return len(fake.delivered()) == i })
	}
	cancel()
	<-done

	if got := fake.delivered(); !equalFloats(got, []float64{1, 2, 3, 4, 5}) {
		t.Fatalf("delivered %v", got)
	}
	if w := buffer.writes.Load(); w != 0 {
		t.Fatalf("healthy delivery wrote %d samples to disk, want 0", w)
	}
	for _, timeout := range fake.timeouts {
		if timeout != d.liveTimeout {
			t.Fatalf("live push used timeout %s, want %s", timeout, d.liveTimeout)
		}
	}
}

// A failed live push spills to disk; newer samples queue behind it; nothing
// is lost and order holds once the server is back.
func TestDeliverySpillsOnFailureAndKeepsOrder(t *testing.T) {
	var fail sync.Mutex
	failing := true
	fake := &fakePusher{fn: func(int, *Payload) error {
		fail.Lock()
		defer fail.Unlock()
		if failing {
			return &pushRetryError{status: 503, msg: "503"}
		}
		return nil
	}}
	buffer, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	d := newTestDelivery(fake, buffer, 10*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- d.run(ctx) }()

	d.offer(testPayload(1))
	waitFor(t, 2*time.Second, "the failed push to spill", func() bool { return buffer.pending() == 1 })
	for i := 2; i <= 5; i++ {
		d.offer(testPayload(float64(i)))
	}
	if buffer.pending() != 5 {
		t.Fatalf("pending = %d, want every sample on disk behind the backlog", buffer.pending())
	}
	fail.Lock()
	failing = false
	fail.Unlock()
	waitFor(t, 5*time.Second, "the backlog to drain", func() bool { return len(fake.delivered()) == 5 })
	cancel()
	<-done

	if got := fake.delivered(); !equalFloats(got, []float64{1, 2, 3, 4, 5}) {
		t.Fatalf("delivered %v, want [1 2 3 4 5]", got)
	}
	fake.mu.Lock()
	last := fake.timeouts[len(fake.timeouts)-1]
	fake.mu.Unlock()
	if last != d.drainTimeout || d.drainTimeout <= d.liveTimeout {
		t.Fatalf("drain push timeout = %s (live %s), want the longer drain timeout", last, d.liveTimeout)
	}
}

// During an outage the queue holds one sample per archive interval, the
// backlog drains thinned, and live delivery resumes after it.
func TestDeliveryThinsTheOutageBacklog(t *testing.T) {
	var fail sync.Mutex
	failing := true
	fake := &fakePusher{fn: func(int, *Payload) error {
		fail.Lock()
		defer fail.Unlock()
		if failing {
			return &pushRetryError{status: 530, msg: "530"}
		}
		return nil
	}}
	buffer, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	d := newTestDelivery(fake, buffer, 10*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- d.run(ctx) }()

	start := time.Date(2026, 10, 28, 4, 0, 0, 0, time.UTC)
	at := func(second int) *Payload {
		return sampledAt(testPayload(float64(second)), start.Add(time.Duration(second)*time.Second))
	}
	d.offer(at(0))
	waitFor(t, 2*time.Second, "the failed push to spill", func() bool { return buffer.pending() == 1 })
	for second := 1; second < 90; second++ {
		d.offer(at(second))
	}
	if got := buffer.pending(); got != 3 {
		t.Fatalf("pending = %d after 90 s of outage, want 3 (one per 30 s)", got)
	}

	fail.Lock()
	failing = false
	fail.Unlock()
	waitForDrain(t, buffer, 5*time.Second)
	d.offer(at(95))
	waitFor(t, 2*time.Second, "live delivery after the drain", func() bool { return len(fake.delivered()) == 4 })
	cancel()
	<-done

	if got := fake.delivered(); !equalFloats(got, []float64{0, 30, 60, 95}) {
		t.Fatalf("delivered %v, want [0 30 60 95]", got)
	}
}

// Shutdown spills whatever is still in memory; the next run recovers it.
func TestDeliveryShutdownSpillsMemory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "buf")
	buffer, err := openSampleBuffer(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	d := newTestDelivery(&fakePusher{}, buffer, time.Second)
	for i := 1; i <= 3; i++ {
		d.offer(testPayload(float64(i)))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := d.run(ctx); err != nil {
		t.Fatal(err)
	}

	again, err := openSampleBuffer(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		entry, p, ok := again.next()
		if !ok || p.CPU.Percent != float64(i) {
			t.Fatalf("recovered sample %d = %+v (ok %v)", i, p, ok)
		}
		again.ack(entry)
	}
}

// A sample that spills late sorts by when it was taken, not when it spilled.
func TestBufferLateSpillKeepsSampleOrder(t *testing.T) {
	buffer, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	older, newer := testPayload(1), testPayload(2)
	older.seq, older.seqSet = buffer.reserveSeq(), true
	newer.seq, newer.seqSet = buffer.reserveSeq(), true
	buffer.append(newer)
	buffer.append(older)
	for _, want := range []float64{1, 2} {
		entry, p, ok := buffer.next()
		if !ok || p.CPU.Percent != want {
			t.Fatalf("next = %+v, want %v", p, want)
		}
		buffer.ack(entry)
	}
}

// The first push after an outage is a probe; the bulk of the drain waits a
// random delay, then paces itself.
func TestDeliveryDelaysDrainStart(t *testing.T) {
	withJitter(t, func(n int64) int64 { return n - 1 }) // the maximum delay
	var mu sync.Mutex
	var at []time.Time
	fake := &fakePusher{fn: func(int, *Payload) error {
		mu.Lock()
		at = append(at, time.Now())
		mu.Unlock()
		return nil
	}}
	buffer, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		buffer.append(testPayload(float64(i)))
	}
	d := newTestDelivery(fake, buffer, 10*time.Millisecond)
	d.drainJitter = 300 * time.Millisecond
	d.drainGap = 50 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- d.run(ctx) }()
	waitForDrain(t, buffer, 5*time.Second)
	cancel()
	<-done

	mu.Lock()
	defer mu.Unlock()
	if gap := at[1].Sub(at[0]); gap < 300*time.Millisecond {
		t.Fatalf("drain started %s after the probe, want the 300ms jitter", gap)
	}
	if gap := at[2].Sub(at[1]); gap < 50*time.Millisecond {
		t.Fatalf("drain gap %s, want at least 50ms", gap)
	}
}

// A panicking push costs a retry, not the process; the sample survives.
func TestDeliveryRecoversPushPanic(t *testing.T) {
	fake := &fakePusher{fn: func(attempt int, _ *Payload) error {
		if attempt == 0 {
			panic("boom")
		}
		return nil
	}}
	buffer, err := openSampleBuffer(filepath.Join(t.TempDir(), "buf"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	before := stats.pushErrors.Load()
	d := newTestDelivery(fake, buffer, 10*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- d.run(ctx) }()
	d.offer(testPayload(7))
	waitFor(t, 3*time.Second, "redelivery after the panic", func() bool { return len(fake.delivered()) == 1 })
	cancel()
	<-done
	if got := fake.delivered(); got[0] != 7 {
		t.Fatalf("delivered %v", got)
	}
	if stats.pushErrors.Load() != before+1 {
		t.Fatal("the push panic must be counted as a collector error")
	}
}

// A panicking sample costs one tick; the sampler keeps going.
func TestSamplerSurvivesPanics(t *testing.T) {
	var mu sync.Mutex
	calls, offered := 0, 0
	sample := func() (*Payload, error) {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		if n == 1 {
			panic("collector bug")
		}
		return testPayload(float64(n)), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		runSampler(ctx, 5*time.Millisecond, sample, func(*Payload) {
			mu.Lock()
			offered++
			mu.Unlock()
		})
		close(done)
	}()
	waitFor(t, 2*time.Second, "samples after the panic", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return offered >= 2
	})
	cancel()
	<-done
	if stats.sampleErrors.Load() == 0 {
		t.Fatal("the sample panic must be counted")
	}
}

func TestClockSkewFromDateHeader(t *testing.T) {
	var c clockSkew
	sent := time.Date(2026, 10, 20, 12, 1, 0, 0, time.UTC)
	received := sent.Add(200 * time.Millisecond)

	c.observe("Tue, 20 Oct 2026 12:00:00 GMT", sent, received)
	if got := c.reportSeconds(); got != 60 {
		t.Fatalf("skew = %d, want 60 (local ahead)", got)
	}
	if !c.warned {
		t.Fatal("a 60s skew must start a logged episode")
	}
	c.observe("Tue, 20 Oct 2026 12:01:01 GMT", sent, received)
	if got := c.reportSeconds(); got != 0 {
		t.Fatalf("1s skew is noise; reported %d", got)
	}
	if c.warned {
		t.Fatal("the episode must end once the clocks agree")
	}
	c.observe("garbage", sent, received)
	c.observe("Tue, 20 Oct 2026 12:02:00 GMT", sent, received)
	if got := c.reportSeconds(); got != -60 {
		t.Fatalf("skew = %d, want -60 (local behind)", got)
	}
}

func TestAgentInfoReportsClockSkew(t *testing.T) {
	old := clock.seconds.Load()
	defer clock.seconds.Store(old)
	clock.seconds.Store(-45)
	if got := agentInfoSnapshot().ClockSkewSeconds; got != -45 {
		t.Fatalf("clockSkewSeconds = %d, want -45", got)
	}
	clock.seconds.Store(1)
	if got := agentInfoSnapshot().ClockSkewSeconds; got != 0 {
		t.Fatalf("noise-level skew must be omitted, got %d", got)
	}
}
