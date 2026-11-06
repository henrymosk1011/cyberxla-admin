-- Patch reports: weekly and monthly Action1 reports for each client. Drafts
-- are made on Sunday, reviewed and edited in the dashboard, and sent Monday
-- morning unless held.
--
-- Security model (the same as quote intake)
--   * The admin (allowlisted, MFA) reads and edits reports through RLS. A guard
--     trigger decides which status changes and edits are allowed, so the rules
--     hold even outside the dashboard.
--   * GitHub Actions in the private reports repo log in as report_writer. That
--     role can only call the functions in the `reporting` schema, which the API
--     never exposes. It can't read or change anything else, and recipients
--     always come from the client record, never from the caller.
--   * PDFs live in report_files, so no Storage policies or service key.
--   * Every change to reports and report_settings goes to audit_log, without
--     the large generated columns.

begin;

-- ---------------------------------------------------------------------------
-- Settings (one row)
-- ---------------------------------------------------------------------------
-- The GitHub schedules run hourly on Sunday and Monday (UTC), and the last
-- Sunday or Monday UTC hour is 3 PM Pacific, so times stay at 3:00 PM or
-- earlier. Times are Pacific.
create table public.report_settings (
  id                  integer primary key default 1 check (id = 1),
  mode                text not null default 'preview' check (mode in ('preview', 'live')),
  auto_send_default   boolean not null default true,
  generate_time       time not null default '12:00' check (generate_time between '00:00' and '15:00'),
  send_time           time not null default '08:00' check (send_time between '00:00' and '15:00'),
  sunday_review_email boolean not null default true,
  updated_at          timestamptz not null default now()
);
insert into public.report_settings (id) values (1);

create trigger report_settings_touch before update on public.report_settings for each row execute function public.touch_updated_at();
create trigger report_settings_audit after insert or update or delete on public.report_settings for each row execute function public.audit_row_text_id();

alter table public.report_settings enable row level security;
create policy report_settings_admin on public.report_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.report_settings from anon, authenticated;
grant select on public.report_settings to authenticated;
grant update (mode, auto_send_default, generate_time, send_time, sunday_review_email) on public.report_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Who gets reports: set on each client
-- ---------------------------------------------------------------------------
create function public.emails_ok(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select array_position(p, null) is null
     and coalesce(bool_and(char_length(e) <= 254 and e ~* '^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$'), true)
  from unnest(p) as e;
$$;
revoke all on function public.emails_ok(text[]) from public, anon;
grant execute on function public.emails_ok(text[]) to authenticated;

alter table public.clients
  add column action1_group     text check (action1_group is null or char_length(btrim(action1_group)) between 1 and 80),
  add column report_recipients text[] not null default '{}' check (cardinality(report_recipients) <= 10 and public.emails_ok(report_recipients)),
  add column report_cc         text[] not null default '{}' check (cardinality(report_cc) <= 10 and public.emails_ok(report_cc)),
  add column reports_enabled   boolean not null default false,
  add constraint clients_reports_ready check (not reports_enabled or (action1_group is not null and cardinality(report_recipients) > 0));
create unique index clients_action1_group_key on public.clients (lower(action1_group)) where action1_group is not null;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------
create type public.report_status as enum ('scheduled', 'held', 'sending', 'sent', 'failed', 'cancelled');

create table public.reports (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- A client with reports can't be deleted, so what was sent stays on record.
  client_id        uuid not null references public.clients (id) on delete restrict,
  period           text not null check (period in ('weekly', 'monthly')),
  -- 2026-W45 (ISO week of the Sunday it was made) or 2026-10 (the month covered).
  period_key       text not null check (
                     (period = 'weekly' and period_key ~ '^\d{4}-W\d{2}$') or
                     (period = 'monthly' and period_key ~ '^\d{4}-(0[1-9]|1[0-2])$')),
  period_start     date not null,
  period_end       date not null check (period_end >= period_start),
  -- A test run never blocks the real report, never sends on a schedule, and
  -- always goes out in preview mode.
  is_test          boolean not null default false,
  status           public.report_status not null,
  send_at          timestamptz not null,
  recipients       text[] not null check (cardinality(recipients) between 1 and 10 and public.emails_ok(recipients)),
  cc               text[] not null default '{}' check (cardinality(cc) <= 10 and public.emails_ok(cc)),
  subject          text not null check (char_length(btrim(subject)) between 1 and 300),
  -- Plain text paragraphs; **bold** is the only markup.
  email_body       text not null check (char_length(btrim(email_body)) between 1 and 20000),
  -- Every client facing string in the PDF (lib/content.js in the reports repo).
  content          jsonb not null check (jsonb_typeof(content) = 'object' and pg_column_size(content) <= 2000000),
  -- What was generated (content, subject, email_body), for Reset to generated.
  original         jsonb not null check (jsonb_typeof(original) = 'object'),
  -- The raw report model, for the internal PDF.
  data             jsonb not null check (jsonb_typeof(data) = 'object'),
  failure_count    integer not null default 0 check (failure_count >= 0),
  warnings         text[] not null default '{}' check (cardinality(warnings) <= 20),
  -- Raised by the guard trigger whenever content changes. The PDFs are current
  -- when rendered_version catches up.
  content_version  integer not null default 1 check (content_version >= 1),
  rendered_version integer not null default 0 check (rendered_version >= 0),
  rendered_at      timestamptz,
  render_error     text check (char_length(render_error) <= 2000),
  claimed_at       timestamptz,
  attempts         integer not null default 0 check (attempts >= 0),
  sent_at          timestamptz,
  -- Stamped on the email as an X-cyberxLA-Report header.
  send_ref         text check (char_length(send_ref) <= 100),
  error            text check (char_length(error) <= 2000)
);
create unique index reports_period_key on public.reports (client_id, period, period_key) where not is_test;
create index reports_due_idx    on public.reports (status, send_at);
create index reports_client_idx on public.reports (client_id, created_at desc);
create index reports_period_idx on public.reports (period_key);

-- PDFs (client and internal) and PNG images of the client PDF's pages for the
-- dashboard preview. Page images are dropped once a report is sent.
create table public.report_files (
  report_id  uuid not null references public.reports (id) on delete cascade,
  kind       text not null check (kind in ('client', 'internal', 'page')),
  page       integer not null default 0 check (page between 0 and 50),
  version    integer not null check (version >= 1),
  bytes      bytea not null check (octet_length(bytes) between 1 and 5000000),
  size       integer generated always as (octet_length(bytes)) stored,
  created_at timestamptz not null default now(),
  primary key (report_id, kind, page),
  check ((kind = 'page') = (page >= 1))
);

-- What the admin may do. Status changes:
--   scheduled -> held, cancelled         (Hold, Cancel)
--   held      -> scheduled, cancelled    (Resume, Send now, Cancel)
--   failed    -> scheduled, held, cancelled
--   cancelled -> held, scheduled
--   sending   -> sent, failed            (after checking Sent Items by hand)
-- What the client gets can't change once a report is sending or sent. Sent
-- reports are kept; test reports can always be deleted unless sending.
create function public.guard_report()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- Dashboard requests run as `authenticated`. The reporting functions run as
  -- their owner and do their own checks; so does the SQL editor.
  v_admin boolean := current_user = 'authenticated';
begin
  if tg_op = 'DELETE' then
    if v_admin and (old.status = 'sending' or (old.status = 'sent' and not old.is_test)) then
      raise exception 'Sent reports are kept for the record and can''t be deleted' using errcode = 'P0403';
    end if;
    return old;
  end if;

  if new.content is distinct from old.content then
    new.content_version := old.content_version + 1;
  end if;

  if not v_admin then
    return new;
  end if;

  if old.status in ('sending', 'sent') and (
       new.content is distinct from old.content or new.subject is distinct from old.subject
       or new.email_body is distinct from old.email_body or new.recipients is distinct from old.recipients
       or new.cc is distinct from old.cc or new.send_at is distinct from old.send_at) then
    raise exception 'This report is % and can''t be edited', old.status using errcode = 'P0403';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'scheduled' and new.status in ('held', 'cancelled'))
      or (old.status = 'held'      and new.status in ('scheduled', 'cancelled'))
      or (old.status = 'failed'    and new.status in ('scheduled', 'held', 'cancelled'))
      or (old.status = 'cancelled' and new.status in ('held', 'scheduled'))
      or (old.status = 'sending'   and new.status in ('sent', 'failed'))
    ) then
      raise exception 'A report can''t go from % to %', old.status, new.status using errcode = 'P0403';
    end if;
    if new.status = 'sent' then
      new.sent_at := now();
      new.error := null;
    elsif new.status = 'failed' then
      new.error := 'Marked as not sent from the dashboard.';
    elsif new.status = 'scheduled' then
      new.error := null;
    end if;
  end if;
  return new;
end;
$$;

-- Like audit_row(), minus the big generated columns (data, original), and
-- minus content unless it changed, so status changes stay small.
create function public.audit_report()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  o jsonb;
  n jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') then o := to_jsonb(old) - 'data' - 'original'; end if;
  if tg_op in ('INSERT', 'UPDATE') then n := to_jsonb(new) - 'data' - 'original'; end if;
  if tg_op = 'INSERT' then
    n := n - 'content';
  elsif tg_op = 'UPDATE' then
    if new.content is not distinct from old.content then
      o := o - 'content';
      n := n - 'content';
    end if;
  end if;
  insert into public.audit_log (actor, actor_role, action, table_name, row_id, old_data, new_data)
  values (
    auth.uid(),
    coalesce(nullif(auth.jwt() ->> 'role', ''), session_user),
    lower(tg_op),
    tg_table_name,
    case when tg_op = 'DELETE' then old.id else new.id end,
    o,
    n
  );
  return null;
end;
$$;
revoke all on function public.audit_report() from public, anon, authenticated;

create trigger reports_guard before update or delete on public.reports for each row execute function public.guard_report();
create trigger reports_touch before update on public.reports for each row execute function public.touch_updated_at();
create trigger reports_audit after insert or update or delete on public.reports for each row execute function public.audit_report();

alter table public.reports      enable row level security;
alter table public.report_files enable row level security;
create policy reports_admin           on public.reports      for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy report_files_admin_read on public.report_files for select to authenticated using (public.is_admin());
revoke all on public.reports, public.report_files from anon, authenticated;
grant select, delete on public.reports to authenticated;
grant update (status, send_at, recipients, cc, subject, email_body, content) on public.reports to authenticated;
grant select on public.report_files to authenticated;

-- PDFs and page images as base64 (bytea would arrive as hex, twice the size).
-- Run as the caller, so the admin only rules above apply.
create function public.report_file(p_report uuid, p_kind text)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select translate(encode(f.bytes, 'base64'), E'\n', '')
  from public.report_files f
  where f.report_id = p_report and f.kind = p_kind and f.kind <> 'page';
$$;

create function public.report_pages(p_report uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('page', f.page, 'version', f.version, 'png', translate(encode(f.bytes, 'base64'), E'\n', '')) order by f.page), '[]'::jsonb)
  from public.report_files f
  where f.report_id = p_report and f.kind = 'page';
$$;
revoke all on function public.report_file(uuid, text), public.report_pages(uuid) from public, anon;
grant execute on function public.report_file(uuid, text), public.report_pages(uuid) to authenticated;

-- Live updates in the dashboard. Rows can be large, so the dashboard treats an
-- event as a signal and refetches.
alter publication supabase_realtime add table public.reports;

-- ---------------------------------------------------------------------------
-- Writer: the only way reports get in, get rendered and get sent. Lives in a
-- schema the API never exposes, callable only by the report_writer role.
-- ---------------------------------------------------------------------------
create schema reporting;
revoke all on schema reporting from public, anon, authenticated;

-- Settings, the clients that get reports, and the reports made recently.
create function reporting.context()
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
               'group', c.action1_group) order by c.company, c.contact_name)
      from public.clients c
      where c.reports_enabled and c.status <> 'former'), '[]'::jsonb),
    'existing', coalesce((
      select jsonb_agg(jsonb_build_object('client_id', r.client_id, 'period', r.period, 'period_key', r.period_key))
      from public.reports r
      where not r.is_test and r.created_at > now() - interval '45 days'), '[]'::jsonb)
  );
$$;

-- Add a draft. Recipients come from the client record. Returns null when this
-- client already has a report for the period (the run is safe to repeat).
create function reporting.insert_report(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client  public.clients;
  v_auto    boolean;
  v_test    boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_hold    boolean := coalesce((p ->> 'hold')::boolean, false);
  v_send_at timestamptz := (p ->> 'send_at')::timestamptz;
  v_id      uuid;
begin
  select * into v_client from public.clients c
   where c.id = (p ->> 'client_id')::uuid and c.reports_enabled and c.status <> 'former';
  if not found then
    raise exception 'client is not set up for reports' using errcode = 'P0002';
  end if;
  if v_send_at is null or v_send_at < now() - interval '1 hour' or v_send_at > now() + interval '8 days' then
    raise exception 'send_at is out of range' using errcode = '22023';
  end if;
  select s.auto_send_default into v_auto from public.report_settings s where s.id = 1;

  insert into public.reports (
    client_id, period, period_key, period_start, period_end, is_test, status, send_at,
    recipients, cc, subject, email_body, content, original, data, failure_count, warnings)
  values (
    v_client.id, p ->> 'period', p ->> 'period_key', (p ->> 'period_start')::date, (p ->> 'period_end')::date, v_test,
    (case when coalesce(v_auto, false) and not v_test and not v_hold then 'scheduled' else 'held' end)::public.report_status,
    v_send_at, v_client.report_recipients, v_client.report_cc, p ->> 'subject', p ->> 'email_body',
    p -> 'content',
    jsonb_build_object('content', p -> 'content', 'subject', p ->> 'subject', 'email_body', p ->> 'email_body'),
    p -> 'data',
    coalesce((p ->> 'failure_count')::integer, 0),
    case when jsonb_typeof(p -> 'warnings') = 'array' then array(select jsonb_array_elements_text(p -> 'warnings')) else '{}' end)
  on conflict (client_id, period, period_key) where not is_test do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- What a render needs.
create function reporting.for_render(p_report uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'status', r.status, 'period', r.period, 'content', r.content, 'data', r.data,
    'content_version', r.content_version, 'rendered_version', r.rendered_version)
  from public.reports r
  where r.id = p_report;
$$;

-- Store a render of content_version p_version. A render that lost a race with
-- a newer one is dropped. p_pages null keeps the current page images.
create function reporting.put_files(p_report uuid, p_version integer, p_client bytea, p_internal bytea, p_pages bytea[])
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reports;
begin
  select * into v from public.reports r where r.id = p_report for update;
  if not found or v.status = 'sent' or p_version > v.content_version or p_version < v.rendered_version then
    return false;
  end if;
  delete from public.report_files f where f.report_id = p_report and f.kind in ('client', 'internal');
  insert into public.report_files (report_id, kind, page, version, bytes) values (p_report, 'client', 0, p_version, p_client);
  if p_internal is not null then
    insert into public.report_files (report_id, kind, page, version, bytes) values (p_report, 'internal', 0, p_version, p_internal);
  end if;
  if p_pages is not null then
    delete from public.report_files f where f.report_id = p_report and f.kind = 'page';
    insert into public.report_files (report_id, kind, page, version, bytes)
    select p_report, 'page', x.n, p_version, x.b from unnest(p_pages) with ordinality as x(b, n);
  end if;
  update public.reports set rendered_version = p_version, rendered_at = now(), render_error = null where id = p_report;
  return true;
end;
$$;

create function reporting.render_failed(p_report uuid, p_version integer, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.reports set render_error = left(coalesce(p_error, 'Render failed'), 2000)
  where id = p_report and content_version = p_version;
$$;

-- Claim one report to send: scheduled -> sending, atomically, so the Monday
-- schedule and Send now can never send the same report twice. With no id,
-- the next report that is due (not more than 24 hours late, never a test).
-- With an id (Send now), that report if it is still scheduled.
create function reporting.claim(p_report uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.reports;
  v_mode text;
begin
  if p_report is null then
    select * into v from public.reports r
     where r.status = 'scheduled' and not r.is_test
       and r.send_at <= now() and r.send_at > now() - interval '24 hours'
     order by r.send_at, r.created_at
     limit 1
     for update skip locked;
  else
    select * into v from public.reports r
     where r.id = p_report and r.status = 'scheduled' and r.send_at <= now() + interval '5 minutes'
     for update;
  end if;
  if not found then
    return null;
  end if;
  update public.reports set status = 'sending', claimed_at = now(), attempts = attempts + 1, error = null where id = v.id;
  select s.mode into v_mode from public.report_settings s where s.id = 1;
  return jsonb_build_object(
    'id', v.id, 'client_id', v.client_id,
    'client_name', (select coalesce(nullif(btrim(c.company), ''), c.contact_name) from public.clients c where c.id = v.client_id),
    'period', v.period, 'period_key', v.period_key, 'period_start', v.period_start, 'is_test', v.is_test,
    'recipients', to_jsonb(v.recipients), 'cc', to_jsonb(v.cc), 'subject', v.subject, 'email_body', v.email_body,
    'content', v.content, 'data', v.data, 'content_version', v.content_version,
    'mode', case when v.is_test then 'preview' else coalesce(v_mode, 'preview') end);
end;
$$;

-- How many reports the Monday schedule would send right now.
create function reporting.due_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.reports r
  where r.status = 'scheduled' and not r.is_test
    and r.send_at <= now() and r.send_at > now() - interval '24 hours';
$$;

-- sending -> sent or failed. Page images go once a report is sent.
create function reporting.finish(p_report uuid, p_sent boolean, p_send_ref text, p_error text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.reports
     set status   = (case when p_sent then 'sent' else 'failed' end)::public.report_status,
         sent_at  = case when p_sent then now() end,
         send_ref = left(p_send_ref, 100),
         error    = case when p_sent then null else left(coalesce(p_error, 'Send failed'), 2000) end
   where id = p_report and status = 'sending';
  if not found then
    return false;
  end if;
  if p_sent then
    delete from public.report_files f where f.report_id = p_report and f.kind = 'page';
  end if;
  return true;
end;
$$;

revoke all on all functions in schema reporting from public, anon, authenticated;
alter default privileges in schema reporting revoke all on functions from public;

-- The login role used by GitHub Actions. Its password is set separately (see
-- README) so it never lives in this repository.
create role report_writer login noinherit nocreatedb nocreaterole nobypassrls connection limit 5;
grant usage on schema reporting to report_writer;
grant execute on function
  reporting.context(),
  reporting.insert_report(jsonb),
  reporting.for_render(uuid),
  reporting.put_files(uuid, integer, bytea, bytea, bytea[]),
  reporting.render_failed(uuid, integer, text),
  reporting.claim(uuid),
  reporting.due_count(),
  reporting.finish(uuid, boolean, text, text)
to report_writer;
alter role report_writer set statement_timeout = '30s';
alter role report_writer set search_path = '';

commit;
