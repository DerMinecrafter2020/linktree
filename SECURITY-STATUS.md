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

- ✅ Tabellenschema (`profile`, `links`, `admin_auth`)
- ✅ CHECK `profile_singleton` (id = 1)
- ✅ Realtime Publication
- ✅ Service-Role-Zugriff für Edge Functions

## Was NICHT deployed IST

- ❌ `alter table ... enable row level security`
- ❌ `create policy "profile read"/"profile write"`
- ❌ `create policy "links read"/"links insert"/"links update"/"links delete"`
- ❌ `create policy "anon deny all profile"/"anon deny all links"`
- ❌ CHECK-Constraints: `links_url_proto`, `links_*_len`, `profile_*_len`
- ❌ `admin_auth` Tabelle & zugehörige Edge Functions

## Sofortmaßnahmen

### 1. SQL deployen (Supabase Dashboard)
```
https://app.supabase.com/project/fxywervpqojpjwreymdp/sql/new
```
Inhalt von `supabase-setup.sql` einfügen → Run.

### 2. Edge Functions deployen
```bash
supabase functions deploy auth-init auth-login auth-change-password admin-proxy
supabase secrets set JWT_SECRET=$(openssl rand -base64 48)
supabase secrets set ALLOWED_ORIGINS=http://localhost:5500,https://deine-domain.com
```

### 3. Auth initialisieren
```bash
curl -X POST https://fxywervpqojpjwreymdp.supabase.co/functions/v1/auth-init \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d '{}'
```

### 4. config.js anpassen
```js
authEnabled: true  // war: false
```

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
- ✅ Logout löscht komplette Session

Diese schützen nur, wenn zusätzlich die SQL-Policies aktiv sind.
