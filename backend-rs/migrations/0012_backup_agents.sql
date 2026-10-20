-- Named backup agents and their runs, migration 12.
--
-- A backup agent is a first-class identity: server-generated UUID, optional
-- monitor link, dedicated credential hash, and durable run history. Display
-- names are never used as storage paths. Credentials are stored only as
-- SHA-256 hashes; revocation keeps the row and its run history.
--
-- Runs move through uploading -> finalizing -> completed, or end as failed /
-- expired / pruned. `backup_run_chunks` is the committed chunk ledger: a byte
-- range exists only when its row and the appended file agree.

CREATE TABLE backup_agents (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    monitor_id         INTEGER REFERENCES monitors (id) ON DELETE SET NULL,
    enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    interval_seconds   INTEGER NOT NULL DEFAULT 86400 CHECK (interval_seconds > 0),
    retention_count    INTEGER NOT NULL DEFAULT 7 CHECK (retention_count BETWEEN 1 AND 30),
    -- NULL once revoked: the plaintext never existed server-side.
    token_hash         TEXT,
    credential_active  INTEGER NOT NULL DEFAULT 0 CHECK (credential_active IN (0, 1)),
    created_at         TEXT NOT NULL,
    -- Last health state for which an alert transition was dispatched. Health
    -- itself is derived from runs; this prevents duplicate alerts on restart.
    alert_state        TEXT NOT NULL DEFAULT 'pending'
        CHECK (alert_state IN ('pending', 'healthy', 'failed', 'overdue', 'disabled')),
    alert_changed_at   TEXT
);

-- Linked agents of one monitor must have distinct display names. Unlinked
-- agents are identified by UUID alone.
CREATE UNIQUE INDEX backup_agents_monitor_name_idx
    ON backup_agents (monitor_id, name)
    WHERE monitor_id IS NOT NULL;

CREATE INDEX backup_agents_created_idx
    ON backup_agents (created_at DESC, id DESC);

CREATE TABLE backup_runs (
    id                 TEXT PRIMARY KEY,
    agent_id           TEXT NOT NULL REFERENCES backup_agents (id) ON DELETE CASCADE,
    client_run_id      TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN (
        'uploading', 'finalizing', 'completed', 'failed', 'expired', 'deleting', 'pruned')),
    export_started_at  TEXT NOT NULL,
    export_finished_at TEXT,
    created_at         TEXT NOT NULL,
    completed_at       TEXT,
    total_bytes        INTEGER CHECK (total_bytes IS NULL OR total_bytes > 0),
    received_bytes     INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
    sha256             TEXT,
    -- Agent-reported summary. Never treated as independently verified.
    source_summary     TEXT,
    error_code         TEXT,
    -- Operator-recorded verifications, JSON objects. Archive verification and
    -- restore verification are separate states.
    archive_verification TEXT,
    restore_verification TEXT,
    UNIQUE (agent_id, client_run_id)
);

CREATE INDEX backup_runs_agent_created_idx
    ON backup_runs (agent_id, created_at DESC, id DESC);

CREATE INDEX backup_runs_status_idx
    ON backup_runs (status);

CREATE INDEX backup_runs_agent_completed_idx
    ON backup_runs (agent_id, export_finished_at DESC)
    WHERE status = 'completed';

CREATE TABLE backup_run_chunks (
    run_id       TEXT NOT NULL REFERENCES backup_runs (id) ON DELETE CASCADE,
    chunk_index  INTEGER NOT NULL CHECK (chunk_index >= 0),
    offset       INTEGER NOT NULL CHECK (offset >= 0),
    size         INTEGER NOT NULL CHECK (size > 0),
    sha256       TEXT NOT NULL,
    PRIMARY KEY (run_id, chunk_index)
);
