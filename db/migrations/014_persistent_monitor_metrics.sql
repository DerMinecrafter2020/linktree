CREATE TABLE IF NOT EXISTS resource_monitor_samples (
  id                    BIGSERIAL PRIMARY KEY,
  sampled_at            TIMESTAMPTZ NOT NULL,
  cpu_percent           DOUBLE PRECISION NOT NULL,
  rss_bytes             BIGINT NOT NULL,
  heap_used_bytes       BIGINT NOT NULL,
  heap_total_bytes      BIGINT NOT NULL,
  loop_mean_ms          DOUBLE PRECISION NOT NULL,
  loop_p99_ms           DOUBLE PRECISION NOT NULL,
  requests_per_min      DOUBLE PRECISION NOT NULL,
  errors_per_min        DOUBLE PRECISION NOT NULL,
  response_avg_ms       DOUBLE PRECISION NOT NULL,
  response_p95_ms       DOUBLE PRECISION NOT NULL,
  db_total              INTEGER NOT NULL,
  db_idle               INTEGER NOT NULL,
  db_waiting            INTEGER NOT NULL,
  request_count         INTEGER NOT NULL DEFAULT 0,
  error_count           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_resource_monitor_samples_sampled_at
  ON resource_monitor_samples (sampled_at DESC);

CREATE TABLE IF NOT EXISTS resource_monitor_totals (
  id               SMALLINT PRIMARY KEY CHECK (id = 1),
  total_requests   BIGINT NOT NULL DEFAULT 0,
  total_errors     BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO resource_monitor_totals (id, total_requests, total_errors)
VALUES (1, 0, 0)
ON CONFLICT (id) DO NOTHING;
