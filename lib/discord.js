const db = require('./db');
const { getNowPlaying } = require('./navidrome');

let lastTrackId = null;
let pollTimer = null;

function trackId(t) {
  return [t.title, t.artist, t.album].filter(Boolean).join('::');
}

async function sendDiscordWebhook(track, webhookUrl, appUrl) {
  // Zufällige Farbe generieren (0x000000 bis 0xFFFFFF)
  const randomColor = Math.floor(Math.random() * 16777215);

  const embed = {
    author: {
      name: '🎵 Now Playing'
    },
    title: track.title || 'Unbekannt',
    url: track.url || appUrl || null,
    color: randomColor,
    timestamp: new Date().toISOString(),
    description: `**Künstler:** ${track.artist || 'Unbekannt'}${track.album ? `\n**Album:** ${track.album}` : ''}`,
  };

  if (track.coverId && appUrl) {
    const coverUrl = `${appUrl}/api/navidrome/cover-art?id=${encodeURIComponent(track.coverId)}`;
    embed.image = { url: coverUrl }; // Großes Titelbild
  }

  const payload = {
    embeds: [embed]
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error('[discord] Webhook failed:', res.status, await res.text());
    } else {
      console.log(`[discord] Gesendet: ${track.title}`);
    }
  } catch (err) {
    console.error('[discord] Webhook error:', err.message);
  }
}

function initDiscordWebhook() {
  const appUrl = process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : null;
  // Polling default 10 seconds
  const pollInterval = 10000; 

  console.log(`[discord] Webhook (Navidrome) aktiviert. Polling alle ${pollInterval}ms`);

  pollTimer = setInterval(async () => {
    try {
      const { rows } = await db.query('SELECT discord_webhook_enabled, discord_webhook_url FROM admin_settings WHERE id = 1 LIMIT 1');
      const settings = rows[0];
      if (!settings || !settings.discord_webhook_enabled || !settings.discord_webhook_url) {
        return;
      }

      const track = await getNowPlaying();
      if (!track || track.playing !== true) {
        return;
      }
      const currentId = trackId(track);
      if (lastTrackId !== currentId) {
        lastTrackId = currentId;
        await sendDiscordWebhook(track, settings.discord_webhook_url, appUrl);
      }
    } catch (err) {
      // Ignorieren, damit bei Fehlern nicht alles abstürzt
    }
  }, pollInterval);
}

module.exports = { initDiscordWebhook, sendDiscordWebhook };
