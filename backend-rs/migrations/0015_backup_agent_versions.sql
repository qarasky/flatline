-- Backup-agent versions, migration 15.
--
-- The backup agent updates itself on its own version line. Each agent
-- reports the version it runs (on every run start and every self-update
-- check-in) and the outcome of its host's last update attempt, so the
-- Superboard can show what is actually installed even while backups are
-- switched off. All three are agent-reported metadata, NULL until the first
-- report.

ALTER TABLE backup_agents ADD COLUMN reported_version TEXT;
ALTER TABLE backup_agents ADD COLUMN version_reported_at TEXT;
ALTER TABLE backup_agents ADD COLUMN update_status TEXT;
