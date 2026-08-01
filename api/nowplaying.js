// =========================================================
// Navidrome API – Now Playing Endpoint
// =========================================================
// Lokale Test-Version des Edge-Function nowPlaying-Endpoints.
//
// Aufruf:
//   node api/nowplaying.js
//
// Voraussetzungen:
//   - .env-Datei mit NAVIDROME_URL, NAVIDROME_USER, NAVIDROME_PASS
//   - oder Umgebungsvariablen direkt gesetzt
// =========================================================

require('dotenv').config();
const crypto = require('crypto');

// --- Helpers ---

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function randomSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// --- Subsonic API call ---

async function callNavidrome(action, extraParams = {}) {
  const url    = process.env.NAVIDROME_URL;
  const user   = process.env.NAVIDROME_USER;
  const pass   = process.env.NAVIDROME_PASS;
  if (!url || !user || !pass) {
    throw new Error('NAVIDROME_URL/USER/PASS env vars missing');
  }

  const salt   = randomSalt();
  const token  = md5(pass + salt);
  const params = new URLSearchParams({
    u: user, t: token, s: salt, v: '1.16.1', c: 'openweb-linktree', f: 'json',
    ...extraParams,
  });

  const r = await fetch(`${url.replace(/\/$/, '')}/rest/${action}?${params.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// --- Action: nowPlaying ---

async function getNowPlaying() {
  const data = await callNavidrome('getNowPlaying');
  const resp = data?.['subsonic-response'];
  const allEntries = resp?.nowPlaying?.entry;
  const entries = Array.isArray(allEntries) ? allEntries : (allEntries ? [allEntries] : []);

  // Nur Entries vom konfigurierten User
  const myEntries = entries.filter((e) =>
    String(e.username || '').toLowerCase() === process.env.NAVIDROME_USER.toLowerCase()
  );

  if (myEntries.length === 0) {
    return { playing: false, reason: 'no active player for this user' };
  }

  const entry = myEntries[0];
  const state = String(entry.state || '').toLowerCase();
  const minutesAgo = Number(entry.minutesAgo || 0);

  // Wenn paused und lange her -> als gestoppt werten
  if (state !== 'playing' && minutesAgo > 5) {
    return { playing: false, reason: `state=${state} minutesAgo=${minutesAgo}` };
  }

  return {
    playing: true,
    source: 'nowPlaying',
    title: entry.title || '',
    artist: entry.artist || '',
    album: entry.album || '',
    duration: Number(entry.duration || 0),
    position: Number(entry.player?.position || minutesAgo * 60 || 0),
    minutesAgo,
    player: entry.player?.name || '',
    state,
    id: entry.id || '',
    coverArt: entry.coverArt || '',
  };
}

// --- Main ---

(async () => {
  try {
    const track = await getNowPlaying();
    console.log(JSON.stringify(track, null, 2));
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
})();
