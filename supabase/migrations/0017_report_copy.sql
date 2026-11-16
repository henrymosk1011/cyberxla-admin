-- Send me a copy: the reports repo reads one report as it stands (its email
-- and content) to email Henry a copy, without claiming it or changing its
-- status, so it works before and after a report is sent and never counts as
-- a send. Only report_writer (the reports repo) can call it.

begin;

create function reporting.report_copy(p_report uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', v.id, 'client_id', v.client_id,
    'client_name', (select coalesce(nullif(btrim(c.company), ''), c.contact_name) from public.clients c where c.id = v.client_id),
    'period', v.period, 'period_key', v.period_key, 'period_start', v.period_start, 'is_test', v.is_test, 'status', v.status,
    'recipients', to_jsonb(v.recipients), 'cc', to_jsonb(v.cc), 'subject', v.subject, 'email_body', v.email_body,
    'content', v.content, 'data', v.data, 'content_version', v.content_version)
  from public.reports v
  where v.id = p_report;
$$;

revoke all on function reporting.report_copy(uuid) from public, anon, authenticated;
grant execute on function reporting.report_copy(uuid) to report_writer;

commit;
