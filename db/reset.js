// =========================================================
// DB-Reset: Alle Daten loeschen und neu seeden (Vorsicht!)
// =========================================================

require('dotenv').config();

const readline = require('readline');
const db = require('../lib/db');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function reset() {
  const answer = await ask('WARNUNG: Alle Links, Profil- und Navidrome-Einstellungen werden geloescht. Fortfahren? (j/N): ');
  if (!/^j$/i.test(answer.trim())) {
    console.log('[reset] Abbruch.');
    rl.close();
    await db.pool.end();
    process.exit(0);
  }

  await db.query('DELETE FROM links');
  await db.query('DELETE FROM profile WHERE id = 1');
  await db.query('DELETE FROM admin_settings WHERE id = 1');
  await db.query('DELETE FROM navidrome_settings WHERE id = 1');
  // Benutzer NICHT loeschen, damit Login weiterhin moeglich ist
  console.log('[reset] Daten geloescht. Starte Seed...');

  const seed = require('./seed');
  // seed.js beendet den Pool selbst, daher nicht hier nochmal end() aufrufen
}

reset().catch((err) => {
  console.error('[reset] Fehler:', err);
  process.exit(1);
}).finally(() => {
  rl.close();
});
