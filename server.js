// =========================================================
// OpenWeb — Link-in-Bio Server (Node.js + Express + PostgreSQL)
// =========================================================

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const setup = require('./lib/setup');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';

// Health-Check vor Setup, damit Load-Balancer / Uptime-Checker funktionieren
app.get('/health', async (req, res) => {
  try {
    const db = require('./lib/db');
    await db.query('SELECT 1');
    res.json({ ok: true, status: 'healthy', database: 'connected' });
  } catch (err) {
    res.status(503).json({ ok: false, status: 'unhealthy', database: 'disconnected', error: err.message });
  }
});

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

app.set('trust proxy', 1);

// =========================================================
// Express-App konfigurieren
// =========================================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
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
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  message: { ok: false, error: 'API-Limit erreicht. Bitte kurz warten.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth/login', authLimiter);
app.use('/api/setup', authLimiter);
app.use('/api', apiLimiter);

// =========================================================
// App je nach Setup-Status finalisieren
// =========================================================
async function finalizeApp() {
  let setupRequired = false;
  try {
    setupRequired = await setup.isSetupRequired();
  } catch (err) {
    console.warn('[server] Setup-Status konnte nicht geprueft werden:', err.message);
    setupRequired = true;
  }

  if (setupRequired) {
    console.log('[server] Initial-Setup-Modus aktiv. Rufe /setup.html auf, um die Anwendung zu konfigurieren.');
    const setupRoutes = require('./routes/setup');
    app.use('/api/setup', setupRoutes);
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
    app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
    app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
  } else {
    console.log('[server] Prüfe auf ausstehende Datenbank-Migrationen...');
    try {
      await require('./db/migrate').run();
    } catch (err) {
      console.error('[server] Fehler bei der Datenbank-Migration:', err.message);
      // Wir setzen fort, aber es könnte zu Problemen führen
    }

    const session = require('express-session');
    const PgSession = require('connect-pg-simple')(session);
    const db = require('./lib/db');
    const publicRoutes = require('./routes/public');
    const adminRoutes = require('./routes/admin');
    const navidromeRoutes = require('./routes/navidrome');
    const statusRoutes = require('./routes/api/status');

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
      keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
      handler: (req, res) => res.status(429).json({ ok: false, error: 'Zu viele Anfragen. Bitte warte einen Moment.' }),
    });
    app.use('/api', publicLimiter);

    // Admin-Rate-Limiting (strenger Brute-Force-Schutz)
    const adminLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
      handler: (req, res) => res.status(429).json({ ok: false, error: 'Zu viele Admin-Anfragen. Bitte warte einen Moment.' }),
    });
    app.use('/api/admin', adminLimiter);

    app.use('/api', publicRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/navidrome', navidromeRoutes);
    app.use('/api/status', statusRoutes);

    app.get('/setup.html', (req, res) => res.redirect('/login'));

    // Service Worker mit eingebetteter Versionsnummer ausliefern (kein Caching!)
    app.get('/sw.js', (req, res) => {
      const pkg = require('./package.json');
      const swContent = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8')
        .replace('__APP_VERSION__', pkg.version);
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.send(swContent);
    });

    // Statische Dateien: kurzer Cache mit Revalidierung
    app.use(express.static(path.join(__dirname, 'public'), {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
          res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        }
      },
    }));
    app.get('/admin.html', (req, res) => res.redirect('/admin'));
    app.get('/admin', (req, res, next) => {
      const { isIpAllowed } = require('./lib/auth');
      if (!isIpAllowed(req)) return res.status(403).send('Admin-Zugang von dieser IP nicht erlaubt');
      res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });
    app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
    app.get('/changelog', (req, res) => res.sendFile(path.join(__dirname, 'public', 'changelog.html')));
    app.get('/api-docs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'api-docs.html')));
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
        const { rows: slugs } = await db.query('SELECT slug FROM links WHERE is_active = true AND slug IS NOT NULL');
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
        if (!slug) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
        const { rows } = await db.query(`
          SELECT id, url FROM links WHERE slug = $1 AND is_active = true LIMIT 1
        `, [slug]);
        if (!rows.length) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
        await db.query(`
          INSERT INTO link_clicks (link_id, ip_hash, user_agent, referrer)
          VALUES ($1, $2, $3, $4)
        `, [rows[0].id, null, req.headers['user-agent']?.slice(0, 500) || null, req.headers.referer?.slice(0, 500) || null]);
        res.redirect(rows[0].url);
      } catch (err) {
        next(err);
      }
    });

    const indexHtmlTemplate = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

    // Startseite mit dynamischen Open-Graph-Tags fuer aktuellen Track
    app.get('/', async (req, res, next) => {
      try {
        const { getNowPlaying } = require('./lib/navidrome');
        const profileRes = await db.query('SELECT * FROM profile WHERE id = 1 LIMIT 1');
        const profile = profileRes.rows[0] || { name: '@corneliusahner', handle: 'Cornelius Ahner', is_public: true };

        if (profile.is_public === false) {
          return res.status(403).sendFile(path.join(__dirname, 'public', 'login.html'));
        }

        const publicDomain = process.env.PUBLIC_DOMAIN;
        const absUrl = publicDomain
          ? (publicDomain.startsWith('http') ? publicDomain : `${req.protocol}://${publicDomain}`)
          : `${req.protocol}://${req.get('host')}`;

        let html = indexHtmlTemplate;
        html = html.replace(/(<meta name="robots"[^>]*?>)?/i, '<meta name="robots" content="index, follow" />');

        // Custom CSS injizieren
        if (profile.custom_css) {
          const safeCss = String(profile.custom_css).replace(/<\/style/gi, '<\\/style');
          html = html.replace(/(<\/head>)/i, `\n<style>${safeCss}</style>\n$1`);
        }

        const pageTitle = escapeHtml(profile.handle || profile.name || 'OpenWeb');
        const pageDescription = escapeHtml(profile.bio || 'Alle wichtigen Links auf einen Blick.');
        const imageUrl = profile.avatar_url 
          ? (profile.avatar_url.startsWith('http') ? profile.avatar_url : `${absUrl}${profile.avatar_url}`) 
          : `${absUrl}/icons/icon.svg`;
        const image = imageUrl;

        const pkg = require('./package.json');

        html = html
          .replace(/<meta property="og:site_name" content="[^"]*"\s*\/?>/, `<meta property="og:site_name" content="${escapeHtml(profile.name || profile.handle || 'OpenWeb')}">`)
          .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${escapeHtml(pageTitle)}">`)
          .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${escapeHtml(pageDescription)}">`)
          .replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${escapeHtml(image)}">`)
          .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${escapeHtml(absUrl)}">`)
          .replace(/<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${escapeHtml(pageTitle)}">`)
          .replace(/<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${escapeHtml(pageDescription)}">`)
          .replace(/<meta name="twitter:image" content="[^"]*"\s*\/?>/, `<meta name="twitter:image" content="${escapeHtml(image)}">`)
          .replace(/<title>[^]*?<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`)
          .replace('__APP_VERSION__', pkg.version);

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
            image: profile.avatar_url || `${absUrl}/icons/icon.svg`,
            sameAs: [],
          },
        };
        const ldScript = `\n<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;
        html = html.replace(/(<\/head>)/i, `${ldScript}\n$1`);

        res.send(html);
      } catch (err) {
        next(err);
      }
    });

    app.get('*', (req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));
  }

  // Globaler Error-Handler
  app.use((err, req, res, _next) => {
    console.error('[server error]', err);
    res.status(500).json({ ok: false, error: NODE_ENV === 'production' ? 'Internal Server Error' : err.message });
  });

  app.listen(PORT, () => {
    const mode = setupRequired ? 'SETUP-MODUS' : NODE_ENV;
    console.log(`[OpenWeb] Server laeuft auf http://localhost:${PORT} (env: ${mode})`);
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
        const { getNowPlaying: getNavidromePlaying } = require('./lib/navidrome');
        const { getNowPlaying: getMAPlaying } = require('./lib/musicassistant');
        const db = require('./lib/db');
        
        let track = await getMAPlaying();
        if (!track || !track.playing) {
          track = await getNavidromePlaying();
        }
        
        if (track && track.playing && !track.paused) {
          const trackKey = track.id || (track.title + track.artist);
          if (trackKey !== lastRecordedTrack) {
            lastRecordedTrack = trackKey;
            await db.query(
              'INSERT INTO music_history (track_id, title, artist, album) VALUES ($1, $2, $3, $4)',
              [track.id ? String(track.id) : null, track.title, track.artist, track.album]
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
    
    // Discord Webhook initialisieren
    const { initDiscordWebhook } = require('./lib/discord');
    initDiscordWebhook();
  }
}

finalizeApp().catch((err) => {
  console.error('[server] Start fehlgeschlagen:', err);
  process.exit(1);
});

module.exports = app;
