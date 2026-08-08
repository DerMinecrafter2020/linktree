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

# Update anwenden
if git fetch origin "$REPO_BRANCH" --quiet 2>>"$LOG_FILE" && \
   git stash push -u -m "timer-auto-stash-$(date +%Y%m%d-%H%M%S)" >>"$LOG_FILE" 2>&1 && \
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
