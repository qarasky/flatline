package main

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/mem"
)

type liveCollector struct {
	mu               sync.RWMutex
	host             Host
	started          time.Time
	disk             []Disk
	gpu              GPU
	docker           []Container
	dockerError      string
	cpuTemp, memTemp float64
	// cpu is the 30-second average utilization, refreshed from cumulative
	// CPU-time counters (/proc/stat deltas) every cpuSampleInterval. Pushes
	// go out every second carrying the current average: a one-second 95%
	// spike reads as ~3%, not 95%, because the number is the interval mean.
	cpu CPU
	// cpuPrev holds the counters the cached average was computed from, so
	// the next refresh covers exactly the elapsed interval.
	cpuPrevTotal   cpuCounter
	cpuPrevPerCore []cpuCounter
	cpuPrevTime    time.Time
	cpuReady       bool
	// updates caches pending OS update counts, refreshed every few hours.
	// Nil means unknown (unsupported distro or failed check): the board
	// shows nothing rather than a wrong "fully updated".
	updates *Updates
}

func refreshLoop(ctx context.Context, interval time.Duration, collect func()) {
	collect()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			collect()
		}
	}
}

// cpuRefreshLoop ticks every interval without an immediate first run: the
// collector primes its counters at startup, and the first refresh 30s later
// covers a full 30s of elapsed CPU time. An immediate run would diff two
// back-to-back reads and report a meaningless milliseconds-wide spike.
func cpuRefreshLoop(ctx context.Context, interval time.Duration, collect func()) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			collect()
		}
	}
}

func newLiveCollector(ctx context.Context) (*liveCollector, error) {
	h, err := collectHost()
	if err != nil {
		return nil, err
	}
	c := &liveCollector{host: h, started: time.Now(), dockerError: "Collector initializing"}
	// Prime the cumulative counters once. The first 30s refresh diffs
	// against this reading, so it covers time since startup.
	if total, perCore, err := readCPUCounters(); err == nil {
		c.cpuPrevTotal, c.cpuPrevPerCore, c.cpuPrevTime, c.cpuReady = total, perCore, time.Now(), false
	} else {
		log.Printf("warning: cpu counters unavailable: %v", err)
	}
	// Populate an initial reading without blocking startup: a short window
	// beats an empty card, and the 30s average takes over on first refresh.
	// Failure here is not fatal; sample() falls back to the same quick read.
	if pct, perCore, cores, err := sampleCPUInterval(cpuQuickInterval); err == nil {
		if total, coresNow, err := readCPUCounters(); err == nil {
			c.mu.Lock()
			c.cpu = CPU{Percent: pct, Cores: cores, PerCore: perCore}
			c.cpuPrevTotal, c.cpuPrevPerCore, c.cpuPrevTime, c.cpuReady = total, coresNow, time.Now(), true
			c.mu.Unlock()
		}
	} else {
		log.Printf("warning: initial cpu sample unavailable: %v", err)
	}
	go cpuRefreshLoop(ctx, cpuSampleInterval, c.refreshCPU)
	go refreshLoop(ctx, 30*time.Second, func() {
		disks, err := collectDisk()
		if err != nil {
			log.Printf("disk: %v", err)
			return
		}
		c.mu.Lock()
		c.disk = disks
		c.mu.Unlock()
	})
	go refreshLoop(ctx, 30*time.Second, func() {
		cpuTemp, memTemp := collectTemp(cpuSensorKeys), collectTemp(memSensorKeys)
		c.mu.Lock()
		c.cpuTemp, c.memTemp = cpuTemp, memTemp
		c.mu.Unlock()
	})
	go refreshLoop(ctx, 5*time.Second, func() {
		gpu := collectGPU()
		c.mu.Lock()
		c.gpu = gpu
		c.mu.Unlock()
	})
	go refreshLoop(ctx, 10*time.Second, func() {
		containers, err := collectDocker()
		errorText := ""
		if err != nil {
			errorText = err.Error()
			log.Printf("docker: %v", err)
		}
		c.mu.Lock()
		c.docker, c.dockerError = containers, errorText
		c.mu.Unlock()
	})
	go refreshLoop(ctx, updatesInterval, func() {
		updates, err := collectUpdates()
		if err != nil {
			logUpdatesWarning(err)
			return
		}
		c.mu.Lock()
		c.updates = updates
		c.mu.Unlock()
	})
	return c, nil
}

// refreshCPU recomputes the cached 30s average from cumulative counters.
// It covers exactly the wall time since the previous refresh, so the number
// is the interval mean even when ticks drift by seconds.
func (c *liveCollector) refreshCPU() {
	total, perCore, err := readCPUCounters()
	if err != nil {
		log.Printf("cpu: %v", err)
		return
	}
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.cpuReady || c.cpuPrevTime.IsZero() {
		// First refresh after a startup where the quick initial sample
		// failed: the prime is already ~30s old, so average from it
		// instead of discarding a full interval of CPU time.
		if !c.cpuPrevTime.IsZero() && now.Sub(c.cpuPrevTime) >= 5*time.Second {
			percent := cpuPercent(c.cpuPrevTotal, total)
			perCorePct := perCorePercents(c.cpuPrevPerCore, perCore)
			if len(perCorePct) == 0 {
				perCorePct = []float64{percent}
			}
			c.cpu = CPU{Percent: percent, Cores: len(perCorePct), PerCore: perCorePct, Temp: c.cpuTemp}
		}
		c.cpuPrevTotal, c.cpuPrevPerCore, c.cpuPrevTime, c.cpuReady = total, perCore, now, true
		return
	}
	percent := cpuPercent(c.cpuPrevTotal, total)
	perCorePct := perCorePercents(c.cpuPrevPerCore, perCore)
	if len(perCorePct) == 0 {
		perCorePct = []float64{percent}
	}
	c.cpu = CPU{Percent: percent, Cores: len(perCorePct), PerCore: perCorePct, Temp: c.cpuTemp}
	c.cpuPrevTotal, c.cpuPrevPerCore, c.cpuPrevTime = total, perCore, now
}

// cachedCPU returns the current 30s average when one exists.
func (c *liveCollector) cachedCPU() (CPU, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if !c.cpuReady || len(c.cpu.PerCore) == 0 {
		return CPU{}, false
	}
	out := c.cpu
	out.Temp = c.cpuTemp
	return out, true
}

func (c *liveCollector) sample() (*Payload, error) {
	cpuVal, ok := c.cachedCPU()
	if !ok {
		// No 30s average yet (first seconds after startup, or a test
		// collector built without newLiveCollector): take a quick
		// counter-based reading so the push still carries real per-core
		// data without blocking the loop for a second.
		percent, perCore, cores, err := sampleCPUInterval(cpuQuickInterval)
		if err != nil {
			return nil, fmt.Errorf("cpu: %w", err)
		}
		c.mu.RLock()
		temp := c.cpuTemp
		c.mu.RUnlock()
		cpuVal = CPU{Percent: percent, Cores: cores, PerCore: perCore, Temp: temp}
	}
	// Raw cumulative counters ride every push: the server derives its own
	// windowed percentages from consecutive snapshots. Omitted when the
	// read fails, and the server falls back to the compat percent above.
	if counters, err := snapshotCPUCounters(); err == nil {
		cpuVal.Counters = counters
		if n := len(counters.PerCore); n > 0 {
			cpuVal.Cores = n
		}
	}
	vm, err := mem.VirtualMemory()
	if err != nil {
		return nil, fmt.Errorf("memory: %w", err)
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	h := c.host
	h.Uptime += uint64(time.Since(c.started).Seconds())
	// Temp rides along from the slow sensor worker; the cached average
	// deliberately does not carry its own copy.
	cpuVal.Temp = c.cpuTemp
	return &Payload{V: payloadVersion, Host: h,
		CPU:  cpuVal,
		Mem:  Mem{Total: vm.Total, Used: vm.Used, Percent: vm.UsedPercent, Temp: c.memTemp},
		Disk: c.disk, GPU: c.gpu, Docker: c.docker, DockerError: c.dockerError,
		Updates: c.updates, Agent: agentInfoSnapshot()}, nil
}
