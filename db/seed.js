// =========================================================
// Seed-Script: Default-Daten anlegen
// =========================================================

require('dotenv').config();

const bcrypt = require('bcrypt');
const db = require('../lib/db');
const { encrypt } = require('../lib/crypto');

async function seed(overrides = {}) {
  const adminEmail = overrides.adminEmail || process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = overrides.adminPassword || process.env.ADMIN_PASSWORD;

  if (!adminPassword || String(adminPassword).length < 8) {
    throw new Error('ADMIN_PASSWORD muss mindestens 8 Zeichen lang sein.');
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  await db.query(`
    INSERT INTO users (email, password_hash, is_active)
    VALUES ($1, $2, true)
    ON CONFLICT (email) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      is_active = true,
      updated_at = NOW()
  `, [adminEmail.toLowerCase(), passwordHash]);
  console.log(`[seed] Admin-User: ${adminEmail}`);

  const profile = overrides.profile || {};
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
  `, [
    (profile.name || '@corneliusahner').slice(0, 80),
    (profile.handle || 'Cornelius Ahner').slice(0, 80),
    (profile.bio || 'Azubi, 21 Jahre alt').slice(0, 280),
    (profile.avatar || 'CA').toUpperCase().slice(0, 2) || 'CA',
    profile.avatarUrl || null,
    ['dark', 'neon', 'midnight'].includes(profile.theme) ? profile.theme : 'dark',
  ]);
  console.log('[seed] Profil angelegt');

  await db.query(`
    INSERT INTO admin_settings (id, admin_enabled, discord_webhook_enabled, discord_webhook_url, discord_webhook_template)
    VALUES (1, true, false, NULL, NULL)
    ON CONFLICT (id) DO NOTHING
  `);
  console.log('[seed] Admin-Settings angelegt');

  const seedLinks = overrides.links;
  const existingLinks = await db.query('SELECT COUNT(*)::int AS count FROM links');
  if (existingLinks.rows[0].count === 0) {
    const defaults = seedLinks && seedLinks.length > 0
      ? seedLinks.map((l, i) => ({ ...l, position: i }))
      : [
          { title: 'Instagram', subtitle: '@cornelius_0511', url: 'https://www.instagram.com/cornelius_0511/', icon: '📸', position: 0 },
          { title: 'GitHub', subtitle: 'Projekte auf Github', url: 'https://github.com/DerMinecrafter2020', icon: '💻', position: 1 },
          { title: 'Kontakt', subtitle: 'admin@derminecrafter2020.com', url: 'mailto:admin@derminecrafter2020.com', icon: '✉️', position: 2 },
        ];

    for (const link of defaults) {
      await db.query(`
        INSERT INTO links (title, subtitle, url, icon, position, is_active, open_new)
        VALUES ($1, $2, $3, $4, $5, true, true)
      `, [
        String(link.title || '').slice(0, 80),
        String(link.subtitle || '').slice(0, 120),
        String(link.url || '').slice(0, 500),
        String(link.icon || '🔗').slice(0, 500),
        parseInt(link.position || 0, 10),
      ]);
    }
    console.log('[seed] Default-Links angelegt');
  }

  const nav = overrides.navidrome || {};
  const navUrl = (nav.url || process.env.NAVIDROME_URL || '').trim();
  const navUser = (nav.username || process.env.NAVIDROME_USERNAME || '').trim();
  const navPass = (nav.password || process.env.NAVIDROME_PASSWORD || '').trim();
  const navEnabled = !!(navUrl && navUser && navPass);
  const pollInterval = parseInt(process.env.NAVIDROME_POLL_INTERVAL_SEC || '30', 10) || 30;

  let encryptedPass = null;
  if (navPass) {
    try {
      encryptedPass = encrypt(navPass);
    } catch (err) {
      console.warn('[seed] Konnte Navidrome-Passwort nicht verschluesseln:', err.message);
    }
  }

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
  `, [navEnabled, navUrl || null, navUser || null, encryptedPass, pollInterval]);
  console.log(`[seed] Navidrome-Settings: ${navEnabled ? 'aktiviert' : 'deaktiviert'}`);

  return { adminEmail };
}

module.exports = { seed };

// Direkter CLI-Aufruf
if (require.main === module) {
  seed().then(async () => {
    await db.pool.end();
    console.log('[seed] Fertig');
  }).catch((err) => {
    console.error('[seed] Fehler:', err);
    process.exit(1);
  });
}
