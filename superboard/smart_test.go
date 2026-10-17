package main

import (
	"encoding/json"
	"testing"
)

const ataSmartFixture = `{
  "smart_status": { "passed": true },
  "temperature": { "current": 38 },
  "power_on_time": { "hours": 12345 },
  "ata_smart_attributes": {
    "table": [
      { "id": 1, "name": "Raw_Read_Error_Rate", "raw": { "value": 0 } },
      { "id": 5, "name": "Reallocated_Sector_Ct", "raw": { "value": 4 } },
      { "id": 177, "name": "Wear_Leveling_Count", "raw": { "value": 97 } }
    ]
  }
}`

const nvmeSmartFixture = `{
  "smart_status": { "passed": true },
  "nvme_smart_health_information_log": {
    "percentage_used": 3,
    "temperature": 41,
    "power_on_hours": 1000,
    "media_errors": 0
  }
}`

const failingSmartFixture = `{
  "smart_status": { "passed": false },
  "ata_smart_attributes": { "table": [ { "id": 5, "raw": { "value": 512 } } ] }
}`

func TestParseSMARTATA(t *testing.T) {
	disk, ok := parseSMARTJSON("sda", []byte(ataSmartFixture))
	if !ok {
		t.Fatal("ATA fixture must parse")
	}
	if disk.Health != "passed" {
		t.Fatalf("health = %q", disk.Health)
	}
	if disk.TempC != 38 || disk.PowerOnHours != 12345 {
		t.Fatalf("temp/hours = %v/%v", disk.TempC, disk.PowerOnHours)
	}
	if disk.ReallocatedSectors != 4 {
		t.Fatalf("reallocated = %v, want 4 (attribute id 5)", disk.ReallocatedSectors)
	}
	if disk.WearPercent != 0 {
		t.Fatalf("ATA wear must not be guessed: %v", disk.WearPercent)
	}
}

func TestParseSMARTNVMe(t *testing.T) {
	disk, ok := parseSMARTJSON("nvme0n1", []byte(nvmeSmartFixture))
	if !ok {
		t.Fatal("NVMe fixture must parse")
	}
	if disk.WearPercent != 3 {
		t.Fatalf("wear = %v, want 3", disk.WearPercent)
	}
	if disk.TempC != 41 || disk.PowerOnHours != 1000 {
		t.Fatalf("temp/hours = %v/%v", disk.TempC, disk.PowerOnHours)
	}
}

func TestParseSMARTFailingDisk(t *testing.T) {
	disk, ok := parseSMARTJSON("sdb", []byte(failingSmartFixture))
	if !ok {
		t.Fatal("failing fixture must still parse")
	}
	if disk.Health != "failed" {
		t.Fatalf("health = %q, want failed", disk.Health)
	}
	if disk.ReallocatedSectors != 512 {
		t.Fatalf("reallocated = %v", disk.ReallocatedSectors)
	}
}

func TestParseSMARTRejectsEmptyAndGarbage(t *testing.T) {
	if _, ok := parseSMARTJSON("sda", []byte("{not json")); ok {
		t.Fatal("garbage must not parse")
	}
	if _, ok := parseSMARTJSON("sda", []byte(`{"device":{"name":"/dev/sda"}}`)); ok {
		t.Fatal("a JSON envelope with no fields we read is not usable data")
	}
	if _, ok := parseSMARTJSON("sda", []byte(``)); ok {
		t.Fatal("empty output must not parse")
	}
}

func TestSMARTJSONShape(t *testing.T) {
	// available:false is explicit; a passed disk omits unknown counters
	// rather than zero-filling them.
	unavailable, err := json.Marshal(SMART{Available: false})
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(unavailable, &back); err != nil {
		t.Fatal(err)
	}
	if back["available"] != false {
		t.Fatalf("available flag = %v", back["available"])
	}
	if _, ok := back["disks"]; ok {
		t.Fatal("no disks must be omitted, not an empty array with omitempty semantics broken")
	}

	passed, _ := json.Marshal(SMARTDisk{Device: "sda", Health: "passed"})
	var diskBack map[string]any
	if err := json.Unmarshal(passed, &diskBack); err != nil {
		t.Fatal(err)
	}
	for _, absent := range []string{"wearPercent", "reallocatedSectors", "powerOnHours", "tempC"} {
		if _, ok := diskBack[absent]; ok {
			t.Fatalf("%s must be omitted when unknown", absent)
		}
	}
}
