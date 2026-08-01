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
};
