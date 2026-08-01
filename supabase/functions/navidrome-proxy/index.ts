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
// Versuche zunaechst die WebCrypto-API; falle auf eine pure-JS-
// Implementierung zurueck, da neuere Deno-Versionen MD5
// aus crypto.subtle entfernt haben ("Unrecognized algorithm name").
async function md5(str) {
  try {
    const bytes = await crypto.subtle.digest('MD5', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(bytes))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch (_) {
    return md5js(str);
  }
}

// Pure-JS MD5 (RFC 1321). Klein, schnell, keine Abhaengigkeiten.
function md5js(str) {
  function rh(n) {
    let j, s = '';
    for (j = 0; j <= 3; j++) s += ((n >> (j * 8 + 4)) & 0x0F).toString(16) + ((n >> (j * 8)) & 0x0F).toString(16);
    return s;
  }
  function ad(x, y) {
    const l = (x & 0xFFFF) + (y & 0xFFFF);
    const m = (x >> 16) + (y >> 16) + (l >> 16);
    return (m << 16) | (l & 0xFFFF);
  }
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cm(q, a, b, x, s, t) { return ad(rl(ad(ad(a, q), ad(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cm((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cm((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cm(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cm(c ^ (b | (~d)), a, b, x, s, t); }
  function cv(s) {
    s = unescape(encodeURIComponent(s));
    const n = s.length;
    const w = new Array(((n + 8) >>> 6) * 16 + 16).fill(0);
    let i;
    for (i = 0; i < n; i++) w[i >> 2] |= s.charCodeAt(i) << ((i & 3) * 8);
    w[i >> 2] |= 0x80 << ((i & 3) * 8);
    w[w.length - 2] = n * 8;
    return w;
  }
  const x = cv(str);
  let a = 0x67452301, b = -0x10325477, c = -0x67452302, d = -0x10325476;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i + 0],  7, -0x28955B88);
    d = ff(d, a, b, c, x[i + 1], 12, -0x173848AA);
    c = ff(c, d, a, b, x[i + 2], 17,  0x242070DB);
    b = ff(b, c, d, a, x[i + 3], 22, -0x3E42312F);
    a = ff(a, b, c, d, x[i + 4],  7, -0x0A83F050);
    d = ff(d, a, b, c, x[i + 5], 12,  0x4787C62A);
    c = ff(c, d, a, b, x[i + 6], 17, -0x57CFB9ED);
    b = ff(b, c, d, a, x[i + 7], 22, -0x02B96AFF);
    a = ff(a, b, c, d, x[i + 8],  7,  0x698098D8);
    d = ff(d, a, b, c, x[i + 9], 12, -0x74BB0851);
    c = ff(c, d, a, b, x[i + 10],17, -0x0000A6F2);
    b = ff(b, c, d, a, x[i + 11],22,  0x2A2F81BC);
    a = ff(a, b, c, d, x[i + 12], 7,  0xD4EF3085);
    d = ff(d, a, b, c, x[i + 13],12, -0x06756A02);
    c = ff(c, d, a, b, x[i + 14],17, -0x06B90112);
    b = ff(b, c, d, a, x[i + 15],22,  0x698098D8);

    a = gg(a, b, c, d, x[i + 1],  5, -0x40128023);
    d = gg(d, a, b, c, x[i + 6],  9,  0x0381D8C2);
    c = gg(c, d, a, b, x[i + 11],14, -0x0B8B45F9);
    b = gg(b, c, d, a, x[i + 0], 20, -0x2972F547);
    a = gg(a, b, c, d, x[i + 5],  5,  0x085670A2);
    d = gg(d, a, b, c, x[i + 10], 9, -0x09E84D02);
    c = gg(c, d, a, b, x[i + 15],14,  0x3D8FA0C3);
    b = gg(b, c, d, a, x[i + 4], 20, -0x036835D3);
    a = gg(a, b, c, d, x[i + 9],  5,  0x493C7D03);
    d = gg(d, a, b, c, x[i + 14], 9, -0x09470DF7);
    c = gg(c, d, a, b, x[i + 3], 14, -0x04405785);
    b = gg(b, c, d, a, x[i + 8], 20, -0x06921526);
    a = gg(a, b, c, d, x[i + 13], 5, -0x040E008B);
    d = gg(d, a, b, c, x[i + 2],  9,  0x0255F1A2);
    c = gg(c, d, a, b, x[i + 7], 14, -0x002A0406);
    b = gg(b, c, d, a, x[i + 12],20, -0x0080A013);

    a = hh(a, b, c, d, x[i + 5],  4, -0x039503CD);
    d = hh(d, a, b, c, x[i + 8], 11,  0x06754E01);
    c = hh(c, d, a, b, x[i + 11],16, -0x04695848);
    b = hh(b, c, d, a, x[i + 14],23,  0x07468567);
    a = hh(a, b, c, d, x[i + 1],  4, -0x03A53419);
    d = hh(d, a, b, c, x[i + 4], 11, -0x01D3E6F8);
    c = hh(c, d, a, b, x[i + 7], 16,  0x6B901122);
    b = hh(b, c, d, a, x[i + 10],23, -0x03115D86);
    a = hh(a, b, c, d, x[i + 13], 4, -0x05834010);
    d = hh(d, a, b, c, x[i + 0], 11,  0x265E5A51);
    c = hh(c, d, a, b, x[i + 3], 16, -0x080D7E34);
    b = hh(b, c, d, a, x[i + 6], 23, -0x07263766);
    a = hh(a, b, c, d, x[i + 9],  4,  0x455A14ED);
    d = hh(d, a, b, c, x[i + 12],11, -0x15702C32);
    c = hh(c, d, a, b, x[i + 15],16,  0x023BA5BB);
    b = hh(b, c, d, a, x[i + 2], 23, -0x080E16EF);

    a = ii(a, b, c, d, x[i + 0],  6,  0x02441413);
    d = ii(d, a, b, c, x[i + 7], 10, -0x03FF6EC9);
    c = ii(c, d, a, b, x[i + 14],15,  0x02441413);
    b = ii(b, c, d, a, x[i + 5], 21, -0x03FF6EC9);
    a = ii(a, b, c, d, x[i + 12], 6,  0x02441413);
    d = ii(d, a, b, c, x[i + 3], 10, -0x03FF6EC9);
    c = ii(c, d, a, b, x[i + 10],15,  0x02441413);
    b = ii(b, c, d, a, x[i + 1], 21, -0x03FF6EC9);
    a = ii(a, b, c, d, x[i + 8],  6,  0x02441413);
    d = ii(d, a, b, c, x[i + 15],10, -0x03FF6EC9);
    c = ii(c, d, a, b, x[i + 6], 15,  0x02441413);
    b = ii(b, c, d, a, x[i + 13],21, -0x03FF6EC9);
    a = ii(a, b, c, d, x[i + 4],  6,  0x02441413);
    d = ii(d, a, b, c, x[i + 11],10, -0x03FF6EC9);
    c = ii(c, d, a, b, x[i + 2], 15,  0x02441413);
    b = ii(b, c, d, a, x[i + 9], 21, -0x03FF6EC9);

    a = ad(a, oa); b = ad(b, ob); c = ad(c, oc); d = ad(d, od);
  }
  return rh(a) + rh(b) + rh(c) + rh(d);
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
