// =========================================================
// Navidrome API — Status
// =========================================================
// Gibt Auskunft, ob die Navidrome-Credentials konfiguriert sind
// und ob die Library Alben enthaelt.
//
// Verwendung:
//   const status = await NavidromeAPI.status();
// =========================================================

window.NavidromeAPI = window.NavidromeAPI || {};
window.NavidromeAPI.status = window.NavidromeHelpers.safe(async function () {
  return await window.NavidromeAPI.post('status', {});
});
