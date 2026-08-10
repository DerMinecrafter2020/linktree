// =========================================================
// OpenWeb — Wartungs-Helfer (Sessions + Analytics aufräumen)
// =========================================================

const db = require('./db');

const RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '365', 10);

async function cleanupSessions() {
  const { rowCount } = await db.query(`
    DELETE FROM user_sessions
    WHERE expire < NOW()
  `);
  return { sessionsRemoved: rowCount };
}

async function cleanupAnalytics() {
  const { rowCount } = await db.query(`
    DELETE FROM link_clicks
    WHERE clicked_at < NOW() - INTERVAL '${RETENTION_DAYS} days'
  `);
  return { clicksRemoved: rowCount };
}

async function runMaintenance() {
  const sessions = await cleanupSessions();
  const analytics = await cleanupAnalytics();
  return { ...sessions, ...analytics, retentionDays: RETENTION_DAYS };
}

module.exports = {
  cleanupSessions,
  cleanupAnalytics,
  runMaintenance,
};
