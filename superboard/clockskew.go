package main

import (
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Clock-skew detection against the server's Date header.
//
// The server is the clock authority, but it trusts the agent's sampledAt for
// backfilled history and silently falls back to receive time when sampledAt
// is more than five minutes in the future. An agent whose clock drifted (no
// NTP, a VM restored from a snapshot) therefore archives its backlog at the
// wrong times with nothing saying so. Every push response carries a Date
// header; comparing it with the midpoint of the request makes the drift
// visible: logged once per episode, and reported in the self-report.

const (
	// clockSkewWarn starts a logged skew episode.
	clockSkewWarn = 30 * time.Second
	// clockSkewClear ends it (hysteresis, so a skew hovering around the
	// threshold does not log on every push).
	clockSkewClear = 10 * time.Second
	// clockSkewReport is the smallest skew worth reporting: the Date header
	// has one-second resolution, so ±1-2s is measurement noise.
	clockSkewReport = 2 * time.Second
)

type clockSkew struct {
	seconds atomic.Int64 // last measured skew, local minus server

	mu     sync.Mutex
	warned bool
}

// clock is the process-wide skew tracker.
var clock clockSkew

// observe records one measurement from a response Date header. Positive
// skew means the local clock is ahead of the server.
func (c *clockSkew) observe(dateHeader string, sent, received time.Time) {
	server, err := http.ParseTime(dateHeader)
	if err != nil {
		return
	}
	local := sent.Add(received.Sub(sent) / 2)
	skew := local.Sub(server)
	c.seconds.Store(int64(skew.Round(time.Second) / time.Second))

	abs := skew.Abs()
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case !c.warned && abs >= clockSkewWarn:
		c.warned = true
		direction := "ahead of"
		if skew < 0 {
			direction = "behind"
		}
		log.Printf("warning: local clock is %s %s the server (Date header); sample times may be ignored by the server — check NTP", abs.Round(time.Second), direction)
	case c.warned && abs <= clockSkewClear:
		c.warned = false
		log.Printf("clock skew resolved (now %s)", skew.Round(time.Second))
	}
}

// reportSeconds is the skew for the self-report: 0 (omitted) while within
// measurement noise.
func (c *clockSkew) reportSeconds() int64 {
	s := c.seconds.Load()
	if time.Duration(max(s, -s))*time.Second < clockSkewReport {
		return 0
	}
	return s
}
