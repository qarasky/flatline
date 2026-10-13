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
	"flag"
	"fmt"
	"log"
	"os"
)

const version = "1.5.1"

func usage() {
	fmt.Fprintf(os.Stderr, `superboard %s — Flatline fleet agent

Usage:
  superboard run [--config PATH]
      Collect and push forever.
  superboard check [--config PATH] [--verbose]
      Collect and push once, printing the outcome. Exit 0 on accept.
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

	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	configPath := fs.String("config", DefaultConfigPath, "path to config.json")
	server := fs.String("server", "", "Flatline origin, e.g. https://uptime.mediaboost.kz")
	token := fs.String("token", "", "monitor push token")
	interval := fs.Int("interval", 0, "seconds between live samples (default 1)")
	insecure := fs.Bool("insecure", false, "allow plain HTTP (not recommended)")
	verbose := fs.Bool("verbose", false, "print the collected payload on check")

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
	default:
		fmt.Fprintf(os.Stderr, "superboard: unknown command %q\n\n", command)
		usage()
		os.Exit(2)
	}
}
