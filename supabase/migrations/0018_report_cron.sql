-- The patch reports' schedule, run by the database. GitHub's own schedule
-- skips runs when it is busy (on Monday Nov 16 2026 none of the hourly Send
-- reports runs started, so the reports went out late), so pg_cron calls the
-- report-cron Edge Function, which starts the reports repo's workflow:
--
--   Generate reports  hourly on Sundays (UTC 07 to 23, 2 past the hour)
--   Send reports      hourly on Mondays (UTC 07 to 23, 2 past the hour)
--   Check UniFi       daily at 13:23 UTC
--
-- The workflows decide what is due (the generate and send times set in the
-- admin panel), so an extra start does nothing, and GitHub's schedules stay
-- as a backup. pg_cron runs in UTC, like GitHub.
--
-- The token pg_cron sends is made here, in Vault (report_cron_token), and
-- never leaves the database. After running this, put the hash the last
-- query prints into Supabase > Edge Functions > Secrets as REPORT_CRON_HASH,
-- then deploy report-cron (verify JWT off).

begin;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Only postgres (which pg_cron runs as) uses this schema.
create schema if not exists scheduler;
revoke all on schema scheduler from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'report_cron_token') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'report_cron_token',
      'Sent by pg_cron to the report-cron Edge Function as x-cron-token. Its SHA-256 is the REPORT_CRON_HASH secret.'
    );
  end if;
end $$;

-- Starts one job; returns the pg_net request id (see net._http_response).
create or replace function scheduler.report_cron(p_job text)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_token text;
begin
  if p_job is null or p_job not in ('generate', 'send', 'unifi') then
    raise exception 'unknown report job %', p_job;
  end if;
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'report_cron_token';
  if v_token is null then
    raise exception 'report_cron_token is missing from Vault';
  end if;
  return net.http_post(
    url := 'https://onpdkqzcgnoepwiqcgtv.supabase.co/functions/v1/report-cron',
    body := jsonb_build_object('job', p_job),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-token', v_token),
    timeout_milliseconds := 20000
  );
end;
$$;

revoke all on function scheduler.report_cron(text) from public, anon, authenticated;

-- cron.schedule with a name replaces a job of that name, so this can run again.
select cron.schedule('report-generate', '2 7-23 * * 0', $job$select scheduler.report_cron('generate')$job$);
select cron.schedule('report-send', '2 7-23 * * 1', $job$select scheduler.report_cron('send')$job$);
select cron.schedule('report-unifi', '23 13 * * *', $job$select scheduler.report_cron('unifi')$job$);

commit;

-- The REPORT_CRON_HASH secret for the report-cron function:
select encode(extensions.digest(decrypted_secret, 'sha256'), 'hex') as report_cron_hash
from vault.decrypted_secrets
where name = 'report_cron_token';
