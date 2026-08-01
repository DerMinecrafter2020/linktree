// =========================================================
// Navidrome API — Player Control
// =========================================================
// Steuert den Player (play/pause/next/previous).
//
// Verwendung:
//   await NavidromeAPI.control('play');
//   await NavidromeAPI.control('pause');
//   await NavidromeAPI.control('next');
//   await NavidromeAPI.control('previous');
// =========================================================

window.NavidromeAPI = window.NavidromeAPI || {};
window.NavidromeAPI.control = window.NavidromeHelpers.safe(async function (action) {
  if (!action) throw new Error('control action required (play|pause|next|previous)');
  return await window.NavidromeAPI.post('control', { controlAction: action });
});
