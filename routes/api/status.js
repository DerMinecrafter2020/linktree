const express = require('express');
const { getNowPlaying: getNavidromePlaying } = require('../../lib/navidrome');
const { getNowPlaying: getMAPlaying } = require('../../lib/musicassistant');

const router = express.Router();

router.get('/now-playing', async (req, res, next) => {
  try {
    // 1. Fetch from both
    const maTrack = await getMAPlaying();
    const ndTrack = await getNavidromePlaying();

    // 2. Determine which one is actively playing
    if (maTrack && maTrack.playing && !maTrack.paused) {
      return res.json({ ok: true, data: maTrack });
    }
    if (ndTrack && ndTrack.playing && !ndTrack.paused) {
      ndTrack.source = 'navidrome';
      return res.json({ ok: true, data: ndTrack });
    }

    // 3. If neither is actively playing, show paused from whichever has it
    if (maTrack && maTrack.playing) {
      return res.json({ ok: true, data: maTrack });
    }
    if (ndTrack && ndTrack.playing) {
      ndTrack.source = 'navidrome';
      return res.json({ ok: true, data: ndTrack });
    }

    // Nothing playing
    res.json({ ok: true, data: { playing: false } });
  } catch (err) {
    console.error('[status] now-playing error:', err.message);
    res.json({ ok: true, data: { playing: false, error: err.message } });
  }
});

module.exports = router;
