# Supabase API — Browser-Module

Diese Module kapseln die Calls an die drei Supabase Edge-Functions
(`admin-proxy`, `auth-login`, `auth-change-password`) in einzelne Dateien.

## Dateien

| Datei | Funktion | Zweck |
|-------|----------|-------|
| `_shared.js` | `SupabaseHelpers.postJSON()` | POST mit JSON-Antwort, wirft bei Fehlern |
| `admin-proxy.js` | `SupabaseAPI.adminProxy({ url, token, action, data, authEnabled, anonKey })` | DB-Mutationen |
| `auth-login.js` | `SupabaseAPI.authLogin({ url, password, honeypot, onToken })` | Login + Token speichern |
| `auth-change-password.js` | `SupabaseAPI.authChangePassword({ url, token, oldPassword, newPassword })` | PW-Änderung |

## Verwendung in HTML

```html
<script src="api/supabase/_shared.js"></script>
<script src="api/supabase/admin-proxy.js"></script>
<script src="api/supabase/auth-login.js"></script>
<script src="api/supabase/auth-change-password.js"></script>
```

Dann im Code:
```js
await SupabaseAPI.adminProxy({
  url: window.SUPABASE_CONFIG.adminProxyUrl,
  token: getToken(),
  action: 'updateProfile',
  data: profile,
  authEnabled: true,
  anonKey: window.SUPABASE_CONFIG.anonKey,
});
```

## Hinweise

- Die Module sind **dünn**: keine Caching-Logik, kein Retry, kein State.
  Caching/Token-Management bleibt im `supabase-client.js` (DB-Wrapper).
- `adminProxy` setzt `Authorization` je nach `authEnabled`: bei `true` mit dem
  User-JWT, sonst mit dem anon-Key + `token` im Body (Legacy).