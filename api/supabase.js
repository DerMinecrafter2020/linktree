// =========================================================
// Supabase API Bundle (Browser)
// =========================================================
// Vereint die bisherigen Einzeldateien:
//   _shared.js, admin-proxy.js, save-config.js
// =========================================================

(() => {
  'use strict';

  window.SupabaseAPI = window.SupabaseAPI || {};

  // ---------- Shared helpers ----------
  const Helpers = window.SupabaseHelpers || (function () {
    async function postJSON(url, headers, body) {
      const r = await fetch(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch (_) { json = { ok: false, error: text }; }
      if (!r.ok || !json.ok) {
        throw new Error(json.error || ('HTTP ' + r.status));
      }
      return json.data !== undefined ? json.data : json;
    }
    return { postJSON };
  })();
  window.SupabaseHelpers = Helpers;

  // ---------- Admin Proxy ----------
  window.SupabaseAPI.adminProxy = async function ({ url, action, data, extra, anonKey, secret }) {
    if (!url) throw new Error('adminProxyUrl not set');
    if (!secret) throw new Error('shared secret missing');
    if (!anonKey) throw new Error('anonKey missing');

    // Shared Secret kommt aus /admin/admin-config.js und wird im Header
    // übertragen, damit es nicht im JSON-Body landet.
    const headers = {
      apikey: anonKey,
      'Authorization': 'Bearer ' + anonKey,
      'X-Admin-Secret': secret,
    };
    const body = { action: action, data: data || {} };
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) {
        if (extra[k] !== undefined) body[k] = extra[k];
      }
    }

    return await Helpers.postJSON(url, headers, body);
  };

  // ---------- Save Config ----------
  window.SupabaseAPI.saveConfig = async function ({ url, anonKey, secret }) {
    const m = String(url || '').match(/https:\/\/([a-z0-9][a-z0-9-]*)\.supabase\.co/i);
    if (!m) throw new Error('Ungueltige Supabase-URL (Format: https://<ref>.supabase.co)');
    const projectRef = m[1];
    const endpoint = `https://${projectRef}.supabase.co/functions/v1/save-config`;

    const headers = {
      apikey: anonKey || '',
      'Authorization': 'Bearer ' + (anonKey || ''),
      'Content-Type': 'application/json',
    };
    if (secret) headers['X-Admin-Secret'] = secret;
    const body = { url: url, anonKey: anonKey };

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { ok: false, error: text }; }
    if (!r.ok || !json.ok) {
      throw new Error(json.error || ('HTTP ' + r.status));
    }
    return json;
  };

})();
