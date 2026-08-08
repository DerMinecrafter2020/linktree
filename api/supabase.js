// =========================================================
// Supabase API Bundle (Browser)
// =========================================================
// Vereint die bisherigen Einzeldateien:
//   _shared.js, admin-proxy.js, auth-login.js,
//   auth-change-password.js, save-config.js
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
  window.SupabaseAPI.adminProxy = async function ({ url, token, action, data, extra, authEnabled, anonKey }) {
    if (!url) throw new Error('adminProxyUrl not set');
    if (!token) throw new Error('token missing');

    const headers = { apikey: anonKey || '' };
    const body = { action: action, data: data || {} };
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) {
        if (extra[k] !== undefined) body[k] = extra[k];
      }
    }
    headers['Authorization'] = 'Bearer ' + (authEnabled ? token : (anonKey || ''));
    if (!authEnabled) body.token = token;

    return await Helpers.postJSON(url, headers, body);
  };

  // ---------- Auth Login ----------
  window.SupabaseAPI.authLogin = async function ({ url, password, honeypot, onToken }) {
    if (!url) throw new Error('authLoginUrl not set');
    const data = await Helpers.postJSON(url, null, {
      password: String(password || ''),
      website: honeypot || '',
    });
    if (data && data.token && typeof onToken === 'function') {
      onToken(data.token, data.expiresAt);
    }
    return data;
  };

  // ---------- Auth Change Password ----------
  window.SupabaseAPI.authChangePassword = async function ({ url, token, oldPassword, newPassword }) {
    if (!url) throw new Error('authChangePasswordUrl not set');
    if (!token) throw new Error('not logged in');
    return await Helpers.postJSON(
      url,
      { 'Authorization': 'Bearer ' + token },
      { old_password: oldPassword, new_password: newPassword }
    );
  };

  // ---------- Save Config ----------
  window.SupabaseAPI.saveConfig = async function ({ url, anonKey, secret }) {
    const m = String(url || '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
    if (!m) throw new Error('Ungueltige Supabase-URL (Format: https://<ref>.supabase.co)');
    const projectRef = m[1];
    const endpoint = `https://${projectRef}.supabase.co/functions/v1/save-config`;

    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers['x-config-secret'] = secret;

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ url: url, anonKey: anonKey }),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { ok: false, error: text }; }
    if (!r.ok || !json.ok) {
      throw new Error(json.error || ('HTTP ' + r.status));
    }
    return json;
  };

  // ---------- Discord Webhook (Now Playing) ----------
  window.SupabaseAPI.discordWebhook = async function ({ url, token, track, anonKey, authEnabled }) {
    if (!url) throw new Error('discordWebhookUrl not set');
    const headers = { apikey: anonKey || '', 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + (authEnabled ? token : (anonKey || ''));
    return await Helpers.postJSON(url, headers, { track });
  };
})();
