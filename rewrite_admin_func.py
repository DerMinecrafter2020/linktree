import re

path = "install.sh"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

new = """# Admin-Bereich aktivieren / deaktivieren (nur serverseitig in nginx)
# Funktioniert auf allen Config-Versionen:
# - Neue Configs verwenden "include ${NGINX_ADMIN_STATE};" in der Admin-Location.
# - Alte Configs (nur location = /admin.html) bekommen einen Blocker ^~ /admin.
do_set_admin_enabled() {
    local enabled="$1"
    if [[ -z "$enabled" ]]; then
        log_error "Interner Fehler: do_set_admin_enabled braucht true/false"
        exit $EX_USAGE
    fi

    if [[ ! -f "$NGINX_CONF" ]]; then
        log_error "Keine nginx-Config ${NGINX_CONF} gefunden -- bitte erst installieren"
        exit $EX_CONFIG
    fi

    local marker="# -- OpenWeb admin area blocker (managed by install.sh) --"

    if [[ "$enabled" == "true" ]]; then
        log_info "Aktiviere Admin-Bereich..."
        printf '' > "$NGINX_ADMIN_STATE"
        sed -i "/${marker}/,/^    }/d" "$NGINX_CONF"
    else
        log_info "Deaktiviere Admin-Bereich..."
        printf 'return 404;\n' > "$NGINX_ADMIN_STATE"
        sed -i "/${marker}/,/^    }/d" "$NGINX_CONF"
        if ! grep -qF "$marker" "$NGINX_CONF"; then
            # Blocker-Location direkt nach "server {" einfuegen.
            # ^~ hat Vorrang vor "location = /admin.html" in alten Configs.
            sed -i "/^server {/a\\    ${marker}\\n    location ^~ /admin {\\n        return 404;\\n    }" "$NGINX_CONF"
        fi
    fi

    reload_nginx

    if [[ "$enabled" == "true" ]]; then
        log_ok "Admin-Bereich aktiviert -- /admin ist wieder erreichbar"
    else
        log_ok "Admin-Bereich deaktiviert -- /admin liefert jetzt 404"
    fi
    return 0
}"""

lines = content.splitlines(keepends=True)
start = None
end = None
for i, line in enumerate(lines):
    if start is None and "# Admin-Bereich aktivieren / deaktivieren" in line:
        start = i
    if start is not None and line.strip() == "reload_nginx() {":
        end = i
        break

if start is None or end is None:
    print(f"Could not locate block: start={start}, end={end}")
    raise SystemExit(1)

new_content = "".join(lines[:start] + [new + "\n\n"] + lines[end:])
with open(path, "w", encoding="utf-8") as f:
    f.write(new_content)
print("install.sh updated")
