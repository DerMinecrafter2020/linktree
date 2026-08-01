// =========================================================
// Shared helper for supabase/api/ files
// =========================================================
// Stellt SupabaseAPI-Container + try/catch-Wrapper bereit.
// =========================================================

window.SupabaseAPI = window.SupabaseAPI || {};
window.SupabaseHelpers = window.SupabaseHelpers || (function () {
  'use strict';

  // POST-Wrapper mit JSON-Antwort. Wirft, wenn die Response nicht ok ist.
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