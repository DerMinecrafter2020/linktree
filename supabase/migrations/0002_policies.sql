-- =========================================================
-- KRITISCHER SICHERHEITS-FIX: fehlende RLS-Policies
-- =========================================================
-- Dieses Skript ist IDEMPOTENT und enthält NUR die noch
-- fehlenden Policies. Es überschreibt KEINE bestehenden
-- Daten, sondern aktiviert RLS und blockiert anon-Writes.
--
-- Ausführen: Supabase Dashboard → SQL Editor → New Query
--           → gesamten Inhalt einfügen → Run
-- =========================================================

-- 1) RLS explizit aktivieren (falls nicht bereits geschehen)
alter table public.profile enable row level security;
alter table public.links   enable row level security;

-- 2) Policies löschen falls vorhanden (idempotent)
drop policy if exists "profile read"        on public.profile;
drop policy if exists "profile write"       on public.profile;
drop policy if exists "links read"          on public.links;
drop policy if exists "links insert"        on public.links;
drop policy if exists "links update"        on public.links;
drop policy if exists "links delete"        on public.links;
drop policy if exists "anon deny all profile" on public.profile;
drop policy if exists "anon deny all links"   on public.links;

-- 3) Lese-Policies für anon + authenticated (Public Read)
create policy "profile read" on public.profile
  for select to anon, authenticated
  using (true);

create policy "links read" on public.links
  for select to anon, authenticated
  using (true);

-- 4) Schreib-Policies NUR für authenticated mit role='admin' im JWT
--    (Achtung: anon hat per Definition KEIN role='admin', wird also
--     durch die USING-Klausel geblockt, auch wenn die Policy 'all'
--     umfasst. Zusätzlich gibt es unten die expliziten anon-DENYs.)
create policy "profile write" on public.profile
  for all to authenticated
  using ((auth.jwt() ->> 'role')::text = 'admin')
  with check ((auth.jwt() ->> 'role')::text = 'admin');

create policy "links insert" on public.links
  for insert to authenticated
  with check ((auth.jwt() ->> 'role')::text = 'admin');

create policy "links update" on public.links
  for update to authenticated
  using ((auth.jwt() ->> 'role')::text = 'admin')
  with check ((auth.jwt() ->> 'role')::text = 'admin');

create policy "links delete" on public.links
  for delete to authenticated
  using ((auth.jwt() ->> 'role')::text = 'admin');

-- 5) Defense-in-Depth: explizit für anon DENY
--    (Selbst wenn jemand oben etwas falsch macht, ist anon geblockt)
create policy "anon deny all profile" on public.profile
  for all to anon
  using (false)
  with check (false);

create policy "anon deny all links" on public.links
  for all to anon
  using (false)
  with check (false);

-- =========================================================
-- FERTIG. Die nächsten Schritte sind außerhalb dieses Skripts:
--  1. Edge Functions deployen
--  2. JWT_SECRET setzen
--  3. config.js: authEnabled = true
--  4. DB aufräumen (siehe fix-cleanup.sql)
-- =========================================================
