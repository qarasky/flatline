package main

import (
	"context"
	"encoding/json"
	"log"
	"os/exec"
	"strings"
	"time"
)

// SMART disk health, best-effort by contract like nvidia-smi: a missing
// smartctl, an unreadable USB bridge or a driver quirk yields
// available:false or a skipped device, never an error that stops the push.
//
// Read-only: smartctl is invoked with -H (health) and -A (attributes) only.
// Values move slowly, so the live collector refreshes every few hours.

// smartRefreshInterval is how often the live collector re-reads SMART.
const smartRefreshInterval = 6 * time.Hour

// smartTimeout bounds one smartctl invocation; spinning disks can take a
// few seconds to answer, a wedged one must not stall the worker forever.
const smartTimeout = 15 * time.Second

// smartctlJSON is the subset of `smartctl -j` output we parse. Pointers
// distinguish "absent" from zero throughout.
type smartctlJSON struct {
	SmartStatus struct {
		Passed *bool `json:"passed"`
	} `json:"smart_status"`
	Temperature struct {
		Current *float64 `json:"current"`
	} `json:"temperature"`
	PowerOnTime struct {
		Hours *uint64 `json:"hours"`
	} `json:"power_on_time"`
	ATAAttributes struct {
		Table []struct {
			ID  int `json:"id"`
			Raw struct {
				Value *float64 `json:"value"`
			} `json:"raw"`
		} `json:"table"`
	} `json:"ata_smart_attributes"`
	NVMe struct {
		PercentageUsed *float64 `json:"percentage_used"`
		Temperature    *float64 `json:"temperature"`
		PowerOnHours   *uint64  `json:"power_on_hours"`
	} `json:"nvme_smart_health_information_log"`
}

// ataReallocatedSectorID is the SMART attribute for reallocated sectors —
// the classic "this disk is dying" counter, and the one number smartctl
// reports consistently across ATA vendors.
const ataReallocatedSectorID = 5

// parseSMARTJSON turns one smartctl -j output into a payload entry. The
// second return is false when the output carries no usable data (parse
// error, or a JSON envelope with none of the fields we read).
//
// smartctl exit codes are a bitmask — a failing disk exits nonzero while
// still printing valid JSON — so the caller parses regardless of exit code
// and relies on this function's verdict.
func parseSMARTJSON(device string, data []byte) (SMARTDisk, bool) {
	var raw smartctlJSON
	if err := json.Unmarshal(data, &raw); err != nil {
		return SMARTDisk{}, false
	}

	out := SMARTDisk{Device: device}
	usable := false

	if raw.SmartStatus.Passed != nil {
		if *raw.SmartStatus.Passed {
			out.Health = "passed"
		} else {
			out.Health = "failed"
		}
		usable = true
	}

	if raw.Temperature.Current != nil {
		out.TempC = *raw.Temperature.Current
		usable = true
	}
	if raw.NVMe.Temperature != nil && out.TempC == 0 {
		out.TempC = *raw.NVMe.Temperature
		usable = true
	}

	if raw.PowerOnTime.Hours != nil {
		out.PowerOnHours = *raw.PowerOnTime.Hours
		usable = true
	}
	if raw.NVMe.PowerOnHours != nil && out.PowerOnHours == 0 {
		out.PowerOnHours = *raw.NVMe.PowerOnHours
		usable = true
	}

	// Reallocated sectors: the first attribute with the well-known id.
	for _, attr := range raw.ATAAttributes.Table {
		if attr.ID == ataReallocatedSectorID && attr.Raw.Value != nil {
			out.ReallocatedSectors = *attr.Raw.Value
			usable = true
			break
		}
	}

	// Wear: NVMe reports percentage_used unambiguously. ATA wear attributes
	// (177/231/233) mean "remaining" on some vendors and "used" on others —
	// guessing would print a number that is wrong half the time, so it is
	// deliberately not guessed.
	if raw.NVMe.PercentageUsed != nil {
		out.WearPercent = *raw.NVMe.PercentageUsed
		usable = true
	}

	return out, usable
}

// smartDevices lists the whole disks to probe, using the same partition
// filter as the I/O counters.
func smartDevices() []string {
	counters, err := readDiskCounters()
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(counters))
	for name := range counters {
		names = append(names, name)
	}
	return wholeDisks(names)
}

// collectSMART probes every whole disk with smartctl. available:false means
// "no smartctl or no readable device" — explicit, never absent, so the
// board can distinguish "no SMART here" from "collector broken".
//
// prev is the last published reading (nil for one-shot checks): a disk that
// is asleep keeps its previous entry rather than being woken or dropped.
func collectSMART(prev *SMART) *SMART {
	path, err := exec.LookPath("smartctl")
	if err != nil {
		return &SMART{Available: false}
	}

	devices := smartDevices()
	if len(devices) == 0 {
		return &SMART{Available: false}
	}

	out := &SMART{Available: true, Disks: []SMARTDisk{}}
	for _, device := range devices {
		ctx, cancel := context.WithTimeout(context.Background(), smartTimeout)
		cmd := boundedCommand(ctx, path, smartctlArgs(device)...)
		data, _ := cmd.Output() // exit codes are a bitmask; JSON is parsed regardless
		cancel()

		if len(data) == 0 {
			stats.recordCollectorError("smart")
			log.Printf("warning: smartctl produced no output for %s", device)
			continue
		}
		if parsed, ok := parseSMARTJSON(device, data); ok {
			out.Disks = append(out.Disks, parsed)
		} else if smartInStandby(data) {
			if kept, ok := previousSMARTDisk(prev, device); ok {
				out.Disks = append(out.Disks, kept)
			}
		}
	}
	if len(out.Disks) > 0 {
		stats.recordCollectorRecovered("smart")
	}
	return out
}

// smartctlArgs is the read-only probe for one device. -n standby: never spin
// up a sleeping disk just to read its health every six hours; smartctl then
// exits early and the caller keeps the previous reading.
func smartctlArgs(device string) []string {
	return []string{"-j", "-n", "standby", "-H", "-A", "/dev/" + device}
}

// smartInStandby reports whether smartctl skipped the device because of -n
// standby ("Device is in STANDBY mode, exit(2)"; SLEEP for some drives).
func smartInStandby(data []byte) bool {
	var raw struct {
		Smartctl struct {
			Messages []struct {
				String string `json:"string"`
			} `json:"messages"`
		} `json:"smartctl"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return false
	}
	for _, m := range raw.Smartctl.Messages {
		upper := strings.ToUpper(m.String)
		if strings.Contains(upper, "STANDBY") || strings.Contains(upper, "SLEEP") {
			return true
		}
	}
	return false
}

// previousSMARTDisk finds device in the previous reading.
func previousSMARTDisk(prev *SMART, device string) (SMARTDisk, bool) {
	if prev == nil {
		return SMARTDisk{}, false
	}
	for _, d := range prev.Disks {
		if d.Device == device {
			return d, true
		}
	}
	return SMARTDisk{}, false
}
