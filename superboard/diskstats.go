package main

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/shirou/gopsutil/v4/disk"
)

// diskstatsSectorSize is the unit of the sector columns in /proc/diskstats.
// The kernel always reports 512-byte sectors there, whatever the device's
// logical block size (Documentation/admin-guide/iostats.rst).
const diskstatsSectorSize = 512

// diskCounters is one device's cumulative byte counters.
type diskCounters struct {
	ReadBytes  uint64
	WriteBytes uint64
}

// diskstatsPath honours HOST_PROC like gopsutil did, so an agent reading a
// host's /proc from inside a container keeps working.
func diskstatsPath() string {
	root := os.Getenv("HOST_PROC")
	if root == "" {
		root = "/proc"
	}
	return filepath.Join(root, "diskstats")
}

// parseDiskstats reads /proc/diskstats text into per-device counters.
//
// It replaces gopsutil's disk.IOCounters on the per-second path: that call
// also looks up a serial number and label for every device (several sysfs
// and udev file opens each), which on a snap- or device-mapper-heavy host is
// dozens of opens per second for two numbers we actually use.
//
// The semantics are the ones gopsutil had, so the payload does not change:
// lines with fewer than 14 fields are ignored, a device whose eleven classic
// counters are all zero (an unused loop or ram device) is omitted, and bytes
// are sectors × 512. A line with an unparseable counter is skipped rather
// than failing the whole read.
func parseDiskstats(r io.Reader) (map[string]diskCounters, error) {
	out := make(map[string]diskCounters)
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 14 {
			continue
		}
		var values [11]uint64
		ok := true
		allZero := true
		for i := range values {
			v, err := strconv.ParseUint(fields[3+i], 10, 64)
			if err != nil {
				ok = false
				break
			}
			values[i] = v
			if v != 0 {
				allZero = false
			}
		}
		if !ok || allZero {
			continue
		}
		// Columns after the name: reads, reads merged, sectors read, ms
		// reading, writes, writes merged, sectors written, ...
		out[fields[2]] = diskCounters{
			ReadBytes:  values[2] * diskstatsSectorSize,
			WriteBytes: values[6] * diskstatsSectorSize,
		}
	}
	return out, scanner.Err()
}

// readDiskCounters returns per-device counters: /proc/diskstats on Linux,
// gopsutil elsewhere (developer machines; the agent ships for Linux only).
func readDiskCounters() (map[string]diskCounters, error) {
	if runtime.GOOS != "linux" {
		counters, err := disk.IOCounters()
		if err != nil {
			return nil, err
		}
		out := make(map[string]diskCounters, len(counters))
		for name, c := range counters {
			out[name] = diskCounters{ReadBytes: c.ReadBytes, WriteBytes: c.WriteBytes}
		}
		return out, nil
	}
	f, err := os.Open(diskstatsPath())
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return parseDiskstats(f)
}
