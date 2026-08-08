# Server-side Auth: Deployment-Anleitung

Diese Anleitung aktiviert die **serverseitige Passwort-Verifizierung** über
Supabase Edge Functions. Aktuell läuft alles im **client-seitigen Fallback**
(PBKDF2-Hash in `localStorage`) — das ist okay, aber das Passwort-Hash wäre
im DevTools auslesbar.

Mit Edge-Function-Auth ist das Passwort **nirgendwo im Browser** gespeichert.
Beim Login wird das Klartext-Passwort per TLS zum Edge-Function-Call
geschickt, dort gegen den DB-Hash verifiziert, und die App bekommt ein
**signiertes JWT (HS256, 1h TTL)** zurück.

---

## Architektur

```
┌──────────────┐        ┌─────────────────────┐        ┌──────────────┐
│  Browser     │  TLS   │  Edge Function     │        │  Supabase DB │
│  (admin.js)  │───────▶│  auth-login         │───────▶│  admin_auth  │
│              │  1.0s  │  - PBKDF2 verify    │  React │  (hash+salt) │
│              │        │  - HMAC-SHA256 JWT  │        │              │
│              │        │  - 1h TTL           │        │              │
│              │◀───────│  → JWT              │        │              │
│              │  JWT   │                     │        │              │
│              │  Bearer│  admin-proxy        │───────▶│  profile     │
│              │───────▶│  - JWT verify       │  React │  links       │
│              │  TTL   │  - validation       │        │              │
└──────────────┘        └─────────────────────┘        └──────────────┘
```

---

## Voraussetzungen

- [Supabase CLI](https://supabase.com/docs/guides/cli) (`npm i -g supabase`)
- Supabase-Projekt (existiert bereits: `fxywervpqojpjwreymdp`)
- 3 Edge Functions lokal im Verzeichnis `supabase/functions/`:
  - `auth-init` (bereits im Workspace angelegt)
  - `auth-login` (bereits im Workspace angelegt)
  - `auth-change-password` (bereits im Workspace angelegt)
  - `admin-proxy` (bereits im Workspace angelegt)

## 1. Einmalig: SQL ausführen

Im Supabase SQL-Editor (`/dashboard/project/_/sql`) den Inhalt von
`supabase-setup.sql` ausführen. Erzeugt die `admin_auth`-Tabelle mit
einem **Platzhalter-Hash** (nicht das echte Password).

## 2. Edge Functions deployen

```bash
supabase functions deploy auth-init
supabase functions deploy auth-login
supabase functions deploy auth-change-password
supabase functions deploy admin-proxy
supabase functions deploy navidrome-proxy
supabase functions deploy discord-webhook
```

Optional: `install.sh` deployed diese automatisch, wenn `supabase CLI` eingeloggt ist.

## 3. Secrets setzen

```bash
supabase secrets set SERVICE_ROLE_KEY=eyJ...      # schon bekannt
supabase secrets set JWT_SECRET=$(openssl rand -base64 48)
supabase secrets set ALLOWED_ORIGINS=https://deine-domain.com,http://localhost:5500
```

`JWT_SECRET` MUSS mindestens 32 Bytes (Base64) lang sein. Er wird für
HS256-Signaturen verwendet — ändere ihn regelmäßig; alte JWTs werden
danach ungültig (und die User müssen sich neu einloggen).

## 4. Init: Default-Passwort hashen

```bash
curl -X POST https://fxywervpqojpjwreymdp.supabase.co/functions/v1/auth-init \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Antwort:
```json
{ "ok": true, "message": "initialized", "algo": "PBKDF2-SHA256", "iterations": 210000 }
```

Falls bereits initialisiert (409): erst mit `delete from admin_auth where id=1;`
(per Service-Role) zurücksetzen, dann Schritt 4 erneut.

## 5. Frontend aktivieren

In `config.js`:

```js
authEnabled: true,  // war vorher false
```

Speichern, Browser neu laden.

## 6. Login testen

- `admin.html` öffnen
- Passwort `admin123` eingeben → JWT wird im `sessionStorage` unter
  `admin-token` abgelegt, Ablaufzeit in `admin-token-exp`
- Im Supabase-Log (`Edge Functions → auth-login`) taucht ein Request mit
  der Remote-IP auf
- Falsches Passwort → 401, `Falsches Passwort` im UI

## 7. Passwort ändern

Im Admin unter **Einstellungen → 🔑 Passwort ändern**:
- "Aktuelles Passwort" + "Neues Passwort" eingeben
- Speichern → Edge-Function `auth-change-password` rotiert Hash + Salt
  in `admin_auth`, behält die `iterations`

## 8. Realtime-Test

- Hauptseite (`index.html`) öffnen
- Im Admin "Externer Link" hinzufügen
- Innerhalb 1s erscheint er live auf der Hauptseite
- Wird mit JWT von `admin-proxy` via Service-Role geschrieben

---

## Sicherheits-Checkliste

- [ ] `JWT_SECRET` ist mindestens 32 Bytes zufällig
- [ ] `ALLOWED_ORIGINS` enthält nur deine echten Domains
- [ ] `SERVICE_ROLE_KEY` ist **niemals** im Browser-Code
- [ ] `anonKey` darf in `config.js` stehen (public)
- [ ] `admin_auth` RLS-Policy ist aktiv (`deny all`)
- [ ] Frontend CSP blockt `connect-src` auf Supabase-Domain
- [ ] Browser-Login in DevTools geprüft: `admin-token` enthält JWT,
      `admin-token-exp` = Unix-Timestamp, kein `localStorage`-Hash mehr
- [ ] SQL: `select * from admin_auth;` als anon → 0 Zeilen

## Rollback

Falls Edge-Functions Ärger machen:

1. `config.js` → `authEnabled: false` setzen
2. Browser neu laden → fällt zurück auf PBKDF2-`localStorage`-Login
3. **Wichtig**: nachdem Edge-Functions wieder gehen, ist der Hash in
   `admin_auth` evtl. nicht synchron mit dem `localStorage`-Hash. In
   Edge-Function `auth-init` einmal mit einem bekannten Passwort neu
   initialisieren.

## Tabellen-Schema (`admin_auth`)

| Spalte          | Typ           | Beschreibung |
|-----------------|---------------|--------------|
| `id`            | `int`         | Primary key, immer `1` (Singleton) |
| `algo`          | `text`        | Algorithmus, z. B. `PBKDF2-SHA256` |
| `iterations`    | `int`         | OWASP 2023: 210000 |
| `salt`          | `text`        | Base64-16-Bytes, per Rotation neu |
| `password_hash` | `text`        | Base64-32-Bytes (= PBKDF2-Output) |
| `updated_at`    | `timestamptz` | Auto-set bei jeder Änderung |

## JWT-Payload

```json
{
  "sub": "admin",
  "role": "admin",
  "iat": 1700000000,
  "exp": 1700003600,
  "jti": "uuid-v4"
}
```

- `sub`: Subject-Identifier (immer „admin")
- `role`: Wird in `admin-proxy` geprüft (`payload.role === 'admin'`)
- `exp`: Unix-Sekunden, Edge-Function lehnt abgelaufene Tokens ab
- `jti`: Eindeutige ID, präventiv für zukünftige Token-Revocation-Listen
## Discord Now-Playing Webhook

### Voraussetzungen
- Navidrome-Player ist aktiviert und erreichbar.
- Ein Discord-Kanal-Webhook (Server-Einstellungen → Integrationen → Webhooks).

### Migration anwenden
Führe im Supabase SQL-Editor den Inhalt von
`supabase/migrations/0004_discord_webhook.sql` aus. Erzeugt die Tabelle
`public.admin_settings` mit RLS, damit der Webhook-URL nur von
serverseitigen Edge Functions gelesen werden kann.

### Edge Function
```bash
supabase functions deploy discord-webhook
```

### Admin-Panel konfigurieren
1. `admin.html` öffnen → Tab **Musik**.
2. Discord-Webhook aktivieren.
3. Discord-Webhook-URL einfügen.
4. (Optional) JSON-Template anpassen. Verfügbare Variablen:
   - `{{title}}` — Titel
   - `{{artist}}` — Interpret
   - `{{album}}` — Album
   - `{{duration}}` — Dauer als Text
   - `{{coverArt}}` — Cover-Art-URL
   - `{{playerUrl}}` — Link zum Navidrome-Player
5. **Speichern**, dann **Testen**.

### Sicherheit
- Der Webhook-URL wird **niemals** an den Browser ausgeliefert.
- `admin_settings` blockt Lesezugriff für `anon` und `authenticated`.
- Nur `discord-webhook` (mit `service_role`) darf die URL lesen und an Discord weitergeben.
- Test-Nachrichten werden über `admin-proxy` + `discord-webhook` versendet, nicht clientseitig.