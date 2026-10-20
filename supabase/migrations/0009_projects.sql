-- Projects for leads and clients: the services each would cover, notes, and
-- saved credentials.
--
-- Credentials are encrypted in the browser (AES-256-GCM) before they're sent.
-- The key is unlocked with a vault passphrase that never leaves the browser,
-- so the database, its backups, and anyone with SQL access only ever see
-- ciphertext. The activity log records that a credential changed, never its
-- contents.

begin;

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
create type public.project_status as enum ('potential', 'proposed', 'in_progress', 'on_hold', 'done', 'cancelled');

create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Belongs to a lead or a client, never both. A lead's projects move to its
  -- client when the lead is converted.
  lead_id    uuid references public.leads (id) on delete cascade,
  client_id  uuid references public.clients (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 120),
  status     public.project_status not null default 'potential',
  due_on     date,
  notes      text check (char_length(notes) <= 20000),
  check ((lead_id is null) <> (client_id is null))
);
create index projects_lead_idx   on public.projects (lead_id);
create index projects_client_idx on public.projects (client_id);

-- Same shape and pricing rule as client_services: amount = unit_amount x quantity.
create table public.project_services (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  service_id  text references public.services (id) on delete set null,
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  billing     text not null check (billing in ('monthly', 'once')),
  unit_amount numeric(12,2) not null check (unit_amount >= 0 and unit_amount <= 10000000),
  quantity    integer not null default 1 check (quantity between 1 and 100000),
  amount      numeric(12,2) not null check (amount >= 0 and amount <= 10000000),
  notes       text check (char_length(notes) <= 500),
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index project_services_project_idx on public.project_services (project_id, sort);

create trigger projects_touch         before update on public.projects         for each row execute function public.touch_updated_at();
create trigger project_services_touch before update on public.project_services for each row execute function public.touch_updated_at();
create trigger project_services_total before insert or update on public.project_services
  for each row execute function public.client_service_total();

alter table public.projects         enable row level security;
alter table public.project_services enable row level security;
create policy projects_admin         on public.projects         for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy project_services_admin on public.project_services for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.projects, public.project_services to authenticated;

create trigger projects_audit         after insert or update or delete on public.projects         for each row execute function public.audit_row();
create trigger project_services_audit after insert or update or delete on public.project_services for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------
-- Credentials (encrypted in the browser)
-- ---------------------------------------------------------------------------
-- One row: a random data key, wrapped with AES-GCM under a key derived from
-- the vault passphrase (PBKDF2-SHA256). Changing the passphrase re-wraps this
-- key; the credentials themselves don't change. Deliberately not in the
-- activity log: an old wrapped key kept forever would still open with the
-- old passphrase.
create table public.credential_vault (
  id          integer primary key default 1 check (id = 1),
  salt        text not null check (salt ~ '^[A-Za-z0-9+/]+={0,2}$' and char_length(salt) <= 64),
  iterations  integer not null check (iterations between 100000 and 10000000),
  wrapped_key text not null check (wrapped_key ~ '^v1\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$' and char_length(wrapped_key) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.project_credentials (
  -- Made by the browser, because it's bound into the ciphertext (with
  -- project_id), so a secret can't be swapped onto another row unnoticed.
  id         uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  label      text not null check (char_length(btrim(label)) between 1 and 120),
  -- v1.<iv>.<ciphertext> in base64: username, password, URL and notes.
  secret     text not null check (secret ~ '^v1\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$' and char_length(secret) <= 40000),
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index project_credentials_project_idx on public.project_credentials (project_id, sort);

create trigger credential_vault_touch    before update on public.credential_vault    for each row execute function public.touch_updated_at();
create trigger project_credentials_touch before update on public.project_credentials for each row execute function public.touch_updated_at();

-- Deleting the vault on its own would leave every saved credential
-- undecryptable; reset_credential_vault() removes both together.
create function public.guard_credential_vault()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.project_credentials) then
    raise exception 'Saved credentials still use this vault. Reset the vault to remove them together.' using errcode = 'P0403';
  end if;
  return old;
end;
$$;
revoke all on function public.guard_credential_vault() from public, anon, authenticated;
create trigger credential_vault_guard before delete on public.credential_vault
  for each row execute function public.guard_credential_vault();

alter table public.credential_vault    enable row level security;
alter table public.project_credentials enable row level security;
create policy credential_vault_admin    on public.credential_vault    for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy project_credentials_admin on public.project_credentials for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.credential_vault, public.project_credentials to authenticated;

-- Like audit_row(), minus the columns named in the trigger's arguments.
create function public.audit_row_redacted()
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
    case when tg_op = 'DELETE' then old.id else new.id end,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) - tg_argv end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) - tg_argv end
  );
  return null;
end;
$$;
revoke all on function public.audit_row_redacted() from public, anon, authenticated;
create trigger project_credentials_audit after insert or update or delete on public.project_credentials
  for each row execute function public.audit_row_redacted('secret');

-- A forgotten passphrase can't be recovered, so the only way forward is to
-- delete every saved credential along with the vault. Runs as the caller, so
-- the admin-only rules above still apply.
create function public.reset_credential_vault()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.project_credentials where id is not null;
  delete from public.credential_vault where id = 1;
end;
$$;
revoke all on function public.reset_credential_vault() from public, anon;
grant execute on function public.reset_credential_vault() to authenticated;

-- ---------------------------------------------------------------------------
-- Converting a lead also moves its projects to the client.
-- ---------------------------------------------------------------------------
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
    update public.projects set client_id = v_client, lead_id = null where lead_id = p_lead;
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

  update public.projects set client_id = v_client, lead_id = null where lead_id = p_lead;
  update public.leads set status = 'won' where id = p_lead and status <> 'won';
  return v_client;
end;
$$;
revoke all on function public.convert_lead_to_client(uuid) from public, anon;
grant execute on function public.convert_lead_to_client(uuid) to authenticated;

commit;
