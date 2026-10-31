-- Instagram-Profilabgleich (Business Login for Instagram, nur Business-/Creator-Konten)
-- App-Secret und Zugriffstoken werden nur verschluesselt (lib/crypto.encrypt) gespeichert.
CREATE TABLE IF NOT EXISTS instagram_settings (
  id INTEGER PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  app_id VARCHAR(64),
  app_secret_encrypted TEXT,
  access_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  token_refreshed_at TIMESTAMPTZ,
  ig_user_id VARCHAR(64),
  username VARCHAR(255),
  sync_avatar BOOLEAN NOT NULL DEFAULT true,
  sync_bio BOOLEAN NOT NULL DEFAULT true,
  sync_name BOOLEAN NOT NULL DEFAULT false,
  bio_available BOOLEAN,
  last_sync_at TIMESTAMPTZ,
  last_sync_ok BOOLEAN,
  last_sync_message VARCHAR(500),
  connected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO instagram_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
