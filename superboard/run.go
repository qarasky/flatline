package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// bufferDrainInterval paces a backlog drain: at most ~20 pushes per second.
// An hour of 1Hz samples drains in about three minutes, fast enough to
// restore live data, slow enough not to hammer the backend or its SSE
// fan-out the moment a host reconnects.
const bufferDrainInterval = 50 * time.Millisecond

// A single collector and a single sender. Without a disk buffer this is the
// fallback: one pending sample, newer replaces older, each replacement
// counts as a dropped sample in the self-report.
func offerLatest(samples chan *Payload, payload *Payload) {
	select {
	case samples <- payload:
		return
	default:
	}
	select {
	case <-samples:
		stats.recordDrop()
	default:
	}
	select {
	case samples <- payload:
	default:
	}
}

// logLive throttles the periodic human-readable delivery log.
func logLive(lastLog *time.Time, payload *Payload) {
	if time.Since(*lastLog) < time.Minute {
		return
	}
	if payload.Updates != nil {
		log.Printf("superboard: live cpu=%.1f%% mem=%.1f%% containers=%d updates=%d(security %d)", payload.CPU.Percent, payload.Mem.Percent, len(payload.Docker), payload.Updates.Total, payload.Updates.Security)
	} else {
		log.Printf("superboard: live cpu=%.1f%% mem=%.1f%% containers=%d", payload.CPU.Percent, payload.Mem.Percent, len(payload.Docker))
	}
	*lastLog = time.Now()
}

// sleepBackoff waits out a push failure, aborting early on shutdown.
func sleepBackoff(ctx context.Context, backoff time.Duration) bool {
	timer := time.NewTimer(backoff)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func runLoop(cfg *Config) error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	collector, err := newLiveCollector(ctx)
	if err != nil {
		return err
	}
	interval := time.Duration(cfg.IntervalSeconds) * time.Second
	if interval <= 0 {
		interval = time.Second
	}

	// Disk-backed delivery queue. Any failure to open it degrades to the
	// in-memory newest-wins queue: buffering is an upgrade, never a
	// requirement, and a broken path must not take monitoring down.
	buffer, err := openSampleBuffer(cfg.bufferDir(), cfg.bufferMaxBytes())
	if err != nil {
		log.Printf("superboard: disk buffer unavailable (%v); using the in-memory queue", err)
		buffer = nil
	} else {
		log.Printf("superboard: buffer %s (cap %.0f MiB, %d pending from a previous run)", buffer.dir, float64(buffer.maxBytes)/(1<<20), buffer.pending())
	}

	samples := make(chan *Payload, 1)
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				payload, err := collector.sample()
				if err != nil {
					log.Printf("collect: %v", err)
					continue
				}
				payload.SampleInterval = int(interval / time.Second)
				if buffer != nil {
					buffer.append(payload)
				} else {
					offerLatest(samples, payload)
				}
			}
		}
	}()

	client := newPushClient(cfg)
	client.http.Timeout = min(30*time.Second, max(2*time.Second, interval))
	log.Printf("superboard: live samples every %s; slow collectors run independently", interval)
	backoff := interval
	lastLog := time.Time{}

	if buffer != nil {
		return deliverBuffered(ctx, buffer, client, interval)
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case payload := <-samples:
			if err := client.push(payload); err != nil {
				stats.recordPushFailure(err)
				log.Printf("push failed: %v", err)
				if !sleepBackoff(ctx, backoff) {
					return nil
				}
				backoff = min(30*time.Second, backoff*2)
				continue
			}
			stats.recordPushOk()
			backoff = interval
			logLive(&lastLog, payload)
		}
	}
}

// deliverBuffered drains the disk-backed queue, oldest first. In-order
// arrival keeps counter-window math and backfilled history chronological; a
// failed push retries the same sample, and the backlog stays bounded by the
// buffer's byte cap. Returns nil when the context is cancelled.
func deliverBuffered(ctx context.Context, buffer *sampleBuffer, client *pushClient, interval time.Duration) error {
	backoff := interval
	lastLog := time.Time{}
	for {
		entry, payload, ok := buffer.next()
		if !ok {
			select {
			case <-ctx.Done():
				return nil
			case <-buffer.wake:
			case <-time.After(time.Second):
			}
			continue
		}
		if err := client.push(payload); err != nil {
			stats.recordPushFailure(err)
			log.Printf("push failed: %v", err)
			if !sleepBackoff(ctx, backoff) {
				return nil
			}
			backoff = min(30*time.Second, backoff*2)
			continue
		}
		buffer.ack(entry)
		stats.recordPushOk()
		backoff = interval
		logLive(&lastLog, payload)
		if buffer.pending() > 0 {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(bufferDrainInterval):
			}
		}
	}
}

// One-shot diagnostics retain the complete blocking collection path.
func runOnce(cfg *Config, verbose bool) error {
	payload, err := collect()
	if err != nil {
		return fmt.Errorf("collect: %w", err)
	}
	if verbose {
		pretty, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			return fmt.Errorf("encode payload: %w", err)
		}
		fmt.Println(string(pretty))
	}
	if err := newPushClient(cfg).push(payload); err != nil {
		return err
	}
	log.Printf("superboard check: ok (cpu=%.1f%% mem=%.1f%% disks=%d containers=%d gpu=%v)", payload.CPU.Percent, payload.Mem.Percent, len(payload.Disk), len(payload.Docker), payload.GPU.Available)
	return nil
}
