// =========================================================
// Öffentliche API-Routen
// =========================================================

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const v = require('../lib/validators');

const router = express.Router();

// Einfacher In-Memory Rate-Limiter fuer /api/login (Brute-Force-Schutz)
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 Minuten
const LOGIN_MAX_ATTEMPTS = 10;

function rateLimitLogin(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (record && record.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    if (now < record.resetAt) {
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ ok: false, error: `Zu viele Anmeldeversuche. Bitte in ${retryAfter} Sekunden erneut versuchen.` });
    }
  }
  req.loginRateLimit = {
    ip,
    record,
    increment: (failed) => {
      if (!failed) {
        loginAttempts.delete(ip);
        return;
      }
      const r = loginAttempts.get(ip);
      if (r && now < r.resetAt) {
        r.count += 1;
      } else {
        loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      }
    },
  };
  next();
}

// Alte Eintraege regelmaessig aufraeumen
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts.entries()) {
    if (now >= record.resetAt) loginAttempts.delete(ip);
  }
}, 60 * 1000);

router.get('/profile', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM profile WHERE id = 1 LIMIT 1');
    const profile = rows[0] || {
      name: '@corneliusahner',
      handle: 'Cornelius Ahner',
      bio: 'Azubi, 21 Jahre alt',
      avatar: 'CA',
      avatar_url: null,
      theme: 'dark',
    };
    res.json({ ok: true, data: profile });
  } catch (err) {
    next(err);
  }
});

router.get('/links', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, title, subtitle, url, display_url, icon, position, is_active, open_new
      FROM links
      WHERE is_active = true
      ORDER BY position ASC, created_at ASC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/login', rateLimitLogin, async (req, res, next) => {
  try {
    const email = v.validateEmail(req.body.email);
    const password = req.body.password;
    if (!email || !password) {
      req.loginRateLimit?.increment(true);
      return res.status(400).json({ ok: false, error: 'E-Mail und Passwort erforderlich' });
    }

    const user = await auth.findUserByEmail(email);
    if (!user) {
      req.loginRateLimit?.increment(true);
      return res.status(401).json({ ok: false, error: 'Ungueltige Anmeldedaten' });
    }

    const valid = await auth.verifyPassword(password, user.password_hash);
    if (!valid) {
      req.loginRateLimit?.increment(true);
      return res.status(401).json({ ok: false, error: 'Ungueltige Anmeldedaten' });
    }

    req.loginRateLimit?.increment(false);

    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.touch();

    res.json({ ok: true, data: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
