package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestContainerDisplayNameHandlesIncompleteEntries(t *testing.T) {
	cases := []struct {
		name string
		item dockerListItem
		want string
	}{
		{"normal name loses the slash", dockerListItem{ID: "0123456789ab", Names: []string{"/web"}}, "web"},
		{"no names falls back to the id prefix", dockerListItem{ID: "0123456789ab"}, "0123456789ab"},
		{"empty name string falls back", dockerListItem{ID: "0123456789ab", Names: []string{""}}, "0123456789ab"},
		// The audit's fixture: an id shorter than the usual 12-char prefix
		// used to slice out of range and panic.
		{"short id is used whole", dockerListItem{ID: "abc"}, "abc"},
		{"no id at all still yields a label", dockerListItem{}, "unknown"},
	}
	for _, tc := range cases {
		if got := containerDisplayName(tc.item); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

// dockerFixtureSocket serves the docker API over a unix socket, returning
// the given containers list. The inspect endpoint answers with a minimal
// record; the stats endpoint 404s (running containers degrade to no stats).
// The socket lives in its own short temp dir: unix socket paths are limited
// to ~104 bytes on macOS, and testing.TempDir() paths are too long there.
func dockerFixtureSocket(t *testing.T, list []map[string]any) string {
	t.Helper()

	dir, err := os.MkdirTemp("", "dsock")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	path := filepath.Join(dir, "s.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/v1.43/containers/json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(list)
	})
	mux.HandleFunc("/v1.43/containers/", func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.Path) > len("/v1.43/containers/") && r.URL.Path[len(r.URL.Path)-5:] == "/json" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"State":{"Status":"exited","StartedAt":"0001-01-01T00:00:00Z"}}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() {
		_ = server.Close()
		_ = listener.Close()
	})
	return path
}

// slowDockerFixtureSocket serves a containers list whose per-container
// inspect requests take `delay` (or hang forever when `hang`), so the
// collection's parallelism and its overall deadline can be observed.
func slowDockerFixtureSocket(t *testing.T, count int, delay time.Duration, hang bool) string {
	t.Helper()

	dir, err := os.MkdirTemp("", "dsock")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	path := filepath.Join(dir, "s.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}

	list := make([]map[string]any, 0, count)
	for i := 0; i < count; i++ {
		list = append(list, map[string]any{
			"Id":    fmt.Sprintf("%012d", i),
			"Names": []any{fmt.Sprintf("/c%d", i)},
			"Image": "img",
			"State": "exited", // exited: no stats request, inspect is the slow part
		})
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/v1.43/containers/json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(list)
	})
	mux.HandleFunc("/v1.43/containers/", func(w http.ResponseWriter, r *http.Request) {
		if hang {
			<-r.Context().Done()
			return
		}
		time.Sleep(delay)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"State":{"Status":"exited","StartedAt":"0001-01-01T00:00:00Z"}}`))
	})

	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() {
		_ = server.Close()
		_ = listener.Close()
	})
	return path
}

// Ten containers with both operations stalling used to keep one pass busy for
// roughly 200 seconds (sequential, 10s per request). The pass runs its
// per-container work on a small pool now, so it finishes in roughly one
// per-request delay per batch.
func TestCollectDockerSocketInspectsContainersInParallel(t *testing.T) {
	path := slowDockerFixtureSocket(t, 8, 250*time.Millisecond, false)

	started := time.Now()
	containers, err := collectDockerSocket(path)
	elapsed := time.Since(started)
	if err != nil {
		t.Fatalf("collectDockerSocket: %v", err)
	}
	if len(containers) != 8 {
		t.Fatalf("got %d containers, want 8", len(containers))
	}
	// Serial would be ~2s; four workers need ~500ms.
	if elapsed > 1200*time.Millisecond {
		t.Fatalf("collection took %s; per-container work is not parallel", elapsed)
	}
	if elapsed < 100*time.Millisecond {
		t.Fatalf("collection took %s; the fixture delay did not apply", elapsed)
	}
}

// A daemon that lists containers and then never answers must not hold a pass
// (or the sample loop) open: the overall deadline cancels the requests and
// the collector reports failure, so the previous snapshot stays labeled.
func TestCollectDockerSocketRespectsTheCollectionBudget(t *testing.T) {
	original := dockerCollectionBudget
	dockerCollectionBudget = 400 * time.Millisecond
	t.Cleanup(func() { dockerCollectionBudget = original })

	path := slowDockerFixtureSocket(t, 6, 0, true)

	started := time.Now()
	_, err := collectDockerSocket(path)
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("expected a timeout error from a hanging daemon")
	}
	if elapsed > 3*time.Second {
		t.Fatalf("collection returned after %s; the budget did not apply", elapsed)
	}
	if !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("error %q should name the budget", err)
	}
}

// A failed or incomplete pass keeps the previous list and says how old it
// is; a successful pass replaces it and clears the note.
func TestApplyDockerKeepsLastGoodSnapshot(t *testing.T) {
	var collector liveCollector
	first := []Container{{Name: "web", State: "running"}}
	collector.applyDocker(first, nil)
	if collector.dockerError != "" || len(collector.docker) != 1 {
		t.Fatalf("successful pass not applied: %+v", collector.docker)
	}
	collectedAt := collector.dockerAt
	if collectedAt.IsZero() {
		t.Fatal("a successful pass must record its collection time")
	}

	time.Sleep(5 * time.Millisecond)
	collector.applyDocker(nil, errors.New("docker collection exceeded 20s"))
	if len(collector.docker) != 1 || collector.docker[0].Name != "web" {
		t.Fatal("a failed pass must keep the previous container list")
	}
	if collector.dockerAt != collectedAt {
		t.Fatal("a failed pass must not advance the collection time")
	}
	if !strings.Contains(collector.dockerError, "exceeded") || !strings.Contains(collector.dockerError, "ago") {
		t.Fatalf("error %q must name the failure and the age of the kept data", collector.dockerError)
	}
}

// The audit's reproduction: a daemon response with an empty name list (and
// a short id) must degrade that entry, never panic the collector — this runs
// in a goroutine, and a panic there stops every host's telemetry.
func TestCollectDockerSocketSurvivesNamelessContainers(t *testing.T) {
	path := dockerFixtureSocket(t, []map[string]any{
		{"Id": "abc", "Names": []any{}, "Image": "img", "State": "exited"},
		{"Id": "0123456789ab", "Names": []any{"/web"}, "Image": "nginx", "State": "exited"},
	})

	containers, err := collectDockerSocket(path)
	if err != nil {
		t.Fatalf("collectDockerSocket: %v", err)
	}
	if len(containers) != 2 {
		t.Fatalf("got %d containers, want 2", len(containers))
	}
	if containers[0].Name != "abc" {
		t.Errorf("nameless container name = %q, want the id fallback %q", containers[0].Name, "abc")
	}
	if containers[1].Name != "web" {
		t.Errorf("named container name = %q, want %q", containers[1].Name, "web")
	}
}
