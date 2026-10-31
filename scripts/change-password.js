#!/usr/bin/env node
// =========================================================
// Admin-Passwort auf der Kommandozeile aendern (aufgerufen von install.sh change-password)
// =========================================================
// Erwartet ADMIN_EMAIL und ADMIN_PASSWORD als Umgebungsvariablen.
// - E-Mail wird wie beim Login normalisiert (trim + Kleinschreibung)
// - schlaegt fehl, wenn kein Konto gefunden wurde (statt stillschweigend nichts zu tun)
// - beendet alle bestehenden Sessions des Kontos (auch halb angemeldete 2FA-Sessions)

require('../lib/paths').loadEnv();
const { hashPassword } = require('../lib/auth');
const db = require('../lib/db');

(async () => {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email) throw new Error('ADMIN_EMAIL fehlt.');
  if (password.length < 8) throw new Error('Passwort muss mindestens 8 Zeichen haben.');

  const hash = await hashPassword(password);
  const userId = await db.transaction(async (client) => {
    const { rows } = await client.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2 RETURNING id',
      [hash, email]
    );
    if (!rows.length) return null;
    await client.query(
      "DELETE FROM user_sessions WHERE sess->>'userId' = $1 OR sess->>'pendingUserId' = $1",
      [String(rows[0].id)]
    );
    return rows[0].id;
  });

  if (userId === null) {
    console.error(`Kein Admin-Konto mit der E-Mail ${email} gefunden – Passwort wurde NICHT geaendert.`);
    process.exit(1);
  }
  console.log(`Passwort geaendert fuer ${email}. Alle bestehenden Sitzungen wurden beendet.`);
  process.exit(0);
})().catch((err) => {
  console.error('Fehler:', err.message);
  process.exit(1);
});
