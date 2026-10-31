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

const lastTrackFile = require('./paths').LAST_TRACK_FILE;
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
  if (track.source === 'spotify') {
    // Link direkt zum Titel in Spotify (nur open.spotify.com, siehe lib/spotify.js)
    trackUrl = track.spotifyUrl || appUrl || null;
  } else if (track.url && !track.isRadio && track.albumId) {
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
  const meta = SOURCE_META[track.source];
  if (meta) embed.author = { name: meta.name, icon_url: `${ICON_CDN}/${meta.icon}.png` };

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
      const imgRes = await fetch(track.testCoverUrl, { signal: AbortSignal.timeout(10000) });
      if (imgRes.ok) {
        const blob = await imgRes.blob();
        formData.append('file', blob, 'cover.jpg');
        embed.thumbnail = { url: 'attachment://cover.jpg' };
        useFormData = true;
      }
    } catch (e) {
      console.error('[discord] Fehler beim Laden des Test-Covers:', e.message);
    }
  } else if (track.source === 'musicassistant' && track.coverUrlInternal) {
    // Nur vom konfigurierten Music-Assistant-Server laden (gleiche Origin, keine Weiterleitungen,
    // Zeit- und Groessenlimit) – Cover-URLs aus den Metadaten werden nicht blind abgerufen
    try {
      const cover = await require('./musicassistant').fetchCurrentCover();
      if (cover) {
        const blob = new Blob([cover.body], { type: cover.contentType });
        formData.append('file', blob, 'cover.jpg');
        embed.thumbnail = { url: 'attachment://cover.jpg' };
        useFormData = true;
      }
    } catch (e) {
      console.error('[discord] Fehler beim Laden des externen Covers für Upload:', e.message);
    }
  } else if (track.source === 'spotify' && track.coverUrlInternal) {
    // Nur von i.scdn.co (https, ohne Weiterleitungen, Zeit- und Groessenlimit)
    try {
      const cover = await require('./spotify').fetchCurrentCover();
      if (cover) {
        const blob = new Blob([cover.body], { type: cover.contentType });
        formData.append('file', blob, 'cover.jpg');
        embed.thumbnail = { url: 'attachment://cover.jpg' };
        useFormData = true;
      }
    } catch (e) {
      console.error('[discord] Fehler beim Laden des Spotify-Covers für Upload:', e.message);
    }
  } else if (track.coverId) {
    try {
      const port = process.env.PORT || 3000;
      const localUrl = `http://127.0.0.1:${port}/api/navidrome/cover-art?id=${encodeURIComponent(track.coverId)}`;
      const imgRes = await fetch(localUrl, { signal: AbortSignal.timeout(10000) });
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

  console.log(`[discord] Now-Playing-Webhook aktiviert. Polling alle ${pollInterval}ms`);

  pollTimer = setInterval(async () => {
    try {
      const { rows } = await db.query('SELECT discord_webhook_enabled, discord_webhook_url FROM admin_settings WHERE id = 1 LIMIT 1');
      const settings = rows[0];
      if (!settings || !settings.discord_webhook_enabled || !settings.discord_webhook_url) {
        return;
      }

      // Gleiche Quellenauswahl wie die Startseite (Music Assistant, Spotify, Navidrome)
      const track = await getActiveTrack();

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
