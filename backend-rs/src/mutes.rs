//! Mutes: acknowledging a known outage.
//!
//! A mute belongs to a subject monitor (a server card, or any monitor muted
//! from the dashboard) and holds a snapshot of what was broken when the
//! operator muted it: the monitors on the subject that were down, plus the
//! disks failing SMART and the mounts over the disk-full level. A monitor is
//! *covered* while it is in some active mute's snapshot; a group is covered
//! when it is down and every down leaf beneath it is covered.
//!
//! Mutes are short-lived on purpose: recovery shrinks the snapshot and
//! anything new and substantial deletes the mute, so a mute never outlives
//! its outage. Every function here is a plain query over the pool; callers
//! publish `invalidate` when a change returns true.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::heartbeats::{DOWN, PENDING};

/// Serialises every read-modify-write of `monitor_mutes`. The rows are
/// shared across monitors (one website's recovery and another's, a mute
/// request and a recovery), so the per-monitor heartbeat lock is not enough:
/// a lost update could keep a recovered monitor in a snapshot and silence its
/// next outage.
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Disk-full level when the monitor has no disk alert threshold: the
/// Superboard card's "hot" level.
pub const DISK_FULL_DEFAULT: f64 = 90.0;

/// One active mute.
#[derive(Debug, Clone, PartialEq)]
pub struct Mute {
    pub subject: i64,
    pub muted_at: String,
    /// Snapshot monitors still down, sorted.
    pub monitors: Vec<i64>,
    pub smart_failed: Vec<String>,
    pub full_mounts: Vec<String>,
}

impl Mute {
    /// The subject itself is part of the mute (its host is down). Only then
    /// are the subject's own CPU/RAM and backup alerts silenced.
    pub fn host_muted(&self) -> bool {
        self.monitors.contains(&self.subject)
    }

    pub fn to_json(&self) -> Value {
        json!({
            "mutedAt": self.muted_at,
            "monitors": self.monitors,
            "hostMuted": self.host_muted(),
            "smartFailed": self.smart_failed,
            "fullMounts": self.full_mounts,
        })
    }
}

#[derive(Debug)]
pub enum MuteError {
    NotFound,
    NothingDown,
    Db(sqlx::Error),
}

impl From<sqlx::Error> for MuteError {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(error)
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    monitor_id: i64,
    muted_at: String,
    monitors: String,
    smart_failed: String,
    full_mounts: String,
}

impl From<Row> for Mute {
    fn from(row: Row) -> Self {
        // An unreadable column reads as an empty list rather than failing.
        Self {
            subject: row.monitor_id,
            muted_at: row.muted_at,
            monitors: serde_json::from_str(&row.monitors).unwrap_or_default(),
            smart_failed: serde_json::from_str(&row.smart_failed).unwrap_or_default(),
            full_mounts: serde_json::from_str(&row.full_mounts).unwrap_or_default(),
        }
    }
}

/// Disks the sample reports SMART `failed`, by device, sorted.
pub fn smart_failed(sample: &Value) -> Vec<String> {
    let set: BTreeSet<String> = sample
        .pointer("/smart/disks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|disk| disk.get("health").and_then(Value::as_str) == Some("failed"))
        .map(|disk| {
            disk.get("device")
                .and_then(Value::as_str)
                .unwrap_or("disk")
                .to_string()
        })
        .collect();
    set.into_iter().collect()
}

/// Mounts at or above the disk-full level, sorted.
pub fn full_mounts(sample: &Value, disk_threshold: Option<i64>) -> Vec<String> {
    let level = disk_threshold.map_or(DISK_FULL_DEFAULT, |t| t as f64);
    let set: BTreeSet<String> = sample
        .get("disk")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|mount| {
            mount
                .get("percent")
                .and_then(Value::as_f64)
                .is_some_and(|percent| percent.is_finite() && percent >= level)
        })
        .map(|mount| {
            mount
                .get("mount")
                .and_then(Value::as_str)
                .unwrap_or("?")
                .to_string()
        })
        .collect();
    set.into_iter().collect()
}

pub async fn get(pool: &SqlitePool, subject: i64) -> sqlx::Result<Option<Mute>> {
    let row: Option<Row> = sqlx::query_as("SELECT * FROM monitor_mutes WHERE monitor_id = ?")
        .bind(subject)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(Mute::from))
}

pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<Mute>> {
    let rows: Vec<Row> = sqlx::query_as("SELECT * FROM monitor_mutes ORDER BY monitor_id")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(Mute::from).collect())
}

/// Insert or replace a mute row.
pub(crate) async fn save(pool: &SqlitePool, mute: &Mute) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO monitor_mutes (monitor_id, muted_at, monitors, smart_failed, full_mounts)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (monitor_id) DO UPDATE SET
             muted_at = excluded.muted_at, monitors = excluded.monitors,
             smart_failed = excluded.smart_failed, full_mounts = excluded.full_mounts",
    )
    .bind(mute.subject)
    .bind(&mute.muted_at)
    .bind(encode(&mute.monitors))
    .bind(encode(&mute.smart_failed))
    .bind(encode(&mute.full_mounts))
    .execute(pool)
    .await?;
    Ok(())
}

/// Shrink an existing mute in place. A plain UPDATE: a mute deleted in the
/// meantime is never written back.
async fn update_snapshot(pool: &SqlitePool, mute: &Mute) -> sqlx::Result<()> {
    sqlx::query("UPDATE monitor_mutes SET monitors = ?, full_mounts = ? WHERE monitor_id = ?")
        .bind(encode(&mute.monitors))
        .bind(encode(&mute.full_mounts))
        .bind(mute.subject)
        .execute(pool)
        .await?;
    Ok(())
}

/// JSON-encode a snapshot list for storage.
fn encode<T: serde::Serialize>(list: &[T]) -> String {
    serde_json::to_string(list).unwrap_or_else(|_| "[]".to_string())
}

pub(crate) async fn delete(pool: &SqlitePool, subject: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM monitor_mutes WHERE monitor_id = ?")
        .bind(subject)
        .execute(pool)
        .await?;
    Ok(())
}

/// Latest status per monitor; a monitor with no beat yet is pending.
pub(crate) async fn statuses(pool: &SqlitePool, ids: &[i64]) -> sqlx::Result<HashMap<i64, i64>> {
    let beats = crate::status_pages::recent_beats(pool, ids, 1).await?;
    Ok(ids
        .iter()
        .map(|id| {
            let status = beats
                .get(id)
                .and_then(|list| list.first())
                .map_or(PENDING, |beat| beat.status);
            (*id, status)
        })
        .collect())
}

/// `(id, latest status)` for the subject and every website on its card; for
/// a group, every monitor inside it.
pub async fn card_monitors(pool: &SqlitePool, subject: i64) -> sqlx::Result<Vec<(i64, i64)>> {
    let (_, resolved) = crate::links::resolve(pool, subject)
        .await
        .map_err(|error| sqlx::Error::Protocol(format!("resolve links: {error:?}")))?;
    let kind: Option<String> = sqlx::query_scalar("SELECT type FROM monitors WHERE id = ?")
        .bind(subject)
        .fetch_optional(pool)
        .await?;
    let mut ids = vec![subject];
    if kind.as_deref() == Some("group") {
        ids.extend(leaves(&tree(pool).await?, subject));
    }
    let own = statuses(pool, &ids).await?;
    let mut out: Vec<(i64, i64)> = ids
        .iter()
        .map(|id| (*id, own.get(id).copied().unwrap_or(PENDING)))
        .collect();
    for link in resolved {
        if let (Some(id), Some(status)) = (
            link.get("id").and_then(Value::as_i64),
            link.get("status").and_then(Value::as_i64),
        ) {
            out.push((id, status));
        }
    }
    Ok(out)
}

/// Mute a subject: snapshot what is red on it now and replace any earlier
/// mute. Refused when nothing on the subject is down.
pub async fn mute(
    pool: &SqlitePool,
    subject: i64,
    sample: Option<&Value>,
    disk_threshold: Option<i64>,
) -> Result<Mute, MuteError> {
    let _guard = LOCK.lock().await;
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM monitors WHERE id = ?")
        .bind(subject)
        .fetch_optional(pool)
        .await?;
    if exists.is_none() {
        return Err(MuteError::NotFound);
    }

    let down: BTreeSet<i64> = card_monitors(pool, subject)
        .await?
        .into_iter()
        .filter(|(_, status)| *status == DOWN)
        .map(|(id, _)| id)
        .collect();
    if down.is_empty() {
        return Err(MuteError::NothingDown);
    }

    let mute = Mute {
        subject,
        muted_at: crate::heartbeats::now_millis(),
        monitors: down.into_iter().collect(),
        smart_failed: sample.map(smart_failed).unwrap_or_default(),
        full_mounts: sample
            .map(|sample| full_mounts(sample, disk_threshold))
            .unwrap_or_default(),
    };
    save(pool, &mute).await?;
    Ok(mute)
}

/// Children by parent id, for walking group trees.
async fn tree(pool: &SqlitePool) -> sqlx::Result<HashMap<i64, Vec<(i64, String)>>> {
    let rows: Vec<(i64, String, i64)> = sqlx::query_as(
        "SELECT id, type, parent FROM monitors WHERE parent IS NOT NULL ORDER BY id",
    )
    .fetch_all(pool)
    .await?;
    let mut tree: HashMap<i64, Vec<(i64, String)>> = HashMap::new();
    for (id, kind, parent) in rows {
        tree.entry(parent).or_default().push((id, kind));
    }
    Ok(tree)
}

/// Every non-group monitor below `root`, cycle-safe.
fn leaves(tree: &HashMap<i64, Vec<(i64, String)>>, root: i64) -> Vec<i64> {
    let mut out = Vec::new();
    let mut seen: HashSet<i64> = HashSet::from([root]);
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for (id, kind) in tree.get(&parent).into_iter().flatten() {
            if !seen.insert(*id) {
                continue;
            }
            if kind == "group" {
                frontier.push(*id);
            } else {
                out.push(*id);
            }
        }
    }
    out.sort_unstable();
    out
}

/// Delete the monitor's own mute and every mute covering it; for a group,
/// every mute covering one of its leaves. Returns the deleted subjects.
pub async fn unmute(pool: &SqlitePool, monitor_id: i64) -> sqlx::Result<Vec<i64>> {
    let _guard = LOCK.lock().await;
    let mutes = list(pool).await?;
    if mutes.is_empty() {
        return Ok(Vec::new());
    }
    let kind: Option<String> = sqlx::query_scalar("SELECT type FROM monitors WHERE id = ?")
        .bind(monitor_id)
        .fetch_optional(pool)
        .await?;
    let mut targets: HashSet<i64> = HashSet::from([monitor_id]);
    if kind.as_deref() == Some("group") {
        targets.extend(leaves(&tree(pool).await?, monitor_id));
    }

    let mut deleted = Vec::new();
    for mute in mutes {
        if mute.subject == monitor_id || mute.monitors.iter().any(|id| targets.contains(id)) {
            delete(pool, mute.subject).await?;
            deleted.push(mute.subject);
        }
    }
    Ok(deleted)
}

/// Every active mute, and which subjects cover each monitor.
#[derive(Debug, Default)]
pub struct Coverage {
    pub mutes: HashMap<i64, Mute>,
    /// Monitor id to the subjects covering it, sorted. Covered groups
    /// included.
    pub muted_by: HashMap<i64, Vec<i64>>,
}

pub async fn coverage(pool: &SqlitePool) -> sqlx::Result<Coverage> {
    let mutes = list(pool).await?;
    let mut coverage = Coverage::default();
    if mutes.is_empty() {
        return Ok(coverage);
    }

    let mut muted_by: HashMap<i64, BTreeSet<i64>> = HashMap::new();
    for mute in &mutes {
        for id in &mute.monitors {
            muted_by.entry(*id).or_default().insert(mute.subject);
        }
    }

    // Groups: covered when down and every down leaf beneath is covered.
    let groups: Vec<i64> = sqlx::query_scalar("SELECT id FROM monitors WHERE type = 'group'")
        .fetch_all(pool)
        .await?;
    if !groups.is_empty() {
        let tree = tree(pool).await?;
        let by_group: Vec<(i64, Vec<i64>)> = groups
            .iter()
            .map(|group| (*group, leaves(&tree, *group)))
            .collect();
        let mut ids: Vec<i64> = groups.clone();
        ids.extend(by_group.iter().flat_map(|(_, leaves)| leaves.iter().copied()));
        ids.sort_unstable();
        ids.dedup();
        let status = statuses(pool, &ids).await?;
        let is_down = |id: &i64| status.get(id) == Some(&DOWN);

        let mut covered_groups: Vec<(i64, BTreeSet<i64>)> = Vec::new();
        for (group, leaves) in &by_group {
            if !is_down(group) {
                continue;
            }
            let down: Vec<&i64> = leaves.iter().filter(|id| is_down(id)).collect();
            if down.is_empty() || !down.iter().all(|id| muted_by.contains_key(id)) {
                continue;
            }
            let subjects = down
                .iter()
                .flat_map(|id| muted_by[id].iter().copied())
                .collect();
            covered_groups.push((*group, subjects));
        }
        for (group, subjects) in covered_groups {
            muted_by.entry(group).or_default().extend(subjects);
        }
    }

    coverage.muted_by = muted_by
        .into_iter()
        .map(|(id, subjects)| (id, subjects.into_iter().collect()))
        .collect();
    coverage.mutes = mutes.into_iter().map(|mute| (mute.subject, mute)).collect();
    Ok(coverage)
}

/// Whether some active mute covers the monitor (groups included).
pub async fn is_covered(pool: &SqlitePool, monitor_id: i64) -> sqlx::Result<bool> {
    Ok(coverage(pool).await?.muted_by.contains_key(&monitor_id))
}

/// Whether the subject's own mute includes the subject (its host is down).
pub async fn host_muted(pool: &SqlitePool, subject: i64) -> sqlx::Result<bool> {
    Ok(get(pool, subject).await?.is_some_and(|mute| mute.host_muted()))
}

/// A monitor's status changed. Down and not in a snapshot on whose card it
/// sits: something new broke, so that mute ends. Up (or in maintenance): it
/// leaves every snapshot, so a later outage is new; a mute left with no
/// monitor is deleted. Pending changes nothing. Returns whether any mute
/// changed.
pub async fn on_status(pool: &SqlitePool, monitor_id: i64, status: i64) -> sqlx::Result<bool> {
    if status == PENDING {
        return Ok(false);
    }
    let _guard = LOCK.lock().await;
    let mut changed = false;
    for mut mute in list(pool).await? {
        let covered = mute.monitors.contains(&monitor_id);
        if status == DOWN {
            if covered {
                continue;
            }
            let on_card = card_monitors(pool, mute.subject)
                .await?
                .iter()
                .any(|(id, _)| *id == monitor_id);
            if on_card {
                delete(pool, mute.subject).await?;
                changed = true;
            }
        } else if covered {
            mute.monitors.retain(|id| *id != monitor_id);
            if mute.monitors.is_empty() {
                delete(pool, mute.subject).await?;
            } else {
                update_snapshot(pool, &mute).await?;
            }
            changed = true;
        }
    }
    Ok(changed)
}

/// What a sample did to its subject's mute.
#[derive(Debug, Clone, PartialEq)]
pub enum SampleChange {
    None,
    /// A snapshot mount dropped back under the level.
    Shrunk,
    /// Something new ended the mute; the reason names it for the operator.
    Ended(String),
}

/// Whether the sample reports this mount with a reading under `level`. A
/// mount missing from the sample (an agent that just restarted sends no
/// disks yet) is not a reading.
fn mount_below(sample: &Value, mount: &str, level: f64) -> bool {
    sample
        .get("disk")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("mount").and_then(Value::as_str) == Some(mount))
        .filter_map(|entry| entry.get("percent").and_then(Value::as_f64))
        .any(|percent| percent.is_finite() && percent < level)
}

/// A muted subject reported a sample. A disk failing SMART or a mount over
/// the disk-full level that the snapshot does not hold is new and ends the
/// mute; a snapshot mount reported back under the level leaves the
/// snapshot, so a later breach is new.
pub async fn on_sample(
    pool: &SqlitePool,
    subject: i64,
    sample: &Value,
    disk_threshold: Option<i64>,
) -> sqlx::Result<SampleChange> {
    let _guard = LOCK.lock().await;
    let Some(mut mute) = get(pool, subject).await? else {
        return Ok(SampleChange::None);
    };
    let level = disk_threshold.map_or(DISK_FULL_DEFAULT, |t| t as f64);
    let new_failures: Vec<String> = smart_failed(sample)
        .into_iter()
        .filter(|disk| !mute.smart_failed.contains(disk))
        .map(|disk| format!("{disk} failing SMART"))
        .collect();
    let new_breaches: Vec<String> = full_mounts(sample, disk_threshold)
        .into_iter()
        .filter(|mount| !mute.full_mounts.contains(mount))
        .map(|mount| format!("{mount} at or above {level}% full"))
        .collect();
    if !new_failures.is_empty() || !new_breaches.is_empty() {
        delete(pool, subject).await?;
        let reasons: Vec<String> = new_failures.into_iter().chain(new_breaches).collect();
        return Ok(SampleChange::Ended(reasons.join(", ")));
    }
    let before = mute.full_mounts.len();
    mute.full_mounts.retain(|mount| !mount_below(sample, mount, level));
    if mute.full_mounts.len() == before {
        return Ok(SampleChange::None);
    }
    update_snapshot(pool, &mute).await?;
    Ok(SampleChange::Shrunk)
}

/// Deleted monitors leave every snapshot; a mute left empty is deleted (a
/// deleted subject's own row goes with it by cascade).
pub async fn forget(pool: &SqlitePool, ids: &[i64]) -> sqlx::Result<bool> {
    let _guard = LOCK.lock().await;
    let mut changed = false;
    for mut mute in list(pool).await? {
        let before = mute.monitors.len();
        mute.monitors.retain(|id| !ids.contains(id));
        if mute.monitors.len() == before {
            continue;
        }
        if mute.monitors.is_empty() {
            delete(pool, mute.subject).await?;
        } else {
            update_snapshot(pool, &mute).await?;
        }
        changed = true;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smart_failed_lists_failing_devices() {
        let sample = json!({"smart": {"disks": [
            {"device": "/dev/sda", "health": "failed"},
            {"device": "/dev/sdb", "health": "passed"}
        ]}});
        assert_eq!(smart_failed(&sample), vec!["/dev/sda".to_string()]);
        assert!(smart_failed(&json!({})).is_empty());
    }

    #[test]
    fn full_mounts_use_the_threshold_or_the_hot_level() {
        let sample = json!({"disk": [
            {"mount": "/", "percent": 91.0},
            {"mount": "/data", "percent": 89.9}
        ]});
        assert_eq!(full_mounts(&sample, None), vec!["/".to_string()]);
        assert_eq!(
            full_mounts(&sample, Some(80)),
            vec!["/".to_string(), "/data".to_string()]
        );
    }

    #[test]
    fn leaves_walk_nested_groups_and_skip_cycles() {
        let mut tree: HashMap<i64, Vec<(i64, String)>> = HashMap::new();
        tree.insert(1, vec![(2, "group".into()), (3, "http".into())]);
        tree.insert(2, vec![(4, "push".into()), (1, "group".into())]);
        assert_eq!(leaves(&tree, 1), vec![3, 4]);
    }
}
