-- Prospecting: find local businesses, run an external security audit on their
-- public web presence, and send them a branded report. The outbound security
-- analog of the quote pipeline.
--
-- Scope and the law (read this before touching the active path)
--   * A PASSIVE audit only observes what is already public: TLS and certificate
--     health, HTTP security headers, SPF/DKIM/DMARC in DNS, cookie flags, stale
--     front-end libraries disclosed in page source, and subdomains from public
--     certificate-transparency logs. It is one HTTPS request plus DNS lookups,
--     the same as loading the site, so it is safe to run on any prospect.
--   * An ACTIVE audit (port scans, probes, anything that touches a system in a
--     way a browser would not) may only run against a target that has given
--     written authorization. That is enforced here: guard_audit() refuses to
--     create an 'active' audit unless a current audit_authorizations row covers
--     the prospect's domain, and the runner has its own active_enabled switch.
--
-- Security model (the same as quote intake and patch reports)
--   * The admin (allowlisted, MFA) reads and edits through RLS. Guard triggers
--     decide which status changes and edits are allowed, so the rules hold even
--     outside the dashboard.
--   * GitHub Actions logs in as audit_runner. That role can only call the
--     functions in the `prospecting` schema, which the API never exposes. It
--     can't read or change anything else, and recipients always come from the
--     prospect record and the mode, never from the caller.
--   * PDFs live in audit_files, so no Storage policies or service key.
--   * Every change to prospects, audits and authorizations goes to audit_log,
--     without the large generated columns.

begin;

-- ---------------------------------------------------------------------------
-- Settings (one row)
-- ---------------------------------------------------------------------------
create table public.audit_settings (
  id             integer primary key default 1 check (id = 1),
  -- preview: audit emails go to henry@cyberx.la only, subject tagged with the
  -- intended recipient. live: they go to the prospect, replies to Henry.
  mode           text not null default 'preview' check (mode in ('preview', 'live')),
  -- Master switches. The runner does nothing for a kind that is off.
  passive_enabled boolean not null default true,
  active_enabled  boolean not null default false,
  sender_email   text not null default 'audits@cyberx.la'
                   check (sender_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(sender_email) <= 254),
  sender_name    text not null default 'cyberxLA Security' check (char_length(btrim(sender_name)) between 1 and 80),
  reply_to       text not null default 'henry@cyberx.la'
                   check (reply_to ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(reply_to) <= 254),
  -- Default subject and body for a new audit email. {business} and {grade} fill in.
  default_subject text not null default 'Security snapshot for {business}' check (char_length(btrim(default_subject)) between 1 and 300),
  default_body    text not null default '' check (char_length(default_body) <= 20000),
  updated_at     timestamptz not null default now()
);
insert into public.audit_settings (id) values (1);

create trigger audit_settings_touch before update on public.audit_settings for each row execute function public.touch_updated_at();
create trigger audit_settings_audit after insert or update or delete on public.audit_settings for each row execute function public.audit_row_text_id();

alter table public.audit_settings enable row level security;
create policy audit_settings_admin on public.audit_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.audit_settings from anon, authenticated;
grant select on public.audit_settings to authenticated;
grant update (mode, passive_enabled, active_enabled, sender_email, sender_name, reply_to, default_subject, default_body) on public.audit_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Prospects: a business we might audit and reach out to
-- ---------------------------------------------------------------------------
create type public.prospect_status as enum ('new', 'auditing', 'audited', 'contacted', 'responded', 'converted', 'declined');

create table public.prospects (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  business_name text not null check (char_length(btrim(business_name)) between 1 and 200),
  -- The site we audit. Normalized apex domain is kept alongside for DNS checks
  -- and de-duplication; both are set by the app/runner.
  website      text check (website is null or (char_length(website) <= 300 and website ~* '^https?://')),
  domain       text check (domain is null or (char_length(domain) between 3 and 253 and domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$')),
  contact_name text check (char_length(contact_name) <= 160),
  -- Where an audit would be sent. Null until we find one.
  email        text check (email is null or (char_length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone        text check (char_length(phone) <= 40),
  city         text check (char_length(city) <= 120),
  region       text check (char_length(region) <= 120),
  industry     text check (char_length(industry) <= 120),
  status       public.prospect_status not null default 'new',
  source       text not null default 'manual' check (source in ('manual', 'csv', 'yelp', 'google_places', 'import')),
  -- The provider's id (Yelp business id, Places id), so a re-import doesn't duplicate.
  source_ref   text check (char_length(source_ref) <= 200),
  -- Set when the prospect is turned into a sales lead.
  lead_id      uuid references public.leads (id) on delete set null,
  notes        text check (char_length(notes) <= 10000),
  archived_at  timestamptz
);
create index prospects_domain_idx on public.prospects (lower(domain));
create index prospects_status_idx on public.prospects (status, updated_at desc);
create unique index prospects_source_ref_key on public.prospects (source, source_ref) where source_ref is not null;

create trigger prospects_touch before update on public.prospects for each row execute function public.touch_updated_at();
create trigger prospects_audit after insert or update or delete on public.prospects for each row execute function public.audit_row();

alter table public.prospects enable row level security;
create policy prospects_admin on public.prospects for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.prospects to authenticated;

create table public.prospect_notes (
  id         uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.prospects (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  body       text not null check (char_length(body) between 1 and 10000)
);
create index prospect_notes_idx on public.prospect_notes (prospect_id, created_at desc);
alter table public.prospect_notes enable row level security;
create policy prospect_notes_admin on public.prospect_notes for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.prospect_notes to authenticated;
create trigger prospect_notes_audit after insert or update or delete on public.prospect_notes for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------
-- Authorizations: the gate an active audit needs. Passive needs none.
-- ---------------------------------------------------------------------------
create table public.audit_authorizations (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  prospect_id  uuid not null references public.prospects (id) on delete cascade,
  -- The exact scope authorized. An active audit is allowed only when the
  -- prospect's domain matches this (apex or a subdomain of it).
  domain       text not null check (char_length(domain) between 3 and 253 and domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  scope        text not null default 'External active testing of the web presence' check (char_length(btrim(scope)) between 1 and 1000),
  method       text not null default 'signed_doc' check (method in ('signed_doc', 'contract', 'email', 'verbal_recorded')),
  authorized_by_name  text not null check (char_length(btrim(authorized_by_name)) between 1 and 160),
  authorized_by_title text check (char_length(authorized_by_title) <= 160),
  authorized_by_email text not null check (authorized_by_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(authorized_by_email) <= 254),
  -- A reference to the paper trail (a file name, a contract id, an email subject).
  evidence     text check (char_length(evidence) <= 2000),
  signed_on    date not null,
  expires_on   date not null check (expires_on >= signed_on),
  revoked_at   timestamptz
);
create index audit_auth_prospect_idx on public.audit_authorizations (prospect_id, created_at desc);
create index audit_auth_domain_idx   on public.audit_authorizations (lower(domain));
alter table public.audit_authorizations enable row level security;
create policy audit_auth_admin on public.audit_authorizations for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.audit_authorizations to authenticated;
create trigger audit_auth_audit after insert or update or delete on public.audit_authorizations for each row execute function public.audit_row();

-- True when an active audit of p_domain is currently allowed for this prospect:
-- a live (not revoked, in-date) authorization whose domain is p_domain or a
-- parent of it. Used by the guard and by the runner.
create function public.audit_authorized(p_prospect uuid, p_domain text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.audit_authorizations a
    where a.prospect_id = p_prospect
      and a.revoked_at is null
      and current_date between a.signed_on and a.expires_on
      and p_domain is not null
      and (lower(p_domain) = lower(a.domain) or lower(p_domain) like '%.' || lower(a.domain))
  );
$$;
revoke all on function public.audit_authorized(uuid, text) from public, anon;
grant execute on function public.audit_authorized(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Audits: one scan of one prospect, its findings, and the report that goes out
-- ---------------------------------------------------------------------------
create type public.audit_kind     as enum ('passive', 'active');
create type public.audit_scan     as enum ('queued', 'running', 'done', 'failed', 'cancelled');
create type public.audit_delivery as enum ('none', 'sending', 'sent', 'failed');

create table public.audits (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  prospect_id    uuid not null references public.prospects (id) on delete cascade,
  kind           public.audit_kind not null default 'passive',
  -- A test audit never emails a prospect and always runs in preview.
  is_test        boolean not null default false,
  -- The scan itself.
  scan_status    public.audit_scan not null default 'queued',
  -- Snapshot of what is being scanned, so the record stands on its own.
  target_url     text check (target_url is null or char_length(target_url) <= 300),
  target_domain  text check (target_domain is null or char_length(target_domain) <= 253),
  -- A..F and 0..100, set when the scan finishes.
  grade          text check (grade is null or grade in ('A', 'B', 'C', 'D', 'E', 'F')),
  score          integer check (score is null or score between 0 and 100),
  summary        text check (char_length(summary) <= 600),
  -- Array of findings; shape is defined by the runner and the dashboard types.
  findings       jsonb not null default '[]' check (jsonb_typeof(findings) = 'array' and pg_column_size(findings) <= 1000000),
  -- Scan metadata (resolved host, cert, timings, scanner version).
  meta           jsonb not null default '{}' check (jsonb_typeof(meta) = 'object' and pg_column_size(meta) <= 500000),
  scanner_version text check (char_length(scanner_version) <= 40),
  started_at     timestamptz,
  finished_at    timestamptz,
  scan_error     text check (char_length(scan_error) <= 2000),
  claimed_at     timestamptz,
  attempts       integer not null default 0 check (attempts >= 0),
  -- Which authorization let an active audit run (null for passive).
  authorization_id uuid references public.audit_authorizations (id) on delete set null,
  -- The report PDFs track the findings: rendered_version catches up to content_version.
  content_version  integer not null default 1 check (content_version >= 1),
  rendered_version integer not null default 0 check (rendered_version >= 0),
  rendered_at    timestamptz,
  render_error   text check (char_length(render_error) <= 2000),
  -- The outgoing email (editable before it goes).
  delivery       public.audit_delivery not null default 'none',
  recipients     text[] not null default '{}' check (cardinality(recipients) <= 10 and public.emails_ok(recipients)),
  subject        text check (char_length(subject) <= 300),
  email_body     text check (char_length(email_body) <= 20000),
  sent_at        timestamptz,
  send_ref       text check (char_length(send_ref) <= 100),
  send_error     text check (char_length(send_error) <= 2000),
  -- Active audits must point at a live authorization (enforced by the guard).
  constraint audits_active_needs_auth check (kind = 'passive' or authorization_id is not null)
);
create index audits_prospect_idx on public.audits (prospect_id, created_at desc);
create index audits_scan_idx     on public.audits (scan_status, created_at);
create index audits_delivery_idx on public.audits (delivery, created_at);

-- PDFs (prospect-facing and internal) and PNG page images for the dashboard
-- preview. Page images are dropped once an audit is sent.
create table public.audit_files (
  audit_id   uuid not null references public.audits (id) on delete cascade,
  kind       text not null check (kind in ('client', 'internal', 'page')),
  page       integer not null default 0 check (page between 0 and 50),
  version    integer not null check (version >= 1),
  bytes      bytea not null check (octet_length(bytes) between 1 and 5000000),
  size       integer generated always as (octet_length(bytes)) stored,
  created_at timestamptz not null default now(),
  primary key (audit_id, kind, page),
  check ((kind = 'page') = (page >= 1))
);

-- What the admin may do, and the rule that active audits need authorization.
-- Status moves for the scan:
--   queued  -> running, cancelled
--   running -> done, failed, cancelled
--   failed  -> queued, cancelled
--   cancelled -> queued
-- Delivery:
--   none    -> sending        (Send now / Send me a copy)
--   sending -> sent, failed
--   failed  -> sending
-- A sent audit is kept; its email and findings don't change after it sends.
create function public.guard_audit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_admin boolean := current_user = 'authenticated';
begin
  if tg_op = 'DELETE' then
    if v_admin and old.delivery in ('sending', 'sent') and not old.is_test then
      raise exception 'A sent audit is kept for the record and can''t be deleted' using errcode = 'P0403';
    end if;
    return old;
  end if;

  -- Active audits always need a live authorization for the target. Find the
  -- one that allows it and record it, so the trail is linked and the
  -- authorization_id check is satisfied.
  if new.kind = 'active' then
    declare
      v_dom  text := coalesce(new.target_domain, (select p.domain from public.prospects p where p.id = new.prospect_id));
      v_auth uuid;
    begin
      select a.id into v_auth from public.audit_authorizations a
       where a.prospect_id = new.prospect_id and a.revoked_at is null
         and current_date between a.signed_on and a.expires_on
         and v_dom is not null
         and (lower(v_dom) = lower(a.domain) or lower(v_dom) like '%.' || lower(a.domain))
       order by a.expires_on desc limit 1;
      if v_auth is null then
        raise exception 'An active audit needs a current signed authorization for this domain' using errcode = 'P0403';
      end if;
      new.authorization_id := coalesce(new.authorization_id, v_auth);
    end;
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.findings is distinct from old.findings then
    new.content_version := old.content_version + 1;
  end if;

  if not v_admin then
    return new;
  end if;

  -- The prospect-facing email can't change once it is sending or sent.
  if old.delivery in ('sending', 'sent') and (
       new.subject is distinct from old.subject or new.email_body is distinct from old.email_body
       or new.recipients is distinct from old.recipients or new.findings is distinct from old.findings) then
    raise exception 'This audit is % and can''t be edited', old.delivery using errcode = 'P0403';
  end if;

  if new.scan_status is distinct from old.scan_status then
    if not (
         (old.scan_status = 'queued'    and new.scan_status in ('running', 'cancelled'))
      or (old.scan_status = 'running'   and new.scan_status in ('done', 'failed', 'cancelled'))
      or (old.scan_status = 'failed'    and new.scan_status in ('queued', 'cancelled'))
      or (old.scan_status = 'cancelled' and new.scan_status = 'queued')
    ) then
      raise exception 'An audit scan can''t go from % to %', old.scan_status, new.scan_status using errcode = 'P0403';
    end if;
  end if;

  if new.delivery is distinct from old.delivery then
    if not (
         (old.delivery = 'none'    and new.delivery = 'sending')
      or (old.delivery = 'sending' and new.delivery in ('sent', 'failed'))
      or (old.delivery = 'failed'  and new.delivery = 'sending')
    ) then
      raise exception 'An audit can''t go from % to %', old.delivery, new.delivery using errcode = 'P0403';
    end if;
    if new.delivery = 'sent' then
      new.sent_at := now();
      new.send_error := null;
    elsif new.delivery = 'failed' then
      new.send_error := coalesce(new.send_error, 'Marked as not sent from the dashboard.');
    end if;
  end if;
  return new;
end;
$$;

-- Like audit_row(), minus the big columns, and minus findings/meta unless they
-- changed, so status changes stay small.
create function public.audit_audits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  o jsonb;
  n jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') then o := to_jsonb(old) - 'meta'; end if;
  if tg_op in ('INSERT', 'UPDATE') then n := to_jsonb(new) - 'meta'; end if;
  if tg_op = 'INSERT' then
    n := n - 'findings';
  elsif tg_op = 'UPDATE' then
    if new.findings is not distinct from old.findings then
      o := o - 'findings';
      n := n - 'findings';
    end if;
  end if;
  insert into public.audit_log (actor, actor_role, action, table_name, row_id, old_data, new_data)
  values (
    auth.uid(),
    coalesce(nullif(auth.jwt() ->> 'role', ''), session_user),
    lower(tg_op),
    tg_table_name,
    case when tg_op = 'DELETE' then old.id else new.id end,
    o, n);
  return null;
end;
$$;
revoke all on function public.audit_audits() from public, anon, authenticated;

create trigger audits_guard before insert or update or delete on public.audits for each row execute function public.guard_audit();
create trigger audits_touch before update on public.audits for each row execute function public.touch_updated_at();
create trigger audits_audit after insert or update or delete on public.audits for each row execute function public.audit_audits();

alter table public.audits      enable row level security;
alter table public.audit_files enable row level security;
create policy audits_admin           on public.audits      for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy audit_files_admin_read on public.audit_files for select to authenticated using (public.is_admin());
revoke all on public.audits, public.audit_files from anon, authenticated;
grant select, insert, delete on public.audits to authenticated;
grant update (scan_status, delivery, recipients, subject, email_body, findings, grade, score, summary) on public.audits to authenticated;
grant select on public.audit_files to authenticated;

-- PDFs and page images as base64 (bytea would arrive as hex, twice the size).
-- Run as the caller, so the admin-only rules above apply.
create function public.audit_file(p_audit uuid, p_kind text)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select translate(encode(f.bytes, 'base64'), E'\n', '')
  from public.audit_files f
  where f.audit_id = p_audit and f.kind = p_kind and f.kind <> 'page';
$$;

create function public.audit_pages(p_audit uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('page', f.page, 'version', f.version, 'png', translate(encode(f.bytes, 'base64'), E'\n', '')) order by f.page), '[]'::jsonb)
  from public.audit_files f
  where f.audit_id = p_audit and f.kind = 'page';
$$;
revoke all on function public.audit_file(uuid, text), public.audit_pages(uuid) from public, anon;
grant execute on function public.audit_file(uuid, text), public.audit_pages(uuid) to authenticated;

-- Live updates in the dashboard. Rows can be large, so the dashboard treats an
-- event as a signal and refetches.
alter publication supabase_realtime add table public.prospects;
alter publication supabase_realtime add table public.audits;

-- ---------------------------------------------------------------------------
-- Runner: the only way audits get scanned, rendered and sent. Lives in a schema
-- the API never exposes, callable only by the audit_runner role.
-- ---------------------------------------------------------------------------
create schema prospecting;
revoke all on schema prospecting from public, anon, authenticated;

-- Settings plus the audits that are waiting to be scanned or sent.
create function prospecting.context()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'now', now(),
    'settings', (select to_jsonb(s) - 'id' - 'updated_at' from public.audit_settings s where s.id = 1),
    'queued_scans', coalesce((
      select jsonb_agg(a.id order by a.created_at)
      from public.audits a where a.scan_status = 'queued'), '[]'::jsonb),
    'queued_sends', coalesce((
      select jsonb_agg(a.id order by a.created_at)
      from public.audits a
      where a.delivery = 'none' and a.scan_status = 'done' and not a.is_test
        and cardinality(a.recipients) > 0), '[]'::jsonb)
  );
$$;

-- Claim one audit to scan: queued -> running, atomically. With no id, the next
-- queued audit. With an id, that audit if it is still queued. Returns the
-- target and, for an active audit, whether it is still authorized right now.
create function prospecting.claim_scan(p_audit uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.audits;
  p public.prospects;
  s public.audit_settings;
begin
  if p_audit is null then
    select * into a from public.audits x
     where x.scan_status = 'queued'
     order by x.created_at
     limit 1 for update skip locked;
  else
    select * into a from public.audits x where x.id = p_audit and x.scan_status = 'queued' for update;
  end if;
  if not found then
    return null;
  end if;
  select * into p from public.prospects where id = a.prospect_id;
  select * into s from public.audit_settings where id = 1;

  -- Respect the master switches and the active-audit authorization gate.
  if (a.kind = 'passive' and not s.passive_enabled)
     or (a.kind = 'active' and not s.active_enabled)
     or (a.kind = 'active' and not public.audit_authorized(a.prospect_id, coalesce(a.target_domain, p.domain))) then
    update public.audits set scan_status = 'failed', scan_error =
      case when a.kind = 'active' and not public.audit_authorized(a.prospect_id, coalesce(a.target_domain, p.domain))
           then 'No current authorization for an active audit of this domain.'
           else 'This kind of audit is turned off.' end,
      finished_at = now()
    where id = a.id;
    return null;
  end if;

  update public.audits
     set scan_status = 'running', claimed_at = now(), started_at = now(),
         attempts = attempts + 1, scan_error = null,
         target_url = coalesce(a.target_url, p.website),
         target_domain = coalesce(a.target_domain, p.domain)
   where id = a.id;
  update public.prospects set status = 'auditing' where id = p.id and status in ('new', 'audited', 'declined');

  return jsonb_build_object(
    'id', a.id, 'prospect_id', p.id, 'kind', a.kind, 'is_test', a.is_test,
    'business_name', p.business_name,
    'target_url', coalesce(a.target_url, p.website),
    'target_domain', coalesce(a.target_domain, p.domain));
end;
$$;

-- Store the result of a scan: running -> done, with findings, grade and score.
-- A findings change bumps content_version so the PDFs re-render.
create function prospecting.put_findings(p_audit uuid, p_grade text, p_score integer, p_summary text, p_findings jsonb, p_meta jsonb, p_version text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.audits;
  v_subject text;
  v_business text;
begin
  select * into v from public.audits where id = p_audit for update;
  if not found or v.scan_status <> 'running' then
    return false;
  end if;
  select p.business_name into v_business from public.prospects p where p.id = v.prospect_id;
  select replace(replace(s.default_subject, '{business}', coalesce(v_business, 'your business')), '{grade}', coalesce(p_grade, ''))
    into v_subject from public.audit_settings s where s.id = 1;

  update public.audits
     set scan_status = 'done', finished_at = now(), scan_error = null,
         grade = p_grade, score = p_score, summary = left(p_summary, 600),
         findings = coalesce(p_findings, '[]'::jsonb), meta = coalesce(p_meta, '{}'::jsonb),
         scanner_version = left(p_version, 40),
         -- Seed the email the first time only; later scans keep any edits.
         subject = coalesce(v.subject, v_subject),
         email_body = coalesce(v.email_body, (select default_body from public.audit_settings where id = 1))
   where id = p_audit;
  update public.prospects set status = 'audited'
   where id = v.prospect_id and status in ('new', 'auditing');
  return true;
end;
$$;

create function prospecting.scan_failed(p_audit uuid, p_error text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.audits set scan_status = 'failed', finished_at = now(), scan_error = left(coalesce(p_error, 'Scan failed'), 2000)
   where id = p_audit and scan_status = 'running';
  return found;
end;
$$;

-- What a render needs, and where to store it (mirrors the reports pipeline).
create function prospecting.for_render(p_audit uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id, 'kind', a.kind, 'grade', a.grade, 'score', a.score, 'summary', a.summary,
    'findings', a.findings, 'meta', a.meta,
    'business_name', p.business_name, 'target_url', a.target_url, 'target_domain', a.target_domain,
    'content_version', a.content_version, 'rendered_version', a.rendered_version)
  from public.audits a join public.prospects p on p.id = a.prospect_id
  where a.id = p_audit;
$$;

create function prospecting.put_files(p_audit uuid, p_version integer, p_client bytea, p_internal bytea, p_pages bytea[])
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.audits;
begin
  select * into v from public.audits a where a.id = p_audit for update;
  if not found or v.delivery = 'sent' or p_version > v.content_version or p_version < v.rendered_version then
    return false;
  end if;
  delete from public.audit_files f where f.audit_id = p_audit and f.kind in ('client', 'internal');
  insert into public.audit_files (audit_id, kind, page, version, bytes) values (p_audit, 'client', 0, p_version, p_client);
  if p_internal is not null then
    insert into public.audit_files (audit_id, kind, page, version, bytes) values (p_audit, 'internal', 0, p_version, p_internal);
  end if;
  if p_pages is not null then
    delete from public.audit_files f where f.audit_id = p_audit and f.kind = 'page';
    insert into public.audit_files (audit_id, kind, page, version, bytes)
    select p_audit, 'page', x.n, p_version, x.b from unnest(p_pages) with ordinality as x(b, n);
  end if;
  update public.audits set rendered_version = p_version, rendered_at = now(), render_error = null where id = p_audit;
  return true;
end;
$$;

create function prospecting.render_failed(p_audit uuid, p_version integer, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.audits set render_error = left(coalesce(p_error, 'Render failed'), 2000)
  where id = p_audit and content_version = p_version;
$$;

-- Claim one audit to send: none -> sending, atomically, so a schedule and Send
-- now can never send the same audit twice. Recipients and mode come from the
-- record and the settings, never from the caller. In preview (or a test), the
-- email goes to Henry only.
create function prospecting.claim_send(p_audit uuid, p_copy boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.audits;
  p public.prospects;
  s public.audit_settings;
  v_mode text;
  v_to text[];
begin
  select * into s from public.audit_settings where id = 1;
  -- A copy goes to Henry only and changes nothing about the audit.
  if p_copy then
    select * into a from public.audits where id = p_audit;
    if not found or a.scan_status <> 'done' then return null; end if;
    select * into p from public.prospects where id = a.prospect_id;
    return jsonb_build_object('id', a.id, 'copy', true, 'mode', 'preview',
      'business_name', p.business_name, 'target_url', a.target_url, 'grade', a.grade, 'score', a.score,
      'summary', a.summary, 'findings', a.findings, 'subject', a.subject, 'email_body', a.email_body,
      'recipients', to_jsonb(array['henry@cyberx.la']),
      'sender_email', s.sender_email, 'sender_name', s.sender_name, 'reply_to', s.reply_to);
  end if;

  select * into a from public.audits where id = p_audit and delivery = 'none' and scan_status = 'done' for update;
  if not found then return null; end if;
  select * into p from public.prospects where id = a.prospect_id;

  v_mode := case when a.is_test then 'preview' else coalesce(s.mode, 'preview') end;
  v_to   := case when v_mode = 'live' then a.recipients else array['henry@cyberx.la'] end;
  if cardinality(v_to) = 0 then return null; end if;

  update public.audits set delivery = 'sending', claimed_at = now(), attempts = attempts + 1, send_error = null where id = a.id;
  update public.prospects set status = 'contacted' where id = p.id and v_mode = 'live' and status in ('new', 'audited', 'auditing');

  return jsonb_build_object('id', a.id, 'copy', false, 'mode', v_mode, 'is_test', a.is_test,
    'business_name', p.business_name, 'target_url', a.target_url, 'grade', a.grade, 'score', a.score,
    'summary', a.summary, 'findings', a.findings, 'subject', a.subject, 'email_body', a.email_body,
    'recipients', to_jsonb(v_to), 'intended', to_jsonb(a.recipients),
    'sender_email', s.sender_email, 'sender_name', s.sender_name, 'reply_to', s.reply_to);
end;
$$;

create function prospecting.finish_send(p_audit uuid, p_sent boolean, p_send_ref text, p_error text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.audits
     set delivery  = (case when p_sent then 'sent' else 'failed' end)::public.audit_delivery,
         sent_at   = case when p_sent then now() end,
         send_ref  = left(p_send_ref, 100),
         send_error = case when p_sent then null else left(coalesce(p_error, 'Send failed'), 2000) end
   where id = p_audit and delivery = 'sending';
  if not found then return false; end if;
  if p_sent then
    delete from public.audit_files f where f.audit_id = p_audit and f.kind = 'page';
  end if;
  return true;
end;
$$;

-- Insert prospects found by discovery (Yelp, Google Places). De-duplicates on
-- (source, source_ref) and returns how many were newly added.
create function prospecting.add_prospects(p jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
  item jsonb;
begin
  for item in select * from jsonb_array_elements(coalesce(p, '[]'::jsonb)) loop
    insert into public.prospects (business_name, website, domain, phone, city, region, industry, source, source_ref)
    values (
      left(btrim(item ->> 'business_name'), 200),
      nullif(btrim(item ->> 'website'), ''),
      nullif(lower(btrim(item ->> 'domain')), ''),
      nullif(btrim(item ->> 'phone'), ''),
      nullif(btrim(item ->> 'city'), ''),
      nullif(btrim(item ->> 'region'), ''),
      nullif(btrim(item ->> 'industry'), ''),
      coalesce(nullif(item ->> 'source', ''), 'import'),
      nullif(btrim(item ->> 'source_ref'), ''))
    on conflict (source, source_ref) where source_ref is not null do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

revoke all on all functions in schema prospecting from public, anon, authenticated;
alter default privileges in schema prospecting revoke all on functions from public;

-- The login role used by GitHub Actions. Its password is set separately (see
-- README) so it never lives in this repository.
create role audit_runner login noinherit nocreatedb nocreaterole nobypassrls connection limit 5;
grant usage on schema prospecting to audit_runner;
grant execute on function
  prospecting.context(),
  prospecting.claim_scan(uuid),
  prospecting.put_findings(uuid, text, integer, text, jsonb, jsonb, text),
  prospecting.scan_failed(uuid, text),
  prospecting.for_render(uuid),
  prospecting.put_files(uuid, integer, bytea, bytea, bytea[]),
  prospecting.render_failed(uuid, integer, text),
  prospecting.claim_send(uuid, boolean),
  prospecting.finish_send(uuid, boolean, text, text),
  prospecting.add_prospects(jsonb)
to audit_runner;
alter role audit_runner set statement_timeout = '30s';
alter role audit_runner set search_path = '';

commit;
