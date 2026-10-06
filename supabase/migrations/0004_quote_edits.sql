-- Editing a quote's services or device counts changes its totals; keep the
-- lead's value in step (it follows the lead's newest active quote).
drop trigger quotes_refresh_lead_value on public.quotes;
create trigger quotes_refresh_lead_value
  after update of archived_at, monthly_total, one_time_total or delete on public.quotes
  for each row execute function public.refresh_lead_value();
