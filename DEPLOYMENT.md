# OpenWeb Deployment-Anleitung

OpenWeb ist ein Node.js + Express + PostgreSQL Projekt. Die komplette Anwendung
laeuft auf einem einzelnen Server (eigenstaendig oder mit Docker Compose).

---

## Architektur

```
┌──────────────┐        ┌─────────────────────┐        ┌──────────────┐
│  Browser     │  TLS   │  nginx (optional)   │        │  Node.js     │
│  public/js   │───────▶│  Reverse Proxy      │───────▶│  server.js   │
│              │        │                     │        │              │
└──────────────┘        └─────────────────────┘        └──────┬───────┘
                                                                │
                                                                │ pg Pool
                                                                ▼
                                                       ┌──────────────┐
                                                       │  PostgreSQL  │
                                                       │  users       │
                                                       │  profile     │
                                                       │  links       │
                                                       │  navidrome_* │
                                                       └──────────────┘
```

- Der Browser fragt **nur** die eigene API an (`/api/*`).
- Navidrome-Credentials liegen **verschluesselt** in PostgreSQL; der Node-Server
  proxyt Subsonic-Anfragen.
- Sessions werden mit `connect-pg-simple` in PostgreSQL gespeichert.

---

## Node.js 26 auf Debian/Ubuntu installieren

OpenWebs `package.json` akzeptiert Node.js 26 bereits. Die Befehle unten installieren die
offizielle Node.js-Version **26.12.1** systemweit unter `/opt/node26` und prüfen vor dem Entpacken
die SHA-256-Prüfsumme. Unterstützt sind Debian/Ubuntu auf `amd64` und `arm64`.

> **LTS-Hinweis (24.10.2026):** Node.js 26.12.1 ist derzeit ein Current-Release; der Wechsel zu
> LTS ist für den 28.10.2026 vorgesehen. Node.js 24 ist aktuell LTS.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl xz-utils

NODE_VERSION=26.12.1
case "$(dpkg --print-architecture)" in
  amd64) NODE_ARCH=x64 ;;
  arm64) NODE_ARCH=arm64 ;;
  *) echo "Nicht unterstützte Architektur: $(dpkg --print-architecture)" >&2; exit 1 ;;
esac

cd /tmp
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
grep " node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz$" SHASUMS256.txt | sha256sum --check -

sudo install -d "/opt/node-v${NODE_VERSION}"
sudo tar -xJf "node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -C "/opt/node-v${NODE_VERSION}" --strip-components=1
sudo ln -sfn "/opt/node-v${NODE_VERSION}" /opt/node26
export PATH="/opt/node26/bin:$PATH"
node --version
npm --version
```

Für einen bestehenden systemd-Dienst den Node-26-Pfad in der Dienstumgebung setzen:

```bash
sudo install -d /etc/systemd/system/openweb.service.d
sudo tee /etc/systemd/system/openweb.service.d/node26.conf >/dev/null <<'EOF'
[Service]
Environment="PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=
ExecStart=/usr/bin/env npm start
EOF
sudo systemctl daemon-reload
```

Danach OpenWeb mit Node.js 26 aktualisieren und neu starten:

```bash
cd /opt/openweb
sudo env PATH="/opt/node26/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" bash install.sh update
sudo systemctl status openweb --no-pager
```

---

## Schnellstart mit `install.sh`

Auf einem frischen Debian/Ubuntu-Server mit Node.js 26 (kompatibel ab 20.19 bzw. 22.12):

```bash
cd /opt
# Repository klonen
git clone https://github.com/DerMinecrafter2020/linktree.git openweb
cd openweb

# Interaktives Setup (erstellt .env, DB, Admin, systemd, nginx)
sudo env PATH="/opt/node26/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" bash install.sh
```

Das Script fragt ab:
- Datenbank-Variante (Docker Postgres oder externe URL)
- Admin-E-Mail + Passwort
- Session-Secret + Navidrome-Encryption-Key (automatisch generiert)
- Port + Domain
- Navidrome-URL/User/Pass (optional)

Anschliessend startet es optional Postgres, fuehrt Migrationen + Seeding aus,
installiert npm-Abhaengigkeiten und richtet optional systemd + nginx ein.

---

## Web-basiertes Initial-Setup

Wenn du OpenWeb **ohne** `install.sh` startest (z. B. lokal oder auf einem
System, auf dem das Script nicht passt), erkennt `server.js` automatisch, dass
noch kein Admin existiert, und zeigt `/setup.html` an.

Voraussetzung: Node.js und eine erreichbare PostgreSQL-Datenbank.

```bash
npm install
npm start
# Oeffne http://localhost:3000/setup.html
```

Im Setup-Formular kannst du setzen:
- PostgreSQL URL
- Server Port + App URL
- Admin-E-Mail/Passwort
- Profil (Name, Handle, Bio, Avatar)
- Erste Links
- Navidrome-Credentials (optional)

Das Setup schreibt alle Werte in `.env` und in die Datenbank. Anschliessend
musst du den Server **einmal neu starten**, damit die Session-Middleware mit dem
generierten `SESSION_SECRET` aktiviert wird.

---

## Manuelles Deployment

### 1. Systemvoraussetzungen

- Node.js 26 empfohlen; kompatible Mindestversion 20.19 bzw. 22.12 (wegen otplib 13)
- PostgreSQL >= 14
- npm

### 2. `.env` anlegen

```bash
cp .env.example .env
```

Beispiel `.env` fuer Produktion:
```env
NODE_ENV=production
PORT=3000
APP_URL=https://deine-domain.de
DATABASE_URL=postgres://openweb:geheim@localhost:5432/openweb
SESSION_SECRET=...
SESSION_MAX_AGE_MS=86400000
ADMIN_EMAIL=admin@deine-domain.de
ADMIN_PASSWORD=...
NAVIDROME_ENCRYPTION_KEY=...
NAVIDROME_ENABLED=true
NAVIDROME_URL=https://music.deine-domain.de
NAVIDROME_USERNAME=openweb
NAVIDROME_PASSWORD=...
```

`SESSION_SECRET` und `NAVIDROME_ENCRYPTION_KEY` muessen jeweils 64 Hex-Zeichen
(32 Bytes) sein. Generieren z. B. mit:
```bash
openssl rand -hex 32
```

### 3. Datenbank vorbereiten

```bash
npm run db:migrate
npm run db:seed
```

### 4. Server starten

```bash
npm start
```

Fuer Entwicklung mit Auto-Reload:
```bash
npm run dev
```

### 5. nginx als Reverse Proxy (empfohlen)

```nginx
server {
    listen 80;
    server_name deine-domain.de;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Danach SSL mit certbot einrichten:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d deine-domain.de
```

---

## systemd-Service (empfohlen)

`/etc/systemd/system/openweb.service`:
```ini
[Unit]
Description=OpenWeb Link-in-Bio
After=network.target

[Service]
Type=simple
User=openweb
Group=openweb
WorkingDirectory=/opt/openweb
Environment=PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env npm start
Restart=always
RestartSec=5
EnvironmentFile=/opt/openweb/.env

[Install]
WantedBy=multi-user.target
```

Aktivieren:
```bash
sudo useradd -r -s /bin/false openweb
sudo chown -R openweb:openweb /opt/openweb
sudo systemctl daemon-reload
sudo systemctl enable openweb
sudo systemctl start openweb
sudo systemctl status openweb
```

---

## Wartung

### Code aktualisieren
```bash
cd /opt/openweb
sudo env PATH="/opt/node26/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" bash install.sh update
```

### Admin-Passwort aendern
```bash
cd /opt/openweb
bash install.sh change-password
```

### Navidrome-Credentials aendern
```bash
cd /opt/openweb
bash install.sh change-navidrome
```

### Datenbank zuruecksetzen
```bash
cd /opt/openweb
bash install.sh reset-db
```

### Logs anzeigen
```bash
sudo journalctl -u openweb -f
```

---

## Sicherheits-Checkliste

- [ ] `.env` hat `chmod 600` und gehoert dem App-User.
- [ ] `SESSION_SECRET` ist ein zufaelliger 32-Byte-Key.
- [ ] `NAVIDROME_ENCRYPTION_KEY` ist ein zufaelliger 32-Byte-Key.
- [ ] `ADMIN_PASSWORD` hat mindestens 8 Zeichen.
- [ ] Datenbank ist nicht oeffentlich erreichbar (nur localhost/VPN).
- [ ] nginx leitet `X-Forwarded-Proto` weiter, damit Cookies in Production `secure` sind.
- [ ] Das `.env`-File wird **niemals** in git committet (`.gitignore` pruefen).
- [ ] Navidrome-Credentials sind nicht im Browser oder in Logs sichtbar.
