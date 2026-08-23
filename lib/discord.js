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

  // Datum und Uhrzeit formatieren (Europe/Berlin Zeitzone erzwingen)
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  let day, month, year, hour, minute;
  for (const p of parts) {
    if (p.type === 'day') day = p.value;
    if (p.type === 'month') month = p.value;
    if (p.type === 'year') year = p.value;
    if (p.type === 'hour') hour = p.value;
    if (p.type === 'minute') minute = p.value;
  }
  const formattedDate = `${day}.${month}.${year} ${hour}:${minute}`;

  const embed = {
    title: track.artist || 'Unbekannt',
    description: trackUrl ? `[${track.title || 'Unbekannt'}](${trackUrl})` : (track.title || 'Unbekannt'),
    color: randomColor,
    footer: {
      text: formattedDate
    }
  };

  const extraInfo = [];
  if (track.format) extraInfo.push(track.format.toUpperCase());
  if (track.bitrate) {
    extraInfo.push(typeof track.bitrate === 'number' ? `${track.bitrate} kbps` : track.bitrate);
  }
  if (extraInfo.length > 0) {
    embed.description += `\n\n\`${extraInfo.join(' • ')}\``;
  }

  let useFormData = false;
  const formData = new FormData();

  if (track.testCoverUrl) {
    try {
      const imgRes = await fetch(track.testCoverUrl);
      if (imgRes.ok) {
        const blob = await imgRes.blob();
        formData.append('file', blob, 'cover.jpg');
        embed.thumbnail = { url: 'attachment://cover.jpg' };
        useFormData = true;
      }
    } catch (e) {
      console.error('[discord] Fehler beim Laden des Test-Covers:', e.message);
    }
  } else if (track.coverUrl && track.coverUrl.startsWith('http')) {
    try {
      const imgRes = await fetch(track.coverUrl);
      if (imgRes.ok) {
        const blob = await imgRes.blob();
        formData.append('file', blob, 'cover.jpg');
        embed.thumbnail = { url: 'attachment://cover.jpg' };
        useFormData = true;
      }
    } catch (e) {
      console.error('[discord] Fehler beim Laden des externen Covers für Upload:', e.message);
    }
  } else if (track.coverId) {
    try {
      const port = process.env.PORT || 3000;
      const localUrl = `http://127.0.0.1:${port}/api/navidrome/cover-art?id=${encodeURIComponent(track.coverId)}`;
      const imgRes = await fetch(localUrl);
      if (imgRes.ok) {
        const blob = await imgRes.blob();
        formData.append('file', blob, 'cover.jpg');
        embed.thumbnail = { url: 'attachment://cover.jpg' };
        useFormData = true;
      }
    } catch (e) {
      console.error('[discord] Fehler beim Laden des Covers für Upload:', e.message);
    }
  }

  const payload = {
    content: "Es wird ein Lied abgespielt:",
    embeds: [embed]
  };

  try {
    let fetchOpts = { method: 'POST' };
    if (useFormData) {
      formData.append('payload_json', JSON.stringify(payload));
      fetchOpts.body = formData;
    } else {
      fetchOpts.headers = { 'Content-Type': 'application/json' };
      fetchOpts.body = JSON.stringify(payload);
    }

    const res = await fetch(webhookUrl, fetchOpts);
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

      let track = null;
      try {
        const { getNowPlaying: getMAPlaying } = require('./musicassistant');
        track = await getMAPlaying();
      } catch (e) {}
      
      if (!track || track.playing !== true) {
        const { getNowPlaying: getNavidromePlaying } = require('./navidrome');
        track = await getNavidromePlaying();
      }

      if (!track || track.playing !== true || track.paused) {
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
