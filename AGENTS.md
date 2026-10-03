# AGENTS.md — Leitfaden für KI-Agenten & Entwickler

Diese Datei beschreibt Aufbau, Regeln und Arbeitsabläufe von **OpenWeb**. Sie richtet sich an
KI-Coding-Agenten (Claude Code, Codex, Cursor, Copilot …) und an Menschen, die am Projekt arbeiten.
**Vor jeder Änderung lesen und die Regeln unten einhalten.**

---

## 1. Projektüberblick

OpenWeb ist eine selbst gehostete **Link-in-Bio-Seite** (à la Linktree) im **Material-3-Design** (dunkel) mit
Admin-Oberfläche, Klick-Statistiken und Musik-Integration („Now Playing“ über Navidrome/Subsonic
oder Music Assistant, inkl. Discord-Webhook und Musik-Verlauf).

| Bereich   | Technik |
|-----------|---------|
| Backend   | Node.js ≥ 20.19 bzw. ≥ 22.12 (otplib 13 lädt ESM per `require`), Docker: `node:20-alpine`, Express 4 |
| Datenbank | PostgreSQL 16, Treiber `pg` (nur parametrisierte Queries) |
| Sessions  | `express-session` + `connect-pg-simple` (Tabelle `user_sessions`) |
| Auth      | E-Mail + Passwort (bcrypt, 12 Runden), 2FA per TOTP (`otplib` v13) und WebAuthn/Passkeys (`@simplewebauthn/server` v13, Browser-Bundle v9.0.1 per CDN mit SRI) |
| Frontend  | Vanilla HTML/CSS/JS, **keine Frameworks, kein Build-Schritt** |
| Sicherheit| `helmet` (CSP), `express-rate-limit`, eigene Validatoren, AES-256-GCM für gespeicherte Secrets |

Autor: Cornelius Ahner · Lizenz: MIT · Sprache der UI, Kommentare und Doku: **Deutsch**.

**Produktivbetrieb:** Linux-Server, eingerichtet mit `install.sh` → **systemd-Service `openweb`**
(`User=openweb`, `npm start`) hinter **nginx** (TLS via certbot). Updates ausschließlich mit
`sudo bash install.sh update` (git pull → `npm ci --omit=dev` → Migrationen → Rechte → Neustart).
Docker/Compose ist nur eine alternative Variante und wird produktiv nicht genutzt.

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
  encryption-key-backup.js Verschlüsseltes Backup/Wiederherstellung des Anwendungsschlüssels
  totp.js                 TOTP-Helfer (otplib v13, ±30 s, Replay-Schutz über afterTimeStep)
  validators.js           Serverseitige Eingabeprüfung (safeText, safeUrl, validateEmail, …)
  icons.js                Link-Icons: Dashboard-Icons-Namensliste (Cache), Erkennung, icon_resolved
  metrics.js              Ressourcenmonitor: CPU, RAM, Event-Loop, Anfragen, DB-Pool (Verlauf 1 h im RAM)
  shortcache.js           Kurzzeit-Cache mit geteilten Abrufen (z. B. Now Playing, 2,5 s)
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
  js/icons.js             Icon-Darstellung (createResolved, Material-Symbole, Stil weiß/bunt)
  js/admin.js             Admin-Oberfläche (eine große IIFE)
  js/login.js             Login-Seite inkl. TOTP/WebAuthn
  js/sw-register*.js      Service-Worker-Registrierung
  sw.js                   Service Worker (Network-First, cached nie /api/)
scripts/bump-version.sh   Versionserhöhung (siehe Abschnitt 8)
scripts/restore-encryption-key.js Offline-Wiederherstellung aus verschlüsseltem Schlüssel-Backup
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
| Sicherheits-Check der Pakete | `npm audit` (Ziel: 0 Funde) |
| Docker | `docker compose up -d` |
| Linux-Installation | `bash install.sh` (`update`, `change-password`, `reset-db`, `logs`) |
| Verschlüsselungsschlüssel offline wiederherstellen | `node scripts/restore-encryption-key.js <Schlüssel-Backup.json>` (im Projektverzeichnis; Passphrase wird verdeckt abgefragt) |

**Tests:** Es gibt keine automatisierten Tests (`npm test` ist ein Platzhalter). Änderungen daher
manuell im Browser prüfen – besonders Login (Passwort, TOTP, WebAuthn) und Admin-Funktionen.
Ohne lokales PostgreSQL lässt sich der Server gegen **PGlite** testen (`@electric-sql/pglite` +
`@electric-sql/pglite-socket` in einem separaten Ordner installieren, nicht ins Projekt).

**Windows:** Die `version:*`-Skripte und der Git-Hook sind Shell-Skripte – in **Git Bash** ausführen
(unter `cmd`/PowerShell ist `sh` meist nicht im PATH). Für lokale Entwicklung über http
`NODE_ENV=development` in die `.env` schreiben, sonst ist das Session-Cookie `secure` und der Login
klappt nur über https.

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
| `NAVIDROME_ENCRYPTION_KEY` | ja | 32 Byte Hex – verschlüsselt Navidrome-Passwort, MA-Token und SMTP-Passwort in der DB. Schlüssel-Backup im Admin separat erstellen und Passphrase getrennt aufbewahren. |
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
Health-Check → Metrik-Middleware → Helmet/CSP + Security-Header → Schutz vor direktem Abruf von `admin.html` /
`index.html` (auch kodierte Varianten) → CSRF-Prüfung für `/api` (nicht GET/HEAD/OPTIONS; volle
Origin inkl. Port) → Body-Parser (1 MB) → Rate-Limits → *(nach Setup-Prüfung)* `/sw.js`-Route →
`express.static(public, { index: false })` → Session → Limits für Public (120/min je IP für `/api`) und
Admin (600 je 15 min) →
`Cache-Control: no-store` für `/api/admin` + `/api/login` → Router → dynamische Startseite `/` →
404 → Error-Handler.
**Wichtig:** Kein `express.static` vor den dynamischen Routen `/` und `/sw.js` einbinden, sonst
greifen „Profil nicht öffentlich“, Custom CSS, OG-Tags und die Cache-Header des Service Workers nicht.
Ein Aufruf des Admin-Bereichs erzeugt ~18 API-Anfragen – Limits nicht unter diese Größenordnung
senken (bei 60/15 min wurde man nach wenigen Klicks ausgesperrt). Der Brute-Force-Schutz liegt bei
den Login-Endpunkten, nicht beim Admin-Limit.

**Service Worker (`public/js/sw-register.js`):** Die Seite lädt nur bei einem **Update** neu (es gab
beim Laden schon einen aktiven Service Worker), nicht beim ersten Installieren – sonst wird jede Seite
beim ersten Besuch doppelt geladen.

**Login-Ablauf (`routes/public.js`)**
`POST /api/login` → Passwort prüfen (oder passwortlos, wenn WebAuthn-Key vorhanden) → ist 2FA
aktiv, wird eine neue Session mit `pendingUserId` erzeugt → `POST /api/login/totp` bzw.
`/api/login/webauthn/options` + `/verify` → `completeLogin()` erzeugt erneut eine **neue
Session-ID** mit `userId`. Der Fehlversuchszähler wird erst nach vollständigem Login zurückgesetzt.

**Admin-Schutz:** `routes/admin.js` nutzt `router.use(requireAdminSession)`: Session vorhanden,
IP erlaubt, Benutzer existiert und ist aktiv. Neue Admin-Endpunkte gehören **immer** in diesen
Router.

**Passwortgeschützte Links:** Die Ziel-URL wird **nie** ohne Passwort ausgeliefert (`url: null` in
`/api/links` und `/api/public/links`, kein Kurzlink `/go/:slug`, nicht in Sitemap oder
Discord-Klickmeldung) – nur über `POST /api/links/:id/unlock` nach Passwortprüfung
(eigenes Rate-Limit, Versuche werden sofort gezählt).

**Link-Icons (`lib/icons.js`):** Alle Logos kommen aus
[Dashboard Icons](https://github.com/homarr-labs/dashboard-icons), ausgeliefert über den eigenen
Proxy `/api/icon/dashboardicon/<name>/<format>`. Die Namensliste (`tree.json`) wird beim Start im
Hintergrund geladen und 24 h gecacht. Die API liefert zu jedem Link `icon_resolved`:
`dashboard` (Logo), `image` (eigene Bild-URL) oder `generic` (Material-Symbol `link`/`mail`/`phone`).
Reihenfolge: gewähltes `dashboardicon:…` → altes `simpleicon:…` (gleichnamiges Dashboard Icon) →
Bild-URL → Erkennung aus Hostname/Titel → Symbol. `mailto:`/`tel:` bekommen immer das Symbol.
Gespeicherte Icon-Werte werden **nie** umgeschrieben, nur bei der Ausgabe aufgelöst.
Stil pro Seite über `profile.icon_style` (`white`|`color`) → Klasse `icons-white`/`icons-color` am
`<body>`. „Weiß“ nutzt den SVG-Filter `#icon-mono-white` (in `index.html` und `admin.html`):
farbige/dunkle Pixel → weiß, weiße Pixel → transparent. Logos mit farbigem Motiv auf dunkler
Kachel (z. B. Plex) werden sonst zur weißen Fläche – dafür in `WHITE_STYLE_VARIANTS`
(`lib/icons.js`) die `-light`-Variante eintragen und im weißen Stil per Screenshot prüfen.
Keine Emojis oder Simple Icons mehr als Link-Icons einführen.

**Performance & Caching (nicht aushebeln):**
- HTML-Seiten mit eigenen CSS/JS-Verweisen über `sendHtml()` (bzw. `versionAssets()` beim
  Startseiten-Template) ausliefern: hängt `?v=<Version>` an, solche Dateien bekommen
  `Cache-Control: max-age=1 Jahr, immutable`. Neue Seiten also **nicht** per `res.sendFile`.
- „Now Playing“ (`lib/navidrome.js`, `lib/musicassistant.js`) ist per `shortCache` 2,5 s gecacht
  und wird von allen Besuchern geteilt; das Frontend fragt nur bei sichtbarem Tab alle 3 s nach.
- Icon-Proxy `/api/icon/dashboardicon` cacht Logos 7 Tage im Speicher (max. 400) und zählt
  nicht zum API-Limit (eigenes Limit 600/min) – sonst verbrauchen viele Links das Kontingent.
- Admin: Daten erst laden, wenn sie gebraucht werden (Vorschau-iframe, Icon-Vorschläge,
  Musik-Vorschau und Monitor nur bei offenem Tab).

**Ressourcenmonitor (`lib/metrics.js`, Admin-Tab „Monitor“):** Messpunkt alle 10 s, 360 Punkte
(1 h) nur im Arbeitsspeicher; `GET /api/admin/metrics?since=<ts>` liefert nur neue Punkte. Die
Middleware zählt jede Anfrage (Dauer, 5xx) – sie muss vor allen Routen stehen.

**Profil nicht öffentlich (`profile.is_public = false`):** `/`, `/api/profile`, `/api/links` und
`/api/links/categories` liefern dann nur für eingeloggte Admins (Vorschau) Inhalte.

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
6. **Auth-Änderungen:** Sensible Kontoänderungen (TOTP einrichten/deaktivieren, Security Key
   hinzufügen/löschen) verlangen das aktuelle Passwort (`checkCurrentPassword`, im Frontend
   `askPassword()` – nie `prompt()`). Ein aktives TOTP kann nicht ersetzt, nur deaktiviert werden.
   WebAuthn-Registrierungs-Challenges liegen in der Session, nicht in
   `users.webauthn_current_challenge` (die setzt der passwortlose Login ohne Anmeldung).
   Nach Login immer `req.session.regenerate()`.
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
- **Design: Material 3 (Dark).** Farben nur über die M3-Farbrollen (`--md-primary`,
  `--md-surface-container-*`, `--md-on-surface-variant`, `--md-outline` …) – keine festen Hex-Werte
  in Komponenten oder JavaScript. Definiert in `public/styles.css` (öffentliche Seite inkl. der
  Themes Dunkel/Midnight/Sunset), `public/admin.css` (Admin + Login) und inline in `setup.html`.
  Formen über `--md-shape-*`, Hover/Pressed über State Layer (`::before`, 8 %/12 %), Bewegung über
  `--md-ease*`/`--md-dur-*`. Die alten Variablen (`--neon-*`, `--text-dim`, `--bg-*` …) sind nur
  noch Aliase für ältere Unterseiten und sollen in neuem Code nicht mehr verwendet werden.
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
- **Abschluss-Checkliste für KI-Agenten** (vor der Rückmeldung an den Nutzer):
  1. Changelog-Eintrag in `public/changelog.html` angelegt bzw. erweitert (siehe unten)?
  2. `AGENTS.md` angepasst, falls sich Aufbau, Regeln, Befehle oder Abläufe geändert haben?
  3. Nach `package.json`-Änderungen `npm install` + `npm audit` ausgeführt?

### Changelog (Pflicht)

**Jede Änderung, die Nutzer, Admins oder den Betrieb betrifft** (Features, Fehlerbehebungen,
Design, Sicherheit, Installation/Updates), wird im **selben Commit** in `public/changelog.html`
eingetragen – nicht nur größere Releases. Ausgenommen sind nur reine interne Refactorings ohne
sichtbare Wirkung und reine Doku-Änderungen.

- Neuester Eintrag **ganz oben** (direkt unter `<p class="subtitle">`), ältere bleiben stehen.
- Format:
  ```html
  <div class="changelog-entry">
    <h2>JJJJ-MM-TT — OpenWeb vX.Y.Z (Kurztitel)</h2>
    <ul>
      <li><strong>Bereich:</strong> Was sich für Nutzer ändert – verständlich, ohne Code-Details.</li>
    </ul>
  </div>
  ```
- Versionsnummer = die Version **nach** dem Commit (der Hook erhöht die Patch-Version; aktuelle
  Version + 1 bei der letzten Stelle). Mehrere zusammengehörige Commits dürfen einen gemeinsamen
  Eintrag mit Versionsbereich haben (`v3.0.6 – v3.0.8`); dann den bestehenden Eintrag erweitern
  statt einen neuen anzulegen.
- Sprache Deutsch mit echten Umlauten, sachlich formulieren („funktioniert jetzt“ statt
  „funktioniert wieder“, wenn es vorher nie funktioniert hat). Sicherheitslücken so beschreiben,
  dass keine Anleitung zum Ausnutzen entsteht.
- Einträge, die älter als die aktuelle Major-/Minor-Reihe sind, können in den
  `<details>`-Block „Ältere Änderungen“ verschoben werden.

---

## 9. Git-Konventionen

- Commit-Nachrichten im Stil **Conventional Commits** auf Englisch:
  `feat: …`, `fix: …`, `style: …`, `docs: …`, `chore: …`, `refactor: …`, `security: …`
- Nicht direkt auf `main` experimentieren; nur committen/pushen, wenn ausdrücklich gewünscht.
- Keine Secrets, `.env`, Backups, Screenshots oder temporären Hilfsdateien committen.

---

## 10. Bekannte Einschränkungen & offene Punkte

- Keine automatisierten Tests vorhanden.
- **Docker + Web-Setup (nicht produktiv genutzt):** Der Setup-Assistent schreibt die `.env` in den
  Container (nicht persistent), während `env_file: .env` Platzhalter aus `.env.example` mitliefert.
  Für Docker die `.env` vorab vollständig ausfüllen (`SESSION_SECRET`, `NAVIDROME_ENCRYPTION_KEY`, …).
- Beim passwortlosen WebAuthn-Login verraten die Antworten, ob eine E-Mail existiert
  (bewusster Kompromiss des „nur E-Mail + Security Key“-Logins).
- Admin-Zugang ist auf einen Benutzer ausgelegt (kein Rollenmodell).
- Größere Major-Updates von Abhängigkeiten (Express 5, Helmet 8, express-rate-limit 8,
  @simplewebauthn 14, dotenv 17+) sind bewusst noch nicht durchgeführt – jeweils mit Tests migrieren.
