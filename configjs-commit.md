fix(repo): untrack config.js + auto-create from config.example.js

Problem: config.js contained Navidrome credentials and was being
committed to Git. On other devices after 'git pull', users got
placeholders instead of real values because config.js was being
overwritten or never created.

Two changes:

1. .gitignore now excludes config.js (matches the existing intent
   in the comment that says 'config.js is not checked in').
   Removed from git tracking via 'git rm --cached'.
   config.example.js remains as the template.

2. install.sh now auto-creates config.js from config.example.js
   on a fresh clone (when neither file exists in the install dir
   yet). This means: 'git clone + install.sh' works on every
   device, even before any config exists.

   install.sh also still detects existing config.js and keeps
   its real values when re-running (unless 'neuinstallieren'
   is selected).

Verified: bash -n install.sh -> exit 0
Verified: config.js no longer in 'git ls-files'
