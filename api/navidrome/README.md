# Navidrome Client API

Alle clientseitigen Navidrome-Calls sind jetzt in **einem** Bundle gebündelt.

## Einsatz

```html
<script type="module" src="api/navidrome.js"></script>
```

## Verfügbare Funktionen

| Symbol | Zweck |
|--------|-------|
| `NavidromeAPI.config()` | Proxy-Konfiguration laden |
| `NavidromeAPI.post(path, body)` | Generischer POST-Wrapper |
| `NavidromeAPI.status()` | Credentials prüfen |
| `NavidromeAPI.nowPlaying()` | Aktueller Track |
| `NavidromeAPI.control(action)` | play/pause/next/previous |
| `NavidromeAPI.coverArt(id, size)` | Cover herunterladen |

## Beispiel

```js
const data = await NavidromeAPI.nowPlaying();
if (data?.playing) { /* Track anzeigen */ }
```

## Hinweise

- Das Bundle ist ein Browser-Modul und erwartet `window.NAVIDROME_CONFIG`.
- Die früheren Einzeldateien (`_shared.js`, `client.js`, `status.js`,
  `nowplaying.js`, `control.js`, `coverart.js`) sind entfernt und in
  `api/navidrome.js` aufgegangen.
