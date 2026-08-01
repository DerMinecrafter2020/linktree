// =========================================================
// Supabase Edge Function: admin-proxy
// =========================================================
// Diese Funktion kapselt ALLE Schreiboperationen hinter einem
// gültigen Admin-JWT (HS256, signiert von auth-login).
//
// Deployment:
//   1. supabase functions deploy admin-proxy
//   2. supabase functions deploy auth-login
//   3. supabase functions deploy auth-change-password
//   4. supabase secrets set SERVICE_ROLE_KEY=...
//   5. supabase secrets set JWT_SECRET=...   (mind. 32 Zeichen random!)
//
// Aufruf von der App:
//   POST {SUPABASE_URL}/functions/v1/admin-proxy
//   Header: Authorization: Bearer <JWT>
//   Body:   { "action": "saveProfile", "data": {...} }
//
// Antwort:
//   200 { "ok": true,  "data": {...} }
//   401 { "ok": false, "error": "unauthorized" }
//   400 { "ok": false, "error": "<validation>" }
// =========================================================
//
// HINWEIS: Wenn du die Edge Functions NICHT deployst, schreibe
// direkt mit dem anon-Key und entferne den JWT-Check.
// =========================================================
//
// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

function corsFor(req) {
  const origin = req.headers.get('origin') || '';
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    return { ...CORS, 'Access-Control-Allow-Origin': origin || '*' };
  }
  return { ...CORS, 'Access-Control-Allow-Origin': 'null' };
}

function json(data, status, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsFor(req) }
  });
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacVerify(secret, data, signature) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ signature[i];
  return diff === 0;
}

async function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const sigBytes = b64urlDecode(s);
  const ok = await hmacVerify(secret, `${h}.${p}`, sigBytes);
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p))); }
  catch { return null; }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.role !== 'admin') return null;
  return payload;
}

function isHttpUrl(u) {
  try {
    const url = new URL(u);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol);
  } catch { return false; }
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

async function authenticate(req) {
  const secret = Deno.env.get('JWT_SECRET');
  if (!secret) throw new Error('server not configured');
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error('unauthorized');
  const claims = await verifyJwt(m[1], secret);
  if (!claims) throw new Error('unauthorized');
  return claims;
}

// --- Rate-Limit (pro JWT sub, in-Memory; pro Edge-Instance) ---
const WRITE_WINDOW_MS = 60 * 1000;
const WRITE_MAX = 60; // max 60 Mutationen pro Minute
const writeAttempts = new Map(); // sub -> [timestamps]

function checkWriteRate(sub) {
  const now = Date.now();
  const arr = (writeAttempts.get(sub) || []).filter(t => now - t < WRITE_WINDOW_MS);
  if (arr.length >= WRITE_MAX) {
    const oldest = arr[0];
    const retryAfter = Math.ceil((WRITE_WINDOW_MS - (now - oldest)) / 1000);
    return { ok: false, retryAfter };
  }
  arr.push(now);
  writeAttempts.set(sub, arr);
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
  'saveProfile', 'createLink', 'updateLink', 'deleteLink', 'reorderLinks'
]);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) });
  if (req.method !== 'POST')   return json({ ok: false, error: 'method not allowed' }, 405, req);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY  = Deno.env.get('SERVICE_ROLE_KEY')!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let claims;
  try { claims = await authenticate(req); }
  catch { return json({ ok: false, error: 'unauthorized' }, 401, req); }

  // Rate-Limit: pro JWT-Subject
  const gate = checkWriteRate(claims.sub || 'anon');
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

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: 'invalid json' }, 400, req); }

  // Action-Whitelist
  if (!ALLOWED_ACTIONS.has(body.action)) {
    return json({ ok: false, error: 'unknown action' }, 400, req);
  }

  try {
    switch (body.action) {
      case 'saveProfile': {
        const profile = validateProfile(body.data);
        const { error } = await admin.from('profile').upsert({ id: 1, ...profile });
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
