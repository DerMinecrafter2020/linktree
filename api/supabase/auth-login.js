// =========================================================
// SupabaseAPI — Auth Login
// =========================================================
// Login gegen die auth-login Edge-Function.
// Speichert das JWT in den entsprechenden globalen Variablen.
//
// Verwendung:
//   const data = await SupabaseAPI.authLogin({
//     url: window.SUPABASE_CONFIG.authLoginUrl,
//     password: '...',
//     honeypot: '',
//     onToken: (token, expiresAt) => setToken(token, expiresAt),
//   });
// =========================================================

window.SupabaseAPI = window.SupabaseAPI || {};
window.SupabaseAPI.authLogin = async function ({ url, password, honeypot, onToken }) {
  if (!url) throw new Error('authLoginUrl not set');
  const data = await window.SupabaseHelpers.postJSON(
    url,
    null,
    { password: String(password || ''), website: honeypot || '' }
  );
  if (data && data.token && typeof onToken === 'function') {
    onToken(data.token, data.expiresAt);
  }
  return data;
};