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
    
    let playersRes, queuesRes;
    try {
      [playersRes, queuesRes] = await Promise.all([
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
        })
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
      
      let bitrate = null;
      let format = null;
      
      // Versuche, zusätzliche Details aus der Queue zu lesen
      const activeQueue = queues.find(q => q.queue_id === activePlayer.active_source || q.queue_id === activePlayer.player_id);
      if (activeQueue && activeQueue.current_item && activeQueue.current_item.streamdetails && activeQueue.current_item.streamdetails.audio_format) {
        const af = activeQueue.current_item.streamdetails.audio_format;
        if (af.bit_rate && af.bit_rate > 0) {
          bitrate = Math.round(af.bit_rate / 1000); 
        } else if (af.sample_rate && af.bit_depth) {
          // Format like "44.1 kHz / 16 bits"
          const khz = (af.sample_rate / 1000).toFixed(1).replace('.0', '');
          bitrate = `${khz} kHz / ${af.bit_depth} bits`;
        }
        if (af.content_type) format = af.content_type;
      }
      
      let position = (media.elapsed_time != null ? media.elapsed_time : (activeQueue ? activeQueue.elapsed_time : activePlayer.elapsed_time)) || 0;
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

module.exports = { getSettings, getNowPlaying };
