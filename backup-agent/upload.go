package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const uploadChunkBytes = 8 * 1024 * 1024

// RunSummary is the server's run metadata as far as the uploader needs it.
type RunSummary struct {
	ID               string `json:"id"`
	AgentID          string `json:"agentId"`
	ClientRunID      string `json:"clientRunId"`
	Status           string `json:"status"`
	ReceivedBytes    int64  `json:"receivedBytes"`
	TotalBytes       *int64 `json:"totalBytes"`
	ExportStartedAt  string `json:"exportStartedAt"`
	ExportFinishedAt string `json:"exportFinishedAt"`
}

type runEnvelope struct {
	OK     bool       `json:"ok"`
	Run    RunSummary `json:"run"`
	Offset int64      `json:"offset"`
}

type errorEnvelope struct {
	OK                bool   `json:"ok"`
	Error             string `json:"error"`
	Message           string `json:"message"`
	ActiveRunID       string `json:"activeRunId"`
	ActiveClientRunID string `json:"activeClientRunId"`
}

var errRedirectRefused = errors.New("redirects are not followed")

// permanentError is a non-2xx answer. code is the server's
// machine-readable `error` field; the free-text message is never kept, so
// server-provided text cannot leak into logs or reports.
type permanentError struct {
	status int
	code   string
}

func (e *permanentError) Error() string {
	if e.code != "" {
		return fmt.Sprintf("server rejected the request with status %d (%s)", e.status, e.code)
	}
	return fmt.Sprintf("server rejected the request with status %d", e.status)
}

// activeRunError is a 409 active_run: another run of this agent is still
// uploading or finalizing on the server.
type activeRunError struct {
	runID       string
	clientRunID string
}

func (e *activeRunError) Error() string {
	return "another run of this agent is still uploading"
}

var (
	errRunGone     = errors.New("run no longer accepts chunks")
	errRunTerminal = errors.New("server run is terminal and cannot be resumed")
	errStartBusy   = errors.New("server refused the upload start with an unclassified conflict")
)

// Server conflict codes on POST /runs. Only the last two mean the local
// bundle can never be delivered under its clientRunId.
const (
	conflictActiveRun = "active_run"
	conflictParams    = "params_conflict"
	conflictTerminal  = "run_terminal"
)

// RetryPolicy is bounded and injectable for tests.
type RetryPolicy struct {
	Attempts int
	Base     time.Duration
	Max      time.Duration
	Sleep    func(context.Context, time.Duration) error
	Jitter   func(time.Duration) time.Duration
}

func defaultRetryPolicy() RetryPolicy {
	return RetryPolicy{
		Attempts: 4,
		Base:     time.Second,
		Max:      30 * time.Second,
		Sleep:    sleepContext,
		Jitter:   jitter,
	}
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func jitter(duration time.Duration) time.Duration {
	factor := 0.5 + rand.Float64()
	return time.Duration(float64(duration) * factor)
}

// UploadClient talks to the agent upload API with a dedicated credential.
type UploadClient struct {
	baseURL        string
	token          string
	http           *http.Client
	retry          RetryPolicy
	bytesPerSecond int64
}

func newUploadClient(cfg Config) (*UploadClient, error) {
	tokenBytes, err := os.ReadFile(cfg.TokenFile)
	if err != nil {
		return nil, fmt.Errorf("read token file: %w", err)
	}
	token := strings.TrimSpace(string(tokenBytes))
	if token == "" {
		return nil, errors.New("token file is empty")
	}

	return &UploadClient{
		baseURL: strings.TrimRight(cfg.ServerURL, "/") + "/api/backup/v1",
		token:   token,
		http: &http.Client{
			Timeout: 2 * time.Minute,
			CheckRedirect: func(request *http.Request, via []*http.Request) error {
				return errRedirectRefused
			},
		},
		retry:          defaultRetryPolicy(),
		bytesPerSecond: cfg.UploadBytesPerSecond,
	}, nil
}

// UploadBundle delivers one encrypted bundle, resuming at the server's
// committed offset. It never re-exports or changes the manifest times.
func UploadBundle(ctx context.Context, cfg Config, bundle Bundle) (RunSummary, error) {
	client, err := newUploadClient(cfg)
	if err != nil {
		return RunSummary{}, err
	}
	return uploadBundleWith(ctx, client, bundle)
}

func uploadBundleWith(ctx context.Context, client *UploadClient, bundle Bundle) (RunSummary, error) {
	if bundle.Size <= 0 || bundle.Size > maxBundleBytes {
		return RunSummary{}, errors.New("bundle size is outside the accepted range")
	}

	run, offset, err := client.startOrReleaseStale(ctx, bundle)
	if err != nil {
		return RunSummary{}, err
	}
	if run.Status == "completed" {
		return run, nil
	}
	if offset < 0 || offset > bundle.Size {
		return RunSummary{}, errors.New("server returned an invalid committed offset")
	}

	file, err := os.Open(bundle.Path)
	if err != nil {
		return RunSummary{}, fmt.Errorf("open bundle: %w", err)
	}
	defer file.Close()

	buffer := make([]byte, uploadChunkBytes)
	restarted := false
	for offset < bundle.Size {
		length := int64(len(buffer))
		if remaining := bundle.Size - offset; remaining < length {
			length = remaining
		}
		chunk := buffer[:length]
		if _, err := file.ReadAt(chunk, offset); err != nil {
			return RunSummary{}, fmt.Errorf("read bundle: %w", err)
		}
		digest := sha256.Sum256(chunk)
		index := offset / uploadChunkBytes

		if err := client.throttle(ctx, length); err != nil {
			return RunSummary{}, err
		}
		nextRun, next, err := client.putChunk(ctx, run.ID, index, offset, hex.EncodeToString(digest[:]), chunk)
		if err != nil {
			if errors.Is(err, errRunGone) && !restarted {
				restarted = true
				run, offset, err = client.startOrReleaseStale(ctx, bundle)
				if err != nil {
					return RunSummary{}, err
				}
				continue
			}
			return RunSummary{}, err
		}
		if next != offset+length {
			return RunSummary{}, fmt.Errorf("server advanced to unexpected offset %d", next)
		}
		run = nextRun
		offset = next
	}

	completed, err := client.complete(ctx, run.ID)
	if err != nil {
		return RunSummary{}, err
	}
	if completed.Status != "completed" {
		return RunSummary{}, errors.New("server did not confirm completion")
	}
	return completed, nil
}

func (c *UploadClient) throttle(ctx context.Context, bytes int64) error {
	if c.bytesPerSecond <= 0 {
		return nil
	}
	wait := time.Duration(float64(bytes) / float64(c.bytesPerSecond) * float64(time.Second))
	if wait <= 0 {
		return nil
	}
	// The uploader reads one bounded chunk at a time; rate limiting sleeps
	// rather than allocating another bundle-sized buffer.
	return sleepContext(ctx, wait)
}

// startOrReleaseStale starts (or resumes) the bundle's run. When the
// server reports another active run of this agent with a different
// clientRunId, this instance no longer holds that run's bundle (there is at
// most one pending bundle per instance), so it can never be completed: the
// agent abandons it once and retries the start. That run's reservation is
// released immediately instead of after the 48-hour expiry.
func (c *UploadClient) startOrReleaseStale(ctx context.Context, bundle Bundle) (RunSummary, int64, error) {
	run, offset, err := c.start(ctx, bundle)
	var active *activeRunError
	if !errors.As(err, &active) {
		return run, offset, err
	}
	if active.runID == "" || active.clientRunID == bundle.ClientRunID {
		return RunSummary{}, 0, err
	}
	if abandonErr := c.abandon(ctx, active.runID); abandonErr != nil {
		return RunSummary{}, 0, fmt.Errorf("release stale active run: %w", abandonErr)
	}
	return c.start(ctx, bundle)
}

func (c *UploadClient) abandon(ctx context.Context, runID string) error {
	path := fmt.Sprintf("/runs/%s/abandon", url.PathEscape(runID))
	_, err := c.request(ctx, http.MethodPost, path, nil, nil)
	return err
}

func (c *UploadClient) start(ctx context.Context, bundle Bundle) (RunSummary, int64, error) {
	body, err := json.Marshal(map[string]any{
		"clientRunId":      bundle.ClientRunID,
		"exportStartedAt":  bundle.ExportStartedAt,
		"exportFinishedAt": bundle.ExportFinishedAt,
		"totalBytes":       bundle.Size,
		"sha256":           bundle.SHA256,
		"sourceSummary":    bundle.Summary,
	})
	if err != nil {
		return RunSummary{}, 0, err
	}
	data, err := c.request(ctx, http.MethodPost, "/runs", body, map[string]string{"Content-Type": "application/json"})
	if err != nil {
		var active *activeRunError
		if errors.As(err, &active) {
			return RunSummary{}, 0, err
		}
		var permanent *permanentError
		if errors.As(err, &permanent) && permanent.status == http.StatusConflict {
			switch permanent.code {
			case conflictTerminal, conflictParams:
				return RunSummary{}, 0, errRunTerminal
			default:
				// Unknown or generic conflicts are never a reason to
				// quarantine a valid bundle; the next run retries.
				return RunSummary{}, 0, errStartBusy
			}
		}
		return RunSummary{}, 0, err
	}
	var envelope runEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil || !envelope.OK || envelope.Run.ID == "" {
		return RunSummary{}, 0, errors.New("invalid run response")
	}
	offset := envelope.Offset
	if offset == 0 && envelope.Run.ReceivedBytes > 0 {
		offset = envelope.Run.ReceivedBytes
	}
	return envelope.Run, offset, nil
}

func (c *UploadClient) putChunk(ctx context.Context, runID string, index, offset int64, digest string, chunk []byte) (RunSummary, int64, error) {
	headers := map[string]string{
		"X-Backup-Offset": strconv.FormatInt(offset, 10),
		"X-Backup-Sha256": digest,
	}
	path := fmt.Sprintf("/runs/%s/chunks/%d", url.PathEscape(runID), index)
	data, err := c.request(ctx, http.MethodPut, path, chunk, headers)
	if err != nil {
		return RunSummary{}, 0, err
	}
	var envelope runEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil || !envelope.OK || envelope.Run.ID == "" {
		return RunSummary{}, 0, &permanentError{status: http.StatusBadGateway}
	}
	next := envelope.Offset
	if next == 0 && envelope.Run.ReceivedBytes > 0 {
		next = envelope.Run.ReceivedBytes
	}
	return envelope.Run, next, nil
}

func (c *UploadClient) complete(ctx context.Context, runID string) (RunSummary, error) {
	path := fmt.Sprintf("/runs/%s/complete", url.PathEscape(runID))
	data, err := c.request(ctx, http.MethodPost, path, nil, nil)
	if err != nil {
		return RunSummary{}, err
	}
	var envelope runEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil || !envelope.OK || envelope.Run.ID == "" {
		return RunSummary{}, errors.New("invalid completion response")
	}
	return envelope.Run, nil
}

func (c *UploadClient) reportFailure(ctx context.Context, clientRunID, exportStartedAt, code string) error {
	body, err := json.Marshal(map[string]string{
		"clientRunId":     clientRunID,
		"exportStartedAt": exportStartedAt,
		"code":            code,
	})
	if err != nil {
		return err
	}
	_, err = c.request(ctx, http.MethodPost, "/failures", body, map[string]string{"Content-Type": "application/json"})
	return err
}

func (c *UploadClient) request(ctx context.Context, method, path string, body []byte, headers map[string]string) ([]byte, error) {
	var last error
	for attempt := 1; attempt <= c.retry.Attempts; attempt++ {
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}
		request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
		if err != nil {
			return nil, errors.New("build upload request")
		}
		request.Header.Set("Authorization", "Bearer "+c.token)
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		if body != nil && request.Header.Get("Content-Type") == "" {
			request.Header.Set("Content-Type", "application/octet-stream")
		}

		response, err := c.http.Do(request)
		if err != nil {
			if errors.Is(err, errRedirectRefused) {
				return nil, errRedirectRefused
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			last = errors.New("server unreachable")
			if attempt < c.retry.Attempts {
				if err := c.retry.Sleep(ctx, c.backoff(attempt)); err != nil {
					return nil, err
				}
				continue
			}
			break
		}

		data, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		_ = response.Body.Close()
		if readErr != nil {
			last = errors.New("server response could not be read")
			if attempt < c.retry.Attempts {
				if err := c.retry.Sleep(ctx, c.backoff(attempt)); err != nil {
					return nil, err
				}
				continue
			}
			break
		}

		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return data, nil
		}

		var envelope errorEnvelope
		_ = json.Unmarshal(data, &envelope)
		code := safeErrorCode(envelope.Error)

		switch {
		case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
			return nil, &permanentError{status: response.StatusCode, code: code}
		case response.StatusCode == http.StatusNotFound:
			last = errRunGone
		case response.StatusCode == http.StatusConflict &&
			(strings.Contains(path, "/chunks/") || strings.HasSuffix(path, "/complete")):
			last = errRunGone
		case response.StatusCode == http.StatusConflict && code == conflictActiveRun:
			return nil, &activeRunError{runID: envelope.ActiveRunID, clientRunID: envelope.ActiveClientRunID}
		case response.StatusCode == http.StatusRequestTimeout ||
			response.StatusCode == http.StatusTooManyRequests ||
			response.StatusCode >= 500:
			// 503 includes a backend that could not check the credential
			// (database unavailable): retry, never treat it as revoked.
			last = &permanentError{status: response.StatusCode, code: code}
		default:
			return nil, &permanentError{status: response.StatusCode, code: code}
		}

		if attempt < c.retry.Attempts {
			wait := c.backoff(attempt)
			if retryAfter := response.Header.Get("Retry-After"); retryAfter != "" {
				wait = retryAfterDuration(retryAfter, c.retry.Max)
			}
			if err := c.retry.Sleep(ctx, wait); err != nil {
				return nil, err
			}
		}
	}
	if last == nil {
		last = errors.New("upload failed")
	}
	return nil, last
}

func (c *UploadClient) backoff(attempt int) time.Duration {
	wait := c.retry.Base
	for index := 1; index < attempt; index++ {
		wait *= 2
		if wait >= c.retry.Max {
			return c.retry.Max
		}
	}
	if c.retry.Jitter != nil {
		wait = c.retry.Jitter(wait)
	}
	if wait > c.retry.Max {
		wait = c.retry.Max
	}
	return wait
}

// safeErrorCode keeps only a short lowercase identifier from the server's
// `error` field.
func safeErrorCode(value string) string {
	if len(value) == 0 || len(value) > 32 {
		return ""
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && character != '_' {
			return ""
		}
	}
	return value
}

func retryAfterDuration(value string, maximum time.Duration) time.Duration {
	if seconds, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
		wait := time.Duration(seconds) * time.Second
		if wait > maximum {
			return maximum
		}
		return wait
	}
	if when, err := http.ParseTime(value); err == nil {
		wait := time.Until(when)
		if wait < 0 {
			return 0
		}
		if wait > maximum {
			return maximum
		}
		return wait
	}
	return maximum
}
