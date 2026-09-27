// =========================================================
// OpenWeb — Kurzzeit-Cache fuer teure Abfragen
// =========================================================
// Haelt das Ergebnis einer async-Funktion fuer ttlMs und teilt laufende Abrufe:
// Fragen 50 Besucher gleichzeitig "Was laeuft gerade?", geht nur EINE Anfrage an
// Navidrome/Music Assistant raus.

function shortCache(fn, ttlMs) {
  let value;
  let expires = 0;
  let inflight = null;

  return function cached() {
    if (Date.now() < expires) return Promise.resolve(value);
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(fn)
      .then((result) => {
        value = result;
        expires = Date.now() + ttlMs;
        return result;
      })
      .finally(() => { inflight = null; });
    return inflight;
  };
}

module.exports = { shortCache };
