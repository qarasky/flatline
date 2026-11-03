-- Kore ID single sign-on, migration 18.
--
-- - `users.kore_sub`: the provider's `sub` claim (a UUID shared by every Kore
--   app), set once an account has signed in through Kore ID. Unique where
--   set. An account without it is a local account. An account made by SSO
--   has no usable password: its `password_hash` is the sentinel '!sso',
--   which no password matches.
-- - `sessions.sso_id_token`: the id token a Kore ID sign-in returned, kept
--   only as the `id_token_hint` for provider-side sign-out. NULL for
--   password and token sessions.

ALTER TABLE users ADD COLUMN kore_sub TEXT;
CREATE UNIQUE INDEX users_kore_sub_idx ON users (kore_sub) WHERE kore_sub IS NOT NULL;

ALTER TABLE sessions ADD COLUMN sso_id_token TEXT;
