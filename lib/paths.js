// =========================================================
// Pfade fuer beschreibbare Daten (.env, Backups, Statusdateien)
// =========================================================
// Mit OPENWEB_DATA_DIR liegen alle Dateien, die die laufende App schreibt, ausserhalb des
// Code-Verzeichnisses (install.sh/systemd: /var/lib/openweb). Der Code bleibt dann root-eigen
// und kann vom Service-Benutzer nicht veraendert werden. Ohne die Variable gilt das bisherige
// Verhalten (.env im Arbeitsverzeichnis, Backups/Statusdateien im Projektordner).

const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.OPENWEB_DATA_DIR ? path.resolve(process.env.OPENWEB_DATA_DIR) : null;

const ENV_FILE = path.join(DATA_DIR || process.cwd(), '.env');
const DEFAULT_BACKUP_DIR = path.join(DATA_DIR || APP_ROOT, 'backups');
const LAST_TRACK_FILE = path.join(DATA_DIR || APP_ROOT, '.last-track-id');

let loaded = false;
function loadEnv() {
  if (loaded) return;
  loaded = true;
  require('dotenv').config({ path: ENV_FILE });
}

module.exports = { APP_ROOT, DATA_DIR, ENV_FILE, DEFAULT_BACKUP_DIR, LAST_TRACK_FILE, loadEnv };
