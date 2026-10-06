-- cyberXLA admin: core schema and security rules.
--
-- Security model
--   * The public website never talks to these tables. Quotes arrive through the
--     submit-quote Edge Function, which logs in as the `quote_intake` role. That
--     role can do exactly one thing: call intake.submit_quote().
--   * The `anon` role (the public publishable key) has no access to anything.
--   * Admin access requires ALL of: a logged-in user, listed in public.admins,
--     whose session completed MFA (aal2). Enforced by RLS inside the database.
--   * Every change to leads, quotes and notes is written to public.audit_log by
--     a trigger. The audit log is read-only, even for the admin.

begin;

-- ---------------------------------------------------------------------------
-- Lock down defaults: nothing in public is reachable unless granted below.
-- ---------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- Admin allowlist + MFA check
-- ---------------------------------------------------------------------------
create table public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create policy admins_self_read on public.admins
  for select to authenticated
  using (user_id = auth.uid() and public.is_admin());
grant select on public.admins to authenticated;

-- ---------------------------------------------------------------------------
-- Leads and quotes
-- ---------------------------------------------------------------------------
create type public.lead_status  as enum ('new', 'contacted', 'proposal', 'won', 'lost');
create type public.quote_status as enum ('submitted', 'reviewing', 'sent', 'accepted', 'declined');

create table public.leads (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name       text not null check (char_length(name) between 1 and 120),
  company    text check (char_length(company) <= 160),
  email      text not null check (char_length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone      text check (char_length(phone) <= 40),
  status     public.lead_status not null default 'new',
  source     text not null default 'quote_builder' check (source in ('quote_builder', 'contact', 'manual')),
  value_monthly  numeric(12,2) not null default 0 check (value_monthly >= 0),
  value_one_time numeric(12,2) not null default 0 check (value_one_time >= 0)
);
create unique index leads_email_key on public.leads (lower(email));
create index leads_status_idx on public.leads (status, updated_at desc);

create table public.quotes (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid not null references public.leads (id) on delete cascade,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  status         public.quote_status not null default 'submitted',
  workstations   integer not null check (workstations between 0 and 5000),
  servers        integer not null check (servers between 0 and 500),
  -- Line items priced by the server, never by the browser.
  items          jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 60),
  monthly_total  numeric(12,2) not null check (monthly_total >= 0),
  one_time_total numeric(12,2) not null check (one_time_total >= 0),
  monthly_minimum_applied boolean not null default false,
  message        text check (char_length(message) <= 2000)
);
create index quotes_lead_idx    on public.quotes (lead_id, created_at desc);
create index quotes_created_idx on public.quotes (created_at desc);

create table public.lead_notes (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.leads (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  body       text not null check (char_length(body) between 1 and 10000)
);
create index lead_notes_lead_idx on public.lead_notes (lead_id, created_at desc);

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger leads_touch  before update on public.leads  for each row execute function public.touch_updated_at();
create trigger quotes_touch before update on public.quotes for each row execute function public.touch_updated_at();

-- RLS: admin (with MFA) only.
alter table public.leads      enable row level security;
alter table public.quotes     enable row level security;
alter table public.lead_notes enable row level security;

create policy leads_admin      on public.leads      for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy quotes_admin     on public.quotes     for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy lead_notes_admin on public.lead_notes for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.leads, public.quotes, public.lead_notes to authenticated;

-- ---------------------------------------------------------------------------
-- Audit log (append-only, written by triggers)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,
  actor_role text not null,
  action     text not null,
  table_name text not null,
  row_id     uuid,
  old_data   jsonb,
  new_data   jsonb
);
create index audit_log_at_idx  on public.audit_log (at desc);
create index audit_log_row_idx on public.audit_log (table_name, row_id);
alter table public.audit_log enable row level security;
create policy audit_log_admin_read on public.audit_log for select to authenticated using (public.is_admin());
grant select on public.audit_log to authenticated;

create function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (actor, actor_role, action, table_name, row_id, old_data, new_data)
  values (
    auth.uid(),
    coalesce(nullif(auth.jwt() ->> 'role', ''), session_user),
    lower(tg_op),
    tg_table_name,
    case when tg_op = 'DELETE' then old.id else new.id end,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end;
$$;
revoke all on function public.audit_row() from public, anon, authenticated;

create trigger leads_audit      after insert or update or delete on public.leads      for each row execute function public.audit_row();
create trigger quotes_audit     after insert or update or delete on public.quotes     for each row execute function public.audit_row();
create trigger lead_notes_audit after insert or update or delete on public.lead_notes for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------
-- Intake: the only way new quotes get in. Lives in a schema the API never
-- exposes, callable only by the quote_intake login role.
-- ---------------------------------------------------------------------------
create schema intake;
revoke all on schema intake from public, anon, authenticated;

create table intake.throttle (
  ip_hash      text not null,
  submitted_at timestamptz not null default now()
);
create index throttle_idx on intake.throttle (ip_hash, submitted_at desc);
create index throttle_at_idx on intake.throttle (submitted_at);
-- Defense in depth: the intake schema is already unreachable from the API.
alter table intake.throttle enable row level security;

create function intake.submit_quote(p jsonb, p_ip_hash text)
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
        status  = case when public.leads.status = 'lost' then 'new'::public.lead_status else public.leads.status end
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
revoke all on function intake.submit_quote(jsonb, text) from public, anon, authenticated;

-- The login role used by the Edge Function. Its password is set separately
-- (see README) so it never lives in this repository.
create role quote_intake login noinherit nocreatedb nocreaterole nobypassrls connection limit 10;
grant usage on schema intake to quote_intake;
grant execute on function intake.submit_quote(jsonb, text) to quote_intake;
alter role quote_intake set statement_timeout = '5s';
alter role quote_intake set search_path = '';

commit;
