// =========================================================
// Navidrome-Proxy (Subsonic-API)
// =========================================================
// Credentials kommen aus der PostgreSQL-DB und werden serverseitig
// entschluesselt. Der Browser sieht URL/User/Passwort nie.

const express = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const { decrypt } = require('../lib/crypto');

const router = express.Router();

async function getSettings() {
  const { rows } = await db.query('SELECT * FROM navidrome_settings WHERE id = 1 LIMIT 1');
  return rows[0] || null;
}

function buildSubsonicUrl(baseUrl, username, password, endpoint, params = {}) {
  const salt = crypto.randomBytes(8).toString('hex');
  const token = crypto.createHash('md5').update(password + salt).digest('hex');
  const url = new URL(endpoint, baseUrl);
  url.searchParams.set('u', username);
  url.searchParams.set('t', token);
  url.searchParams.set('s', salt);
  url.searchParams.set('v', '1.13.0');
  url.searchParams.set('c', 'openweb');
  url.searchParams.set('f', 'json');
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  return url.toString();
}

async function subsonicRequest(baseUrl, username, password, endpoint, params) {
  const url = buildSubsonicUrl(baseUrl, username, password, endpoint, params);
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Ungueltige Navidrome-Antwort');
  }
  if (json['subsonic-response']?.status === 'failed') {
    throw new Error(json['subsonic-response'].error?.message || 'Navidrome-Fehler');
  }
  return json['subsonic-response'];
}

router.get('/now-playing', async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings || !settings.enabled || !settings.url || !settings.username || !settings.password_encrypted) {
      return res.json({ ok: true, data: { playing: false } });
    }

    const password = decrypt(settings.password_encrypted);
    const response = await subsonicRequest(settings.url, settings.username, password, '/rest/getNowPlaying');

    const entries = response?.nowPlaying?.entry || [];
    const entry = entries.find((e) => e.username === settings.username) || entries[0];

    if (!entry) {
      return res.json({ ok: true, data: { playing: false, url: settings.url } });
    }

    const track = {
      playing: true,
      title: entry.title || 'Unbekannt',
      artist: entry.artist || entry.album || '',
      album: entry.album || '',
      duration: entry.duration || 0,
      coverUrl: null,
      paused: entry.playerState === 'paused' || false,
      url: settings.url,
    };

    if (entry.coverArt) {
      const coverUrl = buildSubsonicUrl(settings.url, settings.username, password, '/rest/getCoverArt', { id: entry.coverArt, size: 300 });
      track.coverUrl = `/api/navidrome/cover-art?id=${encodeURIComponent(entry.coverArt)}`;
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

router.post('/control', async (req, res, next) => {
  try {
    const settings = await getSettings();
    if (!settings || !settings.enabled || !settings.url || !settings.username || !settings.password_encrypted) {
      return res.status(400).json({ ok: false, error: 'Navidrome nicht konfiguriert' });
    }

    const password = decrypt(settings.password_encrypted);
    const action = req.body.action;
    const endpointMap = {
      play: '/rest/scrobble',
      pause: '/rest/scrobble',
      next: '/rest/scrobble',
      previous: '/rest/scrobble',
    };

    if (!endpointMap[action]) {
      return res.status(400).json({ ok: false, error: 'Unbekannte Aktion' });
    }

    // Subsonic hat keine direkte Steuerungs-API; wir simulieren eine Bestaetigung
    // und loggen die Aktion. Echte Player-Steuerung erfordert einen Navidrome-Client.
    console.log(`[navidrome] Steuerungsaktion empfangen: ${action}`);
    res.json({ ok: true, data: { action, note: 'Subsonic-Steuerung wird serverseitig protokolliert' } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
