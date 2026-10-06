-- Client services get a price per unit and a quantity (e.g. $200 x 4 machines).
-- amount stays the line total so MRR math elsewhere is unchanged; a trigger
-- keeps it equal to unit_amount * quantity.
begin;

alter table public.client_services
  add column unit_amount numeric(12,2) check (unit_amount >= 0 and unit_amount <= 10000000),
  add column quantity    integer not null default 1 check (quantity between 1 and 100000);

update public.client_services set unit_amount = amount where unit_amount is null;

create function public.client_service_total()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.unit_amount is null then
    -- Callers that only send a total (lead conversion) get a 1 x total line.
    new.unit_amount := new.amount;
    new.quantity := 1;
  elsif tg_op = 'UPDATE' and new.amount is distinct from old.amount
        and new.unit_amount is not distinct from old.unit_amount
        and new.quantity = old.quantity then
    -- Only the total changed: treat it as a flat price.
    new.unit_amount := new.amount;
    new.quantity := 1;
  end if;
  new.amount := round(new.unit_amount * new.quantity, 2);
  return new;
end;
$$;

create trigger client_services_total
  before insert or update on public.client_services
  for each row execute function public.client_service_total();

alter table public.client_services alter column unit_amount set not null;

-- Converting a lead: per-device lines come over as price x devices when the
-- quote priced them that way (no server markup); everything else is 1 x total.
create or replace function public.convert_lead_to_client(p_lead uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_client uuid;
  v_lead public.leads;
  v_quote public.quotes;
  v_devices integer;
begin
  select id into v_client from public.clients where lead_id = p_lead;
  if v_client is not null then
    return v_client;
  end if;

  select * into v_lead from public.leads where id = p_lead;
  if not found then
    raise exception 'Lead not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes
   where lead_id = p_lead and archived_at is null
   order by created_at desc limit 1;

  insert into public.clients (lead_id, company, contact_name, email, phone, workstations, servers, status, started_on)
  values (p_lead, v_lead.company, v_lead.name, v_lead.email, v_lead.phone,
          coalesce(v_quote.workstations, 0), coalesce(v_quote.servers, 0), 'active', current_date)
  returning id into v_client;

  if v_quote.id is not null then
    v_devices := v_quote.workstations + v_quote.servers;
    insert into public.client_services (client_id, service_id, name, billing, unit_amount, quantity, amount, sort)
    select v_client,
           (select s.id from public.services s where s.id = it ->> 'id'),
           it ->> 'name',
           case when it ->> 'kind' = 'monthly' then 'monthly' else 'once' end,
           case when per_dev then (it ->> 'unit_price')::numeric else (it ->> 'cost')::numeric end,
           case when per_dev then v_devices else 1 end,
           (it ->> 'cost')::numeric,
           (ord - 1) * 10
    from jsonb_array_elements(v_quote.items) with ordinality as x(it, ord),
    lateral (select it ->> 'unit' in ('dev', 'devonce') and v_devices > 0
                    and (it ->> 'unit_price')::numeric * v_devices = (it ->> 'cost')::numeric as per_dev) p;
  end if;

  update public.leads set status = 'won' where id = p_lead and status <> 'won';
  return v_client;
end;
$$;
revoke all on function public.convert_lead_to_client(uuid) from public, anon;
grant execute on function public.convert_lead_to_client(uuid) to authenticated;

commit;
