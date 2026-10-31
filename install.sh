#!/usr/bin/env bash
# =========================================================
# OpenWeb Installer / Verwaltungsscript
# Node.js + Express + PostgreSQL
# =========================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Beschreibbare Daten (.env, Backups, Statusdateien). Bei der systemd-Variante liegen sie
# ausserhalb des Code-Verzeichnisses, damit der Service-Benutzer den Code nicht aendern kann.
SYSTEM_DATA_DIR="/var/lib/openweb"
DATA_DIR="$APP_DIR"
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
  # Eingabe/Zeilenumbruch nur auf stderr, sonst landet das "\n" in $(prompt_secret ...)
  if ! read -rsp "${msg}: " value; then
    echo >&2
    err "Keine Eingabe moeglich (kein Terminal?)."
    exit 1
  fi
  echo >&2
  printf '%s\n' "$value"
}

prompt_confirm() {
  local msg="$1"
  local default="${2:-y}"
  local value
  read -rp "${msg} (j/N) [${default}]: " value
  value="${value:-$default}"
  [[ "$value" =~ ^[JjYy]$ ]]
}

# Node.js 26 ist die Zielversion. otplib 13 benoetigt ESM-per-require ab Node 20.19 / 22.12.
require_node() {
  require_command node "Node.js 26 wird empfohlen (Mindestversion: 20.19 bzw. 22.12)."
  require_command npm "npm muss installiert sein."
  local version major minor
  version=$(node --version | sed 's/v//')
  major=$(echo "$version" | cut -d. -f1)
  minor=$(echo "$version" | cut -d. -f2)
  if ! { [[ "$major" -ge 23 ]] || { [[ "$major" -eq 22 ]] && [[ "$minor" -ge 12 ]]; } || { [[ "$major" -eq 20 ]] && [[ "$minor" -ge 19 ]]; }; }; then
    err "Node.js 26 wird empfohlen; mindestens 20.19 (bzw. 22.12) erforderlich, gefunden: $version"
    err "Installationsbefehle fuer Node.js 26 stehen in DEPLOYMENT.md."
    exit 1
  fi
}

# Datenordner bestimmen: OPENWEB_DATA_DIR > /var/lib/openweb (systemd-Installation) > Projektordner
resolve_data_dir() {
  if [[ -n "${OPENWEB_DATA_DIR:-}" ]]; then
    DATA_DIR="$OPENWEB_DATA_DIR"
  elif [[ -d "$SYSTEM_DATA_DIR" ]]; then
    DATA_DIR="$SYSTEM_DATA_DIR"
  else
    DATA_DIR="$APP_DIR"
  fi
  ENV_FILE="$DATA_DIR/.env"
  # Node-Skripte (Migrationen, Seeding, Passwortwechsel) finden die .env so im Datenordner
  if [[ "$DATA_DIR" != "$APP_DIR" ]]; then
    export OPENWEB_DATA_DIR="$DATA_DIR"
  fi
}

# Befehl als Service-Benutzer ausfuehren (falls root und Benutzer vorhanden), sonst direkt
as_app() {
  if [[ "$EUID" -eq 0 ]] && id -u openweb &>/dev/null; then
    runuser -u openweb -- "$@"
  else
    "$@"
  fi
}

# Systemd-Variante mit eigenem Datenordner aktiv?
uses_data_dir() {
  [[ "$EUID" -eq 0 ]] && id -u openweb &>/dev/null && [[ "$DATA_DIR" != "$APP_DIR" ]]
}

# Rechte setzen. Der Code gehoert root und ist fuer den Service-Benutzer nur lesbar; nur der
# Datenordner gehoert "openweb". Rechte in Dateien des Service-Benutzers werden als dieser
# Benutzer gesetzt, damit untergeschobene symbolische Links nichts bewirken.
fix_permissions() {
  if uses_data_dir; then
    chown -R -h root:root "$APP_DIR"
    chmod -R go-w "$APP_DIR"
    install -d -o openweb -g openweb -m 700 "$DATA_DIR"
    if [[ -L "$DATA_DIR/backups" ]]; then
      err "$DATA_DIR/backups ist ein symbolischer Link – bitte pruefen. Abbruch."
      exit 1
    fi
    as_app mkdir -p "$DATA_DIR/backups"
    as_app chmod 700 "$DATA_DIR/backups"
    as_app find "$DATA_DIR" -maxdepth 1 -name .env -type f -exec chmod 600 {} +
    as_app find "$DATA_DIR/backups" -type f -exec chmod 600 {} +
  else
    # Ohne Service-Benutzer: nur Rechte nachziehen, dabei keinen symbolischen Links folgen
    find "$DATA_DIR" -maxdepth 1 -name .env -type f -exec chmod 600 {} +
    if [[ -d "$DATA_DIR/backups" && ! -L "$DATA_DIR/backups" ]]; then
      chmod 700 "$DATA_DIR/backups"
      find "$DATA_DIR/backups" -type f -exec chmod 600 {} +
    fi
  fi
}

# .env als reine Daten lesen (nie per "source" ausfuehren): nur bekannte Schluessel, kein export.
# Die Datei kann vom Service-Benutzer bzw. vom Web-Setup geschrieben worden sein.
ENV_KEYS=" NODE_ENV PORT APP_URL DATABASE_URL SESSION_SECRET SESSION_MAX_AGE_MS ADMIN_EMAIL ADMIN_PASSWORD NAVIDROME_ENCRYPTION_KEY NAVIDROME_ENABLED NAVIDROME_URL NAVIDROME_USERNAME POSTGRES_PASSWORD DOMAIN HOST TRUST_PROXY "
load_env() {
  if [[ -L "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
    err "$ENV_FILE fehlt oder ist keine regulaere Datei."
    exit 1
  fi
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[2]}"
    value="${BASH_REMATCH[3]}"
    [[ "$ENV_KEYS" == *" $key "* ]] || continue
    # Umschliessende Anfuehrungszeichen entfernen (wie dotenv), Inhalt bleibt wortwoertlich
    if [[ "$value" =~ ^\'(.*)\'$ || "$value" =~ ^\"(.*)\"$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    printf -v "$key" '%s' "$value"
  done < "$ENV_FILE"
}

# systemd-Unit schreiben (Code read-only, nur der Datenordner ist beschreibbar)
write_systemd_unit() {
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=OpenWeb Link-in-Bio
After=network.target

[Service]
Type=simple
User=openweb
Group=openweb
WorkingDirectory=${APP_DIR}
Environment=PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin
Environment=OPENWEB_DATA_DIR=${DATA_DIR}
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=5
EnvironmentFile=${ENV_FILE}
# Haertung: keine zusaetzlichen Rechte, eigenes /tmp, System read-only ausser dem Datenordner
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF
}

# Bestehende systemd-Installation (Daten im Code-Ordner, alles "openweb"-eigen) umstellen:
# .env, Backups und Statusdatei nach /var/lib/openweb verschieben und die Unit neu schreiben.
migrate_to_data_dir() {
  [[ "$EUID" -eq 0 ]] || return 0
  id -u openweb &>/dev/null || return 0
  systemctl cat "$SERVICE_NAME" &>/dev/null || return 0
  if [[ "$DATA_DIR" == "$SYSTEM_DATA_DIR" && -f "$SYSTEM_DATA_DIR/.env" ]]; then
    return 0
  fi
  log "Stelle auf getrennten Datenordner um: $SYSTEM_DATA_DIR"
  install -d -o root -g root -m 700 "$SYSTEM_DATA_DIR"
  local item src
  for item in .env backups .last-track-id; do
    src="$APP_DIR/$item"
    if [[ -L "$src" ]]; then
      err "$src ist ein symbolischer Link – bitte manuell pruefen. Abbruch."
      exit 1
    fi
    [[ -e "$src" ]] || continue
    if [[ -e "$SYSTEM_DATA_DIR/$item" ]]; then
      err "$SYSTEM_DATA_DIR/$item existiert bereits – bitte manuell zusammenfuehren. Abbruch."
      exit 1
    fi
    mv "$src" "$SYSTEM_DATA_DIR/$item"
  done
  chown -R -h openweb:openweb "$SYSTEM_DATA_DIR"
  DATA_DIR="$SYSTEM_DATA_DIR"
  ENV_FILE="$DATA_DIR/.env"
  export OPENWEB_DATA_DIR="$DATA_DIR"
  write_systemd_unit
  systemctl daemon-reload
  log ".env und Backups liegen jetzt in $SYSTEM_DATA_DIR."
}

# Warnen, wenn Klartext-Passwoerter aus alten Installationen noch in der .env stehen
warn_plaintext_secrets() {
  [[ -f "$ENV_FILE" ]] || return 0
  local key
  for key in ADMIN_PASSWORD NAVIDROME_PASSWORD; do
    if grep -qE "^${key}=.+" "$ENV_FILE"; then
      warn "${key} steht noch im Klartext in der .env – wird nur fuer das Seeding gebraucht."
      warn "  Entfernen mit: sed -i '/^${key}=/d' \"$ENV_FILE\""
    fi
  done
}

# =========================================================
# Kommandos
# =========================================================
cmd_install() {
  log "OpenWeb Installation/Setup starten"

  # --- System-Checks --------------------------------------------------------
  require_node

  # --- Betriebsart: systemd-Service (root) -> Daten in /var/lib/openweb ------
  USE_SYSTEMD="false"
  if [[ "$EUID" -eq 0 ]] && prompt_confirm "systemd-Service einrichten (empfohlen fuer den Produktivbetrieb)" "j"; then
    USE_SYSTEMD="true"
    id -u openweb &>/dev/null || useradd -r -s /bin/false openweb
    # Bestehende .env aus dem Projektordner uebernehmen (aeltere Installationen)
    if [[ -f "$APP_DIR/.env" && ! -L "$APP_DIR/.env" && ! -e "$SYSTEM_DATA_DIR/.env" ]]; then
      install -d -o root -g root -m 700 "$SYSTEM_DATA_DIR"
      mv "$APP_DIR/.env" "$SYSTEM_DATA_DIR/.env"
    fi
    install -d -m 700 "$SYSTEM_DATA_DIR"
    OPENWEB_DATA_DIR="$SYSTEM_DATA_DIR"
  fi
  resolve_data_dir

  # --- .env vorbereiten -----------------------------------------------------
  OLD_POSTGRES_PASSWORD=""
  if [[ -f "$ENV_FILE" ]]; then
    warn "Eine .env existiert bereits."
    # DB-Passwort eines bestehenden Postgres-Volumes merken, auch wenn die .env ersetzt wird
    OLD_POSTGRES_PASSWORD=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$ENV_FILE" | tail -n 1)
    if ! prompt_confirm "Vorhandene .env behalten und nur fehlende Werte ergaenzen"; then
      mv "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
      log "Alte .env wurde gesichert."
    fi
  fi

  if [[ -f "$ENV_FILE" ]]; then
    load_env
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
    # Neue Installation: zufaelliges DB-Passwort. Existiert das Postgres-Volume bereits,
    # bleibt das dort gesetzte Passwort gueltig (Postgres liest POSTGRES_PASSWORD nur beim ersten Start).
    if [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
      DB_PASSWORD="$POSTGRES_PASSWORD"
    elif [[ -n "$(docker volume ls -q --filter name=openweb-postgres-data)" ]]; then
      # Postgres uebernimmt POSTGRES_PASSWORD nur beim ersten Start -> bisheriges Passwort weiterverwenden
      warn "Bestehendes Postgres-Volume gefunden – es wird das bisherige DB-Passwort benoetigt."
      if [[ -n "$OLD_POSTGRES_PASSWORD" ]]; then
        DB_PASSWORD="$OLD_POSTGRES_PASSWORD"
        info "Verwende POSTGRES_PASSWORD aus der bisherigen .env."
      else
        DB_PASSWORD=$(prompt_secret "Passwort der bestehenden Datenbank (leer = altes Standardpasswort 'openweb')")
        DB_PASSWORD="${DB_PASSWORD:-openweb}"
      fi
    else
      DB_PASSWORD=$(generate_secret)
    fi
    POSTGRES_PASSWORD="$DB_PASSWORD"
    DATABASE_URL="postgres://openweb:${DB_PASSWORD}@localhost:5432/openweb"
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

  # Mit nginx davor: nur auf 127.0.0.1 lauschen und genau einem Proxy-Hop vertrauen.
  # Ohne Proxy: X-Forwarded-For nie vertrauen, sonst ist die Client-IP faelschbar.
  if [[ -n "$DOMAIN" ]] && command -v nginx &>/dev/null; then
    HOST="127.0.0.1"
    TRUST_PROXY="loopback"
  else
    HOST=""
    TRUST_PROXY="0"
  fi

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
  # Nur fuer den Eigentuemer lesbar; Admin-/Navidrome-Passwort werden NICHT gespeichert
  # (nur einmalig beim Seeding als Umgebungsvariable uebergeben).
  (
    umask 077
    cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=${PORT}
APP_URL=https://${DOMAIN:-localhost:${PORT}}
DATABASE_URL=${DATABASE_URL}
SESSION_SECRET=${SESSION_SECRET}
SESSION_MAX_AGE_MS=86400000
ADMIN_EMAIL=${ADMIN_EMAIL}
NAVIDROME_ENCRYPTION_KEY=${NAVIDROME_ENCRYPTION_KEY}
NAVIDROME_ENABLED=${NAVIDROME_ENABLED}
NAVIDROME_URL=${NAVIDROME_URL}
NAVIDROME_USERNAME=${NAVIDROME_USERNAME}
TRUST_PROXY=${TRUST_PROXY}
EOF
    if [[ -n "$HOST" ]]; then
      echo "HOST=${HOST}" >> "$ENV_FILE"
    fi
    if [[ "$DB_CHOICE" == "1" ]]; then
      echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" >> "$ENV_FILE"
    fi
  )
  chmod 600 "$ENV_FILE"
  # Per sudo ohne systemd installiert: .env dem aufrufenden Benutzer geben
  # (systemd-Variante: fix_permissions gibt den Datenordner dem Service-Benutzer)
  if [[ "$EUID" -eq 0 && -n "${SUDO_USER:-}" && "$USE_SYSTEMD" != "true" ]]; then
    chown "$SUDO_USER" "$ENV_FILE"
  fi

  log ".env geschrieben (Rechte 600)."

  # --- Datenbank starten (Docker) -------------------------------------------
  if [[ "$DB_CHOICE" == "1" ]]; then
    log "Starte Postgres-Container…"
    docker compose -f "$DOCKER_COMPOSE_FILE" up -d postgres
    wait_for_postgres "$DATABASE_URL"
  fi

  # --- npm + Datenbank-Setup ------------------------------------------------
  log "Installiere Node-Abhaengigkeiten…"
  # Exakt die Versionen aus package-lock.json (wie beim Update)
  (cd "$APP_DIR" && npm ci --omit=dev)

  log "Fuehre Migrationen aus…"
  (cd "$APP_DIR" && npm run db:migrate)

  log "Seede Datenbank…"
  (cd "$APP_DIR" && ADMIN_PASSWORD="$ADMIN_PASSWORD" NAVIDROME_PASSWORD="${NAVIDROME_PASSWORD:-}" npm run db:seed)

  # --- systemd-Service (nur wenn root) --------------------------------------
  if [[ "$EUID" -eq 0 ]]; then
    if [[ "$USE_SYSTEMD" == "true" ]]; then
      write_systemd_unit
      fix_permissions
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
        proxy_set_header X-Forwarded-Host \$host;
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
    elif [[ "$HOST" == "127.0.0.1" ]]; then
      warn "nginx wurde nicht eingerichtet, die App lauscht aber nur auf 127.0.0.1 (HOST in $ENV_FILE)."
      warn "  Ohne Reverse Proxy HOST entfernen und TRUST_PROXY=0 setzen."

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
  require_node
  resolve_data_dir
  migrate_to_data_dir

  # Code-Verzeichnis gehoert root (aeltere Installationen: "openweb"). Erst die Rechte
  # zuruecknehmen, dann git ausfuehren – ohne safe.directory-Ausnahme und ohne Hooks.
  if uses_data_dir; then
    chown -R -h root:root "$APP_DIR"
    chmod -R go-w "$APP_DIR"
  fi
  # Konfiguration, ueber die git beim Aufruf Programme starten wuerde, nicht akzeptieren
  if grep -qiE '^[[:space:]]*(sshcommand|fsmonitor|hookspath|pager|editor|askpass|helper|gitproxy|textconv|clean|smudge|process|path)[[:space:]]*=|^[[:space:]]*\[(include|includeif|filter|alias)' "$APP_DIR/.git/config" 2>/dev/null; then
    err "$APP_DIR/.git/config enthaelt Eintraege, die Programme starten koennen (z. B. hooksPath, fsmonitor, filter). Bitte pruefen. Abbruch."
    exit 1
  fi
  local git_cmd=(git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.ext.allow=never -C "$APP_DIR")

  # Veraenderte Code-Dateien (ausser der generierten package-lock.json) nicht ueberschreiben,
  # sondern melden: sie koennten manipuliert worden sein.
  local changed
  changed=$("${git_cmd[@]}" status --porcelain --untracked-files=no | grep -v ' package-lock.json$' || true)
  if [[ -n "$changed" ]]; then
    err "Lokal veraenderte Dateien im Code-Verzeichnis gefunden:"
    echo "$changed" >&2
    err "Bitte pruefen (z. B. 'git diff') und bereinigen, dann das Update erneut starten."
    exit 1
  fi

  # Frueher lief hier "npm install", das die package-lock.json lokal veraendert hat.
  # Diese generierte Datei zuruecksetzen, damit "git pull" nicht an lokalen Aenderungen scheitert.
  if ! "${git_cmd[@]}" diff --quiet -- package-lock.json; then
    warn "Lokale Aenderungen an package-lock.json werden verworfen (generierte Datei)."
    "${git_cmd[@]}" checkout -- package-lock.json
  fi
  "${git_cmd[@]}" pull --ff-only

  # Exakt die Versionen aus package-lock.json, ohne Entwicklungs-Pakete
  (cd "$APP_DIR" && npm ci --omit=dev)
  (cd "$APP_DIR" && npm run db:migrate)

  fix_permissions
  warn_plaintext_secrets

  if [[ "$EUID" -eq 0 ]] && systemctl cat "$SERVICE_NAME" &>/dev/null      && prompt_confirm "Service ${SERVICE_NAME} jetzt neu starten" "j"; then
    systemctl restart "$SERVICE_NAME"
    sleep 3
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      log "Update abgeschlossen, Service laeuft."
    else
      err "Service laeuft nicht – Logs: journalctl -u ${SERVICE_NAME} -n 50"
      exit 1
    fi
  else
    log "Update abgeschlossen. Starte den Service neu: sudo systemctl restart ${SERVICE_NAME}"
  fi
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
  # Normalisiert die E-Mail, bricht ab, wenn kein Konto passt, und beendet alle Sitzungen
  if ! (cd "$APP_DIR" && ADMIN_EMAIL="$email" ADMIN_PASSWORD="$password" node scripts/change-password.js); then
    err "Passwort wurde NICHT geaendert."
    exit 1
  fi
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
  password=$(prompt_secret "Navidrome Passwort (leer = unveraendert)")
  poll=$(prompt "Poll-Intervall in Sekunden" "30")
  # Werte als Umgebungsvariablen VOR dem Befehl uebergeben (nach "node -e" waeren es nur Argumente)
  (cd "$APP_DIR" && NAVIDROME_ENABLED="$enabled" NAVIDROME_URL="$url" NAVIDROME_USERNAME="$username" NAVIDROME_PASSWORD="$password" NAVIDROME_POLL="$poll" node -e "
require('./lib/paths').loadEnv();
const { saveSettings } = require('./lib/navidrome');
(async () => {
  // Benutzername und Passwort werden verschluesselt gespeichert; leeres Passwort = unveraendert
  await saveSettings({
    enabled: process.env.NAVIDROME_ENABLED === 'true',
    url: process.env.NAVIDROME_URL,
    username: process.env.NAVIDROME_USERNAME,
    password: process.env.NAVIDROME_PASSWORD,
    pollIntervalSec: process.env.NAVIDROME_POLL,
  });
  console.log('Navidrome-Credentials aktualisiert.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
")
}

cmd_reset_db() {
  if ! prompt_confirm "WARNUNG: Datenbank wirklich zuruecksetzen (alle Daten gehen verloren)" "n"; then
    exit 0
  fi
  ensure_env
  local admin_password="${ADMIN_PASSWORD:-}"
  while [[ ${#admin_password} -lt 8 ]]; do
    admin_password=$(prompt_secret "Neues Admin Passwort (min. 8 Zeichen)")
  done
  (cd "$APP_DIR" && npm run db:reset)
  (cd "$APP_DIR" && npm run db:migrate)
  (cd "$APP_DIR" && ADMIN_PASSWORD="$admin_password" npm run db:seed)
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
  resolve_data_dir
  if [[ ! -f "$ENV_FILE" ]]; then
    err ".env nicht gefunden ($ENV_FILE). Bitte zuerst 'bash install.sh' ausfuehren."
    exit 1
  fi
  load_env
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

# "exit" in derselben Zeile: "install.sh update" aendert diese Datei per git pull waehrend
# sie laeuft – Bash darf danach nicht an alter Position in der neuen Datei weiterlesen.
main "$@"; exit $?
