-- Kontaktformular auf der Startseite. Versand ueber die SMTP-Daten aus alert_settings
-- (Admin > Einstellungen > Benachrichtigungen); hier nur die Formular-Einstellungen.
-- Nachrichten werden nicht in der Datenbank gespeichert, nur per E-Mail zugestellt.
CREATE TABLE IF NOT EXISTS contact_settings (
  id INTEGER PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  recipient VARCHAR(254),
  intro_text VARCHAR(500),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO contact_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
