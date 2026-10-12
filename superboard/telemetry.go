package main

import (
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
// independent goroutines.

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

// recordPushFailure counts one failed delivery and remembers the reason.
func (t *telemetry) recordPushFailure(err error) {
	t.failedPushes.Add(1)
	msg := err.Error()
	if len(msg) > maxErrorLength {
		msg = msg[:maxErrorLength]
	}
	t.lastError.Store(&msg)
}

// recordPushOk clears the last-error string: the most recent state of the
// push pipeline is what an operator needs, not ancient history.
func (t *telemetry) recordPushOk() {
	t.lastError.Store(nil)
}

// recordCollectorError counts one collector failure by name. The names are
// fixed so the payload map stays small and the board can label them.
func (t *telemetry) recordCollectorError(name string) {
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
