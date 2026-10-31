// =========================================================
// Öffentliche API-Routen
// =========================================================

const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../lib/db');
const auth = require('../lib/auth');
const v = require('../lib/validators');
const { parseUserAgent, parseCountryCode } = require('../lib/analytics');
const audit = require('../lib/audit');
const alert = require('../lib/alert');
const contact = require('../lib/contact');
const icons = require('../lib/icons');
const { visibilityColumns, getNowInBerlin, isLinkVisible, isProfileHiddenFor } = require('../lib/visibility');
const webauthnRp = require('../lib/webauthn-rp');

const router = express.Router();

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id) && !/^[0-9a-fA-F-]{36}$/.test(id) && !/^[a-z0-9-]+$/.test(id)) {
    return res.status(400).json({ ok: false, error: 'Ungültige ID' });
  }
  next();
});

// API-Keys sind 256-Bit-Zufallswerte: Suche ueber einen SHA-256-Index (key_lookup) statt
// bcrypt-Vergleich gegen jeden gespeicherten Key. Aeltere Keys ohne key_lookup werden einmalig
// per bcrypt geprueft und beim ersten erfolgreichen Abruf nachgetragen.
function apiKeyLookup(key) {
  return require('crypto').createHash('sha256').update(key).digest('hex');
}

async function requireApiKey(req, res, next) {
  try {
    const key = req.headers['x-api-key'];
    if (!key || typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) {
      req.loginRateLimit?.increment(true);
      return res.status(401).json({ ok: false, error: 'API-Key erforderlich' });
    }
    const lookup = apiKeyLookup(key);
    let match = null;
    const { rows } = await db.query('SELECT id, key_hash FROM api_keys WHERE key_lookup = $1 LIMIT 1', [lookup]);
    if (rows[0] && await bcrypt.compare(key, rows[0].key_hash)) {
      match = rows[0];
    } else if (!rows[0]) {
      const { rows: legacy } = await db.query('SELECT id, key_hash FROM api_keys WHERE key_lookup IS NULL');
      for (const r of legacy) {
        if (await bcrypt.compare(key, r.key_hash)) { match = r; break; }
      }
      if (match) await db.query('UPDATE api_keys SET key_lookup = $1 WHERE id = $2 AND key_lookup IS NULL', [lookup, match.id]);
    }
    if (!match) {
      req.loginRateLimit?.increment(true);
      return res.status(401).json({ ok: false, error: 'Ungueltiger API-Key' });
    }
    req.loginRateLimit?.increment(false);
    await db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [match.id]);
    next();
  } catch (err) {
    next(err);
  }
}

// Einfacher In-Memory Rate-Limiter (Brute-Force-Schutz), getrennte Zaehler je Zweck
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 Minuten
const LOGIN_MAX_ATTEMPTS = 10;

// resetOnSuccess: Erfolg setzt den Zaehler komplett zurueck (Login). Sonst wird nur der
// eigene Versuch zurueckgebucht (Link-Entsperren: ein bekanntes Passwort darf nicht die
// Sperre fuer andere Links aufheben).
function createAttemptLimiter(message, { resetOnSuccess = true } = {}) {
  const attempts = new Map();

  // Alte Eintraege regelmaessig aufraeumen
  setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of attempts.entries()) {
      if (now >= record.resetAt) attempts.delete(ip);
    }
  }, 60 * 1000).unref();

  return function limiter(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let record = attempts.get(ip);
    if (!record || now >= record.resetAt) {
      record = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      attempts.set(ip, record);
    }
    if (record.count >= LOGIN_MAX_ATTEMPTS) {
      const retryAfter = Math.ceil((record.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ ok: false, error: `${message} Bitte in ${retryAfter} Sekunden erneut versuchen.` });
    }
    // Versuch sofort (synchron) zaehlen: parallele Anfragen koennen das Limit so nicht
    // umgehen, waehrend bcrypt noch rechnet. Erfolg bucht den Versuch wieder zurueck.
    record.count += 1;
    let settled = false;
    req.loginRateLimit = {
      ip,
      increment: (failed) => {
        if (settled) return;
        settled = true;
        if (failed) return; // bereits gezaehlt
        if (resetOnSuccess) attempts.delete(ip);
        else record.count = Math.max(0, record.count - 1);
      },
    };
    next();
  };
}

// bcrypt-Hash fuer Vergleiche bei unbekannten E-Mail-Adressen (einmalig zur Laufzeit erzeugt)
let dummyHashPromise = null;
function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = auth.hashPassword(require('crypto').randomBytes(16).toString('hex'));
  return dummyHashPromise;
}

const rateLimitLogin = createAttemptLimiter('Zu viele Anmeldeversuche.');
const rateLimitUnlock = createAttemptLimiter('Zu viele Passwortversuche.', { resetOnSuccess: false });
const rateLimitApiKey = createAttemptLimiter('Zu viele ungueltige API-Keys.', { resetOnSuccess: false });

// Zusaetzlicher Zaehler je Konto (nicht je IP): Fehlversuche aus beliebig vielen IPs zaehlen
// gemeinsam.
// - TOTP: nach ACCOUNT_LIMITS.totp Fehlversuchen wird der 2FA-Schritt fuer das Konto gesperrt.
//   Diesen Schritt erreicht nur, wer das Passwort kennt – ein Fremder kann den Admin so nicht
//   aussperren.
// - Passwort: nur Alarm an den Admin, KEINE Sperre (sonst koennte jeder anonym den Login des
//   Admins dauerhaft blockieren). Der Schutz kommt hier aus dem IP-Limit und dem Alarm.
const ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
const ACCOUNT_LIMITS = { password: 30, totp: 10 };
const ACCOUNT_LOCKING = { password: false, totp: true };
const accountFailures = new Map(); // `${factor}:${userId}` -> { count, resetAt, alerted }

setInterval(() => {
  const now = Date.now();
  for (const [k, r] of accountFailures.entries()) if (now >= r.resetAt) accountFailures.delete(k);
}, 60 * 1000).unref();

function accountRecord(factor, userId) {
  const key = `${factor}:${userId}`;
  const now = Date.now();
  let r = accountFailures.get(key);
  if (!r || now >= r.resetAt) {
    r = { count: 0, resetAt: now + ACCOUNT_WINDOW_MS, alerted: false };
    accountFailures.set(key, r);
  }
  return r;
}

// Antwortet mit 429 und gibt true zurueck, wenn der Faktor fuer dieses Konto gesperrt ist
function accountLocked(res, factor, userId) {
  if (!ACCOUNT_LOCKING[factor]) return false;
  const r = accountRecord(factor, userId);
  if (r.count < ACCOUNT_LIMITS[factor]) return false;
  const retryAfter = Math.ceil((r.resetAt - Date.now()) / 1000);
  res.setHeader('Retry-After', retryAfter);
  res.status(429).json({ ok: false, error: `Zu viele Fehlversuche fuer dieses Konto. Bitte in ${retryAfter} Sekunden erneut versuchen.` });
  return true;
}

function recordAccountFailure(req, factor, user) {
  const r = accountRecord(factor, user.id);
  r.count += 1;
  if (r.count >= ACCOUNT_LIMITS[factor] && !r.alerted) {
    r.alerted = true;
    alert.notify('login', `Viele fehlgeschlagene Anmeldeversuche (${factor === 'totp' ? '2FA-Code' : 'Passwort'})`, {
      email: user.email,
      ip: req.ip || req.socket?.remoteAddress || '-',
      attempts: String(r.count),
      time: new Date().toISOString(),
    }).catch(() => {});
  }
}

function clearAccountFailures(userId) {
  for (const factor of Object.keys(ACCOUNT_LIMITS)) accountFailures.delete(`${factor}:${userId}`);
}

// Session-ID nach Login neu erzeugen (Schutz vor Session Fixation), Daten uebernehmen
function regenerateSession(req, data) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      Object.assign(req.session, data);
      resolve();
    });
  });
}

// "Profil nicht oeffentlich": Profil und Links nur fuer eingeloggte Admins (Vorschau)
async function requirePublicProfile(req, res, next) {
  try {
    if (await isProfileHiddenFor(req)) {
      return res.status(403).json({ ok: false, error: 'Dieses Profil ist nicht oeffentlich' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

router.get('/profile', requirePublicProfile, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM profile WHERE id = 1 LIMIT 1');
    const profile = rows[0] || {
      name: '@corneliusahner',
      handle: 'Cornelius Ahner',
      bio: 'Azubi, 21 Jahre alt',
      avatar: 'CA',
      avatar_url: null,
      theme: 'dark',
      player_progress_style: 'time',
    };
    // Kontakt-Knopf nur anzeigen, wenn Formular aktiv und SMTP eingerichtet ist
    res.json({ ok: true, data: { ...profile, contact_enabled: await contact.isAvailable() } });
  } catch (err) {
    next(err);
  }
});

// ---------- Kontaktformular ----------
// Oeffentlich noetig, damit Besucher schreiben koennen. Schutz: Formular-Token (Mindest-
// Ausfuellzeit, einmalig), Honeypot, Limit je IP (hier) und gesamt (lib/contact.js).
// CSRF-Pruefung (Origin) greift fuer POST automatisch. Nachrichten werden nicht gespeichert.
const CONTACT_IP_MAX = 5;
const CONTACT_IP_WINDOW_MS = 60 * 60 * 1000;
const contactByIp = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of contactByIp) if (now >= r.resetAt) contactByIp.delete(ip);
}, 5 * 60 * 1000).unref();

function contactIpLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let record = contactByIp.get(ip);
  if (!record || now >= record.resetAt) {
    record = { count: 0, resetAt: now + CONTACT_IP_WINDOW_MS };
    contactByIp.set(ip, record);
  }
  if (record.count >= CONTACT_IP_MAX) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({ ok: false, error: 'Du hast schon mehrere Nachrichten gesendet. Bitte versuche es später erneut.' });
  }
  req.contactLimit = record;
  next();
}

router.get('/contact/token', requirePublicProfile, async (req, res, next) => {
  try {
    const status = await contact.getStatus();
    if (!status.available) return res.status(403).json({ ok: false, error: 'Das Kontaktformular ist derzeit nicht verfügbar.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, data: { token: contact.issueToken(), intro_text: status.intro_text, limits: contact.LIMITS } });
  } catch (err) {
    next(err);
  }
});

router.post('/contact', requirePublicProfile, contactIpLimit, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT name, handle FROM profile WHERE id = 1 LIMIT 1');
    const result = await contact.submit(req.body || {}, { profile: rows[0] });
    // Versuche zaehlen, die bis zum Versand kamen (auch bei SMTP-Fehler), nicht Tippfehler
    if (result.status === 200 || result.status === 502) req.contactLimit.count += 1;
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: result.error, field: result.field, code: result.code });
    }
    res.json({ ok: true, data: { sent: true } });
  } catch (err) {
    next(err);
  }
});

// Rechtstexte muessen auch bei einem nicht oeffentlichen Profil ohne Admin-Login erreichbar sein.
router.get('/legal-content', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT impressum_text, datenschutz_text FROM profile WHERE id = 1 LIMIT 1'
    );
    res.json({
      ok: true,
      data: rows[0] || { impressum_text: '', datenschutz_text: '' },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/links/categories', requirePublicProfile, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, name, position FROM link_categories ORDER BY position ASC, name ASC');
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

router.get('/links', requirePublicProfile, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT l.id, l.title, l.subtitle, l.url, l.display_url, l.icon, l.position,
             l.open_new, l.meta_description, l.slug, ${visibilityColumns('l')},
             l.category_id, c.name AS category_name, c.position AS category_position,
             l.password_hash IS NOT NULL AS is_password_protected
      FROM links l
      LEFT JOIN link_categories c ON c.id = l.category_id
      WHERE l.is_active = true
      ORDER BY c.position ASC NULLS FIRST, c.name ASC, l.position ASC, l.created_at ASC
    `);
    const nowBerlin = getNowInBerlin();
    const visible = rows.filter(l => isLinkVisible(l, nowBerlin));
    // Passwort-Hashes nie an Client senden; Ziel-URL geschuetzter Links erst nach Entsperren
    // Icon-Aufloesung braucht die echte URL (auch bei geschuetzten Links), ausgeliefert wird sie nicht
    const safe = visible.map(l => ({
      ...l,
      password_hash: undefined,
      icon_resolved: icons.resolveIcon(l),
      url: l.is_password_protected ? null : l.url,
    }));
    res.json({ ok: true, data: safe });
  } catch (err) {
    next(err);
  }
});

router.post('/links/:id/unlock', rateLimitUnlock, async (req, res, next) => {
  try {
    const { id } = req.params;
    // Gleiche Regeln wie die oeffentliche Linkliste: verborgene, abgelaufene, zeitlich noch nicht
    // freigegebene Links und Links eines nicht oeffentlichen Profils gelten als "nicht gefunden".
    const hidden = await isProfileHiddenFor(req);
    const { rows } = await db.query(`SELECT id, url, password_hash, ${visibilityColumns()} FROM links WHERE id = $1 LIMIT 1`, [id]);
    if (hidden || !rows.length || !isLinkVisible(rows[0])) {
      req.loginRateLimit?.increment(false);
      return res.status(404).json({ ok: false, error: 'Link nicht gefunden' });
    }
    const link = rows[0];
    if (!link.password_hash) {
      req.loginRateLimit?.increment(false);
      return res.json({ ok: true, data: { url: link.url } });
    }
    const password = String(req.body.password || '').slice(0, 1000);
    const valid = await bcrypt.compare(password, link.password_hash);
    if (!valid) {
      req.loginRateLimit?.increment(true);
      return res.status(401).json({ ok: false, error: 'Falsches Passwort' });
    }
    req.loginRateLimit?.increment(false);
    res.json({ ok: true, data: { url: link.url } });
  } catch (err) {
    next(err);
  }
});

async function sendDiscordWebhook(payload) {
  try {
    const { rows } = await db.query('SELECT discord_webhook_enabled, discord_webhook_url, discord_webhook_template FROM admin_settings WHERE id = 1 LIMIT 1');
    const cfg = rows[0] || {};
    if (!cfg.discord_webhook_enabled || !cfg.discord_webhook_url) return;
    const url = cfg.discord_webhook_url;
    const template = cfg.discord_webhook_template || 'Neuer Klick auf **{{title}}** ({{url}})';
    // Replacer-Funktionen: $&, $1 usw. in Titeln/URLs bleiben wortwoertlich
    const text = template
      .replace(/\{\{title\}\}/g, () => payload.title || 'Unbekannt')
      .replace(/\{\{url\}\}/g, () => payload.url || '')
      .replace(/\{\{timestamp\}\}/g, () => new Date().toISOString());
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 2000) }),
    });
  } catch (err) {
    console.warn('[discord webhook] send failed:', err.message);
  }
}

// UTM-Werte stammen von anonymen Besuchern: fuehrende Formelzeichen entfernen (CSV-Export)
function safeUtm(value) {
  return v.safeText(value, 120).replace(/^[=+\-@]+/, '');
}

router.post('/links/:id/click', async (req, res, next) => {
  try {
    const { id } = req.params;
    // Nur Klicks auf aktuell oeffentlich sichtbare Links zaehlen und melden
    const hidden = await isProfileHiddenFor(req);
    const linkRes = await db.query(`SELECT id, title, url, password_hash IS NOT NULL AS is_password_protected, ${visibilityColumns()} FROM links WHERE id = $1 LIMIT 1`, [id]);
    const link = linkRes.rows[0];
    if (hidden || !link || !isLinkVisible(link)) {
      return res.status(404).json({ ok: false, error: 'Link nicht gefunden' });
    }
    const ip = req.ip || req.socket?.remoteAddress || null;
    const ipHash = ip ? require('crypto').createHash('sha256').update(ip).digest('hex') : null;
    const utm = req.body.utm || {};
    const ua = req.headers['user-agent'] || '';
    const { browser, os, deviceType } = parseUserAgent(ua);
    const country = parseCountryCode(req);
    await db.query(`
      INSERT INTO link_clicks (link_id, ip_hash, user_agent, referrer, utm_source, utm_medium, utm_campaign, country_code, device_type, browser, os)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      link.id,
      ipHash,
      ua.slice(0, 500) || null,
      req.headers.referer?.slice(0, 500) || null,
      safeUtm(utm.source),
      safeUtm(utm.medium),
      safeUtm(utm.campaign),
      country,
      deviceType,
      browser,
      os,
    ]);
    // Asynchroner Discord-Webhook ohne Antwort zu blockieren.
    // Ziel geschuetzter Links nicht in den (evtl. geteilten) Discord-Kanal posten
    const payload = { title: link.title, url: link.is_password_protected ? '(passwortgeschuetzt)' : link.url };
    sendDiscordWebhook(payload).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Dashboard-Icon-Proxy mit Speicher-Cache: Logos aendern sich praktisch nie, jsdelivr wird
// so pro Logo nur einmal gefragt (statt bei jedem Seitenaufruf jedes Besuchers)
const ICON_CACHE_MAX = 400;
const ICON_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ICON_MISS_TTL_MS = 60 * 60 * 1000;
const ICON_MAX_BYTES = 1024 * 1024;
const iconCache = new Map(); // key -> { status, body, type, expires }

function iconCacheGet(key) {
  const hit = iconCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { iconCache.delete(key); return null; }
  // LRU: zuletzt genutzte ans Ende
  iconCache.delete(key);
  iconCache.set(key, hit);
  return hit;
}

function iconCacheSet(key, entry) {
  iconCache.set(key, entry);
  while (iconCache.size > ICON_CACHE_MAX) iconCache.delete(iconCache.keys().next().value);
}

router.get('/icon/dashboardicon/:name/:format?', async (req, res, next) => {
  try {
    const name = req.params.name;
    const format = req.params.format || 'png';
    if (!/^[a-z0-9-]{1,80}$/.test(name) || !['png', 'svg', 'webp'].includes(format)) {
      return res.status(400).send('Bad Request');
    }
    const key = `${name}.${format}`;
    let entry = iconCacheGet(key);
    if (!entry) {
      const url = `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/${format}/${key}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        entry = { status: 404, expires: Date.now() + ICON_MISS_TTL_MS };
      } else {
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > ICON_MAX_BYTES) return res.status(502).send('Icon zu gross');
        entry = { status: 200, body, type: format === 'svg' ? 'image/svg+xml' : `image/${format}`, expires: Date.now() + ICON_CACHE_TTL_MS };
      }
      iconCacheSet(key, entry);
    }
    if (entry.status !== 200) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(404).send('Not Found');
    }
    res.setHeader('Content-Type', entry.type);
    // Fremd-SVGs duerfen bei Direktaufruf keine Skripte ausfuehren
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    res.end(entry.body);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return res.status(504).send('Icon-Quelle antwortet nicht');
    next(err);
  }
});

router.get('/qr-code', async (req, res, next) => {
  try {
    const text = req.query.text;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'text Parameter fehlt' });
    }
    const safeText = text.slice(0, 1000);
    const dataUrl = await require('qrcode').toDataURL(safeText, {
      width: 400,
      margin: 2,
      color: { dark: '#11111f', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
    res.json({ ok: true, data: { dataUrl } });
  } catch (err) {
    next(err);
  }
});

router.get('/public/profile', rateLimitApiKey, requireApiKey, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT name, handle, bio, avatar, avatar_url, theme, is_public, allow_visitor_theme, icon_style, player_progress_style FROM profile WHERE id = 1 LIMIT 1');
    res.json({ ok: true, data: rows[0] || null });
  } catch (err) { next(err); }
});

router.get('/public/links', rateLimitApiKey, requireApiKey, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT l.id, l.title, l.subtitle, l.url, l.display_url, l.icon, l.position,
             l.open_new, l.meta_description, l.slug, ${visibilityColumns('l')},
             l.category_id, c.name AS category_name,
             l.password_hash IS NOT NULL AS is_password_protected
      FROM links l
      LEFT JOIN link_categories c ON c.id = l.category_id
      WHERE l.is_active = true
      ORDER BY c.position ASC NULLS FIRST, c.name ASC, l.position ASC, l.created_at ASC
    `);
    const nowBerlin = getNowInBerlin();
    const visible = rows.filter(l => isLinkVisible(l, nowBerlin));
    // Wie /api/links: Ziel geschuetzter Links auch per API-Key nur ueber /links/:id/unlock
    const safe = visible.map(l => ({
      ...l,
      icon_resolved: icons.resolveIcon(l),
      url: l.is_password_protected ? null : l.url,
    }));
    res.json({ ok: true, data: safe });
  } catch (err) { next(err); }
});

router.post('/login', rateLimitLogin, async (req, res, next) => {
  try {
    const email = v.validateEmail(req.body.email);
    const password = req.body.password;
    if (!email) {
      req.loginRateLimit?.increment(true);
      return res.status(400).json({ ok: false, error: 'E-Mail erforderlich' });
    }

    const user = await auth.findUserByEmail(email);
    if (!user) {
      // Gleiche Laufzeit wie bei existierendem User (erschwert User-Enumeration per Timing)
      if (password) await auth.verifyPassword(password, await getDummyHash()).catch(() => {});
      req.loginRateLimit?.increment(true);
      return res.status(401).json({ ok: false, error: 'Ungueltige Anmeldedaten' });
    }

    const db = require('../lib/db');
    const { rows } = await db.query('SELECT id FROM webauthn_credentials WHERE user_id = $1 LIMIT 1', [user.id]);
    const hasWebAuthn = rows.length > 0;

    let passwordValid = false;
    if (password) {
      if (accountLocked(res, 'password', user.id)) {
        req.loginRateLimit?.increment(true);
        return;
      }
      passwordValid = await auth.verifyPassword(password, user.password_hash);
      if (!passwordValid) {
        recordAccountFailure(req, 'password', user);
        req.loginRateLimit?.increment(true);
        return res.status(401).json({ ok: false, error: 'Ungueltige Anmeldedaten' });
      }
    } else if (!hasWebAuthn) {
      req.loginRateLimit?.increment(true);
      return res.status(400).json({ ok: false, error: 'Passwort erforderlich' });
    }

    // 2FA / WebAuthn Check
    // If logged in WITHOUT password, ONLY WebAuthn is allowed.
    // If logged in WITH password, TOTP is also allowed.
    const allowedMethods = [];
    if (hasWebAuthn) allowedMethods.push('webauthn');
    if (passwordValid && user.totp_enabled) allowedMethods.push('totp');

    if (allowedMethods.length > 0) {
      // Zaehler bewusst NICHT zuruecksetzen: sonst koennte man nach jedem
      // Passwort-Login erneut 10 TOTP-Codes durchprobieren (Brute-Force).
      await regenerateSession(req, {
        pendingUserId: user.id,
        pendingRemember: req.body.remember === true ? true : undefined,
        // If they didn't provide a password, we MUST enforce that they use WebAuthn to complete the login
        pendingRequiresWebAuthn: !passwordValid,
      });

      await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
      return res.json({ 
        ok: true, 
        data: {
          requires_2fa: true, 
          methods: allowedMethods
        }
      });
    }

    req.loginRateLimit?.increment(false);
    clearAccountFailures(user.id);
    await regenerateSession(req, { userId: user.id, email: user.email });

    // Eingeloggt bleiben: Session-Cookie auf 30 Tage verlängern
    if (req.body.remember === true) {
      const rememberMs = 30 * 24 * 60 * 60 * 1000;
      req.session.cookie.originalMaxAge = rememberMs;
      req.session.cookie.maxAge = rememberMs;
      req.session.cookie.expires = new Date(Date.now() + rememberMs);
    }

    req.session.touch();
    await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));

    await audit.log(req, 'login', 'user', user.id);

    alert.notify('login', 'Admin-Login erkannt', {
      email: user.email,
      ip: req.ip || req.socket?.remoteAddress || '-',
      userAgent: req.headers['user-agent'] || '-',
      country: parseCountryCode(req) || '-',
      time: new Date().toISOString(),
    }).catch(() => {});

    res.json({ ok: true, data: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});

  // ---------- 2FA Login Endpoints ----------
  
  async function completeLogin(req, res, user) {
    clearAccountFailures(user.id);
    const remember = !!req.session.pendingRemember;
    await regenerateSession(req, { userId: user.id, email: user.email });
    if (remember) {
      const rememberMs = 30 * 24 * 60 * 60 * 1000;
      req.session.cookie.originalMaxAge = rememberMs;
      req.session.cookie.maxAge = rememberMs;
      req.session.cookie.expires = new Date(Date.now() + rememberMs);
    }
    req.session.touch();
    await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));

    const audit = require('../lib/audit');
    const alert = require('../lib/alert');
    const { parseCountryCode } = require('../lib/analytics');
    await audit.log(req, 'login_2fa', 'user', user.id);
    alert.notify('login', 'Admin-Login erkannt (2FA)', {
      email: user.email,
      ip: req.ip || req.socket?.remoteAddress || '-',
      userAgent: req.headers['user-agent'] || '-',
      country: parseCountryCode(req) || '-',
      time: new Date().toISOString(),
    }).catch(() => {});
    res.json({ ok: true, data: { id: user.id, email: user.email } });
  }

  router.post('/login/totp', rateLimitLogin, async (req, res, next) => {
    try {
      if (!req.session.pendingUserId) return res.status(401).json({ ok: false, error: 'Session abgelaufen' });
      if (req.session.pendingRequiresWebAuthn) return res.status(403).json({ ok: false, error: 'Passwort wurde nicht eingegeben. Diese Anmeldung erfordert einen Security Key.' });
      
      const db = require('../lib/db');
      const { rows } = await db.query('SELECT * FROM users WHERE id = $1 AND is_active = true', [req.session.pendingUserId]);
      const user = rows[0];
      if (!user || !user.totp_enabled || !user.totp_secret) {
        return res.status(400).json({ ok: false, error: 'TOTP nicht konfiguriert' });
      }
      if (accountLocked(res, 'totp', user.id)) {
        req.loginRateLimit?.increment(true);
        return;
      }
      const totp = require('../lib/totp');
      const result = await totp.verifyCode(req.body.code, user.totp_secret, user.totp_last_timestep);
      if (!result.valid) {
        recordAccountFailure(req, 'totp', user);
        req.loginRateLimit?.increment(true);
        return res.status(401).json({ ok: false, error: 'Ungueltiger Code' });
      }
      // Code als verbraucht markieren (atomar, falls zwei Anfragen gleichzeitig kommen)
      const { rowCount } = await db.query(
        'UPDATE users SET totp_last_timestep = $1 WHERE id = $2 AND (totp_last_timestep IS NULL OR totp_last_timestep < $1)',
        [result.timeStep, user.id]
      );
      if (!rowCount) {
        req.loginRateLimit?.increment(true);
        return res.status(401).json({ ok: false, error: 'Ungueltiger Code' });
      }
      req.loginRateLimit?.increment(false);
      await completeLogin(req, res, user);
    } catch (err) { next(err); }
  });

  router.post('/login/webauthn/options', rateLimitLogin, async (req, res, next) => {
    try {
      if (!req.session.pendingUserId) return res.status(401).json({ ok: false, error: 'Session abgelaufen' });
      const db = require('../lib/db');
      const { rows } = await db.query('SELECT credential_id FROM webauthn_credentials WHERE user_id = $1', [req.session.pendingUserId]);
      if (!rows.length) return res.status(400).json({ ok: false, error: 'Keine YubiKeys registriert' });
      
      const { generateAuthenticationOptions } = require('@simplewebauthn/server');
      const options = await generateAuthenticationOptions({
        rpID: webauthnRp.getRelyingParty(req).rpID,
        allowCredentials: rows.map(r => ({
          id: r.credential_id,
          type: 'public-key',
        })),
        userVerification: 'preferred',
      });
      await db.query('UPDATE users SET webauthn_current_challenge = $1 WHERE id = $2', [options.challenge, req.session.pendingUserId]);
      res.json({ ok: true, data: options });
    } catch (err) { next(err); }
  });

  router.post('/login/webauthn/verify', rateLimitLogin, async (req, res, next) => {
    try {
      if (!req.session.pendingUserId) return res.status(401).json({ ok: false, error: 'Session abgelaufen' });
      const db = require('../lib/db');
      const { rows } = await db.query('SELECT * FROM users WHERE id = $1 AND is_active = true', [req.session.pendingUserId]);
      const user = rows[0];
      if (!user || !user.webauthn_current_challenge) return res.status(400).json({ ok: false, error: 'Kein aktiver Challenge' });
      
      const expectedChallenge = user.webauthn_current_challenge;
      // Challenge ist nur einmal gueltig – auch bei fehlgeschlagener Pruefung
      await db.query('UPDATE users SET webauthn_current_challenge = NULL WHERE id = $1', [user.id]);
      const { verifyAuthenticationResponse } = require('@simplewebauthn/server');
      
      const body = req.body;
      if (!body || typeof body.id !== 'string') return res.status(400).json({ ok: false, error: 'Ungueltige Anfrage' });
      const { rows: creds } = await db.query('SELECT * FROM webauthn_credentials WHERE user_id = $1 AND credential_id = $2', [user.id, body.id]);
      const authenticator = creds[0];
      if (!authenticator) {
        req.loginRateLimit?.increment(true);
        return res.status(400).json({ ok: false, error: 'Key nicht gefunden' });
      }
      
      // RP-ID und erlaubte Origin kommen aus APP_URL, nicht aus Host-/X-Forwarded-Host-Headern
      const rp = webauthnRp.getRelyingParty(req);

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: body,
          expectedChallenge,
          expectedOrigin: rp.origins,
          expectedRPID: rp.rpID,
          credential: {
            id: authenticator.credential_id,
            publicKey: authenticator.public_key,
            counter: Number(authenticator.counter),
          },
        });
      } catch (verifyErr) {
        req.loginRateLimit?.increment(true);
        console.warn('[login webauthn] Verifizierung fehlgeschlagen:', verifyErr.message);
        return res.status(401).json({ ok: false, error: 'Verifizierung fehlgeschlagen' });
      }

      if (verification.verified) {
        await db.query('UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE id = $2', [verification.authenticationInfo.newCounter, authenticator.id]);
        req.loginRateLimit?.increment(false);
        await completeLogin(req, res, user);
      } else {
        req.loginRateLimit?.increment(true);
        res.status(401).json({ ok: false, error: 'Verifizierung fehlgeschlagen' });
      }
    } catch (err) { next(err); }
  });

module.exports = router;
