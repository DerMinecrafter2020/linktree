# Plan: OpenWeb-Postgres-Rewrite mit Admin-Login

## Ziel
OpenWeb von Supabase (Browser → Supabase Edge Functions) auf ein eigenes **Node.js + PostgreSQL + Session-Auth**-Backend umbauen. Alle bestehenden UI-Features bleiben erhalten; der Admin-Bereich bekommt ein echtes **E-Mail/Passwort-Login**.

---

## Phase 1: Backend-Grundgerüst (Node.js + Express + PostgreSQL)

### Schritt 1.1: Projektstruktur anlegen
```
openweb/
├── server.js                 # Express-Server-Einstieg
├── package.json
├── .env.example
├── docker-compose.yml        # optional: Postgres-Container
├── db/
│   ├── schema.sql            # Tabellen + Trigger + Constraints
│   ├── seed.sql              # Default-User, Profil, Links
│   └── init.js               # Migration/Seeding-Helfer
├── middleware/
│   ├── auth.js               # requireAdminSession
│   └── errorHandler.js
├── routes/
│   ├── public.js             # GET /api/profile, GET /api/links
│   └── admin.js              # alle /api/admin/* Endpunkte
├── lib/
│   ├── db.js                 # pg-Pool
│   └── validation.js         # safeText, safeUrl, sanitizeIconField
└── public/                   # bestehende Frontend-Dateien
```

### Schritt 1.2: Dependencies (`package.json`)
- `express`
- `pg`
- `connect-pg-simple`
- `express-session`
- `bcrypt`
- `helmet`
- `dotenv`
- `uuid`
- Dev: `nodemon`

### Schritt 1.3: Datenbank-Schema (`db/schema.sql`)
Tabellen:
- `users` (id, email, password_hash, is_active, created_at, updated_at)
- `profile` (Singleton id=1, name, handle, bio, avatar, avatar_url, theme, updated_at)
- `links` (uuid, title, subtitle, url, icon, position, is_active, open_new, timestamps)
- `admin_settings` (Singleton id=1, admin_enabled, discord_webhook_enabled, discord_webhook_url, discord_webhook_template, updated_at)
- `navidrome_settings` (Singleton id=1, enabled boolean, url text, username text, password_encrypted text, poll_interval_sec int default 30, updated_at)
  - Das Passwort wird **AES-256-GCM** verschlüsselt in der Spalte `password_encrypted` gespeichert
  - Schlüssel liegt in `NAVIDROME_ENCRYPTION_KEY` (`.env`), niemals in der Datenbank oder im Browser
- `user_sessions` (wird von connect-pg-simple verwaltet)

Constraints:
- CHECK `id = 1` für Singletons
- Längen-Checks (wie im Original)
- URL-Protokoll-Check
- Trigger `set_updated_at()`

### Schritt 1.4: Seeding (`db/seed.sql` / `db/seed.js`)
- Default-Admin: `ADMIN_EMAIL` / gehashtes `ADMIN_PASSWORD` aus `.env`
- Default-Profil mit den aktuellen Default-Werten
- Default-Links (Instagram, GitHub, Kontakt)
- Default `admin_settings` (Admin-Bereich aktiviert)
- Default `navidrome_settings` (enabled=false, restliche Felder leer)

---

## Phase 2: Backend-API implementieren

### Öffentliche Endpunkte (`routes/public.js`)
| Route | Beschreibung |
|-------|--------------|
| `GET /api/profile` | Gibt die eine `profile`-Zeile zurück |
| `GET /api/links` | Gibt aktive Links sortiert nach `position` zurück |

### Admin-Endpunkte (`routes/admin.js`), alle hinter `requireAdminSession`
| Route | Beschreibung |
|-------|--------------|
| `POST /api/admin/login` | bcrypt-Check, Session anlegen |
| `POST /api/admin/logout` | Session zerstören |
| `GET /api/admin/me` | Aktueller User |
| `GET /api/admin/links` | Alle Links |
| `POST /api/admin/links` | Link erstellen |
| `PATCH /api/admin/links/:id` | Link aktualisieren |
| `DELETE /api/admin/links/:id` | Link löschen |
| `POST /api/admin/links/reorder` | `orderedIds[]` → positionen neu setzen |
| `GET /api/admin/profile` | Profil |
| `POST /api/admin/profile` | Profil speichern (inkl. Base64-Avatar-Validierung) |
| `GET /api/admin/settings` | Admin-Settings |
| `POST /api/admin/settings` | Admin-Settings speichern |
| `GET /api/admin/export` | JSON-Export |
| `POST /api/admin/import` | JSON-Import |
| `GET /api/admin/navidrome` | Navidrome-Settings lesen (ohne Passwort) |
| `POST /api/admin/navidrome` | Navidrome-Settings speichern (Passwort wird verschlüsselt) |
| `POST /api/admin/navidrome/test` | Testet Verbindung mit gespeicherten Credentials |

### Navidrome-Endpunkte (`routes/navidrome.js`)
| Route | Beschreibung |
|-------|--------------|
| `GET /api/navidrome/now-playing` | Aktueller Track (öffentlich, aber ohne Credentials zu leaken) |
| `POST /api/navidrome/control` | Steuerung (optional hinter Admin-Session) |
| `GET /api/navidrome/cover-art` | Cover-Art-Proxy |

### Auth-Middleware (`middleware/auth.js`)
- `requireAdminSession`: prüft `req.session.userId`
- Wenn keine Session → 401

### Session-Konfiguration
- `express-session` + `connect-pg-simple`
- `httpOnly`, `secure` in Production, `sameSite: 'lax'`
- Session-Timeout z. B. 24 Stunden

---

## Phase 3: Frontend anpassen

### Schritt 3.1: Neue API-Client-Schicht (`public/js/api-client.js`)
Ersetzt:
- `supabase-client.js`
- `api/supabase.js`
- `config.js`

Bietet:
- `getProfile()`
- `getLinks()`
- `login(email, password)`
- `logout()`
- `getAdminLinks()`, `createLink()`, `updateLink()`, `deleteLink()`, `reorderLinks()`
- `getAdminProfile()`, `saveAdminProfile()`
- `getAdminSettings()`, `saveAdminSettings()`
- `getNavidromeSettings()`, `saveNavidromeSettings({ enabled, url, username, password, pollIntervalSec })`
- `testNavidromeConnection()`
- `exportData()`, `importData()`

### Schritt 3.2: Login-Seite (`public/login.html`)
- E-Mail + Passwort-Formular
- Gleiches Dark/Neon-Design wie `admin.html`
- Bei Erfolg: redirect zu `/admin`
- Bei Fehler: Toast
- Kein Setup-Formular mehr

### Schritt 3.3: `admin.html` anpassen
- Supabase-Scripts entfernen (`config.js`, `supabase-client.js`, `api/supabase.js`)
- `api-client.js` laden
- Setup-Modal (`showSetupForm`) entfernen
- Session-Check am Anfang: wenn keine Session → redirect zu `/login`
- Logout-Button ruft `api-client.logout()` auf
- `bindLogin()` durch echten Logout ersetzen
- `browserLogout()` entfernen
- Tab **Musik**: Navidrome-Formular speichert über `saveNavidromeSettings()` in die DB; Test-Button ruft `testNavidromeConnection()` auf

### Schritt 3.4: `app.js` anpassen
- Supabase-Scripts entfernen
- `api-client.js` laden
- `window.db` durch `window.api` ersetzen
- Realtime-Subscription entfällt (kein Supabase Realtime)

### Schritt 3.5: Navidrome-API anpassen
- **Wichtig:** Navidrome-Credentials (URL, Username, Passwort) werden **ausschließlich in der PostgreSQL-Datenbank** gespeichert, nie in `localStorage`, `config.js` oder ähnlichem.
- `api/navidrome.js` spricht statt Supabase Edge Function gegen ein Backend-Proxy-Endpunkt:
  - `GET /api/navidrome/now-playing`
  - `POST /api/navidrome/control` (Body: `{ action: 'play'|'pause'|'next'|'previous' }`)
  - `GET /api/navidrome/cover-art?id=...`
- Backend-Route `routes/navidrome.js`:
  - Liest `navidrome_settings` aus der DB
  - Entschlüsselt das Passwort mit `NAVIDROME_ENCRYPTION_KEY`
  - Proxyt die Anfrage an den konfigurierten Navidrome-Subsonic-Server
  - Antwortet mit aktuellem Track, Cover-Art-URL oder Fehler
- Client (`app.js`) fragt nur den eigenen `/api/navidrome/*` Endpunkt ab; keine Credentials im Browser sichtbar

---

## Phase 4: Sicherheit & Deployment

### Schritt 4.1: Sicherheitsheaders
- `helmet()` im Server
- CSP so setzen, dass `unsafe-inline` entfällt
- Strict `Referrer-Policy`
- `X-Content-Type-Options: nosniff`

### Schritt 4.2: Input-Validierung
- Wiederverwendung der Client-Sanitizer (`safeText`, `safeUrl`, `sanitizeIconField`)
- Zusätzliche Server-Validierung:
  - `email` muss E-Mail-Format haben
  - `avatar_url` max. 500 KB Base64
  - `url` muss `http/https/mailto` sein
  - `theme` aus Whitelist
  - **Navidrome-Credentials (URL, Username, Passwort) werden niemals an den Browser ausgeliefert; sie werden serverseitig aus der DB gelesen und dort verschlüsselt gespeichert**

### Schritt 4.3: Deployment-Dateien
- `.env.example` mit allen nötigen Variablen, z. B.:
  - `NODE_ENV`, `PORT`, `SESSION_SECRET`
  - `DATABASE_URL`
  - `ADMIN_EMAIL`, `ADMIN_PASSWORD`
  - `NAVIDROME_ENCRYPTION_KEY` (32-Byte-Key für AES-256-GCM, wird bei `install.sh` generiert)
- `docker-compose.yml` (Postgres + optional app)
- `package.json` Scripts:
  - `npm run dev`
  - `npm start`
  - `npm run db:migrate`
  - `npm run db:seed`

### Schritt 4.4: Neues `install.sh` (Postgres-kompatibel)
Das bisherige `install.sh` wird komplett ersetzt durch ein Bash-Script, das OpenWeb auf einem frischen Server mit PostgreSQL aufsetzt.

**Funktionen:**
1. **System-Checks**
   - Prüft, ob `node` ≥ 18 installiert ist (sonst Hinweis/Installationsbefehl).
   - Prüft, ob `npm` vorhanden ist.
   - Prüft, ob `docker` und `docker compose` verfügbar sind (für Docker-Variante).
   - Prüft, ob `psql` verfügbar ist (für native Postgres-Variante).

2. **Interactive Konfiguration**
   - Fragt nach:
     - Datenbank-Variante: Docker-Postgres oder bestehende Postgres-URL
     - Admin-E-Mail
     - Admin-Passwort (mit Bestätigung, min. 8 Zeichen)
     - Session-Secret (generiert falls leer)
     - Port (default 3000)
     - Domain (optional für nginx/SSL)
     - Navidrome-URL, Username, Passwort (optional; Passwort wird mit `NAVIDROME_ENCRYPTION_KEY` verschlüsselt)
   - Schreibt alles in `.env`.
   - Generiert `NAVIDROME_ENCRYPTION_KEY` automatisch (32 Bytes Hex), falls nicht vorhanden.

3. **Datenbank-Setup**
   - Bei Docker: startet `docker compose up -d postgres`.
   - Wartet, bis Postgres erreichbar ist.
   - Führt `npm run db:migrate` aus.
   - Führt `npm run db:seed` aus (legt Admin-User, Profil, Links, Admin-Settings und Navidrome-Settings an).
   - Bei Navidrome-Eingaben: Seed-Script verschlüsselt das Passwort mit `NAVIDROME_ENCRYPTION_KEY` und speichert es in `navidrome_settings`.

4. **App-Start**
   - `npm install`.
   - Optional: baut die App nicht, weil es keine Build-Schritt gibt (reines Node/Static).
   - Startet Server mit `npm start` oder richtet systemd-Service ein.

5. **Reverse Proxy (optional)**
   - Wenn Domain angegeben: erzeugt nginx-Config-Template für Port 80 → 3000.
   - Optional Let's Encrypt mit `certbot` (nur wenn bestätigt).

6. **Weitere Aktionen**
   - `install.sh update`: aktualisiert Code, behält `.env` und DB bei.
   - `install.sh change-password`: ändert Admin-Passwort in der DB.
   - `install.sh change-navidrome`: ändert Navidrome-Credentials in der DB.
   - `install.sh reset-db`: setzt DB auf Seed-Zustand zurück (nach Bestätigung).
   - `install.sh logs`: zeigt PM2/systemd-Logs.

**Ablauf im Normalfall:**
```bash
bash install.sh
# → Datenbank wählen
# → Admin-E-Mail/Passwort eingeben
# → Session-Secret + Encryption-Key generieren
# → Navidrome-Credentials optional eingeben
# → npm install
# → DB starten + migrieren + seeden (inkl. verschlüsseltem Navidrome-Passwort)
# → Server starten
```

### Schritt 4.5: Dateien löschen/ersetzen
Löschen/umbenennen:
- `supabase-client.js`
- `api/supabase.js`
- `config.js`
- `supabase-setup.sql`
- `config.example.js`
- `install.sh` (stark vereinfachen oder löschen)
- `check-admin-security.sh`
- `supabase/`-Ordner

---

## Phase 5: Tests & Qualitätssicherung

### Manuelle Tests
1. `docker compose up` startet Postgres.
2. `npm run db:migrate && npm run db:seed`.
3. `npm run dev` startet Server.
4. `index.html` zeigt Default-Profil + Links.
5. `/login.html` → Login mit `.env`-Credentials → redirect zu `/admin`.
6. Links CRUD, Sortierung, Profil speichern, Avatar-Upload.
7. Export/Import/Reset.
8. Logout funktioniert und schützt `/admin`.
9. Direkter API-Zugriff ohne Session wird mit 401 abgelehnt.

### Code-Qualität
- `server.js` zentraler Einstieg
- Klare Trennung Routes / Middleware / DB
- Keine Secrets im Client
- Keine inline-Scripts, CSP-konform

---

## Erwartetes Ergebnis

OpenWeb läuft komplett ohne Supabase:
- Öffentliche Seite zeigt Profil/Links aus lokaler Postgres.
- Admin-Login per E-Mail/Passwort mit Session-Cookie.
- Alle bestehenden Features (Links, Profil, Icons, Avatar, Navidrome, Export/Import, Reset) funktionieren weiterhin.
- Keine Supabase-Keys, Edge Functions oder nginx Basic Auth nötig.
- Einfacheres lokales Deployment via Docker Compose.
