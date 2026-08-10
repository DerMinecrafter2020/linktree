// =========================================================
// OpenWeb — Audit-Log für Admin-Aktionen
// =========================================================

const db = require('./db');

async function log(req, action, entity = null, entityId = null, details = null) {
  const ip = req.ip || req.connection.remoteAddress || null;
  const userAgent = req.headers['user-agent']?.slice(0, 500) || null;
  const userId = req.session?.userId || null;
  try {
    await db.query(`
      INSERT INTO audit_log (user_id, action, entity, entity_id, ip_address, user_agent, details)
      VALUES ($1, $2, $3, $4, $5::inet, $6, $7)
    `, [userId, action, entity, entityId ? String(entityId).slice(0, 80) : null, ip, userAgent, details ? JSON.stringify(details) : null]);
  } catch (err) {
    console.warn('[audit] log failed:', err.message);
  }
}

async function list(limit = 200, offset = 0) {
  const { rows } = await db.query(`
    SELECT a.*, u.email AS user_email
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows;
}

module.exports = { log, list };
