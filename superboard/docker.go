package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The agent only reads; it never creates, starts, or stops anything, which
// is worth stating because the socket is root-equivalent and whoever audits
// this will ask.
const defaultSocketPath = "/var/run/docker.sock"

// dockerCollectionWorkers bounds how many containers are inspected at once.
// The per-request timeout is 10s and a pass used to walk containers
// sequentially (inspect, then stats): ten running containers against a
// stalling daemon kept one pass busy for roughly 200 seconds while the 10s
// refresh loop republished the previous snapshot under a fresh timestamp.
const dockerCollectionWorkers = 4

// dockerCollectionBudget bounds one whole collection pass. A daemon that
// cannot answer inside it is not providing current data; the collector keeps
// the previous snapshot and says how old it is rather than pretending.
// Variable so tests can shrink it.
var dockerCollectionBudget = 20 * time.Second

// dockerSocketPaths are tried in order. DOCKER_HOST wins when set
// (unix:// only — TCP daemons are out of scope for v1); then the standard
// location, then the rootless one. A hardcoded single path is how agents go
// blind on rootless boxes while insisting everything is fine.
func dockerSocketPaths() []string {
	if host, ok := os.LookupEnv("DOCKER_HOST"); ok {
		if rest, found := strings.CutPrefix(host, "unix://"); found {
			return []string{rest}
		}
		log.Printf("warning: DOCKER_HOST %q is not a unix socket, ignoring", host)
	}

	paths := []string{defaultSocketPath}

	// Rootless daemons live under the user's runtime dir, not the system
	// path. This is the miss that blinds agents on exactly the kind of box
	// that runs rootless Docker: /var/run/docker.sock exists but belongs to
	// an empty system daemon.
	if xdg := os.Getenv("XDG_RUNTIME_DIR"); xdg != "" {
		paths = append(paths, filepath.Join(xdg, "docker.sock"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		rootless := filepath.Join(home, ".docker", "run", "docker.sock")
		if rootless != defaultSocketPath {
			paths = append(paths, rootless)
		}
	}
	if matches, err := filepath.Glob("/run/user/*/docker.sock"); err == nil {
		paths = append(paths, matches...)
	}

	return paths
}

// dockerListItem is the subset of /containers/json we care about.
type dockerListItem struct {
	ID     string   `json:"Id"`
	Names  []string `json:"Names"`
	Image  string   `json:"Image"`
	State  string   `json:"State"`
	Status string   `json:"Status"`
	Ports  []struct {
		IP          string `json:"IP"`
		PrivatePort uint16 `json:"PrivatePort"`
		PublicPort  uint16 `json:"PublicPort"`
		Type        string `json:"Type"`
	} `json:"Ports"`
}

// dockerInspect is the subset of /containers/{id}/json we care about.
type dockerInspect struct {
	Config struct {
		Healthcheck *struct{} `json:"Healthcheck"`
	} `json:"Config"`
	State struct {
		Status    string `json:"Status"`
		StartedAt string `json:"StartedAt"`
		Health    *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	NetworkSettings struct {
		Ports map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"Ports"`
	} `json:"NetworkSettings"`
}

// containerStatsRaw is the subset of /containers/{id}/stats we need. One
// one-shot read carries cumulative CPU counters and current memory; CPU
// percentage needs the delta against the previous read, which we keep
// ourselves because one-shot responses are ten seconds apart.
type containerStatsRaw struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64   `json:"system_cpu_usage"`
		OnlineCPUs  uint32   `json:"online_cpus"`
		PercpuUsage []uint64 `json:"percpu_usage"`
	} `json:"cpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
}

// containerCPUSample is one cumulative CPU read for one container.
type containerCPUSample struct {
	total  uint64
	system uint64
}

// dockerStatsCache remembers the previous cumulative CPU counters per
// container so the next 10s refresh can compute a utilization percentage.
var dockerStatsCache = struct {
	mu   sync.Mutex
	last map[string]containerCPUSample
}{last: make(map[string]containerCPUSample)}

// dockerStatsWarned logs one stats failure per container per process:
// a container that cannot be measured every ten seconds must not spam the
// journal, but the first occurrence is worth seeing.
var dockerStatsWarned = struct {
	mu   sync.Mutex
	seen map[string]bool
}{seen: make(map[string]bool)}

// containerCPUPercent converts two cumulative CPU reads into Docker's
// convention: percent of a single core, so a container using four cores
// reads 400%. A system counter that did not advance (no elapsed time) or a
// container counter that went backwards (restart) yields 0 — the caller
// treats "no valid delta" as unknown, never as a reading.
func containerCPUPercent(prevTotal, prevSystem, curTotal, curSystem uint64, cores int) float64 {
	if cores < 1 {
		cores = 1
	}
	if curSystem <= prevSystem || curTotal < prevTotal {
		return 0
	}
	return float64(curTotal-prevTotal) / float64(curSystem-prevSystem) * float64(cores) * 100
}

// containerMemoryUsage returns the container's working-set bytes and, when
// the limit is meaningful, the percentage of it. Docker's raw usage
// includes page cache; cache (cgroup v1) or inactive_file (cgroup v2) is
// subtracted, as docker stats does. A limit above 1<<60 is the cgroup v2
// "no limit" sentinel: a percentage against it would be meaningless.
func containerMemoryUsage(usage, limit uint64, stats map[string]uint64) (uint64, *float64) {
	cache := stats["cache"]
	if cache == 0 {
		cache = stats["inactive_file"]
	}
	used := uint64(0)
	if usage > cache {
		used = usage - cache
	}
	if limit > 0 && limit < 1<<60 {
		percent := float64(used) / float64(limit) * 100
		return used, &percent
	}
	return used, nil
}

// buildContainerStats turns one stats read into the payload block,
// computing CPU against the previous read and memory against the limit.
func buildContainerStats(id string, raw *containerStatsRaw) *ContainerStats {
	cores := int(raw.CPUStats.OnlineCPUs)
	if cores == 0 {
		cores = len(raw.CPUStats.PercpuUsage)
	}

	cur := containerCPUSample{
		total:  raw.CPUStats.CPUUsage.TotalUsage,
		system: raw.CPUStats.SystemUsage,
	}
	dockerStatsCache.mu.Lock()
	prev, ok := dockerStatsCache.last[id]
	dockerStatsCache.last[id] = cur
	dockerStatsCache.mu.Unlock()

	out := &ContainerStats{}
	if ok && cur.system > prev.system && cur.total >= prev.total {
		percent := containerCPUPercent(prev.total, prev.system, cur.total, cur.system, cores)
		out.CPUPercent = &percent
	}
	out.MemUsed, out.MemPercent = containerMemoryUsage(raw.MemoryStats.Usage, raw.MemoryStats.Limit, raw.MemoryStats.Stats)
	out.MemLimit = raw.MemoryStats.Limit
	return out
}

// pruneDockerStatsCache forgets containers that no longer appear, so the
// map cannot grow with churn.
func pruneDockerStatsCache(seen map[string]bool) {
	dockerStatsCache.mu.Lock()
	defer dockerStatsCache.mu.Unlock()
	for id := range dockerStatsCache.last {
		if !seen[id] {
			delete(dockerStatsCache.last, id)
		}
	}
}

// containerStats fetches one one-shot stats read for a container.
func (c *dockerClient) containerStats(ctx context.Context, id string) (*containerStatsRaw, error) {
	var stats containerStatsRaw
	if err := c.get(ctx, "/v1.43/containers/"+id+"/stats?stream=false&one-shot=true", &stats); err != nil {
		return nil, err
	}
	return &stats, nil
}

// containerUptime converts a Docker StartedAt timestamp (RFC3339) into
// seconds since start. 0 means unknown — never a wrong number.
func containerUptime(startedAt string) uint64 {
	if startedAt == "" {
		return 0
	}
	started, err := time.Parse(time.RFC3339, startedAt)
	if err != nil {
		return 0
	}
	seconds := time.Since(started).Seconds()
	if seconds < 0 {
		return 0
	}
	return uint64(seconds)
}

// dockerClient talks to the daemon over its Unix socket with the standard
// library only. The full docker client library is a large dependency for two
// GET endpoints, and pinning its API version matrix is its own maintenance
// burden. If the surface ever grows past list + inspect, revisit.
type dockerClient struct {
	http *http.Client
}

func newDockerClient(socketPath string) *dockerClient {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socketPath)
		},
	}

	return &dockerClient{
		http: &http.Client{Transport: transport, Timeout: 10 * time.Second},
	}
}

func (c *dockerClient) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("docker API %s: %s", path, resp.Status)
	}

	return json.NewDecoder(resp.Body).Decode(out)
}

// collectDocker lists containers with state, health, ports and uptime.
//
// Socket first: structured data, no CLI dependency. `docker ps` is the
// fallback when no socket is reachable — same daemon, same permissions, but
// worth trying because the failure modes differ (a missing CLI binary vs. a
// missing socket). Both paths answer "what is running, is it healthy, how
// long has it been up".
//
// No stats streaming in v1: per-container CPU/mem needs the stats endpoint
// held open per container, which is heavier on both ends.
func collectDocker() ([]Container, error) {
	var errs []string
	var firstSuccess []Container
	firstPath := ""

	// Every reachable socket is queried: the first path in discovery order
	// is often an empty system daemon on rootless boxes, and "reachable"
	// must not win over "has containers". First non-empty success wins;
	// otherwise the first success stands; otherwise the ps fallback.
	for _, socketPath := range dockerSocketPaths() {
		containers, err := collectDockerSocket(socketPath)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", socketPath, err))
			continue
		}
		if firstSuccess == nil {
			firstSuccess = containers
			firstPath = socketPath
		}
		if len(containers) > 0 {
			if socketPath != firstPath {
				log.Printf("docker: using %s (%d containers) over empty %s", socketPath, len(containers), firstPath)
			}
			return containers, nil
		}
	}

	if firstSuccess != nil {
		return firstSuccess, nil
	}

	containers, err := collectDockerPS()
	if err == nil {
		stats.recordCollectorRecovered("docker")
		return containers, nil
	}
	errs = append(errs, fmt.Sprintf("docker ps: %v", err))

	stats.recordCollectorError("docker")
	return nil, fmt.Errorf("no docker access (%s)", strings.Join(errs, "; "))
}

// containerDisplayName labels one list entry as well as the entry allows.
//
// The daemon is allowed to return an entry with an empty name list (the
// audit fixture returned Names: []) and ids are allowed to be shorter than
// the 12-character prefix Docker usually sends. Indexing or slicing blind
// panicked this collector, which runs in a goroutine, so one incomplete
// entry terminated the whole agent and every host's telemetry with it.
func containerDisplayName(item dockerListItem) string {
	if len(item.Names) > 0 && item.Names[0] != "" {
		return strings.TrimPrefix(item.Names[0], "/")
	}
	if len(item.ID) >= 12 {
		return item.ID[:12]
	}
	if item.ID != "" {
		return item.ID
	}
	return "unknown"
}

// collectDockerSocket lists containers and enriches them under one deadline.
//
// The whole pass is bounded (dockerCollectionBudget) and the per-container
// inspect/stats work runs on a small worker pool, so a stalling daemon costs
// one budget instead of 20s per container. Cancellation propagates into the
// in-flight requests: on expiry this returns an error and the collector keeps
// its previous snapshot rather than publishing a half-collected one as
// current.
func collectDockerSocket(socketPath string) ([]Container, error) {
	ctx, cancel := context.WithTimeout(context.Background(), dockerCollectionBudget)
	defer cancel()

	client := newDockerClient(socketPath)
	defer client.http.CloseIdleConnections()

	var list []dockerListItem
	if err := client.get(ctx, "/v1.43/containers/json?all=1", &list); err != nil {
		return nil, err
	}

	out := make([]Container, len(list))
	seen := make(map[string]bool, len(list))
	for _, item := range list {
		seen[item.ID] = true
	}

	// Each container's inspect and stats are independent; four workers keep
	// the deadline meaningful on a multi-container host while staying gentle
	// on the daemon.
	work := make(chan int)
	var wg sync.WaitGroup
	for worker := 0; worker < dockerCollectionWorkers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range work {
				out[index] = collectDockerContainer(ctx, client, list[index])
			}
		}()
	}
	for index := range list {
		work <- index
	}
	close(work)
	wg.Wait()

	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("docker collection exceeded %s (%d containers listed)", dockerCollectionBudget, len(list))
	}

	pruneDockerStatsCache(seen)
	stats.recordCollectorRecovered("docker")

	if out == nil {
		out = []Container{}
	}

	return out, nil
}

// collectDockerContainer enriches one list entry: inspect for health, ports
// and uptime, stats for a running container's CPU/memory. Failures degrade
// that container, never the whole list.
func collectDockerContainer(ctx context.Context, client *dockerClient, item dockerListItem) Container {
	name := containerDisplayName(item)
	c := Container{
		Name:  name,
		Image: item.Image,
		State: item.State,
	}

	var insp dockerInspect
	if err := client.get(ctx, "/v1.43/containers/"+item.ID+"/json", &insp); err != nil {
		log.Printf("warning: docker inspect %s failed: %v", name, err)
	} else {
		// Health is meaningful only while running: a stopped container
		// keeps its last health status, which would otherwise paint an
		// exited box as "unhealthy" instead of merely stopped.
		if insp.State.Status == "running" && insp.State.Health != nil {
			c.Health = insp.State.Health.Status
		}
		c.Uptime = containerUptime(insp.State.StartedAt)
		for containerPort, bindings := range insp.NetworkSettings.Ports {
			private := strings.Split(containerPort, "/")[0]
			if len(bindings) == 0 {
				c.Ports = append(c.Ports, private)
				continue
			}
			for _, b := range bindings {
				c.Ports = append(c.Ports, fmt.Sprintf("%s:%s", b.HostPort, private))
			}
		}
	}

	// CPU/memory stats for running containers, best-effort: a container
	// that cannot be measured simply carries no stats block, and the
	// first failure per container is logged once.
	if item.State == "running" {
		if raw, err := client.containerStats(ctx, item.ID); err == nil {
			c.Stats = buildContainerStats(item.ID, raw)
		} else {
			dockerStatsWarned.mu.Lock()
			if !dockerStatsWarned.seen[item.ID] {
				dockerStatsWarned.seen[item.ID] = true
				log.Printf("warning: docker stats %s failed (will not repeat): %v", name, err)
			}
			dockerStatsWarned.mu.Unlock()
		}
	}

	// Fall back to the list-response ports when inspect gave nothing.
	if len(c.Ports) == 0 {
		for _, p := range item.Ports {
			if p.PublicPort != 0 {
				c.Ports = append(c.Ports, fmt.Sprintf("%d:%d", p.PublicPort, p.PrivatePort))
			} else {
				c.Ports = append(c.Ports, fmt.Sprintf("%d", p.PrivatePort))
			}
		}
	}

	c.Ports = dedupPorts(c.Ports)
	return c
}

// dedupPorts drops repeats while keeping order. Inspect reports one binding
// per family, so dual-stack publishes arrive twice ("3001:3001" over IPv4
// and IPv6) — the board should show the mapping once.
func dedupPorts(ports []string) []string {
	seen := make(map[string]bool, len(ports))
	out := ports[:0]
	for _, p := range ports {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

// dockerPSFormat pins the columns we parse. An explicit template keeps new
// Docker versions from rearranging the human table out from under us.
const dockerPSFormat = "{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}"

// collectDockerPS shells out to the CLI and parses its table.
//
// Same daemon and same permissions as the socket, so this is not a privilege
// workaround — it is a second chance for environments where the socket path
// is exotic but the CLI knows where to look (DOCKER_HOST, contexts).
func collectDockerPS() ([]Container, error) {
	path, err := exec.LookPath("docker")
	if err != nil {
		return nil, fmt.Errorf("docker CLI not installed")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, path, "ps", "--no-trunc", "--format", dockerPSFormat).Output()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w", err)
	}

	var containers []Container
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		containers = append(containers, parseDockerPSLine(line))
	}

	if containers == nil {
		containers = []Container{}
	}

	return containers, nil
}

// parseDockerPSLine parses one --format row: ID|Names|Image|State|Status|Ports.
//
// Status carries health in parentheses ("Up 3 days (healthy)") and uptime in
// words ("Up 3 days", "Up 5 minutes", "Created", "Exited (0) 2 hours ago").
// Health parsing is exact; uptime parsing is best-effort and yields 0 rather
// than a wrong number when the wording surprises us.
func parseDockerPSLine(line string) Container {
	fields := strings.SplitN(line, "|", 6)
	for len(fields) < 6 {
		fields = append(fields, "")
	}

	c := Container{
		Image: fields[2],
		State: fields[3],
	}

	if fields[1] != "" {
		c.Name = strings.TrimPrefix(strings.Split(fields[1], ",")[0], "/")
	} else if len(fields[0]) >= 12 {
		c.Name = fields[0][:12]
	} else {
		c.Name = fields[0]
	}

	status := fields[4]
	switch {
	case strings.Contains(status, "(healthy)"):
		c.Health = "healthy"
	case strings.Contains(status, "(unhealthy)"):
		c.Health = "unhealthy"
	case strings.Contains(status, "(health: starting)"):
		c.Health = "starting"
	}

	c.Uptime = parseDockerUpTime(status)

	for _, p := range strings.Split(fields[5], ", ") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		// "0.0.0.0:8080->80/tcp" becomes "8080:80".
		if arrow := strings.Index(p, "->"); arrow >= 0 {
			hostPart, containerPart := p[:arrow], p[arrow+2:]
			hostPort := hostPart[strings.LastIndex(hostPart, ":")+1:]
			containerPort := strings.Split(containerPart, "/")[0]
			c.Ports = append(c.Ports, fmt.Sprintf("%s:%s", hostPort, containerPort))
		} else {
			c.Ports = append(c.Ports, strings.Split(p, "/")[0])
		}
	}
	c.Ports = dedupPorts(c.Ports)

	return c
}

// parseDockerUpTime converts "Up ..." durations to seconds. Docker's wording
// is a small closed set (seconds/minutes/hours/days/weeks/months); anything
// else — Created, Restarting, Paused, Exited — is not "up" and yields 0.
func parseDockerUpTime(status string) uint64 {
	if !strings.HasPrefix(status, "Up ") {
		return 0
	}

	rest := strings.TrimPrefix(status, "Up ")
	// "3 days (healthy)" or "About an hour" — isolate the first two words.
	words := strings.Fields(rest)
	if len(words) == 0 {
		return 0
	}

	multipliers := map[string]uint64{
		"second": 1, "seconds": 1,
		"minute": 60, "minutes": 60,
		"hour": 3600, "hours": 3600,
		"day": 86400, "days": 86400,
		"week": 604800, "weeks": 604800,
		"month": 2592000, "months": 2592000,
	}

	amount := 0.0
	unit := ""
	if first := strings.ToLower(words[0]); first == "about" || first == "less" || first == "an" || first == "a" {
		// "About an hour", "Less than a second": find the unit word.
		amount = 1
		for _, w := range words {
			if _, ok := multipliers[strings.ToLower(w)]; ok {
				unit = w
				break
			}
		}
		if unit == "" {
			return 0
		}
	} else {
		n, err := strconv.ParseFloat(words[0], 64)
		if err != nil || len(words) < 2 {
			return 0
		}
		amount = n
		unit = words[1]
	}

	mult, ok := multipliers[strings.ToLower(unit)]
	if !ok {
		return 0
	}

	return uint64(amount * float64(mult))
}
