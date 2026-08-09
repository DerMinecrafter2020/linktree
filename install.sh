#!/usr/bin/env bash
# =========================================================
# OpenWeb Installer / Verwaltungsscript
# Node.js + Express + PostgreSQL
# =========================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP_DIR/.env"
DOCKER_COMPOSE_FILE="$APP_DIR/docker-compose.yml"
NGINX_CONF="/etc/nginx/sites-available/openweb"
SERVICE_NAME="openweb"

# Farben
C_RESET='\033[0m'
C_BOLD='\033[1m'
C_GREEN='\033[0;32m'
C_YELLOW='\033[0;33m'
C_RED='\033[0;31m'
C_CYAN='\033[0;36m'

log()  { echo -e "${C_GREEN}[OpenWeb]${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}[Warnung]${C_RESET} $*"; }
err()  { echo -e "${C_RED}[Fehler]${C_RESET} $*" >&2; }
info() { echo -e "${C_CYAN}[Info]${C_RESET} $*"; }

# =========================================================
# Hilfsfunktionen
# =========================================================
require_command() {
  if ! command -v "$1" &>/dev/null; then
    err "Befehl nicht gefunden: $1"
    err "$2"
    exit 1
  fi
}

wait_for_postgres() {
  local url="$1"
  local max=30
  info "Warte auf PostgreSQL…"
  for i in $(seq 1 $max); do
    if PGPASSWORD="${DB_PASSWORD:-}" psql "$url" -c 'SELECT 1;' &>/dev/null; then
      return 0
    fi
    sleep 1
  done
  err "PostgreSQL nicht innerhalb von ${max}s erreichbar."
  return 1
}

generate_secret() {
  openssl rand -hex 32 || head -c 64 /dev/urandom | xxd -p | tr -d '\n' | head -c 64
}

prompt() {
  local msg="$1"
  local default="${2:-}"
  if [[ -n "$default" ]]; then
    read -rp "${msg} [${default}]: " value
    echo "${value:-$default}"
  else
    read -rp "${msg}: " value
    echo "$value"
  fi
}

prompt_secret() {
  local msg="$1"
  local value
  read -rsp "${msg}: " value
  echo
  echo "$value"
}

prompt_confirm() {
  local msg="$1"
  local default="${2:-y}"
  local value
  read -rp "${msg} (j/N) [${default}]: " value
  value="${value:-$default}"
  [[ "$value" =~ ^[JjYy]$ ]]
}

# =========================================================
# Kommandos
# =========================================================
cmd_install() {
  log "OpenWeb Installation/Setup starten"

  # --- System-Checks --------------------------------------------------------
  require_command node "Node.js muss installiert sein (>=18)."
  require_command npm "npm muss installiert sein."

  NODE_VERSION=$(node --version | sed 's/v//')
  MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [[ "$MAJOR" -lt 18 ]]; then
    err "Node.js >= 18 erforderlich, gefunden: $NODE_VERSION"
    exit 1
  fi

  # --- .env vorbereiten -----------------------------------------------------
  if [[ -f "$ENV_FILE" ]]; then
    warn "Eine .env existiert bereits."
    if ! prompt_confirm "Vorhandene .env behalten und nur fehlende Werte ergaenzen"; then
      mv "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
      log "Alte .env wurde gesichert."
    fi
  fi

  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +a
  fi

  # --- Datenbank-Variante --------------------------------------------------
  info "Datenbank-Variante waehlen:"
  echo "  1) Docker Compose (Postgres-Container)"
  echo "  2) Bestehende PostgreSQL-URL"
  DB_CHOICE="${DB_CHOICE:-}"
  while [[ "$DB_CHOICE" != "1" && "$DB_CHOICE" != "2" ]]; do
    DB_CHOICE=$(prompt "Variante" "1")
  done

  DATABASE_URL=""
  DB_PASSWORD=""
  if [[ "$DB_CHOICE" == "1" ]]; then
    if ! command -v docker &>/dev/null || ! docker compose version &>/dev/null; then
      err "Docker und 'docker compose' werden fuer die Docker-Variante benoetigt."
      exit 1
    fi
    if [[ ! -f "$DOCKER_COMPOSE_FILE" ]]; then
      err "$DOCKER_COMPOSE_FILE nicht gefunden."
      exit 1
    fi
    DATABASE_URL="postgres://openweb:openweb@localhost:5432/openweb"
    DB_PASSWORD="openweb"
  else
    require_command psql "psql wird fuer bestehende Postgres-URL benoetigt."
    DATABASE_URL=$(prompt "PostgreSQL URL" "${DATABASE_URL:-postgres://user:pass@localhost:5432/openweb}")
    DB_PASSWORD=$(echo "$DATABASE_URL" | sed -n 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/p')
  fi

  # --- Admin-Credentials ----------------------------------------------------
  ADMIN_EMAIL=$(prompt "Admin E-Mail" "${ADMIN_EMAIL:-admin@example.com}")
  while true; do
    ADMIN_PASSWORD=$(prompt_secret "Admin Passwort (min. 8 Zeichen)")
    if [[ ${#ADMIN_PASSWORD} -ge 8 ]]; then
      ADMIN_PASSWORD_CONFIRM=$(prompt_secret "Passwort wiederholen")
      if [[ "$ADMIN_PASSWORD" == "$ADMIN_PASSWORD_CONFIRM" ]]; then
        break
      else
        warn "Passwoerter stimmen nicht ueberein."
      fi
    else
      warn "Passwort zu kurz."
    fi
  done

  # --- Session-Secret + Encryption-Key -------------------------------------
  SESSION_SECRET="${SESSION_SECRET:-}"
  if [[ -z "$SESSION_SECRET" ]]; then
    SESSION_SECRET=$(generate_secret)
    info "Neues SESSION_SECRET generiert."
  fi

  NAVIDROME_ENCRYPTION_KEY="${NAVIDROME_ENCRYPTION_KEY:-}"
  if [[ -z "$NAVIDROME_ENCRYPTION_KEY" ]]; then
    NAVIDROME_ENCRYPTION_KEY=$(generate_secret)
    info "Neuer NAVIDROME_ENCRYPTION_KEY generiert."
  fi

  # --- Port / Domain --------------------------------------------------------
  PORT=$(prompt "Server Port" "${PORT:-3000}")
  DOMAIN=$(prompt "Domain (optional, fuer nginx)" "${DOMAIN:-}")

  # --- Navidrome (optional) -------------------------------------------------
  NAVIDROME_ENABLED="false"
  NAVIDROME_URL=""
  NAVIDROME_USERNAME=""
  NAVIDROME_PASSWORD=""
  if prompt_confirm "Navidrome jetzt konfigurieren (optional)" "n"; then
    NAVIDROME_ENABLED="true"
    NAVIDROME_URL=$(prompt "Navidrome URL" "https://navidrome.example.com")
    NAVIDROME_USERNAME=$(prompt "Navidrome Username")
    NAVIDROME_PASSWORD=$(prompt_secret "Navidrome Passwort")
  fi

  # --- .env schreiben -------------------------------------------------------
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=${PORT}
APP_URL=https://${DOMAIN:-localhost:${PORT}}
DATABASE_URL=${DATABASE_URL}
SESSION_SECRET=${SESSION_SECRET}
SESSION_MAX_AGE_MS=86400000
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
NAVIDROME_ENCRYPTION_KEY=${NAVIDROME_ENCRYPTION_KEY}
NAVIDROME_ENABLED=${NAVIDROME_ENABLED}
NAVIDROME_URL=${NAVIDROME_URL}
NAVIDROME_USERNAME=${NAVIDROME_USERNAME}
NAVIDROME_PASSWORD=${NAVIDROME_PASSWORD}
EOF

  log ".env geschrieben."

  # --- Datenbank starten (Docker) -------------------------------------------
  if [[ "$DB_CHOICE" == "1" ]]; then
    log "Starte Postgres-Container…"
    docker compose -f "$DOCKER_COMPOSE_FILE" up -d postgres
    wait_for_postgres "$DATABASE_URL"
  fi

  # --- npm + Datenbank-Setup ------------------------------------------------
  log "Installiere Node-Abhaengigkeiten…"
  (cd "$APP_DIR" && npm install)

  log "Fuehre Migrationen aus…"
  (cd "$APP_DIR" && npm run db:migrate)

  log "Seede Datenbank…"
  (cd "$APP_DIR" && npm run db:seed)

  # --- systemd-Service (nur wenn root) --------------------------------------
  if [[ "$EUID" -eq 0 ]]; then
    if prompt_confirm "systemd-Service einrichten" "j"; then
      cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=OpenWeb Link-in-Bio
After=network.target

[Service]
Type=simple
User=openweb
Group=openweb
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/env npm start
Restart=always
RestartSec=5
EnvironmentFile=${ENV_FILE}

[Install]
WantedBy=multi-user.target
EOF
      id -u openweb &>/dev/null || useradd -r -s /bin/false openweb
      chown -R openweb:openweb "$APP_DIR"
      systemctl daemon-reload
      systemctl enable "$SERVICE_NAME"
      log "Service ${SERVICE_NAME} eingerichtet. Starten mit: systemctl start ${SERVICE_NAME}"
    fi

    # --- nginx (optional) ---------------------------------------------------
    if [[ -n "$DOMAIN" ]] && command -v nginx &>/dev/null && prompt_confirm "nginx als Reverse Proxy einrichten" "j"; then
      cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF
      if [[ ! -L "/etc/nginx/sites-enabled/openweb" ]]; then
        ln -s "$NGINX_CONF" "/etc/nginx/sites-enabled/openweb"
      fi
      nginx -t && systemctl reload nginx
      log "nginx eingerichtet."

      if command -v certbot &>/dev/null && prompt_confirm "SSL-Zertifikat mit Let's Encrypt erstellen" "n"; then
        certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ADMIN_EMAIL" || warn "certbot ist fehlgeschlagen."
      fi
    fi
  else
    warn "Nicht als root ausgefuehrt – systemd/nginx-Skip."
  fi

  log "Installation abgeschlossen."
  info "Starte den Server mit: cd ${APP_DIR} && npm start"
  if [[ "$DB_CHOICE" == "1" ]]; then
    info "Postgres-Container: docker compose up -d postgres"
  fi
}

cmd_update() {
  log "Update: hole neuesten Code und behalte .env/DB bei"
  require_command git "git wird fuer update benoetigt."
  (cd "$APP_DIR" && git pull)
  (cd "$APP_DIR" && npm install)
  (cd "$APP_DIR" && npm run db:migrate)
  log "Update abgeschlossen. Starte den Service neu: sudo systemctl restart ${SERVICE_NAME}"
}

cmd_change_password() {
  ensure_env
  require_command node "node wird benoetigt."
  local email password
  email=$(prompt "Admin E-Mail" "${ADMIN_EMAIL:-}")
  password=$(prompt_secret "Neues Admin Passwort")
  if [[ ${#password} -lt 8 ]]; then
    err "Passwort zu kurz."
    exit 1
  fi
  (cd "$APP_DIR" && ADMIN_EMAIL="$email" ADMIN_PASSWORD="$password" node -e "
require('dotenv').config();
const { hashPassword } = require('./lib/auth');
const db = require('./lib/db');
(async () => {
  const hash = await hashPassword(process.env.ADMIN_PASSWORD);
  await db.query('UPDATE users SET password_hash = \$1, updated_at = NOW() WHERE email = \$2', [hash, process.env.ADMIN_EMAIL]);
  console.log('Passwort geaendert fuer', process.env.ADMIN_EMAIL);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
")
}

cmd_change_navidrome() {
  ensure_env
  require_command node "node wird benoetigt."
  local url username password poll enabled
  enabled="${NAVIDROME_ENABLED:-false}"
  if prompt_confirm "Navidrome aktivieren" "$([[ "$enabled" == \"true\" ]] && echo j || echo n)"; then
    enabled="true"
  else
    enabled="false"
  fi
  url=$(prompt "Navidrome URL" "${NAVIDROME_URL:-}")
  username=$(prompt "Navidrome Username" "${NAVIDROME_USERNAME:-}")
  password=$(prompt_secret "Navidrome Passwort")
  poll=$(prompt "Poll-Intervall in Sekunden" "30")
  (cd "$APP_DIR" && node -e "
require('dotenv').config();
const { encrypt } = require('./lib/crypto');
const db = require('./lib/db');
(async () => {
  const enc = process.env.NAVIDROME_PASSWORD ? encrypt(process.env.NAVIDROME_PASSWORD) : null;
  await db.query(\`
    INSERT INTO navidrome_settings (id, enabled, url, username, password_encrypted, poll_interval_sec)
    VALUES (1, \$1, \$2, \$3, \$4, \$5)
    ON CONFLICT (id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      url = EXCLUDED.url,
      username = EXCLUDED.username,
      password_encrypted = EXCLUDED.password_encrypted,
      poll_interval_sec = EXCLUDED.poll_interval_sec,
      updated_at = NOW()
  \`, [process.env.NAVIDROME_ENABLED === 'true', process.env.NAVIDROME_URL, process.env.NAVIDROME_USERNAME, enc, parseInt(process.env.NAVIDROME_POLL || '30', 10)]);
  console.log('Navidrome-Credentials aktualisiert.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
" NAVIDROME_ENABLED="$enabled" NAVIDROME_URL="$url" NAVIDROME_USERNAME="$username" NAVIDROME_PASSWORD="$password" NAVIDROME_POLL="$poll")
}

cmd_reset_db() {
  if ! prompt_confirm "WARNUNG: Datenbank wirklich zuruecksetzen (alle Daten gehen verloren)" "n"; then
    exit 0
  fi
  ensure_env
  (cd "$APP_DIR" && npm run db:reset)
  (cd "$APP_DIR" && npm run db:migrate)
  (cd "$APP_DIR" && npm run db:seed)
  log "Datenbank wurde zurueckgesetzt und neu geseedet."
}

cmd_logs() {
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    journalctl -u "$SERVICE_NAME" -n 100 -f
  else
    err "Service ${SERVICE_NAME} nicht aktiv."
    exit 1
  fi
}

ensure_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    err ".env nicht gefunden. Bitte zuerst 'bash install.sh' ausfuehren."
    exit 1
  fi
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
}

usage() {
  cat <<EOF
OpenWeb Installer

Verwendung:
  bash install.sh                  Interaktive Erstinstallation
  bash install.sh update           Code aktualisieren
  bash install.sh change-password  Admin-Passwort aendern
  bash install.sh change-navidrome Navidrome-Credentials aendern
  bash install.sh reset-db         DB zuruecksetzen + seeden
  bash install.sh logs             systemd-Logs anzeigen
EOF
}

# =========================================================
# Einstieg
# =========================================================
main() {
  cd "$APP_DIR"
  case "${1:-}" in
    ""|install) cmd_install ;;
    update)       cmd_update ;;
    change-password) cmd_change_password ;;
    change-navidrome) cmd_change_navidrome ;;
    reset-db)     cmd_reset_db ;;
    logs)         cmd_logs ;;
    -h|--help|help) usage ;;
    *) err "Unbekannter Befehl: $1"; usage; exit 1 ;;
  esac
}

main "$@"
