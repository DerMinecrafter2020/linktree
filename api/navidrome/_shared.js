// =========================================================
// Shared helper for navidrome/api/ files
// =========================================================
// Wird vor den anderen API-Dateien geladen. Stellt Hilfsfunktionen
// bereit, die jede API-Datei nutzen kann.
// =========================================================

window.NavidromeHelpers = window.NavidromeHelpers || (function () {
  'use strict';

  function safe(fn) {
    // Wrappt eine Funktion in try/catch und loggt Fehler statt zu werfen
    return function (...args) {
      try { return fn.apply(this, args); }
      catch (e) { console.warn('[navidrome] error:', e.message); return null; }
    };
  }

  return { safe };
})();
