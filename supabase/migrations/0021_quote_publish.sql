-- Publish without emailing: freeze a version and make the link live, with no
-- email. For quotes you send yourself (a text, your own email), and for while
-- email isn't set up (no RESEND_API_KEY). The timeline says the link was
-- published without an email.

create function public.proposal_publish(p_id uuid)
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
  return v;
end;
$$;

revoke all on function public.proposal_publish(uuid) from public, anon;
grant execute on function public.proposal_publish(uuid) to authenticated;
