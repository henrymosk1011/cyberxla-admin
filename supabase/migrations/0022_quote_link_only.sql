-- "Published, not emailed": a quote whose latest version went out with
-- Publish without emailing, and hasn't been emailed since. The dashboard shows
-- it in place of Sent, so it's clear nothing reached the client's inbox.
-- Only the database sets it (the dashboard can't update this column).

alter table public.proposals add column link_only boolean not null default false;
comment on column public.proposals.link_only is
  'True when the latest version was published without an email and none has been sent since.';

-- Every new version (Send now, Send later, Publish) starts as emailed;
-- Publish without emailing marks it link only right after.
create function proposal_api.link_only_reset()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version is distinct from old.version then
    new.link_only := false;
  end if;
  return new;
end;
$$;
revoke all on function proposal_api.link_only_reset() from public;

create trigger proposals_link_only before update on public.proposals
for each row execute function proposal_api.link_only_reset();

create or replace function public.proposal_publish(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform proposal_api.require_admin();
  v := proposal_api.snapshot(p_id, null, null);
  update public.proposal_events set detail = detail || '{"emailed": false}'::jsonb
  where id = (select max(id) from public.proposal_events where proposal_id = p_id and kind = 'sent');
  update public.proposals set link_only = true where id = p_id;
  return v;
end;
$$;

-- Resend emails the latest version, so it's no longer link only.
create or replace function public.proposal_mail_logged(p_id uuid, p_kind text, p_detail jsonb)
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
    update public.proposals set last_sent_at = now(), link_only = false where id = p_id;
  end if;
end;
$$;

-- Quotes already published without an email (their latest send says so).
update public.proposals p set link_only = true
where p.version > 0
  and exists (
    select 1 from public.proposal_events e
    where e.proposal_id = p.id and e.kind = 'sent' and e.detail ->> 'emailed' = 'false'
      and e.id = (select max(x.id) from public.proposal_events x where x.proposal_id = p.id and x.kind in ('sent', 'resent'))
  );
