# Navidrome API — Lokale Test-Scripts

Lokale Node.js-Versionen der Edge-Function-Endpunkte, mit denen du die
Navidrome-Verbindung **ohne Browser** testen kannst.

## Setup

```bash
# Im Projekt-Root
npm init -y
npm install dotenv
```

Lege eine `.env`-Datei im Projekt-Root an:

```
NAVIDROME_URL=https://play.jasonstinkt.de
NAVIDROME_USER=DEIN_USERNAME
NAVIDROME_PASS=DEIN_PASSWORT
```

## Verfügbare Scripts

| Datei | Zweck |
|-------|-------|
| `api/status.js` | Testet ob Auth + URL stimmen |
| `api/nowplaying.js` | Gibt den aktuell spielenden Track aus |
| `api/coverart.js` | Lädt ein Cover-Art-Bild (usage: `node api/coverart.js <coverId> [size]`) |

## Aufruf

```bash
node api/status.js
node api/nowplaying.js
node api/coverart.js mf-abc123def 300
```

## Was beim Output wichtig ist

`status.js` sollte `ok: true` und eine `serverVersion` zeigen.

`nowplaying.js` zeigt bei pausiertem/gestopptem Player:
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
