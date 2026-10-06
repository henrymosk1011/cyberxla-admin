-- Homepage packages (Essential / Secure / Shield): per-device monthly rates
-- for each volume tier, edited from the dashboard and read live by the
-- homepage package cards and pricing calculator.
-- rates[1..4] = 1 to 24, 25 to 49, 50 to 99, 100+ devices.
begin;

create table public.packages (
  id         text primary key check (id in ('essential', 'secure', 'shield')),
  name       text not null,
  rates      numeric(8,2)[] not null check (
               cardinality(rates) = 4 and array_position(rates, null) is null
               and 0 <= all (rates) and 10000 >= all (rates)),
  sort       integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.packages (id, name, rates, sort) values
  ('essential', 'Essential', '{10, 9.5, 9, 8.5}', 0),
  ('secure',    'Secure',    '{18, 17, 16, 15}',  1),
  ('shield',    'Shield',    '{32, 30, 28.5, 27}', 2);

create trigger packages_touch before update on public.packages for each row execute function public.touch_updated_at();
create trigger packages_audit after insert or update or delete on public.packages for each row execute function public.audit_row_text_id();

-- The three cards are fixed on the homepage, so admins can only change rates.
alter table public.packages enable row level security;
create policy packages_admin on public.packages for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.packages from anon, authenticated;
grant select on public.packages to authenticated;
grant update (rates) on public.packages to authenticated;

-- What the homepage reads: {"essential": [10, 9.5, 9, 8.5], ...}
create function public.package_pricing()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(id, to_jsonb(rates)), '{}'::jsonb) from public.packages;
$$;
revoke all on function public.package_pricing() from public;
grant execute on function public.package_pricing() to anon, authenticated;

commit;
