// =========================================================
// Gemeinsame Sichtbarkeitsregeln fuer Links
// =========================================================
// Eine einzige Stelle fuer "darf ein anonymer Besucher diesen Link sehen bzw. aufloesen?".
// Wird von /api/links, /api/public/links, /sitemap.xml, /go/:slug, Entsperren und Klick-Tracking
// genutzt, damit Zeitsteuerung, Ablaufdatum und "Profil nicht oeffentlich" ueberall gleich gelten.

const db = require('./db');

// Spalten, die isLinkVisible() braucht. In jede Abfrage aufnehmen, deren Ergebnis gefiltert wird –
// fehlt eine Spalte, wird die zugehoerige Regel sonst stillschweigend nie angewendet.
const VISIBILITY_COLUMNS = ['is_active', 'expires_at', 'visible_from', 'visible_until', 'visible_weekdays'];

function visibilityColumns(alias) {
  const prefix = alias ? `${alias}.` : '';
  return VISIBILITY_COLUMNS.map(c => `${prefix}${c}`).join(', ');
}

function getNowInBerlin() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
}

function isLinkVisible(link, nowBerlin = getNowInBerlin()) {
  if (!link) return false;
  for (const col of VISIBILITY_COLUMNS) {
    // Schutz gegen Abfragen, die eine Regel-Spalte vergessen haben: lieber verbergen als freigeben
    if (!(col in link)) throw new Error(`isLinkVisible: Spalte ${col} fehlt in der Abfrage`);
  }
  if (!link.is_active) return false;
  if (link.expires_at) {
    const expires = new Date(link.expires_at);
    if (expires < nowBerlin) return false;
  }
  if (link.visible_from) {
    const from = new Date(link.visible_from);
    if (from > nowBerlin) return false;
  }
  if (link.visible_until) {
    const until = new Date(link.visible_until);
    if (until < nowBerlin) return false;
  }
  if (Array.isArray(link.visible_weekdays) && link.visible_weekdays.length) {
    const weekday = nowBerlin.getDay();
    if (!link.visible_weekdays.includes(weekday)) return false;
  }
  return true;
}

// true, wenn das Profil nicht oeffentlich ist und die Anfrage nicht von einem eingeloggten Admin kommt
async function isProfileHiddenFor(req) {
  const { rows } = await db.query('SELECT is_public FROM profile WHERE id = 1 LIMIT 1');
  return rows[0]?.is_public === false && !req.session?.userId;
}

module.exports = { VISIBILITY_COLUMNS, visibilityColumns, getNowInBerlin, isLinkVisible, isProfileHiddenFor };
