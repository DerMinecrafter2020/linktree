#!/usr/bin/env bash
# =========================================================
# OpenWeb (Linktree-Clone) — Server-Installations-Skript
# =========================================================
# Was dieses Skript tut:
#   1. Installiert alle System-Abhängigkeiten (nginx, git, curl)
#   2. Fragt nach einem Admin-Passwort (min. 16 Zeichen, gehärtet)
#   3. Klont/aktualisiert die OpenWeb-Seite von GitHub
#      nach /var/html
#   4. Konfiguriert nginx als Reverse-Proxy + Static-Server
#   5. Erstellt einen systemd-Service für Auto-Updates
#
# Aufruf:
#   sudo bash install.sh
#
# Voraussetzungen:
#   - Linux (Debian/Ubuntu)
#   - Root oder sudo
#   - Internetzugang
# =========================================================

set -euo pipefail

# --- Konstanten ---
readonly REPO_URL="https://github.com/DerMinecrafter2020/linktree.git"
readonly INSTALL_DIR="/var/html"
readonly NGINX_SITE_NAME="openweb"
readonly NGINX_CONF="/etc/nginx/sites-available/${NGINX_SITE_NAME}"
readonly NGINX_LINK="/etc/nginx/sites-enabled/${NGINX_SITE_NAME}"
readonly SYSTEMD_SERVICE="/etc/systemd/system/openweb-updater.service"
readonly SYSTEMD_TIMER="/etc/systemd/system/openweb-updater.timer"
readonly UPDATE_SCRIPT="/usr/local/bin/openweb-update.sh"
readonly LOG_FILE="/var/log/openweb-update.log"

# --- Farben für Output ---
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

log_info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok()      { echo -e "${GREEN}[ OK ]${NC} $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error()   { echo -e "${RED}[FAIL]${NC} $*" >&2; }

# --- Root-Check ---
if [[ $EUID -ne 0 ]]; then
    log_error "Bitte als root ausführen: sudo bash $0"
    exit 1
fi

# --- Schritt 1: System-Abhängigkeiten installieren ---
log_info "Installiere System-Abhängigkeiten (nginx, git, curl, ca-certificates)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx git curl ca-certificates ufw >/dev/null
log_ok "Abhängigkeiten installiert"

# --- Schritt 2: Admin-Passwort abfragen ---
# Wir packen das Passwort-Prompt in eine Funktion, weil 'local'
# nur innerhalb von Funktionen erlaubt ist (nicht im while-Loop).
prompt_admin_password() {
    log_info "Konfiguration: Admin-Passwort für /admin.html"
    echo ""

    while true; do
        echo -n "  Admin-Passwort (min. 16 Zeichen, Enter zum Überspringen): "
        if [[ -t 0 ]]; then
            read -rs ADMIN_PASSWORD || ADMIN_PASSWORD=""
        else
            read ADMIN_PASSWORD
        fi

        # Wenn leer, später in config.js als Platzhalter lassen
        if [[ -z "$ADMIN_PASSWORD" ]]; then
            log_warn "Kein Passwort gesetzt. Du musst es später manuell in ${INSTALL_DIR}/config.js eintragen."
            ADMIN_PASSWORD="__SET_ME_MANUALLY__"
            return 0
        fi

        if [[ ${#ADMIN_PASSWORD} -lt 16 ]]; then
            log_error "Passwort zu kurz (${#ADMIN_PASSWORD} Zeichen). Mindestens 16 erforderlich."
            continue
        fi

        # Stärke-Check: mind. 3 von 4 Zeichenklassen
        local classes=0
        [[ "$ADMIN_PASSWORD" =~ [a-z] ]] && classes=$((classes + 1))
        [[ "$ADMIN_PASSWORD" =~ [A-Z] ]] && classes=$((classes + 1))
        [[ "$ADMIN_PASSWORD" =~ [0-9] ]] && classes=$((classes + 1))
        [[ "$ADMIN_PASSWORD" =~ [^a-zA-Z0-9] ]] && classes=$((classes + 1))
        if [[ $classes -lt 3 ]]; then
            log_warn "Passwort ist schwach (verwende mind. 3 von: Klein-/Großbuchstaben, Zahlen, Sonderzeichen)"
            echo -n "  Trotzdem verwenden? (j/n): "
            read -r CONFIRM
            [[ "$CONFIRM" =~ ^[jJyY]$ ]] && return 0
            continue
        fi
        return 0
    done
}

prompt_admin_password

# --- Schritt 3: /var/html vorbereiten + Repo klonen/updaten ---
log_info "Bereite ${INSTALL_DIR} vor und klone GitHub-Repo..."

mkdir -p "$INSTALL_DIR"

if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log_info "Existierendes Git-Repo gefunden — aktualisiere via 'git pull'..."
    cd "$INSTALL_DIR"
    # Lokale Änderungen verwerfen, falls vorhanden (Server-Konfig kommt aus Repo)
    git reset --hard HEAD >/dev/null
    git pull --ff-only origin main
    log_ok "Repo aktualisiert"
else
    log_info "Klone Repo nach ${INSTALL_DIR}..."
    # Falls Verzeichnis nicht leer ist, vorher warnen
    if [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
        log_warn "${INSTALL_DIR} ist nicht leer — Backup wird erstellt"
        mv "$INSTALL_DIR" "${INSTALL_DIR}.backup.$(date +%s)"
        mkdir -p "$INSTALL_DIR"
    fi
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    log_ok "Repo geklont"
fi

# --- Schritt 4: config.js mit echtem Passwort erstellen ---
# Die im Repo gelieferte config.js enthält Platzhalter.
# Wir generieren hier eine lokale config.js, die das echte Passwort enthält.
log_info "Erstelle lokale config.js mit Admin-Passwort..."

# Anon-Key + URL aus dem User erfragen oder Defaults verwenden
echo ""
echo "  Supabase-Konfiguration:"
echo -n "  Supabase URL [https://fxywervpqojpjwreymdp.supabase.co]: "
read SUPABASE_URL
SUPABASE_URL=${SUPABASE_URL:-https://fxywervpqojpjwreymdp.supabase.co}

echo -n "  Supabase anon-key: "
read SUPABASE_ANON_KEY
if [[ -z "$SUPABASE_ANON_KEY" ]]; then
    log_warn "Kein anon-key gesetzt — du musst ihn nachträglich in ${INSTALL_DIR}/config.js eintragen"
    SUPABASE_ANON_KEY="__SET_ME_MANUALLY__"
fi

# Passwort als JSON-String escapen
ADMIN_PASS_JSON=$(printf '%s' "$ADMIN_PASSWORD" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' 2>/dev/null || \
                  printf '%s' "$ADMIN_PASSWORD" | sed 's/\\/\\\\/g; s/"/\\"/g; s/'"'"'/\\'"'"'/g')

cat > "${INSTALL_DIR}/config.js" <<EOF
// Lokale Server-Konfiguration — wird vom Install-Skript erzeugt.
// Bearbeite diese Datei NICHT direkt; stattdessen \`sudo bash install.sh\` erneut ausführen.
window.SUPABASE_CONFIG = {
  url: '${SUPABASE_URL}',
  anonKey: '${SUPABASE_ANON_KEY}',
  authEnabled: false,
  adminProxyUrl:         '${SUPABASE_URL}/functions/v1/admin-proxy',
  authLoginUrl:          '${SUPABASE_URL}/functions/v1/auth-login',
  authChangePasswordUrl: '${SUPABASE_URL}/functions/v1/auth-change-password',
};

window.NAVIDROME_CONFIG = {
  enabled: false,
  url: 'https://music.deinedomain.de',
  user: 'YOUR_USER',
  pass: 'YOUR_PASS',
  proxyUrl: '${SUPABASE_URL}/functions/v1/navidrome-proxy',
  pollIntervalSec: 30,
};

// Wird vom Admin-Panel in localStorage gespeichert (PBKDF2-gehasht).
// Falls der Admin-Passwort-Vergleich gegen das Backend gehen soll,
// muss dieses Passwort identisch zu auth-init sein.
window.ADMIN_DEFAULT_PASSWORD = ${ADMIN_PASS_JSON};
EOF

chmod 640 "${INSTALL_DIR}/config.js"
log_ok "config.js erstellt (chmod 640)"

# --- Schritt 5: nginx konfigurieren ---
log_info "Konfiguriere nginx..."

cat > "$NGINX_CONF" <<EOF
# OpenWeb — automatisch generiert
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root ${INSTALL_DIR};
    index index.html;

    # Sicherheits-Header
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;

    # Statische Files
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Cache für statische Assets (1 Tag)
    location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 1d;
        add_header Cache-Control "public, max-age=86400";
        try_files \$uri =404;
    }

    # Admin-Panel: kein Caching
    location = /admin.html {
        add_header Cache-Control "no-store" always;
        try_files \$uri =404;
    }

    # config.js: niemals cachen, sensible Daten
    location = /config.js {
        add_header Cache-Control "no-store" always;
        try_files \$uri =404;
    }

    # Verzeichnis-Listing deaktivieren
    autoindex off;
}
EOF

# Default-Site deaktivieren, unsere aktivieren
rm -f /etc/nginx/sites-enabled/default

log_info "Site '${NGINX_SITE_NAME}' enablen..."
log_info "  source: ${NGINX_CONF}"
log_info "  target: ${NGINX_LINK}"

# nginx-Site enablen via nginx_ensite (falls verfuegbar), sonst per Symlink
if command -v nginx_ensite >/dev/null 2>&1; then
    nginx_ensite "${NGINX_SITE_NAME}"
    log_ok "Site via nginx_ensite aktiviert"
else
    ln -sf "$NGINX_CONF" "$NGINX_LINK"
    log_ok "Site via Symlink aktiviert: ${NGINX_LINK} -> $(readlink -f "$NGINX_LINK" 2>/dev/null || echo "?")"
fi

# Sicherstellen, dass der Link tatsaechlich existiert und auf unsere Conf zeigt
if [[ ! -L "$NGINX_LINK" ]]; then
    log_error "Konnte Site nicht aktivieren — ${NGINX_LINK} existiert nicht"
    exit 1
fi

LINK_TARGET=$(readlink "$NGINX_LINK")
if [[ "$LINK_TARGET" != "$NGINX_CONF" ]]; then
    log_warn "Symlink zeigt auf '${LINK_TARGET}', erwartet '${NGINX_CONF}' — wird korrigiert"
    ln -sf "$NGINX_CONF" "$NGINX_LINK"
fi

# Liste alle aktivierten Sites
log_info "Aktivierte Sites:"
for site in /etc/nginx/sites-enabled/*; do
    [[ -e "$site" ]] || continue
    log_info "  $(basename "$site") -> $(readlink "$site" 2>/dev/null || echo "(kein Symlink)")"
done

# WICHTIG: Wenn /etc/nginx/nginx.conf einen globalen 'root'-Eintrag
# (z.B. /var/www/html) hat, ueberschreibt dieser unseren server-block-root.
# Wir kommentieren ihn aus oder entfernen ihn, damit unsere root-Direktive greift.
NGINX_MAIN="/etc/nginx/nginx.conf"
if [[ -f "$NGINX_MAIN" ]] && grep -qE '^\s*root\s+/var/www/html' "$NGINX_MAIN"; then
    log_warn "Globaler 'root /var/www/html' in nginx.conf gefunden — wird korrigiert..."
    # Backup + Auskommentieren
    cp -n "$NGINX_MAIN" "${NGINX_MAIN}.bak.$(date +%s)" 2>/dev/null || true
    sed -i 's|^\(\s*\)root\s\+/var/www/html;|\1# root /var/www/html;  # disabled by openweb installer|' "$NGINX_MAIN"
    log_ok "Globaler root in nginx.conf auskommentiert"
fi

# Sicherstellen, dass nginx.conf die sites-enabled einbindet
if [[ -f "$NGINX_MAIN" ]] && ! grep -q 'include /etc/nginx/sites-enabled/\*' "$NGINX_MAIN"; then
    log_warn "nginx.conf bindet sites-enabled nicht ein — wird hinzugefügt..."
    # Im 'http {}'-Block am Ende einfuegen
    sed -i '/^http {/a \    include /etc/nginx/sites-enabled/*;' "$NGINX_MAIN"
    log_ok "include sites-enabled/* zu nginx.conf hinzugefügt"
fi

# nginx-Service selbst aktivieren (Boot-Start)
systemctl enable nginx
log_ok "nginx-Service ist aktiviert (startet bei Boot)"

# nginx testen + reload
nginx -t
systemctl reload nginx
log_ok "nginx konfiguriert und geladen (root = ${INSTALL_DIR})"

# --- Schritt 6: Update-Skript + systemd-Timer ---
log_info "Erstelle Auto-Update-Skript..."

cat > "$UPDATE_SCRIPT" <<'UPDATE_EOF'
#!/usr/bin/env bash
# Auto-Update-Skript für OpenWeb
# Wird vom systemd-Timer alle 5 Minuten aufgerufen.
set -euo pipefail

INSTALL_DIR="/var/html"
LOG_FILE="/var/log/openweb-update.log"
LOCK_FILE="/var/lock/openweb-update.lock"

mkdir -p "$(dirname "$LOG_FILE")"

# Lockfile — verhindert parallele Updates
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "[$(date -Iseconds)] Another update is already running. Skipping." >> "$LOG_FILE"
    exit 0
fi

cd "$INSTALL_DIR"

# Schneller Check: ist Remote voraus?
git fetch origin main --quiet 2>>"$LOG_FILE" || {
    echo "[$(date -Iseconds)] ERROR: git fetch failed" >> "$LOG_FILE"
    exit 1
}

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [[ "$LOCAL" == "$REMOTE" ]]; then
    echo "[$(date -Iseconds)] No updates available (HEAD = origin/main)" >> "$LOG_FILE"
    exit 0
fi

echo "[$(date -Iseconds)] Updating $LOCAL -> $REMOTE" >> "$LOG_FILE"

# Lokale Änderungen verwerfen (Server-Konfig kommt aus config.js, nicht aus Repo)
git reset --hard origin/main >> "$LOG_FILE" 2>&1

# config.js wurde vom Install-Skript gesetzt — nicht überschreiben
# Falls im Repo eine neuere config.js ist, wird sie beim nächsten install.sh überschrieben

# nginx neu laden (kein Restart nötig — static files)
nginx -t >> "$LOG_FILE" 2>&1 && systemctl reload nginx || true

echo "[$(date -Iseconds)] Update applied successfully" >> "$LOG_FILE"
UPDATE_EOF

chmod +x "$UPDATE_SCRIPT"
log_ok "Update-Skript erstellt: $UPDATE_SCRIPT"

# systemd-Service (one-shot, vom Timer gestartet)
cat > "$SYSTEMD_SERVICE" <<EOF
[Unit]
Description=OpenWeb Auto-Update (git pull + nginx reload)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${UPDATE_SCRIPT}
User=root
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
EOF

# systemd-Timer (alle 5 Minuten)
cat > "$SYSTEMD_TIMER" <<EOF
[Unit]
Description=OpenWeb Auto-Update Timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true
Unit=${SYSTEMD_SERVICE##*/}

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable "openweb-updater.timer"
systemctl start  "openweb-updater.timer"
log_ok "systemd-Timer aktiv (alle 5 Min): systemctl list-timers openweb-updater*"

# --- Schritt 7: Firewall (optional) ---
if command -v ufw >/dev/null 2>&1; then
    log_info "Konfiguriere ufw (HTTP/HTTPS offen)..."
    ufw allow 'Nginx Full' >/dev/null 2>&1 || ufw allow 80/tcp >/dev/null 2>&1
    log_ok "ufw: HTTP/HTTPS offen"
fi

# --- Schritt 8: Erster Update-Lauf ---
log_info "Führe ersten Update-Check durch..."
if "$UPDATE_SCRIPT"; then
    log_ok "Erster Update-Check OK (siehe ${LOG_FILE})"
else
    log_warn "Erster Update-Check fehlgeschlagen — prüfe ${LOG_FILE}"
fi

# --- Zusammenfassung ---
# URL-Erkennung: lokale IP(s), öffentliche IP, und Domain-Hinweis
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
PRIMARY_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
# Oeffentliche IP via mehrere Dienste probieren (falls einer down ist)
PUBLIC_IP=""
for ip_service in "https://api.ipify.org" "https://ifconfig.me" "https://ipv4.icanhazip.com"; do
    PUBLIC_IP=$(curl -s --max-time 5 "$ip_service" 2>/dev/null | tr -d '[:space:]')
    [[ -n "$PUBLIC_IP" && "$PUBLIC_IP" =~ ^[0-9.]+$ ]] && break
done
HOSTNAME_FQDN=$(hostname -f 2>/dev/null || hostname)

cat <<EOF

${GREEN}============================================================${NC}
${GREEN} Installation abgeschlossen!${NC}
${GREEN}============================================================${NC}

  Install-Pfad:    ${INSTALL_DIR}
  nginx-Config:    ${NGINX_CONF}
  Update-Skript:   ${UPDATE_SCRIPT}
  Update-Log:      ${LOG_FILE}
  Update-Intervall: alle 5 Minuten

${BLUE}--- Webseite erreichbar unter: ---${NC}
EOF

# URL-Liste ausgeben
if [[ -n "$PUBLIC_IP" ]]; then
    echo -e "  ${GREEN}Öffentlich:${NC}  http://${PUBLIC_IP}/"
fi
if [[ -n "$LOCAL_IP" ]]; then
    echo -e "  ${GREEN}Lokal:    ${NC}  http://${LOCAL_IP}/"
fi
if [[ "$LOCAL_IP" != "$PRIMARY_IP" && -n "$PRIMARY_IP" ]]; then
    echo -e "  ${GREEN}Primär:   ${NC}  http://${PRIMARY_IP}/"
fi
echo -e "  ${GREEN}Hostname: ${NC}  http://${HOSTNAME_FQDN}/  (nur lokal erreichbar)"

cat <<EOF

  ${YELLOW}Test-Befehl:${NC}
    curl -I http://localhost/         # sollte HTTP/1.1 200 OK liefern
    curl http://localhost/ | head -5   # sollte <!DOCTYPE html> zeigen

${YELLOW}Wichtig:${NC}
  - Trage die echten Navidrome-Daten und Supabase-Keys in
    ${INSTALL_DIR}/config.js ein (oder setze sie als Supabase-Secrets).
  - Wenn du eine Domain hast, richte sie als A-Record auf die
    öffentliche IP ein und nutze dann Certbot für HTTPS:
      sudo apt install certbot python3-certbot-nginx
      sudo certbot --nginx -d deine.domain.de

  ${YELLOW}Firewall:${NC}  ufw muss Port 80 (und ggf. 443) offen haben:
    sudo ufw status           # sollte 'Nginx Full' / '80,443/tcp' zeigen
    sudo ufw allow 80/tcp     # falls nicht

  Nützliche Befehle:
    systemctl status openweb-updater.timer
    systemctl list-timers openweb-updater*
    tail -f ${LOG_FILE}
    sudo bash install.sh      # Re-Run für Updates/Re-Config

EOF

log_ok "Fertig!"