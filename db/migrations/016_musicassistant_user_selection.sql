ALTER TABLE musicassistant_settings
  ADD COLUMN IF NOT EXISTS user_id VARCHAR(255);
