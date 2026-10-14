package main

import (
	"context"
	"encoding/csv"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/sensors"
)

// collectHost identifies the machine.
func collectHost() (Host, error) {
	info, err := host.Info()
	if err != nil {
		return Host{}, fmt.Errorf("host info: %w", err)
	}

	uptime, err := host.Uptime()
	if err != nil {
		// Uptime is informational; a failure here must not sink the push.
		log.Printf("warning: host uptime unavailable: %v", err)
	}

	hostname := info.Hostname
	if hostname == "" {
		hostname, _ = os.Hostname()
	}

	return Host{
		Hostname: hostname,
		OS:       info.OS,
		Uptime:   uptime,
	}, nil
}

// collectCPU reports true average utilization across a one-second window,
// diffing cumulative CPU-time counters around a sleep. Linux reads /proc/stat
// directly; other platforms use the same counter math via gopsutil.
//
// This is a one-shot diagnostic for `superboard check`: it must return
// quickly, so the window is short. The daemon's live path does not use this —
// it averages over 30 seconds (see live_collect.go) — so a one-second spike
// here must never be presented as a 30-second load average.
func collectCPU() (CPU, error) {
	percent, perCore, cores, err := sampleCPUInterval(time.Second)
	if err != nil {
		return CPU{}, fmt.Errorf("cpu percent: %w", err)
	}

	out := CPU{
		Percent: percent,
		Cores:   cores,
		PerCore: perCore,
		Temp:    collectTemp(cpuSensorKeys),
	}
	// Raw snapshot for the server to derive its own windows from. A read
	// failure here must not sink the check: the compat percent above still
	// stands on its own.
	if counters, err := snapshotCPUCounters(); err == nil {
		out.Counters = counters
		if n := len(counters.PerCore); n > 0 {
			out.Cores = n
		}
	} else {
		log.Printf("warning: cpu counters unavailable: %v", err)
	}

	return out, nil
}

// cpuSensorKeys matches Linux hwmon labels that describe processor heat.
// Vendor naming is chaos (coretemp, k10temp, zenpower, ...), so this is a
// substring match, not a list. Anything not matching is ignored: a hot NVMe
// must never present itself as a hot CPU.
var cpuSensorKeys = []string{"coretemp", "cpu", "package", "k10temp", "zenpower", "acpitz"}

// memSensorKeys matches memory temperature sensors. Almost nothing exposes
// these (VPS never does), so this list is aspirational: DDR5 TSODs, if a
// future kernel ever surfaces them under hwmon.
var memSensorKeys = []string{"dimm", "ddr", "memory"}

// maxSensorTemp returns the hottest plausible reading among sensors whose
// key contains one of the given substrings, or 0 when there is nothing.
//
// Plausibility matters: virtual machines report 0, and broken drivers report
// absurd values. Both mean "no data", and the board hides a zero, so clamping
// here can never paint a wrong number.
func maxSensorTemp(keys []string) float64 {
	temps, err := sensors.SensorsTemperatures()
	if err != nil {
		return 0
	}

	best := 0.0
	for _, t := range temps {
		key := strings.ToLower(t.SensorKey)
		matched := false
		for _, k := range keys {
			if strings.Contains(key, k) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		if t.Temperature > best && t.Temperature < 125 {
			best = t.Temperature
		}
	}

	return best
}

// collectTemp is a hook for tests: production passes maxSensorTemp.
var collectTemp = maxSensorTemp

// collectMem reports bytes and percent.
func collectMem() (Mem, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return Mem{}, fmt.Errorf("memory: %w", err)
	}

	return Mem{
		Total:   vm.Total,
		Used:    vm.Used,
		Percent: vm.UsedPercent,
		Temp:    collectTemp(memSensorKeys),
	}, nil
}

// collectDisk reports every local mount it can read.
func collectDisk() ([]Disk, error) {
	partitions, err := disk.Partitions(false)
	if err != nil {
		stats.recordCollectorError("disk")
		return nil, fmt.Errorf("disk partitions: %w", err)
	}

	var out []Disk
	for _, p := range partitions {
		// Skip pseudo-filesystems: they report nonsense totals (/dev at 100%
		// on a healthy box is the classic false alarm).
		if strings.HasPrefix(p.Mountpoint, "/snap") ||
			strings.HasPrefix(p.Fstype, "squashfs") ||
			p.Mountpoint == "/proc" || strings.HasPrefix(p.Mountpoint, "/proc/") ||
			p.Mountpoint == "/sys" || strings.HasPrefix(p.Mountpoint, "/sys/") ||
			p.Mountpoint == "/dev" || strings.HasPrefix(p.Mountpoint, "/dev/") {
			continue
		}

		usage, err := disk.Usage(p.Mountpoint)
		if err != nil {
			log.Printf("warning: disk usage for %s unavailable: %v", p.Mountpoint, err)
			continue
		}

		out = append(out, Disk{
			Mount:   p.Mountpoint,
			Total:   usage.Total,
			Used:    usage.Used,
			Percent: usage.UsedPercent,
		})
	}

	stats.recordCollectorRecovered("disk")
	return out, nil
}

// gpuHealth rate-limits a persistently broken nvidia-smi.
//
// The office host's NVML driver/library mismatch failed on every 5s poll:
// the log filled with one warning per tick and the board's collector-error
// counter climbed forever. After a few consecutive failures the poll backs
// off (the GPU is unavailable either way) and the reason is logged on the
// first failure and then rarely.
var gpuHealth = struct {
	mu          sync.Mutex
	consecutive int
	nextAttempt time.Time
	lastLogged  time.Time
}{}

const (
	// Consecutive failures before the poll backs off.
	gpuBackoffAfterFailures = 3
	// How long to wait between attempts while the GPU is unusable.
	gpuBackoffInterval = 5 * time.Minute
	// How often the same failure is re-logged while it persists.
	gpuFailureLogInterval = 15 * time.Minute
)

// gpuAttemptDue reports whether nvidia-smi should be polled now.
func gpuAttemptDue() bool {
	gpuHealth.mu.Lock()
	defer gpuHealth.mu.Unlock()
	return !time.Now().Before(gpuHealth.nextAttempt)
}

// gpuNoteFailure records one failed poll: counts the episode (once), logs the
// first failure and then at most one line per gpuFailureLogInterval, and backs
// the poll off after gpuBackoffAfterFailures consecutive failures.
func gpuNoteFailure(err error) {
	gpuHealth.mu.Lock()
	gpuHealth.consecutive++
	consecutive := gpuHealth.consecutive
	if consecutive >= gpuBackoffAfterFailures {
		gpuHealth.nextAttempt = time.Now().Add(gpuBackoffInterval)
	}
	loggable := consecutive == 1 || time.Since(gpuHealth.lastLogged) >= gpuFailureLogInterval
	if loggable {
		gpuHealth.lastLogged = time.Now()
	}
	gpuHealth.mu.Unlock()

	if loggable {
		if consecutive == 1 {
			log.Printf("warning: nvidia-smi failed: %v", err)
		} else {
			log.Printf("warning: nvidia-smi still failing after %d attempts (retrying every %s): %v",
				consecutive, gpuBackoffInterval, err)
		}
	}
	stats.recordCollectorError("gpu")
}

// gpuNoteRecovered clears the failure episode and the backoff.
func gpuNoteRecovered() {
	gpuHealth.mu.Lock()
	gpuHealth.consecutive = 0
	gpuHealth.nextAttempt = time.Time{}
	gpuHealth.mu.Unlock()
	stats.recordCollectorRecovered("gpu")
}

// collectGPU shells out to nvidia-smi and parses the CSV output.
//
// Best-effort by contract: any failure (binary missing, parse error, driver
// mismatch) yields Available false, never an error that stops the push. A
// null GPU and a broken collector must be distinguishable server-side, and
// this is how.
func collectGPU() GPU {
	if !gpuAttemptDue() {
		// Backing off from a persistently broken nvidia-smi (driver
		// mismatch, no usable device): polling every 5s only spams the log
		// and the error counter. The GPU stays honestly unavailable.
		return GPU{Available: false}
	}

	path, err := exec.LookPath("nvidia-smi")
	if err != nil {
		// No tool at all: this box has no NVIDIA GPU, which is not a failure.
		gpuNoteRecovered()
		return GPU{Available: false}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// CSV with exactly the fields we parse, in order.
	cmd := exec.CommandContext(ctx, path,
		"--query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu",
		"--format=csv,noheader,nounits")
	out, err := cmd.Output()
	if err != nil {
		gpuNoteFailure(err)
		return GPU{Available: false}
	}

	records, err := csv.NewReader(strings.NewReader(strings.TrimSpace(string(out)))).ReadAll()
	if err != nil || len(records) == 0 {
		gpuNoteFailure(fmt.Errorf("nvidia-smi output unparseable: %v", err))
		return GPU{Available: false}
	}

	// Every GPU on the box; the scalar fields below repeat the first.

	parse := func(s string) float64 {
		f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
		return f
	}
	parseBytes := func(s string) uint64 {
		// nvidia-smi reports MiB with --format=nounits.
		f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
		return uint64(f * 1024 * 1024)
	}

	gpus := make([]GPUDetail, 0, len(records))
	for _, r := range records {
		if len(r) < 5 {
			log.Printf("warning: nvidia-smi returned %d fields, want 5 — skipping GPU", len(r))
			continue
		}
		gpus = append(gpus, GPUDetail{
			Name:     strings.TrimSpace(r[0]),
			Util:     parse(r[1]),
			MemTotal: parseBytes(r[2]),
			MemUsed:  parseBytes(r[3]),
			Temp:     parse(r[4]),
		})
	}

	if len(gpus) == 0 {
		gpuNoteFailure(fmt.Errorf("nvidia-smi reported no GPUs"))
		return GPU{Available: false}
	}

	gpuNoteRecovered()

	// The scalar fields repeat the first GPU so old readers keep working;
	// new readers use Gpus.
	first := gpus[0]
	return GPU{
		Available: true,
		Name:      first.Name,
		Util:      first.Util,
		MemTotal:  first.MemTotal,
		MemUsed:   first.MemUsed,
		Temp:      first.Temp,
		Gpus:      gpus,
	}
}

// collect builds the full payload. Individual collectors degrade to empty or
// zero values with a logged warning; only a total failure to assemble aborts.
func collect() (*Payload, error) {
	h, err := collectHost()
	if err != nil {
		return nil, err
	}

	c, err := collectCPU()
	if err != nil {
		return nil, err
	}

	m, err := collectMem()
	if err != nil {
		return nil, err
	}

	disks, err := collectDisk()
	if err != nil {
		return nil, err
	}

	containers, err := collectDocker()
	if err != nil {
		// Docker absent is normal (most boxes run without it). But an empty
		// list is ambiguous — no containers vs. cannot see the daemon — so
		// the reason travels with the payload and the board can say
		// "unavailable" instead of silently showing "none".
		log.Printf("warning: docker unavailable: %v", err)
		containers = nil
	}

	payload := &Payload{
		V:      payloadVersion,
		Host:   h,
		CPU:    c,
		Mem:    m,
		Disk:   disks,
		GPU:    collectGPU(),
		Docker: containers,
		Load:   collectLoad(),
		Net:    collectNet(),
		DiskIO: collectDiskIO(),
		Smart:  collectSMART(),
	}
	if err != nil {
		payload.DockerError = err.Error()
	}

	// Pending-update counts are best-effort: an unsupported distro or a
	// failed check reads as unknown (absent), never as "fully updated".
	if updates, err := collectUpdates(); err != nil {
		log.Printf("warning: updates check unavailable: %v", err)
	} else {
		payload.Updates = updates
	}

	// Self-report rides every payload, including one-shot checks: version,
	// uptime, dropped samples, push failures and per-collector error counts.
	payload.Agent = agentInfoSnapshot()
	stampSample(payload)

	return payload, nil
}
