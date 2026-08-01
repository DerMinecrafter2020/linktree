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
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'YOUR-ANON-KEY',

  // --- Optionale Supabase Edge Functions ---
  authEnabled: false,
  adminProxyUrl:         'https://YOUR-PROJECT.supabase.co/functions/v1/admin-proxy',
  authLoginUrl:          'https://YOUR-PROJECT.supabase.co/functions/v1/auth-login',
  authChangePasswordUrl: 'https://YOUR-PROJECT.supabase.co/functions/v1/auth-change-password',
};
