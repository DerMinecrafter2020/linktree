// =========================================================
// OpenWeb — Link-Vorschau (Open Graph / Twitter Card) fuer Discord, WhatsApp, Telegram …
// ---------------------------------------------------------
// Vorschaubild: 1200x630 JPEG/PNG, erzeugt im Admin-Bereich (Canvas, public/js/admin.js) aus
// Profil + Standard-Design oder hochgeladen; gespeichert in og_settings.image (BYTEA),
// ausgeliefert unter /og-image.jpg. Ohne eigenes Bild dient das Profilbild als kleines Vorschaubild.
// Crawler (Discordbot …) koennen kein SVG – deshalb nie icon.svg als og:image verwenden.
// =========================================================

const crypto = require('crypto');
const db = require('./db');

const WIDTH = 1200;
const HEIGHT = 630;
// Body-Parser erlaubt 1 MB JSON; Base64 braucht ~4/3 – daher hoechstens 700 KB Bilddaten
const MAX_BYTES = 700 * 1024;

// Akzentfarbe je Standard-Design fuer <meta name="theme-color"> (Discord: Farbstreifen am Embed).
// Werte = --md-primary der Themes in public/styles.css / public/css/themes.css.
const THEME_ACCENT = {
  dark: '#d0bcff',
  midnight: '#9ecaff',
  sunset: '#ffb781',
  light: '#6750a4',
  win11: '#60cdff',
  glass: '#9cd0ff',
};

// Bekannte Vorschau-Crawler: nur fuer sie wird "Hoert gerade" in die Beschreibung geschrieben
const CRAWLER_RE = /discordbot|twitterbot|facebookexternalhit|facebookcatalog|slackbot|telegrambot|whatsapp|linkedinbot|skypeuripreview|mastodon|pleroma|misskey|redditbot|embedly|iframely|vkshare|bluesky|cardyb|signal|threema|matrix|synapse|element|applebot|pinterest/i;

function isCrawler(userAgent) {
  return CRAWLER_RE.test(String(userAgent || ''));
}

function accentFor(theme) {
  return THEME_ACCENT[theme] || THEME_ACCENT.dark;
}

async function getSettings() {
  const { rows } = await db.query(
    'SELECT image IS NOT NULL AS has_image, image_type, image_key, custom, show_now_playing, updated_at FROM og_settings WHERE id = 1 LIMIT 1'
  );
  return rows[0] || { has_image: false, image_type: null, image_key: null, custom: false, show_now_playing: true, updated_at: null };
}

async function getImage() {
  const { rows } = await db.query('SELECT image, image_type, updated_at FROM og_settings WHERE id = 1 AND image IS NOT NULL LIMIT 1');
  return rows[0] || null;
}

// Kurzer Versionswert fuer ?v= (Discord & Co. cachen Vorschauen pro URL)
function versionOf(updatedAt) {
  if (!updatedAt) return '0';
  return crypto.createHash('sha1').update(String(new Date(updatedAt).getTime())).digest('hex').slice(0, 10);
}

// Breite/Hoehe aus dem Dateikopf lesen (PNG: IHDR, JPEG: SOF-Marker)
function imageSize(buf, type) {
  if (type === 'image/png') {
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (type === 'image/jpeg') {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  err.expose = true;
  return err;
}

/**
 * Prueft und speichert ein Vorschaubild (Data-URL aus dem Admin).
 * @param {{ dataUrl: string, key?: string, custom?: boolean }} input
 */
async function saveImage({ dataUrl, key, custom }) {
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw badRequest('Bitte ein JPEG- oder PNG-Bild übertragen.');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) throw badRequest('Das Vorschaubild ist zu groß (höchstens 700 KB).');
  const size = imageSize(buf, m[1]);
  if (!size) throw badRequest('Die Bilddatei ist beschädigt oder hat ein unbekanntes Format.');
  if (size.width !== WIDTH || size.height !== HEIGHT) throw badRequest(`Das Vorschaubild muss ${WIDTH} × ${HEIGHT} Pixel groß sein.`);
  const imageKey = typeof key === 'string' && /^[a-f0-9]{8,64}$/.test(key) ? key : null;
  await db.query(
    `UPDATE og_settings SET image = $1, image_type = $2, image_key = $3, custom = $4, updated_at = NOW() WHERE id = 1`,
    [buf, m[1], imageKey, Boolean(custom)]
  );
  return getSettings();
}

async function clearImage() {
  await db.query('UPDATE og_settings SET image = NULL, image_type = NULL, image_key = NULL, custom = false, updated_at = NOW() WHERE id = 1');
  return getSettings();
}

async function saveOptions({ showNowPlaying }) {
  await db.query('UPDATE og_settings SET show_now_playing = $1 WHERE id = 1', [Boolean(showNowPlaying)]);
  return getSettings();
}

// "Hoert gerade: Titel – Kuenstler" (nur wenn wirklich gerade etwas laeuft), max. ~0,8 s warten
async function nowPlayingLine(timeoutMs = 800) {
  try {
    const { getActiveTrack } = require('./nowplaying');
    const track = await Promise.race([
      getActiveTrack(),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.()),
    ]);
    if (!track || track.playing !== true || track.paused || !track.title) return '';
    const title = String(track.title).replace(/\s+/g, ' ').slice(0, 80);
    const artist = track.artist ? String(track.artist).replace(/\s+/g, ' ').slice(0, 60) : '';
    return `🎵 Hört gerade: ${title}${artist ? ` – ${artist}` : ''}`;
  } catch {
    return '';
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Setzt Titel, Beschreibung, Open-Graph-/Twitter-Tags und Embed-Farbe in das Startseiten-HTML.
 * Rohwerte rein, escaped wird genau einmal; Replacer-Funktionen (kein $&-Problem).
 * Bild: erzeugtes/hochgeladenes Vorschaubild (gross), sonst Profilbild (klein), sonst keins –
 * nie SVG, das zeigen Discord, WhatsApp & Co. nicht an.
 * @returns {{ html: string, image: string|null, card: string }}
 */
function applyMetaTags(html, { profile = {}, absUrl, settings, nowPlaying = '', theme = 'dark' }) {
  const pageTitle = profile.handle || profile.name || 'OpenWeb';
  const siteName = profile.name || profile.handle || 'OpenWeb';
  const bio = profile.bio || 'Alle wichtigen Links auf einen Blick.';
  const description = nowPlaying ? `${bio}\n${nowPlaying}` : bio;

  let image = null;
  let card = 'summary';
  if (settings?.has_image) {
    image = `${absUrl}/og-image.jpg?v=${versionOf(settings.updated_at)}`;
    card = 'summary_large_image';
  } else if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(profile.avatar_url || '')) {
    image = `${absUrl}/og-image.jpg?v=a${crypto.createHash('sha1').update(profile.avatar_url).digest('hex').slice(0, 10)}`;
  }
  const imageTags = image
    ? [
      `<meta property="og:image" content="${escapeHtml(image)}">`,
      `<meta property="og:image:alt" content="${escapeHtml(`Vorschau von ${pageTitle}`)}">`,
      ...(card === 'summary_large_image'
        ? [`<meta property="og:image:width" content="${WIDTH}">`, `<meta property="og:image:height" content="${HEIGHT}">`]
        : []),
    ].join('\n  ')
    : '';

  const out = html
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, () => `<meta name="description" content="${escapeHtml(bio)}" />`)
    // Akzentfarbe des Standard-Designs: Discord faerbt damit den Rand des Embeds.
    // Browser bekommen per js/theme-init.js danach die Hintergrundfarbe des Themes.
    .replace(/<meta name="theme-color" content="[^"]*"\s*\/?>/, () => `<meta name="theme-color" content="${accentFor(theme)}" />`)
    .replace(/<meta property="og:site_name" content="[^"]*"\s*\/?>/, () => `<meta property="og:site_name" content="${escapeHtml(siteName)}">\n  <meta property="og:locale" content="de_DE">`)
    .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, () => `<meta property="og:title" content="${escapeHtml(pageTitle)}">`)
    .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, () => `<meta property="og:description" content="${escapeHtml(description)}">`)
    .replace(/<meta property="og:image" content="[^"]*"\s*\/?>/, () => imageTags)
    .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, () => `<meta property="og:url" content="${escapeHtml(absUrl)}">`)
    .replace(/<meta name="twitter:card" content="[^"]*"\s*\/?>/, () => `<meta name="twitter:card" content="${card}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*"\s*\/?>/, () => `<meta name="twitter:title" content="${escapeHtml(pageTitle)}">`)
    .replace(/<meta name="twitter:description" content="[^"]*"\s*\/?>/, () => `<meta name="twitter:description" content="${escapeHtml(description)}">`)
    .replace(/<meta name="twitter:image" content="[^"]*"\s*\/?>/, () => (image ? `<meta name="twitter:image" content="${escapeHtml(image)}">` : ''))
    .replace(/<title>[^]*?<\/title>/, () => `<title>${escapeHtml(pageTitle)}</title>`);
  return { html: out, image, card };
}

module.exports = {
  WIDTH, HEIGHT, MAX_BYTES,
  isCrawler, accentFor, applyMetaTags, getSettings, getImage, versionOf, saveImage, clearImage, saveOptions, nowPlayingLine,
  _internal: { imageSize },
};
