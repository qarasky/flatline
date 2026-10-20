package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const defaultBinaryPath = "/usr/local/bin/flatline-backup"
const defaultUnitDir = "/etc/systemd/system"

// serviceStartTimeout bounds one oneshot run: the two-hour export job
// deadline plus a throttled upload of a maximum-size bundle. Without it a
// oneshot may hang forever (systemd's oneshot default is no timeout) and the
// daily timer never fires again while it is active.
const serviceStartTimeout = "6h"

type installOptions struct {
	unitDir    string
	binaryPath string
	// systemctl runs one systemctl command; tests record the calls.
	systemctl func(args ...string) error
}

// InstallInstance writes the named oneshot service and daily timer. A fresh
// installation leaves the timer disabled; with enableTimer the units are
// reloaded and the timer is enabled into timers.target and started.
func InstallInstance(cfgPath string, enableTimer bool) error {
	return installInstance(cfgPath, enableTimer, installOptions{
		unitDir:    defaultUnitDir,
		binaryPath: defaultBinaryPath,
		systemctl:  runSystemctl,
	})
}

func runSystemctl(args ...string) error {
	command := exec.Command("systemctl", args...)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

func installInstance(cfgPath string, enableTimer bool, options installOptions) error {
	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		return err
	}
	if options.unitDir == "" {
		options.unitDir = defaultUnitDir
	}
	if options.binaryPath == "" {
		options.binaryPath = defaultBinaryPath
	}
	absoluteConfig, err := filepath.Abs(cfgPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(options.unitDir, 0o755); err != nil {
		return fmt.Errorf("create unit dir: %w", err)
	}

	serviceName := "flatline-backup@" + cfg.Name + ".service"
	timerName := "flatline-backup@" + cfg.Name + ".timer"
	servicePath := filepath.Join(options.unitDir, serviceName)
	timerPath := filepath.Join(options.unitDir, timerName)

	service := renderService(cfg.Name, options.binaryPath, absoluteConfig)
	if err := writeUnit(servicePath, service); err != nil {
		return err
	}
	timer := renderTimer(cfg.Name, cfg.Schedule)
	if err := writeUnit(timerPath, timer); err != nil {
		return err
	}

	if enableTimer {
		if options.systemctl == nil {
			return errors.New("enable timer: systemctl is unavailable")
		}
		// A hand-made wants/ symlink is neither loaded nor started; let
		// systemd link the timer into timers.target and start it now.
		if err := options.systemctl("daemon-reload"); err != nil {
			return fmt.Errorf("enable timer: %w", err)
		}
		if err := options.systemctl("enable", "--now", timerName); err != nil {
			return fmt.Errorf("enable timer: %w", err)
		}
	}
	return nil
}

func renderService(name, binaryPath, configPath string) string {
	var builder strings.Builder
	builder.WriteString("[Unit]\n")
	builder.WriteString("Description=Flatline backup agent " + name + "\n")
	builder.WriteString("StartLimitIntervalSec=0\n")
	builder.WriteString("After=network-online.target\n")
	builder.WriteString("Wants=network-online.target\n\n")
	builder.WriteString("[Service]\n")
	builder.WriteString("Type=oneshot\n")
	builder.WriteString("ExecStart=" + systemdEscape(binaryPath) + " run-once --config " + systemdEscape(configPath) + "\n")
	builder.WriteString("TimeoutStartSec=" + serviceStartTimeout + "\n")
	builder.WriteString("Restart=on-failure\n")
	builder.WriteString("RestartSec=30min\n")
	return builder.String()
}

func renderTimer(name, schedule string) string {
	var builder strings.Builder
	builder.WriteString("[Unit]\n")
	builder.WriteString("Description=Daily Flatline backup for " + name + "\n\n")
	builder.WriteString("[Timer]\n")
	builder.WriteString("OnCalendar=" + schedule + "\n")
	builder.WriteString("RandomizedDelaySec=600\n")
	builder.WriteString("Persistent=true\n")
	builder.WriteString("Unit=flatline-backup@" + name + ".service\n\n")
	builder.WriteString("[Install]\n")
	builder.WriteString("WantedBy=timers.target\n")
	return builder.String()
}

func systemdEscape(value string) string {
	if !strings.ContainsAny(value, " \t\"'\\") {
		return value
	}
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	return `"` + replacer.Replace(value) + `"`
}

func writeUnit(path, contents string) error {
	if !strings.HasSuffix(path, ".service") && !strings.HasSuffix(path, ".timer") {
		return errors.New("unit path must end in .service or .timer")
	}
	return atomicWriteMode(path, []byte(contents), 0o644)
}
