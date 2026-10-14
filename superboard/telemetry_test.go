package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestAgentInfoCountsCollectorEpisodes(t *testing.T) {
	// A collector that keeps failing is one problem, not a per-tick event:
	// repeat failures while it stays broken must not move the counter (the
	// office host's nvidia-smi driver mismatch failed every 5s and made the
	// board's warning line climb forever).
	stats.recordCollectorRecovered("gpu")
	stats.recordCollectorRecovered("updates")
	before := agentInfoSnapshot()
	stats.recordCollectorError("gpu")
	stats.recordCollectorError("gpu")
	stats.recordCollectorError("gpu")
	stats.recordCollectorError("updates")
	after := agentInfoSnapshot()

	if after.CollectorErrors["gpu"] != before.CollectorErrors["gpu"]+1 {
		t.Fatalf("gpu errors = %d, want +1 for one episode", after.CollectorErrors["gpu"])
	}
	if after.CollectorErrors["updates"] != before.CollectorErrors["updates"]+1 {
		t.Fatalf("updates errors = %d, want +1", after.CollectorErrors["updates"])
	}

	// Recovery closes the episode; the next failure counts again.
	stats.recordCollectorRecovered("gpu")
	stats.recordCollectorError("gpu")
	if got := agentInfoSnapshot().CollectorErrors["gpu"]; got != after.CollectorErrors["gpu"]+1 {
		t.Fatalf("gpu errors after recovery = %d, want +1", got)
	}
	if _, ok := after.CollectorErrors["disk"]; ok && before.CollectorErrors["disk"] == 0 {
		t.Fatal("zero counters must be omitted from the report")
	}
}

func TestGPUBackoffAfterRepeatedFailures(t *testing.T) {
	gpuNoteRecovered()
	if !gpuAttemptDue() {
		t.Fatal("a recovered GPU must be polled")
	}
	for i := 0; i < gpuBackoffAfterFailures; i++ {
		gpuNoteFailure(errTest{})
	}
	if gpuAttemptDue() {
		t.Fatal("a persistently failing nvidia-smi must back off")
	}
	gpuNoteRecovered()
	if !gpuAttemptDue() {
		t.Fatal("recovery must clear the backoff")
	}
}

func TestAgentInfoLastErrorRoundTrip(t *testing.T) {
	stats.recordPushOk()
	if got := agentInfoSnapshot().LastError; got != "" {
		t.Fatalf("clean pipeline must have no last error, got %q", got)
	}

	stats.recordPushLost(errTest{})
	if got := agentInfoSnapshot().LastError; got != "connection refused" {
		t.Fatalf("last error = %q", got)
	}
	if failed := agentInfoSnapshot().FailedPushes; failed < 1 {
		t.Fatal("lost samples must be counted")
	}

	// A retried failure is not a loss: it must set the reason without
	// moving the counter.
	lostBefore := agentInfoSnapshot().FailedPushes
	stats.recordPushRetry(errTest{msg: "transient 503"})
	if got := agentInfoSnapshot().FailedPushes; got != lostBefore {
		t.Fatalf("a retried failure counted as lost: %d -> %d", lostBefore, got)
	}
	if got := agentInfoSnapshot().LastError; got != "transient 503" {
		t.Fatalf("a retried failure must still be visible, got %q", got)
	}

	stats.recordPushOk()
	if got := agentInfoSnapshot().LastError; got != "" {
		t.Fatalf("success must clear the last error, got %q", got)
	}
}

func TestAgentInfoTruncatesLongErrors(t *testing.T) {
	stats.recordPushRetry(errTest{msg: strings.Repeat("x", 500)})
	if got := len(agentInfoSnapshot().LastError); got != maxErrorLength {
		t.Fatalf("error length = %d, want %d", got, maxErrorLength)
	}
	stats.recordPushOk()
}

func TestOfferLatestCountsDrops(t *testing.T) {
	samples := make(chan *Payload, 1)
	before := agentInfoSnapshot().SamplesDropped

	offerLatest(samples, &Payload{CPU: CPU{Percent: 1}}) // fills the queue: no drop
	offerLatest(samples, &Payload{CPU: CPU{Percent: 2}}) // replaces: one drop
	offerLatest(samples, &Payload{CPU: CPU{Percent: 3}}) // replaces: another drop

	if got := agentInfoSnapshot().SamplesDropped - before; got != 2 {
		t.Fatalf("drops = %d, want 2", got)
	}
	if (<-samples).CPU.Percent != 3 {
		t.Fatal("latest sample must survive")
	}
}

func TestPayloadAgentOmittedWhenAbsent(t *testing.T) {
	data, err := json.Marshal(Payload{V: 1})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), `"agent"`) {
		t.Fatal("absent agent must be omitted so old readers see today's payload")
	}
}

func TestPayloadAgentRoundTrip(t *testing.T) {
	p := Payload{V: 1, Agent: &AgentInfo{
		Version: "1.4.0", Uptime: 90, SamplesDropped: 2, FailedPushes: 3,
		LastError:       "push: connection refused",
		CollectorErrors: map[string]uint64{"gpu": 1, "updates": 4},
	}}
	data, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var back Payload
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	a := back.Agent
	if a == nil || a.Version != "1.4.0" || a.Uptime != 90 || a.SamplesDropped != 2 ||
		a.FailedPushes != 3 || a.LastError != "push: connection refused" ||
		a.CollectorErrors["gpu"] != 1 || a.CollectorErrors["updates"] != 4 {
		t.Fatalf("round trip lost agent data: %+v", a)
	}
}

func TestLiveSampleCarriesAgentTelemetry(t *testing.T) {
	c := &liveCollector{host: Host{Hostname: "test"}, started: time.Now().Add(-time.Second)}
	p, err := c.sample()
	if err != nil {
		t.Fatal(err)
	}
	if p.Agent == nil {
		t.Fatal("live samples must carry the self-report")
	}
	if p.Agent.Version != version {
		t.Fatalf("agent version = %q, want %q", p.Agent.Version, version)
	}
}

// errTest is a controllable error for telemetry tests.
type errTest struct{ msg string }

func (e errTest) Error() string {
	if e.msg != "" {
		return e.msg
	}
	return "connection refused"
}
