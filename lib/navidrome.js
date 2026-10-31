// =========================================================
// Navidrome-Helfer (serverseitig)
// =========================================================
// Wird von Routes und vom Open-Graph-Handler genutzt.

const crypto = require('crypto');
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');

// Anmeldedaten (Benutzername + Passwort) liegen nur verschluesselt in navidrome_settings.
// getSettings() liefert den Benutzernamen entschluesselt in "username" (nur serverseitig nutzen).
async function getSettings() {
  const { rows } = await db.query('SELECT * FROM navidrome_settings WHERE id = 1 LIMIT 1');
  let row = rows[0];
  if (!row) return null;

  // Altbestand: Klartext-Benutzernamen einmalig verschluesseln und die Klartext-Spalte leeren
  if (row.username && !row.username_encrypted) {
    const enc = encrypt(row.username);
    await db.query(
      'UPDATE navidrome_settings SET username_encrypted = $1, username = NULL WHERE id = 1 AND username = $2',
      [enc, row.username]
    );
    console.log('[navidrome] Benutzername wird jetzt verschluesselt gespeichert.');
    row = { ...row, username_encrypted: enc, username: null };
  }

  let username = null;
  if (row.username_encrypted) {
    try {
      username = decrypt(row.username_encrypted);
    } catch (err) {
      console.error('[navidrome] Benutzername nicht entschluesselbar:', err.message);
    }
  }
  return { ...row, username };
}

// Einziger Schreibweg fuer die Navidrome-Einstellungen (Admin, Seeding, install.sh).
// Leeres Passwort = gespeichertes Passwort behalten.
async function saveSettings({ enabled, url, username, password, pollIntervalSec }) {
  const usernameEnc = username ? encrypt(username) : null;
  const passwordEnc = password ? encrypt(password) : null;
  const poll = Math.min(600, Math.max(5, parseInt(pollIntervalSec, 10) || 30));
  await db.query(`
    INSERT INTO navidrome_settings (id, enabled, url, username, username_encrypted, password_encrypted, poll_interval_sec)
    VALUES (1, $1, $2, NULL, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      url = EXCLUDED.url,
      username = NULL,
      username_encrypted = EXCLUDED.username_encrypted,
      password_encrypted = COALESCE(EXCLUDED.password_encrypted, navidrome_settings.password_encrypted),
      poll_interval_sec = EXCLUDED.poll_interval_sec,
      updated_at = NOW()
  `, [!!enabled, url || null, usernameEnc, passwordEnc, poll]);
}

// Nur pruefen, ob unter der Adresse ein Subsonic-/Navidrome-Server antwortet – ohne Zugangsdaten
// (der Server meldet dann "Parameter fehlt", aber im Subsonic-Format). Fuer Schritt 1 des Assistenten.
async function probeServer(url) {
  let pingUrl;
  try {
    pingUrl = new URL('/rest/ping', url);
    pingUrl.searchParams.set('v', '1.13.0');
    pingUrl.searchParams.set('c', 'openweb');
    pingUrl.searchParams.set('f', 'json');
  } catch {
    return { ok: false, error: 'Die Adresse ist ungültig.' };
  }
  let response;
  try {
    response = await fetch(pingUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ok: false,
      error: timeout
        ? 'Der Server antwortet nicht (Zeitüberschreitung). Ist er vom OpenWeb-Server aus erreichbar?'
        : 'Der Server ist nicht erreichbar. Prüfe die Adresse und ob er vom OpenWeb-Server aus erreichbar ist.',
    };
  }
  try {
    const json = JSON.parse(await response.text());
    if (json['subsonic-response']) return { ok: true };
  } catch { /* kein JSON */ }
  return { ok: false, error: `Unter dieser Adresse antwortet kein Navidrome-/Subsonic-Server (HTTP ${response.status}). Nutze die Adresse, unter der du Navidrome im Browser öffnest.` };
}

// Verbindung pruefen (Subsonic-Ping). Liefert eine verstaendliche Fehlermeldung statt Interna.
async function testConnection({ url, username, password }) {
  if (!url || !username || !password) return { ok: false, error: 'URL, Benutzername und Passwort werden benötigt.' };
  let pingUrl;
  try {
    pingUrl = buildSubsonicUrl(url, username, password, '/rest/ping');
  } catch {
    return { ok: false, error: 'Die Adresse ist ungültig.' };
  }
  let response;
  try {
    response = await fetch(pingUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ok: false,
      error: timeout
        ? 'Der Server antwortet nicht (Zeitüberschreitung). Ist er vom OpenWeb-Server aus erreichbar?'
        : 'Der Server ist nicht erreichbar. Prüfe die Adresse und ob er vom OpenWeb-Server aus erreichbar ist.',
    };
  }
  let json;
  try {
    json = JSON.parse(await response.text());
  } catch {
    return { ok: false, error: `Unter dieser Adresse antwortet kein Navidrome-/Subsonic-Server (HTTP ${response.status}).` };
  }
  const status = json['subsonic-response'];
  if (!status) return { ok: false, error: 'Unter dieser Adresse antwortet kein Navidrome-/Subsonic-Server.' };
  if (status.status === 'failed') {
    const code = Number(status.error?.code);
    if (code === 40 || code === 41) return { ok: false, error: 'Benutzername oder Passwort ist falsch.' };
    return { ok: false, error: 'Navidrome meldet einen Fehler: ' + String(status.error?.message || 'unbekannt').slice(0, 200) };
  }
  return { ok: true, serverVersion: status.serverVersion || status.version || null, type: status.type || null };
}

function buildSubsonicUrl(baseUrl, username, password, endpoint, params = {}) {
  const salt = crypto.randomBytes(8).toString('hex');
  const token = crypto.createHash('md5').update(password + salt).digest('hex');
  const url = new URL(endpoint, baseUrl);
  url.searchParams.set('u', username);
  url.searchParams.set('t', token);
  url.searchParams.set('s', salt);
  url.searchParams.set('v', '1.13.0');
  url.searchParams.set('c', 'openweb');
  url.searchParams.set('f', 'json');
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  return url.toString();
}

async function subsonicRequest(baseUrl, username, password, endpoint, params) {
  const url = buildSubsonicUrl(baseUrl, username, password, endpoint, params);
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Ungueltige Navidrome-Antwort');
  }
  if (json['subsonic-response']?.status === 'failed') {
    throw new Error(json['subsonic-response'].error?.message || 'Navidrome-Fehler');
  }
  return json['subsonic-response'];
}

// Cache fuer Radiosender (wird alle 5 Minuten aktualisiert)
let radioStationsCache = null;
let radioStationsCacheTime = 0;
const RADIO_CACHE_TTL = 5 * 60 * 1000;

async function getRadioStations(baseUrl, username, password) {
  const now = Date.now();
  if (radioStationsCache && (now - radioStationsCacheTime) < RADIO_CACHE_TTL) {
    return radioStationsCache;
  }
  try {
    const response = await subsonicRequest(baseUrl, username, password, '/rest/getInternetRadioStations');
    const stations = response?.internetRadioStations?.internetRadioStation || [];
    // Normalisiere: Subsonic kann ein Objekt statt Array liefern wenn nur 1 Sender existiert
    radioStationsCache = Array.isArray(stations) ? stations : [stations];
    radioStationsCacheTime = now;
    return radioStationsCache;
  } catch (err) {
    console.warn('[navidrome] getRadioStations failed:', err.message);
    return radioStationsCache || [];
  }
}

function isRadioEntry(entry, radioStations) {
  if (!entry) return null;
  
  const stations = radioStations || [];

  // Direkter Match über Sender-ID, exakter Titel oder Album (oft als Sendername missbraucht)
  const exactMatch = stations.find(s =>
    String(s.id) === String(entry.id) ||
    (s.name && entry.title && s.name.toLowerCase() === entry.title.toLowerCase()) ||
    (s.name && entry.album && s.name.toLowerCase() === entry.album.toLowerCase())
  );
  if (exactMatch) return exactMatch;

  // Navidrome markiert Radio-Einträge manchmal speziell
  if (entry.streamUrl || entry.homepageUrl || entry.isVideo === true) {
    const streamMatch = stations.find(s =>
      s.name && entry.title && entry.title.toLowerCase().includes(s.name.toLowerCase())
    );
    if (streamMatch) return streamMatch;
  }

  // Heuristik: Radiosender haben typischerweise keine Album-ID und keine Track-Nummer.
  // Duration kann bei Live-Streams 0 oder undefined sein, manchmal aber auch >0
  const noAlbumId = !entry.albumId;
  const noTrack = !entry.track || entry.track === '0' || entry.track === 0;
  const shortOrNoDuration = !entry.duration || entry.duration === 0 || entry.duration < 30;
  
  if (noAlbumId && noTrack) {
    const titleMatch = stations.find(s =>
      (s.name && entry.title && entry.title.toLowerCase().includes(s.name.toLowerCase())) ||
      (s.name && entry.album && entry.album.toLowerCase().includes(s.name.toLowerCase()))
    );
    if (titleMatch) return titleMatch;
    
    // Generischer Radio-Eintrag, falls Heuristik stark auf Radio hindeutet
    if (shortOrNoDuration) {
      return { 
        name: entry.album || entry.title || 'Radiosender', 
        homepageUrl: null, 
        streamUrl: null 
      };
    }
  }
  
  return null;
}

async function getNowPlaying() {
  const settings = await getSettings();
  if (!settings || !settings.enabled || !settings.url || !settings.username || !settings.password_encrypted) {
    return null;
  }

  let password, response;
  try {
    password = decrypt(settings.password_encrypted);
    response = await subsonicRequest(settings.url, settings.username, password, '/rest/getNowPlaying');
  } catch (err) {
    console.warn('[navidrome] getNowPlaying failed:', err.message);
    return null;
  }

  const entries = response?.nowPlaying?.entry || [];
  const entry = entries.find((e) => e.username === settings.username);

  if (!entry) {
    return null;
  }

  // Radiosender-Erkennung
  const radioStations = await getRadioStations(settings.url, settings.username, password);
  const radioStation = isRadioEntry(entry, radioStations);

  // Navidrome-Status auswerten. Mögliche playerState-Werte: paused/playing.
  const state = (entry.playerState || entry.state || '').toString().toLowerCase();
  const isPaused = state === 'paused';

  // Pausierte Tracks verschwinden nach 2 Minuten aus der Anzeige.
  const PAUSED_TIMEOUT_MIN = 2;
  if (isPaused && (parseFloat(entry.minutesAgo) || 0) > PAUSED_TIMEOUT_MIN) {
    return null;
  }

  if (radioStation) {
    // Radio-Modus: Keine Position/Duration, spezielles Format
    return {
      playing: true,
      isRadio: true,
      title: radioStation.name || entry.title || 'Radiosender',
      artist: entry.artist || '',
      album: entry.album || '',
      duration: 0,
      bitrate: entry.bitRate || entry.bitrate || null,
      position: 0,
      coverUrl: entry.coverArt
        ? `/api/navidrome/cover-art?id=${encodeURIComponent(entry.coverArt)}`
        : null,
      coverId: entry.coverArt || null,
      paused: isPaused,
      url: settings.url,
      radioHomepage: radioStation.homepageUrl || null,
      radioStreamUrl: radioStation.streamUrl || null,
    };
  }

  // Navidrome sendet die Position als Millisekunden (positionMs) oder Sekunden (playerPosition).
  // Dieser Wert ist bereits die aktuelle Wiedergabeposition, daher wird minutesAgo
  // nicht mehr extra addiert (sonst laufen die Sekunden doppelt).
  const rawPositionMs = parseFloat(entry.positionMs);
  const playerPosition = Number.isFinite(rawPositionMs) ? rawPositionMs / 1000 : (parseFloat(entry.playerPosition) || 0);
  const position = playerPosition;

  const track = {
    playing: true,
    isRadio: false,
    id: entry.id || null,
    albumId: entry.albumId || null,
    title: entry.title || 'Unbekannt',
    artist: entry.artist || '',
    album: entry.album || '',
    duration: entry.duration || 0,
    bitrate: entry.bitRate || entry.bitrate || null,
    format: entry.suffix || null,
    position: Math.max(0, Math.min(position, entry.duration || position)),
    coverUrl: null,
    paused: isPaused,
    url: settings.url,
  };

  if (entry.coverArt) {
    track.coverUrl = `/api/navidrome/cover-art?id=${encodeURIComponent(entry.coverArt)}`;
    track.coverId = entry.coverArt;
  }

  return track;
}

// Ergebnis 2,5 s zwischenspeichern: Startseite (jeder Besucher alle 3 s), Admin-Vorschau,
// Musik-Verlauf und Discord-Webhook teilen sich so einen Abruf
const { shortCache } = require('./shortcache');
const getNowPlayingCached = shortCache(getNowPlaying, 2500);

module.exports = {
  getSettings,
  saveSettings,
  testConnection,
  probeServer,
  buildSubsonicUrl,
  subsonicRequest,
  getNowPlaying: getNowPlayingCached,
  getNowPlayingUncached: getNowPlaying,
  getRadioStations,
};

