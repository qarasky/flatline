-- Mutes, migration 16.
--
-- The operator mutes a known outage: the card goes dark red and Telegram
-- stops repeating it. A mute belongs to a subject monitor (a server card, or
-- any monitor muted from the dashboard) and records a snapshot of what was
-- broken at mute time, so anything new can end it:
--
-- - `monitors`: JSON array of the monitor ids on the subject that were down
--   (the subject itself and its linked websites). A monitor that recovers is
--   removed; the mute is deleted when none is left.
-- - `smart_failed`: JSON array of the disks the subject reported SMART
--   `failed` at mute time. A newly failing disk ends the mute.
-- - `full_mounts`: JSON array of the mounts at or above the disk-full level
--   at mute time. A newly full mount ends the mute; one that drops back
--   under the level is removed, so a later breach is new.
--
-- One row per subject; muting again replaces it. A deleted subject takes its
-- mute with it.

CREATE TABLE monitor_mutes (
    monitor_id   INTEGER PRIMARY KEY REFERENCES monitors (id) ON DELETE CASCADE,
    muted_at     TEXT NOT NULL,
    monitors     TEXT NOT NULL DEFAULT '[]',
    smart_failed TEXT NOT NULL DEFAULT '[]',
    full_mounts  TEXT NOT NULL DEFAULT '[]'
);
