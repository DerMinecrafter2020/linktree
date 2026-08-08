// =========================================================
// Discord Webhook API Bundle (Browser)
// =========================================================
// Vereint Now-Playing Discord-Webhook-Funktionalität in einem
// Bundle, das von index.html / app.js geladen werden kann.
// =========================================================

(() => {
  'use strict';

  window.DiscordAPI = window.DiscordAPI || {};

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

  // ---------- Discord Webhook (Now Playing) ----------
  window.DiscordAPI.send = async function (track) {
    const url = window.SUPABASE_CONFIG?.discordWebhookUrl;
    if (!url) throw new Error('discordWebhookUrl not set');
    const anonKey = window.SUPABASE_CONFIG?.anonKey || '';
    return await Helpers.postJSON(
      url,
      { apikey: anonKey, 'Content-Type': 'application/json' },
      { track: track || {} }
    );
  };
})();
