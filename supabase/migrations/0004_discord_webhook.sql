-- =========================================================
-- Migration 0004: Discord-Webhook für Now-Playing
-- =========================================================
-- Neue Tabelle public.admin_settings (Singleton, id = 1).
-- Enthält sensible Admin-Konfiguration wie Discord-Webhook-URL.
-- Lesezugriff ist komplett blockiert (nur service_role/Edge Functions).
-- =========================================================

-- Funktion: Default-Template für Discord-Embeds
-- Platzhalter: {title}, {artist}, {album}, {cover}, {url}
create or replace function public.default_discord_template()
returns text as $$
begin
  return jsonb_pretty(jsonb_build_object(
    'content', '🎵 Jetzt läuft:',
    'embeds', jsonb_build_array(jsonb_build_object(
      'title', '{title}',
      'description', 'von {artist}' || case when '{album}' <> '' then ' — Album: {album}' else '' end,
      'color', 0xff2bd6,
      'thumbnail', jsonb_build_object('url', '{cover}'),
      'footer', jsonb_build_object('text', 'OpenWeb Now Playing'),
      'timestamp', now()
    ))
  ));
end;
$$ language plpgsql;

-- Tabelle für sensible Admin-Konfiguration
create table if not exists public.admin_settings (
  id                    int primary key default 1,
  discord_webhook_url   text null,
  discord_webhook_enabled boolean not null default false,
  discord_webhook_template text not null default public.default_discord_template(),
  updated_at            timestamptz not null default now(),
  constraint admin_settings_singleton check (id = 1)
);

-- Trigger: updated_at automatisch setzen
drop trigger if exists trg_admin_settings_updated_at on public.admin_settings;
create trigger trg_admin_settings_updated_at
  before update on public.admin_settings
  for each row execute function public.set_updated_at();

-- RLS: komplett gesperrt für anon/authenticated
alter table public.admin_settings enable row level security;

drop policy if exists "admin_settings no read" on public.admin_settings;
create policy "admin_settings no read" on public.admin_settings
  for select to anon, authenticated using (false);

-- Default-Eintrag
insert into public.admin_settings (id)
values (1)
on conflict (id) do nothing;
