const express = require('express');
const db = require('../../lib/db');
const { shortCache } = require('../../lib/shortcache');
const { getNowPlaying: getNavidromePlaying } = require('../../lib/navidrome');
const { getNowPlaying: getMAPlaying, fetchCurrentCover } = require('../../lib/musicassistant');
const { toPublicTrack } = require('../../lib/nowplaying-public');

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
    // Nur oeffentliche Felder ausgeben (keine internen Server-URLs); geteiltes Cache-Objekt nicht veraendern
    const respond = (track, source) => res.json({
      ok: true,
      data: { ...toPublicTrack(track && source ? { ...track, source } : track), player_progress_style: playerProgressStyle }
    });

    // 2. Determine which one is actively playing
    if (maTrack && maTrack.playing && !maTrack.paused) {
      return respond(maTrack);
    }
    if (ndTrack && ndTrack.playing && !ndTrack.paused) {
      return respond(ndTrack, 'navidrome');
    }

    // 3. If neither is actively playing, show paused from whichever has it
    if (maTrack && maTrack.playing) {
      return respond(maTrack);
    }
    if (ndTrack && ndTrack.playing) {
      return respond(ndTrack, 'navidrome');
    }

    // Nothing playing
    return respond({ playing: false });
  } catch (err) {
    console.error('[status] now-playing error:', err.message);
    res.json({ ok: true, data: { playing: false, player_progress_style: playerProgressStyle } });
  }
});

// Cover des aktuellen Music-Assistant-Titels ueber die eigene Origin ausliefern
router.get('/cover', async (req, res) => {
  try {
    const cover = await fetchCurrentCover();
    if (!cover) return res.status(404).send('Kein Cover');
    res.setHeader('Content-Type', cover.contentType);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(cover.body);
  } catch (err) {
    console.warn('[status] cover error:', err.message);
    res.status(502).send('Cover nicht verfuegbar');
  }
});

module.exports = router;
