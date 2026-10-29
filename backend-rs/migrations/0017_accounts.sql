-- Accounts, migration 17.
--
-- People sign in to the web app with an email and a password. Every account
-- has full permission, the same as an operator token; accounts exist to give
-- each person their own credentials.
--
-- - `users`: `email` is stored as entered; `email_key` is its lowercased form
--   and carries the uniqueness. `password_hash` is bcrypt. A password set by
--   someone else (on add or reset) is a starting password:
--   `must_change_password` stays 1 until its owner chooses their own, and an
--   unchanged one expires 7 days after `password_set_at`.
-- - `sessions`: the `fl_session` cookie holds a random id; only its SHA-256 is
--   stored here. A session belongs to exactly one account or one token, and
--   goes with it. `last_used_at` slides the lifetime (30 days for an account,
--   400 for a token).
-- - `tokens.maker_user_id` / `maker_name`: who minted the token, when an
--   account did. The name survives the account's removal; the id does not.
--   Tokens that existed before this migration have no maker.

CREATE TABLE users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    email                TEXT NOT NULL,
    email_key            TEXT NOT NULL UNIQUE,
    name                 TEXT NOT NULL,
    password_hash        TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    password_set_at      TEXT NOT NULL,
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

CREATE TABLE sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    hash         TEXT NOT NULL UNIQUE,
    user_id      INTEGER REFERENCES users (id) ON DELETE CASCADE,
    token_id     INTEGER REFERENCES tokens (id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    CHECK ((user_id IS NULL) != (token_id IS NULL))
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_token_idx ON sessions (token_id);

ALTER TABLE tokens ADD COLUMN maker_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE tokens ADD COLUMN maker_name TEXT;
