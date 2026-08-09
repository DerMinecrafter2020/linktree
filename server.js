// =========================================================
// OpenWeb — Link-in-Bio Server (Node.js + Express + PostgreSQL)
// =========================================================

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const path = require('path');

const db = require('./lib/db');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const navidromeRoutes = require('./routes/navidrome');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// =========================================================
// Sicherheits-Header
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

// Zusaetzliche Header via Middleware (fuer nginx-lose Setups)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  next();
});

// =========================================================
// Body-Parser
// =========================================================
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// =========================================================
// Session
// =========================================================
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

// =========================================================
// Statische Dateien
// =========================================================
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================
// API-Routen
// =========================================================
app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/navidrome', navidromeRoutes);

// =========================================================
// SPA-Fallback: alles nicht-API/HTML-Dateien -> index.html
// =========================================================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =========================================================
// Globaler Error-Handler
// =========================================================
app.use((err, req, res, _next) => {
  console.error('[server error]', err);
  res.status(500).json({ ok: false, error: NODE_ENV === 'production' ? 'Internal Server Error' : err.message });
});

// =========================================================
// Server starten
// =========================================================
app.listen(PORT, () => {
  console.log(`[OpenWeb] Server laeuft auf ${APP_URL} (env: ${NODE_ENV})`);
});

module.exports = app;
