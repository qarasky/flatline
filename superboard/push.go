package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// pushClient posts metrics to Flatline.
type pushClient struct {
	http *http.Client
	cfg  *Config
	// now is the clock behind clock-skew measurement; tests replace it.
	now func() time.Time
}

// defaultPushTimeout bounds a one-shot push (`superboard check`) and is the
// drain timeout: a backlog push is not racing the next live sample, and a
// short timeout against a slow-but-working backend only produces
// duplicates (the server stored it, the agent gave up and re-sends).
const defaultPushTimeout = 30 * time.Second

func newPushClient(cfg *Config) *pushClient {
	return &pushClient{
		// Per-request deadlines come from the context; this is only a
		// backstop for a caller that forgot one.
		http: &http.Client{Timeout: 2 * defaultPushTimeout},
		cfg:  cfg,
		now:  time.Now,
	}
}

// pusher is what the delivery loop needs from a client; tests fake it.
type pusher interface {
	pushWithTimeout(payload *Payload, timeout time.Duration) error
}

// push sends one sample with the default timeout.
func (c *pushClient) push(payload *Payload) error {
	return c.pushWithTimeout(payload, defaultPushTimeout)
}

/**
 * Push one sample.
 *
 * Guardrails, in order of importance:
 * 1. Plain HTTP is refused unless explicitly allowed. Metrics (hostnames,
 *    container names, versions) are genuinely useful recon in cleartext.
 * 2. 400 is a validation failure: the server understood the payload and will
 *    never accept it (the heartbeat is still recorded). 413 is the transport
 *    body limit. Both are permanent for these bytes.
 * 3. 429 and 5xx are transient. The backend answers 503 with Retry-After for
 *    storage failures (a SQLite write lock held past busy_timeout), so those
 *    keep the sample and wait at least as long as asked.
 * 4. Auth/config answers (404 for an unknown or inactive token, 401/403)
 *    are neither: the payload is fine, the configuration is wrong. Those
 *    are classified separately so a queued backlog is kept, not deleted,
 *    while the operator fixes the token.
 */
func (c *pushClient) pushWithTimeout(payload *Payload, timeout time.Duration) error {
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

	if timeout <= 0 {
		timeout = defaultPushTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	sent := c.now()
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("push: %w", err)
	}
	defer resp.Body.Close()
	received := c.now()
	clock.observe(resp.Header.Get("Date"), sent, received)

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024))
	detail := fmt.Sprintf("%s: %s", resp.Status, strings.TrimSpace(string(respBody)))

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode == http.StatusBadRequest, resp.StatusCode == http.StatusRequestEntityTooLarge:
		return &pushRejectedError{msg: detail}
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden, resp.StatusCode == http.StatusNotFound:
		return &pushConfigError{msg: detail}
	default:
		// 429, 5xx and anything unexpected: transient, keep the sample.
		return &pushRetryError{
			status:     resp.StatusCode,
			retryAfter: parseRetryAfter(resp.Header, received),
			msg:        detail,
		}
	}
}

// pushRejectedError marks a payload the server will never accept: a 400
// (validation failure) or a 413 (transport body limit). Retrying is
// pointless for the same bytes, so the caller quarantines the sample instead
// of blocking everything behind it — within the quarantine cap.
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

// pushRetryError is a transient server answer (429, 503 and other 5xx). The
// sample is kept and retried; retryAfter is the server's Retry-After, zero
// when it sent none.
type pushRetryError struct {
	status     int
	retryAfter time.Duration
	msg        string
}

func (e *pushRetryError) Error() string {
	if e.retryAfter > 0 {
		return fmt.Sprintf("push: server returned %s (retry after %s)", e.msg, e.retryAfter)
	}
	return fmt.Sprintf("push: server returned %s", e.msg)
}
