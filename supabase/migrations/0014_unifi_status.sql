-- The latest UniFi status for each client with a UniFi console, for the UniFi
-- tab on a report: the router's software version, any update waiting, and
-- when it was last updated. The reports repo writes it (Check now, a daily
-- check, and the Sunday run); the admin only reads it.

begin;

create table public.unifi_status (
  client_id  uuid primary key references public.clients (id) on delete cascade,
  console    text not null check (char_length(console) between 1 and 200),
  checked_at timestamptz not null default now(),
  data       jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 65536)
);
alter table public.unifi_status enable row level security;
create policy unifi_status_admin_read on public.unifi_status for select to authenticated using (public.is_admin());
revoke all on public.unifi_status from anon, authenticated;
grant select on public.unifi_status to authenticated;

-- Save the status of each client checked: [{ client_id, console, data }].
-- Only clients that still name a UniFi console are saved. Returns how many.
create function reporting.unifi_status_put(p jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p) > 200 then
    raise exception 'expected an array of up to 200 clients' using errcode = '22023';
  end if;

  insert into public.unifi_status (client_id, console, checked_at, data)
  select c.id, left(x ->> 'console', 200), now(), x -> 'data'
  from jsonb_array_elements(p) x
  join public.clients c on c.id::text = x ->> 'client_id' and nullif(btrim(c.unifi_console), '') is not null
  where jsonb_typeof(x -> 'data') = 'object' and coalesce(x ->> 'console', '') <> ''
  on conflict (client_id) do update set console = excluded.console, checked_at = excluded.checked_at, data = excluded.data;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function reporting.unifi_status_put(jsonb) from public, anon, authenticated;
grant execute on function reporting.unifi_status_put(jsonb) to report_writer;

commit;
