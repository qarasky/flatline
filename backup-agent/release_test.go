package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"testing"
)

func TestStartSendsAgentVersion(t *testing.T) {
	fake := newFakeUploadServer(t)
	client := testUploadClient(t, fake.server.URL)
	if _, err := uploadBundleWith(context.Background(), client, makeBundle(t, 1024)); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.starts) == 0 || fake.starts[0]["agentVersion"] != version {
		t.Fatalf("start body must carry agentVersion %q: %+v", version, fake.starts)
	}
}

// checkinServer answers the server's check-in shape and records bodies.
func checkinServer(t *testing.T, release string) (*httptest.Server, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	bodies := []map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/backup/v1/checkin" {
			http.NotFound(w, r)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		bodies = append(bodies, body)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(release))
	}))
	t.Cleanup(server.Close)
	return server, &bodies
}

func TestCheckinParsesRelease(t *testing.T) {
	server, bodies := checkinServer(t, `{"ok":true,"release":{"version":"0.3.0","assets":[
		{"platform":"linux-amd64","file":"flatline-backup-linux-amd64","size":10,"sha256":"`+
		"ab"+`"}]}}`)
	client := testUploadClient(t, server.URL)

	release, err := client.checkin(context.Background(), "linux-amd64", "ok")
	if err != nil {
		t.Fatal(err)
	}
	if release.Version != "0.3.0" || len(release.Assets) != 1 {
		t.Fatalf("release = %+v", release)
	}
	asset := release.Assets[0]
	if asset.Platform != "linux-amd64" || asset.File != "flatline-backup-linux-amd64" || asset.Size != 10 || asset.SHA256 != "ab" {
		t.Fatalf("asset = %+v", asset)
	}
	sent := (*bodies)[0]
	if sent["version"] != version || sent["platform"] != "linux-amd64" || sent["updateStatus"] != "ok" {
		t.Fatalf("check-in body = %+v", sent)
	}
}

func TestCheckinSendsNullStatusWhenEmpty(t *testing.T) {
	server, bodies := checkinServer(t, `{"ok":true,"release":{"version":null,"assets":[]}}`)
	client := testUploadClient(t, server.URL)

	release, err := client.checkin(context.Background(), "linux-amd64", "")
	if err != nil {
		t.Fatal(err)
	}
	if release.Version != "" || len(release.Assets) != 0 {
		t.Fatalf("an image without a release offers nothing: %+v", release)
	}
	sent := (*bodies)[0]
	status, present := sent["updateStatus"]
	if !present || status != nil {
		t.Fatalf("an empty status must be sent as null, got %+v", sent)
	}
}

func TestPlatformIDMatchesRuntime(t *testing.T) {
	if got, want := platformID(), runtime.GOOS+"-"+runtime.GOARCH; got != want {
		t.Fatalf("platformID() = %q, want %q", got, want)
	}
}
