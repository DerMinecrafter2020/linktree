// =========================================================
// Navidrome-Proxy (Subsonic-API)
// =========================================================
// Credentials kommen aus der PostgreSQL-DB und werden serverseitig
// entschluesseelt. Der Browser sieht URL/User/Passwort nie.

const express = require('express');
const { getNowPlaying, getSettings, fetchCoverArt } = require('../lib/navidrome');
const { requireAdminSession } = require('../lib/auth');
const { toPublicTrack } = require('../lib/nowplaying-public');

const router = express.Router();

router.get('/now-playing', async (req, res, next) => {
  try {
    const track = await getNowPlaying();
    if (!track) {
      return res.json({ ok: true, data: { playing: false } });
    }
    // Nur oeffentliche Felder (u. a. nicht die Navidrome-Basis-URL)
    res.json({ ok: true, data: toPublicTrack(track) });
  } catch (err) {
    console.error('[navidrome] now-playing error:', err.message);
    res.json({ ok: true, data: { playing: false } });
  }
});

router.get('/cover-art', async (req, res, next) => {
  try {
    // Laden und Pruefen (Rasterbild, Groesse, Zeitlimit) in lib/navidrome.js – auch fuer Discord genutzt
    const cover = await fetchCoverArt(req.query.id, req.query.size);
    if (!cover.ok) return res.status(cover.status).send(cover.message);
    res.setHeader('Content-Type', cover.contentType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(cover.body);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return res.status(504).send('Navidrome antwortet nicht');
    next(err);
  }
});

router.post('/control', requireAdminSession, async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings || !settings.enabled || !settings.url || !settings.username || !settings.password_encrypted) {
      return res.status(400).json({ ok: false, error: 'Navidrome nicht konfiguriert' });
    }

    const action = String(req.body.action || '').replace(/[^\w-]/g, '').slice(0, 40);

    console.log(`[navidrome] Steuerungsaktion empfangen: ${action}`);
    res.json({ ok: true, data: { action, note: 'Subsonic-Steuerung wird serverseitig protokolliert' } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
