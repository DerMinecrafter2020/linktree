#!/usr/bin/env bash
# =========================================================
# OpenWeb (Linktree-Clone) — Server-Installations-Skript
# =========================================================
# Was dieses Skript tut:
#   1. Installiert alle System-Abhängigkeiten (nginx, git, curl)
#   2. Fragt nach einem Admin-Passwort (Default 'admin123' nur für Erst-Login)
#   3. Klont/aktualisiert die OpenWeb-Seite von GitHub nach /var/html
#   4. Konfiguriert nginx als Reverse-Proxy + Static-Server
#   5. Erstellt einen systemd-Service für Auto-Updates
#
# Aufruf:
#   sudo bash install.sh
#
# Modi:
#   sudo bash install.sh                     # interaktives Menü
#   sudo bash install.sh neuinstallieren     # frischer Setup
#   sudo bash install.sh update              # Repo updaten (mit Backup)
#   sudo bash install.sh update-self         # Skript selbst updaten
#   sudo bash install.sh install-cli         # Supabase CLI installieren
#   sudo bash install.sh change-password     # Admin-Passwort ändern
#   sudo bash install.sh enable-admin        # Admin-Bereich aktivieren
#   sudo bash install.sh disable-admin       # Admin-Bereich deaktivieren
#   sudo bash install.sh uninstall           # alles entfernen
#
# Voraussetzungen:
#   - Linux (Debian/Ubuntu)
#   - Root oder sudo
#   - Internetzugang
# =========================================================

set -euo pipefail
IFS=$'\n\t'

# --- Konstanten ---
readonly REPO_URL="https://github.com/DerMinecrafter2020/linktree.git"
readonly REPO_BRANCH="main"
readonly INSTALL_DIR="/var/html"
readonly BACKUP_DIR="/var/backups/openweb"
readonly SERVER_CONFIG_FILE="${INSTALL_DIR}/.openweb.env"
readonly SUPABASE_CLI="${SUPABASE_CLI:-/usr/local/bin/supabase}"
readonly NGINX_SITE_NAME="openweb"
readonly NGINX_CONF="/etc/nginx/sites-available/${NGINX_SITE_NAME}"
readonly NGINX_LINK="/etc/nginx/sites-enabled/${NGINX_SITE_NAME}"
readonly NGINX_ADMIN_STATE="/etc/nginx/openweb-admin-state.conf"
readonly NGINX_MAIN="/etc/nginx/nginx.conf"
readonly SYSTEMD_SERVICE="/etc/systemd/system/openweb-updater.service"
readonly SYSTEMD_TIMER="/etc/systemd/system/openweb-updater.timer"
readonly UPDATE_SCRIPT="/usr/local/bin/openweb-update.sh"
readonly LOG_FILE="/var/log/openweb-update.log"
readonly LOCK_FILE="/var/lock/openweb-update.lock"
readonly BACKUP_RETENTION_DAYS=30

# Exit-Codes
readonly EX_OK=0
readonly EX_USAGE=1
readonly EX_PERM=2
readonly EX_NETWORK=3
readonly EX_GIT=4
readonly EX_NGINX=5
readonly EX_CONFIG=6
readonly EX_DEPENDENCY=7
readonly EX_SOFTWARE=70

# --- Farben für Output ---
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok()      { echo -e "${GREEN}[ OK ]${NC} $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error()   { echo -e "${RED}[FAIL]${NC} $*" >&2; }

# Auch in LOG_FILE schreiben, falls definiert
_log() {
    local level="$1"; shift
    local msg="$*"
    if [[ -n "${LOG_FILE:-}" ]]; then
        mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
        printf '[%s] [%s] %s\n' "$(date -Iseconds 2>/dev/null || date)" "$level" "$msg" >> "$LOG_FILE" 2>/dev/null || true
    fi
}

# Lock-Variablen für cleanup_on_exit
HELD_LOCK=""
HELD_LOCK_FD=""

# Trap für sauberes Aufräumen bei Abbruch
cleanup_on_exit() {
    local exit_code=$?
    if [[ -n "${HELD_LOCK:-}" && -e "$HELD_LOCK" ]]; then
        flock -u "${HELD_LOCK_FD:-9}" 2>/dev/null || true
        rm -f "$HELD_LOCK" 2>/dev/null || true
    fi
    exit "$exit_code"
}
trap cleanup_on_exit EXIT

# =========================================================
# HILFSFUNKTIONEN
# =========================================================

# Lock akquirieren (verhindert parallele Ausführung; re-entrant im selben Prozess)
acquire_lock() {
    if [[ -n "${HELD_LOCK:-}" ]]; then
        return 0
    fi
    local lock="${LOCK_FILE}.main"
    mkdir -p "$(dirname "$lock")" 2>/dev/null || true
    exec 9>"$lock"
    if ! flock -n 9; then
        log_error "Ein anderer openweb-Prozess läuft bereits (Lock: $lock)"
        return 1
    fi
    HELD_LOCK="$lock"
    HELD_LOCK_FD=9
    return 0
}

# JSON-String-Escaping (für Passwörter in config.js)
json_escape() {
    local val="$1"
    if command -v python3 >/dev/null 2>&1; then
        printf '%s' "$val" | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))'
    else
        printf '"%s"' "$val" | sed 's/\\/\\\\/g; s/"/\\"/g; s/'"'"'/\\'"'"'/g'
    fi
}

# Backup erstellen (timestamped)
create_backup() {
    local src="$1"
    local label="${2:-backup}"
    if [[ ! -e "$src" ]]; then
        log_warn "Backup-Quelle existiert nicht: $src" >&2
        return 1
    fi
    mkdir -p "$BACKUP_DIR" 2>/dev/null || {
        log_warn "Kann Backup-Verzeichnis nicht erstellen: $BACKUP_DIR" >&2
        return 1
    }
    local name
    name="$(basename "$src")"
    local ts
    ts=$(date +%Y%m%d-%H%M%S)
    local dest="${BACKUP_DIR}/${name}.${label}.${ts}.tar.gz"
    # Temporäre Datei + atomisches Umbenennen vermeidet halbe Backups
    local tmp_dest="${dest}.tmp.$$"
    if tar -czf "$tmp_dest" -C "$(dirname "$src")" "$name" 2>/dev/null; then
        if mv -f "$tmp_dest" "$dest" 2>/dev/null; then
            chmod 600 "$dest"
            log_ok "Backup erstellt: $dest" >&2
            echo "$dest"
            return 0
        fi
    fi
    log_warn "Backup fehlgeschlagen: $dest" >&2
    rm -f "$tmp_dest"
    return 1
}

# Erkennen, ob ein Wert ein Platzhalter ist
is_placeholder() {
    case "${1:-}" in
        ""|"__SET_ME_MANUALLY__"|"YOUR_USER"|"YOUR_PASS"|"YOUR-PROJECT"*|"YOUR-ANON-KEY"*|"admin123") return 0;;
        *) return 1 ;;
    esac
}

# Prüft, dass benötigte Variablen gesetzt und keine Platzhalter sind
require_env_vars() {
    local missing=()
    for var in "$@"; do
        local val
        val="${!var:-}"
        if [[ -z "$val" ]] || is_placeholder "$val"; then
            missing+=("$var")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Folgende Umgebungsvariablen fehlen oder sind ungültig: ${missing[*]}"
        return 1
    fi
    return 0
}

# Wert aus config.js extrahieren (Format: key: 'value')
_extract_config_js_value() {
    local file="$1"
    local key="$2"
    grep -oE "${key}:\s*['\"][^'\"]*['\"]" "$file" 2>/dev/null | head -1 | sed -E "s/^.*${key}:\s*['\"]//;s/['\"],?\s*$//"
}

# Stellt sicher, dass temporaere Dateien im Fehlerfall entfernt werden
_cleanup_temp_configs() {
    [[ -n "${config_backup:-}" && -f "${config_backup}" ]] && rm -f "${config_backup}"
    [[ -n "${server_config_backup:-}" && -f "${server_config_backup}" ]] && rm -f "${server_config_backup}"
}

# Serverseitige Konfiguration laden (.openweb.env)
load_server_config() {
    if [[ ! -f "$SERVER_CONFIG_FILE" ]]; then
        return 0
    fi
    log_info "Lade serverseitige Konfiguration aus ${SERVER_CONFIG_FILE}..."
    local line key val
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Zeilenumbruch-Reste entfernen
        line="${line%$'\r'}"
        case "$line" in
            ''|\#*) continue ;;
        esac
        if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
            key="${line%%=*}"
            val="${line#*=}"
            # Entferne einfache/doppelte Anführungszeichen am Anfang/Ende
            val="${val#[\"\']}" && val="${val%[\"\']}"
            # Trim: CR (\r), LF, Tab und Leerzeichen entfernen
            val="${val//$'\r'/}"
            val="${val#"${val%%[![:space:]]*}"}" && val="${val%"${val##*[![:space:]]}"}"
            export "$key"="$val"
        fi
    done < "$SERVER_CONFIG_FILE"
}

# Serverseitige Konfiguration speichern (.openweb.env)
save_server_config() {
    local file="$SERVER_CONFIG_FILE"
    local tmp
    tmp=$(mktemp "${file}.tmp.XXXXXX")
    cat > "$tmp" <<EOF
# OpenWeb serverseitige Konfiguration
# Wird von install.sh geschrieben. Enthält serverseitige Einstellungen
# (URL, anon-Key, Discord/Navidrome, Shared Secret für save-config).
# Niemals in git committen — steht in .gitignore.
SUPABASE_URL='${SUPABASE_URL:-}'
SUPABASE_ANON_KEY='${SUPABASE_ANON_KEY:-}'
CONFIG_SHARED_SECRET='${CONFIG_SHARED_SECRET:-}'
NAVIDROME_URL='${NAV_URL:-}'
NAVIDROME_USER='${NAV_USER:-}'
NAVIDROME_PASS='${NAVIDROME_PASS:-}'
EOF
    chmod 600 "$tmp"
    mv -f "$tmp" "$file"
    log_ok "Server-Konfiguration gespeichert: ${file}"
}

# Sicherstellen, dass .openweb.env existiert (Migration / Repair)
# Wird im Update-, Restore- und Install-Modus aufgerufen.
ensure_server_config() {
    local from_config=0

    # 1) Wenn .openweb.env existiert: nur Secret prüfen/generieren und aktualisieren
    if [[ -f "$SERVER_CONFIG_FILE" ]]; then
        load_server_config
        if [[ -z "${CONFIG_SHARED_SECRET:-}" ]] || is_placeholder "$CONFIG_SHARED_SECRET"; then
            if command -v openssl >/dev/null 2>&1; then
                CONFIG_SHARED_SECRET=$(openssl rand -hex 32 2>/dev/null)
            else
                CONFIG_SHARED_SECRET=$(tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 64)
            fi
            save_server_config
        fi
        from_config=0
    else
        # 2) .openweb.env fehlt: Werte aus config.js übernehmen
        if [[ -f "${INSTALL_DIR}/config.js" ]]; then
            log_info "Erstelle ${SERVER_CONFIG_FILE} aus bestehender config.js..."
            SUPABASE_URL=$(_extract_config_js_value "${INSTALL_DIR}/config.js" "url")
            SUPABASE_ANON_KEY=$(_extract_config_js_value "${INSTALL_DIR}/config.js" "anonKey")
            NAV_URL=$(_extract_config_js_value "${INSTALL_DIR}/config.js" "url")
            from_config=1
        fi

        # Shared Secret generieren
        if [[ -z "${CONFIG_SHARED_SECRET:-}" ]] || is_placeholder "$CONFIG_SHARED_SECRET"; then
            if command -v openssl >/dev/null 2>&1; then
                CONFIG_SHARED_SECRET=$(openssl rand -hex 32 2>/dev/null)
            else
                CONFIG_SHARED_SECRET=$(tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 64)
            fi
        fi

        save_server_config
    fi

    # 3) Shared Secret in Supabase setzen, falls CLI verfügbar
    local cli=""
    [[ -x "$SUPABASE_CLI" ]] && cli="$SUPABASE_CLI"
    command -v supabase >/dev/null 2>&1 && cli="${cli:-supabase}"
    if [[ -n "$cli" ]] && "$cli" projects list 2>/dev/null >/dev/null; then
        log_info "Stelle sicher, dass CONFIG_SHARED_SECRET in Supabase gesetzt ist..."
        if "$cli" secrets set CONFIG_SHARED_SECRET="$CONFIG_SHARED_SECRET" 2>&1 | sed 's/^/    /'; then
            log_ok "CONFIG_SHARED_SECRET in Supabase gesetzt"
        else
            log_warn "Konnte CONFIG_SHARED_SECRET nicht in Supabase setzen"
        fi
    else
        log_warn "supabase CLI nicht eingeloggt — CONFIG_SHARED_SECRET nur lokal gespeichert"
        log_warn "  Später manuell setzen (Projekt muss mit 'supabase link' verknüpft sein):"
        log_warn "    supabase link"
        log_warn "    supabase secrets set CONFIG_SHARED_SECRET='$CONFIG_SHARED_SECRET'"
    fi

    # 4) config.js-Permissions korrigieren (falls sie falsch sind)
    if [[ -f "${INSTALL_DIR}/config.js" ]]; then
        chmod 644 "${INSTALL_DIR}/config.js" 2>/dev/null || true
    fi

    if [[ "$from_config" -eq 1 ]]; then
        log_ok "Server-Konfiguration wurde aus config.js migriert"
    fi
}

# Alte Backups löschen (Default: 30 Tage)
cleanup_old_backups() {
    local days="${1:-$BACKUP_RETENTION_DAYS}"
    if [[ ! -d "$BACKUP_DIR" ]]; then
        return 0
    fi
    find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.tar.gz' -mtime +"$days" -print0 2>/dev/null \
        | xargs -0 -r rm -f
}

# Sicheren Token-Download von URL
safe_download() {
    local url="$1"
    local dest="$2"
    local min_size="${3:-100}"
    if curl -fsSL --max-time 60 "$url" -o "$dest" 2>/dev/null; then
        local size
        size=$(stat -c%s "$dest" 2>/dev/null || stat -f%z "$dest" 2>/dev/null || echo 0)
        if [[ "$size" -lt "$min_size" ]]; then
            log_error "Download zu klein ($size Bytes) — vermutlich keine gültige Antwort"
            rm -f "$dest"
            return 1
        fi
        return 0
    fi
    rm -f "$dest"
    return 1
}

# Supabase-Secret auslesen (CLI erfordert Login)
get_supabase_secret() {
    local name="$1"
    local cli=""
    [[ -x "$SUPABASE_CLI" ]] && cli="$SUPABASE_CLI"
    command -v supabase >/dev/null 2>&1 && cli="${cli:-supabase}"
    [[ -z "$cli" ]] && { log_warn "supabase CLI nicht verfügbar" >&2; return 1; }

    local val
    if ! val=$("$cli" secrets get "$name" 2>/dev/null | head -n1 | tr -d '\r'); then
        log_warn "supabase secrets get '$name' fehlgeschlagen — ist die CLI eingeloggt?" >&2
        return 1
    fi
    if [[ -n "$val" && "$val" != *"error"* && "$val" != *"Error"* ]]; then
        echo "$val"
        return 0
    fi
    log_warn "supabase secrets get '$name' lieferte keinen Wert" >&2
    return 1
}

# =========================================================
# GIT-OPERATIONEN (DRY — von do_update, install und Timer genutzt)
# =========================================================

# Sicheren git-Pull durchführen mit Verifikation
# Exit: 0=ok+neue Commits, 2=keine Updates, 1=Fehler
git_pull_safe() {
    local workdir="${1:-$INSTALL_DIR}"

    if [[ ! -d "${workdir}/.git" ]]; then
        log_error "Kein Git-Repo unter ${workdir}"
        return 1
    fi

    # 1) Remote-Stand holen (im Zielverzeichnis, cwd vorher wiederherstellen)
    if ! (cd "$workdir" && git fetch origin "$REPO_BRANCH" --quiet 2>/dev/null); then
        log_error "git fetch fehlgeschlagen — Netzwerkproblem?"
        return 1
    fi

    local local_sha remote_sha
    local_sha=$(cd "$workdir" && git rev-parse HEAD 2>/dev/null || echo "unknown")
    remote_sha=$(cd "$workdir" && git rev-parse "origin/${REPO_BRANCH}" 2>/dev/null || echo "unknown")

    # 2) Bereits aktuell?
    if [[ "$local_sha" == "$remote_sha" ]]; then
        log_info "Bereits aktuell (HEAD = origin/${REPO_BRANCH})"
        return 2
    fi

    # 3) Liste der neuen Commits anzeigen (max 10)
    log_info "Neue Commits:"
    (cd "$workdir" && git log --oneline --max-count=10 "${local_sha}..origin/${REPO_BRANCH}" 2>/dev/null) | sed 's/^/    /' || true

    # 4) Pre-Update-Backup
    log_info "Erstelle Pre-Update-Backup..."
    if ! create_backup "$workdir" "pre-update" >/dev/null; then
        log_warn "Backup fehlgeschlagen — Update wird trotzdem fortgesetzt"
    else
        cleanup_old_backups
    fi

    # 5) Lokale config.js und serverseitige .openweb.env sichern
    local config_backup=""
    local server_config_backup=""
    if [[ -f "${workdir}/config.js" ]]; then
        config_backup=$(mktemp /tmp/openweb-config.XXXXXX.js)
        cp -f "${workdir}/config.js" "$config_backup"
        log_info "Lokale config.js temporär gesichert (wird nach Update wiederhergestellt)"
    fi
    if [[ -f "${workdir}/.openweb.env" ]]; then
        server_config_backup=$(mktemp /tmp/openweb-server-config.XXXXXX.env)
        cp -f "${workdir}/.openweb.env" "$server_config_backup"
        log_info "Server-Konfiguration .openweb.env temporär gesichert"
    fi
    log_info "Alle in Supabase gespeicherten Daten bleiben bei einem Update unberührt"

    # 6) Update anwenden: erst stash, dann pull, bei Bedarf reset
    local stash_done=0
    if (cd "$workdir" && git status --porcelain 2>/dev/null | grep -q .); then
        log_warn "Lokale Änderungen erkannt — werden vor dem Pull zwischengespeichert"
        if (cd "$workdir" && git stash push -u -m "openweb-auto-stash-$(date +%Y%m%d-%H%M%S)" 2>&1 | sed 's/^/    /'); then
            stash_done=1
        else
            log_warn "git stash fehlgeschlagen — versuche reset --hard"
        fi
    fi

    if ! (cd "$workdir" && git pull --ff-only origin "$REPO_BRANCH" 2>&1 | sed 's/^/    /'); then
        log_warn "Fast-forward Pull fehlgeschlagen — versuche reset --hard"
        if ! (cd "$workdir" && git reset --hard "origin/${REPO_BRANCH}" 2>&1 | sed 's/^/    /'); then
            log_error "git reset --hard fehlgeschlagen"
            [[ -n "$config_backup" ]] && mv -f "$config_backup" "${workdir}/config.js"
            [[ -n "$server_config_backup" ]] && mv -f "$server_config_backup" "${workdir}/.openweb.env"
            _cleanup_temp_configs
            return 1
        fi
    fi

    # Stash wieder anwenden, falls einer erstellt wurde
    if [[ "$stash_done" -eq 1 ]]; then
        if (cd "$workdir" && git stash pop 2>&1 | sed 's/^/    /'); then
            log_ok "Lokale Änderungen wiederhergestellt (stash pop)"
        else
            log_warn "git stash pop fehlgeschlagen — Änderungen liegen im git-stash"
        fi
    fi

    # 7) config.js und .openweb.env wiederherstellen (übernehmen lokale Anpassungen)
    if [[ -n "$config_backup" && -f "$config_backup" ]]; then
        mv -f "$config_backup" "${workdir}/config.js"
        chmod 644 "${workdir}/config.js"
        log_ok "Lokale config.js wiederhergestellt"
    fi
    if [[ -n "$server_config_backup" && -f "$server_config_backup" ]]; then
        mv -f "$server_config_backup" "${workdir}/.openweb.env"
        chmod 600 "${workdir}/.openweb.env"
        log_ok "Server-Konfiguration .openweb.env wiederhergestellt"
    fi
    _cleanup_temp_configs
    log_info "Keine Datenbank/Supabase-Daten verändert — update sicher für bestehende Inhalte"

    # 8) Verifikation
    local new_sha
    new_sha=$(cd "$workdir" && git rev-parse HEAD 2>/dev/null || echo "unknown")
    if [[ "$new_sha" != "$remote_sha" ]]; then
        log_error "Update-Verifikation fehlgeschlagen: HEAD=$new_sha, erwartet=$remote_sha"
        return 1
    fi

    log_ok "Repo aktualisiert: ${local_sha:0:7} → ${new_sha:0:7}"
    return 0
}

# Fallback: Aktuelle Anwendungsdateien direkt von GitHub RAW herunterladen
# Wird verwendet, wenn git_pull_safe komplett fehlschlägt.
download_latest_files() {
    local workdir="${1:-$INSTALL_DIR}"
    local base_url="https://raw.githubusercontent.com/DerMinecrafter2020/linktree/${REPO_BRANCH}"
    local files=(
        .gitignore
        index.html admin.html
        styles.css admin.css
        app.js admin.js supabase-client.js icons.js
        api/supabase.js api/navidrome.js
        api/README.md
        supabase/functions/save-config/index.ts
        supabase/functions/admin-proxy/index.ts
        supabase/functions/navidrome-proxy/index.ts
    )

    log_warn "Git-Update nicht möglich — lade aktuelle Dateien direkt von GitHub..."
    local tmp_dir
    tmp_dir=$(mktemp -d /tmp/openweb-download.XXXXXX)
    local failed=0

    for f in "${files[@]}"; do
        local dest="${tmp_dir}/${f}"
        mkdir -p "$(dirname "$dest")"
        if safe_download "${base_url}/${f}" "$dest" 100; then
            log_ok "  ${f} heruntergeladen"
        else
            log_warn "  ${f} konnte nicht heruntergeladen werden"
            failed=$((failed + 1))
        fi
    done

    if [[ "$failed" -gt 0 ]]; then
        log_error "${failed} Datei(en) konnten nicht heruntergeladen werden — Fallback abgebrochen"
        rm -rf "$tmp_dir"
        return 1
    fi

    # Sicherungen der lokalen Dateien erstellen
    local config_backup=""
    local server_config_backup=""
    if [[ -f "${workdir}/config.js" ]]; then
        config_backup=$(mktemp /tmp/openweb-config.XXXXXX.js)
        cp -f "${workdir}/config.js" "$config_backup"
    fi
    if [[ -f "${workdir}/.openweb.env" ]]; then
        server_config_backup=$(mktemp /tmp/openweb-server-config.XXXXXX.env)
        cp -f "${workdir}/.openweb.env" "$server_config_backup"
    fi

    # Heruntergeladene Dateien ins Installationsverzeichnis kopieren
    if cp -a "${tmp_dir}/." "${workdir}/" 2>&1 | sed 's/^/    /'; then
        log_ok "Dateien nach ${workdir} kopiert"
    else
        log_error "Kopieren der heruntergeladenen Dateien fehlgeschlagen"
        [[ -n "$config_backup" ]] && mv -f "$config_backup" "${workdir}/config.js"
        [[ -n "$server_config_backup" ]] && mv -f "$server_config_backup" "${workdir}/.openweb.env"
        rm -rf "$tmp_dir"
        return 1
    fi

    # Lokale Konfiguration wiederherstellen
    if [[ -n "$config_backup" && -f "$config_backup" ]]; then
        mv -f "$config_backup" "${workdir}/config.js"
        chmod 644 "${workdir}/config.js"
        log_ok "Lokale config.js wiederhergestellt"
    fi
    if [[ -n "$server_config_backup" && -f "$server_config_backup" ]]; then
        mv -f "$server_config_backup" "${workdir}/.openweb.env"
        chmod 600 "${workdir}/.openweb.env"
        log_ok "Server-Konfiguration .openweb.env wiederhergestellt"
    fi

    rm -rf "$tmp_dir"
    return 0
}

# Services nach Update/Restore sauber neu starten
# - nginx: reload (kein restart nötig für static files, aber bei config-Änderungen restart)
# - systemd-Timer: restart damit geänderte UPDATE_SCRIPT sofort aktiv wird
# - ggf. weitere Services, die wir in Zukunft brauchen
_restart_services_post_update() {
    local failed=0

    # 1) nginx reload (mit Fallback auf restart wenn reload scheitert)
    log_info "  [1/3] nginx neu laden..."
    if nginx -t >/dev/null 2>&1; then
        if systemctl reload nginx 2>/dev/null; then
            log_ok "  nginx reloaded"
        else
            log_warn "  nginx reload fehlgeschlagen — versuche restart..."
            if systemctl restart nginx 2>/dev/null; then
                log_ok "  nginx restarted"
            else
                log_error "  nginx restart fehlgeschlagen"
                failed=$((failed + 1))
            fi
        fi
    else
        log_error "  nginx config-Test fehlgeschlagen — Service wird nicht neugestartet"
        failed=$((failed + 1))
    fi

    # 2) systemd-Timer neu starten (lädt ggf. geänderte UPDATE_SCRIPT-Datei)
    log_info "  [2/3] systemd-Timer neu starten..."
    if systemctl list-unit-files openweb-updater.timer >/dev/null 2>&1; then
        # Geänderte Unit-Dateien einlesen; Service neustarten, Timer NICHT
        # (Timer-Restart im eigenen Service würde rekursive Trigger riskieren)
        systemctl daemon-reload 2>/dev/null || true
        if systemctl restart openweb-updater.service 2>/dev/null; then
            log_ok "  openweb-updater.service restarted"
        else
            log_warn "  service restart fehlgeschlagen — versuche timer reenable..."
            if systemctl restart openweb-updater.timer 2>/dev/null; then
                log_ok "  openweb-updater.timer restarted"
            else
                log_error "  openweb-updater.timer restart fehlgeschlagen"
                failed=$((failed + 1))
            fi
        fi
    else
        log_warn "  openweb-updater.timer nicht installiert — übersprungen"
    fi

    # 3) Bestätigung dass nginx aktiv ist
    log_info "  [3/3] Service-Status verifizieren..."
    if systemctl is-active --quiet nginx; then
        log_ok "  nginx läuft"
    else
        log_error "  nginx ist nicht aktiv!"
        failed=$((failed + 1))
    fi

    return $failed
}

# Rollback vom letzten Pre-Update-Backup
_rollback_from_backup() {
    local target="$1"
    local latest
    latest=$(ls -1t "${BACKUP_DIR}/$(basename "$target").pre-update."*.tar.gz 2>/dev/null | head -1 || true)
    if [[ -z "$latest" ]]; then
        log_error "Kein Backup zum Rollback gefunden"
        return 1
    fi
    log_warn "Rollback auf: $latest"

    # Ziel vollständig leeren, bevor Backup entpackt wird (verhindert vermischte Restdateien)
    local parent
    parent="$(dirname "$target")"
    if [[ -d "$target" ]]; then
        find "$target" -mindepth 1 -delete 2>/dev/null || rm -rf "$target"/* "$target"/.[!.]* 2>/dev/null || true
    else
        mkdir -p "$parent"
    fi

    if tar -xzf "$latest" -C "$parent" 2>/dev/null; then
        log_ok "Rollback erfolgreich"
        return 0
    fi
    log_error "Rollback via tar fehlgeschlagen"
    return 1
}

# =========================================================
# MODI-FUNKTIONEN
# =========================================================

# 1) Update von GitHub
do_update() {
    acquire_lock || exit $EX_USAGE

    log_info "Update von ${REPO_URL} (Branch: ${REPO_BRANCH})..."
    log_info "Hinweis: Mit 'update' werden nur Anwendungsdateien ersetzt. Alle Supabase-Daten und die lokale config.js bleiben erhalten."

    # Sicherstellen, dass .openweb.env existiert und Shared Secret gesetzt ist
    ensure_server_config

    local result
    git_pull_safe "$INSTALL_DIR"
    result=$?

    case $result in
        0|2)
            # 0 = Update erfolgreich, 2 = bereits aktuell
            # In beiden Fällen Reparatur + Deployment ausführen
            if [[ "$result" -eq 0 ]]; then
                log_info "Update angewendet — starte Services neu..."
            else
                log_info "Bereits aktuell — führe trotzdem Reparatur + Edge-Function-Deployment durch..."
            fi

            # Edge Functions deployen (falls CLI verfügbar)
            deploy_edge_functions || log_warn "Edge-Function-Deployment übersprungen"

            # Services neu starten
            if ! _restart_services_post_update; then
                log_error "Service-Restart fehlgeschlagen — versuche Rollback"
                _rollback_from_backup "$INSTALL_DIR" || log_error "Rollback fehlgeschlagen — manuell eingreifen!"
                return $EX_NGINX
            fi
            _log "INFO" "Update erfolgreich (Services neu gestartet)"
            log_info "Vorhandene Supabase-Daten und config.js wurden nicht verändert"
            ;;
        *)
            log_error "Git-Update fehlgeschlagen — versuche GitHub-Fallback..."
            if download_latest_files "$INSTALL_DIR"; then
                log_info "GitHub-Fallback erfolgreich — führe Reparatur + Edge-Function-Deployment durch..."
                deploy_edge_functions || log_warn "Edge-Function-Deployment übersprungen"
                if ! _restart_services_post_update; then
                    log_error "Service-Restart fehlgeschlagen — versuche Rollback"
                    _rollback_from_backup "$INSTALL_DIR" || log_error "Rollback fehlgeschlagen — manuell eingreifen!"
                    return $EX_NGINX
                fi
                _log "INFO" "Update via GitHub-Fallback erfolgreich"
                log_info "Vorhandene Supabase-Daten und config.js wurden nicht verändert"
            else
                log_error "Update komplett fehlgeschlagen (Git und GitHub-Fallback)"
                return $EX_GIT
            fi
            ;;
    esac
    return $EX_OK
}

# 2) Manuelles Backup erstellen
do_backup() {
    acquire_lock || exit $EX_USAGE

    if [[ ! -d "$INSTALL_DIR" ]]; then
        log_error "Keine Installation unter ${INSTALL_DIR} gefunden"
        exit $EX_USAGE
    fi

    log_info "Backup erstellen — Quelle: ${INSTALL_DIR}"
    echo ""

    # Backup-Strategie wählen
    echo "  Was soll gesichert werden?"
    echo ""
    echo "    [1] Komplette Installation (${INSTALL_DIR})"
    echo "    [2] Nur config.js"
    echo "    [3] Nur nginx-Config (${NGINX_CONF})"
    echo "    [4] Nur Update-Skript (${UPDATE_SCRIPT})"
    echo "    [5] Eigener Pfad"
    echo "    [0] Abbrechen"
    echo ""
    echo -n "  Auswahl [0-5]: "
    read -r CHOICE

    local BACKUP_SRC=""
    local BACKUP_LABEL=""

    case "$CHOICE" in
        1)
            BACKUP_SRC="$INSTALL_DIR"
            BACKUP_LABEL="manual-full"
            ;;
        2)
            if [[ ! -f "${INSTALL_DIR}/config.js" ]]; then
                log_error "Keine config.js gefunden"
                exit $EX_USAGE
            fi
            BACKUP_SRC="${INSTALL_DIR}/config.js"
            BACKUP_LABEL="manual-config"
            ;;
        3)
            if [[ ! -f "$NGINX_CONF" ]]; then
                log_error "Keine nginx-Config gefunden: $NGINX_CONF"
                exit $EX_USAGE
            fi
            BACKUP_SRC="$NGINX_CONF"
            BACKUP_LABEL="manual-nginx"
            ;;
        4)
            if [[ ! -f "$UPDATE_SCRIPT" ]]; then
                log_error "Kein Update-Skript gefunden: $UPDATE_SCRIPT"
                exit $EX_USAGE
            fi
            BACKUP_SRC="$UPDATE_SCRIPT"
            BACKUP_LABEL="manual-updatescript"
            ;;
        5)
            echo -n "  Pfad zur Datei/Verzeichnis: "
            read -r CUSTOM_PATH
            if [[ -z "$CUSTOM_PATH" ]]; then
                log_error "Kein Pfad angegeben"
                exit $EX_USAGE
            fi
            if [[ ! -e "$CUSTOM_PATH" ]]; then
                log_error "Pfad existiert nicht: $CUSTOM_PATH"
                exit $EX_USAGE
            fi
            BACKUP_SRC="$CUSTOM_PATH"
            BACKUP_LABEL="manual-custom"
            ;;
        0|*)
            log_info "Abgebrochen"
            exit 0
            ;;
    esac

    local BACKUP_FILE=""
    BACKUP_FILE=$(create_backup "$BACKUP_SRC" "$BACKUP_LABEL" 2>/dev/null)
    if [[ $? -ne 0 || -z "${BACKUP_FILE:-}" || ! -f "$BACKUP_FILE" ]]; then
        log_error "Backup fehlgeschlagen"
        exit $EX_CONFIG
    fi

    # Backup-Verifikation
    if [[ ! -f "$BACKUP_FILE" ]]; then
        log_error "Backup-Datei nicht gefunden: $BACKUP_FILE"
        exit $EX_CONFIG
    fi

    local size
    size=$(du -h "$BACKUP_FILE" 2>/dev/null | awk '{print $1}')
    local bcount
    bcount=$(ls -1 "${BACKUP_DIR}"/*.tar.gz 2>/dev/null | wc -l)

    cleanup_old_backups

    log_ok "Backup erfolgreich erstellt"
    echo ""
    echo "    Pfad:    $BACKUP_FILE"
    echo "    Größe:   $size"
    echo "    Backups insgesamt: $bcount (in $BACKUP_DIR)"
    echo ""
    log_info "Wiederherstellen mit: sudo bash install.sh restore"
}

# 3) Backup wiederherstellen
do_restore() {
    acquire_lock || exit $EX_USAGE

    if [[ ! -d "$BACKUP_DIR" ]]; then
        log_error "Backup-Verzeichnis nicht gefunden: $BACKUP_DIR"
        exit $EX_USAGE
    fi

    # Alle verfügbaren Backups auflisten
    local backups
    mapfile -t backups < <(ls -1t "${BACKUP_DIR}"/*.tar.gz 2>/dev/null)

    if [[ ${#backups[@]} -eq 0 ]]; then
        log_error "Keine Backups gefunden in ${BACKUP_DIR}"
        exit $EX_USAGE
    fi

    log_info "Verfügbare Backups in ${BACKUP_DIR}:"
    echo ""

    # Formatierte Liste anzeigen mit Index
    local i=1
    declare -A backup_map
    for backup in "${backups[@]}"; do
        local size
        size=$(du -h "$backup" 2>/dev/null | awk '{print $1}')
        local mtime
        mtime=$(stat -c%y "$backup" 2>/dev/null | cut -d. -f1 || stat -f%Sm "$backup" 2>/dev/null)
        printf "  [%2d] %s  (%s, %s)\n" "$i" "$(basename "$backup")" "$mtime" "$size"
        backup_map[$i]="$backup"
        i=$((i + 1))
    done

    echo ""
    echo "  [0] Abbrechen"
    echo ""
    echo -n "  Welches Backup soll wiederhergestellt werden? [0-$((i-1))]: "
    read -r CHOICE

    if [[ "$CHOICE" == "0" || -z "$CHOICE" ]]; then
        log_info "Abgebrochen"
        exit 0
    fi

    if [[ ! "${backup_map[$CHOICE]:-}" ]]; then
        log_error "Ungültige Auswahl: $CHOICE"
        exit $EX_USAGE
    fi

    local selected="${backup_map[$CHOICE]}"
    log_info "Ausgewähltes Backup: $selected"

    # Bestätigung
    echo ""
    log_warn "ACHTUNG: Dies überschreibt die aktuelle Installation!"
    log_warn "  Quelle:  $selected"
    log_warn "  Ziel:    $INSTALL_DIR"
    echo ""
    echo -n "  Tippe 'WIEDERHERSTELLEN' zum Bestätigen: "
    read -r CONFIRM
    [[ "$CONFIRM" == "WIEDERHERSTELLEN" ]] || { log_info "Abgebrochen"; exit 0; }

    # Vor Restore: aktuellen Stand sichern
    log_info "Sichere aktuellen Stand vor Restore..."
    create_backup "$INSTALL_DIR" "pre-restore" >/dev/null || log_warn "Pre-Restore-Backup fehlgeschlagen"

    # config.js und .openweb.env separat sichern (falls im Backup nicht enthalten oder neuer)
    local config_backup=""
    local server_config_backup=""
    if [[ -f "${INSTALL_DIR}/config.js" ]]; then
        config_backup=$(mktemp /tmp/openweb-config.XXXXXX.js)
        cp -f "${INSTALL_DIR}/config.js" "$config_backup"
    fi
    if [[ -f "${INSTALL_DIR}/.openweb.env" ]]; then
        server_config_backup=$(mktemp /tmp/openweb-server-config.XXXXXX.env)
        cp -f "${INSTALL_DIR}/.openweb.env" "$server_config_backup"
    fi

    # Restore durchführen
    log_info "Entpacke Backup..."
    local extract_dir
    extract_dir=$(mktemp -d /tmp/openweb-restore.XXXXXX)
    if ! tar -xzf "$selected" -C "$extract_dir" 2>&1 | sed 's/^/    /'; then
        log_error "Entpacken fehlgeschlagen"
        rm -rf "$extract_dir"
        [[ -n "$config_backup" ]] && mv -f "$config_backup" "${INSTALL_DIR}/config.js"
        exit $EX_CONFIG
    fi

    # Prüfe, ob Backup ein einzelnes File oder ein Verzeichnis enthält
    local top_count restored_root is_single_file=0
    top_count=$(find "$extract_dir" -mindepth 1 -maxdepth 1 | wc -l)
    restored_root=$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -1)

    if [[ -n "$restored_root" ]]; then
        is_single_file=0
    elif [[ "$top_count" -eq 1 ]]; then
        local only_file
        only_file=$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type f | head -1)
        if [[ -n "$only_file" ]]; then
            restored_root="$only_file"
            is_single_file=1
        fi
    fi

    if [[ -z "$restored_root" ]]; then
        log_error "Backup enthält kein wiederherstellbares Element — Restore abgebrochen"
        rm -rf "$extract_dir"
        [[ -n "$config_backup" ]] && mv -f "$config_backup" "${INSTALL_DIR}/config.js"
        exit $EX_CONFIG
    fi

    # Ziel vorbereiten
    if [[ ! -d "$INSTALL_DIR" ]]; then
        mkdir -p "$INSTALL_DIR"
    fi

    if [[ "$is_single_file" -eq 1 ]]; then
        # Einzelne Datei: Ziel anhand Backup-Label bestimmen
        local bname
        bname=$(basename "$selected")
        local target_path=""
        case "$bname" in
            *"manual-config"*|*"pre-update-config"*)
                target_path="${INSTALL_DIR}/config.js"
                ;;
            *"manual-nginx"*)
                target_path="$NGINX_CONF"
                ;;
            *"manual-updatescript"*)
                target_path="$UPDATE_SCRIPT"
                ;;
            *)
                # Fallback: Namensableitung aus dem Backup-Namen
                target_path="${INSTALL_DIR}/$(basename "$bname" .tar.gz)"
                target_path="${target_path%.*.*}"   # <label>.<timestamp> entfernen
                if [[ -z "$(basename "$target_path")" ]]; then
                    target_path="${INSTALL_DIR}/$(basename "$restored_root")"
                fi
                ;;
        esac
        cp -f "$restored_root" "$target_path" || {
            log_error "Kopieren der Datei fehlgeschlagen: $restored_root → $target_path"
            rm -rf "$extract_dir"
            [[ -n "$config_backup" ]] && mv -f "$config_backup" "${INSTALL_DIR}/config.js"
            exit $EX_CONFIG
        }
        log_ok "Datei wiederhergestellt: $target_path"
    else
        # Verzeichnis-Backup: Inhalte kopieren
        log_info "Kopiere ${restored_root}/* → ${INSTALL_DIR}/ ..."
        if command -v rsync >/dev/null 2>&1; then
            rsync -a --delete "${restored_root}/" "${INSTALL_DIR}/" 2>&1 | sed 's/^/    /' || {
                log_error "rsync fehlgeschlagen"
                rm -rf "$extract_dir"
                [[ -n "$config_backup" ]] && mv -f "$config_backup" "${INSTALL_DIR}/config.js"
                exit $EX_CONFIG
            }
        else
            # Fallback: kopiere via cp -a und lösche alten Inhalt
            find "$INSTALL_DIR" -mindepth 1 -delete 2>/dev/null || rm -rf "$INSTALL_DIR"/* "$INSTALL_DIR"/.[!.]* 2>/dev/null || true
            cp -a "${restored_root}/." "$INSTALL_DIR/" 2>&1 | sed 's/^/    /' || {
                log_error "cp fehlgeschlagen"
                rm -rf "$extract_dir"
                [[ -n "$config_backup" ]] && mv -f "$config_backup" "${INSTALL_DIR}/config.js"
                exit $EX_CONFIG
            }
        fi
    fi

    rm -rf "$extract_dir"

    # config.js und .openweb.env wiederherstellen (lokale Anpassung hat Vorrang, falls im Backup keine vorhanden)
    if [[ -n "$config_backup" && -f "$config_backup" ]]; then
        if [[ -f "${INSTALL_DIR}/config.js" ]]; then
            # Im Backup war eine config.js enthalten — lokale Kopie wegwerfen
            rm -f "$config_backup"
            log_info "config.js aus Backup übernommen"
        else
            # Backup enthielt keine config.js — lokale behalten
            mv -f "$config_backup" "${INSTALL_DIR}/config.js"
            log_ok "Lokale config.js beibehalten (nicht überschrieben)"
        fi
    fi
    if [[ -n "$server_config_backup" && -f "$server_config_backup" ]]; then
        if [[ -f "${INSTALL_DIR}/.openweb.env" ]]; then
            rm -f "$server_config_backup"
            log_info ".openweb.env aus Backup übernommen"
        else
            mv -f "$server_config_backup" "${INSTALL_DIR}/.openweb.env"
            log_ok "Lokale .openweb.env beibehalten (nicht überschrieben)"
        fi
    fi

    # Permissions sicherstellen
    if [[ -f "${INSTALL_DIR}/config.js" ]]; then
        chmod 644 "${INSTALL_DIR}/config.js" 2>/dev/null || log_warn "Konnte chmod 644 für config.js nicht setzen"
    fi
    if [[ -f "${INSTALL_DIR}/.openweb.env" ]]; then
        chmod 600 "${INSTALL_DIR}/.openweb.env" 2>/dev/null || log_warn "Konnte chmod 600 für .openweb.env nicht setzen"
    fi

    # Services neu starten
    log_info "Starte Services nach Restore neu..."
    _restart_services_post_update || log_warn "Service-Restart teilweise fehlgeschlagen"

    log_ok "Restore erfolgreich abgeschlossen: $selected"
    _log "INFO" "Restore erfolgreich: $selected"
}

# 4) Supabase CLI installieren / reparieren
do_install_cli() {
    acquire_lock || exit $EX_USAGE

    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq curl ca-certificates >/dev/null 2>&1 || true
    install_supabase_cli || log_warn "CLI konnte nicht installiert werden"

    if command -v supabase >/dev/null 2>&1; then
        log_ok "supabase CLI jetzt verfügbar: $(supabase --version 2>/dev/null | head -n1)"

        if [[ -d "${INSTALL_DIR}/supabase/functions/save-config" ]]; then
            log_info "Deploye save-config Edge-Function..."
            if (cd "$INSTALL_DIR" && supabase functions deploy save-config 2>&1) | sed 's/^/    /'; then
                log_ok "save-config deployed"
            else
                log_warn "save-config konnte nicht deployed werden"
            fi
        fi
    fi
}

# 5) Skript selbst updaten
do_update_self() {
    log_info "Aktuelle Version von GitHub holen..."

    local tmp backup
    tmp=$(mktemp /tmp/openweb-install.XXXXXX.sh)

    if ! safe_download "https://raw.githubusercontent.com/DerMinecrafter2020/linktree/main/install.sh" "$tmp" 500; then
        log_error "Download fehlgeschlagen"
        rm -f "$tmp"
        exit $EX_NETWORK
    fi

    # Shebang prüfen
    if ! head -n1 "$tmp" | grep -qE '^#!/usr/bin/env bash|^#!/bin/bash'; then
        log_error "Heruntergeladene Datei ist kein gültiges Bash-Skript"
        rm -f "$tmp"
        exit $EX_CONFIG
    fi

    # Syntax-Check
    if ! bash -n "$tmp" 2>/dev/null; then
        log_error "Heruntergeladenes Skript hat Syntaxfehler"
        rm -f "$tmp"
        exit $EX_CONFIG
    fi

    backup="/etc/openweb-install.sh.backup.$(date +%s)"
    if ! cp -f "$0" "$backup" 2>/dev/null; then
        log_error "Backup fehlgeschlagen — Update abgebrochen"
        rm -f "$tmp"
        exit $EX_PERM
    fi

    cp -f "$tmp" "$0"
    chmod +x "$0"
    rm -f "$tmp"

    log_ok "Skript aktualisiert. Backup: $backup"
    log_info "Starte mit: sudo bash install.sh"
    exec bash "$0"
}

# 6) Alles deinstallieren
do_uninstall() {
    log_warn "Deinstallation: OpenWeb wird vollständig entfernt!"
    echo ""
    echo -n "  Bist du sicher? Tippe 'JA' zum Bestätigen: "
    read -r CONFIRM
    [[ "$CONFIRM" == "JA" ]] || { log_info "Abgebrochen"; exit 0; }

    echo -n "  Vorher vollständiges Backup erstellen? (j/N): "
    read -r DO_BACKUP
    if [[ "$DO_BACKUP" =~ ^[jJyY]$ ]]; then
        create_backup "$INSTALL_DIR" "pre-uninstall" || log_warn "Backup fehlgeschlagen — fahre fort"
    fi

    log_info "Stoppe Auto-Update-Timer..."
    systemctl stop    openweb-updater.timer 2>/dev/null || true
    systemctl disable openweb-updater.timer 2>/dev/null || true

    log_info "Entferne systemd-Units..."
    rm -f "$SYSTEMD_SERVICE" "$SYSTEMD_TIMER"
    systemctl daemon-reload

    log_info "Entferne Update-Skript..."
    rm -f "$UPDATE_SCRIPT"

    log_info "Deaktiviere nginx-Site..."
    [[ -L "$NGINX_LINK" ]] && rm -f "$NGINX_LINK"
    [[ -f "$NGINX_CONF" ]] && rm -f "$NGINX_CONF"
    if [[ ! -e /etc/nginx/sites-enabled/default ]]; then
        ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default 2>/dev/null || true
    fi
    nginx -t 2>/dev/null && systemctl reload nginx || true

    log_info "Entferne Webseite (${INSTALL_DIR})..."
    if [[ -d "$INSTALL_DIR" ]]; then
        local uninstall_backup="${BACKUP_DIR}/uninstall-$(date +%Y%m%d-%H%M%S).tar.gz"
        if tar -czf "$uninstall_backup" -C "$(dirname "$INSTALL_DIR")" "$(basename "$INSTALL_DIR")" 2>/dev/null; then
            log_ok "Letztes Backup: $uninstall_backup"
        else
            log_warn "Konnte kein Deinstallations-Backup erstellen"
        fi
        rm -rf "$INSTALL_DIR"
        log_ok "Installationsverzeichnis entfernt"
    fi

    log_info "Entferne Lock- und Log-Files..."
    rm -f "$LOG_FILE" /var/lock/openweb-update.lock "$LOCK_FILE.main"

    log_ok "OpenWeb wurde deinstalliert."
    log_info "nginx + supabase-cli wurden NICHT entfernt (sind separate Pakete)."
    log_info "Falls du auch nginx komplett entfernen willst:"
    log_info "  apt remove --purge nginx"
}

# 7) Admin-Passwort ändern (config.js)
change_admin_password() {
    echo ""
    log_info "Admin-Passwort ändern"
    echo ""

    if [[ ! -t 0 ]]; then
        log_error "Passwortänderung erfordert ein interaktives Terminal (TTY)."
        log_info "  Alternative: ADMIN_PASSWORD='neuesPW' sudo bash install.sh change-password"
        exit $EX_USAGE
    fi

    local tries=0
    local max_tries=3
    while [[ $tries -lt $max_tries ]]; do
        tries=$((tries + 1))
        echo -n "  Neues Admin-Passwort: "
        read -rs NEW_PW
        echo ""
        if [[ -z "$NEW_PW" ]]; then
            log_warn "Passwort darf nicht leer sein"
            continue
        fi
        if [[ "$NEW_PW" == "admin123" ]]; then
            log_warn "'admin123' ist der bekannte Default — bitte ein sicheres Passwort wählen"
            continue
        fi
        echo -n "  Passwort bestätigen: "
        read -rs CONFIRM_PW
        echo ""
        if [[ "$NEW_PW" != "$CONFIRM_PW" ]]; then
            log_warn "Passwörter stimmen nicht überein — erneut versuchen"
            continue
        fi
        ADMIN_PASSWORD="$NEW_PW"
        return 0
    done
    log_error "Zu viele Fehlversuche — Passwortänderung abgebrochen"
    exit $EX_USAGE
}

do_change_password() {
    if [[ ! -d "$INSTALL_DIR" ]]; then
        log_error "Kein OpenWeb-Install unter ${INSTALL_DIR} — bitte erst installieren"
        exit $EX_USAGE
    fi

    if [[ ! -f "${INSTALL_DIR}/config.js" ]]; then
        log_error "Keine config.js unter ${INSTALL_DIR}"
        exit $EX_CONFIG
    fi

    log_info "Admin-Passwort ändern (nginx Basic Auth)"

    change_admin_password
    local new_pw="$ADMIN_PASSWORD"

    # htpasswd auf dem Server aktualisieren
    ensure_admin_htpasswd "$new_pw"

    if ! create_backup "$INSTALL_DIR/config.js" "pre-pwchange" >/dev/null; then
        log_warn "Pre-Passwortänderungs-Backup fehlgeschlagen — fahre trotzdem fort"
    fi

    log_ok "Admin-Passwort aktualisiert (nginx Basic Auth)"
    log_info "Hinweis: Browser muss ggf. die Basic-Auth-Sitzung neu laden: /admin neu öffnen."

    # Kein Admin-Passwort mehr in config.js
    return 0
}

# Admin-Bereich aktivieren / deaktivieren (nur serverseitig in nginx)
do_set_admin_enabled() {
    local enabled="$1"
    if [[ -z "$enabled" ]]; then
        log_error "Interner Fehler: do_set_admin_enabled braucht true/false"
        exit $EX_USAGE
    fi

    if [[ ! -f "$NGINX_CONF" ]]; then
        log_error "Keine nginx-Config ${NGINX_CONF} gefunden — bitte erst installieren"
        exit $EX_CONFIG
    fi

    local include_line
    include_line="include ${NGINX_ADMIN_STATE};"

    if [[ "$enabled" == "true" ]]; then
        log_info "Aktiviere Admin-Bereich (lösche ${NGINX_ADMIN_STATE})..."
        # Leere Datei = kein return 404, Admin-Bereich erreichbar
        printf '' > "$NGINX_ADMIN_STATE"
    else
        log_info "Deaktiviere Admin-Bereich (schreibe 404-Block nach ${NGINX_ADMIN_STATE})..."
        printf 'return 404;\n' > "$NGINX_ADMIN_STATE"
    fi

    chmod 644 "$NGINX_ADMIN_STATE"

    # Sicherstellen, dass die Include-Zeile in der nginx-Config existiert
    if ! grep -qF "$include_line" "$NGINX_CONF" 2>/dev/null; then
        log_warn "Include-Zeile fehlt in ${NGINX_CONF} — füge sie hinzu"
        sed -i "/auth_basic.*OpenWeb Admin/i\\        ${include_line}" "$NGINX_CONF"
    fi

    reload_nginx

    if [[ "$enabled" == "true" ]]; then
        log_ok "Admin-Bereich aktiviert — /admin ist wieder erreichbar"
    else
        log_ok "Admin-Bereich deaktiviert — /admin liefert jetzt 404"
    fi
    return 0
}

reload_nginx() {
    if command -v nginx >/dev/null 2>&1; then
        if nginx -t >/dev/null 2>&1; then
            nginx -s reload >/dev/null 2>&1 || true
            log_ok "nginx neu geladen"
        else
            log_error "nginx-Konfiguration ist ungültig — bitte prüfen"
            nginx -t
            exit $EX_NGINX
        fi
    else
        log_warn "nginx nicht gefunden — bitte manuell neu laden"
    fi
}

# 8) Supabase CLI installieren (Helper)
install_supabase_cli() {
    if [[ -x "$SUPABASE_CLI" ]] || command -v supabase >/dev/null 2>&1; then
        log_ok "supabase CLI bereits vorhanden"
        return 0
    fi
    log_info "supabase CLI nicht gefunden — versuche Installation..."

    log_info "  [1/3] Versuche offiziellen one-liner..."
    if curl -fsSL https://raw.githubusercontent.com/supabase/cli/main/install | bash 2>/dev/null; then
        if command -v supabase >/dev/null 2>&1; then
            log_ok "supabase CLI via one-liner installiert"
            return 0
        fi
    fi

    local arch
    arch=$(uname -m)
    case "$arch" in
        x86_64) arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)
            log_warn "Unbekannte Architektur '$arch' — CLI-Installation wird übersprungen"
            return 1
            ;;
    esac

    log_info "  [2/3] Versuche .deb-Paket (arch=$arch)..."
    local deb_url="https://github.com/supabase/cli/releases/latest/download/supabase_linux_${arch}.deb"
    local deb_file="/tmp/supabase-cli.deb"
    if safe_download "$deb_url" "$deb_file" 1000; then
        if dpkg -i "$deb_file" 2>/dev/null; then
            log_ok "supabase CLI via .deb installiert"
            rm -f "$deb_file"
            return 0
        fi
        rm -f "$deb_file"
    fi

    log_info "  [3/3] Versuche tar.gz..."
    local tar_url="https://github.com/supabase/cli/releases/latest/download/supabase_linux_${arch}.tar.gz"
    local tar_file="/tmp/supabase-cli.tar.gz"
    if safe_download "$tar_url" "$tar_file" 1000; then
        local tar_dir
        tar_dir=$(mktemp -d /tmp/supabase-extract.XXXXXX)
        if tar -xzf "$tar_file" -C "$tar_dir" 2>/dev/null; then
            local extracted
            extracted=$(find "$tar_dir" -name supabase -type f -executable 2>/dev/null | head -1)
            if [[ -n "$extracted" ]]; then
                mv "$extracted" /usr/local/bin/supabase
                chmod +x /usr/local/bin/supabase
                log_ok "supabase CLI via tar.gz installiert"
                rm -rf "$tar_dir" "$tar_file"
                return 0
            fi
        fi
        rm -rf "$tar_dir" "$tar_file"
    fi

    log_warn "CLI-Installation fehlgeschlagen — Navidrome-Secrets können nicht aus Supabase geladen werden"
    return 1
}

# =========================================================
# ROOT-CHECK + MODUS-DISPATCH
# =========================================================

if [[ $EUID -ne 0 ]]; then
    log_error "Bitte als root ausführen: sudo bash $0"
    exit $EX_PERM
fi

# Lock akquirieren (außer update-self, das sich selbst ersetzt)
acquire_lock || exit $EX_USAGE

# --- Modus-Wahl ---
if [[ $# -ge 1 ]]; then
    MODE="$1"
else
    cat <<EOF

${GREEN}============================================================${NC}
${GREEN} OpenWeb Installer / Manager${NC}
${GREEN}============================================================${NC}

EOF
    PS3="  Wähle eine Option: "
    select opt in \
        "Neuinstallieren (fragt alle Werte neu ab)" \
        "Update von GitHub pushen" \
        "Supabase CLI installieren / reparieren" \
        "Skript selbst updaten" \
        "Admin-Passwort ändern" \
        "Admin-Bereich aktivieren" \
        "Admin-Bereich deaktivieren" \
        "Backup erstellen" \
        "Backup wiederherstellen" \
        "Alles deinstallieren" \
        "Beenden"
    do
        case "$REPLY" in
            1) MODE="neuinstallieren" ;;
            2) MODE="update" ;;
            3) MODE="install-cli" ;;
            4) MODE="update-self" ;;
            5) MODE="change-password" ;;
            6) MODE="enable-admin" ;;
            7) MODE="disable-admin" ;;
            8) MODE="backup" ;;
            9) MODE="restore" ;;
            10) MODE="uninstall" ;;
            11) log_info "Abbruch"; exit 0 ;;
            *) log_warn "Ungültige Auswahl: $REPLY"; continue ;;
        esac
        break
    done
fi

# Whitelist-Check
case "$MODE" in
    neuinstallieren|install|update|update-self|install-cli|change-password|enable-admin|disable-admin|backup|restore|uninstall) ;;
    *)
        log_error "Unbekannter Modus: $MODE"
        log_info "Erlaubt: neuinstallieren, update, update-self, install-cli, change-password, enable-admin, disable-admin, backup, restore, uninstall"
        exit $EX_USAGE
        ;;
esac

log_info "Modus: $MODE"

# === Modi ohne Install ===
case "$MODE" in
    update)          do_update;          exit $? ;;
    update-self)     do_update_self;     exit $? ;;
    uninstall)       do_uninstall;       exit $? ;;
    install-cli)     do_install_cli;     exit $? ;;
    change-password) do_change_password; exit $? ;;
    enable-admin)    do_set_admin_enabled true;  exit $? ;;
    disable-admin)   do_set_admin_enabled false; exit $? ;;
    backup)          do_backup;          exit $? ;;
    restore)         do_restore;         exit $? ;;
esac

# === Standard-Pfad: install (auch fuer 'neuinstallieren') ===

# --- Schritt 1: System-Abhängigkeiten ---
log_info "Installiere System-Abhängigkeiten (nginx, git, curl, ca-certificates)..."
export DEBIAN_FRONTEND=noninteractive
if ! apt-get update -qq 2>&1 | sed 's/^/    /'; then
    log_error "apt-get update fehlgeschlagen"
    exit $EX_DEPENDENCY
fi
if ! apt-get install -y -qq nginx git curl ca-certificates ufw >/dev/null 2>&1; then
    log_error "apt-get install fehlgeschlagen"
    exit $EX_DEPENDENCY
fi
log_ok "Abhängigkeiten installiert"

# --- Schritt 2: Admin-Passwort ---
prompt_admin_password() {
    log_info "Konfiguration: Admin-Passwort für /admin.html"
    echo ""

    # Admin-Passwort aus .openweb.env laden, falls vorhanden
    if [[ -f "$SERVER_CONFIG_FILE" ]]; then
        load_server_config
    fi

    local keep_existing=0
    if [[ "$MODE" != "neuinstallieren" ]]; then
        if [[ -n "${ADMIN_PASSWORD:-}" ]] && ! is_placeholder "${ADMIN_PASSWORD:-}"; then
            keep_existing=1
        fi
    fi
    if [[ "$keep_existing" -eq 1 ]]; then
        echo -n "  Bestehendes Passwort erkannt. Neues Passwort setzen? (j/N): "
        read -r CHANGE_PW
        if [[ ! "$CHANGE_PW" =~ ^[jJyY]$ ]]; then
            log_info "  bestehendes Passwort wird beibehalten"
            return 0
        fi
        log_info "  OK, neues Passwort wird gesetzt"
    fi

    echo ""
    echo "  Es gibt kein Standard-Passwort."
    echo "  Bitte ein sicheres Admin-Passwort für /admin eingeben."
    echo ""
    echo -n "  Admin-Passwort: "
    read -rs ADMIN_PASSWORD
    echo ""

    if [[ -z "$ADMIN_PASSWORD" ]]; then
        log_error "Kein Admin-Passwort angegeben. Abbruch."
        exit $EX_CONFIG
    fi
    if [[ "$ADMIN_PASSWORD" == "admin123" ]]; then
        log_warn "'admin123' ist der bekannte Default — bitte ein sicheres Passwort wählen"
        read -rs ADMIN_PASSWORD
        echo ""
    fi
    log_ok "  eigenes Passwort wird gesetzt"
}

# --- Schritt 3: /var/html vorbereiten + Repo klonen/updaten ---
log_info "Bereite ${INSTALL_DIR} vor und klone GitHub-Repo..."

mkdir -p "$INSTALL_DIR"

if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log_info "Existierendes Git-Repo gefunden — aktualisiere via 'git pull'..."
    git_pull_safe "$INSTALL_DIR"
    local pull_status=$?
    case "$pull_status" in
        0) log_ok "Repo aktualisiert" ;;
        2) log_info "Repo bereits aktuell" ;;
        *) log_error "Update bei Install fehlgeschlagen"
           exit $EX_GIT ;;
    esac
else
    log_info "Klone Repo nach ${INSTALL_DIR}..."
    if [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
        log_warn "${INSTALL_DIR} ist nicht leer — Backup wird erstellt"
        create_backup "$INSTALL_DIR" "pre-clone" >/dev/null || true
        find "$INSTALL_DIR" -mindepth 1 -delete 2>/dev/null || rm -rf "$INSTALL_DIR"/* "$INSTALL_DIR"/.[!.]* 2>/dev/null || true
    fi
    if ! git clone "$REPO_URL" "$INSTALL_DIR" 2>&1 | sed 's/^/    /'; then
        log_error "git clone fehlgeschlagen"
        exit $EX_GIT
    fi
    log_ok "Repo geklont"
fi

# --- Schritt 4: config.js mit echtem Passwort erstellen ---
log_info "Erstelle lokale config.js mit Admin-Passwort..."

if [[ ! -f "${INSTALL_DIR}/config.js" ]]; then
    if [[ -f "${INSTALL_DIR}/config.example.js" ]]; then
        cp "${INSTALL_DIR}/config.example.js" "${INSTALL_DIR}/config.js"
        log_ok "config.js aus config.example.js erstellt (frischer Klon)"
    else
        log_warn "Weder config.js noch config.example.js vorhanden — erstelle leeres Template"
        touch "${INSTALL_DIR}/config.js"
    fi
fi

EXISTING_CONFIG="${INSTALL_DIR}/config.js"
EXISTING_URL=""
EXISTING_ANON_KEY=""
EXISTING_ADMIN_PW=""
if [[ "$MODE" != "neuinstallieren" && -f "$EXISTING_CONFIG" ]]; then
    EXISTING_URL=$(grep -oE "url:\s*['\"][^'\"]*['\"]" "$EXISTING_CONFIG" 2>/dev/null | head -1 | sed -E "s/^.*url:\s*['\"]//;s/['\"],?\s*$//")
    EXISTING_ANON_KEY=$(grep -oE "anonKey:\s*['\"][^'\"]*['\"]" "$EXISTING_CONFIG" 2>/dev/null | head -1 | sed -E "s/^.*anonKey:\s*['\"]//;s/['\"],?\s*$//")
    # Admin-Passwort liegt jetzt in .openweb.env (ADMIN_PASSWORD), nicht mehr in config.js
elif [[ "$MODE" == "neuinstallieren" ]]; then
    log_info "  Modus 'neuinstallieren' — alle Werte werden neu abgefragt"
fi

# Serverseitige .openweb.env hat Vorrang gegenüber config.js.
# Wenn .openweb.env noch nicht existiert, wird es automatisch aus config.js migriert.
ensure_server_config
if [[ -n "${SUPABASE_URL:-}" ]] && ! is_placeholder "$SUPABASE_URL"; then
    EXISTING_URL="$SUPABASE_URL"
fi
if [[ -n "${SUPABASE_ANON_KEY:-}" ]] && ! is_placeholder "$SUPABASE_ANON_KEY"; then
    EXISTING_ANON_KEY="$SUPABASE_ANON_KEY"
fi

prompt_admin_password

# Supabase-URL
if [[ -n "$EXISTING_URL" ]] && ! is_placeholder "$EXISTING_URL"; then
    SUPABASE_URL="$EXISTING_URL"
    log_info "  bestehende Supabase-URL behalten: $SUPABASE_URL"
else
    echo -n "  Supabase URL [https://DEIN-PROJEKT.supabase.co]: "
    read SUPABASE_URL
    if [[ -z "$SUPABASE_URL" ]]; then
        log_warn "Keine Supabase-URL gesetzt — du musst sie nachträglich in ${INSTALL_DIR}/config.js eintragen"
        SUPABASE_URL="https://DEIN-PROJEKT.supabase.co"
    fi
fi

# Supabase anon-key
if [[ -n "$EXISTING_ANON_KEY" ]] && ! is_placeholder "$EXISTING_ANON_KEY"; then
    SUPABASE_ANON_KEY="$EXISTING_ANON_KEY"
    log_info "  bestehender anon-key behalten (${#SUPABASE_ANON_KEY} Zeichen)"
else
    echo -n "  Supabase anon-key: "
    read SUPABASE_ANON_KEY
    if [[ -z "$SUPABASE_ANON_KEY" ]]; then
        log_warn "Kein anon-key gesetzt — du musst ihn nachträglich in ${INSTALL_DIR}/config.js eintragen"
        SUPABASE_ANON_KEY="__SET_ME_MANUALLY__"
    fi
fi

ADMIN_PASS_JSON=$(json_escape "$ADMIN_PASSWORD")

install_supabase_cli

SECRETS_READABLE=0
if command -v supabase >/dev/null 2>&1; then
    if supabase projects list 2>/dev/null >/dev/null; then
        log_ok "supabase CLI eingeloggt und verlinkt"
        SECRETS_READABLE=1
    else
        log_warn "supabase CLI nicht eingeloggt — Secrets werden nur in config.js gesetzt"
        log_warn "  Um nachträglich zu setzen:"
        log_warn "    supabase login"
        log_warn "    supabase link"
    fi
fi

# Shared Secret ist bereits durch ensure_server_config() gesetzt
    :

# Navidrome-Werte abfragen
echo ""
echo -n "  Navidrome URL (z.B. https://music.deinedomain.de oder http://localhost:4533): "
read -r NAV_URL_PROMPT
NAV_URL="${NAV_URL_PROMPT:-https://music.deinedomain.de}"

if [[ -z "${NAV_USER:-}" && "$SECRETS_READABLE" -eq 1 ]]; then
    if NAV_URL_FROM_SECRET=$(get_supabase_secret "NAVIDROME_URL" 2>/dev/null) \
       && [[ -n "$NAV_URL_FROM_SECRET" ]]; then
        log_info "  Navidrome-Secrets gefunden — Player wird automatisch aktiviert"
        NAV_URL="$NAV_URL_FROM_SECRET"
        NAV_USER="(aus Supabase-Secrets)"
        NAV_PASS_JSON='"(siehe Supabase-Secrets)"'
        NAV_ENABLED="true"
    fi
fi

echo -n "  Navidrome Username: "
read -r NAV_USER
if [[ -z "$NAV_USER" ]]; then
    log_warn "Username leer — Player bleibt deaktiviert"
    NAV_USER="YOUR_USER"
    NAV_ENABLED="false"
    NAV_PASS_JSON='"YOUR_PASS"'
else
    NAV_ENABLED="true"
    while true; do
        echo -n "  Navidrome Passwort: "
        read -r NAV_PASS
        if [[ -z "$NAV_PASS" ]]; then
            log_warn "Passwort darf nicht leer sein — bitte erneut eingeben"
            continue
        fi
        break
    done

    if [[ "$SECRETS_READABLE" -eq 1 ]]; then
        log_info "Setze Secrets in Supabase (NAVIDROME_URL/USER/PASS)..."
        local env_tmp="/tmp/openweb-nav-env"
        printf 'NAVIDROME_URL=%s\nNAVIDROME_USER=%s\nNAVIDROME_PASS=%s\n' "$NAV_URL" "$NAV_USER" "$NAV_PASS" > "$env_tmp"
        chmod 600 "$env_tmp"
        if supabase secrets set --env-file "$env_tmp" 2>&1 | sed 's/^/    /'; then
            log_ok "Secrets in Supabase gesetzt"
        else
            log_warn "supabase secrets set fehlgeschlagen — nur lokal in config.js"
        fi
        rm -f "$env_tmp"
    else
        log_warn "CLI nicht eingeloggt — Secrets nur lokal. Später manuell mit:"
        log_warn "    supabase login"
        log_warn "    supabase link"
        log_warn "    supabase secrets set NAVIDROME_URL='${NAV_URL}' NAVIDROME_USER='${NAV_USER}' NAVIDROME_PASS='${NAV_PASS}'"
    fi

    NAV_PASS_JSON=$(json_escape "$NAV_PASS")
fi

# Pre-Write-Backup

# Pre-Write-Backup
if ! create_backup "$INSTALL_DIR/config.js" "pre-write" >/dev/null; then
    log_warn "Pre-Write-Backup von config.js fehlgeschlagen — fahre trotzdem fort"
fi

cat > "${INSTALL_DIR}/config.js" <<EOF
// Lokale Server-Konfiguration — wird vom Install-Skript erzeugt.
// Bearbeite diese Datei NICHT direkt; stattdessen \`sudo bash install.sh\` erneut ausführen.
window.SUPABASE_CONFIG = {
  url: '${SUPABASE_URL}',
  anonKey: '${SUPABASE_ANON_KEY}',

  // Admin-Login läuft über nginx Basic Auth.
  adminProxyUrl:     '${SUPABASE_URL}/functions/v1/admin-proxy',

};



window.NAVIDROME_CONFIG = {
  enabled: ${NAV_ENABLED},
  url: '${NAV_URL}',
  user: '${NAV_USER}',
  pass: ${NAV_PASS_JSON},
  proxyUrl: '${SUPABASE_URL}/functions/v1/navidrome-proxy',
  pollIntervalSec: 30,
};

// Admin-Passwort wird NICHT im Browser gespeichert.
// Serverseitige Authentifizierung über /etc/nginx/openweb-admin.htpasswd
EOF

chmod 644 "${INSTALL_DIR}/config.js"
log_ok "config.js erstellt (chmod 644)"

# Serverseitige Konfiguration sichern
save_server_config

# Geschützte Admin-Konfiguration erzeugen (Shared Secret für admin-proxy)
# Diese Datei liegt im /admin-Bereich und wird durch nginx Basic Auth geschützt.
# Sie enthält das CONFIG_SHARED_SECRET, damit das Admin-Panel nicht per
# Prompt danach fragen muss.
generate_admin_config() {
    local file="${INSTALL_DIR}/admin/admin-config.js"
    mkdir -p "$(dirname "$file")"
    local tmp
    tmp=$(mktemp "${file}.tmp.XXXXXX")
    cat > "$tmp" <<EOF
// OpenWeb Admin-Konfiguration — nur für /admin über nginx Basic Auth erreichbar.
// Wird von install.sh erzeugt. NICHT in git committen.
window.ADMIN_CONFIG = {
  sharedSecret: '${CONFIG_SHARED_SECRET}',
};
EOF
    chmod 600 "$tmp"
    mv -f "$tmp" "$file"
    log_ok "Geschützte Admin-Konfiguration erstellt: ${file} (chmod 600)"
}

# Geschützte Admin-Konfiguration erzeugen
save_server_config
generate_admin_config

# --- Edge Functions deployen (falls supabase CLI verfügbar) ---
deploy_edge_functions() {
    local cli=""
    [[ -x "$SUPABASE_CLI" ]] && cli="$SUPABASE_CLI"
    command -v supabase >/dev/null 2>&1 && cli="${cli:-supabase}"
    [[ -z "$cli" ]] && { log_warn "supabase CLI nicht verfügbar — Edge Functions müssen manuell deployed werden"; return 1; }
    if ! "$cli" projects list 2>/dev/null >/dev/null; then
        log_warn "supabase CLI nicht eingeloggt — Edge Functions müssen manuell deployed werden:"
        log_warn "  (im Installationsverzeichnis mit 'supabase link')"
        log_warn "  supabase functions deploy admin-proxy"
        log_warn "  supabase functions deploy navidrome-proxy"
        log_warn "  supabase functions deploy save-config"
        return 1
    fi

    log_info "Deploye Supabase Edge Functions..."
    local func
    for func in admin-proxy navidrome-proxy save-config; do
        if [[ -d "${INSTALL_DIR}/supabase/functions/${func}" ]]; then
            if (cd "$INSTALL_DIR" && "$cli" functions deploy "$func" 2>&1) | sed 's/^/    /'; then
                log_ok "  $func deployed"
            else
                log_warn "  $func konnte nicht deployed werden"
            fi
        else
            log_info "  $func nicht vorhanden — übersprungen"
        fi
    done
    return 0
}

# Direkt bei Installation deployen
deploy_edge_functions

# --- Schritt 5: nginx konfigurieren ---
log_info "Konfiguriere nginx..."

if [[ -f "$NGINX_CONF" ]]; then
    if ! create_backup "$NGINX_CONF" "pre-install" >/dev/null; then
        log_warn "Backup von nginx.conf fehlgeschlagen — fahre trotzdem fort"
    fi
fi

# --- Admin-Passwort / htpasswd ---
readonly NGINX_HTPASSWD="/etc/nginx/openweb-admin.htpasswd"
ensure_admin_htpasswd() {
    local pw="${1:-${ADMIN_PASSWORD:-}}"
    if [[ -z "$pw" ]]; then
        log_warn "Kein Admin-Passwort übergeben — htpasswd bleibt unverändert"
        return 1
    fi
    if ! command -v apache2-utils >/dev/null 2>&1 && ! command -v htpasswd >/dev/null 2>&1; then
        log_info "Installiere htpasswd (apache2-utils)..."
        apt-get install -y -qq apache2-utils >/dev/null 2>&1 || {
            log_warn "apache2-utils konnte nicht installiert werden — Admin-Login ohne Basic Auth"
            return 1
        }
    fi
    if command -v openssl >/dev/null 2>&1; then
        # bcrypt-Hash via openssl (bevorzugt)
        local hash
        hash=$(openssl passwd -apr1 "$pw" 2>/dev/null)
        printf 'admin:%s\n' "$hash" > "$NGINX_HTPASSWD"
    else
        htpasswd -cbB "$NGINX_HTPASSWD" admin "$pw" 2>/dev/null || {
            log_warn "htpasswd konnte keinen Hash erstellen"
            return 1
        }
    fi
    chmod 640 "$NGINX_HTPASSWD"
    chown root:www-data "$NGINX_HTPASSWD" 2>/dev/null || true
    log_ok "Admin-Basic-Auth-Datei aktualisiert: ${NGINX_HTPASSWD}"
}

# Initial beim Setup aufrufen (ADMIN_PASSWORD ist zu diesem Zeitpunkt gesetzt)
ensure_admin_htpasswd "$ADMIN_PASSWORD"

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

    # Rate-Limits (schützen Admin-Login gegen Brute-Force)
    limit_req_zone \$binary_remote_addr zone=admin_login:10m rate=5r/m;
    limit_req_zone \$binary_remote_addr zone=admin_general:10m rate=60r/m;

    # Statische Files
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Cache für statische Assets (1 Tag) — AUSSER admin-* und config.js
    location ~* ^(?!.*admin).*\.(css|js|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 1d;
        add_header Cache-Control "public, max-age=86400";
        try_files \$uri =404;
    }

    # Admin-Bereich: /admin, /admin.html und alle admin-* Dateien streng schützen.
    # In openweb-admin-state.conf kann der Admin-Bereich serverseitig auf 404 geschaltet werden.
    location ~ ^/(admin|admin-.*\.(html|css|js))$ {
        limit_req zone=admin_login burst=5 nodelay;

        include ${NGINX_ADMIN_STATE};

        auth_basic           "OpenWeb Admin";
        auth_basic_user_file ${NGINX_HTPASSWD};

        add_header Cache-Control "no-store" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        try_files \$uri =404;
    }

    # config.js: niemals cachen, sensible Daten
    location = /config.js {
        add_header Cache-Control "no-store" always;
        try_files \$uri =404;
    }

    # admin-config.js: geschützte Datei im /admin-Bereich, niemals cachen
    location = /admin/admin-config.js {
        limit_req zone=admin_login burst=5 nodelay;
        auth_basic           "OpenWeb Admin";
        auth_basic_user_file ${NGINX_HTPASSWD};
        add_header Cache-Control "no-store" always;
        add_header Last-Modified "";
        add_header ETag "";
        try_files \$uri =404;
    }

    # Verzeichnis-Listing deaktivieren
    autoindex off;
}
EOF

rm -f /etc/nginx/sites-enabled/default

log_info "Site '${NGINX_SITE_NAME}' enablen..."
log_info "  source: ${NGINX_CONF}"
log_info "  target: ${NGINX_LINK}"

if command -v nginx_ensite >/dev/null 2>&1; then
    nginx_ensite "${NGINX_SITE_NAME}"
    log_ok "Site via nginx_ensite aktiviert"
else
    ln -sf "$NGINX_CONF" "$NGINX_LINK"
    log_ok "Site via Symlink aktiviert: ${NGINX_LINK} -> $(readlink -f "$NGINX_LINK" 2>/dev/null || echo "?")"
fi

if [[ ! -L "$NGINX_LINK" ]]; then
    log_error "Konnte Site nicht aktivieren — ${NGINX_LINK} existiert nicht"
    exit $EX_NGINX
fi

LINK_TARGET=$(readlink "$NGINX_LINK")
if [[ "$LINK_TARGET" != "$NGINX_CONF" ]]; then
    log_warn "Symlink zeigt auf '${LINK_TARGET}', erwartet '${NGINX_CONF}' — wird korrigiert"
    ln -sf "$NGINX_CONF" "$NGINX_LINK"
fi

log_info "Aktivierte Sites:"
for site in /etc/nginx/sites-enabled/*; do
    [[ -e "$site" ]] || continue
    log_info "  $(basename "$site") -> $(readlink "$site" 2>/dev/null || echo "(kein Symlink)")"
done

if [[ -f "$NGINX_MAIN" ]] && grep -qE '^\s*root\s+/var/www/html' "$NGINX_MAIN"; then
    log_warn "Globaler 'root /var/www/html' in nginx.conf gefunden — wird korrigiert..."
    local main_backup="${NGINX_MAIN}.bak.$(date +%s)"
    if cp -n "$NGINX_MAIN" "$main_backup" 2>/dev/null; then
        log_ok "Backup der nginx.conf erstellt: $main_backup"
    else
        log_warn "Konnte kein Backup der nginx.conf erstellen"
    fi
    sed -i 's|^\(\s*\)root\s\+/var/www/html;|\1# root /var/www/html;  # disabled by openweb installer|' "$NGINX_MAIN"
    log_ok "Globaler root in nginx.conf auskommentiert"
fi

if [[ -f "$NGINX_MAIN" ]] && ! grep -q 'include /etc/nginx/sites-enabled/\*' "$NGINX_MAIN"; then
    log_warn "nginx.conf bindet sites-enabled nicht ein — wird hinzugefügt..."
    sed -i '/^http {/a \    include /etc/nginx/sites-enabled/*;' "$NGINX_MAIN"
    log_ok "include sites-enabled/* zu nginx.conf hinzugefügt"
fi

systemctl enable nginx
log_ok "nginx-Service ist aktiviert (startet bei Boot)"

if ! nginx -t 2>&1 | sed 's/^/    /'; then
    log_error "nginx config-Test fehlgeschlagen"
    exit $EX_NGINX
fi
systemctl reload nginx
log_ok "nginx konfiguriert und geladen (root = ${INSTALL_DIR})"

# --- Schritt 6: Update-Skript + systemd-Timer ---
log_info "Erstelle Auto-Update-Skript..."

if [[ -f "$UPDATE_SCRIPT" ]]; then
    if ! create_backup "$UPDATE_SCRIPT" "pre-install" >/dev/null; then
        log_warn "Backup von update-script fehlgeschlagen — fahre trotzdem fort"
    fi
fi

cat > "$UPDATE_SCRIPT" <<'UPDATE_EOF'
#!/usr/bin/env bash
# Auto-Update-Skript für OpenWeb
# Wird vom systemd-Timer alle 5 Minuten aufgerufen.
set -euo pipefail
IFS=$'\n\t'

INSTALL_DIR="/var/html"
LOG_FILE="/var/log/openweb-update.log"
LOCK_FILE="/var/lock/openweb-update.lock"
BACKUP_DIR="/var/backups/openweb"
REPO_BRANCH="main"

mkdir -p "$(dirname "$LOG_FILE")" "$BACKUP_DIR"

# Lockfile — verhindert parallele Updates
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "[$(date -Iseconds)] Another update is already running. Skipping." >> "$LOG_FILE"
    exit 0
fi

cd "$INSTALL_DIR"

# Remote-Stand holen
if ! git fetch origin "$REPO_BRANCH" --quiet 2>>"$LOG_FILE"; then
    echo "[$(date -Iseconds)] ERROR: git fetch failed" >> "$LOG_FILE"
    exit 1
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/${REPO_BRANCH}")

if [[ "$LOCAL" == "$REMOTE" ]]; then
    echo "[$(date -Iseconds)] No updates available (HEAD = origin/${REPO_BRANCH})" >> "$LOG_FILE"
    exit 0
fi

echo "[$(date -Iseconds)] Updating $LOCAL -> $REMOTE" >> "$LOG_FILE"

# Backup vor Update (bei Fehler abbrechen — Rollback ist nur mit Backup sinnvoll)
NAME="$(basename "$INSTALL_DIR")"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/${NAME}.timer-pre-update.${TS}.tar.gz"
if ! tar -czf "$BACKUP_FILE" -C "$(dirname "$INSTALL_DIR")" "$NAME" 2>>"$LOG_FILE"; then
    echo "[$(date -Iseconds)] ERROR: Backup fehlgeschlagen — Update abgebrochen" >> "$LOG_FILE"
    exit 1
fi
echo "[$(date -Iseconds)] Backup: $BACKUP_FILE" >> "$LOG_FILE"

# config.js und serverseitige .openweb.env sichern
CONFIG_BACKUP=""
SERVER_CONFIG_BACKUP=""
if [[ -f "${INSTALL_DIR}/config.js" ]]; then
    CONFIG_BACKUP=$(mktemp /tmp/openweb-config.XXXXXX.js)
    cp -f "${INSTALL_DIR}/config.js" "$CONFIG_BACKUP"
fi
if [[ -f "${INSTALL_DIR}/.openweb.env" ]]; then
    SERVER_CONFIG_BACKUP=$(mktemp /tmp/openweb-server-config.XXXXXX.env)
    cp -f "${INSTALL_DIR}/.openweb.env" "$SERVER_CONFIG_BACKUP"
fi

# Rollback-Helfer (wiederverwendbar)
rollback_update() {
    local reason="$1"
    echo "[$(date -Iseconds)] ERROR: $reason — rolling back" >> "$LOG_FILE"
    if [[ -f "$BACKUP_FILE" ]]; then
        tar -xzf "$BACKUP_FILE" -C "$(dirname "$INSTALL_DIR")" >> "$LOG_FILE" 2>&1
        systemctl reload nginx >> "$LOG_FILE" 2>&1 || true
        echo "[$(date -Iseconds)] Rolled back to: $BACKUP_FILE" >> "$LOG_FILE"
    fi
}

# Update anwenden (kein doppeltes fetch — bereits oben geschehen)
if git stash push -u -m "timer-auto-stash-$(date +%Y%m%d-%H%M%S)" >>"$LOG_FILE" 2>&1 && \
   git pull --ff-only origin "$REPO_BRANCH" >>"$LOG_FILE" 2>&1; then
    if git stash list 2>/dev/null | grep -q "timer-auto-stash"; then
        git stash pop >>"$LOG_FILE" 2>&1 || true
    fi
    if [[ -n "$CONFIG_BACKUP" && -f "$CONFIG_BACKUP" ]]; then
        mv -f "$CONFIG_BACKUP" "${INSTALL_DIR}/config.js"
        chmod 644 "${INSTALL_DIR}/config.js"
        echo "[$(date -Iseconds)] config.js restored" >> "$LOG_FILE"
    fi
    if [[ -n "$SERVER_CONFIG_BACKUP" && -f "$SERVER_CONFIG_BACKUP" ]]; then
        mv -f "$SERVER_CONFIG_BACKUP" "${INSTALL_DIR}/.openweb.env"
        chmod 600 "${INSTALL_DIR}/.openweb.env"
        echo "[$(date -Iseconds)] .openweb.env restored" >> "$LOG_FILE"
    fi

    # nginx reload mit Rollback bei Fehler
    if ! nginx -t >> "$LOG_FILE" 2>&1; then
        rollback_update "nginx config test failed"
        exit 1
    fi

    if ! systemctl reload nginx >> "$LOG_FILE" 2>&1; then
        if systemctl restart nginx >> "$LOG_FILE" 2>&1; then
            echo "[$(date -Iseconds)] nginx reload failed, restart succeeded" >> "$LOG_FILE"
        else
            rollback_update "nginx reload/restart failed"
            exit 1
        fi
    fi

    systemctl daemon-reload >> "$LOG_FILE" 2>&1 || echo "[$(date -Iseconds)] WARN: daemon-reload failed" >> "$LOG_FILE"
    if systemctl restart openweb-updater.service >> "$LOG_FILE" 2>&1; then
        echo "[$(date -Iseconds)] openweb-updater.service restarted" >> "$LOG_FILE"
    else
        echo "[$(date -Iseconds)] WARN: openweb-updater.service restart failed" >> "$LOG_FILE"
    fi

    if systemctl is-active --quiet nginx; then
        echo "[$(date -Iseconds)] Update applied successfully" >> "$LOG_FILE"
    else
        rollback_update "nginx not active after reload/restart"
        exit 1
    fi
else
    echo "[$(date -Iseconds)] ERROR: git update failed" >> "$LOG_FILE"
    if git stash list 2>/dev/null | grep -q "timer-auto-stash"; then
        git stash pop >> "$LOG_FILE" 2>&1 || true
    fi
    [[ -n "$CONFIG_BACKUP" ]] && mv -f "$CONFIG_BACKUP" "${INSTALL_DIR}/config.js"
    [[ -n "$SERVER_CONFIG_BACKUP" ]] && mv -f "$SERVER_CONFIG_BACKUP" "${INSTALL_DIR}/.openweb.env"
    exit 1
fi
UPDATE_EOF

chmod +x "$UPDATE_SCRIPT"
log_ok "Update-Skript erstellt: $UPDATE_SCRIPT"

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

# --- Schritt 7: Firewall ---
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

# --- Domain-Abfrage ---
DOMAIN=""
EXISTING_DOMAIN=$(grep -oE "server_name\s+[^;]+;" "$NGINX_CONF" 2>/dev/null | head -1 | awk '{print $2}')

if [[ -n "$EXISTING_DOMAIN" && "$EXISTING_DOMAIN" != "_" ]]; then
    echo ""
    echo -n "  Domain erkannt (${EXISTING_DOMAIN}). Ändern? (j/N): "
    read -r CHANGE_DOMAIN
    if [[ "$CHANGE_DOMAIN" =~ ^[jJyY]$ ]]; then
        echo -n "  Domain (z.B. meine.domain.de, leer für keine): "
        read -r DOMAIN
    else
        DOMAIN="$EXISTING_DOMAIN"
    fi
else
    echo ""
    echo -n "  Domain (z.B. meine.domain.de, leer für keine — Default '_' bleibt): "
    read -r DOMAIN
fi

if [[ -n "$DOMAIN" ]]; then
    log_info "Setze nginx server_name auf '$DOMAIN'..."
    # Sichere sed-Escaping: Punkt/Plus als Regex-Zeichen, Slash im Domain nicht verwendet
    local sed_domain_escaped
    sed_domain_escaped=$(printf '%s' "$DOMAIN" | sed 's/[[\.\*\^\$+?{}()|]/\\&/g')
    sed -i "s/^\(\s*\)server_name\s\+\(_\|[^;]\+\);/\1server_name ${sed_domain_escaped};/" "$NGINX_CONF"
    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        log_ok "nginx server_name aktualisiert"
    else
        log_warn "nginx config-Test fehlgeschlagen — bitte manuell prüfen"
    fi

    # CORS-Origin fÃ¼r Edge Functions auf diese Domain beschrÃ¤nken
    set_allowed_origins_secret "$DOMAIN"
fi

set_allowed_origins_secret() {
    local domain="${1:-}"
    [[ -z "$domain" ]] && return 0

    local cli=""
    [[ -x "$SUPABASE_CLI" ]] && cli="$SUPABASE_CLI"
    command -v supabase >/dev/null 2>&1 && cli="${cli:-supabase}"
    if [[ -z "$cli" ]] || ! "$cli" projects list 2>/dev/null >/dev/null; then
        log_warn "supabase CLI nicht eingeloggt — ALLOWED_ORIGINS nicht automatisch gesetzt"
        log_warn "  Manuell: supabase secrets set ALLOWED_ORIGINS='https://${domain}'"
        return 0
    fi

    log_info "BeschrÃ¤nke Edge-Function CORS auf https://${domain} ..."
    if "$cli" secrets set "ALLOWED_ORIGINS=https://${domain}" 2>&1 | sed 's/^/    /'; then
        log_ok "ALLOWED_ORIGINS in Supabase gesetzt"
    else
        log_warn "Konnte ALLOWED_ORIGINS nicht in Supabase setzen"
    fi
}

# --- Zusammenfassung ---
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
PRIMARY_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
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
  Backup-Pfad:     ${BACKUP_DIR}
  nginx-Config:    ${NGINX_CONF}
  Update-Skript:   ${UPDATE_SCRIPT}
  Update-Log:      ${LOG_FILE}
  Update-Intervall: alle 5 Minuten

${BLUE}--- Webseite erreichbar unter: ---${NC}
EOF

if [[ -n "$DOMAIN" ]]; then
    echo -e "  ${GREEN}Domain:   ${NC}  http://${DOMAIN}/"
fi
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

${YELLOW}HTTPS / SSL Cert (OPTIONAL — manuell einrichten wenn gewünscht):${NC}
  Das Skript fragt KEIN SSL-Zertifikat ab. Wenn du HTTPS willst:
EOF

if [[ -n "$DOMAIN" ]]; then
    cat <<EOF
    1) DNS A-Record setzen: $DOMAIN -> ${PUBLIC_IP:-<öffentliche-IP>}
    2) Certbot installieren:
         sudo apt install certbot python3-certbot-nginx
    3) Zertifikat holen:
         sudo certbot --nginx -d $DOMAIN
    4) Auto-Renewal testen:
         sudo certbot renew --dry-run

EOF
else
    cat <<EOF
    1) Domain kaufen + DNS A-Record auf öffentliche IP setzen
    2) install.sh erneut ausführen mit Domain eingeben
    3) Certbot installieren:
         sudo apt install certbot python3-certbot-nginx
    4) Zertifikat holen:
         sudo certbot --nginx -d deine.domain.de
    5) Auto-Renewal testen:
         sudo certbot renew --dry-run

EOF
fi

cat <<EOF
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