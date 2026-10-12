-- Status pages and token lifecycle, migration 4.
--
-- Status pages are read-only in v1 (the operator vetoed authoring): the
-- importer copies the deployed page configs, groups, monitors, incidents
-- and host mappings, and the API serves them to the public SPA routes.
--
-- `tokens.active`/`tokens.expires` back the Agents panel: a token can be
-- disabled or given an expiry without deleting it.

ALTER TABLE tokens ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tokens ADD COLUMN expires TEXT;

CREATE TABLE status_pages (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    slug                    TEXT NOT NULL UNIQUE,
    title                   TEXT NOT NULL DEFAULT '',
    description             TEXT,
    icon                    TEXT,
    theme                   TEXT NOT NULL DEFAULT 'light',
    accent_color            TEXT,
    auto_refresh_interval   INTEGER,
    published               INTEGER NOT NULL DEFAULT 0,
    show_tags               INTEGER NOT NULL DEFAULT 0,
    custom_css              TEXT,
    footer_text             TEXT,
    show_powered_by         INTEGER NOT NULL DEFAULT 0,
    analytics_id            TEXT,
    analytics_script_url    TEXT,
    analytics_type          TEXT,
    show_certificate_expiry INTEGER NOT NULL DEFAULT 0,
    show_only_last_heartbeat INTEGER NOT NULL DEFAULT 0,
    rss_title               TEXT,
    -- bcrypt hash imported from the old database; NULL means public.
    password                TEXT,
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);

CREATE TABLE status_page_groups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    status_page_id  INTEGER NOT NULL REFERENCES status_pages (id) ON DELETE CASCADE,
    name            TEXT NOT NULL DEFAULT '',
    weight          INTEGER NOT NULL DEFAULT 0,
    public          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX status_page_groups_page_idx ON status_page_groups (status_page_id, weight);

CREATE TABLE status_page_monitors (
    group_id   INTEGER NOT NULL REFERENCES status_page_groups (id) ON DELETE CASCADE,
    monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    send_url   INTEGER NOT NULL DEFAULT 1,
    custom_url TEXT,
    weight     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, monitor_id)
);
CREATE INDEX status_page_monitors_monitor_idx ON status_page_monitors (monitor_id);

CREATE TABLE status_page_incidents (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    status_page_id    INTEGER NOT NULL REFERENCES status_pages (id) ON DELETE CASCADE,
    style             TEXT NOT NULL DEFAULT 'info',
    title             TEXT NOT NULL DEFAULT '',
    content           TEXT NOT NULL DEFAULT '',
    pin               INTEGER NOT NULL DEFAULT 0,
    active            INTEGER NOT NULL DEFAULT 1,
    created_date      TEXT NOT NULL,
    last_updated_date TEXT
);
CREATE INDEX status_page_incidents_page_idx ON status_page_incidents (status_page_id, created_date DESC);

CREATE TABLE status_page_cnames (
    status_page_id INTEGER NOT NULL REFERENCES status_pages (id) ON DELETE CASCADE,
    domain         TEXT NOT NULL UNIQUE,
    PRIMARY KEY (status_page_id, domain)
);
