// =========================================================
// Öffentliche API-Routen
// =========================================================

const express = require('express');
const db = require('../lib/db');
const auth = require('../lib/auth');
const v = require('../lib/validators');

const router = express.Router();

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

router.post('/login', async (req, res, next) => {
  try {
    const email = v.validateEmail(req.body.email);
    const password = req.body.password;
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'E-Mail und Passwort erforderlich' });
    }

    const user = await auth.findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Ungueltige Anmeldedaten' });
    }

    const valid = await auth.verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'Ungueltige Anmeldedaten' });
    }

    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.touch();

    res.json({ ok: true, data: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
