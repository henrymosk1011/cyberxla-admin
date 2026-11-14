-- Deleting reports for good.
--   * The Reports list's Cleared view can delete reports for good (one or in
--     bulk). Their PDFs and page images go with them (report_files cascades).
--   * A sent client report must be cleared first; a report that is sending can
--     never be deleted. Everything else could already be deleted.

begin;

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
    if v_admin and old.status = 'sending' then
      raise exception 'This report is sending and can''t be deleted' using errcode = 'P0403';
    end if;
    -- A sent client report is the record: it has to be cleared first, then it
    -- can be deleted for good from the Cleared view.
    if v_admin and old.status = 'sent' and not old.is_test and old.cleared_at is null then
      raise exception 'Sent reports are kept for the record. Clear it first, then delete it from Cleared.' using errcode = 'P0403';
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

commit;
