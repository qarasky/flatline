package main

import (
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
	options := installOptions{unitDir: unitDir, binaryPath: "/usr/local/bin/flatline-backup"}

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
	} {
		if !strings.Contains(string(timer), expected) {
			t.Fatalf("timer unit lacks %q:\n%s", expected, timer)
		}
	}

	wants := filepath.Join(unitDir, "multi-user.target.wants")
	if _, err := os.Lstat(filepath.Join(wants, "flatline-backup@meks.timer")); !os.IsNotExist(err) {
		t.Fatalf("a fresh installation must leave the timer disabled: %v", err)
	}

	if err := installInstance(fixture.writeConfig(t, "zhkhteam", fixture.config("zhkhteam")), true, options); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(wants, "flatline-backup@zhkhteam.timer")
	target, err := os.Readlink(link)
	if err != nil {
		t.Fatalf("enabled timer symlink missing: %v", err)
	}
	if target != filepath.Join(unitDir, "flatline-backup@zhkhteam.timer") {
		t.Fatalf("timer symlink target = %q", target)
	}
	if _, err := os.Lstat(filepath.Join(wants, "flatline-backup@meks.timer")); !os.IsNotExist(err) {
		t.Fatal("enabling one instance must not enable another")
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
