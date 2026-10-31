// =========================================================
// OAuth-Redirect-URIs (Spotify, Instagram)
// =========================================================
// Die Adresse kommt wie bei WebAuthn aus APP_URL (lib/webauthn-rp.js), nicht aus Request-Headern.
// getRedirectUriStatus() liefert dem Einrichtungsassistenten zusaetzlich, ob die Adresse aus der
// Konfiguration stammt und ob die Anbieter sie akzeptieren: https ist Pflicht, http nur fuer
// Loopback-IPs (127.0.0.1, [::1]), "localhost" lehnen Spotify und Meta ab.

const { getRelyingParty } = require('./webauthn-rp');

function getRedirectUri(req, path) {
  return getRelyingParty(req).origins[0].replace(/\/$/, '') + path;
}

function getRedirectUriStatus(req, path) {
  const uri = getRedirectUri(req, path);
  const configured = !!((process.env.APP_URL || '').trim() || (process.env.PUBLIC_DOMAIN || '').trim());
  let secure = false;
  let localhost = false;
  try {
    const u = new URL(uri);
    const loopback = ['127.0.0.1', '[::1]'].includes(u.hostname);
    localhost = u.hostname === 'localhost';
    secure = u.protocol === 'https:' || (u.protocol === 'http:' && loopback);
  } catch { /* ungueltig = nicht sicher */ }
  return { uri, configured, secure, localhost };
}

module.exports = { getRedirectUri, getRedirectUriStatus };
