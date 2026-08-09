// =========================================================
// Seed-Script: Default-Daten anlegen
// =========================================================

require('dotenv').config();

const bcrypt = require('bcrypt');
const db = require('../lib/db');
const { encrypt } = require('../lib/crypto');

async function seed() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || adminPassword.startsWith('__SET_ME')) {
    console.error('[seed] ADMIN_PASSWORD ist nicht konfiguriert. Abbruch.');
    process.exit(1);
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

  await db.query(`
    INSERT INTO profile (id, name, handle, bio, avatar, avatar_url, theme)
    VALUES (1, '@corneliusahner', 'Cornelius Ahner', 'Azubi, 21 Jahre alt', 'CA', NULL, 'dark')
    ON CONFLICT (id) DO NOTHING
  `);
  console.log('[seed] Profil angelegt');

  await db.query(`
    INSERT INTO admin_settings (id, admin_enabled, discord_webhook_enabled, discord_webhook_url, discord_webhook_template)
    VALUES (1, true, false, NULL, NULL)
    ON CONFLICT (id) DO NOTHING
  `);
  console.log('[seed] Admin-Settings angelegt');

  const existingLinks = await db.query('SELECT COUNT(*)::int AS count FROM links');
  if (existingLinks.rows[0].count === 0) {
    const defaults = [
      { title: 'Instagram', subtitle: '@cornelius_0511', url: 'https://www.instagram.com/cornelius_0511/', icon: '📸', position: 0 },
      { title: 'GitHub', subtitle: 'Projekte auf Github', url: 'https://github.com/DerMinecrafter2020', icon: '💻', position: 1 },
      { title: 'Kontakt', subtitle: 'admin@derminecrafter2020.com', url: 'mailto:admin@derminecrafter2020.com', icon: '✉️', position: 2 },
    ];
    for (const link of defaults) {
      await db.query(`
        INSERT INTO links (title, subtitle, url, icon, position, is_active, open_new)
        VALUES ($1, $2, $3, $4, $5, true, true)
      `, [link.title, link.subtitle, link.url, link.icon, link.position]);
    }
    console.log('[seed] Default-Links angelegt');
  }

  const navUrl = process.env.NAVIDROME_URL ? process.env.NAVIDROME_URL.trim() : '';
  const navUser = process.env.NAVIDROME_USERNAME ? process.env.NAVIDROME_USERNAME.trim() : '';
  const navPass = process.env.NAVIDROME_PASSWORD ? process.env.NAVIDROME_PASSWORD.trim() : '';
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

  await db.pool.end();
  console.log('[seed] Fertig');
}

seed().catch((err) => {
  console.error('[seed] Fehler:', err);
  process.exit(1);
});
