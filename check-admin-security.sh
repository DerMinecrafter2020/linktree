#!/usr/bin/env bash
# =========================================================
# OpenWeb Admin-Security Check
# =========================================================
# Prüft auf dem Server:
#   1. config.js existiert und enthält gültige Supabase-Werte
#   2. /var/html/admin/admin-config.js existiert und ist geschützt
#   3. .openweb.env enthält CONFIG_SHARED_SECRET
#   4. nginx schützt /admin und /admin/admin-config.js
#   5. Supabase Secrets (falls CLI verfügbar)
#
# Aufruf:
#   sudo bash check-admin-security.sh
# =========================================================

set -uo pipefail
IFS=$'\n\t'

readonly INSTALL_DIR="${INSTALL_DIR:-/var/html}"
readonly NGINX_HTPASSWD="/etc/nginx/openweb-admin.htpasswd"
readonly NGINX_CONF="/etc/nginx/sites-available/openweb"
readonly ENV_FILE="${INSTALL_DIR}/.openweb.env"

# Farben
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()  { echo -e "${GREEN}✓${NC} $1"; }
warn(){ echo -e "${YELLOW}⚠${NC} $1"; }
err() { echo -e "${RED}✗${NC} $1"; }

EXIT_CODE=0

echo "============================================================"
echo " OpenWeb Admin-Security Check"
echo "============================================================"
echo ""

# --- 1. config.js ---
CONFIG_JS="${INSTALL_DIR}/config.js"
if [[ -f "$CONFIG_JS" ]]; then
    ok "config.js existiert: ${CONFIG_JS}"
    PERM=$(stat -c '%a' "$CONFIG_JS" 2>/dev/null || echo "?")
    if [[ "$PERM" == "644" ]]; then
        ok "config.js Berechtigung ist 644"
    else
        warn "config.js Berechtigung ist ${PERM} (erwartet 644)"
    fi

    URL=$(grep -oE "url:\s*'[^']*'" "$CONFIG_JS" | head -1 | sed -E "s/^.*url:\s*'//;s/'$//")
    KEY=$(grep -oE "anonKey:\s*'[^']*'" "$CONFIG_JS" | head -1 | sed -E "s/^.*anonKey:\s*'//;s/'$//")

    if [[ -n "$URL" && "$URL" != "https://DEIN-PROJEKT.supabase.co" ]]; then
        ok "Supabase URL gesetzt: ${URL}"
    else
        err "Supabase URL fehlt oder ist Platzhalter"
        EXIT_CODE=1
    fi

    if [[ -n "$KEY" && "$KEY" != "__SET_ME_MANUALLY__" && "${#KEY}" -gt 40 ]]; then
        ok "Supabase anon-key gesetzt (${#KEY} Zeichen)"
    else
        err "Supabase anon-key fehlt, ist Platzhalter oder zu kurz"
        EXIT_CODE=1
    fi
else
    err "config.js NICHT gefunden: ${CONFIG_JS}"
    EXIT_CODE=1
fi

echo ""

# --- 2. admin-config.js ---
ADMIN_CONFIG_JS="${INSTALL_DIR}/admin/admin-config.js"
if [[ -f "$ADMIN_CONFIG_JS" ]]; then
    ok "admin-config.js existiert: ${ADMIN_CONFIG_JS}"
    PERM=$(stat -c '%a' "$ADMIN_CONFIG_JS" 2>/dev/null || echo "?")
    if [[ "$PERM" == "600" ]]; then
        ok "admin-config.js Berechtigung ist 600"
    else
        warn "admin-config.js Berechtigung ist ${PERM} (erwartet 600)"
    fi

    if grep -q "sharedSecret:" "$ADMIN_CONFIG_JS"; then
        SECRET=$(grep -oE "sharedSecret:\s*'[^']*'" "$ADMIN_CONFIG_JS" | head -1 | sed -E "s/^.*sharedSecret:\s*'//;s/'$//")
        if [[ -n "$SECRET" && "${#SECRET}" -ge 20 ]]; then
            ok "Shared Secret in admin-config.js gesetzt (${#SECRET} Zeichen)"
        else
            err "Shared Secret in admin-config.js leer oder zu kurz"
            EXIT_CODE=1
        fi
    else
        err "Kein sharedSecret in admin-config.js gefunden"
        EXIT_CODE=1
    fi
else
    err "admin-config.js NICHT gefunden: ${ADMIN_CONFIG_JS}"
    warn "Lösung: sudo bash install.sh erneut ausführen"
    EXIT_CODE=1
fi

echo ""

# --- 3. .openweb.env ---
if [[ -f "$ENV_FILE" ]]; then
    ok ".openweb.env existiert: ${ENV_FILE}"
    PERM=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo "?")
    if [[ "$PERM" == "600" ]]; then
        ok ".openweb.env Berechtigung ist 600"
    else
        warn ".openweb.env Berechtigung ist ${PERM} (erwartet 600)"
    fi

    if grep -q "CONFIG_SHARED_SECRET=" "$ENV_FILE"; then
        ENV_SECRET=$(grep "CONFIG_SHARED_SECRET=" "$ENV_FILE" | head -1 | sed -E "s/^CONFIG_SHARED_SECRET='?//;s/'?$//")
        if [[ -n "$ENV_SECRET" && "${#ENV_SECRET}" -ge 20 ]]; then
            ok "CONFIG_SHARED_SECRET in .openweb.env gesetzt (${#ENV_SECRET} Zeichen)"
        else
            err "CONFIG_SHARED_SECRET in .openweb.env leer oder zu kurz"
            EXIT_CODE=1
        fi
    else
        err "CONFIG_SHARED_SECRET nicht in .openweb.env gefunden"
        EXIT_CODE=1
    fi
else
    err ".openweb.env NICHT gefunden: ${ENV_FILE}"
    EXIT_CODE=1
fi

echo ""

# --- 4. nginx ---
if [[ -f "$NGINX_CONF" ]]; then
    ok "nginx-Config existiert: ${NGINX_CONF}"

    if grep -q "auth_basic" "$NGINX_CONF" && grep -q "auth_basic_user_file" "$NGINX_CONF"; then
        ok "nginx Basic Auth ist konfiguriert"
    else
        err "nginx Basic Auth fehlt in Config"
        EXIT_CODE=1
    fi

    if grep -qE "location ~.*admin.*auth_basic" "$NGINX_CONF"; then
        ok "nginx schützt Admin-Bereich"
    else
        err "nginx Location für Admin-Bereich fehlt oder schützt nicht"
        EXIT_CODE=1
    fi

    if nginx -t >/dev/null 2>&1; then
        ok "nginx Config-Test erfolgreich"
    else
        err "nginx Config-Test FEHLGESCHLAGEN"
        EXIT_CODE=1
    fi
else
    err "nginx-Config NICHT gefunden: ${NGINX_CONF}"
    EXIT_CODE=1
fi

if [[ -f "$NGINX_HTPASSWD" ]]; then
    ok "htpasswd-Datei existiert: ${NGINX_HTPASSWD}"
    PERM=$(stat -c '%a' "$NGINX_HTPASSWD" 2>/dev/null || echo "?")
    if [[ "$PERM" == "640" ]]; then
        ok "htpasswd Berechtigung ist 640"
    else
        warn "htpasswd Berechtigung ist ${PERM} (erwartet 640)"
    fi
else
    err "htpasswd-Datei NICHT gefunden: ${NGINX_HTPASSWD}"
    EXIT_CODE=1
fi

echo ""

# --- 5. Supabase Secrets (optional) ---
SUPABASE_CLI="${SUPABASE_CLI:-/usr/local/bin/supabase}"
CLI=""
[[ -x "$SUPABASE_CLI" ]] && CLI="$SUPABASE_CLI"
command -v supabase >/dev/null 2>&1 && CLI="${CLI:-supabase}"

if [[ -n "$CLI" ]]; then
    if "$CLI" projects list 2>/dev/null >/dev/null; then
        ok "supabase CLI ist eingeloggt"

        SECRETS=$("$CLI" secrets list 2>/dev/null || true)
        if echo "$SECRETS" | grep -q "CONFIG_SHARED_SECRET"; then
            ok "CONFIG_SHARED_SECRET in Supabase Secrets vorhanden"
        else
            err "CONFIG_SHARED_SECRET fehlt in Supabase Secrets"
            warn "Lösung: ${CLI} secrets set CONFIG_SHARED_SECRET='$(grep CONFIG_SHARED_SECRET= "$ENV_FILE" 2>/dev/null | sed -E "s/^CONFIG_SHARED_SECRET='?//;s/'?$//")'"
            EXIT_CODE=1
        fi

        if echo "$SECRETS" | grep -q "SERVICE_ROLE_KEY"; then
            ok "SERVICE_ROLE_KEY in Supabase Secrets vorhanden"
        else
            err "SERVICE_ROLE_KEY fehlt in Supabase Secrets"
            warn "Lösung: ${CLI} secrets set SERVICE_ROLE_KEY='...'"
            EXIT_CODE=1
        fi

        if echo "$SECRETS" | grep -q "ALLOWED_ORIGINS"; then
            ok "ALLOWED_ORIGINS in Supabase Secrets vorhanden"
        else
            warn "ALLOWED_ORIGINS fehlt in Supabase Secrets (CORS ist dann offen)"
        fi
    else
        warn "supabase CLI nicht eingeloggt — Secrets können nicht geprüft werden"
        warn "  Prüfe manuell: ${CLI} secrets list"
    fi
else
    warn "supabase CLI nicht installiert — Secrets können nicht geprüft werden"
fi

echo ""
echo "============================================================"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo -e "${GREEN}Alle Checks bestanden.${NC}"
else
    echo -e "${RED}Es gibt Probleme — siehe ✗ oben.${NC}"
fi
echo "============================================================"

exit "$EXIT_CODE"
