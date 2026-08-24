# OpenWeb · Link in Bio

Eine komplette Link-in-Bio-Seite (a la Linktree) im **Dark & Neon**-Stil mit eigener vollumfänglicher Admin-Oberfläche, tiefgehenden Statistiken und Musik-Integration.

- **Backend:** Node.js 20 + Express 4
- **Datenbank:** PostgreSQL 16
- **Auth:** E-Mail/Passwort (bcrypt), **2FA (WebAuthn/Passkeys)**, serverseitige Sessions
- **Frontend:** Statisches HTML/JS/CSS, komplett ohne Frontend-Frameworks (Vanilla)

---

## ✨ Features

### 🖥️ Frontend (Public Page)
- Animierter **Aurora-Hintergrund** und Neon-Avatar mit rotierendem Ring
- Hover-Effekte: Karten wachsen, URLs leuchten im Neon-Cyan auf
- **Now Playing:** Live-Anzeige des aktuell gehörten Songs (über Navidrome/Subsonic API oder Music Assistant)
- Integrierte Rechtstexte (Impressum, Datenschutz)

### 📊 Umfangreiche Statistiken
Die Admin-Oberfläche bietet ein dediziertes Statistik-Dashboard für wählbare Zeiträume (7, 30, 90 Tage):
- Klick-Verlauf (Interaktives Balkendiagramm)
- Breakdown nach **Geräten**, **Browsern**, **Betriebssystemen** und **Ländern**
- Auswertung von **Top Quellen / UTM-Parametern** (Source & Medium)
- Klicks & Unique Visitors pro einzelnem Link
- **Musik-Verlauf (Scrobbles)**: Automatische Aufzeichnung und Anzeige der zuletzt gehörten Songs. Doppelte Tracks werden intelligent zusammengefasst.
- **CSV-Export** aller generierten Statistiken

### 🛠️ Admin & Verwaltung
- 🔐 **Hohe Sicherheit:** Echter Login mit 2FA (WebAuthn) Support für Passkeys / Security Keys.
- 🔗 **Link-Verwaltung**: Hinzufügen, bearbeiten, deaktivieren, löschen und per **Drag & Drop** sortieren.
- 🎨 **Icons**: Unterstützt einfache Emojis, direkte Bild-URLs oder über 2000 [Simple Icons](https://simpleicons.org/).
- 👤 **Profil-Verwaltung**: Name, Handle, Bio, und Avatar (Bild-Upload oder Initialen).
- 💾 **Backups**: Komplettes JSON-Export/Import der Links.
- 🎵 **Navidrome- & Music Assistant-Einstellungen**: Bequem im UI verwaltbar (Passwörter werden sicher AES-256-GCM verschlüsselt in der DB abgelegt).

---

## 🚀 Installation & Setup

### Variante A: Docker + Web-basiertes Setup (Empfohlen)

Die einfachste Möglichkeit, OpenWeb zu starten. Es wird automatisch erkannt, wenn das System noch unkonfiguriert ist, und ein Setup-Assistent im Browser gestartet.

1. Repository klonen und in den Ordner wechseln:
   ```bash
   git clone https://github.com/DerMinecrafter2020/linktree.git openweb
   cd openweb
   ```
2. `.env` erstellen:
   ```bash
   cp .env.example .env
   ```
3. Docker Compose starten (startet Node.js Server + PostgreSQL DB):
   ```bash
   docker compose up -d
   ```
4. Setup im Browser abschließen:
   Öffne `http://localhost:3000/setup.html` in deinem Browser. Der Assistent führt dich durch die Erstellung des Admin-Accounts, das initiale Profil und die Datenbankanbindung.

### Variante B: Manuell über Install-Script (Linux Server)

Für produktive Deployments direkt auf einem Linux-Server bietet das beiliegende Bash-Script einen komfortablen Weg, Systemd-Services, Nginx-Proxys und die Datenbank automatisch einzurichten.

```bash
bash install.sh
```

Das Script:
- Fragt nach der gewünschten Datenbank-Variante (installiert via Docker oder nutzt bestehende URL)
- Erfragt Admin-Zugangsdaten und generiert kryptografische Schlüssel
- Installiert npm-Abhängigkeiten und führt SQL-Migrationen aus
- Richtet auf Wunsch einen **systemd-Service** und einen **nginx Reverse Proxy** ein

Weitere Befehle des Install-Scripts:
```bash
bash install.sh update           # Holt neuen Code und führt Updates durch
bash install.sh change-password  # Admin-Passwort neu setzen
bash install.sh reset-db         # Datenbank komplett zurücksetzen
bash install.sh logs             # systemd-Logs live anzeigen
```

---

## 🛠 Datenmodell / Architektur

- `users` — Admin-Benutzer (E-Mail + Passwort-Hash)
- `user_credentials` — WebAuthn 2FA Keys
- `profile` — Singleton (`id = 1`) mit Name, Handle, Bio, Avatar
- `links` — Link-Einträge mit Position, Aktiv-Status, Icon
- `link_clicks` — Analytik-Rohdaten (IP-Hash, User-Agent Parses, UTM)
- `music_history` — Lokales Scrobble-Tagebuch
- `admin_settings` — Singleton mit Admin-Status
- `navidrome_settings` & `musicassistant_settings` — Singleton, API-Keys verschlüsselt
- `user_sessions` — Verwaltet von `connect-pg-simple`

---

## 🔒 Sicherheit

- **Passwörter & 2FA**: Bcrypt Hashing für Passwörter. 2FA wird nativ über WebAuthn (FIDO2) abgewickelt.
- **Verschlüsselung**: API Keys / Passwörter für Navidrome & Music Assistant werden via AES-256-GCM verschlüsselt in der Datenbank abgelegt. Der nötige Schlüssel `NAVIDROME_ENCRYPTION_KEY` verbleibt ausschließlich in der `.env`-Datei auf dem Server.
- **Datenschutz**: IP-Adressen in den Statistiken werden sofort als kryptografischer Hash gespeichert (Unique Visitors), Roh-IPs werden niemals gesichert.
- **Absicherung**: Helmet + CSP, SameSite-Cookies, vorbereitete SQL-Statements (`pg` param queries) verhindern XSS und SQL-Injection.

---

## 🔁 Updates durchführen

Wenn die Anwendung läuft, kannst du Aktualisierungen jederzeit wie folgt einspielen:

**Bei Nutzung von `install.sh`:**
```bash
bash install.sh update
```

**Bei manueller / Docker Nutzung:**
```bash
git pull
docker compose build  # (Falls neue npm-Pakete hinzukamen)
docker compose up -d
docker compose exec app npm run db:migrate  # Führt evtl. neue SQL-Migrationen aus
```
