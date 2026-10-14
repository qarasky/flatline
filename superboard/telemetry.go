package main

import (
	"sync"
	"sync/atomic"
	"time"
)

// Agent self-telemetry: what the running process knows about its own health.
//
// Telegraf's internal input plugin is the precedent (gather_errors,
// metrics_dropped, ...): a monitoring agent should report its own failures,
// because otherwise a broken collector writes to journald and nobody reads
// it. The board then cannot tell "collector failing" from "quiet host".
//
// Counters are cumulative since process start and reset on restart, so they
// describe the current agent's behaviour. Types are atomic: collectors run in
// independent goroutines. Collector counts are per failure *episode* and the
// push counter counts lost samples, not retried attempts, so a recovered
// agent's numbers stop moving (see the record* helpers below).

// agentStarted approximates process start; it anchors the uptime field.
var agentStarted = time.Now()

// maxErrorLength bounds the last push-failure reason that travels in every
// payload. Counters say "something happened"; the string says what, and a
// runaway error message must not bloat the payload forever.
const maxErrorLength = 200

type telemetry struct {
	samplesDropped atomic.Uint64
	failedPushes   atomic.Uint64
	cpuErrors      atomic.Uint64
	gpuErrors      atomic.Uint64
	diskErrors     atomic.Uint64
	dockerErrors   atomic.Uint64
	updatesErrors  atomic.Uint64
	loadErrors     atomic.Uint64
	netErrors      atomic.Uint64
	diskioErrors   atomic.Uint64
	smartErrors    atomic.Uint64
	lastError      atomic.Pointer[string]

	// collectorFailing tracks which collectors are in a failing episode, so
	// repeat failures count once per episode instead of once per tick.
	collectorMu      sync.Mutex
	collectorFailing map[string]bool
}

// stats is the process-wide self-report. Package-level on purpose: the
// collector functions are package functions, not methods on liveCollector.
var stats telemetry

// recordDrop counts one sample lost before delivery: a buffer eviction when
// the byte cap is hit, a failed or corrupt buffer write, or a superseded
// sample in the fallback in-memory queue.
func (t *telemetry) recordDrop() {
	t.samplesDropped.Add(1)
}

// recordPushRetry records a delivery failure that will be retried: the
// reason is remembered (the board shows it while it is current), but the
// failure counter is left alone. Retried-and-delivered is not a failure, and
// counting every attempt made the counter climb on every backend restart,
// tunnel blip or transient 5xx while no sample was actually lost.
func (t *telemetry) recordPushRetry(err error) {
	msg := err.Error()
	if len(msg) > maxErrorLength {
		msg = msg[:maxErrorLength]
	}
	t.lastError.Store(&msg)
}

// recordPushLost counts one sample that delivery lost for good: a payload the
// server permanently refused (quarantined) or a failed push in the fallback
// in-memory queue, where the sample is consumed and replaced.
func (t *telemetry) recordPushLost(err error) {
	t.failedPushes.Add(1)
	t.recordPushRetry(err)
}

// recordPushOk clears the last-error string: the most recent state of the
// push pipeline is what an operator needs, not ancient history.
func (t *telemetry) recordPushOk() {
	t.lastError.Store(nil)
}

// recordCollectorError counts one collector failure *episode* by name: the
// first failure after a healthy period. A collector that keeps failing (the
// office host's nvidia-smi driver mismatch, a missing helper) is one problem,
// not a per-tick event — the old counter grew every five seconds and made the
// board's warning line climb forever. The count rises again only when a
// collector recovered and failed anew.
//
// The names are fixed so the payload map stays small and the board can label
// them.
func (t *telemetry) recordCollectorError(name string) {
	t.collectorMu.Lock()
	if t.collectorFailing == nil {
		t.collectorFailing = make(map[string]bool)
	}
	if t.collectorFailing[name] {
		t.collectorMu.Unlock()
		return
	}
	t.collectorFailing[name] = true
	t.collectorMu.Unlock()

	switch name {
	case "cpu":
		t.cpuErrors.Add(1)
	case "gpu":
		t.gpuErrors.Add(1)
	case "disk":
		t.diskErrors.Add(1)
	case "docker":
		t.dockerErrors.Add(1)
	case "updates":
		t.updatesErrors.Add(1)
	case "load":
		t.loadErrors.Add(1)
	case "net":
		t.netErrors.Add(1)
	case "diskio":
		t.diskioErrors.Add(1)
	case "smart":
		t.smartErrors.Add(1)
	}
}

// recordCollectorRecovered marks a collector healthy again, so its next
// failure counts as a new episode. Collectors call it on their success path.
func (t *telemetry) recordCollectorRecovered(name string) {
	t.collectorMu.Lock()
	if t.collectorFailing != nil {
		delete(t.collectorFailing, name)
	}
	t.collectorMu.Unlock()
}

// collectorErrorNames is the stable, sorted order of collector keys.
var collectorErrorNames = []string{"cpu", "disk", "diskio", "docker", "gpu", "load", "net", "smart", "updates"}

// agentInfoSnapshot assembles the self-report that rides every payload.
// Only nonzero collector counters are included, so a healthy agent's block
// stays tiny.
func agentInfoSnapshot() *AgentInfo {
	info := &AgentInfo{
		Version:        version,
		Uptime:         uint64(time.Since(agentStarted).Seconds()),
		SamplesDropped: stats.samplesDropped.Load(),
		FailedPushes:   stats.failedPushes.Load(),
	}
	if p := stats.lastError.Load(); p != nil {
		info.LastError = *p
	}

	counters := map[string]uint64{
		"cpu":     stats.cpuErrors.Load(),
		"disk":    stats.diskErrors.Load(),
		"diskio":  stats.diskioErrors.Load(),
		"docker":  stats.dockerErrors.Load(),
		"gpu":     stats.gpuErrors.Load(),
		"load":    stats.loadErrors.Load(),
		"net":     stats.netErrors.Load(),
		"smart":   stats.smartErrors.Load(),
		"updates": stats.updatesErrors.Load(),
	}
	errors := map[string]uint64{}
	for _, name := range collectorErrorNames {
		if counters[name] > 0 {
			errors[name] = counters[name]
		}
	}
	if len(errors) > 0 {
		info.CollectorErrors = errors
	}

	return info
}
