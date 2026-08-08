# Supabase Client API

Alle clientseitigen Supabase-Edge-Function-Calls sind in **einem** Bundle
gbündelt: [`api/supabase.js`](../supabase.js).

## Einsatz

```html
<script src="api/supabase.js"></script>
```

## Verfügbare Funktionen

| Symbol | Zweck |
|--------|-------|
| `SupabaseHelpers.postJSON(url, headers, body)` | Generischer POST-Helper |
| `SupabaseAPI.adminProxy(payload)` | Proxy für Admin-Operationen |
| `SupabaseAPI.saveConfig(config)` | Supabase-URL + Anon-Key speichern |
| `SupabaseAPI.discordWebhook({ url, token, track, anonKey })` | Now-Playing an Discord-Webhook senden (Legacy) |

Über `adminProxy` zusätzlich verfügbar:

| Symbol | Zweck |
|--------|-------|
| `SupabaseAPI.adminProxy({ action: 'getAdminSettings' })` | Discord-Webhook-Einstig. lesen |
| `SupabaseAPI.adminProxy({ action: 'saveAdminSettings', data: settings })` | Discord-Webhook-Einstig. speichern |

## Hinweise

- Kein Caching, kein Retry, kein State – das bleibt in `supabase-client.js`.
- `adminProxy` sendet immer `Authorization: Bearer <anonKey>` und erwartet,
  dass `admin-proxy` über das mitgesendete `token` (Shared Secret) den Schreibzugriff prüft.
- Login geschieht über **nginx Basic Auth** (`/admin`, `/admin.html`).
  `api/supabase.js` enthält keinen Login mehr; das Passwort liegt nur serverseitig
  in `/etc/nginx/openweb-admin.htpasswd`.
- Für reine Discord-Webhook-Aufrufe wird bevorzugt `api/discord.js` / `window.DiscordAPI.send()` verwendet.
- Die früheren Einzeldateien (`_shared.js`, `admin-proxy.js`, `auth-login.js`,
  `auth-change-password.js`, `save-config.js`) sind entfernt und in
  `api/supabase.js` aufgegangen.