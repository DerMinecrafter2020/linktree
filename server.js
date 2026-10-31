// =========================================================
// OpenWeb — Link-in-Bio Server (Node.js + Express + PostgreSQL)
// =========================================================

require('./lib/paths').loadEnv();

const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const compression = require('compression');
const setup = require('./lib/setup');
const metrics = require('./lib/metrics');
const { validateTheme } = require('./lib/validators');
const i18n = require('./lib/i18n');
const maintenanceMode = require('./lib/maintenance-mode');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
// Sicherer Standard: ohne explizites NODE_ENV=development laeuft die App im Produktionsmodus
// (keine internen Fehlermeldungen an Clients, Session-Cookie nur ueber HTTPS)
const NODE_ENV = process.env.NODE_ENV || 'production';

// Health-Check vor Setup, damit Load-Balancer / Uptime-Checker funktionieren
let setupMode = false;

// Ressourcenmonitor: zaehlt alle Anfragen (Anzahl, Antwortzeit, 5xx)
app.use(metrics.middleware);

app.get('/health', async (req, res) => {
  // Im Setup-Modus lib/db NICHT laden: der Pool wuerde mit der noch leeren Konfiguration
  // gecacht und das anschliessende Web-Setup (Migrationen/Seeding) daran scheitern.
  if (setupMode) return res.json({ ok: true, status: 'setup' });
  try {
    const db = require('./lib/db');
    await db.query('SELECT 1');
    res.json({ ok: true, status: 'healthy', database: 'connected' });
  } catch (err) {
    // Fehlerdetails (z. B. DB-Host) nicht oeffentlich preisgeben
    if (NODE_ENV === 'production') console.error('[health] DB-Check fehlgeschlagen:', err.message);
    res.status(503).json({ ok: false, status: 'unhealthy', database: 'disconnected', error: NODE_ENV === 'production' ? undefined : err.message });
  }
});

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Anzahl vertrauenswuerdiger Reverse-Proxys (Standard: 1). Ohne Proxy TRUST_PROXY=0 setzen,
// sonst koennen Clients ihre IP per X-Forwarded-For faelschen (Rate-Limits / IP-Allowlist).
function parseTrustProxy(raw) {
  if (raw === undefined || raw === '') return 1;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw; // z. B. 'loopback' oder IP-/Subnetz-Liste
}
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.disable('x-powered-by');

// =========================================================
// Express-App konfigurieren
// =========================================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Kein 'unsafe-inline': eingeschleuste <script>-Tags werden vom Browser blockiert.
      // jsdelivr nur fuer @simplewebauthn/browser (per SRI-Hash abgesichert)
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@9.0.1/"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      scriptSrcAttr: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  next();
});

// Bot-Schutz: gesperrte IPs ablehnen, verdaechtige Seitenaufrufe pruefen (lib/botguard.js).
// Steht vor Static/Routen; bis zum Laden der Einstellungen in finalizeApp laesst er alles durch.
const botguard = require('./lib/botguard');
app.use(botguard.middleware);

// admin.html/index.html in keiner Schreibweise direkt ausliefern (z. B. /%61dmin.html, //admin.html,
// /ADMIN.HTML), sonst werden IP-Allowlist bzw. Sichtbarkeitseinstellung umgangen
app.use((req, res, next) => {
  let decoded;
  try {
    decoded = decodeURIComponent(req.path);
  } catch {
    return next();
  }
  const file = path.posix.basename(decoded.replace(/\\/g, '/')).replace(/[.\s]+$/, '').toLowerCase();
  if (file === 'admin.html') return res.redirect('/admin');
  // Startseite nur ueber die dynamische Route "/" (prueft u. a. "Profil nicht oeffentlich")
  if (file === 'index.html') return res.redirect('/');
  // Template der Wartungsseite (Platzhalter) nur ueber "/" im Wartungsmodus
  if (file === 'maintenance.html') return sendHtml(res, '404.html', 404);
  next();
});

// CSRF-Schutz: zustandsaendernde API-Aufrufe aus dem Browser nur von der eigenen Origin
// (Schema + Host + Port). Ergaenzt SameSite=Lax, das Nachbar-Subdomains und andere Ports
// desselben Hosts nicht abdeckt.
function allowedOrigins(req) {
  const origins = new Set();
  const host = req.get('host');
  if (host) {
    origins.add(`${req.protocol}://${host}`.toLowerCase());
    // TLS endet am Proxy, ohne X-Forwarded-Proto sieht Express nur http
    origins.add(`https://${host}`.toLowerCase());
  }
  for (const raw of [process.env.APP_URL, process.env.PUBLIC_DOMAIN]) {
    if (!raw) continue;
    try {
      origins.add(new URL(raw.startsWith('http') ? raw : `https://${raw}`).origin.toLowerCase());
    } catch { /* ungueltige Konfiguration ignorieren */ }
  }
  return origins;
}

app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  // Nicht-Browser-Clients (curl, Skripte) senden keinen Origin-Header
  if (!origin) return next();
  if (origin !== 'null' && allowedOrigins(req).has(origin.toLowerCase())) return next();
  return res.status(403).json({ ok: false, error: 'Ungueltige Herkunft der Anfrage' });
});

// Hinweis: express.static wird erst in finalizeApp eingebunden. Ein globales static an dieser
// Stelle wuerde "/" und "/sw.js" vor den dynamischen Routen beantworten (is_public, OG-Tags,
// Custom CSS und die No-Cache-Header des Service Workers wuerden nie greifen).
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(compression());

// Rate Limiting für die API
const rateLimit = require('express-rate-limit');

// Strikteres Limit für Login & Setup (z.B. max 10 Versuche pro 15 Minuten)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { ok: false, error: 'Zu viele Anfragen. Bitte in 15 Minuten erneut versuchen.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Moderates Limit für allgemeine API (z.B. 200 Requests pro Minute)
// Logos (/api/icon/…) sind gecachte statische Dateien und zaehlen nicht zum API-Limit –
// sonst verbraucht allein eine Startseite mit vielen Links das Kontingent
const isIconRequest = (req) => req.path.startsWith('/icon/');

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  skip: isIconRequest,
  handler: (req, res) => res.status(429).json({ ok: false, error: i18n.t(req, 'api.limit') }),
  standardHeaders: true,
  legacyHeaders: false,
});

// Eigenes, grosszuegiges Limit fuer den Icon-Proxy (Schutz vor Massenabrufen unbekannter Namen)
const iconLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 600,
  message: 'Zu viele Icon-Anfragen',
  standardHeaders: true,
  legacyHeaders: false,
});

// Login-Endpunkte: nur fehlgeschlagene Versuche zaehlen, damit normale Logins nicht blockiert werden
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  message: { ok: false, error: 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/login', loginLimiter);
app.use('/api/setup', authLimiter);
app.use('/api/icon', iconLimiter);
app.use('/api', apiLimiter);

// =========================================================
// App je nach Setup-Status finalisieren
// =========================================================
// Eigene CSS/JS-Verweise in HTML-Seiten mit ?v=<Version> versehen (Cache-Busting bei Updates)
const APP_VERSION = require('./package.json').version;
function versionAssets(html) {
  return html.replace(/(href|src)="(\/(?:js\/[a-z0-9._-]+\.js|(?:css\/)?[a-z0-9_-]+\.css))"/gi,
    (m, attr, url) => `${attr}="${url}?v=${encodeURIComponent(APP_VERSION)}"`);
}

// HTML-Seite mit versionierten Assets senden; im Produktionsmodus einmal gelesen und gecacht
const htmlCache = new Map();
function sendHtml(res, file, status = 200) {
  let html = NODE_ENV === 'production' ? htmlCache.get(file) : null;
  if (!html) {
    html = versionAssets(fs.readFileSync(path.join(__dirname, 'public', file), 'utf8'));
    if (NODE_ENV === 'production') htmlCache.set(file, html);
  }
  res.status(status).setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
}

async function finalizeApp() {
  let setupRequired = false;
  const MAX_DB_ATTEMPTS = 10;
  for (let attempt = 1; ; attempt++) {
    try {
      setupRequired = await setup.isSetupRequired();
      break;
    } catch (err) {
      // Bei konfigurierter, aber nicht erreichbarer DB NICHT in den (oeffentlichen)
      // Setup-Modus wechseln, sondern warten bzw. mit Fehler beenden.
      console.warn(`[server] Setup-Status konnte nicht geprueft werden (Versuch ${attempt}/${MAX_DB_ATTEMPTS}):`, err.message);
      if (attempt >= MAX_DB_ATTEMPTS) {
        console.error('[FATAL] Datenbank nicht erreichbar. Server wird beendet (Neustart durch Prozessmanager).');
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  if (setupRequired) {
    setupMode = true;
    console.log('[server] Initial-Setup-Modus aktiv. Rufe /setup.html auf, um die Anwendung zu konfigurieren.');
    const setupRoutes = require('./routes/setup');
    app.use('/api/setup', setupRoutes);
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
    app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
    app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
  } else {
    try {
      require('./lib/crypto').assertKey();
    } catch (err) {
      console.error('[FATAL] NAVIDROME_ENCRYPTION_KEY fehlt oder ist ungueltig. Bitte einen 32-Byte-Hex-Schluessel (64 Hex-Zeichen) konfigurieren.');
      process.exit(1);
      return;
    }

    console.log('[server] Prüfe auf ausstehende Datenbank-Migrationen...');
    try {
      await require('./db/migrate').run();
    } catch (err) {
      console.error('[server] Fehler bei der Datenbank-Migration:', err.message);
      // Wir setzen fort, aber es könnte zu Problemen führen
    }

    await botguard.init({ versionAssets });

    const session = require('express-session');
    const PgSession = require('connect-pg-simple')(session);
    const db = require('./lib/db');
    const visibility = require('./lib/visibility');
    const og = require('./lib/og');
    const publicRoutes = require('./routes/public');
    const adminRoutes = require('./routes/admin');
    const navidromeRoutes = require('./routes/navidrome');
    const statusRoutes = require('./routes/api/status');

    // Service Worker mit eingebetteter Versionsnummer ausliefern (kein Caching!).
    // Wie die statischen Dateien VOR der Session, damit Assets keine Session-Abfrage ausloesen.
    app.get('/sw.js', (req, res) => {
      const pkg = require('./package.json');
      const swContent = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8')
        .replace('__APP_VERSION__', pkg.version);
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.send(swContent);
    });

    // Unterseiten mit eigenen CSS-/JS-Dateien versioniert und nicht direkt statisch ausliefern.
    app.get('/changelog.html', (req, res) => sendHtml(res, 'changelog.html'));
    app.get('/impressum.html', (req, res) => sendHtml(res, 'impressum.html'));
    app.get('/datenschutz.html', (req, res) => sendHtml(res, 'datenschutz.html'));

    // Statische Dateien. CSS/JS mit ?v=<Version> (von sendHtml gesetzt) duerfen ein Jahr im
    // Browser-Cache bleiben – jede neue Version hat eine neue URL. Ohne ?v= kurzer Cache.
    app.use(express.static(path.join(__dirname, 'public'), {
      index: false,
      setHeaders: (res, filePath) => {
        const versioned = Boolean(res.req?.query?.v);
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if ((filePath.endsWith('.js') || filePath.endsWith('.css')) && versioned) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
          res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
        } else if (filePath.endsWith('.woff2')) {
          res.setHeader('Cache-Control', 'public, max-age=2592000');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        }
      },
    }));
    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret || sessionSecret.startsWith('__SET_ME')) {
      console.error('[FATAL] SESSION_SECRET ist nicht konfiguriert. Bitte in .env setzen.');
      process.exit(1);
    }

    app.use(session({
      store: new PgSession({
        pool: db.pool,
        tableName: 'user_sessions',
        createTableIfMissing: true,
      }),
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      name: 'openweb.sid',
      rolling: true,
      cookie: {
        maxAge: parseInt(process.env.SESSION_MAX_AGE_MS || '86400000', 10),
        httpOnly: true,
        secure: NODE_ENV === 'production',
        sameSite: 'lax',
      },
    }));

    // Öffentliches Rate-Limiting (ausgenommen Login, das eigenen Limiter hat)
    const rateLimit = require('express-rate-limit');
    const publicLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      skip: isIconRequest,
      keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
      handler: (req, res) => res.status(429).json({ ok: false, error: i18n.t(req, 'api.tooMany') }),
    });
    app.use('/api', publicLimiter);

    // Admin-Rate-Limiting (bremst automatisierten Missbrauch, z. B. mit uebernommener Session)
    // Admin-API ist nur mit Login erreichbar; der Schutz gegen Passwort-Raten liegt bei /api/login.
    // Ein Seitenaufruf des Admins braucht ~18 Anfragen – 60 waren nach wenigen Klicks aufgebraucht.
    const adminLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
      handler: (req, res) => res.status(429).json({ ok: false, error: 'Zu viele Admin-Anfragen. Bitte warte einen Moment.' }),
    });
    app.use('/api/admin', adminLimiter);

    // Admin- und Login-Antworten (Einstellungen, Exporte, Audit-Log) nie zwischenspeichern
    const noStore = (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };
    app.use('/api/admin', noStore);
    app.use('/api/login', noStore);

    app.use('/api', publicRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/navidrome', navidromeRoutes);
    app.use('/api/status', statusRoutes);

    app.get('/setup.html', (req, res) => res.redirect('/login'));

    app.get('/admin', (req, res, next) => {
      const { isIpAllowed } = require('./lib/auth');
      if (!isIpAllowed(req)) return res.status(403).send('Admin-Zugang von dieser IP nicht erlaubt');
      if (!req.session?.userId) return res.redirect('/login');
      sendHtml(res, 'admin.html');
    });
    app.get('/login', (req, res) => sendHtml(res, 'login.html'));
    app.get('/changelog', (req, res) => sendHtml(res, 'changelog.html'));
    app.get('/api-docs', (req, res) => sendHtml(res, 'api-docs.html'));
    app.get('/robots.txt', (req, res) => {
      const publicDomain = process.env.PUBLIC_DOMAIN || '';
      res.set('Content-Type', 'text/plain');
      res.send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /login\nDisallow: /api/\nSitemap: ${req.protocol}://${publicDomain || req.get('host')}/sitemap.xml\n`);
    });

    // Server-Info (nur fuer authentifizierte Admins)
    app.get('/api/admin/server-info', async (req, res, next) => {
      try {
        if (!req.session?.userId) return res.status(401).json({ ok: false, error: 'Nicht authentifiziert' });
        const pkg = require('./package.json');
        const dbRes = await db.query(`
          SELECT
            (SELECT COUNT(*) FROM links) AS links,
            (SELECT COUNT(*) FROM link_clicks) AS clicks,
            (SELECT COUNT(*) FROM link_categories) AS categories,
            (SELECT COUNT(*) FROM api_keys) AS api_keys,
            (SELECT COUNT(*) FROM user_sessions) AS sessions,
            (SELECT pg_size_pretty(pg_database_size(current_database()))) AS db_size
        `);
        res.json({
          ok: true,
          data: {
            version: pkg.version,
            nodeEnv: NODE_ENV,
            uptime: process.uptime(),
            ...dbRes.rows[0],
          },
        });
      } catch (err) { next(err); }
    });

    // Sitemap-Generierung
    app.get('/sitemap.xml', async (req, res, next) => {
      try {
        const publicDomain = process.env.PUBLIC_DOMAIN
          ? (process.env.PUBLIC_DOMAIN.startsWith('http') ? process.env.PUBLIC_DOMAIN : `${req.protocol}://${process.env.PUBLIC_DOMAIN}`)
          : `${req.protocol}://${req.get('host')}`;
        // Nur Links, die auch die oeffentliche Linkliste zeigen wuerde (Zeitsteuerung, Ablaufdatum,
        // Profil nicht oeffentlich)
        const profileHidden = await visibility.isProfileHiddenFor(req);
        const { rows: slugRows } = profileHidden ? { rows: [] } : await db.query(
          `SELECT slug, ${visibility.visibilityColumns()} FROM links WHERE is_active = true AND slug IS NOT NULL AND password_hash IS NULL`
        );
        const nowBerlin = visibility.getNowInBerlin();
        const slugs = slugRows.filter(l => visibility.isLinkVisible(l, nowBerlin));
        const now = new Date().toISOString().slice(0, 10);
        const urls = [
          { loc: publicDomain, changefreq: 'daily', priority: '1.0' },
          { loc: `${publicDomain}/changelog`, changefreq: 'monthly', priority: '0.5' },
          { loc: `${publicDomain}/api-docs`, changefreq: 'monthly', priority: '0.5' },
          ...slugs.map(s => ({ loc: `${publicDomain}/go/${encodeURIComponent(s.slug)}`, changefreq: 'weekly', priority: '0.8' })),
        ];
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          urls.map(u =>
            `  <url>\n` +
            `    <loc>${escapeHtml(u.loc)}</loc>\n` +
            `    <lastmod>${now}</lastmod>\n` +
            `    <changefreq>${u.changefreq}</changefreq>\n` +
            `    <priority>${u.priority}</priority>\n` +
            `  </url>\n`).join('') +
          `</urlset>`;
        res.set('Content-Type', 'application/xml');
        res.send(xml);
      } catch (err) { next(err); }
    });

    // Kurzlink-Weiterleitungen
    function safeSlug(value) {
      const s = String(value || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,64}$/.test(s)) return null;
      return s;
    }

    app.get('/go/:slug', async (req, res, next) => {
      try {
        const slug = safeSlug(req.params.slug);
        if (!slug) return sendHtml(res, '404.html', 404);
        const { rows } = await db.query(`
          SELECT id, url, password_hash IS NOT NULL AS is_password_protected, ${visibility.visibilityColumns()}
          FROM links WHERE slug = $1 AND is_active = true LIMIT 1
        `, [slug]);
        // Verborgene, abgelaufene oder zeitlich nicht freigegebene Links sowie Links eines nicht
        // oeffentlichen Profils wie nicht vorhandene behandeln
        if (!rows.length || !visibility.isLinkVisible(rows[0], undefined, { isAdmin: visibility.isAdminRequest(req) }) || await visibility.isProfileHiddenFor(req)) {
          return sendHtml(res, '404.html', 404);
        }
        // Passwortgeschuetzte Links nicht per Kurzlink freigeben -> Entsperren auf der Startseite
        if (rows[0].is_password_protected) return res.redirect('/');
        await db.query(`
          INSERT INTO link_clicks (link_id, ip_hash, user_agent, referrer)
          VALUES ($1, $2, $3, $4)
        `, [rows[0].id, null, req.headers['user-agent']?.slice(0, 500) || null, req.headers.referer?.slice(0, 500) || null]);
        res.redirect(rows[0].url);
      } catch (err) {
        next(err);
      }
    });

    const indexHtmlTemplate = versionAssets(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'));
    const maintenanceTemplate = versionAssets(fs.readFileSync(path.join(__dirname, 'public', 'maintenance.html'), 'utf8'));

    // Standard-Design aus dem Admin direkt setzen (kein Aufblitzen); js/theme-init.js
    // uebernimmt danach eine gespeicherte Besucher-Wahl, sofern erlaubt.
    // validateTheme liefert nur Werte aus einer festen Liste -> sicher im Attribut.
    function withThemeAttrs(html, profile) {
      const defaultTheme = validateTheme(profile?.theme);
      const themeAttrs = ` data-default-theme="${defaultTheme}"`
        + (defaultTheme !== 'dark' ? ` data-theme="${defaultTheme}"` : '')
        + (profile?.allow_visitor_theme === false ? ' data-visitor-theme="0"' : '');
      return html.replace(/<html lang="de">/, () => `<html lang="de"${themeAttrs}>`);
    }

    // Wartungsseite senden (lib/maintenance-mode.js): 503 mit Retry-After oder 404, nie cachen
    async function sendMaintenance(res, settings, status) {
      const profile = (await db.query('SELECT theme, allow_visitor_theme FROM profile WHERE id = 1 LIMIT 1').catch(() => ({ rows: [] }))).rows[0];
      if (status === 503) res.setHeader('Retry-After', String(maintenanceMode.retryAfter(settings)));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex');
      res.status(status).type('html').send(withThemeAttrs(maintenanceMode.renderPage(maintenanceTemplate, settings), profile));
    }

    // Vorschaubild fuer Link-Vorschauen (Discord, WhatsApp …): erzeugt/hochgeladen im Admin
    // (lib/og.js), sonst das Profilbild. Nur bei oeffentlichem Profil (oder fuer Admins).
    app.get('/og-image.jpg', async (req, res, next) => {
      try {
        const { rows } = await db.query('SELECT is_public, avatar_url FROM profile WHERE id = 1 LIMIT 1');
        const profile = rows[0] || {};
        if (profile.is_public === false && !req.session?.userId) return res.status(404).end();
        let body = null;
        let type = null;
        const stored = await og.getImage();
        if (stored) {
          body = stored.image;
          type = stored.image_type;
        } else {
          const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(profile.avatar_url || '');
          if (m) { body = Buffer.from(m[2], 'base64'); type = m[1]; }
        }
        if (!body || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) return res.status(404).end();
        res.setHeader('Content-Type', type);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // Mit ?v=<Version> darf lange gecacht werden (neue Version = neue URL)
        res.setHeader('Cache-Control', req.query.v ? 'public, max-age=86400' : 'public, max-age=300');
        res.end(body);
      } catch (err) {
        next(err);
      }
    });

    // Startseite mit dynamischen Open-Graph-Tags (Vorschaubild, Beschreibung, laufender Song)
    app.get('/', async (req, res, next) => {
      try {
        // Wartungsmodus: Besucher sehen die Wartungsseite, angemeldete Admins die Startseite
        // (mit Hinweis); "/?preview=maintenance" zeigt Admins die Wartungsseite als Vorschau.
        const isAdmin = Boolean(req.session?.userId);
        if (isAdmin && req.query.preview === 'maintenance') {
          return await sendMaintenance(res, await maintenanceMode.getSettings(), 200);
        }
        const maintenance = await maintenanceMode.getActive();
        if (maintenance && !isAdmin) return await sendMaintenance(res, maintenance, maintenance.http_status);

        const { getNowPlaying } = require('./lib/navidrome');
        const profileRes = await db.query('SELECT * FROM profile WHERE id = 1 LIMIT 1');
        const profile = profileRes.rows[0] || { name: '@corneliusahner', handle: 'Cornelius Ahner', is_public: true };

        // Nicht oeffentlich: nur eingeloggte Admins sehen die Seite (z. B. Vorschau im Admin)
        if (profile.is_public === false && !req.session?.userId) {
          return sendHtml(res, 'login.html', 403);
        }

        const publicDomain = process.env.PUBLIC_DOMAIN;
        const absUrl = publicDomain
          ? (publicDomain.startsWith('http') ? publicDomain : `${req.protocol}://${publicDomain}`)
          : `${req.protocol}://${req.get('host')}`;

        let html = indexHtmlTemplate.replace('__CURRENT_YEAR__', () => String(new Date().getFullYear()));

        html = withThemeAttrs(html, profile);
        html = html.replace(/(<meta name="robots"[^>]*?>)?/i, '<meta name="robots" content="index, follow" />');

        // Admin bei aktivem Wartungsmodus: Hinweis-Banner (Texte ueber js/i18n.js)
        if (maintenance) {
          html = html.replace('<main class="card">', () => '<div class="maintenance-banner" role="status">'
            + '<span data-i18n="maintenance.adminBanner">Wartungsmodus aktiv – Besucher sehen die Wartungsseite, nur du siehst die Startseite.</span> '
            + '<a href="/admin" target="_top" data-i18n="maintenance.adminLink">Einstellungen</a></div>\n  <main class="card">');
        }

        // Custom CSS injizieren
        if (profile.custom_css) {
          const safeCss = String(profile.custom_css).replace(/<\/style/gi, '<\\/style');
          html = html.replace(/(<\/head>)/i, (m) => '\n<style>' + safeCss + '</style>\n' + m);
        }

        // Link-Vorschau (Open Graph / Twitter Card, Titel, Beschreibung, Embed-Farbe): lib/og.js
        const ogSettings = await og.getSettings().catch(() => null);
        let nowPlaying = '';
        if (ogSettings?.show_now_playing !== false && og.isCrawler(req.get('user-agent'))) {
          nowPlaying = await og.nowPlayingLine();
        }
        const meta = og.applyMetaTags(html, { profile, absUrl, settings: ogSettings, nowPlaying, theme: validateTheme(profile.theme) });
        html = meta.html;
        const image = meta.image;

        const pkg = require('./package.json');
        html = html.replace('__APP_VERSION__', pkg.version);

        // JSON-LD strukturierte Daten
        const jsonLd = {
          '@context': 'https://schema.org',
          '@type': 'ProfilePage',
          mainEntity: {
            '@type': 'Person',
            name: profile.handle || profile.name || 'OpenWeb',
            alternateName: profile.name || null,
            description: profile.bio || null,
            url: absUrl,
            // Nie die Data-URL des Profilbilds einbetten (bis 500 KB pro Seitenaufruf)
            image: image || undefined,
            sameAs: [],
          },
        };
        // "<" escapen, damit z. B. "</script>" in der Bio das Script-Tag nicht beenden kann (XSS)
        const unsafeScriptChars = new RegExp('[<' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
        const ldJson = JSON.stringify(jsonLd)
          .replace(unsafeScriptChars, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
        const ldScript = `\n<script type="application/ld+json">${ldJson}</script>`;
        html = html.replace(/(<\/head>)/i, (m) => ldScript + '\n' + m);

        res.send(html);
      } catch (err) {
        next(err);
      }
    });

    app.get('*', (req, res) => sendHtml(res, '404.html', 404));
  }

  // Globaler Error-Handler
  app.use((err, req, res, _next) => {
    // Client-Fehler (z. B. ungueltiges JSON, zu grosser Body) nicht als 500 melden
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('[server error]', err);
    const message = status < 500 && err.expose ? err.message : 'Internal Server Error';
    res.status(status).json({ ok: false, error: NODE_ENV === 'production' ? message : err.message });
  });

  // HOST: Bind-Adresse. Hinter einem Reverse-Proxy auf demselben Host 127.0.0.1 setzen, damit der
  // Node-Port nicht direkt erreichbar ist (sonst koennen Clients X-Forwarded-For selbst setzen).
  const HOST = (process.env.HOST || '').trim() || undefined;
  if (!HOST && app.get('trust proxy') !== 0 && app.get('trust proxy') !== false) {
    console.warn('[OpenWeb] Hinweis: TRUST_PROXY ist aktiv, der Server lauscht aber auf allen Schnittstellen. ' +
      'Hinter einem Proxy HOST=127.0.0.1 setzen, ohne Proxy TRUST_PROXY=0.');
  }
  app.listen(PORT, HOST, () => {
    const mode = setupRequired ? 'SETUP-MODUS' : NODE_ENV;
    console.log(`[OpenWeb] Server laeuft auf http://${HOST || 'localhost'}:${PORT} (env: ${mode})`);
  });

  if (!setupRequired) {
    const backup = require('./lib/backup');
    const maintenance = require('./lib/maintenance');
    const alert = require('./lib/alert');

    const runBackup = async () => {
      try {
        const file = await backup.createBackup();
        console.log('[backup] Automatisches Backup erstellt:', file);
      } catch (err) {
        console.error('[backup] Fehler beim automatischen Backup:', err.message);
        alert.notify('backup_fail', 'Automatisches Backup fehlgeschlagen', { error: err.message }).catch(() => {});
      }
    };

    const runCleanup = async () => {
      try {
        const result = await maintenance.runMaintenance();
        console.log('[maintenance] Aufraeumen abgeschlossen:', result);
      } catch (err) {
        console.error('[maintenance] Fehler beim Aufräumen:', err.message);
      }
    };

    let lastRecordedTrack = null;
    const recordMusicHistory = async () => {
      try {
        const { getActiveTrack } = require('./lib/nowplaying');
        const db = require('./lib/db');

        // Gleiche Quellenauswahl wie die Startseite (Music Assistant, Spotify, Navidrome)
        const track = await getActiveTrack();

        if (track && track.playing && !track.paused) {
          const trackKey = track.id || (track.title + track.artist);
          if (trackKey !== lastRecordedTrack) {
            lastRecordedTrack = trackKey;
            const tId = track.id ? String(track.id).substring(0, 255) : null;
            const tTitle = (track.title || 'Unbekannt').substring(0, 255);
            const tArtist = (track.artist || '').substring(0, 255);
            const tAlbum = (track.album || '').substring(0, 255);
            await db.query(
              'INSERT INTO music_history (track_id, title, artist, album, source) VALUES ($1, $2, $3, $4, $5)',
              [tId, tTitle, tArtist, tAlbum, track.source || null]
            );
          }
        } else if (!track || !track.playing) {
          lastRecordedTrack = null;
        }
      } catch (err) {
        console.error('[music-history] Fehler beim Speichern des Verlaufs:', err.message);
      }
    };
    // Alle 15 Sekunden prüfen
    setInterval(recordMusicHistory, 15000);

    // Einmalig beim Start und dann täglich um 03:00 Uhr
    runBackup();
    runCleanup();
    const now = new Date();
    const next3am = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (now.getHours() >= 3 ? 1 : 0), 3, 0, 0);
    setTimeout(() => {
      runBackup();
      runCleanup();
      setInterval(() => { runBackup(); runCleanup(); }, 24 * 60 * 60 * 1000);
    }, next3am - now);
    
    // Instagram-Profilabgleich: stuendlich pruefen, abgeglichen wird hoechstens einmal pro Tag
    // (nur wenn im Admin aktiviert und verbunden; verlaengert dabei auch den Zugriffstoken)
    const { syncIfDue: syncInstagramIfDue } = require('./lib/instagram');
    setTimeout(syncInstagramIfDue, 60 * 1000);
    setInterval(syncInstagramIfDue, 60 * 60 * 1000);

    // Discord Webhook initialisieren
    const { initDiscordWebhook } = require('./lib/discord');
    initDiscordWebhook();

    // Namensliste der Dashboard Icons im Hintergrund laden (Icon-Erkennung fuer Links)
    require('./lib/icons').ensureLoaded();

    // Ressourcenmonitor starten (Messpunkt alle 10 s, Verlauf 1 h im Speicher)
    metrics.start(require('./lib/db').pool);
  }
}

finalizeApp().catch((err) => {
  console.error('[server] Start fehlgeschlagen:', err);
  process.exit(1);
});

module.exports = app;
