package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

const version = "0.3.0"

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
	case "verify":
		return runVerify(args[1:])
	case "restore":
		return runRestore(args[1:])
	case "compare":
		return runCompare(args[1:])
	case "restore-globals":
		return runRestoreGlobals(args[1:])
	case "keygen":
		return runKeygen(args[1:])
	case "self-update":
		return runSelfUpdate(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", args[0])
		usage()
		return 2
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: flatline-backup <check|run-once|install|self-update|verify|restore|compare|restore-globals|keygen|version> [flags]")
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
	encryption := "off (plain tar bundles)"
	if cfg.Encrypted() {
		encryption = "on (age)"
	}
	fmt.Printf("ok: %s (%d postgres, %d s3 sources, encryption %s)\n", cfg.Name, len(cfg.Postgres), len(cfg.S3), encryption)
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
	refresh := flags.Bool("refresh-units", false, "re-render every installed instance's units and the self-update units")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *refresh {
		if *configPath != "" || *enableTimer || flags.NArg() > 0 {
			fmt.Fprintln(os.Stderr, "install --refresh-units takes no other flags")
			return 2
		}
		if err := RefreshUnits(installOptions{systemctl: runSystemctl}); err != nil {
			fmt.Fprintf(os.Stderr, "refresh failed: %v\n", err)
			return 1
		}
		fmt.Println("units refreshed")
		return 0
	}
	if *configPath == "" || flags.NArg() > 0 {
		fmt.Fprintln(os.Stderr, "install needs --config FILE [--enable-timer], or --refresh-units")
		return 2
	}
	if err := InstallInstance(*configPath, *enableTimer); err != nil {
		fmt.Fprintf(os.Stderr, "install failed: %v\n", err)
		return 1
	}
	if *enableTimer {
		fmt.Println("installed; daily timer enabled and started (systemctl list-timers shows the next run)")
	} else {
		fmt.Println("installed; daily backup timer left disabled; self-update timer enabled")
	}
	return 0
}

func runSelfUpdate(args []string) int {
	if len(args) > 0 {
		fmt.Fprintln(os.Stderr, "self-update takes no flags")
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	status, err := SelfUpdate(ctx, updateOptions{})
	if err != nil {
		fmt.Fprintf(os.Stderr, "self-update: %s: %v\n", status, err)
	}
	if status != updateOK {
		return 1
	}
	fmt.Printf("self-update: %s (running %s)\n", status, version)
	return 0
}

func bundleFlags(name string, args []string, needTarget bool) (string, string, string, error) {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	bundle := flags.String("bundle", "", "path to the bundle (.tar or .age)")
	identity := flags.String("identity-file", "", "path to the age identity; needed only for an encrypted bundle")
	target := flags.String("target-config", "", "path to the scratch target configuration")
	if err := flags.Parse(args); err != nil {
		return "", "", "", err
	}
	if *bundle == "" || (needTarget && *target == "") {
		return "", "", "", fmt.Errorf("%s needs --bundle FILE [--identity-file FILE]%s", name, map[bool]string{true: " --target-config FILE"}[needTarget])
	}
	return *bundle, *identity, *target, nil
}

func runVerify(args []string) int {
	bundle, identity, _, err := bundleFlags("verify", args, false)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	verified, err := VerifyBundle(ctx, bundle, identity)
	if err != nil {
		fmt.Fprintf(os.Stderr, "archive verification failed: %v\n", err)
		return 1
	}
	printJSON(map[string]any{
		"archiveVerified":  true,
		"agentName":        verified.Manifest.AgentName,
		"clientRunId":      verified.Manifest.ClientRunID,
		"exportStartedAt":  verified.Manifest.ExportStartedAt,
		"exportFinishedAt": verified.Manifest.ExportFinishedAt,
		"entries":          len(verified.Manifest.Entries),
	})
	return 0
}

func runRestore(args []string) int {
	bundle, identity, target, err := bundleFlags("restore", args, true)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	report, err := RestoreBundle(ctx, bundle, identity, target)
	printJSON(report)
	if err != nil {
		fmt.Fprintf(os.Stderr, "restore failed: %v\n", err)
		return 1
	}
	if report.RestoreStatus != "passed" {
		fmt.Fprintln(os.Stderr, "restore did not pass")
		return 1
	}
	return 0
}

func runCompare(args []string) int {
	bundle, identity, target, err := bundleFlags("compare", args, true)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	report, err := CompareRestore(ctx, bundle, identity, target)
	printJSON(report)
	if err != nil {
		fmt.Fprintf(os.Stderr, "comparison failed: %v\n", err)
		return 1
	}
	if report.RestoreStatus != "passed" {
		fmt.Fprintln(os.Stderr, "comparison did not pass")
		return 1
	}
	return 0
}

func runRestoreGlobals(args []string) int {
	bundle, identity, target, err := bundleFlags("restore-globals", args, true)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	report, err := RestoreGlobals(ctx, bundle, identity, target)
	printJSON(report)
	if err != nil {
		fmt.Fprintf(os.Stderr, "globals restore failed: %v\n", err)
		return 1
	}
	if report.RestoreStatus != "passed" {
		fmt.Fprintln(os.Stderr, "globals restore did not pass")
		return 1
	}
	return 0
}

func runKeygen(args []string) int {
	flags := flag.NewFlagSet("keygen", flag.ContinueOnError)
	output := flags.String("output", "", "path for the private identity")
	if err := flags.Parse(args); err != nil || *output == "" {
		fmt.Fprintln(os.Stderr, "keygen needs --output FILE")
		return 2
	}
	recipient, err := GenerateIdentity(*output)
	if err != nil {
		fmt.Fprintf(os.Stderr, "keygen failed: %v\n", err)
		return 1
	}
	fmt.Println(recipient)
	return 0
}

func printJSON(value any) {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return
	}
	fmt.Println(string(encoded))
}
