-- SMTP-Passwort wird verschluesselt (AES-256-GCM) gespeichert; das Chiffrat ist laenger als 255 Zeichen moeglich
ALTER TABLE alert_settings ALTER COLUMN smtp_password TYPE TEXT;
