package main

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
)

// procStatPath is the Linux cumulative CPU-time source. Overridable in tests.
var procStatPath = "/proc/stat"

// cpuSampleInterval is the spacing between consecutive cumulative-counter
// reads for the daemon's CPU average. Thirty seconds of elapsed CPU time
// makes a one-second 95% spike report ~3% instead of 95%: the number on the
// board is the interval average, not a one-second window dressed as one.
const cpuSampleInterval = 30 * time.Second

// cpuQuickInterval is the short window used only to populate an initial
// reading without blocking startup, and as a fallback when no 30s average
// exists yet (first push, one-shot `check`). It must stay well under a
// second so live sampling never blocks the push loop.
const cpuQuickInterval = 200 * time.Millisecond

// cpuCounter holds cumulative CPU time. Total excludes guest/guestNice to
// avoid double counting (they are already included in user/nice on Linux),
// matching gopsutil's getAllBusy. Idle includes iowait: waiting on disk is
// not doing work.
type cpuCounter struct {
	total uint64
	idle  uint64
}

// parseProcStatContent parses /proc/stat text into an aggregate counter and
// one counter per logical CPU in index order.
//
// Each cpu line holds USER_HZ ticks: user nice system idle iowait irq
// softirq steal guest guestNice. Missing trailing fields are zero. At least
// user/nice/system/idle must be present; anything less is corrupt.
func parseProcStatContent(content string) (cpuCounter, []cpuCounter, error) {
	var total cpuCounter
	var perCore []cpuCounter
	var perCoreIdx []int
	foundTotal := false

	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		name := fields[0]
		var isTotal, isCore bool
		var coreIdx int
		if name == "cpu" {
			isTotal = true
		} else if strings.HasPrefix(name, "cpu") {
			rest := strings.TrimPrefix(name, "cpu")
			n, err := strconv.Atoi(rest)
			if err != nil {
				continue
			}
			isCore = true
			coreIdx = n
		} else {
			continue
		}

		if len(fields) < 5 {
			return cpuCounter{}, nil, fmt.Errorf("proc stat %q has %d fields, want at least 4 counters", name, len(fields)-1)
		}

		nums := make([]uint64, 0, 10)
		for _, s := range fields[1:] {
			if len(nums) >= 10 {
				break
			}
			v, err := strconv.ParseUint(s, 10, 64)
			if err != nil {
				return cpuCounter{}, nil, fmt.Errorf("proc stat %q: %w", name, err)
			}
			nums = append(nums, v)
		}
		for len(nums) < 10 {
			nums = append(nums, 0)
		}
		user, nice, system, idle, iowait, irq, softirq, steal := nums[0], nums[1], nums[2], nums[3], nums[4], nums[5], nums[6], nums[7]
		// guest/guestNice (nums[8], nums[9]) are deliberately excluded:
		// the kernel already accounts them inside user/nice.
		c := cpuCounter{
			total: user + nice + system + idle + iowait + irq + softirq + steal,
			idle:  idle + iowait,
		}
		if isTotal {
			total = c
			foundTotal = true
		} else if isCore {
			perCore = append(perCore, c)
			perCoreIdx = append(perCoreIdx, coreIdx)
		}
		_ = coreIdx
	}

	if !foundTotal {
		return cpuCounter{}, nil, fmt.Errorf("proc stat has no aggregate cpu line")
	}

	// Order per-core counters by logical index; /proc/stat is ordered but
	// sorting makes the contract explicit and hotplug gaps harmless.
	if len(perCore) > 1 {
		type pair struct {
			idx int
			c   cpuCounter
		}
		pairs := make([]pair, len(perCore))
		for i := range perCore {
			pairs[i] = pair{perCoreIdx[i], perCore[i]}
		}
		sort.Slice(pairs, func(a, b int) bool { return pairs[a].idx < pairs[b].idx })
		for i := range pairs {
			perCore[i] = pairs[i].c
		}
	}

	return total, perCore, nil
}

// readProcStatCounters reads cumulative counters straight from /proc/stat.
func readProcStatCounters() (cpuCounter, []cpuCounter, error) {
	data, err := os.ReadFile(procStatPath)
	if err != nil {
		return cpuCounter{}, nil, err
	}
	return parseProcStatContent(string(data))
}

// gopsutilCounters is the non-Linux fallback (darwin dev boxes, tests). It
// converts gopsutil's second-based TimesStat into the same tick domain as
// /proc/stat (USER_HZ=100) so the delta math below is identical.
func gopsutilCounters() (cpuCounter, []cpuCounter, error) {
	const hz = 100.0
	toTicks := func(v float64) uint64 { return uint64(v * hz) }

	totalTimes, err := cpu.Times(false)
	if err != nil {
		return cpuCounter{}, nil, err
	}
	perCoreTimes, err := cpu.Times(true)
	if err != nil {
		return cpuCounter{}, nil, err
	}

	convert := func(t cpu.TimesStat) cpuCounter {
		return cpuCounter{
			total: toTicks(t.User + t.Nice + t.System + t.Idle + t.Iowait + t.Irq + t.Softirq + t.Steal),
			idle:  toTicks(t.Idle + t.Iowait),
		}
	}

	var total cpuCounter
	if len(totalTimes) > 0 {
		total = convert(totalTimes[0])
	} else {
		// No aggregate: sum the cores, the same way the kernel does.
		for _, t := range perCoreTimes {
			c := convert(t)
			total.total += c.total
			total.idle += c.idle
		}
	}

	perCore := make([]cpuCounter, len(perCoreTimes))
	for i, t := range perCoreTimes {
		perCore[i] = convert(t)
	}
	return total, perCore, nil
}

// readCPUCounters returns cumulative counters, preferring /proc/stat on
// Linux and falling back to gopsutil elsewhere.
func readCPUCounters() (cpuCounter, []cpuCounter, error) {
	if total, perCore, err := readProcStatCounters(); err == nil {
		return total, perCore, nil
	}
	return gopsutilCounters()
}

// snapshotCPUCounters reads the current cumulative counters in payload
// form: the raw snapshot the server diffs against the previous push. A
// failure is counted in the self-report and yields an error, so the caller
// omits the field and the server falls back to the compat percent.
func snapshotCPUCounters() (*CPUCounters, error) {
	total, perCore, err := readCPUCounters()
	if err != nil {
		stats.recordCollectorError("cpu")
		return nil, err
	}
	stats.recordCollectorRecovered("cpu")
	out := &CPUCounters{Total: total.total, Idle: total.idle}
	for _, c := range perCore {
		out.PerCore = append(out.PerCore, CPUCounter{Total: c.total, Idle: c.idle})
	}
	return out, nil
}

// cpuPercent converts a pair of cumulative readings into 0-100% utilization:
// busy delta over total delta, where busy excludes idle+iowait. A zero or
// backwards total (counter reset, VM restore, no time elapsed) yields 0
// rather than a spike or NaN.
func cpuPercent(prev, cur cpuCounter) float64 {
	if cur.total <= prev.total {
		return 0
	}
	totalDelta := cur.total - prev.total
	if cur.idle < prev.idle {
		return 0
	}
	idleDelta := cur.idle - prev.idle
	if idleDelta > totalDelta {
		return 0
	}
	p := (1 - float64(idleDelta)/float64(totalDelta)) * 100
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

// perCorePercents diffs per-core counters pairwise. On hotplug (length
// change) there is no valid previous reading, so it returns zeros for the
// current shape; the next tick has a matching pair again.
func perCorePercents(prev, cur []cpuCounter) []float64 {
	out := make([]float64, len(cur))
	if len(prev) != len(cur) {
		return out
	}
	for i := range cur {
		out[i] = cpuPercent(prev[i], cur[i])
	}
	return out
}

// sampleCPUInterval measures true average utilization across the given
// window by diffing cumulative counters around a sleep. The window is the
// measurement: pass 30s for a representative load average, 200ms only for a
// quick initial reading. Two reads with no sleep cannot produce a percent.
func sampleCPUInterval(d time.Duration) (float64, []float64, int, error) {
	prevTotal, prevPerCore, err := readCPUCounters()
	if err != nil {
		return 0, nil, 0, err
	}
	time.Sleep(d)
	curTotal, curPerCore, err := readCPUCounters()
	if err != nil {
		return 0, nil, 0, err
	}
	percent := cpuPercent(prevTotal, curTotal)
	perCore := perCorePercents(prevPerCore, curPerCore)
	// A box with no per-cpu lines still has one aggregate: report it as a
	// single core rather than an empty breakdown the board must special-case.
	if len(perCore) == 0 {
		perCore = []float64{percent}
	}
	return percent, perCore, len(perCore), nil
}
