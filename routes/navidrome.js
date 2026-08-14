// =========================================================
// Navidrome-Proxy (Subsonic-API)
// =========================================================
// Credentials kommen aus der PostgreSQL-DB und werden serverseitig
// entschluesseelt. Der Browser sieht URL/User/Passwort nie.

const express = require('express');
const { decrypt } = require('../lib/crypto');
const { getNowPlaying, buildSubsonicUrl, getSettings } = require('../lib/navidrome');
const { requireAdminSession } = require('../lib/auth');

const router = express.Router();

router.get('/now-playing', async (req, res, next) => {
  try {
    const track = await getNowPlaying();
    if (!track) {
      return res.json({ ok: true, data: { playing: false } });
    }
    res.json({ ok: true, data: track });
  } catch (err) {
    console.error('[navidrome] now-playing error:', err.message);
    res.json({ ok: true, data: { playing: false, error: err.message } });
  }
});

router.get('/cover-art', async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings || !settings.enabled || !settings.url || !settings.username || !settings.password_encrypted) {
      return res.status(404).send('Navidrome nicht konfiguriert');
    }

    const password = decrypt(settings.password_encrypted);
    const id = req.query.id;
    if (!id) return res.status(400).send('id fehlt');

    const url = buildSubsonicUrl(settings.url, settings.username, password, '/rest/getCoverArt', {
      id,
      size: req.query.size || 300,
    });

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).send('Cover-Art-Fehler');
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.post('/control', requireAdminSession, async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings || !settings.enabled || !settings.url || !settings.username || !settings.password_encrypted) {
      return res.status(400).json({ ok: false, error: 'Navidrome nicht konfiguriert' });
    }

    const password = decrypt(settings.password_encrypted);
    const action = req.body.action;

    console.log(`[navidrome] Steuerungsaktion empfangen: ${action}`);
    res.json({ ok: true, data: { action, note: 'Subsonic-Steuerung wird serverseitig protokolliert' } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
