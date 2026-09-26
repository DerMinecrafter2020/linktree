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
    res.json({ ok: true, data: { playing: false } });
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
    if (!id || typeof id !== 'string' || id.length > 200) return res.status(400).send('id fehlt');
    const size = Math.min(2000, Math.max(16, parseInt(req.query.size, 10) || 300));

    const url = buildSubsonicUrl(settings.url, settings.username, password, '/rest/getCoverArt', {
      id,
      size,
    });

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).send('Cover-Art-Fehler');
    }

    // Nur Rasterbilder durchreichen (kein HTML/SVG von fremdem Server auf eigener Origin)
    const contentType = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(contentType)) {
      return res.status(415).send('Ungueltiger Bildtyp');
    }
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

    const action = String(req.body.action || '').replace(/[^\w-]/g, '').slice(0, 40);

    console.log(`[navidrome] Steuerungsaktion empfangen: ${action}`);
    res.json({ ok: true, data: { action, note: 'Subsonic-Steuerung wird serverseitig protokolliert' } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
