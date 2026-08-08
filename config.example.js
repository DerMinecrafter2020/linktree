// =========================================================
// Supabase-Konfiguration — BEISPIEL
// =========================================================
// Kopiere diese Datei nach `config.js` und trage deine echten
// Werte ein. `config.js` ist in .gitignore und wird NIE gepusht.

window.SUPABASE_CONFIG = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'YOUR-ANON-KEY',

  // --- Optionale Supabase Edge Functions ---
  authEnabled: false,
  adminProxyUrl:         'https://YOUR-PROJECT.supabase.co/functions/v1/admin-proxy',
  authLoginUrl:          'https://YOUR-PROJECT.supabase.co/functions/v1/auth-login',
  authChangePasswordUrl: 'https://YOUR-PROJECT.supabase.co/functions/v1/auth-change-password',
  discordWebhookUrl:     'https://YOUR-PROJECT.supabase.co/functions/v1/discord-webhook',
};

// =========================================================
// Navidrome / Subsonic — Musik-Player (optional)
// =========================================================
// Wenn aktiviert, holt die Hauptseite alle 30s den aktuellen
// Track von deinem Navidrome-Server via Subsonic-API.
//
// Voraussetzung:
//   1. Edge-Function `navidrome-proxy` deployen:
//        supabase functions deploy navidrome-proxy
//   2. Secrets setzen:
//        supabase secrets set NAVIDROME_URL=https://navidrome.example.com
//        supabase secrets set NAVIDROME_USER=alice
//        supabase secrets set NAVIDROME_PASS=geheim123
window.NAVIDROME_CONFIG = {
  enabled: true,                                   // Default: AN. Im Admin-Panel deaktivierbar.
  url: 'https://navidrome.example.com',
  user: 'YOUR_USER',
  pass: 'YOUR_PASS',
  proxyUrl: 'https://YOUR-PROJECT.supabase.co/functions/v1/navidrome-proxy',
  pollIntervalSec: 30,
};
