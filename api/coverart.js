// =========================================================
// Navidrome API – Cover Art Endpoint
// =========================================================
// Lädt ein Cover-Art-Bild und speichert es als Data-URL.
//
// Aufruf:
//   node api/coverart.js <coverId> [size]
// =========================================================

require('dotenv').config();
const crypto = require('crypto');

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

async function getCoverArt(coverId, size = 220) {
  const url  = process.env.NAVIDROME_URL;
  const user = process.env.NAVIDROME_USER;
  const pass = process.env.NAVIDROME_PASS;
  if (!url || !user || !pass) throw new Error('env vars missing');

  const salt  = crypto.randomBytes(16).toString('hex');
  const token = md5(pass + salt);
  const params = new URLSearchParams({
    u: user, t: token, s: salt, v: '1.16.1', c: 'openweb-linktree', f: 'json',
    id: coverId, size: String(size),
  });

  const r = await fetch(`${url.replace(/\/$/, '')}/rest/getCoverArt?${params.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = r.headers.get('content-type') || 'image/jpeg';
  if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(ct)) {
    throw new Error('unsupported image format: ' + ct);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.byteLength > 600000) throw new Error('cover too large');
  return 'data:' + ct + ';base64,' + buf.toString('base64');
}

(async () => {
  const coverId = process.argv[2];
  const size = parseInt(process.argv[3] || '220', 10);
  if (!coverId) {
    console.log('Usage: node api/coverart.js <coverId> [size]');
    process.exit(1);
  }
  try {
    const dataUrl = await getCoverArt(coverId, size);
    console.log('OK: dataUrl length =', dataUrl.length);
    console.log('First 100 chars:', dataUrl.substring(0, 100) + '...');
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
})();
