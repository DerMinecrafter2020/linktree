# Navidrome API — Browser-Module

Diese Module kapseln alle Calls an die Navidrome-Edge-Function in einzelne, testbare Dateien.

## Dateien

| Datei | Funktion | Zweck |
|-------|----------|-------|
| `client.js` | `NavidromeAPI.post(path, body)` | Generischer POST-Wrapper |
| `_shared.js` | `NavidromeHelpers.safe(fn)` | try/catch-Wrapper |
| `status.js` | `NavidromeAPI.status()` | Credentials prüfen |
| `nowplaying.js` | `NavidromeAPI.nowPlaying()` | Aktueller Track |
| `control.js` | `NavidromeAPI.control(action)` | play/pause/next/previous |
| `coverart.js` | `NavidromeAPI.coverArt(id, size)` | Cover herunterladen |

## Verwendung in HTML

In dieser Reihenfolge einbinden (in `index.html` / `admin.html`):

```html
<script src="api/navidrome/_shared.js"></script>
<script src="api/navidrome/client.js"></script>
<script src="api/navidrome/status.js"></script>
<script src="api/navidrome/nowplaying.js"></script>
<script src="api/navidrome/control.js"></script>
<script src="api/navidrome/coverart.js"></script>
```

Dann im Code:
```js
const data = await NavidromeAPI.nowPlaying();
if (data?.playing) { /* Track anzeigen */ }
```

## Verwendung in Node.js (Tests)

Diese Dateien sind Browser-Module (nutzen `window`). Für Node-Tests siehe
stattdessen `api/nowplaying.js`, `api/status.js`, `api/coverart.js` im
übergeordneten `api/`-Ordner.
