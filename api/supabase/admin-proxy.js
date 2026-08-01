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
window.SupabaseAPI.adminProxy = async function ({ url, token, action, data, extra, authEnabled, anonKey }) {
  if (!url) throw new Error('adminProxyUrl not set');
  if (!token) throw new Error('token missing');

  const headers = { apikey: anonKey || '' };
  const body = { action: action, data: data || {} };
  // Extra-Felder (z.B. id für updateLink/deleteLink) werden als Top-Level gemerged
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) {
      if (extra[k] !== undefined) body[k] = extra[k];
    }
  }
  if (authEnabled) {
    headers['Authorization'] = 'Bearer ' + token;
  } else {
    headers['Authorization'] = 'Bearer ' + (anonKey || '');
    body.token = token;
  }
  return await window.SupabaseHelpers.postJSON(url, headers, body);
};