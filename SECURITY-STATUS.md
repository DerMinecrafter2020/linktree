# 🛡️ Security Status

**Architektur:** OpenWeb laeuft jetzt als Node.js + Express + PostgreSQL-Anwendung.
Es gibt keinen Supabase-Abhaengigkeit mehr. Alle Supabase-Dateien wurden
entfernt.

## Angewendete Schutzmaßnahmen

| Bereich | Massnahme |
|---|---|
| **Auth** | bcrypt-Hashing, serverseitige Sessions via `connect-pg-simple`, kein Basic-Auth |
| **Navidrome-Credentials** | AES-256-GCM-Verschluesselung in PostgreSQL; Key liegt nur in `.env`; Browser sieht Credentials nie |
| **Session-Cookie** | `httpOnly`, `secure` in Production, `sameSite: lax` |
| **Sicherheitsheader** | Helmet, CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` |
| **Input-Validierung** | `safeText()`, `safeUrl()`, `sanitizeIconField()`, `validateEmail()`, `validateAvatarUrl()` auf Client und Server |
| **SQL** | Parameterisierte Queries via `pg` |
| **Secrets** | `.env` gehoert dem App-User, `chmod 600` |

## Empfohlene Checks vor Produktivbetrieb

- [ ] `SESSION_SECRET` und `NAVIDROME_ENCRYPTION_KEY` sind 64 zufaellige Hex-Zeichen.
- [ ] `.env` ist nicht in git (`git check-ignore .env` sollte treffen).
- [ ] PostgreSQL ist nicht oeffentlich erreichbar.
- [ ] nginx/Reverse-Proxy setzt `X-Forwarded-Proto: https`.
- [ ] Admin-Passwort hat mindestens 8 Zeichen.
- [ ] `NODE_ENV=production` ist gesetzt.

## Ehemalige Supabase-Security-Probleme

Die in der vorherigen Version dokumentierten RLS-Probleme und Supabase-offenen
Schreibzugriffe existieren in dieser Postgres-Rewrite nicht mehr, da die
Datenbank nur noch vom eigenen Node.js-Backend angesprochen wird.
