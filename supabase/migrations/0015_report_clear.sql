-- Clearing old reports from the Reports list.
--   * Clear on a finished report (sent, failed or cancelled) sets cleared_at:
--     it leaves the list but stays in the database (sent ones are the record).
--     The list's Cleared view shows them, and Restore brings one back.
--   * A cleared report that goes back to scheduled or on hold is uncleared.
--   * Test reports delete themselves a week after they're made: the Sunday
--     run calls reporting.purge_test_reports().

begin;

alter table public.reports add column cleared_at timestamptz;
grant update (cleared_at) on public.reports to authenticated;

create or replace function public.guard_report()
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

  -- Back in play: back on the list.
  if new.status is distinct from old.status and new.status in ('scheduled', 'held') then
    new.cleared_at := null;
  end if;

  if not v_admin then
    return new;
  end if;

  if new.cleared_at is not null and old.cleared_at is null
     and not (old.is_test or old.status in ('sent', 'failed', 'cancelled')) then
    raise exception 'Only sent, failed, cancelled or test reports can be cleared' using errcode = 'P0403';
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

-- Test reports more than a week old (never one that is sending). Returns how many.
create function reporting.purge_test_reports()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from public.reports r
  where r.is_test and r.status <> 'sending' and r.created_at < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function reporting.purge_test_reports() from public, anon, authenticated;
grant execute on function reporting.purge_test_reports() to report_writer;

commit;
