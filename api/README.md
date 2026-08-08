# Browser-API Bundles

Dieses Verzeichnis enthält die clientseitigen API-Bundles, die von
`index.html` und `admin.html` geladen werden:

| Datei | Zweck | Globales Objekt |
|-------|-------|-----------------|
| `api/supabase.js` | Supabase Edge-Function Aufrufe (Login, Admin-Proxy, Config-Save, Discord) | `window.SupabaseAPI` |
| `api/navidrome.js` | Navidrome / Subsonic Player-API (Status, Now Playing, Steuerung, Cover-Art) | `window.NavidromeAPI` |
| `api/discord.js` | Discord Webhook für Now-Playing | `window.DiscordAPI` |

## Einsatz

```html
<script src="api/supabase.js"></script>
<script src="api/navidrome.js"></script>
<script src="api/discord.js"></script>
```

## Navidrome — Lokale Test-Scripts

Für lokale Tests ohne Browser stehen zusätzlich Node.js-Scripts bereit:

### Setup

```bash
npm init -y
npm install dotenv
```

`.env` im Projekt-Root:

```
NAVIDROME_URL=https://navidrome.example.com
NAVIDROME_USER=DEIN_USERNAME
NAVIDROME_PASS=DEIN_PASSWORT
```

### Verfügbare Scripts

| Datei | Zweck |
|-------|-------|
| `api/status.js` | Testet ob Auth + URL stimmen |
| `api/nowplaying.js` | Gibt den aktuell spielenden Track aus |
| `api/coverart.js` | Lädt ein Cover-Art-Bild (`node api/coverart.js <coverId> [size]`) |

### Aufruf

```bash
node api/status.js
node api/nowplaying.js
node api/coverart.js mf-abc123def 300
```

### Beispiel-Output

`status.js` sollte `ok: true` und eine `serverVersion` zeigen.

`nowplaying.js` bei pausiertem Player:
```json
{
  "playing": false,
  "reason": "state=paused minutesAgo=14"
}
```

Bei aktivem Player:
```json
{
  "playing": true,
  "title": "HEY!",
  "artist": "Tommy Fieber, Malle Max, DJ OYU",
  "position": 14,
  "duration": 135,
  "coverArt": "mf-..."
}
```

## Discord Webhook

`api/discord.js` stellt bereit:

```js
await window.DiscordAPI.send({
  title: 'Songtitel',
  artist: 'Künstler',
  album: 'Album',
  cover: 'https://...cover.jpg',
  url: 'https://...player-link'
});
```

Voraussetzungen:
- `window.SUPABASE_CONFIG.discordWebhookUrl` muss auf `…/functions/v1/discord-webhook` zeigen.
- Die Edge-Function `discord-webhook` muss deployed sein.
- Die Tabelle `admin_settings` muss über Migration `0004_discord_webhook.sql` angelegt sein.
- Webhook-URL und Template werden im Admin-Panel unter **Musik** konfiguriert.
