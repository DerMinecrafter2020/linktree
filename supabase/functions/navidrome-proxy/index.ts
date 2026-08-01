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
//   supabase secrets set ALLOWED_ORIGINS=https://deine-domain.de
//
// Aufruf von der App:
//   POST {SUPABASE_URL}/functions/v1/navidrome-proxy
//   Header: apikey: <anon-key>
//   Body:   { "action": "nowPlaying" }
//           { "action": "coverArt", "id": "..." }
//           { "action": "control", "controlAction": "play|pause|next|previous" }
//
// Subsonic-API: https://www.subsonic.org/pages/api.jsp
// =========================================================

// @ts-nocheck
const NAVIDROME_URL    = Deno.env.get('NAVIDROME_URL')    || '';
const NAVIDROME_USER   = Deno.env.get('NAVIDROME_USER')   || '';
const NAVIDROME_PASS   = Deno.env.get('NAVIDROME_PASS')   || '';
const ALLOWED_ORIGINS  = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim()).filter(Boolean);

const SUB_VERSION = '1.16.1';
const CLIENT_NAME = 'openweb-linktree';

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
    'Vary': 'Origin',
  };
}

function json(data, status, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsFor(req) },
  });
}

// MD5 (Subsonic token = md5(password + salt))
async function md5(str) {
  const bytes = await crypto.subtle.digest('MD5', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function subsonicParams(extra) {
  const extraObj = extra || {};
  const salt = randomSalt();
  const token = await md5(NAVIDROME_PASS + salt);
  const params = new URLSearchParams({
    u: NAVIDROME_USER,
    t: token,
    s: salt,
    v: SUB_VERSION,
    c: CLIENT_NAME,
    f: 'json',
  });
  for (const key of Object.keys(extraObj)) {
    if (extraObj[key] !== undefined && extraObj[key] !== null) {
      params.set(key, String(extraObj[key]));
    }
  }
  return params;
}

// ArrayBuffer -> base64 (chunked, vermeidet "Maximum call stack" bei grossen Bildern)
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function navFetch(path, params) {
  if (!NAVIDROME_URL || !NAVIDROME_USER || !NAVIDROME_PASS) {
    throw new Error('Navidrome nicht konfiguriert (Secrets NAVIDROME_URL/USER/PASS fehlen)');
  }
  const base = NAVIDROME_URL.replace(/\/+$/, '');
  const url  = base + '/rest/' + path + '?' + params.toString();
  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) throw new Error('Navidrome ' + path + ' HTTP ' + r.status);
  return r.json();
}

// ACTION: nowPlaying
async function getNowPlaying() {
  try {
    const params = await subsonicParams();
    const data   = await navFetch('getNowPlaying', params);

    const resp  = data && data['subsonic-response'];
    const entry = resp && resp.nowPlaying && resp.nowPlaying.entry && resp.nowPlaying.entry[0];

    if (!entry) return { playing: false };

    const coverUrl = entry.coverArt ? await getCoverArt(entry.coverArt, 220) : '';
    const player   = entry.player || {};
    const minutesAgoNum = Number(entry.minutesAgo || 0) || 0;
    const durationNum   = Number(entry.duration   || 0) || 0;
    const positionNum   = Number(player.position  || minutesAgoNum) || 0;

    return {
      playing:    true,
      title:      String(entry.title  || ''),
      artist:     String(entry.artist || ''),
      album:      String(entry.album  || ''),
      duration:   durationNum,
      position:   positionNum,
      coverUrl:   coverUrl,
      player:     String(player.name  || ''),
      minutesAgo: minutesAgoNum,
    };
  } catch (err) {
    console.error('nowPlaying failed:', err && err.message);
    return { playing: false, error: err && err.message };
  }
}

// ACTION: coverArt
async function getCoverArt(id, size) {
  if (!id) return '';
  const sizeNum = Number(size) || 220;
  try {
    const params = await subsonicParams({ id: id, size: sizeNum });
    const base   = NAVIDROME_URL.replace(/\/+$/, '');
    const url    = base + '/rest/getCoverArt?' + params.toString();
    const r      = await fetch(url);
    if (!r.ok) return '';
    const ct = r.headers.get('content-type') || 'image/jpeg';
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(ct)) return '';
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 600000) return '';
    return 'data:' + ct + ';base64,' + arrayBufferToBase64(buf);
  } catch (e) {
    console.error('coverArt failed:', e && e.message);
    return '';
  }
}

// ACTION: control
async function controlPlayer(action) {
  const map = { play: 'play', pause: 'pause', next: 'next', previous: 'previous' };
  const mapped = map[action];
  if (!mapped) throw new Error('unsupported action: ' + action);
  const params = await subsonicParams({ action: mapped });
  const data   = await navFetch('control', params);
  const resp   = data && data['subsonic-response'];
  if (resp && resp.error) {
    throw new Error(resp.error.message || 'control failed');
  }
  return true;
}

// ROUTER
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsFor(req) });
  }
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method not allowed' }, 405, req);
  }

  let body = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch (_) {
    return json({ ok: false, error: 'invalid JSON body' }, 400, req);
  }

  const action = body.action;
  try {
    let data;
    switch (action) {
      case 'nowPlaying':
        data = await getNowPlaying();
        break;
      case 'coverArt':
        data = { coverUrl: await getCoverArt(body.id, body.size) };
        break;
      case 'control':
        data = await controlPlayer(body.controlAction);
        break;
      default:
        return json({ ok: false, error: 'unknown action: ' + action }, 400, req);
    }
    return json({ ok: true, data: data }, 200, req);
  } catch (err) {
    console.error('action=' + action + ' failed:', err && err.message);
    return json({ ok: false, error: err && err.message }, 500, req);
  }
});
