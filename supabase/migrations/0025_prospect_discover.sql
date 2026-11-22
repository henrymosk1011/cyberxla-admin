-- Prospect discovery (the Prospects page's "Find businesses" button).
--
-- The prospect-discover Edge Function searches a business directory and then
-- adds what it finds by calling prospecting.add_prospects(). That function
-- lives in the prospecting schema, which the API never exposes and which only
-- the audit_runner role may call, so the signed-in admin can't reach it over
-- their own PostgREST connection.
--
-- This thin, admin-gated wrapper in the public schema bridges the gap: the
-- Edge Function authenticates the caller the same way audit-action and
-- report-action do (public.is_admin() with the caller's token, allowlist plus
-- MFA), then calls this over the caller's own connection. No service-role key
-- and no second database login are involved, matching how the rest of the
-- dashboard talks to the database. De-duplication on (source, source_ref) and
-- all validation stay in prospecting.add_prospects().

begin;

create function public.add_prospects(p jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Same gate as every prospects policy: an allowlisted admin whose session
  -- finished MFA. 42501 (insufficient_privilege) surfaces as HTTP 403.
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return prospecting.add_prospects(p);
end;
$$;

revoke all on function public.add_prospects(jsonb) from public, anon;
grant execute on function public.add_prospects(jsonb) to authenticated;

commit;
