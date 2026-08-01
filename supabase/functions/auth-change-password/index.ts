// =========================================================
// Supabase Edge Function: auth-change-password
// =========================================================
// Ändert das Admin-Passwort. Voraussetzung:
//   - gültiges JWT (role=admin) im Authorization-Header
//   - "old_password" muss mit dem aktuellen DB-Hash übereinstimmen
//   - "new_password" muss mind. 8 Zeichen lang sein
//
// Aufruf:
//   POST {SUPABASE_URL}/functions/v1/auth-change-password
//   Header: Authorization: Bearer <JWT>
//   Body:   { "old_password": "...", "new_password": "..." }
//
// =========================================================
// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

function corsHeaders(req) {
  const origin = req.headers.get('origin') || '';
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    return { ...CORS, 'Access-Control-Allow-Origin': origin || '*' };
  }
  return { ...CORS, 'Access-Control-Allow-Origin': 'null' };
}

function json(data, status, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) }
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

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function pbkdf2Hex(password, saltB64, iterations) {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    32 * 8
  );
  return Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomSaltB64(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST')   return json({ ok: false, error: 'method not allowed' }, 405, req);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_KEY  = Deno.env.get('SERVICE_ROLE_KEY');
  const JWT_SECRET   = Deno.env.get('JWT_SECRET');
  if (!SUPABASE_URL || !SERVICE_KEY || !JWT_SECRET) {
    return json({ ok: false, error: 'server not configured' }, 500, req);
  }

  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return json({ ok: false, error: 'unauthorized' }, 401, req);
  const claims = await verifyJwt(m[1], JWT_SECRET);
  if (!claims) return json({ ok: false, error: 'unauthorized' }, 401, req);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: 'invalid json' }, 400, req); }

  const oldPw = String(body.old_password || '');
  const newPw = String(body.new_password || '');

  if (!oldPw || !newPw) {
    return json({ ok: false, error: 'old_password and new_password required' }, 400, req);
  }
  // Längenlimits: PBKDF2 mit 210k Iter. ist teuer — kein DoS durch riesige Inputs
  if (oldPw.length > 200 || oldPw.length < 1) {
    return json({ ok: false, error: 'old_password length invalid (1..200)' }, 400, req);
  }
  if (newPw.length < 8 || newPw.length > 200) {
    return json({ ok: false, error: 'new_password must be 8..200 chars' }, 400, req);
  }
  if (oldPw === newPw) {
    return json({ ok: false, error: 'new password must differ from old' }, 400, req);
  }

  // Aktuellen Hash laden
  const { data: row, error: selErr } = await admin
    .from('admin_auth')
    .select('iterations, salt, password_hash')
    .eq('id', 1)
    .single();
  if (selErr || !row) return json({ ok: false, error: 'auth backend error' }, 500, req);

  // Altes Passwort prüfen
  const oldCandidate = await pbkdf2Hex(oldPw, row.salt, row.iterations);
  if (!timingSafeEqual(oldCandidate, row.password_hash)) {
    return json({ ok: false, error: 'old password incorrect' }, 401, req);
  }

  // Neuen Hash erzeugen
  const newSalt = randomSaltB64();
  const newIterations = row.iterations; // gleiches Niveau
  const newHash = await pbkdf2Hex(newPw, newSalt, newIterations);

  const { error: upErr } = await admin.from('admin_auth').upsert({
    id: 1,
    algo: 'PBKDF2-SHA256',
    iterations: newIterations,
    salt: newSalt,
    password_hash: newHash,
    updated_at: new Date().toISOString()
  });
  if (upErr) return json({ ok: false, error: upErr.message }, 500, req);

  return json({
    ok: true,
    algo: 'PBKDF2-SHA256',
    iterations: newIterations
  }, 200, req);
});
