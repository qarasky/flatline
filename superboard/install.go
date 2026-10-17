package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// systemdUnitName is the service name. Fixed, not configurable: one agent per
// box, and a predictable name is what operators grep for.
const systemdUnitName = "superboard"

// cronMarker identifies lines this tool owns in a crontab, so uninstall
// removes exactly what install added and nothing else.
const cronMarker = "superboard-agent"

// hasSystemd reports whether PID 1 is systemd.
//
// "systemctl exists" is not enough: containers often ship the binary without
// running it as init. Checking /run/systemd/system is the reliable test.
func hasSystemd() bool {
	info, err := os.Stat("/run/systemd/system")
	return err == nil && info.IsDir()
}

// unitFile renders the systemd unit. Type=simple with Restart=always: the
// agent is a loop, not a daemon that forks, and a crash should come back.
func unitFile(binaryPath, configPath string) string {
	return fmt.Sprintf(`[Unit]
Description=Flatline Superboard agent
Documentation=https://github.com/artchsh/flatline
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s run --config %s
Restart=always
RestartSec=10
# The Docker socket is root-owned; the agent only reads from it.
User=root

[Install]
WantedBy=multi-user.target
`, binaryPath, configPath)
}

// cmdInstall writes config, installs the service, and starts it.
//
// Refuses to double-install: running install twice should be a clear error,
// not two units fighting over one config.
func cmdInstall(configPath, server, token string, interval int, insecure bool) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("install must run as root (needs /etc/superboard and the service manager)")
	}

	binary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate own binary: %w", err)
	}
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		return fmt.Errorf("resolve own binary: %w", err)
	}

	if _, err := os.Stat(configPath); err == nil {
		return fmt.Errorf("already installed: %s exists (uninstall first to re-provision)", configPath)
	}

	cfg := &Config{ServerURL: server, PushToken: token, AllowInsecure: insecure}
	if interval > 0 {
		cfg.IntervalSeconds = interval
	} else {
		cfg.IntervalSeconds = DefaultIntervalSeconds
	}
	// Written explicitly rather than left to the nil default, so an operator
	// reading the config file can see self-update is on and turn it off.
	selfUpdate := true
	cfg.SelfUpdate = &selfUpdate

	if err := saveConfig(configPath, cfg); err != nil {
		return err
	}
	log.Printf("superboard: wrote %s (mode 0600)", configPath)

	if hasSystemd() {
		return installSystemd(binary, configPath)
	}

	log.Printf("superboard: no systemd detected, falling back to cron @reboot")
	return installCron(binary, configPath)
}

func installSystemd(binaryPath, configPath string) error {
	unitPath := "/etc/systemd/system/" + systemdUnitName + ".service"

	if err := os.WriteFile(unitPath, []byte(unitFile(binaryPath, configPath)), 0o644); err != nil {
		return fmt.Errorf("write unit: %w", err)
	}

	for _, args := range [][]string{
		{"daemon-reload"},
		{"enable", "--now", systemdUnitName},
	} {
		cmd := exec.Command("systemctl", args...)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
		}
	}

	log.Printf("superboard: installed and started via systemd (%s)", unitPath)
	return nil
}

// installCron is the fallback for boxes without systemd as PID 1.
//
// Cron cannot supervise: if the agent dies mid-day it stays dead until the
// next reboot. That limitation is printed, not hidden, because pretending a
// cron entry equals a service is how monitoring gaps happen.
func installCron(binaryPath, configPath string) error {
	entry := fmt.Sprintf("@reboot %s run --config %s # %s\n", binaryPath, configPath, cronMarker)

	out, err := exec.Command("crontab", "-l").CombinedOutput()
	if err != nil && !strings.Contains(string(out), "no crontab") {
		return fmt.Errorf("read crontab: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if err != nil {
		// A fresh host has no crontab yet: `crontab -l` exits 1 with
		// "no crontab for <user>" on stderr. That is an empty crontab,
		// not a failure.
		out = nil
	}

	if strings.Contains(string(out), cronMarker) {
		return fmt.Errorf("already installed: a superboard cron entry exists (uninstall first)")
	}

	combined := string(out)
	if combined != "" && !strings.HasSuffix(combined, "\n") {
		combined += "\n"
	}
	combined += entry

	cmd := exec.Command("crontab", "-")
	cmd.Stdin = strings.NewReader(combined)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("install crontab: %w: %s", err, strings.TrimSpace(string(out)))
	}

	log.Printf("superboard: installed via cron @reboot (no supervision: a crash stays dead until reboot)")

	// Start one now so the operator does not wait for a reboot to see data.
	starter := exec.Command(binaryPath, "run", "--config", configPath)
	starter.Stdout = os.Stdout
	starter.Stderr = os.Stderr
	if err := starter.Start(); err != nil {
		return fmt.Errorf("start agent now: %w", err)
	}

	return nil
}

// cmdUninstall stops and removes everything install created.
func cmdUninstall(configPath string) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("uninstall must run as root")
	}

	if hasSystemd() {
		for _, args := range [][]string{
			{"disable", "--now", systemdUnitName},
		} {
			cmd := exec.Command("systemctl", args...)
			if out, err := cmd.CombinedOutput(); err != nil {
				log.Printf("superboard: systemctl %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
			}
		}
		if err := os.Remove("/etc/systemd/system/" + systemdUnitName + ".service"); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove unit: %w", err)
		}
		if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
			log.Printf("superboard: daemon-reload: %v: %s", err, strings.TrimSpace(string(out)))
		}
	} else {
		out, err := exec.Command("crontab", "-l").CombinedOutput()
		if err == nil {
			kept := []string{}
			for _, line := range strings.Split(string(out), "\n") {
				if !strings.Contains(line, cronMarker) {
					kept = append(kept, line)
				}
			}
			cmd := exec.Command("crontab", "-")
			cmd.Stdin = strings.NewReader(strings.Join(kept, "\n"))
			if out, err := cmd.CombinedOutput(); err != nil {
				return fmt.Errorf("remove crontab entry: %w: %s", err, strings.TrimSpace(string(out)))
			}
		}
	}

	// Kill any running agent, then remove the config. Order matters: killing
	// first means no push can race the config deletion.
	if out, err := exec.Command("pkill", "-f", "superboard run").CombinedOutput(); err != nil {
		log.Printf("superboard: no running agent to stop (%s)", strings.TrimSpace(string(out)))
	}

	// The buffer is a cache of undelivered telemetry: worthless once the
	// agent is gone, and it contains hostnames/container names. Resolve a
	// custom path from the config before deleting it.
	bufferDir := DefaultBufferDir
	if cfg, err := loadConfig(configPath); err == nil {
		bufferDir = cfg.bufferDir()
	}
	if err := os.RemoveAll(bufferDir); err != nil {
		log.Printf("superboard: buffer cleanup: %v", err)
	}

	if err := os.Remove(configPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove config: %w", err)
	}

	log.Printf("superboard: uninstalled")
	return nil
}
