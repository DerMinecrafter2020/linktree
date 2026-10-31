// =========================================================
// Oeffentliche Darstellung von "Now Playing"
// =========================================================
// Die internen Track-Objekte (lib/navidrome.js, lib/musicassistant.js, lib/spotify.js) enthalten
// Daten, die nur serverseitig gebraucht werden (Basis-URL des Navidrome-Servers, interne
// Cover-URLs, Spotify-Link fuer Discord). An Besucher geht nur diese Feldliste.

const PUBLIC_FIELDS = [
  'playing', 'paused', 'isRadio', 'title', 'artist', 'album', 'duration', 'position',
  'bitrate', 'format', 'coverUrl', 'source', 'radioHomepage', 'radioStreamUrl',
];
const PUBLIC_SOURCES = new Set(['navidrome', 'musicassistant', 'spotify']);

function toPublicTrack(track) {
  if (!track) return { playing: false };
  const out = {};
  for (const key of PUBLIC_FIELDS) {
    if (track[key] !== undefined) out[key] = track[key];
  }
  // Cover-URLs nur als eigene, relative Proxy-Pfade ausliefern
  if (typeof out.coverUrl === 'string' && !out.coverUrl.startsWith('/api/')) out.coverUrl = null;
  // Quelle nur aus der festen Liste (das Frontend waehlt daraus das Quellen-Icon)
  if (out.source !== undefined && !PUBLIC_SOURCES.has(out.source)) delete out.source;
  return out;
}

module.exports = { toPublicTrack, PUBLIC_FIELDS, PUBLIC_SOURCES };
