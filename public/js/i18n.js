// =========================================================
// OpenWeb – Sprache der Besucherseiten (Deutsch/Englisch)
// ---------------------------------------------------------
// Synchron im <head> nach js/theme-init.js laden. Gegenstueck auf dem Server: lib/i18n.js
// (gleiche Erkennung; Server-Meldungen wie Kontaktformular-Fehler kommen schon uebersetzt).
//
// Erkennung: Cookie "ow_lang" (Umschalter) → Browsersprachen (erste mit de/en) → sonst Englisch;
// meldet der Browser gar keine Sprache, bleibt es Deutsch.
//
// Markierungen im HTML (der deutsche Text bleibt im HTML als Rueckfall ohne JavaScript):
//   data-i18n="key"                         → textContent
//   data-i18n-attr="title:key;aria-label:key" → Attribute
//   data-lang-only="en"                     → nur in dieser Sprache sichtbar (fuer Absaetze mit
//                                             Links/Code: je Sprache ein eigenes Element)
// In JavaScript: window.OpenWebI18n.t('key', { name: 'Wert' }); Umschalten loest das Ereignis
// "openweb:langchange" auf document aus.
// Nutzerinhalte (Bio, Linktitel, Rechtstexte, Changelog-Eintraege) werden nicht uebersetzt.
// Neue Texte immer in BEIDEN Woerterbuechern anlegen.
// =========================================================
(function () {
  'use strict';

  var LANGS = ['de', 'en'];
  var COOKIE = 'ow_lang';
  var LOCALES = { de: 'de-DE', en: 'en-US' };

  var DICT = {
    de: {
      'lang.group': 'Sprache',
      'lang.switchTo': 'Auf {name} umschalten',
      'lang.name.de': 'Deutsch',
      'lang.name.en': 'Englisch',
      'common.cancel': 'Abbrechen',
      'common.close': 'Schließen',
      'common.backHome': '← Zurück zur Startseite',
      'common.backHomePlain': 'Zurück zur Startseite',

      'meta.description': 'Alle wichtigen Links auf einen Blick.',
      'meta.profile': 'Profil',

      'pw.title': '🔒 Geschützter Link',
      'pw.hint': 'Dieser Link ist passwortgeschützt. Bitte gib das Passwort ein.',
      'pw.label': 'Passwort',
      'pw.wrong': 'Falsches Passwort.',
      'pw.open': 'Öffnen',

      'home.admin': 'Admin-Bereich öffnen',
      'home.avatar': 'Profilbild',
      'home.share': 'Seite teilen',
      'home.contact': 'Nachricht schreiben',
      'home.qr': 'QR-Code anzeigen',
      'home.links': 'Wichtige Links',
      'home.private': '🔒 Privates Profil',
      'home.privateText': 'Dieses Profil ist derzeit nicht öffentlich sichtbar.',
      'home.empty': 'Noch keine Links vorhanden.',
      'home.loadError': 'Links konnten nicht geladen werden.',
      'home.adminOnly': 'Nur Admin',
      'home.adminOnlyHint': 'Nur für dich sichtbar – Gäste sehen diesen Link nicht.',

      'footer.changelog': 'Changelog – was ist neu?',
      'footer.imprint': 'Impressum',
      'footer.privacy': 'Datenschutz',
      'footer.sponsor': 'Gehostet bei',
      'footer.sponsorTitle': 'Affiliate-Link zu Nuvine',
      'footer.ad': 'Anzeige',

      'player.label': 'Aktuell gespielter Track',
      'player.loading': 'Lade Player…',
      'player.progress': 'Wiedergabefortschritt',
      'player.idle': 'Momentan läuft nichts',
      'player.idleHint': 'Sobald Musik läuft, erscheint sie hier',
      'player.source': 'Quelle: {name}',
      'player.radio': 'Internetradio',
      'player.paused': 'Pausiert',
      'player.pausedSuffix': ' (pausiert)',
      'player.unknown': 'Unbekannt',

      'theme.menu': 'Design wählen',
      'theme.title': 'Design',
      'theme.button': 'Design: {name} – ändern',
      'theme.dark': 'Dunkel',
      'theme.dark.hint': 'Material 3, violett',
      'theme.midnight': 'Midnight',
      'theme.midnight.hint': 'Material 3, blau',
      'theme.sunset': 'Sunset',
      'theme.sunset.hint': 'Material 3, orange',
      'theme.light': 'Hell',
      'theme.light.hint': 'Material 3, hell',
      'theme.win11': 'Windows 11',
      'theme.win11.hint': 'Mica & Fluent',
      'theme.glass': 'Liquid Glass',
      'theme.glass.hint': 'Glas auf Farbe',

      'contact.title': 'Nachricht schreiben',
      'contact.name': 'Name',
      'contact.email': 'E-Mail',
      'contact.subject': 'Betreff',
      'contact.optional': '(optional)',
      'contact.message': 'Nachricht',
      'contact.consent': 'Ich bin einverstanden, dass meine Angaben zur Beantwortung meiner Anfrage verwendet werden. Mehr dazu in der',
      'contact.privacyLink': 'Datenschutzerklärung',
      'contact.thanks': 'Danke für deine Nachricht!',
      'contact.thanksText': 'Sie ist angekommen – die Antwort kommt an die angegebene E-Mail-Adresse.',
      'contact.send': 'Senden',
      'contact.sending': 'Wird gesendet …',
      'contact.errUnreachable': 'Das Kontaktformular ist gerade nicht erreichbar. Bitte versuche es später erneut.',
      'contact.errName': 'Bitte gib deinen Namen an.',
      'contact.errEmail': 'Bitte gib eine gültige E-Mail-Adresse an, damit eine Antwort möglich ist.',
      'contact.errShort': 'Die Nachricht ist zu kurz (mindestens {min} Zeichen).',
      'contact.errConsent': 'Bitte bestätige den Hinweis zum Datenschutz.',
      'contact.errRenewed': 'Das Formular wurde erneuert. Bitte tippe noch einmal auf „Senden“.',
      'contact.errFailed': 'Die Nachricht konnte nicht gesendet werden.',

      'qr.title': '📱 QR-Code',
      'qr.alt': 'QR-Code dieser Seite',
      'qr.download': '⬇ Herunterladen',

      'notFound.title': 'Seite nicht gefunden · OpenWeb',
      'notFound.heading': 'Hier ist nichts.',
      'notFound.text': 'Der angeforderte Link existiert nicht oder wurde entfernt. Wahrscheinlich bist du nur falsch abgebogen.',

      'legal.imprint': 'Impressum',
      'legal.privacy': 'Datenschutzerklärung',

      'changelog.subtitle': 'Alle Änderungen an der OpenWeb Link-in-Bio Seite.',
      'changelog.older': 'Ältere Änderungen anzeigen (v2.x und früher)',

      'api.pageTitle': 'API-Dokumentation · OpenWeb',
      'api.heading': 'API-Dokumentation',
      'api.subtitle': 'Öffentliche Endpunkte der OpenWeb Link-in-Bio Seite. Lesender Zugriff erfolgt mit einem API-Key aus dem Admin-Panel.',
      'api.exampleResponse': 'Beispiel-Antwort',
      'api.response': 'Antwort',
      'api.keyHeader': 'X-Api-Key: dein-api-key',
      'api.profile': 'Profil abrufen',
      'api.profileText': 'Gibt Name, Handle, Bio, Avatar, Theme und Sichtbarkeit des Profils zurück.',
      'api.links': 'Links abrufen',
      'api.linksText': 'Gibt alle aktiven, aktuell sichtbaren Links inklusive Kategorie und Zeitsteuerung zurück.',
      'api.click': 'Klick tracken',
      'api.clickText': 'Speichert einen Klick für einen Link. Optional können UTM-Parameter mitgegeben werden.',
      'api.unlock': 'Passwortgeschützten Link entsperren',
      'api.unlockText': 'Gibt die Ziel-URL eines passwortgeschützten Links zurück, wenn das Passwort korrekt ist.',
      'api.unlockBody': '{ "password": "geheim" }',

      'maintenance.title503': 'Wartungsarbeiten',
      'maintenance.text503': 'Die Seite wird gerade überarbeitet und ist bald wieder da.',
      'maintenance.title404': 'Hier ist gerade nichts.',
      'maintenance.text404': 'Diese Seite ist vorübergehend nicht erreichbar. Schau später noch einmal vorbei.',
      'maintenance.days': 'Tage',
      'maintenance.hours': 'Stunden',
      'maintenance.minutes': 'Minuten',
      'maintenance.seconds': 'Sekunden',
      'maintenance.eta': 'Voraussichtlich wieder da:',
      'maintenance.soon': 'Gleich geht’s weiter – die Seite lädt neu …',
      'maintenance.adminBanner': 'Wartungsmodus aktiv – Besucher sehen die Wartungsseite, nur du siehst die Startseite.',
      'maintenance.adminLink': 'Einstellungen'
    },
    en: {
      'lang.group': 'Language',
      'lang.switchTo': 'Switch to {name}',
      'lang.name.de': 'German',
      'lang.name.en': 'English',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.backHome': '← Back to home page',
      'common.backHomePlain': 'Back to home page',

      'meta.description': 'All important links at a glance.',
      'meta.profile': 'Profile',

      'pw.title': '🔒 Protected link',
      'pw.hint': 'This link is password-protected. Please enter the password.',
      'pw.label': 'Password',
      'pw.wrong': 'Wrong password.',
      'pw.open': 'Open',

      'home.admin': 'Open admin area',
      'home.avatar': 'Profile picture',
      'home.share': 'Share page',
      'home.contact': 'Send a message',
      'home.qr': 'Show QR code',
      'home.links': 'Important links',
      'home.private': '🔒 Private profile',
      'home.privateText': 'This profile is currently not publicly visible.',
      'home.empty': 'No links yet.',
      'home.loadError': 'Links could not be loaded.',
      'home.adminOnly': 'Admin only',
      'home.adminOnlyHint': 'Only visible to you – guests can’t see this link.',

      'footer.changelog': 'Changelog – what’s new?',
      'footer.imprint': 'Legal notice',
      'footer.privacy': 'Privacy',
      'footer.sponsor': 'Hosted by',
      'footer.sponsorTitle': 'Affiliate link to Nuvine',
      'footer.ad': 'Ad',

      'player.label': 'Currently playing track',
      'player.loading': 'Loading player…',
      'player.progress': 'Playback progress',
      'player.idle': 'Nothing playing right now',
      'player.idleHint': 'As soon as music is playing, it will show up here',
      'player.source': 'Source: {name}',
      'player.radio': 'Internet radio',
      'player.paused': 'Paused',
      'player.pausedSuffix': ' (paused)',
      'player.unknown': 'Unknown',

      'theme.menu': 'Choose a theme',
      'theme.title': 'Theme',
      'theme.button': 'Theme: {name} – change',
      'theme.dark': 'Dark',
      'theme.dark.hint': 'Material 3, violet',
      'theme.midnight': 'Midnight',
      'theme.midnight.hint': 'Material 3, blue',
      'theme.sunset': 'Sunset',
      'theme.sunset.hint': 'Material 3, orange',
      'theme.light': 'Light',
      'theme.light.hint': 'Material 3, light',
      'theme.win11': 'Windows 11',
      'theme.win11.hint': 'Mica & Fluent',
      'theme.glass': 'Liquid Glass',
      'theme.glass.hint': 'Glass on color',

      'contact.title': 'Send a message',
      'contact.name': 'Name',
      'contact.email': 'Email',
      'contact.subject': 'Subject',
      'contact.optional': '(optional)',
      'contact.message': 'Message',
      'contact.consent': 'I agree that my details will be used to answer my enquiry. You can find more information in the',
      'contact.privacyLink': 'privacy policy',
      'contact.thanks': 'Thank you for your message!',
      'contact.thanksText': 'It has arrived – the reply will be sent to the email address you provided.',
      'contact.send': 'Send',
      'contact.sending': 'Sending …',
      'contact.errUnreachable': 'The contact form can’t be reached right now. Please try again later.',
      'contact.errName': 'Please enter your name.',
      'contact.errEmail': 'Please enter a valid email address so a reply is possible.',
      'contact.errShort': 'The message is too short (at least {min} characters).',
      'contact.errConsent': 'Please confirm the privacy notice.',
      'contact.errRenewed': 'The form has been refreshed. Please tap “Send” again.',
      'contact.errFailed': 'The message could not be sent.',

      'qr.title': '📱 QR code',
      'qr.alt': 'QR code for this page',
      'qr.download': '⬇ Download',

      'notFound.title': 'Page not found · OpenWeb',
      'notFound.heading': 'Nothing here.',
      'notFound.text': 'The requested link doesn’t exist or has been removed. You probably just took a wrong turn.',

      'legal.imprint': 'Legal notice',
      'legal.privacy': 'Privacy policy',

      'changelog.subtitle': 'All changes to the OpenWeb link-in-bio page.',
      'changelog.older': 'Show older changes (v2.x and earlier)',

      'api.pageTitle': 'API documentation · OpenWeb',
      'api.heading': 'API documentation',
      'api.subtitle': 'Public endpoints of the OpenWeb link-in-bio page. Read access requires an API key from the admin panel.',
      'api.exampleResponse': 'Example response',
      'api.response': 'Response',
      'api.keyHeader': 'X-Api-Key: your-api-key',
      'api.profile': 'Get profile',
      'api.profileText': 'Returns the profile’s name, handle, bio, avatar, theme and visibility.',
      'api.links': 'Get links',
      'api.linksText': 'Returns all active, currently visible links, including category and scheduling.',
      'api.click': 'Track a click',
      'api.clickText': 'Records a click on a link. UTM parameters can optionally be included.',
      'api.unlock': 'Unlock a password-protected link',
      'api.unlockText': 'Returns the target URL of a password-protected link if the password is correct.',
      'api.unlockBody': '{ "password": "secret" }',

      'maintenance.title503': 'Under maintenance',
      'maintenance.text503': 'This page is being worked on and will be back soon.',
      'maintenance.title404': 'Nothing here right now.',
      'maintenance.text404': 'This page is temporarily unavailable. Please check back later.',
      'maintenance.days': 'Days',
      'maintenance.hours': 'Hours',
      'maintenance.minutes': 'Minutes',
      'maintenance.seconds': 'Seconds',
      'maintenance.eta': 'Expected back:',
      'maintenance.soon': 'Almost there – the page will reload …',
      'maintenance.adminBanner': 'Maintenance mode is on – visitors see the maintenance page, only you can see the home page.',
      'maintenance.adminLink': 'Settings'
    }
  };
  var NAMES = { de: 'Deutsch', en: 'English' };

  var root = document.documentElement;

  function readCookie() {
    var parts = String(document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf(COOKIE + '=') === 0) return p.slice(COOKIE.length + 1);
    }
    return '';
  }

  function detect() {
    var stored = readCookie();
    if (LANGS.indexOf(stored) !== -1) return stored;
    var list = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || ''];
    var any = false;
    for (var i = 0; i < list.length; i++) {
      var base = String(list[i] || '').toLowerCase().split('-')[0];
      if (!base) continue;
      any = true;
      if (LANGS.indexOf(base) !== -1) return base;
    }
    return any ? 'en' : 'de';
  }

  var lang = detect();

  function t(key, vars) {
    var text = DICT[lang][key];
    if (text === undefined) text = DICT.de[key];
    if (text === undefined) return key;
    if (vars) {
      text = text.replace(/\{(\w+)\}/g, function (m, name) {
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
      });
    }
    return text;
  }

  // Uebersetzt alle markierten Elemente unterhalb von scope (Standard: ganzes Dokument)
  function apply(scope) {
    var base = scope || document;
    root.lang = lang;
    var nodes = base.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var text = t(nodes[i].getAttribute('data-i18n'));
      if (nodes[i].textContent !== text) nodes[i].textContent = text;
      // Steht der Text in einem Bereich mit eigener Sprache (z. B. deutscher Changelog),
      // die Sprache am Element selbst angeben (Screenreader-Aussprache)
      var holder = nodes[i].parentElement && nodes[i].parentElement.closest('[lang]');
      if (holder && holder !== root) nodes[i].lang = lang;
    }
    var attrs = base.querySelectorAll('[data-i18n-attr]');
    for (var j = 0; j < attrs.length; j++) {
      var pairs = attrs[j].getAttribute('data-i18n-attr').split(';');
      for (var k = 0; k < pairs.length; k++) {
        var idx = pairs[k].indexOf(':');
        if (idx > 0) attrs[j].setAttribute(pairs[k].slice(0, idx).trim(), t(pairs[k].slice(idx + 1).trim()));
      }
    }
    var only = base.querySelectorAll('[data-lang-only]');
    for (var m = 0; m < only.length; m++) only[m].hidden = only[m].getAttribute('data-lang-only') !== lang;
    syncSwitcher();
  }

  function writeCookie(value) {
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = COOKIE + '=' + value + '; Path=/; Max-Age=31536000; SameSite=Lax' + secure;
  }

  function setLang(next) {
    if (LANGS.indexOf(next) === -1 || next === lang) return lang;
    lang = next;
    writeCookie(next);
    apply(document);
    var ev;
    try { ev = new CustomEvent('openweb:langchange', { detail: { lang: lang } }); } catch (e) {
      ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('openweb:langchange', false, false, { lang: lang });
    }
    document.dispatchEvent(ev);
    return lang;
  }

  // ---------- Umschalter (DE | EN) oben rechts, neben dem Design-Waehler ----------
  var switcher = null;

  // Gemeinsamer Platz fuer Bedienelemente oben (Sprache, Design); app.js haengt den
  // Design-Waehler ebenfalls hier ein.
  function controls() {
    var box = document.getElementById('page-controls');
    if (!box) {
      box = document.createElement('div');
      box.id = 'page-controls';
      box.className = 'page-controls';
      document.body.appendChild(box);
    }
    return box;
  }

  function buildSwitcher() {
    if (switcher || !document.body || document.body.hasAttribute('data-no-lang-switch')) return;
    switcher = document.createElement('div');
    switcher.className = 'lang-switch';
    switcher.setAttribute('role', 'group');
    LANGS.forEach(function (code) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lang-switch-btn';
      btn.lang = code;
      btn.setAttribute('data-lang', code);
      btn.textContent = code.toUpperCase();
      btn.addEventListener('click', function () { setLang(code); });
      switcher.appendChild(btn);
    });
    controls().insertBefore(switcher, controls().firstChild);
    syncSwitcher();
  }

  function syncSwitcher() {
    if (!switcher) return;
    switcher.setAttribute('aria-label', t('lang.group'));
    var buttons = switcher.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var code = buttons[i].getAttribute('data-lang');
      buttons[i].setAttribute('aria-pressed', String(code === lang));
      buttons[i].title = NAMES[code];
      buttons[i].setAttribute('aria-label', code === lang ? t('lang.name.' + code) : t('lang.switchTo', { name: t('lang.name.' + code) }));
    }
  }

  // Kein Aufblitzen des deutschen Textes: bis zur Uebersetzung unsichtbar (styles.css),
  // mit Sicherheitsnetz, falls etwas schiefgeht.
  root.lang = lang;
  if (lang !== 'de') {
    root.classList.add('i18n-pending');
    setTimeout(function () { root.classList.remove('i18n-pending'); }, 2500);
  }

  function ready() {
    try {
      buildSwitcher();
      apply(document);
    } finally {
      root.classList.remove('i18n-pending');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  window.OpenWebI18n = {
    langs: LANGS.slice(),
    lang: function () { return lang; },
    locale: function () { return LOCALES[lang]; },
    t: t,
    apply: apply,
    setLang: setLang,
    controls: controls
  };
})();
