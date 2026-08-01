fix(repo): track config.js with placeholders so the page loads everywhere

Problem: config.js was untracked. On a fresh clone, the page
loaded without it, leading to 'Supabase nicht konfiguriert'
because window.SUPABASE_CONFIG.url was undefined.

Fix:
1. config.js is now in the repo with placeholder values
   (https://YOUR-PROJECT.supabase.co etc.). The page loads
   in 'demo mode' (localStorage only) when these placeholders
   are present.
2. .gitignore updated: removed 'config.js', added 'config.local.js'
   (backup with real secrets written by install.sh).
3. install.sh is_placeholder() now also recognizes:
   - URLs starting with YOUR-PROJECT
   - Keys starting with YOUR-ANON-KEY
   - The default 'admin123' admin password
   So a fresh config.js from the repo is detected as a placeholder
   and the user gets prompted to set real values.

Flow:
- Fresh clone: config.js has placeholders, page works in demo mode
- Run install.sh: placeholders replaced with real values
- Re-run install.sh: real values are kept (unless neuinstallieren)
- Other devices after git pull: see real values from the server

Verified: bash -n OK, config.js LF.
