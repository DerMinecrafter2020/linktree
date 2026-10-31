// =========================================================
// WebAuthn Relying Party (RP-ID + erlaubte Origin)
// =========================================================
// RP-ID und Origin muessen aus der Konfiguration kommen, nicht aus Request-Headern: Host und
// X-Forwarded-Host koennen je nach Proxy-Aufbau vom Client gesetzt werden. Quelle ist APP_URL
// (alternativ PUBLIC_DOMAIN). Nur wenn beides fehlt (lokale Entwicklung), wird der Host-Header
// der Anfrage verwendet – X-Forwarded-Host wird dabei nie beruecksichtigt.

let warned = false;

function configuredOrigin() {
  const raw = (process.env.APP_URL || '').trim() || (process.env.PUBLIC_DOMAIN || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return { rpID: url.hostname, origin: url.origin };
  } catch {
    return null;
  }
}

function getRelyingParty(req) {
  const cfg = configuredOrigin();
  if (cfg) return { rpID: cfg.rpID, origins: [cfg.origin] };
  if (!warned) {
    warned = true;
    console.warn('[webauthn] APP_URL ist nicht gesetzt – RP-ID wird aus dem Host-Header abgeleitet. Fuer den Produktivbetrieb APP_URL setzen.');
  }
  const host = String(req.headers.host || '').trim();
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return { rpID: hostname, origins: [`${req.protocol}://${host}`] };
}

module.exports = { getRelyingParty };
