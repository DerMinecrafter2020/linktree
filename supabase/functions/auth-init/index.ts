// =========================================================
// Supabase Edge Function: auth-init
// =========================================================
// Legt beim ERSTEN Aufruf das Default-Passwort "admin123"
// als PBKDF2-SHA256-Hash in der Tabelle admin_auth ab.
//
// Idempotent: Nach erfolgreichem Init gibt die Funktion 409
// zurück, damit niemand den existierenden Hash überschreiben
// kann (Reset-Pfad läuft über auth-reset).
//
// Aufruf:
//   POST {SUPABASE_URL}/functions/v1/auth-init
//   Header: Authorization: Bearer {SERVICE_ROLE_KEY}
//           apikey: {SERVICE_ROLE_KEY}
//   Body:   { "default_password": "admin123" }
//
// =========================================================
// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// auth-init ist ein Server-zu-Server-Endpoint (kein Browser).
// Wir geben bewusst KEIN Access-Control-Allow-Origin: * zurück,
// damit kein Browser via fetch() auf die Funktion zugreifen kann.
// Nur curl/CLI funktioniert, und das ist OK.
const CORS = {
  'Access-Control-Allow-Origin': 'null',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function corsHeaders(origin) {
  // Kein Browser-Origin darf die Funktion aufrufen
  return { ...CORS, 'Access-Control-Allow-Origin': 'null' };
}

function json(data, status, origin = 'null') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
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
  const origin = req.headers.get('origin') || '*';
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST')   return json({ ok: false, error: 'method not allowed' }, 405, origin);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_KEY  = Deno.env.get('SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ ok: false, error: 'server not configured' }, 500, origin);
  }

  // Auth-Check: nur mit Service-Role-Key aufrufbar.
  // Strikt: exakter Vergleich + Mindestlänge, sonst
  // akzeptiert z. B. ein leerer Bearer-Token alles.
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return json({ ok: false, error: 'unauthorized' }, 401, origin);
  if (SERVICE_KEY.length < 32) {
    return json({ ok: false, error: 'SERVICE_ROLE_KEY must be at least 32 chars' }, 500, origin);
  }
  // constant-time compare
  const a = m[1];
  const b = SERVICE_KEY;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  if (diff !== 0 || a.length !== b.length) {
    return json({ ok: false, error: 'unauthorized' }, 401, origin);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: 'invalid json' }, 400, origin); }

  const defaultPw = String(body.default_password || '');
  if (defaultPw.length < 4 || defaultPw.length > 200) {
    return json({ ok: false, error: 'default_password length 4..200' }, 400, origin);
  }

  // Existierender Hash?
  const { data: existing, error: selErr } = await admin
    .from('admin_auth').select('id, salt, password_hash').eq('id', 1).maybeSingle();
  if (selErr) return json({ ok: false, error: selErr.message }, 500, origin);

  if (existing && existing.salt !== 'PLACEHOLDER' && existing.password_hash !== 'PLACEHOLDER') {
    return json({ ok: false, error: 'already initialized', id: 1 }, 409, origin);
  }

  // Hash erzeugen
  const salt = randomSaltB64();
  const iterations = 210000;
  const hash = await pbkdf2Hex(defaultPw, salt, iterations);

  const { error: upErr } = await admin.from('admin_auth').upsert({
    id: 1,
    algo: 'PBKDF2-SHA256',
    iterations,
    salt,
    password_hash: hash,
    updated_at: new Date().toISOString()
  });
  if (upErr) return json({ ok: false, error: upErr.message }, 500, origin);

  return json({ ok: true, algo: 'PBKDF2-SHA256', iterations, salt_len: salt.length, hash_len: hash.length }, 200, origin);
});
