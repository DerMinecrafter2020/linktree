-- =========================================================
-- OpenWeb — Migration 002
-- Anzeige-URL fuer Links (Hover-Text vs. echte Ziel-URL)
-- =========================================================

ALTER TABLE links ADD COLUMN IF NOT EXISTS display_url VARCHAR(120) NULL;
