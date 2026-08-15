// =========================================================
// Admin-API-Routen (hinter requireAdminSession)
// =========================================================

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { encrypt, decrypt } = require('../lib/crypto');
const v = require('../lib/validators');
const { hashPassword, verifyPassword, findUserByEmail, requireAdminSession } = require('../lib/auth');
const bcrypt = require('bcrypt');
const backup = require('../lib/backup');
const audit = require('../lib/audit');
const alert = require('../lib/alert');

function generateApiKey() {
  return require('crypto').randomBytes(32).toString('hex');
}

const router = express.Router();

router.use(requireAdminSession);

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id) && !/^[0-9a-fA-F-]{36}$/.test(id)) {
    return res.status(400).json({ ok: false, error: 'Ungültige ID' });
  }
  next();
});

// ---------- Auth (nur Logout/Me; Login ist oeffentlich unter /api/login) ----------
router.post('/logout', async (req, res) => {
  await audit.log(req, 'logout', 'user', req.session?.userId);
  req.session.destroy(() => {
    res.clearCookie('openweb.sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  res.json({
    ok: true,
    data: { id: req.session.userId, email: req.session.email },
  });
});

// ---------- Profile ----------
router.get('/profile', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM profile WHERE id = 1 LIMIT 1');
    const profile = rows[0] || null;
    if (profile) {
      delete profile.created_at;
      delete profile.updated_at;
    }
    res.json({ ok: true, data: profile });
  } catch (err) {
    next(err);
  }
});

router.post('/profile', async (req, res, next) => {
  try {
    const name = v.safeText(req.body.name, 80);
    const handle = v.safeText(req.body.handle, 80);
    const bio = v.safeText(req.body.bio, 280);
    const avatar = v.safeText(req.body.avatar, 2).toUpperCase() || 'CA';
    const avatarUrl = v.validateAvatarUrl(req.body.avatar_url);
    const theme = v.validateTheme(req.body.theme);
    const isPublic = req.body.is_public !== false;
    const allowVisitorTheme = req.body.allow_visitor_theme !== false;
    const customCss = req.body.custom_css !== undefined ? String(req.body.custom_css || '').slice(0, 5000) : undefined;

    const updates = [
      'name = EXCLUDED.name',
      'handle = EXCLUDED.handle',
      'bio = EXCLUDED.bio',
      'avatar = EXCLUDED.avatar',
      'avatar_url = EXCLUDED.avatar_url',
      'theme = EXCLUDED.theme',
      'is_public = EXCLUDED.is_public',
      'allow_visitor_theme = EXCLUDED.allow_visitor_theme',
      'updated_at = NOW()',
    ];
    const values = [name, handle, bio, avatar, avatarUrl, theme, isPublic, allowVisitorTheme];
    let idx = 9;
    if (customCss !== undefined) {
      updates.splice(-1, 0, `custom_css = EXCLUDED.custom_css`);
      values.push(customCss);
      idx++;
    }

    await db.query(`
      INSERT INTO profile (id, name, handle, bio, avatar, avatar_url, theme, is_public, allow_visitor_theme${customCss !== undefined ? ', custom_css' : ''})
      VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8${customCss !== undefined ? ', $' + idx : ''})
      ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}
    `, values);

    const { rows } = await db.query('SELECT * FROM profile WHERE id = 1 LIMIT 1');
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------- Links ----------
router.get('/links', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT l.*, c.name AS category_name,
        (SELECT COUNT(*)::int FROM link_clicks WHERE link_id = l.id) AS click_count,
        l.password_hash IS NOT NULL AS is_password_protected
      FROM links l
      LEFT JOIN link_categories c ON c.id = l.category_id
      ORDER BY c.position ASC NULLS FIRST, c.name ASC, l.position ASC, l.created_at ASC
    `);
    const safe = rows.map(r => ({ ...r, password_hash: undefined }));
    res.json({ ok: true, data: safe });
  } catch (err) {
    next(err);
  }
});

// ---------- QR-Codes ----------
// ---------- Statistik ----------
router.get('/stats/links', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const totalRes = await db.query(`
      SELECT COUNT(*)::int AS total FROM link_clicks WHERE clicked_at > NOW() - $1 * INTERVAL '1 day'
    `, [days]);
    const linksRes = await db.query(`
      SELECT l.id, l.title, l.url, l.slug,
        COUNT(lc.id)::int AS clicks,
        COUNT(DISTINCT lc.ip_hash) AS unique_visitors
      FROM links l
      LEFT JOIN link_clicks lc ON lc.link_id = l.id AND lc.clicked_at > NOW() - $1 * INTERVAL '1 day'
      GROUP BY l.id
      ORDER BY clicks DESC, l.position ASC
    `, [days]);
    const timelineRes = await db.query(`
      SELECT DATE(clicked_at) AS day, COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at > NOW() - $1 * INTERVAL '1 day'
      GROUP BY day
      ORDER BY day ASC
    `, [days]);
    const utmRes = await db.query(`
      SELECT COALESCE(utm_source, '(direkt)') AS source,
             COALESCE(utm_medium, '(unbekannt)') AS medium,
             COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at > NOW() - $1 * INTERVAL '1 day'
      GROUP BY utm_source, utm_medium
      ORDER BY count DESC
      LIMIT 20
    `, [days]);
    const devicesRes = await db.query(`
      SELECT COALESCE(device_type, 'unbekannt') AS device_type, COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at > NOW() - $1 * INTERVAL '1 day'
      GROUP BY device_type
      ORDER BY count DESC
    `, [days]);
    const browsersRes = await db.query(`
      SELECT COALESCE(browser, 'unbekannt') AS browser, COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at > NOW() - $1 * INTERVAL '1 day'
      GROUP BY browser
      ORDER BY count DESC
    `, [days]);
    const osRes = await db.query(`
      SELECT COALESCE(os, 'unbekannt') AS os, COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at > NOW() - $1 * INTERVAL '1 day'
      GROUP BY os
      ORDER BY count DESC
    `, [days]);
    const countriesRes = await db.query(`
      SELECT COALESCE(country_code, 'unbekannt') AS country_code, COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at > NOW() - $1 * INTERVAL '1 day'
      GROUP BY country_code
      ORDER BY count DESC
    `, [days]);
    res.json({
      ok: true,
      data: {
        days,
        total: totalRes.rows[0].total,
        links: linksRes.rows,
        timeline: timelineRes.rows,
        utm: utmRes.rows,
        devices: devicesRes.rows,
        browsers: browsersRes.rows,
        os: osRes.rows,
        countries: countriesRes.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});



router.get('/link-categories', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM link_categories ORDER BY position ASC, name ASC');
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/link-categories', async (req, res, next) => {
  try {
    const name = v.safeText(req.body.name, 80);
    if (!name) return res.status(400).json({ ok: false, error: 'Name ist Pflicht' });
    const countRes = await db.query('SELECT COUNT(*)::int AS count FROM link_categories');
    const position = countRes.rows[0].count;
    const { rows } = await db.query(`
      INSERT INTO link_categories (name, position) VALUES ($1, $2) RETURNING *
    `, [name, position]);
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch('/link-categories/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = [];
    const values = [];
    let idx = 1;
    if (req.body.name !== undefined) {
      const name = v.safeText(req.body.name, 80);
      if (!name) return res.status(400).json({ ok: false, error: 'Name ist Pflicht' });
      updates.push(`name = $${idx++}`);
      values.push(name);
    }
    if (req.body.position !== undefined) {
      updates.push(`position = $${idx++}`);
      values.push(parseInt(req.body.position, 10) || 0);
    }
    if (updates.length === 0) return res.status(400).json({ ok: false, error: 'Keine Felder' });
    values.push(id);
    const { rows } = await db.query(
      `UPDATE link_categories SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Kategorie nicht gefunden' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/link-categories/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM link_categories WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'Kategorie nicht gefunden' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/links', async (req, res, next) => {
  try {
    const title = v.safeText(req.body.title, 80);
    const subtitle = v.safeText(req.body.subtitle, 120);
    const url = v.safeUrl(req.body.url);
    const displayUrl = v.safeText(req.body.display_url, 120);
    const icon = v.sanitizeIconField(req.body.icon);
    const isActive = req.body.is_active !== false;
    const openNew = req.body.open_new !== false;
    const metaDescription = v.safeText(req.body.meta_description, 280);
    const adminNote = v.safeText(req.body.admin_note, 280);
    const slug = v.safeSlug(req.body.slug);
    const categoryId = req.body.category_id || null;
    const visibleFrom = v.safeDate(req.body.visible_from);
    const visibleUntil = v.safeDate(req.body.visible_until);
    const visibleWeekdays = v.safeWeekdays(req.body.visible_weekdays);
    const expiresAt = v.safeDate(req.body.expires_at);
    const linkPassword = req.body.password ? await bcrypt.hash(String(req.body.password), 10) : null;

    if (!title || !url) {
      return res.status(400).json({ ok: false, error: 'Titel und URL sind Pflicht' });
    }

    const countRes = await db.query('SELECT COUNT(*)::int AS count FROM links');
    const position = countRes.rows[0].count;

    const { rows } = await db.query(`
      INSERT INTO links (
        title, subtitle, url, display_url, icon, position, is_active, open_new,
        meta_description, admin_note, slug, category_id,
        visible_from, visible_until, visible_weekdays,
        password_hash, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *
    `, [title, subtitle, url, displayUrl, icon, position, isActive, openNew, metaDescription, adminNote, slug, categoryId, visibleFrom, visibleUntil, visibleWeekdays, linkPassword, expiresAt]);

    await audit.log(req, 'create', 'link', rows[0].id, { title });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch('/links/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = [];
    const values = [];
    let idx = 1;

    if (req.body.title !== undefined) {
      const title = v.safeText(req.body.title, 80);
      if (!title) return res.status(400).json({ ok: false, error: 'Titel ist Pflicht' });
      updates.push(`title = $${idx++}`);
      values.push(title);
    }
    if (req.body.subtitle !== undefined) {
      updates.push(`subtitle = $${idx++}`);
      values.push(v.safeText(req.body.subtitle, 120));
    }
    if (req.body.url !== undefined) {
      const url = v.safeUrl(req.body.url);
      if (!url) return res.status(400).json({ ok: false, error: 'Ungueltige URL' });
      updates.push(`url = $${idx++}`);
      values.push(url);
    }
    if (req.body.display_url !== undefined) {
      updates.push(`display_url = $${idx++}`);
      values.push(v.safeText(req.body.display_url, 120));
    }
    if (req.body.icon !== undefined) {
      updates.push(`icon = $${idx++}`);
      values.push(v.sanitizeIconField(req.body.icon));
    }
    if (req.body.is_active !== undefined) {
      updates.push(`is_active = $${idx++}`);
      values.push(!!req.body.is_active);
    }
    if (req.body.open_new !== undefined) {
      updates.push(`open_new = $${idx++}`);
      values.push(!!req.body.open_new);
    }
    if (req.body.meta_description !== undefined) {
      updates.push(`meta_description = $${idx++}`);
      values.push(v.safeText(req.body.meta_description, 280));
    }
    if (req.body.admin_note !== undefined) {
      updates.push(`admin_note = $${idx++}`);
      values.push(v.safeText(req.body.admin_note, 280));
    }
    if (req.body.slug !== undefined) {
      const slug = v.safeSlug(req.body.slug);
      updates.push(`slug = $${idx++}`);
      values.push(slug);
    }
    if (req.body.category_id !== undefined) {
      updates.push(`category_id = $${idx++}`);
      values.push(req.body.category_id || null);
    }
    if (req.body.visible_from !== undefined) {
      updates.push(`visible_from = $${idx++}`);
      values.push(v.safeDate(req.body.visible_from));
    }
    if (req.body.visible_until !== undefined) {
      updates.push(`visible_until = $${idx++}`);
      values.push(v.safeDate(req.body.visible_until));
    }
    if (req.body.visible_weekdays !== undefined) {
      updates.push(`visible_weekdays = $${idx++}`);
      values.push(v.safeWeekdays(req.body.visible_weekdays));
    }
    if (req.body.expires_at !== undefined) {
      updates.push(`expires_at = $${idx++}`);
      values.push(v.safeDate(req.body.expires_at));
    }
    if (req.body.password !== undefined) {
      const pwd = req.body.password ? String(req.body.password) : '';
      updates.push(`password_hash = $${idx++}`);
      values.push(pwd ? await bcrypt.hash(pwd, 10) : null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, error: 'Keine Felder zum Aktualisieren' });
    }

    values.push(id);
    const { rows } = await db.query(
      `UPDATE links SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Link nicht gefunden' });
    }

    await audit.log(req, 'update', 'link', id, { changed: Object.keys(req.body) });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/links/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM links WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Link nicht gefunden' });
    }
    await audit.log(req, 'delete', 'link', id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/links/reorder', async (req, res, next) => {
  try {
    const orderedIds = req.body.orderedIds;
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ ok: false, error: 'orderedIds muss ein Array sein' });
    }

    await db.transaction(async (client) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          'UPDATE links SET position = $1 WHERE id = $2',
          [i, orderedIds[i]]
        );
      }
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Admin-Settings ----------
router.get('/settings', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, admin_enabled, discord_webhook_enabled, discord_webhook_url, discord_webhook_template FROM admin_settings WHERE id = 1 LIMIT 1');
    res.json({ ok: true, data: rows[0] || { id: 1, admin_enabled: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/settings', async (req, res, next) => {
  try {
    const adminEnabled = req.body.admin_enabled !== false;
    const discordEnabled = !!req.body.discord_webhook_enabled;
    const discordUrl = req.body.discord_webhook_url ? v.safeUrl(req.body.discord_webhook_url) : null;
    const discordTemplate = req.body.discord_webhook_template || null;

    await db.query(`
      INSERT INTO admin_settings (id, admin_enabled, discord_webhook_enabled, discord_webhook_url, discord_webhook_template)
      VALUES (1, $1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET
        admin_enabled = EXCLUDED.admin_enabled,
        discord_webhook_enabled = EXCLUDED.discord_webhook_enabled,
        discord_webhook_url = EXCLUDED.discord_webhook_url,
        discord_webhook_template = EXCLUDED.discord_webhook_template,
        updated_at = NOW()
    `, [adminEnabled, discordEnabled, discordUrl, discordTemplate]);

    const { rows } = await db.query('SELECT id, admin_enabled, discord_webhook_enabled, discord_webhook_url, discord_webhook_template FROM admin_settings WHERE id = 1 LIMIT 1');
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/alert-settings', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, email_enabled, email_to, smtp_host, smtp_port, smtp_user, smtp_secure,
             webhook_url, notify_login, notify_backup_fail, notify_password
      FROM alert_settings WHERE id = 1 LIMIT 1
    `);
    res.json({ ok: true, data: rows[0] || { id: 1 } });
  } catch (err) { next(err); }
});

router.post('/alert-settings', async (req, res, next) => {
  try {
    const s = req.body;
    const values = [
      !!s.email_enabled,
      s.email_to || null,
      s.smtp_host || null,
      parseInt(s.smtp_port, 10) || 587,
      s.smtp_user || null,
      s.smtp_password || null,
      s.smtp_secure !== false,
      s.webhook_url ? v.safeUrl(s.webhook_url) : null,
      s.notify_login !== false,
      s.notify_backup_fail !== false,
      s.notify_password !== false,
    ];
    await db.query(`
      INSERT INTO alert_settings (
        id, email_enabled, email_to, smtp_host, smtp_port, smtp_user, smtp_password,
        smtp_secure, webhook_url, notify_login, notify_backup_fail, notify_password
      )
      VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        email_enabled = EXCLUDED.email_enabled,
        email_to = EXCLUDED.email_to,
        smtp_host = EXCLUDED.smtp_host,
        smtp_port = EXCLUDED.smtp_port,
        smtp_user = EXCLUDED.smtp_user,
        smtp_password = EXCLUDED.smtp_password,
        smtp_secure = EXCLUDED.smtp_secure,
        webhook_url = EXCLUDED.webhook_url,
        notify_login = EXCLUDED.notify_login,
        notify_backup_fail = EXCLUDED.notify_backup_fail,
        notify_password = EXCLUDED.notify_password,
        updated_at = NOW()
    `, values);

    const { rows } = await db.query(`
      SELECT id, email_enabled, email_to, smtp_host, smtp_port, smtp_user, smtp_secure,
             webhook_url, notify_login, notify_backup_fail, notify_password
      FROM alert_settings WHERE id = 1 LIMIT 1
    `);
    res.json({ ok: true, data: rows[0] });
  } catch (err) { next(err); }
});

router.post('/alert-settings/test', async (req, res, next) => {
  try {
    const result = await alert.notify('test', 'Dies ist eine Testbenachrichtigung von OpenWeb.', { time: new Date().toISOString() });
    res.json({ ok: result.sent, results: result.results });
  } catch (err) { next(err); }
});

router.post('/settings/discord/test', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT discord_webhook_enabled, discord_webhook_url, discord_webhook_template FROM admin_settings WHERE id = 1 LIMIT 1');
    const cfg = rows[0] || {};
    if (!cfg.discord_webhook_url) {
      return res.status(400).json({ ok: false, error: 'Keine Discord-Webhook-URL hinterlegt' });
    }
    const template = cfg.discord_webhook_template || 'Testbenachrichtigung von OpenWeb: **{{title}}**';
    const text = template
      .replace(/\{\{title\}\}/g, 'Test-Link')
      .replace(/\{\{url\}\}/g, 'https://example.com')
      .replace(/\{\{timestamp\}\}/g, new Date().toISOString());
    const response = await fetch(cfg.discord_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 2000) }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return res.status(502).json({ ok: false, error: `Discord-Fehler: ${response.status} ${body.slice(0, 200)}` });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Datenbank-Status ----------
router.get('/db-info', async (req, res, next) => {
  try {
    const versionRes = await db.query('SELECT version() AS version');
    const tablesRes = await db.query(`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const dbNameRes = await db.query('SELECT current_database() AS name');
    res.json({
      ok: true,
      data: {
        connected: true,
        name: dbNameRes.rows[0].name,
        version: versionRes.rows[0].version.split(' ')[0],
        tables: tablesRes.rows[0].count,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Music History ----------
router.get('/music-history', async (req, res) => {
  try {
    const db = require('../lib/db');
    const { rows } = await db.query('SELECT * FROM music_history ORDER BY played_at DESC LIMIT 50');
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('[music-history] Error fetching history:', err);
    res.status(500).json({ ok: false, error: 'Fehler beim Laden des Musikverlaufs' });
  }
});

// ---------- Navidrome-Settings (Admin) ----------
router.get('/settings/navidrome', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, enabled, url, username, poll_interval_sec, updated_at
      FROM navidrome_settings
      WHERE id = 1
      LIMIT 1
    `);
    res.json({ ok: true, data: rows[0] || { enabled: false } });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/navidrome/discord-test', async (req, res, next) => {
  try {
    const { sendDiscordWebhook } = require('../lib/discord');
    const { rows } = await db.query('SELECT discord_webhook_enabled, discord_webhook_url FROM admin_settings WHERE id = 1 LIMIT 1');
    const settings = rows[0] || {};
    if (!settings.discord_webhook_url) {
      return res.status(400).json({ ok: false, error: 'Keine Discord-Webhook-URL im Tab "Admin" hinterlegt' });
    }
    
    // Fake track for testing
    const testTrack = {
      title: 'Test Song (Now Playing)',
      artist: 'OpenWeb Test',
      album: 'Webhook Integration',
      coverId: null, 
      testCoverUrl: 'https://images.unsplash.com/photo-1614680376573-df3480f0c6ef?auto=format&fit=crop&w=800&q=80', // Dummy Vinyl Bild für Discord
      url: settings.url || 'https://demo.navidrome.org',
      albumId: 'test-album-id',
    };

    const appUrl = process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : null;
    await sendDiscordWebhook(testTrack, settings.discord_webhook_url, appUrl);
    
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/navidrome', async (req, res, next) => {
  try {
    const enabled = !!req.body.enabled;
    const url = req.body.url ? v.safeUrl(req.body.url) : null;
    const username = req.body.username ? v.safeText(req.body.username, 120) : null;
    const pollInterval = Math.min(600, Math.max(5, parseInt(req.body.poll_interval_sec || '30', 10) || 30));

    let encryptedPassword = null;
    if (req.body.password) {
      encryptedPassword = encrypt(req.body.password);
    }

    if (encryptedPassword) {
      await db.query(`
        INSERT INTO navidrome_settings (id, enabled, url, username, password_encrypted, poll_interval_sec)
        VALUES (1, $1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          url = EXCLUDED.url,
          username = EXCLUDED.username,
          password_encrypted = EXCLUDED.password_encrypted,
          poll_interval_sec = EXCLUDED.poll_interval_sec,
          updated_at = NOW()
      `, [enabled, url, username, encryptedPassword, pollInterval]);
    } else {
      await db.query(`
        INSERT INTO navidrome_settings (id, enabled, url, username, poll_interval_sec)
        VALUES (1, $1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          url = EXCLUDED.url,
          username = EXCLUDED.username,
          poll_interval_sec = EXCLUDED.poll_interval_sec,
          updated_at = NOW()
      `, [enabled, url, username, pollInterval]);
    }

    const { rows } = await db.query(`
      SELECT id, enabled, url, username, poll_interval_sec, updated_at
      FROM navidrome_settings
      WHERE id = 1
      LIMIT 1
    `);
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/navidrome/test', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM navidrome_settings WHERE id = 1 LIMIT 1');
    const settings = rows[0];
    if (!settings || !settings.enabled || !settings.url || !settings.username || !settings.password_encrypted) {
      return res.json({ ok: true, data: { configured: false } });
    }

    const password = decrypt(settings.password_encrypted);
    const salt = crypto.randomBytes(8).toString('hex');
    const token = crypto.createHash('md5').update(password + salt).digest('hex');
    const pingUrl = new URL('/rest/ping', settings.url);
    pingUrl.searchParams.set('u', settings.username);
    pingUrl.searchParams.set('t', token);
    pingUrl.searchParams.set('s', salt);
    pingUrl.searchParams.set('v', '1.13.0');
    pingUrl.searchParams.set('c', 'openweb');
    pingUrl.searchParams.set('f', 'json');

    const response = await fetch(pingUrl.toString(), { headers: { Accept: 'application/json' } });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('Ungueltige Navidrome-Antwort'); }
    const status = json['subsonic-response'];
    if (!status) throw new Error('Keine Subsonic-Antwort');
    if (status.status === 'failed') throw new Error(status.error?.message || 'Navidrome-Fehler');

    res.json({ ok: true, data: { configured: true, connected: status.status === 'ok' } });
  } catch (err) {
    console.error('[admin navidrome/test]', err.message);
    res.json({ ok: true, data: { configured: false, error: err.message } });
  }
});

router.get('/links/:id/check', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT url FROM links WHERE id = $1 LIMIT 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Link nicht gefunden' });
    const url = rows[0].url;
    const start = Date.now();
    let status = 'unknown';
    let statusCode = null;
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10000) });
      statusCode = r.status;
      status = r.ok ? 'ok' : 'error';
    } catch {
      try {
        const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10000) });
        statusCode = r.status;
        status = r.ok ? 'ok' : 'error';
      } catch {
        status = 'unreachable';
      }
    }
    res.json({ ok: true, data: { url, status, statusCode, responseTimeMs: Date.now() - start } });
  } catch (err) {
    next(err);
  }
});

// ---------- Export / Import ----------
router.get('/export', async (req, res, next) => {
  try {
    const [profileRes, linksRes, categoriesRes, settingsRes] = await Promise.all([
      db.query('SELECT * FROM profile WHERE id = 1 LIMIT 1'),
      db.query('SELECT * FROM links ORDER BY position ASC'),
      db.query('SELECT * FROM link_categories ORDER BY position ASC'),
      db.query('SELECT * FROM admin_settings WHERE id = 1 LIMIT 1'),
    ]);

    res.json({
      ok: true,
      data: {
        version: 3,
        exportedAt: new Date().toISOString(),
        profile: profileRes.rows[0] || null,
        links: linksRes.rows,
        link_categories: categoriesRes.rows,
        admin_settings: settingsRes.rows[0] || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/import', async (req, res, next) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ ok: false, error: 'Ungueltiger Import' });
    }

    await db.transaction(async (client) => {
      if (data.profile && typeof data.profile === 'object') {
        const p = data.profile;
        await client.query(`
          INSERT INTO profile (id, name, handle, bio, avatar, avatar_url, theme)
          VALUES (1, $1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            handle = EXCLUDED.handle,
            bio = EXCLUDED.bio,
            avatar = EXCLUDED.avatar,
            avatar_url = EXCLUDED.avatar_url,
            theme = EXCLUDED.theme,
            updated_at = NOW()
        `, [
          v.safeText(p.name, 80),
          v.safeText(p.handle, 80),
          v.safeText(p.bio, 280),
          v.safeText(p.avatar, 2).toUpperCase() || 'CA',
          v.validateAvatarUrl(p.avatar_url),
          v.validateTheme(p.theme),
        ]);
      }

      if (Array.isArray(data.link_categories) && data.link_categories.length > 0) {
        await client.query('DELETE FROM link_categories');
        for (let i = 0; i < data.link_categories.length; i++) {
          const c = data.link_categories[i];
          await client.query(`
            INSERT INTO link_categories (id, name, position) VALUES ($1, $2, $3)
          `, [c.id, v.safeText(c.name, 80), i]);
        }
      }

      if (Array.isArray(data.links) && data.links.length > 0) {
        await client.query('DELETE FROM links');
        for (let i = 0; i < data.links.length; i++) {
          const l = data.links[i];
          const url = v.safeUrl(l.url);
          if (!url) continue;
          await client.query(`
            INSERT INTO links (
              title, subtitle, url, display_url, icon, position, is_active, open_new,
              meta_description, admin_note, slug, category_id,
              visible_from, visible_until, visible_weekdays
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          `, [
            v.safeText(l.title, 80),
            v.safeText(l.subtitle, 120),
            url,
            v.safeText(l.display_url, 120),
            v.sanitizeIconField(l.icon),
            i,
            l.is_active !== false,
            l.open_new !== false,
            v.safeText(l.meta_description, 280),
            v.safeText(l.admin_note, 280),
            v.safeSlug(l.slug),
            l.category_id || null,
            v.safeDate(l.visible_from),
            v.safeDate(l.visible_until),
            v.safeWeekdays(l.visible_weekdays),
          ]);
        }
      }
    });

    await audit.log(req, 'import', 'links', null, { imported: data.links?.length, categories: data.link_categories?.length });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Admin-Passwort aendern (selbst) ----------
// ---------- API-Keys ----------
router.get('/api-keys', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, name, last_used_at, created_at FROM api_keys ORDER BY created_at DESC');
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

router.post('/api-keys', async (req, res, next) => {
  try {
    const name = v.safeText(req.body.name, 80);
    if (!name) return res.status(400).json({ ok: false, error: 'Name ist Pflicht' });
    const plain = generateApiKey();
    const hash = await bcrypt.hash(plain, 10);
    const { rows } = await db.query('INSERT INTO api_keys (name, key_hash) VALUES ($1, $2) RETURNING id, name, created_at', [name, hash]);
    await audit.log(req, 'create', 'api_key', rows[0].id, { name });
    res.json({ ok: true, data: { ...rows[0], key: plain } });
  } catch (err) { next(err); }
});

router.delete('/api-keys/:id', async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM api_keys WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'Key nicht gefunden' });
    await audit.log(req, 'delete', 'api_key', req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- Backups ----------
router.get('/backups', async (req, res, next) => {
  try {
    const backups = backup.listBackups();
    res.json({ ok: true, data: backups });
  } catch (err) {
    next(err);
  }
});

router.post('/backups', async (req, res, next) => {
  try {
    const file = await backup.createBackup();
    await audit.log(req, 'backup', null, null, { file });
    res.json({ ok: true, data: { file } });
  } catch (err) {
    next(err);
  }
});

router.get('/backups/download/:name', async (req, res, next) => {
  try {
    const name = path.basename(req.params.name);
    const file = path.join(backup.BACKUP_DIR || path.join(__dirname, '..', 'backups'), name);
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: 'Backup nicht gefunden' });
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Type', 'application/json');
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    next(err);
  }
});

router.post('/import/linktree-csv', async (req, res, next) => {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'rows muss ein Array sein' });
    const countRes = await db.query('SELECT COUNT(*)::int AS count FROM links');
    let position = countRes.rows[0].count;
    let imported = 0;
    await db.transaction(async (client) => {
      for (const row of rows) {
        const url = v.safeUrl(row.url);
        if (!url || !row.title) continue;
        await client.query(`
          INSERT INTO links (title, subtitle, url, icon, position, is_active, open_new)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          v.safeText(row.title, 80),
          v.safeText(row.subtitle, 120),
          url,
          '🔗',
          position++,
          true,
          true,
        ]);
        imported++;
      }
    });
    await audit.log(req, 'import', 'linktree-csv', null, { imported });
    res.json({ ok: true, data: { imported } });
  } catch (err) {
    next(err);
  }
});

router.get('/audit-log', async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const rows = await audit.list(limit, offset);
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

router.post('/change-password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ ok: false, error: 'Aktuelles und neues Passwort (min. 8 Zeichen) erforderlich' });
    }

    const user = await findUserByEmail(req.session.email);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Benutzer nicht gefunden' });
    }

    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'Aktuelles Passwort falsch' });
    }

    const newHash = await hashPassword(newPassword);
    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, user.id]);

    await audit.log(req, 'change_password', 'user', user.id);
    alert.notify('password', 'Admin-Passwort wurde geändert', {
      email: user.email,
      ip: req.ip || req.connection.remoteAddress || '-',
      time: new Date().toISOString(),
    }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

  // ---------- 2FA & WebAuthn Settings ----------

  router.get('/settings/2fa/status', async (req, res) => {
    try {
      const db = require('../lib/db');
      const { rows } = await db.query('SELECT totp_enabled FROM users WHERE id = $1', [req.session.userId]);
      const { rows: webauthn } = await db.query('SELECT id, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1', [req.session.userId]);
      res.json({ ok: true, data: { totp_enabled: rows[0]?.totp_enabled || false, webauthn_keys: webauthn } });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  router.post('/settings/2fa/totp/setup', async (req, res) => {
    try {
      const { authenticator } = require('otplib');
      const QRCode = require('qrcode');
      const secret = authenticator.generateSecret();
      
      const db = require('../lib/db');
      const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
      const email = rows[0]?.email || 'admin@openweb';
      
      const otpauth = authenticator.keyuri(email, 'OpenWeb Admin', secret);
      const qrcodeUrl = await QRCode.toDataURL(otpauth);
      
      await db.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [secret, req.session.userId]);
      
      res.json({ ok: true, data: { secret, qrcode: qrcodeUrl } });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  router.post('/settings/2fa/totp/verify', async (req, res) => {
    try {
      const { code } = req.body;
      const db = require('../lib/db');
      const { rows } = await db.query('SELECT totp_secret FROM users WHERE id = $1', [req.session.userId]);
      const user = rows[0];
      
      if (!user || !user.totp_secret) {
        return res.status(400).json({ ok: false, error: 'TOTP nicht eingerichtet' });
      }
      
      const { authenticator } = require('otplib');
      const isValid = authenticator.check(code, user.totp_secret);
      if (!isValid) {
        return res.status(400).json({ ok: false, error: 'Ungueltiger Code' });
      }
      
      await db.query('UPDATE users SET totp_enabled = true WHERE id = $1', [req.session.userId]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  
  router.post('/settings/2fa/totp/disable', async (req, res) => {
    try {
      const db = require('../lib/db');
      await db.query('UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1', [req.session.userId]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  router.post('/settings/2fa/webauthn/register-options', async (req, res) => {
    try {
      const db = require('../lib/db');
      const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
      const user = rows[0];
      
      const { generateRegistrationOptions } = require('@simplewebauthn/server');
      const { rows: existing } = await db.query('SELECT credential_id FROM webauthn_credentials WHERE user_id = $1', [req.session.userId]);
      
      const options = await generateRegistrationOptions({
        rpName: 'OpenWeb',
        rpID: req.hostname,
        userID: new Uint8Array(Buffer.from(String(req.session.userId))),
        userName: user.email,
        attestationType: 'none',
        excludeCredentials: existing.map(r => ({
          id: r.credential_id,
          type: 'public-key'
        })),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
        }
      });
      
      await db.query('UPDATE users SET webauthn_current_challenge = $1 WHERE id = $2', [options.challenge, req.session.userId]);
      res.json({ ok: true, data: options });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  router.post('/settings/2fa/webauthn/register-verify', async (req, res) => {
    try {
      const db = require('../lib/db');
      const { rows } = await db.query('SELECT webauthn_current_challenge FROM users WHERE id = $1', [req.session.userId]);
      const expectedChallenge = rows[0]?.webauthn_current_challenge;
      if (!expectedChallenge) return res.status(400).json({ ok: false, error: 'Kein Challenge aktiv' });
      
      const { verifyRegistrationResponse } = require('@simplewebauthn/server');
      const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge,
        expectedOrigin: `${req.protocol}://${req.get('host')}`,
        expectedRPID: req.hostname,
      });
      
      if (verification.verified) {
        const { id, publicKey, counter } = verification.registrationInfo.credential;
        await db.query(
          'INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter) VALUES ($1, $2, $3, $4)',
          [req.session.userId, id, publicKey, counter]
        );
        await db.query('UPDATE users SET webauthn_current_challenge = NULL WHERE id = $1', [req.session.userId]);
        res.json({ ok: true });
      } else {
        res.status(400).json({ ok: false, error: 'Registrierung fehlgeschlagen' });
      }
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  
  router.delete('/settings/2fa/webauthn/:id', async (req, res) => {
    try {
      const db = require('../lib/db');
      await db.query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

module.exports = router;
