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

async function getNowPlaying() {
  const settings = await getSettings();
  if (!settings || !settings.enabled || !settings.url || !settings.username || !settings.password_encrypted) {
    return null;
  }

  const password = decrypt(settings.password_encrypted);
  const response = await subsonicRequest(settings.url, settings.username, password, '/rest/getNowPlaying');

  const entries = response?.nowPlaying?.entry || [];
  const entry = entries.find((e) => e.username === settings.username);

  if (!entry) {
    return null;
  }

  // Navidrome-Status auswerten. Mögliche playerState-Werte: paused/playing.
  const state = (entry.playerState || entry.state || '').toString().toLowerCase();
  const isPaused = state === 'paused';
  // Navidrome sendet die Position als Millisekunden (positionMs) oder Sekunden (playerPosition).
  // Dieser Wert ist bereits die aktuelle Wiedergabeposition, daher wird minutesAgo
  // nicht mehr extra addiert (sonst laufen die Sekunden doppelt).
  const rawPositionMs = parseFloat(entry.positionMs);
  const playerPosition = Number.isFinite(rawPositionMs) ? rawPositionMs / 1000 : (parseFloat(entry.playerPosition) || 0);
  const position = playerPosition;

  const track = {
    playing: true,
    title: entry.title || 'Unbekannt',
    artist: entry.artist || '',
    album: entry.album || '',
    duration: entry.duration || 0,
    bitrate: entry.bitRate || entry.bitrate || null,
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
};
