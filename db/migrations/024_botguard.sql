-- Bot-Schutz (lib/botguard.js): IP-Sperrliste (UFW Manager, Adresslisten, eigene Liste) und
-- Browser-Pruefung bei Verdacht. API-Token des UFW Managers nur verschluesselt.
CREATE TABLE IF NOT EXISTS botguard_settings (
  id INTEGER PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  challenge_enabled BOOLEAN NOT NULL DEFAULT true,
  mode VARCHAR(20) NOT NULL DEFAULT 'suspicious',
  difficulty VARCHAR(10) NOT NULL DEFAULT 'medium',
  clearance_days INTEGER NOT NULL DEFAULT 7,
  rate_per_min INTEGER NOT NULL DEFAULT 30,
  allowlist TEXT,
  manual_blocklist TEXT,
  ufw_enabled BOOLEAN NOT NULL DEFAULT false,
  ufw_url VARCHAR(500),
  ufw_token_encrypted TEXT,
  ufw_lists VARCHAR(500),
  ufw_interval_min INTEGER NOT NULL DEFAULT 5,
  ufw_last_sync_at TIMESTAMPTZ,
  ufw_last_ok BOOLEAN,
  ufw_last_message VARCHAR(500),
  ufw_entries TEXT NOT NULL DEFAULT '[]',
  ufw_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO botguard_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
