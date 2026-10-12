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

// A single collector and a single sender, with one pending sample. A slow
// network replaces old pending samples rather than building a stale backlog;
// each replacement counts as a dropped sample in the self-report.
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
				offerLatest(samples, payload)
			}
		}
	}()
	client := newPushClient(cfg)
	client.http.Timeout = min(30*time.Second, max(2*time.Second, interval))
	log.Printf("superboard: live samples every %s; slow collectors run independently", interval)
	backoff := interval
	lastLog := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return nil
		case payload := <-samples:
			if err := client.push(payload); err != nil {
				stats.recordPushFailure(err)
				log.Printf("push failed: %v", err)
				timer := time.NewTimer(backoff)
				select {
				case <-ctx.Done():
					timer.Stop()
					return nil
				case <-timer.C:
				}
				backoff = min(30*time.Second, backoff*2)
				continue
			}
			stats.recordPushOk()
			backoff = interval
			if time.Since(lastLog) >= time.Minute {
				if payload.Updates != nil {
					log.Printf("superboard: live cpu=%.1f%% mem=%.1f%% containers=%d updates=%d(security %d)", payload.CPU.Percent, payload.Mem.Percent, len(payload.Docker), payload.Updates.Total, payload.Updates.Security)
				} else {
					log.Printf("superboard: live cpu=%.1f%% mem=%.1f%% containers=%d", payload.CPU.Percent, payload.Mem.Percent, len(payload.Docker))
				}
				lastLog = time.Now()
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
