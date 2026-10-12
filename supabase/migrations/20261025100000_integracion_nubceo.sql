-- =============================================================================
-- 20261025100000_integracion_nubceo  (ADR-062)
--
-- Integración con NubCeo (conciliación de cobros): cada venta de NinjaPOS viaja
-- a NubCeo con sus pagos (una venta por comprobante, idempotente por
-- `venta_id`), con ritmo y ventana horaria configurables, modo "solo simular",
-- y la importación de los asientos contables que arma NubCeo.
--
-- Piezas:
--   A) Feature OPTIONAL `integracion_nubceo` (Business y Enterprise; también
--      como add-on para un negocio puntual).
--   B) nubceo_settings: configuración por negocio (ambiente, simulación, ritmo,
--      ventana, sucursales, mapeo de campos y medios). Lectura por RLS para
--      dueño y encargado; escritura sólo por RPC.
--   C) nubceo_credentials: API key, secreto y tenant de NubCeo por ambiente.
--      RLS activa SIN policies y sin grants a anon ni authenticated: nadie la
--      lee por PostgREST (sólo service_role en la Edge). Se escribe por RPC.
--   D) nubceo_sync: una fila por venta (o devolución) a mandar, con estado,
--      intentos, último error, payload enviado y su huella. nubceo_runs: el
--      historial de vueltas del sincronizador.
--   E) Asientos contables importados (API o CSV): nubceo_ledger_headers y
--      nubceo_ledger_entries.
--   F) Encolado por trigger: venta completada → pendiente; anulada → excluida
--      (si no se mandó) o borrado en NubCeo (si ya se mandó); devolución en
--      efectivo → nota de crédito. Los triggers NUNCA frenan una venta.
--   G) RPC de la pantalla (dueño o encargado, feature en el plan para escribir).
--   H) RPC del sincronizador (sólo service_role): vencidos, siembra, toma con
--      lease, snapshot de la venta, resultados y cierre de la vuelta.
--
-- El cron (pg_cron + pg_net) que llama a la Edge `nubceo_sync` está en
-- 20261025100100_nubceo_cron.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Feature de plan
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('integracion_nubceo', 'Integración NubCeo',
   'Envío automático de ventas y cobros a NubCeo para conciliarlos, con monitor de envíos e importación de asientos contables',
   'integraciones', false, 215)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('integracion_nubceo', p.key in ('business', 'enterprise')),
  true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'integracion_nubceo');

-- Add-on (para un negocio Pro que lo necesite). Inactivo hasta definir precio:
-- el interno lo puede otorgar igual en subscription_addons.
insert into plan_addons (key, label, description, monthly_price_ars, is_active) values
  ('integracion_nubceo', 'Integración NubCeo',
   'Envío de ventas a NubCeo para conciliar cobros, con asientos contables', 0, false)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- B) Configuración
-- -----------------------------------------------------------------------------
create table if not exists nubceo_settings (
  tenant_id             uuid primary key references tenants(id) on delete cascade,
  enabled               boolean not null default false,
  environment           text not null default 'test' check (environment in ('test', 'prod')),
  simulate              boolean not null default true,
  start_at              timestamptz,
  every_minutes         integer not null default 60
                          check (every_minutes in (5, 15, 30, 60, 120, 360, 720, 1440)),
  window_start          time not null default '00:00',
  window_end            time not null default '00:00',
  window_days           smallint[] not null default '{0,1,2,3,4,5,6}',
  store_ids             uuid[],
  batch_size            integer not null default 100 check (batch_size between 1 and 500),
  max_attempts          integer not null default 8 check (max_attempts between 1 and 20),
  mapping               jsonb not null default '{}'::jsonb check (jsonb_typeof(mapping) = 'object'),
  ledger_auto           boolean not null default false,
  ledger_since          date,
  next_run_at           timestamptz,
  last_run_at           timestamptz,
  last_run_status       text check (last_run_status in ('ok', 'partial', 'error', 'skipped', 'simulated')),
  last_run_message      text,
  last_run_counts       jsonb,
  consecutive_failures  integer not null default 0,
  paused_until          timestamptz,
  ledger_last_import_at timestamptz,
  ledger_last_message   text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  updated_by            uuid references public.users(id) on delete set null
);
create trigger set_updated_at_nubceo_settings before update on nubceo_settings
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- C) Credenciales (ilegibles por PostgREST)
-- -----------------------------------------------------------------------------
create table if not exists nubceo_credentials (
  tenant_id      uuid not null references tenants(id) on delete cascade,
  environment    text not null check (environment in ('test', 'prod')),
  api_url        text check (api_url is null or api_url ~ '^https://([a-z0-9-]+\.)*nubceo\.com(/[A-Za-z0-9/_.-]*)?$'),
  api_key        text not null check (length(api_key) between 1 and 300),
  api_secret     text not null check (length(api_secret) between 1 and 500),
  nubceo_tenant  text not null check (nubceo_tenant ~ '^[A-Za-z0-9_-]{1,40}$'),
  tax_code       text check (tax_code is null or tax_code ~ '^[0-9]{11}$'),
  company_id     text,
  company_name   text,
  verified_at    timestamptz,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.users(id) on delete set null,
  primary key (tenant_id, environment)
);
alter table nubceo_credentials enable row level security;
revoke all on nubceo_credentials from anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Envíos y vueltas
-- -----------------------------------------------------------------------------
create table if not exists nubceo_sync (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  kind               text not null check (kind in ('sale', 'return')),
  sale_id            uuid not null references sales(id) on delete cascade,
  return_id          uuid references sale_returns(id) on delete cascade,
  venta_id           text not null check (length(venta_id) between 1 and 120),
  store_id           uuid references stores(id) on delete set null,
  sale_number        bigint,
  sale_date          timestamptz not null,
  amount             numeric(14,2) not null default 0,
  status             text not null default 'pending'
                       check (status in ('pending', 'sending', 'synced', 'excluded', 'error',
                                         'simulated', 'delete_pending', 'deleted')),
  excluded_by        text check (excluded_by in ('rule', 'user', 'void')),
  excluded_reason    text,
  error_kind         text check (error_kind in ('config', 'validation', 'network', 'credentials', 'exhausted')),
  attempts           integer not null default 0,
  next_attempt_at    timestamptz not null default now(),
  claimed_at         timestamptz,
  void_requested     boolean not null default false,
  last_error         text,
  last_http_status   integer,
  last_response      jsonb,
  payload            jsonb,
  payload_hash       text,
  environment        text check (environment in ('test', 'prod')),
  already_existed    boolean not null default false,
  sent_at            timestamptz,
  synced_at          timestamptz,
  deleted_in_nubceo_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, venta_id),
  check ((kind = 'return') = (return_id is not null))
);
create unique index if not exists nubceo_sync_sale_uq on nubceo_sync (tenant_id, sale_id) where kind = 'sale';
create unique index if not exists nubceo_sync_return_uq on nubceo_sync (tenant_id, return_id) where kind = 'return';
create index if not exists nubceo_sync_queue_idx on nubceo_sync (tenant_id, status, next_attempt_at);
create index if not exists nubceo_sync_date_idx on nubceo_sync (tenant_id, sale_date desc);
create trigger set_updated_at_nubceo_sync before update on nubceo_sync
  for each row execute function set_updated_at();

create table if not exists nubceo_runs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  trigger      text not null default 'cron' check (trigger in ('cron', 'manual')),
  environment  text check (environment in ('test', 'prod')),
  simulate     boolean not null default false,
  status       text not null check (status in ('ok', 'partial', 'error', 'skipped', 'simulated')),
  counts       jsonb not null default '{}'::jsonb,
  message      text
);
create index if not exists nubceo_runs_tenant_idx on nubceo_runs (tenant_id, started_at desc);

-- -----------------------------------------------------------------------------
-- E) Asientos contables
-- -----------------------------------------------------------------------------
create table if not exists nubceo_ledger_headers (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  source            text not null check (source in ('api', 'csv')),
  nubceo_id         text not null check (length(nubceo_id) between 1 and 200),
  number            text,
  company_id        text,
  batch_id          text,
  category          text,
  status            text not null default 'not_confirmed' check (status in ('confirmed', 'not_confirmed')),
  entry_date        date not null,
  currency          text not null default 'ARS',
  total_debit       numeric(16,2) not null default 0,
  total_credit      numeric(16,2) not null default 0,
  deleted_in_nubceo boolean not null default false,
  imported_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, nubceo_id)
);
create index if not exists nubceo_ledger_headers_date_idx on nubceo_ledger_headers (tenant_id, entry_date desc);

create table if not exists nubceo_ledger_entries (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  header_id       uuid not null references nubceo_ledger_headers(id) on delete cascade,
  position        integer not null default 0,
  nubceo_id       text,
  account_code    text,
  account_name    text,
  subaccount_code text,
  subaccount_name text,
  cost_center     text,
  amount          numeric(16,2) not null
);
create index if not exists nubceo_ledger_entries_header_idx on nubceo_ledger_entries (header_id, position);

-- -----------------------------------------------------------------------------
-- RLS: lectura para dueño y encargado del negocio activo (ADR-052:
-- internal_scope(), nunca is_internal()). Sin policies de escritura: todo pasa
-- por RPC SECURITY DEFINER o por la Edge con service_role.
-- -----------------------------------------------------------------------------
create or replace function nubceo_can_view()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(stock_my_role() in ('owner', 'manager'), false);
$$;
revoke all on function nubceo_can_view() from public, anon;
grant execute on function nubceo_can_view() to authenticated;

alter table nubceo_settings enable row level security;
create policy nubceo_settings_select on nubceo_settings for select
  using ((tenant_id = current_tenant_id() and (select nubceo_can_view())) or internal_scope());

alter table nubceo_sync enable row level security;
create policy nubceo_sync_select on nubceo_sync for select
  using ((tenant_id = current_tenant_id() and (select nubceo_can_view())) or internal_scope());

alter table nubceo_runs enable row level security;
create policy nubceo_runs_select on nubceo_runs for select
  using ((tenant_id = current_tenant_id() and (select nubceo_can_view())) or internal_scope());

alter table nubceo_ledger_headers enable row level security;
create policy nubceo_ledger_headers_select on nubceo_ledger_headers for select
  using ((tenant_id = current_tenant_id() and (select nubceo_can_view())) or internal_scope());

alter table nubceo_ledger_entries enable row level security;
create policy nubceo_ledger_entries_select on nubceo_ledger_entries for select
  using ((tenant_id = current_tenant_id() and (select nubceo_can_view())) or internal_scope());

revoke insert, update, delete on nubceo_settings, nubceo_sync, nubceo_runs,
  nubceo_ledger_headers, nubceo_ledger_entries from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Guardas
-- -----------------------------------------------------------------------------
-- Dueño o encargado del negocio activo. p_write exige además la feature.
create or replace function nubceo_assert(p_write boolean default true)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_write and not tenant_has_feature_for(v_tenant, 'integracion_nubceo') then
    raise exception 'feature_not_in_plan: integracion_nubceo';
  end if;
  return v_tenant;
end;
$$;
revoke all on function nubceo_assert(boolean) from public, anon;
grant execute on function nubceo_assert(boolean) to authenticated;

-- Para la Edge (service_role): el usuario del JWT, ¿puede operar NubCeo en ese
-- negocio? null = sí; si no, el código de error.
create or replace function nubceo_edge_guard(p_tenant uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not exists (select 1 from tenant_users
                      where tenant_id = p_tenant and user_id = p_user
                        and status = 'active' and role in ('owner', 'manager')) then 'forbidden'
    when not tenant_has_feature_for(p_tenant, 'integracion_nubceo') then 'feature_not_in_plan'
    else null
  end;
$$;
revoke all on function nubceo_edge_guard(uuid, uuid) from public, anon, authenticated;
grant execute on function nubceo_edge_guard(uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- Id de la venta en NubCeo (llave de idempotencia). Espejo de ventaIdFor()
-- (supabase/functions/_shared/nubceo.ts): prefijo saneado + número o uuid.
-- Una vez encolada, el id de la fila no cambia nunca (renumerar duplicaría la
-- venta en NubCeo).
-- -----------------------------------------------------------------------------
create or replace function nubceo_venta_id(p_mapping jsonb, p_sale_id uuid, p_number bigint)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select left(regexp_replace(coalesce(p_mapping ->> 'saleIdPrefix', 'NP-'), '[^A-Za-z0-9_-]', '', 'g'), 12)
      || case when p_mapping ->> 'saleIdSource' = 'uuid' then p_sale_id::text else p_number::text end;
$$;
revoke all on function nubceo_venta_id(jsonb, uuid, bigint) from public, anon;
grant execute on function nubceo_venta_id(jsonb, uuid, bigint) to authenticated, service_role;

-- Ventana horaria en hora de Argentina (UTC-3 fijo, igual que inWindow() en
-- TS). Inicio = fin: todo el día. Fin < inicio: cruza la medianoche y cuenta
-- el día del inicio de la franja.
create or replace function nubceo_in_window(p_start time, p_end time, p_days smallint[], p_at timestamptz)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_local timestamp := (p_at at time zone 'UTC') - interval '3 hours';
  v_t     time := date_trunc('minute', v_local)::time;
  v_dow   integer := extract(dow from v_local)::integer;
begin
  if p_start = p_end then
    return v_dow = any (p_days);
  end if;
  if p_start < p_end then
    return v_dow = any (p_days) and v_t >= p_start and v_t < p_end;
  end if;
  if v_t >= p_start then
    return v_dow = any (p_days);
  end if;
  if v_t < p_end then
    return ((v_dow + 6) % 7) = any (p_days);
  end if;
  return false;
end;
$$;
revoke all on function nubceo_in_window(time, time, smallint[], timestamptz) from public, anon;
grant execute on function nubceo_in_window(time, time, smallint[], timestamptz) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- F) Encolado
-- -----------------------------------------------------------------------------
create or replace function nubceo_enqueue_sale(p_sale_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale sales%rowtype;
  v_set  nubceo_settings%rowtype;
  v_id   text;
  v_new  uuid;
begin
  select * into v_sale from sales where id = p_sale_id;
  if not found or v_sale.status <> 'completed' then
    return null;
  end if;
  select * into v_set from nubceo_settings where tenant_id = v_sale.tenant_id;
  if not found or not v_set.enabled or v_set.start_at is null or v_sale.created_at < v_set.start_at then
    return null;
  end if;
  if not tenant_has_feature_for(v_sale.tenant_id, 'integracion_nubceo') then
    return null;
  end if;
  if exists (select 1 from nubceo_sync
              where tenant_id = v_sale.tenant_id and kind = 'sale' and sale_id = p_sale_id) then
    return null;
  end if;
  v_id := nubceo_venta_id(v_set.mapping, v_sale.id, v_sale.number);
  -- Un id ya usado (p. ej. por un cambio de prefijo) no se pisa: se le suma
  -- el comienzo del uuid de la venta.
  if exists (select 1 from nubceo_sync where tenant_id = v_sale.tenant_id and venta_id = v_id) then
    v_id := v_id || '-' || left(replace(v_sale.id::text, '-', ''), 8);
  end if;
  insert into nubceo_sync (tenant_id, kind, sale_id, venta_id, store_id, sale_number, sale_date, amount)
  values (v_sale.tenant_id, 'sale', v_sale.id, v_id, v_sale.store_id, v_sale.number, v_sale.created_at, v_sale.total)
  on conflict do nothing
  returning id into v_new;
  return v_new;
end;
$$;
revoke all on function nubceo_enqueue_sale(uuid) from public, anon, authenticated;
grant execute on function nubceo_enqueue_sale(uuid) to service_role;

create or replace function nubceo_enqueue_return(p_return_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ret    sale_returns%rowtype;
  v_sale   sales%rowtype;
  v_set    nubceo_settings%rowtype;
  v_parent text;
  v_new    uuid;
begin
  select * into v_ret from sale_returns where id = p_return_id;
  if not found then
    return null;
  end if;
  select * into v_set from nubceo_settings where tenant_id = v_ret.tenant_id;
  if not found or not v_set.enabled or v_set.start_at is null or v_ret.created_at < v_set.start_at then
    return null;
  end if;
  if coalesce((v_set.mapping ->> 'sendReturns')::boolean, true) = false then
    return null;
  end if;
  if not tenant_has_feature_for(v_ret.tenant_id, 'integracion_nubceo') then
    return null;
  end if;
  select * into v_sale from sales where id = v_ret.sale_id;
  if not found then
    return null;
  end if;
  select venta_id into v_parent from nubceo_sync
   where tenant_id = v_ret.tenant_id and kind = 'sale' and sale_id = v_ret.sale_id;
  v_parent := coalesce(v_parent, nubceo_venta_id(v_set.mapping, v_sale.id, v_sale.number));
  insert into nubceo_sync (tenant_id, kind, sale_id, return_id, venta_id, store_id, sale_number, sale_date, amount)
  values (v_ret.tenant_id, 'return', v_ret.sale_id, v_ret.id, v_parent || '-NC' || v_ret.number,
          v_sale.store_id, v_sale.number, v_ret.created_at, v_ret.total)
  on conflict do nothing
  returning id into v_new;
  return v_new;
end;
$$;
revoke all on function nubceo_enqueue_return(uuid) from public, anon, authenticated;
grant execute on function nubceo_enqueue_return(uuid) to service_role;

-- Venta anulada: si no salió, se excluye; si ya está en NubCeo, se pide el
-- borrado (salvo que el negocio lo apague); si se está mandando, se marca y
-- el sincronizador la borra al confirmar.
create or replace function nubceo_on_void(p_sale_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row  nubceo_sync%rowtype;
  v_send boolean;
begin
  select * into v_row from nubceo_sync where kind = 'sale' and sale_id = p_sale_id for update;
  if not found then
    return;
  end if;
  select coalesce((mapping ->> 'sendVoids')::boolean, true) into v_send
    from nubceo_settings where tenant_id = v_row.tenant_id;
  v_send := coalesce(v_send, true);
  if v_row.status in ('pending', 'error', 'simulated') then
    update nubceo_sync
       set status = 'excluded', excluded_by = 'void', excluded_reason = 'Venta anulada',
           error_kind = null, claimed_at = null
     where id = v_row.id;
  elsif v_row.status = 'sending' then
    update nubceo_sync set void_requested = true where id = v_row.id;
  elsif v_row.status = 'synced' then
    if v_send then
      update nubceo_sync
         set status = 'delete_pending', attempts = 0, next_attempt_at = now(),
             last_error = null, error_kind = null, claimed_at = null
       where id = v_row.id;
    else
      update nubceo_sync
         set last_error = 'Anulada en NinjaPOS: no se borra de NubCeo (apagado en Configuración)'
       where id = v_row.id;
    end if;
  end if;
end;
$$;
revoke all on function nubceo_on_void(uuid) from public, anon, authenticated;
grant execute on function nubceo_on_void(uuid) to service_role;

create or replace function nubceo_sales_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from nubceo_settings where tenant_id = new.tenant_id and enabled) then
    return null;
  end if;
  begin
    if tg_op = 'INSERT' then
      if new.status = 'completed' then
        perform nubceo_enqueue_sale(new.id);
      end if;
    elsif new.status is distinct from old.status then
      if new.status = 'completed' then
        perform nubceo_enqueue_sale(new.id);
      elsif new.status = 'voided' then
        perform nubceo_on_void(new.id);
      end if;
    end if;
  exception when others then
    -- NubCeo nunca frena una venta: la siembra del sincronizador la recupera.
    raise warning 'nubceo_sales_trg: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function nubceo_sales_trg() from public, anon, authenticated;

drop trigger if exists nubceo_sales_sync on sales;
create trigger nubceo_sales_sync
  after insert or update of status on sales
  for each row execute function nubceo_sales_trg();

create or replace function nubceo_returns_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from nubceo_settings where tenant_id = new.tenant_id and enabled) then
    return null;
  end if;
  begin
    if tg_op = 'INSERT' then
      perform nubceo_enqueue_return(new.id);
    elsif new.total is distinct from old.total then
      update nubceo_sync set amount = new.total
       where tenant_id = new.tenant_id and kind = 'return' and return_id = new.id;
    end if;
  exception when others then
    raise warning 'nubceo_returns_trg: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function nubceo_returns_trg() from public, anon, authenticated;

drop trigger if exists nubceo_returns_sync on sale_returns;
create trigger nubceo_returns_sync
  after insert or update of total on sale_returns
  for each row execute function nubceo_returns_trg();

-- -----------------------------------------------------------------------------
-- G) RPC de la pantalla
-- -----------------------------------------------------------------------------
create or replace function nubceo_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(false);
  v_set    jsonb;
  v_creds  jsonb;
begin
  select to_jsonb(s) into v_set from nubceo_settings s where s.tenant_id = v_tenant;
  select coalesce(jsonb_object_agg(c.environment, jsonb_build_object(
           'configured', true,
           'api_key_hint', right(c.api_key, 4),
           'nubceo_tenant', c.nubceo_tenant,
           'tax_code', c.tax_code,
           'api_url', c.api_url,
           'company_id', c.company_id,
           'company_name', c.company_name,
           'verified_at', c.verified_at,
           'updated_at', c.updated_at)), '{}'::jsonb)
    into v_creds
    from nubceo_credentials c
   where c.tenant_id = v_tenant;
  return jsonb_build_object(
    'settings', v_set,
    'credentials', v_creds,
    'feature', tenant_has_feature_for(v_tenant, 'integracion_nubceo'));
end;
$$;
revoke all on function nubceo_settings_get() from public, anon;
grant execute on function nubceo_settings_get() to authenticated;

create or replace function nubceo_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := nubceo_assert(true);
  v_before  nubceo_settings%rowtype;
  v_row     nubceo_settings%rowtype;
  v_days    smallint[];
  v_stores  uuid[];
  v_reset   integer := 0;
  v_was_on  boolean;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'invalid_settings';
  end if;
  insert into nubceo_settings (tenant_id) values (v_tenant) on conflict (tenant_id) do nothing;
  select * into v_before from nubceo_settings where tenant_id = v_tenant for update;
  v_row := v_before;
  v_was_on := v_before.enabled;

  if p ? 'environment' then
    if p ->> 'environment' not in ('test', 'prod') then raise exception 'invalid_environment'; end if;
    v_row.environment := p ->> 'environment';
  end if;
  if p ? 'simulate' then v_row.simulate := coalesce((p ->> 'simulate')::boolean, true); end if;
  if p ? 'enabled' then v_row.enabled := coalesce((p ->> 'enabled')::boolean, false); end if;
  if p ? 'start_at' then
    v_row.start_at := nullif(p ->> 'start_at', '')::timestamptz;
  end if;
  if p ? 'every_minutes' then
    if (p ->> 'every_minutes')::integer not in (5, 15, 30, 60, 120, 360, 720, 1440) then
      raise exception 'invalid_every_minutes';
    end if;
    v_row.every_minutes := (p ->> 'every_minutes')::integer;
  end if;
  if p ? 'window_start' then
    if coalesce(p ->> 'window_start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'invalid_window'; end if;
    v_row.window_start := (p ->> 'window_start')::time;
  end if;
  if p ? 'window_end' then
    if coalesce(p ->> 'window_end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'invalid_window'; end if;
    v_row.window_end := (p ->> 'window_end')::time;
  end if;
  if p ? 'window_days' then
    if jsonb_typeof(p -> 'window_days') <> 'array' then raise exception 'invalid_window_days'; end if;
    select array_agg(distinct d::smallint order by d::smallint) into v_days
      from jsonb_array_elements_text(p -> 'window_days') d;
    if v_days is null or exists (select 1 from unnest(v_days) x where x < 0 or x > 6) then
      raise exception 'invalid_window_days';
    end if;
    v_row.window_days := v_days;
  end if;
  if p ? 'store_ids' then
    if p -> 'store_ids' is null or jsonb_typeof(p -> 'store_ids') = 'null' then
      v_row.store_ids := null;
    else
      if jsonb_typeof(p -> 'store_ids') <> 'array' then raise exception 'invalid_stores'; end if;
      select array_agg(distinct x::uuid) into v_stores from jsonb_array_elements_text(p -> 'store_ids') x;
      if v_stores is null then raise exception 'invalid_stores'; end if;
      if exists (select 1 from unnest(v_stores) sid
                  where not exists (select 1 from stores s
                                     where s.id = sid and s.tenant_id = v_tenant and s.deleted_at is null)) then
        raise exception 'invalid_stores';
      end if;
      v_row.store_ids := v_stores;
    end if;
  end if;
  if p ? 'batch_size' then v_row.batch_size := (p ->> 'batch_size')::integer; end if;
  if p ? 'max_attempts' then v_row.max_attempts := (p ->> 'max_attempts')::integer; end if;
  if p ? 'mapping' then
    if jsonb_typeof(p -> 'mapping') <> 'object' or octet_length((p -> 'mapping')::text) > 65536 then
      raise exception 'invalid_mapping';
    end if;
    if (p -> 'mapping') ? 'saleIdPrefix' and coalesce(p -> 'mapping' ->> 'saleIdPrefix', '') !~ '^[A-Za-z0-9_-]{0,12}$' then
      raise exception 'invalid_mapping: saleIdPrefix';
    end if;
    if (p -> 'mapping') ? 'branchCodes' and jsonb_typeof(p -> 'mapping' -> 'branchCodes') <> 'object' then
      raise exception 'invalid_mapping: branchCodes';
    end if;
    v_row.mapping := p -> 'mapping';
  end if;
  if p ? 'ledger_auto' then v_row.ledger_auto := coalesce((p ->> 'ledger_auto')::boolean, false); end if;
  if p ? 'ledger_since' then v_row.ledger_since := nullif(p ->> 'ledger_since', '')::date; end if;

  -- Envío real: tienen que estar las credenciales del ambiente.
  if v_row.enabled and not v_row.simulate
     and not exists (select 1 from nubceo_credentials where tenant_id = v_tenant and environment = v_row.environment) then
    raise exception 'credentials_missing';
  end if;
  -- Al prender por primera vez sin fecha de inicio: desde ahora (nunca una
  -- avalancha de ventas viejas sin que el dueño lo pida).
  if v_row.enabled and v_row.start_at is null then
    v_row.start_at := now();
  end if;
  if v_row.enabled and not v_was_on then
    v_row.next_run_at := now();
    v_row.consecutive_failures := 0;
    v_row.paused_until := null;
  end if;

  update nubceo_settings set
    enabled = v_row.enabled, environment = v_row.environment, simulate = v_row.simulate,
    start_at = v_row.start_at, every_minutes = v_row.every_minutes,
    window_start = v_row.window_start, window_end = v_row.window_end, window_days = v_row.window_days,
    store_ids = v_row.store_ids, batch_size = v_row.batch_size, max_attempts = v_row.max_attempts,
    mapping = v_row.mapping, ledger_auto = v_row.ledger_auto, ledger_since = v_row.ledger_since,
    next_run_at = v_row.next_run_at, consecutive_failures = v_row.consecutive_failures,
    paused_until = v_row.paused_until, updated_by = auth.uid()
  where tenant_id = v_tenant
  returning * into v_row;

  -- Lo que se excluyó o falló por la configuración vuelve a la cola para
  -- clasificarse con la nueva (nunca lo que ya está en NubCeo).
  update nubceo_sync
     set status = 'pending', excluded_by = null, excluded_reason = null, error_kind = null,
         last_error = null, attempts = 0, next_attempt_at = now(), claimed_at = null
   where tenant_id = v_tenant and synced_at is null
     and ((status = 'excluded' and excluded_by = 'rule') or (status = 'error' and error_kind = 'config'));
  get diagnostics v_reset = row_count;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'nubceo_settings', null, 'nubceo_settings_updated',
          to_jsonb(v_before) - 'last_run_counts', to_jsonb(v_row) - 'last_run_counts');

  return jsonb_build_object('ok', true, 'requeued', v_reset, 'settings', to_jsonb(v_row));
end;
$$;
revoke all on function nubceo_settings_save(jsonb) from public, anon;
grant execute on function nubceo_settings_save(jsonb) to authenticated;

-- Credenciales: el secreto vacío conserva el guardado. Nunca vuelven por RPC.
create or replace function nubceo_credentials_set(
  p_environment   text,
  p_api_key       text,
  p_api_secret    text,
  p_nubceo_tenant text,
  p_tax_code      text default null,
  p_api_url       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(true);
  v_prev   nubceo_credentials%rowtype;
  v_secret text := nullif(btrim(coalesce(p_api_secret, '')), '');
  v_tax    text := nullif(regexp_replace(coalesce(p_tax_code, ''), '[^0-9]', '', 'g'), '');
  v_url    text := nullif(regexp_replace(btrim(coalesce(p_api_url, '')), '/+$', ''), '');
  v_key    text := btrim(coalesce(p_api_key, ''));
  v_nt     text := btrim(coalesce(p_nubceo_tenant, ''));
begin
  if p_environment not in ('test', 'prod') then raise exception 'invalid_environment'; end if;
  if v_key = '' then raise exception 'invalid_api_key'; end if;
  if v_nt !~ '^[A-Za-z0-9_-]{1,40}$' then raise exception 'invalid_nubceo_tenant'; end if;
  if v_tax is not null and v_tax !~ '^[0-9]{11}$' then raise exception 'invalid_tax_code'; end if;
  if v_url is not null and v_url !~ '^https://([a-z0-9-]+\.)*nubceo\.com(/[A-Za-z0-9/_.-]*)?$' then
    raise exception 'invalid_api_url';
  end if;
  select * into v_prev from nubceo_credentials where tenant_id = v_tenant and environment = p_environment;
  if v_secret is null and not found then raise exception 'invalid_api_secret'; end if;

  insert into nubceo_credentials (tenant_id, environment, api_url, api_key, api_secret, nubceo_tenant,
                                  tax_code, updated_by)
  values (v_tenant, p_environment, v_url, v_key, coalesce(v_secret, v_prev.api_secret), v_nt, v_tax, auth.uid())
  on conflict (tenant_id, environment) do update set
    api_url = excluded.api_url,
    api_key = excluded.api_key,
    api_secret = excluded.api_secret,
    nubceo_tenant = excluded.nubceo_tenant,
    tax_code = excluded.tax_code,
    -- Otro tenant u otro CUIT: la compañía hay que volver a buscarla.
    company_id = case when nubceo_credentials.nubceo_tenant = excluded.nubceo_tenant
                       and nubceo_credentials.tax_code is not distinct from excluded.tax_code
                      then nubceo_credentials.company_id end,
    company_name = case when nubceo_credentials.nubceo_tenant = excluded.nubceo_tenant
                         and nubceo_credentials.tax_code is not distinct from excluded.tax_code
                        then nubceo_credentials.company_name end,
    verified_at = null,
    updated_at = now(),
    updated_by = auth.uid();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'nubceo_credentials', null, 'nubceo_credentials_set',
          jsonb_build_object('environment', p_environment, 'api_key_hint', right(v_key, 4),
                             'nubceo_tenant', v_nt, 'tax_code', v_tax, 'api_url', v_url,
                             'secret_changed', v_secret is not null));
  return jsonb_build_object('ok', true, 'environment', p_environment);
end;
$$;
revoke all on function nubceo_credentials_set(text, text, text, text, text, text) from public, anon;
grant execute on function nubceo_credentials_set(text, text, text, text, text, text) to authenticated;

create or replace function nubceo_credentials_clear(p_environment text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(false);
begin
  if p_environment not in ('test', 'prod') then raise exception 'invalid_environment'; end if;
  delete from nubceo_credentials where tenant_id = v_tenant and environment = p_environment;
  -- Sin credenciales no hay envío real en ese ambiente.
  update nubceo_settings set simulate = true
   where tenant_id = v_tenant and environment = p_environment and enabled and not simulate;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'nubceo_credentials', null, 'nubceo_credentials_cleared',
          jsonb_build_object('environment', p_environment));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function nubceo_credentials_clear(text) from public, anon;
grant execute on function nubceo_credentials_clear(text) to authenticated;

-- Reintentar: errores, simuladas o excluidas (no las anuladas) vuelven a la cola.
create or replace function nubceo_retry(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(true);
  v_n      integer;
begin
  update nubceo_sync
     set status = 'pending', attempts = 0, next_attempt_at = now(), error_kind = null,
         last_error = null, excluded_by = null, excluded_reason = null, claimed_at = null
   where tenant_id = v_tenant and id = any (coalesce(p_ids, '{}'))
     and (status in ('error', 'simulated') or (status = 'excluded' and excluded_by is distinct from 'void'));
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'nubceo_sync', null, 'nubceo_retry',
            jsonb_build_object('ids', to_jsonb(p_ids), 'count', v_n));
  end if;
  return v_n;
end;
$$;
revoke all on function nubceo_retry(uuid[]) from public, anon;
grant execute on function nubceo_retry(uuid[]) to authenticated;

-- Reintentar todo lo que está en error (o mandar todo lo simulado) del rango.
create or replace function nubceo_retry_bulk(p_status text, p_from timestamptz, p_to timestamptz)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(true);
  v_n      integer;
begin
  if p_status not in ('error', 'simulated') then raise exception 'invalid_status'; end if;
  update nubceo_sync
     set status = 'pending', attempts = 0, next_attempt_at = now(), error_kind = null,
         last_error = null, claimed_at = null
   where tenant_id = v_tenant and status = p_status
     and sale_date >= coalesce(p_from, '-infinity') and sale_date < coalesce(p_to, 'infinity');
  get diagnostics v_n = row_count;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'nubceo_sync', null, 'nubceo_retry_bulk',
          jsonb_build_object('status', p_status, 'from', p_from, 'to', p_to, 'count', v_n));
  return v_n;
end;
$$;
revoke all on function nubceo_retry_bulk(text, timestamptz, timestamptz) from public, anon;
grant execute on function nubceo_retry_bulk(text, timestamptz, timestamptz) to authenticated;

create or replace function nubceo_exclude(p_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(true);
  v_n      integer;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required'; end if;
  update nubceo_sync
     set status = 'excluded', excluded_by = 'user', excluded_reason = left(btrim(p_reason), 300),
         claimed_at = null, error_kind = null
   where tenant_id = v_tenant and id = any (coalesce(p_ids, '{}'))
     and status in ('pending', 'error', 'simulated');
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
    values (v_tenant, auth.uid(), 'nubceo_sync', null, 'nubceo_exclude', btrim(p_reason),
            jsonb_build_object('ids', to_jsonb(p_ids), 'count', v_n));
  end if;
  return v_n;
end;
$$;
revoke all on function nubceo_exclude(uuid[], text) from public, anon;
grant execute on function nubceo_exclude(uuid[], text) to authenticated;

-- Pedir el borrado en NubCeo de ventas ya mandadas (p. ej. mandadas por error).
create or replace function nubceo_request_delete(p_ids uuid[], p_reason text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(true);
  v_n      integer;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason_required'; end if;
  update nubceo_sync
     set status = 'delete_pending', attempts = 0, next_attempt_at = now(), last_error = null,
         error_kind = null, claimed_at = null
   where tenant_id = v_tenant and id = any (coalesce(p_ids, '{}')) and status = 'synced';
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
    values (v_tenant, auth.uid(), 'nubceo_sync', null, 'nubceo_request_delete', btrim(p_reason),
            jsonb_build_object('ids', to_jsonb(p_ids), 'count', v_n));
  end if;
  return v_n;
end;
$$;
revoke all on function nubceo_request_delete(uuid[], text) from public, anon;
grant execute on function nubceo_request_delete(uuid[], text) to authenticated;

-- Cantidades por estado del rango (pestañas del monitor).
create or replace function nubceo_status_counts(p_from timestamptz, p_to timestamptz, p_store uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(false);
  v_out    jsonb;
begin
  select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) into v_out
    from (select status, count(*) as n from nubceo_sync
           where tenant_id = v_tenant
             and sale_date >= coalesce(p_from, '-infinity') and sale_date < coalesce(p_to, 'infinity')
             and (p_store is null or store_id = p_store)
           group by status) x;
  return v_out;
end;
$$;
revoke all on function nubceo_status_counts(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function nubceo_status_counts(timestamptz, timestamptz, uuid) to authenticated;

-- Totales por día (hora de Argentina): enviadas y su monto (las notas de
-- crédito restan), pendientes, con error y excluidas.
create or replace function nubceo_daily_totals(p_from date, p_to date)
returns table (day date, synced integer, synced_amount numeric, pending integer, errors integer, excluded integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(false);
begin
  return query
  select ((n.sale_date at time zone 'UTC') - interval '3 hours')::date as day,
         count(*) filter (where n.status = 'synced')::integer,
         coalesce(sum(case when n.kind = 'return' then -n.amount else n.amount end)
                    filter (where n.status = 'synced'), 0)::numeric,
         count(*) filter (where n.status in ('pending', 'sending', 'simulated', 'delete_pending'))::integer,
         count(*) filter (where n.status = 'error')::integer,
         count(*) filter (where n.status in ('excluded', 'deleted'))::integer
    from nubceo_sync n
   where n.tenant_id = v_tenant
     and n.sale_date >= (p_from::timestamp + interval '3 hours') at time zone 'UTC'
     and n.sale_date < ((p_to + 1)::timestamp + interval '3 hours') at time zone 'UTC'
   group by 1
   order by 1 desc;
end;
$$;
revoke all on function nubceo_daily_totals(date, date) from public, anon;
grant execute on function nubceo_daily_totals(date, date) to authenticated;

-- Pedir una vuelta ya (el cron la toma en el próximo minuto).
create or replace function nubceo_run_soon()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(true);
begin
  update nubceo_settings set next_run_at = now(), paused_until = null where tenant_id = v_tenant;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function nubceo_run_soon() from public, anon;
grant execute on function nubceo_run_soon() to authenticated;

-- -----------------------------------------------------------------------------
-- Asientos: alta o actualización (API y CSV comparten esta función).
-- p_headers = [{ nubceo_id, number, company_id, batch_id, category, status,
--               date (YYYY-MM-DD), currency, deleted,
--               entries: [{ nubceo_id, account_code, account_name,
--                           subaccount_code, subaccount_name, cost_center, amount }] }]
-- -----------------------------------------------------------------------------
create or replace function nubceo_ledger_upsert(p_tenant uuid, p_headers jsonb, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_h       jsonb;
  v_hid     uuid;
  v_nh      integer := 0;
  v_ne      integer := 0;
  v_skipped integer := 0;
begin
  if p_source not in ('api', 'csv') then raise exception 'invalid_source'; end if;
  if jsonb_typeof(p_headers) <> 'array' then raise exception 'invalid_headers'; end if;
  for v_h in select * from jsonb_array_elements(p_headers)
  loop
    if coalesce(v_h ->> 'nubceo_id', '') = '' or coalesce(v_h ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into nubceo_ledger_headers (tenant_id, source, nubceo_id, number, company_id, batch_id, category,
                                       status, entry_date, currency, deleted_in_nubceo)
    values (p_tenant, p_source, left(v_h ->> 'nubceo_id', 200), left(v_h ->> 'number', 60),
            left(v_h ->> 'company_id', 60), left(v_h ->> 'batch_id', 100), left(v_h ->> 'category', 60),
            case when v_h ->> 'status' = 'confirmed' then 'confirmed' else 'not_confirmed' end,
            (v_h ->> 'date')::date, left(coalesce(nullif(v_h ->> 'currency', ''), 'ARS'), 3),
            coalesce((v_h ->> 'deleted')::boolean, false))
    on conflict (tenant_id, nubceo_id) do update set
      number = excluded.number, company_id = excluded.company_id, batch_id = excluded.batch_id,
      category = excluded.category, status = excluded.status, entry_date = excluded.entry_date,
      currency = excluded.currency, deleted_in_nubceo = excluded.deleted_in_nubceo,
      source = excluded.source, updated_at = now()
    returning id into v_hid;

    delete from nubceo_ledger_entries where header_id = v_hid;
    insert into nubceo_ledger_entries (tenant_id, header_id, position, nubceo_id, account_code, account_name,
                                       subaccount_code, subaccount_name, cost_center, amount)
    select p_tenant, v_hid, e.ord::integer, left(e.v ->> 'nubceo_id', 200), left(e.v ->> 'account_code', 100),
           left(e.v ->> 'account_name', 200), left(e.v ->> 'subaccount_code', 100),
           left(e.v ->> 'subaccount_name', 200), left(e.v ->> 'cost_center', 100),
           round(coalesce((e.v ->> 'amount')::numeric, 0), 2)
      from jsonb_array_elements(coalesce(v_h -> 'entries', '[]'::jsonb)) with ordinality as e(v, ord);
    v_ne := v_ne + jsonb_array_length(coalesce(v_h -> 'entries', '[]'::jsonb));

    update nubceo_ledger_headers h
       set total_debit = coalesce((select sum(amount) from nubceo_ledger_entries where header_id = v_hid and amount > 0), 0),
           total_credit = coalesce((select -sum(amount) from nubceo_ledger_entries where header_id = v_hid and amount < 0), 0)
     where h.id = v_hid;
    v_nh := v_nh + 1;
  end loop;
  return jsonb_build_object('headers', v_nh, 'entries', v_ne, 'skipped', v_skipped);
end;
$$;
revoke all on function nubceo_ledger_upsert(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function nubceo_ledger_upsert(uuid, jsonb, text) to service_role;

-- Importación de la exportación de NubCeo (CSV ya leído en el navegador).
create or replace function nubceo_ledger_import(p_headers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := nubceo_assert(true);
  v_out    jsonb;
begin
  if jsonb_typeof(p_headers) <> 'array' or jsonb_array_length(p_headers) > 5000 then
    raise exception 'invalid_headers';
  end if;
  v_out := nubceo_ledger_upsert(v_tenant, p_headers, 'csv');
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'nubceo_ledger', null, 'nubceo_ledger_import_csv', v_out);
  return v_out;
end;
$$;
revoke all on function nubceo_ledger_import(jsonb) from public, anon;
grant execute on function nubceo_ledger_import(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC del sincronizador (sólo service_role)
-- -----------------------------------------------------------------------------
-- ¿Hay algo que hacer? (el cron no llama a la Edge si no.)
create or replace function nubceo_any_due()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from nubceo_settings s
     where (s.paused_until is null or s.paused_until <= now())
       and ((s.enabled and coalesce(s.next_run_at, '-infinity') <= now())
            or (s.ledger_auto and coalesce(s.ledger_last_import_at, '-infinity') <= now() - interval '6 hours')));
$$;
revoke all on function nubceo_any_due() from public, anon, authenticated;
grant execute on function nubceo_any_due() to service_role;

-- Negocios con vuelta vencida: envío (activo, en ventana) y/o asientos.
create or replace function nubceo_due_tenants(p_limit integer default 20)
returns table (tenant_id uuid, send_due boolean, ledger_due boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select x.tenant_id, x.send_due, x.ledger_due
    from (
      select s.tenant_id,
             (s.enabled and coalesce(s.next_run_at, '-infinity') <= now()
               and nubceo_in_window(s.window_start, s.window_end, s.window_days, now())) as send_due,
             (s.ledger_auto and coalesce(s.ledger_last_import_at, '-infinity') <= now() - interval '6 hours') as ledger_due,
             s.next_run_at
        from nubceo_settings s
       where (s.paused_until is null or s.paused_until <= now())
         and tenant_has_feature_for(s.tenant_id, 'integracion_nubceo')
    ) x
   where x.send_due or x.ledger_due
   order by x.next_run_at nulls first
   limit greatest(1, coalesce(p_limit, 20));
$$;
revoke all on function nubceo_due_tenants(integer) from public, anon, authenticated;
grant execute on function nubceo_due_tenants(integer) to service_role;

-- Red de seguridad del trigger: ventas y devoluciones desde start_at sin fila.
create or replace function nubceo_seed(p_tenant uuid, p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_set nubceo_settings%rowtype;
  v_id  uuid;
  v_n   integer := 0;
begin
  select * into v_set from nubceo_settings where tenant_id = p_tenant;
  if not found or not v_set.enabled or v_set.start_at is null then
    return 0;
  end if;
  for v_id in
    select s.id from sales s
     where s.tenant_id = p_tenant and s.status = 'completed' and s.created_at >= v_set.start_at
       and not exists (select 1 from nubceo_sync n where n.tenant_id = p_tenant and n.kind = 'sale' and n.sale_id = s.id)
     order by s.created_at
     limit greatest(1, coalesce(p_limit, 500))
  loop
    if nubceo_enqueue_sale(v_id) is not null then v_n := v_n + 1; end if;
  end loop;
  for v_id in
    select r.id from sale_returns r
     where r.tenant_id = p_tenant and r.created_at >= v_set.start_at
       and not exists (select 1 from nubceo_sync n where n.tenant_id = p_tenant and n.kind = 'return' and n.return_id = r.id)
     order by r.created_at
     limit greatest(1, coalesce(p_limit, 500))
  loop
    if nubceo_enqueue_return(v_id) is not null then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end;
$$;
revoke all on function nubceo_seed(uuid, integer) from public, anon, authenticated;
grant execute on function nubceo_seed(uuid, integer) to service_role;

-- Toma una tanda con lease de 10 minutos (FOR UPDATE SKIP LOCKED): las
-- pendientes pasan a 'sending'; los borrados pendientes conservan su estado.
create or replace function nubceo_claim(p_tenant uuid, p_limit integer)
returns setof nubceo_sync
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update nubceo_sync set status = 'pending', claimed_at = null
   where tenant_id = p_tenant and status = 'sending' and claimed_at < now() - interval '10 minutes';
  return query
  with c as (
    select n.id from nubceo_sync n
     where n.tenant_id = p_tenant and n.status in ('pending', 'delete_pending')
       and n.next_attempt_at <= now()
       and (n.claimed_at is null or n.claimed_at < now() - interval '10 minutes')
     order by (n.status = 'delete_pending') desc, n.sale_date, n.created_at
     limit greatest(1, least(coalesce(p_limit, 100), 500))
     for update skip locked
  )
  update nubceo_sync n
     set status = case when n.status = 'pending' then 'sending' else n.status end,
         claimed_at = now()
    from c
   where n.id = c.id
  returning n.*;
end;
$$;
revoke all on function nubceo_claim(uuid, integer) from public, anon, authenticated;
grant execute on function nubceo_claim(uuid, integer) to service_role;

-- La venta (o devolución) con todo lo que hace falta para armar el envío.
create or replace function nubceo_snapshots(p_tenant uuid, p_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'sync_id', n.id,
    'kind', n.kind,
    'venta_id', n.venta_id,
    'status', n.status,
    'sale', jsonb_build_object(
      'id', s.id, 'number', s.number, 'created_at', s.created_at, 'status', s.status,
      'total', s.total, 'tax_total', s.tax_total, 'store_id', s.store_id,
      'store_name', st.name, 'register_name', cr.name,
      'cashier_name', coalesce(nullif(u.full_name, ''), u.email),
      'customer_name', c.name, 'customer_doc', c.document_number),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'method', p.method, 'amount', p.amount, 'reference', p.reference,
               'card_voucher', p.card_voucher, 'created_at', p.created_at,
               'provider_key', i.provider_key, 'provider_payment_id', i.mp_payment_id)
             order by p.created_at, p.id)
        from payments p
        left join mp_payment_intents i
          on i.tenant_id = p.tenant_id
         and i.id = case when p.reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         then p.reference::uuid end
       where p.sale_id = s.id), '[]'::jsonb),
    'ret', case when r.id is null then null else jsonb_build_object(
      'id', r.id, 'number', r.number, 'created_at', r.created_at, 'total', r.total,
      'refund_method', r.refund_method) end
  ) order by n.sale_date), '[]'::jsonb)
  from nubceo_sync n
  join sales s on s.id = n.sale_id
  left join stores st on st.id = s.store_id
  left join cash_shifts sh on sh.id = s.cash_shift_id
  left join cash_registers cr on cr.id = sh.cash_register_id
  left join public.users u on u.id = s.created_by
  left join customers c on c.id = s.customer_id
  left join sale_returns r on r.id = n.return_id
  where n.tenant_id = p_tenant and n.id = any (p_ids);
$$;
revoke all on function nubceo_snapshots(uuid, uuid[]) from public, anon, authenticated;
grant execute on function nubceo_snapshots(uuid, uuid[]) to service_role;

-- Resultados de una vuelta, fila por fila (nunca un upsert en lote con
-- claves distintas). Cada elemento:
--   { id, status, payload?, payload_hash?, http_status?, response?, error?,
--     error_kind?, excluded_reason?, attempt (bool), next_attempt_at?,
--     environment?, already (bool), sent (bool) }
-- Una venta confirmada que se anuló mientras se mandaba pasa a borrarse.
create or replace function nubceo_apply_results(p_tenant uuid, p_results jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r  jsonb;
  v_n  integer := 0;
  v_st text;
begin
  if jsonb_typeof(p_results) <> 'array' then raise exception 'invalid_results'; end if;
  for v_r in select * from jsonb_array_elements(p_results)
  loop
    v_st := v_r ->> 'status';
    if v_st not in ('pending', 'synced', 'excluded', 'error', 'simulated', 'delete_pending', 'deleted') then
      continue;
    end if;
    update nubceo_sync n set
      status = case when v_st = 'synced' and n.void_requested then 'delete_pending' else v_st end,
      void_requested = case when v_st = 'synced' then false else n.void_requested end,
      attempts = case when v_st = 'synced' and n.void_requested then 0
                      when coalesce((v_r ->> 'attempt')::boolean, false) then n.attempts + 1
                      else n.attempts end,
      next_attempt_at = coalesce((v_r ->> 'next_attempt_at')::timestamptz, now()),
      claimed_at = null,
      payload = case when v_r ? 'payload' then v_r -> 'payload' else n.payload end,
      payload_hash = coalesce(v_r ->> 'payload_hash', n.payload_hash),
      last_http_status = case when v_r ? 'http_status' then (v_r ->> 'http_status')::integer else n.last_http_status end,
      last_response = case when v_r ? 'response' then v_r -> 'response' else n.last_response end,
      last_error = case when v_st in ('synced', 'simulated', 'deleted') then v_r ->> 'error' else coalesce(v_r ->> 'error', n.last_error) end,
      error_kind = case when v_st = 'error' then coalesce(v_r ->> 'error_kind', 'validation')
                        when v_st = 'pending' then v_r ->> 'error_kind' else null end,
      excluded_by = case when v_st = 'excluded' then 'rule' else n.excluded_by end,
      excluded_reason = case when v_st = 'excluded' then v_r ->> 'excluded_reason' else n.excluded_reason end,
      environment = coalesce(v_r ->> 'environment', n.environment),
      already_existed = case when v_st = 'synced' then coalesce((v_r ->> 'already')::boolean, false) else n.already_existed end,
      sent_at = case when coalesce((v_r ->> 'sent')::boolean, false) then now() else n.sent_at end,
      synced_at = case when v_st = 'synced' then coalesce(n.synced_at, now()) else n.synced_at end,
      deleted_in_nubceo_at = case when v_st = 'deleted' then now() else n.deleted_in_nubceo_at end
    where n.tenant_id = p_tenant and n.id = (v_r ->> 'id')::uuid;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function nubceo_apply_results(uuid, jsonb) from public, anon, authenticated;
grant execute on function nubceo_apply_results(uuid, jsonb) to service_role;

-- Cierre de una vuelta: historial, latido y próxima vuelta. Tres vueltas
-- seguidas sin poder hablar con NubCeo (credenciales o red) → pausa de 30 min.
create or replace function nubceo_finish_run(p_tenant uuid, p_run jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text := p_run ->> 'status';
  v_fail   boolean := coalesce((p_run ->> 'failed')::boolean, false);
  v_every  integer;
begin
  if v_status not in ('ok', 'partial', 'error', 'skipped', 'simulated') then raise exception 'invalid_status'; end if;
  insert into nubceo_runs (tenant_id, started_at, finished_at, trigger, environment, simulate, status, counts, message)
  values (p_tenant, coalesce((p_run ->> 'started_at')::timestamptz, now()), now(),
          case when p_run ->> 'trigger' = 'manual' then 'manual' else 'cron' end,
          p_run ->> 'environment', coalesce((p_run ->> 'simulate')::boolean, false),
          v_status, coalesce(p_run -> 'counts', '{}'::jsonb), left(p_run ->> 'message', 1000));

  select every_minutes into v_every from nubceo_settings where tenant_id = p_tenant;
  update nubceo_settings set
    last_run_at = now(),
    last_run_status = v_status,
    last_run_message = left(p_run ->> 'message', 1000),
    last_run_counts = coalesce(p_run -> 'counts', '{}'::jsonb),
    next_run_at = date_trunc('minute', now()) + make_interval(mins => coalesce(v_every, 60)),
    consecutive_failures = case when v_fail then consecutive_failures + 1 else 0 end,
    paused_until = case when v_fail and consecutive_failures + 1 >= 3 then now() + interval '30 minutes'
                        else paused_until end
  where tenant_id = p_tenant;

  -- Historial acotado: las últimas 500 vueltas por negocio.
  delete from nubceo_runs r
   where r.tenant_id = p_tenant
     and r.id in (select id from nubceo_runs where tenant_id = p_tenant order by started_at desc offset 500);
end;
$$;
revoke all on function nubceo_finish_run(uuid, jsonb) from public, anon, authenticated;
grant execute on function nubceo_finish_run(uuid, jsonb) to service_role;
