fix(repo): untrack config.js again + ensure install.sh preserves it

We tried tracking config.js with placeholders so the page would
load on fresh clones. But that created a worse problem: every
git pull on a server with real config.js overwrites it with
placeholders, breaking the live site.

Reverted to the original approach: config.js stays in .gitignore.
config.example.js remains as the only template in the repo.

install.sh already creates config.js from config.example.js on
fresh clones (via the 'if [[ ! -f ... ]]' block added earlier).
On re-runs, it detects existing values and keeps them (unless
'neuinstallieren' is selected).

Verified: bash -n install.sh OK, git check-ignore confirms
config.js is ignored.
