package integration

import (
	"archive/tar"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
)

// TestScratchBackendHTTP exercises the real receiver over HTTP with two
// isolated agents, then verifies the downloaded bundle offline. It is opt-in
// because it launches a backend process and owns a provisioned storage root.
func TestScratchBackendHTTP(t *testing.T) {
	if os.Getenv("FLATLINE_BACKUP_INTEGRATION") != "1" {
		t.Skip("set FLATLINE_BACKUP_INTEGRATION=1 to run the scratch HTTP integration")
	}
	backendBinary := os.Getenv("FLATLINE_BACKEND_BIN")
	if backendBinary == "" {
		t.Skip("FLATLINE_BACKEND_BIN prerequisite missing")
	}

	temp := t.TempDir()
	storage := filepath.Join(temp, "backups")
	if err := os.Mkdir(storage, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := make([]byte, 16)
	if _, err := rand.Read(marker); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(storage, ".flatline-backup-storage"), []byte(hex.EncodeToString(marker)), 0o600); err != nil {
		t.Fatal(err)
	}

	port := freePort(t)
	backend := exec.Command(backendBinary)
	backend.Env = append(os.Environ(),
		"DATA_DIR="+filepath.Join(temp, "data"),
		"PORT="+strconv.Itoa(port),
		"UPTIME_KUMA_HOST=127.0.0.1",
		"FLATLINE_WEB_DIST="+filepath.Join(temp, "no-web"),
		"FLATLINE_AGENT_DIR="+filepath.Join(temp, "agent"),
		"FLATLINE_BACKUP_DIR="+storage,
	)
	var logs bytes.Buffer
	backend.Stdout = &logs
	backend.Stderr = &logs
	if err := backend.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backend.Process.Kill(); _ = backend.Wait() })

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	waitForBackend(t, base)
	tokenBytes, err := os.ReadFile(filepath.Join(temp, "data", "initial-token.txt"))
	if err != nil {
		t.Fatalf("operator token: %v\n%s", err, logs.String())
	}
	operator := strings.TrimSpace(string(tokenBytes))

	identity, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	identityPath := filepath.Join(temp, "identity.txt")
	if err := os.WriteFile(identityPath, []byte(identity.String()+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bundlePath, bundleSize, bundleSHA, started, finished := makeHTTPBundle(t, identity.Recipient())
	bundleBytes, err := os.ReadFile(bundlePath)
	if err != nil {
		t.Fatal(err)
	}

	meks := createAgent(t, base, operator, "meks")
	zhkh := createAgent(t, base, operator, "zhkhteam")
	if meks["id"] == zhkh["id"] {
		t.Fatal("agents must have distinct identities")
	}

	meksRun := uploadBundle(t, base, meks["token"], "meks-run", bundleBytes, bundleSize, bundleSHA, started, finished)
	zhkhRun := uploadBundle(t, base, zhkh["token"], "zhkh-run", bundleBytes, bundleSize, bundleSHA, started, finished)

	if status, _ := getJSON(t, base+"/api/backup/v1/runs/"+meksRun, zhkh["token"]); status != http.StatusNotFound {
		t.Fatalf("cross-agent run read = %d", status)
	}
	if status, _ := getJSON(t, base+"/api/backup/v1/runs/"+meksRun, meks["token"]); status != http.StatusOK {
		t.Fatalf("owner run read = %d", status)
	}

	response, err := http.Get(base + "/api/v1/backup-runs/" + meksRun + "/download")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("download without operator token = %d", response.StatusCode)
	}
	request, _ := http.NewRequest(http.MethodGet, base+"/api/v1/backup-runs/"+meksRun+"/download", nil)
	request.Header.Set("Authorization", "Bearer "+operator)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	downloaded, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || !bytes.Equal(downloaded, bundleBytes) {
		t.Fatalf("download status=%d bytes=%d/%d", response.StatusCode, len(downloaded), len(bundleBytes))
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("download cache control = %q", response.Header.Get("Cache-Control"))
	}

	// Offline verification of the downloaded bundle, with no backend calls.
	downloadedPath := filepath.Join(temp, "downloaded.age")
	if err := os.WriteFile(downloadedPath, downloaded, 0o600); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(temp, "flatline-backup")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Dir = ".."
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build backup agent: %v\n%s", err, output)
	}
	verify := exec.Command(binary, "verify", "--bundle", downloadedPath, "--identity-file", identityPath)
	if output, err := verify.CombinedOutput(); err != nil {
		t.Fatalf("offline verify: %v\n%s", err, output)
	}

	_ = zhkhRun
}

func createAgent(t *testing.T, base, operator, name string) map[string]string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"name": name, "monitorId": nil})
	request, _ := http.NewRequest(http.MethodPost, base+"/api/v1/backup-agents", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+operator)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var decoded struct {
		Agent struct {
			ID string `json:"id"`
		} `json:"agent"`
		Token string `json:"token"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("create agent %s = %d", name, response.StatusCode)
	}
	return map[string]string{"id": decoded.Agent.ID, "token": decoded.Token}
}

func uploadBundle(t *testing.T, base, token, clientRunID string, data []byte, size int64, sha, started, finished string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"clientRunId": clientRunID, "exportStartedAt": started, "exportFinishedAt": finished,
		"totalBytes": size, "sha256": sha,
		"sourceSummary": map[string]any{"databaseCount": 0, "objectCount": 1, "sourceBytes": size},
	})
	request, _ := http.NewRequest(http.MethodPost, base+"/api/backup/v1/runs", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	decoded := decodeRun(t, response)
	runID := decoded["run"].(map[string]any)["id"].(string)

	offset := 0
	for offset < len(data) {
		length := len(data) - offset
		if length > 8<<20 {
			length = 8 << 20
		}
		chunk := data[offset : offset+length]
		sum := sha256.Sum256(chunk)
		request, _ := http.NewRequest(http.MethodPut,
			fmt.Sprintf("%s/api/backup/v1/runs/%s/chunks/%d", base, runID, offset/(8<<20)),
			bytes.NewReader(chunk))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("X-Backup-Offset", strconv.Itoa(offset))
		request.Header.Set("X-Backup-Sha256", hex.EncodeToString(sum[:]))
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = decodeRun(t, response)
		offset += length
	}

	request, _ = http.NewRequest(http.MethodPost, base+"/api/backup/v1/runs/"+runID+"/complete", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	decoded = decodeRun(t, response)
	if decoded["run"].(map[string]any)["status"] != "completed" {
		t.Fatalf("run did not complete: %v", decoded)
	}
	return runID
}

func decodeRun(t *testing.T, response *http.Response) map[string]any {
	t.Helper()
	defer response.Body.Close()
	var decoded map[string]any
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%v", response.StatusCode, decoded)
	}
	return decoded
}

func getJSON(t *testing.T, url, token string) (int, map[string]any) {
	t.Helper()
	request, _ := http.NewRequest(http.MethodGet, url, nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	return response.StatusCode, decoded
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port
}

func waitForBackend(t *testing.T, base string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		response, err := http.Get(base + "/api/v1/auth/setup")
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("scratch backend did not start")
}

func makeHTTPBundle(t *testing.T, recipient age.Recipient) (string, int64, string, string, string) {
	t.Helper()
	body := []byte("hello from the scratch HTTP integration")
	sum := sha256.Sum256(body)
	manifest := map[string]any{
		"formatVersion": 1, "clientRunId": "fixture-run", "agentName": "meks",
		"exportStartedAt": "2026-01-01T00:00:00Z", "exportFinishedAt": "2026-01-01T01:00:00Z",
		"postgres": []any{},
		"entries": []any{map[string]any{
			"path": "objects/000001", "kind": "object", "size": len(body),
			"sha256": hex.EncodeToString(sum[:]), "bucket": "fixture", "key": "k",
			"contentType": "text/plain",
		}},
	}
	encodedManifest, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "fixture.age")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := age.Encrypt(file, recipient)
	if err != nil {
		t.Fatal(err)
	}
	archive := tar.NewWriter(encrypted)
	for _, entry := range []struct {
		name string
		body []byte
	}{
		{"objects/000001", body},
		{"manifest.json", encodedManifest},
	} {
		header := &tar.Header{Name: entry.name, Mode: 0o600, Size: int64(len(entry.body)),
			ModTime: time.Unix(0, 0).UTC(), Typeflag: tar.TypeReg}
		if err := archive.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.Write(entry.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := encrypted.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cipherSum := sha256.Sum256(data)
	return path, int64(len(data)), hex.EncodeToString(cipherSum[:]), "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z"
}
