const crypto = require('crypto');
const db = require('./db');
const { decrypt } = require('./crypto');
const { safeText } = require('./validators');

// Zeitlimit je Abruf. Music Assistant auf kleiner Hardware braucht z. B. waehrend eines
// Bibliotheks-Scans gelegentlich laenger als 3 s – mit dem alten Limit verschwand die Anzeige.
const API_TIMEOUT_MS = 5000;
// Die Benutzerliste (Player-Zuordnung) aendert sich selten: 5 min gueltig, danach im Hintergrund
// erneuern. Schlaegt das fehl, gilt die letzte bekannte Liste weiter (neuer Versuch nach 30 s).
const USER_CACHE_MS = 5 * 60_000;
const USER_RETRY_MS = 30_000;
// Kurze Aussetzer (Zeitueberschreitung, Neustart von Music Assistant) ueberbruecken: so lange
// wird der letzte erfolgreiche Stand weitergegeben, statt kurz "nichts laeuft" anzuzeigen.
const LAST_GOOD_GRACE_MS = 15_000;
// Ist Music Assistant laenger nicht erreichbar, nicht bei jeder Anfrage erneut bis zum
// Zeitlimit warten (bremst sonst auch Spotify/Navidrome auf der Startseite aus).
const FAILURES_BEFORE_PAUSE = 3;
const FAILURE_PAUSE_MS = 20_000;

let usersCache = { key: null, users: null, expiresAt: 0, inflight: null };
let messageCounter = Date.now();
let lastGood = null; // { key, track, at }
let lastErrorMessage = null;
let consecutiveFailures = 0;
let pausedUntil = 0;

function nextMessageId() {
  messageCounter += 1;
  return messageCounter;
}

async function getSettings() {
  const { rows } = await db.query('SELECT * FROM musicassistant_settings WHERE id = 1 LIMIT 1');
  return rows[0] || null;
}

function normalizeUser(user) {
  if (!user || user.user_id == null || user.enabled === false) return null;
  const userId = safeText(String(user.user_id), 255);
  if (!userId) return null;

  const playerFilter = Array.isArray(user.player_filter)
    ? [...new Set(user.player_filter.map(id => safeText(String(id), 255)).filter(Boolean))]
    : [];

  return {
    user_id: userId,
    name: safeText(user.display_name, 120) || safeText(user.username, 120) || userId,
    username: safeText(user.username, 120),
    player_filter: playerFilter
  };
}

function authHeaders(settings) {
  const headers = { 'Accept': 'application/json' };
  if (settings.token_encrypted) {
    headers['Authorization'] = 'Bearer ' + decrypt(settings.token_encrypted);
  }
  return headers;
}

async function requestMusicAssistant(settings, command, signal, messageId = nextMessageId()) {
  const url = `${settings.url.replace(/\/$/, '')}/api`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(settings), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_id: messageId, command }),
    signal
  });
  if (!response.ok) throw new Error('MA HTTP ' + response.status);

  const json = await response.json();
  if (json && (json.error || json.error_code != null)) {
    throw new Error('Music Assistant API-Fehler');
  }
  return json && json.result !== undefined ? json.result : json;
}

// Dauerhafte Ablehnung (fehlendes Recht, unbekannter Befehl) statt Zeitueberschreitung,
// Netz- oder Serverfehler?
function isPermissionError(err) {
  const msg = String(err && err.message || '');
  return msg === 'Music Assistant API-Fehler' || /^MA HTTP (400|401|403|404)$/.test(msg);
}

function isTimeout(err) {
  return Boolean(err) && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

// Verbindung pruefen (fuer den Einrichtungsassistenten): Adresse erreichbar, API vorhanden,
// Token gueltig. Liefert verstaendliche Fehlermeldungen statt Interna.
async function testConnection(settings) {
  try {
    const result = await requestMusicAssistant(settings, 'players/all', AbortSignal.timeout(API_TIMEOUT_MS * 2));
    const players = Array.isArray(result) ? result : (Array.isArray(result?.players) ? result.players : []);
    return { ok: true, playerCount: players.length };
  } catch (err) {
    const msg = String(err && err.message || '');
    const status = Number((msg.match(/MA HTTP (\d+)/) || [])[1]);
    if (isTimeout(err)) {
      return { ok: false, code: 'timeout', error: 'Music Assistant antwortet nicht (Zeitüberschreitung). Ist der Server vom OpenWeb-Server aus erreichbar?' };
    }
    if (status === 401 || status === 403 || msg === 'Music Assistant API-Fehler') {
      return { ok: false, code: 'auth', error: settings.token_encrypted
        ? 'Music Assistant lehnt den Token ab. Erstelle in deinen Profileinstellungen einen neuen langlebigen Token.'
        : 'Music Assistant verlangt einen Token. Erstelle ihn in der Weboberfläche in deinen Profileinstellungen.' };
    }
    if (status === 404 || status === 405) {
      return { ok: false, code: 'not_found', error: 'Unter dieser Adresse läuft kein Music Assistant (API nicht gefunden). Nutze die Adresse der Weboberfläche, z. B. http://192.168.1.100:8095.' };
    }
    if (status) return { ok: false, code: 'http', error: `Music Assistant antwortet mit HTTP ${status}.` };
    if (err instanceof SyntaxError) return { ok: false, code: 'not_found', error: 'Unter dieser Adresse antwortet kein Music Assistant.' };
    return { ok: false, code: 'unreachable', error: 'Music Assistant ist nicht erreichbar. Prüfe die Adresse und ob der Server vom OpenWeb-Server aus erreichbar ist.' };
  }
}

async function fetchUsersFromMusicAssistant(settings) {
  const signal = AbortSignal.timeout(API_TIMEOUT_MS);
  const [usersResult, currentUserResult] = await Promise.allSettled([
    requestMusicAssistant(settings, 'auth/users', signal),
    requestMusicAssistant(settings, 'auth/me', signal)
  ]);

  // auth/users braucht users.read; fehlt nur dieses Recht, liefert auth/me zumindest den
  // Token-Benutzer. Bei Zeitueberschreitung oder Netzfehler dagegen abbrechen: sonst ersetzte
  // ein einzelner Aussetzer die vollstaendige Liste durch den Token-Benutzer, und ein anders
  // gewaehlter Benutzer fehlte bis zum naechsten Abruf (Anzeige "nichts laeuft").
  if (usersResult.status === 'rejected' && !isPermissionError(usersResult.reason)) {
    throw usersResult.reason;
  }

  let rawUsers = [];
  if (usersResult.status === 'fulfilled') {
    const result = usersResult.value;
    rawUsers = Array.isArray(result) ? result : (Array.isArray(result?.users) ? result.users : []);
  }
  const currentUser = currentUserResult.status === 'fulfilled'
    ? normalizeUser(currentUserResult.value)
    : null;
  if (!rawUsers.length && currentUser) return [{ ...currentUser, is_current: true }];

  const users = rawUsers.map(normalizeUser).filter(Boolean).map(user => ({
    ...user,
    is_current: user.user_id === currentUser?.user_id
  }));
  if (!users.length && usersResult.status === 'rejected' && currentUserResult.status === 'rejected') {
    throw usersResult.reason || currentUserResult.reason;
  }
  return users;
}

function usersCacheKey(settings) {
  return `${settings.url}\n${settings.token_encrypted || ''}`;
}

// force: neuen Abruf starten, statt sich an einen laufenden (evtl. aelteren) anzuhaengen
function refreshUsers(settings, key, force = false) {
  if (!force && usersCache.key === key && usersCache.inflight) return usersCache.inflight;
  const previous = usersCache.key === key ? usersCache : { users: null, expiresAt: 0 };

  const inflight = fetchUsersFromMusicAssistant(settings).then((users) => {
    if (usersCache.key === key && usersCache.inflight === inflight) {
      usersCache = { key, users, expiresAt: Date.now() + USER_CACHE_MS, inflight: null };
    }
    return users;
  }, (err) => {
    if (usersCache.key === key && usersCache.inflight === inflight) {
      // Letzte bekannte Liste behalten und spaeter erneut versuchen
      usersCache = {
        key,
        users: previous.users,
        expiresAt: previous.users ? Date.now() + USER_RETRY_MS : 0,
        inflight: null
      };
    }
    throw err;
  });

  usersCache = { key, users: previous.users, expiresAt: previous.expiresAt, inflight };
  return inflight;
}

// refresh = true (Admin-Auswahl): immer neu laden. Sonst (Now Playing): gueltige Liste sofort,
// abgelaufene Liste ebenfalls sofort und im Hintergrund erneuern; nur ohne Liste wird gewartet.
async function getUsersForSettings(settings, refresh = false) {
  const key = usersCacheKey(settings);
  if (refresh) return refreshUsers(settings, key, true);
  if (usersCache.key === key && usersCache.users) {
    if (usersCache.expiresAt <= Date.now() && !usersCache.inflight) {
      refreshUsers(settings, key).catch(() => {});
    }
    return usersCache.users;
  }
  return refreshUsers(settings, key);
}

async function getAvailableUsers() {
  const settings = await getSettings();
  if (!settings || !settings.url) {
    const err = new Error('Bitte zuerst die Music Assistant URL speichern.');
    err.status = 400;
    throw err;
  }

  const users = await getUsersForSettings(settings, true);
  return users.map(user => ({
    user_id: user.user_id,
    name: user.name,
    username: user.username,
    is_current: user.is_current,
    has_player_filter: user.player_filter.length > 0
  }));
}

function correctedElapsedTime(elapsedTime, lastUpdated, isPlaying, playbackSpeed = 1) {
  if (elapsedTime == null || elapsedTime === '') return null;
  const position = Number(elapsedTime);
  if (!Number.isFinite(position) || position < 0) return null;

  const timestamp = Number(lastUpdated);
  if (!isPlaying || !Number.isFinite(timestamp) || timestamp <= 0) return position;

  const speed = Number(playbackSpeed);
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const secondsSinceUpdate = Math.max(0, Date.now() / 1000 - timestamp);
  return position + secondsSinceUpdate * rate;
}

// ---------------------------------------------------------------------------
// Aktuelle Wiedergabe bestimmen
// ---------------------------------------------------------------------------

// Aeltere Music-Assistant-Versionen liefern nur "state", neuere "playback_state" (+ Alias)
function playbackState(entity) {
  return String(entity?.playback_state ?? entity?.state ?? '').toLowerCase();
}

function asList(result, key) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result[key])) return result[key];
  return [];
}

function hasTitle(media) {
  return Boolean(media) && typeof media.title === 'string' && media.title.trim() !== '';
}

// Aktive MA-Queue eines Players (wie in Music Assistant selbst): die Quelle der aktuellen
// Wiedergabe, sonst die eigene Queue – aber nur, wenn keine fremde Quelle (z. B. Spotify Connect
// direkt am Geraet) aktiv ist, sonst stammten Titel/Bitrate vom zuletzt in MA gespielten Titel.
function findActiveQueue(player, queues) {
  const byId = (id) => (id == null ? null : queues.find(q => q && String(q.queue_id) === String(id)) || null);
  return byId(player.current_media?.source_id)
    || byId(player.active_source)
    || (player.active_source == null ? byId(player.player_id) : null);
}

function queueItemImageUrl(item) {
  const image = item.image;
  if (!image) return null;
  if (image.proxy_id) return `/imageproxy/${encodeURIComponent(image.proxy_id)}?size=512`;
  if (image.path && image.provider && !image.remotely_accessible) {
    // Format aelterer Versionen (Pfad doppelt kodiert, wie Music Assistant es selbst baut)
    return `/imageproxy?path=${encodeURIComponent(encodeURIComponent(image.path))}`
      + `&provider=${encodeURIComponent(image.provider)}&size=512`;
  }
  return typeof image.path === 'string' ? image.path : null;
}

// Rueckfall fuer aeltere Versionen, die current_media nicht aus der Queue befuellen
function mediaFromQueue(queue) {
  const item = queue?.current_item;
  if (!item) return null;
  const mediaItem = item.media_item || {};
  const stream = item.streamdetails?.stream_metadata || null;
  const artists = Array.isArray(mediaItem.artists)
    ? mediaItem.artists.map(a => a?.name).filter(Boolean).join(', ')
    : '';
  const name = mediaItem.name
    ? (mediaItem.version ? `${mediaItem.name} (${mediaItem.version})` : mediaItem.name)
    : null;
  return {
    uri: mediaItem.uri || item.queue_item_id,
    media_type: mediaItem.media_type || item.streamdetails?.media_type || null,
    title: stream?.title || name || item.name || null,
    artist: stream?.artist || mediaItem.artist_str || artists || null,
    album: stream?.album || mediaItem.album?.name || null,
    image_url: stream?.image_url || queueItemImageUrl(item),
    duration: stream?.duration || mediaItem.duration || item.duration || null,
    source_id: queue.queue_id,
    queue_item_id: item.queue_item_id || null,
    elapsed_time: null,
    elapsed_time_last_updated: null
  };
}

// Was laeuft auf dem Player? Neuere Versionen liefern current_media fertig (auch fuer gruppierte
// Player und Radiosender). Rueckfaelle: Medium des Gruppen-/Sync-Leiters, dann die aktive Queue.
function resolveMedia(player, playersById, queue) {
  const own = player.current_media || null;
  if (hasTitle(own)) return own;
  const parentId = player.active_group || player.synced_to;
  const parent = parentId && String(parentId) !== String(player.player_id)
    ? playersById.get(String(parentId))
    : null;
  const parentMedia = parent?.current_media || null;
  if (hasTitle(parentMedia)) return parentMedia;
  const queueMedia = mediaFromQueue(queue);
  if (hasTitle(queueMedia)) return queueMedia;
  return own || parentMedia || queueMedia;
}

function lastUpdated(candidate) {
  return Number(candidate.media.elapsed_time_last_updated)
    || Number(candidate.player.elapsed_time_last_updated)
    || 0;
}

// Unter den Playern des gewaehlten Benutzers den aktiven waehlen. Frueher gewann der erste
// laufende ODER pausierte Player der Liste – ein seit Stunden pausierter Lautsprecher verdeckte so
// die eigentliche Wiedergabe. Jetzt: laufend vor pausiert, dann mit Titel, dann zuletzt aktualisiert.
// Nicht verfuegbare oder deaktivierte Player (oft mit veraltetem Status) zaehlen nicht.
function pickActivePlayer(players, allowedIds, queues) {
  const playersById = new Map(players.filter(Boolean).map(p => [String(p.player_id), p]));
  const candidates = [];
  for (const player of playersById.values()) {
    if (!allowedIds.has(String(player.player_id))) continue;
    if (player.available === false || player.enabled === false) continue;
    const state = playbackState(player);
    if (state !== 'playing' && state !== 'paused') continue;
    const queue = findActiveQueue(player, queues);
    const media = resolveMedia(player, playersById, queue);
    if (!media) continue;
    candidates.push({ player, queue, media, playing: state === 'playing' });
  }
  candidates.sort((a, b) =>
    (Number(b.playing) - Number(a.playing))
    || (Number(hasTitle(b.media)) - Number(hasTitle(a.media)))
    || (lastUpdated(b) - lastUpdated(a)));
  return candidates[0] || null;
}

// Gehoert der aktuelle Queue-Eintrag zum angezeigten Titel?
function queueMatchesMedia(queue, media) {
  const item = queue?.current_item;
  if (!item) return false;
  return !media.queue_item_id || !item.queue_item_id || media.queue_item_id === item.queue_item_id;
}

function audioDetails(queue, media) {
  const empty = { bitrate: null, format: null };
  if (!queueMatchesMedia(queue, media)) return empty;
  const af = queue.current_item.streamdetails?.audio_format;
  if (!af) return empty;

  let bitrate = null;
  const rawBitrate = Number(af.bit_rate);
  if (Number.isFinite(rawBitrate) && rawBitrate > 0) {
    // Music Assistant liefert bit_rate inzwischen in kbps; alte APIs lieferten bit/s.
    bitrate = Math.round(rawBitrate > 10_000 ? rawBitrate / 1000 : rawBitrate);
  } else if (af.sample_rate && af.bit_depth) {
    // Format like "44.1 kHz / 16 bits"
    const khz = (af.sample_rate / 1000).toFixed(1).replace('.0', '');
    bitrate = `${khz} kHz / ${af.bit_depth} bits`;
  }
  const format = typeof af.content_type === 'string' && af.content_type && af.content_type !== 'unknown'
    ? af.content_type
    : null;
  return { bitrate, format };
}

// Position: bevorzugt aus current_media (berechnet Music Assistant selbst, auch fuer Radio-Titel),
// sonst aus der passenden Queue, zuletzt vom Player.
function playbackPosition(candidate) {
  const { player, queue, media, playing } = candidate;
  const queueMatches = queueMatchesMedia(queue, media);
  const queuePlaying = playing && (queue?.state == null || playbackState(queue) === 'playing');
  const speed = queueMatches ? queue.playback_speed : 1;
  return correctedElapsedTime(media.elapsed_time, media.elapsed_time_last_updated, playing, speed)
    ?? (queueMatches
      ? correctedElapsedTime(queue.elapsed_time, queue.elapsed_time_last_updated, queuePlaying, queue.playback_speed)
      : null)
    ?? correctedElapsedTime(player.elapsed_time, player.elapsed_time_last_updated, playing)
    ?? 0;
}

// Cover-Adresse fuer den Abruf durch OpenWeb. Music Assistant baut Bild-URLs mit seiner eigenen
// Basis-URL – oft eine interne IP, ein anderer Hostname oder der Stream-Port 8097. Die passte
// nicht zur in OpenWeb eingetragenen Adresse, und das Cover fehlte. Bilder ueber den Bild-Proxy
// von Music Assistant (/imageproxy) werden deshalb immer ueber die eingetragene Adresse geladen
// (gleicher Server, fester Host). Andere Adressen nur, wenn sie genau diese Origin haben.
function normalizeCoverUrl(imageUrl, baseUrl) {
  if (typeof imageUrl !== 'string' || !imageUrl) return null;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let baseOrigin;
  try {
    baseOrigin = new URL(base).origin;
  } catch {
    return null;
  }
  const proxyPart = (path) => {
    const idx = path.search(/\/imageproxy(?:[/?]|$)/);
    return idx === -1 ? null : path.slice(idx);
  };

  if (imageUrl.startsWith('/') && !imageUrl.startsWith('//')) {
    return base + (proxyPart(imageUrl) || imageUrl);
  }
  let url;
  try {
    url = new URL(imageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const proxied = proxyPart(url.pathname);
  if (proxied) return base + proxied + url.search;
  return url.origin === baseOrigin ? url.href : null;
}

function buildTrack(candidate, settings) {
  const { media, playing } = candidate;
  const isRadio = String(media.media_type || '').toLowerCase() === 'radio';
  const title = typeof media.title === 'string' && media.title.trim() ? media.title.trim() : 'Unbekannt';
  const uri = media.uri ? String(media.uri) : null;

  // Interne Cover-URL bleibt serverseitig (coverUrlInternal); Besucher erhalten nur den eigenen
  // Proxy-Pfad. v wechselt mit dem Bild (auch bei Radio, wo die URI gleich bleibt).
  const coverUrlInternal = normalizeCoverUrl(media.image_url, settings.url);
  const coverUrl = coverUrlInternal
    ? `/api/status/cover?v=${crypto.createHash('sha256').update(coverUrlInternal).digest('hex').slice(0, 16)}`
    : null;

  const { bitrate, format } = audioDetails(candidate.queue, media);
  const duration = Number(media.duration) > 0 ? Number(media.duration) : 0;
  let position = playbackPosition(candidate);
  if (duration > 0 && position > duration) position = duration;

  return {
    playing: true,
    // Radio: gleiche URI fuer alle Titel – Titel anhaengen, damit Verlauf/Discord Wechsel erkennen
    id: isRadio && uri ? `${uri}::${title}` : uri,
    title,
    artist: media.artist || '',
    album: media.album || '',
    duration,
    bitrate,
    format,
    position,
    coverUrl,
    coverUrlInternal,
    isRadio,
    paused: !playing,
    source: 'musicassistant'
  };
}

async function fetchNowPlaying(settings) {
  const signal = AbortSignal.timeout(API_TIMEOUT_MS);
  const [playersResult, queuesResult, users] = await Promise.all([
    requestMusicAssistant(settings, 'players/all', signal),
    // Queues nur fuer Bitrate/Format und als Rueckfall – ein Fehler hier ist kein Abbruchgrund
    requestMusicAssistant(settings, 'player_queues/all', signal).catch(() => null),
    getUsersForSettings(settings)
  ]);

  const players = asList(playersResult, 'players');
  const queues = asList(queuesResult, 'queues');

  // Nur Player beruecksichtigen, die dem ausgewaehlten MA-Benutzer zugewiesen sind. Ohne
  // eingeschraenkte Zuordnung (= alle Player) vorsichtshalber nichts anzeigen.
  const selectedUser = users.find(user => user.user_id === String(settings.user_id));
  const allowedIds = new Set(selectedUser?.player_filter || []);
  if (!allowedIds.size) return { playing: false, source: 'musicassistant' };

  const candidate = pickActivePlayer(players, allowedIds, queues);
  if (!candidate) return { playing: false, source: 'musicassistant' };
  return buildTrack(candidate, settings);
}

// Letzten Stand fortschreiben (Position laeuft weiter), ohne das gecachte Objekt zu veraendern
function advanceTrack(track, since) {
  if (!track || track.playing !== true || track.paused || track.isRadio) return track;
  const duration = Number(track.duration) || 0;
  const position = (Number(track.position) || 0) + (Date.now() - since) / 1000;
  return { ...track, position: duration > 0 ? Math.min(position, duration) : position };
}

function describeError(err) {
  if (isTimeout(err)) return 'Zeitueberschreitung';
  return String(err && err.message || err || 'unbekannter Fehler');
}

// force: Admin-Test – auch waehrend der Pause nach wiederholten Fehlern sofort abfragen
async function getNowPlaying(options) {
  const force = Boolean(options && options.force);
  const settings = await getSettings();
  if (!settings || !settings.enabled || !settings.url) {
    lastGood = null;
    return null;
  }
  if (!settings.user_id) return { playing: false, source: 'musicassistant' };

  const key = `${settings.url}\n${settings.user_id}`;
  const fromLastGood = () => (lastGood && lastGood.key === key && Date.now() - lastGood.at < LAST_GOOD_GRACE_MS
    ? advanceTrack(lastGood.track, lastGood.at)
    : null);

  if (!force && Date.now() < pausedUntil) return fromLastGood();

  try {
    const track = await fetchNowPlaying(settings);
    lastGood = { key, track, at: Date.now() };
    consecutiveFailures = 0;
    if (lastErrorMessage) {
      console.log('[musicassistant] Now Playing wieder erreichbar');
      lastErrorMessage = null;
    }
    return track;
  } catch (err) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= FAILURES_BEFORE_PAUSE) pausedUntil = Date.now() + FAILURE_PAUSE_MS;
    // Gleiche Fehler nicht alle 2,5 s erneut protokollieren
    const message = describeError(err);
    if (message !== lastErrorMessage) {
      console.error('[musicassistant] now-playing error:', message);
      lastErrorMessage = message;
    }
    // null: andere Quellen (Spotify/Navidrome) koennen uebernehmen
    return fromLastGood();
  }
}

// Ergebnis 2,5 s zwischenspeichern: Startseite (jeder Besucher alle 3 s), Admin-Vorschau,
// Musik-Verlauf und Discord-Webhook teilen sich so einen Abruf
const { shortCache } = require('./shortcache');
const getNowPlayingCached = shortCache(getNowPlaying, 2500);

// Aktuelles Cover laden – nur vom konfigurierten Music-Assistant-Server (gleiche Origin),
// ohne Weiterleitungen, mit Zeit- und Groessenlimit und nur fuer Rasterbilder.
const COVER_MAX_BYTES = 5 * 1024 * 1024;
const COVER_TYPES = /^image\/(jpeg|png|gif|webp|avif|bmp)$/;

async function fetchCurrentCover() {
  const [track, settings] = await Promise.all([getNowPlayingCached(), getSettings()]);
  if (!track || !track.coverUrlInternal || !settings || !settings.url) return null;
  let coverOrigin;
  let maOrigin;
  try {
    coverOrigin = new URL(track.coverUrlInternal).origin;
    maOrigin = new URL(settings.url).origin;
  } catch {
    return null;
  }
  if (coverOrigin !== maOrigin) return null;
  // Token mitsenden (nur an den eingetragenen Server, Weiterleitungen sind verboten), falls der
  // Bild-Proxy von Music Assistant eine Anmeldung verlangt
  const headers = authHeaders(settings);
  headers['Accept'] = 'image/*';
  const res = await fetch(track.coverUrlInternal, { headers, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!COVER_TYPES.test(contentType)) return null;
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > COVER_MAX_BYTES) return null;
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > COVER_MAX_BYTES) return null;
    chunks.push(chunk);
  }
  return { contentType, body: Buffer.concat(chunks) };
}

module.exports = {
  fetchCurrentCover,
  getSettings,
  testConnection,
  getAvailableUsers,
  getNowPlaying: getNowPlayingCached,
  getNowPlayingUncached: () => getNowPlaying({ force: true })
};
