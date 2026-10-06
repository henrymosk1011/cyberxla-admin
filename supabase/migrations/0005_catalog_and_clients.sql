-- Services catalog managed from the dashboard (the website and the quote
-- function read it live), and clients with the services they pay for.

begin;

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
create table public.service_categories (
  id         text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  blurb      text not null default '' check (char_length(blurb) <= 300),
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.services (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  category_id text not null references public.service_categories (id) on delete restrict,
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 400),
  price       numeric(10,2) not null check (price >= 0 and price <= 1000000),
  unit        text not null check (unit in ('dev', 'mo', 'once', 'devonce')),
  price_from  boolean not null default false,
  in_packages boolean not null default false,
  active      boolean not null default true,
  -- Used by the website's Essential/Secure/Shield packages: editable, but
  -- can't be deleted or hidden.
  locked      boolean not null default false,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index services_category_idx on public.services (category_id, sort);

create function public.guard_locked_service()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.locked then
      raise exception '% is used by the website packages and can''t be deleted', old.name using errcode = 'P0403';
    end if;
    return old;
  end if;
  if new.id is distinct from old.id then
    raise exception 'A service''s id can''t be changed' using errcode = 'P0403';
  end if;
  if new.locked is distinct from old.locked then
    raise exception 'The package lock can''t be changed here' using errcode = 'P0403';
  end if;
  if old.locked and not new.active then
    raise exception '% is used by the website packages and can''t be hidden', old.name using errcode = 'P0403';
  end if;
  return new;
end;
$$;
create trigger services_guard before update or delete on public.services
  for each row execute function public.guard_locked_service();
create trigger services_touch   before update on public.services           for each row execute function public.touch_updated_at();
create trigger categories_touch before update on public.service_categories for each row execute function public.touch_updated_at();

alter table public.service_categories enable row level security;
alter table public.services           enable row level security;
create policy service_categories_admin on public.service_categories for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy services_admin           on public.services           for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.service_categories, public.services to authenticated;

-- Catalog changes go to the audit log too (text ids, so row_id stays null).
create function public.audit_row_text_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (actor, actor_role, action, table_name, row_id, old_data, new_data)
  values (
    auth.uid(),
    coalesce(nullif(auth.jwt() ->> 'role', ''), session_user),
    lower(tg_op),
    tg_table_name,
    null,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end;
$$;
revoke all on function public.audit_row_text_id() from public, anon, authenticated;
create trigger services_audit   after insert or update or delete on public.services           for each row execute function public.audit_row_text_id();
create trigger categories_audit after insert or update or delete on public.service_categories for each row execute function public.audit_row_text_id();

-- What the public website and the quote function read: active services only,
-- grouped by category, nothing else.
create function public.service_catalog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(cat order by sort, name), '[]'::jsonb)
  from (
    select c.sort, c.name,
           jsonb_build_object(
             'id', c.id, 'name', c.name, 'blurb', c.blurb,
             'services', (
               select jsonb_agg(jsonb_build_object(
                        'id', s.id, 'name', s.name, 'description', s.description,
                        'price', s.price, 'unit', s.unit, 'from', s.price_from,
                        'in_packages', s.in_packages
                      ) order by s.sort, s.name)
               from public.services s
               where s.category_id = c.id and s.active
             )
           ) as cat
    from public.service_categories c
    where exists (select 1 from public.services s where s.category_id = c.id and s.active)
  ) t;
$$;
revoke all on function public.service_catalog() from public;
grant execute on function public.service_catalog() to anon, authenticated, quote_intake;
grant usage on schema public to quote_intake;

insert into public.service_categories (id, name, blurb, sort) values
  ('protect', 'Protect devices', 'Keep every laptop, desktop, and server hardened and up to date.', 0),
  ('monitor', 'Monitor and respond', 'Eyes on your business around the clock, and a plan for when something happens.', 10),
  ('email', 'Email and identity', 'Most attacks start with an inbox or a stolen password.', 20),
  ('test', 'Test and assess', 'Find the gaps before someone else does.', 30),
  ('recover', 'Backup and recovery', 'When something goes wrong, get back to work fast.', 40),
  ('compliance', 'Insurance and compliance', 'Prove you’re secure to insurers, clients, and regulators.', 50);

insert into public.services (id, category_id, name, description, price, unit, price_from, in_packages, locked, sort) values
  ('patching', 'protect', 'Patching', 'OS and third party app updates, tested and scheduled after hours.', 10, 'dev', false, true, true, 0),
  ('edr', 'protect', 'EDR', 'Endpoint detection and response on every device, catching what antivirus misses.', 8, 'dev', false, true, true, 10),
  ('ransomware', 'protect', 'Ransomware Protection', 'Behavior based blocking, automatic device isolation, and rollback.', 5, 'dev', false, false, false, 20),
  ('encryption', 'protect', 'Disk Encryption', 'BitLocker and FileVault enforced and tracked, so a lost laptop isn’t a breach.', 3, 'dev', false, false, false, 30),
  ('hardening', 'protect', 'Device Hardening', 'Secure baseline settings, local admin rights removed, risky features turned off.', 35, 'devonce', false, false, false, 40),
  ('firewall', 'protect', 'Firewall and Wi-Fi Security', 'Firewall rules, guest network separation, and firmware kept current.', 150, 'mo', false, false, false, 50),
  ('mdr', 'monitor', '24/7 MDR', 'A security operations center watching alerts day and night and containing threats.', 14, 'dev', false, true, true, 0),
  ('domain', 'monitor', 'Domain Monitoring', 'Alerts on lookalike phishing domains, unexpected DNS changes, and expiring renewals.', 49, 'mo', false, false, false, 10),
  ('darkweb', 'monitor', 'Dark Web Monitoring', 'Alerts when company emails and passwords show up in breach dumps.', 75, 'mo', false, false, false, 20),
  ('cloudmon', 'monitor', 'Microsoft 365 and Google Monitoring', 'Suspicious sign ins, risky forwarding rules, and account takeovers flagged fast.', 5, 'dev', false, false, false, 30),
  ('irretainer', 'monitor', 'Incident Response Retainer', 'Guaranteed hands on help to contain an attack, clean up, and document what happened.', 400, 'mo', false, false, false, 40),
  ('irplan', 'monitor', 'Incident Response Plan', 'A written, practiced plan so your team knows who to call and what to do first.', 2500, 'once', false, false, false, 50),
  ('filtering', 'email', 'Email Filtering', 'Phishing, malware, and impersonation emails stopped before they reach the inbox.', 4, 'dev', false, false, false, 0),
  ('training', 'email', 'Phishing Training', 'Short training and realistic simulated phishing tests for the whole team.', 3, 'dev', false, false, false, 10),
  ('dmarc', 'email', 'SPF, DKIM, and DMARC', 'Stop criminals from sending email as your domain, and improve deliverability.', 750, 'once', false, false, false, 20),
  ('mfa', 'email', 'MFA Rollout', 'Multi factor sign in on email, remote access, and every critical app.', 50, 'devonce', false, false, false, 30),
  ('passwords', 'email', 'Password Manager', 'A business password manager deployed and adopted. No more sticky notes.', 6, 'dev', false, false, false, 40),
  ('access', 'email', 'Access Reviews', 'Quarterly checks that former employees and vendors no longer have access.', 99, 'mo', false, false, false, 50),
  ('pentest', 'test', 'Penetration Testing', 'Real, authorized attempts to break in, with a plain English report and fix list.', 5000, 'once', true, false, false, 0),
  ('vuln', 'test', 'Vulnerability Management', 'Recurring internal and external scans, prioritized so you fix what matters first.', 4, 'dev', false, false, false, 10),
  ('risk', 'test', 'Security Risk Assessment', 'A full review of your people, processes, and technology, with a roadmap.', 3500, 'once', false, false, false, 20),
  ('surface', 'test', 'External Attack Surface Review', 'Everything you expose to the internet, from forgotten servers to open ports.', 1800, 'once', false, false, false, 30),
  ('cloudbackup', 'recover', 'Microsoft 365 and Google Backup', 'Email, files, and calendars backed up daily, separate from Microsoft and Google.', 4, 'dev', false, false, false, 0),
  ('devbackup', 'recover', 'Device and Server Backup', 'Image based backups for critical machines, with copies kept offsite.', 10, 'dev', false, false, false, 10),
  ('restore', 'recover', 'Restore Testing', 'Backups that are actually tested, so you know they’ll work when you need them.', 150, 'mo', false, false, false, 20),
  ('drplan', 'recover', 'Disaster Recovery Planning', 'A clear plan for how long you can be down and how you get back up.', 3000, 'once', false, false, false, 30),
  ('insurance', 'compliance', 'Cyber Insurance Readiness', 'The controls insurers require, plus help with the questionnaire and renewals. We don’t sell insurance.', 2500, 'once', false, false, false, 0),
  ('hipaa', 'compliance', 'HIPAA Security Support', 'Risk analysis and safeguards for health care practices, home health, and hospice.', 400, 'mo', false, false, false, 10),
  ('policies', 'compliance', 'Security Policies', 'Plain English policies for acceptable use, passwords, remote work, and incidents.', 2000, 'once', false, false, false, 20),
  ('questionnaire', 'compliance', 'Client Security Questionnaires', 'Help answering the security questionnaires your larger clients send you.', 500, 'once', false, false, false, 30);

-- ---------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------
create type public.client_status as enum ('active', 'paused', 'former');

create table public.clients (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  company      text check (char_length(company) <= 160),
  contact_name text check (char_length(contact_name) <= 120),
  email        text check (email is null or (char_length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone        text check (char_length(phone) <= 40),
  address      text check (char_length(address) <= 300),
  status       public.client_status not null default 'active',
  started_on   date,
  workstations integer not null default 0 check (workstations between 0 and 100000),
  servers      integer not null default 0 check (servers between 0 and 10000),
  notes        text check (char_length(notes) <= 10000),
  lead_id      uuid references public.leads (id) on delete set null,
  check (coalesce(btrim(company), '') <> '' or coalesce(btrim(contact_name), '') <> '')
);
create unique index clients_lead_key on public.clients (lead_id) where lead_id is not null;
create index clients_status_idx on public.clients (status);

create table public.client_services (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  service_id text references public.services (id) on delete set null,
  name       text not null check (char_length(btrim(name)) between 1 and 120),
  billing    text not null check (billing in ('monthly', 'once')),
  amount     numeric(12,2) not null check (amount >= 0 and amount <= 10000000),
  notes      text check (char_length(notes) <= 500),
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index client_services_client_idx on public.client_services (client_id, sort);

create trigger clients_touch         before update on public.clients         for each row execute function public.touch_updated_at();
create trigger client_services_touch before update on public.client_services for each row execute function public.touch_updated_at();

alter table public.clients         enable row level security;
alter table public.client_services enable row level security;
create policy clients_admin         on public.clients         for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy client_services_admin on public.client_services for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.clients, public.client_services to authenticated;

create trigger clients_audit         after insert or update or delete on public.clients         for each row execute function public.audit_row();
create trigger client_services_audit after insert or update or delete on public.client_services for each row execute function public.audit_row();

-- Turn a lead into a client in one step: contact details plus the services
-- and prices from its newest active quote. Runs as the caller, so the
-- admin-only rules above still apply. Converting twice returns the same client.
create function public.convert_lead_to_client(p_lead uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_client uuid;
  v_lead public.leads;
  v_quote public.quotes;
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

  insert into public.clients (company, contact_name, email, phone, status, started_on, workstations, servers, lead_id)
  values (v_lead.company, v_lead.name, v_lead.email, v_lead.phone, 'active', current_date,
          coalesce(v_quote.workstations, 0), coalesce(v_quote.servers, 0), p_lead)
  returning id into v_client;

  if v_quote.id is not null then
    insert into public.client_services (client_id, service_id, name, billing, amount, sort)
    select v_client,
           (select s.id from public.services s where s.id = it ->> 'id'),
           it ->> 'name',
           case when it ->> 'kind' = 'monthly' then 'monthly' else 'once' end,
           (it ->> 'cost')::numeric,
           (ord - 1) * 10
    from jsonb_array_elements(v_quote.items) with ordinality as x(it, ord);
  end if;

  update public.leads set status = 'won' where id = p_lead and status <> 'won';
  return v_client;
end;
$$;
revoke all on function public.convert_lead_to_client(uuid) from public, anon;
grant execute on function public.convert_lead_to_client(uuid) to authenticated;

commit;
