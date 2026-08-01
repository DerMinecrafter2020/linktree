// =========================================================
// Supabase Edge Function: navidrome-proxy
// =========================================================
// Diese Funktion ist ein sicherer Proxy zwischen Browser und
// Navidrome/Subsonic-API. Sie schützt die Credentials vor
// direkter CORS-Exposure im Browser.
//
// Konfiguration via Secrets:
//   supabase secrets set NAVIDROME_URL=https://navidrome.example.com
//   supabase secrets set NAVIDROME_USER=alice
//   supabase secrets set NAVIDROME_PASS=geheim123
//
// Aufruf von der App:
//   POST {SUPABASE_URL}/functions/v1/navidrome-proxy
//   Header: apikey: <anon-key>
//   Body:   { "action": "nowPlaying" }
//           { "action": "coverArt", id: "..." }   (gibt Base64-DataURL zurück)
//           { "action": "control", action: "play|pause|next|previous" }
//
// Antwort (action=nowPlaying):
//   200 {
//     ok: true,
//     data: {
//       playing: true|false,
//       title: "...",
//       artist: "...",
//       album: "...",
//       coverUrl: "data:image/...",   // Base64-DataURL, ggf. leer
//       duration: 240,
//       position: 80,
//       player: "Web Player"
//     }
//   }
//
// Subsonic-API:
//   https://www.subsonic.org/pages/api.jsp
// =========================================================
//
// @ts-nocheck
const NAVIDROME_URL  = Deno.env.get('NAVIDROME_URL')  || '';
const NAVIDROME_USER = Deno.env.get('NAVIDROME_USER') || '';
const NAVIDROME_PASS = Deno.env.get('NAVIDROME_PASS') || '';
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

const SUB_VERSION   = '1.16.1';
const CLIENT_NAME   = 'openweb-linktree';

const CORS_BASE = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function corsFor(req) {
  const origin = req.headers.get('origin') || '';
  const allowed = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin);
  return {
    ...CORS_BASE,
    'Access-Control-Allow-Origin': allowed ? (origin || '*') : 'null',
  };
}

function json(data, status, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsFor(req) },
  });
}

// Hilfsfunktion: MD5-Token für Subsonic-Auth
async function md5(str) {
  const bytes = await crypto.subtle.digest('MD5', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Subsonic-Query-String (token-Version mit md5(pass+salt))
async function subsonicParams(extra = {}) {
  const salt = crypto.randomUUID().replace(/-/g, '');
  const token = await md5(NAVIDROME_PASS + salt);
  return new URLSearchParams({
    u: NAVIDROME_USER,
    t: token,
    s: salt,
    v: SUB_VERSION,
    c: CLIENT_NAME,
    f: 'json',
    ...extra,
  });
}

// Generischer Fetch-Wrapper für Navidrome
async function navFetch(path, params) {
  if (!NAVIDROME_URL || !NAVIDROME_USER || !NAVIDROME_PASS) {
    throw new Error('Navidrome nicht konfiguriert (Secrets NAVIDROME_URL/USER/PASS fehlen)');
  }
  const url = `${NAVIDROME_URL.replace(/\/$/, '')}/rest/${path}?${params.toString()}`;
  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) throw new Error(`Navidrome ${path} HTTP ${r.status}`);
  return r.json();
}

// =========================================================
// ACTIONS
// =========================================================

// 1) nowPlaying — verbundene Player abfragen
async function getNowPlaying() {
  try {
    const params = await subsonicParams();
    const json = await navFetch('getNowPlaying', params);
    const entry = json?.subsonic‑response?.nowPlaying?.entry?.[0];
    if (!entry) {
      return { playing: false };
    }
    const coverUrl = entry.coverArt
      ? await getCoverArt(entry.coverArt, 220)
      : '';
    return {
      playing: true,
      title:       entry.title       || '',
      artist:      entry.artist      || '',
      album:       entry.album       || '',
      duration:    parseInt(entry.duration || '0', 10),
      position:    parseInt(entry.player?.position || entry.minutesAgo || '0', 10),
      coverUrl,
      player:      entry.player?.name || '',
      minutesAgo:  parseInt(entry.minutesAgo || '0', 10),
    };
  } catch (err) {
    // Fallback: versuche alternativ "getRandomSongs" oder gib klare Antwort
    console.error('nowPlaying failed:', err.message);
    return { playing: false, error: err.message };
  }
}

// 2) coverArt — Cover als DataURL
async function getCoverArt(id, size = 220) {
  if (!id) return '';
  try {
    const params = await subsonicParams({ id, size });
    const url = `${NAVIDROME_URL.replace(/\/$/, '')}/rest/getCoverArt?${params.toString()}`;
    const r = await fetch(url);
    if (!r.ok) return '';
    const ct = r.headers.get('content-type') || 'image/jpeg';
    const buf = await r.arrayBuffer();
    // Größenlimit: max 600KB raw → ~800KB base64
    if (buf.byteLength > 600_000) return '';
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return `data:${ct};base64,${b64}`;
  } catch (e) {
    console.error('coverArt failed:', e.message);
    return '';
  }
}

// 3) control — Wiedergabe steuern
async function controlPlayer(action) {
  const map = {
    play:     'play',
    pause:    'pause',
    next:     'next',
    previous: 'previous',
  };
  const mapped = map[action];
  if (!mapped) throw new Error(`unsupported action: ${action}`);
  const params = await subsonicParams({ action: mapped });
  const json = await navFetch('control', params);
  if (json?.subsonic‑response?.status === 'ok') return true;
  if (json?.subsonic‑response?.error) {
    throw new Error(json.subsonic‑response.error.message || 'control failed');
  }
  return true;
}

// =========================================================
// ROUTER
// =========================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsFor(req) });
  }
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method not allowed' }, 405, req);
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON body' }, 400, req);
  }

  const { action } = body;
  try {
    let data;
    switch (action) {
      case 'nowPlaying':
        data = await getNowPlaying();
        break;
      case 'coverArt':
        data = { coverUrl: await getCoverArt(body.id, body.size || 220) };
        break;
      case 'control':
        data = await controlPlayer(body.controlAction);
        break;
      default:
        return json({ ok: false, error: `unknown action: ${action}` }, 400, req);
    }
    return json({ ok: true, data }, 200, req);
  } catch (err) {
    console.error(`action=${action} failed:`, err.message);
    return json({ ok: false, error: err.message }, 500, req);
  }
});
