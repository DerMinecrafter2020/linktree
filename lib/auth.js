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

function isIpAllowed(req) {
  const raw = process.env.ADMIN_IP_ALLOWLIST;
  if (!raw) return true;
  const allowed = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.length) return true;
  const rawIp = req.ip || req.socket?.remoteAddress || '';
  const ip = rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;
  return allowed.some(a => ip === a || (a.includes('/') && ipRangeCheck(ip, a)));
}

function ipv4ToNumber(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((a, b) => a * 256 + Number(b), 0);
}

function ipRangeCheck(ip, cidr) {
  // Einfache IPv4-CIDR Prüfung (IPv6-Adressen matchen nie)
  const [range, bits] = cidr.split('/');
  if (!/^\d{1,2}$/.test(bits || '')) return false;
  const mask = parseInt(bits, 10);
  if (mask < 0 || mask > 32) return false;
  const ipNum = ipv4ToNumber(ip);
  const rangeNum = ipv4ToNumber(range);
  if (ipNum === null || rangeNum === null) return false;
  const size = 2 ** (32 - mask);
  return Math.floor(ipNum / size) === Math.floor(rangeNum / size);
}

async function requireAdminSession(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
  }
  if (!isIpAllowed(req)) {
    return res.status(403).json({ ok: false, error: 'Admin-Zugang von dieser IP nicht erlaubt' });
  }
  try {
    // Session nur gueltig, solange der Benutzer existiert und aktiv ist
    const { rows } = await db.query('SELECT 1 FROM users WHERE id = $1 AND is_active = true LIMIT 1', [req.session.userId]);
    if (!rows.length) {
      return req.session.destroy(() => res.status(401).json({ ok: false, error: 'Nicht angemeldet' }));
    }
  } catch (err) {
    return next(err);
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  findUserByEmail,
  requireAdminSession,
  isIpAllowed,
};
