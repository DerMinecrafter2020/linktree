// =========================================================
// OpenWeb — Link-in-Bio Server (Node.js + Express + PostgreSQL)
// =========================================================

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
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

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

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
    const session = require('express-session');
    const PgSession = require('connect-pg-simple')(session);
    const db = require('./lib/db');
    const publicRoutes = require('./routes/public');
    const adminRoutes = require('./routes/admin');
    const navidromeRoutes = require('./routes/navidrome');

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
      cookie: {
        maxAge: parseInt(process.env.SESSION_MAX_AGE_MS || '86400000', 10),
        httpOnly: true,
        secure: true,
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
      keyGenerator: (req) => req.ip || req.connection.remoteAddress || 'unknown',
      handler: (req, res) => res.status(429).json({ ok: false, error: 'Zu viele Anfragen. Bitte warte einen Moment.' }),
    });
    app.use('/api', publicLimiter);

    // Admin-Rate-Limiting (strenger Brute-Force-Schutz)
    const adminLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => req.session?.userId || (req.ip || req.connection.remoteAddress || 'unknown'),
      handler: (req, res) => res.status(429).json({ ok: false, error: 'Zu viele Admin-Anfragen. Bitte warte einen Moment.' }),
    });
    app.use('/api/admin', adminLimiter);

    app.use('/api', publicRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/navidrome', navidromeRoutes);

    app.get('/setup.html', (req, res) => res.redirect('/login'));
    app.use(express.static(path.join(__dirname, 'public'), { index: false }));
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
    app.get('/go/:slug', async (req, res, next) => {
      try {
        const slug = v.safeSlug(req.params.slug);
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

        let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
        html = html.replace(/(<meta name="robots"[^>]*?>)?/i, '<meta name="robots" content="index, follow" />');

        // Custom CSS injizieren
        if (profile.custom_css) {
          html = html.replace(/(<\/head>)/i, `\n<style>${profile.custom_css}</style>\n$1`);
        }

        const track = await getNowPlaying();
        const isPlaying = track && track.playing;
        const pageTitle = isPlaying
          ? `🎵 ${track.artist ? track.artist + ' — ' : ''}${track.title}`
          : `${escapeHtml(profile.handle || profile.name || 'OpenWeb')}`;
        const pageDescription = isPlaying
          ? (track.paused ? 'Momentan pausiert' : `Aktuell läuft: ${track.title}${track.artist ? ' von ' + track.artist : ''}${track.album ? ' (' + track.album + ')' : ''}`)
          : escapeHtml(profile.bio || 'Alle wichtigen Links auf einen Blick.');
        const image = isPlaying && track.coverUrl ? `${absUrl}${track.coverUrl}` : `${absUrl}/icons/icon.svg`;

        html = html
          .replace(/<meta property="og:site_name" content="[^"]*"\s*\/?>/, `<meta property="og:site_name" content="${escapeHtml(profile.name || profile.handle || 'OpenWeb')}">`)
          .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${escapeHtml(pageTitle)}">`)
          .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${escapeHtml(pageDescription)}">`)
          .replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${escapeHtml(image)}">`)
          .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${escapeHtml(absUrl)}">`)
          .replace(/<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${escapeHtml(pageTitle)}">`)
          .replace(/<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${escapeHtml(pageDescription)}">`)
          .replace(/<meta name="twitter:image" content="[^"]*"\s*\/?>/, `<meta name="twitter:image" content="${escapeHtml(image)}">`)
          .replace(/<title>[^]*?<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`);

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
  }
}

finalizeApp().catch((err) => {
  console.error('[server] Start fehlgeschlagen:', err);
  process.exit(1);
});

module.exports = app;
