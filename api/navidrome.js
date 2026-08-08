// =========================================================
// Navidrome API Bundle (Browser)
// =========================================================
// Vereint die bisherigen Einzeldateien:
//   _shared.js (client.js), _shared.js (helpers),
//   status.js, nowplaying.js, control.js, coverart.js
// =========================================================

(() => {
  'use strict';

  window.NavidromeAPI = window.NavidromeAPI || {};

  // ---------- Helpers ----------
  function safe(fn) {
    return function (...args) {
      try { return fn.apply(this, args); }
      catch (e) { console.warn('[navidrome] error:', e.message); return null; }
    };
  }

  function getConfig() {
    return window.NAVIDROME_CONFIG || {};
  }

  function getAuthHeaders() {
    const key = window.SUPABASE_CONFIG?.anonKey || '';
    return {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': 'Bearer ' + key,
    };
  }

  async function postJSON(path, body) {
    const cfg = getConfig();
    if (!cfg.proxyUrl) throw new Error('NAVIDROME_CONFIG.proxyUrl not set');

    const r = await fetch(cfg.proxyUrl, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(Object.assign({ action: path }, body || {})),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { ok: false, error: text }; }
    if (!r.ok || !json.ok) {
      throw new Error(json.error || ('HTTP ' + r.status));
    }
    return json.data;
  }

  // ---------- Public API ----------
  window.NavidromeAPI.config = getConfig;
  window.NavidromeAPI.post = postJSON;

  window.NavidromeAPI.status = safe(async function () {
    return await postJSON('status', {});
  });

  window.NavidromeAPI.nowPlaying = safe(async function () {
    return await postJSON('nowPlaying', {});
  });

  window.NavidromeAPI.control = safe(async function (action) {
    if (!action) throw new Error('control action required (play|pause|next|previous)');
    return await postJSON('control', { controlAction: action });
  });

  window.NavidromeAPI.coverArt = safe(async function (id, size) {
    if (!id) throw new Error('coverArt id required');
    return await postJSON('coverArt', { id: id, size: size || 220 });
  });
})();
