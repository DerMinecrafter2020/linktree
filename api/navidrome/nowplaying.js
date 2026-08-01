// =========================================================
// Navidrome API — Now Playing
// =========================================================
// Gibt den aktuell spielenden Track zurueck (oder paused/stopped).
// Server liefert { playing: bool, title, artist, album, position,
//   duration, paused, ... }.
//
// Verwendung:
//   const data = await NavidromeAPI.nowPlaying();
//   if (data && data.playing) { ... }
// =========================================================

window.NavidromeAPI = window.NavidromeAPI || {};
window.NavidromeAPI.nowPlaying = window.NavidromeHelpers.safe(async function () {
  return await window.NavidromeAPI.post('nowPlaying', {});
});
