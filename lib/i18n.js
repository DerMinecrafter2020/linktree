// =========================================================
// OpenWeb – Sprache fuer serverseitige Besucher-Texte (Deutsch/Englisch)
// ---------------------------------------------------------
// Gegenstueck zu public/js/i18n.js: gleiche Erkennung, damit Seite und Server-Meldungen
// dieselbe Sprache sprechen.
//   1. Cookie "ow_lang" (de|en) – gesetzt, wenn der Besucher die Sprache umschaltet
//   2. Accept-Language: erste Sprache, die mit "de" oder "en" beginnt (nach q-Wert)
//   3. Header vorhanden, aber weder Deutsch noch Englisch → Englisch; kein Header → Deutsch
// Admin-Bereich und E-Mails an den Betreiber bleiben Deutsch.
// =========================================================
'use strict';

const LANGS = ['de', 'en'];
const DEFAULT_LANG = 'de';
const COOKIE = 'ow_lang';

function readCookie(req, name) {
  const header = req?.headers?.cookie;
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

// "en-US,en;q=0.9,de;q=0.8" → ['en-us', 'en', 'de'] (nach q sortiert, stabil)
function parseAcceptLanguage(header) {
  return String(header || '')
    .slice(0, 500)
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((e) => e.tag && e.tag !== '*' && e.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((e) => e.tag);
}

function fromList(tags) {
  if (!tags.length) return DEFAULT_LANG;
  for (const tag of tags) {
    const base = tag.split('-')[0];
    if (LANGS.includes(base)) return base;
  }
  return 'en';
}

function pickLang(req) {
  const cookie = readCookie(req, COOKIE);
  if (LANGS.includes(cookie)) return cookie;
  return fromList(parseAcceptLanguage(req?.headers?.['accept-language']));
}

// ---------- Texte ----------
// Platzhalter {name} werden ersetzt. Neue Besucher-Texte immer in beiden Sprachen anlegen.
const MESSAGES = {
  de: {
    'contact.name': 'Bitte gib deinen Namen an.',
    'contact.email': 'Bitte gib eine gültige E-Mail-Adresse an, damit eine Antwort möglich ist.',
    'contact.tooShort': 'Die Nachricht ist zu kurz (mindestens {min} Zeichen).',
    'contact.tooLong': 'Die Nachricht ist zu lang (höchstens {max} Zeichen).',
    'contact.links': 'Bitte höchstens {max} Links in der Nachricht.',
    'contact.consent': 'Bitte bestätige den Hinweis zum Datenschutz.',
    'contact.tooFast': 'Das ging sehr schnell – bitte warte einen Moment und sende dann erneut.',
    'contact.expired': 'Das Formular ist abgelaufen. Bitte lade es neu und sende die Nachricht erneut.',
    'contact.unavailable': 'Das Kontaktformular ist derzeit nicht verfügbar.',
    'contact.busy': 'Gerade kommen sehr viele Nachrichten an. Bitte versuche es später erneut.',
    'contact.sendFailed': 'Die Nachricht konnte gerade nicht versendet werden. Bitte versuche es später erneut.',
    'contact.ipLimit': 'Du hast schon mehrere Nachrichten gesendet. Bitte versuche es später erneut.',
    'unlock.tooMany': 'Zu viele Passwortversuche. Bitte in {seconds} Sekunden erneut versuchen.',
    'unlock.notFound': 'Link nicht gefunden',
    'unlock.wrong': 'Falsches Passwort',
    'api.tooMany': 'Zu viele Anfragen. Bitte warte einen Moment.',
    'api.limit': 'API-Limit erreicht. Bitte kurz warten.',
    'botguard.denied': 'Zugriff verweigert',
    'botguard.deniedText': 'Deine Anfrage wurde vom Schutz dieser Seite abgelehnt.',
    'botguard.deniedHelp': 'Falls das ein Irrtum ist, melde dich bitte beim Betreiber und nenne diese Kennung:',
    'botguard.title': 'Einen Moment …',
    'botguard.text': 'Wir prüfen kurz, ob du ein Mensch bist. Das dauert nur ein, zwei Sekunden.',
    'botguard.noscript': 'Für diese Prüfung wird JavaScript benötigt. Bitte aktiviere JavaScript und lade die Seite neu.',
    'botguard.foot': 'Schutz vor automatisierten Zugriffen · keine Daten an Dritte',
    'botguard.done': 'Geschafft – einen Augenblick …',
    'botguard.failed': 'Die Prüfung ist fehlgeschlagen. Bitte lade die Seite neu.',
    'botguard.offline': 'Keine Verbindung. Bitte lade die Seite neu.',
    'botguard.oldBrowser': 'Dein Browser ist zu alt für diese Prüfung.',
    'botguard.expired': 'Die Prüfung ist abgelaufen. Bitte lade die Seite neu.',
    'botguard.invalid': 'Die Prüfung ist fehlgeschlagen.',
  },
  en: {
    'contact.name': 'Please enter your name.',
    'contact.email': 'Please enter a valid email address so a reply is possible.',
    'contact.tooShort': 'The message is too short (at least {min} characters).',
    'contact.tooLong': 'The message is too long (at most {max} characters).',
    'contact.links': 'Please include no more than {max} links in your message.',
    'contact.consent': 'Please confirm the privacy notice.',
    'contact.tooFast': 'That was very quick – please wait a moment and then send again.',
    'contact.expired': 'The form has expired. Please reload it and send your message again.',
    'contact.unavailable': 'The contact form is currently unavailable.',
    'contact.busy': 'A lot of messages are coming in right now. Please try again later.',
    'contact.sendFailed': 'Your message could not be sent right now. Please try again later.',
    'contact.ipLimit': 'You have already sent several messages. Please try again later.',
    'unlock.tooMany': 'Too many password attempts. Please try again in {seconds} seconds.',
    'unlock.notFound': 'Link not found',
    'unlock.wrong': 'Wrong password',
    'api.tooMany': 'Too many requests. Please wait a moment.',
    'api.limit': 'API limit reached. Please wait a moment.',
    'botguard.denied': 'Access denied',
    'botguard.deniedText': 'Your request was blocked by this site’s protection.',
    'botguard.deniedHelp': 'If you think this is a mistake, please contact the site owner and quote this ID:',
    'botguard.title': 'One moment …',
    'botguard.text': 'We’re quickly checking that you’re human. This only takes a second or two.',
    'botguard.noscript': 'This check requires JavaScript. Please enable JavaScript and reload the page.',
    'botguard.foot': 'Protection against automated access · no data shared with third parties',
    'botguard.done': 'Done – just a moment …',
    'botguard.failed': 'The check failed. Please reload the page.',
    'botguard.offline': 'No connection. Please reload the page.',
    'botguard.oldBrowser': 'Your browser is too old for this check.',
    'botguard.expired': 'The check has expired. Please reload the page.',
    'botguard.invalid': 'The check failed.',
  },
};

function msg(lang, key, vars) {
  const dict = MESSAGES[LANGS.includes(lang) ? lang : DEFAULT_LANG];
  const text = dict[key] ?? MESSAGES[DEFAULT_LANG][key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

// Kurzform: Text in der Sprache dieser Anfrage
function t(req, key, vars) {
  return msg(pickLang(req), key, vars);
}

module.exports = { LANGS, DEFAULT_LANG, COOKIE, pickLang, parseAcceptLanguage, msg, t, MESSAGES };
