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

## Schnellstart mit `install.sh`

Auf einem frischen Debian/Ubuntu-Server mit Node.js >= 18:

```bash
cd /opt
# Repository klonen
git clone https://github.com/DerMinecrafter2020/linktree.git openweb
cd openweb

# Interaktives Setup
bash install.sh
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

## Manuelles Deployment

### 1. Systemvoraussetzungen

- Node.js >= 18
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
ExecStart=/usr/bin/npm start
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
bash install.sh update
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
