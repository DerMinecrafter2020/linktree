// =========================================================
// OpenWeb — Bot-Schutz (IP-Sperrliste + Browser-Pruefung bei Verdacht)
// ---------------------------------------------------------
// 1. Gesperrte IPs (UFW Manager, ausgewaehlte Adresslisten, eigene Liste) -> 403 vor allem anderen.
// 2. Verdaechtige Seitenaufrufe (Bot-User-Agent, fehlende Browser-Header, zu viele Aufrufe,
//    oder "alle pruefen") -> Pruefseite mit Proof-of-Work (public/js/botguard.js) statt Seite.
//    Geloest -> signiertes Freigabe-Cookie (an den User-Agent gebunden) fuer N Tage.
// Nie geprueft/gesperrt: interne Adressen (LAN, NetBird/Tailscale, Proxys), Freigabeliste,
// Link-Vorschauen, Suchmaschinen und Monitoring (nur Seitenpruefung; Sperrliste gilt trotzdem).
// Einstellungen: Tabelle botguard_settings (Admin > Einstellungen > Sicherheit).
// =========================================================

const crypto = require('crypto');
// DB erst bei Bedarf laden (server.js bindet die Middleware schon vor dem Setup-Check ein)
const db = { query: (...args) => require('./db').query(...args) };
const iprange = require('./iprange');
const i18n = require('./i18n');
const { encrypt, decrypt } = require('./crypto');

const COOKIE = 'ow_bg';
const VERIFY_PATH = '/__botguard/verify';
const CHALLENGE_MAX_AGE_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_TRACKED_IPS = 50000;
const UFW_MAX_BYTES = 10 * 1024 * 1024;
const UFW_MAX_ENTRIES = 200000;
const DIFFICULTY = { low: 14, medium: 17, high: 20 };

// Erlaubte Bots (nur Seitenpruefung entfaellt; Sperrliste und Rate-Limits gelten weiter)
const GOOD_BOTS = /discordbot|twitterbot|facebookexternalhit|facebookcatalog|meta-externalagent|whatsapp|telegrambot|slackbot|linkedinbot|skypeuripreview|mastodon|pleroma|misskey|bluesky|cardyb|signal|matrix|synapse|element|redditbot|embedly|iframely|pinterest|vkshare|googlebot|google-inspectiontool|googleother|storebot-google|adsbot-google|bingbot|bingpreview|duckduckbot|duckassistbot|applebot|yandexbot|baiduspider|qwantbot|ecosia|seznambot|petalbot|uptime-?kuma|uptimerobot|betteruptime|better stack|statuscake|pingdom|site24x7|hetrixtools|freshping|updown\.io|gatus|healthchecks|checkly|homarr|nagios|check_http|zabbix|prometheus|blackbox-exporter/i;
// Typische Automatisierung / Scanner
const BAD_AGENTS = /curl|wget|python|aiohttp|httpx|go-http-client|java\/|okhttp|libwww|lwp::|perl|ruby|php\/|guzzle|node-fetch|axios|undici|got \(|scrapy|headless|phantomjs|selenium|webdriver|puppeteer|playwright|httpclient|apache-http|mechanize|winhttp|powershell|zgrab|masscan|nmap|nikto|sqlmap|nuclei|dirbuster|gobuster|ffuf|wpscan|semrush|ahrefs|mj12bot|dotbot|bytespider|gptbot|ccbot|claudebot|anthropic-ai|amazonbot|dataforseo|petalsearch|zoominfo|\bbot\b|crawl|spider|scraper/i;

const DEFAULTS = {
  enabled: true,
  challenge_enabled: true,
  mode: 'suspicious', // 'suspicious' | 'all'
  difficulty: 'medium',
  clearance_days: 7,
  rate_per_min: 30,
  allowlist: '',
  manual_blocklist: '',
  ufw_enabled: false,
  ufw_url: '',
  ufw_token_encrypted: null,
  ufw_lists: '',
  ufw_interval_min: 5,
  ufw_last_sync_at: null,
  ufw_last_ok: null,
  ufw_last_message: null,
  ufw_entries: '[]',
  ufw_count: 0,
};

let settings = null; // null = noch nicht geladen -> Middleware laesst alles durch
let blockSet = iprange.buildSet([]);
let allowSet = iprange.buildSet([]);
let versionAssets = (html) => html;
let ufwTimer = null;
let syncing = null;

// ---------- Statistik (nur im Speicher) ----------
const stats = { since: Date.now(), blocked: 0, challenged: 0, solved: 0, failed: 0, events: [] };
function logEvent(type, ip, detail) {
  stats.events.unshift({ t: Date.now(), type, ip: String(ip || '').slice(0, 64), detail: String(detail || '').slice(0, 120) });
  if (stats.events.length > 50) stats.events.length = 50;
}

// ---------- Hilfen ----------
function secret() {
  return crypto.createHash('sha256').update(`openweb-botguard:${process.env.SESSION_SECRET || ''}`).digest();
}
function hmac(data) {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function uaHash(req) {
  return crypto.createHash('sha256').update(String(req.get('user-agent') || '')).digest('base64url').slice(0, 16);
}
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Einstellungen ----------
function rebuildSets() {
  let ufw = [];
  try { ufw = JSON.parse(settings.ufw_entries || '[]'); } catch { ufw = []; }
  const entries = [...iprange.splitList(settings.manual_blocklist), ...(settings.ufw_enabled ? ufw : [])];
  blockSet = iprange.buildSet(entries);
  allowSet = iprange.buildSet(iprange.splitList(settings.allowlist));
}

async function load() {
  const { rows } = await db.query('SELECT * FROM botguard_settings WHERE id = 1 LIMIT 1');
  settings = { ...DEFAULTS, ...(rows[0] || {}) };
  rebuildSets();
  scheduleUfw();
  return settings;
}

function publicView() {
  const s = settings || DEFAULTS;
  return {
    enabled: s.enabled,
    challenge_enabled: s.challenge_enabled,
    mode: s.mode,
    difficulty: s.difficulty,
    clearance_days: s.clearance_days,
    rate_per_min: s.rate_per_min,
    allowlist: s.allowlist || '',
    manual_blocklist: s.manual_blocklist || '',
    ufw_enabled: s.ufw_enabled,
    ufw_url: s.ufw_url || '',
    has_ufw_token: Boolean(s.ufw_token_encrypted),
    ufw_lists: s.ufw_lists || '',
    ufw_interval_min: s.ufw_interval_min,
    ufw_last_sync_at: s.ufw_last_sync_at,
    ufw_last_ok: s.ufw_last_ok,
    ufw_last_message: s.ufw_last_message,
    ufw_count: s.ufw_count || 0,
    blocked_networks: blockSet.size,
    stats: {
      since: new Date(stats.since).toISOString(),
      blocked: stats.blocked,
      challenged: stats.challenged,
      solved: stats.solved,
      failed: stats.failed,
      events: stats.events.slice(0, 20).map((e) => ({ ...e, t: new Date(e.t).toISOString() })),
    },
  };
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  err.expose = true;
  return err;
}

function cleanList(text, label) {
  const entries = iprange.splitList(text);
  if (entries.length > 5000) throw badRequest(`${label}: höchstens 5000 Einträge.`);
  const bad = entries.filter((e) => !iprange.parseEntry(e));
  if (bad.length) throw badRequest(`${label}: ungültige Einträge (${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ' …' : ''}). Erlaubt sind IPv4/IPv6-Adressen und Netze wie 203.0.113.0/24.`);
  return entries.join('\n');
}

async function saveSettings(input) {
  const s = settings || await load();
  const next = {
    enabled: input.enabled !== false,
    challenge_enabled: input.challenge_enabled !== false,
    mode: input.mode === 'all' ? 'all' : 'suspicious',
    difficulty: Object.hasOwn(DIFFICULTY, input.difficulty) ? input.difficulty : 'medium',
    clearance_days: Math.min(90, Math.max(1, parseInt(input.clearance_days, 10) || 7)),
    rate_per_min: Math.min(1000, Math.max(5, parseInt(input.rate_per_min, 10) || 30)),
    allowlist: cleanList(input.allowlist, 'Freigabeliste'),
    manual_blocklist: cleanList(input.manual_blocklist, 'Eigene Sperrliste'),
    ufw_enabled: input.ufw_enabled === true,
    ufw_url: '',
    ufw_lists: String(input.ufw_lists || '').split(/[\s,;]+/).map((x) => x.trim().replace(/^@/, '')).filter((x) => /^[\w.-]{1,64}$/.test(x)).slice(0, 20).join(', '),
    ufw_interval_min: Math.min(1440, Math.max(1, parseInt(input.ufw_interval_min, 10) || 5)),
  };
  if (input.ufw_url) {
    let u;
    try { u = new URL(String(input.ufw_url).trim()); } catch { throw badRequest('Die Adresse des UFW Managers ist ungültig.'); }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw badRequest('Die Adresse des UFW Managers muss mit http:// oder https:// beginnen (ohne Zugangsdaten in der Adresse).');
    next.ufw_url = u.origin + u.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  }
  let tokenEnc = s.ufw_token_encrypted;
  if (typeof input.ufw_token === 'string' && input.ufw_token.trim()) {
    const tok = input.ufw_token.trim();
    if (!/^ufwm_api_[A-Za-z0-9_-]{8,200}$/.test(tok)) throw badRequest('Der API-Token sieht nicht wie ein UFW-Manager-Token aus (beginnt mit „ufwm_api_“).');
    tokenEnc = encrypt(tok);
  }
  if (input.ufw_token === null) tokenEnc = null;
  if (next.ufw_enabled && (!next.ufw_url || !tokenEnc)) throw badRequest('Für den Abgleich mit dem UFW Manager werden Adresse und API-Token benötigt.');
  const urlChanged = next.ufw_url !== (s.ufw_url || '');

  await db.query(
    `INSERT INTO botguard_settings (id, enabled, challenge_enabled, mode, difficulty, clearance_days, rate_per_min,
       allowlist, manual_blocklist, ufw_enabled, ufw_url, ufw_token_encrypted, ufw_lists, ufw_interval_min, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, challenge_enabled = EXCLUDED.challenge_enabled,
       mode = EXCLUDED.mode, difficulty = EXCLUDED.difficulty, clearance_days = EXCLUDED.clearance_days,
       rate_per_min = EXCLUDED.rate_per_min, allowlist = EXCLUDED.allowlist, manual_blocklist = EXCLUDED.manual_blocklist,
       ufw_enabled = EXCLUDED.ufw_enabled, ufw_url = EXCLUDED.ufw_url, ufw_token_encrypted = EXCLUDED.ufw_token_encrypted,
       ufw_lists = EXCLUDED.ufw_lists, ufw_interval_min = EXCLUDED.ufw_interval_min, updated_at = NOW()`,
    [next.enabled, next.challenge_enabled, next.mode, next.difficulty, next.clearance_days, next.rate_per_min,
      next.allowlist, next.manual_blocklist, next.ufw_enabled, next.ufw_url || null, tokenEnc, next.ufw_lists || null, next.ufw_interval_min]
  );
  // Andere Quelle -> alte Liste nicht weiterverwenden
  if (urlChanged || !next.ufw_enabled) {
    await db.query("UPDATE botguard_settings SET ufw_entries = '[]', ufw_count = 0 WHERE id = 1");
  }
  await load();
  return publicView();
}

// ---------- UFW Manager ----------
async function fetchJson(url, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: ctrl.signal, redirect: 'error' });
    if (res.status === 401) throw new Error('Der UFW Manager lehnt den API-Token ab (401).');
    if (res.status === 403) throw new Error('Dem API-Token fehlt das Leserecht (UFW Manager: „Blocked addresses“ bzw. „Address lists“).');
    if (!res.ok) throw new Error(`Der UFW Manager antwortet mit HTTP ${res.status}.`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > UFW_MAX_BYTES) throw new Error('Antwort des UFW Managers ist zu groß.');
    const text = await res.text();
    if (text.length > UFW_MAX_BYTES) throw new Error('Antwort des UFW Managers ist zu groß.');
    try { return JSON.parse(text); } catch { throw new Error('Der UFW Manager hat keine gültige JSON-Antwort geliefert – stimmt die Adresse?'); }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Der UFW Manager antwortet nicht (Zeitüberschreitung).');
    if (err.cause?.code) throw new Error(`UFW Manager nicht erreichbar (${err.cause.code}).`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Sperrliste vom UFW Manager holen; bei Fehler bleibt die letzte Liste aktiv. */
async function syncUfw() {
  if (syncing) return syncing;
  syncing = (async () => {
    const s = settings || await load();
    if (!s.ufw_url || !s.ufw_token_encrypted) return { ok: false, message: 'UFW Manager ist nicht eingerichtet.' };
    let ok = false;
    let message;
    let entries = null;
    try {
      const token = decrypt(s.ufw_token_encrypted);
      const base = s.ufw_url.replace(/\/+$/, '');
      const blocked = await fetchJson(`${base}/api/v1/blocked`, token);
      if (!Array.isArray(blocked?.blocked)) throw new Error('Unerwartete Antwort von /api/v1/blocked.');
      const set = new Set();
      let automatic = 0;
      for (const b of blocked.blocked) {
        if (b && typeof b.address === 'string' && iprange.parseEntry(b.address)) {
          set.add(b.address.trim());
          if (b.automatic) automatic += 1;
        }
      }
      const wanted = String(s.ufw_lists || '').split(/[\s,;]+/).filter(Boolean).map((n) => n.toLowerCase());
      let fromLists = 0;
      if (wanted.length) {
        const lists = await fetchJson(`${base}/api/v1/lists`, token);
        if (!Array.isArray(lists?.lists)) throw new Error('Unerwartete Antwort von /api/v1/lists.');
        const missing = new Set(wanted);
        for (const l of lists.lists) {
          if (!l || !wanted.includes(String(l.name || '').toLowerCase())) continue;
          missing.delete(String(l.name).toLowerCase());
          for (const a of l.addresses || []) {
            if (typeof a === 'string' && iprange.parseEntry(a)) { set.add(a.trim()); fromLists += 1; }
          }
        }
        if (missing.size) throw new Error(`Adressliste(n) im UFW Manager nicht gefunden: ${[...missing].join(', ')}`);
      }
      entries = [...set].slice(0, UFW_MAX_ENTRIES);
      ok = true;
      message = `${entries.length} Einträge übernommen (${blocked.blocked.length} gesperrte Adressen, davon ${automatic} automatisch gesperrt${wanted.length ? `; ${fromLists} aus Adresslisten` : ''}).`;
    } catch (err) {
      message = String(err.message || err).slice(0, 300);
    }
    if (ok) {
      await db.query(
        'UPDATE botguard_settings SET ufw_entries = $1, ufw_count = $2, ufw_last_sync_at = NOW(), ufw_last_ok = true, ufw_last_message = $3 WHERE id = 1',
        [JSON.stringify(entries), entries.length, message]
      );
    } else {
      await db.query('UPDATE botguard_settings SET ufw_last_sync_at = NOW(), ufw_last_ok = false, ufw_last_message = $1 WHERE id = 1', [message]);
      console.warn('[botguard] UFW-Abgleich fehlgeschlagen:', message);
    }
    const { rows } = await db.query('SELECT * FROM botguard_settings WHERE id = 1 LIMIT 1');
    settings = { ...DEFAULTS, ...(rows[0] || {}) };
    rebuildSets();
    return { ok, message, count: ok ? entries.length : settings.ufw_count };
  })();
  try { return await syncing; } finally { syncing = null; }
}

function scheduleUfw() {
  if (ufwTimer) { clearInterval(ufwTimer); ufwTimer = null; }
  if (!settings?.ufw_enabled || !settings.ufw_url || !settings.ufw_token_encrypted) return;
  const every = Math.max(1, Number(settings.ufw_interval_min) || 5) * 60 * 1000;
  ufwTimer = setInterval(() => { syncUfw().catch(() => {}); }, every);
  ufwTimer.unref?.();
  // Beim Start bzw. nach dem Speichern sofort abgleichen, wenn die letzte Liste alt ist
  const last = settings.ufw_last_sync_at ? new Date(settings.ufw_last_sync_at).getTime() : 0;
  if (Date.now() - last > every) setTimeout(() => syncUfw().catch(() => {}), 2000).unref?.();
}

// ---------- Rate je IP (Seitenaufrufe) ----------
const pageHits = new Map();
function countPageHit(ipKey, now = Date.now()) {
  let r = pageHits.get(ipKey);
  if (!r || now - r.start > RATE_WINDOW_MS) {
    if (!r && pageHits.size >= MAX_TRACKED_IPS) pageHits.delete(pageHits.keys().next().value);
    r = { start: now, count: 0 };
    pageHits.set(ipKey, r);
  }
  r.count += 1;
  return r.count;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of pageHits) if (now - r.start > RATE_WINDOW_MS) pageHits.delete(k);
}, RATE_WINDOW_MS).unref?.();

// ---------- Freigabe-Cookie ----------
function issueClearance(req, days) {
  const exp = Date.now() + days * 86400000;
  const payload = `${exp}.${uaHash(req)}`;
  return `${payload}.${hmac(`clear:${payload}`)}`;
}
function hasClearance(req) {
  const raw = readCookie(req, COOKIE);
  if (!raw || raw.length > 200) return false;
  const parts = raw.split('.');
  if (parts.length !== 3) return false;
  const [exp, ua, sig] = parts;
  if (!safeEqual(sig, hmac(`clear:${exp}.${ua}`))) return false;
  if (!(Number(exp) > Date.now())) return false;
  return safeEqual(ua, uaHash(req));
}

// ---------- Proof-of-Work ----------
const usedChallenges = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of usedChallenges) if (now > exp) usedChallenges.delete(k);
}, 5 * 60 * 1000).unref?.();

function issueChallenge(bits) {
  const payload = `${Date.now()}.${crypto.randomBytes(12).toString('base64url')}.${bits}`;
  return `${payload}.${hmac(`pow:${payload}`)}`;
}
function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue; }
    n += Math.clz32(byte) - 24;
    break;
  }
  return n;
}
/** Prueft eine Loesung. Rueckgabe: 'ok' | 'invalid' | 'expired' | 'used' | 'wrong' */
function checkSolution(challenge, solution, now = Date.now()) {
  if (typeof challenge !== 'string' || challenge.length > 200) return 'invalid';
  const parts = challenge.split('.');
  if (parts.length !== 4) return 'invalid';
  const [ts, nonce, bits, sig] = parts;
  if (!safeEqual(sig, hmac(`pow:${ts}.${nonce}.${bits}`))) return 'invalid';
  if (now - Number(ts) > CHALLENGE_MAX_AGE_MS || now < Number(ts) - 5000) return 'expired';
  if (usedChallenges.has(challenge)) return 'used';
  if (!/^\d{1,12}$/.test(String(solution))) return 'wrong';
  const hash = crypto.createHash('sha256').update(`${challenge}:${solution}`).digest();
  if (leadingZeroBits(hash) < Number(bits)) return 'wrong';
  usedChallenges.set(challenge, Number(ts) + CHALLENGE_MAX_AGE_MS);
  return 'ok';
}

// ---------- Entscheidungen ----------
function isNavigation(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = req.path;
  if (p.startsWith('/api/') || p === '/api' || p.startsWith('/admin') || p === '/login' || p.startsWith('/__botguard')) return false;
  // Nur Seiten (ohne Dateiendung oder .html), keine Assets/Bilder/Feeds
  const last = p.split('/').pop() || '';
  return !last.includes('.') || last.endsWith('.html');
}

/** Grund fuer die Pruefung oder '' (fuer Tests exportiert). */
function suspicionReason(req, s, hits) {
  const ua = String(req.get('user-agent') || '');
  if (s.mode === 'all') return 'all';
  if (BAD_AGENTS.test(ua)) return 'bot-ua';
  if (ua.length < 10) return 'no-ua';
  if (/^Mozilla\//.test(ua)) {
    if (!req.get('accept-language')) return 'no-accept-language';
    const accept = String(req.get('accept') || '');
    if (accept && !/text\/html|\*\/\*/.test(accept)) return 'odd-accept';
    if (/Chrome\/\d/.test(ua) && !/Edg\/|OPR\//.test(ua) && !req.get('sec-fetch-mode')) return 'no-fetch-metadata';
  } else {
    return 'non-browser-ua';
  }
  if (hits > s.rate_per_min) return 'rate';
  return '';
}

// Texte in der Sprache des Besuchers (lib/i18n.js: Cookie ow_lang bzw. Accept-Language)
function deniedPage(id, lang = 'de') {
  const t = (key) => escapeHtml(i18n.msg(lang, key));
  return `<!DOCTYPE html><html lang="${lang === 'en' ? 'en' : 'de'}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${t('botguard.denied')}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f0d13;color:#e6e0e9;font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px}main{max-width:460px;text-align:center}h1{font-size:24px;margin:0 0 8px}p{color:#cac4d0;margin:0 0 8px}code{font-size:12px;color:#938f99}</style></head>
<body><main><h1>${t('botguard.denied')}</h1><p>${t('botguard.deniedText')}</p><p>${t('botguard.deniedHelp')}</p><code>${escapeHtml(id)}</code></main></body></html>`;
}

function challengePage({ challenge, bits, returnTo, lang = 'de' }) {
  const t = (key) => escapeHtml(i18n.msg(lang, key));
  const html = `<!DOCTYPE html>
<html lang="${lang === 'en' ? 'en' : 'de'}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${t('botguard.title')}</title>
  <link rel="stylesheet" href="/fonts.css" />
  <link rel="stylesheet" href="/styles.css" />
  <link rel="stylesheet" href="/css/themes.css" />
  <script src="/js/theme-init.js"></script>
</head>
<body class="botguard-page">
  <div class="aurora" aria-hidden="true"><span class="blob blob-1"></span><span class="blob blob-2"></span><span class="blob blob-3"></span></div>
  <main class="card botguard-card" id="botguard" data-challenge="${escapeHtml(challenge)}" data-bits="${Number(bits)}" data-return="${escapeHtml(returnTo)}"
    data-msg-done="${t('botguard.done')}" data-msg-failed="${t('botguard.failed')}" data-msg-offline="${t('botguard.offline')}" data-msg-old="${t('botguard.oldBrowser')}">
    <div class="botguard-spinner" aria-hidden="true"></div>
    <h1 class="botguard-title">${t('botguard.title')}</h1>
    <p class="botguard-text" id="botguard-status" role="status" aria-live="polite">${t('botguard.text')}</p>
    <div class="botguard-bar" aria-hidden="true"><span id="botguard-progress"></span></div>
    <noscript><p class="botguard-text">${t('botguard.noscript')}</p></noscript>
    <p class="botguard-foot">${t('botguard.foot')}</p>
  </main>
  <script src="/js/botguard.js"></script>
</body>
</html>`;
  return versionAssets(html);
}

function safeReturn(p) {
  const s = String(p || '/');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') && s.length < 2000 ? s : '/';
}

// Kleiner JSON-Parser nur fuer die Pruef-Antwort (Body-Parser laeuft erst spaeter)
function readSmallJson(req, max = 2048) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

async function handleVerify(req, res) {
  const body = await readSmallJson(req);
  const ip = clientIp(req);
  const s = settings || DEFAULTS;
  const result = body ? checkSolution(body.challenge, body.solution) : 'invalid';
  res.setHeader('Cache-Control', 'no-store');
  if (result !== 'ok') {
    stats.failed += 1;
    logEvent('failed', ip, result);
    return res.status(result === 'expired' ? 409 : 403).json({ ok: false, error: i18n.t(req, result === 'expired' ? 'botguard.expired' : 'botguard.invalid') });
  }
  stats.solved += 1;
  logEvent('solved', ip, '');
  const secure = process.env.NODE_ENV === 'production'; // TLS endet am Proxy (wie beim Session-Cookie)
  const days = Number(s.clearance_days) || 7;
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(issueClearance(req, days))}; Path=/; Max-Age=${days * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  return res.json({ ok: true, data: { redirect: safeReturn(body.return) } });
}

/** Express-Middleware (frueh einbinden, vor Static/Routen). */
function middleware(req, res, next) {
  const s = settings;
  if (!s || !s.enabled) return next();
  if (req.path === '/health') return next();
  const ipRaw = clientIp(req);
  const ip = iprange.parseIp(ipRaw);
  const internal = !ip || iprange.isInternal(ip);
  const allowed = !internal && allowSet.has(ip);

  // 1) Sperrliste
  if (!internal && !allowed && blockSet.has(ip)) {
    stats.blocked += 1;
    const id = crypto.randomBytes(6).toString('hex');
    logEvent('blocked', ipRaw, `Kennung ${id} · ${req.path}`);
    res.setHeader('Cache-Control', 'no-store');
    if (req.path.startsWith('/api/') || /application\/json/.test(String(req.get('accept') || ''))) {
      return res.status(403).json({ ok: false, error: i18n.t(req, 'botguard.denied'), id });
    }
    return res.status(403).type('html').send(deniedPage(id, i18n.pickLang(req)));
  }

  // 2) Pruefung beantworten
  if (req.path === VERIFY_PATH) {
    if (req.method !== 'POST') return res.status(405).end();
    return handleVerify(req, res).catch(next);
  }

  // 3) Pruefung bei Verdacht (nur Seitenaufrufe)
  if (!s.challenge_enabled || internal || allowed || !isNavigation(req)) return next();
  const ua = String(req.get('user-agent') || '');
  const hits = countPageHit(ipRaw);
  if (GOOD_BOTS.test(ua)) {
    // Auch "gute" Bots duerfen nicht fluten (User-Agent ist faelschbar)
    if (hits > s.rate_per_min * 4) {
      res.setHeader('Retry-After', '60');
      return res.status(429).end();
    }
    return next();
  }
  if (hasClearance(req)) return next();
  const reason = suspicionReason(req, s, hits);
  if (!reason) return next();

  stats.challenged += 1;
  logEvent('challenged', ipRaw, reason);
  const bits = DIFFICULTY[s.difficulty] || DIFFICULTY.medium;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.status(403).type('html').send(challengePage({ challenge: issueChallenge(bits), bits, returnTo: safeReturn(req.originalUrl), lang: i18n.pickLang(req) }));
}

async function init(options = {}) {
  if (options.versionAssets) versionAssets = options.versionAssets;
  try {
    await load();
  } catch (err) {
    console.warn('[botguard] Einstellungen konnten nicht geladen werden – Bot-Schutz inaktiv:', err.message);
  }
}

module.exports = {
  init, middleware, load, saveSettings, syncUfw, publicView,
  _internal: { suspicionReason, checkSolution, issueChallenge, leadingZeroBits, hasClearance, issueClearance, isNavigation, GOOD_BOTS, BAD_AGENTS, DIFFICULTY, COOKIE, VERIFY_PATH, stats, setSettings: (s) => { settings = { ...DEFAULTS, ...s }; rebuildSets(); } },
};
