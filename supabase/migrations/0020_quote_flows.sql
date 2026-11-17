-- Quotes, part 3: the scheduler, notifications, and Stripe payments.
--
--   * pg_cron checks every minute (proposal_api.tick): it expires quotes past
--     their date in the database, and when something is due (a Send later, an
--     email to Henry, or at least hourly for reminders and the Stripe check) it
--     calls the quote-cron Edge Function with a key kept in Vault. The function
--     checks the key with the database, so the key never leaves it.
--   * Stripe: the quote-public function starts Checkout for the exact accepted
--     amount; stripe-webhook records payments. Each Stripe event is applied
--     once (proposal_api.stripe_events), so a repeated event never counts twice.
--   * Everything here is callable only by quote_intake (the Edge Functions) or
--     by the admin (is_admin), like 0019.

begin;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Emails to Henry that failed are retried a few times, not forever.
alter table public.proposal_events add column notify_tries integer not null default 0 check (notify_tries >= 0);

-- ---------------------------------------------------------------------------
-- Admin (dashboard and quote-action)
-- ---------------------------------------------------------------------------
create function public.proposal_set_stripe_mode(p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform proposal_api.require_admin();
  perform proposal_api.set_stripe_mode(p_mode);
end;
$$;

-- Send test payment on the Payments page: a $1 Checkout not tied to a quote.
create function public.payment_test_started(p_session text, p_amount_cents integer, p_livemode boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform proposal_api.require_admin();
  if p_session is null or p_session !~ '^cs_[A-Za-z0-9_]{8,250}$' or p_amount_cents not between 50 and 100000 then
    raise exception 'bad test payment' using errcode = '22023';
  end if;
  insert into public.payments (kind, amount, status, livemode, stripe_session_id)
  values ('test', round(p_amount_cents::numeric / 100, 2), 'pending', coalesce(p_livemode, false), p_session)
  on conflict (stripe_session_id) do nothing;
end;
$$;

revoke all on function public.proposal_set_stripe_mode(text), public.payment_test_started(text, integer, boolean) from public, anon;
grant execute on function public.proposal_set_stripe_mode(text), public.payment_test_started(text, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Accept and request changes return the timeline event, so the Edge Function
-- can email Henry right away and mark it sent.
-- ---------------------------------------------------------------------------
create or replace function proposal_api.accept(p_token text, p_version integer, p jsonb, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.proposals;
  v public.proposal_versions;
  v_id uuid;
  v_event bigint;
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
    raise exception 'changed' using errcode = 'P0408';
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
    'once_total', q.accepted_once, 'monthly_total', q.accepted_monthly, 'by', btrim(p ->> 'name')), 'accepted')
  returning id into v_event;
  -- The lead is won, and its value follows what was accepted.
  update public.leads set status = 'won', value_one_time = q.accepted_once, value_monthly = q.accepted_monthly where id = q.lead_id;
  return proposal_api.context(q) || jsonb_build_object('acceptance_id', v_id, 'event_id', v_event, 'accepted', proposal_api.accepted_info(q));
end;
$$;

create or replace function proposal_api.request_changes(p_token text, p jsonb, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.proposals;
  v_event bigint;
  v_expired boolean;
begin
  perform proposal_api.throttle_check(p_ip_hash, 'changes', 5);
  select * into q from public.proposals where token = p_token for update;
  if not found or q.version = 0 or q.status not in ('sent', 'viewed', 'changes_requested', 'expired') then
    raise exception 'not available' using errcode = 'P0404';
  end if;
  v_expired := q.status = 'expired' or q.valid_until < public.la_today();
  update public.proposals set changes_requested_at = now(),
    status = case when v_expired then 'expired'::public.proposal_status else 'changes_requested'::public.proposal_status end
  where id = q.id
  returning * into q;
  insert into public.proposal_events (proposal_id, kind, detail, notify)
  values (q.id, 'changes_requested', jsonb_build_object('version', q.version, 'name', left(btrim(p ->> 'name'), 120),
    'email', left(lower(btrim(p ->> 'email')), 254), 'message', left(btrim(p ->> 'message'), 2000), 'expired', v_expired), 'changes')
  returning id into v_event;
  return proposal_api.context(q) || jsonb_build_object('event_id', v_event);
end;
$$;

-- A failed email, on the quote's timeline (from the Edge Functions).
create function proposal_api.log_email_failed(p_id uuid, p_detail jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.proposal_events (proposal_id, kind, detail)
  select id, 'email_failed', jsonb_build_object('error', left(coalesce(p_detail ->> 'error', ''), 300), 'what', left(coalesce(p_detail ->> 'what', ''), 60))
  from public.proposals where id = p_id;
$$;

-- Notices that didn't send are tried again, up to five times.
create or replace function proposal_api.pending_notices()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('event_id', e.id, 'notify', e.notify, 'at', e.at, 'detail', e.detail,
           'quote', proposal_api.context(p)) order by e.id), '[]'::jsonb)
  from (select * from public.proposal_events
        where notify is not null and notified_at is null and notify_tries < 5 and at > now() - interval '3 days'
        order by id limit 20) e
  join public.proposals p on p.id = e.proposal_id;
$$;

create function proposal_api.notice_failed(p_ids bigint[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.proposal_events set notify_tries = notify_tries + 1 where id = any (p_ids) and notified_at is null;
$$;

-- ---------------------------------------------------------------------------
-- The scheduler
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'quote_cron_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'quote_cron_key',
      'Sent by pg_cron to the quote-cron Edge Function as x-cron-key; the function checks it with proposal_api.cron_key_ok.');
  end if;
end $$;

create function proposal_api.cron_key_ok(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_key is not null and p_key ~ '^[0-9a-f]{64}$'
     and exists (select 1 from vault.decrypted_secrets s where s.name = 'quote_cron_key' and s.decrypted_secret = p_key);
$$;

create function proposal_api.cron_seen()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.quote_settings set cron_seen_at = now() where id = 1;
$$;

-- Every minute: expire what's past its date, and wake quote-cron when there's
-- something to send (and at least hourly, for reminders and the Stripe check).
create function proposal_api.tick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_seen timestamptz;
begin
  perform proposal_api.expire_due();
  select cron_seen_at into v_seen from public.quote_settings where id = 1;
  if exists (select 1 from public.proposals where scheduled_at is not null and scheduled_at <= now() and status <> 'revoked')
     or exists (select 1 from public.proposal_events where notify is not null and notified_at is null and notify_tries < 5 and at > now() - interval '3 days')
     or v_seen is null or v_seen < now() - interval '55 minutes' then
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'quote_cron_key';
    perform net.http_post(
      url := 'https://onpdkqzcgnoepwiqcgtv.supabase.co/functions/v1/quote-cron',
      body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', v_key),
      timeout_milliseconds := 25000);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Stripe
-- ---------------------------------------------------------------------------
create table proposal_api.stripe_events (
  id          text primary key check (id ~ '^evt_[A-Za-z0-9_]{6,250}$'),
  type        text not null check (char_length(type) <= 100),
  received_at timestamptz not null default now()
);
alter table proposal_api.stripe_events enable row level security;

-- What's due on an accepted quote, for Pay deposit / Pay now.
create function proposal_api.pay_context(p_token text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.proposals;
  a public.proposal_acceptances;
  v_paid numeric;
begin
  perform proposal_api.throttle_check(p_ip_hash, 'pay', 20);
  select * into q from public.proposals where token = p_token;
  if not found or q.status <> 'accepted' then
    raise exception 'not accepted' using errcode = 'P0404';
  end if;
  select * into a from public.proposal_acceptances where proposal_id = q.id and version = q.accepted_version order by accepted_at desc limit 1;
  select coalesce(sum(amount), 0) into v_paid from public.payments where acceptance_id = a.id and status = 'paid';
  return proposal_api.context(q) || jsonb_build_object(
    'acceptance_id', a.id, 'due_cents', round(a.due_now * 100)::integer, 'paid_cents', round(v_paid * 100)::integer,
    'kind', case when a.doc -> 'payment' ->> 'mode' = 'full' then 'full' else 'deposit' end, 'email', a.signer_email);
end;
$$;

-- A Checkout Session was made for a quote.
create function proposal_api.payment_started(p_proposal uuid, p_acceptance uuid, p_kind text, p_amount_cents integer, p_session text, p_livemode boolean, p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session is null or p_session !~ '^cs_[A-Za-z0-9_]{8,250}$' or p_kind not in ('deposit', 'full') or p_amount_cents < 50 then
    raise exception 'bad payment' using errcode = '22023';
  end if;
  insert into public.payments (proposal_id, acceptance_id, project_id, kind, amount, status, livemode, stripe_session_id, email)
  values (p_proposal, p_acceptance, (select id from public.projects where proposal_id = p_proposal), p_kind,
          round(p_amount_cents::numeric / 100, 2), 'pending', coalesce(p_livemode, false), p_session, left(p_email, 254))
  on conflict (stripe_session_id) do nothing;
end;
$$;

-- Apply one Stripe event, once. p: { session_id, payment_intent, amount_cents,
-- livemode, status (paid, failed, expired, refunded), proposal_id,
-- acceptance_id, kind, email } from the verified event. The event id is
-- stored in the same transaction, so a repeat (Stripe retries) changes nothing.
create function proposal_api.stripe_apply(p_event_id text, p_type text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.payments;
  q public.proposals;
  v_status text := p ->> 'status';
  v_event bigint;
  v_prop uuid;
  v_acc uuid;
begin
  insert into proposal_api.stripe_events (id, type) values (p_event_id, left(p_type, 100)) on conflict (id) do nothing;
  if not found then
    return jsonb_build_object('duplicate', true);
  end if;
  if v_status not in ('paid', 'failed', 'expired', 'refunded') then
    return jsonb_build_object('ignored', true);
  end if;

  if v_status = 'refunded' then
    select * into m from public.payments where stripe_payment_intent = p ->> 'payment_intent' for update;
  else
    select * into m from public.payments where stripe_session_id = p ->> 'session_id' for update;
  end if;

  if not found then
    if v_status = 'refunded' or coalesce(p ->> 'session_id', '') !~ '^cs_[A-Za-z0-9_]{8,250}$' then
      return jsonb_build_object('unknown', true);
    end if;
    -- A session we didn't record (made elsewhere, or the start wasn't saved): from its metadata.
    if (p ->> 'proposal_id') ~ '^[0-9a-f-]{36}$' and exists (select 1 from public.proposals where id = (p ->> 'proposal_id')::uuid) then
      v_prop := (p ->> 'proposal_id')::uuid;
      if (p ->> 'acceptance_id') ~ '^[0-9a-f-]{36}$' then
        select id into v_acc from public.proposal_acceptances where id = (p ->> 'acceptance_id')::uuid and proposal_id = v_prop;
      end if;
    end if;
    insert into public.payments (proposal_id, acceptance_id, project_id, kind, amount, status, livemode, stripe_session_id, email)
    values (v_prop, v_acc, (select id from public.projects where proposal_id = v_prop),
            case when p ->> 'kind' in ('deposit', 'full', 'test') then p ->> 'kind' else 'balance' end,
            greatest(round(coalesce((p ->> 'amount_cents')::numeric, 0) / 100, 2), 0.01), 'pending', coalesce((p ->> 'livemode')::boolean, false),
            p ->> 'session_id', left(p ->> 'email', 254))
    returning * into m;
  end if;

  if m.status = v_status or not (
       (m.status = 'pending' and v_status in ('paid', 'failed', 'expired'))
    or (m.status = 'failed' and v_status = 'paid')
    or (m.status = 'expired' and v_status = 'paid')
    or (m.status = 'paid' and v_status = 'refunded')) then
    return jsonb_build_object('changed', false, 'status', m.status);
  end if;

  update public.payments set
    status = v_status,
    paid_at = case when v_status = 'paid' then coalesce(paid_at, now()) else paid_at end,
    stripe_payment_intent = coalesce(nullif(p ->> 'payment_intent', ''), stripe_payment_intent),
    amount = case when coalesce((p ->> 'amount_cents')::numeric, 0) > 0 and v_status = 'paid' then round((p ->> 'amount_cents')::numeric / 100, 2) else amount end,
    livemode = coalesce((p ->> 'livemode')::boolean, livemode),
    project_id = coalesce(project_id, (select id from public.projects where proposal_id = m.proposal_id))
  where id = m.id
  returning * into m;

  if m.proposal_id is not null and v_status in ('paid', 'failed') then
    insert into public.proposal_events (proposal_id, kind, detail, notify)
    values (m.proposal_id, case when v_status = 'paid' then 'payment' else 'payment_failed' end,
            jsonb_build_object('payment_id', m.id, 'amount', m.amount, 'kind', m.kind, 'livemode', m.livemode),
            case when v_status = 'paid' then 'payment' end)
    returning id into v_event;
    select * into q from public.proposals where id = m.proposal_id;
  end if;
  return jsonb_build_object('changed', true, 'status', m.status, 'kind', m.kind, 'amount_cents', round(m.amount * 100)::integer, 'livemode', m.livemode,
    'event_id', v_event, 'quote', case when q.id is not null then proposal_api.context(q) end);
end;
$$;

revoke all on all functions in schema proposal_api from public, anon, authenticated;
grant execute on function
  proposal_api.accept(text, integer, jsonb, text), proposal_api.request_changes(text, jsonb, text),
  proposal_api.log_email_failed(uuid, jsonb), proposal_api.pending_notices(), proposal_api.notice_failed(bigint[]),
  proposal_api.cron_key_ok(text), proposal_api.cron_seen(),
  proposal_api.pay_context(text, text), proposal_api.payment_started(uuid, uuid, text, integer, text, boolean, text),
  proposal_api.stripe_apply(text, text, jsonb)
to quote_intake;

-- cron.schedule with a name replaces a job of that name, so this can run again.
select cron.schedule('quote-tick', '* * * * *', $job$select proposal_api.tick()$job$);

commit;
