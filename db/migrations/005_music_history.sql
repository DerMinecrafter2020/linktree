CREATE TABLE IF NOT EXISTS music_history (
  id SERIAL PRIMARY KEY,
  track_id VARCHAR(255),
  title VARCHAR(255) NOT NULL,
  artist VARCHAR(255),
  album VARCHAR(255),
  played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_music_history_played_at ON music_history(played_at DESC);
