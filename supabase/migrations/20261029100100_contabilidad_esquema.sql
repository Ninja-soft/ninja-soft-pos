-- =============================================================================
-- 20261029100100_contabilidad_esquema  (ADR-066 · F18/H109)
--
-- Contabilidad v1, parte 1: esquema, seguridad, plantilla y configuración.
--
--  A) Tablas: acc_settings, acc_accounts (plan de cuentas en árbol),
--     acc_cost_centers (uno por sucursal), acc_mappings (evento → cuenta),
--     acc_periods (cierre mensual), acc_entries + acc_entry_lines (libro
--     diario), acc_issues (eventos que no se pudieron contabilizar).
--  B) RLS: lectura `tenant_id = current_tenant_id() or internal_scope()`
--     (ADR-052) + RESTRICTIVE de dueño o encargado. Sin policies de
--     escritura: todo pasa por RPC SECURITY DEFINER con auditoría.
--  C) Guardas: líneas inmutables, asiento sólo se da de baja lógica, período
--     cerrado bloquea altas y bajas, asiento balanceado al commit.
--  D) Resolución de cuentas (acc_account_for) y centro de costo por sucursal.
--  E) Plantilla argentina comercial (acc_install_template) y acc_setup.
--  F) RPC de plan de cuentas, centros de costo, mapeos y configuración.
--
-- No toca create_sale, close_cash_shift, _pc_complete ni el resolutor de
-- precios: los asientos salen de triggers sobre las tablas existentes
-- (migración siguiente).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tablas
-- -----------------------------------------------------------------------------
create table if not exists acc_settings (
  tenant_id               uuid primary key references tenants(id) on delete cascade,
  enabled                 boolean not null default true,
  template                text not null default 'comercial_ar',
  start_date              date not null default (date_trunc('month', current_date))::date,
  vat_mode                text not null default 'included_rate' check (vat_mode in ('included_rate', 'none')),
  default_vat_rate        numeric(5,2) not null default 21 check (default_vat_rate >= 0 and default_vat_rate <= 100),
  cmv_mode                text not null default 'none' check (cmv_mode in ('none', 'perpetual')),
  fiscal_year_start_month int not null default 1 check (fiscal_year_start_month between 1 and 12),
  export_config           jsonb not null default '{}'::jsonb check (jsonb_typeof(export_config) = 'object'),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  updated_by              uuid default auth.uid()
);
comment on table acc_settings is
  'Contabilidad (ADR-066): configuración por negocio. vat_mode included_rate = IVA incluido en el precio a la alícuota del producto; none = sin IVA (monotributo o exento).';

create table if not exists acc_accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  code          text not null check (code ~ '^[0-9]+(\.[0-9]+)*$' and char_length(code) <= 30),
  name          text not null check (char_length(btrim(name)) between 1 and 120),
  parent_id     uuid references acc_accounts(id) on delete cascade,
  kind          text not null check (kind in ('activo', 'pasivo', 'patrimonio', 'ingreso', 'egreso')),
  imputable     boolean not null default true,
  external_code text check (external_code is null or char_length(external_code) <= 40),
  system_key    text check (system_key is null or system_key ~ '^[a-z0-9_]{2,40}$'),
  is_active     boolean not null default true,
  notes         text check (notes is null or char_length(notes) <= 500),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index if not exists acc_accounts_code_key
  on acc_accounts (tenant_id, code) where deleted_at is null;
create unique index if not exists acc_accounts_system_key
  on acc_accounts (tenant_id, system_key) where system_key is not null and deleted_at is null;
create index if not exists acc_accounts_parent_idx on acc_accounts (parent_id);
comment on table acc_accounts is
  'Plan de cuentas por negocio (ADR-066). kind: activo, pasivo, patrimonio, ingreso (resultado positivo), egreso (resultado negativo). Sólo las imputables reciben asientos. external_code = código en el sistema del estudio.';

create table if not exists acc_cost_centers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  code       text not null check (char_length(btrim(code)) between 1 and 20),
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  store_id   uuid references stores(id) on delete set null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists acc_cost_centers_code_key
  on acc_cost_centers (tenant_id, code) where deleted_at is null;
create unique index if not exists acc_cost_centers_store_key
  on acc_cost_centers (tenant_id, store_id) where store_id is not null and deleted_at is null;

create table if not exists acc_mappings (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  concept    text not null check (concept ~ '^[a-z_]{2,40}$'),
  qualifier  text not null default '*' check (char_length(qualifier) between 1 and 80),
  store_id   uuid references stores(id) on delete cascade,
  account_id uuid not null references acc_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create unique index if not exists acc_mappings_key
  on acc_mappings (tenant_id, concept, qualifier, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid));
comment on table acc_mappings is
  'Reglas evento → cuenta (ADR-066). Se busca de lo más específico a lo general: calificador exacto, "*:proveedor", el medio antes de ":", "*"; en cada nivel primero la de la sucursal.';

create table if not exists acc_periods (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  period        date not null check (extract(day from period) = 1),
  status        text not null default 'open' check (status in ('open', 'closed')),
  closed_at     timestamptz,
  closed_by     uuid,
  reopened_at   timestamptz,
  reopened_by   uuid,
  reopen_reason text check (reopen_reason is null or char_length(reopen_reason) <= 300),
  notes         text check (notes is null or char_length(notes) <= 500),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint acc_periods_key unique (tenant_id, period)
);

create table if not exists acc_entries (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  number          bigint not null,
  official_number bigint,
  entry_date      date not null,
  period          date generated always as ((date_trunc('month', entry_date::timestamp))::date) stored,
  kind            text not null check (kind in ('auto', 'manual', 'reversal', 'opening')),
  source_type     text,
  source_id       uuid,
  source_event    text,
  description     text not null check (char_length(description) between 1 and 300),
  store_id        uuid references stores(id) on delete set null,
  reversal_of     uuid references acc_entries(id) on delete set null,
  reversed_by     uuid references acc_entries(id) on delete set null,
  total           numeric(14,2) not null default 0,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  delete_reason   text,
  constraint acc_entries_number_key unique (tenant_id, number),
  constraint acc_entries_source_check check ((source_type is null) = (source_id is null))
);
create unique index if not exists acc_entries_source_key
  on acc_entries (tenant_id, source_type, source_id, source_event)
  where deleted_at is null and source_type is not null;
create index if not exists acc_entries_date_idx on acc_entries (tenant_id, entry_date) where deleted_at is null;
create index if not exists acc_entries_period_idx on acc_entries (tenant_id, period);
create index if not exists acc_entries_source_idx on acc_entries (source_type, source_id);

create table if not exists acc_entry_lines (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  entry_id       uuid not null references acc_entries(id) on delete cascade,
  line_no        int not null,
  account_id     uuid not null references acc_accounts(id),
  cost_center_id uuid references acc_cost_centers(id) on delete set null,
  debit          numeric(14,2) not null default 0 check (debit >= 0),
  credit         numeric(14,2) not null default 0 check (credit >= 0),
  description    text check (description is null or char_length(description) <= 300),
  created_at     timestamptz not null default now(),
  constraint acc_entry_lines_side check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
);
create index if not exists acc_entry_lines_entry_idx on acc_entry_lines (entry_id);
create index if not exists acc_entry_lines_account_idx on acc_entry_lines (tenant_id, account_id);

create table if not exists acc_issues (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  source_type  text not null,
  source_id    uuid not null,
  message      text not null,
  event_date   date,
  attempts     int not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  dismissed_at timestamptz,
  dismissed_by uuid,
  constraint acc_issues_key unique (tenant_id, source_type, source_id)
);
create index if not exists acc_issues_open_idx on acc_issues (tenant_id) where resolved_at is null and dismissed_at is null;

-- -----------------------------------------------------------------------------
-- B) RLS
-- -----------------------------------------------------------------------------
create or replace function acc_can_read()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select internal_scope() or coalesce(stock_my_role() in ('owner', 'manager'), false);
$$;
revoke all on function acc_can_read() from public, anon;
grant execute on function acc_can_read() to authenticated, service_role;

do $$
declare
  t text;
begin
  foreach t in array array['acc_settings', 'acc_accounts', 'acc_cost_centers', 'acc_mappings',
                           'acc_periods', 'acc_entries', 'acc_entry_lines', 'acc_issues']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('create policy %I on %I for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()))',
                   t || '_select', t);
    execute format('drop policy if exists %I on %I', t || '_role', t);
    execute format('create policy %I on %I as restrictive for select using ((select acc_can_read()))', t || '_role', t);
    execute format('revoke insert, update, delete on %I from anon, authenticated', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- C) Guardas
-- -----------------------------------------------------------------------------
create or replace function acc_period_is_closed(p_tenant uuid, p_date date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from acc_periods
     where tenant_id = p_tenant
       and period = (date_trunc('month', p_date::timestamp))::date
       and status = 'closed'
  );
$$;
revoke all on function acc_period_is_closed(uuid, date) from public, anon, authenticated;

-- El tenant ya no existe: es el borrado en cascada del negocio (tests, baja).
create or replace function acc_tenant_gone(p_tenant uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select not exists (select 1 from tenants where id = p_tenant);
$$;

create or replace function acc_entries_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if acc_period_is_closed(new.tenant_id, new.entry_date) then
      raise exception 'acc_period_closed: %', to_char(new.entry_date, 'MM/YYYY');
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if acc_tenant_gone(old.tenant_id) then
      return old;
    end if;
    raise exception 'acc_entry_immutable';
  end if;
  -- UPDATE: sólo baja lógica, numeración oficial y vínculo de reversión.
  if (new.tenant_id, new.number, new.entry_date, new.kind, new.source_type, new.source_id,
      new.source_event, new.description, new.store_id, new.reversal_of, new.total, new.created_at)
     is distinct from
     (old.tenant_id, old.number, old.entry_date, old.kind, old.source_type, old.source_id,
      old.source_event, old.description, old.store_id, old.reversal_of, old.total, old.created_at) then
    raise exception 'acc_entry_immutable';
  end if;
  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'acc_entry_immutable';
  end if;
  if new.deleted_at is distinct from old.deleted_at and acc_period_is_closed(new.tenant_id, new.entry_date) then
    raise exception 'acc_period_closed: %', to_char(new.entry_date, 'MM/YYYY');
  end if;
  return new;
end;
$$;
drop trigger if exists acc_entries_guard_trg on acc_entries;
create trigger acc_entries_guard_trg
  before insert or update or delete on acc_entries
  for each row execute function acc_entries_guard();

create or replace function acc_lines_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_entry acc_entries%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into v_entry from acc_entries where id = new.entry_id;
    if v_entry.tenant_id is distinct from new.tenant_id then
      raise exception 'acc_line_tenant_mismatch';
    end if;
    if not exists (select 1 from acc_accounts a
                    where a.id = new.account_id and a.tenant_id = new.tenant_id
                      and a.imputable and a.deleted_at is null) then
      raise exception 'acc_account_not_imputable';
    end if;
    if new.cost_center_id is not null
       and not exists (select 1 from acc_cost_centers c where c.id = new.cost_center_id and c.tenant_id = new.tenant_id) then
      raise exception 'acc_cost_center_invalid';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if acc_tenant_gone(old.tenant_id) then
      return old;
    end if;
    raise exception 'acc_entry_immutable';
  end if;
  -- UPDATE: sólo el centro de costo puede quedar en null (baja de la sucursal).
  if (new.entry_id, new.line_no, new.account_id, new.debit, new.credit, new.description, new.tenant_id)
     is distinct from
     (old.entry_id, old.line_no, old.account_id, old.debit, old.credit, old.description, old.tenant_id)
     or (new.cost_center_id is not null and new.cost_center_id is distinct from old.cost_center_id) then
    raise exception 'acc_entry_immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists acc_lines_guard_trg on acc_entry_lines;
create trigger acc_lines_guard_trg
  before insert or update or delete on acc_entry_lines
  for each row execute function acc_lines_guard();

-- Asiento balanceado y con al menos dos renglones, al commit.
create or replace function acc_entry_balance_check()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_d numeric;
  v_c numeric;
  v_n int;
begin
  if tg_table_name = 'acc_entries' then
    v_id := new.id;
  else
    v_id := new.entry_id;
  end if;
  if not exists (select 1 from acc_entries where id = v_id and deleted_at is null) then
    return null;
  end if;
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    into v_d, v_c, v_n
    from acc_entry_lines where entry_id = v_id;
  if v_n < 2 or v_d <> v_c or v_d = 0 then
    raise exception 'acc_entry_unbalanced: debe % haber % renglones %', v_d, v_c, v_n;
  end if;
  return null;
end;
$$;
drop trigger if exists acc_entry_lines_balance_trg on acc_entry_lines;
create constraint trigger acc_entry_lines_balance_trg
  after insert on acc_entry_lines
  deferrable initially deferred
  for each row execute function acc_entry_balance_check();
drop trigger if exists acc_entries_balance_trg on acc_entries;
create constraint trigger acc_entries_balance_trg
  after insert on acc_entries
  deferrable initially deferred
  for each row execute function acc_entry_balance_check();

-- Un período cerrado no se toca: sólo se reabre por RPC.
create or replace function acc_periods_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if acc_tenant_gone(old.tenant_id) then
      return old;
    end if;
    raise exception 'acc_period_immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists acc_periods_guard_trg on acc_periods;
create trigger acc_periods_guard_trg
  before delete on acc_periods
  for each row execute function acc_periods_guard();

-- -----------------------------------------------------------------------------
-- D) Acceso, gating y resolución de cuentas
-- -----------------------------------------------------------------------------
create or replace function acc_assert()
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
  if not tenant_has_feature_for(v_tenant, 'contabilidad') then
    raise exception 'feature_not_in_plan: contabilidad';
  end if;
  return v_tenant;
end;
$$;
revoke all on function acc_assert() from public, anon;
grant execute on function acc_assert() to authenticated;

-- ¿Genera asientos este negocio? Configurado, encendido y con la feature.
create or replace function acc_tenant_active(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from acc_settings s where s.tenant_id = p_tenant and s.enabled)
     and tenant_has_feature_for(p_tenant, 'contabilidad');
$$;
revoke all on function acc_tenant_active(uuid) from public, anon, authenticated;

-- Candidatos de calificador de lo más específico a lo general (espejo:
-- qualifierCandidates en lib/accounting/mappings.ts).
--   'credit:payway' → credit:payway, *:payway, credit, *
--   'cash'          → cash, *
create or replace function acc_qualifier_candidates(p_qualifier text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_qualifier is null or p_qualifier = '' or p_qualifier = '*' then array['*']
    when position(':' in p_qualifier) > 0 then
      array[p_qualifier,
            '*:' || substr(p_qualifier, position(':' in p_qualifier) + 1),
            split_part(p_qualifier, ':', 1),
            '*']
    else array[p_qualifier, '*']
  end;
$$;

create or replace function acc_account_for(p_tenant uuid, p_concept text, p_qualifier text, p_store uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cands text[] := acc_qualifier_candidates(p_qualifier);
  v_account uuid;
begin
  select m.account_id into v_account
    from acc_mappings m
    join acc_accounts a on a.id = m.account_id and a.deleted_at is null
   where m.tenant_id = p_tenant
     and m.concept = p_concept
     and m.qualifier = any (v_cands)
     and (m.store_id is null or m.store_id = p_store)
   order by array_position(v_cands, m.qualifier), (m.store_id is null)
   limit 1;
  if v_account is null then
    raise exception 'acc_mapping_missing: %[%]', p_concept, coalesce(p_qualifier, '*');
  end if;
  if not exists (select 1 from acc_accounts where id = v_account and imputable and is_active) then
    raise exception 'acc_account_not_imputable: %[%]', p_concept, coalesce(p_qualifier, '*');
  end if;
  return v_account;
end;
$$;
revoke all on function acc_account_for(uuid, text, text, uuid) from public, anon, authenticated;

-- Centro de costo de la sucursal (se crea si falta).
create or replace function acc_cost_center_for(p_tenant uuid, p_store uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_name text;
  v_n int;
begin
  if p_store is null then
    return null;
  end if;
  select id into v_id from acc_cost_centers
   where tenant_id = p_tenant and store_id = p_store and deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;
  select name into v_name from stores where id = p_store and tenant_id = p_tenant;
  if v_name is null then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtext('acc_cc:' || p_tenant::text));
  select id into v_id from acc_cost_centers
   where tenant_id = p_tenant and store_id = p_store and deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;
  select count(*) + 1 into v_n from acc_cost_centers where tenant_id = p_tenant;
  loop
    exit when not exists (select 1 from acc_cost_centers
                           where tenant_id = p_tenant and code = 'S' || lpad(v_n::text, 2, '0') and deleted_at is null);
    v_n := v_n + 1;
  end loop;
  insert into acc_cost_centers (tenant_id, code, name, store_id)
  values (p_tenant, 'S' || lpad(v_n::text, 2, '0'), left(v_name, 80), p_store)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function acc_cost_center_for(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- E) Plantilla argentina comercial y alta
-- -----------------------------------------------------------------------------
create or replace function acc_install_template(p_tenant uuid, p_template text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_store record;
begin
  if p_template is distinct from 'comercial_ar' then
    raise exception 'acc_template_unknown';
  end if;
  if exists (select 1 from acc_accounts where tenant_id = p_tenant and deleted_at is null) then
    raise exception 'acc_already_setup';
  end if;

  create temporary table if not exists acc_tpl (code text, name text, kind text, imputable boolean, skey text) on commit drop;
  truncate acc_tpl;
  insert into acc_tpl (code, name, kind, imputable, skey) values
    ('1',             'ACTIVO',                                          'activo', false, null),
    ('1.1',           'Activo corriente',                                'activo', false, null),
    ('1.1.01',        'Caja y bancos',                                   'activo', false, null),
    ('1.1.01.01',     'Caja (cajas del POS)',                            'activo', true,  'caja'),
    ('1.1.01.02',     'Caja general y fondo fijo',                       'activo', true,  'caja_general'),
    ('1.1.01.03',     'Valores a depositar',                             'activo', true,  'valores_a_depositar'),
    ('1.1.01.04',     'Fondos en tránsito',                              'activo', true,  'fondos_transito'),
    ('1.1.01.05',     'Banco cuenta corriente',                          'activo', true,  'banco'),
    ('1.1.01.06',     'Mercado Pago (saldo en cuenta)',                  'activo', true,  'mp_saldo'),
    ('1.1.02',        'Créditos por ventas',                             'activo', false, null),
    ('1.1.02.01',     'Deudores por ventas (cuenta corriente)',          'activo', true,  'deudores'),
    ('1.1.02.02',     'Tarjetas a cobrar',                               'activo', false, null),
    ('1.1.02.02.01',  'Tarjetas a cobrar Payway (Prisma)',               'activo', true,  'tarjetas_payway'),
    ('1.1.02.02.02',  'Tarjetas a cobrar Fiserv (Posnet y Clover)',      'activo', true,  'tarjetas_fiserv'),
    ('1.1.02.02.03',  'Tarjetas a cobrar Getnet',                        'activo', true,  'tarjetas_getnet'),
    ('1.1.02.02.04',  'Tarjetas a cobrar Nave',                          'activo', true,  'tarjetas_nave'),
    ('1.1.02.02.99',  'Tarjetas a cobrar otros adquirentes',             'activo', true,  'tarjetas_otros'),
    ('1.1.02.03',     'Mercado Pago a cobrar (QR, link y Point)',        'activo', true,  'mp_a_cobrar'),
    ('1.1.02.04',     'Otros medios de cobro a cobrar',                  'activo', true,  'otros_a_cobrar'),
    ('1.1.02.05',     'Cheques rechazados a cobrar',                     'activo', true,  'cheques_rechazados'),
    ('1.1.03',        'Créditos fiscales',                               'activo', false, null),
    ('1.1.03.01',     'IVA crédito fiscal',                              'activo', true,  'iva_cf'),
    ('1.1.03.02',     'Percepciones de IVA sufridas',                    'activo', true,  'perc_iva'),
    ('1.1.03.03',     'Percepciones de IIBB sufridas',                   'activo', true,  'perc_iibb'),
    ('1.1.03.04',     'Percepciones de Ganancias sufridas',              'activo', true,  'perc_ganancias'),
    ('1.1.03.05',     'Retenciones e impuestos sufridos en cobros',      'activo', true,  'ret_cobros'),
    ('1.1.04',        'Bienes de cambio',                                'activo', false, null),
    ('1.1.04.01',     'Mercaderías',                                     'activo', true,  'mercaderias'),
    ('1.2',           'Activo no corriente',                             'activo', false, null),
    ('1.2.01',        'Bienes de uso',                                   'activo', false, null),
    ('1.2.01.01',     'Muebles y útiles',                                'activo', true,  'muebles'),
    ('1.2.01.02',     'Instalaciones',                                   'activo', true,  'instalaciones'),
    ('1.2.01.03',     'Equipos de computación',                          'activo', true,  'equipos'),
    ('2',             'PASIVO',                                          'pasivo', false, null),
    ('2.1',           'Pasivo corriente',                                'pasivo', false, null),
    ('2.1.01',        'Deudas comerciales',                              'pasivo', false, null),
    ('2.1.01.01',     'Proveedores',                                     'pasivo', true,  'proveedores'),
    ('2.1.01.02',     'Cheques diferidos a pagar',                       'pasivo', true,  'cheques_diferidos'),
    ('2.1.01.03',     'Tarjeta corporativa a pagar',                     'pasivo', true,  'tarjeta_corporativa'),
    ('2.1.02',        'Deudas fiscales',                                 'pasivo', false, null),
    ('2.1.02.01',     'IVA débito fiscal',                               'pasivo', true,  'iva_df'),
    ('2.1.02.02',     'IVA a pagar',                                     'pasivo', true,  'iva_a_pagar'),
    ('2.1.02.03',     'Ingresos brutos a pagar',                         'pasivo', true,  'iibb_a_pagar'),
    ('2.1.02.04',     'Retenciones de Ganancias a depositar',            'pasivo', true,  'ret_ganancias'),
    ('2.1.02.05',     'Retenciones de IVA a depositar',                  'pasivo', true,  'ret_iva'),
    ('2.1.02.06',     'Retenciones de IIBB a depositar',                 'pasivo', true,  'ret_iibb'),
    ('2.1.02.07',     'Retenciones SUSS a depositar',                    'pasivo', true,  'ret_suss'),
    ('2.1.02.08',     'Otras retenciones a depositar',                   'pasivo', true,  'ret_otras'),
    ('2.1.03',        'Otras deudas',                                    'pasivo', false, null),
    ('2.1.03.01',     'Saldos a favor de clientes',                      'pasivo', true,  'saldos_clientes'),
    ('2.1.03.02',     'Propinas a pagar al personal',                    'pasivo', true,  'propinas'),
    ('2.1.03.03',     'Sueldos y cargas sociales a pagar',               'pasivo', true,  'sueldos_a_pagar'),
    ('3',             'PATRIMONIO NETO',                                 'patrimonio', false, null),
    ('3.1',           'Capital',                                         'patrimonio', true, 'capital'),
    ('3.2',           'Resultados no asignados',                         'patrimonio', true, 'rna'),
    ('3.3',           'Resultado del ejercicio',                         'patrimonio', true, 'resultado_ejercicio'),
    ('4',             'INGRESOS',                                        'ingreso', false, null),
    ('4.1',           'Ventas',                                          'ingreso', false, null),
    ('4.1.01',        'Ventas de mercaderías',                           'ingreso', true,  'ventas'),
    ('4.1.02',        'Devoluciones sobre ventas',                       'ingreso', true,  'devoluciones_ventas'),
    ('4.2',           'Otros ingresos',                                  'ingreso', false, null),
    ('4.2.01',        'Intereses ganados',                               'ingreso', true,  'intereses_ganados'),
    ('4.2.02',        'Sobrantes de caja',                               'ingreso', true,  'sobrante_caja'),
    ('5',             'EGRESOS',                                         'egreso', false, null),
    ('5.1',           'Costo de mercaderías vendidas',                   'egreso', true,  'cmv'),
    ('5.2',           'Gastos de comercialización',                      'egreso', false, null),
    ('5.2.01',        'Comisiones de procesadores de pago',              'egreso', true,  'comisiones_procesadores'),
    ('5.2.02',        'Comisiones y gastos bancarios',                   'egreso', true,  'gastos_bancarios'),
    ('5.2.03',        'Contracargos y devoluciones de procesadores',     'egreso', true,  'contracargos'),
    ('5.2.04',        'Impuesto sobre los ingresos brutos',              'egreso', true,  'iibb'),
    ('5.3',           'Gastos de administración',                        'egreso', false, null),
    ('5.3.01',        'Alquileres',                                      'egreso', true,  'alquileres'),
    ('5.3.02',        'Servicios',                                       'egreso', true,  'servicios'),
    ('5.3.03',        'Sueldos y cargas sociales',                       'egreso', true,  'sueldos'),
    ('5.3.04',        'Honorarios profesionales',                        'egreso', true,  'honorarios'),
    ('5.3.05',        'Gastos varios',                                   'egreso', true,  'gastos_varios'),
    ('5.4',           'Otros egresos',                                   'egreso', false, null),
    ('5.4.01',        'Faltantes de caja',                               'egreso', true,  'faltante_caja'),
    ('5.4.02',        'Ajustes y bonificaciones a clientes',             'egreso', true,  'ajustes_clientes'),
    ('5.4.03',        'Otros tributos',                                  'egreso', true,  'otros_tributos'),
    ('5.4.04',        'Diferencias de redondeo y conciliación',          'egreso', true,  'redondeo');

  for r in select * from acc_tpl order by length(code), code loop
    insert into acc_accounts (tenant_id, code, name, kind, imputable, system_key, parent_id)
    values (p_tenant, r.code, r.name, r.kind, r.imputable, r.skey,
            (select a.id from acc_accounts a
              where a.tenant_id = p_tenant and a.deleted_at is null
                and a.code = regexp_replace(r.code, '\.[0-9]+$', '')
                and r.code like '%.%'));
  end loop;

  create temporary table if not exists acc_tpl_map (concept text, qualifier text, skey text) on commit drop;
  truncate acc_tpl_map;
  insert into acc_tpl_map (concept, qualifier, skey) values
    -- Cobros: medio de pago y, después de ':', el adquirente o proveedor.
    ('cobro', '*',              'otros_a_cobrar'),
    ('cobro', 'cash',           'caja'),
    ('cobro', 'debit',          'tarjetas_otros'),
    ('cobro', 'credit',         'tarjetas_otros'),
    ('cobro', 'qr',             'mp_a_cobrar'),
    ('cobro', 'transfer',       'banco'),
    ('cobro', 'account',        'deudores'),
    ('cobro', 'store_credit',   'saldos_clientes'),
    ('cobro', 'directo',        'otros_a_cobrar'),
    ('cobro', 'other',          'otros_a_cobrar'),
    ('cobro', '*:payway',       'tarjetas_payway'),
    ('cobro', '*:prisma',       'tarjetas_payway'),
    ('cobro', '*:fiserv',       'tarjetas_fiserv'),
    ('cobro', '*:posnet',       'tarjetas_fiserv'),
    ('cobro', '*:getnet',       'tarjetas_getnet'),
    ('cobro', '*:nave',         'tarjetas_nave'),
    ('cobro', '*:mercadopago',  'mp_a_cobrar'),
    -- Ventas
    ('ventas',               '*', 'ventas'),
    ('devoluciones_ventas',  '*', 'devoluciones_ventas'),
    ('iva_df',               '*', 'iva_df'),
    ('propinas',             '*', 'propinas'),
    ('redondeo',             '*', 'redondeo'),
    ('cmv',                  '*', 'cmv'),
    ('mercaderias',          '*', 'mercaderias'),
    -- Cuenta corriente y caja
    ('intereses_cc',         '*', 'intereses_ganados'),
    ('ajustes_cc',           '*', 'ajustes_clientes'),
    ('faltante_caja',        '*', 'faltante_caja'),
    ('sobrante_caja',        '*', 'sobrante_caja'),
    ('caja_movimiento',      '*', 'fondos_transito'),
    -- Compras y pagos
    ('compras',              '*', 'mercaderias'),
    ('iva_cf',               '*', 'iva_cf'),
    ('percepcion', '*',                    'otros_tributos'),
    ('percepcion', 'percepcion_iva',       'perc_iva'),
    ('percepcion', 'percepcion_iibb',      'perc_iibb'),
    ('percepcion', 'percepcion_ganancias', 'perc_ganancias'),
    ('percepcion', 'impuesto_interno',     'mercaderias'),
    ('proveedores',          '*', 'proveedores'),
    ('pago', '*',              'banco'),
    ('pago', 'efectivo',       'caja'),
    ('pago', 'transferencia',  'banco'),
    ('pago', 'deposito',       'banco'),
    ('pago', 'cheque',         'cheques_diferidos'),
    ('pago', 'cheque_propio',  'cheques_diferidos'),
    ('pago', 'echeq',          'cheques_diferidos'),
    ('pago', 'cheque_tercero', 'valores_a_depositar'),
    ('pago', 'tarjeta',        'tarjeta_corporativa'),
    ('retencion_practicada', '*',         'ret_otras'),
    ('retencion_practicada', 'ganancias', 'ret_ganancias'),
    ('retencion_practicada', 'iva',       'ret_iva'),
    ('retencion_practicada', 'iibb',      'ret_iibb'),
    ('retencion_practicada', 'suss',      'ret_suss'),
    -- Tesorería
    ('tesoreria', '*',    'banco'),
    ('tesoreria', 'cash', 'caja_general'),
    ('tesoreria', 'bank', 'banco'),
    ('tesoreria_mov', '*',               'gastos_bancarios'),
    ('tesoreria_mov', 'deposit',         'fondos_transito'),
    ('tesoreria_mov', 'withdrawal',      'fondos_transito'),
    ('tesoreria_mov', 'cheque_deposit',  'valores_a_depositar'),
    ('tesoreria_mov', 'cheque_debit',    'cheques_diferidos'),
    ('tesoreria_mov', 'cheque_rejected', 'cheques_rechazados'),
    -- Procesadores
    ('comision_procesador',   '*', 'comisiones_procesadores'),
    ('impuestos_procesador',  '*', 'ret_cobros'),
    ('acreditacion',          '*', 'banco'),
    ('acreditacion', 'mercadopago', 'mp_saldo'),
    ('diferencia_procesador', '*', 'redondeo'),
    ('contracargos',          '*', 'contracargos');

  insert into acc_mappings (tenant_id, concept, qualifier, account_id)
  select p_tenant, m.concept, m.qualifier, a.id
    from acc_tpl_map m
    join acc_accounts a on a.tenant_id = p_tenant and a.system_key = m.skey and a.deleted_at is null
  on conflict do nothing;

  for v_store in select id from stores where tenant_id = p_tenant and deleted_at is null order by is_default desc, created_at loop
    perform acc_cost_center_for(p_tenant, v_store.id);
  end loop;
end;
$$;
revoke all on function acc_install_template(uuid, text) from public, anon, authenticated;

-- Alta de la contabilidad del negocio (dueño o encargado, con la feature).
--   p: {template?, start_date?, vat_mode?, default_vat_rate?, cmv_mode?, fiscal_year_start_month?}
create or replace function acc_setup(p jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  v_iva text;
  v_vat text;
begin
  select iva_condition into v_iva from tenant_branding where tenant_id = v_tenant;
  v_vat := coalesce(p ->> 'vat_mode',
                    case when coalesce(v_iva, 'responsable_inscripto') = 'responsable_inscripto'
                         then 'included_rate' else 'none' end);
  perform acc_install_template(v_tenant, coalesce(p ->> 'template', 'comercial_ar'));
  insert into acc_settings (tenant_id, enabled, template, start_date, vat_mode, default_vat_rate,
                            cmv_mode, fiscal_year_start_month)
  values (v_tenant, true, coalesce(p ->> 'template', 'comercial_ar'),
          coalesce((p ->> 'start_date')::date, (date_trunc('month', current_date))::date),
          v_vat,
          coalesce((p ->> 'default_vat_rate')::numeric, 21),
          coalesce(p ->> 'cmv_mode', 'none'),
          coalesce((p ->> 'fiscal_year_start_month')::int, 1))
  on conflict (tenant_id) do update
     set enabled = true, template = excluded.template, start_date = excluded.start_date,
         vat_mode = excluded.vat_mode, default_vat_rate = excluded.default_vat_rate,
         cmv_mode = excluded.cmv_mode, fiscal_year_start_month = excluded.fiscal_year_start_month,
         updated_at = now(), updated_by = auth.uid();
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'acc_settings', v_tenant, 'acc_setup', p);
end;
$$;
revoke all on function acc_setup(jsonb) from public, anon;
grant execute on function acc_setup(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Configuración, plan de cuentas, centros de costo y mapeos
-- -----------------------------------------------------------------------------
create or replace function acc_settings_save(p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  v_before jsonb;
begin
  select to_jsonb(s) into v_before from acc_settings s where tenant_id = v_tenant;
  if v_before is null then
    raise exception 'acc_not_setup';
  end if;
  update acc_settings
     set enabled                 = coalesce((p ->> 'enabled')::boolean, enabled),
         start_date              = coalesce((p ->> 'start_date')::date, start_date),
         vat_mode                = coalesce(p ->> 'vat_mode', vat_mode),
         default_vat_rate        = coalesce((p ->> 'default_vat_rate')::numeric, default_vat_rate),
         cmv_mode                = coalesce(p ->> 'cmv_mode', cmv_mode),
         fiscal_year_start_month = coalesce((p ->> 'fiscal_year_start_month')::int, fiscal_year_start_month),
         export_config           = coalesce(p -> 'export_config', export_config),
         updated_at              = now(),
         updated_by              = auth.uid()
   where tenant_id = v_tenant;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'acc_settings', v_tenant, 'acc_settings_saved', v_before,
          (select to_jsonb(s) from acc_settings s where tenant_id = v_tenant));
end;
$$;
revoke all on function acc_settings_save(jsonb) from public, anon;
grant execute on function acc_settings_save(jsonb) to authenticated;

-- Alta o edición de una cuenta.
--   p: {code, name, parent_id?, kind?, imputable?, external_code?, is_active?, notes?}
create or replace function acc_account_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  v_old acc_accounts%rowtype;
  v_parent acc_accounts%rowtype;
  v_code text := btrim(coalesce(p ->> 'code', ''));
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_kind text;
  v_imputable boolean;
  v_id uuid;
  v_has_lines boolean;
begin
  if v_code = '' or v_name = '' then
    raise exception 'acc_account_required';
  end if;
  if nullif(p ->> 'parent_id', '') is not null then
    select * into v_parent from acc_accounts
     where id = (p ->> 'parent_id')::uuid and tenant_id = v_tenant and deleted_at is null;
    if not found then
      raise exception 'acc_parent_not_found';
    end if;
    if v_parent.imputable and exists (select 1 from acc_entry_lines where account_id = v_parent.id) then
      raise exception 'acc_parent_has_entries';
    end if;
    if v_code not like v_parent.code || '.%' then
      raise exception 'acc_code_parent_prefix';
    end if;
  end if;
  v_kind := coalesce(nullif(p ->> 'kind', ''), v_parent.kind);
  if v_kind is null then
    raise exception 'acc_kind_required';
  end if;
  if v_parent.id is not null and v_kind is distinct from v_parent.kind then
    raise exception 'acc_kind_parent_mismatch';
  end if;
  v_imputable := coalesce((p ->> 'imputable')::boolean, true);

  if p_id is null then
    insert into acc_accounts (tenant_id, code, name, parent_id, kind, imputable, external_code, is_active, notes)
    values (v_tenant, v_code, v_name, v_parent.id, v_kind, v_imputable,
            nullif(btrim(coalesce(p ->> 'external_code', '')), ''),
            coalesce((p ->> 'is_active')::boolean, true),
            nullif(btrim(coalesce(p ->> 'notes', '')), ''))
    returning id into v_id;
    -- La madre deja de ser imputable al tener hijas.
    if v_parent.id is not null and v_parent.imputable then
      update acc_accounts set imputable = false, updated_at = now() where id = v_parent.id;
    end if;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'acc_accounts', v_id, 'acc_account_created', p);
    return v_id;
  end if;

  select * into v_old from acc_accounts where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'acc_account_not_found';
  end if;
  if v_parent.id = p_id then
    raise exception 'acc_parent_cycle';
  end if;
  v_has_lines := exists (select 1 from acc_entry_lines where account_id = p_id);
  if v_has_lines and (v_kind is distinct from v_old.kind) then
    raise exception 'acc_account_has_entries';
  end if;
  if not v_imputable and v_has_lines then
    raise exception 'acc_account_has_entries';
  end if;
  if v_imputable and exists (select 1 from acc_accounts where parent_id = p_id and deleted_at is null) then
    raise exception 'acc_account_has_children';
  end if;
  update acc_accounts
     set code = v_code, name = v_name, parent_id = v_parent.id, kind = v_kind, imputable = v_imputable,
         external_code = nullif(btrim(coalesce(p ->> 'external_code', '')), ''),
         is_active = coalesce((p ->> 'is_active')::boolean, is_active),
         notes = nullif(btrim(coalesce(p ->> 'notes', '')), ''),
         updated_at = now()
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'acc_accounts', p_id, 'acc_account_updated', to_jsonb(v_old), p);
  return p_id;
end;
$$;
revoke all on function acc_account_save(uuid, jsonb) from public, anon;
grant execute on function acc_account_save(uuid, jsonb) to authenticated;

-- Baja lógica: sin asientos, sin hijas y sin mapeos que la usen.
create or replace function acc_account_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  v_old acc_accounts%rowtype;
begin
  select * into v_old from acc_accounts where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'acc_account_not_found';
  end if;
  if exists (select 1 from acc_entry_lines where account_id = p_id) then
    raise exception 'acc_account_has_entries';
  end if;
  if exists (select 1 from acc_accounts where parent_id = p_id and deleted_at is null) then
    raise exception 'acc_account_has_children';
  end if;
  if exists (select 1 from acc_mappings where account_id = p_id) then
    raise exception 'acc_account_in_mapping';
  end if;
  update acc_accounts set deleted_at = now(), is_active = false, updated_at = now() where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
  values (v_tenant, auth.uid(), 'acc_accounts', p_id, 'acc_account_deleted', to_jsonb(v_old));
end;
$$;
revoke all on function acc_account_delete(uuid) from public, anon;
grant execute on function acc_account_delete(uuid) to authenticated;

--   p: {code, name, store_id?, is_active?}
create or replace function acc_cost_center_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  v_store uuid := nullif(p ->> 'store_id', '')::uuid;
  v_id uuid;
begin
  if btrim(coalesce(p ->> 'code', '')) = '' or btrim(coalesce(p ->> 'name', '')) = '' then
    raise exception 'acc_cost_center_required';
  end if;
  if v_store is not null and not exists (select 1 from stores where id = v_store and tenant_id = v_tenant) then
    raise exception 'store_not_found';
  end if;
  if p_id is null then
    insert into acc_cost_centers (tenant_id, code, name, store_id, is_active)
    values (v_tenant, btrim(p ->> 'code'), btrim(p ->> 'name'), v_store, coalesce((p ->> 'is_active')::boolean, true))
    returning id into v_id;
  else
    update acc_cost_centers
       set code = btrim(p ->> 'code'), name = btrim(p ->> 'name'), store_id = v_store,
           is_active = coalesce((p ->> 'is_active')::boolean, is_active), updated_at = now()
     where id = p_id and tenant_id = v_tenant and deleted_at is null
    returning id into v_id;
    if v_id is null then
      raise exception 'acc_cost_center_not_found';
    end if;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'acc_cost_centers', v_id, 'acc_cost_center_saved', p);
  return v_id;
end;
$$;
revoke all on function acc_cost_center_save(uuid, jsonb) from public, anon;
grant execute on function acc_cost_center_save(uuid, jsonb) to authenticated;

-- Fija (o cambia) la cuenta de una regla. p_account null = borra la regla
-- (la general "*" sin sucursal no se puede borrar: sólo cambiar).
create or replace function acc_mapping_set(p_concept text, p_qualifier text, p_store uuid, p_account uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := acc_assert();
  v_q text := coalesce(nullif(btrim(p_qualifier), ''), '*');
  v_before uuid;
begin
  if p_concept !~ '^[a-z_]{2,40}$' then
    raise exception 'acc_concept_invalid';
  end if;
  if p_store is not null and not exists (select 1 from stores where id = p_store and tenant_id = v_tenant) then
    raise exception 'store_not_found';
  end if;
  select account_id into v_before from acc_mappings
   where tenant_id = v_tenant and concept = p_concept and qualifier = v_q
     and store_id is not distinct from p_store;
  if p_account is null then
    if v_q = '*' and p_store is null then
      raise exception 'acc_mapping_default_required';
    end if;
    delete from acc_mappings
     where tenant_id = v_tenant and concept = p_concept and qualifier = v_q
       and store_id is not distinct from p_store;
  else
    if not exists (select 1 from acc_accounts
                    where id = p_account and tenant_id = v_tenant and imputable and deleted_at is null) then
      raise exception 'acc_account_not_imputable';
    end if;
    update acc_mappings set account_id = p_account, updated_at = now(), updated_by = auth.uid()
     where tenant_id = v_tenant and concept = p_concept and qualifier = v_q
       and store_id is not distinct from p_store;
    if not found then
      insert into acc_mappings (tenant_id, concept, qualifier, store_id, account_id)
      values (v_tenant, p_concept, v_q, p_store, p_account);
    end if;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'acc_mappings', null, 'acc_mapping_set',
          jsonb_build_object('account_id', v_before),
          jsonb_build_object('concept', p_concept, 'qualifier', v_q, 'store_id', p_store, 'account_id', p_account));
end;
$$;
revoke all on function acc_mapping_set(text, text, uuid, uuid) from public, anon;
grant execute on function acc_mapping_set(text, text, uuid, uuid) to authenticated;
