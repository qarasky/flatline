package main

import (
	"testing"
	"time"
)

// Without a disk buffer the live queue is one newest-wins slot.
func TestMemoryOnlyDeliveryNeverBuildsBacklog(t *testing.T) {
	d := newDelivery(nil, nil, time.Second)
	for i := 0; i < 10000; i++ {
		d.offer(&Payload{CPU: CPU{Percent: float64(i)}})
	}
	if d.pendingLive() != 1 {
		t.Fatalf("pending=%d", d.pendingLive())
	}
	if got := d.popLive().CPU.Percent; got != 9999 {
		t.Fatalf("latest=%v", got)
	}
}

func TestLiveSampleDoesNotWaitForSlowCollectors(t *testing.T) {
	c := &liveCollector{host: Host{Hostname: "test", Uptime: 100}, started: time.Now(), dockerError: "Collector initializing", cpuTemp: 65}
	started := time.Now()
	p, err := c.sample()
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(started) >= time.Second {
		t.Fatal("live sample has a blocking CPU window")
	}
	if p.CPU.Temp != 65 || p.Host.Hostname != "test" || p.DockerError != "Collector initializing" {
		t.Fatalf("cached slow data lost: %+v", p)
	}
	if len(p.CPU.PerCore) == 0 {
		t.Fatal("missing per-core data")
	}
}
