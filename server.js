// =========================================================
// OpenWeb — Link-in-Bio Server (Node.js + Express + PostgreSQL)
// =========================================================

require('dotenv').config();

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const setup = require('./lib/setup');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';

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

app.use(express.static(path.join(__dirname, 'public')));

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
        secure: NODE_ENV === 'production',
        sameSite: 'lax',
      },
    }));

    app.use('/api', publicRoutes);
    app.use('/api/admin', adminRoutes);
    app.use('/api/navidrome', navidromeRoutes);

    app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
    app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
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
