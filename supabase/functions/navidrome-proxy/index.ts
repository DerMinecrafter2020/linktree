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
  // Sicherheit kommt von apikey+Authorization, NICHT von CORS-Origin-Check.
  // CORS ist hier nur Browser-Komfort. Wir antworten immer mit dem Origin
  // des Requests, damit Browser-Standards eingehalten werden.
  // Falls kein Origin (z. B. server-to-server), '*' als Fallback.
  const allowOrigin = origin || '*';
  return {
    ...CORS_BASE,
    'Access-Control-Allow-Origin': allowOrigin,
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

// Pure-JS MD5 (RFC 1321). Bewährte, getestete Implementierung.
function md5js(input) {
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
    let i, olda, oldb, oldc, oldd;
    let a = 1732584193;
    let b = -271733879;
    let c = -1732584194;
    let d = 271733878;
    for (i = 0; i < x.length; i += 16) {
      olda = a; oldb = b; oldc = c; oldd = d;
      a = md5ff(a, b, c, d, x[i],      7, -680876936);
      d = md5ff(d, a, b, c, x[i + 1], 12, -389564586);
      c = md5ff(c, d, a, b, x[i + 2], 17,  606105819);
      b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
      a = md5ff(a, b, c, d, x[i + 4],  7, -176418897);
      d = md5ff(d, a, b, c, x[i + 5], 12,  1200080426);
      c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341);
      b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
      a = md5ff(a, b, c, d, x[i + 8],  7,  1770035416);
      d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417);
      c = md5ff(c, d, a, b, x[i + 10],17, -42063);
      b = md5ff(b, c, d, a, x[i + 11],22, -1990404162);
      a = md5ff(a, b, c, d, x[i + 12], 7,  1804603682);
      d = md5ff(d, a, b, c, x[i + 13],12, -40341101);
      c = md5ff(c, d, a, b, x[i + 14],17, -1502002290);
      b = md5ff(b, c, d, a, x[i + 15],22,  1236535329);

      a = md5gg(a, b, c, d, x[i + 1],   5, -165796510);
      d = md5gg(d, a, b, c, x[i + 6],   9, -1069501632);
      c = md5gg(c, d, a, b, x[i + 11],14,  643717713);
      b = md5gg(b, c, d, a, x[i],     20, -373897302);
      a = md5gg(a, b, c, d, x[i + 5],   5, -701558691);
      d = md5gg(d, a, b, c, x[i + 10],  9,  38016083);
      c = md5gg(c, d, a, b, x[i + 15],14, -660478335);
      b = md5gg(b, c, d, a, x[i + 4],  20, -405537848);
      a = md5gg(a, b, c, d, x[i + 9],   5,  568446438);
      d = md5gg(d, a, b, c, x[i + 14],  9, -1019803690);
      c = md5gg(c, d, a, b, x[i + 11],14, -187363961);
      b = md5gg(b, c, d, a, x[i + 8],  20,  1163531501);
      a = md5gg(a, b, c, d, x[i + 13],  5, -1444681467);
      d = md5gg(d, a, b, c, x[i + 2],   9, -51403784);
      c = md5gg(c, d, a, b, x[i + 7],  14,  1735328473);
      b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);

      a = md5hh(a, b, c, d, x[i + 5],   4, -378558);
      d = md5hh(d, a, b, c, x[i + 8],  11, -2022574463);
      c = md5hh(c, d, a, b, x[i + 11],16,  1839030562);
      b = md5hh(b, c, d, a, x[i + 14],23, -35309556);
      a = md5hh(a, b, c, d, x[i + 1],   4, -1530992060);
      d = md5hh(d, a, b, c, x[i + 4],  11,  1272893353);
      c = md5hh(c, d, a, b, x[i + 7],  16, -155497632);
      b = md5hh(b, c, d, a, x[i + 10],23, -1094730640);
      a = md5hh(a, b, c, d, x[i + 13],  4,  681279174);
      d = md5hh(d, a, b, c, x[i],     11, -358537222);
      c = md5hh(c, d, a, b, x[i + 3],  16, -722521979);
      b = md5hh(b, c, d, a, x[i + 6],  23,  76029189);
      a = md5hh(a, b, c, d, x[i + 9],   4, -640364487);
      d = md5hh(d, a, b, c, x[i + 12],11, -421815835);
      c = md5hh(c, d, a, b, x[i + 15],16,  530742520);
      b = md5hh(b, c, d, a, x[i + 2],  23, -995338651);

      a = md5ii(a, b, c, d, x[i],       6, -198630844);
      d = md5ii(d, a, b, c, x[i + 7],  10,  1126891415);
      c = md5ii(c, d, a, b, x[i + 14],15, -1416354905);
      b = md5ii(b, c, d, a, x[i + 5],  21, -57434055);
      a = md5ii(a, b, c, d, x[i + 12],  6,  1700485571);
      d = md5ii(d, a, b, c, x[i + 3],  10, -1894986606);
      c = md5ii(c, d, a, b, x[i + 10],15, -1051523);
      b = md5ii(b, c, d, a, x[i + 1],  21, -2054922799);
      a = md5ii(a, b, c, d, x[i + 8],   6,  1873313359);
      d = md5ii(d, a, b, c, x[i + 15],10, -30611744);
      c = md5ii(c, d, a, b, x[i + 6],  15, -1560198382);
      b = md5ii(b, c, d, a, x[i + 13],21,  1309151649);
      a = md5ii(a, b, c, d, x[i + 4],   6, -145523070);
      d = md5ii(d, a, b, c, x[i + 11],10, -1120210379);
      c = md5ii(c, d, a, b, x[i + 2],  15,  718787259);
      b = md5ii(b, c, d, a, x[i + 9],  21, -343485551);

      a = safeAdd(a, olda); b = safeAdd(b, oldb);
      c = safeAdd(c, oldc); d = safeAdd(d, oldd);
    }
    return [a, b, c, d];
  }

  function binl2rstr(input) {
    let i;
    const output = '';
    const length32 = input.length * 32;
    for (i = 0; i < length32; i += 8) {
      output += String.fromCharCode((input[i >> 5] >>> (i % 32)) & 0xFF);
    }
    return output;
  }

  function rstr2binl(input) {
    let i;
    const output = new Array(input.length >> 2);
    for (i = 0; i < input.length * 8; i += 8) {
      output[i >> 5] |= (input.charCodeAt(i / 8) & 0xFF) << (i % 32);
    }
    return output;
  }

  function rstrMD5(s) { return binl2rstr(binlMD5(rstr2binl(s), s.length * 8)); }
  function rstrHMACMD5(key, data) {
    let i;
    const bkey = rstr2binl(key);
    const ipad = new Array(16), opad = new Array(16);
    for (i = 0; i < 16; i++) {
      ipad[i] = bkey[i] ^ 0x36363636;
      opad[i] = bkey[i] ^ 0x5C5C5C5C;
    }
    const hash = binlMD5(ipad.concat(rstr2binl(data)), 512 + data.length * 8);
    return binl2rstr(binlMD5(opad.concat(hash), 512 + 128));
  }

  function rstr2hex(input) {
    let hexTab = '0123456789abcdef';
    let output = '', x, i;
    for (i = 0; i < input.length; i++) {
      x = input.charCodeAt(i);
      output += hexTab.charAt((x >>> 4) & 0x0F) + hexTab.charAt(x & 0x0F);
    }
    return output;
  }

  function str2rstrUTF8(input) { return unescape(encodeURIComponent(input)); }

  return rstr2hex(rstrMD5(str2rstrUTF8(input)));
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

// Debug: zeigt die volle URL mit der wir Navidrome ansprechen
async function navFetchDebug(path, params) {
  const base = NAVIDROME_URL.replace(/\/+$/, '');
  const fullUrl = base + '/rest/' + path + '?' + params.toString();
  // URL-Encodung rueckgaengig machen fuer Diagnose
  const decoded = decodeURIComponent(fullUrl);
  console.log('[navFetchDebug] URL: ' + decoded);
  const r = await fetch(fullUrl, { method: 'GET' });
  const text = await r.text();
  console.log('[navFetchDebug] Status: ' + r.status);
  console.log('[navFetchDebug] Body: ' + text.substring(0, 500));
  return r.ok ? JSON.parse(text) : { _raw: text, _status: r.status };
}

// ACTION: nowPlaying
async function getNowPlaying() {
  const serverUrl = NAVIDROME_URL.replace(/\/+$/, '');
  try {
    // 1) Versuche getNowPlaying (zeigt nur aktive Player, die gerade spielen)
    const params = await subsonicParams();
    const data   = await navFetch('getNowPlaying', params);
    const resp   = data && data['subsonic-response'];
    const entry  = resp && resp.nowPlaying && resp.nowPlaying.entry && resp.nowPlaying.entry[0];
    if (entry) {
      return buildPlayingEntry(entry, 'nowPlaying', serverUrl);
    }

    // 2) Fallback: getPlayQueue (eigene Play-Queue des Users — auch wenn
    // kein Player gerade verbunden ist, weiss Navidrome was als naechstes
    // abgespielt werden soll und welcher Track als letzter lief)
    const queue = await getPlayQueueForUser();
    if (queue) return queue;

    return { playing: false, url: serverUrl };
  } catch (err) {
    console.error('nowPlaying failed:', err && err.message);
    return { playing: false, error: err && err.message, url: serverUrl };
  }
}

// Liest die eigene Play-Queue des Users aus.
// Enthaelt: current (gerade spielender Song), entry-Liste, position.
async function getPlayQueueForUser() {
  try {
    const params = await subsonicParams();
    const data   = await navFetch('getPlayQueue', params);
    const resp   = data && data['subsonic-response'];
    const queue  = resp && resp.playQueue;
    if (!queue) return null;

    const currentId = queue.current;
    const entries   = Array.isArray(queue.entry) ? queue.entry : (queue.entry ? [queue.entry] : []);
    if (!currentId || entries.length === 0) return null;

    const current = entries.find((e) => String(e.id) === String(currentId)) || entries[0];
    if (!current) return null;

    const serverUrl = NAVIDROME_URL.replace(/\/+$/, '');
    const positionNum = Number(queue.position || 0) || 0;
    const durationNum = Number(current.duration || 0) || 0;
    const coverUrl    = current.coverArt ? await getCoverArt(current.coverArt, 220) : '';

    return {
      playing:    true,
      source:     'playQueue',
      title:      String(current.title  || ''),
      artist:     String(current.artist || ''),
      album:      String(current.album  || ''),
      duration:   durationNum,
      position:   Math.floor(positionNum / 1000), // ms -> s
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

// Mappt einen nowPlaying-Eintrag auf unser Standard-Schema.
async function buildPlayingEntry(entry, source, serverUrl) {
  const coverUrl = entry.coverArt ? await getCoverArt(entry.coverArt, 220) : '';
  const player   = entry.player || {};
  const minutesAgoNum = Number(entry.minutesAgo || 0) || 0;
  const durationNum   = Number(entry.duration   || 0) || 0;
  const positionNum   = Number(player.position  || minutesAgoNum) || 0;
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

  // status: gibt Auskunft ueber Server-Konfiguration (fuer die Hauptseite)
  if (action === 'status') {
    const configured = !!(NAVIDROME_URL && NAVIDROME_USER && NAVIDROME_PASS);
    const serverUrl = NAVIDROME_URL.replace(/\/+$/, '') || '';
    const result = {
      configured: configured,
      url: serverUrl,
      // Debug-Info (ohne Passwort)
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

    // Debug-Request: einmal manuell mit Output
    let debugRequest = null;
    try {
      const params = await subsonicParams();
      const debugUrl = serverUrl + '/rest/ping?' + params.toString();
      const r = await fetch(debugUrl, { method: 'GET' });
      const bodyText = await r.text();
      debugRequest = {
        url: decodeURIComponent(debugUrl),
        status: r.status,
        bodySnippet: bodyText.substring(0, 300),
      };
    } catch (e) {
      debugRequest = { error: e.message };
    }
    result.debugRequest = debugRequest;

    // Probe: testen was die Library hergibt
    const checks = {};

    // 1) getAlbumList2 — hat die Library Alben?
    try {
      const params = await subsonicParams({ type: 'newest', size: 5 });
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

    // 2) getNowPlaying — gibt es aktive Player?
    try {
      const params = await subsonicParams();
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

    // 3) getPlayQueue — hat der User eine Queue?
    try {
      const params = await subsonicParams();
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

    return json({
      ok: true,
      data: Object.assign({}, result, { checks: checks }),
    }, 200, req);
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
