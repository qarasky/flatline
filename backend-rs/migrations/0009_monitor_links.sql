-- Server -> website monitor links, migration 9.
--
-- A "server" in Flatline is a monitor that emits metrics (usually `push`).
-- This table records, per server, the website monitors shown as status chips
-- on its Superboard card. A linked target may be an ordinary monitor or a
-- `group`; a group is expanded to its non-group descendants when the links
-- are read, so linking a whole group links every website inside it, including
-- ones added later.
--
-- Both columns cascade: a link whose server or target was removed is
-- meaningless. The pair is unique so the same website cannot be linked twice.

CREATE TABLE monitor_links (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id        INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    linked_monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    UNIQUE (monitor_id, linked_monitor_id)
);
CREATE INDEX monitor_links_monitor_idx ON monitor_links (monitor_id);
CREATE INDEX monitor_links_linked_idx ON monitor_links (linked_monitor_id);
