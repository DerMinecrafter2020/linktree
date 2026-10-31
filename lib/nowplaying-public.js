// =========================================================
// Oeffentliche Darstellung von "Now Playing"
// =========================================================
// Die internen Track-Objekte (lib/navidrome.js, lib/musicassistant.js) enthalten Daten, die nur
// serverseitig gebraucht werden (Basis-URL des Navidrome-Servers, interne Cover-URL von
// Music Assistant). An Besucher geht nur diese Feldliste.

const PUBLIC_FIELDS = [
  'playing', 'paused', 'isRadio', 'title', 'artist', 'album', 'duration', 'position',
  'bitrate', 'format', 'coverUrl', 'source', 'radioHomepage', 'radioStreamUrl',
];

function toPublicTrack(track) {
  if (!track) return { playing: false };
  const out = {};
  for (const key of PUBLIC_FIELDS) {
    if (track[key] !== undefined) out[key] = track[key];
  }
  // Cover-URLs nur als eigene, relative Proxy-Pfade ausliefern
  if (typeof out.coverUrl === 'string' && !out.coverUrl.startsWith('/api/')) out.coverUrl = null;
  return out;
}

module.exports = { toPublicTrack, PUBLIC_FIELDS };
