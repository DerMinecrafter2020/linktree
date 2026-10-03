// =========================================================
// OpenWeb — Wartungs-Helfer (Sessions + Analytics aufräumen)
// =========================================================

const db = require('./db');
const metrics = require('./metrics');

const RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '365', 10);

async function cleanupSessions() {
  const { rowCount } = await db.query(`
    DELETE FROM user_sessions
    WHERE expire < NOW()
  `);
  return { sessionsRemoved: rowCount };
}

async function cleanupAnalytics() {
  const { rowCount } = await db.query(
    `DELETE FROM link_clicks WHERE clicked_at < NOW() - $1 * INTERVAL '1 day'`,
    [RETENTION_DAYS]
  );
  return { clicksRemoved: rowCount };
}

async function cleanupMonitorMetrics() {
  const { rowCount } = await db.query(
    `DELETE FROM resource_monitor_samples WHERE sampled_at < NOW() - $1 * INTERVAL '1 day'`,
    [metrics.RETENTION_DAYS]
  );
  return { monitorSamplesRemoved: rowCount };
}

async function runMaintenance() {
  const sessions = await cleanupSessions();
  const analytics = await cleanupAnalytics();
  const monitor = await cleanupMonitorMetrics();
  return {
    ...sessions,
    ...analytics,
    ...monitor,
    retentionDays: RETENTION_DAYS,
    monitorRetentionDays: metrics.RETENTION_DAYS,
  };
}

module.exports = {
  cleanupSessions,
  cleanupAnalytics,
  cleanupMonitorMetrics,
  runMaintenance,
};
