//! Server-side rate derivation for cumulative byte counters
//! (`io-rates.js`).
//!
//! Same contract as CPU: agents forward raw cumulative snapshots (network
//! interfaces, whole disks) and the server owns the window. Rates are
//! derived between consecutive pushes and attached to the live sample as
//! `netRate`/`diskIoRate`; archived rows keep the raw counters, which are
//! lossless.
//!
//! Every function is total: missing data, counter resets, non-positive or
//! absurdly long windows all yield None, and the board simply shows
//! nothing. A gap (agent restart, outage) must never be averaged into a
//! fake rate.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

/// Longest window a rate may describe; beyond it, gaps win and the rate is
/// omitted.
pub const MAX_WINDOW_MS: i64 = 5 * 60_000;

/// Virtual interface prefixes excluded when summing card throughput.
/// Container and bridge traffic already traverses the physical parent, so
/// summing both would double count. If a host only has virtual interfaces
/// (rare), the fallback sums everything rather than showing zero.
fn is_virtual(iface: &str) -> bool {
    ["veth", "docker", "br-", "virbr", "vnet", "tap", "tun", "wg"]
        .iter()
        .any(|prefix| iface.starts_with(prefix))
}

/// Interface name -> (rxBytes, txBytes).
pub type NetMap = BTreeMap<String, (f64, f64)>;
/// Device name -> (readBytes, writeBytes).
pub type DiskMap = BTreeMap<String, (f64, f64)>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetRate {
    pub rx_bytes_per_sec: f64,
    pub tx_bytes_per_sec: f64,
    pub window_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskRate {
    pub read_bytes_per_sec: f64,
    pub write_bytes_per_sec: f64,
    pub window_seconds: f64,
}

/// Normalise the `net` list of one payload into a map of counters.
pub fn net_snapshot(metrics: &Value) -> Option<NetMap> {
    let list = metrics.get("net")?.as_array()?;
    let mut map = NetMap::new();
    for entry in list {
        let iface = entry
            .get("iface")
            .and_then(Value::as_str)
            .filter(|iface| !iface.is_empty());
        let rx = entry.get("rxBytes").and_then(Value::as_f64);
        let tx = entry.get("txBytes").and_then(Value::as_f64);
        if let (Some(iface), Some(rx), Some(tx)) = (iface, rx, tx)
            && rx >= 0.0
            && tx >= 0.0
        {
            map.insert(iface.to_string(), (rx, tx));
        }
    }
    if map.is_empty() { None } else { Some(map) }
}

/// Normalise the `diskIo` list of one payload into a map of counters.
pub fn disk_snapshot(metrics: &Value) -> Option<DiskMap> {
    let list = metrics.get("diskIo")?.as_array()?;
    let mut map = DiskMap::new();
    for entry in list {
        let device = entry
            .get("device")
            .and_then(Value::as_str)
            .filter(|device| !device.is_empty());
        let read = entry.get("readBytes").and_then(Value::as_f64);
        let write = entry.get("writeBytes").and_then(Value::as_f64);
        if let (Some(device), Some(read), Some(write)) = (device, read, write)
            && read >= 0.0
            && write >= 0.0
        {
            map.insert(device.to_string(), (read, write));
        }
    }
    if map.is_empty() { None } else { Some(map) }
}

/// Sum per-key deltas over the counters both snapshots share. Returns None
/// when nothing matched or a counter decreased (reset, reboot).
fn sum_deltas<F: Fn(&str) -> bool>(
    prev: &BTreeMap<String, (f64, f64)>,
    cur: &BTreeMap<String, (f64, f64)>,
    include: F,
) -> Option<(f64, f64)> {
    let mut totals: Option<(f64, f64)> = None;
    for (key, after) in cur {
        if !include(key) {
            continue;
        }
        let Some(before) = prev.get(key) else {
            // Interface/device appeared mid-window: no valid delta yet.
            continue;
        };
        if after.0 < before.0 || after.1 < before.1 {
            return None;
        }
        let totals = totals.get_or_insert((0.0, 0.0));
        totals.0 += after.0 - before.0;
        totals.1 += after.1 - before.1;
    }
    totals
}

/// Network throughput between two snapshots, non-virtual interfaces first.
pub fn net_rates(prev: &NetMap, cur: &NetMap, dt_ms: i64) -> Option<NetRate> {
    if dt_ms <= 0 || dt_ms > MAX_WINDOW_MS {
        return None;
    }
    let totals = sum_deltas(prev, cur, |key| !is_virtual(key))
        .or_else(|| sum_deltas(prev, cur, |_| true))?;
    let seconds = dt_ms as f64 / 1000.0;
    Some(NetRate {
        rx_bytes_per_sec: totals.0 / seconds,
        tx_bytes_per_sec: totals.1 / seconds,
        window_seconds: seconds,
    })
}

/// Disk throughput between two snapshots, summed over whole disks.
pub fn disk_rates(prev: &DiskMap, cur: &DiskMap, dt_ms: i64) -> Option<DiskRate> {
    if dt_ms <= 0 || dt_ms > MAX_WINDOW_MS {
        return None;
    }
    let totals = sum_deltas(prev, cur, |_| true)?;
    let seconds = dt_ms as f64 / 1000.0;
    Some(DiskRate {
        read_bytes_per_sec: totals.0 / seconds,
        write_bytes_per_sec: totals.1 / seconds,
        window_seconds: seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshots_parse_lists() {
        let metrics = json!({
            "net": [
                { "iface": "eth0", "rxBytes": 100, "txBytes": 200 },
                { "iface": "", "rxBytes": 1, "txBytes": 1 },
                { "iface": "lo", "rxBytes": -1, "txBytes": 1 }
            ]
        });
        let map = net_snapshot(&metrics).unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map["eth0"], (100.0, 200.0));

        assert!(net_snapshot(&json!({})).is_none());
        assert!(net_snapshot(&json!({ "net": [] })).is_none());
    }

    #[test]
    fn rates_exclude_virtual_interfaces() {
        let prev = NetMap::from([
            ("eth0".to_string(), (0.0, 0.0)),
            ("docker0".to_string(), (0.0, 0.0)),
        ]);
        let cur = NetMap::from([
            ("eth0".to_string(), (1000.0, 2000.0)),
            ("docker0".to_string(), (500.0, 500.0)),
        ]);
        let rate = net_rates(&prev, &cur, 1000).unwrap();
        assert_eq!(rate.rx_bytes_per_sec, 1000.0);
        assert_eq!(rate.tx_bytes_per_sec, 2000.0);
        assert_eq!(rate.window_seconds, 1.0);
    }

    #[test]
    fn rates_refuse_resets_and_long_windows() {
        let prev = NetMap::from([("eth0".to_string(), (1000.0, 1000.0))]);
        let cur = NetMap::from([("eth0".to_string(), (10.0, 2000.0))]);
        assert!(net_rates(&prev, &cur, 1000).is_none(), "counter reset");

        let big = NetMap::from([("eth0".to_string(), (2000.0, 2000.0))]);
        assert!(net_rates(&prev, &big, 0).is_none());
        assert!(net_rates(&prev, &big, MAX_WINDOW_MS + 1).is_none());
        assert!(net_rates(&prev, &big, 1000).is_some());
    }

    #[test]
    fn disk_rates_sum_devices() {
        let prev = DiskMap::from([
            ("sda".to_string(), (0.0, 0.0)),
            ("sdb".to_string(), (100.0, 100.0)),
        ]);
        let cur = DiskMap::from([
            ("sda".to_string(), (300.0, 0.0)),
            ("sdb".to_string(), (100.0, 200.0)),
        ]);
        let rate = disk_rates(&prev, &cur, 2000).unwrap();
        assert_eq!(rate.read_bytes_per_sec, 150.0);
        assert_eq!(rate.write_bytes_per_sec, 50.0);
        assert_eq!(rate.window_seconds, 2.0);
    }
}
