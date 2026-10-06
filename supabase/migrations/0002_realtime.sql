-- Push lead and quote changes to the dashboard live. Realtime applies the same
-- row-level security, so only an MFA-verified admin receives these events.
alter publication supabase_realtime add table public.leads, public.quotes;
