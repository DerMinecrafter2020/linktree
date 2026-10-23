ALTER TABLE profile
  ADD COLUMN IF NOT EXISTS player_progress_style VARCHAR(16) NOT NULL DEFAULT 'time'
  CHECK (player_progress_style IN ('time', 'line'));
