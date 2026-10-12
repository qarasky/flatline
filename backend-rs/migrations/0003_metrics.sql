-- Metrics pipeline, migration 3.
--
-- Raw samples are the agent payloads as validated at ingest, with
-- server-derived CPU percentages when the agent sent raw counters. The
-- hourly tier folds them per monitor per hour and is kept for two years;
-- the raw tier lives 30 days (pruned by the job in `metrics::rollup`).

CREATE TABLE metrics_raw (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    time       TEXT NOT NULL,
    payload    TEXT NOT NULL
);
CREATE INDEX metrics_raw_monitor_time_idx ON metrics_raw (monitor_id, time DESC);

CREATE TABLE metrics_hourly (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    time       TEXT NOT NULL,
    -- True extremes plus the hour average per metric. NULL means the metric
    -- was absent in that hour (no GPU, invalid readings), never zero.
    cpu_min  REAL, cpu_max  REAL, cpu_avg  REAL,
    ram_min  REAL, ram_max  REAL, ram_avg  REAL,
    gpu_min  REAL, gpu_max  REAL, gpu_avg  REAL,
    vram_min REAL, vram_max REAL, vram_avg REAL,
    -- Raw readings that contributed; the honest sample count for the long
    -- tier, where one row stands for many 30s samples.
    samples  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (monitor_id, time)
);
