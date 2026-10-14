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

import "time"

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

// Load is the 1/5/15-minute load average, a gauge. It is sent as-is; there
// is no counter delta to own server-side.
type Load struct {
	Avg1  float64 `json:"avg1"`
	Avg5  float64 `json:"avg5"`
	Avg15 float64 `json:"avg15"`
}

// NetInterface is one interface's cumulative byte counters, loopback
// excluded. Raw counters, not rates: the server diffs consecutive
// snapshots, same contract as CPU. Virtual interfaces (veth, docker,
// bridges) are included in the payload; the server excludes them when
// summing the card's throughput so container traffic is not double counted.
type NetInterface struct {
	Iface   string `json:"iface"`
	RxBytes uint64 `json:"rxBytes"`
	TxBytes uint64 `json:"txBytes"`
}

// DiskIO is one whole disk's cumulative byte counters. Partitions are
// filtered out (their counters are already in their disk's). Raw counters;
// the server derives rates.
type DiskIO struct {
	Device     string `json:"device"`
	ReadBytes  uint64 `json:"readBytes"`
	WriteBytes uint64 `json:"writeBytes"`
}

// NetRate and DiskIoRate are server-derived throughput over the window
// since the previous push (see server/io-rates.js). They exist only on live
// samples: history keeps the raw counters, which are lossless.
type NetRate struct {
	RxBytesPerSec float64 `json:"rxBytesPerSec"`
	TxBytesPerSec float64 `json:"txBytesPerSec"`
	WindowSeconds float64 `json:"windowSeconds"`
}

type DiskIoRate struct {
	ReadBytesPerSec  float64 `json:"readBytesPerSec"`
	WriteBytesPerSec float64 `json:"writeBytesPerSec"`
	WindowSeconds    float64 `json:"windowSeconds"`
}

// SMART is disk health, best-effort by contract like the GPU block:
// available:false is explicit ("no smartctl / no readable device"), never
// absent, so a blind agent is distinguishable from a healthy one.
type SMART struct {
	Available bool        `json:"available"`
	Disks     []SMARTDisk `json:"disks,omitempty"`
}

// SMARTDisk is one whole disk's health. Health is "passed"/"failed" when
// smartctl reported it; the counters are omitted when unknown, never
// zero-filled. WearPercent comes from NVMe percentage_used only: ATA wear
// attributes mean "remaining" on some vendors and "used" on others, and
// guessing would be wrong half the time.
type SMARTDisk struct {
	Device             string  `json:"device"`
	Health             string  `json:"health,omitempty"`
	TempC              float64 `json:"tempC,omitempty"`
	WearPercent        float64 `json:"wearPercent,omitempty"`
	ReallocatedSectors float64 `json:"reallocatedSectors,omitempty"`
	PowerOnHours       uint64  `json:"powerOnHours,omitempty"`
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
	// SamplesDropped counts samples lost before delivery: buffer evictions
	// when the byte cap is hit, failed or corrupt buffer writes, and
	// superseded samples in the fallback in-memory queue.
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

// Container is list + state plus best-effort live stats. Per-container
// history is deliberately out of scope; stats are the current reading.
type Container struct {
	Name   string   `json:"name"`
	Image  string   `json:"image"`
	State  string   `json:"state"`
	Health string   `json:"health,omitempty"`
	Ports  []string `json:"ports,omitempty"`
	// Uptime in seconds since the container started. 0 means unknown, not
	// "just started" — the board shows nothing rather than a wrong number.
	Uptime uint64 `json:"uptime,omitempty"`
	// Stats is absent when the container is not running or the daemon could
	// not be asked; a present block always carries memory, CPU only when a
	// previous cumulative read exists (first tick, restarts).
	Stats *ContainerStats `json:"stats,omitempty"`
}

// ContainerStats is one live reading for one container. CPU follows Docker's
// convention: percent of a single core, so a container using four cores
// reads 400%. Pointers distinguish "unknown" from a real zero (an idle
// container is 0%, not missing).
type ContainerStats struct {
	CPUPercent *float64 `json:"cpuPercent,omitempty"`
	MemUsed    uint64   `json:"memUsed,omitempty"`
	MemLimit   uint64   `json:"memLimit,omitempty"`
	MemPercent *float64 `json:"memPercent,omitempty"`
}

// Payload is the full document POSTed as `metrics` to /api/push/:token.
// Unknown fields are ignored server-side, so additions are safe.
type Payload struct {
	V              int `json:"v"`
	SampleInterval int `json:"sampleInterval,omitempty"`
	// SampledAt is when this sample was taken (RFC3339, millisecond, UTC).
	// Live agents include it so buffered backfill can carry the true sample
	// time; the server validates it and falls back to receive time. The
	// server stays the clock authority — this is an optimisation, never a
	// requirement.
	SampledAt   string      `json:"sampledAt,omitempty"`
	Host        Host        `json:"host"`
	CPU         CPU         `json:"cpu"`
	Mem         Mem         `json:"mem"`
	Disk        []Disk      `json:"disk"`
	GPU         GPU         `json:"gpu"`
	Docker      []Container `json:"docker"`
	DockerError string      `json:"dockerError,omitempty"`
	// DockerAt is when the container list was last collected completely
	// (RFC3339, omitted when never). The board compares it with the sample
	// timestamp so a list a stalling daemon left behind is visibly old.
	DockerAt time.Time      `json:"dockerAt,omitzero"`
	Updates  *Updates       `json:"updates,omitempty"`
	Agent    *AgentInfo     `json:"agent,omitempty"`
	Load     *Load          `json:"load,omitempty"`
	Net      []NetInterface `json:"net,omitempty"`
	DiskIO   []DiskIO       `json:"diskIo,omitempty"`
	Smart    *SMART         `json:"smart,omitempty"`
	// Server-derived rates (live samples only; absent from agent payloads).
	NetRate    *NetRate    `json:"netRate,omitempty"`
	DiskIoRate *DiskIoRate `json:"diskIoRate,omitempty"`
}

// sampleTimeFormat is RFC3339 with milliseconds in UTC, matching the server's
// millisecond storage precision.
const sampleTimeFormat = "2006-01-02T15:04:05.000Z07:00"

// stampSample records when the sample was taken.
func stampSample(p *Payload) {
	p.SampledAt = time.Now().UTC().Format(sampleTimeFormat)
}
