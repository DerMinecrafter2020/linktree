// =========================================================
// Navidrome API – Status Endpoint
// =========================================================
// Testet ob die Credentials funktionieren und gibt Config-Info aus.
//
// Aufruf:
//   node api/status.js
// =========================================================

require('dotenv').config();
const crypto = require('crypto');

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

async function checkStatus() {
  const url  = process.env.NAVIDROME_URL;
  const user = process.env.NAVIDROME_USER;
  const pass = process.env.NAVIDROME_PASS;
  if (!url || !user || !pass) {
    return { ok: false, error: 'env vars missing' };
  }

  const salt  = crypto.randomBytes(16).toString('hex');
  const token = md5(pass + salt);
  const params = new URLSearchParams({
    u: user, t: token, s: salt, v: '1.16.1', c: 'openweb-linktree', f: 'json'
  });

  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/ping?${params.toString()}`);
    const j = await r.json();
    return {
      ok: j?.['subsonic-response']?.status === 'ok',
      url,
      user,
      serverVersion: j?.['subsonic-response']?.serverVersion,
      type: j?.['subsonic-response']?.type,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

(async () => {
  const status = await checkStatus();
  console.log(JSON.stringify(status, null, 2));
})();
