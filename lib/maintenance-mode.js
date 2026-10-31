// =========================================================
// OpenWeb – Wartungsmodus
// ---------------------------------------------------------
// Ist er aktiv, sehen Besucher unter "/" statt der Startseite eine Wartungsseite
// (public/maintenance.html) mit Status 503 (empfohlen, inkl. Retry-After) oder 404.
// Optional mit Countdown bis ends_at; mit auto_end endet der Wartungsmodus dann von selbst.
// Angemeldete Admins sehen weiter die normale Startseite (mit Hinweis-Banner).
// Impressum, Datenschutz, Kurzlinks (/go/…) und die API bleiben erreichbar.
// Nicht verwechseln mit lib/maintenance.js (naechtliches Aufraeumen).
// =========================================================
'use strict';

const db = require('./db');
const v = require('./validators');

const STATUSES = [503, 404];
const LIMITS = { title: 100, message: 500, maxDays: 366 };
const CACHE_MS = 5000;

const DEFAULTS = {
  enabled: false,
  http_status: 503,
  title: null,
  message: null,
  countdown_enabled: false,
  ends_at: null,
  auto_end: false,
  started_at: null,
  updated_at: null,
};

let cache = null;
let cacheAt = 0;

function normalize(row) {
  const s = { ...DEFAULTS, ...(row || {}) };
  s.http_status = STATUSES.includes(Number(s.http_status)) ? Number(s.http_status) : 503;
  s.ends_at = s.ends_at ? new Date(s.ends_at) : null;
  return s;
}

// Countdown abgelaufen und "automatisch beenden" gesetzt?
function isExpired(s, now = Date.now()) {
  return Boolean(s.enabled && s.countdown_enabled && s.auto_end && s.ends_at && s.ends_at.getTime() <= now);
}

function isActive(s, now = Date.now()) {
  return Boolean(s && s.enabled && !isExpired(s, now));
}

async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < CACHE_MS) {
    // Ablauf auch innerhalb der Cache-Zeit sofort beachten
    if (!isExpired(cache)) return cache;
  }
  const { rows } = await db.query('SELECT * FROM maintenance_settings WHERE id = 1 LIMIT 1');
  let s = normalize(rows[0]);
  if (isExpired(s)) {
    // Automatisches Ende dauerhaft festhalten (Admin sieht den Schalter dann aus)
    await db.query('UPDATE maintenance_settings SET enabled = false, updated_at = NOW() WHERE id = 1 AND enabled = true');
    s = { ...s, enabled: false, ended_automatically: true };
  }
  cache = s;
  cacheAt = Date.now();
  return s;
}

// Fuer die Startseite: Fehler der DB sollen die Seite nicht lahmlegen
async function getActive() {
  try {
    const s = await getSettings();
    return isActive(s) ? s : null;
  } catch (err) {
    console.warn('[maintenance-mode] Einstellungen nicht lesbar:', err.message);
    return null;
  }
}

function view(s) {
  return {
    enabled: Boolean(s.enabled),
    active: isActive(s),
    http_status: s.http_status,
    title: s.title || '',
    message: s.message || '',
    countdown_enabled: Boolean(s.countdown_enabled),
    ends_at: s.ends_at ? s.ends_at.toISOString() : null,
    auto_end: Boolean(s.auto_end),
    started_at: s.started_at ? new Date(s.started_at).toISOString() : null,
    updated_at: s.updated_at ? new Date(s.updated_at).toISOString() : null,
    limits: { title: LIMITS.title, message: LIMITS.message },
  };
}

function badRequest(message, field) {
  const err = new Error(message);
  err.status = 400;
  err.field = field;
  return err;
}

function multiLine(input, max) {
  if (typeof input !== 'string') return '';
  return input.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

async function saveSettings(body = {}, now = Date.now()) {
  const enabled = body.enabled === true;
  const httpStatus = Number(body.http_status);
  if (!STATUSES.includes(httpStatus)) throw badRequest('Ungültige Anzeige (nur 503 oder 404).', 'http_status');
  const title = v.safeText(typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ') : '', LIMITS.title) || null;
  const message = multiLine(body.message, LIMITS.message) || null;
  const countdown = body.countdown_enabled === true;
  let endsAt = null;
  if (body.ends_at !== null && body.ends_at !== undefined && body.ends_at !== '') {
    const d = new Date(typeof body.ends_at === 'string' ? body.ends_at : NaN);
    if (Number.isNaN(d.getTime())) throw badRequest('Das Ende der Wartung ist kein gültiges Datum.', 'ends_at');
    endsAt = d;
  }
  if (countdown && !endsAt) throw badRequest('Für den Countdown fehlt das Ende der Wartung.', 'ends_at');
  if (countdown && endsAt && enabled && endsAt.getTime() <= now) {
    throw badRequest('Das Ende der Wartung liegt in der Vergangenheit.', 'ends_at');
  }
  if (endsAt && endsAt.getTime() > now + LIMITS.maxDays * 86400000) {
    throw badRequest('Das Ende der Wartung darf höchstens ein Jahr in der Zukunft liegen.', 'ends_at');
  }
  const autoEnd = countdown && body.auto_end === true;

  // started_at: Beginn der aktuellen Wartung (bleibt beim erneuten Speichern erhalten)
  await db.query(
    `INSERT INTO maintenance_settings (id, enabled, http_status, title, message, countdown_enabled, ends_at, auto_end, started_at, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, CASE WHEN $1 THEN NOW() ELSE NULL END, NOW())
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, http_status = EXCLUDED.http_status,
       title = EXCLUDED.title, message = EXCLUDED.message, countdown_enabled = EXCLUDED.countdown_enabled,
       ends_at = EXCLUDED.ends_at, auto_end = EXCLUDED.auto_end,
       started_at = CASE WHEN EXCLUDED.enabled THEN COALESCE(maintenance_settings.started_at, NOW()) ELSE NULL END,
       updated_at = NOW()`,
    [enabled, httpStatus, title, message, countdown, endsAt, autoEnd]
  );
  cache = null;
  return view(await getSettings({ fresh: true }));
}

// ---------- Seite ----------
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22.7 19.3 13.6 10.2c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3l4.3 4.3-3 3-4.4-4.3C.4 7.4.9 10.4 2.9 12.4c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>';

// Standardtexte (Deutsch im HTML, js/i18n.js uebersetzt ueber die Schluessel)
const DEFAULT_TEXT = {
  503: { title: ['maintenance.title503', 'Wartungsarbeiten'], message: ['maintenance.text503', 'Die Seite wird gerade überarbeitet und ist bald wieder da.'] },
  404: { title: ['maintenance.title404', 'Hier ist gerade nichts.'], message: ['maintenance.text404', 'Diese Seite ist vorübergehend nicht erreichbar. Schau später noch einmal vorbei.'] },
};

// Text mit Absaetzen/Zeilenumbruechen als sicheres HTML
function messageHtml(text) {
  return text.split(/\n{2,}/).map((p) => `<p class="maintenance-text">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`).join('\n    ');
}

/**
 * Baut die Wartungsseite aus dem Template (Platzhalter __MT_…__, immer mit Replacer-Funktion).
 * template: Inhalt von public/maintenance.html (bereits mit versionAssets versioniert).
 */
function renderPage(template, s, { now = Date.now() } = {}) {
  const status = s.http_status === 404 ? 404 : 503;
  const defaults = DEFAULT_TEXT[status];
  const title = s.title
    ? { attr: '', html: escapeHtml(s.title) }
    : { attr: ` data-i18n="${defaults.title[0]}"`, html: escapeHtml(defaults.title[1]) };
  const message = s.message
    ? messageHtml(s.message)
    : `<p class="maintenance-text" data-i18n="${defaults.message[0]}">${escapeHtml(defaults.message[1])}</p>`;
  const countdown = s.countdown_enabled && s.ends_at;
  const badge = status === 404
    ? '<p class="maintenance-code" aria-hidden="true">404</p>'
    : `<div class="maintenance-icon">${ICON}</div>`;
  const replacements = {
    __MT_STATUS__: String(status),
    __MT_PAGE_TITLE__: title.html,
    __MT_PAGE_TITLE_ATTR__: title.attr,
    __MT_BADGE__: badge,
    __MT_TITLE__: title.html,
    __MT_TITLE_ATTR__: title.attr,
    __MT_MESSAGE__: message,
    __MT_ENDS_AT__: countdown ? s.ends_at.toISOString() : '',
    __MT_AUTO_END__: countdown && s.auto_end ? '1' : '0',
    __MT_COUNTDOWN_HIDDEN__: countdown ? '' : ' hidden',
  };
  return template.replace(/__MT_[A-Z_]+__/g, (key) => (Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : ''));
}

// Sekunden fuer Retry-After (nur 503): bis zum Countdown-Ende, sonst eine Stunde
function retryAfter(s, now = Date.now()) {
  if (s.countdown_enabled && s.ends_at) {
    const sec = Math.ceil((s.ends_at.getTime() - now) / 1000);
    if (sec > 0) return Math.max(60, Math.min(sec, 7 * 86400));
  }
  return 3600;
}

module.exports = { getSettings, getActive, saveSettings, isActive, isExpired, renderPage, retryAfter, view, STATUSES, LIMITS };
