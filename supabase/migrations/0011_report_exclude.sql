-- Computers to always leave off a client's patch reports, by the name shown
-- on the report (with or without its PIN, any case). Edited on the client's
-- page or from a report; the Sunday run skips them in the client report, the
-- internal detail, and the numbers.

begin;

create function public.names_ok(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select array_position(p, null) is null
     and coalesce(bool_and(char_length(btrim(n)) between 1 and 120), true)
  from unnest(p) as n;
$$;
revoke all on function public.names_ok(text[]) from public, anon;
grant execute on function public.names_ok(text[]) to authenticated;

alter table public.clients
  add column report_exclude text[] not null default '{}' check (cardinality(report_exclude) <= 200 and public.names_ok(report_exclude));

-- The writer's view of each client now includes the list.
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
               'exclude', to_jsonb(c.report_exclude)) order by c.company, c.contact_name)
      from public.clients c
      where c.reports_enabled and c.status <> 'former'), '[]'::jsonb),
    'existing', coalesce((
      select jsonb_agg(jsonb_build_object('client_id', r.client_id, 'period', r.period, 'period_key', r.period_key))
      from public.reports r
      where not r.is_test and r.created_at > now() - interval '45 days'), '[]'::jsonb)
  );
$$;

commit;
