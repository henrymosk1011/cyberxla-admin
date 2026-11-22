-- Queue scans for many prospects at once, for the dashboard's bulk "Scan now"
-- (selected prospects) and the auto-scan that runs right after "Find
-- businesses" adds new ones. Both queue PASSIVE audits only: a passive audit
-- just observes what is public, so it is safe to run on any prospect. Active
-- (intrusive) audits still go one at a time through the per-prospect button,
-- behind a recorded authorization, and are never fanned out from here.

begin;

-- Insert a queued passive audit for each eligible prospect and return the new
-- audit ids. Eligible = not archived, has a website to scan, and has no scan
-- already in flight. With p_ids null, every eligible prospect; otherwise just
-- those. With p_rescan false (the auto-scan after discovery) only prospects
-- that have never been audited, so it targets fresh finds and doesn't re-run
-- ones already done. With p_rescan true (an explicit "Scan now" on a selection)
-- it queues a fresh scan even for prospects that were audited before.
--
-- Admin-gated and SECURITY DEFINER, like public.add_prospects: the is_admin()
-- check is the gate, and the queued-passive insert passes guard_audit() the
-- same way the per-prospect "Run passive audit" button does.
create function public.scan_prospects(p_ids uuid[] default null, p_rescan boolean default false)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin who finished MFA can do this' using errcode = '42501';
  end if;
  return query
  with eligible as (
    select p.id
    from public.prospects p
    where p.archived_at is null
      and p.website is not null
      and (p_ids is null or p.id = any (p_ids))
      and not exists (
        select 1 from public.audits a
        where a.prospect_id = p.id and a.scan_status in ('queued', 'running'))
      and (p_rescan or not exists (
        select 1 from public.audits a where a.prospect_id = p.id))
  ),
  queued as (
    insert into public.audits (prospect_id, kind, is_test, scan_status)
    select id, 'passive', false, 'queued' from eligible
    returning id
  )
  select id from queued;
end;
$$;
revoke all on function public.scan_prospects(uuid[], boolean) from public, anon;
grant execute on function public.scan_prospects(uuid[], boolean) to authenticated;

-- Drain-friendly claim_scan: when it meets a queued audit it must refuse (a kind
-- that is turned off, or an active audit with no current authorization), it
-- fails that one and moves on to the next queued audit instead of returning
-- null. So one turned-off or unauthorized audit at the front of the queue no
-- longer stalls a whole batch. A named target (p_audit not null) still returns
-- null when that specific audit can't run, exactly as before.
create or replace function prospecting.claim_scan(p_audit uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.audits;
  p public.prospects;
  s public.audit_settings;
  v_dom text;
begin
  select * into s from public.audit_settings where id = 1;
  loop
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
    v_dom := coalesce(a.target_domain, p.domain);

    -- Respect the master switches and the active-audit authorization gate.
    if (a.kind = 'passive' and not s.passive_enabled)
       or (a.kind = 'active' and not s.active_enabled)
       or (a.kind = 'active' and not public.audit_authorized(a.prospect_id, v_dom)) then
      update public.audits set scan_status = 'failed', finished_at = now(), scan_error =
        case when a.kind = 'active' and not public.audit_authorized(a.prospect_id, v_dom)
             then 'No current authorization for an active audit of this domain.'
             else 'This kind of audit is turned off.' end
      where id = a.id;
      if p_audit is not null then
        return null;   -- a named target that can't run: report nothing, as before
      end if;
      continue;        -- draining: skip it and claim the next queued audit
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
  end loop;
end;
$$;

commit;
