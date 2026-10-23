const express = require('express');
const db = require('../../lib/db');
const { shortCache } = require('../../lib/shortcache');
const { getNowPlaying: getNavidromePlaying } = require('../../lib/navidrome');
const { getNowPlaying: getMAPlaying } = require('../../lib/musicassistant');

const router = express.Router();
const getPlayerProgressStyle = shortCache(async () => {
  const { rows } = await db.query('SELECT player_progress_style FROM profile WHERE id = 1 LIMIT 1');
  return rows[0]?.player_progress_style === 'line' ? 'line' : 'time';
}, 1000);

router.get('/now-playing', async (req, res, next) => {
  let playerProgressStyle = 'time';
  try {
    playerProgressStyle = await getPlayerProgressStyle();
    // 1. Fetch from both
    const [maTrack, ndTrack] = await Promise.all([getMAPlaying(), getNavidromePlaying()]);
    const respond = (track) => res.json({
      ok: true,
      data: { ...(track || { playing: false }), player_progress_style: playerProgressStyle }
    });

    // 2. Determine which one is actively playing
    if (maTrack && maTrack.playing && !maTrack.paused) {
      return respond(maTrack);
    }
    if (ndTrack && ndTrack.playing && !ndTrack.paused) {
      ndTrack.source = 'navidrome';
      return respond(ndTrack);
    }

    // 3. If neither is actively playing, show paused from whichever has it
    if (maTrack && maTrack.playing) {
      return respond(maTrack);
    }
    if (ndTrack && ndTrack.playing) {
      ndTrack.source = 'navidrome';
      return respond(ndTrack);
    }

    // Nothing playing
    return respond({ playing: false });
  } catch (err) {
    console.error('[status] now-playing error:', err.message);
    res.json({ ok: true, data: { playing: false, player_progress_style: playerProgressStyle } });
  }
});

module.exports = router;
