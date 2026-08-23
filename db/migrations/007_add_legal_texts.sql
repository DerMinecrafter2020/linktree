-- 007_add_legal_texts.sql
ALTER TABLE profile ADD COLUMN IF NOT EXISTS impressum_text TEXT DEFAULT '';
ALTER TABLE profile ADD COLUMN IF NOT EXISTS datenschutz_text TEXT DEFAULT '';
