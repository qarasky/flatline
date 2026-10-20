package main

import (
	"sort"
	"strings"

	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/net"
)

// Host I/O and load collectors.
//
// Contract, same as CPU: network and disk I/O are forwarded as raw
// cumulative byte counters and the server diffs consecutive snapshots into
// rates. Load average is a gauge, not a counter — no delta math anywhere.
// All three are best-effort: a failure logs and omits the field, never
// fails the push.

// collectLoad reads the 1/5/15-minute load averages.
func collectLoad() *Load {
	avg, err := load.Avg()
	if err != nil {
		stats.recordCollectorError("load")
		return nil
	}
	stats.recordCollectorRecovered("load")
	return &Load{Avg1: avg.Load1, Avg5: avg.Load5, Avg15: avg.Load15}
}

// collectNet reports cumulative per-interface byte counters, excluding
// loopback. Virtual interfaces are kept in the payload — the server decides
// what to sum for the card, and a raw list is lossless.
func collectNet() []NetInterface {
	counters, err := net.IOCounters(true)
	if err != nil {
		stats.recordCollectorError("net")
		return nil
	}

	var out []NetInterface
	for _, c := range counters {
		if c.Name == "lo" || c.Name == "lo0" {
			continue
		}
		out = append(out, NetInterface{
			Iface:   c.Name,
			RxBytes: c.BytesRecv,
			TxBytes: c.BytesSent,
		})
	}
	stats.recordCollectorRecovered("net")
	sort.Slice(out, func(i, j int) bool { return out[i].Iface < out[j].Iface })
	return out
}

// collectDiskIO reports cumulative per-disk read/write byte counters for
// whole disks only. A partition's counters are already included in its
// disk's, so summing both would double count.
func collectDiskIO() []DiskIO {
	counters, err := readDiskCounters()
	if err != nil {
		stats.recordCollectorError("diskio")
		return nil
	}

	names := make([]string, 0, len(counters))
	for name := range counters {
		names = append(names, name)
	}

	stats.recordCollectorRecovered("diskio")
	var out []DiskIO
	for _, name := range wholeDisks(names) {
		c := counters[name]
		out = append(out, DiskIO{
			Device:     name,
			ReadBytes:  c.ReadBytes,
			WriteBytes: c.WriteBytes,
		})
	}
	return out
}

// wholeDisks filters partition device names out of a device list.
//
// A name is a partition when stripping its trailing digits (and an optional
// "p" separator) yields another name in the list: sda1 -> sda,
// nvme0n1p2 -> nvme0n1, mmcblk0p1 -> mmcblk0. Whole devices whose name ends
// in digits (nvme0n1, dm-0, md0) have no such parent and stay.
func wholeDisks(names []string) []string {
	present := make(map[string]bool, len(names))
	for _, name := range names {
		present[name] = true
	}

	var out []string
	for _, name := range names {
		base := stripPartitionSuffix(name)
		if base != name && present[base] {
			continue
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// stripPartitionSuffix removes a trailing partition index: "sda1" -> "sda",
// "nvme0n1p2" -> "nvme0n1". Returns the name unchanged when there is no
// numeric suffix. Whether the result is actually a parent is decided by the
// caller, which knows the full device list.
func stripPartitionSuffix(name string) string {
	trimmed := strings.TrimRight(name, "0123456789")
	if trimmed == name {
		return name
	}
	return strings.TrimSuffix(trimmed, "p")
}
