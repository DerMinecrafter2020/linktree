// =========================================================
// Navidrome API — Cover Art
// =========================================================
// Laedt ein Cover-Art-Bild und gibt es als Base64-DataURL zurueck.
//
// Verwendung:
//   const dataUrl = await NavidromeAPI.coverArt('mf-abc123', 300);
// =========================================================

window.NavidromeAPI = window.NavidromeAPI || {};
window.NavidromeAPI.coverArt = window.NavidromeHelpers.safe(async function (id, size) {
  if (!id) throw new Error('coverArt id required');
  return await window.NavidromeAPI.post('coverArt', { id: id, size: size || 220 });
});
