-- Wartungsmodus (lib/maintenance-mode.js): Besucher sehen statt der Startseite eine Wartungsseite
-- (Status 503 oder 404), optional mit Countdown bis ends_at und automatischem Ende.
CREATE TABLE IF NOT EXISTS maintenance_settings (
  id INTEGER PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  http_status INTEGER NOT NULL DEFAULT 503,
  title VARCHAR(100),
  message VARCHAR(500),
  countdown_enabled BOOLEAN NOT NULL DEFAULT false,
  ends_at TIMESTAMPTZ,
  auto_end BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO maintenance_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
