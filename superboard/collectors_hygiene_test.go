package main

import (
	"context"
	"encoding/json"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// A grandchild holding stdout must not hang Output() past the deadline.
func TestBoundedCommandDoesNotHangOnInheritedStdout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs sh")
	}
	old := commandWaitDelay
	commandWaitDelay = 200 * time.Millisecond
	defer func() { commandWaitDelay = old }()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	// sh exits at once; the backgrounded sleep keeps the stdout pipe open.
	_, _ = boundedCommand(ctx, "sh", "-c", "sleep 30 & echo started").Output()
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("Output blocked %s on an inherited pipe", elapsed)
	}
}

func TestEpisodeLogLogsOncePerEpisode(t *testing.T) {
	var e episodeLog
	if !e.fail("a", "first %d", 1) {
		t.Fatal("first failure must log")
	}
	for i := 0; i < 5; i++ {
		if e.fail("a", "again") {
			t.Fatal("repeat failure in the same episode must not log")
		}
	}
	e.ok("a", "")
	if !e.fail("a", "new episode") {
		t.Fatal("a failure after recovery starts a new episode")
	}
	e.fail("gone", "x")
	e.prune(func(key string) bool { return key == "a" })
	if e.size() != 1 {
		t.Fatalf("prune kept %d keys, want 1", e.size())
	}
}

func TestSmartctlDoesNotWakeSleepingDisks(t *testing.T) {
	args := smartctlArgs("sda")
	i := slices.Index(args, "-n")
	if i < 0 || i+1 >= len(args) || args[i+1] != "standby" {
		t.Fatalf("smartctl args %v lack -n standby", args)
	}
}

func TestSMARTStandbyKeepsPreviousReading(t *testing.T) {
	standby := []byte(`{"smartctl":{"exit_status":2,"messages":[{"string":"Device is in STANDBY mode, exit(2)","severity":"information"}]},"device":{"name":"/dev/sdb"}}`)
	if !smartInStandby(standby) {
		t.Fatal("standby output not recognised")
	}
	if _, ok := parseSMARTJSON("sdb", standby); ok {
		t.Fatal("standby output carries no reading")
	}
	if smartInStandby([]byte(`{"smart_status":{"passed":true}}`)) {
		t.Fatal("a normal reading is not standby")
	}
	prev := &SMART{Available: true, Disks: []SMARTDisk{{Device: "sdb", Health: "passed", PowerOnHours: 10}}}
	got, ok := previousSMARTDisk(prev, "sdb")
	if !ok || got.Health != "passed" {
		t.Fatalf("previous reading = %+v, %v", got, ok)
	}
	if _, ok := previousSMARTDisk(nil, "sdb"); ok {
		t.Fatal("no previous reading on a one-shot check")
	}
}

func TestLiveSamplePublishesCollectedAt(t *testing.T) {
	at := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	c := &liveCollector{host: Host{Hostname: "t"}, started: time.Now(), collectedAt: CollectedAt{Disk: at, Smart: at}}
	p, err := c.sample()
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"collectedAt":{"disk":"2026-10-20T09:00:00Z","smart":"2026-10-20T09:00:00Z"}`) {
		t.Fatalf("collectedAt missing or malformed: %s", data)
	}

	fresh := &liveCollector{host: Host{Hostname: "t"}, started: time.Now()}
	p, err = fresh.sample()
	if err != nil {
		t.Fatal(err)
	}
	if p.CollectedAt != nil {
		t.Fatal("nothing collected yet: collectedAt must be omitted")
	}
}
