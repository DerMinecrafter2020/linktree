// =========================================================
// SupabaseAPI — Admin Proxy
// =========================================================
// Generischer Wrapper für die admin-proxy Edge-Function.
// Erwartet URL + Token + Action + Data, sendet JWT im Header.
//
// Verwendung:
//   const result = await SupabaseAPI.adminProxy({
//     url: window.SUPABASE_CONFIG.adminProxyUrl,
//     token: getToken(),
//     action: 'updateProfile',
//     data: { ... },
//     authEnabled: true,
//   });
// =========================================================

window.SupabaseAPI = window.SupabaseAPI || {};
window.SupabaseAPI.adminProxy = async function ({ url, token, action, data, authEnabled, anonKey }) {
  if (!url) throw new Error('adminProxyUrl not set');
  if (!token) throw new Error('token missing');

  const headers = { apikey: anonKey || '' };
  const body = { action: action, data: data || {} };
  if (authEnabled) {
    headers['Authorization'] = 'Bearer ' + token;
  } else {
    headers['Authorization'] = 'Bearer ' + (anonKey || '');
    body.token = token;
  }
  return await window.SupabaseHelpers.postJSON(url, headers, body);
};