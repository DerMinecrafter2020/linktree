// =========================================================
// Supabase-Konfiguration
// =========================================================
// Trage hier deine Supabase-Zugangsdaten ein.
// Du findest sie unter: Supabase Dashboard → Project Settings → API

// =========================================================
// Supabase-Konfiguration — LOKAL (nicht eingecheckt!)
// =========================================================
// Diese Datei ist in .gitignore. Für ein Beispiel siehe
// config.example.js. Trage hier deine echten Werte ein.

window.SUPABASE_CONFIG = {
  url: 'https://fxywervpqojpjwreymdp.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ4eXdlcnZwcW9qcGp3cmV5bWRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1Mjg4MDIsImV4cCI6MjEwMTEwNDgwMn0.ta9GfKsphl_IOVYd1LkENsbelbGB8SsdVTmBRUb95Wo',

  // --- Optionale Supabase Edge Functions ---
  authEnabled: false,
  adminProxyUrl:         'https://fxywervpqojpjwreymdp.supabase.co/functions/v1/admin-proxy',
  authLoginUrl:          'https://fxywervpqojpjwreymdp.supabase.co/functions/v1/auth-login',
  authChangePasswordUrl: 'https://fxywervpqojpjwreymdp.supabase.co/functions/v1/auth-change-password',
};

// =========================================================
// Navidrome / Subsonic — Musik-Player
// =========================================================
// Trage hier deine Navidrome-URL und Credentials ein.
// Optional: Wenn du KEINE Navidrome hast, lass die Werte leer
// und der Player wird auf der Hauptseite ausgeblendet.
window.NAVIDROME_CONFIG = {
  enabled: false,
  url: 'https://music.deinedomain.de',   // z. B. https://navidrome.example.com
  user: 'YOUR_USER',
  pass: 'YOUR_PASS',

  // Edge-Function-Proxy (empfohlen — schützt Credentials vor CORS-Exposure)
  proxyUrl: 'https://fxywervpqojpjwreymdp.supabase.co/functions/v1/navidrome-proxy',

  // Polling-Intervall für "Now Playing" (in Sekunden)
  pollIntervalSec: 30,
};
