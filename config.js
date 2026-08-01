// =========================================================
// Supabase-Konfiguration
// =========================================================
// Diese Datei ist im Repo eingecheckt (mit Platzhaltern).
// Beim ersten Aufruf wird die Seite im Demo-Mode laufen
// (Daten nur lokal im Browser gespeichert).
//
// Fuer Produktivbetrieb:
//   sudo bash install.sh
// Dies ersetzt die Platzhalter mit echten Werten und speichert
// ein Backup der Platzhalter-Version als config.js.original.

window.SUPABASE_CONFIG = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'YOUR-ANON-KEY-HERE',

  // --- Optionale Supabase Edge Functions ---
  authEnabled: false,
  adminProxyUrl:         'https://YOUR-PROJECT.supabase.co/functions/v1/admin-proxy',
  authLoginUrl:          'https://YOUR-PROJECT.supabase.co/functions/v1/auth-login',
  authChangePasswordUrl: 'https://YOUR-PROJECT.supabase.co/functions/v1/auth-change-password',
};

// =========================================================
// Navidrome / Subsonic — Musik-Player (optional)
// =========================================================
// Wenn aktiviert, holt die Hauptseite alle 30s den aktuellen
// Track von deinem Navidrome-Server via Subsonic-API.
//
// Voraussetzung:
//   1. Edge-Function 'navidrome-proxy' deployen:
//        supabase functions deploy navidrome-proxy
//   2. Secrets setzen:
//        supabase secrets set NAVIDROME_URL=https://navidrome.example.com
//        supabase secrets set NAVIDROME_USER=alice
//        supabase secrets set NAVIDROME_PASS=geheim123
window.NAVIDROME_CONFIG = {
  enabled: true,                                   // Default: AN
  url: 'https://navidrome.example.com',
  user: 'YOUR_USER',
  pass: 'YOUR_PASS',

  // Edge-Function-Proxy (empfohlen — schützt Credentials vor CORS-Exposure)
  proxyUrl: 'https://YOUR-PROJECT.supabase.co/functions/v1/navidrome-proxy',

  // Polling-Intervall für "Now Playing" (in Sekunden)
  pollIntervalSec: 30,
};

// Wird vom Admin-Panel in localStorage gespeichert (PBKDF2-gehasht).
// Wird vom install.sh mit dem vom User gewaehlten Passwort ueberschrieben.
window.ADMIN_DEFAULT_PASSWORD = 'admin123';