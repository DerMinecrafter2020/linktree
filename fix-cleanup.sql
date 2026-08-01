-- =========================================================
-- CLEANUP: kaputte Test-Daten reparieren
-- =========================================================
-- Erst ausführen NACHDEM fix-policies.sql erfolgreich war.
-- (Sonst könnten diese INSERTs durch die RLS blockt sein —
--  sie sind als 'service_role' aber bypass-fähig.)
-- =========================================================

-- 1) Müll-Link mit javascript:-URL entfernen
delete from public.links where url like 'javascript:%';
delete from public.links where title = 'ATTACK_T1';
delete from public.links where title = 'js';

-- 2) Profil-Zeile neu anlegen (falls gelöscht)
insert into public.profile (id, name, handle, bio, avatar, avatar_url)
values (1, '@corneliusahner', 'Cornelius Ahner', 'Azubi, 21 Jahre alt', 'CA', null)
on conflict (id) do update set
  name      = excluded.name,
  handle    = excluded.handle,
  bio       = excluded.bio,
  avatar    = excluded.avatar,
  avatar_url= excluded.avatar_url;

-- 3) 3 saubere Beispiel-Links anlegen
insert into public.links (title, subtitle, url, icon, position, is_active, open_new)
select * from (values
  ('GitHub',    'Meine Open-Source-Projekte',     'https://github.com/corneliusahner', '🐙', 0, true, true),
  ('Twitter',   'Updates & Quick-Thoughts',       'https://twitter.com/corneliusahner','🐦', 1, true, true),
  ('E-Mail',    'Schreib mir direkt',             'mailto:hi@corneliusahner.de',       '✉️', 2, true, true)
) as v(title, subtitle, url, icon, position, is_active, open_new)
where not exists (select 1 from public.links);

-- 4) Verifizierung
select 'PROFILE:' as kind, count(*)::text as n from public.profile
union all
select 'LINKS:',   count(*)::text        from public.links;
