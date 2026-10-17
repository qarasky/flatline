package main

import (
	"encoding/json"
	"testing"
)

func TestParseAptCheck(t *testing.T) {
	total, security, ok := parseAptCheck("72;8\n")
	if !ok || total != 72 || security != 8 {
		t.Fatalf("got %d,%d,%v", total, security, ok)
	}
	if total, _, ok := parseAptCheck("0;0"); !ok || total != 0 {
		t.Fatalf("zero updates must parse: %d,%v", total, ok)
	}
	for _, bad := range []string{"", "72", "72;", "a;b", "-1;0", "5;9", "72;8;1"} {
		if _, _, ok := parseAptCheck(bad); ok {
			t.Fatalf("must reject %q (security above total is corrupt)", bad)
		}
	}
}

func TestCountAptInst(t *testing.T) {
	out := "Reading package lists...\n" +
		"Inst bash [5.1-2] (5.2-1 Ubuntu:22.04/jammy-updates)\n" +
		"Conf bash (5.2-1 Ubuntu:22.04/jammy-updates)\n" +
		"Inst curl [7.81.0-1] (8.2.1-1ubuntu3.4 Ubuntu:22.04/jammy-security)\n"
	if got := countAptInst(out); got != 2 {
		t.Fatalf("got %d, want 2 (Conf lines are not upgrades)", got)
	}
}

func TestCountDNF(t *testing.T) {
	out := "bash.x86_64    5.2-1.el9    baseos\n" +
		"curl.x86_64    8.2.1-1.el9_4    appstream\n" +
		"\n" +
		"Last metadata expiration check: 0:12:33 ago.\n"
	if got := countDNF(out); got != 2 {
		t.Fatalf("got %d, want 2", got)
	}
}

func TestCountLines(t *testing.T) {
	if got := countLines("bash 5.1-2 -> 5.2-1\n\ncurl 7.81 -> 8.2\n"); got != 2 {
		t.Fatalf("got %d, want 2", got)
	}
	if got := countLines(""); got != 0 {
		t.Fatalf("empty must be 0, got %d", got)
	}
}

func TestCollectUpdatesUnsupportedYieldsError(t *testing.T) {
	// The test box is darwin without a Linux package manager: the check
	// must fail cleanly so the caller omits the field, never fabricate one.
	if _, err := collectUpdates(); err == nil {
		t.Skip("a supported package manager exists in this environment")
	}
}

func TestPayloadUpdatesOmittedWhenUnknown(t *testing.T) {
	data, err := json.Marshal(Payload{V: 1, CPU: CPU{Percent: 10, Cores: 2}})
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if _, ok := back["updates"]; ok {
		t.Fatal("absent updates must be omitted so unknown never reads as zero")
	}
}

func TestPayloadUpdatesRoundTrip(t *testing.T) {
	p := Payload{V: 1, Updates: &Updates{Total: 70, Security: 8, RebootRequired: true}}
	data, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var back Payload
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if back.Updates == nil || back.Updates.Total != 70 || back.Updates.Security != 8 || !back.Updates.RebootRequired {
		t.Fatalf("round trip lost updates: %+v", back.Updates)
	}
}

func TestPayloadRebootOmittedWhenNotRequired(t *testing.T) {
	// A false reboot flag must not travel: absent means "not needed", and a
	// field that appears with false on every push is noise on the wire.
	data, err := json.Marshal(Payload{V: 1, Updates: &Updates{Total: 3}})
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	updates, _ := back["updates"].(map[string]any)
	if _, ok := updates["rebootRequired"]; ok {
		t.Fatal("rebootRequired must be omitted when false")
	}
}

func TestPayloadCountersRoundTrip(t *testing.T) {
	p := Payload{V: 1, CPU: CPU{
		Percent: 3.2, Cores: 2, PerCore: []float64{3.1, 3.3},
		Counters: &CPUCounters{Total: 103000, Idle: 92905,
			PerCore: []CPUCounter{{Total: 51500, Idle: 46455}, {Total: 51500, Idle: 46450}}},
	}}
	data, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var back Payload
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	c := back.CPU.Counters
	if c == nil || c.Total != 103000 || c.Idle != 92905 || len(c.PerCore) != 2 {
		t.Fatalf("round trip lost counters: %+v", c)
	}
	if back.CPU.Percent != 3.2 || len(back.CPU.PerCore) != 2 {
		t.Fatalf("compat percent must survive alongside counters: %+v", back.CPU)
	}
}

func TestSnapshotCountersShape(t *testing.T) {
	c, err := snapshotCPUCounters()
	if err != nil {
		t.Skipf("no cpu counters in test env: %v", err)
	}
	if c.Total == 0 {
		t.Fatal("total must advance with wall time, never be zero")
	}
	if c.Idle > c.Total {
		t.Fatalf("idle %d exceeds total %d", c.Idle, c.Total)
	}
}
