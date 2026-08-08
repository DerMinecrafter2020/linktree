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
//   Header: apikey: <anon-key>, Authorization: Bearer <anon-key>
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

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ ok: false, error: 'server not configured' }, 500, req);
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
