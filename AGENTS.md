# AGENTS.md — Leitfaden für KI-Agenten & Entwickler

Diese Datei beschreibt Aufbau, Regeln und Arbeitsabläufe von **OpenWeb**. Sie richtet sich an
KI-Coding-Agenten (Claude Code, Codex, Cursor, Copilot …) und an Menschen, die am Projekt arbeiten.
**Vor jeder Änderung lesen und die Regeln unten einhalten.**

---

## 1. Projektüberblick

OpenWeb ist eine selbst gehostete **Link-in-Bio-Seite** (à la Linktree) im Dark-&-Neon-Stil mit
Admin-Oberfläche, Klick-Statistiken und Musik-Integration („Now Playing“ über Navidrome/Subsonic
oder Music Assistant, inkl. Discord-Webhook und Musik-Verlauf).

| Bereich   | Technik |
|-----------|---------|
| Backend   | Node.js ≥ 18 (Docker: Node 20), Express 4 |
| Datenbank | PostgreSQL 16, Treiber `pg` (nur parametrisierte Queries) |
| Sessions  | `express-session` + `connect-pg-simple` (Tabelle `user_sessions`) |
| Auth      | E-Mail + Passwort (bcrypt, 12 Runden), 2FA per TOTP (`otplib` v13) und WebAuthn/Passkeys (`@simplewebauthn/server` v13, Browser-Bundle v9.0.1 per CDN mit SRI) |
| Frontend  | Vanilla HTML/CSS/JS, **keine Frameworks, kein Build-Schritt** |
| Sicherheit| `helmet` (CSP), `express-rate-limit`, eigene Validatoren, AES-256-GCM für gespeicherte Secrets |

Autor: Cornelius Ahner · Lizenz: MIT · Sprache der UI, Kommentare und Doku: **Deutsch**.

---

## 2. Verzeichnisstruktur

```
server.js                 Einstiegspunkt: Middleware, Setup-Modus, Routen, Cronjobs
routes/
  public.js               Öffentliche API (/api/...): Profil, Links, Klicks, Icons, QR, Login + 2FA-Login
  admin.js                Admin-API (/api/admin/...), komplett hinter requireAdminSession
  navidrome.js            /api/navidrome: Now-Playing + Cover-Proxy (öffentlich), /control (Admin)
  api/status.js           /api/status/now-playing (Music Assistant → Navidrome-Fallback)
  setup.js                /api/setup (nur im Setup-Modus aktiv)
lib/
  auth.js                 bcrypt, requireAdminSession, IP-Allowlist (IPv4/CIDR)
  crypto.js               AES-256-GCM encrypt/decrypt/isEncrypted (Key: NAVIDROME_ENCRYPTION_KEY)
  totp.js                 TOTP-Helfer (otplib v13, ±30 s, Replay-Schutz über afterTimeStep)
  validators.js           Serverseitige Eingabeprüfung (safeText, safeUrl, validateEmail, …)
  db.js                   pg-Pool, query(), transaction()
  setup.js                Erkennung/Durchführung des Initial-Setups, schreibt .env
  audit.js                Audit-Log für Admin-Aktionen
  alert.js                Benachrichtigungen (Webhook / SMTP) bei Login, Passwortwechsel, Backup-Fehler
  backup.js               Tägliche JSON-Backups nach ./backups (Rechte 600)
  maintenance.js          Aufräumen alter Sessions / Klickdaten (DATA_RETENTION_DAYS)
  navidrome.js            Subsonic-API-Client inkl. Radiosender-Erkennung
  musicassistant.js       Music-Assistant-API-Client
  discord.js              „Now Playing“-Discord-Webhook (Polling alle 10 s)
  analytics.js            User-Agent-/Länder-Parsing für Statistiken
db/
  migrate.js              Führt db/migrations/*.sql der Reihe nach aus (Tabelle `migrations`)
  migrations/NNN_*.sql    Schema-Migrationen (fortlaufend nummeriert, nie nachträglich ändern)
  seed.js / reset.js      Initialdaten / Datenbank leeren
public/                   Statische Dateien (werden 1:1 ausgeliefert!)
  index.html, admin.html, login.html, setup.html, changelog.html, impressum.html, datenschutz.html …
  js/api-client.js        window.api – einziger Weg, wie das Frontend das Backend aufruft
  js/app.js               Öffentliche Seite
  js/admin.js             Admin-Oberfläche (eine große IIFE)
  js/login.js             Login-Seite inkl. TOTP/WebAuthn
  js/sw-register*.js      Service-Worker-Registrierung
  sw.js                   Service Worker (Network-First, cached nie /api/)
scripts/bump-version.sh   Versionserhöhung (siehe Abschnitt 8)
.githooks/pre-commit      Automatische Patch-Erhöhung bei jedem Code-Commit
install.sh                Interaktive Installation auf Linux (systemd, nginx, Docker-DB)
Dockerfile, docker-compose.yml, .dockerignore, nginx-lb.conf.example
```

---

## 3. Befehle

| Zweck | Befehl |
|-------|--------|
| Abhängigkeiten installieren | `npm install` (aktualisiert auch `package-lock.json`) |
| Server starten | `npm start` |
| Entwicklung mit Auto-Reload | `npm run dev` (nodemon) |
| Migrationen ausführen | `npm run db:migrate` (läuft auch automatisch beim Serverstart) |
| Seed / Reset | `npm run db:seed` / `npm run db:reset` |
| Version erhöhen | `npm run version:patch` / `version:minor` / `version:major` |
| Git-Hook aktivieren | `npm run hooks:install` (einmalig pro Klon) |
| Docker | `docker compose up -d` |
| Linux-Installation | `bash install.sh` (`update`, `change-password`, `reset-db`, `logs`) |

**Tests:** Es gibt keine automatisierten Tests (`npm test` ist ein Platzhalter). Änderungen daher
manuell im Browser prüfen – besonders Login (Passwort, TOTP, WebAuthn) und Admin-Funktionen.

---

## 4. Konfiguration (Umgebungsvariablen)

Vorlage: `.env.example`. Die `.env` enthält Secrets → **niemals committen, loggen oder ausgeben**
(ist in `.gitignore` und `.dockerignore`).

| Variable | Pflicht | Bedeutung |
|----------|---------|-----------|
| `NODE_ENV` | – | Standard **`production`** (sichere Voreinstellung). Nur lokal `development` setzen. |
| `PORT` | – | Standard 3000 |
| `APP_URL`, `PUBLIC_DOMAIN` | – | Öffentliche URL/Domain (Sitemap, OG-Tags, erlaubte Origins für CSRF-Prüfung) |
| `DATABASE_URL` | ja* | PostgreSQL-URL (*alternativ `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`) |
| `POSTGRES_PASSWORD` | Docker | Passwort des Postgres-Containers (muss zu `DATABASE_URL` passen) |
| `SESSION_SECRET` | ja | Zufälliger 64-Hex-Wert, Server startet sonst nicht |
| `SESSION_MAX_AGE_MS` | – | Session-Dauer (Standard 24 h; „Angemeldet bleiben“ = 30 Tage) |
| `NAVIDROME_ENCRYPTION_KEY` | ja | 32 Byte Hex – verschlüsselt Navidrome-Passwort, MA-Token und SMTP-Passwort in der DB |
| `ADMIN_EMAIL` | – | E-Mail des initialen Admins (Seeding) |
| `ADMIN_PASSWORD`, `NAVIDROME_PASSWORD` | – | **Nur für das Seeding**, danach aus der `.env` entfernen |
| `NAVIDROME_URL`, `NAVIDROME_USERNAME`, `NAVIDROME_POLL_INTERVAL_SEC` | – | Initiale Navidrome-Daten (Seeding) |
| `ADMIN_IP_ALLOWLIST` | – | Kommagetrennte IPv4-Adressen/CIDR für Admin-Zugang (leer = alle) |
| `TRUST_PROXY` | – | Anzahl vorgeschalteter Proxys (Standard 1). **Ohne Proxy `0` setzen**, sonst ist die Client-IP fälschbar |
| `DATA_RETENTION_DAYS` | – | Aufbewahrung von Klickdaten (Standard 365) |
| `BACKUP_DIR` | – | Zielordner für Backups (Standard `./backups`) |

---

## 5. Architektur – wichtige Abläufe

**Start (`server.js` → `finalizeApp`)**
1. `lib/setup.isSetupRequired()`: Setup nötig, wenn keine `DATABASE_URL` konfiguriert ist oder
   noch kein aktiver Admin existiert. Ist die DB **nicht erreichbar**, wird 10× im Abstand von 3 s
   neu versucht und dann beendet – **niemals** in den öffentlichen Setup-Modus wechseln.
2. Setup-Modus: nur `/api/setup` + `setup.html`; nach erfolgreichem Setup beendet sich der Prozess
   (systemd/Docker startet neu).
3. Normalbetrieb: Migrationen → Session-Middleware → Rate-Limits → Routen → Cronjobs (Backup +
   Wartung täglich 03:00, Musik-Verlauf alle 15 s, Discord-Polling alle 10 s).

**Middleware-Reihenfolge (relevant für Sicherheit)**
Health-Check → Helmet/CSP + Security-Header → `/admin.html`-Redirect → CSRF-Origin-Prüfung für
`/api` (nicht GET/HEAD/OPTIONS) → `express.static(public)` → Body-Parser (1 MB) → Rate-Limits →
(nach Setup-Prüfung) Session → Limits für Public/Admin → `Cache-Control: no-store` für
`/api/admin` + `/api/login` → Router → 404 → Error-Handler.

**Login-Ablauf (`routes/public.js`)**
`POST /api/login` → Passwort prüfen (oder passwortlos, wenn WebAuthn-Key vorhanden) → ist 2FA
aktiv, wird eine neue Session mit `pendingUserId` erzeugt → `POST /api/login/totp` bzw.
`/api/login/webauthn/options` + `/verify` → `completeLogin()` erzeugt erneut eine **neue
Session-ID** mit `userId`. Der Fehlversuchszähler wird erst nach vollständigem Login zurückgesetzt.

**Admin-Schutz:** `routes/admin.js` nutzt `router.use(requireAdminSession)`: Session vorhanden,
IP erlaubt, Benutzer existiert und ist aktiv. Neue Admin-Endpunkte gehören **immer** in diesen
Router.

**Passwortgeschützte Links:** Die Ziel-URL wird öffentlich **nie** ausgeliefert (`url: null` in
`/api/links`, kein Kurzlink `/go/:slug`, nicht in der Sitemap) – nur über
`POST /api/links/:id/unlock` nach Passwortprüfung.

---

## 6. Sicherheitsregeln (verbindlich)

1. **SQL:** ausschließlich parametrisierte Queries (`$1, $2 …`). Dynamisch zusammengesetzt werden
   dürfen nur feste, im Code definierte Spaltennamen – nie Benutzereingaben.
2. **Eingaben** serverseitig mit `lib/validators.js` prüfen (Texte kürzen, URLs nur http/https/mailto,
   E-Mails validieren, IDs per `router.param` prüfen). Client-Validierung zählt nicht.
3. **XSS:** Im Frontend Inhalte per `textContent` / `createElement` setzen. Wenn `innerHTML` nötig
   ist, **jeden** dynamischen Wert mit `escapeHtml()` escapen. Links immer durch `safeUrl()`.
   Serverseitig in HTML nur mit `escapeHtml()` und bei `String.replace` immer eine
   **Replacer-Funktion** verwenden (`$&`/`$1` in Nutzerdaten sonst aktiv).
4. **CSP ohne `'unsafe-inline'` für Skripte:** Keine Inline-`<script>`-Blöcke und keine
   `onclick=`-Attribute. JavaScript immer als eigene Datei unter `public/js/`. Externe Skripte nur
   mit `integrity`-Hash (SRI) und `crossorigin="anonymous"`.
5. **Secrets:** Passwörter nur als bcrypt-Hash; API-Keys nur gehasht (Klartext wird einmalig
   angezeigt); Zugangsdaten zu Fremddiensten (Navidrome, Music Assistant, SMTP) nur mit
   `lib/crypto.encrypt()` speichern und **nie** an den Client zurückgeben. Keine Secrets loggen.
6. **Auth-Änderungen:** Sensible Kontoänderungen (2FA deaktivieren, Schlüssel löschen) verlangen das
   aktuelle Passwort (`checkCurrentPassword`). Nach Login immer `req.session.regenerate()`.
7. **Fehlermeldungen:** Im Produktionsmodus keine internen Details (`err.message`, Stacktraces) an
   öffentliche Clients senden.
8. **Neue öffentliche Endpunkte** brauchen eine Begründung, Eingabeprüfung und ggf. eigenes
   Rate-Limit. Zustandsändernde Endpunkte sind POST/PATCH/PUT/DELETE (CSRF-Prüfung greift nur dort).
9. **Proxys auf Fremd-Inhalte** (Cover, Icons) nur mit festem Ziel-Host und festen Content-Types
   durchreichen; SVGs mit Sandbox-CSP.
10. **Keine Dateien mit Secrets oder Debug-Resten** unter `public/` ablegen – alles dort ist öffentlich.

---

## 7. Code-Konventionen

- **Sprache:** Deutsch für UI-Texte, Kommentare, Logs und Doku. Code-Kommentare verwenden
  traditionell Umschreibungen (`ae/oe/ue`), UI-Texte echte Umlaute.
- Bestehenden Stil übernehmen: 2 Leerzeichen, Semikolons, `'use strict'`-IIFEs im Frontend,
  CommonJS (`require`) im Backend, API-Antworten immer `{ ok: true, data }` bzw.
  `{ ok: false, error }`.
- Frontend ruft das Backend **nur** über `window.api` (`public/js/api-client.js`) auf.
- Zeilenenden: LF (per `.gitattributes` erzwungen). Keine BOMs (haben schon Migrationen zerstört).
- **Migrationen:** neue Datei `db/migrations/NNN_beschreibung.sql` mit nächster freier Nummer,
  idempotent schreiben (`IF NOT EXISTS`), bestehende Migrationen nie ändern.
- **Abhängigkeiten:** Nach Änderungen an `package.json` immer `npm install` ausführen und die
  aktualisierte `package-lock.json` mit committen (Docker nutzt `npm ci`, das sonst abbricht).
  Keine ungenutzten Pakete aufnehmen; neue Pakete vorher auf bekannte Sicherheitslücken prüfen.

---

## 8. Versionierung (automatisch)

Die Version folgt **Semantic Versioning** und steht an vier Stellen, die immer synchron sein müssen:
`package.json`, `package-lock.json`, `public/sw.js` (`CACHE_NAME` – erzwingt neuen Offline-Cache)
und der Footer in `public/index.html`.

- **Automatisch:** Der Pre-Commit-Hook `.githooks/pre-commit` erhöht bei **jedem Commit mit
  Code-Änderungen** die Patch-Version (z. B. 3.0.5 → 3.0.6) an allen Stellen und nimmt die Dateien
  mit in den Commit. Reine Doku-Commits (`*.md`, `LICENSE`, `screenshots/`, `.github/`) erhöhen nicht.
- **Aktivierung (einmalig pro Klon):** `git config core.hooksPath .githooks` (bzw. `npm run hooks:install`).
- **Neue Features / Breaking Changes:** vor dem Commit `npm run version:minor` bzw.
  `version:major` ausführen (oder `sh scripts/bump-version.sh minor`) und die Dateien stagen – der
  Hook erkennt die bereits geänderte Version und erhöht nicht doppelt.
- **Überspringen** (z. B. bei `git commit --amend`): `SKIP_VERSION_BUMP=1 git commit …`
- Hat eine Versionsdatei nicht gestagte Änderungen, bricht der Hook mit Hinweis ab.
- **Für KI-Agenten:** Version nie manuell in einzelnen Dateien ändern, sondern immer über
  `scripts/bump-version.sh`. Wird ohne Commit gearbeitet, nach Abschluss einer Code-Änderung
  `sh scripts/bump-version.sh patch` ausführen – aber nur einmal pro zusammenhängender Änderung.
- Größere Releases zusätzlich in `public/changelog.html` eintragen (neuester Eintrag oben, Datum
  + Version).

---

## 9. Git-Konventionen

- Commit-Nachrichten im Stil **Conventional Commits** auf Englisch:
  `feat: …`, `fix: …`, `style: …`, `docs: …`, `chore: …`, `refactor: …`, `security: …`
- Nicht direkt auf `main` experimentieren; nur committen/pushen, wenn ausdrücklich gewünscht.
- Keine Secrets, `.env`, Backups, Screenshots oder temporären Hilfsdateien committen.

---

## 10. Bekannte Einschränkungen & offene Punkte

- **Statische Auslieferung vor dynamischen Routen:** In `server.js` steht ein
  `express.static(public)` (mit Standard-`index`) **vor** den Routen `GET /` und `GET /sw.js`.
  Dadurch werden `public/index.html` und `public/sw.js` unverändert ausgeliefert, und
  `is_public` („Profil nicht öffentlich“), Custom CSS, dynamische OG-Tags/JSON-LD sowie die
  No-Cache-Header für den Service Worker greifen nicht. Vor Änderungen an diesen Routen beheben.
- Keine automatisierten Tests vorhanden.
- Admin-Zugang ist auf einen Benutzer ausgelegt (kein Rollenmodell).
- Größere Major-Updates von Abhängigkeiten (Express 5, Helmet 8, express-rate-limit 8,
  @simplewebauthn 14, dotenv 17+) sind bewusst noch nicht durchgeführt – jeweils mit Tests migrieren.
