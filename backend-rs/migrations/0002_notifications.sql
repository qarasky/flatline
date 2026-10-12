-- Notifications, migration 2.
--
-- Telegram is the only provider in v1 (locked scope); the table keeps the
-- Node shape so the importer is a straight copy and the operator can edit
-- configs via the API. `config` is the provider's JSON blob (bot token
-- inside) and is never echoed back by the API.

CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL DEFAULT '',
    type       TEXT NOT NULL DEFAULT 'telegram',
    active     INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    config     TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

CREATE TABLE monitor_notifications (
    monitor_id      INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    notification_id INTEGER NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
    PRIMARY KEY (monitor_id, notification_id)
);
