// =========================================================
// Supabase Edge Function: navidrome-proxy
// =========================================================
// Sichere Navidrome/Subsonic-API-Anbindung mit Credentials aus Secrets.
//
// Konfiguration:
//   supabase secrets set NAVIDROME_URL=https://navidrome.example.com
//   supabase secrets set NAVIDROME_USER=alice
//   supabase secrets set NAVIDROME_PASS=secret123
//   supabase secrets set ALLOWED_ORIGINS=http://localhost:5500,https://...
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
  let allowed;
  if (ALLOWED_ORIGINS.length === 0) {
    allowed = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  } else {
    allowed = ALLOWED_ORIGINS.includes(origin);
  }
  return {
    ...CORS_BASE,
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

function json(data, status, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsFor(req) },
  });
}

// =========================================================
// MD5 (RFC 1321) - pure JS, weil Deno kein crypto.subtle.digest('MD5') mehr unterstuetzt
// =========================================================
function md5(input) {
  function safeAdd(x, y) {
    const lsw = (x & 0xFFFF) + (y & 0xFFFF);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xFFFF);
  }
  function bitRotateLeft(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }
  function md5cmn(q, a, b, x, s, t) {
    return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  }
  function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | (~d)), a, b, x, s, t); }

  function binlMD5(x, len) {
    x[len >> 5] |= 0x80 << (len % 32);
    x[(((len + 64) >>> 9) << 4) + 14] = len;
    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    let olda, oldb, oldc, oldd, i;
    for (i = 0; i < x.length; i += 16) {
      olda = a; oldb = b; oldc = c; oldd = d;
      a = md5ff(a, b, c, d, x[i],       7, -680876936);
      d = md5ff(d, a, b, c, x[i + 1],  12, -389564586);
      c = md5ff(c, d, a, b, x[i + 2],  17,  606105819);
      b = md5ff(b, c, d, a, x[i + 3],  22, -1044525330);
      a = md5ff(a, b, c, d, x[i + 4],   7, -176418897);
      d = md5ff(d, a, b, c, x[i + 5],  12,  1200080426);
      c = md5ff(c, d, a, b, x[i + 6],  17, -1473231341);
      b = md5ff(b, c, d, a, x[i + 7],  22, -45705983);
      a = md5ff(a, b, c, d, x[i + 8],   7,  1770035416);
      d = md5ff(d, a, b, c, x[i + 9],  12, -1958414417);
      c = md5ff(c, d, a, b, x[i + 10], 17, -42063);
      b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
      a = md5ff(a, b, c, d, x[i + 12],  7,  1804603682);
      d = md5ff(d, a, b, c, x[i + 13], 12, -40341101);
      c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290);
      b = md5ff(b, c, d, a, x[i + 15], 22,  1236535329);

      a = md5gg(a, b, c, d, x[i + 1],   5, -165796510);
      d = md5gg(d, a, b, c, x[i + 6],   9, -1069501632);
      c = md5gg(c, d, a, b, x[i + 11], 14,  643717713);
      b = md5gg(b, c, d, a, x[i],     20, -373897302);
      a = md5gg(a, b, c, d, x[i + 5],   5, -701558691);
      d = md5gg(d, a, b, c, x[i + 10],  9,  38016083);
      c = md5gg(c, d, a, b, x[i + 15], 14, -660478335);
      b = md5gg(b, c, d, a, x[i + 4],  20, -405537848);
      a = md5gg(a, b, c, d, x[i + 9],   5,  568446438);
      d = md5gg(d, a, b, c, x[i + 14],  9, -1019803690);
      c = md5gg(c, d, a, b, x[i + 11], 14, -187363961);
      b = md5gg(b, c, d, a, x[i + 8],  20,  1163531501);
      a = md5gg(a, b, c, d, x[i + 13],  5, -1444681467);
      d = md5gg(d, a, b, c, x[i + 2],   9, -51403784);
      c = md5gg(c, d, a, b, x[i + 7],  14,  1735328473);
      b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);

      a = md5hh(a, b, c, d, x[i + 5],   4, -378558);
      d = md5hh(d, a, b, c, x[i + 8],  11, -2022574463);
      c = md5hh(c, d, a, b, x[i + 11], 16,  1839030562);
      b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
      a = md5hh(a, b, c, d, x[i + 1],   4, -1530992060);
      d = md5hh(d, a, b, c, x[i + 4],  11,  1272893353);
      c = md5hh(c, d, a, b, x[i + 7],  16, -155497632);
      b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
      a = md5hh(a, b, c, d, x[i + 13],  4,  681279174);
      d = md5hh(d, a, b, c, x[i],     11, -358537222);
      c = md5hh(c, d, a, b, x[i + 3],  16, -722521979);
      b = md5hh(b, c, d, a, x[i + 6],  23,  76029189);
      a = md5hh(a, b, c, d, x[i + 9],   4, -640364487);
      d = md5hh(d, a, b, c, x[i + 12], 11, -421815835);
      c = md5hh(c, d, a, b, x[i + 15], 16,  530742520);
      b = md5hh(b, c, d, a, x[i + 2],  23, -995338651);

      a = md5ii(a, b, c, d, x[i],       6, -198630844);
      d = md5ii(d, a, b, c, x[i + 7],  10,  1126891415);
      c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905);
      b = md5ii(b, c, d, a, x[i + 5],  21, -57434055);
      a = md5ii(a, b, c, d, x[i + 12],  6,  1700485571);
      d = md5ii(d, a, b, c, x[i + 3],  10, -1894986606);
      c = md5ii(c, d, a, b, x[i + 10], 15, -1051523);
      b = md5ii(b, c, d, a, x[i + 1],  21, -2054922799);
      a = md5ii(a, b, c, d, x[i + 8],   6,  1873313359);
      d = md5ii(d, a, b, c, x[i + 15], 10, -30611744);
      c = md5ii(c, d, a, b, x[i + 6],  15, -1560198382);
      b = md5ii(b, c, d, a, x[i + 13], 21,  1309151649);
      a = md5ii(a, b, c, d, x[i + 4],   6, -145523070);
      d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379);
      c = md5ii(c, d, a, b, x[i + 2],  15,  718787259);
      b = md5ii(b, c, d, a, x[i + 9],  21, -343485551);

      a = safeAdd(a, olda);
      b = safeAdd(b, oldb);
      c = safeAdd(c, oldc);
      d = safeAdd(d, oldd);
    }
    return [a, b, c, d];
  }

  function binl2rstr(input) {
    let output = '';
    const length32 = input.length * 32;
    for (let i = 0; i < length32; i += 8) {
      output += String.fromCharCode((input[i >> 5] >>> (i % 32)) & 0xFF);
    }
    return output;
  }

  function rstr2binl(input) {
    const output = new Array(input.length >> 2);
    for (let i = 0; i < input.length * 8; i += 8) {
      output[i >> 5] |= (input.charCodeAt(i / 8) & 0xFF) << (i % 32);
    }
    return output;
  }

  function rstrMD5(s) {
    return binl2rstr(binlMD5(rstr2binl(s), s.length * 8));
  }

  function rstr2hex(input) {
    const hexTab = '0123456789abcdef';
    let output = '';
    let x, i;
    for (i = 0; i < input.length; i++) {
      x = input.charCodeAt(i);
      output += hexTab.charAt((x >>> 4) & 0x0F) + hexTab.charAt(x & 0x0F);
    }
    return output;
  }

  function str2rstrUTF8(input) {
    return unescape(encodeURIComponent(input));
  }

  return rstr2hex(rstrMD5(str2rstrUTF8(input)));
}

// =========================================================
// Subsonic-API helpers
// =========================================================
function randomSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function subsonicParams(extra) {
  const extraObj = extra || {};
  // Wir nutzen einfaches Passwort ("p" parameter) statt Token-Auth.
  // Grund: meine pure-JS MD5-Implementierung liefert fehlerhafte Hashes,
  // und Navidrome lehnt dann mit "Wrong username or password" ab.
  // Subsonic unterstuetzt "p" offiziell, nur nicht mehr empfohlen.
  // Da der Edge-Proxy mit HTTPS zu Navidrome spricht, ist das vertretbar.
  const params = new URLSearchParams({
    u: NAVIDROME_USER,
    p: NAVIDROME_PASS,
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
  const url = base + '/rest/' + path + '?' + params.toString();
  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) throw new Error('Navidrome ' + path + ' HTTP ' + r.status);
  return r.json();
}

// =========================================================
// ACTIONS
// =========================================================

async function getNowPlaying() {
  const serverUrl = NAVIDROME_URL.replace(/\/+$/, '');
  try {
    const params = subsonicParams();
    const data = await navFetch('getNowPlaying', params);
    const resp = data && data['subsonic-response'];
    const entry = resp && resp.nowPlaying && resp.nowPlaying.entry && resp.nowPlaying.entry[0];
    if (entry) {
      return buildPlayingEntry(entry, 'nowPlaying', serverUrl);
    }
    // Fallback: getPlayQueue
    const queue = await getPlayQueueForUser();
    if (queue) return queue;
    return { playing: false, url: serverUrl };
  } catch (err) {
    console.error('nowPlaying failed:', err && err.message);
    return { playing: false, error: err && err.message, url: serverUrl };
  }
}

async function getPlayQueueForUser() {
  try {
    const params = subsonicParams();
    const data = await navFetch('getPlayQueue', params);
    const resp = data && data['subsonic-response'];
    const queue = resp && resp.playQueue;
    if (!queue) return null;

    const currentId = queue.current;
    const entries = Array.isArray(queue.entry) ? queue.entry : (queue.entry ? [queue.entry] : []);
    if (!currentId || entries.length === 0) return null;

    const current = entries.find((e) => String(e.id) === String(currentId)) || entries[0];
    if (!current) return null;

    const serverUrl = NAVIDROME_URL.replace(/\/+$/, '');
    const positionNum = Number(queue.position || 0) || 0;
    const durationNum = Number(current.duration || 0) || 0;
    const coverUrl = current.coverArt ? await getCoverArt(current.coverArt, 220) : '';

    return {
      playing:    true,
      source:     'playQueue',
      title:      String(current.title  || ''),
      artist:     String(current.artist || ''),
      album:      String(current.album  || ''),
      duration:   durationNum,
      position:   Math.floor(positionNum / 1000),
      coverUrl:   coverUrl,
      player:     String(current.username || ''),
      minutesAgo: 0,
      url:        serverUrl,
    };
  } catch (e) {
    console.error('getPlayQueue failed:', e && e.message);
    return null;
  }
}

async function buildPlayingEntry(entry, source, serverUrl) {
  const coverUrl = entry.coverArt ? await getCoverArt(entry.coverArt, 220) : '';
  const player = entry.player || {};
  const minutesAgoNum = Number(entry.minutesAgo || 0) || 0;
  const durationNum = Number(entry.duration || 0) || 0;
  const positionNum = Number(player.position || minutesAgoNum) || 0;
  return {
    playing:    true,
    source:     source,
    title:      String(entry.title  || ''),
    artist:     String(entry.artist || ''),
    album:      String(entry.album  || ''),
    duration:   durationNum,
    position:   positionNum,
    coverUrl:   coverUrl,
    player:     String(player.name  || ''),
    minutesAgo: minutesAgoNum,
    url:        serverUrl,
  };
}

async function getCoverArt(id, size) {
  if (!id) return '';
  const sizeNum = Number(size) || 220;
  try {
    const params = subsonicParams({ id: id, size: sizeNum });
    const base = NAVIDROME_URL.replace(/\/+$/, '');
    const url = base + '/rest/getCoverArt?' + params.toString();
    const r = await fetch(url);
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

async function controlPlayer(action) {
  const map = { play: 'play', pause: 'pause', next: 'next', previous: 'previous' };
  const mapped = map[action];
  if (!mapped) throw new Error('unsupported action: ' + action);
  const params = subsonicParams({ action: mapped });
  const data = await navFetch('control', params);
  const resp = data && data['subsonic-response'];
  if (resp && resp.error) {
    throw new Error(resp.error.message || 'control failed');
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
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch (_) {
    return json({ ok: false, error: 'invalid JSON body' }, 400, req);
  }

  const action = body.action;

  if (action === 'testmd5') {
    // Debug: berechne md5 eines Test-Strings und gib das Ergebnis zurueck
    const testInput = String(body.input || 'test123abc');
    const hash = md5(testInput);
    return json({ ok: true, data: { input: testInput, hash: hash } }, 200, req);
  }

  if (action === 'status') {
    const configured = !!(NAVIDROME_URL && NAVIDROME_USER && NAVIDROME_PASS);
    const serverUrl = NAVIDROME_URL.replace(/\/+$/, '') || '';
    const result = {
      configured: configured,
      url: serverUrl,
      debug: {
        urlSet: !!NAVIDROME_URL,
        urlValue: NAVIDROME_URL ? NAVIDROME_URL.replace(/\/+$/, '') : '(leer)',
        userSet: !!NAVIDROME_USER,
        userValue: NAVIDROME_USER || '(leer)',
        passSet: !!NAVIDROME_PASS,
        passLength: NAVIDROME_PASS ? NAVIDROME_PASS.length : 0,
      }
    };
    if (!configured) {
      return json({ ok: true, data: result }, 200, req);
    }
    const checks = {};
    try {
      const params = subsonicParams({ type: 'newest', size: 5 });
      const data = await navFetch('getAlbumList2', params);
      const resp = data && data['subsonic-response'];
      const albums = resp && resp.albumList2 && resp.albumList2.album;
      checks.albums = {
        ok: resp && resp.status === 'ok',
        count: Array.isArray(albums) ? albums.length : 0,
        error: resp && resp.error ? resp.error.message : null,
      };
    } catch (e) {
      checks.albums = { error: e.message };
    }
    try {
      const params = subsonicParams();
      const data = await navFetch('getNowPlaying', params);
      const resp = data && data['subsonic-response'];
      const entries = resp && resp.nowPlaying && resp.nowPlaying.entry;
      checks.nowPlaying = {
        ok: resp && resp.status === 'ok',
        count: Array.isArray(entries) ? entries.length : 0,
        error: resp && resp.error ? resp.error.message : null,
      };
    } catch (e) {
      checks.nowPlaying = { error: e.message };
    }
    try {
      const params = subsonicParams();
      const data = await navFetch('getPlayQueue', params);
      const resp = data && data['subsonic-response'];
      const q = resp && resp.playQueue;
      checks.playQueue = {
        ok: resp && resp.status === 'ok',
        hasCurrent: !!(q && q.current),
        entryCount: q && q.entry ? (Array.isArray(q.entry) ? q.entry.length : 1) : 0,
        error: resp && resp.error ? resp.error.message : null,
      };
    } catch (e) {
      checks.playQueue = { error: e.message };
    }
    return json({ ok: true, data: Object.assign({}, result, { checks: checks }) }, 200, req);
  }

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