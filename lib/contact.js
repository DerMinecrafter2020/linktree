// =========================================================
// OpenWeb — Kontaktformular
// ---------------------------------------------------------
// Besucher schreiben ueber die Startseite eine Nachricht, die per SMTP (lib/mailer.js,
// Zugangsdaten aus alert_settings) an den Admin geht. Nachrichten werden NICHT gespeichert.
//
// Spamschutz (ohne Captcha / Drittanbieter):
//  - Formular-Token: signierter Zeitstempel (HMAC mit SESSION_SECRET). Absenden erst nach
//    MIN_FILL_MS, hoechstens TOKEN_MAX_AGE_MS nach dem Oeffnen; jedes Token nur einmal.
//  - Honeypot-Feld "website": fuer Menschen unsichtbar, Bots fuellen es aus.
//  - Limits: pro IP (routes/public.js) und insgesamt pro Stunde (hier).
//  - Laengen- und Link-Grenzen; Antwortadresse nur als Reply-To, nie als Absender.
// =========================================================

const crypto = require('crypto');
const db = require('./db');
const v = require('./validators');
const mailer = require('./mailer');
const alert = require('./alert');

const MIN_FILL_MS = 3000;
const TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const GLOBAL_MAX_PER_HOUR = 30;
const MAX_LINKS = 5;
const LIMITS = { name: 100, email: 254, subject: 150, message: 5000, messageMin: 10, intro: 500 };

// ---------- Einstellungen ----------
async function getSettings() {
  const { rows } = await db.query('SELECT enabled, recipient, intro_text, updated_at FROM contact_settings WHERE id = 1 LIMIT 1');
  return rows[0] || { enabled: false, recipient: null, intro_text: null };
}

// Empfaenger: eigene Adresse fuer das Formular, sonst die Alert-Empfaengeradresse
function effectiveRecipient(settings, smtp) {
  return settings?.recipient || smtp?.email_to || null;
}

async function getStatus() {
  const [settings, smtp] = await Promise.all([getSettings(), alert.loadSettings()]);
  const recipient = effectiveRecipient(settings, smtp);
  const smtpConfigured = mailer.isConfigured(smtp);
  return {
    enabled: Boolean(settings.enabled),
    recipient: settings.recipient || '',
    effective_recipient: recipient || '',
    intro_text: settings.intro_text || '',
    smtp_configured: smtpConfigured,
    sender: smtpConfigured ? mailer.senderAddress(smtp, recipient) : '',
    available: Boolean(settings.enabled && smtpConfigured && recipient),
  };
}

async function isAvailable() {
  try { return (await getStatus()).available; } catch { return false; }
}

async function saveSettings({ enabled, recipient, introText }) {
  let rcpt = null;
  if (recipient) {
    rcpt = v.validateEmail(recipient);
    if (!rcpt) {
      const err = new Error('Die Empfänger-Adresse ist keine gültige E-Mail-Adresse.');
      err.status = 400;
      err.expose = true;
      throw err;
    }
  }
  const intro = String(introText || '').replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').trim().slice(0, LIMITS.intro) || null;
  await db.query(
    `INSERT INTO contact_settings (id, enabled, recipient, intro_text, updated_at)
     VALUES (1, $1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, recipient = EXCLUDED.recipient,
       intro_text = EXCLUDED.intro_text, updated_at = NOW()`,
    [Boolean(enabled), rcpt, intro]
  );
  return getStatus();
}

// ---------- Formular-Token ----------
function tokenKey() {
  return crypto.createHash('sha256').update(`openweb-contact:${process.env.SESSION_SECRET || ''}`).digest();
}
function sign(payload) {
  return crypto.createHmac('sha256', tokenKey()).update(payload).digest('base64url');
}
function issueToken(now = Date.now()) {
  const payload = `${now}.${crypto.randomBytes(9).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}

// Bereits benutzte Tokens (nur bis zu ihrem Ablauf gemerkt)
const usedTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of usedTokens) if (now > exp) usedTokens.delete(t);
}, 10 * 60 * 1000).unref();

function checkToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 200) return 'invalid';
  const parts = token.split('.');
  if (parts.length !== 3) return 'invalid';
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return 'invalid';
  const issued = Number(parts[0]);
  if (!Number.isFinite(issued)) return 'invalid';
  if (now - issued < MIN_FILL_MS) return 'too_fast';
  if (now - issued > TOKEN_MAX_AGE_MS) return 'expired';
  if (usedTokens.has(token)) return 'used';
  return 'ok';
}
function consumeToken(token, now = Date.now()) {
  usedTokens.set(token, now + TOKEN_MAX_AGE_MS);
}

// ---------- Globales Limit ----------
let windowStart = 0;
let windowCount = 0;
function takeGlobalSlot(now = Date.now()) {
  if (now - windowStart > 60 * 60 * 1000) { windowStart = now; windowCount = 0; }
  if (windowCount >= GLOBAL_MAX_PER_HOUR) return false;
  windowCount += 1;
  return true;
}

// ---------- Eingaben ----------
function oneLine(input, max) {
  return v.safeText(typeof input === 'string' ? input.replace(/\s+/g, ' ') : '', max);
}
// Mehrzeiliger Text: Zeilenumbrueche behalten, sonstige Steuerzeichen entfernen
function multiLine(input, max) {
  if (typeof input !== 'string') return '';
  return input.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max);
}

/**
 * Prueft die Formulardaten. Liefert { ok, data } oder { ok: false, field, error }.
 * Fehlermeldungen sind fuer Besucher gedacht (deutsch, ohne Interna).
 */
function validate(body = {}) {
  const name = oneLine(body.name, LIMITS.name);
  const email = v.validateEmail(typeof body.email === 'string' ? body.email.slice(0, LIMITS.email + 10) : '');
  const subject = oneLine(body.subject, LIMITS.subject);
  const message = multiLine(body.message, LIMITS.message + 1);

  if (!name) return { ok: false, field: 'name', error: 'Bitte gib deinen Namen an.' };
  if (!email) return { ok: false, field: 'email', error: 'Bitte gib eine gültige E-Mail-Adresse an, damit eine Antwort möglich ist.' };
  if (message.length < LIMITS.messageMin) return { ok: false, field: 'message', error: `Die Nachricht ist zu kurz (mindestens ${LIMITS.messageMin} Zeichen).` };
  if (message.length > LIMITS.message) return { ok: false, field: 'message', error: `Die Nachricht ist zu lang (höchstens ${LIMITS.message} Zeichen).` };
  const links = (message.match(/https?:\/\/|www\./gi) || []).length;
  if (links > MAX_LINKS) return { ok: false, field: 'message', error: `Bitte höchstens ${MAX_LINKS} Links in der Nachricht.` };
  if (body.consent !== true) return { ok: false, field: 'consent', error: 'Bitte bestätige den Hinweis zum Datenschutz.' };
  return { ok: true, data: { name, email, subject, message } };
}

function siteName(profile) {
  return oneLine(profile?.handle || profile?.name || 'OpenWeb', 80) || 'OpenWeb';
}

function buildMail(data, { site, appUrl, date = new Date() }) {
  const when = date.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
  const subject = data.subject
    ? `Kontaktformular: ${data.subject}`
    : `Kontaktformular: Nachricht von ${data.name}`;
  const text = [
    `Neue Nachricht über das Kontaktformular von ${site}.`,
    '',
    `Name:    ${data.name}`,
    `E-Mail:  ${data.email}`,
    data.subject ? `Betreff: ${data.subject}` : null,
    '',
    '----------------------------------------',
    data.message,
    '----------------------------------------',
    '',
    `Gesendet am ${when}${appUrl ? ` über ${appUrl}` : ''}.`,
    'Mit „Antworten“ geht deine Antwort direkt an die angegebene Adresse.',
  ].filter((l) => l !== null).join('\n');
  return { subject, text };
}

/**
 * Validiert und versendet eine Nachricht. Rueckgabe { ok, status, error?, field? }.
 * status: 200 gesendet, 400 Eingabe, 403 aus, 409 Token, 429 Limit, 502 SMTP-Fehler.
 */
async function submit(body, { profile } = {}) {
  // Honeypot: so tun, als waere alles gut (Bot bekommt keinen Hinweis)
  if (typeof body?.website === 'string' && body.website.trim() !== '') {
    return { ok: true, status: 200, silent: true };
  }
  const tokenState = checkToken(body?.token);
  if (tokenState === 'too_fast') return { ok: false, status: 409, error: 'Das ging sehr schnell – bitte warte einen Moment und sende dann erneut.' };
  if (tokenState !== 'ok') return { ok: false, status: 409, error: 'Das Formular ist abgelaufen. Bitte lade es neu und sende die Nachricht erneut.', code: 'token' };

  const checked = validate(body);
  if (!checked.ok) return { ok: false, status: 400, error: checked.error, field: checked.field };

  const [settings, smtp] = await Promise.all([getSettings(), alert.loadSettings()]);
  const recipient = effectiveRecipient(settings, smtp);
  if (!settings.enabled || !mailer.isConfigured(smtp) || !recipient) {
    return { ok: false, status: 403, error: 'Das Kontaktformular ist derzeit nicht verfügbar.' };
  }
  if (!takeGlobalSlot()) {
    return { ok: false, status: 429, error: 'Gerade kommen sehr viele Nachrichten an. Bitte versuche es später erneut.' };
  }
  consumeToken(body.token);

  const { subject, text } = buildMail(checked.data, { site: siteName(profile), appUrl: process.env.APP_URL || '' });
  try {
    await mailer.sendMail(smtp, {
      to: recipient,
      subject,
      text,
      replyTo: { name: checked.data.name, address: checked.data.email },
    });
  } catch (err) {
    console.warn('[contact] Versand fehlgeschlagen:', err.code || err.message);
    return { ok: false, status: 502, error: 'Die Nachricht konnte gerade nicht versendet werden. Bitte versuche es später erneut.' };
  }
  return { ok: true, status: 200 };
}

// Testnachricht aus dem Admin (mit Fehlerdetails fuer den Admin)
async function sendTest(profile) {
  const [settings, smtp] = await Promise.all([getSettings(), alert.loadSettings()]);
  const recipient = effectiveRecipient(settings, smtp);
  if (!mailer.isConfigured(smtp)) return { ok: false, error: 'SMTP ist noch nicht eingerichtet (Alert-Einstellungen).' };
  if (!recipient) return { ok: false, error: 'Es ist keine Empfänger-Adresse eingetragen.' };
  const { subject, text } = buildMail({
    name: 'OpenWeb-Test',
    email: recipient,
    subject: 'Testnachricht',
    message: 'Das ist eine Testnachricht aus dem Admin-Bereich. Wenn du sie liest, kommt das Kontaktformular bei dir an.',
  }, { site: siteName(profile), appUrl: process.env.APP_URL || '' });
  try {
    await mailer.sendMail(smtp, { to: recipient, subject, text });
    return { ok: true, recipient };
  } catch (err) {
    return { ok: false, error: `Versand fehlgeschlagen: ${String(err.response || err.message || err.code || 'unbekannter Fehler').slice(0, 300)}` };
  }
}

module.exports = {
  LIMITS,
  getStatus,
  isAvailable,
  saveSettings,
  issueToken,
  submit,
  sendTest,
  // fuer Tests
  _internal: { checkToken, validate, buildMail, MIN_FILL_MS },
};
