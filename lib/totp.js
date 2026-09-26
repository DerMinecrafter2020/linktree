// =========================================================
// TOTP-Helfer (otplib v13)
// =========================================================

const { generateSecret, generateURI, verify } = require('otplib');

const ISSUER = 'OpenWeb Admin';

function createSecret() {
  return generateSecret();
}

function buildOtpAuthUri(label, secret) {
  return generateURI({ issuer: ISSUER, label, secret });
}

// Prueft einen 6-stelligen Code (+/- 30 s Toleranz).
// lastTimeStep: zuletzt akzeptierter Zeitschritt -> bereits benutzte Codes werden abgelehnt (Replay-Schutz).
async function verifyCode(code, secret, lastTimeStep = null) {
  const token = String(code || '').replace(/\s+/g, '');
  if (!secret || !/^\d{6}$/.test(token)) return { valid: false };
  const options = { secret, token, epochTolerance: 30 };
  if (lastTimeStep !== null && lastTimeStep !== undefined) {
    options.afterTimeStep = Number(lastTimeStep);
  }
  try {
    const result = await verify(options);
    return result.valid ? { valid: true, timeStep: result.timeStep } : { valid: false };
  } catch {
    return { valid: false };
  }
}

module.exports = { createSecret, buildOtpAuthUri, verifyCode };
