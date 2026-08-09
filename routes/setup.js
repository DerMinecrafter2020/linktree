// =========================================================
// Setup-Endpunkte (oeffentlich, nur aktiv wenn noetig)
// =========================================================

const express = require('express');
const setup = require('../lib/setup');
const v = require('../lib/validators');

const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    const required = await setup.isSetupRequired();
    const envExists = setup.envFileExists();
    const env = envExists ? setup.parseEnv(setup.readEnvFile()) : {};
    res.json({
      ok: true,
      data: {
        setupRequired: required,
        envFileExists: envExists,
        databaseUrl: env.DATABASE_URL ? 'configured' : 'missing',
      },
    });
  } catch (err) {
    res.json({
      ok: true,
      data: {
        setupRequired: true,
        envFileExists: setup.envFileExists(),
        databaseUrl: 'unknown',
        error: err.message,
      },
    });
  }
});

router.get('/config', async (req, res) => {
  try {
    const envExists = setup.envFileExists();
    const env = envExists ? setup.parseEnv(setup.readEnvFile()) : {};

    let databaseUrl = env.DATABASE_URL || '';
    if (!databaseUrl && env.DB_HOST) {
      const user = env.DB_USER || '';
      const pass = env.DB_PASSWORD || '';
      const host = env.DB_HOST || '';
      const port = env.DB_PORT || '5432';
      const db = env.DB_NAME || '';
      if (user && host && db) {
        databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${encodeURIComponent(db)}`;
      }
    }

    res.json({
      ok: true,
      data: {
        envFileExists,
        databaseUrl,
        port: env.PORT || '3000',
        appUrl: env.APP_URL || '',
        adminEmail: env.ADMIN_EMAIL || '',
        navidromeUrl: env.NAVIDROME_URL || '',
        navidromeUsername: env.NAVIDROME_USERNAME || '',
      },
    });
  } catch (err) {
    console.error('[setup/config error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/test-database', async (req, res) => {
  try {
    const url = v.safeText(req.body.databaseUrl, 500);
    if (!url) {
      return res.status(400).json({ ok: false, error: 'DATABASE_URL fehlt' });
    }
    const result = await setup.testDatabaseUrl(url);
    res.json({ ok: result.ok, error: result.error || undefined });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const required = await setup.isSetupRequired();
    if (!required) {
      return res.status(403).json({ ok: false, error: 'Setup wurde bereits durchgefuehrt.' });
    }

    const config = req.body;

    const databaseUrl = v.safeText(config.databaseUrl, 500);
    if (!databaseUrl) {
      return res.status(400).json({ ok: false, error: 'DATABASE_URL ist Pflicht' });
    }

    const adminEmail = v.validateEmail(config.adminEmail);
    if (!adminEmail) {
      return res.status(400).json({ ok: false, error: 'Gueltige Admin-E-Mail erforderlich' });
    }

    const adminPassword = String(config.adminPassword || '');
    if (adminPassword.length < 8) {
      return res.status(400).json({ ok: false, error: 'Admin-Passwort muss mindestens 8 Zeichen haben' });
    }

    const profile = config.profile || {};
    const links = Array.isArray(config.links) ? config.links : [];

    const result = await setup.performSetup({
      databaseUrl,
      adminEmail,
      adminPassword,
      profile: {
        name: v.safeText(profile.name, 80),
        handle: v.safeText(profile.handle, 80),
        bio: v.safeText(profile.bio, 280),
        avatar: v.safeText(profile.avatar, 2).toUpperCase() || 'CA',
        avatarUrl: v.validateAvatarUrl(profile.avatarUrl),
        theme: v.validateTheme(profile.theme),
      },
      links: links.map((l, i) => ({
        title: v.safeText(l.title, 80),
        subtitle: v.safeText(l.subtitle, 120),
        url: v.safeUrl(l.url),
        icon: v.sanitizeIconField(l.icon),
        position: i,
      })).filter(l => l.title && l.url),
      navidromeUrl: v.safeUrl(config.navidromeUrl),
      navidromeUsername: v.safeText(config.navidromeUsername, 120),
      navidromePassword: String(config.navidromePassword || ''),
      navidromePollIntervalSec: Math.min(600, Math.max(5, parseInt(config.navidromePollIntervalSec || '30', 10) || 30)),
      port: String(config.port || '3000'),
      appUrl: v.safeUrl(config.appUrl) || `http://localhost:${config.port || '3000'}`,
      nodeEnv: config.nodeEnv || 'production',
    });

    res.json({
      ok: true,
      data: {
        restartRequired: result.restartRequired,
        message: 'Setup abgeschlossen. Bitte starte den Server neu, damit Sessions aktiv werden.',
      },
    });
  } catch (err) {
    console.error('[setup] Fehler:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
