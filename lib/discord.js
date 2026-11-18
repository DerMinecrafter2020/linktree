// =========================================================
// OpenWeb — "Now Playing"-Meldungen an einen Discord-Webhook
// =========================================================
// Laeuft komplett auf dem Server, unabhaengig davon, ob jemand die Startseite offen hat:
// Alle 10 s wird die aktive Quelle abgefragt (lib/nowplaying.js, dieselbe Auswahl wie die
// Startseite). Ein neuer Titel wird sofort samt Cover zu einer Nachricht gebaut und in eine kleine
// Warteschlange gelegt. Schlaegt das Senden fehl (Netzwerk, Zeitueberschreitung, Discord-Rate-Limit
// 429, 5xx), wird es mit wachsendem Abstand erneut versucht – das Cover bleibt dabei das des
// gemeldeten Titels, auch wenn inzwischen der naechste laeuft.
//
// Doppelte Meldungen vermeiden:
// - Schluessel = normalisierter Titel + Menge der Interpreten (Music Assistant meldet z. B.
//   "Boney M./LIZOT", Navidrome "LIZOT, Boney M." – beides ist derselbe Titel).
// - Ein in den letzten 10 Minuten gemeldeter Titel wird nicht erneut gemeldet (faellt eine Quelle
//   kurz aus, kann eine andere fuer einen Moment noch den vorigen Titel melden).
// - Der zuletzt gemeldete Titel steht in LAST_TRACK_FILE, damit ein Neustart nichts doppelt sendet.

const db = require('./db');
const fs = require('fs');
const { getActiveTrack } = require('./nowplaying');

// Quelle in der Discord-Nachricht (Autorzeile mit Logo aus Dashboard Icons)
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png';
const SOURCE_META = {
  navidrome: { name: 'Navidrome', icon: 'navidrome' },
  musicassistant: { name: 'Music Assistant', icon: 'music-assistant' },
  spotify: { name: 'Spotify', icon: 'spotify' },
};

const POLL_INTERVAL_MS = 10_000;
const TICK_WATCHDOG_MS = 60_000;      // ein Durchlauf darf den Takt nie dauerhaft blockieren
const WEBHOOK_TIMEOUT_MS = 15_000;
const COVER_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 5_000;          // 5 s, 10 s, 20 s, 40 s, 80 s, dann hoechstens 2 min
const RETRY_MAX_MS = 2 * 60_000;
const MAX_ATTEMPTS = 6;
const MAX_MESSAGE_AGE_MS = 15 * 60_000;
const MAX_QUEUE = 5;
const RECENT_WINDOW_MS = 10 * 60_000;

const COVER_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp' };

const lastTrackFile = require('./paths').LAST_TRACK_FILE;

let pollTimer = null;
let lastDetectedKey = null;        // zuletzt erkannter Titel (gemeldet, wartend oder bewusst uebersprungen)
const recentlySent = new Map();    // Schluessel -> Zeitpunkt der erfolgreichen Meldung
const queue = [];                  // wartende Nachrichten, aelteste zuerst
let flushing = false;
let lastPollError = null;

// ---------------------------------------------------------------------------
// Titel-Schluessel
// ---------------------------------------------------------------------------
function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Titel + Menge der Interpreten (Reihenfolge, Dubletten und Trennzeichen egal)
function trackKey(track) {
  const title = normalizeText(track && track.title);
  if (!title) return null;
  const artists = String((track && track.artist) || '')
    .split(/\s*(?:[/,;&]|\s(?:feat\.?|ft\.?)\s)\s*/i)
    .map(normalizeText)
    .filter(Boolean);
  return `${title}::${[...new Set(artists)].sort().join('|')}`;
}

function loadLastSent() {
  try {
    if (!fs.existsSync(lastTrackFile)) return;
    const raw = fs.readFileSync(lastTrackFile, 'utf8').trim();
    if (!raw) return;
    let key = null;
    let at = Date.now();
    if (raw.startsWith('{')) {
      const data = JSON.parse(raw);
      if (typeof data.key === 'string') key = data.key;
      if (Number.isFinite(data.at)) at = data.at;
    } else {
      // Altes Format bis v4.0.4: "Titel::Interpret::Album"
      const [title, artist] = raw.split('::');
      key = trackKey({ title, artist });
    }
    if (key) {
      lastDetectedKey = key;
      recentlySent.set(key, at);
    }
  } catch {
    // Datei unlesbar: im schlimmsten Fall wird der laufende Titel einmal doppelt gemeldet
  }
}

function saveLastSent(key, at) {
  try {
    fs.writeFileSync(lastTrackFile, JSON.stringify({ key, at }), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Nicht kritisch (nur Schutz vor doppelter Meldung nach einem Neustart)
  }
}

function pruneRecent(now = Date.now()) {
  for (const [key, at] of recentlySent) {
    if (now - at > RECENT_WINDOW_MS) recentlySent.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Nachricht bauen (inkl. Cover – wird einmal geladen und bei Wiederholungen weiterverwendet)
// ---------------------------------------------------------------------------
async function readLimited(res, maxBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function loadCover(track) {
  try {
    if (track.testCoverUrl) {
      const res = await fetch(track.testCoverUrl, { signal: AbortSignal.timeout(COVER_TIMEOUT_MS) });
      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!res.ok || !COVER_EXT[contentType]) return null;
      const body = await readLimited(res);
      return body ? { contentType, body } : null;
    }
    if (track.source === 'musicassistant' && track.coverUrlInternal) {
      // Nur vom konfigurierten Music-Assistant-Server (gleiche Origin, keine Weiterleitungen,
      // Zeit- und Groessenlimit) – Cover-URLs aus den Metadaten werden nicht blind abgerufen
      return await require('./musicassistant').fetchCurrentCover();
    }
    if (track.source === 'spotify' && track.coverUrlInternal) {
      // Nur von i.scdn.co (https, ohne Weiterleitungen, Zeit- und Groessenlimit)
      return await require('./spotify').fetchCurrentCover();
    }
    if (track.coverId) {
      const cover = await require('./navidrome').fetchCoverArt(track.coverId);
      return cover.ok ? { contentType: cover.contentType, body: cover.body } : null;
    }
  } catch (err) {
    console.error(`[discord] Cover konnte nicht geladen werden (${track.source || 'test'}):`, err.message);
  }
  return null;
}

function formatBerlinDate(date) {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

async function buildMessage(track, appUrl) {
  let trackUrl = track.url || appUrl || null;
  if (track.source === 'spotify') {
    // Link direkt zum Titel in Spotify (nur open.spotify.com, siehe lib/spotify.js)
    trackUrl = track.spotifyUrl || appUrl || null;
  } else if (track.url && !track.isRadio && track.albumId) {
    trackUrl = `${track.url.replace(/\/$/, '')}/app/#/album/${track.albumId}`;
  }

  const embed = {
    title: track.artist || 'Unbekannt',
    description: trackUrl ? `[${track.title || 'Unbekannt'}](${trackUrl})` : (track.title || 'Unbekannt'),
    color: Math.floor(Math.random() * 16777215),
    // Zeitpunkt der Erkennung (bei einer spaeter erfolgreichen Wiederholung bleibt er korrekt)
    footer: { text: formatBerlinDate(new Date()) }
  };
  const meta = SOURCE_META[track.source];
  if (meta) embed.author = { name: meta.name, icon_url: `${ICON_CDN}/${meta.icon}.png` };

  const extraInfo = [];
  if (track.format) extraInfo.push(String(track.format).toUpperCase());
  if (track.bitrate) {
    extraInfo.push(typeof track.bitrate === 'number' ? `${track.bitrate} kbps` : track.bitrate);
  }
  if (extraInfo.length > 0) {
    embed.description += `\n\n\`${extraInfo.join(' • ')}\``;
  }

  const cover = await loadCover(track);
  const file = cover && COVER_EXT[cover.contentType]
    ? { name: `cover.${COVER_EXT[cover.contentType]}`, contentType: cover.contentType, body: cover.body }
    : null;

  return {
    label: track.title || 'Unbekannt',
    payload: {
      content: 'Es wird ein Lied abgespielt:',
      embeds: [embed],
      allowed_mentions: { parse: [] }
    },
    file
  };
}

// ---------------------------------------------------------------------------
// Senden – liefert { ok } oder { ok: false, retryable, retryAfterMs?, error }
// ---------------------------------------------------------------------------
function retryAfterMs(res, bodyText) {
  let seconds = Number(res.headers.get('retry-after'));
  try {
    const body = JSON.parse(bodyText);
    if (Number.isFinite(body.retry_after)) seconds = Math.max(Number.isFinite(seconds) ? seconds : 0, body.retry_after);
  } catch {
    // kein JSON
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(Math.max(seconds * 1000, 1000), 10 * 60_000);
}

async function deliver(webhookUrl, message, withFile = true) {
  const useFile = Boolean(withFile && message.file);
  const payload = JSON.parse(JSON.stringify(message.payload));
  if (useFile) payload.embeds[0].thumbnail = { url: `attachment://${message.file.name}` };

  const opts = { method: 'POST', signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) };
  if (useFile) {
    const form = new FormData();
    form.append('file', new Blob([message.file.body], { type: message.file.contentType }), message.file.name);
    form.append('payload_json', JSON.stringify(payload));
    opts.body = form;
  } else {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(payload);
  }

  let res;
  try {
    res = await fetch(webhookUrl, opts);
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const cause = err && err.cause;
    return { ok: false, retryable: true, error: timeout ? 'Zeitüberschreitung' : (cause && (cause.code || cause.message)) || err.message };
  }
  if (res.ok) return { ok: true };

  const text = await res.text().catch(() => '');
  const error = `HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`;
  if (res.status === 429) return { ok: false, retryable: true, retryAfterMs: retryAfterMs(res, text), error };
  if (res.status >= 500) return { ok: false, retryable: true, error };
  // Abgelehnter Anhang (z. B. zu gross oder unbekanntes Format): ohne Cover nochmal
  if (useFile && (res.status === 400 || res.status === 413)) return deliver(webhookUrl, message, false);
  return { ok: false, retryable: false, error };
}

// Einmal bauen und senden (Admin-Test). Gibt das Ergebnis zurueck, statt Fehler zu verschlucken.
async function sendDiscordWebhook(track, webhookUrl, appUrl) {
  const message = await buildMessage(track, appUrl);
  const result = await deliver(webhookUrl, message);
  if (result.ok) console.log(`[discord] Gesendet: ${message.label}`);
  else console.error(`[discord] Senden fehlgeschlagen: ${message.label} – ${result.error}`);
  return result;
}

// ---------------------------------------------------------------------------
// Warteschlange
// ---------------------------------------------------------------------------
function attemptsText(n) {
  return `${n} Versuch${n === 1 ? '' : 'e'}`;
}

async function flushQueue(webhookUrl) {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length) {
      const item = queue[0];
      const now = Date.now();
      if (now - item.createdAt > MAX_MESSAGE_AGE_MS) {
        queue.shift();
        console.error(`[discord] Meldung verworfen (älter als 15 min, ${attemptsText(item.attempts)}): ${item.message.label}`);
        continue;
      }
      if (now < item.nextAt) return;

      item.attempts += 1;
      const result = await deliver(webhookUrl, item.message);
      if (result.ok) {
        queue.shift();
        const at = Date.now();
        recentlySent.set(item.key, at);
        saveLastSent(item.key, at);
        console.log(`[discord] Gesendet: ${item.message.label}${item.attempts > 1 ? ` (Versuch ${item.attempts})` : ''}`);
        continue;
      }
      if (!result.retryable || item.attempts >= MAX_ATTEMPTS) {
        queue.shift();
        console.error(`[discord] Senden fehlgeschlagen, keine weiteren Versuche (${attemptsText(item.attempts)}): ${item.message.label} – ${result.error}`);
        continue;
      }
      const delay = result.retryAfterMs || Math.min(RETRY_BASE_MS * 2 ** (item.attempts - 1), RETRY_MAX_MS);
      item.nextAt = Date.now() + delay;
      console.warn(`[discord] Senden fehlgeschlagen (${result.error}), neuer Versuch in ${Math.round(delay / 1000)} s: ${item.message.label}`);
      return;
    }
  } finally {
    flushing = false;
  }
}

function enqueue(key, message) {
  queue.push({ key, message, attempts: 0, nextAt: 0, createdAt: Date.now() });
  while (queue.length > MAX_QUEUE) {
    const dropped = queue.shift();
    console.error(`[discord] Warteschlange voll, Meldung verworfen: ${dropped.message.label}`);
  }
}

// ---------------------------------------------------------------------------
// Abfrage-Takt
// ---------------------------------------------------------------------------
async function tick(appUrl) {
  const { rows } = await db.query('SELECT discord_webhook_enabled, discord_webhook_url FROM admin_settings WHERE id = 1 LIMIT 1');
  const settings = rows[0];
  if (!settings || !settings.discord_webhook_enabled || !settings.discord_webhook_url) {
    queue.length = 0;
    return;
  }
  pruneRecent();

  // Gleiche Quellenauswahl wie die Startseite (Music Assistant, Spotify, Navidrome)
  const track = await getActiveTrack();
  if (!track || track.playing !== true) {
    // Nichts laeuft: derselbe Titel spaeter erneut gestartet wird wieder gemeldet
    // (kurze Aussetzer faengt das 10-Minuten-Fenster ab)
    lastDetectedKey = null;
  } else if (!track.paused) {
    const key = trackKey(track);
    if (key && key !== lastDetectedKey) {
      lastDetectedKey = key;
      if (!recentlySent.has(key) && !queue.some((item) => item.key === key)) {
        enqueue(key, await buildMessage(track, appUrl));
      }
    }
  }

  await flushQueue(settings.discord_webhook_url);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Durchlauf dauert länger als ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runPoll(appUrl) {
  try {
    await withTimeout(tick(appUrl), TICK_WATCHDOG_MS);
    if (lastPollError) {
      console.log('[discord] Abfrage funktioniert wieder');
      lastPollError = null;
    }
  } catch (err) {
    // Gleiche Fehler nicht alle 10 s erneut protokollieren
    const message = (err && err.message) || String(err);
    if (message !== lastPollError) {
      console.error('[discord] Fehler bei der Abfrage:', message);
      lastPollError = message;
    }
  } finally {
    // Naechster Durchlauf erst nach Ende des vorigen (kein Ueberlappen bei langsamen Antworten)
    pollTimer = setTimeout(() => runPoll(appUrl), POLL_INTERVAL_MS);
  }
}

function initDiscordWebhook() {
  if (pollTimer) return;
  const appUrl = process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : null;
  loadLastSent();
  console.log(`[discord] Now-Playing-Webhook aktiviert. Polling alle ${POLL_INTERVAL_MS / 1000} s`);
  pollTimer = setTimeout(() => runPoll(appUrl), POLL_INTERVAL_MS);
}

module.exports = { initDiscordWebhook, sendDiscordWebhook, trackKey };
