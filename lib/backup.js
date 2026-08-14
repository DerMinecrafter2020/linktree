// =========================================================
// OpenWeb — Automatische JSON-Backups
// =========================================================

const fs = require('fs');
const path = require('path');
const db = require('./db');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function backupPath(date = new Date()) {
  ensureDir();
  const stamp = date.toISOString().slice(0, 10);
  return path.join(BACKUP_DIR, `openweb-backup-${stamp}.json`);
}

async function createBackup() {
  ensureDir();
  const [profileRes, linksRes, categoriesRes, settingsRes] = await Promise.all([
    db.query('SELECT * FROM profile WHERE id = 1 LIMIT 1'),
    db.query('SELECT * FROM links ORDER BY position ASC'),
    db.query('SELECT * FROM link_categories ORDER BY position ASC'),
    db.query('SELECT id, admin_enabled, discord_webhook_enabled, discord_webhook_url, discord_webhook_template FROM admin_settings WHERE id = 1 LIMIT 1'),
  ]);

  const data = {
    version: 3,
    exportedAt: new Date().toISOString(),
    profile: profileRes.rows[0] || null,
    links: linksRes.rows,
    link_categories: categoriesRes.rows,
    admin_settings: settingsRes.rows[0] || null,
  };

  const file = backupPath();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

function listBackups() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('openweb-backup-') && f.endsWith('.json'))
    .map(f => {
      const full = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(full);
      return { name: f, path: full, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

module.exports = { createBackup, listBackups, backupPath, BACKUP_DIR };
