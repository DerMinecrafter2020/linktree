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

function getNowInBerlin() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
}

function isLinkVisible(link, nowBerlin) {
  if (!link.is_active) return false;
  if (link.visible_from) {
    const from = new Date(link.visible_from);
    if (from > nowBerlin) return false;
  }
  if (link.visible_until) {
    const until = new Date(link.visible_until);
    if (until < nowBerlin) return false;
  }
  if (Array.isArray(link.visible_weekdays) && link.visible_weekdays.length) {
    const weekday = nowBerlin.getDay();
    if (!link.visible_weekdays.includes(weekday)) return false;
  }
  return true;
}

router.get('/links', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT l.id, l.title, l.subtitle, l.url, l.display_url, l.icon, l.position,
             l.is_active, l.open_new, l.meta_description, l.slug,
             l.visible_from, l.visible_until, l.visible_weekdays,
             l.category_id, c.name AS category_name, c.position AS category_position
      FROM links l
      LEFT JOIN link_categories c ON c.id = l.category_id
      WHERE l.is_active = true
      ORDER BY c.position ASC NULLS FIRST, c.name ASC, l.position ASC, l.created_at ASC
    `);
    const nowBerlin = getNowInBerlin();
    const visible = rows.filter(l => isLinkVisible(l, nowBerlin));
    res.json({ ok: true, data: visible });
  } catch (err) {
    next(err);
  }
});

router.post('/links/:id/click', async (req, res, next) => {
  try {
    const { id } = req.params;
    const ip = req.ip || req.connection.remoteAddress || null;
    const ipHash = ip ? require('crypto').createHash('sha256').update(ip).digest('hex') : null;
    await db.query(`
      INSERT INTO link_clicks (link_id, ip_hash, user_agent, referrer)
      VALUES ($1, $2, $3, $4)
    `, [id, ipHash, req.headers['user-agent']?.slice(0, 500) || null, req.headers.referer?.slice(0, 500) || null]);
    res.json({ ok: true });
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
