-- Core schema, migration 1.
--
-- New schema owned by the Rust backend (the Node schema is imported once,
-- not shared). Types are push | http | group only; anything the operator
-- does not use is deliberately absent.

CREATE TABLE tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL DEFAULT '',
    -- sha256 hex for tokens minted here; imported API keys keep their
    -- bcrypt hashes so existing automation keeps working.
    hash         TEXT NOT NULL,
    scheme       TEXT NOT NULL DEFAULT 'sha256',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    last_used_at TEXT
);
CREATE INDEX tokens_hash_idx ON tokens (hash);

CREATE TABLE monitors (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    type                 TEXT NOT NULL,
    active               INTEGER NOT NULL DEFAULT 1,
    description          TEXT,
    interval             INTEGER NOT NULL DEFAULT 60,
    retry_interval       INTEGER NOT NULL DEFAULT 60,
    maxretries           INTEGER NOT NULL DEFAULT 0,
    timeout              INTEGER NOT NULL DEFAULT 48,
    resend_interval      INTEGER NOT NULL DEFAULT 0,
    upside_down          INTEGER NOT NULL DEFAULT 0,
    parent               INTEGER REFERENCES monitors (id) ON DELETE SET NULL,
    weight               INTEGER NOT NULL DEFAULT 0,
    url                  TEXT,
    method               TEXT,
    accepted_statuscodes TEXT NOT NULL DEFAULT '["200-299"]',
    ignore_tls           INTEGER NOT NULL DEFAULT 0,
    maxredirects         INTEGER NOT NULL DEFAULT 10,
    push_token           TEXT,
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);
CREATE UNIQUE INDEX monitors_push_token_idx ON monitors (push_token) WHERE push_token IS NOT NULL;

CREATE TABLE heartbeats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    time       TEXT NOT NULL,
    status     INTEGER NOT NULL,
    ping       REAL,
    msg        TEXT,
    important  INTEGER NOT NULL DEFAULT 0,
    retries    INTEGER NOT NULL DEFAULT 0,
    down_count INTEGER NOT NULL DEFAULT 0,
    duration   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX heartbeats_monitor_time_idx ON heartbeats (monitor_id, time DESC);
