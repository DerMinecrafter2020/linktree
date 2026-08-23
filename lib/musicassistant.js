const db = require('./db');
const { decrypt } = require('./crypto');

async function getSettings() {
  const { rows } = await db.query('SELECT * FROM musicassistant_settings WHERE id = 1 LIMIT 1');
  return rows[0] || null;
}

async function getNowPlaying() {
  const settings = await getSettings();
  if (!settings || !settings.enabled || !settings.url) return null;

  try {
    const headers = { 'Accept': 'application/json' };
    if (settings.token_encrypted) {
      headers['Authorization'] = 'Bearer ' + decrypt(settings.token_encrypted);
    }

    // Music Assistant V2 JSON RPC API
    const url = `${settings.url.replace(/\/$/, '')}/api`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 seconds timeout
    
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: Date.now(), command: "players/all" }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
    
    if (!res.ok) {
      throw new Error('MA HTTP ' + res.status);
    }
    
    const json = await res.json();
    const data = json.result || json;
    const players = Array.isArray(data) ? data : (data.players || []);
    
    // Suche nach einem Player, der gerade spielt oder pausiert ist
    let activePlayer = players.find(p => p.playback_state === 'playing' || p.playback_state === 'PLAYING');
    if (!activePlayer) {
      activePlayer = players.find(p => p.playback_state === 'paused' || p.playback_state === 'PAUSED');
    }
    
    if (activePlayer && activePlayer.current_media) {
      const media = activePlayer.current_media;
      let coverUrl = media.image_url || null;
      if (coverUrl && coverUrl.startsWith('/')) {
        coverUrl = settings.url.replace(/\/$/, '') + coverUrl;
      }
      
      return {
        playing: true,
        id: media.uri,
        title: media.title || 'Unbekannt',
        artist: media.artist || '',
        album: media.album || '',
        duration: media.duration || 0,
        position: activePlayer.elapsed_time || media.elapsed_time || 0,
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

module.exports = { getSettings, getNowPlaying };
