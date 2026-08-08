# OpenWeb · Link in Bio

Eine komplette Link-in-Bio-Seite (à la Linktree) im **Dark & Neon**-Stil mit eigener Admin-Oberfläche.
Daten werden in **Supabase** gespeichert und über Edge Functions geschrieben.
Für lokale Demos gibt es einen **Mock/Fallback** im Browser.

---

## 📂 Dateien

| Datei | Zweck |
|---|---|
| `index.html` / `styles.css` / `app.js` | Öffentliche Profilseite |
| `admin.html` / `admin.css` / `admin.js` | Admin-Oberfläche (Dashboard) |
| `supabase-client.js` | Gemeinsamer DB-Wrapper (Supabase + Mock) |
| `config.js` | Öffentliche Supabase-Daten (URL + anon-key) |
| `supabase-setup.sql` | SQL zum Anlegen der Tabellen |

---

## 🚀 Schnellstart (nur lokale Demo)

1. Doppelklick auf `index.html` – die Seite läuft mit **Demo-Daten im Browser**.
2. Doppelklick auf `admin.html` – ohne Server wird hier das **Setup-Formular** angezeigt.

> ⚠️ Für den Produktivbetrieb siehe die Installationsanleitung unten. `admin.html` ist
> dann über `/admin` erreichbar und durch **nginx Basic Auth** geschützt.

---

## ☁️ Mit Supabase verbinden

### 1) Supabase-Projekt anlegen
- Gehe auf [supabase.com](https://supabase.com) → **New Project**
- Notiere dir **Project URL** und **anon public key** (in *Project Settings → API*)

### 2) Tabellen anlegen
- Öffne im Supabase-Dashboard: **SQL Editor → New Query**
- Kopiere den kompletten Inhalt von [`supabase-setup.sql`](supabase-setup.sql) und führe ihn aus
- Dadurch entstehen zwei Tabellen: `profile` und `links`, inkl. RLS-Policies

### 3) Zugangsdaten eintragen
In [`config.js`](config.js) tragest du **nur** URL und anon-key ein. Admin-Schreibzugriffe
laufen über die Edge Function `admin-proxy` und ein Shared Secret (`CONFIG_SHARED_SECRET`),
das **nicht** in `config.js` liegt.

```js
window.SUPABASE_CONFIG = {
  url:    'https://DEIN-PROJEKT.supabase.co',
  anonKey: 'DEIN-ANON-PUBLIC-KEY'
};
```

Anschließend `index.html` und `admin.html` neu laden.

### 4) Realtime
Die Tabellen sind bereits in der `supabase_realtime`-Publication. Änderungen im Admin erscheinen **sofort** auf der Hauptseite – auch wenn sie in einem anderen Tab offen ist.

---

## ✨ Features

### Hauptseite
- Animierter Aurora-Hintergrund, Neon-Avatar mit rotierendem Ring
- Hover: Karte wächst auf 1.06, URL erscheint in Neon-Cyan
- Auto-Update bei Änderungen (Supabase Realtime)

### Admin
- 🔐 **Login** über **nginx Basic Auth** — Passwort liegt nur serverseitig in `/etc/nginx/openweb-admin.htpasswd`
- 🔗 **Links**: hinzufügen, bearbeiten, löschen, **drag & drop sortieren**, Pfeile
- 👤 **Profil**: Name, Handle, Bio, Avatar-Buchstaben
- 🖼 **Eigene Icons** pro Link (Emoji oder Bild-URL)
- 💾 **JSON-Export/Import** als Backup
- 🗑 **Reset** auf Auslieferungszustand
- ⚙️ **Verbindungsstatus** und Discord-Webhook-Einstellungen

---

## 🔒 Sicherheit

| Schutz | Wie |
|---|---|
| **Admin-Login** | nginx Basic Auth (`/admin`, `/admin.html`). Passwort-Hash liegt in `/etc/nginx/openweb-admin.htpasswd` (root:www-data, chmod 640). Kein Passwort in Supabase, `config.js` oder localStorage. |
| **Admin-Schreiben** | Nur über Edge Function `admin-proxy` mit `CONFIG_SHARED_SECRET` (serverseitig in `.openweb.env` und Supabase Secrets). |
| **Login-Sperre** | Keine client-seitige Sperre nötig – nginx Basic Auth handhabt Fehlversuche. |
| **Content-Security-Policy** | Meta-Tag in `index.html` und `admin.html`, inkl. `frame-ancestors 'none'` |
| **X-Content-Type-Options** | `nosniff` |
| **Referrer-Policy** | `strict-origin-when-cross-origin` |
| **Permissions-Policy** | Geo/Mikro/Kamera/Payment deaktiviert |
| **XSS-Filter** | `safeUrl()` blockiert `javascript:`/`data:`/`vbscript:`/`file:`/`about:`, `sanitizeIconField()` whitelisted `simpleicon:[a-z0-9-]{1,32}` |
| **Text-Sanitizer** | `safeText()` strippt Control-Chars, kürzt auf Feld-Max |
| **Avatar-DataURL** | Nur `data:image/*`, max 500 KB |
| **RLS (Supabase)** | Public-Read für alle, Schreiben nur via Edge-Function `admin-proxy` |
| **Service-Role-Key** | NIE im Browser — bleibt serverseitig in der Edge-Function |

### Edge-Function deployen (empfohlen für Produktion)

```bash
# 1. Login (verwendet das verlinkte Supabase-Projekt, kein --project-ref nötig)
supabase login

# 2. Funktionen deployen
supabase functions deploy admin-proxy
supabase functions deploy navidrome-proxy
supabase functions deploy discord-webhook
supabase functions deploy save-config

# 3. Secrets setzen (serverseitig!)
supabase secrets set SERVICE_ROLE_KEY=eyJ...
supabase secrets set ALLOWED_ORIGINS=https://deine-domain.de
supabase secrets set CONFIG_SHARED_SECRET=$(openssl rand -hex 32)
supabase secrets set NAVIDROME_URL='...' NAVIDROME_USER='...' NAVIDROME_PASS='...'

# 4. config.js anlegen (wird bei Verwendung von install.sh automatisch erledigt)
# Falls du manuell installierst, kopiere config.example.js nach config.js
# und trage deine Supabase-URL und deinen anon-key ein.
cp config.example.js config.js
# Bearbeite anschließend config.js und setze url/anonKey für dein Projekt.
```

> **Hinweis:** Bei Verwendung von `install.sh` werden `config.js`,
> Edge Functions und `CONFIG_SHARED_SECRET` automatisch angelegt. Das
> Secret wird in `/var/html/.openweb.env` gespeichert. Trage echte
> URLs/Keys niemals in README-Beispiele ein.

### Admin-Passwort

Das Admin-Passwort wird bei `install.sh` abgefragt und ausschließlich in
`/etc/nginx/openweb-admin.htpasswd` als Hash gespeichert. Es landet **nicht**
in Supabase, `config.js` oder `localStorage`.

Passwort ändern:

```bash
sudo bash install.sh
# Menü: „Passwort ändern“
```

### Was aktuell noch offen ist

- ❗ Für echten Multi-User-Betrieb: Supabase Auth (Email-Login) verwenden.
- ❗ Bei Kompromiss des Server-Zugriffs: `install.sh` → Passwort ändern und `.openweb.env` rotieren.

---

## 🛠 Datenmodell

**Tabelle `profile` (1 Zeile, `id = 1`)**
- `name`, `handle`, `bio`, `avatar`

**Tabelle `links`**
- `title`, `subtitle`, `url`, `icon`, `position`, `is_active`, `open_new`

**Tabelle `admin_settings` (Singleton, `id = 1`)**
- `discord_webhook_enabled` — `boolean`
- `discord_webhook_url` — verschlüsselter Webhook-URL (text)
- `discord_webhook_template` — Discord-Payload-Template (jsonb)

---

## 🔁 Updates

Falls die App bereits läuft, kannst du sie jederzeit aktualisieren:

```bash
sudo bash install.sh update
```

- Nur Anwendungsdateien werden ersetzt.
- Alle Supabase-Daten (Links, Profil, Admin-Settings) bleiben erhalten.
- Die lokale `config.js` und die serverseitige `.openweb.env` werden vor dem
  Update gesichert und danach wiederhergestellt.
- Falls `.openweb.env` noch nicht existiert, wird es automatisch aus der
  bestehenden `config.js` erzeugt und `CONFIG_SHARED_SECRET` generiert.
- Berechtigungen werden repariert (`config.js` bekommt `chmod 644`, damit
  nginx sie ausliefern kann).

Viel Spaß! 🎉
