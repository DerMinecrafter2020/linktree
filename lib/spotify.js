// =========================================================
// Spotify-Helfer (serverseitig)
// =========================================================
// "Now Playing" ueber die Spotify Web API (GET /me/player/currently-playing).
// Anmeldung per OAuth Authorization Code Flow: Client-ID/-Secret der eigenen Spotify-App,
// der Refresh-Token liegt verschluesselt in spotify_settings. Der Access-Token (1 h gueltig)
// bleibt nur im Arbeitsspeicher. Der Browser sieht keine dieser Daten.

const db = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { safeText } = require('./validators');
const { shortCache } = require('./shortcache');
const redirectUris = require('./redirect-uri');

const ACCOUNTS_URL = 'https://accounts.spotify.com';
const API_URL = 'https://api.spotify.com/v1';
const SCOPES = ['user-read-currently-playing', 'user-read-playback-state'];
const CALLBACK_PATH = '/api/admin/spotify/callback';
const API_TIMEOUT_MS = 4000;
const CACHE_MS = 4000;                 // Spotify hat ein Rate-Limit: hoechstens ein Abruf je 4 s
const PAUSED_TIMEOUT_MS = 2 * 60 * 1000; // wie Navidrome: Pausiertes verschwindet nach 2 Minuten
const DEFAULT_BACKOFF_MS = 30_000;
const COVER_HOST = 'i.scdn.co';
const COVER_MAX_BYTES = 5 * 1024 * 1024;
const COVER_TYPES = /^image\/(jpeg|png|gif|webp|avif)$/;
const ID_RE = /^[A-Za-z0-9]{16,64}$/;

let tokenCache = { key: null, token: null, expiresAt: 0, inflight: null };
let backoffUntil = 0;
let lastTrack = null;
let pausedState = { id: null, since: 0 };
let coverCache = { url: null, contentType: null, body: null };

async function getSettings() {
  const { rows } = await db.query('SELECT * FROM spotify_settings WHERE id = 1 LIMIT 1');
  return rows[0] || null;
}

function isConfigured(settings) {
  return !!(settings && settings.client_id && settings.client_secret_encrypted);
}

function isConnected(settings) {
  return isConfigured(settings) && !!settings.refresh_token_encrypted;
}

// Redirect-URI aus APP_URL (wie WebAuthn) – muss exakt so in der Spotify-App eingetragen sein
function getRedirectUri(req) {
  return redirectUris.getRedirectUri(req, CALLBACK_PATH);
}

// Fuer den Einrichtungsassistenten: kommt die URI aus der Konfiguration und akzeptiert Spotify sie?
function getRedirectUriStatus(req) {
  return redirectUris.getRedirectUriStatus(req, CALLBACK_PATH);
}

function buildAuthorizeUrl(settings, state, redirectUri) {
  const url = new URL('/authorize', ACCOUNTS_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', settings.client_id);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('show_dialog', 'true');
  return url.toString();
}

function spotifyError(message, status) {
  const err = new Error(message);
  if (status) err.status = status;
  return err;
}

async function tokenRequest(settings, params) {
  const secret = decrypt(settings.client_secret_encrypted);
  const basic = Buffer.from(`${settings.client_id}:${secret}`).toString('base64');
  const res = await fetch(`${ACCOUNTS_URL}/api/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams(params).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(API_TIMEOUT_MS * 2),
  });
  let json = {};
  try { json = await res.json(); } catch { /* leer */ }
  if (!res.ok) {
    const err = spotifyError(`Spotify-Token-Fehler (${res.status}${json.error ? ': ' + json.error : ''})`, res.status);
    err.code = json.error || null;
    throw err;
  }
  return json;
}

// Code aus dem OAuth-Callback gegen Tokens tauschen
async function exchangeCode(settings, code, redirectUri) {
  const json = await tokenRequest(settings, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  if (!json.access_token || !json.refresh_token) throw spotifyError('Spotify hat keinen Refresh-Token geliefert');
  const granted = String(json.scope || '').split(/\s+/);
  if (!granted.includes('user-read-currently-playing')) {
    throw spotifyError('Die Berechtigung "user-read-currently-playing" wurde nicht erteilt');
  }
  return json;
}

function tokenKey(settings) {
  return `${settings.client_id}\n${settings.refresh_token_encrypted}`;
}

function resetTokenCache() {
  tokenCache = { key: null, token: null, expiresAt: 0, inflight: null };
}

// Access-Token aus dem Code-Tausch direkt uebernehmen (spart einen Refresh direkt nach dem Verbinden)
function primeToken(settings, accessToken, expiresIn) {
  const seconds = Math.max(60, Number(expiresIn) || 3600);
  tokenCache = { key: tokenKey(settings), token: accessToken, expiresAt: Date.now() + seconds * 1000, inflight: null };
}

async function getAccessToken(settings) {
  const key = tokenKey(settings);
  if (tokenCache.key === key) {
    if (tokenCache.token && tokenCache.expiresAt - 60_000 > Date.now()) return tokenCache.token;
    if (tokenCache.inflight) return tokenCache.inflight;
  }
  const inflight = (async () => {
    try {
      const json = await tokenRequest(settings, {
        grant_type: 'refresh_token',
        refresh_token: decrypt(settings.refresh_token_encrypted),
      });
      if (!json.access_token) throw spotifyError('Spotify hat keinen Access-Token geliefert');
      // Spotify kann beim Refresh einen neuen Refresh-Token ausgeben – dann speichern
      if (json.refresh_token) {
        const enc = encrypt(json.refresh_token);
        await db.query('UPDATE spotify_settings SET refresh_token_encrypted = $1, updated_at = NOW() WHERE id = 1', [enc]);
        settings.refresh_token_encrypted = enc;
      }
      const expiresIn = Math.max(60, Number(json.expires_in) || 3600);
      tokenCache = { key: tokenKey(settings), token: json.access_token, expiresAt: Date.now() + expiresIn * 1000, inflight: null };
      return json.access_token;
    } catch (err) {
      // Widerrufen (z. B. App in Spotify entfernt): Verbindung trennen, Admin muss neu verbinden
      if (err.code === 'invalid_grant') {
        console.warn('[spotify] Refresh-Token ungueltig – Verbindung wird getrennt. Bitte im Admin neu verbinden.');
        await db.query('UPDATE spotify_settings SET refresh_token_encrypted = NULL, connected_at = NULL, updated_at = NOW() WHERE id = 1');
      }
      resetTokenCache();
      throw err;
    }
  })();
  tokenCache = { key, token: null, expiresAt: 0, inflight };
  return inflight;
}

// GET gegen die Web API; 204 -> null, 401 -> Token neu holen und einmal wiederholen, 429 -> Pause
async function apiGet(settings, path, retried = false) {
  const token = await getAccessToken(settings);
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (res.status === 204) return null;
  if (res.status === 401 && !retried) {
    resetTokenCache();
    return apiGet(settings, path, true);
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3600) * 1000 : DEFAULT_BACKOFF_MS;
    backoffUntil = Date.now() + wait;
    console.warn(`[spotify] Rate-Limit erreicht – naechster Abruf in ${Math.round(wait / 1000)} s`);
    throw spotifyError('Spotify Rate-Limit', 429);
  }
  if (!res.ok) throw spotifyError(`Spotify HTTP ${res.status}`, res.status);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw spotifyError('Ungueltige Spotify-Antwort');
  }
}

async function getProfile(settings) {
  const me = await apiGet(settings, '/me');
  return {
    id: safeText(String(me?.id || ''), 255),
    name: safeText(String(me?.display_name || me?.id || ''), 255),
  };
}

// Passendes Cover: kleinstes Bild ab 300 px, sonst das groesste; nur von i.scdn.co (https)
function pickCover(images) {
  if (!Array.isArray(images) || !images.length) return null;
  const valid = images.filter((img) => {
    if (!img || typeof img.url !== 'string') return false;
    try {
      const u = new URL(img.url);
      return u.protocol === 'https:' && u.hostname === COVER_HOST;
    } catch {
      return false;
    }
  });
  if (!valid.length) return null;
  const sorted = [...valid].sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
  const fitting = sorted.filter((img) => (Number(img.width) || 0) >= 300);
  return (fitting.length ? fitting[fitting.length - 1] : sorted[0]).url;
}

function spotifyUrlOf(item) {
  const url = item?.external_urls?.spotify;
  return typeof url === 'string' && url.startsWith('https://open.spotify.com/') ? url.slice(0, 500) : null;
}

const NOT_PLAYING = Object.freeze({ playing: false, source: 'spotify' });

function toTrack(data) {
  if (!data || !data.item || !['track', 'episode'].includes(data.currently_playing_type)) return NOT_PLAYING;
  const item = data.item;
  const isEpisode = data.currently_playing_type === 'episode';
  const id = safeText(String(item.uri || item.id || ''), 255) || null;
  const paused = data.is_playing !== true;

  // Pausierte Titel nach 2 Minuten ausblenden (eigene Zeitmessung, Spotify meldet Pausen sonst ewig)
  if (paused) {
    if (pausedState.id !== id) pausedState = { id, since: Date.now() };
    if (Date.now() - pausedState.since > PAUSED_TIMEOUT_MS) return NOT_PLAYING;
  } else {
    pausedState = { id: null, since: 0 };
  }

  const artist = isEpisode
    ? safeText(String(item.show?.name || ''), 255)
    : (Array.isArray(item.artists) ? item.artists.map((a) => a && a.name).filter(Boolean).join(', ') : '');
  const coverUrlInternal = pickCover(isEpisode ? (item.images || item.show?.images) : item.album?.images);
  const duration = Math.max(0, (Number(item.duration_ms) || 0) / 1000);
  const position = Math.max(0, (Number(data.progress_ms) || 0) / 1000);

  return {
    playing: true,
    paused,
    isRadio: false,
    id,
    title: safeText(String(item.name || ''), 255) || 'Unbekannt',
    artist: safeText(artist, 255),
    album: isEpisode ? '' : safeText(String(item.album?.name || ''), 255),
    duration,
    position: duration > 0 ? Math.min(position, duration) : position,
    bitrate: null,
    format: null,
    coverUrl: coverUrlInternal ? `/api/status/spotify-cover?v=${encodeURIComponent(String(id || item.name || '').slice(0, 200))}` : null,
    coverUrlInternal,
    spotifyUrl: spotifyUrlOf(item),
    source: 'spotify',
    fetchedAt: Date.now(),
  };
}

async function getNowPlaying() {
  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    console.error('[spotify] Einstellungen nicht lesbar:', err.message);
    return null;
  }
  if (!settings || !settings.enabled || !isConnected(settings)) return null;

  // Waehrend einer Rate-Limit-Pause den letzten bekannten Stand weitergeben
  if (Date.now() < backoffUntil) return lastTrack;

  try {
    const data = await apiGet(settings, '/me/player/currently-playing?additional_types=track,episode');
    lastTrack = toTrack(data);
    return lastTrack;
  } catch (err) {
    if (err.status !== 429) console.error('[spotify] now-playing error:', err.message);
    return err.status === 429 ? lastTrack : null;
  }
}

const getNowPlayingCached = shortCache(getNowPlaying, CACHE_MS);

// Position seit dem Abruf fortschreiben, damit der gecachte Stand nicht "zurueckspringt"
async function getNowPlayingLive() {
  const track = await getNowPlayingCached();
  if (!track || track.playing !== true || track.paused || !track.fetchedAt) return track;
  const elapsed = Math.max(0, (Date.now() - track.fetchedAt) / 1000);
  const position = track.position + elapsed;
  return { ...track, position: track.duration > 0 ? Math.min(position, track.duration) : position };
}

// Aktuelles Cover laden – nur https://i.scdn.co, ohne Weiterleitungen, mit Zeit- und Groessenlimit.
// Das letzte Cover bleibt im Speicher, damit nicht jeder Besucher einen eigenen Abruf ausloest.
async function fetchCurrentCover() {
  const track = await getNowPlayingCached();
  const url = track && track.coverUrlInternal;
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== COVER_HOST) return null;
  if (coverCache.url === url && coverCache.body) return { contentType: coverCache.contentType, body: coverCache.body };

  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!COVER_TYPES.test(contentType)) return null;
  if (Number(res.headers.get('content-length') || 0) > COVER_MAX_BYTES) return null;
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > COVER_MAX_BYTES) return null;
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  coverCache = { url, contentType, body };
  return { contentType, body };
}

// Nach Trennen/Neuverbinden alle Zwischenstaende verwerfen
function resetState() {
  resetTokenCache();
  backoffUntil = 0;
  lastTrack = null;
  pausedState = { id: null, since: 0 };
}

module.exports = {
  SCOPES,
  CALLBACK_PATH,
  ID_RE,
  getSettings,
  isConfigured,
  isConnected,
  getRedirectUri,
  getRedirectUriStatus,
  buildAuthorizeUrl,
  exchangeCode,
  primeToken,
  getProfile,
  fetchCurrentCover,
  resetState,
  getNowPlaying: getNowPlayingLive,
  getNowPlayingUncached: getNowPlaying,
  // fuer Tests
  _toTrack: toTrack,
  _pickCover: pickCover,
};
