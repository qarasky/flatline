package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

const version = "0.1.0"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		usage()
		return 2
	}

	switch args[0] {
	case "version":
		fmt.Printf("flatline-backup %s\n", version)
		return 0
	case "check":
		return runCheck(args[1:])
	case "run-once":
		return runOnceCommand(args[1:])
	case "install":
		return runInstall(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", args[0])
		usage()
		return 2
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: flatline-backup <check|run-once|install|version> [flags]")
}

func configFlag(name string, args []string) (string, []string, error) {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	configPath := flags.String("config", "", "path to the instance configuration")
	if err := flags.Parse(args); err != nil {
		return "", nil, err
	}
	if *configPath == "" {
		return "", nil, fmt.Errorf("%s needs --config FILE", name)
	}
	return *configPath, flags.Args(), nil
}

func runCheck(args []string) int {
	configPath, rest, err := configFlag("check", args)
	if err != nil || len(rest) > 0 {
		fmt.Fprintln(os.Stderr, "check needs exactly --config FILE")
		return 2
	}
	cfg, err := LoadConfig(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "configuration invalid: %v\n", err)
		return 1
	}
	fmt.Printf("ok: %s (%d postgres, %d s3 sources)\n", cfg.Name, len(cfg.Postgres), len(cfg.S3))
	return 0
}

func runOnceCommand(args []string) int {
	configPath, rest, err := configFlag("run-once", args)
	if err != nil || len(rest) > 0 {
		fmt.Fprintln(os.Stderr, "run-once needs exactly --config FILE")
		return 2
	}
	cfg, err := LoadConfig(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "configuration invalid: %v\n", err)
		return 1
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := RunOnce(ctx, cfg); err != nil {
		fmt.Fprintf(os.Stderr, "backup failed: %v\n", err)
		return 1
	}
	fmt.Printf("backup completed: %s\n", cfg.Name)
	return 0
}

func runInstall(args []string) int {
	flags := flag.NewFlagSet("install", flag.ContinueOnError)
	configPath := flags.String("config", "", "path to the instance configuration")
	enableTimer := flags.Bool("enable-timer", false, "enable the daily systemd timer")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *configPath == "" || flags.NArg() > 0 {
		fmt.Fprintln(os.Stderr, "install needs --config FILE [--enable-timer]")
		return 2
	}
	if err := InstallInstance(*configPath, *enableTimer); err != nil {
		fmt.Fprintf(os.Stderr, "install failed: %v\n", err)
		return 1
	}
	if *enableTimer {
		fmt.Println("installed; daily timer enabled")
	} else {
		fmt.Println("installed; daily timer left disabled")
	}
	return 0
}
