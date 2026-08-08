# 🛡️ Security Audit Status (2026-08-01)

## ⚠️ AKUTER HINWEIS

**Die RLS-Policies in `supabase-setup.sql` sind im produktiven Supabase-Projekt NICHT aktiv.**
Ohne diese Policies kann jeder mit dem anon-Key vollen Lese-/Schreibzugriff auf die DB nehmen.

## Testergebnisse (Re-Test, 2026-08-01)

| # | Angriff | HTTP | Status |
|---|---|---|---|
| T1 | anon INSERT `links` | 201 | ❌ OFFEN |
| T2 | anon UPDATE alle `links` | 204 | ❌ OFFEN |
| T3 | anon DELETE alle `links` | 204 | ❌ OFFEN |
| T4 | anon INSERT `profile` mit id≠1 | 400 | ✅ blockiert (Singleton CHECK) |
| T5 | anon UPDATE `profile` | 204 | ❌ OFFEN |
| T6 | anon DELETE `profile` | 204 | ❌ OFFEN |
| T7 | `javascript:`-URL | 201 | ❌ OFFEN (URL-CHECK fehlt) |
| T8 | SVG-XSS in `avatar_url` | 204 | ❌ OFFEN (MIME-CHECK fehlt) |

**DB-Schaden:** 1 Link mit `javascript:alert(1)`, Profil-Zeile gelöscht.

## Was deployed IST

- ✅ Tabellenschema (`profile`, `links`, `admin_settings`)
- ✅ CHECK `profile_singleton` (id = 1)
- ✅ Realtime Publication
- ✅ Service-Role-Zugriff für Edge Functions

## Was NICHT deployed IST

- ❌ `alter table ... enable row level security`
- ❌ `create policy "profile read" / "profile write"`
- ❌ `create policy "links read" / "links insert" / "links update" / "links delete"`
- ❌ `create policy "anon deny all profile" / "anon deny all links"`
- ❌ CHECK-Constraints: `links_url_proto`, `links_*_len`, `profile_*_len`

## Sofortmaßnahmen

### 1. SQL deployen (Supabase Dashboard)

Öffne im Supabase-Dashboard deines Projekts den SQL-Editor und führe den
Inhalt von `supabase-setup.sql` aus.

URL-Muster:
```
https://app.supabase.com/project/DEIN-PROJECT-REF/sql/new
```

Ersetze `DEIN-PROJECT-REF` durch deinen tatsächlichen Projekt-Ref.

### 2. Edge Functions deployen

```bash
supabase functions deploy admin-proxy navidrome-proxy discord-webhook save-config
supabase secrets set ALLOWED_ORIGINS=http://localhost:5500,https://deine-domain.com
supabase secrets set CONFIG_SHARED_SECRET=$(openssl rand -hex 32)
```

### 3. Admin-Passwort setzen

```bash
sudo bash install.sh
# Menü: neu installieren oder Passwort ändern
```

`install.sh` erzeugt `/etc/nginx/openweb-admin.htpasswd` und konfiguriert
nginx Basic Auth für `/admin`. Das Passwort landet **nicht** in Supabase.

### 4. config.js anpassen

```js
window.SUPABASE_CONFIG = {
  url: 'https://DEIN-PROJEKT.supabase.co',
  anonKey: 'YOUR-ANON-KEY',
  adminProxyUrl: 'https://DEIN-PROJEKT.supabase.co/functions/v1/admin-proxy',
  discordWebhookUrl: 'https://DEIN-PROJEKT.supabase.co/functions/v1/discord-webhook',
};
```

Es gibt kein `authEnabled`, keine `authLoginUrl` und kein
`authChangePasswordUrl` mehr.

### 5. DB aufräumen (nach SQL-Deploy, mit service_role)

```sql
delete from public.links where url like 'javascript:%';
insert into public.profile (id, name, handle, bio, avatar) values
  (1, '@corneliusahner', 'Cornelius Ahner', 'Azubi, 21 Jahre alt', 'CA')
on conflict (id) do nothing;
```

### 6. Re-Test (gleiches Skript: `retest.bat`)

Alle Tests sollten jetzt 401/403 oder CHECK-Fehler zurückgeben.

## Client-seitige Fixes (bereits implementiert, aber ohne SQL-Policies nutzlos)

- ✅ `supabase-client.js` blockt alle Writes ohne Proxy
- ✅ `admin-proxy` hat Rate-Limit + Action-Whitelist + Size-Checks
- ✅ `app.js`/`admin.js` nutzen DOM-Construction (kein `innerHTML` mit User-Input)
- ✅ CSP: kein `unsafe-inline` in `script-src`
- ✅ Admin-Login über nginx Basic Auth — kein Passwort im Browser

Diese schützen nur, wenn zusätzlich die SQL-Policies aktiv sind.
