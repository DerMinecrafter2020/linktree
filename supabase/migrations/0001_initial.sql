-- =========================================================
-- Supabase SQL-Setup
-- =========================================================
-- Führe dieses Skript EINMAL im Supabase SQL-Editor aus:
--   https://app.supabase.com → SQL Editor → New Query → Einfügen → Run
-- =========================================================

-- 1) Tabelle für das Profil (es gibt nur eine Zeile mit id = 1)
create table if not exists public.profile (
  id          int          primary key default 1,
  name        text         not null default '@corneliusahner',
  handle      text         not null default 'Cornelius Ahner',
  bio         text         not null default 'Azubi, 21 Jahre alt',
  avatar      text         not null default 'CA',
  avatar_url  text         null,
  updated_at  timestamptz  not null default now(),
  constraint profile_singleton check (id = 1)
);

-- Falls die Tabelle schon existiert (z.B. Wiederholungslauf), fehlende Spalte ergänzen
alter table public.profile
  add column if not exists avatar_url text;

-- Theme-Auswahl (Whitelist in DB + Client)
--   neon   = aktueller Dark & Neon Look (default)
--   light  = heller, freundlicher Look
--   sunset = warmer Sonnenuntergang
--   mono   = minimalistisch schwarz/weiß
alter table public.profile
  add column if not exists theme text not null default 'neon';

alter table public.profile
  drop constraint if exists profile_theme_whitelist;
alter table public.profile
  add constraint profile_theme_whitelist
    check (theme in ('neon','light','sunset','mono'));

insert into public.profile (id, name, handle, bio, avatar, theme)
values (1, '@corneliusahner', 'Cornelius Ahner', 'Azubi, 21 Jahre alt', 'CA', 'neon')
on conflict (id) do nothing;

-- 2) Tabelle für die Links
create table if not exists public.links (
  id          uuid         primary key default gen_random_uuid(),
  title       text         not null,
  subtitle    text         not null default '',
  url         text         not null,
  icon        text         not null default '🔗',
  position    int          not null default 0,
  is_active   boolean      not null default true,
  open_new    boolean      not null default true,
  created_at  timestamptz  not null default now(),
  updated_at  timestamptz  not null default now()
);

create index if not exists links_position_idx on public.links (position);

-- 3) Trigger: updated_at automatisch setzen
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_links_updated_at on public.links;
create trigger trg_links_updated_at
  before update on public.links
  for each row execute function public.set_updated_at();

drop trigger if exists trg_profile_updated_at on public.profile;
create trigger trg_profile_updated_at
  before update on public.profile
  for each row execute function public.set_updated_at();

-- 4) Row Level Security aktivieren
alter table public.profile enable row level security;
alter table public.links   enable row level security;

-- 5) Policies: Jeder darf lesen (öffentliche Seite).
--    Schreiben darf nur der Service-Role-Key (via Edge-Function
--    admin-proxy). Anon und authenticated werden hart geblockt.
drop policy if exists "profile read"   on public.profile;
drop policy if exists "profile write"  on public.profile;
drop policy if exists "links read"     on public.links;
drop policy if exists "links write"    on public.links;
drop policy if exists "links insert"   on public.links;
drop policy if exists "links update"   on public.links;
drop policy if exists "links delete"   on public.links;

-- Public-Read für alle (anon + authenticated)
create policy "profile read"  on public.profile for select to anon, authenticated using (true);
create policy "links read"    on public.links   for select to anon, authenticated using (true);

-- Schreiben für anon und authenticated verbieten.
-- Edge-Function admin-proxy verwendet SERVICE_ROLE_KEY und bypassed RLS.
create policy "profile deny write" on public.profile
  for all to anon, authenticated using (false) with check (false);

create policy "links deny insert" on public.links
  for insert to anon, authenticated with check (false);

create policy "links deny update" on public.links
  for update to anon, authenticated using (false) with check (false);

create policy "links deny delete" on public.links
  for delete to anon, authenticated using (false);

-- Defense-in-Depth: explizit für anon DENY
-- (anon sollte zwar schon durch das Fehlen einer Policy geblockt
-- sein, aber so ist die Absicht eindeutig dokumentiert)
drop policy if exists "anon deny all profile" on public.profile;
drop policy if exists "anon deny all links" on public.links;
create policy "anon deny all profile" on public.profile for all to anon using (false) with check (false);
create policy "anon deny all links"   on public.links   for all to anon using (false) with check (false);

-- =========================================================
-- Größen-Limits als CHECK-Constraints (DoS-Schutz)
-- =========================================================
alter table public.profile
  drop constraint if exists profile_name_len,
  drop constraint if exists profile_handle_len,
  drop constraint if exists profile_bio_len,
  drop constraint if exists profile_avatar_len,
  drop constraint if exists profile_avatar_url_len;

alter table public.profile
  add constraint profile_name_len       check (char_length(name)       <= 80),
  add constraint profile_theme_len       check (char_length(theme)       <= 16),
  add constraint profile_handle_len     check (char_length(handle)     <= 80),
  add constraint profile_bio_len        check (char_length(bio)        <= 280),
  add constraint profile_avatar_len     check (char_length(avatar)     <= 8),
  add constraint profile_avatar_url_len check (avatar_url is null or char_length(avatar_url) <= 700_000); -- ~500KB Base64

alter table public.links
  drop constraint if exists links_title_len,
  drop constraint if exists links_subtitle_len,
  drop constraint if exists links_url_len,
  drop constraint if exists links_icon_len;

alter table public.links
  add constraint links_title_len    check (char_length(title)    <= 200),
  add constraint links_subtitle_len check (char_length(subtitle) <= 300),
  add constraint links_url_len     check (char_length(url)      <= 500),
  add constraint links_icon_len    check (char_length(icon)     <= 200);

-- URL-Protokoll-Check (nur http/https/mailto)
alter table public.links
  drop constraint if exists links_url_proto;
alter table public.links
  add constraint links_url_proto check (
    url ~* '^https?://' or url ~* '^mailto:'
  );

-- 6) Realtime aktivieren (optional, damit Änderungen live auf der Hauptseite ankommen)
-- Wir ignorieren 42710 (Tabelle bereits in der Publication), falls das Skript mehrfach läuft.
do $$
begin
  begin
    alter publication supabase_realtime add table public.profile;
  exception
    when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.links;
  exception
    when duplicate_object then null;
  end;
end
$$;

-- 7) Admin-Einstellungen (Navidrome-Player etc.)
--    Admin-Authentifizierung läuft über nginx Basic Auth (serverseitig).
--    Kein Passwort-Hash wird in Supabase gespeichert.
create table if not exists public.admin_settings (
  id                            int          primary key default 1,
  navidrome_enabled             boolean      not null default false,
  navidrome_proxy_url           text         null,
  navidrome_poll_interval_sec   int          not null default 30,
  updated_at                    timestamptz  not null default now(),
  constraint admin_settings_singleton check (id = 1)
);

insert into public.admin_settings (id) values (1) on conflict (id) do nothing;

-- RLS: niemand liest/schreibt direkt. Service-Role via Edge-Function.
alter table public.admin_settings enable row level security;
drop policy if exists "admin_settings all" on public.admin_settings;
create policy "admin_settings deny all" on public.admin_settings for all to anon, authenticated using (false) with check (false);
