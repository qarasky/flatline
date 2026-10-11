package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// updatesInterval is how often the daemon refreshes pending-update counts.
// Package lists move slowly; checking every few hours is plenty, and each
// check only reads the local package database — it never fetches, installs,
// or modifies anything.
const updatesInterval = 4 * time.Hour

// updatesTimeout bounds any single package-manager invocation so a wedged
// subprocess cannot stall collection. The result is cached for hours, so a
// slow first check is cheap; a hung one must still die.
const updatesTimeout = 30 * time.Second

// collectUpdates counts pending OS package updates: totals only, never a
// package inventory (names and versions are recon the board does not need).
//
// Read-only by contract: apt uses simulation against existing lists,
// dnf/yum/pacman/apk only query. Best-effort like the GPU collector —
// unsupported distros and any failure yield an error and the caller omits
// the field, so unknown never presents as "fully updated".
func collectUpdates() (*Updates, error) {
	if total, security, ok := aptCheckUpdates(); ok {
		return &Updates{Total: total, Security: security}, nil
	}
	if total, security, ok := dnfCheckUpdates(); ok {
		return &Updates{Total: total, Security: security}, nil
	}
	if total, ok := pacmanCheckUpdates(); ok {
		return &Updates{Total: total}, nil
	}
	if total, ok := apkCheckUpdates(); ok {
		return &Updates{Total: total}, nil
	}
	return nil, fmt.Errorf("no supported package manager found")
}

// runQuery executes a read-only query command, returning stdout. A dnf-style
// exit code of 100 means "updates available" and is success, not failure.
func runQuery(ctx context.Context, accept100 bool, name string, args ...string) (string, bool) {
	path, err := exec.LookPath(name)
	if err != nil {
		return "", false
	}
	ctx, cancel := context.WithTimeout(ctx, updatesTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, args...).Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok && accept100 && exit.ExitCode() == 100 {
			return string(out), true
		}
		return "", false
	}
	return string(out), true
}

// parseAptCheck parses /usr/lib/update-notifier/apt-check output, which is
// "TOTAL;SECURITY" (e.g. "72;8"). This is the only apt source that exposes
// security severity; the simulation fallback below is total-only.
func parseAptCheck(out string) (total, security int, ok bool) {
	parts := strings.Split(strings.TrimSpace(out), ";")
	if len(parts) != 2 {
		return 0, 0, false
	}
	total, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
	security, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err1 != nil || err2 != nil || total < 0 || security < 0 || security > total {
		return 0, 0, false
	}
	return total, security, true
}

// countAptInst counts simulated upgrades: lines starting with "Inst ".
func countAptInst(out string) int {
	n := 0
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "Inst ") {
			n++
		}
	}
	return n
}

// aptCheckUpdates tries Ubuntu's update-notifier first (exact security
// count), then a read-only apt simulation (total only).
func aptCheckUpdates() (total, security int, ok bool) {
	ctx := context.Background()
	if out, ran := runQuery(ctx, false, "/usr/lib/update-notifier/apt-check"); ran {
		if total, security, ok := parseAptCheck(out); ok {
			return total, security, true
		}
	}
	// Simulation against existing lists: no fetch, no lock, no changes.
	out, ran := runQuery(ctx, false, "apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade")
	if !ran {
		return 0, 0, false
	}
	return countAptInst(out), 0, true
}

// dnfLine matches a "name.arch  version  repo" update line.
var dnfLine = regexp.MustCompile(`^\S+\.\S+\s+\S+`)

// countDNF counts check-update lines, skipping blanks and status chatter.
func countDNF(out string) int {
	n := 0
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "Last ") || strings.HasPrefix(line, "=") {
			continue
		}
		if dnfLine.MatchString(line) {
			n++
		}
	}
	return n
}

// dnfCheckUpdates queries dnf (or yum) for totals and, best-effort, the
// security subset via --security filtering. A failed security query degrades
// to total-only rather than failing the whole check.
func dnfCheckUpdates() (total, security int, ok bool) {
	ctx := context.Background()
	for _, mgr := range []string{"dnf", "yum"} {
		out, ran := runQuery(ctx, true, mgr, "-q", "check-update")
		if !ran {
			continue
		}
		total = countDNF(out)
		if sec, ran := runQuery(ctx, true, mgr, "-q", "--security", "check-update"); ran {
			security = countDNF(sec)
			if security > total {
				security = total
			}
		}
		return total, security, true
	}
	return 0, 0, false
}

// countLines counts non-blank lines: checkupdates and pacman -Qu both list
// one package per line ("pkg old -> new").
func countLines(out string) int {
	n := 0
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) != "" {
			n++
		}
	}
	return n
}

// pacmanCheckUpdates counts Arch updates. Severity is not exposed by the
// tooling, so this is total-only.
func pacmanCheckUpdates() (int, bool) {
	ctx := context.Background()
	if out, ran := runQuery(ctx, false, "checkupdates"); ran {
		return countLines(out), true
	}
	if out, ran := runQuery(ctx, false, "pacman", "-Qu"); ran {
		return countLines(out), true
	}
	return 0, false
}

// apkCheckUpdates counts Alpine upgrades via `apk version -l '<'`.
// Severity is not exposed; total-only.
func apkCheckUpdates() (int, bool) {
	ctx := context.Background()
	if out, ran := runQuery(ctx, false, "apk", "version", "-l", "<"); ran {
		return countLines(out), true
	}
	return 0, false
}

// logUpdatesWarning keeps a failed refresh visible in the journal without
// ever failing a push: unknown updates must read as unknown, not as zero.
func logUpdatesWarning(err error) {
	log.Printf("warning: updates check unavailable: %v", err)
}
