-- UniFi equipment on patch reports. A client can name its UniFi console (its
-- name as UniFi Site Manager shows it, or its host id). The Sunday run reads
-- that console's devices with a read only UniFi Site Manager key, which lives
-- only in the private reports repo, and keeps a small log of the software
-- versions it has seen. When a version changes, the next report says the
-- router (or another UniFi device) was updated, without anyone typing it in.

begin;

alter table public.clients
  add column unifi_console text check (unifi_console is null or char_length(btrim(unifi_console)) between 1 and 200);

-- One row per device and software version: when a run first saw it, and when
-- the device had last started then (an update restarts it, so that is usually
-- when the update went in). Only reached through reporting.unifi_seen().
create table reporting.unifi_versions (
  device_id    text not null check (char_length(device_id) between 1 and 200),
  version      text not null check (char_length(version) between 1 and 120),
  host_id      text not null check (char_length(host_id) between 1 and 200),
  device_name  text not null default '' check (char_length(device_name) <= 200),
  model        text not null default '' check (char_length(model) <= 120),
  is_console   boolean not null default false,
  first_seen   timestamptz not null default now(),
  startup_time timestamptz,
  primary key (device_id, version)
);
alter table reporting.unifi_versions enable row level security;
revoke all on reporting.unifi_versions from public, anon, authenticated;

-- Record the devices one run sees and return the version history of those
-- devices, oldest first. Seeing a version again changes nothing.
create function reporting.unifi_seen(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p) > 500 then
    raise exception 'expected an array of up to 500 devices' using errcode = '22023';
  end if;

  insert into reporting.unifi_versions (device_id, version, host_id, device_name, model, is_console, startup_time)
  select left(d ->> 'device_id', 200), left(d ->> 'version', 120), left(coalesce(d ->> 'host_id', ''), 200),
         left(coalesce(d ->> 'name', ''), 200), left(coalesce(d ->> 'model', ''), 120),
         coalesce((d ->> 'is_console')::boolean, false), nullif(d ->> 'startup_time', '')::timestamptz
  from jsonb_array_elements(p) d
  where coalesce(d ->> 'device_id', '') <> '' and coalesce(d ->> 'version', '') <> '' and coalesce(d ->> 'host_id', '') <> ''
  on conflict (device_id, version) do nothing;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'device_id', v.device_id, 'version', v.version,
             'first_seen', v.first_seen, 'startup_time', v.startup_time) order by v.device_id, v.first_seen)
    from reporting.unifi_versions v
    where v.device_id in (select d ->> 'device_id' from jsonb_array_elements(p) d)), '[]'::jsonb);
end;
$$;

-- The writer's view of each client now includes its UniFi console.
create or replace function reporting.context()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'now', now(),
    'settings', (select to_jsonb(s) - 'id' - 'updated_at' from public.report_settings s where s.id = 1),
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'name', coalesce(nullif(btrim(c.company), ''), c.contact_name),
               'group', c.action1_group,
               'exclude', to_jsonb(c.report_exclude),
               'unifi', nullif(btrim(c.unifi_console), '')) order by c.company, c.contact_name)
      from public.clients c
      where c.reports_enabled and c.status <> 'former'), '[]'::jsonb),
    'existing', coalesce((
      select jsonb_agg(jsonb_build_object('client_id', r.client_id, 'period', r.period, 'period_key', r.period_key))
      from public.reports r
      where not r.is_test and r.created_at > now() - interval '45 days'), '[]'::jsonb)
  );
$$;

revoke all on function reporting.unifi_seen(jsonb) from public, anon, authenticated;
grant execute on function reporting.unifi_seen(jsonb) to report_writer;

commit;
