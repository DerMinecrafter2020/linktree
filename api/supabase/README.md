# Supabase Client API

Alle clientseitigen Supabase-Calls sind jetzt in **einem** Bundle gebündelt.

## Einsatz

```html
<script type="module" src="api/supabase.js"></script>
```

## Verfügbare Funktionen

| Symbol | Zweck |
|--------|-------|
| `SupabaseHelpers.postJSON(url, body, token)` | Generischer POST-Helper |
| `SupabaseAPI.adminProxy(payload)` | Proxy für Admin-Operationen |
| `SupabaseAPI.authLogin(email, password)` | Login |
| `SupabaseAPI.authChangePassword(newPassword, token)` | Passwort ändern |
| `SupabaseAPI.saveConfig(config)` | Einstellungen speichern |

## Hinweise

- Kein Caching, kein Retry, kein State – das bleibt in `supabase-client.js`.
- `adminProxy` setzt `Authorization` je nach `authEnabled`: bei `true` mit dem
  User-JWT, sonst mit dem anon-Key + `token` im Body (Legacy).
- Die früheren Einzeldateien (`_shared.js`, `admin-proxy.js`, `auth-login.js`,
  `auth-change-password.js`, `save-config.js`) sind entfernt und in
  `api/supabase.js` aufgegangen.