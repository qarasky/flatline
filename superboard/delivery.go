package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
)

// Delivery: live samples go out from memory; the disk buffer is the spill
// path, used only when a push fails or while a backlog exists.
//
// The previous design wrote every sample to disk, renamed it, read it back,
// pushed it and unlinked it — about 86,000 write/rename/unlink cycles a day
// per host while everything was healthy (SD-card wear on small boards), plus
// a second JSON encode per sample. The no-loss guarantees are kept:
//
//   - a sample whose push fails for any retryable reason is written to the
//     buffer before anything else happens, and retried from there;
//   - while a backlog exists every new sample goes straight to disk, behind
//     it, so delivery stays strictly oldest-first;
//   - on shutdown (systemctl restart/stop, SIGTERM) samples still in memory
//     are spilled, and the next run recovers them;
//   - each sample reserves its queue position when it is taken, so one that
//     spills late (its push failed while newer ones were already spilling)
//     still sorts into its true place.
//
// What memory-first does not cover is a hard kill (SIGKILL, power loss) in
// the window between taking a sample and its push completing — at most the
// one or two samples in flight. The old path had the equivalent window: its
// writes were never fsynced, so a power loss lost the newest files too.

const (
	// liveQueueCap bounds the in-memory queue while a push is in flight.
	// Overflow spills to disk (or, without a buffer, drops the oldest).
	liveQueueCap = 8
	// drainGap paces a backlog drain: at most 4 pushes/s per host (it was
	// 20/s), stretched further when the server is slow — see paceDrain.
	drainGap = 250 * time.Millisecond
	// drainStartJitter spreads the start of a drain after an outage. Every
	// agent that lost the backend at the same time sees it come back at the
	// same time; without a random delay the whole fleet starts draining in
	// the same second, against a server that has just recovered.
	drainStartJitter = 30 * time.Second
	// quarantinePerMinute caps how many rejected (400/413) samples may be
	// discarded per minute; past it they stay buffered (see
	// quarantineLimiter).
	quarantinePerMinute = 10
	// failureLogEvery re-logs a persisting push failure.
	failureLogEvery = 5 * time.Minute
)

// delivery owns the send side: the in-memory live queue, the optional disk
// buffer, pacing and failure classification.
type delivery struct {
	client   pusher
	buffer   *sampleBuffer // nil: memory-only fallback (one newest-wins slot)
	interval time.Duration

	liveTimeout  time.Duration
	drainTimeout time.Duration
	drainGap     time.Duration
	drainJitter  time.Duration
	backoff      *backoff
	quarantine   *quarantineLimiter
	// onDelivered runs after every accepted push (the first-push marker).
	onDelivered func()

	mu      sync.Mutex
	live    []*Payload // oldest first
	liveCap int
	wake    chan struct{}

	draining     bool
	failing      bool
	failures     int
	lastFailLog  time.Time
	capLogged    bool
	lastPushTook time.Duration
}

func newDelivery(client pusher, buffer *sampleBuffer, interval time.Duration) *delivery {
	if interval <= 0 {
		interval = time.Second
	}
	d := &delivery{
		client:   client,
		buffer:   buffer,
		interval: interval,
		// A live push should finish well before the sample after next; the
		// queue absorbs a slow one, so this can be generous.
		liveTimeout:  min(defaultPushTimeout, max(5*time.Second, 2*interval)),
		drainTimeout: defaultPushTimeout,
		drainGap:     drainGap,
		drainJitter:  drainStartJitter,
		backoff:      newBackoff(interval),
		quarantine:   newQuarantineLimiter(quarantinePerMinute, time.Minute),
		liveCap:      liveQueueCap,
		wake:         make(chan struct{}, 1),
	}
	if buffer == nil {
		d.liveCap = 1
	}
	return d
}

func (d *delivery) signal() {
	select {
	case d.wake <- struct{}{}:
	default:
	}
}

// offer accepts one fresh sample from the sampler. It never blocks on the
// network.
func (d *delivery) offer(payload *Payload) {
	if d.buffer != nil {
		payload.seq, payload.seqSet = d.buffer.reserveSeq(), true
		if d.buffer.pending() > 0 {
			// A backlog exists: this sample queues behind it on disk.
			d.buffer.append(payload)
			d.signal()
			return
		}
	}

	var overflow []*Payload
	d.mu.Lock()
	d.live = append(d.live, payload)
	if n := len(d.live) - d.liveCap; n > 0 {
		overflow = append(overflow, d.live[:n]...)
		d.live = append([]*Payload(nil), d.live[n:]...)
	}
	d.mu.Unlock()

	for _, p := range overflow {
		if d.buffer != nil {
			d.buffer.append(p)
		} else {
			// Memory-only fallback: newest wins, each replacement a drop.
			stats.recordDrop()
		}
	}
	d.signal()
}

// popLive takes the oldest in-memory sample.
func (d *delivery) popLive() *Payload {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.live) == 0 {
		return nil
	}
	p := d.live[0]
	d.live = d.live[1:]
	return p
}

// keep puts a live sample whose push did not succeed back under delivery's
// care: on disk when there is a buffer, otherwise back at the front of the
// one-slot memory queue unless a newer sample already replaced it.
func (d *delivery) keep(payload *Payload) {
	if d.buffer != nil {
		d.buffer.append(payload)
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.live) >= d.liveCap {
		stats.recordDrop()
		return
	}
	d.live = append([]*Payload{payload}, d.live...)
}

// spillLive moves every in-memory sample to disk (no-op without a buffer).
func (d *delivery) spillLive() {
	if d.buffer == nil {
		return
	}
	d.mu.Lock()
	pending := d.live
	d.live = nil
	d.mu.Unlock()
	for _, p := range pending {
		d.buffer.append(p)
	}
}

// pendingLive reports the in-memory queue length (tests, logs).
func (d *delivery) pendingLive() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.live)
}

// safePush is one push attempt with panic recovery: a bug in encoding or in
// the HTTP stack must cost one retry, not the process (and with it all host
// telemetry).
func (d *delivery) safePush(payload *Payload, timeout time.Duration) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("push: panic recovered: %v", recovered)
			stats.recordCollectorError("push")
			err = fmt.Errorf("push panic: %v", recovered)
		}
	}()
	started := time.Now()
	err = d.client.pushWithTimeout(payload, timeout)
	d.lastPushTook = time.Since(started)
	if err == nil {
		stats.recordCollectorRecovered("push")
	}
	return err
}

// sleep waits d or until shutdown; false means shut down.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// run is the send loop. It returns nil on shutdown, after spilling any
// in-memory samples to disk.
func (d *delivery) run(ctx context.Context) error {
	defer d.spillLive()
	lastLog := time.Time{}
	lastConfigLog := time.Time{}

	for {
		if ctx.Err() != nil {
			return nil
		}

		var (
			payload  *Payload
			entry    bufferEntry
			fromDisk bool
		)
		if d.buffer != nil && d.buffer.pending() > 0 {
			// One source of truth while a backlog exists: anything still in
			// memory joins the disk queue (in sequence order) first.
			d.spillLive()
			var ok bool
			entry, payload, ok = d.buffer.next()
			if !ok {
				continue
			}
			fromDisk = true
		} else if payload = d.popLive(); payload == nil {
			select {
			case <-ctx.Done():
				return nil
			case <-d.wake:
			case <-time.After(time.Second):
			}
			continue
		}

		timeout := d.liveTimeout
		if fromDisk {
			timeout = d.drainTimeout
		}
		err := d.safePush(payload, timeout)

		if err == nil {
			if fromDisk {
				d.buffer.ack(entry)
			}
			stats.recordPushOk()
			d.backoff.reset()
			d.capLogged = false
			if d.failing {
				log.Printf("push recovered after %d failed attempts", d.failures)
				d.failing, d.failures = false, 0
			}
			if d.onDelivered != nil {
				d.onDelivered()
			}
			logLive(&lastLog, payload)

			if d.buffer != nil && d.buffer.pending() > 0 {
				if !d.draining {
					d.draining = true
					wait := randomDuration(d.drainJitter)
					log.Printf("superboard: %d samples backlogged; draining oldest first after %s", d.buffer.pending(), wait.Round(time.Millisecond))
					if !sleepCtx(ctx, wait) {
						return nil
					}
				} else if !sleepCtx(ctx, d.paceDrain()) {
					return nil
				}
			} else if d.draining {
				d.draining = false
				log.Printf("superboard: backlog drained")
			}
			continue
		}

		stats.recordPushRetry(err)
		d.draining = false

		var (
			rejected   *pushRejectedError
			configErr  *pushConfigError
			retryErr   *pushRetryError
			retryAfter time.Duration
		)
		switch {
		case errors.As(err, &rejected):
			if d.quarantine.allow(time.Now()) {
				if fromDisk {
					d.buffer.quarantine(entry)
				} else if d.buffer != nil {
					d.buffer.quarantinePayload(payload)
				}
				// Gone for good: counted as a push failure, not as a drop.
				stats.recordPushLost(err)
				queued := 0
				if d.buffer != nil {
					queued = d.buffer.pending()
				}
				log.Printf("push rejected, sample quarantined (%d still queued): %v", queued, err)
				continue
			}
			// Safety valve: too many rejections in a minute looks like a
			// server problem, not a payload problem. Keep the sample and
			// wait for the window instead of discarding the backlog.
			if !fromDisk {
				d.keep(payload)
			}
			if !d.capLogged {
				d.capLogged = true
				log.Printf("push rejected %d times within a minute; keeping samples buffered instead of quarantining more: %v", quarantinePerMinute, err)
			}
			retryAfter = d.quarantine.retryIn(time.Now())
		case errors.As(err, &configErr):
			if !fromDisk {
				d.keep(payload)
			}
			// Rate-limited: a wrong token repeats forever and the operator
			// only needs the newest reason, not one line per retry.
			if time.Since(lastConfigLog) >= failureLogEvery {
				log.Printf("push refused by server configuration (backlog kept): %v", err)
				lastConfigLog = time.Now()
			}
		default:
			if !fromDisk {
				d.keep(payload)
			}
			if errors.As(err, &retryErr) {
				retryAfter = retryErr.retryAfter
			}
			d.failures++
			if !d.failing || time.Since(d.lastFailLog) >= failureLogEvery {
				log.Printf("push failed (sample kept, attempt %d): %v", d.failures, err)
				d.lastFailLog = time.Now()
			}
			d.failing = true
		}

		if !sleepCtx(ctx, d.backoff.next(retryAfter)) {
			return nil
		}
	}
}

// paceDrain is the gap between two backlog pushes: at least drainGap, and
// twice the last push's latency, so a server that slows down under the drain
// automatically gets a gentler one.
func (d *delivery) paceDrain() time.Duration {
	return max(d.drainGap, 2*d.lastPushTook)
}
