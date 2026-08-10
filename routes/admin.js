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
    res.json({ ok: true, data: rows[0] || null });
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

    await db.query(`
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
    `, [name, handle, bio, avatar, avatarUrl, theme]);

    const { rows } = await db.query('SELECT * FROM profile WHERE id = 1 LIMIT 1');
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------- Links ----------
router.get('/links', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM links ORDER BY position ASC, created_at ASC');
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/links', async (req, res, next) => {
  try {
    const title = v.safeText(req.body.title, 80);
    const subtitle = v.safeText(req.body.subtitle, 120);
    const url = v.safeUrl(req.body.url);
    const icon = v.sanitizeIconField(req.body.icon);
    const isActive = req.body.is_active !== false;
    const openNew = req.body.open_new !== false;

    if (!title || !url) {
      return res.status(400).json({ ok: false, error: 'Titel und URL sind Pflicht' });
    }

    const countRes = await db.query('SELECT COUNT(*)::int AS count FROM links');
    const position = countRes.rows[0].count;

    const { rows } = await db.query(`
      INSERT INTO links (title, subtitle, url, icon, position, is_active, open_new)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [title, subtitle, url, icon, position, isActive, openNew]);

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
    const { rows } = await db.query('SELECT * FROM admin_settings WHERE id = 1 LIMIT 1');
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

    const { rows } = await db.query('SELECT * FROM admin_settings WHERE id = 1 LIMIT 1');
    res.json({ ok: true, data: rows[0] });
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

// ---------- Export / Import ----------
router.get('/export', async (req, res, next) => {
  try {
    const [profileRes, linksRes, settingsRes] = await Promise.all([
      db.query('SELECT * FROM profile WHERE id = 1 LIMIT 1'),
      db.query('SELECT * FROM links ORDER BY position ASC'),
      db.query('SELECT * FROM admin_settings WHERE id = 1 LIMIT 1'),
    ]);

    res.json({
      ok: true,
      data: {
        version: 2,
        exportedAt: new Date().toISOString(),
        profile: profileRes.rows[0] || null,
        links: linksRes.rows,
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

      if (Array.isArray(data.links)) {
        await client.query('DELETE FROM links');
        for (let i = 0; i < data.links.length; i++) {
          const l = data.links[i];
          const url = v.safeUrl(l.url);
          if (!url) continue;
          await client.query(`
            INSERT INTO links (title, subtitle, url, icon, position, is_active, open_new)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            v.safeText(l.title, 80),
            v.safeText(l.subtitle, 120),
            url,
            v.sanitizeIconField(l.icon),
            i,
            l.is_active !== false,
            l.open_new !== false,
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
