package main

import (
	"encoding/json"
	"testing"
)

const statsFixture = `{
  "cpu_stats": {
    "cpu_usage": { "total_usage": 1500 },
    "system_cpu_usage": 11000,
    "online_cpus": 4,
    "percpu_usage": [ 400, 400, 400, 300 ]
  },
  "memory_stats": {
    "usage": 1000,
    "limit": 2000,
    "stats": { "cache": 400 }
  }
}`

func TestParseContainerStatsFixture(t *testing.T) {
	var raw containerStatsRaw
	if err := json.Unmarshal([]byte(statsFixture), &raw); err != nil {
		t.Fatal(err)
	}
	if raw.CPUStats.CPUUsage.TotalUsage != 1500 || raw.CPUStats.SystemUsage != 11000 {
		t.Fatalf("cpu counters = %+v", raw.CPUStats)
	}
	if raw.CPUStats.OnlineCPUs != 4 {
		t.Fatalf("online cpus = %d", raw.CPUStats.OnlineCPUs)
	}
	if raw.MemoryStats.Usage != 1000 || raw.MemoryStats.Limit != 2000 || raw.MemoryStats.Stats["cache"] != 400 {
		t.Fatalf("memory = %+v", raw.MemoryStats)
	}
}

func TestContainerCPUPercent(t *testing.T) {
	// 500/1000 system delta, 4 cores -> 200% (two cores' worth).
	if got := containerCPUPercent(1000, 10000, 1500, 11000, 4); got != 200 {
		t.Fatalf("got %v, want 200", got)
	}
	if got := containerCPUPercent(1000, 10000, 1000, 10000, 4); got != 0 {
		t.Fatalf("no elapsed time must read 0, got %v", got)
	}
	if got := containerCPUPercent(1000, 10000, 900, 11000, 4); got != 0 {
		t.Fatalf("counter reset must read 0, got %v", got)
	}
	if got := containerCPUPercent(0, 0, 100, 1000, 0); got != 10 {
		t.Fatalf("cores < 1 must clamp to 1, got %v", got)
	}
}

func TestContainerMemoryUsage(t *testing.T) {
	used, percent := containerMemoryUsage(1000, 2000, map[string]uint64{"cache": 400})
	if used != 600 {
		t.Fatalf("used = %d, want 600 (cache subtracted)", used)
	}
	if percent == nil || *percent != 30 {
		t.Fatalf("percent = %v, want 30", percent)
	}

	// cgroup v2 names the same thing inactive_file.
	used, _ = containerMemoryUsage(1000, 0, map[string]uint64{"inactive_file": 250})
	if used != 750 {
		t.Fatalf("v2 used = %d, want 750", used)
	}

	// usage below cache cannot go negative.
	used, _ = containerMemoryUsage(100, 0, map[string]uint64{"cache": 400})
	if used != 0 {
		t.Fatalf("clamped used = %d, want 0", used)
	}

	// No limit / sentinel limit: bytes only, no percentage.
	if _, percent = containerMemoryUsage(100, 0, nil); percent != nil {
		t.Fatalf("no limit must yield no percent, got %v", percent)
	}
	if _, percent = containerMemoryUsage(100, 1<<62, nil); percent != nil {
		t.Fatalf("sentinel limit must yield no percent, got %v", percent)
	}
}

func TestBuildContainerStatsNeedsTwoReads(t *testing.T) {
	var raw containerStatsRaw
	if err := json.Unmarshal([]byte(statsFixture), &raw); err != nil {
		t.Fatal(err)
	}

	first := buildContainerStats("test-container", &raw)
	if first.CPUPercent != nil {
		t.Fatalf("first read must not invent a CPU percent: %v", *first.CPUPercent)
	}
	if first.MemUsed != 600 || first.MemPercent == nil {
		t.Fatalf("first read memory = %+v", first)
	}

	raw.CPUStats.CPUUsage.TotalUsage = 2500
	raw.CPUStats.SystemUsage = 13000
	second := buildContainerStats("test-container", &raw)
	if second.CPUPercent == nil || *second.CPUPercent != 200 {
		t.Fatalf("second read cpu = %v, want 200", second.CPUPercent)
	}

	// A container that disappears is pruned from the cache.
	pruneDockerStatsCache(map[string]bool{})
	dockerStatsCache.mu.Lock()
	_, still := dockerStatsCache.last["test-container"]
	dockerStatsCache.mu.Unlock()
	if still {
		t.Fatal("pruned container must leave the cache")
	}
}

func TestContainerStatsJSONShape(t *testing.T) {
	percent := 12.5
	c := Container{
		Name: "api", State: "running",
		Stats: &ContainerStats{CPUPercent: &percent, MemUsed: 512, MemLimit: 2048},
	}
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	stats, ok := back["stats"].(map[string]any)
	if !ok || stats["cpuPercent"] != 12.5 {
		t.Fatalf("stats block = %v", back["stats"])
	}
	if _, ok := stats["memPercent"]; ok {
		t.Fatal("unknown memPercent must be omitted, not zero")
	}

	// A container without stats must not grow a stats key at all.
	plain := Container{Name: "old", State: "exited"}
	data, _ = json.Marshal(plain)
	if back := string(data); back == "" || json.Valid(data) == false {
		t.Fatal("marshal failed")
	}
	var plainBack map[string]any
	_ = json.Unmarshal(data, &plainBack)
	if _, ok := plainBack["stats"]; ok {
		t.Fatal("statless container must omit the block")
	}
}
