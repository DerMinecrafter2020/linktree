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
