// Command superboard is the Flatline fleet agent.
//
// It collects host metrics (CPU, memory, disks), Docker container states and,
// where present, GPU stats, then pushes them to a Flatline monitor's push
// endpoint once per interval. Silence is the alert: if pushes stop, the
// monitor goes down through the existing push-timeout path.
//
// Usage:
//
//	superboard run [--config PATH]
//	superboard check [--config PATH] [--verbose]
//	superboard install --server URL --token TOKEN [--interval SECS] [--insecure] [--config PATH]
//	superboard uninstall [--config PATH]
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
)

// version is a var, not a const, so release builds can stamp it with
// -ldflags "-X main.version=..." (the Dockerfile also derives the VERSION
// file from `superboard version`).
var version = "1.7.0"

func usage() {
	fmt.Fprintf(os.Stderr, `superboard %s — Flatline fleet agent

Usage:
  superboard run [--config PATH]
      Collect and push forever.
  superboard check [--config PATH] [--verbose]
      Collect and push once, printing the outcome. Exit 0 on accept.
  superboard self-update [--config PATH] [--check]
      Install a newer agent release the server ships. --check only reports.
  superboard install --server URL --token TOKEN [--interval SECS] [--insecure] [--config PATH]
      Write config, install as a service (systemd, or cron @reboot without
      it), and start. Must run as root.
  superboard uninstall [--config PATH]
      Stop and remove everything install created. Must run as root.

Flags:
`, version)
	flag.PrintDefaults()
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("")

	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	command := os.Args[1]
	rest := os.Args[2:]

	// apply-update is the detached helper's private entry point. It takes
	// flags no operator command shares, so it gets its own parser before the
	// common one below.
	if command == "apply-update" {
		apply := flag.NewFlagSet(command, flag.ContinueOnError)
		newPath := apply.String("new", "", "staged binary to install")
		target := apply.String("target", "", "binary to replace")
		backup := apply.String("backup", "", "where to keep the previous binary")
		service := apply.String("service", systemdUnitName, "systemd unit to restart")
		expect := apply.String("expect", "", "version the staged binary must report")
		logPath := apply.String("log", "", "append the helper's log to this file")
		if err := apply.Parse(rest); err != nil {
			os.Exit(2)
		}
		if err := cmdApplyUpdate(*newPath, *target, *backup, *service, *expect, *logPath); err != nil {
			log.Fatalf("superboard: %v", err)
		}
		return
	}

	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	configPath := fs.String("config", DefaultConfigPath, "path to config.json")
	server := fs.String("server", "", "Flatline origin, e.g. https://uptime.mediaboost.kz")
	token := fs.String("token", "", "monitor push token")
	interval := fs.Int("interval", 0, "seconds between live samples (default 1)")
	insecure := fs.Bool("insecure", false, "allow plain HTTP (not recommended)")
	verbose := fs.Bool("verbose", false, "print the collected payload on check")
	check := fs.Bool("check", false, "for self-update: only report, do not install")

	if err := fs.Parse(rest); err != nil {
		os.Exit(2)
	}

	switch command {
	case "run":
		{
			cfg, err := loadConfig(*configPath)
			if err != nil {
				log.Fatalf("superboard: %v", err)
			}
			if err := runLoop(cfg); err != nil {
				log.Fatalf("superboard: %v", err)
			}
		}
	case "check":
		{
			cfg, err := loadConfig(*configPath)
			if err != nil {
				log.Fatalf("superboard: %v", err)
			}
			if err := runOnce(cfg, *verbose); err != nil {
				log.Fatalf("superboard: %v", err)
			}
		}
	case "self-update":
		{
			cfg, err := loadConfig(*configPath)
			if err != nil {
				log.Fatalf("superboard: %v", err)
			}
			if *check {
				manifest, asset, err := checkForUpdate(context.Background(), cfg)
				if err != nil {
					log.Fatalf("superboard: %v", err)
				}
				if asset == nil {
					fmt.Printf("superboard %s: no update available (server ships %s)\n", version, manifest.Version)
					return
				}
				fmt.Printf("superboard %s: update available -> %s (%s)\n", version, manifest.Version, asset.File)
				return
			}
			if err := selfUpdateOnce(context.Background(), cfg); err != nil {
				log.Fatalf("superboard: %v", err)
			}
			fmt.Printf("superboard %s: no update applied (current, or no build for %s)\n", version, platformID())
		}
	case "install":
		if *server == "" || *token == "" {
			log.Fatalf("superboard: install requires --server and --token")
		}
		if err := cmdInstall(*configPath, *server, *token, *interval, *insecure); err != nil {
			log.Fatalf("superboard: %v", err)
		}
	case "uninstall":
		if err := cmdUninstall(*configPath); err != nil {
			log.Fatalf("superboard: %v", err)
		}
	case "version":
		fmt.Printf("superboard %s\n", version)
	case "features":
		// Hidden: capabilities an update helper may rely on.
		fmt.Println(strings.Join(agentFeatures, " "))
	case "refresh-unit":
		// Hidden: rewrite an existing systemd unit to this build's template
		// (used by install.sh --update and the update helper).
		if err := cmdRefreshUnit(); err != nil {
			log.Fatalf("superboard: %v", err)
		}
	default:
		fmt.Fprintf(os.Stderr, "superboard: unknown command %q\n\n", command)
		usage()
		os.Exit(2)
	}
}
