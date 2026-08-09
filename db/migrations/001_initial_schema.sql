-- =========================================================
-- OpenWeb — Initiales PostgreSQL-Schema
-- =========================================================

-- Hilfsfunktion: updated_at automatisch setzen
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------
-- Tabelle: users
-- Admin-User mit E-Mail/Passwort-Login
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------
-- Tabelle: profile (Singleton)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS profile (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name        VARCHAR(80)  NOT NULL DEFAULT '@corneliusahner',
  handle      VARCHAR(80)  NOT NULL DEFAULT 'Cornelius Ahner',
  bio         VARCHAR(280) NOT NULL DEFAULT 'Azubi, 21 Jahre alt',
  avatar      VARCHAR(2)   NOT NULL DEFAULT 'CA',
  avatar_url  TEXT CHECK (avatar_url IS NULL OR avatar_url ~ '^data:image\/(png|jpeg|webp|gif);base64,'),
  theme       VARCHAR(20)  NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'neon', 'midnight')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_profile_updated_at
BEFORE UPDATE ON profile
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------
-- Tabelle: links
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      VARCHAR(80)  NOT NULL,
  subtitle   VARCHAR(120) NOT NULL DEFAULT '',
  url        VARCHAR(500) NOT NULL CHECK (url ~ '^https?://' OR url ~ '^mailto:'),
  icon       VARCHAR(500) NOT NULL DEFAULT '🔗',
  position   INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  open_new   BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_links_updated_at
BEFORE UPDATE ON links
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------
-- Tabelle: admin_settings (Singleton)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_settings (
  id                         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  admin_enabled              BOOLEAN NOT NULL DEFAULT true,
  discord_webhook_enabled    BOOLEAN NOT NULL DEFAULT false,
  discord_webhook_url        VARCHAR(500) DEFAULT NULL,
  discord_webhook_template   JSONB DEFAULT NULL,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_admin_settings_updated_at
BEFORE UPDATE ON admin_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------
-- Tabelle: navidrome_settings (Singleton)
-- Passwort wird AES-256-GCM verschlüsselt gespeichert
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS navidrome_settings (
  id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled           BOOLEAN NOT NULL DEFAULT false,
  url               VARCHAR(500) DEFAULT NULL CHECK (url IS NULL OR url ~ '^https?://'),
  username          VARCHAR(120) DEFAULT NULL,
  password_encrypted TEXT DEFAULT NULL,
  poll_interval_sec INTEGER NOT NULL DEFAULT 30 CHECK (poll_interval_sec BETWEEN 5 AND 600),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_navidrome_settings_updated_at
BEFORE UPDATE ON navidrome_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------
-- Tabelle: user_sessions (fuer connect-pg-simple)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
  sid    VARCHAR(255) NOT NULL PRIMARY KEY,
  sess   JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions (expire);
