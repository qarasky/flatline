// Package integration proves the backup/restore path against real Docker
// services. It is opt-in: without FLATLINE_BACKUP_INTEGRATION=1 it skips, and
// a missing image is reported as a skipped prerequisite, never as a pass.
package integration

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

func TestPostgres16AndGarageRoundTrip(t *testing.T) {
	if os.Getenv("FLATLINE_BACKUP_INTEGRATION") != "1" {
		t.Skip("set FLATLINE_BACKUP_INTEGRATION=1 to run Docker/Garage integration")
	}

	t.Run("postgres16", func(t *testing.T) {
		testPostgresRoundTrip(t)
	})
	t.Run("garage", func(t *testing.T) {
		testGarageRoundTrip(t)
	})
}

type receiver struct {
	mu        sync.Mutex
	runID     string
	total     int64
	chunks    map[int64][]byte
	output    string
	completed bool
}

func (r *receiver) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if request.Header.Get("Authorization") != "Bearer integration-token" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	switch {
	case request.Method == http.MethodPost && request.URL.Path == "/api/backup/v1/runs":
		var body struct {
			TotalBytes int64 `json:"totalBytes"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		r.runID = "integration-run"
		r.total = body.TotalBytes
		r.chunks = make(map[int64][]byte)
		writeJSON(w, map[string]any{
			"ok": true,
			"run": map[string]any{
				"id": r.runID, "agentId": "integration-agent", "clientRunId": "integration",
				"status": "uploading", "receivedBytes": 0,
			},
			"offset": 0,
		})
	case request.Method == http.MethodPut && request.URL.Path != "":
		var offset int64
		fmt.Sscanf(request.Header.Get("X-Backup-Offset"), "%d", &offset)
		body, _ := io.ReadAll(request.Body)
		r.chunks[offset] = body
		received := int64(0)
		for start, chunk := range r.chunks {
			if start+int64(len(chunk)) > received {
				received = start + int64(len(chunk))
			}
		}
		writeJSON(w, map[string]any{
			"ok": true, "offset": received,
			"run": map[string]any{
				"id": r.runID, "status": "uploading", "receivedBytes": received,
			},
		})
	case request.Method == http.MethodPost && filepath.Base(request.URL.Path) == "complete":
		ordered := make([]byte, r.total)
		for start, chunk := range r.chunks {
			copy(ordered[start:], chunk)
		}
		if err := os.WriteFile(r.output, ordered, 0o600); err != nil {
			http.Error(w, "write", http.StatusInternalServerError)
			return
		}
		r.completed = true
		writeJSON(w, map[string]any{
			"ok": true,
			"run": map[string]any{
				"id": r.runID, "status": "completed", "receivedBytes": r.total,
			},
		})
	default:
		http.NotFound(w, request)
	}
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func testPostgresRoundTrip(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("Docker prerequisite missing")
	}
	if err := exec.Command("docker", "image", "inspect", "postgres:16").Run(); err != nil {
		t.Skip("postgres:16 image prerequisite missing; run `docker pull postgres:16`")
	}

	temp := t.TempDir()
	binary := filepath.Join(temp, "flatline-backup")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Dir = ".."
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}

	suffix := strconv.Itoa(os.Getpid())
	source := "flatline-it-src-" + suffix
	target := "flatline-it-dst-" + suffix
	runDocker(t, "run", "-d", "--rm", "--name", source, "-e", "POSTGRES_PASSWORD=postgres", "postgres:16")
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", source).Run() })
	runDocker(t, "run", "-d", "--rm", "--name", target, "-e", "POSTGRES_PASSWORD=postgres", "postgres:16")
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", target).Run() })
	waitForPostgres(t, source)
	waitForPostgres(t, target)

	runDocker(t, "exec", source, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c",
		"CREATE TABLE items (id integer PRIMARY KEY, name text); INSERT INTO items VALUES (1,'a'),(2,'b'),(3,'c');")
	runDocker(t, "exec", target, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c",
		"CREATE DATABASE restored;")

	received := filepath.Join(temp, "received.age")
	handler := &receiver{output: received}
	server := httptest.NewServer(handler)
	defer server.Close()

	identityPath := filepath.Join(temp, "identity.txt")
	keygen := exec.Command(binary, "keygen", "--output", identityPath)
	keyOutput, err := keygen.CombinedOutput()
	if err != nil {
		t.Fatalf("keygen: %v\n%s", err, keyOutput)
	}
	recipient := string(keyOutput)
	for len(recipient) > 0 && (recipient[len(recipient)-1] == '\n' || recipient[len(recipient)-1] == '\r') {
		recipient = recipient[:len(recipient)-1]
	}

	tokenPath := filepath.Join(temp, "agent.token")
	if err := os.WriteFile(tokenPath, []byte("integration-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(temp, "meks")
	configPath := filepath.Join(temp, "meks.json")
	config := map[string]any{
		"version":       1,
		"name":          "meks",
		"serverUrl":     server.URL,
		"tokenFile":     tokenPath,
		"recipient":     recipient,
		"stateDir":      stateDir,
		"spoolMaxBytes": int64(256 << 20),
		"postgres": []any{map[string]any{
			"container": source, "user": "postgres", "databases": []string{"postgres"},
			"includeGlobals": false,
		}},
		"s3": []any{},
	}
	writeJSONFile(t, configPath, config)

	run := exec.Command(binary, "run-once", "--config", configPath)
	if output, err := run.CombinedOutput(); err != nil {
		t.Fatalf("run-once: %v\n%s", err, output)
	}
	if _, err := os.Stat(received); err != nil {
		t.Fatalf("receiver did not get a bundle: %v", err)
	}

	verify := exec.Command(binary, "verify", "--bundle", received, "--identity-file", identityPath)
	if output, err := verify.CombinedOutput(); err != nil {
		t.Fatalf("offline verify: %v\n%s", err, output)
	}

	targetConfigPath := filepath.Join(temp, "target.json")
	targetConfig := map[string]any{
		"version": 1,
		"postgres": []any{map[string]any{
			"container": target, "user": "postgres",
			"databases": []any{map[string]string{"source": "postgres", "target": "restored"}},
		}},
		"s3": []any{},
	}
	writeJSONFile(t, targetConfigPath, targetConfig)

	restore := exec.Command(binary, "restore", "--bundle", received, "--identity-file", identityPath,
		"--target-config", targetConfigPath)
	if output, err := restore.CombinedOutput(); err != nil {
		t.Fatalf("restore: %v\n%s", err, output)
	}
	compare := exec.Command(binary, "compare", "--bundle", received, "--identity-file", identityPath,
		"--target-config", targetConfigPath)
	if output, err := compare.CombinedOutput(); err != nil {
		t.Fatalf("compare: %v\n%s", err, output)
	}

	query := exec.Command("docker", "exec", target, "psql", "-U", "postgres", "-d", "restored", "-Atc",
		"SELECT count(*) FROM items")
	output, err := query.CombinedOutput()
	if err != nil {
		t.Fatalf("target query: %v\n%s", err, output)
	}
	if string(output) != "3\n" {
		t.Fatalf("restored rows = %q", output)
	}
}

func waitForPostgres(t *testing.T, container string) {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if exec.Command("docker", "exec", container, "pg_isready", "-U", "postgres").Run() == nil {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("postgres container %s did not become ready", container)
}

func runDocker(t *testing.T, args ...string) {
	t.Helper()
	command := exec.Command("docker", args...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("docker %v: %v\n%s", args, err, output)
	}
}

func writeJSONFile(t *testing.T, path string, value any) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}
