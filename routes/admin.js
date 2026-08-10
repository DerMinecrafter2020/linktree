// =========================================================
// Admin-API-Routen (hinter requireAdminSession)
// =========================================================

const express = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const { encrypt, decrypt } = require('../lib/crypto');
const v = require('../lib/validators');
const { hashPassword, verifyPassword, findUserByEmail, requireAdminSession } = require('../lib/auth');

const router = express.Router();

router.use(requireAdminSession);

// ---------- Auth (nur Logout/Me; Login ist oeffentlich unter /api/login) ----------
router.post('/logout', (req, res) => {
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

    await db.query(`
      INSERT INTO profile (id, name, handle, bio, avatar, avatar_url, theme, is_public, allow_visitor_theme)
      VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        handle = EXCLUDED.handle,
        bio = EXCLUDED.bio,
        avatar = EXCLUDED.avatar,
        avatar_url = EXCLUDED.avatar_url,
        theme = EXCLUDED.theme,
        is_public = EXCLUDED.is_public,
        allow_visitor_theme = EXCLUDED.allow_visitor_theme,
        updated_at = NOW()
    `, [name, handle, bio, avatar, avatarUrl, theme, isPublic, allowVisitorTheme]);

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
        (SELECT COUNT(*)::int FROM link_clicks WHERE link_id = l.id) AS click_count
      FROM links l
      LEFT JOIN link_categories c ON c.id = l.category_id
      ORDER BY c.position ASC NULLS FIRST, c.name ASC, l.position ASC, l.created_at ASC
    `);
    res.json({ ok: true, data: rows });
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
      SELECT COUNT(*)::int AS total FROM link_clicks WHERE clicked_at > NOW() - INTERVAL '${days} days'
    `);
    const linksRes = await db.query(`
      SELECT l.id, l.title, l.url, l.slug,
        COUNT(lc.id)::int AS clicks,
        COUNT(DISTINCT lc.ip_hash) AS unique_visitors
      FROM links l
      LEFT JOIN link_clicks lc ON lc.link_id = l.id AND lc.clicked_at > NOW() - INTERVAL '${days} days'
      GROUP BY l.id
      ORDER BY clicks DESC, l.position ASC
    `);
    const timelineRes = await db.query(`
      SELECT DATE(clicked_at) AS day, COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at > NOW() - INTERVAL '${days} days'
      GROUP BY day
      ORDER BY day ASC
    `);
    res.json({
      ok: true,
      data: {
        days,
        total: totalRes.rows[0].total,
        links: linksRes.rows,
        timeline: timelineRes.rows,
      },
    });
  } catch (err) {
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

    if (!title || !url) {
      return res.status(400).json({ ok: false, error: 'Titel und URL sind Pflicht' });
    }

    const countRes = await db.query('SELECT COUNT(*)::int AS count FROM links');
    const position = countRes.rows[0].count;

    const { rows } = await db.query(`
      INSERT INTO links (
        title, subtitle, url, display_url, icon, position, is_active, open_new,
        meta_description, admin_note, slug, category_id,
        visible_from, visible_until, visible_weekdays
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `, [title, subtitle, url, displayUrl, icon, position, isActive, openNew, metaDescription, adminNote, slug, categoryId, visibleFrom, visibleUntil, visibleWeekdays]);

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

// ---------- Navidrome-Settings (Admin) ----------
router.get('/navidrome', async (req, res, next) => {
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

router.post('/navidrome', async (req, res, next) => {
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

router.post('/navidrome/test', async (req, res, next) => {
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

      if (Array.isArray(data.link_categories)) {
        await client.query('DELETE FROM link_categories');
        for (let i = 0; i < data.link_categories.length; i++) {
          const c = data.link_categories[i];
          await client.query(`
            INSERT INTO link_categories (id, name, position) VALUES ($1, $2, $3)
          `, [c.id, v.safeText(c.name, 80), i]);
        }
      }

      if (Array.isArray(data.links)) {
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

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Admin-Passwort aendern (selbst) ----------
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

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
