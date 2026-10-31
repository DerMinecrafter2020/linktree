-- Navidrome-Benutzername wie das Passwort nur verschluesselt speichern.
-- Bestehende Klartext-Werte verschluesselt lib/navidrome.js beim ersten Zugriff
-- (der Schluessel liegt nur in der Umgebung, nicht in der Datenbank) und leert danach "username".
ALTER TABLE navidrome_settings ADD COLUMN IF NOT EXISTS username_encrypted TEXT;
