-- =========================================================
-- OpenWeb — Migration 003
-- Erweiterte Link-Funktionen
-- =========================================================

-- Kategorien fuer Links
CREATE TABLE IF NOT EXISTS link_categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(80) NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_link_categories_updated_at
BEFORE UPDATE ON link_categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Link-Erweiterungen
ALTER TABLE links
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES link_categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS slug VARCHAR(80) NULL UNIQUE,
  ADD COLUMN IF NOT EXISTS meta_description VARCHAR(280) NULL,
  ADD COLUMN IF NOT EXISTS admin_note VARCHAR(280) NULL,
  ADD COLUMN IF NOT EXISTS visible_from TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS visible_until TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS visible_weekdays INTEGER[] NULL CHECK (visible_weekdays <@ ARRAY[0,1,2,3,4,5,6]);

-- Klickstatistik
CREATE TABLE IF NOT EXISTS link_clicks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id    UUID NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_hash    VARCHAR(64) NULL,
  user_agent VARCHAR(500) NULL,
  referrer   VARCHAR(500) NULL
);

CREATE INDEX IF NOT EXISTS idx_link_clicks_link_id ON link_clicks(link_id);
CREATE INDEX IF NOT EXISTS idx_link_clicks_clicked_at ON link_clicks(clicked_at);

-- Profil-Erweiterungen
ALTER TABLE profile
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_visitor_theme BOOLEAN NOT NULL DEFAULT true;
