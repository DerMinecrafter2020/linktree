// =========================================================
// Aktive "Now Playing"-Quelle bestimmen
// =========================================================
// Gemeinsame Auswahl fuer Startseite (/api/status/now-playing), Musik-Verlauf und Discord-Webhook,
// damit alle drei dieselbe Quelle anzeigen. Alle Quellen sind per shortCache zwischengespeichert.
//
// Reihenfolge: Was gerade laeuft, gewinnt vor Pausiertem. Laufen mehrere Quellen gleichzeitig,
// gilt Music Assistant -> Spotify -> Navidrome.

const SOURCES = ['musicassistant', 'spotify', 'navidrome'];

async function safeCall(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function getActiveTrack() {
  const [ma, spotify, navidrome] = await Promise.all([
    safeCall(() => require('./musicassistant').getNowPlaying()),
    safeCall(() => require('./spotify').getNowPlaying()),
    safeCall(() => require('./navidrome').getNowPlaying()),
  ]);
  // Quelle ergaenzen, ohne die gecachten (geteilten) Objekte zu veraendern
  const candidates = [
    ma && { ...ma, source: 'musicassistant' },
    spotify && { ...spotify, source: 'spotify' },
    navidrome && { ...navidrome, source: 'navidrome' },
  ].filter((t) => t && t.playing === true);

  return candidates.find((t) => !t.paused) || candidates[0] || { playing: false };
}

module.exports = { getActiveTrack, SOURCES };
