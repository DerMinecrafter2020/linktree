feat(player): enable Navidrome player by default

Previously the player was disabled by default (enabled: false),
forcing the user to either:
- edit config.js manually
- run install.sh with placeholder override

This was friction for users who already configured Navidrome
on their server (via Supabase secrets or admin panel).

Changes:
1. config.example.js: enabled: true (was false)
2. install.sh: comment clarifies enabled=true is the default
3. app.js mergeNavidromeConfig():
   - Default to enabled=true when no localStorage override exists
   - If localStorage has explicit boolean, respect that
4. app.js np.isEnabled():
   - Removed check on 'c.enabled' — proxyUrl alone is enough
   - The player will now try to connect whenever a proxyUrl is set
     and will show a setup-needed message if it fails

If the user wants the player OFF, they can still disable it via
the Admin-Panel or by editing config.js.

Verified: bash -n OK, no JS errors.
