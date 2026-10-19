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
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

var errRedirectRefused = errors.New("redirects are not followed")

type permanentError struct {
	status int
}

func (e *permanentError) Error() string {
	return fmt.Sprintf("server rejected the request with status %d", e.status)
}

var (
	errRunGone     = errors.New("run no longer accepts chunks")
	errRunTerminal = errors.New("server run is terminal and cannot be resumed")
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

	run, offset, err := client.start(ctx, bundle)
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
				run, offset, err = client.start(ctx, bundle)
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
		var permanent *permanentError
		if errors.As(err, &permanent) && permanent.status == http.StatusConflict {
			return RunSummary{}, 0, errRunTerminal
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

		switch {
		case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
			return nil, &permanentError{status: response.StatusCode}
		case response.StatusCode == http.StatusNotFound:
			last = errRunGone
		case response.StatusCode == http.StatusConflict &&
			(strings.Contains(path, "/chunks/") || strings.HasSuffix(path, "/complete")):
			last = errRunGone
		case response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500:
			last = &permanentError{status: response.StatusCode}
		default:
			var envelope errorEnvelope
			_ = json.Unmarshal(data, &envelope)
			return nil, &permanentError{status: response.StatusCode}
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
