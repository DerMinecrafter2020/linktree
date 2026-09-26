// =========================================================
// OpenWeb — Einheitliche Link-Icons ueber Dashboard Icons
// =========================================================
// Quelle: https://github.com/homarr-labs/dashboard-icons (ueber /api/icon/dashboardicon geproxyt)
//
// Jeder Link bekommt beim Ausliefern ein aufgeloestes Icon (icon_resolved). Die gespeicherten
// Werte (Emoji, simpleicon:…, dashboardicon:…, Bild-URL) bleiben unveraendert:
//   { type: 'dashboard', name, format }  -> Logo aus Dashboard Icons
//   { type: 'image', url }               -> eigene Bild-URL des Admins
//   { type: 'generic', name }            -> allgemeines Material-Symbol (link, mail, phone)

const TREE_URL = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/tree.json';
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

let svgNames = new Set();
let pngNames = new Set();
let compactIndex = new Map(); // "applemusic" -> "apple-music"
let loadedAt = 0;
let loadingPromise = null;

// Feste Zuordnungen, wo Name/Alias nicht automatisch passt
const ALIASES = {
  yt: 'youtube', insta: 'instagram', ig: 'instagram', fb: 'facebook', gh: 'github',
  wa: 'whatsapp', tg: 'telegram', bsky: 'bluesky', hbo: 'max',
  nintendo: 'nintendo-switch', riotgames: 'riot', kofi: 'ko-fi', medium: 'medium-dark',
  gmail: 'gmail', mail: null,
};

// Logos mit farbigem Motiv auf dunkler Kachel (z. B. Plex): Der Weiss-Filter wuerde daraus
// eine volle weisse Flaeche machen. Im weissen Stil wird dann diese Variante verwendet.
const WHITE_STYLE_VARIANTS = {
  plex: 'plex-light',
};

// Hostnamen-Teile, die nie ein Logo bezeichnen
const IGNORED_LABELS = new Set(['www', 'm', 'app', 'web', 'api', 'com', 'de', 'net', 'org', 'io', 'co', 'uk', 'at', 'ch', 'eu', 'me', 'tv', 'gg', 'dev', 'info']);

function buildIndex(tree) {
  const strip = (file) => file.replace(/\.[a-z0-9]+$/, '');
  svgNames = new Set((tree.svg || []).map(strip));
  pngNames = new Set((tree.png || []).map(strip));
  compactIndex = new Map();
  for (const name of new Set([...svgNames, ...pngNames])) {
    const compact = name.replace(/-/g, '');
    if (!compactIndex.has(compact)) compactIndex.set(compact, name);
  }
  loadedAt = Date.now();
}

// Namensliste laden (im Hintergrund, mit Cache). Schlaegt das fehl, bleiben explizit
// gewaehlte Icons erhalten; nur die automatische Erkennung faellt dann auf Symbole zurueck.
function ensureLoaded() {
  const fresh = loadedAt && Date.now() - loadedAt < REFRESH_MS;
  if (fresh || loadingPromise) return loadingPromise || Promise.resolve();
  loadingPromise = fetch(TREE_URL, { signal: AbortSignal.timeout(10000) })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(buildIndex)
    .catch((err) => {
      console.warn('[icons] Dashboard-Icon-Liste konnte nicht geladen werden:', err.message);
      // naechster Versuch nach RETRY_MS statt bei jeder Anfrage
      if (!loadedAt) loadedAt = Date.now() - REFRESH_MS + RETRY_MS;
    })
    .finally(() => { loadingPromise = null; });
  return loadingPromise;
}

function isLoaded() {
  return svgNames.size > 0 || pngNames.size > 0;
}

function hasIcon(name) {
  return svgNames.has(name) || pngNames.has(name);
}

// Vorhandenen Namen finden: exakt, ohne Bindestriche oder ueber Alias
function findName(candidate) {
  if (!candidate) return null;
  const c = String(candidate).toLowerCase().trim();
  if (!/^[a-z0-9-]{1,64}$/.test(c)) return null;
  if (Object.prototype.hasOwnProperty.call(ALIASES, c)) {
    const alias = ALIASES[c];
    return alias && hasIcon(alias) ? alias : null;
  }
  if (hasIcon(c)) return c;
  return compactIndex.get(c.replace(/-/g, '')) || null;
}

function formatOf(name) {
  return svgNames.has(name) ? 'svg' : 'png';
}

function dashboard(name) {
  const resolved = { type: 'dashboard', name, format: formatOf(name) };
  const whiteName = WHITE_STYLE_VARIANTS[name];
  if (whiteName && hasIcon(whiteName)) {
    resolved.white = { name: whiteName, format: formatOf(whiteName) };
  }
  return resolved;
}

function genericFor(url) {
  const u = String(url || '').trim().toLowerCase();
  if (u.startsWith('mailto:')) return { type: 'generic', name: 'mail' };
  if (u.startsWith('tel:')) return { type: 'generic', name: 'phone' };
  return { type: 'generic', name: 'link' };
}

// Logo anhand von URL und Titel erkennen
function detect(url, title) {
  if (!isLoaded()) return null;
  const candidates = [];

  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* keine gueltige URL */ }
  if (host) {
    const labels = host.split('.').filter((l) => l && !IGNORED_LABELS.has(l));
    // Hauptdomain zuerst (music.youtube.com -> youtube), dann Subdomain-Kombinationen
    const main = labels[labels.length - 1];
    if (labels.length >= 2) candidates.push(`${main}-${labels[labels.length - 2]}`);
    candidates.push(main, ...labels.slice(0, -1).reverse());
  }

  const words = String(title || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  if (words.length >= 2) candidates.push(words.join('-'), words.join(''));
  candidates.push(...words.filter((w) => w.length >= 3 || Object.prototype.hasOwnProperty.call(ALIASES, w)));

  for (const cand of candidates) {
    const name = findName(cand);
    if (name) return dashboard(name);
  }
  return null;
}

function resolveIcon(link) {
  const icon = typeof link.icon === 'string' ? link.icon.trim() : '';
  const url = link.url || '';

  // mailto/tel sind Kontaktwege -> immer das passende Symbol (nicht das Logo des Mailanbieters)
  const lowerUrl = String(url).toLowerCase();
  const isContact = lowerUrl.startsWith('mailto:') || lowerUrl.startsWith('tel:');

  if (icon.startsWith('dashboardicon:')) {
    const [name, , variant] = icon.slice('dashboardicon:'.length).split(':');
    const full = variant ? `${name}-${variant}` : name;
    // Ohne geladene Liste dem Admin vertrauen (Name wurde beim Speichern bereinigt)
    if (!isLoaded() && /^[a-z0-9-]{1,80}$/.test(full)) return { type: 'dashboard', name: full, format: 'png' };
    const found = findName(full) || findName(name);
    if (found) return dashboard(found);
  } else if (icon.startsWith('simpleicon:')) {
    const found = findName(icon.slice('simpleicon:'.length));
    if (found) return dashboard(found);
  } else if (/^https?:\/\//i.test(icon)) {
    return { type: 'image', url: icon };
  }

  if (isContact) return genericFor(url);
  return detect(url, link.title) || genericFor(url);
}

// Fuer die Icon-Suche im Admin
function listNames() {
  return [...new Set([...svgNames, ...pngNames])].sort();
}

module.exports = { ensureLoaded, resolveIcon, listNames, isLoaded };
