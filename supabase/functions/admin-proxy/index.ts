// =========================================================
// Supabase Edge Function: admin-proxy
// =========================================================
// Diese Funktion kapselt ALLE Schreiboperationen hinter einem
// Shared Secret, das install.sh in Supabase Secrets und lokal
// in /var/html/.openweb.env ablegt.
//
// Deployment:
//   1. supabase functions deploy admin-proxy
//   2. supabase secrets set SERVICE_ROLE_KEY=...
//   3. supabase secrets set CONFIG_SHARED_SECRET=...
//
// Aufruf von der App:
//   POST {SUPABASE_URL}/functions/v1/admin-proxy
//   Header: Authorization: Bearer <anon-key>
//           X-Admin-Secret: <CONFIG_SHARED_SECRET>
//   Body:   { "action": "saveProfile", "data": {...} }
//
// Antwort:
//   200 { "ok": true,  "data": {...} }
//   401 { "ok": false, "error": "unauthorized" }
//   400 { "ok": false, "error": "<validation>" }
// =========================================================
//
// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-secret',
};

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

function corsFor(req) {
  const origin = req.headers.get('origin') || '';
  if (ALLOWED_ORIGINS.length === 0) {
    return { ...CORS, 'Access-Control-Allow-Origin': origin || '*' };
  }
  if (ALLOWED_ORIGINS.includes(origin)) {
    return { ...CORS, 'Access-Control-Allow-Origin': origin };
  }
  // Unbekannter Origin: keine CORS-Weitergabe (Preflight/Request wird blockiert)
  return {
    'Access-Control-Allow-Origin': 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-secret',
  };
}

function json(data, status, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsFor(req) }
  });
}

const SHARED_SECRET = Deno.env.get('CONFIG_SHARED_SECRET') || '';

function isHttpUrl(u) {
  try {
    const url = new URL(u);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol);
  } catch { return false; }
}

function validateAdminSettings(s) {
  if (!s || typeof s !== 'object') throw new Error('invalid admin settings');
  const out = {};
  if (typeof s.admin_enabled === 'boolean') out.admin_enabled = s.admin_enabled;
  if (typeof s.navidrome_enabled === 'boolean') out.navidrome_enabled = s.navidrome_enabled;
  if (typeof s.navidrome_proxy_url === 'string') {
    const u = s.navidrome_proxy_url.trim();
    if (u && !/^https?:\/\//i.test(u)) throw new Error('invalid navidrome proxy url');
    out.navidrome_proxy_url = u || null;
  }
  if (typeof s.navidrome_poll_interval_sec === 'number') {
    const n = Number(s.navidrome_poll_interval_sec);
    if (!Number.isFinite(n) || n < 10 || n > 600) throw new Error('invalid navidrome poll interval');
    out.navidrome_poll_interval_sec = Math.round(n);
  }
  return out;
}

function validateProfile(p) {
  if (!p || typeof p !== 'object') throw new Error('invalid profile');
  const out = {};
  if (typeof p.name === 'string') {
    // ASCII-only (Buchstaben/Zahlen/Punkt/Leer-/Sonderzeichen erlaubt, aber < > " ' raus)
    out.name = p.name.slice(0, 80).replace(/[\u0000-\u001f\u007f<>"']/g, '');
  }
  if (typeof p.handle === 'string') {
    out.handle = p.handle.slice(0, 80).replace(/[\u0000-\u001f\u007f<>"']/g, '');
  }
  if (typeof p.bio === 'string') {
    out.bio = p.bio.slice(0, 280).replace(/[\u0000-\u001f\u007f<>"']/g, '');
  }
  if (typeof p.avatar === 'string') {
    // Avatar-Buchstaben: max 4, nur [A-Za-z0-9], keine HTML-Sonderzeichen
    out.avatar = p.avatar.slice(0, 4).replace(/[^A-Za-z0-9]/g, '') || 'CA';
  }
  // avatar_url: nur DataURLs von sicheren Bildformaten (kein SVG!)
  if (p.avatar_url === null) {
    out.avatar_url = null;
  } else if (typeof p.avatar_url === 'string') {
    if (p.avatar_url.length > 700_000) throw new Error('avatar_url too large (max 500KB)');
    // explizit KEIN svg+xml (kann <script> enthalten)
    if (/^data:image\/svg\+xml/i.test(p.avatar_url)) {
      throw new Error('svg avatars are not allowed (use PNG/JPG/WebP)');
    }
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(p.avatar_url)) {
      throw new Error('avatar_url must be a data:image base64 URL');
    }
    out.avatar_url = p.avatar_url;
  }
  // Theme: Whitelist (verhindert beliebige Strings → würde sonst in
  // data-theme="<user-input>" als HTML-Attribut landen)
  if (typeof p.theme === 'string') {
    if (!['neon', 'light', 'sunset', 'mono'].includes(p.theme)) {
      throw new Error('invalid theme (allowed: neon, light, sunset, mono)');
    }
    out.theme = p.theme;
  }
  return out;
}

function validateLink(l) {
  if (!l || typeof l !== 'object') throw new Error('invalid link');
  if (typeof l.title !== 'string' || !l.title.trim()) throw new Error('title required');
  if (typeof l.url !== 'string' || !l.url.trim()) throw new Error('url required');
  // Sanitize title/subtitle (keine HTML-Injection)
  const title = l.title.replace(/[\u0000-\u001f\u007f<>"']/g, '').slice(0, 200);
  const subtitle = (typeof l.subtitle === 'string' ? l.subtitle : '')
    .replace(/[\u0000-\u001f\u007f<>"']/g, '').slice(0, 300);
  // Icon: simpleicon:ID (whitelist) ODER https-URL (validiert) ODER safe-emoji
  let icon = '🔗';
  if (typeof l.icon === 'string') {
    const ic = l.icon.trim();
    if (ic.startsWith('simpleicon:')) {
      const id = ic.slice('simpleicon:'.length).toLowerCase();
      if (/^[a-z0-9-]{1,32}$/.test(id)) icon = `simpleicon:${id}`;
    } else if (/^https?:\/\//i.test(ic)) {
      if (isHttpUrl(ic)) icon = ic.slice(0, 200);
    } else {
      // Emoji oder Text: max 8 Zeichen, strip < > " '
      icon = ic.replace(/[<>"']/g, '').slice(0, 8) || '🔗';
    }
  }
  return {
    title,
    subtitle,
    url: isHttpUrl(l.url) ? l.url.slice(0, 500) : (() => { throw new Error('invalid url') })(),
    icon,
    position: Number.isInteger(l.position) ? l.position : 0,
    is_active: typeof l.is_active === 'boolean' ? l.is_active : true,
    open_new:  typeof l.open_new  === 'boolean' ? l.open_new  : true,
  };
}

async function authenticate(req, body) {
  if (!SHARED_SECRET) throw new Error('server not configured');
  // Secret bevorzugt aus Header (nicht im JSON-Body/Proxy-Log sichtbar),
  // Fallback auf Body für alte Clients.
  const provided = String(req.headers.get('x-admin-secret') || body?.secret || '');
  if (provided !== SHARED_SECRET) throw new Error('unauthorized');
  return { sub: 'admin' };
}

// --- Rate-Limit (pro IP / Shared-Secret-Client, in-Memory; pro Edge-Instance) ---
const WRITE_WINDOW_MS = 60 * 1000;
const WRITE_MAX = 60; // max 60 Mutationen pro Minute
const writeAttempts = new Map(); // key -> [timestamps]

function checkWriteRate(key) {
  const now = Date.now();
  const arr = (writeAttempts.get(key) || []).filter(t => now - t < WRITE_WINDOW_MS);
  if (arr.length >= WRITE_MAX) {
    const oldest = arr[0];
    const retryAfter = Math.ceil((WRITE_WINDOW_MS - (now - oldest)) / 1000);
    return { ok: false, retryAfter };
  }
  arr.push(now);
  writeAttempts.set(key, arr);
  return { ok: true };
}

// Maximaler Body-Size + JSON-Tiefe
const MAX_BODY_BYTES = 600_000; // ~500 KB Avatar-DataURL + slack
const MAX_JSON_DEPTH = 5;

function safeJsonParse(text) {
  if (text.length > MAX_BODY_BYTES) throw new Error('payload too large');
  const seen = new WeakSet();
  function checkDepth(v, d) {
    if (d > MAX_JSON_DEPTH) throw new Error('payload too deep');
    if (v && typeof v === 'object') {
      if (seen.has(v)) throw new Error('cycle detected');
      seen.add(v);
      for (const k in v) checkDepth(v[k], d + 1);
    }
  }
  const parsed = JSON.parse(text);
  checkDepth(parsed, 0);
  return parsed;
}

const ALLOWED_ACTIONS = new Set([
  'saveProfile', 'createLink', 'updateLink', 'deleteLink', 'reorderLinks',
  'getAdminSettings', 'saveAdminSettings'
]);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) });
  if (req.method !== 'POST')   return json({ ok: false, error: 'method not allowed' }, 405, req);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY  = Deno.env.get('SERVICE_ROLE_KEY')!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: 'invalid json' }, 400, req); }

  let claims;
  try { claims = await authenticate(req, body); }
  catch { return json({ ok: false, error: 'unauthorized' }, 401, req); }

  // Rate-Limit: pro Client (IP + secret-Hash)
  const rateKey = `${req.headers.get('x-forwarded-for') || 'unknown'}-${claims.sub || 'admin'}`;
  const gate = checkWriteRate(rateKey);
  if (!gate.ok) {
    return new Response(JSON.stringify({
      ok: false, error: 'rate limit exceeded', retryAfter: gate.retryAfter
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(gate.retryAfter),
        ...corsFor(req)
      }
    });
  }

  // Action-Whitelist
  if (!ALLOWED_ACTIONS.has(body.action)) {
    return json({ ok: false, error: 'unknown action' }, 400, req);
  }

  // Wenn Admin-Bereich deaktiviert ist: Schreiboperationen blockieren,
  // außer saveAdminSettings (damit man ihn wieder aktivieren kann).
  const WRITE_ACTIONS = new Set([
    'saveProfile', 'createLink', 'updateLink', 'deleteLink', 'reorderLinks'
  ]);
  if (WRITE_ACTIONS.has(body.action)) {
    try {
      const { data } = await admin.from('admin_settings')
        .select('admin_enabled')
        .eq('id', 1)
        .maybeSingle();
      if (data && data.admin_enabled === false) {
        return json({ ok: false, error: 'admin area disabled' }, 403, req);
      }
    } catch (_) {
      // Bei Fehler: weiter im Standard-Flow (fail-open ist hier akzeptabel)
    }
  }

  try {
    switch (body.action) {
      case 'saveProfile': {
        const profile = validateProfile(body.data);
        const { error } = await admin.from('profile').upsert({ id: 1, ...profile });
        if (error) throw error;
        return json({ ok: true }, 200, req);
      }
      case 'getAdminSettings': {
        const { data, error } = await admin.from('admin_settings')
          .select('id,admin_enabled,navidrome_enabled,navidrome_proxy_url,navidrome_poll_interval_sec')
          .eq('id', 1).maybeSingle();
        if (error) throw error;
        // Sicherstellen, dass admin_enabled immer einen definierten Wert hat
        const result = data || {};
        if (typeof result.admin_enabled !== 'boolean') result.admin_enabled = true;
        return json({ ok: true, data: result }, 200, req);
      }
      case 'saveAdminSettings': {
        const settings = validateAdminSettings(body.data);
        const { error } = await admin.from('admin_settings').upsert({ id: 1, ...settings }, { onConflict: 'id' });
        if (error) throw error;
        return json({ ok: true }, 200, req);
      }
      case 'createLink': {
        const link = validateLink(body.data);
        const { data, error } = await admin.from('links').insert(link).select().single();
        if (error) throw error;
        return json({ ok: true, data }, 200, req);
      }
      case 'updateLink': {
        if (!body.id) throw new Error('id required');
        const link = validateLink(body.data);
        const { error } = await admin.from('links').update(link).eq('id', body.id);
        if (error) throw error;
        return json({ ok: true }, 200, req);
      }
      case 'deleteLink': {
        if (!body.id) throw new Error('id required');
        const { error } = await admin.from('links').delete().eq('id', body.id);
        if (error) throw error;
        return json({ ok: true }, 200, req);
      }
      case 'reorderLinks': {
        if (!Array.isArray(body.orderedIds)) throw new Error('orderedIds required');
        if (body.orderedIds.length > 100) throw new Error('too many ids (max 100)');
        if (!body.orderedIds.every(id => typeof id === 'string' && id.length <= 64)) {
          throw new Error('invalid id format');
        }
        for (let i = 0; i < body.orderedIds.length; i++) {
          const { error } = await admin.from('links').update({ position: i }).eq('id', body.orderedIds[i]);
          if (error) throw error;
        }
        return json({ ok: true }, 200, req);
      }
      default:
        return json({ ok: false, error: 'unknown action' }, 400, req);
    }
  } catch (err) {
    return json({ ok: false, error: err.message || 'server error' }, 400, req);
  }
});
