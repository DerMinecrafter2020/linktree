-- Spotify als dritte "Now Playing"-Quelle (OAuth Authorization Code Flow)
-- Client-Secret und Refresh-Token werden nur verschluesselt (lib/crypto.encrypt) gespeichert.
CREATE TABLE IF NOT EXISTS spotify_settings (
  id INTEGER PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  client_id VARCHAR(255),
  client_secret_encrypted TEXT,
  refresh_token_encrypted TEXT,
  account_name VARCHAR(255),
  connected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO spotify_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Quelle im Musik-Verlauf (navidrome | musicassistant | spotify); alte Eintraege bleiben NULL
ALTER TABLE music_history ADD COLUMN IF NOT EXISTS source VARCHAR(32);
