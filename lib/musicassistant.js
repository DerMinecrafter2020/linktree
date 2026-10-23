const db = require('./db');
const { decrypt } = require('./crypto');
const { safeText } = require('./validators');

const API_TIMEOUT_MS = 3000;
const USER_CACHE_MS = 30_000;
let usersCache = { key: null, users: null, expiresAt: 0, inflight: null };

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

async function requestMusicAssistant(settings, command, signal, messageId) {
  const headers = { 'Accept': 'application/json' };
  if (settings.token_encrypted) {
    headers['Authorization'] = 'Bearer ' + decrypt(settings.token_encrypted);
  }

  const url = `${settings.url.replace(/\/$/, '')}/api`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_id: messageId, command }),
    signal
  });
  if (!response.ok) throw new Error('MA HTTP ' + response.status);

  const json = await response.json();
  if (json.error || json.error_code != null) {
    throw new Error('Music Assistant API-Fehler');
  }
  return json.result !== undefined ? json.result : json;
}

async function fetchUsersFromMusicAssistant(settings) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    // auth/users braucht users.read; auth/me liefert als Fallback zumindest den Token-Benutzer.
    const [usersResult, currentUserResult] = await Promise.allSettled([
      requestMusicAssistant(settings, 'auth/users', controller.signal, Date.now()),
      requestMusicAssistant(settings, 'auth/me', controller.signal, Date.now() + 1)
    ]);

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
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getUsersForSettings(settings, refresh = false) {
  const key = `${settings.url}\n${settings.token_encrypted || ''}`;
  if (!refresh && usersCache.key === key) {
    if (usersCache.users && usersCache.expiresAt > Date.now()) return usersCache.users;
    if (usersCache.inflight) return usersCache.inflight;
  }

  const inflight = fetchUsersFromMusicAssistant(settings);
  usersCache = { key, users: null, expiresAt: 0, inflight };
  try {
    const users = await inflight;
    if (usersCache.key === key && usersCache.inflight === inflight) {
      usersCache = { key, users, expiresAt: Date.now() + USER_CACHE_MS, inflight: null };
    }
    return users;
  } catch (err) {
    if (usersCache.key === key && usersCache.inflight === inflight) {
      usersCache = { key: null, users: null, expiresAt: 0, inflight: null };
    }
    throw err;
  }
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

async function getNowPlaying() {
  const settings = await getSettings();
  if (!settings || !settings.enabled || !settings.url) return null;
  if (!settings.user_id) return { playing: false, source: 'musicassistant' };

  try {
    const headers = { 'Accept': 'application/json' };
    if (settings.token_encrypted) {
      headers['Authorization'] = 'Bearer ' + decrypt(settings.token_encrypted);
    }

    // Music Assistant V2 JSON RPC API
    const url = `${settings.url.replace(/\/$/, '')}/api`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 seconds timeout
    
    let playersRes, queuesRes, users;
    try {
      [playersRes, queuesRes, users] = await Promise.all([
        fetch(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: Date.now(), command: "players/all" }),
          signal: controller.signal
        }),
        fetch(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: Date.now() + 1, command: "player_queues/all" }),
          signal: controller.signal
        }),
        getUsersForSettings(settings)
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
    
    if (!playersRes.ok) throw new Error('MA HTTP ' + playersRes.status);
    
    const playersJson = await playersRes.json();
    const queuesJson = (queuesRes && queuesRes.ok) ? await queuesRes.json() : {};
    
    const playersData = playersJson.result || playersJson;
    const queuesData = queuesJson.result || queuesJson;
    
    const players = Array.isArray(playersData) ? playersData : (playersData.players || []);
    const queues = Array.isArray(queuesData) ? queuesData : (queuesData.queues || []);

    const selectedUser = users.find(user => user.user_id === String(settings.user_id));
    const allowedPlayerIds = new Set(selectedUser?.player_filter || []);
    if (!allowedPlayerIds.size) return { playing: false, source: 'musicassistant' };
    
    // Nur Player beruecksichtigen, die dem ausgewaehlten MA-Benutzer zugewiesen sind.
    const activePlayer = players.find(p =>
      allowedPlayerIds.has(String(p.player_id)) &&
      ['playing', 'PLAYING', 'paused', 'PAUSED'].includes(p.playback_state)
    );
    
    if (activePlayer && activePlayer.current_media) {
      const media = activePlayer.current_media;
      let coverUrl = media.image_url || null;
      if (coverUrl && coverUrl.startsWith('/')) {
        coverUrl = settings.url.replace(/\/$/, '') + coverUrl;
      }
      
      let bitrate = null;
      let format = null;
      
      // Versuche, zusätzliche Details aus der Queue zu lesen
      const activeQueue = queues.find(q => q.queue_id === activePlayer.active_source || q.queue_id === activePlayer.player_id);
      if (activeQueue && activeQueue.current_item && activeQueue.current_item.streamdetails && activeQueue.current_item.streamdetails.audio_format) {
        const af = activeQueue.current_item.streamdetails.audio_format;
        const rawBitrate = Number(af.bit_rate);
        if (Number.isFinite(rawBitrate) && rawBitrate > 0) {
          // Music Assistant liefert bit_rate inzwischen in kbps; alte APIs lieferten bit/s.
          bitrate = Math.round(rawBitrate > 10_000 ? rawBitrate / 1000 : rawBitrate);
        } else if (af.sample_rate && af.bit_depth) {
          // Format like "44.1 kHz / 16 bits"
          const khz = (af.sample_rate / 1000).toFixed(1).replace('.0', '');
          bitrate = `${khz} kHz / ${af.bit_depth} bits`;
        }
        if (af.content_type) format = af.content_type;
      }

      const playerIsPlaying = ['playing', 'PLAYING'].includes(activePlayer.playback_state);
      const queueIsActive = activeQueue && (
        activeQueue.queue_id === activePlayer.active_source ||
        (activePlayer.active_source == null && activeQueue.active !== false)
      );
      const queuePosition = queueIsActive
        ? correctedElapsedTime(
            activeQueue.elapsed_time,
            activeQueue.elapsed_time_last_updated,
            playerIsPlaying && (activeQueue.state == null || ['playing', 'PLAYING'].includes(activeQueue.state)),
            activeQueue.playback_speed
          )
        : null;
      const mediaPosition = correctedElapsedTime(
        media.elapsed_time,
        media.elapsed_time_last_updated,
        playerIsPlaying
      );
      const playerPosition = correctedElapsedTime(
        activePlayer.elapsed_time,
        activePlayer.elapsed_time_last_updated,
        playerIsPlaying
      );
      let position = queuePosition ?? mediaPosition ?? playerPosition ?? 0;
      let duration = media.duration || 0;
      if (duration > 0 && position > duration) {
        position = duration;
      }
      
      return {
        playing: true,
        id: media.uri,
        title: media.title || 'Unbekannt',
        artist: media.artist || '',
        album: media.album || '',
        duration: duration,
        bitrate: bitrate,
        format: format,
        position: position,
        coverUrl: coverUrl,
        paused: activePlayer.playback_state === 'paused' || activePlayer.playback_state === 'PAUSED',
        source: 'musicassistant'
      };
    }
    
    return { playing: false, source: 'musicassistant' };
  } catch (err) {
    console.error('[musicassistant] now-playing error:', err.message);
    return null; // Return null on error so fallback to Navidrome can happen
  }
}

// Ergebnis 2,5 s zwischenspeichern: Startseite (jeder Besucher alle 3 s), Admin-Vorschau,
// Musik-Verlauf und Discord-Webhook teilen sich so einen Abruf
const { shortCache } = require('./shortcache');
const getNowPlayingCached = shortCache(getNowPlaying, 2500);

module.exports = {
  getSettings,
  getAvailableUsers,
  getNowPlaying: getNowPlayingCached,
  getNowPlayingUncached: getNowPlaying
};
