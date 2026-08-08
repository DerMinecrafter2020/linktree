// =========================================================
// Supabase Edge Function: discord-settings
// =========================================================
// Eigene, eingeschränkte Edge Function fuer Discord-Webhook-
// Einstellungen im Admin-Panel. Sie verwendet ein separates
// DISCORD_ADMIN_SECRET (schwaecherer Schutz als admin-proxy),
// das nur in der geschuetzten admin-config.js hinterlegt ist.
//
// Deployment:
//   supabase functions deploy discord-settings
//   supabase secrets set SERVICE_ROLE_KEY=...
//   supabase secrets set SUPABASE_URL=...
//   supabase secrets set DISCORD_ADMIN_SECRET=...
//
// Aufruf:
//   POST {SUPABASE_URL}/functions/v1/discord-settings
//   Header: apikey: <anon-key>, Authorization: Bearer <anon-key>
//   Body:   { "action": "get" | "save", "secret": "<DISCORD_ADMIN_SECRET>", "data": {...} }
//
// Sicherheit:
//   • Liest/Schreibt nur admin_settings (ID 1).
//   • Service-Role-Key bleibt serverseitig.
//   • Keine Verwendung fuer Profile, Links oder andere Daten.
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

const DISCORD_ADMIN_SECRET = Deno.env.get('DISCORD_ADMIN_SECRET') || '';

function isDiscordWebhookUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' &&
      /^(discord\.com|discordapp\.com)$/.test(url.hostname) &&
      url.pathname.startsWith('/api/webhooks/');
  } catch { return false; }
}

function validateSettings(s) {
  if (!s || typeof s !== 'object') throw new Error('invalid settings');
  const out = {};
  if (typeof s.discord_webhook_enabled === 'boolean') out.discord_webhook_enabled = s.discord_webhook_enabled;
  if (typeof s.discord_webhook_url === 'string') {
    const u = s.discord_webhook_url.trim();
    if (u && !isDiscordWebhookUrl(u)) throw new Error('invalid discord webhook url');
    out.discord_webhook_url = u || null;
  }
  if (typeof s.discord_webhook_template === 'string') {
    const t = s.discord_webhook_template.trim();
    if (t) {
      try { JSON.parse(t); } catch { throw new Error('invalid discord webhook template (must be valid JSON)'); }
      out.discord_webhook_template = t;
    }
  }
  return out;
}

async function authenticate(body) {
  if (!DISCORD_ADMIN_SECRET) throw new Error('server not configured');
  if (!body || typeof body !== 'object') throw new Error('unauthorized');
  const provided = String(body.secret || '');
  if (provided !== DISCORD_ADMIN_SECRET) throw new Error('unauthorized');
  return { sub: 'admin-discord' };
}

const MAX_BODY_BYTES = 50_000;

function safeJsonParse(text) {
  if (text.length > MAX_BODY_BYTES) throw new Error('payload too large');
  return JSON.parse(text);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405, req);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY  = Deno.env.get('SERVICE_ROLE_KEY')!;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ ok: false, error: 'server not configured' }, 500, req);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: 'invalid json' }, 400, req); }

  try { await authenticate(body); }
  catch { return json({ ok: false, error: 'unauthorized' }, 401, req); }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const action = body.action;

  try {
    switch (action) {
      case 'get': {
        const { data, error } = await admin
          .from('admin_settings')
          .select('discord_webhook_url,discord_webhook_enabled,discord_webhook_template')
          .eq('id', 1)
          .maybeSingle();
        if (error) throw error;
        return json({ ok: true, data: data || {} }, 200, req);
      }
      case 'save': {
        const settings = validateSettings(body.data || {});
        const { error } = await admin
          .from('admin_settings')
          .upsert({ id: 1, ...settings }, { onConflict: 'id' });
        if (error) throw error;
        return json({ ok: true }, 200, req);
      }
      default:
        return json({ ok: false, error: 'unknown action' }, 400, req);
    }
  } catch (err) {
    console.error('discord-settings failed:', err && err.message);
    return json({ ok: false, error: err && err.message }, 500, req);
  }
});
