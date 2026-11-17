-- Outgoing quotes ("Quotes" in the dashboard; "proposals" in the database, so
-- they never get mixed up with public.quotes, the quote requests that come in
-- from the website's Build Your Quote page).
--
-- What's here
--   * proposals: one row per quote (Q1001, Q1002, ...), the working draft, and
--     its link token. proposal_versions: what each sent version said, exactly,
--     and never changed after. The client always sees the latest sent version.
--   * proposal_events: the quote's timeline (sent, viewed, accepted, ...), and
--     the queue of emails to send Henry (notify, notified_at).
--   * proposal_acceptances: an immutable record of exactly what the client saw
--     and accepted, and who signed.
--   * proposal_templates, quote_settings, and payments (Stripe, off until it's
--     connected).
--
-- Security model (the same as the rest of the admin)
--   * Every table is admin only: allowlisted and MFA (public.is_admin()), by RLS.
--   * The admin edits drafts directly; everything that changes a quote's status
--     goes through the functions below, which check is_admin() themselves.
--   * The public page reads one quote with public.proposal_view(token), granted
--     to anon. It returns only what the page shows, only for sent quotes, and
--     records the view. Nothing else is reachable with the public key.
--   * Accepting, requesting changes and paying go through the quote-public Edge
--     Function, which logs in as quote_intake (like submit-quote) and can only
--     call the functions in the proposal_api schema, which the API never exposes.
--   * Every change goes to audit_log.

begin;

-- ---------------------------------------------------------------------------
-- Checking a quote document (the shape is in supabase/functions/_shared/proposal.ts)
-- ---------------------------------------------------------------------------
create function public.pdoc_text(v jsonb, max integer, required boolean)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when v is null or v = 'null'::jsonb then not required
    when jsonb_typeof(v) <> 'string' then false
    else char_length(v #>> '{}') <= max and (not required or btrim(v #>> '{}') <> '')
  end;
$$;

create function public.pdoc_money(v jsonb, max numeric)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric between 0 and max
     and (v #>> '{}')::numeric = round((v #>> '{}')::numeric, 2);
$$;

create function public.pdoc_disc(v jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when v is null or v = 'null'::jsonb then true
    when jsonb_typeof(v) <> 'object' then false
    else not exists (select 1 from jsonb_object_keys(v) k where k not in ('kind', 'value'))
     and ((v ->> 'kind' = 'percent' and public.pdoc_money(v -> 'value', 100))
       or (v ->> 'kind' = 'amount' and public.pdoc_money(v -> 'value', 10000000)))
  end;
$$;

create function public.pdoc_key(v jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^[a-z0-9]{1,24}$';
$$;

create function public.pdoc_only(v jsonb, allowed text[])
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(v) = 'object' and not exists (select 1 from jsonb_object_keys(v) k where k <> all (allowed));
$$;

-- Known fields only (so nothing internal can hide in what the client is
-- sent), every limit, every key unique, every reference to a real tier.
create function public.proposal_doc_ok(d jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  t jsonb; r jsonb; a jsonb; f jsonb; x jsonb; k text;
  tiers text[] := '{}'; rows text[] := '{}'; adds text[] := '{}'; notes text[] := '{}';
begin
  if not public.pdoc_only(d, array['v','intro','tiers','recommended','default_tier','rows','addons','discount','payment','fine_print','terms'])
     or pg_column_size(d) > 400000 or d -> 'v' is distinct from '1'::jsonb
     or not public.pdoc_text(d -> 'intro', 1500, false)
     or jsonb_typeof(d -> 'tiers') is distinct from 'array' or jsonb_array_length(d -> 'tiers') not between 1 and 6
     or jsonb_typeof(d -> 'rows') is distinct from 'array' or jsonb_array_length(d -> 'rows') > 80
     or jsonb_typeof(d -> 'addons') is distinct from 'array' or jsonb_array_length(d -> 'addons') > 30
     or jsonb_typeof(d -> 'fine_print') is distinct from 'array' or jsonb_array_length(d -> 'fine_print') > 12
     or jsonb_typeof(d -> 'terms') is distinct from 'boolean' then
    return false;
  end if;

  for t in select * from jsonb_array_elements(d -> 'tiers') loop
    if not public.pdoc_only(t, array['key','name','price','discount','monthly','monthly_discount','summary'])
       or not public.pdoc_key(t -> 'key') or (t ->> 'key') = any (tiers)
       or not public.pdoc_text(t -> 'name', 60, true) or not public.pdoc_money(t -> 'price', 10000000)
       or not public.pdoc_disc(t -> 'discount') or not public.pdoc_disc(t -> 'monthly_discount')
       or not (t -> 'monthly' is null or t -> 'monthly' = 'null'::jsonb or public.pdoc_money(t -> 'monthly', 1000000))
       or not public.pdoc_text(t -> 'summary', 240, false) then
      return false;
    end if;
    tiers := tiers || (t ->> 'key');
  end loop;

  for r in select * from jsonb_array_elements(d -> 'rows') loop
    if not public.pdoc_only(r, array['key','label','explain','values'])
       or not public.pdoc_key(r -> 'key') or (r ->> 'key') = any (rows)
       or not public.pdoc_text(r -> 'label', 120, true) or not public.pdoc_text(r -> 'explain', 1200, false)
       or jsonb_typeof(r -> 'values') is distinct from 'object' then
      return false;
    end if;
    for k, x in select * from jsonb_each(r -> 'values') loop
      if k <> all (tiers) or not (jsonb_typeof(x) = 'boolean' or public.pdoc_text(x, 60, true)) then
        return false;
      end if;
    end loop;
    rows := rows || (r ->> 'key');
  end loop;

  for a in select * from jsonb_array_elements(d -> 'addons') loop
    if not public.pdoc_only(a, array['key','name','description','price','billing','discount','tiers'])
       or not public.pdoc_key(a -> 'key') or (a ->> 'key') = any (adds)
       or not public.pdoc_text(a -> 'name', 120, true) or not public.pdoc_text(a -> 'description', 500, false)
       or not public.pdoc_money(a -> 'price', 1000000) or coalesce(a ->> 'billing', '') not in ('once', 'monthly')
       or not public.pdoc_disc(a -> 'discount') or jsonb_typeof(a -> 'tiers') is distinct from 'object' then
      return false;
    end if;
    for k, x in select * from jsonb_each(a -> 'tiers') loop
      if k <> all (tiers) or x not in ('"available"'::jsonb, '"included"'::jsonb, '"unavailable"'::jsonb) then
        return false;
      end if;
    end loop;
    adds := adds || (a ->> 'key');
  end loop;

  for f in select * from jsonb_array_elements(d -> 'fine_print') loop
    if not public.pdoc_only(f, array['key','text','tiers','addon'])
       or not public.pdoc_key(f -> 'key') or (f ->> 'key') = any (notes)
       or not public.pdoc_text(f -> 'text', 400, true)
       or jsonb_typeof(f -> 'tiers') is distinct from 'array'
       or exists (select 1 from jsonb_array_elements(f -> 'tiers') y where jsonb_typeof(y) <> 'string' or (y #>> '{}') <> all (tiers))
       or not (f -> 'addon' is null or f -> 'addon' = 'null'::jsonb or (f ->> 'addon') = any (adds)) then
      return false;
    end if;
    notes := notes || (f ->> 'key');
  end loop;

  if not (d -> 'recommended' is null or d -> 'recommended' = 'null'::jsonb or (d ->> 'recommended') = any (tiers))
     or not ((d ->> 'default_tier') = any (tiers)) then
    return false;
  end if;

  x := d -> 'discount';
  if not (x is null or x = 'null'::jsonb or (
       public.pdoc_only(x, array['kind','value','label','applies_to'])
       and public.pdoc_disc(x - 'label' - 'applies_to') and x ? 'kind'
       and public.pdoc_text(x -> 'label', 60, false) and coalesce(x ->> 'applies_to', '') in ('once', 'monthly'))) then
    return false;
  end if;

  x := d -> 'payment';
  if not public.pdoc_only(x, array['mode','deposit_kind','deposit_value'])
     or coalesce(x ->> 'mode', '') not in ('none', 'deposit', 'full')
     or coalesce(x ->> 'deposit_kind', '') not in ('percent', 'amount')
     or not public.pdoc_money(x -> 'deposit_value', case when x ->> 'deposit_kind' = 'percent' then 100 else 10000000 end) then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.pdoc_text(jsonb, integer, boolean), public.pdoc_money(jsonb, numeric), public.pdoc_disc(jsonb),
  public.pdoc_key(jsonb), public.pdoc_only(jsonb, text[]), public.proposal_doc_ok(jsonb) from public, anon;
grant execute on function public.pdoc_text(jsonb, integer, boolean), public.pdoc_money(jsonb, numeric), public.pdoc_disc(jsonb),
  public.pdoc_key(jsonb), public.pdoc_only(jsonb, text[]), public.proposal_doc_ok(jsonb) to authenticated;

-- Internal costs and catalog links: never shown to the client.
create function public.proposal_internal_ok(d jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select public.pdoc_only(d, array['costs', 'links']) and pg_column_size(d) <= 100000
     and (d -> 'costs' is null or (jsonb_typeof(d -> 'costs') = 'object'
          and not exists (select 1 from jsonb_each(d -> 'costs') c where char_length(c.key) > 40 or not public.pdoc_money(c.value, 10000000))))
     and (d -> 'links' is null or (jsonb_typeof(d -> 'links') = 'object'
          and not exists (select 1 from jsonb_each(d -> 'links') l where char_length(l.key) > 40 or jsonb_typeof(l.value) <> 'string' or char_length(l.value #>> '{}') > 40)));
$$;
revoke all on function public.proposal_internal_ok(jsonb) from public, anon;
grant execute on function public.proposal_internal_ok(jsonb) to authenticated;

create function public.la_today()
returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Los_Angeles')::date;
$$;
revoke all on function public.la_today() from public, anon;
grant execute on function public.la_today() to authenticated;

-- ---------------------------------------------------------------------------
-- Settings (one row)
-- ---------------------------------------------------------------------------
create table public.quote_settings (
  id                   integer primary key default 1 check (id = 1),
  notify_email         text not null default 'henry@cyberx.la' check (public.emails_ok(array[notify_email])),
  reply_to             text not null default 'henry@cyberx.la' check (public.emails_ok(array[reply_to])),
  from_name            text not null default 'Henry at cyberxLA' check (char_length(btrim(from_name)) between 1 and 60 and from_name !~ '[<>"\r\n]'),
  default_valid_days   integer not null default 30 check (default_valid_days between 1 and 365),
  remind_unviewed_days integer not null default 3 check (remind_unviewed_days between 1 and 30),
  remind_expiry_days   integer not null default 2 check (remind_expiry_days between 1 and 30),
  -- Kept in step by the Edge Functions from the Stripe secrets: 'off' until they exist.
  stripe_mode          text not null default 'off' check (stripe_mode in ('off', 'test', 'live')),
  stripe_checked_at    timestamptz,
  cron_seen_at         timestamptz,
  updated_at           timestamptz not null default now()
);
insert into public.quote_settings (id) values (1);
create trigger quote_settings_touch before update on public.quote_settings for each row execute function public.touch_updated_at();
create trigger quote_settings_audit after insert or update or delete on public.quote_settings for each row execute function public.audit_row_text_id();
alter table public.quote_settings enable row level security;
create policy quote_settings_admin on public.quote_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.quote_settings from anon, authenticated;
grant select on public.quote_settings to authenticated;
grant update (notify_email, reply_to, from_name, default_valid_days, remind_unviewed_days, remind_expiry_days) on public.quote_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------
create type public.proposal_status as enum ('draft', 'scheduled', 'sent', 'viewed', 'changes_requested', 'accepted', 'declined', 'expired', 'revoked');

-- Q1001, Q1002, ... A number is taken when a quote is created and never reused.
create sequence public.proposal_number_seq start with 1001 minvalue 1001 no cycle;

-- 24 random bytes, URL safe: 192 bits, so a link can't be guessed.
create function public.new_proposal_token()
returns text language sql volatile security definer set search_path = '' as $$
  select translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
$$;
revoke all on function public.new_proposal_token() from public, anon;
grant execute on function public.new_proposal_token() to authenticated;

create table public.proposals (
  id              uuid primary key default gen_random_uuid(),
  number          integer not null unique default nextval('public.proposal_number_seq'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A lead's or a client's, never both (like projects). A lead's quotes move to
  -- its client when the lead is converted.
  lead_id         uuid references public.leads (id) on delete cascade,
  client_id       uuid references public.clients (id) on delete cascade,
  title           text not null check (char_length(btrim(title)) between 1 and 120 and title !~ '[\r\n]'),
  status          public.proposal_status not null default 'draft',
  recipient_name  text not null default '' check (char_length(recipient_name) <= 120 and recipient_name !~ '[<>"\r\n]'),
  recipient_email text check (recipient_email is null or public.emails_ok(array[recipient_email])),
  cc              text[] not null default '{}' check (cardinality(cc) <= 5 and public.emails_ok(cc)),
  prepared_on     date not null default public.la_today(),
  valid_until     date not null default public.la_today() + 30,
  -- The working draft. What the client sees is the latest proposal_versions row.
  content         jsonb not null check (public.proposal_doc_ok(content)),
  internal        jsonb not null default '{}' check (public.proposal_internal_ok(internal)),
  internal_notes  text check (char_length(internal_notes) <= 5000),
  token           text not null unique default public.new_proposal_token() check (token ~ '^[A-Za-z0-9_-]{32,64}$'),
  token_created_at timestamptz not null default now(),
  -- The latest version sent (0: never sent).
  version         integer not null default 0 check (version >= 0),
  -- A sent quote being changed; the client still sees the latest sent version.
  revising        boolean not null default false,
  -- Send later.
  scheduled_at    timestamptz,
  send_subject    text check (char_length(send_subject) <= 200 and send_subject !~ '[\r\n]'),
  send_note       text check (char_length(send_note) <= 2000),
  reminders       boolean not null default false,
  sent_at         timestamptz,
  last_sent_at    timestamptz,
  first_viewed_at timestamptz,
  last_viewed_at  timestamptz,
  view_count      integer not null default 0 check (view_count >= 0),
  reminded_unviewed_at timestamptz,
  reminded_expiry_at   timestamptz,
  changes_requested_at timestamptz,
  accepted_at     timestamptz,
  accepted_version integer,
  accepted_once   numeric(12,2),
  accepted_monthly numeric(12,2),
  revoked_from    public.proposal_status,
  archived_at     timestamptz,
  check ((lead_id is null) <> (client_id is null))
);
create index proposals_lead_idx   on public.proposals (lead_id);
create index proposals_client_idx on public.proposals (client_id);
create index proposals_status_idx on public.proposals (status, updated_at desc);
create index proposals_due_idx    on public.proposals (scheduled_at) where scheduled_at is not null;

-- Exactly what each version said. Written once when it's sent, never changed.
create table public.proposal_versions (
  id          uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals (id) on delete cascade,
  version     integer not null check (version >= 1),
  sent_at     timestamptz not null default now(),
  -- number, title, prepared_for, prepared_on, valid_until: as sent.
  header      jsonb not null check (jsonb_typeof(header) = 'object'),
  -- The document with placeholders filled in: what the client sees.
  content     jsonb not null check (public.proposal_doc_ok(content)),
  -- The draft it came from (placeholders kept), for Discard revision.
  source_title text not null,
  source      jsonb not null check (public.proposal_doc_ok(source)),
  unique (proposal_id, version)
);

create table public.proposal_events (
  id          bigint generated always as identity primary key,
  proposal_id uuid not null references public.proposals (id) on delete cascade,
  at          timestamptz not null default now(),
  kind        text not null check (kind in (
                'created', 'edited', 'sent', 'resent', 'scheduled', 'unscheduled', 'test_sent', 'viewed', 'reminder',
                'changes_requested', 'accepted', 'declined', 'reopened', 'expired', 'revoked', 'link_regenerated',
                'revision_started', 'revision_discarded', 'converted', 'payment', 'payment_failed', 'email_failed', 'duplicated', 'extended')),
  detail      jsonb not null default '{}' check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 8000),
  -- An email to send Henry about this event, and when it went.
  notify      text check (notify in ('first_view', 'changes', 'accepted', 'payment')),
  notified_at timestamptz
);
create index proposal_events_idx    on public.proposal_events (proposal_id, at desc);
create index proposal_events_at_idx on public.proposal_events (at desc);
create index proposal_events_notify_idx on public.proposal_events (id) where notify is not null and notified_at is null;

-- What the client saw and accepted, frozen.
create table public.proposal_acceptances (
  id           uuid primary key default gen_random_uuid(),
  proposal_id  uuid not null references public.proposals (id) on delete cascade,
  version      integer not null,
  accepted_at  timestamptz not null default now(),
  header       jsonb not null,
  -- The version's document as the client saw it, explanations included.
  doc          jsonb not null,
  tier         text not null,
  addons       text[] not null default '{}',
  -- Every line and total, in cents, as computed by _shared/proposal.ts totals().
  lines        jsonb not null check (jsonb_typeof(lines) = 'array'),
  totals       jsonb not null check (jsonb_typeof(totals) = 'object'),
  once_total   numeric(12,2) not null check (once_total >= 0),
  monthly_total numeric(12,2) not null check (monthly_total >= 0),
  due_now      numeric(12,2) not null default 0 check (due_now >= 0),
  signer_name  text not null check (char_length(btrim(signer_name)) between 1 and 120),
  signer_title text not null default '' check (char_length(signer_title) <= 120),
  signer_email text not null check (public.emails_ok(array[signer_email])),
  signature    text not null check (char_length(btrim(signature)) between 1 and 120),
  agreed_terms boolean not null check (agreed_terms),
  ip_hash      text not null check (char_length(ip_hash) = 64),
  user_agent   text not null default '' check (char_length(user_agent) <= 400)
);
create index proposal_acceptances_idx on public.proposal_acceptances (proposal_id, accepted_at desc);

create table public.proposal_templates (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name       text not null unique check (char_length(btrim(name)) between 1 and 80),
  title      text not null check (char_length(btrim(title)) between 1 and 120),
  content    jsonb not null check (public.proposal_doc_ok(content)),
  internal   jsonb not null default '{}' check (public.proposal_internal_ok(internal))
);

-- Stripe payments (deposits and full payments). Written only by the Edge
-- Functions, through the functions below.
create table public.payments (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  proposal_id           uuid references public.proposals (id) on delete set null,
  acceptance_id         uuid references public.proposal_acceptances (id) on delete set null,
  project_id            uuid references public.projects (id) on delete set null,
  kind                  text not null check (kind in ('deposit', 'full', 'balance', 'test')),
  amount                numeric(12,2) not null check (amount > 0),
  currency              text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  status                text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'expired', 'refunded')),
  livemode              boolean not null default false,
  stripe_session_id     text unique check (char_length(stripe_session_id) <= 255),
  stripe_payment_intent text check (char_length(stripe_payment_intent) <= 255),
  paid_at               timestamptz,
  email                 text check (char_length(email) <= 254)
);
create index payments_proposal_idx on public.payments (proposal_id);
create index payments_paid_idx on public.payments (paid_at desc) where status = 'paid';

-- A project made from a quote points back to it.
alter table public.projects add column proposal_id uuid references public.proposals (id) on delete set null;
create unique index projects_proposal_key on public.projects (proposal_id) where proposal_id is not null;

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
create trigger proposals_touch before update on public.proposals for each row execute function public.touch_updated_at();
create trigger proposal_templates_touch before update on public.proposal_templates for each row execute function public.touch_updated_at();
create trigger payments_touch before update on public.payments for each row execute function public.touch_updated_at();

-- What the dashboard may change directly. Everything else (sending,
-- accepting, revoking, ...) goes through the functions below.
create function public.guard_proposal()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_admin boolean := current_user = 'authenticated';
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.payments p where p.proposal_id = old.id and p.status = 'paid') then
      raise exception 'Q% has a payment on record, so it''s kept. Archive it instead.', old.number using errcode = 'P0403';
    end if;
    if v_admin and old.version > 0 and old.archived_at is null then
      raise exception 'Q% was sent, so it''s kept for the record. Archive it first, then delete it.', old.number using errcode = 'P0403';
    end if;
    return old;
  end if;
  if not v_admin then
    return new;
  end if;
  if (new.content is distinct from old.content or new.title is distinct from old.title or new.prepared_on is distinct from old.prepared_on)
     and not (old.status in ('draft', 'scheduled') or old.revising) then
    if old.status = 'accepted' then
      raise exception 'Q% was accepted, so it''s locked. Use Revise to make a new version for the client to accept.', old.number using errcode = 'P0403';
    end if;
    raise exception 'Q% was sent. Use Revise to change it; the client keeps seeing the sent version until you send the revision.', old.number using errcode = 'P0403';
  end if;
  if new.valid_until is distinct from old.valid_until and old.status = 'accepted' and not old.revising then
    raise exception 'Q% was accepted, so its dates are locked.', old.number using errcode = 'P0403';
  end if;
  -- A later date brings an expired quote back.
  if new.valid_until is distinct from old.valid_until and old.status = 'expired' and new.valid_until >= public.la_today() then
    new.status := case when old.first_viewed_at is null then 'sent' else 'viewed' end;
  end if;
  -- Converting a lead moves its quotes to the new client (convert_lead_to_client).
  if new.lead_id is null and old.lead_id is not null and new.client_id is not null
     and exists (select 1 from public.clients c where c.id = new.client_id and c.lead_id = old.lead_id) then
    return new;
  end if;
  if (new.lead_id is distinct from old.lead_id or new.client_id is distinct from old.client_id) and old.version > 0 then
    raise exception 'Q% was sent to this client, so it can''t move to another. Duplicate it instead.', old.number using errcode = 'P0403';
  end if;
  return new;
end;
$$;
create trigger proposals_guard before update or delete on public.proposals for each row execute function public.guard_proposal();

-- Versions, acceptances and events are a record: never edited, and only
-- deleted along with their quote.
create function public.guard_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'This is part of a quote''s record and can''t be changed' using errcode = 'P0403';
end;
$$;
create trigger proposal_versions_guard    before update or delete on public.proposal_versions    for each row execute function public.guard_record();
create trigger proposal_acceptances_guard before update or delete on public.proposal_acceptances for each row execute function public.guard_record();

-- The timeline: "created" when a quote is made, and one "edited" per editing
-- session (edits within 30 minutes of the last one join it).
create function public.proposal_timeline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last bigint;
begin
  if tg_op = 'INSERT' then
    insert into public.proposal_events (proposal_id, kind, detail) values (new.id, 'created', jsonb_build_object('number', 'Q' || new.number));
  elsif new.content is distinct from old.content or new.title is distinct from old.title or new.prepared_on is distinct from old.prepared_on then
    select e.id into v_last from public.proposal_events e
     where e.proposal_id = new.id order by e.at desc, e.id desc limit 1;
    if exists (select 1 from public.proposal_events e where e.id = v_last and e.kind = 'edited' and e.at > now() - interval '30 minutes') then
      update public.proposal_events set at = now() where id = v_last;
    else
      insert into public.proposal_events (proposal_id, kind, detail) values (new.id, 'edited', jsonb_build_object('revising', new.revising));
    end if;
  elsif new.valid_until is distinct from old.valid_until and old.version > 0 then
    insert into public.proposal_events (proposal_id, kind, detail) values (new.id, 'extended', jsonb_build_object('from', old.valid_until, 'to', new.valid_until));
  end if;
  return null;
end;
$$;
revoke all on function public.proposal_timeline() from public, anon, authenticated;
create trigger proposals_timeline after insert or update on public.proposals for each row execute function public.proposal_timeline();

-- The timeline's own entries in the audit log, filed under their quote.
create function public.audit_proposal_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (actor, actor_role, action, table_name, row_id, old_data, new_data)
  values (auth.uid(), coalesce(nullif(auth.jwt() ->> 'role', ''), session_user), lower(tg_op), tg_table_name,
          coalesce(new.proposal_id, old.proposal_id),
          case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return null;
end;
$$;
revoke all on function public.audit_proposal_event() from public, anon, authenticated;

-- Audit: the big documents and the link token stay out of the log (the
-- versions table keeps every sent document anyway).
create trigger proposals_audit after insert or update or delete on public.proposals
  for each row execute function public.audit_row_redacted('content', 'internal', 'token');
create trigger proposal_versions_audit after insert or update or delete on public.proposal_versions
  for each row execute function public.audit_row_redacted('content', 'source');
create trigger proposal_acceptances_audit after insert or update or delete on public.proposal_acceptances
  for each row execute function public.audit_row_redacted('doc');
create trigger proposal_templates_audit after insert or update or delete on public.proposal_templates
  for each row execute function public.audit_row_redacted('content', 'internal');
create trigger payments_audit after insert or update or delete on public.payments
  for each row execute function public.audit_row();
create trigger proposal_events_audit after insert or update or delete on public.proposal_events
  for each row execute function public.audit_proposal_event();

-- RLS: admin (with MFA) only, like every other table.
alter table public.proposals            enable row level security;
alter table public.proposal_versions    enable row level security;
alter table public.proposal_events      enable row level security;
alter table public.proposal_acceptances enable row level security;
alter table public.proposal_templates   enable row level security;
alter table public.payments             enable row level security;
create policy proposals_admin            on public.proposals            for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy proposal_versions_admin    on public.proposal_versions    for select to authenticated using (public.is_admin());
create policy proposal_events_admin      on public.proposal_events      for select to authenticated using (public.is_admin());
create policy proposal_acceptances_admin on public.proposal_acceptances for select to authenticated using (public.is_admin());
create policy proposal_templates_admin   on public.proposal_templates   for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy payments_admin             on public.payments             for select to authenticated using (public.is_admin());

revoke all on public.proposals, public.proposal_versions, public.proposal_events, public.proposal_acceptances,
  public.proposal_templates, public.payments from anon, authenticated;
revoke all on sequence public.proposal_number_seq from anon, authenticated;
grant select, delete on public.proposals to authenticated;
grant insert (lead_id, client_id, title, recipient_name, recipient_email, cc, prepared_on, valid_until, content, internal, internal_notes, reminders)
  on public.proposals to authenticated;
grant update (lead_id, client_id, title, recipient_name, recipient_email, cc, prepared_on, valid_until, content, internal, internal_notes, reminders, archived_at)
  on public.proposals to authenticated;
grant usage on sequence public.proposal_number_seq to authenticated;
grant select on public.proposal_versions, public.proposal_events, public.proposal_acceptances, public.payments to authenticated;
grant select, insert, update, delete on public.proposal_templates to authenticated;

alter publication supabase_realtime add table public.proposals, public.proposal_events;

-- ---------------------------------------------------------------------------
-- The functions behind the buttons. Each runs as its owner and checks the
-- caller itself: is_admin() for the dashboard, the token for the client.
-- ---------------------------------------------------------------------------
create schema proposal_api;
revoke all on schema proposal_api from public, anon, authenticated;

-- The quote, or an error a person can read.
create function proposal_api.lock(p_id uuid)
returns public.proposals
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.proposals;
begin
  select * into p from public.proposals where id = p_id for update;
  if not found then
    raise exception 'That quote doesn''t exist or was deleted.' using errcode = 'P0002';
  end if;
  return p;
end;
$$;

create function proposal_api.require_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin who finished MFA can do this.' using errcode = '42501';
  end if;
end;
$$;

-- Who the quote is for: the owner's company and contact, and what the
-- placeholders become.
create function proposal_api.vars(p public.proposals)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with o as (
    select nullif(btrim(c.company), '') as company, nullif(btrim(c.contact_name), '') as contact, c.email
      from public.clients c where c.id = p.client_id
    union all
    select nullif(btrim(l.company), ''), nullif(btrim(l.name), ''), l.email
      from public.leads l where l.id = p.lead_id
  ), x as (
    select (select company from o limit 1) as company, (select contact from o limit 1) as contact, (select email from o limit 1) as email,
           coalesce(nullif(btrim(p.recipient_name), ''), (select contact from o limit 1)) as person
  )
  select jsonb_build_object(
    'company', coalesce(x.company, x.contact, 'your team'),
    'contact_first_name', coalesce(nullif(split_part(btrim(coalesce(x.person, '')), ' ', 1), ''), 'there'),
    'quote_number', 'Q' || p.number,
    'valid_until', trim(to_char(p.valid_until, 'FMMonth FMDD, YYYY')),
    'prepared_for', coalesce(x.company, x.contact, nullif(btrim(p.recipient_name), ''), ''),
    'person', coalesce(x.person, ''),
    'owner_email', x.email)
  from x;
$$;

-- Fill {company}, {contact_first_name}, {quote_number}, {valid_until} in a
-- document's text (the same as fill() in _shared/proposal.ts). Placeholders
-- only ever sit inside JSON strings, so replacing in the JSON text is safe
-- once each value is escaped for JSON.
create function proposal_api.fill(p_text text, v jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  r text := p_text;
begin
  foreach k in array array['company', 'contact_first_name', 'quote_number', 'valid_until'] loop
    r := replace(r, '{' || k || '}', coalesce(v ->> k, ''));
  end loop;
  return r;
end;
$$;

create function proposal_api.fill_doc(d jsonb, v jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  r text := d::text;
  e text;
begin
  foreach k in array array['company', 'contact_first_name', 'quote_number', 'valid_until'] loop
    e := to_jsonb(coalesce(v ->> k, ''))::text;
    r := replace(r, '{' || k || '}', substr(e, 2, char_length(e) - 2));
  end loop;
  return r::jsonb;
end;
$$;

-- Everything an email about this quote needs (the Edge Functions write the email).
create function proposal_api.context(p public.proposals, p_subject text default null, p_note text default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'number', 'Q' || p.number, 'version', p.version, 'status', p.status,
    'title', proposal_api.fill(p.title, v), 'company', v ->> 'prepared_for', 'first_name', v ->> 'contact_first_name',
    'to', p.recipient_email, 'to_name', nullif(btrim(p.recipient_name), ''), 'cc', to_jsonb(p.cc),
    'valid_until', p.valid_until, 'token', p.token, 'subject', p_subject, 'note', p_note,
    'lead_id', p.lead_id, 'client_id', p.client_id,
    'accepted_once', p.accepted_once, 'accepted_monthly', p.accepted_monthly,
    'settings', (select jsonb_build_object('notify_email', s.notify_email, 'reply_to', s.reply_to, 'from_name', s.from_name, 'stripe_mode', s.stripe_mode)
                 from public.quote_settings s where s.id = 1))
  from (select proposal_api.vars(p) as v) x;
$$;

-- Send a version: freeze the draft (placeholders filled) as the next
-- version, and the quote is sent. The caller emails it.
create function proposal_api.snapshot(p_id uuid, p_subject text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.proposals := proposal_api.lock(p_id);
  v jsonb;
  n integer;
  v_sched boolean := p.scheduled_at is not null and p.scheduled_at <= now() + interval '1 minute';
begin
  if p.status = 'revoked' then
    raise exception 'Q%''s link is turned off. Make a new link first.', p.number using errcode = 'P0403';
  end if;
  if not (p.status in ('draft', 'scheduled') or p.revising) then
    raise exception 'Q% was already sent. Use Revise to send a new version, or Resend to email it again.', p.number using errcode = 'P0403';
  end if;
  if p.recipient_email is null then
    raise exception 'Add the recipient''s email first.' using errcode = '22023';
  end if;
  if p.valid_until < public.la_today() then
    raise exception 'Valid until is in the past. Pick a later date first.' using errcode = '22023';
  end if;
  v := proposal_api.vars(p);
  n := p.version + 1;
  insert into public.proposal_versions (proposal_id, version, header, content, source_title, source)
  values (p.id, n,
    jsonb_build_object('number', 'Q' || p.number, 'title', proposal_api.fill(p.title, v), 'prepared_for', v ->> 'prepared_for',
                       'prepared_on', p.prepared_on, 'valid_until', p.valid_until),
    proposal_api.fill_doc(p.content, v), p.title, p.content);
  update public.proposals set
    version = n, status = 'sent', revising = false, scheduled_at = null, send_subject = null, send_note = null,
    sent_at = coalesce(sent_at, now()), last_sent_at = now(), revoked_from = null,
    accepted_at = null, accepted_version = null, accepted_once = null, accepted_monthly = null,
    reminded_unviewed_at = null, reminded_expiry_at = null
  where id = p.id
  returning * into p;
  insert into public.proposal_events (proposal_id, kind, detail)
  values (p.id, 'sent', jsonb_build_object('version', n, 'to', p.recipient_email, 'cc', to_jsonb(p.cc), 'scheduled', v_sched));
  -- Sending moves the lead along: a new or contacted lead now has a proposal.
  update public.leads set status = 'proposal' where id = p.lead_id and status in ('new', 'contacted');
  return proposal_api.context(p, p_subject, p_note);
end;
$$;

create function proposal_api.check_message(p_subject text, p_note text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_subject is null or char_length(btrim(p_subject)) not between 1 and 200 or p_subject ~ '[\r\n]' then
    raise exception 'The subject needs 1 to 200 characters on one line.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_note, '')) > 2000 then
    raise exception 'The note can be up to 2,000 characters.' using errcode = '22023';
  end if;
end;
$$;

-- Send now (the quote-action Edge Function calls this as the signed in admin, then emails).
create function public.proposal_send(p_id uuid, p_subject text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform proposal_api.require_admin();
  perform proposal_api.check_message(p_subject, p_note);
  return proposal_api.snapshot(p_id, btrim(p_subject), nullif(btrim(p_note), ''));
end;
$$;

-- What an email would say, without sending or changing anything (Resend, Send me a test).
create function public.proposal_mail_context(p_id uuid, p_subject text, p_note text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.proposals;
begin
  perform proposal_api.require_admin();
  perform proposal_api.check_message(p_subject, p_note);
  select * into p from public.proposals where id = p_id;
  if not found then
    raise exception 'That quote doesn''t exist or was deleted.' using errcode = 'P0002';
  end if;
  return proposal_api.context(p, btrim(p_subject), nullif(btrim(p_note), ''));
end;
$$;

-- After an email: record it on the timeline (resent, test sent, or failed).
create function public.proposal_mail_logged(p_id uuid, p_kind text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform proposal_api.require_admin();
  if p_kind not in ('resent', 'test_sent', 'email_failed') then
    raise exception 'unknown email event' using errcode = '22023';
  end if;
  insert into public.proposal_events (proposal_id, kind, detail)
  select id, p_kind, coalesce(p_detail, '{}') from public.proposals where id = p_id;
  if p_kind = 'resent' then
    update public.proposals set last_sent_at = now() where id = p_id;
  end if;
end;
$$;

-- Send later.
create function public.proposal_schedule(p_id uuid, p_at timestamptz, p_subject text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.proposals;
begin
  perform proposal_api.require_admin();
  perform proposal_api.check_message(p_subject, p_note);
  p := proposal_api.lock(p_id);
  if not (p.status in ('draft', 'scheduled') or p.revising) then
    raise exception 'Q% was already sent. Use Revise to schedule a new version.', p.number using errcode = 'P0403';
  end if;
  if p_at is null or p_at < now() + interval '1 minute' or p_at > now() + interval '90 days' then
    raise exception 'Pick a time from a few minutes to 90 days from now.' using errcode = '22023';
  end if;
  if p.recipient_email is null then
    raise exception 'Add the recipient''s email first.' using errcode = '22023';
  end if;
  update public.proposals set scheduled_at = p_at, send_subject = btrim(p_subject), send_note = nullif(btrim(p_note), ''),
    status = case when status = 'draft' then 'scheduled'::public.proposal_status else status end
  where id = p_id;
  insert into public.proposal_events (proposal_id, kind, detail) values (p_id, 'scheduled', jsonb_build_object('at', p_at));
end;
$$;

create function public.proposal_unschedule(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.proposals;
begin
  perform proposal_api.require_admin();
  p := proposal_api.lock(p_id);
  if p.scheduled_at is null then
    return;
  end if;
  update public.proposals set scheduled_at = null, send_subject = null, send_note = null,
    status = case when status = 'scheduled' then 'draft'::public.proposal_status else status end
  where id = p_id;
  insert into public.proposal_events (proposal_id, kind) values (p_id, 'unscheduled');
end;
$$;

-- Revise: the sent quote opens for edits; the client keeps seeing the sent
-- version until the revision is sent.
create function public.proposal_revise(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.proposals;
begin
  perform proposal_api.require_admin();
  p := proposal_api.lock(p_id);
  if p.version = 0 then
    raise exception 'Q% hasn''t been sent yet, so just edit it.', p.number using errcode = 'P0403';
  end if;
  if p.revising then
    return;
  end if;
  update public.proposals set revising = true where id = p_id;
  insert into public.proposal_events (proposal_id, kind, detail) values (p_id, 'revision_started', jsonb_build_object('version', p.version + 1));
end;
$$;

create function public.proposal_discard_revision(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.proposals;
  v public.proposal_versions;
begin
  perform proposal_api.require_admin();
  p := proposal_api.lock(p_id);
  if not p.revising then
    return;
  end if;
  select * into v from public.proposal_versions where proposal_id = p_id and version = p.version;
  update public.proposals set revising = false, scheduled_at = null, send_subject = null, send_note = null,
    content = v.source, title = v.source_title, prepared_on = (v.header ->> 'prepared_on')::date
  where id = p_id;
  insert into public.proposal_events (proposal_id, kind) values (p_id, 'revision_discarded');
end;
$$;

-- Turn the link off, or make a new one (which also turns a revoked quote back on).
create function public.proposal_revoke(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.proposals;
begin
  perform proposal_api.require_admin();
  p := proposal_api.lock(p_id);
  if p.status = 'revoked' then
    return;
  end if;
  update public.proposals set status = 'revoked', revoked_from = p.status, scheduled_at = null where id = p_id;
  insert into public.proposal_events (proposal_id, kind) values (p_id, 'revoked');
end;
$$;

create function public.proposal_new_link(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.proposals;
begin
  perform proposal_api.require_admin();
  p := proposal_api.lock(p_id);
  update public.proposals set token = public.new_proposal_token(), token_created_at = now(),
    status = case when status = 'revoked' then coalesce(revoked_from, case when version > 0 then 'sent' else 'draft' end::public.proposal_status) else status end,
    revoked_from = null
  where id = p_id;
  insert into public.proposal_events (proposal_id, kind, detail) values (p_id, 'link_regenerated', jsonb_build_object('was_revoked', p.status = 'revoked'));
end;
$$;

-- Declined (marked by you), and back to sent.
create function public.proposal_set_declined(p_id uuid, p_declined boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.proposals;
begin
  perform proposal_api.require_admin();
  p := proposal_api.lock(p_id);
  if p_declined then
    if p.status not in ('sent', 'viewed', 'changes_requested', 'expired') then
      raise exception 'Only a sent quote can be marked declined.' using errcode = 'P0403';
    end if;
    update public.proposals set status = 'declined', scheduled_at = null where id = p_id;
    insert into public.proposal_events (proposal_id, kind) values (p_id, 'declined');
  else
    if p.status <> 'declined' then
      return;
    end if;
    update public.proposals set status = case when first_viewed_at is null then 'sent' else 'viewed' end::public.proposal_status where id = p_id;
    insert into public.proposal_events (proposal_id, kind) values (p_id, 'reopened');
  end if;
end;
$$;

-- A copy as a new draft with a new number.
create function public.proposal_duplicate(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.proposals;
  v_id uuid;
  v_days integer;
begin
  perform proposal_api.require_admin();
  select * into p from public.proposals where id = p_id;
  if not found then
    raise exception 'That quote doesn''t exist or was deleted.' using errcode = 'P0002';
  end if;
  select default_valid_days into v_days from public.quote_settings where id = 1;
  insert into public.proposals (lead_id, client_id, title, recipient_name, recipient_email, cc, valid_until, content, internal, internal_notes, reminders)
  values (p.lead_id, p.client_id, p.title, p.recipient_name, p.recipient_email, p.cc, public.la_today() + coalesce(v_days, 30), p.content, p.internal, p.internal_notes, p.reminders)
  returning id into v_id;
  insert into public.proposal_events (proposal_id, kind, detail) values (v_id, 'duplicated', jsonb_build_object('from', 'Q' || p.number));
  return v_id;
end;
$$;

-- Turn a quote into a project: the accepted selection's lines at the accepted
-- prices (or, for a quote that wasn't accepted online, the lines the dashboard
-- sends), and the included scope as a checklist in the notes. With
-- p_convert_lead, a lead becomes a client first (the usual convert, which also
-- moves the lead's projects and quotes). Doing it twice returns the same project.
create function public.proposal_convert(p_id uuid, p_lines jsonb, p_convert_lead boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.proposals;
  acc public.proposal_acceptances;
  ver public.proposal_versions;
  v_project uuid;
  v_client uuid;
  v_lines jsonb;
  v_doc jsonb;
  v_tier text;
  v_addons text[];
  v_notes text;
  r jsonb;
  a jsonb;
  cell jsonb;
  v_tier_name text;
begin
  perform proposal_api.require_admin();
  p := proposal_api.lock(p_id);
  select id into v_project from public.projects where proposal_id = p_id;
  if v_project is not null then
    return v_project;
  end if;
  if p.status not in ('accepted', 'sent', 'viewed', 'changes_requested') or p.version = 0 then
    raise exception 'Only a sent or accepted quote can become a project.' using errcode = 'P0403';
  end if;

  if p.status = 'accepted' then
    select * into acc from public.proposal_acceptances
     where proposal_id = p_id and version = p.accepted_version order by accepted_at desc limit 1;
    v_lines := acc.lines; v_doc := acc.doc; v_tier := acc.tier; v_addons := acc.addons;
  else
    select * into ver from public.proposal_versions where proposal_id = p_id and version = p.version;
    v_doc := ver.content;
    if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 40 then
      raise exception 'Pick what the project covers first.' using errcode = '22023';
    end if;
    v_lines := p_lines;
    v_tier := coalesce((select l ->> 'key' from jsonb_array_elements(p_lines) l where l ->> 'kind' = 'tier' limit 1), v_doc ->> 'default_tier');
    v_addons := array(select l ->> 'key' from jsonb_array_elements(p_lines) l where l ->> 'kind' = 'addon');
  end if;
  if exists (select 1 from jsonb_array_elements(v_lines) l
             where char_length(btrim(coalesce(l ->> 'name', ''))) not between 1 and 120
                or coalesce(l ->> 'billing', '') not in ('once', 'monthly')
                or jsonb_typeof(l -> 'net') <> 'number' or (l ->> 'net')::numeric not between 0 and 1000000000) then
    raise exception 'The project''s lines aren''t valid.' using errcode = '22023';
  end if;

  if p.lead_id is not null and p_convert_lead then
    v_client := public.convert_lead_to_client(p.lead_id);
    select * into p from public.proposals where id = p_id;
  end if;

  select t ->> 'name' into v_tier_name from jsonb_array_elements(v_doc -> 'tiers') t where t ->> 'key' = v_tier;
  v_notes := case when p.status = 'accepted'
      then format('From quote Q%s, accepted %s by %s.', p.number, trim(to_char(acc.accepted_at at time zone 'America/Los_Angeles', 'FMMonth FMDD, YYYY')), acc.signer_name)
      else format('From quote Q%s (version %s, not accepted online).', p.number, p.version) end
    || E'\n\nScope (' || coalesce(v_tier_name, v_tier) || E'):';
  for r in select * from jsonb_array_elements(v_doc -> 'rows') loop
    cell := r -> 'values' -> v_tier;
    if cell = 'true'::jsonb then
      v_notes := v_notes || E'\n[ ] ' || (r ->> 'label');
    elsif jsonb_typeof(cell) = 'string' then
      v_notes := v_notes || E'\n[ ] ' || (r ->> 'label') || ': ' || (cell #>> '{}');
    end if;
  end loop;
  for a in select * from jsonb_array_elements(v_doc -> 'addons') loop
    if (a -> 'tiers' ->> v_tier) = 'included' or (a ->> 'key') = any (v_addons) then
      v_notes := v_notes || E'\n[ ] ' || (a ->> 'name');
    end if;
  end loop;

  insert into public.projects (lead_id, client_id, name, status, notes, proposal_id)
  values (p.lead_id, p.client_id, left(coalesce(case when p.status = 'accepted' then acc.header ->> 'title' else ver.header ->> 'title' end, p.title), 120),
          case when p.status = 'accepted' then 'in_progress' else 'proposed' end::public.project_status,
          left(v_notes, 20000), p_id)
  returning id into v_project;

  insert into public.project_services (project_id, name, billing, unit_amount, quantity, amount, sort)
  select v_project, left(l ->> 'name', 120), l ->> 'billing', round((l ->> 'net')::numeric / 100, 2), 1, round((l ->> 'net')::numeric / 100, 2), (n - 1) * 10
  from jsonb_array_elements(v_lines) with ordinality as x(l, n);

  update public.payments set project_id = v_project where proposal_id = p_id;
  insert into public.proposal_events (proposal_id, kind, detail) values (p_id, 'converted', jsonb_build_object('project_id', v_project, 'client_created', v_client is not null));
  return v_project;
end;
$$;

revoke all on function
  public.proposal_send(uuid, text, text), public.proposal_mail_context(uuid, text, text), public.proposal_mail_logged(uuid, text, jsonb),
  public.proposal_schedule(uuid, timestamptz, text, text), public.proposal_unschedule(uuid), public.proposal_revise(uuid),
  public.proposal_discard_revision(uuid), public.proposal_revoke(uuid), public.proposal_new_link(uuid),
  public.proposal_set_declined(uuid, boolean), public.proposal_duplicate(uuid), public.proposal_convert(uuid, jsonb, boolean)
from public, anon;
grant execute on function
  public.proposal_send(uuid, text, text), public.proposal_mail_context(uuid, text, text), public.proposal_mail_logged(uuid, text, jsonb),
  public.proposal_schedule(uuid, timestamptz, text, text), public.proposal_unschedule(uuid), public.proposal_revise(uuid),
  public.proposal_discard_revision(uuid), public.proposal_revoke(uuid), public.proposal_new_link(uuid),
  public.proposal_set_declined(uuid, boolean), public.proposal_duplicate(uuid), public.proposal_convert(uuid, jsonb, boolean)
to authenticated;

-- ---------------------------------------------------------------------------
-- The public page: one quote by its link token. Granted to anon.
-- ---------------------------------------------------------------------------
create function proposal_api.expire_one(p public.proposals)
returns void
language sql
security definer
set search_path = ''
as $$
  with u as (
    update public.proposals set status = 'expired' where id = p.id and status in ('sent', 'viewed', 'changes_requested')
    returning id
  )
  insert into public.proposal_events (proposal_id, kind, detail)
  select id, 'expired', jsonb_build_object('valid_until', p.valid_until) from u;
$$;

-- What the page shows for an accepted quote (and what's been paid).
create function proposal_api.accepted_info(p public.proposals)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'at', a.accepted_at, 'by', a.signer_name, 'tier', a.tier, 'addons', to_jsonb(a.addons),
    'once_total', a.once_total, 'monthly_total', a.monthly_total, 'due_now', a.due_now,
    'paid', coalesce((select sum(m.amount) from public.payments m where m.acceptance_id = a.id and m.status = 'paid'), 0))
  from public.proposal_acceptances a
  where a.proposal_id = p.id and a.version = p.accepted_version
  order by a.accepted_at desc
  limit 1;
$$;

create function public.proposal_view(p_token text, p_count boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.proposals;
  v public.proposal_versions;
  s public.quote_settings;
  v_first boolean;
begin
  select * into s from public.quote_settings where id = 1;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,64}$' then
    return jsonb_build_object('ok', false, 'reason', 'unavailable', 'contact_email', s.reply_to);
  end if;
  select * into p from public.proposals where token = p_token;
  if not found or p.version = 0 or p.status in ('draft', 'scheduled', 'declined', 'revoked') then
    return jsonb_build_object('ok', false, 'reason', 'unavailable', 'contact_email', s.reply_to);
  end if;
  select * into v from public.proposal_versions where proposal_id = p.id and version = p.version;

  if p.status = 'expired' or (p.status <> 'accepted' and p.valid_until < public.la_today()) then
    perform proposal_api.expire_one(p);
    return jsonb_build_object('ok', false, 'reason', 'expired', 'contact_email', s.reply_to,
      'number', v.header ->> 'number', 'title', v.header ->> 'title', 'prepared_for', v.header ->> 'prepared_for', 'valid_until', p.valid_until);
  end if;

  -- A view counts once per half hour, so reloading doesn't inflate it. The
  -- dashboard's preview never calls this, and its "View as client" link asks not to count.
  if p_count and (p.last_viewed_at is null or p.last_viewed_at < now() - interval '30 minutes') then
    v_first := p.first_viewed_at is null;
    update public.proposals set
      view_count = view_count + 1, first_viewed_at = coalesce(first_viewed_at, now()), last_viewed_at = now(),
      status = case when status = 'sent' then 'viewed'::public.proposal_status else status end
    where id = p.id
    returning * into p;
    insert into public.proposal_events (proposal_id, kind, detail, notify)
    values (p.id, 'viewed', jsonb_build_object('version', p.version, 'count', p.view_count), case when v_first then 'first_view' end);
  elsif p_count then
    update public.proposals set last_viewed_at = now() where id = p.id;
  end if;

  return jsonb_build_object(
    'ok', true, 'state', p.status, 'number', v.header ->> 'number', 'version', p.version,
    'title', v.header ->> 'title', 'prepared_for', v.header ->> 'prepared_for',
    'prepared_on', v.header ->> 'prepared_on', 'valid_until', p.valid_until,
    'doc', v.content, 'contact_email', s.reply_to, 'payments', s.stripe_mode,
    'accepted', case when p.status = 'accepted' then proposal_api.accepted_info(p) end);
end;
$$;
revoke all on function public.proposal_view(text, boolean) from public;
grant execute on function public.proposal_view(text, boolean) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- For the quote-public Edge Function (as quote_intake): accept, request
-- changes, and the version the client is looking at. Every call carries the
-- link token; nothing here can find a quote any other way.
-- ---------------------------------------------------------------------------
create table proposal_api.throttle (
  ip_hash text not null,
  action  text not null,
  at      timestamptz not null default now()
);
create index throttle_idx on proposal_api.throttle (ip_hash, action, at desc);
alter table proposal_api.throttle enable row level security;

create function proposal_api.throttle_check(p_ip_hash text, p_action text, p_per_hour integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_ip_hash is null or char_length(p_ip_hash) <> 64 then
    raise exception 'bad request' using errcode = '22023';
  end if;
  delete from proposal_api.throttle where at < now() - interval '1 day';
  if (select count(*) from proposal_api.throttle where ip_hash = p_ip_hash and action = p_action and at > now() - interval '1 hour') >= p_per_hour
     or (select count(*) from proposal_api.throttle) >= 500 then
    raise exception 'rate limited' using errcode = 'P0429';
  end if;
  insert into proposal_api.throttle (ip_hash, action) values (p_ip_hash, p_action);
end;
$$;

-- The quote by token, with the version the client sees (for computing totals).
create function proposal_api.for_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.proposals;
  v public.proposal_versions;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,64}$' then
    return null;
  end if;
  select * into p from public.proposals where token = p_token;
  if not found or p.version = 0 then
    return null;
  end if;
  select * into v from public.proposal_versions where proposal_id = p.id and version = p.version;
  return jsonb_build_object('id', p.id, 'status', p.status, 'version', p.version, 'valid_until', p.valid_until,
    'expired', p.status <> 'accepted' and p.valid_until < public.la_today(),
    'header', v.header, 'doc', v.content, 'accepted', case when p.status = 'accepted' then proposal_api.accepted_info(p) end,
    'context', proposal_api.context(p));
end;
$$;

-- Record an acceptance: the version the client saw, their selection, every
-- price and total (computed by the Edge Function from that same version), and
-- who signed. The quote is then accepted and locked.
create function proposal_api.accept(p_token text, p_version integer, p jsonb, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.proposals;
  v public.proposal_versions;
  v_id uuid;
begin
  perform proposal_api.throttle_check(p_ip_hash, 'accept', 10);
  select * into q from public.proposals where token = p_token for update;
  if not found or q.version = 0 or q.status not in ('sent', 'viewed', 'changes_requested') then
    if found and q.status = 'accepted' then
      raise exception 'already accepted' using errcode = 'P0409';
    end if;
    raise exception 'not available' using errcode = 'P0404';
  end if;
  if q.valid_until < public.la_today() then
    perform proposal_api.expire_one(q);
    raise exception 'expired' using errcode = 'P0410';
  end if;
  if q.version <> p_version then
    raise exception 'changed' using errcode = 'P0409';
  end if;
  select * into v from public.proposal_versions where proposal_id = q.id and version = q.version;

  insert into public.proposal_acceptances (proposal_id, version, header, doc, tier, addons, lines, totals, once_total, monthly_total, due_now,
    signer_name, signer_title, signer_email, signature, agreed_terms, ip_hash, user_agent)
  values (q.id, q.version, v.header, v.content, p ->> 'tier',
    array(select jsonb_array_elements_text(p -> 'addons')), p -> 'lines', p -> 'totals',
    round((p -> 'totals' ->> 'once_total')::numeric / 100, 2), round((p -> 'totals' ->> 'monthly_total')::numeric / 100, 2),
    round((p -> 'totals' ->> 'due_now')::numeric / 100, 2),
    btrim(p ->> 'name'), coalesce(btrim(p ->> 'title'), ''), lower(btrim(p ->> 'email')), btrim(p ->> 'signature'),
    coalesce((p ->> 'agree')::boolean, false), p_ip_hash, left(coalesce(p ->> 'user_agent', ''), 400))
  returning id into v_id;

  update public.proposals set status = 'accepted', accepted_at = now(), accepted_version = q.version,
    accepted_once = round((p -> 'totals' ->> 'once_total')::numeric / 100, 2),
    accepted_monthly = round((p -> 'totals' ->> 'monthly_total')::numeric / 100, 2),
    scheduled_at = null, revising = false
  where id = q.id
  returning * into q;
  insert into public.proposal_events (proposal_id, kind, detail, notify)
  values (q.id, 'accepted', jsonb_build_object('version', q.version, 'acceptance_id', v_id, 'tier', p ->> 'tier', 'addons', p -> 'addons',
    'once_total', q.accepted_once, 'monthly_total', q.accepted_monthly, 'by', btrim(p ->> 'name')), 'accepted');
  -- The lead is won, and its value follows what was accepted.
  update public.leads set status = 'won', value_one_time = q.accepted_once, value_monthly = q.accepted_monthly where id = q.lead_id;
  return proposal_api.context(q) || jsonb_build_object('acceptance_id', v_id, 'accepted', proposal_api.accepted_info(q));
end;
$$;

-- Request changes (or, on an expired quote, an updated one).
create function proposal_api.request_changes(p_token text, p jsonb, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.proposals;
begin
  perform proposal_api.throttle_check(p_ip_hash, 'changes', 5);
  select * into q from public.proposals where token = p_token for update;
  if not found or q.version = 0 or q.status not in ('sent', 'viewed', 'changes_requested', 'expired') then
    raise exception 'not available' using errcode = 'P0404';
  end if;
  update public.proposals set changes_requested_at = now(),
    status = case when status = 'expired' or valid_until < public.la_today() then status else 'changes_requested'::public.proposal_status end
  where id = q.id
  returning * into q;
  insert into public.proposal_events (proposal_id, kind, detail, notify)
  values (q.id, 'changes_requested', jsonb_build_object('version', q.version, 'name', left(btrim(p ->> 'name'), 120),
    'email', left(lower(btrim(p ->> 'email')), 254), 'message', left(btrim(p ->> 'message'), 2000), 'expired', q.status = 'expired'), 'changes');
  return proposal_api.context(q);
end;
$$;

-- Emails to Henry that haven't gone yet (first view, changes, accepted, payment).
create function proposal_api.pending_notices()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('event_id', e.id, 'notify', e.notify, 'at', e.at, 'detail', e.detail,
           'quote', proposal_api.context(p)) order by e.id), '[]'::jsonb)
  from (select * from public.proposal_events where notify is not null and notified_at is null and at > now() - interval '3 days' order by id limit 20) e
  join public.proposals p on p.id = e.proposal_id;
$$;

create function proposal_api.mark_notified(p_ids bigint[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.proposal_events set notified_at = now() where id = any (p_ids) and notified_at is null;
$$;

-- Quotes whose Send later time has come: each is sent (frozen as a new
-- version) in one step, so it can't go twice. The caller emails them.
create function proposal_api.claim_scheduled()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  out jsonb := '[]';
begin
  for r in select id, send_subject, send_note from public.proposals
           where scheduled_at is not null and scheduled_at <= now() and status <> 'revoked'
           order by scheduled_at limit 10 for update skip locked loop
    begin
      out := out || jsonb_build_array(proposal_api.snapshot(r.id, coalesce(r.send_subject, 'Your quote from cyberxLA'), r.send_note));
    exception when others then
      update public.proposals set scheduled_at = null,
        status = case when status = 'scheduled' then 'draft'::public.proposal_status else status end where id = r.id;
      insert into public.proposal_events (proposal_id, kind, detail) values (r.id, 'email_failed', jsonb_build_object('scheduled', true, 'error', left(sqlerrm, 300)));
    end;
  end loop;
  return out;
end;
$$;

-- Follow ups, for quotes with reminders on, between 9 AM and 5 PM Pacific:
-- not viewed a few days after sending, and a couple of days before expiring.
create function proposal_api.claim_reminders()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.quote_settings;
  r public.proposals;
  out jsonb := '[]';
  v_hour integer := extract(hour from now() at time zone 'America/Los_Angeles');
begin
  if v_hour < 9 or v_hour >= 17 then
    return out;
  end if;
  select * into s from public.quote_settings where id = 1;
  for r in select * from public.proposals
           where reminders and status = 'sent' and first_viewed_at is null and reminded_unviewed_at is null
             and last_sent_at < now() - make_interval(days => s.remind_unviewed_days) and valid_until >= public.la_today()
           limit 10 for update skip locked loop
    update public.proposals set reminded_unviewed_at = now() where id = r.id;
    insert into public.proposal_events (proposal_id, kind, detail) values (r.id, 'reminder', jsonb_build_object('kind', 'unviewed'));
    out := out || jsonb_build_array(proposal_api.context(r) || jsonb_build_object('reminder', 'unviewed'));
  end loop;
  for r in select * from public.proposals
           where reminders and status in ('sent', 'viewed') and reminded_expiry_at is null
             and valid_until >= public.la_today() and valid_until - public.la_today() <= s.remind_expiry_days
           limit 10 for update skip locked loop
    update public.proposals set reminded_expiry_at = now() where id = r.id;
    insert into public.proposal_events (proposal_id, kind, detail) values (r.id, 'reminder', jsonb_build_object('kind', 'expiring'));
    out := out || jsonb_build_array(proposal_api.context(r) || jsonb_build_object('reminder', 'expiring'));
  end loop;
  return out;
end;
$$;

-- Sent quotes past their valid until date. Returns how many.
create function proposal_api.expire_due()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  with u as (
    update public.proposals set status = 'expired'
    where status in ('sent', 'viewed', 'changes_requested') and valid_until < public.la_today()
    returning id, valid_until
  ), e as (
    insert into public.proposal_events (proposal_id, kind, detail)
    select id, 'expired', jsonb_build_object('valid_until', valid_until) from u
    returning 1
  )
  select count(*) into n from e;
  return n;
end;
$$;

-- The Edge Functions report whether Stripe's secrets are set.
create function proposal_api.set_stripe_mode(p_mode text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.quote_settings set stripe_mode = p_mode, stripe_checked_at = now()
  where id = 1 and p_mode in ('off', 'test', 'live');
$$;

revoke all on all functions in schema proposal_api from public, anon, authenticated;
alter default privileges in schema proposal_api revoke all on functions from public;
grant usage on schema proposal_api to quote_intake;
grant execute on function
  proposal_api.for_token(text), proposal_api.accept(text, integer, jsonb, text), proposal_api.request_changes(text, jsonb, text),
  proposal_api.pending_notices(), proposal_api.mark_notified(bigint[]), proposal_api.claim_scheduled(), proposal_api.claim_reminders(),
  proposal_api.expire_due(), proposal_api.set_stripe_mode(text)
to quote_intake;

-- ---------------------------------------------------------------------------
-- Converting a lead also moves its quotes to the client.
-- ---------------------------------------------------------------------------
create or replace function public.convert_lead_to_client(p_lead uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_client uuid;
  v_lead public.leads;
  v_quote public.quotes;
  v_devices integer;
begin
  select id into v_client from public.clients where lead_id = p_lead;
  if v_client is not null then
    update public.projects set client_id = v_client, lead_id = null where lead_id = p_lead;
    update public.proposals set client_id = v_client, lead_id = null where lead_id = p_lead;
    return v_client;
  end if;

  select * into v_lead from public.leads where id = p_lead;
  if not found then
    raise exception 'Lead not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes
   where lead_id = p_lead and archived_at is null
   order by created_at desc limit 1;

  insert into public.clients (lead_id, company, contact_name, email, phone, workstations, servers, status, started_on)
  values (p_lead, v_lead.company, v_lead.name, v_lead.email, v_lead.phone,
          coalesce(v_quote.workstations, 0), coalesce(v_quote.servers, 0), 'active', current_date)
  returning id into v_client;

  if v_quote.id is not null then
    v_devices := v_quote.workstations + v_quote.servers;
    insert into public.client_services (client_id, service_id, name, billing, unit_amount, quantity, amount, sort)
    select v_client,
           (select s.id from public.services s where s.id = it ->> 'id'),
           it ->> 'name',
           case when it ->> 'kind' = 'monthly' then 'monthly' else 'once' end,
           case when per_dev then (it ->> 'unit_price')::numeric else (it ->> 'cost')::numeric end,
           case when per_dev then v_devices else 1 end,
           (it ->> 'cost')::numeric,
           (ord - 1) * 10
    from jsonb_array_elements(v_quote.items) with ordinality as x(it, ord),
    lateral (select it ->> 'unit' in ('dev', 'devonce') and v_devices > 0
                    and (it ->> 'unit_price')::numeric * v_devices = (it ->> 'cost')::numeric as per_dev) p;
  end if;

  update public.projects set client_id = v_client, lead_id = null where lead_id = p_lead;
  update public.proposals set client_id = v_client, lead_id = null where lead_id = p_lead;
  update public.leads set status = 'won' where id = p_lead and status <> 'won';
  return v_client;
end;
$$;
revoke all on function public.convert_lead_to_client(uuid) from public, anon;
grant execute on function public.convert_lead_to_client(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The first template, written generally (placeholders, no client details).
-- Same content as tests/fixtures/workspace-template.json.
-- ---------------------------------------------------------------------------
insert into public.proposal_templates (name, title, content) values
  ('Google Workspace migration', 'Google Workspace migration', $tpl${"v": 1, "intro": "Pick a tier, add anything extra, and accept your selection online. Tap any service in the table to see what it includes.", "tiers": [{"key": "essentials", "name": "Essentials", "price": 4200, "discount": null, "monthly": null, "monthly_discount": null, "summary": "Everything you need to move over, done simply."}, {"key": "pro", "name": "Pro", "price": 5500, "discount": null, "monthly": null, "monthly_discount": null, "summary": "Organized shared drives, spoofing blocked, and a tested backup."}, {"key": "complete", "name": "Complete", "price": 8400, "discount": null, "monthly": null, "monthly_discount": null, "summary": "Business Plus with Vault legal holds, USB keys, and every add on included."}], "recommended": "pro", "default_tier": "pro", "rows": [{"key": "plan", "label": "Plan", "explain": "The Google Workspace license {company} pays Google for. Standard is the most affordable plan with room for all of your files; Plus adds Google Vault for legal holds and retention.", "values": {"essentials": "Standard", "pro": "Standard", "complete": "Plus"}}, {"key": "tenant", "label": "Tenant, Users", "explain": "We create your Google Workspace, verify your domain, set baseline security, and set up an account for each person.", "values": {"essentials": true, "pro": true, "complete": true}}, {"key": "email", "label": "Email Migration", "explain": "All the email in your current inbox is copied into a shared office mailbox on your own domain.", "values": {"essentials": true, "pro": true, "complete": true}}, {"key": "forward", "label": "Old Gmail Forwarding", "explain": "The old Gmail address forwards new mail to the new mailbox and auto replies with your new address. Then its password is reset and every device is signed out.", "values": {"essentials": true, "pro": true, "complete": true}}, {"key": "drive", "label": "Drive Migration", "explain": "Essentials moves your files as is into one shared drive. Pro and Complete organize them into four separate shared drives, each with its own permissions.", "values": {"essentials": "1 shared drive folder", "pro": "4 shared drive folders", "complete": "4 shared drive folders"}}, {"key": "mfa", "label": "MFA", "explain": "Everyone signs in with a password plus a code from an authenticator app on their phone. Complete adds USB security keys for up to 3 people, including the admin account.", "values": {"essentials": "Authenticator App Only", "pro": "Authenticator App Only", "complete": "Authenticator App plus USB Keys"}}, {"key": "desktop", "label": "Drive Desktop", "explain": "Google Drive for desktop on each PC, signed in for each person, with their Desktop, Documents, and Downloads folders backed up.", "values": {"essentials": true, "pro": true, "complete": true}}, {"key": "cutover", "label": "Domain Cutover", "explain": "Your domain’s email moves over to Google, any existing mailboxes come along, and the old email subscription is cancelled.", "values": {"essentials": true, "pro": true, "complete": true}}, {"key": "contacts", "label": "Contacts/Calendar Migration", "explain": "Contacts and calendar events move from the old account into Google Workspace.", "values": {"essentials": true, "pro": true, "complete": true}}, {"key": "scanner", "label": "Scanner Email Setup", "explain": "Your copier’s scan to email, and anything else that sends from the old account, is switched to send from your domain.", "values": {"essentials": true, "pro": true, "complete": true}}, {"key": "training", "label": "Staff Training", "explain": "A one hour session for your team on their new logins, the shared inbox, shared drives, and MFA.", "values": {"essentials": true, "pro": true, "complete": true}}, {"key": "runbook", "label": "Runbook", "explain": "A written record of your setup: DNS records, drive structure, admin access, and how to add or remove a user.", "values": {"essentials": true, "pro": true, "complete": true}}, {"key": "dmarc", "label": "SPF DKIM DMARC", "explain": "Email security records that stop scammers from sending email as your domain. Monitor reports spoofing attempts; Enforce actively blocks them after 2 to 4 weeks of reports.", "values": {"essentials": "Monitor", "pro": "Enforce", "complete": "Enforce"}}, {"key": "backup", "label": "Backup Reconfiguration", "explain": "Your existing backup is moved to the new Workspace, covering every person’s email and files and all shared drives. Pro and Complete add a test restore and email alerts if a backup fails.", "values": {"essentials": true, "pro": true, "complete": true}}, {"key": "winlogin", "label": "Windows Synced User Logins", "explain": "Each person signs into their PC with their Google Workspace login and MFA, so one login covers everything.", "values": {"essentials": false, "pro": false, "complete": true}}, {"key": "vault", "label": "Vault Retention Policies", "explain": "Google Vault retention rules and legal holds, so email and files can’t be permanently deleted and can be searched or exported when you need them.", "values": {"essentials": false, "pro": false, "complete": true}}, {"key": "phone", "label": "Phone Policies", "explain": "A screen lock is required, and remote wipe is ready, on any phone with company email.", "values": {"essentials": false, "pro": false, "complete": true}}, {"key": "policies", "label": "IT Policies", "explain": "Written policies for acceptable use, passwords and MFA, and onboarding and offboarding staff.", "values": {"essentials": false, "pro": false, "complete": true}}, {"key": "hypercare", "label": "Hypercare", "explain": "Support after cutover, with any issues fixed at no extra charge.", "values": {"essentials": "1 week", "pro": "2 weeks", "complete": "30 days"}}], "addons": [{"key": "usb", "name": "USB Security Keys", "description": "Physical keys for up to 3 people, the strongest protection against phishing. Keys billed at cost.", "price": 400, "billing": "once", "discount": null, "tiers": {"essentials": "available", "pro": "available", "complete": "included"}}, {"key": "win", "name": "Windows Synced User Logins", "description": "Each person signs into their PC with their Workspace login and MFA.", "price": 750, "billing": "once", "discount": null, "tiers": {"essentials": "available", "pro": "available", "complete": "included"}}, {"key": "phone", "name": "Phone Policies", "description": "Screen lock required and remote wipe ready on every phone with company email.", "price": 400, "billing": "once", "discount": null, "tiers": {"essentials": "available", "pro": "available", "complete": "included"}}, {"key": "policies", "name": "Basic IT Policies", "description": "Short written policies for acceptable use, passwords and MFA, and onboarding and offboarding.", "price": 750, "billing": "once", "discount": null, "tiers": {"essentials": "available", "pro": "available", "complete": "included"}}, {"key": "hyper", "name": "Extended Hypercare, 30 Days", "description": "Support after cutover extended to 30 days, with fixes at no extra charge.", "price": 500, "billing": "once", "discount": null, "tiers": {"essentials": "available", "pro": "available", "complete": "included"}}], "discount": null, "payment": {"mode": "none", "deposit_kind": "percent", "deposit_value": 50}, "fine_print": [{"key": "lic1", "text": "Google Workspace Standard licenses are billed separately by Google, about $14 per user per month on an annual plan.", "tiers": ["essentials", "pro"], "addon": null}, {"key": "lic2", "text": "Google Workspace Plus licenses are billed separately by Google, about $22 per user per month on an annual plan.", "tiers": ["complete"], "addon": null}, {"key": "keys", "text": "USB keys are billed at cost.", "tiers": [], "addon": "usb"}], "terms": true}$tpl$::jsonb)
on conflict (name) do nothing;

commit;
