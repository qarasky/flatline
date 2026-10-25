package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
)

// Release is what the Flatline server ships of the backup agent, as
// answered by a self-update check-in. Version is empty when the image
// ships no backup-agent build.
type Release struct {
	Version string         `json:"version"`
	Assets  []ReleaseAsset `json:"assets"`
}

// ReleaseAsset is one platform build: download it from
// /api/backup/v1/release/<File> and verify Size and SHA256 before use.
type ReleaseAsset struct {
	Platform string `json:"platform"`
	File     string `json:"file"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
}

// platformID names this build's target the way release assets do.
func platformID() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}

// checkin reports the running version (and the host's last update outcome,
// sent as null when empty so the server keeps its stored value) and returns
// the release the server ships.
func (c *UploadClient) checkin(ctx context.Context, platform, updateStatus string) (Release, error) {
	var status any
	if updateStatus != "" {
		status = updateStatus
	}
	body, err := json.Marshal(map[string]any{
		"version":      version,
		"platform":     platform,
		"updateStatus": status,
	})
	if err != nil {
		return Release{}, err
	}
	data, err := c.request(ctx, http.MethodPost, "/checkin", body, map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return Release{}, err
	}
	var envelope struct {
		Release Release `json:"release"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return Release{}, fmt.Errorf("parse check-in response: %w", err)
	}
	return envelope.Release, nil
}
