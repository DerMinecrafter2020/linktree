// =========================================================
// Initial-Setup Helfer
// =========================================================
// Prueft, ob die Anwendung eingerichtet ist, und fuehrt das
// erstmalige Setup durch (ueber die Web-Oberflaeche).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const ENV_FILE = path.join(process.cwd(), '.env');

function envPath() {
  return ENV_FILE;
}

function envFileExists() {
  return fs.existsSync(ENV_FILE);
}

function readEnvFile() {
  if (!envFileExists()) return '';
  return fs.readFileSync(ENV_FILE, 'utf8');
}

function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    env[key] = value;
  }
  return env;
}

function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

async function testDatabaseUrl(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await pool.end();
  }
}

async function hasAdminUser(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM users WHERE is_active = true');
    return rows[0].count > 0;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

async function isSetupRequired() {
  if (!envFileExists()) return true;
  const env = parseEnv(readEnvFile());
  if (!env.DATABASE_URL) return true;
  const dbTest = await testDatabaseUrl(env.DATABASE_URL);
  if (!dbTest.ok) return true;
  const hasAdmin = await hasAdminUser(env.DATABASE_URL);
  return !hasAdmin;
}

function buildEnvContent(config) {
  const sessionSecret = config.sessionSecret || generateSecret();
  const encryptionKey = config.encryptionKey || generateSecret();
  const port = config.port || '3000';
  const appUrl = config.appUrl || `http://localhost:${port}`;

  return `# OpenWeb — Umgebungsvariablen
# Automatisch durch das Initial-Setup erzeugt.

NODE_ENV=${config.nodeEnv || 'production'}
PORT=${port}
APP_URL=${appUrl}

DATABASE_URL=${config.databaseUrl}

SESSION_SECRET=${sessionSecret}
SESSION_MAX_AGE_MS=86400000

ADMIN_EMAIL=${config.adminEmail}
ADMIN_PASSWORD=${config.adminPassword}

NAVIDROME_ENCRYPTION_KEY=${encryptionKey}
NAVIDROME_URL=${config.navidromeUrl || ''}
NAVIDROME_USERNAME=${config.navidromeUsername || ''}
NAVIDROME_PASSWORD=${config.navidromePassword || ''}
NAVIDROME_POLL_INTERVAL_SEC=${config.navidromePollIntervalSec || '30'}
`;
}

async function performSetup(config) {
  const dbTest = await testDatabaseUrl(config.databaseUrl);
  if (!dbTest.ok) {
    throw new Error(`Datenbankverbindung fehlgeschlagen: ${dbTest.error}`);
  }

  // .env schreiben
  fs.writeFileSync(ENV_FILE, buildEnvContent(config), { mode: 0o600 });

  // Migrationen + Seeding
  const migrate = require('../db/migrate');
  await migrate.run();

  const seed = require('../db/seed');
  await seed.seed({
    adminEmail: config.adminEmail,
    adminPassword: config.adminPassword,
    profile: config.profile || {},
    links: config.links || [],
    navidrome: {
      url: config.navidromeUrl,
      username: config.navidromeUsername,
      password: config.navidromePassword,
    },
  });

  return { ok: true, restartRequired: true };
}

module.exports = {
  envPath,
  envFileExists,
  readEnvFile,
  parseEnv,
  isSetupRequired,
  testDatabaseUrl,
  performSetup,
  generateSecret,
};
