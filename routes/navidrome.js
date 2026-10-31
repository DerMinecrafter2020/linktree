// =========================================================
// Navidrome-Proxy (Subsonic-API)
// =========================================================
// Credentials kommen aus der PostgreSQL-DB und werden serverseitig
// entschluesseelt. Der Browser sieht URL/User/Passwort nie.

const express = require('express');
const { decrypt } = require('../lib/crypto');
const { getNowPlaying, buildSubsonicUrl, getSettings } = require('../lib/navidrome');
const { requireAdminSession } = require('../lib/auth');
const { toPublicTrack } = require('../lib/nowplaying-public');

const COVER_MAX_BYTES = 5 * 1024 * 1024;

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

    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return res.status(response.status).send('Cover-Art-Fehler');
    }

    // Nur Rasterbilder durchreichen (kein HTML/SVG von fremdem Server auf eigener Origin)
    const contentType = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(contentType)) {
      return res.status(415).send('Ungueltiger Bildtyp');
    }
    if (Number(response.headers.get('content-length') || 0) > COVER_MAX_BYTES) {
      return res.status(502).send('Cover zu gross');
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > COVER_MAX_BYTES) return res.status(502).send('Cover zu gross');
      chunks.push(chunk);
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(Buffer.concat(chunks));
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
