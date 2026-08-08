# Server-seitige Konfiguration: Deployment-Anleitung

Diese Anleitung beschreibt die aktuelle Architektur:

- **Admin-Login** erfolgt über **nginx Basic Auth**. Das Passwort liegt als
  Hash in `/etc/nginx/openweb-admin.htpasswd` und wird nirgendwo sonst
  gespeichert.
- Schreibzugriffe auf Supabase laufen über die Edge-Function `admin-proxy`,
  die den Service-Role-Key serverseitig nutzt.
- Konfigurationen werden in `/var/html/.openweb.env` (chmod 600) gespeichert
  und können mit `install.sh update` selbstheilend repariert werden.

---

## Architektur

```
┌──────────────┐        ┌─────────────────────┐        ┌──────────────┐
│  Browser     │  TLS   │  nginx              │        │  Supabase DB │
│  (admin.js)  │───────▶│  /admin Basic Auth  │        │  profile     │
│              │ 401/   │  htpasswd           │        │  links       │
│              │ 200    │                     │        │              │
│              │◀───────│  → admin.html       │        │              │
│              │        │                     │        │              │
│              │───────▶│  admin-proxy        │───────▶│  admin_proxy │
│              │ Bearer │  - Shared Secret    │ Service│  schreibt    │
│              │ Token  │  - JWT/Secret prüft │ Role   │  Mutationen  │
└──────────────┘        └─────────────────────┘        └──────────────┘
```

---

## Schnell-Update / Repair

Falls du von einer älteren Version kommst und `config.js` von nginx nicht
gelesen werden kann (**403**) oder `save-config` mit **401** antwortet:

```bash
cd /var/html
sudo bash install.sh update
```

Das Skript erledigt dann automatisch:

1. `.openweb.env` aus bestehender `config.js` erzeugen
2. `CONFIG_SHARED_SECRET` generieren und in Supabase setzen
3. `config.js` auf `chmod 644` setzen, damit nginx sie ausliefern kann
4. Edge Functions deployen (außer auth-init/auth-login/auth-change-password)
5. nginx-Basic-Auth-Datei (`htpasswd`) erzeugen oder erneuern

Danach steht das Shared Secret in `/var/html/.openweb.env` und wird im
Admin-Panel unter „Supabase konfigurieren" eingetragen.

---

## Voraussetzungen

- [Supabase CLI](https://supabase.com/docs/guides/cli) (`npm i -g supabase`)
- Supabase-Projekt (linkes Projekt wird automatisch verwendet; kein `<PROJECT_REF>` nötig)
- Edge Functions lokal im Verzeichnis `supabase/functions/`:
  - `admin-proxy`
  - `navidrome-proxy`
  - `discord-webhook`
  - `save-config`

> Die Edge Functions `auth-init`, `auth-login` und `auth-change-password`
> werden nicht mehr verwendet. Das Admin-Passwort liegt jetzt ausschließlich
> serverseitig in der nginx `htpasswd`.

## 1. Einmalig: SQL ausführen

Im Supabase SQL-Editor (`/dashboard/project/_/sql`) den Inhalt von
`supabase-setup.sql` ausführen. Erzeugt die Tabellen `profile`, `links` und
`admin_settings`.

## 2. Edge Functions deployen

```bash
supabase functions deploy admin-proxy
supabase functions deploy navidrome-proxy
supabase functions deploy discord-webhook
supabase functions deploy save-config
```

Optional: `install.sh` deployed diese automatisch, wenn `supabase CLI`
eingeloggt ist.

## 3. Secrets setzen

```bash
supabase secrets set SERVICE_ROLE_KEY=eyJ...      # schon bekannt
supabase secrets set ALLOWED_ORIGINS=https://deine-domain.com,http://localhost:5500
supabase secrets set CONFIG_SHARED_SECRET=$(openssl rand -hex 32)
```

`CONFIG_SHARED_SECRET` schützt die `save-config` Edge Function. Wenn du
`install.sh` nutzt, wird das Secret automatisch generiert, in
`/var/html/.openweb.env` gespeichert und im Supabase-Secret hinterlegt.
Im Admin-Panel „Supabase konfigurieren" muss es als **Shared Secret**
eingetragen werden, sonst antwortet `save-config` mit **401**.

## 4. Admin-Passwort setzen

```bash
sudo bash install.sh
```

Im Menü „neuinstallieren" oder „Passwort ändern" das gewünschte Passwort
eingeben. `install.sh` schreibt dann `/etc/nginx/openweb-admin.htpasswd`
und aktiviert `auth_basic` für `/admin` in der nginx-Konfiguration.

Standard-Benutzername ist `admin`.

## 5. Frontend aktivieren

In `config.js` (wird von `install.sh` automatisch geschrieben):

```js
window.SUPABASE_CONFIG = {
  url: 'https://DEIN-PROJEKT.supabase.co',
  anonKey: 'YOUR-ANON-KEY',
  adminProxyUrl: 'https://DEIN-PROJEKT.supabase.co/functions/v1/admin-proxy',
  discordWebhookUrl: 'https://DEIN-PROJEKT.supabase.co/functions/v1/discord-webhook',
};
```

> Kein `authEnabled`, keine `authLoginUrl`, keine `authChangePasswordUrl`,
> kein `ADMIN_DEFAULT_PASSWORD` mehr nötig.

Speichern, nginx neu laden, Browser neu laden.

## 6. Login testen

- `/admin` öffnen.
- Der Browser zeigt den nativen Basic-Auth-Dialog.
- Benutzername: `admin`, Passwort: das bei `install.sh` gesetzte.
- Nach erfolgreicher Authentifizierung wird `admin.html` ausgeliefert.

## 7. Passwort ändern

```bash
sudo bash install.sh
# Menü: „Passwort ändern"
```

`install.sh` aktualisiert `/etc/nginx/openweb-admin.htpasswd`. Es ist kein
Supabase-Update mehr nötig.

## 8. Realtime-Test

- Hauptseite (`index.html`) öffnen.
- Im Admin „Externer Link" hinzufügen.
- Innerhalb 1s erscheint er live auf der Hauptseite.

---

## Sicherheits-Checkliste

- [ ] `CONFIG_SHARED_SECRET` ist mindestens 32 Bytes zufällig (Hex).
- [ ] `ALLOWED_ORIGINS` enthält nur deine echten Domains.
- [ ] `SERVICE_ROLE_KEY` ist **niemals** im Browser-Code.
- [ ] `anonKey` darf in `config.js` stehen (public).
- [ ] `/etc/nginx/openweb-admin.htpasswd` hat `chmod 640` und gehört `root:www-data`.
- [ ] `/var/html/.openweb.env` hat `chmod 600`.
- [ ] Frontend CSP blockt `connect-src` auf Supabase-Domain.
- [ ] Kein `auth-init`, `auth-login`, `auth-change-password` mehr deployed.

## Rollback auf client-seitigen Login

Falls nginx Basic Auth doch nicht gewünscht ist:

1. `sudo rm /etc/nginx/openweb-admin.htpasswd` oder Basic-Auth-Block in
   nginx-Konfiguration auskommentieren.
2. `sudo systemctl reload nginx`

Ein vollständiger client-seitiger Login ist in dieser Version nicht mehr
vorgesehen; bei Bedarf muss er manuell wieder eingebaut werden.

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
