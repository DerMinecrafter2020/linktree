CREATE TABLE IF NOT EXISTS musicassistant_settings (
  id SERIAL PRIMARY KEY,
  enabled BOOLEAN DEFAULT false,
  url VARCHAR(255),
  token_encrypted TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO musicassistant_settings (id, enabled, url, token_encrypted) 
VALUES (1, false, '', '') 
ON CONFLICT (id) DO NOTHING;
