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
readonly SUPABASE_PROJECT_REF="fxywervpqojpjwreymdp"
readonly SUPABASE_CLI="${SUPABASE_CLI:-/usr/local/bin/supabase}"
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

# =========================================================
# Modi-Funktionen (nur Definition; am Anfang aufgerufen)
# =========================================================

# 1) Update von GitHub
do_update() {
    if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
        log_error "Kein Git-Repo unter ${INSTALL_DIR} — bitte erst installieren"
        exit 1
    fi
    log_info "Update von ${REPO_URL}..."
    cd "$INSTALL_DIR"
    git reset --hard HEAD >/dev/null
    if git pull --ff-only origin main; then
        log_ok "Repo aktualisiert"
        nginx -t && systemctl reload nginx || true
        log_ok "nginx neu geladen"
    else
        log_error "git pull fehlgeschlagen"
        exit 1
    fi
}

# 2) Supabase CLI installieren / reparieren
do_install_cli() {
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq curl ca-certificates >/dev/null 2>&1 || true
    install_supabase_cli
    if command -v supabase >/dev/null 2>&1; then
        log_ok "supabase CLI jetzt verfügbar: $(supabase --version 2>/dev/null | head -n1)"
    else
        log_warn "CLI konnte nicht installiert werden"
    fi
}

# 3) Skript selbst updaten
do_update_self() {
    log_info "Aktuelle Version von GitHub holen..."
    local tmp
    tmp=$(mktemp /tmp/openweb-install.XXXXXX.sh)
    if curl -fsSL "https://raw.githubusercontent.com/DerMinecrafter2020/linktree/main/install.sh" -o "$tmp"; then
        # Backup
        local backup="/etc/openweb-install.sh.backup.$(date +%s)"
        cp -f "$0" "$backup" 2>/dev/null || true
        cp -f "$tmp" "$0"
        chmod +x "$0"
        rm -f "$tmp"
        log_ok "Skript aktualisiert. Backup: $backup"
        log_info "Starte mit: sudo bash install.sh"
        exec bash "$0"
    else
        log_error "Download fehlgeschlagen"
        rm -f "$tmp"
        exit 1
    fi
}

# 4) Alles deinstallieren
do_uninstall() {
    log_warn "Deinstallation: OpenWeb wird vollständig entfernt!"
    echo ""
    echo -n "  Bist du sicher? Tippe 'JA' zum Bestätigen: "
    read -r CONFIRM
    [[ "$CONFIRM" == "JA" ]] || { log_info "Abgebrochen"; exit 0; }

    log_info "Stoppe Auto-Update-Timer..."
    systemctl stop    openweb-updater.timer 2>/dev/null || true
    systemctl disable openweb-updater.timer 2>/dev/null || true

    log_info "Entferne systemd-Units..."
    rm -f "$SYSTEMD_SERVICE" "$SYSTEMD_TIMER"
    systemctl daemon-reload

    log_info "Entferne Update-Skript..."
    rm -f "$UPDATE_SCRIPT"

    log_info "Deaktiviere nginx-Site..."
    if [[ -L "$NGINX_LINK" ]]; then rm -f "$NGINX_LINK"; fi
    if [[ -f "$NGINX_CONF" ]]; then rm -f "$NGINX_CONF"; fi
    # Default-Site wieder aktivieren
    if [[ ! -e /etc/nginx/sites-enabled/default ]]; then
        ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default 2>/dev/null || true
    fi
    nginx -t && systemctl reload nginx || true

    log_info "Entferne Webseite (${INSTALL_DIR})..."
    if [[ -d "$INSTALL_DIR" ]]; then
        # Backup mit Timestamp
        local backup="/var/html.backup.$(date +%s)"
        mv "$INSTALL_DIR" "$backup" 2>/dev/null || rm -rf "$INSTALL_DIR"
        log_ok "Backup: $backup"
    fi

    log_info "Entferne Logs und Lock-Files..."
    rm -f "$LOG_FILE" /var/lock/openweb-update.lock

    log_ok "OpenWeb wurde deinstalliert."
    log_info "nginx + supabase-cli wurden NICHT entfernt (sind separate Pakete)."
    log_info "Falls du auch nginx komplett entfernen willst:"
    log_info "  apt remove --purge nginx"
}

# 5) Admin-Passwort aendern (config.js)
do_change_password() {
    if [[ ! -d "$INSTALL_DIR" ]]; then
        log_error "Kein OpenWeb-Install unter ${INSTALL_DIR} — bitte erst installieren"
        exit 1
    fi

    log_info "Admin-Passwort aendern"

    # Aktuelles Passwort aus config.js lesen
    local current_pw
    current_pw=$(grep -oE "ADMIN_DEFAULT_PASSWORD\s*=\s*['\"][^'\"]*['\"]" "${INSTALL_DIR}/config.js" 2>/dev/null | head -1 | sed "s/ADMIN_DEFAULT_PASSWORD\s*=\s*['\"]//;s/['\"]$//")
    if [[ -z "$current_pw" ]]; then
        current_pw="(unbekannt)"
    fi
    log_info "  aktuelles Passwort in config.js: ${current_pw:0:3}*** (Laenge: ${#current_pw})"

    # Neues Passwort abfragen (mit Doppel-Bestaetigung wenn TTY)
    change_admin_password
    local new_pw="$ADMIN_PASSWORD"

    # config.js aktualisieren — nur die ADMIN_DEFAULT_PASSWORD-Zeile ersetzen
    local escaped_pw
    escaped_pw=$(printf '%s' "$new_pw" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' 2>/dev/null || \
                  printf '%s' "$new_pw" | sed 's/\\/\\\\/g; s/"/\\"/g; s/'"'"'/\\'"'"'/g')

    # Backup vor Aenderung
    cp -n "${INSTALL_DIR}/config.js" "${INSTALL_DIR}/config.js.bak.$(date +%s)" 2>/dev/null || true

    # Zeile ersetzen
    if grep -q "window.ADMIN_DEFAULT_PASSWORD" "${INSTALL_DIR}/config.js"; then
        sed -i "s|window\.ADMIN_DEFAULT_PASSWORD\s*=.*|window.ADMIN_DEFAULT_PASSWORD = $escaped_pw;|" "${INSTALL_DIR}/config.js"
    else
        # Falls Zeile fehlt, am Ende der Datei anfuegen
        echo "window.ADMIN_DEFAULT_PASSWORD = $escaped_pw;" >> "${INSTALL_DIR}/config.js"
    fi
    chmod 640 "${INSTALL_DIR}/config.js"
    log_ok "Admin-Passwort in ${INSTALL_DIR}/config.js aktualisiert"
    log_info "Hinweis: Browser muss localStorage (linktree-admin-pw-hash) leeren,"
    log_info "         damit der neue Hash beim Login-Versuch berechnet wird."
    log_info "         Im Browser-Console: localStorage.clear(); dann /admin.html neu laden."
}

# 5) Supabase CLI installieren (von hier aufrufbar)
install_supabase_cli() {
    if [[ -x "$SUPABASE_CLI" ]] || command -v supabase >/dev/null 2>&1; then
        log_ok "supabase CLI bereits vorhanden"
        return 0
    fi
    log_info "supabase CLI nicht gefunden — versuche Installation..."

    # Variante A: Offizieller one-liner von Supabase (curl | bash)
    # Quelle: https://github.com/supabase/cli#install-the-cli
    log_info "  Versuche offiziellen one-liner (curl | bash)..."
    if curl -fsSL https://raw.githubusercontent.com/supabase/cli/main/install | bash 2>/dev/null; then
        if command -v supabase >/dev/null 2>&1; then
            log_ok "supabase CLI via offiziellem one-liner installiert"
            return 0
        fi
    fi

    # Variante B: .deb-Paket von GitHub Releases (fuer Debian/Ubuntu)
    log_info "  one-liner fehlgeschlagen, versuche .deb-Paket..."

    # Architektur erkennen
    local arch
    arch=$(uname -m)
    case "$arch" in
        x86_64) arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)
            log_warn "Unbekannte Architektur '$arch' — CLI-Installation wird uebersprungen"
            return 1
            ;;
    esac

    local deb_url="https://github.com/supabase/cli/releases/latest/download/supabase_linux_${arch}.deb"
    local deb_file="/tmp/supabase-cli.deb"

    if curl -fsSL -o "$deb_file" "$deb_url" 2>/dev/null; then
        if dpkg -i "$deb_file" 2>/dev/null; then
            log_ok "supabase CLI via .deb installiert"
            rm -f "$deb_file"
            return 0
        fi
        rm -f "$deb_file"
    fi

    # Variante C: .tar.gz herunterladen und nach /usr/local/bin entpacken
    log_info "  .deb fehlgeschlagen, versuche tar.gz..."
    local tar_url="https://github.com/supabase/cli/releases/latest/download/supabase_linux_${arch}.tar.gz"
    local tar_file="/tmp/supabase-cli.tar.gz"

    if curl -fsSL -o "$tar_file" "$tar_url" 2>/dev/null; then
        if tar -xzf "$tar_file" -C /tmp/ 2>/dev/null && [[ -x /tmp/supabase ]]; then
            mv /tmp/supabase /usr/local/bin/supabase
            chmod +x /usr/local/bin/supabase
            log_ok "supabase CLI via tar.gz nach /usr/local/bin installiert"
            rm -f "$tar_file"
            return 0
        fi
    fi
    rm -f "$tar_file"

    log_warn "CLI-Installation fehlgeschlagen — Navidrome-Secrets koennen nicht aus Supabase geladen werden"
    return 1
}

# --- Root-Check ---
if [[ $EUID -ne 0 ]]; then
    log_error "Bitte als root ausführen: sudo bash $0"
    exit 1
fi

# --- Modus-Wahl: interaktives Menü oder Kommandozeilen-Argument ---
# Erlaubt direkten Aufruf:  sudo bash install.sh neuinstallieren
# Oder interaktiv:          sudo bash install.sh
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
        "Alles deinstallieren" \
        "Beenden"
    do
        case "$REPLY" in
            1) MODE="neuinstallieren" ;;
            2) MODE="update" ;;
            3) MODE="install-cli" ;;
            4) MODE="update-self" ;;
            5) MODE="change-password" ;;
            6) MODE="uninstall" ;;
            7) log_info "Abbruch"; exit 0 ;;
            *) log_warn "Ungültige Auswahl: $REPLY"; continue ;;
        esac
        break
    done
fi

log_info "Modus: $MODE"

# === Modi, die ohne install auskommen ===
case "$MODE" in
    update)
        do_update
        exit 0
        ;;
    update-self)
        do_update_self
        exit 0
        ;;
    uninstall)
        do_uninstall
        exit 0
        ;;
    install-cli)
        do_install_cli
        exit 0
        ;;
    change-password)
        do_change_password
        exit 0
        ;;
esac

# === Standard-Pfad: install (auch fuer 'neuinstallieren') ===

# --- Schritt 1: System-Abhängigkeiten installieren ---
log_info "Installiere System-Abhängigkeiten (nginx, git, curl, ca-certificates)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx git curl ca-certificates ufw >/dev/null
log_ok "Abhängigkeiten installiert"

# --- Schritt 2: Admin-Passwort ---
# Default: 'admin123' — der User muss es nach dem ersten Login aendern
# (Force-Change-Dialog in admin.js). Hier nur ein optionaler Override.
prompt_admin_password() {
    log_info "Konfiguration: Admin-Passwort für /admin.html"
    echo ""

    # Falls schon ein Passwort in config.js existiert, nachfragen ob
    # ein neues gesetzt werden soll. So wird der User bei Re-Runs nicht
    # jedes Mal zur Passwort-Eingabe gezwungen.
    local keep_existing=0
    if [[ "$MODE" != "neuinstallieren" ]]; then
        if [[ -n "${EXISTING_ADMIN_PW:-}" ]]; then
            if ! is_placeholder "${EXISTING_ADMIN_PW:-}"; then
                keep_existing=1
            fi
        fi
    fi
    if [[ "$keep_existing" -eq 1 ]]; then
        echo -n "  Bestehendes Passwort erkannt. Neues Passwort setzen? (j/N): "
        read -r CHANGE_PW
        if [[ ! "$CHANGE_PW" =~ ^[jJyY]$ ]]; then
            log_info "  bestehendes Passwort wird beibehalten"
            ADMIN_PASSWORD="$EXISTING_ADMIN_PW"
            return 0
        fi
        log_info "  OK, neues Passwort wird gesetzt"
    fi

    # Default-Passwort vorschlagen + Override-Funktion anbieten
    echo ""
    echo "  Standard-Passwort: admin123"
    echo "  (Beim ersten /admin.html-Login wirst du zum Aendern gezwungen.)"
    echo ""
    echo "  Optionen:"
    echo "    [Enter]       Standard 'admin123' verwenden"
    echo "    <eigenes PW>  Jetzt ein anderes Passwort setzen"
    echo ""
    echo -n "  Deine Wahl: "
    read -r ADMIN_PASSWORD

    # Wenn leer → Standard admin123
    if [[ -z "$ADMIN_PASSWORD" ]]; then
        ADMIN_PASSWORD="admin123"
        log_info "  Standard-Passwort 'admin123' wird gesetzt"
    else
        log_ok "  eigenes Passwort wird gesetzt"
    fi
}

# Helper-Funktion: eigenes Passwort spaeter via Menue aendern
# Wird vom install.sh 'change-password'-Modus (oder interaktiv) aufgerufen.
change_admin_password() {
    echo ""
    log_info "Admin-Passwort aendern"
    echo ""
    while true; do
        echo -n "  Neues Admin-Passwort (Enter = Standard 'admin123'): "
        read -r NEW_PW
        if [[ -z "$NEW_PW" ]]; then
            NEW_PW="admin123"
            log_info "  Standard-Passwort 'admin123' wird verwendet"
            break
        fi
        # Optional: Doppel-Eingabe zur Bestaetigung (nur fuer TTY)
        if [[ -t 0 ]]; then
            echo -n "  Passwort bestaetigen: "
            read -r CONFIRM_PW
            if [[ "$NEW_PW" != "$CONFIRM_PW" ]]; then
                log_warn "Passwoerter stimmen nicht ueberein — erneut versuchen"
                continue
            fi
        fi
        break
    done
    ADMIN_PASSWORD="$NEW_PW"
}

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

# Wenn config.js noch nicht existiert (frischer Klon), aus config.example.js kopieren
if [[ ! -f "${INSTALL_DIR}/config.js" ]]; then
    if [[ -f "${INSTALL_DIR}/config.example.js" ]]; then
        cp "${INSTALL_DIR}/config.example.js" "${INSTALL_DIR}/config.js"
        log_ok "config.js aus config.example.js erstellt (frischer Klon)"
    else
        log_warn "Weder config.js noch config.example.js vorhanden — erstelle leeres Template"
    fi
fi

# Wenn schon eine config.js mit echten Daten existiert, behalten wir sie.
# So gehen Werte aus früheren install-Läufen nicht verloren.
# Ausnahme: 'neuinstallieren' ueberschreibt alles ohne Rueckfrage.
EXISTING_CONFIG="${INSTALL_DIR}/config.js"
EXISTING_URL=""
EXISTING_ANON_KEY=""
EXISTING_ADMIN_PW=""
if [[ "$MODE" != "neuinstallieren" && -f "$EXISTING_CONFIG" ]]; then
    # Bestehende Werte extrahieren (vorsichtig, ohne JS zu eval)
    EXISTING_URL=$(grep -oE "url:\s*'[^']*'" "$EXISTING_CONFIG" 2>/dev/null | head -1 | sed "s/url:\s*'//;s/'$//")
    EXISTING_ANON_KEY=$(grep -oE "anonKey:\s*'[^']*'" "$EXISTING_CONFIG" 2>/dev/null | head -1 | sed "s/anonKey:\s*'//;s/'$//")
    EXISTING_ADMIN_PW=$(grep -oE "ADMIN_DEFAULT_PASSWORD\s*=\s*'[^']*'" "$EXISTING_CONFIG" 2>/dev/null | head -1 | sed "s/ADMIN_DEFAULT_PASSWORD\s*=\s*'//;s/'$//")
    EXISTING_ADMIN_PW=${EXISTING_ADMIN_PW:-$(grep -oE "ADMIN_DEFAULT_PASSWORD\s*=\s*\"[^\"]*\"" "$EXISTING_CONFIG" 2>/dev/null | head -1 | sed 's/ADMIN_DEFAULT_PASSWORD\s*=\s*"//;s/"$//')}
elif [[ "$MODE" == "neuinstallieren" ]]; then
    log_info "  Modus 'neuinstallieren' — alle Werte werden neu abgefragt"
fi

# Erkennen, ob Platzhalter vorhanden sind
is_placeholder() {
    case "$1" in
        ""|"__SET_ME_MANUALLY__"|"YOUR_USER"|"YOUR_PASS") return 0;;
        *) return 1;;
    esac
}

# Versuchen, einen Supabase-Secret auszulesen.
# Methode 1: 'supabase secrets get NAME' (interaktive CLI, erfordert Login)
# Methode 2: Management-API mit Access-Token (falls SUPABASE_ACCESS_TOKEN gesetzt)
# Gibt Klartext zurück oder leer bei Fehler.
get_supabase_secret() {
    local name="$1"
    # CLI vorhanden + eingeloggt?
    local cli=""
    [[ -x "$SUPABASE_CLI" ]] && cli="$SUPABASE_CLI"
    command -v supabase >/dev/null 2>&1 && cli="${cli:-supabase}"
    if [[ -n "$cli" ]]; then
        local val
        val=$("$cli" secrets get --project-ref "$SUPABASE_PROJECT_REF" "$name" 2>/dev/null | head -n1 | tr -d '\r')
        # Wenn die CLI nicht eingeloggt ist, gibt sie einen Fehler aus — verwerfen
        if [[ -n "$val" && "$val" != *"error"* && "$val" != *"Error"* ]]; then
            echo "$val"
            return 0
        fi
    fi
    return 1
}

# (install_supabase_cli() ist weiter oben definiert — siehe Modi-Funktionen)

# Jetzt erst das Passwort-Prompt — es kennt jetzt die EXISTING_*-Werte
prompt_admin_password

# Supabase-URL: bestehender Wert nur behalten, wenn kein Platzhalter
if [[ -n "$EXISTING_URL" ]] && ! is_placeholder "$EXISTING_URL"; then
    SUPABASE_URL="$EXISTING_URL"
    log_info "  bestehende Supabase-URL behalten: $SUPABASE_URL"
else
    echo -n "  Supabase URL [https://fxywervpqojpjwreymdp.supabase.co]: "
    read SUPABASE_URL
    SUPABASE_URL=${SUPABASE_URL:-https://fxywervpqojpjwreymdp.supabase.co}
fi

# Supabase anon-key: bestehender Wert nur behalten, wenn kein Platzhalter
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

# Passwort als JSON-String escapen
ADMIN_PASS_JSON=$(printf '%s' "$ADMIN_PASSWORD" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' 2>/dev/null || \
                  printf '%s' "$ADMIN_PASSWORD" | sed 's/\\/\\\\/g; s/"/\\"/g; s/'"'"'/\\'"'"'/g')

# Navidrome-Werte: immer interaktiv nach Credentials fragen.
# Früher wurde versucht, die Werte aus Supabase-Secrets zu lesen,
# aber das hat sich als unzuverlässig erwiesen (Login-State,
# Cache, Token-Refresh). Stattdessen: User gibt die Werte einmal ein,
# das Skript setzt sie (a) lokal in config.js und (b) bei eingeloggtem
# CLI direkt in Supabase. So funktioniert es ohne Token-Cache-Issues.

# Erst CLI installieren (falls noetig)
install_supabase_cli

# Login-Status nur pruefen (KEIN auto-read der Secrets)
SECRETS_READABLE=0
if command -v supabase >/dev/null 2>&1; then
    if supabase projects list 2>/dev/null | grep -q "$SUPABASE_PROJECT_REF"; then
        log_ok "supabase CLI eingeloggt und Projekt $SUPABASE_PROJECT_REF verlinkt"
        SECRETS_READABLE=1
    else
        log_warn "supabase CLI nicht eingeloggt — Secrets werden nur in config.js gesetzt"
    fi
fi

# Frage Navidrome-URL
echo ""
echo -n "  Navidrome URL (z.B. https://music.deinedomain.de oder http://localhost:4533): "
read -r NAV_URL_PROMPT
NAV_URL="${NAV_URL_PROMPT:-https://music.deinedomain.de}"

# Frage Navidrome-Username
echo -n "  Navidrome Username: "
read -r NAV_USER
if [[ -z "$NAV_USER" ]]; then
    log_warn "Username leer — Player bleibt deaktiviert"
    NAV_USER="YOUR_USER"
    NAV_ENABLED="false"
    NAV_PASS_JSON='"YOUR_PASS"'
else
    NAV_ENABLED="true"
    # Frage Navidrome-Passwort (sichtbar)
    while true; do
        echo -n "  Navidrome Passwort: "
        read -r NAV_PASS
        if [[ -z "$NAV_PASS" ]]; then
            log_warn "Passwort darf nicht leer sein — bitte erneut eingeben"
            continue
        fi
        break
    done

    # Wenn CLI eingeloggt: Secrets in Supabase setzen
    if [[ "$SECRETS_READABLE" -eq 1 ]]; then
        log_info "Setze Secrets in Supabase (NAVIDROME_URL/USER/PASS)..."
        env_tmp="/tmp/openweb-nav-env"
        # Hier-String mit Single-Quotes: KEINE Sonderzeichen-Interpretation
        cat > "$env_tmp" <<EOF
NAVIDROME_URL=${NAV_URL}
NAVIDROME_USER=${NAV_USER}
NAVIDROME_PASS=${NAV_PASS}
EOF
        chmod 600 "$env_tmp"
        if supabase secrets set --project-ref "$SUPABASE_PROJECT_REF" --env-file "$env_tmp" 2>&1; then
            log_ok "Secrets in Supabase gesetzt"
        else
            log_warn "supabase secrets set fehlgeschlagen — nur lokal in config.js"
        fi
        rm -f "$env_tmp"
    else
        log_warn "CLI nicht eingeloggt — Secrets nur lokal. Spaeter manuell mit:"
        log_warn "    supabase login"
        log_warn "    supabase link --project-ref $SUPABASE_PROJECT_REF"
        log_warn "    supabase secrets set NAVIDROME_URL='${NAV_URL}' NAVIDROME_USER='${NAV_USER}' NAVIDROME_PASS='${NAV_PASS}'"
    fi

    # Passwort als JSON-String escapen (lokale Verwendung in config.js)
    NAV_PASS_JSON=$(printf '%s' "$NAV_PASS" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' 2>/dev/null || \
                    printf '%s' "$NAV_PASS" | sed 's/\\/\\\\/g; s/"/\\"/g; s/'"'"'/\\'"'"'/g')
fi

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
  enabled: ${NAV_ENABLED},
  url: '${NAV_URL}',
  user: '${NAV_USER}',
  pass: ${NAV_PASS_JSON},
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

# --- Domain-Abfrage (fuer nginx server_name + spateren Certbot-Hinweis) ---
DOMAIN=""
EXISTING_DOMAIN=$(grep -oE "server_name\s+[^;]+;" "$NGINX_CONF" 2>/dev/null | head -1 | awk '{print $2}')

if [[ -n "$EXISTING_DOMAIN" && "$EXISTING_DOMAIN" != "_" ]]; then
    echo ""
    echo -n "  Domain erkannt (${EXISTING_DOMAIN}). Aendern? (j/N): "
    read -r CHANGE_DOMAIN
    if [[ "$CHANGE_DOMAIN" =~ ^[jJyY]$ ]]; then
        echo -n "  Domain (z.B. meine.domain.de, leer fuer keine): "
        read -r DOMAIN
    else
        DOMAIN="$EXISTING_DOMAIN"
    fi
else
    echo ""
    echo -n "  Domain (z.B. meine.domain.de, leer fuer keine — Default '_' bleibt): "
    read -r DOMAIN
fi

# nginx server_name aktualisieren, wenn Domain angegeben
if [[ -n "$DOMAIN" ]]; then
    log_info "Setze nginx server_name auf '$DOMAIN'..."
    sed -i "s/^\(\s*\)server_name\s\+\(_\|.*\);/\1server_name $DOMAIN;/" "$NGINX_CONF"
    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        log_ok "nginx server_name aktualisiert"
    else
        log_warn "nginx config-Test fehlgeschlagen — bitte manuell pruefen"
    fi
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

${YELLOW}HTTPS / SSL Cert (OPTIONAL — manuell einrichten wenn gewuenscht):${NC}
  Das Skript fragt KEIN SSL-Zertifikat ab. Wenn du HTTPS willst:
EOF

if [[ -n "$DOMAIN" ]]; then
    cat <<EOF
    1) DNS A-Record setzen: $DOMAIN -> ${PUBLIC_IP:-<oeffentliche-IP>}
    2) Certbot installieren:
         sudo apt install certbot python3-certbot-nginx
    3) Zertifikat holen:
         sudo certbot --nginx -d $DOMAIN
    4) Auto-Renewal testen:
         sudo certbot renew --dry-run

EOF
else
    cat <<EOF
    1) Domain kaufen + DNS A-Record auf oeffentliche IP setzen
    2) install.sh erneut ausfuehren mit Domain eingeben
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