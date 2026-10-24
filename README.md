# OpenWeb – selbst gehostete Link-in-Bio-Seite

OpenWeb ist eine responsive Link-in-Bio-Seite mit Admin-Panel, Statistiken und Musik-Integration. Das Frontend besteht aus Vanilla-HTML/CSS/JavaScript und benötigt keinen Build-Schritt.

| Komponente | Technik |
|---|---|
| Backend | Node.js **26.x** (Zielversion; Mindestversion **20.19+** oder **22.12+**), Express 4 |
| Datenbank | PostgreSQL 16 |
| Anmeldung | E-Mail/Passwort, TOTP und WebAuthn/Passkeys |
| Oberfläche | Material 3 Dark; öffentliche Themes Dunkel, Midnight und Sunset |

## Funktionen

### Öffentliche Seite

- Responsive Profilseite mit Kategorien, Kurzlinks und Dashboard-Icons.
- Links können geplant, zeitlich begrenzt und passwortgeschützt werden. Die Ziel-URL geschützter Links wird erst nach erfolgreicher Passwortprüfung ausgegeben.
- Besucher können Links teilen, QR-Codes öffnen und – sofern aktiviert – das Theme wählen.
- Now-Playing-Anzeige über Navidrome/Subsonic oder Music Assistant; optional mit Discord-Webhook und Musikverlauf.
- Impressum und Datenschutzerklärung lassen sich im Admin-Panel pflegen. Leerzeilen und Zeilenumbrüche werden auf den Unterseiten formatiert dargestellt.
- Nach Admin-Anmeldung erscheint auf der Hauptseite ein mobilfreundlicher Direktzugang zum Admin-Panel.

### Admin-Panel

- Profil-, Link- und Kategorienverwaltung, einschließlich Zeitsteuerung, Ablaufdatum, Passwortschutz und Kurzlinks.
- Statistiken über 7, 30 oder 90 Tage: Klicks, eindeutige Besucher, Geräte, Browser, Betriebssysteme, Länder und UTM-Parameter; CSV-Export.
- API-Key-Verwaltung und öffentliche API-Dokumentation.
- Ressourcenmonitor für CPU, Arbeitsspeicher, Event-Loop, HTTP-Anfragen/-Fehler, Antwortzeiten und PostgreSQL-Verbindungen. Messpunkte werden zentral gespeichert, sind auf anderen Admin-Geräten sichtbar und bleiben bei Neustarts erhalten. Messpunkte werden nach 30 Tagen gelöscht; das Diagramm zeigt die letzte Stunde.
- Lokale Theme-Auswahl Dunkel/Midnight/Sunset für das Admin-Panel.
- TOTP- und WebAuthn-Verwaltung, Audit-Log, Benachrichtigungen und JSON-Backups.
- Verschlüsselungsschlüssel-Backup als separat passwortgeschützte Datei; Wiederherstellung im Admin-Panel oder offline.

## Voraussetzungen

- Linux für den empfohlenen Produktivbetrieb mit systemd/nginx; Git und Bash für `install.sh`.
- Node.js **26.x** (Zielversion) und npm; kompatible Mindestversion ist **20.19+** oder **22.12+**.
- PostgreSQL 16. Für die alternative Compose-Installation wird Docker Compose benötigt.
- Eine öffentliche Domain und HTTPS werden für den Produktivbetrieb empfohlen.

Node.js 26 ist am 24.10.2026 noch die Current-Version und kein LTS-Release. Für konservativen
Produktivbetrieb ist Node.js 24 LTS die stabilere Wahl; OpenWeb unterstützt Node 26 wie gewünscht.
Installationsbefehle für Debian/Ubuntu stehen in [DEPLOYMENT.md](DEPLOYMENT.md#nodejs-26-auf-debianubuntu-installieren).

Für lokale Entwicklung mit nvm (auch nvm-windows):

```bash
nvm install 26.12.1
nvm use 26.12.1
node --version
```

## Installation

### Empfohlen: Linux-Installation mit `install.sh`

Das Installationsskript richtet OpenWeb direkt auf einem Linux-Server ein. Es kann eine PostgreSQL-Datenbank in Docker Compose verwenden oder sich mit einer bestehenden PostgreSQL-URL verbinden. Bei Ausführung als root können außerdem ein systemd-Dienst, nginx und optional ein Let's-Encrypt-Zertifikat eingerichtet werden.

```bash
git clone https://github.com/DerMinecrafter2020/linktree.git openweb
cd openweb
sudo env PATH="/opt/node26/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" bash install.sh
```

Folge den Fragen zu Datenbank, Admin-Konto, Domain und optionaler Navidrome-Integration. Das Skript generiert Session- und Verschlüsselungsschlüssel und führt die Migrationen sowie das initiale Seeding aus. Die `.env` wird mit restriktiven Dateirechten angelegt.

Nach der Installation ist der Dienst – sofern systemd eingerichtet wurde – über `openweb` verwaltbar:

```bash
sudo systemctl status openweb
sudo systemctl restart openweb
sudo journalctl -u openweb -n 100 -f
```

Weitere Verwaltungsbefehle:

```bash
NODE26_PATH="/opt/node26/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
sudo env PATH="$NODE26_PATH" bash install.sh update             # Aktualisieren und Neustart anbieten
sudo env PATH="$NODE26_PATH" bash install.sh change-password    # Admin-Passwort ändern
sudo env PATH="$NODE26_PATH" bash install.sh change-navidrome   # Navidrome-Zugangsdaten ändern
sudo env PATH="$NODE26_PATH" bash install.sh reset-db           # Datenbank zurücksetzen (löscht Daten)
sudo bash install.sh logs                                         # systemd-Logs live anzeigen
```

### Alternative: Docker Compose

Docker Compose ist als alternative Betriebsart vorhanden, aber nicht der empfohlene Produktivweg. **Nicht mit den Platzhaltern aus `.env.example` starten.** Compose bindet App und PostgreSQL standardmäßig nur an `127.0.0.1`.

```bash
git clone https://github.com/DerMinecrafter2020/linktree.git openweb
cd openweb
cp .env.example .env
```

Vor dem Start in `.env` mindestens `POSTGRES_PASSWORD`, `SESSION_SECRET`, `NAVIDROME_ENCRYPTION_KEY`, `ADMIN_EMAIL` und `ADMIN_PASSWORD` setzen. `SESSION_SECRET` und `NAVIDROME_ENCRYPTION_KEY` müssen jeweils 64 Hex-Zeichen (32 Byte) enthalten; Schlüssel lassen sich z. B. mit `openssl rand -hex 32` erzeugen. `ADMIN_PASSWORD` wird nur für das initiale Seeding benötigt.

Die Datenbank vorbereiten und den Admin anlegen:

```bash
docker compose build --pull app
docker compose up -d postgres
docker compose run --rm app npm run db:migrate
docker compose run --rm app npm run db:seed
```

Danach `ADMIN_PASSWORD` und ein eventuell verwendetes `NAVIDROME_PASSWORD` aus der Host-`.env` entfernen und die App starten:

```bash
docker compose up -d app
docker compose logs -f app
```

**Wichtig:** Für Compose die Datenbank vor dem App-Start über die Befehle oben migrieren und seeden. Der Web-Setup-Assistent schreibt seine `.env` innerhalb des Containers; diese Datei ist nicht dauerhaft. Ein vollständiges Host-`.env` und das manuelle Seeding vermeiden außerdem, dass ein im Container erzeugter Verschlüsselungsschlüssel nach dem Neustart von Compose-Werten abweicht.

### Manuelle Installation / Entwicklung

1. PostgreSQL bereitstellen und `DATABASE_URL` in `.env` konfigurieren. `.env.example` kann als Vorlage dienen.
2. `SESSION_SECRET` und `NAVIDROME_ENCRYPTION_KEY` durch gültige, zufällige 64-stellige Hex-Schlüssel ersetzen.
3. Abhängigkeiten und Datenbankschema einrichten:

   ```bash
   npm ci
   npm run db:migrate
   npm run db:seed
   ```

   Für das Seeding muss `ADMIN_PASSWORD` (mindestens 8 Zeichen) in `.env` gesetzt sein. Danach `ADMIN_PASSWORD` und `NAVIDROME_PASSWORD` wieder daraus entfernen.

4. Starten:

   ```bash
   npm start
   ```

   Für lokale Entwicklung über unverschlüsseltes HTTP `NODE_ENV=development` setzen. Im Produktionsmodus ist das Session-Cookie auf HTTPS beschränkt.

Wenn noch keine Datenbank konfiguriert ist oder noch kein aktiver Admin existiert, startet OpenWeb im Setup-Modus. Den Setup-Assistenten nur aus einem vertrauenswürdigen Netzwerk aufrufen und nicht öffentlich erreichbar lassen. Nach erfolgreichem Setup beendet sich der Prozess; bei manuellem Start erneut `npm start` ausführen. Eine konfigurierte, aber nicht erreichbare Datenbank führt absichtlich **nicht** in den öffentlichen Setup-Modus.

## Zugangsdaten und Schlüssel-Backup

Navidrome-Passwort, Music-Assistant-Token und SMTP-Passwort werden mit AES-256-GCM verschlüsselt in PostgreSQL gespeichert. `NAVIDROME_ENCRYPTION_KEY` muss dauerhaft gesichert und unverändert erhalten bleiben; ohne passenden Schlüssel sind die bestehenden Zugangsdaten nicht entschlüsselbar.

Im Admin-Panel unter **Daten → Verschlüsselungsschlüssel sichern** eine Backup-Datei erstellen. Dafür wird eine eigene Wiederherstellungs-Passphrase mit mindestens 16 Zeichen festgelegt. **Backup-Datei und Passphrase getrennt und außerhalb des Servers aufbewahren.** Die regulären JSON-Backups enthalten den Verschlüsselungsschlüssel absichtlich nicht.

Wenn die App noch läuft, den Schlüssel im selben Admin-Bereich mit der Backup-Datei, der Wiederherstellungs-Passphrase und dem aktuellen Admin-Passwort wiederherstellen. Wenn OpenWeb wegen eines fehlenden oder ungültigen Schlüssels nicht startet, im Projektverzeichnis ausführen:

```bash
node scripts/restore-encryption-key.js /pfad/zum/openweb-encryption-key-backup.json
```

Das Wiederherstellungspasswort wird verdeckt abgefragt; anschließend den Dienst neu starten. Wird der Schlüssel über eine externe Umgebungsvariablen-Verwaltung bereitgestellt, dort ebenfalls den wiederhergestellten Wert eintragen.

## Einstellungen und Datenhaltung

| Variable | Zweck |
|---|---|
| `DATABASE_URL` | PostgreSQL-Verbindungs-URL; erforderlich im Normalbetrieb |
| `SESSION_SECRET` | Zufälliger 64-Hex-Wert zum Signieren der Sessions |
| `NAVIDROME_ENCRYPTION_KEY` | Zufälliger 64-Hex-Wert für verschlüsselte Dienst-Zugangsdaten |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Initiales Admin-Seeding; `ADMIN_PASSWORD` anschließend entfernen |
| `ADMIN_IP_ALLOWLIST` | Optionale Liste erlaubter Admin-IPv4-Adressen/CIDR-Netze |
| `TRUST_PROXY` | Anzahl vertrauenswürdiger Reverse-Proxys; ohne Proxy auf `0` setzen |
| `DATA_RETENTION_DAYS` | Aufbewahrung von Klickstatistiken (Standard: 365 Tage) |
| `BACKUP_DIR` | Zielverzeichnis der automatischen JSON-Backups (Standard: `./backups`) |

Datenbankmigrationen laufen beim Serverstart. Tägliche JSON-Backups werden um 03:00 Uhr erstellt und lassen sich im Admin-Bereich herunterladen oder manuell auslösen. Die tägliche Wartung löscht abgelaufene Sessions, alte Klickdaten und Monitor-Messpunkte älter als 30 Tage. Die Monitor-Gesamtsummen bleiben dauerhaft in der Datenbank erhalten.

Die automatischen JSON-Backups sichern Profil-, Link-, Kategorie- und ausgewählte Admin-Daten; sie sind keine vollständige PostgreSQL- oder Server-Sicherung. Dateien im Backup-Verzeichnis werden mit restriktiven Dateirechten angelegt.

## Updates

Für die empfohlene Linux-Installation:

```bash
sudo bash install.sh update
```

Das Skript holt den neuesten Code, installiert die in `package-lock.json` festgeschriebenen Produktionsabhängigkeiten, führt Migrationen aus, setzt Dateirechte und bietet einen Dienstneustart an.

Bei Docker Compose:

```bash
git pull --ff-only
docker compose build app
docker compose run --rm app npm run db:migrate
docker compose up -d app
```

## Weitere Informationen

- Öffentliche API-Dokumentation: `/api-docs`
- Änderungen: `/changelog.html`
- Lizenz: MIT
