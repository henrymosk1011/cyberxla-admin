-- Archive and delete for leads and quotes, hideable activity entries, and a
-- keep-alive heartbeat for the free plan.

begin;

-- ---------------------------------------------------------------------------
-- Archive: hidden from the pipeline and stats, kept for the record.
-- ---------------------------------------------------------------------------
alter table public.leads  add column archived_at timestamptz;
alter table public.quotes add column archived_at timestamptz;
create index leads_archived_idx  on public.leads (archived_at);
create index quotes_archived_idx on public.quotes (archived_at);

-- Keep a lead's value equal to its newest active quote when quotes are
-- archived, restored, or deleted.
create function public.refresh_lead_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead uuid := coalesce(new.lead_id, old.lead_id);
  v_m numeric(12,2);
  v_o numeric(12,2);
begin
  select q.monthly_total, q.one_time_total into v_m, v_o
  from public.quotes q
  where q.lead_id = v_lead and q.archived_at is null
  order by q.created_at desc
  limit 1;
  update public.leads l
     set value_monthly = coalesce(v_m, 0), value_one_time = coalesce(v_o, 0)
   where l.id = v_lead
     and (l.value_monthly is distinct from coalesce(v_m, 0) or l.value_one_time is distinct from coalesce(v_o, 0));
  return null;
end;
$$;
revoke all on function public.refresh_lead_value() from public, anon, authenticated;
create trigger quotes_refresh_lead_value
  after update of archived_at or delete on public.quotes
  for each row execute function public.refresh_lead_value();

-- ---------------------------------------------------------------------------
-- Activity: the audit log stays append-only. "Removing" an entry hides it from
-- the dashboard timeline; the original record is never altered.
-- ---------------------------------------------------------------------------
create table public.activity_hidden (
  audit_id  bigint primary key references public.audit_log (id) on delete cascade,
  hidden_at timestamptz not null default now(),
  hidden_by uuid default auth.uid() references auth.users (id) on delete set null
);
alter table public.activity_hidden enable row level security;
create policy activity_hidden_admin on public.activity_hidden for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, delete on public.activity_hidden to authenticated;

-- ---------------------------------------------------------------------------
-- Intake: un-archive a returning lead.
-- ---------------------------------------------------------------------------
create or replace function intake.submit_quote(p jsonb, p_ip_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email   text := lower(btrim(p ->> 'email'));
  v_lead_id uuid;
  v_quote_id uuid;
  v_monthly numeric(12,2) := (p ->> 'monthly_total')::numeric;
  v_once    numeric(12,2) := (p ->> 'one_time_total')::numeric;
begin
  if p_ip_hash is null or char_length(p_ip_hash) <> 64 then
    raise exception 'bad request' using errcode = '22023';
  end if;

  -- Housekeeping: keep the throttle table small.
  delete from intake.throttle where submitted_at < now() - interval '1 day';

  -- Per-IP: 5 per hour. Global: 300 per day (flood guard).
  if (select count(*) from intake.throttle where ip_hash = p_ip_hash and submitted_at > now() - interval '1 hour') >= 5
     or (select count(*) from intake.throttle) >= 300 then
    raise exception 'rate limited' using errcode = 'P0429';
  end if;
  insert into intake.throttle (ip_hash) values (p_ip_hash);

  insert into public.leads (name, company, email, phone, source, value_monthly, value_one_time)
  values (
    btrim(p ->> 'name'),
    nullif(btrim(p ->> 'company'), ''),
    v_email,
    nullif(btrim(p ->> 'phone'), ''),
    'quote_builder',
    v_monthly,
    v_once
  )
  on conflict ((lower(email))) do update
    set name    = excluded.name,
        company = coalesce(excluded.company, public.leads.company),
        phone   = coalesce(excluded.phone, public.leads.phone),
        value_monthly  = excluded.value_monthly,
        value_one_time = excluded.value_one_time,
        status  = case when public.leads.status = 'lost' then 'new'::public.lead_status else public.leads.status end,
        -- A new quote from an archived lead brings it back.
        archived_at = null
  returning id into v_lead_id;

  insert into public.quotes (lead_id, workstations, servers, items, monthly_total, one_time_total, monthly_minimum_applied, message)
  values (
    v_lead_id,
    (p ->> 'workstations')::integer,
    (p ->> 'servers')::integer,
    p -> 'items',
    v_monthly,
    v_once,
    coalesce((p ->> 'monthly_minimum_applied')::boolean, false),
    nullif(btrim(p ->> 'message'), '')
  )
  returning id into v_quote_id;

  return v_quote_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Heartbeat: a tiny daily write so a free-plan project never looks inactive.
-- Callable with the public key; it can only bump one timestamp, at most once
-- every 10 minutes, and returns nothing.
-- ---------------------------------------------------------------------------
create table intake.heartbeat (
  id int primary key check (id = 1),
  beat_at timestamptz not null default now()
);
alter table intake.heartbeat enable row level security;
insert into intake.heartbeat (id) values (1);

create function public.keepalive()
returns void
language sql
security definer
set search_path = ''
as $$
  update intake.heartbeat set beat_at = now() where id = 1 and beat_at < now() - interval '10 minutes';
$$;
revoke all on function public.keepalive() from public, authenticated;
grant execute on function public.keepalive() to anon;

commit;
