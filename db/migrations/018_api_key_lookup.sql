-- Schneller Index fuer API-Keys: SHA-256 des Keys (Keys sind 256-Bit-Zufallswerte).
-- Bestehende Keys erhalten den Wert beim ersten erfolgreichen Abruf.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_lookup CHAR(64) NULL;
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_lookup_idx ON api_keys (key_lookup) WHERE key_lookup IS NOT NULL;
