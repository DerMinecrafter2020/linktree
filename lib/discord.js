const db = require('./db');
const { getNowPlaying } = require('./navidrome');
const fs = require('fs');
const path = require('path');

const lastTrackFile = path.join(__dirname, '..', '.last-track-id');
let lastTrackId = null;

try {
  if (fs.existsSync(lastTrackFile)) {
    lastTrackId = fs.readFileSync(lastTrackFile, 'utf8').trim();
  }
} catch (e) {
  // Ignore
}

let pollTimer = null;

function trackId(t) {
  return [t.title, t.artist, t.album].filter(Boolean).join('::');
}

async function sendDiscordWebhook(track, webhookUrl, appUrl) {
  // Zufällige Farbe generieren
  const randomColor = Math.floor(Math.random() * 16777215);

  let trackUrl = track.url || appUrl || null;
  if (track.url && !track.isRadio && track.albumId) {
    trackUrl = `${track.url.replace(/\/$/, '')}/app/#/album/${track.albumId}`;
  }

  // Datum und Uhrzeit formatieren (wie im Screenshot z.B. 12.08.2026 13:57)
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const formattedDate = `${day}.${month}.${year} ${hours}:${minutes}`;

  const embed = {
    title: track.artist || 'Unbekannt',
    description: trackUrl ? `[${track.title || 'Unbekannt'}](${trackUrl})` : (track.title || 'Unbekannt'),
    color: randomColor,
    footer: {
      text: formattedDate
    }
  };

  if (track.testCoverUrl) {
    embed.thumbnail = { url: track.testCoverUrl };
  } else if (track.coverId && appUrl) {
    const coverUrl = `${appUrl}/api/navidrome/cover-art?id=${encodeURIComponent(track.coverId)}`;
    embed.thumbnail = { url: coverUrl };
  }

  const payload = {
    content: "Es wird ein Lied abgespielt:",
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
        try {
          fs.writeFileSync(lastTrackFile, currentId, 'utf8');
        } catch (e) {
          // Ignore
        }
        await sendDiscordWebhook(track, settings.discord_webhook_url, appUrl);
      }
    } catch (err) {
      // Ignorieren, damit bei Fehlern nicht alles abstürzt
    }
  }, pollInterval);
}

module.exports = { initDiscordWebhook, sendDiscordWebhook };
