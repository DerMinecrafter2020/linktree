ALTER TABLE musicassistant_settings
  ADD COLUMN IF NOT EXISTS player_id VARCHAR(255);
