// =========================================================
// Admin-API-Routen (hinter requireAdminSession)
// =========================================================

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { encrypt, decrypt, isEncrypted } = require('../lib/crypto');
const v = require('../lib/validators');
const { hashPassword, verifyPassword, findUserByEmail, requireAdminSession } = require('../lib/auth');
const bcrypt = require('bcrypt');
const backup = require('../lib/backup');
const audit = require('../lib/audit');
const alert = require('../lib/alert');
const contact = require('../lib/contact');
const og = require('../lib/og');
const botguard = require('../lib/botguard');
const icons = require('../lib/icons');
const encryptionKeyBackup = require('../lib/encryption-key-backup');
const { getAvailableUsers: getMusicAssistantUsers } = require('../lib/musicassistant');
const navidrome = require('../lib/navidrome');
const webauthnRp = require('../lib/webauthn-rp');

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
    const impressumText = req.body.impressum_text !== undefined ? String(req.body.impressum_text || '').slice(0, 10000) : undefined;
    const datenschutzText = req.body.datenschutz_text !== undefined ? String(req.body.datenschutz_text || '').slice(0, 10000) : undefined;
    const iconStyle = ['white', 'color'].includes(req.body.icon_style) ? req.body.icon_style : undefined;
    const playerProgressStyle = ['time', 'line'].includes(req.body.player_progress_style)
      ? req.body.player_progress_style
      : undefined;

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
    
    let extraCols = [];
    let extraVals = [];
    
    if (customCss !== undefined) {
      updates.splice(-1, 0, `custom_css = EXCLUDED.custom_css`);
      values.push(customCss);
      extraCols.push('custom_css');
      extraVals.push('$' + idx++);
    }
    
    if (impressumText !== undefined) {
      updates.splice(-1, 0, `impressum_text = EXCLUDED.impressum_text`);
      values.push(impressumText);
      extraCols.push('impressum_text');
      extraVals.push('$' + idx++);
    }

    if (datenschutzText !== undefined) {
      updates.splice(-1, 0, `datenschutz_text = EXCLUDED.datenschutz_text`);
      values.push(datenschutzText);
      extraCols.push('datenschutz_text');
      extraVals.push('$' + idx++);
    }

    if (iconStyle !== undefined) {
      updates.splice(-1, 0, `icon_style = EXCLUDED.icon_style`);
      values.push(iconStyle);
      extraCols.push('icon_style');
      extraVals.push('$' + idx++);
    }

    if (playerProgressStyle !== undefined) {
      updates.splice(-1, 0, 'player_progress_style = EXCLUDED.player_progress_style');
      values.push(playerProgressStyle);
      extraCols.push('player_progress_style');
      extraVals.push('$' + idx++);
    }
    
    const extraColsStr = extraCols.length ? ', ' + extraCols.join(', ') : '';
    const extraValsStr = extraVals.length ? ', ' + extraVals.join(', ') : '';

    await db.query(`
      INSERT INTO profile (id, name, handle, bio, avatar, avatar_url, theme, is_public, allow_visitor_theme${extraColsStr})
      VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8${extraValsStr})
      ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}
    `, values);

    await audit.log(req, 'profile_update', 'profile', 1);
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
    const safe = rows.map(r => ({ ...r, password_hash: undefined, icon_resolved: icons.resolveIcon(r) }));
    res.json({ ok: true, data: safe });
  } catch (err) {
    next(err);
  }
});

// ---------- Ressourcenmonitor ----------
router.get('/metrics', async (req, res, next) => {
  try {
    const metrics = require('../lib/metrics');
    const since = parseInt(req.query.since, 10) || 0;
    const data = metrics.snapshot(since);
    const persisted = await metrics.persistentSnapshot(since);
    data.history = persisted.history;
    data.totals = persisted.totals;
    // Groessen, die sich selten aendern, nur beim ersten Abruf (ohne since) mitliefern
    if (!since) {
      const { rows } = await db.query(`
        SELECT pg_database_size(current_database()) AS db_bytes,
               (SELECT COUNT(*)::int FROM user_sessions WHERE expire > NOW()) AS sessions,
               (SELECT COUNT(*)::int FROM link_clicks) AS clicks
      `);
      let backupBytes = 0;
      let backupCount = 0;
      try {
        for (const b of backup.listBackups()) { backupBytes += b.size; backupCount += 1; }
      } catch { /* Backup-Ordner fehlt */ }
      data.storage = {
        dbBytes: Number(rows[0].db_bytes),
        sessions: rows[0].sessions,
        clicks: rows[0].clicks,
        backupBytes,
        backupCount,
      };
    }
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// ---------- Icons (Dashboard Icons) ----------
// Namenssuche fuer die Icon-Auswahl im Link-Dialog
router.get('/icons/dashboard', async (req, res, next) => {
  try {
    await icons.ensureLoaded();
    const q = String(req.query.q || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const all = icons.listNames();
    const matches = q ? all.filter(n => n.includes(q)) : all;
    // exakter Treffer zuerst, dann Treffer am Wortanfang, dann alphabetisch
    const rank = (n) => (n === q ? 0 : n.startsWith(q) ? 1 : 2);
    matches.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    res.json({ ok: true, data: { total: matches.length, names: matches.slice(0, 120) } });
  } catch (err) { next(err); }
});

// Vorschau: welches Icon ergibt sich aus Icon-Feld, URL und Titel?
router.get('/icons/resolve', async (req, res, next) => {
  try {
    await icons.ensureLoaded();
    const link = {
      icon: v.sanitizeIconField(String(req.query.icon || '')),
      url: String(req.query.url || '').slice(0, 500),
      title: v.safeText(String(req.query.title || ''), 80),
    };
    res.json({ ok: true, data: icons.resolveIcon(link) });
  } catch (err) { next(err); }
});

// ---------- QR-Codes ----------
// ---------- Statistik ----------
// Zeitzone fuer die Tagesbalken (vom Browser des Admins). Nur Namen, die PostgreSQL kennt;
// sonst UTC. Ergebnis wird gecacht, damit pg_timezone_names nicht bei jedem Aufruf laeuft.
const STATS_TZ_RE = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/;
const statsTzCache = new Map();
async function statsTimeZone(raw) {
  const tz = typeof raw === 'string' ? raw.trim() : '';
  if (!tz || tz.length > 64 || !STATS_TZ_RE.test(tz)) return 'UTC';
  if (statsTzCache.has(tz)) return statsTzCache.get(tz);
  const { rows } = await db.query('SELECT 1 FROM pg_timezone_names WHERE name = $1 LIMIT 1', [tz]);
  const result = rows.length ? tz : 'UTC';
  if (statsTzCache.size < 50) statsTzCache.set(tz, result);
  return result;
}

router.get('/stats/links', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const tz = await statsTimeZone(req.query.tz);
    // Zeitraum = volle Kalendertage in der Zeitzone des Admins inkl. heute (wie im Diagramm)
    const sinceRes = await db.query(
      `SELECT (date_trunc('day', NOW() AT TIME ZONE $2) - ($1::int - 1) * INTERVAL '1 day') AT TIME ZONE $2 AS since`,
      [days, tz]
    );
    const since = sinceRes.rows[0].since;
    const totalRes = await db.query(`
      SELECT COUNT(*)::int AS total FROM link_clicks WHERE clicked_at >= $1
    `, [since]);
    const linksRes = await db.query(`
      SELECT l.id, l.title, l.url, l.slug,
        COUNT(lc.id)::int AS clicks,
        COUNT(DISTINCT lc.ip_hash)::int AS unique_visitors
      FROM links l
      LEFT JOIN link_clicks lc ON lc.link_id = l.id AND lc.clicked_at >= $1
      GROUP BY l.id
      ORDER BY clicks DESC, l.position ASC
    `, [since]);
    // Tag als Text (YYYY-MM-DD) in der Zeitzone des Admins: ein DATE-Wert wuerde als
    // Mitternacht in Server-Zeit nach JSON serialisiert und im Browser um einen Tag verrutschen.
    const timelineRes = await db.query(`
      SELECT to_char((clicked_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at >= $1
      GROUP BY 1
      ORDER BY 1 ASC
    `, [since, tz]);
    const utmRes = await db.query(`
      SELECT COALESCE(utm_source, '(direkt)') AS source,
             COALESCE(utm_medium, '(unbekannt)') AS medium,
             COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at >= $1
      GROUP BY utm_source, utm_medium
      ORDER BY count DESC
      LIMIT 20
    `, [since]);
    const devicesRes = await db.query(`
      SELECT COALESCE(device_type, 'unbekannt') AS device_type, COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at >= $1
      GROUP BY device_type
      ORDER BY count DESC
    `, [since]);
    const browsersRes = await db.query(`
      SELECT COALESCE(browser, 'unbekannt') AS browser, COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at >= $1
      GROUP BY browser
      ORDER BY count DESC
    `, [since]);
    const osRes = await db.query(`
      SELECT COALESCE(os, 'unbekannt') AS os, COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at >= $1
      GROUP BY os
      ORDER BY count DESC
    `, [since]);
    const countriesRes = await db.query(`
      SELECT COALESCE(country_code, 'unbekannt') AS country_code, COUNT(*)::int AS count
      FROM link_clicks
      WHERE clicked_at >= $1
      GROUP BY country_code
      ORDER BY count DESC
    `, [since]);
    const musicHistoryRes = await db.query(`
      SELECT * FROM (
        SELECT DISTINCT ON (title, artist) title, artist, album, source, played_at
        FROM music_history 
        WHERE played_at >= $1
        ORDER BY title, artist, played_at DESC
      ) AS deduped
      ORDER BY played_at DESC
      LIMIT 150
    `, [since]);
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
        musicHistory: musicHistoryRes.rows,
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
    if (!Array.isArray(orderedIds) || orderedIds.length > 1000) {
      return res.status(400).json({ ok: false, error: 'orderedIds muss ein Array sein' });
    }
    if (!orderedIds.every(id => /^\d+$/.test(String(id)) || /^[0-9a-fA-F-]{36}$/.test(String(id)))) {
      return res.status(400).json({ ok: false, error: 'Ungültige ID' });
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
    const discordTemplate = req.body.discord_webhook_template
      ? String(req.body.discord_webhook_template).slice(0, 2000)
      : null;

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
    // Wie <input type="email"> (erlaubt auch z. B. root@localhost), aber ohne Leer-/Steuerzeichen
    const rawEmailTo = typeof s.email_to === 'string' ? s.email_to.trim() : '';
    const emailTo = /^[^\s@<>",;]+@[^\s@<>",;]+$/.test(rawEmailTo) && rawEmailTo.length <= 254 ? rawEmailTo : null;
    if (rawEmailTo && !emailTo) {
      return res.status(400).json({ ok: false, error: 'Ungueltige Empfaenger-E-Mail' });
    }

    // SMTP-Passwort verschluesselt speichern. Leeres Feld = bisheriges Passwort behalten.
    // Bei fehlendem/ungueltigem Schluessel abbrechen, niemals Klartext persistieren.
    let smtpPassword;
    if (s.smtp_password) {
      smtpPassword = encrypt(String(s.smtp_password).slice(0, 500));
    } else {
      const { rows: existing } = await db.query('SELECT smtp_password FROM alert_settings WHERE id = 1 LIMIT 1');
      const current = existing[0]?.smtp_password || null;
      smtpPassword = current && !isEncrypted(current) ? encrypt(current) : current;
    }

    const smtpPort = parseInt(s.smtp_port, 10);
    const values = [
      !!s.email_enabled,
      emailTo,
      s.smtp_host ? v.safeText(String(s.smtp_host), 255) || null : null,
      smtpPort >= 1 && smtpPort <= 65535 ? smtpPort : 587,
      s.smtp_user ? v.safeText(String(s.smtp_user), 255) || null : null,
      smtpPassword,
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

// ---------- Bot-Schutz (lib/botguard.js) ----------
router.get('/settings/botguard', async (req, res, next) => {
  try {
    await botguard.load();
    res.json({ ok: true, data: botguard.publicView() });
  } catch (err) { next(err); }
});

router.post('/settings/botguard', async (req, res, next) => {
  try {
    const b = req.body || {};
    const data = await botguard.saveSettings({
      enabled: b.enabled !== false,
      challenge_enabled: b.challenge_enabled !== false,
      mode: b.mode,
      difficulty: b.difficulty,
      clearance_days: b.clearance_days,
      rate_per_min: b.rate_per_min,
      allowlist: typeof b.allowlist === 'string' ? b.allowlist : '',
      manual_blocklist: typeof b.manual_blocklist === 'string' ? b.manual_blocklist : '',
      ufw_enabled: b.ufw_enabled === true,
      ufw_url: typeof b.ufw_url === 'string' ? b.ufw_url : '',
      ufw_token: b.remove_ufw_token === true ? null : (typeof b.ufw_token === 'string' ? b.ufw_token : undefined),
      ufw_lists: typeof b.ufw_lists === 'string' ? b.ufw_lists : '',
      ufw_interval_min: b.ufw_interval_min,
    });
    await audit.log(req, 'update', 'botguard_settings', 1, { enabled: data.enabled, mode: data.mode, ufw: data.ufw_enabled });
    res.json({ ok: true, data });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ ok: false, error: err.message });
    next(err);
  }
});

router.post('/settings/botguard/sync', async (req, res, next) => {
  try {
    const result = await botguard.syncUfw();
    res.json({ ok: true, data: { ...result, settings: botguard.publicView() } });
  } catch (err) { next(err); }
});

// ---------- Link-Vorschau (Open Graph) ----------
function ogView(settings) {
  return {
    has_image: Boolean(settings.has_image),
    image_key: settings.image_key || null,
    custom: Boolean(settings.custom),
    show_now_playing: settings.show_now_playing !== false,
    updated_at: settings.updated_at || null,
    image_url: settings.has_image ? `/og-image.jpg?v=${og.versionOf(settings.updated_at)}` : null,
    width: og.WIDTH,
    height: og.HEIGHT,
  };
}

router.get('/og', async (req, res, next) => {
  try {
    res.json({ ok: true, data: ogView(await og.getSettings()) });
  } catch (err) { next(err); }
});

router.post('/og/image', async (req, res, next) => {
  try {
    const b = req.body || {};
    const settings = await og.saveImage({ dataUrl: b.image, key: b.key, custom: b.custom === true });
    if (b.custom === true) await audit.log(req, 'update', 'og_image', 1, { custom: true });
    res.json({ ok: true, data: ogView(settings) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ ok: false, error: err.message });
    next(err);
  }
});

router.delete('/og/image', async (req, res, next) => {
  try {
    const settings = await og.clearImage();
    await audit.log(req, 'delete', 'og_image', 1);
    res.json({ ok: true, data: ogView(settings) });
  } catch (err) { next(err); }
});

router.post('/og/options', async (req, res, next) => {
  try {
    const settings = await og.saveOptions({ showNowPlaying: req.body?.show_now_playing !== false });
    res.json({ ok: true, data: ogView(settings) });
  } catch (err) { next(err); }
});

// ---------- Kontaktformular (Versand ueber die SMTP-Daten der Alert-Einstellungen) ----------
router.get('/settings/contact', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await contact.getStatus() });
  } catch (err) { next(err); }
});

router.post('/settings/contact', async (req, res, next) => {
  try {
    const b = req.body || {};
    const data = await contact.saveSettings({
      enabled: b.enabled === true,
      recipient: typeof b.recipient === 'string' ? b.recipient : '',
      introText: typeof b.intro_text === 'string' ? b.intro_text : '',
    });
    await audit.log(req, 'update', 'contact_settings', 1, { enabled: data.enabled });
    res.json({ ok: true, data });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ ok: false, error: err.message });
    next(err);
  }
});

router.post('/settings/contact/test', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT name, handle FROM profile WHERE id = 1 LIMIT 1');
    const result = await contact.sendTest(rows[0]);
    res.json({ ok: true, data: result });
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
    const { rows } = await db.query('SELECT * FROM music_history ORDER BY played_at DESC LIMIT 150');
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('[music-history] Error fetching history:', err);
    res.status(500).json({ ok: false, error: 'Fehler beim Laden des Musikverlaufs' });
  }
});

// ---------- Navidrome-Settings (Admin) ----------
// Navidrome-Einstellungen fuer das Admin-Formular: Benutzername entschluesselt, Passwort nie
async function navidromeSettingsView() {
  const s = await navidrome.getSettings();
  if (!s) return { enabled: false, url: '', username: '', poll_interval_sec: 30, has_password: false };
  return {
    id: s.id,
    enabled: !!s.enabled,
    url: s.url || '',
    username: s.username || '',
    poll_interval_sec: s.poll_interval_sec || 30,
    has_password: !!s.password_encrypted,
    updated_at: s.updated_at,
  };
}

router.get('/settings/navidrome', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await navidromeSettingsView() });
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

    // Test-Track; die Quelle bestimmt Quellen-Anzeige und Link in der Discord-Nachricht
    const source = ['navidrome', 'musicassistant', 'spotify'].includes(req.body?.source) ? req.body.source : 'navidrome';
    const testTrack = {
      title: 'Test Song (Now Playing)',
      artist: 'OpenWeb Test',
      album: 'Webhook Integration',
      coverId: null,
      testCoverUrl: 'https://images.unsplash.com/photo-1614680376573-df3480f0c6ef?auto=format&fit=crop&w=800&q=80', // Dummy Vinyl Bild für Discord
      source,
      ...(source === 'spotify'
        ? { spotifyUrl: 'https://open.spotify.com/' }
        : { url: settings.url || 'https://demo.navidrome.org', albumId: 'test-album-id' }),
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
    // Benutzername und Passwort werden verschluesselt gespeichert (lib/navidrome.saveSettings);
    // leeres Passwort = gespeichertes Passwort behalten
    await navidrome.saveSettings({
      enabled: !!req.body.enabled,
      url: req.body.url ? v.safeUrl(req.body.url) : null,
      username: req.body.username ? v.safeText(req.body.username, 120) : null,
      password: typeof req.body.password === 'string' ? req.body.password : null,
      pollIntervalSec: req.body.poll_interval_sec,
    });
    res.json({ ok: true, data: await navidromeSettingsView() });
  } catch (err) {
    next(err);
  }
});

// ---------- MusicAssistant-Settings (Admin) ----------
router.get('/settings/musicassistant', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, enabled, url, user_id, updated_at, (COALESCE(token_encrypted, '') <> '') AS has_token
      FROM musicassistant_settings
      WHERE id = 1
      LIMIT 1
    `);
    res.json({ ok: true, data: rows[0] || { enabled: false, has_token: false } });
  } catch (err) {
    next(err);
  }
});

router.get('/settings/musicassistant/users', async (req, res) => {
  try {
    const users = await getMusicAssistantUsers();
    res.json({ ok: true, data: users });
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[admin musicassistant/users]', err.message);
    res.status(502).json({
      ok: false,
      error: 'Music Assistant-Benutzer konnten nicht geladen werden. Bitte URL und Token-Berechtigung (users.read) prüfen.'
    });
  }
});

router.post('/settings/musicassistant', async (req, res, next) => {
  try {
    const enabled = !!req.body.enabled;
    const url = req.body.url ? v.safeUrl(req.body.url) : null;
    const userId = v.safeText(req.body.userId, 255) || null;

    let encryptedToken = null;
    if (req.body.token) {
      encryptedToken = encrypt(req.body.token);
    }

    if (encryptedToken) {
      await db.query(`
        INSERT INTO musicassistant_settings (id, enabled, url, token_encrypted, user_id)
        VALUES (1, $1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          url = EXCLUDED.url,
          token_encrypted = EXCLUDED.token_encrypted,
          user_id = EXCLUDED.user_id,
          updated_at = NOW()
      `, [enabled, url, encryptedToken, userId]);
    } else {
      await db.query(`
        INSERT INTO musicassistant_settings (id, enabled, url, user_id)
        VALUES (1, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          url = EXCLUDED.url,
          user_id = EXCLUDED.user_id,
          updated_at = NOW()
      `, [enabled, url, userId]);
    }

    const { rows } = await db.query(`
      SELECT id, enabled, url, user_id, updated_at, (COALESCE(token_encrypted, '') <> '') AS has_token
      FROM musicassistant_settings
      WHERE id = 1
      LIMIT 1
    `);
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------- Spotify (Admin) ----------
// Eigene Spotify-App (developer.spotify.com) mit Client-ID/-Secret; Anmeldung per OAuth.
// Client-Secret und Refresh-Token werden nur verschluesselt gespeichert und nie ausgegeben.
const spotify = require('../lib/spotify');
const SPOTIFY_STATE_MAX_AGE_MS = 10 * 60 * 1000;

function spotifySettingsView(row, req) {
  const s = row || {};
  const redirect = spotify.getRedirectUriStatus(req);
  return {
    enabled: !!s.enabled,
    client_id: s.client_id || '',
    has_client_secret: !!s.client_secret_encrypted,
    connected: spotify.isConnected(s),
    account_name: s.account_name || null,
    connected_at: s.connected_at || null,
    redirect_uri: redirect.uri,
    // Fuer den Einrichtungsassistenten (APP_URL gesetzt? https?)
    redirect_uri_configured: redirect.configured,
    redirect_uri_secure: redirect.secure,
    redirect_uri_localhost: redirect.localhost,
  };
}

router.get('/settings/spotify', async (req, res, next) => {
  try {
    res.json({ ok: true, data: spotifySettingsView(await spotify.getSettings(), req) });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/spotify', async (req, res, next) => {
  try {
    const enabled = !!req.body.enabled;
    const clientId = typeof req.body.clientId === 'string' ? req.body.clientId.trim() : '';
    const clientSecret = typeof req.body.clientSecret === 'string' ? req.body.clientSecret.trim() : '';
    if (clientId && !spotify.ID_RE.test(clientId)) {
      return res.status(400).json({ ok: false, error: 'Ungültige Client-ID (nur Buchstaben und Ziffern)' });
    }
    if (clientSecret && !spotify.ID_RE.test(clientSecret)) {
      return res.status(400).json({ ok: false, error: 'Ungültiges Client-Secret (nur Buchstaben und Ziffern)' });
    }

    const current = await spotify.getSettings() || {};
    // Neue App-Zugangsdaten: bestehende Anmeldung gehoert zur alten App und wird verworfen
    const credentialsChanged = (clientId || null) !== (current.client_id || null) || !!clientSecret;
    const secretEnc = clientSecret ? encrypt(clientSecret) : (clientId ? current.client_secret_encrypted || null : null);
    if (enabled && (!clientId || !secretEnc)) {
      return res.status(400).json({ ok: false, error: 'Client-ID und Client-Secret sind Pflicht, wenn Spotify aktiviert ist' });
    }

    await db.query(`
      INSERT INTO spotify_settings (id, enabled, client_id, client_secret_encrypted, refresh_token_encrypted, account_name, connected_at)
      VALUES (1, $1, $2, $3, NULL, NULL, NULL)
      ON CONFLICT (id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        client_id = EXCLUDED.client_id,
        client_secret_encrypted = EXCLUDED.client_secret_encrypted,
        refresh_token_encrypted = CASE WHEN $4 THEN NULL ELSE spotify_settings.refresh_token_encrypted END,
        account_name = CASE WHEN $4 THEN NULL ELSE spotify_settings.account_name END,
        connected_at = CASE WHEN $4 THEN NULL ELSE spotify_settings.connected_at END,
        updated_at = NOW()
    `, [enabled, clientId || null, secretEnc, credentialsChanged]);
    if (credentialsChanged) spotify.resetState();
    await audit.log(req, 'settings_update', 'spotify', 1, { enabled, credentials_changed: credentialsChanged });

    res.json({ ok: true, data: spotifySettingsView(await spotify.getSettings(), req) });
  } catch (err) {
    next(err);
  }
});

// Startet die Anmeldung: liefert die Spotify-URL (POST, damit die CSRF-Pruefung greift)
router.post('/settings/spotify/authorize', async (req, res, next) => {
  try {
    const settings = await spotify.getSettings();
    if (!spotify.isConfigured(settings)) {
      return res.status(400).json({ ok: false, error: 'Bitte zuerst Client-ID und Client-Secret speichern' });
    }
    const state = crypto.randomBytes(32).toString('hex');
    const redirectUri = spotify.getRedirectUri(req);
    req.session.spotifyOAuth = { state, redirectUri, createdAt: Date.now() };
    req.session.save((err) => {
      if (err) return next(err);
      res.json({ ok: true, data: { url: spotify.buildAuthorizeUrl(settings, state, redirectUri) } });
    });
  } catch (err) {
    next(err);
  }
});

// Rueckkehr von Spotify (GET, von Spotify aufgerufen). Schutz ueber den einmaligen state-Wert,
// der an die Admin-Session gebunden ist.
router.get('/spotify/callback', async (req, res) => {
  const pending = req.session.spotifyOAuth;
  delete req.session.spotifyOAuth;
  const done = (status) => res.redirect(`/admin?spotify=${status}`);

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const stateOk = pending && typeof pending.state === 'string' && state.length === pending.state.length &&
    crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state)) &&
    Date.now() - pending.createdAt < SPOTIFY_STATE_MAX_AGE_MS;
  if (!stateOk) return done('invalid');
  if (req.query.error) return done('denied');

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code || code.length > 2000) return done('invalid');

  try {
    const settings = await spotify.getSettings();
    if (!spotify.isConfigured(settings)) return done('error');
    const tokens = await spotify.exchangeCode(settings, code, pending.redirectUri);
    const refreshEnc = encrypt(tokens.refresh_token);
    await db.query(
      'UPDATE spotify_settings SET refresh_token_encrypted = $1, connected_at = NOW(), updated_at = NOW() WHERE id = 1',
      [refreshEnc]
    );
    spotify.resetState();
    const connected = { ...settings, refresh_token_encrypted: refreshEnc };
    spotify.primeToken(connected, tokens.access_token, tokens.expires_in);
    try {
      const profile = await spotify.getProfile(connected);
      await db.query('UPDATE spotify_settings SET account_name = $1 WHERE id = 1', [profile.name || profile.id || null]);
    } catch (err) {
      console.warn('[spotify] Profil konnte nicht geladen werden:', err.message);
    }
    await audit.log(req, 'connect', 'spotify', 1);
    done('connected');
  } catch (err) {
    console.error('[spotify] Anmeldung fehlgeschlagen:', err.message);
    done('error');
  }
});

router.post('/settings/spotify/disconnect', async (req, res, next) => {
  try {
    await db.query('UPDATE spotify_settings SET refresh_token_encrypted = NULL, account_name = NULL, connected_at = NULL, updated_at = NOW() WHERE id = 1');
    spotify.resetState();
    await audit.log(req, 'disconnect', 'spotify', 1);
    res.json({ ok: true, data: spotifySettingsView(await spotify.getSettings(), req) });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/spotify/test', async (req, res) => {
  try {
    const settings = await spotify.getSettings();
    if (!spotify.isConnected(settings)) return res.json({ ok: true, data: { configured: false } });
    const profile = await spotify.getProfile(settings);
    if (profile.name && profile.name !== settings.account_name) {
      await db.query('UPDATE spotify_settings SET account_name = $1 WHERE id = 1', [profile.name]);
    }
    const track = await spotify.getNowPlaying();
    res.json({
      ok: true,
      data: {
        configured: true,
        connected: true,
        account: profile.name || profile.id || null,
        enabled: !!settings.enabled,
        playing: !!(track && track.playing),
        title: track?.title || null,
        artist: track?.artist || null,
      },
    });
  } catch (err) {
    console.error('[admin spotify/test]', err.message);
    let error = 'Spotify nicht erreichbar oder Anmeldung abgelaufen';
    if (err.status === 429) error = 'Spotify-Rate-Limit erreicht, bitte später erneut testen';
    if (err.status === 403) {
      error = 'Spotify verweigert den Zugriff: Ist dein Konto in der App unter „User Management“ eingetragen und hat Premium?';
    }
    res.json({ ok: true, data: { configured: true, connected: false, error, status: err.status || null } });
  }
});

// ---------- Instagram-Profilabgleich (Admin) ----------
// Eigene Meta-App (Business Login for Instagram); nur Business-/Creator-Konten.
// App-Secret und Token werden nur verschluesselt gespeichert und nie ausgegeben.
const instagram = require('../lib/instagram');
const INSTAGRAM_STATE_MAX_AGE_MS = 10 * 60 * 1000;

function instagramSettingsView(row, req) {
  const s = row || {};
  const redirect = instagram.getRedirectUriStatus(req);
  return {
    enabled: !!s.enabled,
    app_id: s.app_id || '',
    has_app_secret: !!s.app_secret_encrypted,
    connected: instagram.isConnected(s),
    username: s.username || null,
    token_expires_at: s.token_expires_at || null,
    sync_avatar: s.sync_avatar !== false,
    sync_bio: s.sync_bio !== false,
    sync_name: !!s.sync_name,
    bio_available: s.bio_available,
    last_sync_at: s.last_sync_at || null,
    last_sync_ok: s.last_sync_ok,
    last_sync_message: s.last_sync_message || null,
    connected_at: s.connected_at || null,
    redirect_uri: redirect.uri,
    redirect_uri_configured: redirect.configured,
    redirect_uri_secure: redirect.secure,
    redirect_uri_localhost: redirect.localhost,
  };
}

router.get('/settings/instagram', async (req, res, next) => {
  try {
    res.json({ ok: true, data: instagramSettingsView(await instagram.getSettings(), req) });
  } catch (err) {
    next(err);
  }
});

// Speichern: App-Zugangsdaten und/oder Auswahl der Felder. Fehlende Felder bleiben unveraendert.
router.post('/settings/instagram', async (req, res, next) => {
  try {
    const body = req.body || {};
    const current = await instagram.getSettings() || {};
    const appId = typeof body.appId === 'string' ? body.appId.trim() : (current.app_id || '');
    const appSecret = typeof body.appSecret === 'string' ? body.appSecret.trim() : '';
    if (appId && !instagram.APP_ID_RE.test(appId)) {
      return res.status(400).json({ ok: false, error: 'Ungültige Instagram-App-ID (nur Ziffern)' });
    }
    if (appSecret && !instagram.APP_SECRET_RE.test(appSecret)) {
      return res.status(400).json({ ok: false, error: 'Ungültiges Instagram-App-Secret (nur Buchstaben und Ziffern)' });
    }
    const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
    const enabled = bool(body.enabled, !!current.enabled);
    const syncAvatar = bool(body.sync_avatar, current.sync_avatar !== false);
    const syncBio = bool(body.sync_bio, current.sync_bio !== false);
    const syncName = bool(body.sync_name, !!current.sync_name);

    // Neue App-Zugangsdaten: bestehende Anmeldung gehoert zur alten App und wird verworfen
    const credentialsChanged = (appId || null) !== (current.app_id || null) || !!appSecret;
    const secretEnc = appSecret ? encrypt(appSecret) : (appId ? current.app_secret_encrypted || null : null);
    if (enabled && (!appId || !secretEnc)) {
      return res.status(400).json({ ok: false, error: 'App-ID und App-Secret sind Pflicht, wenn der Abgleich aktiviert ist' });
    }

    await db.query(`
      INSERT INTO instagram_settings (id, enabled, app_id, app_secret_encrypted, sync_avatar, sync_bio, sync_name)
      VALUES (1, $1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        app_id = EXCLUDED.app_id,
        app_secret_encrypted = EXCLUDED.app_secret_encrypted,
        sync_avatar = EXCLUDED.sync_avatar,
        sync_bio = EXCLUDED.sync_bio,
        sync_name = EXCLUDED.sync_name,
        access_token_encrypted = CASE WHEN $7 THEN NULL ELSE instagram_settings.access_token_encrypted END,
        token_expires_at = CASE WHEN $7 THEN NULL ELSE instagram_settings.token_expires_at END,
        username = CASE WHEN $7 THEN NULL ELSE instagram_settings.username END,
        connected_at = CASE WHEN $7 THEN NULL ELSE instagram_settings.connected_at END,
        updated_at = NOW()
    `, [enabled, appId || null, secretEnc, syncAvatar, syncBio, syncName, credentialsChanged]);
    await audit.log(req, 'settings_update', 'instagram', 1, { enabled, credentials_changed: credentialsChanged });

    res.json({ ok: true, data: instagramSettingsView(await instagram.getSettings(), req) });
  } catch (err) {
    next(err);
  }
});

// Startet die Anmeldung: liefert die Instagram-URL (POST, damit die CSRF-Pruefung greift)
router.post('/settings/instagram/authorize', async (req, res, next) => {
  try {
    const settings = await instagram.getSettings();
    if (!instagram.isConfigured(settings)) {
      return res.status(400).json({ ok: false, error: 'Bitte zuerst App-ID und App-Secret speichern' });
    }
    const state = crypto.randomBytes(32).toString('hex');
    const redirectUri = instagram.getRedirectUri(req);
    req.session.instagramOAuth = { state, redirectUri, createdAt: Date.now() };
    req.session.save((err) => {
      if (err) return next(err);
      res.json({ ok: true, data: { url: instagram.buildAuthorizeUrl(settings, state, redirectUri) } });
    });
  } catch (err) {
    next(err);
  }
});

// Rueckkehr von Instagram (GET). Schutz ueber den einmaligen state-Wert der Admin-Session.
router.get('/instagram/callback', async (req, res) => {
  const pending = req.session.instagramOAuth;
  delete req.session.instagramOAuth;
  const done = (status) => res.redirect(`/admin?instagram=${status}`);

  const state = typeof req.query.state === 'string' ? req.query.state.replace(/#_$/, '') : '';
  const stateOk = pending && typeof pending.state === 'string' && state.length === pending.state.length &&
    crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state)) &&
    Date.now() - pending.createdAt < INSTAGRAM_STATE_MAX_AGE_MS;
  if (!stateOk) return done('invalid');
  if (req.query.error) return done('denied');

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code || code.length > 2000) return done('invalid');

  try {
    const settings = await instagram.getSettings();
    if (!instagram.isConfigured(settings)) return done('error');
    const token = await instagram.exchangeCode(settings, code, pending.redirectUri);
    await instagram.saveToken(token.accessToken, token.expiresIn, { userId: token.userId, connected: true });
    // Benutzernamen gleich mit abholen (Profil wird erst nach der Feldauswahl uebernommen)
    try {
      const profile = await instagram.fetchProfile(token.accessToken);
      await db.query('UPDATE instagram_settings SET username = $1, bio_available = $2 WHERE id = 1',
        [profile.username || null, profile.bioAvailable]);
    } catch (err) {
      console.warn('[instagram] Profil nach dem Verbinden nicht ladbar:', err.message);
    }
    await audit.log(req, 'connect', 'instagram', 1);
    done('connected');
  } catch (err) {
    console.error('[instagram] Anmeldung fehlgeschlagen:', err.message);
    done('error');
  }
});

router.post('/settings/instagram/disconnect', async (req, res, next) => {
  try {
    await db.query(`UPDATE instagram_settings SET access_token_encrypted = NULL, token_expires_at = NULL,
      token_refreshed_at = NULL, username = NULL, connected_at = NULL, updated_at = NOW() WHERE id = 1`);
    await audit.log(req, 'disconnect', 'instagram', 1);
    res.json({ ok: true, data: instagramSettingsView(await instagram.getSettings(), req) });
  } catch (err) {
    next(err);
  }
});

// Jetzt abgleichen (auch wenn der taegliche Abgleich deaktiviert ist)
router.post('/settings/instagram/sync', async (req, res, next) => {
  try {
    const result = await instagram.syncNow({ force: true });
    if (result.ok && result.changed.length) {
      await audit.log(req, 'profile_sync', 'instagram', 1, { changed: result.changed });
    }
    const { rows } = await db.query('SELECT name, handle, bio, avatar, avatar_url FROM profile WHERE id = 1 LIMIT 1');
    res.json({
      ok: true,
      data: { ...result, profile: rows[0] || null, settings: instagramSettingsView(await instagram.getSettings(), req) },
    });
  } catch (err) {
    next(err);
  }
});

// Verbindung pruefen. Mit url/username/password im Body werden diese Werte geprueft, ohne zu
// speichern (Einrichtungsassistent); ein leeres Passwort nimmt das gespeicherte.
router.post('/settings/navidrome/test', async (req, res) => {
  try {
    const saved = await navidrome.getSettings() || {};
    const body = req.body || {};
    const candidate = body.url !== undefined;
    const url = candidate ? v.safeUrl(String(body.url || '')) : saved.url;
    const username = candidate ? v.safeText(String(body.username || ''), 120) : saved.username;
    let password = candidate && typeof body.password === 'string' && body.password ? body.password : null;
    if (!password && saved.password_encrypted) password = decrypt(saved.password_encrypted);

    if (!url || !/^https?:\/\//i.test(url)) {
      return res.json({ ok: true, data: { configured: false, connected: false, error: 'Bitte eine gültige http(s)-Adresse angeben.' } });
    }
    // Schritt 1 des Assistenten: nur pruefen, ob dort ein Subsonic-Server antwortet (ohne Zugangsdaten)
    if (candidate && body.probe === true) {
      const probe = await navidrome.probeServer(url);
      return res.json({ ok: true, data: { configured: false, connected: probe.ok, error: probe.ok ? undefined : probe.error } });
    }
    if (!username || !password) {
      return res.json({ ok: true, data: { configured: false, connected: false, error: 'Benutzername und Passwort werden benötigt.' } });
    }
    const result = await navidrome.testConnection({ url, username, password });
    if (!result.ok) return res.json({ ok: true, data: { configured: true, connected: false, error: result.error } });

    const data = { configured: true, connected: true, serverVersion: result.serverVersion, type: result.type };
    // Bei gespeicherten Werten zusaetzlich zeigen, ob gerade etwas laeuft
    if (!candidate && saved.enabled) {
      const track = await navidrome.getNowPlayingUncached();
      data.playing = !!(track && track.playing);
      data.title = track?.title || null;
      data.artist = track?.artist || null;
    }
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[admin navidrome/test]', err.message);
    res.json({ ok: true, data: { configured: false, connected: false, error: 'Prüfung fehlgeschlagen.' } });
  }
});

// Music Assistant pruefen: mit url/token im Body ohne zu speichern (leeres Token = gespeichertes),
// sonst die gespeicherten Werte inkl. aktueller Wiedergabe des gewaehlten Benutzers.
router.post('/settings/musicassistant/test', async (req, res) => {
  try {
    const ma = require('../lib/musicassistant');
    const saved = await ma.getSettings() || {};
    const body = req.body || {};
    const candidate = body.url !== undefined;
    const url = candidate ? v.safeUrl(String(body.url || '')) : saved.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.json({ ok: true, data: { connected: false, error: 'Bitte eine gültige http(s)-Adresse angeben.' } });
    }
    // Schritt 1 des Assistenten (probe): ohne Token pruefen – "Token noetig" heisst, der Server ist da
    const tokenEncrypted = candidate && body.probe === true
      ? null
      : (candidate && typeof body.token === 'string' && body.token ? encrypt(body.token) : (saved.token_encrypted || null));
    const result = await ma.testConnection({ url, token_encrypted: tokenEncrypted });
    if (!result.ok) return res.json({ ok: true, data: { connected: false, code: result.code || null, error: result.error } });

    const data = { connected: true, playerCount: result.playerCount };
    if (!candidate && saved.enabled && saved.user_id) {
      const track = await ma.getNowPlayingUncached();
      data.playing = !!(track && track.playing);
      data.title = track?.title || null;
      data.artist = track?.artist || null;
    }
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[admin musicassistant/test]', err.message);
    res.json({ ok: true, data: { connected: false, error: 'Prüfung fehlgeschlagen.' } });
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

const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

router.post('/import', async (req, res, next) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ ok: false, error: 'Ungueltiger Import' });
    }

    let protectionLost = 0;
    await db.transaction(async (client) => {
      if (data.profile && typeof data.profile === 'object') {
        const p = data.profile;
        await client.query(`
          INSERT INTO profile (id, name, handle, bio, avatar, avatar_url, theme, player_progress_style)
          VALUES (1, $1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            handle = EXCLUDED.handle,
            bio = EXCLUDED.bio,
            avatar = EXCLUDED.avatar,
            avatar_url = EXCLUDED.avatar_url,
            theme = EXCLUDED.theme,
            player_progress_style = EXCLUDED.player_progress_style,
            updated_at = NOW()
        `, [
          v.safeText(p.name, 80),
          v.safeText(p.handle, 80),
          v.safeText(p.bio, 280),
          v.safeText(p.avatar, 2).toUpperCase() || 'CA',
          v.validateAvatarUrl(p.avatar_url),
          v.validateTheme(p.theme),
          ['time', 'line'].includes(p.player_progress_style) ? p.player_progress_style : 'time',
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
          // Passwortschutz und Ablaufdatum aus dem Export uebernehmen. Ein Link, der im Export
          // geschuetzt war, dessen Hash aber fehlt oder ungueltig ist, wird deaktiviert statt
          // ungeschuetzt veroeffentlicht.
          const hadProtection = typeof l.password_hash === 'string' && l.password_hash !== '';
          const passwordHash = hadProtection && BCRYPT_HASH_RE.test(l.password_hash) ? l.password_hash : null;
          if (hadProtection && !passwordHash) protectionLost += 1;
          await client.query(`
            INSERT INTO links (
              title, subtitle, url, display_url, icon, position, is_active, open_new,
              meta_description, admin_note, slug, category_id,
              visible_from, visible_until, visible_weekdays, password_hash, expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
          `, [
            v.safeText(l.title, 80),
            v.safeText(l.subtitle, 120),
            url,
            v.safeText(l.display_url, 120),
            v.sanitizeIconField(l.icon),
            i,
            l.is_active !== false && !(hadProtection && !passwordHash),
            l.open_new !== false,
            v.safeText(l.meta_description, 280),
            v.safeText(l.admin_note, 280),
            v.safeSlug(l.slug),
            l.category_id || null,
            v.safeDate(l.visible_from),
            v.safeDate(l.visible_until),
            v.safeWeekdays(l.visible_weekdays),
            passwordHash,
            v.safeDate(l.expires_at),
          ]);
        }
      }
    });

    await audit.log(req, 'import', 'links', null, { imported: data.links?.length, categories: data.link_categories?.length, deactivated: protectionLost });
    res.json({ ok: true, data: { deactivated_unprotected: protectionLost } });
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
    const lookup = crypto.createHash('sha256').update(plain).digest('hex');
    const { rows } = await db.query('INSERT INTO api_keys (name, key_hash, key_lookup) VALUES ($1, $2, $3) RETURNING id, name, created_at', [name, hash, lookup]);
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

// Nur echte Backup-Dateien (Namensschema von lib/backup.js), keine Verzeichnisse oder Links
const BACKUP_NAME_RE = /^openweb-backup-[A-Za-z0-9._-]{1,80}\.json$/;

router.get('/backups/download/:name', async (req, res, next) => {
  try {
    const name = String(req.params.name || '');
    if (!BACKUP_NAME_RE.test(name) || name.includes('..')) {
      return res.status(404).json({ ok: false, error: 'Backup nicht gefunden' });
    }
    const file = path.join(backup.BACKUP_DIR, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch { stat = null; }
    if (!stat || !stat.isFile()) return res.status(404).json({ ok: false, error: 'Backup nicht gefunden' });
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Type', 'application/json');
    const stream = fs.createReadStream(file);
    // Lesefehler duerfen den Prozess nicht beenden
    stream.on('error', (err) => {
      if (!res.headersSent) return next(err);
      res.destroy(err);
    });
    stream.pipe(res);
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

    // Alle anderen Sessions dieses Users beenden (z. B. gestohlene Session nach Passwortwechsel)
    await db.query(
      `DELETE FROM user_sessions WHERE sid <> $1 AND (sess->>'userId' = $2 OR sess->>'pendingUserId' = $2)`,
      [req.sessionID, String(user.id)]
    ).catch((err) => console.warn('[change-password] Sessions konnten nicht beendet werden:', err.message));

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
      const { rows: webauthn } = await db.query('SELECT id, name, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at ASC', [req.session.userId]);
      res.json({ ok: true, data: { totp_enabled: rows[0]?.totp_enabled || false, webauthn_keys: webauthn } });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  router.put('/settings/2fa/webauthn/:id', async (req, res) => {
    try {
      const db = require('../lib/db');
      const { name } = req.body;
      const { id } = req.params;
      
      const safeName = require('../lib/validators').safeText(name, 100) || 'Security Key';
      
      const result = await db.query('UPDATE webauthn_credentials SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING id, name', [safeName, id, req.session.userId]);
      if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'Schluessel nicht gefunden' });
      
      res.json({ ok: true, data: result.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Sensible 2FA-Aenderungen erfordern das aktuelle Passwort (Schutz bei uebernommener Session)
  async function checkCurrentPassword(req) {
    const password = req.body?.password;
    if (!password || typeof password !== 'string') return false;
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1 AND is_active = true', [req.session.userId]);
    if (!rows[0]) return false;
    return verifyPassword(password, rows[0].password_hash);
  }

  router.post('/encryption-key/backup', async (req, res, next) => {
    try {
      if (!(await checkCurrentPassword(req))) {
        return res.status(401).json({ ok: false, error: 'Aktuelles Passwort falsch' });
      }
      if (typeof req.body.backupPassword === 'string' && req.body.backupPassword === req.body.password) {
        return res.status(400).json({ ok: false, error: 'Die Wiederherstellungs-Passphrase muss sich vom Admin-Passwort unterscheiden.' });
      }
      const encryptedBackup = await encryptionKeyBackup.createBackup(
        process.env.NAVIDROME_ENCRYPTION_KEY,
        req.body.backupPassword
      );
      await audit.log(req, 'encryption_key_backup', 'encryption_key');
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, data: { backup: encryptedBackup } });
    } catch (err) {
      if (err.message.startsWith('Ein Schluessel-Backup-Vorgang')) {
        return res.status(429).json({ ok: false, error: 'Ein Schlüssel-Backup läuft bereits. Bitte kurz warten.' });
      }
      if (err.message.startsWith('Das Wiederherstellungspasswort')) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      next(err);
    }
  });

  router.post('/encryption-key/restore', async (req, res, next) => {
    try {
      if (!(await checkCurrentPassword(req))) {
        return res.status(401).json({ ok: false, error: 'Aktuelles Passwort falsch' });
      }
      const keyHex = await encryptionKeyBackup.restoreBackup(req.body.backup, req.body.backupPassword);
      encryptionKeyBackup.writeKeyToEnvFile(keyHex);
      process.env.NAVIDROME_ENCRYPTION_KEY = keyHex;
      await audit.log(req, 'encryption_key_restore', 'encryption_key');
      res.json({ ok: true, data: { restartRequired: false } });
    } catch (err) {
      if (err.message.startsWith('Ein Schluessel-Backup-Vorgang')) {
        return res.status(429).json({ ok: false, error: 'Ein Schlüssel-Backup läuft bereits. Bitte kurz warten.' });
      }
      if (err.message.startsWith('Das Wiederherstellungspasswort') ||
          err.message.startsWith('Die Schluessel-Backup-Datei') ||
          err.message.startsWith('Backup konnte nicht entschluesselt werden')) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      next(err);
    }
  });

  router.post('/settings/2fa/totp/setup', async (req, res) => {
    try {
      if (!(await checkCurrentPassword(req))) {
        return res.status(401).json({ ok: false, error: 'Aktuelles Passwort falsch' });
      }
      const QRCode = require('qrcode');
      const totp = require('../lib/totp');
      const secret = totp.createSecret();

      const { rows } = await db.query('SELECT email, totp_enabled FROM users WHERE id = $1', [req.session.userId]);
      // Aktives TOTP nicht ersetzen lassen (sonst koennte eine uebernommene Session die
      // Passwortpflicht beim Deaktivieren umgehen) -> erst deaktivieren, dann neu einrichten
      if (rows[0]?.totp_enabled) {
        return res.status(409).json({ ok: false, error: 'TOTP ist bereits aktiv. Bitte zuerst deaktivieren.' });
      }
      const email = rows[0]?.email || 'admin@openweb';

      const otpauth = totp.buildOtpAuthUri(email, secret);
      const qrcodeUrl = await QRCode.toDataURL(otpauth);

      // Erst nach erfolgreicher Code-Pruefung in der DB speichern -> ein aktives Secret
      // wird nicht schon durch das blosse Starten der Einrichtung ueberschrieben
      req.session.pendingTotpSecret = secret;

      res.json({ ok: true, data: { secret, qrcode: qrcodeUrl } });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  router.post('/settings/2fa/totp/verify', async (req, res) => {
    try {
      const secret = req.session.pendingTotpSecret;
      if (!secret) {
        return res.status(400).json({ ok: false, error: 'TOTP nicht eingerichtet' });
      }

      const totp = require('../lib/totp');
      const result = await totp.verifyCode(req.body.code, secret);
      if (!result.valid) {
        return res.status(400).json({ ok: false, error: 'Ungueltiger Code' });
      }

      const { rowCount } = await db.query(
        'UPDATE users SET totp_secret = $1, totp_enabled = true, totp_last_timestep = $2 WHERE id = $3 AND totp_enabled IS NOT TRUE',
        [secret, result.timeStep, req.session.userId]
      );
      if (!rowCount) {
        return res.status(409).json({ ok: false, error: 'TOTP ist bereits aktiv. Bitte zuerst deaktivieren.' });
      }
      delete req.session.pendingTotpSecret;
      await audit.log(req, 'totp_enable', 'user', req.session.userId);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  router.post('/settings/2fa/totp/disable', async (req, res) => {
    try {
      if (!(await checkCurrentPassword(req))) {
        return res.status(401).json({ ok: false, error: 'Aktuelles Passwort falsch' });
      }
      await db.query('UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_last_timestep = NULL WHERE id = $1', [req.session.userId]);
      await audit.log(req, 'totp_disable', 'user', req.session.userId);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  router.post('/settings/2fa/webauthn/register-options', async (req, res) => {
    try {
      // Ein neuer Schluessel erlaubt passwortlosen Login -> nur mit aktuellem Passwort
      if (!(await checkCurrentPassword(req))) {
        return res.status(401).json({ ok: false, error: 'Aktuelles Passwort falsch' });
      }
      const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
      const user = rows[0];
      
      const { generateRegistrationOptions } = require('@simplewebauthn/server');
      const { rows: existing } = await db.query('SELECT credential_id FROM webauthn_credentials WHERE user_id = $1', [req.session.userId]);
      
      const options = await generateRegistrationOptions({
        rpName: 'OpenWeb',
        rpID: webauthnRp.getRelyingParty(req).rpID,
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
      
      // Challenge in der Session (nicht in users.webauthn_current_challenge): diese Spalte kann der
      // passwortlose Login-Ablauf ohne Anmeldung setzen und darf daher nicht fuer Registrierungen zaehlen
      req.session.webauthnRegChallenge = options.challenge;
      res.json({ ok: true, data: options });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  router.post('/settings/2fa/webauthn/register-verify', async (req, res) => {
    try {
      const expectedChallenge = req.session.webauthnRegChallenge;
      // Nur einmal verwendbar
      delete req.session.webauthnRegChallenge;
      if (!expectedChallenge) return res.status(400).json({ ok: false, error: 'Kein Challenge aktiv' });
      
      const { verifyRegistrationResponse } = require('@simplewebauthn/server');
      // RP-ID und Origin aus APP_URL (nicht aus Host-/X-Forwarded-Host-Headern)
      const rp = webauthnRp.getRelyingParty(req);

      const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpID,
      });
      
      if (verification.verified) {
        const { id, publicKey, counter } = verification.registrationInfo.credential;
        await db.query(
          'INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter) VALUES ($1, $2, $3, $4)',
          [req.session.userId, id, publicKey, counter]
        );
        await audit.log(req, 'webauthn_register', 'user', req.session.userId);
        res.json({ ok: true });
      } else {
        res.status(400).json({ ok: false, error: 'Registrierung fehlgeschlagen' });
      }
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  
  router.delete('/settings/2fa/webauthn/:id', async (req, res) => {
    try {
      if (!(await checkCurrentPassword(req))) {
        return res.status(401).json({ ok: false, error: 'Aktuelles Passwort falsch' });
      }
      await db.query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
      await audit.log(req, 'webauthn_delete', 'user', req.session.userId);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

module.exports = router;
