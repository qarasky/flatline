-- Kore ID back-channel logout, migration 19.
--
-- - `sessions.sso_sid`: the Kore ID session id (`sid` claim of the id token)
--   a Kore ID sign-in came from. A back-channel logout token names it, and
--   every local session with that `sid` is deleted. NULL for password and
--   token sessions, and for Kore ID sessions made before this migration
--   (those are ended by `sub` when a logout token has no `sid`, or by their
--   30-day idle limit).

ALTER TABLE sessions ADD COLUMN sso_sid TEXT;
CREATE INDEX sessions_sso_sid_idx ON sessions (sso_sid) WHERE sso_sid IS NOT NULL;
