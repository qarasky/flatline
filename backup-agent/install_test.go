package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTwoInstanceUnitsAndManualLock(t *testing.T) {
	fixture := newFixture(t)
	meksConfig := runnerConfig(t, fixture, "meks")
	zhkhConfig := runnerConfig(t, fixture, "zhkhteam")
	unitDir := t.TempDir()
	var systemctl [][]string
	options := installOptions{
		unitDir:    unitDir,
		binaryPath: "/usr/local/bin/flatline-backup",
		systemctl: func(args ...string) error {
			systemctl = append(systemctl, args)
			return nil
		},
	}

	if err := installInstance(fixture.writeConfig(t, "meks", fixture.config("meks")), false, options); err != nil {
		t.Fatal(err)
	}
	service, err := os.ReadFile(filepath.Join(unitDir, "flatline-backup@meks.service"))
	if err != nil {
		t.Fatal(err)
	}
	timer, err := os.ReadFile(filepath.Join(unitDir, "flatline-backup@meks.timer"))
	if err != nil {
		t.Fatal(err)
	}

	for _, expected := range []string{
		"Type=oneshot",
		"ExecStart=/usr/local/bin/flatline-backup run-once --config ",
		"Restart=on-failure",
		"RestartSec=30min",
		"StartLimitIntervalSec=0",
		// Review L1: a oneshot has no start timeout by default.
		"TimeoutStartSec=6h",
	} {
		if !strings.Contains(string(service), expected) {
			t.Fatalf("service unit lacks %q:\n%s", expected, service)
		}
	}
	for _, expected := range []string{
		"OnCalendar=*-*-* 02:00:00 Asia/Almaty",
		"RandomizedDelaySec=600",
		"Persistent=true",
		"Unit=flatline-backup@meks.service",
		"WantedBy=timers.target",
	} {
		if !strings.Contains(string(timer), expected) {
			t.Fatalf("timer unit lacks %q:\n%s", expected, timer)
		}
	}

	if len(systemctl) != 0 {
		t.Fatalf("a fresh installation must leave the timer disabled: %v", systemctl)
	}

	// Review L1: --enable-timer must really enable and start the timer.
	if err := installInstance(fixture.writeConfig(t, "zhkhteam", fixture.config("zhkhteam")), true, options); err != nil {
		t.Fatal(err)
	}
	want := [][]string{{"daemon-reload"}, {"enable", "--now", "flatline-backup@zhkhteam.timer"}}
	if fmt.Sprint(systemctl) != fmt.Sprint(want) {
		t.Fatalf("systemctl calls = %v, want %v", systemctl, want)
	}

	// A failing systemctl is an installation failure, never "enabled".
	options.systemctl = func(args ...string) error { return errors.New("no systemd") }
	if err := installInstance(fixture.writeConfig(t, "zhkhteam", fixture.config("zhkhteam")), true, options); err == nil {
		t.Fatal("enable failures must be reported")
	}

	// Separate names have separate locks; a second holder of one fails.
	meksLock, err := AcquireInstanceLock(meksConfig.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer meksLock.Close()
	zhkhLock, err := AcquireInstanceLock(zhkhConfig.StateDir)
	if err != nil {
		t.Fatalf("separate instances must not share a lock: %v", err)
	}
	defer zhkhLock.Close()
	if _, err := AcquireInstanceLock(meksConfig.StateDir); err == nil {
		t.Fatal("the same instance lock must be exclusive")
	}
}
