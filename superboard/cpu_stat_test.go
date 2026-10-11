package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseProcStatBasic(t *testing.T) {
	content := "cpu  100 0 100 800 0 0 0 0 0 0\n" +
		"cpu0 60 0 60 480 0 0 0 0 0 0\n" +
		"cpu1 40 0 40 320 0 0 0 0 0 0\n"
	total, perCore, err := parseProcStatContent(content)
	if err != nil {
		t.Fatal(err)
	}
	// total = 100+0+100+800 = 1000, idle = 800
	if total.total != 1000 || total.idle != 800 {
		t.Fatalf("total = %+v, want {1000 800}", total)
	}
	if len(perCore) != 2 {
		t.Fatalf("perCore len = %d, want 2", len(perCore))
	}
	if perCore[0].total != 600 || perCore[1].total != 400 {
		t.Fatalf("perCore totals = %v", perCore)
	}
}

func TestParseProcStatExcludesGuest(t *testing.T) {
	// guest=50 is already inside user; counting it again would inflate total.
	content := "cpu  100 0 100 800 0 0 0 0 50 0\n"
	total, _, err := parseProcStatContent(content)
	if err != nil {
		t.Fatal(err)
	}
	if total.total != 1000 {
		t.Fatalf("total = %d, want 1000 (guest excluded)", total.total)
	}
}

func TestParseProcStatOrdersCores(t *testing.T) {
	content := "cpu  200 0 0 800 0 0 0 0 0 0\n" +
		"cpu1 100 0 0 400 0 0 0 0 0 0\n" +
		"cpu0 100 0 0 400 0 0 0 0 0 0\n"
	_, perCore, err := parseProcStatContent(content)
	if err != nil {
		t.Fatal(err)
	}
	if len(perCore) != 2 || perCore[0].total != 500 || perCore[1].total != 500 {
		t.Fatalf("unordered cores not sorted: %v", perCore)
	}
}

func TestParseProcStatMissing(t *testing.T) {
	if _, _, err := parseProcStatContent("intr 123\n"); err == nil {
		t.Fatal("expected error with no cpu line")
	}
}

func TestCpuPercentIntervalAverage(t *testing.T) {
	// The reported bug: a 1s 95% spike must not read as 95% across 30s.
	// 30s window: 29s idle (total 2900, idle 2900) + 1s spike (total 100,
	// idle 5) = total 3000, idle 2905 -> busy 95/3000 = 3.17%.
	prev := cpuCounter{total: 100000, idle: 90000}
	cur := cpuCounter{total: 103000, idle: 92905}
	got := cpuPercent(prev, cur)
	if got < 2 || got > 5 {
		t.Fatalf("30s average = %.2f, want ~3.17", got)
	}
	// Same spike in a 1s window reads ~95%.
	spike := cpuPercent(cpuCounter{total: 100000, idle: 90000}, cpuCounter{total: 100100, idle: 90005})
	if spike < 90 || spike > 100 {
		t.Fatalf("1s spike = %.2f, want ~95", spike)
	}
}

func TestCpuPercentEdgeCases(t *testing.T) {
	if got := cpuPercent(cpuCounter{100, 50}, cpuCounter{100, 50}); got != 0 {
		t.Fatalf("zero delta = %v, want 0", got)
	}
	// Counter reset (VM restore, wrap): never a spike or NaN.
	if got := cpuPercent(cpuCounter{200, 100}, cpuCounter{100, 50}); got != 0 {
		t.Fatalf("reset = %v, want 0", got)
	}
	if got := cpuPercent(cpuCounter{0, 0}, cpuCounter{1000, 0}); got != 100 {
		t.Fatalf("fully busy = %v, want 100", got)
	}
	if got := cpuPercent(cpuCounter{0, 0}, cpuCounter{1000, 1000}); got != 0 {
		t.Fatalf("fully idle = %v, want 0", got)
	}
}

func TestPerCoreMismatchYieldsZeros(t *testing.T) {
	prev := []cpuCounter{{1000, 800}}
	cur := []cpuCounter{{1100, 810}, {1100, 810}}
	got := perCorePercents(prev, cur)
	if len(got) != 2 || got[0] != 0 || got[1] != 0 {
		t.Fatalf("hotplug mismatch = %v, want zeros", got)
	}
}

func TestReadProcStatFromFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stat")
	content := "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	old := procStatPath
	procStatPath = path
	defer func() { procStatPath = old }()
	total, perCore, err := readProcStatCounters()
	if err != nil {
		t.Fatal(err)
	}
	if total.total != 1000 || len(perCore) != 1 {
		t.Fatalf("file read = %+v %v", total, perCore)
	}
}

func TestSampleCPUIntervalQuick(t *testing.T) {
	start := time.Now()
	percent, perCore, cores, err := sampleCPUInterval(10 * time.Millisecond)
	if err != nil {
		t.Skipf("no cpu counters in test env: %v", err)
	}
	if time.Since(start) >= time.Second {
		t.Fatal("quick sample blocked too long")
	}
	if cores <= 0 || len(perCore) != cores {
		t.Fatalf("cores=%d perCore=%d", cores, len(perCore))
	}
	if percent < 0 || percent > 100 {
		t.Fatalf("percent=%v out of range", percent)
	}
	for _, p := range perCore {
		if p < 0 || p > 100 {
			t.Fatalf("perCore %v out of range", p)
		}
	}
}

func TestLiveRefreshUsesIntervalAverage(t *testing.T) {
	// Two snapshots 30s apart in counter space must average, not spike.
	prevTotal := cpuCounter{total: 100000, idle: 90000}
	if pct := cpuPercent(prevTotal, cpuCounter{total: 103000, idle: 92905}); pct < 2 || pct > 5 {
		t.Fatalf("fixture sanity: avg=%.2f", pct)
	}
}

func TestRefreshCPUAveragesCounters(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "stat")
	v1 := "cpu  1000 0 1000 9000 0 0 0 0 0 0\n" +
		"cpu0 500 0 500 4500 0 0 0 0 0 0\n" +
		"cpu1 500 0 500 4500 0 0 0 0 0 0\n"
	// 30s later: mostly idle (+2905 idle of +3000 total => ~3.17% busy).
	v2 := "cpu  1047 0 1048 11905 0 0 0 0 0 0\n" +
		"cpu0 524 0 524 5952 0 0 0 0 0 0\n" +
		"cpu1 523 0 524 5953 0 0 0 0 0 0\n"
	if err := os.WriteFile(path, []byte(v1), 0o644); err != nil {
		t.Fatal(err)
	}
	old := procStatPath
	procStatPath = path
	defer func() { procStatPath = old }()

	total1, perCore1, err := readProcStatCounters()
	if err != nil {
		t.Fatal(err)
	}
	c := &liveCollector{
		cpuPrevTotal:   total1,
		cpuPrevPerCore: perCore1,
		cpuPrevTime:    time.Now().Add(-30 * time.Second),
		cpuReady:       true,
	}
	if err := os.WriteFile(path, []byte(v2), 0o644); err != nil {
		t.Fatal(err)
	}
	c.refreshCPU()
	c.mu.RLock()
	got := c.cpu.Percent
	n := len(c.cpu.PerCore)
	c.mu.RUnlock()
	if got < 2 || got > 5 {
		t.Fatalf("refreshCPU 30s average = %.2f, want ~3.2 (spike must not report 95)", got)
	}
	if n != 2 {
		t.Fatalf("per-core len = %d, want 2", n)
	}
}
