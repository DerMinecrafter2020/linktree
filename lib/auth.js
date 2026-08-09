// =========================================================
// Authentifizierungs-Helper
// =========================================================

const bcrypt = require('bcrypt');
const db = require('./db');

const SALT_ROUNDS = 12;

async function hashPassword(password) {
  return bcrypt.hash(String(password), SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(String(password), hash);
}

async function findUserByEmail(email) {
  const { rows } = await db.query(
    'SELECT * FROM users WHERE email = $1 AND is_active = true LIMIT 1',
    [email.toLowerCase()]
  );
  return rows[0] || null;
}

function requireAdminSession(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  findUserByEmail,
  requireAdminSession,
};
