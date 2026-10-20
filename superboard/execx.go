package main

import (
	"context"
	"log"
	"os/exec"
	"sync"
	"time"
)

// commandWaitDelay bounds how long Wait keeps reading a child's output after
// the child exited or its context expired. Without it, a grandchild that
// inherited stdout (a package manager spawning a helper, a wedged driver
// tool) keeps the pipe open and Output() never returns, hanging the worker
// that called it forever even though the context deadline already fired.
var commandWaitDelay = 2 * time.Second

// boundedCommand is exec.CommandContext with WaitDelay set. Every external
// command the agent runs goes through it, always with a deadline-carrying
// context.
func boundedCommand(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = commandWaitDelay
	return cmd
}

// episodeLog logs a persistent failure once per episode instead of once per
// tick: the first failure for a key is logged, repeats are suppressed until
// the key succeeds again, and the recovery is logged too. A broken mount, an
// unreachable Docker daemon or a full disk used to write one journal line
// every 1-30 seconds for as long as it lasted.
type episodeLog struct {
	mu      sync.Mutex
	failing map[string]bool
}

// fail logs the failure if key is not already in a failing episode. It
// reports whether the line was logged.
func (e *episodeLog) fail(key, format string, args ...any) bool {
	e.mu.Lock()
	if e.failing == nil {
		e.failing = make(map[string]bool)
	}
	if e.failing[key] {
		e.mu.Unlock()
		return false
	}
	e.failing[key] = true
	e.mu.Unlock()
	log.Printf(format, args...)
	return true
}

// ok ends key's failing episode, logging the recovery when there was one.
func (e *episodeLog) ok(key, format string, args ...any) {
	e.mu.Lock()
	was := e.failing[key]
	delete(e.failing, key)
	e.mu.Unlock()
	if was && format != "" {
		log.Printf(format, args...)
	}
}

// prune forgets keys keep rejects (containers or mounts that are gone), so
// the map cannot grow with churn.
func (e *episodeLog) prune(keep func(key string) bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for key := range e.failing {
		if !keep(key) {
			delete(e.failing, key)
		}
	}
}

// size reports how many keys are in a failing episode (tests).
func (e *episodeLog) size() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.failing)
}
