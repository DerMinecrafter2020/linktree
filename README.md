# OpenWeb · Link in Bio

Eine komplette Link-in-Bio-Seite (a la Linktree) im **Dark & Neon**-Stil mit eigener Admin-Oberfläche.

- **Backend:** Node.js 20 + Express 4
- **Datenbank:** PostgreSQL 16
- **Auth:** E-Mail/Passwort mit bcrypt + serverseitigen Sessions (connect-pg-simple)
- **Frontend:** Statische HTML/JS/CSS, geserved aus `public/`

---

## 📂 Wichtige Dateien

| Datei / Ordner | Zweck |
|---|---|
| `server.js` | Express-Server-Einstieg |
| `lib/db.js` | pg-Pool + Transaktionshelfer |
| `lib/auth.js` | bcrypt, Session-Check |
| `lib/crypto.js` | AES-256-GCM fuer Navidrome-Passwort |
| `lib/validators.js` | `safeText`, `safeUrl`, `sanitizeIconField` |
| `routes/public.js` | Oeffentliche API (`/api/profile`, `/api/links`, `/api/login`) |
| `routes/admin.js` | Geschuetzte Admin-API |
| `routes/navidrome.js` | Backend-Proxy fuer Navidrome/Subsonic |
| `public/` | Frontend: `index.html`, `admin.html`, `login.html`, `setup.html`, JS, CSS |
| `db/migrations/` | SQL-Migrationen |
| `db/migrate.js` | Migration-Runner |
| `db/seed.js` | Erzeugt Admin-User, Profil, Default-Links |
| `db/reset.js` | Setzt alle Daten zurueck |
| `lib/setup.js` | Initial-Setup-Logik |
| `routes/setup.js` | Setup-API |

---

## 🚀 Schnellstart (lokal)

### Voraussetzungen
- Node.js >= 18
- PostgreSQL (lokal oder Docker)

### Variante A: Web-basiertes Initial-Setup (empfohlen)

```bash
npm install
npm start
# Oeffne http://localhost:3000/setup.html
```

Beim ersten Start erkennt der Server automatisch, dass noch kein Admin-User
existiert, und zeigt das Initial-Setup. Dort kannst du setzen:

- PostgreSQL-Verbindung
- Admin-E-Mail/Passwort
- Profil-Daten
- Erste Links
- Navidrome-Credentials (optional)

Nach dem Setup musst du den Server **einmal neu starten**, damit die
Session-Konfiguration aktiv wird. Danach ist `/login` erreichbar.

### Variante B: Manuell ueber `.env`

```bash
npm install
cp .env.example .env
# .env bearbeiten
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

Die Seite ist unter `http://localhost:3000` erreichbar, der Admin-Login unter `/login`.

---

## ☁️ Produktiv-Deployment

Fuer einen frischen Server empfohlen:

```bash
bash install.sh
```

Das Script:
- fragt nach Datenbank-Variante (Docker Postgres oder bestehende URL)
- fragt Admin-E-Mail/Passwort ab
- generiert `SESSION_SECRET` und `NAVIDROME_ENCRYPTION_KEY`
- schreibt `.env`
- installiert `npm`-Abhaengigkeiten
- fuehrt Migrationen + Seeding aus
- richtet optional einen systemd-Service und nginx ein
- kann optional Navidrome-Credentials speichern

Weitere Befehle:
```bash
bash install.sh update           # Code aktualisieren
bash install.sh change-password  # Admin-Passwort aendern
bash install.sh change-navidrome # Navidrome-Credentials aendern
bash install.sh reset-db         # DB zuruecksetzen
bash install.sh logs             # systemd-Logs anzeigen
```

---

## ✨ Features

### Hauptseite
- Animierter Aurora-Hintergrund, Neon-Avatar mit rotierendem Ring
- Hover: Karte waechst auf 1.06, URL erscheint in Neon-Cyan
- Navidrome-Player zeigt aktuellen Track an (optional)

### Admin
- 🔐 **Echter Login** mit E-Mail/Passwort + Session-Cookie
- 🔗 **Links**: hinzufuegen, bearbeiten, loeschen, **drag & drop sortieren**
- 👤 **Profil**: Name, Handle, Bio, Avatar-Buchstaben oder Avatar-Bild
- 🎨 **Eigene Icons** pro Link (Emoji, Bild-URL oder Simple Icons)
- 💾 **JSON-Export/Import** als Backup
- 🗑 **Reset** auf Auslieferungszustand
- 🎵 **Navidrome-Einstellungen** (verschluesselt in PostgreSQL)

---

## 🔒 Sicherheit

| Schutz | Wie |
|---|---|
| **Admin-Login** | bcrypt-Hash + serverseitige Session in PostgreSQL (connect-pg-simple) |
| **Navidrome-Credentials** | AES-256-GCM verschluesselt in `navidrome_settings`; Schluessel liegt nur in `.env`; Browser sieht Credentials nie |
| **Session-Cookie** | `httpOnly`, `secure` in Production, `sameSite: lax` |
| **Sicherheitsheader** | Helmet + CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` |
| **Input-Validierung** | `safeText()`, `safeUrl()`, `sanitizeIconField()` auf Client und Server |
| **Avatar-DataURL** | Nur `data:image/*`, max. 500 KB |
| **SQL-Injection** | Parameterisierte Queries ueber `pg` |

---

## 🛠 Datenmodell

- `users` — Admin-Benutzer (E-Mail + Passwort-Hash)
- `profile` — Singleton (`id = 1`) mit Name, Handle, Bio, Avatar
- `links` — Link-Eintraege mit Position, Aktiv-Status, Icon
- `admin_settings` — Singleton mit Admin-Status + Discord-Webhook
- `navidrome_settings` — Singleton, Passwort verschlüsselt
- `user_sessions` — Wird von `connect-pg-simple` verwaltet

---

## 🔁 Updates

```bash
bash install.sh update
```

- Holt neuen Code
- Behaelt `.env` und Datenbank bei
- Fuehrt Migrationen aus
- Startet den Service neu

Viel Spass! 🎉
