-- Rollup maintenance state, migration 8.
--
-- The hourly rollup needs one piece of durable state: the repair sweep's
-- cursor, the hour up to which the bounded reconciliation has verified
-- coverage. Without it, every run had to compare the whole raw retention
-- window to find the handful of hours that need work; with it, normal runs
-- process the dirty hours plus one bounded window, and the whole window is
-- still swept within a cycle.
--
-- A key/value table rather than a column on an existing table: the rollup
-- owns it, and future maintenance state fits without another migration.

CREATE TABLE metrics_rollup_state (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL
);
