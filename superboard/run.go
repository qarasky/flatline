package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

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

// safeSample takes one sample with panic recovery. A panic in a fast-path
// collector (a parser meeting an unexpected /proc line) used to terminate
// the agent and with it all host telemetry; now it costs one tick and is
// counted as a "sample" collector error.
func safeSample(sample func() (*Payload, error)) (payload *Payload, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("sample: collector panic: %v", recovered)
			stats.recordCollectorError("sample")
			payload, err = nil, fmt.Errorf("sample panic: %v", recovered)
		}
	}()
	payload, err = sample()
	if err != nil {
		stats.recordCollectorError("sample")
	} else {
		stats.recordCollectorRecovered("sample")
	}
	return payload, err
}

// sampleLog keeps a persistently failing sample (no memory reading) to one
// journal line per episode.
var sampleLog episodeLog

// runSampler takes one sample per tick and hands it to offer. Failures and
// panics cost that tick, never the loop.
func runSampler(ctx context.Context, interval time.Duration, sample func() (*Payload, error), offer func(*Payload)) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			payload, err := safeSample(sample)
			if err != nil {
				sampleLog.fail("sample", "collect: %v (repeats suppressed)", err)
				continue
			}
			sampleLog.ok("sample", "collect: recovered")
			payload.SampleInterval = int(interval / time.Second)
			offer(payload)
		}
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

	// Disk-backed spill queue. Any failure to open it degrades to the
	// in-memory newest-wins slot: buffering is an upgrade, never a
	// requirement, and a broken path must not take monitoring down.
	buffer, err := openSampleBuffer(cfg.bufferDir(), cfg.bufferMaxBytes())
	if err != nil {
		log.Printf("superboard: disk buffer unavailable (%v); using the in-memory queue", err)
		buffer = nil
	} else {
		log.Printf("superboard: buffer %s (cap %.0f MiB, %d pending from a previous run)", buffer.dir, float64(buffer.maxBytes)/(1<<20), buffer.pending())
	}

	d := newDelivery(newPushClient(cfg), buffer, interval)

	var sampler sync.WaitGroup
	sampler.Add(1)
	go func() {
		defer sampler.Done()
		runSampler(ctx, interval, collector.sample, d.offer)
	}()
	log.Printf("superboard: live samples every %s; slow collectors run independently", interval)

	// Self-update runs beside the push loop: a version check must never block
	// or delay telemetry, and every failure degrades to "keep pushing".
	go selfUpdateLoop(ctx, cfg)

	err = d.run(ctx)
	cancel()
	sampler.Wait()
	// A sample offered while the sender was shutting down is spilled too.
	d.spillLive()
	return err
}

// deliverBuffered drains buffer through client until ctx is cancelled, with
// the default pacing. Used by callers and tests that drive a pre-filled
// buffer directly.
func deliverBuffered(ctx context.Context, buffer *sampleBuffer, client pusher, interval time.Duration) error {
	return newDelivery(client, buffer, interval).run(ctx)
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
	if s := clock.reportSeconds(); s != 0 {
		log.Printf("superboard check: local clock differs from the server by %ds", s)
	}
	log.Printf("superboard check: ok (cpu=%.1f%% mem=%.1f%% disks=%d containers=%d gpu=%v)", payload.CPU.Percent, payload.Mem.Percent, len(payload.Disk), len(payload.Docker), payload.GPU.Available)
	return nil
}
