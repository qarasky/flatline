package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"time"
)

// pushClient posts metrics to Flatline.
type pushClient struct {
	http *http.Client
	cfg  *Config
}

func newPushClient(cfg *Config) *pushClient {
	return &pushClient{
		http: &http.Client{Timeout: 30 * time.Second},
		cfg:  cfg,
	}
}

/**
 * Push one sample.
 *
 * Guardrails, in order of importance:
 * 1. Plain HTTP is refused unless explicitly allowed. Metrics (hostnames,
 *    container names, versions) are genuinely useful recon in cleartext.
 * 2. The server answers 400 for a bad metrics payload while still recording
 *    the heartbeat, so a 400 here means "fix the collector", never "the host
 *    is down". Do not retry a 400: it will fail identically next tick.
 * 3. A 413 means the transport body limit rejected this payload; like a 400
 *    it can never succeed on retry.
 * 4. Auth/config answers (404 for an unknown or inactive token, 401/403)
 *    are neither: the payload is fine, the configuration is wrong. Those
 *    are classified separately so a queued backlog is kept, not deleted,
 *    while the operator fixes the token.
 */
func (c *pushClient) push(payload *Payload) error {
	server := strings.TrimRight(c.cfg.ServerURL, "/")

	if strings.HasPrefix(server, "http://") && !c.cfg.AllowInsecure {
		return fmt.Errorf("refusing plain HTTP to %s (set allow_insecure to override)", server)
	}

	url := fmt.Sprintf("%s/api/push/%s", server, c.cfg.PushToken)
	if payload.SampleInterval > 0 {
		url += "?telemetry=1"
	}

	body, err := json.Marshal(map[string]any{
		"status":  "up",
		"msg":     "OK",
		"metrics": payload,
	})
	if err != nil {
		return fmt.Errorf("encode payload: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("push: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024))

	switch resp.StatusCode {
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge:
		return &pushRejectedError{msg: fmt.Sprintf("%s: %s", resp.Status, strings.TrimSpace(string(respBody)))}
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
		return &pushConfigError{msg: fmt.Sprintf("%s: %s", resp.Status, strings.TrimSpace(string(respBody)))}
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("push: server returned %s: %s", resp.Status, strings.TrimSpace(string(respBody)))
	}

	return nil
}

// pushRejectedError marks a payload the server will never accept: a 400
// (understood and refused) or a 413 (transport body limit). Retrying is
// pointless for the same bytes, so the caller discards or quarantines the
// sample instead of blocking everything behind it.
type pushRejectedError struct {
	msg string
}

func (e *pushRejectedError) Error() string {
	return fmt.Sprintf("server rejected payload: %s", e.msg)
}

// pushConfigError marks an authentication or configuration problem: an
// unknown/inactive push token (404), or an auth answer (401/403). The
// payload is fine; the agent's configuration is not. The backlog must be
// kept — fixing the token should deliver the history that accumulated while
// it was wrong — and the failure must be visible rather than silent.
type pushConfigError struct {
	msg string
}

func (e *pushConfigError) Error() string {
	return fmt.Sprintf("server refused the push token/configuration: %s", e.msg)
}

// pushWithBackoff tries a push, retrying transient failures with capped
// exponential backoff. A rejection (400/413) is returned immediately: it
// will fail identically on retry. A configuration error is retried — the
// token may be fixed while the agent waits.
//
// A failed push is not reported as host-down locally. Silence is the signal,
// and the server already turns sustained silence into an alert.
func pushWithBackoff(client *pushClient, payload *Payload, maxElapsed time.Duration) error {
	wait := 2 * time.Second
	start := time.Now()

	for {
		err := client.push(payload)
		if err == nil {
			return nil
		}

		var rejected *pushRejectedError
		if errors.As(err, &rejected) {
			return err
		}

		if time.Since(start)+wait > maxElapsed {
			return fmt.Errorf("push failed after retries: %w", err)
		}

		// Jitter the wait so a fleet-wide outage does not retry in lockstep.
		jitter := time.Duration(rand.Int63n(int64(wait / 2)))
		time.Sleep(wait + jitter)

		wait *= 2
		if wait > 30*time.Second {
			wait = 30 * time.Second
		}
	}
}
