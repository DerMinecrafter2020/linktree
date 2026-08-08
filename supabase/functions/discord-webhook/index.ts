// =========================================================
// Supabase Edge Function: discord-webhook
// =========================================================
// Empfängt Now-Playing-Informationen vom Client und postet sie
// an einen in admin_settings hinterlegten Discord-Webhook.
//
// Deployment:
//   supabase functions deploy discord-webhook
//   supabase secrets set SERVICE_ROLE_KEY=...
//   supabase secrets set SUPABASE_URL=...
//
// Aufruf:
//   POST {SUPABASE_URL}/functions/v1/discord-webhook
//   Header: Authorization: Bearer <JWT>   (nur wenn authEnabled)
//   Body:   { "track": { "title", "artist", "album", "cover", "url" } }
//
// Sicherheit:
//   • Webhook-URL liegt in admin_settings und ist via RLS
//     für anon/authenticated komplett gesperrt.
//   • Diese Edge Function liest mit SERVICE_ROLE_KEY.
//   • Der Client sieht die Webhook-URL nie.
// =========================================================
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

function isDiscordWebhookUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' &&
      /^(discord\.com|discordapp\.com)$/.test(url.hostname) &&
      url.pathname.startsWith('/api/webhooks/');
  } catch { return false; }
}

function applyTemplate(template, track) {
  const map = {
    '{title}': track.title || 'Unbekannter Titel',
    '{artist}': track.artist || 'Unbekannter Künstler',
    '{album}': track.album || '',
    '{cover}': track.cover || '',
    '{url}': track.url || '',
  };
  let out = template;
  for (const [key, val] of Object.entries(map)) {
    out = out.split(key).join(val);
  }
  return out;
}

function safeJsonParse(text) {
  if (text.length > 50_000) throw new Error('payload too large');
  return JSON.parse(text);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405, req);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY  = Deno.env.get('SERVICE_ROLE_KEY')!;
  const JWT_SECRET   = Deno.env.get('JWT_SECRET') || '';

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ ok: false, error: 'server not configured' }, 500, req);
  }

  // Optional: JWT-Auth nur wenn im Projekt aktiviert
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (JWT_SECRET && m) {
    const claims = await verifyJwt(m[1], JWT_SECRET);
    if (!claims) return json({ ok: false, error: 'unauthorized' }, 401, req);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: 'invalid json' }, 400, req); }

  const track = body.track || {};
  if (!track.title && !track.artist) {
    return json({ ok: false, error: 'track info required' }, 400, req);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: settings, error } = await admin
    .from('admin_settings')
    .select('discord_webhook_url, discord_webhook_enabled, discord_webhook_template')
    .eq('id', 1)
    .maybeSingle();

  if (error) return json({ ok: false, error: error.message }, 500, req);
  if (!settings || !settings.discord_webhook_enabled || !settings.discord_webhook_url) {
    return json({ ok: true, sent: false, reason: 'webhook disabled or not configured' }, 200, req);
  }

  if (!isDiscordWebhookUrl(settings.discord_webhook_url)) {
    return json({ ok: false, error: 'invalid webhook url' }, 400, req);
  }

  let payload;
  try {
    const tpl = settings.discord_webhook_template || '{}';
    const rendered = applyTemplate(tpl, track);
    payload = safeJsonParse(rendered);
  } catch (err) {
    return json({ ok: false, error: 'invalid webhook template: ' + err.message }, 400, req);
  }

  try {
    const res = await fetch(settings.discord_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown');
      return json({ ok: false, error: `discord returned ${res.status}: ${text}` }, 502, req);
    }
    return json({ ok: true, sent: true }, 200, req);
  } catch (err) {
    return json({ ok: false, error: err.message || 'webhook request failed' }, 502, req);
  }
});
