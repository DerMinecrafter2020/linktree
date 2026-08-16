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

function ipRangeCheck(ip, cidr) {
  // Einfache IPv4-CIDR Prüfung
  const [range, bits] = cidr.split('/');
  const mask = parseInt(bits, 10);
  if (isNaN(mask) || mask < 0 || mask > 32) return false;
  const ipNum = ip.split('.').reduce((a, b) => (a << 8) + parseInt(b, 10), 0) >>> 0;
  const rangeNum = range.split('.').reduce((a, b) => (a << 8) + parseInt(b, 10), 0) >>> 0;
  const shift = 32 - mask;
  return (ipNum >> shift) === (rangeNum >> shift);
}

function requireAdminSession(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
  }
  if (!isIpAllowed(req)) {
    return res.status(403).json({ ok: false, error: 'Admin-Zugang von dieser IP nicht erlaubt' });
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
