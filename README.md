# Link in Bio · Admin-Oberfläche

Eine komplette Link-in-Bio-Seite (à la Linktree) im **Dark & Neon**-Stil mit eigener Admin-Oberfläche.
Daten werden in **Supabase** gespeichert, mit **localStorage-Fallback** für den schnellen Einstieg.

---

## 📂 Dateien

| Datei | Zweck |
|---|---|
| `index.html` / `styles.css` / `app.js` | Öffentliche Profilseite |
| `admin.html` / `admin.css` / `admin.js` | Admin-Oberfläche (Login + Dashboard) |
| `supabase-client.js` | Gemeinsamer DB-Wrapper (Supabase + Mock) |
| `config.js` | **Hier deine Supabase-Daten eintragen** |
| `supabase-setup.sql` | SQL zum Anlegen der Tabellen |

---

## 🚀 Schnellstart (ohne Supabase)

1. Doppelklick auf `index.html` – die Seite läuft sofort mit **Beispieldaten im localStorage**.
2. Doppelklick auf `admin.html` – Login mit Standard-Passwort **`admin123`**.
3. Links hinzufügen, sortieren, exportieren, fertig.

> 💡 Standard-Passwort ändern: im Admin unter **Einstellungen → Passwort ändern**.
> Achtung: Das Passwort wird in `localStorage` gespeichert – **kein echter Schutz**!

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
In [`config.js`](config.js):

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
- 🔐 **Login** mit client-seitigem Passwort (1-h-Session)
- 🔗 **Links**: hinzufügen, bearbeiten, löschen, **drag & drop sortieren**, Pfeile
- 👤 **Profil**: Name, Handle, Bio, Avatar-Buchstaben
- 🖼 **Eigene Icons** pro Link (Emoji oder Bild-URL)
- 💾 **JSON-Export/Import** als Backup
- 🗑 **Reset** auf Auslieferungszustand
- ⚙️ **Verbindungsstatus** und Passwort-Änderung

---

## 🔒 Sicherheit

| Schutz | Wie |
|---|---|
| **Passwort-Hash** | PBKDF2 (SHA-256, 210 000 Iterationen) + zufälliger 16-Byte-Salt. Klartext liegt nirgends. |
| **Login-Sperre** | 5 Fehlversuche in 5 min → 1 min Sperre |
| **Honeypot** | Verstecktes Feld „website" — Bots werden still abgewiesen |
| **Constant-Time-Vergleich** | verhindert Timing-Attacks beim Passwort-Hash |
| **CSRF-Token** | Zufalls-Token in `sessionStorage`, bei jeder Mutation mitgesendet |
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
# 1. Login
supabase login

# 2. Funktionen deployen
supabase functions deploy admin-proxy --project-ref fxywervpqojpjwreymdp
supabase functions deploy auth-login --project-ref fxywervpqojpjwreymdp
supabase functions deploy auth-change-password --project-ref fxywervpqojpjwreymdp
supabase functions deploy navidrome-proxy --project-ref fxywervpqojpjwreymdp
supabase functions deploy discord-webhook --project-ref fxywervpqojpjwreymdp
supabase functions deploy save-config --project-ref fxywervpqojpjwreymdp

# 3. Secrets setzen (serverseitig!)
supabase secrets set SERVICE_ROLE_KEY=eyJ... --project-ref fxywervpqojpjwreymdp
supabase secrets set JWT_SECRET=$(openssl rand -base64 48) --project-ref fxywervpqojpjwreymdp
supabase secrets set ADMIN_PASSWORD=...   --project-ref fxywervpqojpjwreymdp
supabase secrets set ALLOWED_ORIGINS=https://deine-domain.de --project-ref fxywervpqojpjwreymdp
supabase secrets set CONFIG_SHARED_SECRET=$(openssl rand -hex 32) --project-ref fxywervpqojpjwreymdp
supabase secrets set NAVIDROME_URL='...' NAVIDROME_USER='...' NAVIDROME_PASS='...' --project-ref fxywervpqojpjwreymdp

# 4. URL in config.js eintragen
window.SUPABASE_CONFIG = {
  url: 'https://fxywervpqojpjwreymdp.supabase.co',
  anonKey: '...',
  authEnabled: true,
  adminProxyUrl:         'https://fxywervpqojpjwreymdp.supabase.co/functions/v1/admin-proxy',
  authLoginUrl:          'https://fxywervpqojpjwreymdp.supabase.co/functions/v1/auth-login',
  authChangePasswordUrl: 'https://fxywervpqojpjwreymdp.supabase.co/functions/v1/auth-change-password',
  discordWebhookUrl:     'https://fxywervpqojpjwreymdp.supabase.co/functions/v1/discord-webhook',
};
```

> **Hinweis:** Bei Verwendung von `install.sh` werden `save-config` und
> `CONFIG_SHARED_SECRET` automatisch angelegt. Das Secret wird in
> `/var/html/.openweb.env` gespeichert und im Admin-Panel beim ersten
> Supabase-Setup eingetragen.

### Was aktuell noch offen ist

- ❗ Login ist **client-seitig** — wer DevTools + PBKDF2-Cracker hat, kann Bruteforce versuchen. Der Salt + 210k Iterationen erschwert das aber extrem.
- ❗ Für echten Multi-User-Betrieb: Supabase Auth (Email-Login) verwenden.
- ❗ localStorage-Passwort-Hash ist nicht rotationsfähig — bei Kompromiss: Browser-Daten löschen.

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
- Die lokale `config.js` wird vor dem Update gesichert und danach wiederhergestellt.

---

Viel Spaß! 🎉
