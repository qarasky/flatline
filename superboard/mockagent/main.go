// Command mockagent fabricates a fleet of Superboard hosts for local UI work.
//
// It is a development tool. It creates its demo monitors through the public
// API — so it never touches a database schema — and then pushes varied,
// believable telemetry for them on a loop. That gives the board the full range
// of card states (healthy, hot, neglected, security updates pending, a GPU
// box, a blind Docker collector, an idle host, a 16-core builder) without
// needing eight machines.
//
// Because it only speaks HTTP it works against any backend, and because it is
// Go it does not drag a Node runtime into local development.
//
// Usage:
//
//	mockagent --server http://127.0.0.1:3001 --token <operator token> [--interval 3s]
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	kib = 1 << 10
	mib = kib << 10
	gib = mib << 10
)

// serverDef is one demo host.
type serverDef struct {
	name     string
	group    string
	provider string
	profile  string
}

// The demo fleet. Profiles deliberately span the card's states.
var fleet = []serverDef{
	{name: "edge-01", group: "Work", provider: "hetzner", profile: "healthy"},
	{name: "edge-02", group: "Work", provider: "ps.kz", profile: "hot"},
	{name: "db-01", group: "Work", provider: "digitalocean", profile: "neglected"},
	{name: "web-01", group: "Work", provider: "hoster.kz", profile: "security"},
	{name: "gpu-01", group: "Home", provider: "hetzner", profile: "gpu"},
	{name: "nas-01", group: "Home", provider: "", profile: "blind"},
	{name: "router-01", group: "Home", provider: "", profile: "quiet"},
	{name: "build-16", group: "Home", provider: "hetzner", profile: "manycores"},
}

// websiteDef is one demo website a server hosts, shown as a chip on its card.
type websiteDef struct {
	name  string
	group string
	url   string
}

// Demo websites, so the link picker and the cards' website chips have
// something real to show. The URLs point at the dev stack itself (up) and at
// a closed port (down), so both chip tones appear without leaving the machine.
// The server checker polls them like any other HTTP monitor.
var websites = []websiteDef{
	{name: "shop.clients.kz", group: "Work", url: "http://127.0.0.1:3003/"},
	{name: "api.clients.kz", group: "Work", url: "http://127.0.0.1:3003/"},
	{name: "legacy.clients.kz", group: "Work", url: "http://127.0.0.1:9/"},
	{name: "media.home.lan", group: "Home", url: "http://127.0.0.1:3003/"},
}

// Which server hosts which websites, as an operator would link them.
var hostLinks = map[string][]string{
	"web-01": {"shop.clients.kz", "api.clients.kz"},
	"db-01":  {"legacy.clients.kz"},
	"nas-01": {"media.home.lan"},
}

// state carries the counters that must climb between pushes so the server can
// derive per-second rates.
type state struct {
	tick      int
	netRx     float64
	netTx     float64
	diskRead  float64
	diskWrite float64
	memBase   float64
	uptime    float64
}

func newState() *state {
	return &state{
		netRx:     180 * gib,
		netTx:     90 * gib,
		diskRead:  640 * gib,
		diskWrite: 220 * gib,
		memBase:   12 * gib,
		uptime:    6 * 24 * 3600,
	}
}

type client struct {
	base  string
	token string
	http  *http.Client
}

func (c *client) do(method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s: HTTP %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out != nil && len(raw) > 0 {
		return json.Unmarshal(raw, out)
	}
	return nil
}

type monitorSummary struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	PushToken string `json:"pushToken"`
}

type monitorList struct {
	Monitors []monitorSummary `json:"monitors"`
}

func (c *client) roster() ([]monitorSummary, error) {
	var out monitorList
	if err := c.do(http.MethodGet, "/api/v1/monitors?perPage=200", nil, &out); err != nil {
		return nil, err
	}
	return out.Monitors, nil
}

// ensureGroup finds or creates a group monitor and returns its id.
func (c *client) ensureGroup(name string, weight int) (int64, error) {
	roster, err := c.roster()
	if err != nil {
		return 0, err
	}
	for _, m := range roster {
		if m.Type == "group" && m.Name == name {
			return m.ID, nil
		}
	}
	var created struct {
		Monitor monitorSummary `json:"monitor"`
	}
	body := map[string]any{"name": name, "type": "group", "active": true, "weight": weight}
	if err := c.do(http.MethodPost, "/api/v1/monitors", body, &created); err != nil {
		return 0, err
	}
	return created.Monitor.ID, nil
}

// ensurePush finds or creates a push monitor and returns its id and push token.
// The push token is minted by the server, so the agent never invents one.
func (c *client) ensurePush(def serverDef, parent int64) (int64, string, error) {
	roster, err := c.roster()
	if err != nil {
		return 0, "", err
	}
	for _, m := range roster {
		if m.Type == "push" && m.Name == def.name && m.PushToken != "" {
			return m.ID, m.PushToken, nil
		}
	}
	var created struct {
		Monitor monitorSummary `json:"monitor"`
	}
	body := map[string]any{
		"name":          def.name,
		"type":          "push",
		"active":        true,
		"interval":      60,
		"retryInterval": 60,
		"maxretries":    0,
		"parent":        parent,
	}
	if def.provider != "" {
		body["provider"] = def.provider
	}
	if err := c.do(http.MethodPost, "/api/v1/monitors", body, &created); err != nil {
		return 0, "", err
	}
	if created.Monitor.PushToken == "" {
		return 0, "", fmt.Errorf("server did not mint a push token for %s", def.name)
	}
	return created.Monitor.ID, created.Monitor.PushToken, nil
}

func (c *client) push(token string, metrics map[string]any) error {
	body := map[string]any{"status": "up", "ping": 12, "msg": "OK", "metrics": metrics}
	return c.do(http.MethodPost, "/api/push/"+token+"?telemetry=1", body, nil)
}

// ensureWebsite finds or creates an HTTP monitor and returns its id.
func (c *client) ensureWebsite(def websiteDef, parent int64) (int64, error) {
	roster, err := c.roster()
	if err != nil {
		return 0, err
	}
	for _, m := range roster {
		if m.Type == "http" && m.Name == def.name {
			return m.ID, nil
		}
	}
	var created struct {
		Monitor monitorSummary `json:"monitor"`
	}
	body := map[string]any{
		"name":    def.name,
		"type":    "http",
		"active":  true,
		"url":     def.url,
		"parent":  parent,
		"timeout": 5,
	}
	if err := c.do(http.MethodPost, "/api/v1/monitors", body, &created); err != nil {
		return 0, err
	}
	return created.Monitor.ID, nil
}

// setLinks replaces a server's linked websites with exactly the given ids.
func (c *client) setLinks(serverID int64, linked []int64) error {
	body := map[string]any{"linkedMonitorIds": linked}
	return c.do(http.MethodPut, fmt.Sprintf("/api/v1/monitors/%d/links", serverID), body, nil)
}

// walk nudges a value and keeps it inside a range.
func walk(value, step, min, max float64) float64 {
	next := value + (rand.Float64()-0.5)*step
	if next < min {
		return min
	}
	if next > max {
		return max
	}
	return next
}

// perCore builds one load percentage per core around a base.
func perCore(count int, base, spread float64) []float64 {
	out := make([]float64, count)
	for i := range out {
		v := base + (rand.Float64()-0.5)*spread
		if v < 1 {
			v = 1
		}
		if v > 99 {
			v = 99
		}
		out[i] = float64(int(v + 0.5))
	}
	return out
}

// mean rounds the average of the per-core loads.
func mean(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	return float64(int(sum/float64(len(values))*10+0.5)) / 10
}

// container is one healthy container tile with live stats.
func container(name, image string, cpu, memUsed, memLimit float64) map[string]any {
	return map[string]any{
		"name":   name,
		"image":  image,
		"state":  "running",
		"health": "healthy",
		"ports":  []string{},
		"uptime": 5 * 24 * 3600,
		"stats": map[string]any{
			"cpuPercent": float64(int(cpu*10+0.5)) / 10,
			"memUsed":    memUsed,
			"memLimit":   memLimit,
			"memPercent": float64(int(memUsed/memLimit*1000+0.5)) / 10,
		},
	}
}

// sample builds one metrics payload for a host, mirroring what the real agent
// sends (percent CPU with a per-core breakdown, RAM, disks, containers, pending
// updates, self-report, load, raw net/disk counters).
func sample(def serverDef, st *state, now time.Time) map[string]any {
	st.tick++
	st.uptime += 3
	st.netRx += 4*mib + rand.Float64()*40*mib
	st.netTx += mib + rand.Float64()*16*mib
	st.diskRead += rand.Float64() * 8 * mib
	st.diskWrite += rand.Float64() * 4 * mib
	st.memBase = walk(st.memBase, 1.5*gib, 3*gib, 58*gib)

	ramTotal := float64(64 * gib)
	metrics := map[string]any{
		"v":              1,
		"sampledAt":      now.UTC().Format(time.RFC3339),
		"sampleInterval": 3,
		"host": map[string]any{
			"hostname": def.name,
			"os":       "linux",
			"uptime":   int(st.uptime),
		},
		"mem": map[string]any{
			"total":   ramTotal,
			"used":    st.memBase,
			"percent": float64(int(st.memBase/ramTotal*1000+0.5)) / 10,
		},
		"disk":   []any{map[string]any{"mount": "/", "total": 512 * gib, "used": 210 * gib, "percent": 41}},
		"docker": []any{},
		"gpu":    map[string]any{"available": false},
		"load":   map[string]any{"avg1": 0.42, "avg5": 0.51, "avg15": 0.6},
		"net": []any{map[string]any{
			"iface": "eth0", "rxBytes": int(st.netRx), "txBytes": int(st.netTx),
		}},
		"diskIo": []any{map[string]any{
			"device": "sda", "readBytes": int(st.diskRead), "writeBytes": int(st.diskWrite),
		}},
		"agent": map[string]any{
			"version":        "1.8.1",
			"uptime":         int(st.uptime),
			"samplesDropped": 0,
			"failedPushes":   0,
		},
		"smart": map[string]any{
			"available": true,
			"disks": []any{map[string]any{
				"device": "sda", "health": "passed", "tempC": 34,
				"reallocatedSectors": 0, "powerOnHours": 20000,
			}},
		},
	}

	setCPU := func(cores int, base, spread, temp float64) {
		values := perCore(cores, base, spread)
		metrics["cpu"] = map[string]any{
			"percent": mean(values), "cores": cores, "perCore": values, "temp": temp,
		}
	}

	switch def.profile {
	case "healthy":
		setCPU(8, 18, 21, 46)
		metrics["updates"] = map[string]any{"total": 0}
		metrics["docker"] = []any{
			container("api", "ghcr.io/acme/api:1.6.2", 22, 900*mib, 2*gib),
			container("worker", "ghcr.io/acme/worker:1.6.2", 41, 1.2*gib, 4*gib),
			container("postgres", "postgres:16", 8, 2.4*gib, 8*gib),
			container("redis", "redis:7", 3, 220*mib, 1*gib),
		}
	case "hot":
		setCPU(8, 82, 22, 79)
		metrics["mem"] = map[string]any{
			"total": 32 * gib, "used": walk(26*gib, gib, 22*gib, 30*gib), "percent": 82.0,
		}
		metrics["disk"] = []any{map[string]any{"mount": "/", "total": 512 * gib, "used": 449 * gib, "percent": 88}}
		metrics["updates"] = map[string]any{"total": 12}
		metrics["load"] = map[string]any{"avg1": 7.4, "avg5": 6.1, "avg15": 4.8}
		metrics["docker"] = []any{
			container("api", "ghcr.io/acme/api:1.6.2", 180, 1.9*gib, 2*gib),
			container("worker", "ghcr.io/acme/worker:1.6.2", 320, 3.6*gib, 4*gib),
			container("ffmpeg", "jrottenberg/ffmpeg:6", 410, 1.1*gib, 2*gib),
		}
		metrics["agent"] = map[string]any{
			"version": "1.8.1", "uptime": int(st.uptime), "samplesDropped": 0, "failedPushes": 0,
			"collectorErrors": map[string]any{"gpu": 2},
		}
	case "neglected":
		setCPU(4, 38, 30, 61)
		metrics["mem"] = map[string]any{"total": 16 * gib, "used": 15 * gib, "percent": 93.8}
		metrics["disk"] = []any{map[string]any{"mount": "/", "total": 256 * gib, "used": 236 * gib, "percent": 92}}
		metrics["updates"] = map[string]any{"total": 137}
		metrics["docker"] = []any{
			container("postgres", "postgres:14", 12, 3.9*gib, 4*gib),
			map[string]any{"name": "legacy-api", "image": "acme/legacy:0.9", "state": "exited", "health": nil, "ports": []string{}, "uptime": 0},
			map[string]any{
				"name": "cron", "image": "acme/cron:1.2", "state": "running", "health": "unhealthy",
				"ports": []string{}, "uptime": 1200,
				"stats": map[string]any{"cpuPercent": 0.0, "memUsed": 40 * mib, "memLimit": 256 * mib, "memPercent": 15.6},
			},
		}
		metrics["agent"] = map[string]any{
			"version": "1.4.2", "uptime": int(st.uptime), "samplesDropped": 4, "failedPushes": 3,
			"lastError":       "connect ETIMEDOUT 10.0.0.5:3001",
			"collectorErrors": map[string]any{"smart": 1},
		}
	case "security":
		setCPU(4, 24, 24, 48)
		// A staged kernel: the card must flash.
		metrics["updates"] = map[string]any{"total": 41, "security": 6, "rebootRequired": true}
		metrics["docker"] = []any{
			container("nginx", "nginx:1.27", 6, 120*mib, 512*mib),
			container("app", "acme/web:3.4.1", 34, 1.6*gib, 2*gib),
		}
	case "gpu":
		setCPU(12, 30, 30, 58)
		metrics["gpu"] = map[string]any{
			"available": true, "name": "NVIDIA RTX 4090", "util": 63,
			"memUsed": 9 * gib, "memTotal": 24 * gib, "temp": 64,
		}
		metrics["updates"] = map[string]any{"total": 3}
		metrics["docker"] = []any{
			container("ollama", "ollama/ollama:latest", 30, 18*gib, 24*gib),
			container("api", "acme/inference:2.0", 55, 2*gib, 4*gib),
		}
		metrics["smart"] = map[string]any{
			"available": true,
			"disks": []any{
				map[string]any{"device": "sda", "health": "passed", "tempC": 36, "wearPercent": 12, "powerOnHours": 9000},
				map[string]any{"device": "nvme0n1", "health": "failed", "tempC": 51, "reallocatedSectors": 24, "powerOnHours": 30000},
			},
		}
	case "blind":
		setCPU(4, 20, 20, 44)
		metrics["disk"] = []any{map[string]any{"mount": "/", "total": 4 * 1024 * gib, "used": 3 * 1024 * gib, "percent": 76}}
		metrics["dockerError"] = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock (permission denied)."
		metrics["dockerAt"] = now.Add(-10 * time.Minute).UTC().Format(time.RFC3339)
		metrics["updates"] = map[string]any{"total": 7}
		metrics["smart"] = map[string]any{
			"available": true,
			"disks":     []any{map[string]any{"device": "sda", "health": "passed", "tempC": 40, "wearPercent": 88, "powerOnHours": 40000}},
		}
	case "quiet":
		setCPU(4, 8, 12, 38)
		metrics["disk"] = []any{map[string]any{"mount": "/", "total": 32 * gib, "used": 6 * gib, "percent": 19}}
		metrics["mem"] = map[string]any{"total": 4 * gib, "used": 1.1 * gib, "percent": 27.5}
		metrics["updates"] = map[string]any{"total": 2}
	case "manycores":
		setCPU(16, 46, 40, 67)
		metrics["disk"] = []any{
			map[string]any{"mount": "/", "total": 1024 * gib, "used": 610 * gib, "percent": 60},
			map[string]any{"mount": "/data", "total": 8 * 1024 * gib, "used": 7.5 * 1024 * gib, "percent": 94},
		}
		metrics["updates"] = map[string]any{"total": 58}
		metrics["docker"] = []any{
			container("builder", "acme/builder:latest", 240, 5*gib, 8*gib),
			container("cache", "redis:7", 5, 400*mib, 2*gib),
			container("runner", "acme/runner:latest", 160, 3.2*gib, 8*gib),
			container("registry", "registry:2", 9, 700*mib, 4*gib),
			map[string]any{"name": "janitor", "image": "acme/janitor:1.0", "state": "restarting", "health": nil, "ports": []string{}, "uptime": 0},
		}
	default:
		setCPU(2, 10, 10, 40)
	}

	return metrics
}

func main() {
	server := flag.String("server", envOr("FLATLINE_URL", "http://127.0.0.1:3001"), "Flatline origin")
	token := flag.String("token", os.Getenv("FLATLINE_TOKEN"), "operator token with write scope")
	interval := flag.Duration("interval", 3*time.Second, "how often to push telemetry")
	flag.Parse()

	if *token == "" {
		log.Fatal("mockagent: --token (or FLATLINE_TOKEN) is required: the monitors are created through the API")
	}

	c := &client{
		base:  strings.TrimRight(*server, "/"),
		token: *token,
		http:  &http.Client{Timeout: 30 * time.Second},
	}

	groups := map[string]int64{}
	for _, def := range fleet {
		if _, ok := groups[def.group]; ok {
			continue
		}
		id, err := c.ensureGroup(def.group, 100*len(groups)+100)
		if err != nil {
			log.Fatalf("mockagent: group %s: %v", def.group, err)
		}
		groups[def.group] = id
	}

	tokens := map[string]string{}
	states := map[string]*state{}
	servers := map[string]int64{}
	for _, def := range fleet {
		id, tok, err := c.ensurePush(def, groups[def.group])
		if err != nil {
			log.Fatalf("mockagent: monitor %s: %v", def.name, err)
		}
		servers[def.name] = id
		tokens[def.name] = tok
		states[def.name] = newState()
	}

	// Websites live in their group too, so the picker can offer both a single
	// website and the whole group that holds it.
	websiteIDs := map[string]int64{}
	for _, def := range websites {
		id, err := c.ensureWebsite(def, groups[def.group])
		if err != nil {
			log.Fatalf("mockagent: website %s: %v", def.name, err)
		}
		websiteIDs[def.name] = id
	}
	for host, names := range hostLinks {
		ids := make([]int64, 0, len(names))
		for _, name := range names {
			ids = append(ids, websiteIDs[name])
		}
		if err := c.setLinks(servers[host], ids); err != nil {
			log.Fatalf("mockagent: links for %s: %v", host, err)
		}
	}
	log.Printf("mockagent: %d hosts and %d websites ready -> %s every %s", len(fleet), len(websites), c.base, *interval)

	consecutiveFailures := 0
	for {
		now := time.Now()
		for _, def := range fleet {
			if err := c.push(tokens[def.name], sample(def, states[def.name], now)); err != nil {
				consecutiveFailures++
				if consecutiveFailures <= 5 || consecutiveFailures%20 == 0 {
					log.Printf("mockagent: %s: %v", def.name, err)
				}
				continue
			}
			consecutiveFailures = 0
		}
		time.Sleep(*interval)
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
