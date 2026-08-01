// =========================================================
// Navidrome API Client (Browser-seitig)
// =========================================================
// Saubere Wrapper-Funktionen für die Navidrome-Proxy-Endpoints.
// Jeder Endpoint hat eine eigene Funktion in einer eigenen Datei:
//
//   api/navidrome/status.js
//   api/navidrome/nowplaying.js
//   api/navidrome/control.js
//   api/navidrome/coverart.js
//
// Verwendung im Browser:
//   <script src="api/navidrome/_shared.js"></script>
//   <script src="api/navidrome/status.js"></script>
//   <script src="api/navidrome/nowplaying.js"></script>
//   ...
//
// Aufruf:
//   await NavidromeAPI.nowPlaying();
// =========================================================

window.NavidromeAPI = (function () {
  'use strict';

  // Liest Konfiguration aus window.NAVIDROME_CONFIG
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

  // POST-Wrapper. Wirft einen Error wenn die Response nicht ok ist.
  async function postJSON(path, body) {
    const cfg = getConfig();
    if (!cfg.proxyUrl) {
      throw new Error('NAVIDROME_CONFIG.proxyUrl not set');
    }
    const r = await fetch(cfg.proxyUrl, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { ok: false, error: text }; }
    if (!r.ok || !json.ok) {
      throw new Error(json.error || ('HTTP ' + r.status));
    }
    return json.data;
  }

  return {
    config: getConfig,
    post: postJSON,
  };
})();
