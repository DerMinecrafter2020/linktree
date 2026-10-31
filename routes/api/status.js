const express = require('express');
const db = require('../../lib/db');
const { shortCache } = require('../../lib/shortcache');
const { fetchCurrentCover } = require('../../lib/musicassistant');
const { fetchCurrentCover: fetchSpotifyCover } = require('../../lib/spotify');
const { getActiveTrack } = require('../../lib/nowplaying');
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
    // Music Assistant, Spotify und Navidrome; Auswahl siehe lib/nowplaying.js.
    // Nur oeffentliche Felder ausgeben (keine internen Server-URLs)
    const track = await getActiveTrack();
    res.json({ ok: true, data: { ...toPublicTrack(track), player_progress_style: playerProgressStyle } });
  } catch (err) {
    console.error('[status] now-playing error:', err.message);
    res.json({ ok: true, data: { playing: false, player_progress_style: playerProgressStyle } });
  }
});

async function sendCover(res, loader, label) {
  try {
    const cover = await loader();
    if (!cover) return res.status(404).send('Kein Cover');
    res.setHeader('Content-Type', cover.contentType);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(cover.body);
  } catch (err) {
    console.warn(`[status] ${label} cover error:`, err.message);
    res.status(502).send('Cover nicht verfuegbar');
  }
}

// Cover des aktuellen Music-Assistant-Titels ueber die eigene Origin ausliefern
router.get('/cover', (req, res) => sendCover(res, fetchCurrentCover, 'musicassistant'));

// Cover des aktuellen Spotify-Titels (nur von i.scdn.co, siehe lib/spotify.js)
router.get('/spotify-cover', (req, res) => sendCover(res, fetchSpotifyCover, 'spotify'));

module.exports = router;
