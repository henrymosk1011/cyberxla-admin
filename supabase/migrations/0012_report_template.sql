-- The report template: the wording and order every new patch report starts
-- from (What we did, titles, labels, the email), edited in Reports, Settings,
-- Report template. Empty means the built in defaults. Generate reads it with
-- the other settings through reporting.context().

begin;

alter table public.report_settings
  add column template jsonb not null default '{}' check (jsonb_typeof(template) = 'object' and pg_column_size(template) <= 200000);

grant update (template) on public.report_settings to authenticated;

commit;
