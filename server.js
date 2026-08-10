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

    app.use('/api', publicRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/navidrome', navidromeRoutes);

    app.get('/setup.html', (req, res) => res.redirect('/login'));
    app.use(express.static(path.join(__dirname, 'public')));
    app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
    app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
    app.get('/changelog', (req, res) => res.sendFile(path.join(__dirname, 'public', 'changelog.html')));

    // Startseite mit dynamischen Open-Graph-Tags fuer aktuellen Track
    app.get('/', async (req, res, next) => {
      try {
        const { getNowPlaying } = require('./lib/navidrome');
        const profileRes = await db.query('SELECT name, handle FROM profile WHERE id = 1 LIMIT 1');
        const profile = profileRes.rows[0] || { name: '@corneliusahner', handle: 'Cornelius Ahner' };

        let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
        const track = await getNowPlaying();

        if (track && track.playing) {
          const title = `🎵 ${track.artist ? track.artist + ' — ' : ''}${track.title}`;
          const description = track.paused ? 'Momentan pausiert' : `Aktuell läuft: ${track.title}${track.artist ? ' von ' + track.artist : ''}${track.album ? ' (' + track.album + ')' : ''}`;
          const absUrl = `${req.protocol}://${req.get('host')}`;
          const image = track.coverUrl ? `${absUrl}${track.coverUrl}` : '';

          html = html
            .replace(/<meta property="og:site_name" content="[^"]*"\s*\/?>/, `<meta property="og:site_name" content="${escapeHtml(profile.name || profile.handle || 'OpenWeb')}">`)
            .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${escapeHtml(title)}">`)
            .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${escapeHtml(description)}">`)
            .replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${escapeHtml(image)}">`)
            .replace(/<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${escapeHtml(title)}">`)
            .replace(/<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${escapeHtml(description)}">`)
            .replace(/<meta name="twitter:image" content="[^"]*"\s*\/?>/, `<meta name="twitter:image" content="${escapeHtml(image)}">`)
            .replace(/<title>[^]*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
        }

        res.send(html);
      } catch (err) {
        next(err);
      }
    });

    app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
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
}

finalizeApp().catch((err) => {
  console.error('[server] Start fehlgeschlagen:', err);
  process.exit(1);
});

module.exports = app;
