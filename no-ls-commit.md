feat: remove ALL localStorage usage (everything via Supabase + server-side auth)

User requested zero localStorage. Three areas had localStorage:

1. Admin-Passwort (PBKDF2-Hash, salt, iter, must-change flag):
   - REMOVED. Login now goes through auth-login Edge Function
   server-side. JWT is stored in sessionStorage (which is OK -
   disappears on tab close, can't be shared across origins).
   - ensureDefaultHash() deleted.
   - verifyPassword() deleted.
   - setPassword() now calls auth-change-password.
   - Force-change-dialog uses server-side auth-change-password
     instead of local verifyPassword.

2. Navidrome-Config (openweb-navidrome-config):
   - REMOVED from admin.js. Values now go directly into
     window.NAVIDROME_CONFIG (in-memory).
   - app.js loadNavidromeFromStorage() deleted. mergeNavidromeConfig()
     reads from window.NAVIDROME_CONFIG only.

3. Settings hint text: now always shows server-side message,
   no more localStorage reference.

Other cleanups:
- STORAGE_PW_* constants removed
- PBKDF2 helper functions removed (no longer needed)
- randomSalt / bufferToBase64 kept (used by navidrome config)
- hasValidSession() now reads sessionStorage (set by supabase-client
  after successful login)
- mustChangePassword() now reads JWT payload (server tells us via
  payload.must_change flag)

Verified: no syntax errors.
