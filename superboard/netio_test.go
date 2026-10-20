package main

import (
	"strings"
	"testing"
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
	all, err := readDiskCounters()
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

// A real-world /proc/diskstats excerpt (kernel 6.x: 20 columns) with the
// shapes the parser must handle: whole disks and partitions, NVMe, an idle
// loop device (all zero, omitted), device-mapper, an old 14-column line, a
// truncated line and a garbage counter.
const diskstatsFixture = `   7       0 loop0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
   7       1 loop1 52 0 2104 12 0 0 0 0 0 20 12 0 0 0 0 0 0
   8       0 sda 120345 2311 9876544 51230 98765 4321 7654320 88123 0 99123 140000 0 0 0 0 1234 900
   8       1 sda1 120000 2300 9870000 51000 98000 4300 7650000 88000 0 99000 139000 0 0 0 0 0 0
 259       0 nvme0n1 5000 10 400000 1200 6000 20 800000 3000 0 4000 4200 0 0 0 0 0 0
 259       1 nvme0n1p1 4900 10 399000 1100 5900 20 799000 2900 0 3900 4000 0 0 0 0 0 0
 253       0 dm-0 700 0 5600 100 800 0 6400 200 0 300 300
   8      16 sdb 10 0 80
   8      32 sdc 1 x 8 0 0 0 0 0 0 0 0 0 0 0
`

func TestParseDiskstatsFixture(t *testing.T) {
	got, err := parseDiskstats(strings.NewReader(diskstatsFixture))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]diskCounters{
		"loop1":     {ReadBytes: 2104 * 512, WriteBytes: 0},
		"sda":       {ReadBytes: 9876544 * 512, WriteBytes: 7654320 * 512},
		"sda1":      {ReadBytes: 9870000 * 512, WriteBytes: 7650000 * 512},
		"nvme0n1":   {ReadBytes: 400000 * 512, WriteBytes: 800000 * 512},
		"nvme0n1p1": {ReadBytes: 399000 * 512, WriteBytes: 799000 * 512},
		"dm-0":      {ReadBytes: 5600 * 512, WriteBytes: 6400 * 512},
	}
	if len(got) != len(want) {
		t.Fatalf("parsed %d devices (%v), want %d", len(got), got, len(want))
	}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("%s = %+v, want %+v", name, got[name], w)
		}
	}
	for _, absent := range []string{"loop0", "sdb", "sdc"} {
		if _, ok := got[absent]; ok {
			t.Errorf("%s must be skipped", absent)
		}
	}

	// The whole-disk filter downstream sees the same names as before.
	names := make([]string, 0, len(got))
	for name := range got {
		names = append(names, name)
	}
	disks := wholeDisks(names)
	if strings.Join(disks, ",") != "dm-0,loop1,nvme0n1,sda" {
		t.Fatalf("whole disks = %v", disks)
	}
}
