package main

// Payload schema for Superboard metrics.
//
// Mirrors SUPERBOARD-SPEC.md §1.2: units are bytes for memory/disk totals,
// percent 0–100, uptime seconds. The agent and the board must never disagree
// about units, so they are documented here, next to the code that produces
// them.
//
// Absent capabilities are explicit, never omitted: gpu.available false means
// "no GPU", an empty docker list means "no Docker", an empty disk list means
// "could not read mounts". The server cannot distinguish "missing" from
// "broken" if we send nulls, and chasing that ghost is worse than no data.
//
// The one exception that proves the rule is dockerError: an empty docker
// list is ambiguous (no containers vs. cannot see the daemon), so a failed
// collection attaches the reason. The board shows "unavailable" for that,
// "no containers" for a clean empty list.

/** Envelope version. Bump when fields change shape, never for additions. */
const payloadVersion = 1

// Host describes the machine itself.
type Host struct {
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
	Uptime   uint64 `json:"uptime"`
}

// CPUCounter is one cumulative CPU-time snapshot in USER_HZ ticks, the raw
// material percentages are derived from. Total excludes guest/guestNice
// (already counted inside user/nice); Idle includes iowait. These are never
// percentages: the server owns the averaging window and diffs consecutive
// snapshots itself.
type CPUCounter struct {
	Total uint64 `json:"total"`
	Idle  uint64 `json:"idle"`
}

// CPUCounters is the raw cumulative snapshot behind a CPU reading: the box
// total plus one entry per logical CPU in index order. The agent sends this
// with every push; the server derives the authoritative percent/perCore from
// consecutive snapshots and only falls back to Percent/PerCore (kept as a
// rolling-upgrade compat field for old backends) when no previous snapshot
// exists yet, counters reset, or samples arrive out of order.
type CPUCounters struct {
	Total   uint64       `json:"total"`
	Idle    uint64       `json:"idle"`
	PerCore []CPUCounter `json:"perCore,omitempty"`
}

// CPU is the average utilization across the 30 seconds before the push,
// computed from cumulative CPU-time counters (/proc/stat deltas), not a
// one-second window. PerCore holds one interval-average percentage per
// logical CPU in index order; power vs. efficiency cores are deliberately not
// distinguished — the board only cares which ones are hot. Temp is meaningful
// only when nonzero: 0 means "no sensor", not "freezing", and the board
// hides it. The one-shot `check` path uses a 1s counter window for speed and
// says so in its log; it is a diagnostic, never a load average.
//
// Counters is the raw snapshot Percent/PerCore were derived from. New
// servers ignore the derived fields when Counters is present and compute
// their own windowed percentages instead.
type CPU struct {
	Percent  float64      `json:"percent"`
	Cores    int          `json:"cores"`
	PerCore  []float64    `json:"perCore,omitempty"`
	Temp     float64      `json:"temp,omitempty"`
	Counters *CPUCounters `json:"counters,omitempty"`
}

// Updates counts pending OS package updates: totals only, never a package
// inventory. Absent means unknown (unsupported distro, failed check) and the
// board shows nothing; present with Total 0 means fully updated (green).
// Security is present only when the platform exposes severity (Ubuntu
// update-notifier, dnf security metadata) — 0 there means none detected,
// while a total-only platform reports no security field at all.
type Updates struct {
	Total    int `json:"total"`
	Security int `json:"security,omitempty"`
}

// AgentInfo is the agent's self-report, modelled on Telegraf's internal
// metrics input: the monitoring software reports its own failures, because
// otherwise a broken collector writes to journald and nobody reads it.
//
// Counters are cumulative since process start and reset on restart, so they
// describe the current agent. Only nonzero values are serialized; a healthy
// agent's block stays tiny. Strings are deliberately absent except lastError:
// counts travel, configs and inventories do not.
type AgentInfo struct {
	Version string `json:"version"`
	// Uptime in seconds since the agent process started. A small number on
	// a long-running host means a crash loop, not a fresh install.
	Uptime uint64 `json:"uptime"`
	// SamplesDropped counts samples superseded before delivery (the
	// capacity-one queue replaced them with something newer).
	SamplesDropped uint64 `json:"samplesDropped,omitempty"`
	// FailedPushes counts failed deliveries since start, including 400s the
	// server rejected: the number is history, lastError says what happened.
	FailedPushes uint64 `json:"failedPushes,omitempty"`
	// LastError is the most recent push failure, cleared by the next
	// successful push. Empty when the pipeline is currently clean.
	LastError string `json:"lastError,omitempty"`
	// CollectorErrors counts failures per collector since start. Docker
	// failures also travel as dockerError; the board suppresses the generic
	// warning for those to avoid printing the same problem twice.
	CollectorErrors map[string]uint64 `json:"collectorErrors,omitempty"`
}

// Mem holds bytes for totals and percent 0–100. Temp is the same deal as
// CPU: present on almost nothing (VPS never), hidden when zero.
type Mem struct {
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Percent float64 `json:"percent"`
	Temp    float64 `json:"temp,omitempty"`
}

// Disk is one mount. The agent sends every local mount it can read; the board
// shows the fullest first.
type Disk struct {
	Mount   string  `json:"mount"`
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Percent float64 `json:"percent"`
}

// GPU is best-effort by contract: failure yields Available false, never an
// error that stops the push.
type GPU struct {
	Available bool    `json:"available"`
	Util      float64 `json:"util,omitempty"`
	MemUsed   uint64  `json:"memUsed,omitempty"`
	MemTotal  uint64  `json:"memTotal,omitempty"`
	Temp      float64 `json:"temp,omitempty"`
	Name      string  `json:"name,omitempty"`
	// Gpus is every GPU on the box. The scalar fields above repeat the
	// first entry so old readers keep working; new readers use this.
	Gpus []GPUDetail `json:"gpus,omitempty"`
}

// GPUDetail is one physical GPU: compute load, VRAM pool and temperature.
// The board renders load and VRAM separately — one number cannot describe a
// card that is compute-idle with full memory, which is the common ML shape.
type GPUDetail struct {
	Name     string  `json:"name,omitempty"`
	Util     float64 `json:"util"`
	MemUsed  uint64  `json:"memUsed"`
	MemTotal uint64  `json:"memTotal"`
	Temp     float64 `json:"temp,omitempty"`
}

// Container is list + state, not stats. Per-container CPU/mem needs the stats
// stream and is explicitly phase 2.
type Container struct {
	Name   string   `json:"name"`
	Image  string   `json:"image"`
	State  string   `json:"state"`
	Health string   `json:"health,omitempty"`
	Ports  []string `json:"ports,omitempty"`
	// Uptime in seconds since the container started. 0 means unknown, not
	// "just started" — the board shows nothing rather than a wrong number.
	Uptime uint64 `json:"uptime,omitempty"`
}

// Payload is the full document POSTed as `metrics` to /api/push/:token.
// Unknown fields are ignored server-side, so additions are safe.
type Payload struct {
	V              int         `json:"v"`
	SampleInterval int         `json:"sampleInterval,omitempty"`
	Host           Host        `json:"host"`
	CPU            CPU         `json:"cpu"`
	Mem            Mem         `json:"mem"`
	Disk           []Disk      `json:"disk"`
	GPU            GPU         `json:"gpu"`
	Docker         []Container `json:"docker"`
	DockerError    string      `json:"dockerError,omitempty"`
	Updates        *Updates    `json:"updates,omitempty"`
	Agent          *AgentInfo  `json:"agent,omitempty"`
}
