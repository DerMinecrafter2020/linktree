feat(admin): setup form for Supabase URL + anonKey (no localStorage)

Major architecture change: remove localStorage as a fallback for
profile/links. Everything must go through Supabase.

Changes:

1. supabase-client.js: replaced mockDb() (localStorage) with
   needsSetupDb() that throws 'Supabase not configured' for all
   data operations. isMock is still true so the UI can detect it.

2. admin.js: new showSetupForm() function creates a modal with
   URL + anon-key + optional shared-secret fields. Submits via
   SupabaseAPI.saveConfig() which POSTs to the save-config edge
   function. After success, page reloads automatically.

3. admin.js: DOMContentLoaded checks db.needsSetup before the
   normal login flow. If needsSetup is true, showSetupForm()
   runs and we return early.

4. admin.html: includes api/supabase/save-config.js

5. api/supabase/save-config.js: new client-side wrapper that
   derives the project-ref from the URL and POSTs to
   https://<ref>.supabase.co/functions/v1/save-config

6. supabase/functions/save-config/index.ts: new Edge Function.
   Verifies shared-secret (if set), then reads /var/html/config.js,
   backs it up, replaces url/anonKey/adminProxyUrl/etc lines,
   and writes back.

7. install.sh: do_install_cli() also deploys the save-config
   function if the CLI is installed.

Flow:
- Fresh install with no config.js: page shows setup form
- User enters URL + anon-key, submits
- Browser POSTs to save-config edge function
- Edge function rewrites /var/html/config.js on the server
- Page reloads, config.js is now correct, Supabase works
- All future data operations go through real Supabase

No more localStorage for profile/links. Verified: no syntax errors,
bash -n OK.
