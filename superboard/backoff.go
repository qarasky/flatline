package main

import (
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Retry pacing for push failures.
//
// The old loop doubled a fixed wait (1s, 2s, 4s ... 30s) with no jitter, so
// every agent that lost the backend at the same moment retried at the same
// moments, and the whole fleet hit a recovering server in synchronized
// waves. Full jitter (AWS Architecture Blog, "Exponential Backoff And
// Jitter") spreads each retry uniformly over [0, ceiling]: the ceiling still
// grows exponentially, the fleet does not.

const (
	// backoffFloor keeps a full-jitter draw of ~0 from becoming a busy loop.
	backoffFloor = 100 * time.Millisecond
	// backoffMax caps the exponential ceiling.
	backoffMax = 60 * time.Second
	// retryAfterMax caps a server-supplied Retry-After: a misconfigured or
	// hostile answer must not park the agent for hours. Samples keep
	// buffering meanwhile, so waiting is cheap, but not unbounded.
	retryAfterMax = 5 * time.Minute
)

// jitterSource is the randomness behind every jittered wait; tests swap it.
var jitterSource = func(n int64) int64 { return rand.Int64N(n) }

// randomDuration returns a uniform duration in [0, d].
func randomDuration(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	return time.Duration(jitterSource(int64(d) + 1))
}

// backoff is a full-jitter exponential backoff. Not safe for concurrent use;
// each delivery loop owns one.
type backoff struct {
	base    time.Duration
	max     time.Duration
	attempt int
}

func newBackoff(base time.Duration) *backoff {
	if base <= 0 {
		base = time.Second
	}
	return &backoff{base: base, max: backoffMax}
}

// ceiling is the upper bound of the next draw: base·2^attempt, capped.
func (b *backoff) ceiling() time.Duration {
	c := b.base
	for i := 0; i < b.attempt && c < b.max; i++ {
		c *= 2
	}
	return min(c, b.max)
}

// next returns the wait before the following attempt and advances the
// exponent. A server-supplied Retry-After is honoured as a lower bound
// (capped at retryAfterMax) and spread by up to +50%, so a fleet told
// "come back in 30s" does not come back in the same second.
func (b *backoff) next(retryAfter time.Duration) time.Duration {
	wait := max(backoffFloor, randomDuration(b.ceiling()))
	if b.attempt < 32 {
		b.attempt++
	}
	if retryAfter > 0 {
		ra := min(retryAfter, retryAfterMax)
		wait = max(wait, ra+randomDuration(ra/2))
	}
	return wait
}

// reset returns to the base ceiling after a success.
func (b *backoff) reset() { b.attempt = 0 }

// parseRetryAfter reads a Retry-After header: delta-seconds or an HTTP-date
// (RFC 9110 §10.2.3). Dates are resolved against the response's own Date
// header when present, so agent clock skew does not distort the wait.
// Returns 0 when absent or unparseable.
func parseRetryAfter(h http.Header, now time.Time) time.Duration {
	value := strings.TrimSpace(h.Get("Retry-After"))
	if value == "" {
		return 0
	}
	if secs, err := strconv.ParseInt(value, 10, 64); err == nil {
		if secs <= 0 {
			return 0
		}
		if secs > int64(retryAfterMax/time.Second) {
			return retryAfterMax
		}
		return time.Duration(secs) * time.Second
	}
	at, err := http.ParseTime(value)
	if err != nil {
		return 0
	}
	ref := now
	if date, err := http.ParseTime(h.Get("Date")); err == nil {
		ref = date
	}
	if d := at.Sub(ref); d > 0 {
		return min(d, retryAfterMax)
	}
	return 0
}

// quarantineLimiter caps how many samples may be quarantined per window.
//
// A 400 means "this payload can never be accepted", and the agent believes
// it. But a backend bug that answers 400 for a storage failure (audit S1)
// would turn that belief into deleting the entire backlog at drain speed.
// The cap is the safety valve: past it, rejected samples stay buffered and
// the agent backs off instead of discarding.
type quarantineLimiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	times  []time.Time
}

func newQuarantineLimiter(max int, window time.Duration) *quarantineLimiter {
	return &quarantineLimiter{max: max, window: window}
}

// allow records one quarantine at now if the window has room.
func (q *quarantineLimiter) allow(now time.Time) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	cutoff := now.Add(-q.window)
	kept := q.times[:0]
	for _, t := range q.times {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	q.times = kept
	if len(q.times) >= q.max {
		return false
	}
	q.times = append(q.times, now)
	return true
}

// retryIn reports how long until the window frees a slot.
func (q *quarantineLimiter) retryIn(now time.Time) time.Duration {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.times) < q.max || len(q.times) == 0 {
		return 0
	}
	return max(0, q.times[0].Add(q.window).Sub(now))
}
