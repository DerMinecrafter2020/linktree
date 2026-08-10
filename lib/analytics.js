// =========================================================
// OpenWeb — Klick-Analyse-Helfer (geräte- und geo-basiert)
// =========================================================

function parseUserAgent(ua) {
  const str = String(ua || '').toLowerCase();
  let browser = 'Other';
  if (str.includes('firefox/')) browser = 'Firefox';
  else if (str.includes('edg/')) browser = 'Edge';
  else if (str.includes('chrome/') || str.includes('crios/')) browser = 'Chrome';
  else if (str.includes('safari/') && !str.includes('chrome/') && !str.includes('crios/')) browser = 'Safari';
  else if (str.includes('opera/') || str.includes('opr/')) browser = 'Opera';

  let os = 'Other';
  if (str.includes('windows nt')) os = 'Windows';
  else if (str.includes('macintosh') || str.includes('mac os')) os = 'macOS';
  else if (str.includes('linux')) os = 'Linux';
  else if (str.includes('android')) os = 'Android';
  else if (str.includes('iphone') || str.includes('ipad') || str.includes('ipod')) os = 'iOS';

  let deviceType = 'desktop';
  if (str.includes('mobile')) deviceType = 'mobile';
  else if (str.includes('tablet') || str.includes('ipad')) deviceType = 'tablet';
  else if (str.includes('android') && !str.includes('mobile')) deviceType = 'tablet';

  return { browser, os, deviceType };
}

function parseCountryCode(req) {
  // Mögliche Header hinter einem Reverse Proxy
  const raw =
    req.headers['cf-ipcountry'] ||
    req.headers['x-country-code'] ||
    req.headers['geoip-country'] ||
    null;
  if (!raw) return null;
  const code = String(raw).toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

module.exports = {
  parseUserAgent,
  parseCountryCode,
};
