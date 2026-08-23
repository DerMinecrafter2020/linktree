// =========================================================
// Navidrome API-Client (Browser)
// =========================================================
// Spricht gegen das eigene Backend /api/navidrome/*,
// damit Credentials niemals im Browser landen.

(() => {
  'use strict';

  window.NavidromeAPI = window.NavidromeAPI || {};

  async function getJSON(path) {
    const r = await fetch(`/api${path}`, { credentials: 'same-origin' });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { ok: false, error: text }; }
    if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
    return json.data;
  }

  async function postJSON(path, body) {
    const r = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { ok: false, error: text }; }
    if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
    return json.data;
  }

  window.NavidromeAPI.status = async function () {
    const data = await getJSON('/status/now-playing');
    return { configured: data && (data.playing === true || data.playing === false), data };
  };

  window.NavidromeAPI.nowPlaying = async function () {
    return await getJSON('/status/now-playing');
  };

  window.NavidromeAPI.control = async function (action) {
    return await postJSON('/navidrome/control', { action });
  };

  window.NavidromeAPI.coverArt = async function (id, size) {
    if (!id) throw new Error('coverArt id required');
    return `/api/navidrome/cover-art?id=${encodeURIComponent(id)}&size=${encodeURIComponent(size || 220)}`;
  };
})();
