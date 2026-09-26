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
  } catch (err) {
    // Tabelle existiert noch nicht -> frische Datenbank, Setup noetig
    if (err.code === '42P01') return false;
    throw err;
  } finally {
    await pool.end();
  }
}

class DatabaseUnavailableError extends Error {}

// DATABASE_URL aus der Umgebung (z. B. Docker env_file) oder aus der .env-Datei
function configuredDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (!envFileExists()) return null;
  return parseEnv(readEnvFile()).DATABASE_URL || null;
}

async function isSetupRequired() {
  const databaseUrl = configuredDatabaseUrl();
  if (!databaseUrl) return true;
  const dbTest = await testDatabaseUrl(databaseUrl);
  // Konfigurierte, aber (voruebergehend) nicht erreichbare DB ist KEIN Grund fuer den
  // oeffentlichen Setup-Modus – sonst koennte ein Fremder die .env ueberschreiben.
  if (!dbTest.ok) throw new DatabaseUnavailableError(`Datenbank nicht erreichbar: ${dbTest.error}`);
  const hasAdmin = await hasAdminUser(databaseUrl);
  return !hasAdmin;
}

// Werte fuer die .env: Zeilenumbrueche entfernen (keine Injection weiterer Variablen)
function envValue(value) {
  return String(value ?? '').replace(/[\r\n]/g, '');
}

function buildEnvContent(rawConfig) {
  const config = {};
  for (const [key, value] of Object.entries(rawConfig)) {
    config[key] = typeof value === 'string' ? envValue(value) : value;
  }
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
# ADMIN_PASSWORD wird nicht gespeichert (nur beim Setup verwendet)

NAVIDROME_ENCRYPTION_KEY=${encryptionKey}
NAVIDROME_URL=${config.navidromeUrl || ''}
NAVIDROME_USERNAME=${config.navidromeUsername || ''}
# NAVIDROME_PASSWORD wird nicht gespeichert (liegt verschluesselt in der Datenbank)
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
  DatabaseUnavailableError,
};
