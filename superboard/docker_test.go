package main

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
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
