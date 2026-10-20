-- Backup run activity and deletion bookkeeping, migration 13.
--
-- Expiration needs a durable "last accepted activity" timestamp; created_at
-- alone would expire a slow-but-active upload. Deletion is two-phase
-- (`deleting` -> unlink/fsync -> `pruned`/`expired`) so a restart between the
-- database update and the unlink finishes the same deletion instead of
-- leaking bytes. Metadata is kept after pruning.

ALTER TABLE backup_runs ADD COLUMN last_activity_at TEXT;
ALTER TABLE backup_runs ADD COLUMN delete_reason TEXT
    CHECK (delete_reason IS NULL OR delete_reason IN ('retention', 'expired'));

CREATE INDEX backup_runs_activity_idx
    ON backup_runs (status, last_activity_at);
