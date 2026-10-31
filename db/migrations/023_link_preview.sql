-- Link-Vorschau (Open Graph) fuer Discord, WhatsApp, Telegram, X …
-- Das Vorschaubild (1200x630, JPEG/PNG) erzeugt der Admin-Bereich im Browser aus Profil und
-- Standard-Design oder es wird hochgeladen; ausgeliefert unter /og-image.jpg.
-- Eigene Tabelle, damit das Bild nicht in "SELECT * FROM profile" landet.
CREATE TABLE IF NOT EXISTS og_settings (
  id INTEGER PRIMARY KEY,
  image BYTEA,
  image_type VARCHAR(20),
  image_key VARCHAR(64),
  custom BOOLEAN NOT NULL DEFAULT false,
  show_now_playing BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO og_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
