#!/bin/sh
# =========================================================
# OpenWeb — Versionsnummer erhoehen (Semantic Versioning)
# =========================================================
# Aufruf:  sh scripts/bump-version.sh [patch|minor|major]   (Standard: patch)
#
# Aktualisiert die Version an allen Stellen, an denen sie hart kodiert ist:
#   - package.json            ("version")
#   - package-lock.json       (Top-Level + packages[""])
#   - public/sw.js            (CACHE_NAME -> alter Offline-Cache wird verworfen)
#   - public/index.html       (Footer "vX.Y.Z")
# Reines POSIX-sh (kein Node noetig), laeuft unter Linux, macOS und Git Bash (Windows).

set -e

root=$(git rev-parse --show-toplevel)
cd "$root"

part=${1:-patch}

old=$(sed -n 's/^  "version": "\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)",$/\1/p' package.json | head -n 1)
if [ -z "$old" ]; then
  echo "[bump-version] Version in package.json nicht gefunden." >&2
  exit 1
fi

major=${old%%.*}
rest=${old#*.}
minor=${rest%%.*}
patch=${rest#*.}

case "$part" in
  major) major=$((major + 1)); minor=0; patch=0 ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  patch) patch=$((patch + 1)) ;;
  *) echo "[bump-version] Unbekannter Teil '$part' (erlaubt: patch, minor, major)." >&2; exit 1 ;;
esac

new="$major.$minor.$patch"
old_re=$(printf '%s' "$old" | sed 's/\./\\./g')

# sed ohne -i (unterscheidet sich zwischen GNU und BSD): ueber temporaere Datei ersetzen
replace() {
  file=$1
  expr=$2
  sed "$expr" "$file" > "$file.bump-tmp"
  mv "$file.bump-tmp" "$file"
}

replace package.json "s/^  \"version\": \"$old_re\",\$/  \"version\": \"$new\",/"
replace package-lock.json "1,12s/\"version\": \"$old_re\",/\"version\": \"$new\",/"
replace public/sw.js "s/openweb-cache-v$old_re'/openweb-cache-v$new'/"
replace public/index.html "s#</a> · v$old_re</span>#</a> · v$new</span>#"

# Pruefen, dass wirklich ueberall ersetzt wurde
for file in package.json package-lock.json public/sw.js public/index.html; do
  if ! grep -q "$new" "$file"; then
    echo "[bump-version] Version in $file nicht aktualisiert – bitte manuell pruefen." >&2
    exit 1
  fi
done

echo "[bump-version] $old -> $new"
