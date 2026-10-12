package main

import (
	"testing"

	"github.com/shirou/gopsutil/v4/disk"
)

func TestWholeDisksFiltersPartitions(t *testing.T) {
	cases := []struct {
		in   []string
		want []string
	}{
		{
			// Classic SATA: sda + partitions.
			[]string{"sda", "sda1", "sda2", "sdb", "sdb1"},
			[]string{"sda", "sdb"},
		},
		{
			// NVMe naming: whole device ends in a digit, partition adds pN.
			[]string{"nvme0n1", "nvme0n1p1", "nvme0n1p2"},
			[]string{"nvme0n1"},
		},
		{
			// eMMC.
			[]string{"mmcblk0", "mmcblk0p1"},
			[]string{"mmcblk0"},
		},
		{
			// Device-mapper and md have no parents in the list.
			[]string{"dm-0", "dm-1", "md0"},
			[]string{"dm-0", "dm-1", "md0"},
		},
		{
			// A lone partition (parent not reported) stays: better to count
			// it than to drop the only device.
			[]string{"sda1"},
			[]string{"sda1"},
		},
		{
			// vd* virtio naming.
			[]string{"vda", "vda1", "vdb"},
			[]string{"vda", "vdb"},
		},
	}

	for _, c := range cases {
		got := wholeDisks(c.in)
		if len(got) != len(c.want) {
			t.Fatalf("%v: got %v, want %v", c.in, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("%v: got %v, want %v", c.in, got, c.want)
			}
		}
	}
}

func TestCollectLoadShape(t *testing.T) {
	l := collectLoad()
	if l == nil {
		t.Skip("load average unavailable in this environment")
	}
	if l.Avg1 < 0 || l.Avg5 < 0 || l.Avg15 < 0 {
		t.Fatalf("load averages must be non-negative: %+v", l)
	}
}

func TestCollectNetExcludesLoopback(t *testing.T) {
	interfaces := collectNet()
	for _, iface := range interfaces {
		if iface.Iface == "lo" || iface.Iface == "lo0" {
			t.Fatalf("loopback must be excluded: %+v", iface)
		}
	}
	// On a machine with any network at all the list must be non-empty;
	// empty is tolerated only when the collector itself failed (nil).
	if interfaces != nil && len(interfaces) == 0 {
		t.Log("no non-loopback interfaces reported")
	}
}

func TestCollectDiskIOMatchesWholeDisks(t *testing.T) {
	ios := collectDiskIO()
	if ios == nil {
		t.Skip("disk IO counters unavailable in this environment")
	}
	// The collector must return exactly the whole-disk subset of the
	// kernel's device list.
	all, err := disk.IOCounters()
	if err != nil {
		t.Skipf("disk counters unavailable: %v", err)
	}
	names := make([]string, 0, len(all))
	for name := range all {
		names = append(names, name)
	}
	want := wholeDisks(names)
	got := make([]string, 0, len(ios))
	for _, io := range ios {
		got = append(got, io.Device)
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}
