// =========================================================
// Navidrome-Helfer (serverseitig)
// =========================================================
// Wird von Routes und vom Open-Graph-Handler genutzt.

const crypto = require('crypto');
const db = require('./db');
const { decrypt } = require('./crypto');

async function getSettings() {
  const { rows } = await db.query('SELECT * FROM navidrome_settings WHERE id = 1 LIMIT 1');
  return rows[0] || null;
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

module.exports = {
  getSettings,
  buildSubsonicUrl,
  subsonicRequest,
  getNowPlaying,
  getRadioStations,
};

