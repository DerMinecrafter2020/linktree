// =========================================================
// Supabase Edge Function: auth-login
// =========================================================
// Prüft das Admin-Passwort gegen den PBKDF2-Hash in
// public.admin_auth und gibt ein HMAC-signiertes JWT zurück,
// das 60 Minuten gültig ist.
//
// Aufruf von der App:
//   POST {SUPABASE_URL}/functions/v1/auth-login
//   Header: apikey: {ANON_KEY}
//   Body:   { "password": "..." }
//
// Antwort:
//   200 { "ok": true, "token": "eyJ...", "expiresAt": 1234567890 }
//   401 { "ok": false, "error": "invalid credentials" }
//   423 { "ok": false, "error": "locked out", "retryAfter": 30 }
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

// --- JWT (HS256) ---
function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encHeader = b64url(JSON.stringify(header));
  const encPayload = b64url(JSON.stringify(payload));
  const sig = await hmacSha256(secret, `${encHeader}.${encPayload}`);
  return `${encHeader}.${encPayload}.${b64url(sig)}`;
}

// --- Rate-Limit (In-Memory, pro Edge-Instance; für Multi-Instance
// später auf KV/Redis umstellbar) ---
const RATE_WINDOW_MS = 5 * 60 * 1000;  // 5 min
const RATE_MAX_TRIES = 5;
const RATE_LOCKOUT_MS = 60 * 1000;     // 1 min
const attempts = new Map(); // ip -> { tries: number[], lockedUntil: number }

function getClientIp(req) {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || req.headers.get('cf-connecting-ip')
    || 'unknown';
}

function consumeAttempt(ip) {
  const now = Date.now();
  let s = attempts.get(ip);
  if (!s) { s = { tries: [], lockedUntil: 0 }; attempts.set(ip, s); }
  if (s.lockedUntil > now) return { ok: false, retryAfter: Math.ceil((s.lockedUntil - now) / 1000) };
  s.tries = s.tries.filter(t => now - t < RATE_WINDOW_MS);
  s.tries.push(now);
  if (s.tries.length >= RATE_MAX_TRIES) {
    s.lockedUntil = now + RATE_LOCKOUT_MS;
  }
  return { ok: true };
}

function resetAttempts(ip) {
  attempts.delete(ip);
}

// --- Main ---
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST')   return json({ ok: false, error: 'method not allowed' }, 405, req);

  const ip = getClientIp(req);
  const gate = consumeAttempt(ip);
  if (!gate.ok) {
    return new Response(JSON.stringify({
      ok: false, error: 'locked out', retryAfter: gate.retryAfter
    }), {
      status: 423,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(gate.retryAfter),
        ...corsHeaders(req)
      }
    });
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_KEY  = Deno.env.get('SERVICE_ROLE_KEY');
  const JWT_SECRET   = Deno.env.get('JWT_SECRET');

  if (!SUPABASE_URL || !SERVICE_KEY || !JWT_SECRET) {
    return json({ ok: false, error: 'server not configured' }, 500, req);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: 'invalid json' }, 400, req); }

  const pw = String(body.password || '');
  if (!pw || pw.length < 1 || pw.length > 200) {
    return json({ ok: false, error: 'invalid credentials' }, 401, req);
  }

  // Honeypot: leerer Body = Bot
  if (typeof body.website === 'string' && body.website.length > 0) {
    // bewusst kein unterschiedlicher Fehler, damit Bots nicht lernen
    return json({ ok: false, error: 'invalid credentials' }, 401, req);
  }

  // Hash aus DB lesen
  const { data: row, error: selErr } = await admin
    .from('admin_auth')
    .select('algo, iterations, salt, password_hash')
    .eq('id', 1)
    .maybeSingle();
  if (selErr) return json({ ok: false, error: 'auth backend error' }, 500, req);
  if (!row || row.salt === 'PLACEHOLDER') {
    return json({
      ok: false,
      error: 'auth not initialized — call auth-init first'
    }, 503, req);
  }

  // PBKDF2 — konstante Iterationszahl aus DB
  let candidate;
  try {
    candidate = await pbkdf2Hex(pw, row.salt, row.iterations);
  } catch {
    return json({ ok: false, error: 'invalid credentials' }, 401, req);
  }

  // Konstante Wartezeit (gegen Timing-Angriffe)
  const t0 = performance.now();
  const ok = timingSafeEqual(candidate, row.password_hash);
  const elapsed = performance.now() - t0;
  if (elapsed < 250) {
    await new Promise(r => setTimeout(r, 250 - Math.floor(elapsed)));
  }

  if (!ok) {
    return json({ ok: false, error: 'invalid credentials' }, 401, req);
  }

  // Erfolg: Rate-Limit zurücksetzen + JWT signieren
  resetAttempts(ip);

  const now = Math.floor(Date.now() / 1000);
  const ttl = 60 * 60; // 1 h
  const payload = {
    sub: 'admin',
    role: 'admin',
    iat: now,
    exp: now + ttl,
    // jti: einmaliger Identifier für Token-Replay-Tracking
    jti: crypto.randomUUID()
  };

  const token = await signJwt(payload, JWT_SECRET);
  return json({
    ok: true,
    token,
    expiresAt: payload.exp * 1000,
    ttl
  }, 200, req);
});
