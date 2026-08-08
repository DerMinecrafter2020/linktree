// =========================================================
// Supabase Edge Function: save-config
// =========================================================
// Schreibt die Browser-Supabase-URL zurueck in die lokale config.js
// auf dem Server. Benoetigt keine Authentifizierung (oeffentlich),
// weil die Funktion nur die URL schreibt, die der User sowieso
// kennt. In Production sollte ein Token/Shared-Secret erforderlich sein.
//
// Aufruf (Browser -> Supabase -> nginx -> save-config):
//   POST /functions/v1/save-config
//   Body:   { url: "https://xxx.supabase.co", anonKey: "...", secret: "<shared-secret>" }
//
// Antwort:
//   200 { ok: true }
//   401 { ok: false, error: "unauthorized" }
//   400 { ok: false, error: "invalid url" }
//
// @ts-nocheck
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-secret',
};

const CONFIG_PATH = '/var/html/config.js';
const SHARED_SECRET = Deno.env.get('CONFIG_SHARED_SECRET') || '';
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

function json(data, status, req) {
  const origin = req?.headers.get('origin') || '';
  const cors = ALLOWED_ORIGINS.length === 0
    ? { ...CORS, 'Access-Control-Allow-Origin': origin || '*' }
    : ALLOWED_ORIGINS.includes(origin)
      ? { ...CORS, 'Access-Control-Allow-Origin': origin }
      : {
          'Access-Control-Allow-Origin': 'null',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-secret',
        };
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}

function isValidUrl(u) {
  try {
    const url = new URL(u);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405, req);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid json' }, 400, req); }

  // Shared-Secret bevorzugt aus Header (nicht im JSON-Body/Proxy-Log sichtbar),
  // Fallback auf Body für alte Clients.
  if (SHARED_SECRET) {
    const provided = String(req.headers.get('x-admin-secret') || body?.secret || '');
    if (provided !== SHARED_SECRET) {
      return json({ ok: false, error: 'unauthorized' }, 401, req);
    }
  }

  const newUrl = String(body.url || '').trim();
  const newKey = String(body.anonKey || '').trim();
  if (!isValidUrl(newUrl)) {
    return json({ ok: false, error: 'invalid url' }, 400, req);
  }
  if (newKey.length < 50) {
    return json({ ok: false, error: 'anon-key too short' }, 400, req);
  }

  // Bestehende config.js lesen
  let existing = '';
  try {
    existing = await Deno.readTextFile(CONFIG_PATH);
  } catch (_) {
    return json({ ok: false, error: 'config.js not found at ' + CONFIG_PATH }, 500, req);
  }

  // Backup
  try {
    await Deno.writeTextFile(CONFIG_PATH + '.bak', existing);
  } catch (_) { /* backup best-effort */ }

  // Ersetze url: und anonKey: Zeilen mit den neuen Werten
  let updated = existing
    .replace(/url:\s*'[^']*'/i, `url: '${newUrl}'`)
    .replace(/anonKey:\s*'[^']*'/i, `anonKey: '${newKey}'`)
    .replace(/adminProxyUrl:\s*'[^']*'/i, `adminProxyUrl: '${newUrl}/functions/v1/admin-proxy'`)
    .replace(/proxyUrl:\s*'[^']*'/i, `proxyUrl: '${newUrl}/functions/v1/navidrome-proxy'`);

  // Zurueckschreiben
  try {
    await Deno.writeTextFile(CONFIG_PATH, updated);
  } catch (e) {
    return json({ ok: false, error: 'write failed: ' + e.message }, 500, req);
  }

  return json({ ok: true, url: newUrl }, 200, req);
});