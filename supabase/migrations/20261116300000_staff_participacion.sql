-- =============================================================================
-- 20261116300000_staff_participacion  (F21 · ADR-121)
--
-- Participación del staff y gastos (spec docs/40-cobranza-saas.md §20; base
-- del reparto = COBRADO NETO del mes, decisión §22 #15).
--
-- Modelo (todo de plataforma, sin tenant_id operativo; RLS con
-- (select internal_scope()), nunca OR is_internal()):
--   · staff_payout_settings      una fila: desde qué mes se liquida, si la casa
--                                absorbe gastos, arrastre de negativos, reserva
--                                de impuestos, tasa de cobro de la proyección,
--                                tolerancia del monto de MP, email al pagar.
--   · staff_members              quiénes participan (con o sin usuario staff).
--   · staff_shares               % sobre el cobrado neto con vigencia (historia;
--                                la suma de un día nunca pasa el 100 %) y % de
--                                gastos opcional (absorbe menos o más gastos).
--   · staff_client_rules         reglas por negocio: +X % (bonus_bp), X % en
--                                este cliente (override_bp), comisión de alta
--                                fija o en % (signup_fixed / signup_bp).
--   · staff_expenses (+ _splits, _exemptions, _period_amounts)
--                                gastos con categoría, proveedor, recurrencia,
--                                fin, moneda, prorrateo en N meses, comprobante
--                                y asignación (proporcional, una persona, casa,
--                                a medida, por cliente; exenciones).
--   · staff_fx_rates             cotización del dólar por mes (carga manual).
--   · staff_adjustments          ajustes manuales por persona y mes.
--   · staff_payout_runs / _items / _lines
--                                liquidación cerrada (inmutable): qué hechos de
--                                plata entraron (un pago o reversa se liquida
--                                una sola vez), la foto del cálculo y la línea
--                                de cada persona.
--   · staff_bank_accounts        cuentas para pagarle a cada persona (CBU/CVU,
--                                alias, banco con logo; una predeterminada).
--   · staff_mp_lookups           operaciones de MP leídas por la Edge (la RPC
--                                de pago toma el detalle de acá, nunca del
--                                navegador).
--   · staff_payout_payments      pagos a cada persona (parciales, baja lógica,
--                                email de acreditación).
--
-- Quién:
--   · super_admin (staff_is_owner): configura, cierra y paga. Ni admin ni el
--     permiso Cobranzas alcanzan.
--   · cada persona: lee sólo SUS filas (participación, reglas, líneas, pagos y
--     cuentas) y puede cargar sus propias cuentas de cobro.
--
-- El cálculo (borrador, proyección y cierre) lo hace el motor TS
-- (supabase/functions/_shared/staff/settlement.ts) en la Edge staff_payouts,
-- que lee los insumos con staff_settlement_inputs (sólo service_role). La RPC
-- de cierre vuelve a calcular en SQL la base y los hechos sin liquidar y
-- verifica el invariante al centavo antes de grabar.
--
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Quién es quién
-- -----------------------------------------------------------------------------
create or replace function staff_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select internal_scope()), false) and internal_level() = 'super_admin';
$$;

-- -----------------------------------------------------------------------------
-- B) Tablas
-- -----------------------------------------------------------------------------
create table if not exists staff_payout_settings (
  id                             boolean primary key default true check (id),
  start_period                   date not null default (date_trunc('month', (now() at time zone 'America/Argentina/Buenos_Aires')))::date
                                   check (extract(day from start_period) = 1),
  house_label                    text not null default 'NinjaSoft',
  house_absorbs_expenses         boolean not null default true,
  negative_carry                 boolean not null default true,
  income_tax_reserve_bp          int not null default 0 check (income_tax_reserve_bp between 0 and 10000),
  projection_collection_rate_bp  int not null default 10000 check (projection_collection_rate_bp between 0 and 10000),
  mp_amount_tolerance_cents      bigint not null default 0 check (mp_amount_tolerance_cents between 0 and 100000),
  notify_on_payment              boolean not null default true,
  updated_at                     timestamptz not null default now(),
  updated_by                     uuid references users(id)
);
insert into staff_payout_settings (id) values (true) on conflict (id) do nothing;

create table if not exists staff_members (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references users(id) on delete restrict,
  display_name  text not null check (length(btrim(display_name)) between 2 and 80),
  email         text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  notes         text check (notes is null or length(notes) <= 500),
  is_active     boolean not null default true,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index if not exists staff_members_user_uidx on staff_members (user_id) where user_id is not null and deleted_at is null;
create index if not exists staff_members_created_by_idx on staff_members (created_by);

create table if not exists staff_shares (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references staff_members(id) on delete restrict,
  share_bp     int not null check (share_bp between 0 and 10000),
  expense_bp   int check (expense_bp is null or expense_bp between 0 and 10000),
  valid_from   date not null,
  valid_to     date,
  reason       text not null check (length(btrim(reason)) between 5 and 500),
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  voided_at    timestamptz,
  voided_by    uuid references users(id),
  void_reason  text,
  constraint staff_shares_range check (valid_to is null or valid_to >= valid_from)
);
create index if not exists staff_shares_member_idx on staff_shares (member_id, valid_from);

create table if not exists staff_client_rules (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references staff_members(id) on delete restrict,
  tenant_id    uuid not null references tenants(id) on delete restrict,
  kind         text not null check (kind in ('bonus_bp', 'override_bp', 'signup_fixed', 'signup_bp')),
  value        bigint not null,
  valid_from   date not null,
  valid_to     date,
  reason       text not null check (length(btrim(reason)) between 5 and 500),
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  voided_at    timestamptz,
  voided_by    uuid references users(id),
  void_reason  text,
  constraint staff_client_rules_range check (valid_to is null or valid_to >= valid_from),
  constraint staff_client_rules_value check (
    case kind
      when 'bonus_bp' then value between 1 and 10000
      when 'override_bp' then value between 0 and 10000
      when 'signup_bp' then value between 1 and 10000
      when 'signup_fixed' then value between 1 and 100000000000
    end
  )
);
create index if not exists staff_client_rules_member_idx on staff_client_rules (member_id);
create index if not exists staff_client_rules_tenant_idx on staff_client_rules (tenant_id);

create table if not exists staff_expenses (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(btrim(name)) between 2 and 120),
  category       text not null check (category in ('servidores', 'dominios', 'servicios', 'sueldos', 'impuestos', 'comisiones', 'otros')),
  vendor         text check (vendor is null or length(vendor) <= 120),
  amount_cents   bigint not null check (amount_cents > 0 and amount_cents <= 100000000000),
  currency       text not null default 'ARS' check (currency in ('ARS', 'USD')),
  recurrence     text not null check (recurrence in ('once', 'monthly', 'yearly', 'every_n_months', 'every_n_days')),
  interval_n     int check (interval_n is null or interval_n between 1 and 366),
  start_date     date not null,
  end_date       date,
  spread_months  int not null default 1 check (spread_months between 1 and 36),
  allocation     text not null default 'proportional' check (allocation in ('proportional', 'single', 'custom', 'house', 'client')),
  member_id      uuid references staff_members(id) on delete restrict,
  tenant_id      uuid references tenants(id) on delete restrict,
  proof_path     text,
  notes          text check (notes is null or length(notes) <= 500),
  created_by     uuid references users(id),
  created_at     timestamptz not null default now(),
  updated_by     uuid references users(id),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint staff_expenses_range check (end_date is null or end_date >= start_date),
  constraint staff_expenses_interval check (recurrence not in ('every_n_months', 'every_n_days') or interval_n is not null),
  constraint staff_expenses_client check (allocation <> 'client' or tenant_id is not null)
);
create index if not exists staff_expenses_member_idx on staff_expenses (member_id);
create index if not exists staff_expenses_tenant_idx on staff_expenses (tenant_id);

create table if not exists staff_expense_splits (
  id          uuid primary key default gen_random_uuid(),
  expense_id  uuid not null references staff_expenses(id) on delete restrict,
  member_id   uuid references staff_members(id) on delete restrict,
  share_bp    int not null check (share_bp between 1 and 10000)
);
create unique index if not exists staff_expense_splits_uidx on staff_expense_splits (expense_id, coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists staff_expense_splits_member_idx on staff_expense_splits (member_id);

create table if not exists staff_expense_exemptions (
  id          uuid primary key default gen_random_uuid(),
  expense_id  uuid not null references staff_expenses(id) on delete restrict,
  member_id   uuid not null references staff_members(id) on delete restrict,
  valid_from  date,
  valid_to    date,
  created_by  uuid references users(id),
  created_at  timestamptz not null default now()
);
create index if not exists staff_expense_exemptions_expense_idx on staff_expense_exemptions (expense_id);
create index if not exists staff_expense_exemptions_member_idx on staff_expense_exemptions (member_id);

create table if not exists staff_expense_period_amounts (
  expense_id    uuid not null references staff_expenses(id) on delete restrict,
  period        date not null check (extract(day from period) = 1),
  amount_cents  bigint not null check (amount_cents >= 0 and amount_cents <= 100000000000),
  note          text,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  primary key (expense_id, period)
);

create table if not exists staff_fx_rates (
  period      date not null check (extract(day from period) = 1),
  currency    text not null default 'USD' check (currency = 'USD'),
  rate        numeric(14, 4) not null check (rate > 0),
  source      text check (source is null or length(source) <= 120),
  updated_by  uuid references users(id),
  updated_at  timestamptz not null default now(),
  primary key (period, currency)
);

create table if not exists staff_payout_runs (
  id                   uuid primary key default gen_random_uuid(),
  period               date not null unique check (extract(day from period) = 1),
  status               text not null default 'closed' check (status in ('closed', 'partially_paid', 'paid')),
  engine               text not null,
  gross_cents          bigint not null,
  fees_cents           bigint not null,
  reversals_cents      bigint not null,
  net_cents            bigint not null,
  reserve_cents        bigint not null,
  distributable_cents  bigint not null,
  expenses_cents       bigint not null,
  to_share_cents       bigint not null,
  house_net_cents      bigint not null,
  house_cash_cents     bigint not null,
  late_net_cents       bigint not null default 0,
  snapshot             jsonb not null,
  notes                text,
  closed_by            uuid references users(id),
  closed_at            timestamptz not null default now()
);
create index if not exists staff_payout_runs_closed_by_idx on staff_payout_runs (closed_by);

create table if not exists staff_adjustments (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references staff_members(id) on delete restrict,
  period        date not null check (extract(day from period) = 1),
  amount_cents  bigint not null check (amount_cents <> 0 and abs(amount_cents) <= 100000000000),
  reason        text not null check (length(btrim(reason)) between 5 and 500),
  run_id        uuid references staff_payout_runs(id) on delete restrict,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  voided_at     timestamptz,
  voided_by     uuid references users(id),
  void_reason   text
);
create index if not exists staff_adjustments_member_idx on staff_adjustments (member_id, period);
create index if not exists staff_adjustments_run_idx on staff_adjustments (run_id);

create table if not exists staff_payout_items (
  source        text not null check (source in ('payment', 'reversal')),
  source_id     uuid not null,
  run_id        uuid not null references staff_payout_runs(id) on delete restrict,
  tenant_id     uuid not null references tenants(id) on delete restrict,
  item_date     date not null,
  amount_cents  bigint not null,
  fee_cents     bigint not null default 0,
  primary key (source, source_id)
);
create index if not exists staff_payout_items_run_idx on staff_payout_items (run_id);
create index if not exists staff_payout_items_tenant_idx on staff_payout_items (tenant_id);

create table if not exists staff_payout_lines (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references staff_payout_runs(id) on delete restrict,
  member_id         uuid not null references staff_members(id) on delete restrict,
  share_bp_end      int not null default 0,
  income_cents      bigint not null,
  signup_cents      bigint not null default 0,
  expense_cents     bigint not null default 0,
  adjustment_cents  bigint not null default 0,
  carry_in_cents    bigint not null default 0,
  net_cents         bigint not null,
  payable_cents     bigint not null check (payable_cents >= 0),
  carry_out_cents   bigint not null default 0 check (carry_out_cents <= 0),
  signup_rule_ids   uuid[] not null default '{}',
  detail            jsonb not null default '{}'::jsonb,
  unique (run_id, member_id)
);
create index if not exists staff_payout_lines_member_idx on staff_payout_lines (member_id);

create table if not exists staff_bank_accounts (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid not null references staff_members(id) on delete restrict,
  bank_slug     text,
  bank_name     text not null check (length(btrim(bank_name)) between 1 and 80),
  holder_name   text not null check (length(btrim(holder_name)) between 2 and 120),
  cuit          text check (cuit is null or cuit ~ '^\d{11}$'),
  cbu           text check (cbu is null or cbu ~ '^\d{22}$'),
  alias         text check (alias is null or alias ~ '^[A-Za-z0-9.\-]{6,20}$'),
  account_type  text not null default 'caja_ahorro' check (account_type in ('caja_ahorro', 'cuenta_corriente', 'cuenta_virtual', 'otra')),
  currency      text not null default 'ARS' check (currency in ('ARS', 'USD')),
  note          text check (note is null or length(note) <= 200),
  is_default    boolean not null default false,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint staff_bank_accounts_target check (cbu is not null or alias is not null)
);
create index if not exists staff_bank_accounts_member_idx on staff_bank_accounts (member_id);
create unique index if not exists staff_bank_accounts_default_uidx on staff_bank_accounts (member_id) where is_default and deleted_at is null;

create table if not exists staff_mp_lookups (
  id            uuid primary key default gen_random_uuid(),
  operation_id  text not null,
  ok            boolean not null,
  summary       jsonb,
  error         text,
  fetched_by    uuid references users(id),
  fetched_at    timestamptz not null default now()
);
create index if not exists staff_mp_lookups_op_idx on staff_mp_lookups (operation_id, fetched_at desc);
create index if not exists staff_mp_lookups_fetched_by_idx on staff_mp_lookups (fetched_by);

create table if not exists staff_payout_payments (
  id                uuid primary key default gen_random_uuid(),
  line_id           uuid not null references staff_payout_lines(id) on delete restrict,
  run_id            uuid not null references staff_payout_runs(id) on delete restrict,
  member_id         uuid not null references staff_members(id) on delete restrict,
  amount_cents      bigint not null check (amount_cents > 0),
  method            text not null check (method in ('transfer', 'mercadopago', 'cash', 'other')),
  paid_on           date not null,
  bank_account_id   uuid references staff_bank_accounts(id) on delete restrict,
  account_snapshot  jsonb,
  reference         text check (reference is null or length(reference) <= 120),
  mp_operation_id   text,
  mp_lookup_id      uuid references staff_mp_lookups(id) on delete restrict,
  mp_summary        jsonb,
  proof_path        text,
  notes             text check (notes is null or length(notes) <= 500),
  notify            boolean not null default true,
  email_queued_at   timestamptz,
  created_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  voided_at         timestamptz,
  voided_by         uuid references users(id),
  void_reason       text,
  constraint staff_payout_payments_mp check (method <> 'mercadopago' or mp_operation_id is not null)
);
create index if not exists staff_payout_payments_line_idx on staff_payout_payments (line_id);
create index if not exists staff_payout_payments_run_idx on staff_payout_payments (run_id);
create index if not exists staff_payout_payments_member_idx on staff_payout_payments (member_id, paid_on desc);
create index if not exists staff_payout_payments_account_idx on staff_payout_payments (bank_account_id);
create index if not exists staff_payout_payments_lookup_idx on staff_payout_payments (mp_lookup_id);
create unique index if not exists staff_payout_payments_mp_uidx on staff_payout_payments (mp_operation_id)
  where mp_operation_id is not null and voided_at is null;

-- -----------------------------------------------------------------------------
-- C) Inmutabilidad (nada de DELETE; lo cerrado no se toca)
-- -----------------------------------------------------------------------------
create or replace function staff_no_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% no se borra: usá la baja lógica', tg_table_name using errcode = '42501';
end;
$$;

create or replace function staff_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% es inmutable: corregí con un ajuste en la próxima liquidación', tg_table_name using errcode = '42501';
end;
$$;

-- Liquidación: sólo cambia el estado de pago.
create or replace function staff_runs_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'staff_payout_runs es inmutable' using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'staff_payout_runs es inmutable: corregí con un ajuste en la próxima liquidación' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Participaciones y reglas: sólo se cierra la vigencia o se anulan.
create or replace function staff_validity_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% no se borra: anulá la fila', tg_table_name using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['valid_to', 'voided_at', 'voided_by', 'void_reason'])
       is distinct from (to_jsonb(old) - array['valid_to', 'voided_at', 'voided_by', 'void_reason']) then
    raise exception '%: sólo se puede cerrar la vigencia o anular', tg_table_name using errcode = '42501';
  end if;
  if old.voided_at is not null then
    raise exception '%: la fila ya está anulada', tg_table_name using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Ajustes: se anulan o los consume una liquidación (run_id), una sola vez.
create or replace function staff_adjustments_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'staff_adjustments no se borra: anulalo' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['run_id', 'voided_at', 'voided_by', 'void_reason'])
       is distinct from (to_jsonb(old) - array['run_id', 'voided_at', 'voided_by', 'void_reason']) then
    raise exception 'staff_adjustments: sólo se anula' using errcode = '42501';
  end if;
  if old.run_id is not null and (new.run_id is distinct from old.run_id or new.voided_at is not null) then
    raise exception 'staff_adjustments: ya entró en una liquidación cerrada' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Pagos: sólo se anulan (con motivo) o se marca el email.
create or replace function staff_payments_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'staff_payout_payments no se borra: anulalo' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason', 'email_queued_at'])
       is distinct from (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason', 'email_queued_at']) then
    raise exception 'staff_payout_payments: sólo se anula' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists staff_payout_runs_guard on staff_payout_runs;
create trigger staff_payout_runs_guard before update or delete on staff_payout_runs
  for each row execute function staff_runs_guard();
drop trigger if exists staff_payout_items_immutable on staff_payout_items;
create trigger staff_payout_items_immutable before update or delete on staff_payout_items
  for each row execute function staff_immutable();
drop trigger if exists staff_payout_lines_immutable on staff_payout_lines;
create trigger staff_payout_lines_immutable before update or delete on staff_payout_lines
  for each row execute function staff_immutable();
drop trigger if exists staff_shares_guard on staff_shares;
create trigger staff_shares_guard before update or delete on staff_shares
  for each row execute function staff_validity_guard();
drop trigger if exists staff_client_rules_guard on staff_client_rules;
create trigger staff_client_rules_guard before update or delete on staff_client_rules
  for each row execute function staff_validity_guard();
drop trigger if exists staff_adjustments_guard on staff_adjustments;
create trigger staff_adjustments_guard before update or delete on staff_adjustments
  for each row execute function staff_adjustments_guard();
drop trigger if exists staff_payout_payments_guard on staff_payout_payments;
create trigger staff_payout_payments_guard before update or delete on staff_payout_payments
  for each row execute function staff_payments_guard();
drop trigger if exists staff_members_no_delete on staff_members;
create trigger staff_members_no_delete before delete on staff_members
  for each row execute function staff_no_delete();
drop trigger if exists staff_expenses_no_delete on staff_expenses;
create trigger staff_expenses_no_delete before delete on staff_expenses
  for each row execute function staff_no_delete();
drop trigger if exists staff_bank_accounts_no_delete on staff_bank_accounts;
create trigger staff_bank_accounts_no_delete before delete on staff_bank_accounts
  for each row execute function staff_no_delete();
drop trigger if exists staff_mp_lookups_immutable on staff_mp_lookups;
create trigger staff_mp_lookups_immutable before update or delete on staff_mp_lookups
  for each row execute function staff_immutable();

-- -----------------------------------------------------------------------------
-- D) RLS: el dueño (super_admin en el panel interno) ve todo; cada persona,
--    sólo lo suyo. Escritura sólo por RPC SECURITY DEFINER.
-- -----------------------------------------------------------------------------
create or replace function staff_my_member_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.id
    from staff_members m
   where m.user_id = auth.uid()
     and m.deleted_at is null
     and coalesce((select internal_scope()), false);
$$;

alter table staff_payout_settings        enable row level security;
alter table staff_members                enable row level security;
alter table staff_shares                 enable row level security;
alter table staff_client_rules           enable row level security;
alter table staff_expenses               enable row level security;
alter table staff_expense_splits         enable row level security;
alter table staff_expense_exemptions     enable row level security;
alter table staff_expense_period_amounts enable row level security;
alter table staff_fx_rates               enable row level security;
alter table staff_payout_runs            enable row level security;
alter table staff_adjustments            enable row level security;
alter table staff_payout_items           enable row level security;
alter table staff_payout_lines           enable row level security;
alter table staff_bank_accounts          enable row level security;
alter table staff_mp_lookups             enable row level security;
alter table staff_payout_payments        enable row level security;

do $rls$
declare
  t text;
begin
  -- Sólo el dueño.
  foreach t in array array['staff_payout_settings', 'staff_expenses', 'staff_expense_splits', 'staff_expense_exemptions',
                           'staff_expense_period_amounts', 'staff_fx_rates', 'staff_payout_runs', 'staff_payout_items',
                           'staff_mp_lookups'] loop
    execute format('drop policy if exists %I on %I', t || '_owner', t);
    execute format('create policy %I on %I for select to authenticated using ((select internal_scope()) and (select staff_is_owner()))',
                   t || '_owner', t);
  end loop;
  -- El dueño o la persona dueña de la fila.
  foreach t in array array['staff_shares', 'staff_client_rules', 'staff_adjustments', 'staff_payout_lines',
                           'staff_bank_accounts', 'staff_payout_payments'] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using ((select internal_scope()) and ((select staff_is_owner()) or member_id in (select staff_my_member_ids())))',
                   t || '_read', t);
  end loop;
end
$rls$;

drop policy if exists staff_members_read on staff_members;
create policy staff_members_read on staff_members for select to authenticated
  using ((select internal_scope()) and ((select staff_is_owner()) or user_id = (select auth.uid())));

revoke all on table staff_payout_settings, staff_members, staff_shares, staff_client_rules, staff_expenses,
  staff_expense_splits, staff_expense_exemptions, staff_expense_period_amounts, staff_fx_rates, staff_payout_runs,
  staff_adjustments, staff_payout_items, staff_payout_lines, staff_bank_accounts, staff_mp_lookups,
  staff_payout_payments from anon;
revoke insert, update, delete, truncate on table staff_payout_settings, staff_members, staff_shares, staff_client_rules,
  staff_expenses, staff_expense_splits, staff_expense_exemptions, staff_expense_period_amounts, staff_fx_rates,
  staff_payout_runs, staff_adjustments, staff_payout_items, staff_payout_lines, staff_bank_accounts, staff_mp_lookups,
  staff_payout_payments from authenticated;
grant select on table staff_payout_settings, staff_members, staff_shares, staff_client_rules, staff_expenses,
  staff_expense_splits, staff_expense_exemptions, staff_expense_period_amounts, staff_fx_rates, staff_payout_runs,
  staff_adjustments, staff_payout_items, staff_payout_lines, staff_bank_accounts, staff_mp_lookups,
  staff_payout_payments to authenticated;

-- -----------------------------------------------------------------------------
-- E) Comprobantes (gastos y pagos): bucket privado. Rutas:
--      expenses/{uuid}.{ext}             sólo el dueño
--      payments/{member_id}/{uuid}.{ext} el dueño sube; la persona lo lee
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('staff-payout-files', 'staff-payout-files', false, 10485760,
        array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "staff_payout_files_read" on storage.objects;
drop policy if exists "staff_payout_files_write" on storage.objects;
create policy "staff_payout_files_read" on storage.objects for select to authenticated
  using (bucket_id = 'staff-payout-files'
         and (select internal_scope())
         and ((select staff_is_owner())
              or ((storage.foldername(name))[1] = 'payments'
                  and (storage.foldername(name))[2] in (select m::text from staff_my_member_ids() m))));
create policy "staff_payout_files_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'staff-payout-files'
              and (select internal_scope())
              and (select staff_is_owner())
              and (storage.foldername(name))[1] in ('expenses', 'payments'));

-- -----------------------------------------------------------------------------
-- F) Helpers
-- -----------------------------------------------------------------------------
create or replace function staff_assert_owner()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not staff_is_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- Último día liquidado (cerrado); null si no hay liquidaciones.
create or replace function staff_locked_until()
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (max(period) + interval '1 month' - interval '1 day')::date from staff_payout_runs;
$$;

create or replace function staff_assert_open(p_day date)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_locked date := staff_locked_until();
begin
  if p_day is null then
    raise exception 'date_required' using errcode = '22023';
  end if;
  if v_locked is not null and p_day <= v_locked then
    raise exception 'period_closed' using errcode = '22023';
  end if;
end;
$$;

-- Primer día en que la suma de participaciones vigentes pasa el 100 % (o null).
create or replace function staff_shares_overflow()
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.day
    from (select distinct valid_from as day from staff_shares where voided_at is null) d
    join staff_shares s
      on s.voided_at is null and s.valid_from <= d.day and (s.valid_to is null or s.valid_to >= d.day)
   group by d.day
  having sum(s.share_bp) > 10000
   order by d.day
   limit 1;
$$;

create or replace function staff_audit(p_entity text, p_id uuid, p_action text, p_before jsonb, p_after jsonb, p_reason text)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (null, auth.uid(), p_entity, p_id, p_action, p_before, p_after, p_reason);
$$;

create or replace function staff_ar_today()
returns date
language sql
stable
set search_path = public, pg_temp
as $$ select (now() at time zone 'America/Argentina/Buenos_Aires')::date $$;

-- -----------------------------------------------------------------------------
-- G) Configuración, personas, participaciones y reglas (super_admin)
-- -----------------------------------------------------------------------------
create or replace function internal_staff_access()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'is_staff', coalesce((select internal_scope()), false),
    'is_owner', staff_is_owner(),
    'member_ids', coalesce((select jsonb_agg(x) from staff_my_member_ids() x), '[]'::jsonb),
    'locked_until', staff_locked_until());
$$;

create or replace function internal_staff_save_settings(p jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
  v_start  date := nullif(p ->> 'start_period', '')::date;
begin
  perform staff_assert_owner();
  select to_jsonb(s) into v_before from staff_payout_settings s where id;
  if v_start is not null then
    v_start := date_trunc('month', v_start)::date;
    if exists (select 1 from staff_payout_runs) and v_start is distinct from (v_before ->> 'start_period')::date then
      raise exception 'start_period_locked' using errcode = '22023';
    end if;
  end if;
  update staff_payout_settings
     set start_period = coalesce(v_start, start_period),
         house_label = coalesce(nullif(btrim(p ->> 'house_label'), ''), house_label),
         house_absorbs_expenses = coalesce((p ->> 'house_absorbs_expenses')::boolean, house_absorbs_expenses),
         negative_carry = coalesce((p ->> 'negative_carry')::boolean, negative_carry),
         income_tax_reserve_bp = coalesce((p ->> 'income_tax_reserve_bp')::int, income_tax_reserve_bp),
         projection_collection_rate_bp = coalesce((p ->> 'projection_collection_rate_bp')::int, projection_collection_rate_bp),
         mp_amount_tolerance_cents = coalesce((p ->> 'mp_amount_tolerance_cents')::bigint, mp_amount_tolerance_cents),
         notify_on_payment = coalesce((p ->> 'notify_on_payment')::boolean, notify_on_payment),
         updated_at = now(),
         updated_by = auth.uid()
   where id;
  perform staff_audit('staff_payout_settings', null, 'staff_settings_saved', v_before,
                      (select to_jsonb(s) from staff_payout_settings s where id), v_reason);
end;
$$;

create or replace function internal_staff_save_member(
  p_id           uuid,
  p_user_id      uuid,
  p_display_name text,
  p_email        text,
  p_notes        text,
  p_is_active    boolean,
  p_reason       text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
  v_id     uuid := p_id;
  v_email  text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  perform staff_assert_owner();
  if p_user_id is not null and not exists (select 1 from users where id = p_user_id and internal_level is not null) then
    raise exception 'user_not_staff' using errcode = '22023';
  end if;
  if v_email is null and p_user_id is not null then
    select lower(email) into v_email from users where id = p_user_id;
  end if;
  if v_id is null then
    insert into staff_members (user_id, display_name, email, notes, is_active, created_by)
    values (p_user_id, btrim(p_display_name), v_email, nullif(btrim(coalesce(p_notes, '')), ''), coalesce(p_is_active, true), auth.uid())
    returning id into v_id;
  else
    select to_jsonb(m) into v_before from staff_members m where id = v_id and deleted_at is null;
    if v_before is null then
      raise exception 'member_not_found' using errcode = 'P0002';
    end if;
    update staff_members
       set user_id = p_user_id, display_name = btrim(p_display_name), email = v_email,
           notes = nullif(btrim(coalesce(p_notes, '')), ''), is_active = coalesce(p_is_active, is_active), updated_at = now()
     where id = v_id;
  end if;
  perform staff_audit('staff_member', v_id, case when v_before is null then 'staff_member_created' else 'staff_member_updated' end,
                      v_before, (select to_jsonb(m) from staff_members m where id = v_id), v_reason);
  return v_id;
end;
$$;

-- Nueva participación desde una fecha: cierra la vigente el día anterior,
-- anula las programadas desde esa fecha y abre la nueva. share 0 sin % de
-- gastos = deja de participar desde esa fecha.
create or replace function internal_staff_set_share(
  p_member     uuid,
  p_share_bp   int,
  p_expense_bp int,
  p_valid_from date,
  p_reason     text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
  v_id     uuid;
  v_over   date;
begin
  perform staff_assert_owner();
  perform staff_assert_open(p_valid_from);
  if not exists (select 1 from staff_members where id = p_member and deleted_at is null) then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  if p_share_bp is null or p_share_bp < 0 or p_share_bp > 10000 or (p_expense_bp is not null and (p_expense_bp < 0 or p_expense_bp > 10000)) then
    raise exception 'invalid_share' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('staff_shares', 0));
  select coalesce(jsonb_agg(to_jsonb(s) order by s.valid_from), '[]'::jsonb) into v_before
    from staff_shares s where s.member_id = p_member and s.voided_at is null;

  update staff_shares
     set voided_at = now(), voided_by = auth.uid(), void_reason = 'Reemplazada: ' || v_reason
   where member_id = p_member and voided_at is null and valid_from >= p_valid_from;
  update staff_shares
     set valid_to = p_valid_from - 1
   where member_id = p_member and voided_at is null and valid_from < p_valid_from
     and (valid_to is null or valid_to >= p_valid_from);

  if p_share_bp > 0 or coalesce(p_expense_bp, 0) > 0 then
    insert into staff_shares (member_id, share_bp, expense_bp, valid_from, reason, created_by)
    values (p_member, p_share_bp, p_expense_bp, p_valid_from, v_reason, auth.uid())
    returning id into v_id;
  end if;

  v_over := staff_shares_overflow();
  if v_over is not null then
    raise exception 'shares_over_100:%', v_over using errcode = '22023';
  end if;
  perform staff_audit('staff_share', coalesce(v_id, p_member), 'staff_share_set', v_before,
                      jsonb_build_object('member_id', p_member, 'share_bp', p_share_bp, 'expense_bp', p_expense_bp, 'valid_from', p_valid_from),
                      v_reason);
  return v_id;
end;
$$;

create or replace function internal_staff_save_rule(
  p_member     uuid,
  p_tenant     uuid,
  p_kind       text,
  p_value      bigint,
  p_valid_from date,
  p_valid_to   date,
  p_reason     text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_id     uuid;
begin
  perform staff_assert_owner();
  perform staff_assert_open(p_valid_from);
  if not exists (select 1 from staff_members where id = p_member and deleted_at is null) then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  if p_kind in ('bonus_bp', 'override_bp') and exists (
       select 1 from staff_client_rules r
        where r.member_id = p_member and r.tenant_id = p_tenant and r.voided_at is null
          and r.kind in ('bonus_bp', 'override_bp')
          and r.valid_from <= coalesce(p_valid_to, 'infinity'::date)
          and coalesce(r.valid_to, 'infinity'::date) >= p_valid_from) then
    raise exception 'rule_overlap' using errcode = '23505';
  end if;
  if p_kind in ('signup_fixed', 'signup_bp') and exists (
       select 1 from staff_client_rules r
        where r.member_id = p_member and r.tenant_id = p_tenant and r.voided_at is null
          and r.kind in ('signup_fixed', 'signup_bp')) then
    raise exception 'signup_exists' using errcode = '23505';
  end if;
  insert into staff_client_rules (member_id, tenant_id, kind, value, valid_from, valid_to, reason, created_by)
  values (p_member, p_tenant, p_kind, p_value, p_valid_from, p_valid_to, v_reason, auth.uid())
  returning id into v_id;
  perform staff_audit('staff_client_rule', v_id, 'staff_rule_created', null,
                      (select to_jsonb(r) from staff_client_rules r where id = v_id), v_reason);
  return v_id;
end;
$$;

-- Termina una regla (desde un día abierto) o la anula si no empezó.
create or replace function internal_staff_end_rule(p_id uuid, p_end date, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_rule   staff_client_rules%rowtype;
begin
  perform staff_assert_owner();
  select * into v_rule from staff_client_rules where id = p_id and voided_at is null;
  if not found then
    raise exception 'rule_not_found' using errcode = 'P0002';
  end if;
  if p_end is null or p_end < v_rule.valid_from then
    perform staff_assert_open(v_rule.valid_from);
    update staff_client_rules set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = p_id;
  else
    perform staff_assert_open(p_end);
    update staff_client_rules set valid_to = p_end where id = p_id;
  end if;
  perform staff_audit('staff_client_rule', p_id, 'staff_rule_ended', to_jsonb(v_rule),
                      (select to_jsonb(r) from staff_client_rules r where id = p_id), v_reason);
end;
$$;

-- -----------------------------------------------------------------------------
-- H) Gastos, cotizaciones y ajustes (super_admin)
-- -----------------------------------------------------------------------------
create or replace function internal_staff_save_expense(p_id uuid, p jsonb, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
  v_id     uuid := p_id;
  v_alloc  text := coalesce(p ->> 'allocation', 'proportional');
  v_sum    int;
  v_x      jsonb;
begin
  perform staff_assert_owner();
  if v_alloc = 'single' and nullif(p ->> 'member_id', '') is not null
     and not exists (select 1 from staff_members where id = (p ->> 'member_id')::uuid and deleted_at is null) then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  if v_alloc = 'custom' then
    select coalesce(sum((x ->> 'share_bp')::int), 0) into v_sum from jsonb_array_elements(coalesce(p -> 'custom', '[]'::jsonb)) x;
    if v_sum <> 10000 then
      raise exception 'custom_must_sum_100' using errcode = '22023';
    end if;
  end if;

  if v_id is null then
    insert into staff_expenses (name, category, vendor, amount_cents, currency, recurrence, interval_n, start_date, end_date,
                                spread_months, allocation, member_id, tenant_id, proof_path, notes, created_by, updated_by)
    values (btrim(p ->> 'name'), p ->> 'category', nullif(btrim(coalesce(p ->> 'vendor', '')), ''), (p ->> 'amount_cents')::bigint,
            coalesce(p ->> 'currency', 'ARS'), p ->> 'recurrence', nullif(p ->> 'interval_n', '')::int, (p ->> 'start_date')::date,
            nullif(p ->> 'end_date', '')::date, coalesce(nullif(p ->> 'spread_months', '')::int, 1), v_alloc,
            case when v_alloc = 'single' then nullif(p ->> 'member_id', '')::uuid end,
            nullif(p ->> 'tenant_id', '')::uuid, nullif(p ->> 'proof_path', ''), nullif(btrim(coalesce(p ->> 'notes', '')), ''),
            auth.uid(), auth.uid())
    returning id into v_id;
  else
    select to_jsonb(e) into v_before from staff_expenses e where id = v_id and deleted_at is null;
    if v_before is null then
      raise exception 'expense_not_found' using errcode = 'P0002';
    end if;
    update staff_expenses
       set name = btrim(p ->> 'name'), category = p ->> 'category', vendor = nullif(btrim(coalesce(p ->> 'vendor', '')), ''),
           amount_cents = (p ->> 'amount_cents')::bigint, currency = coalesce(p ->> 'currency', 'ARS'), recurrence = p ->> 'recurrence',
           interval_n = nullif(p ->> 'interval_n', '')::int, start_date = (p ->> 'start_date')::date,
           end_date = nullif(p ->> 'end_date', '')::date, spread_months = coalesce(nullif(p ->> 'spread_months', '')::int, 1),
           allocation = v_alloc, member_id = case when v_alloc = 'single' then nullif(p ->> 'member_id', '')::uuid end,
           tenant_id = nullif(p ->> 'tenant_id', '')::uuid,
           proof_path = coalesce(nullif(p ->> 'proof_path', ''), proof_path),
           notes = nullif(btrim(coalesce(p ->> 'notes', '')), ''), updated_by = auth.uid(), updated_at = now()
     where id = v_id;
    delete from staff_expense_splits where expense_id = v_id;
    delete from staff_expense_exemptions where expense_id = v_id;
  end if;

  if v_alloc = 'custom' then
    for v_x in select * from jsonb_array_elements(coalesce(p -> 'custom', '[]'::jsonb)) loop
      insert into staff_expense_splits (expense_id, member_id, share_bp)
      values (v_id, nullif(v_x ->> 'member_id', '')::uuid, (v_x ->> 'share_bp')::int);
    end loop;
  end if;
  for v_x in select * from jsonb_array_elements(coalesce(p -> 'exemptions', '[]'::jsonb)) loop
    insert into staff_expense_exemptions (expense_id, member_id, valid_from, valid_to, created_by)
    values (v_id, (v_x ->> 'member_id')::uuid, nullif(v_x ->> 'valid_from', '')::date, nullif(v_x ->> 'valid_to', '')::date, auth.uid());
  end loop;

  perform staff_audit('staff_expense', v_id, case when v_before is null then 'staff_expense_created' else 'staff_expense_updated' end,
                      v_before, (select to_jsonb(e) from staff_expenses e where id = v_id) || jsonb_build_object('custom', p -> 'custom', 'exemptions', p -> 'exemptions'),
                      v_reason);
  return v_id;
end;
$$;

create or replace function internal_staff_delete_expense(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
begin
  perform staff_assert_owner();
  select to_jsonb(e) into v_before from staff_expenses e where id = p_id and deleted_at is null;
  if v_before is null then
    raise exception 'expense_not_found' using errcode = 'P0002';
  end if;
  update staff_expenses set deleted_at = now(), updated_by = auth.uid(), updated_at = now() where id = p_id;
  perform staff_audit('staff_expense', p_id, 'staff_expense_deleted', v_before, null, v_reason);
end;
$$;

-- Monto de un mes puntual (en la moneda del gasto; 0 = ese mes no hubo).
-- p_amount_cents null = vuelve al monto habitual.
create or replace function internal_staff_set_expense_month(p_expense uuid, p_period date, p_amount_cents bigint, p_note text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period date := date_trunc('month', p_period)::date;
  v_before jsonb;
begin
  perform staff_assert_owner();
  perform staff_assert_open((v_period + interval '1 month' - interval '1 day')::date);
  if not exists (select 1 from staff_expenses where id = p_expense and deleted_at is null) then
    raise exception 'expense_not_found' using errcode = 'P0002';
  end if;
  select to_jsonb(x) into v_before from staff_expense_period_amounts x where expense_id = p_expense and period = v_period;
  if p_amount_cents is null then
    delete from staff_expense_period_amounts where expense_id = p_expense and period = v_period;
  else
    insert into staff_expense_period_amounts (expense_id, period, amount_cents, note, created_by)
    values (p_expense, v_period, p_amount_cents, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
    on conflict (expense_id, period) do update
      set amount_cents = excluded.amount_cents, note = excluded.note, created_by = excluded.created_by, created_at = now();
  end if;
  perform staff_audit('staff_expense', p_expense, 'staff_expense_month_set', v_before,
                      jsonb_build_object('period', v_period, 'amount_cents', p_amount_cents), coalesce(nullif(btrim(p_note), ''), 'Monto del mes'));
end;
$$;

create or replace function internal_staff_set_fx(p_period date, p_rate numeric, p_source text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period date := date_trunc('month', p_period)::date;
  v_before jsonb;
begin
  perform staff_assert_owner();
  if p_rate is null or p_rate <= 0 or p_rate > 1000000 then
    raise exception 'invalid_rate' using errcode = '22023';
  end if;
  select to_jsonb(f) into v_before from staff_fx_rates f where period = v_period and currency = 'USD';
  insert into staff_fx_rates (period, currency, rate, source, updated_by)
  values (v_period, 'USD', round(p_rate, 4), nullif(btrim(coalesce(p_source, '')), ''), auth.uid())
  on conflict (period, currency) do update
    set rate = excluded.rate, source = excluded.source, updated_by = excluded.updated_by, updated_at = now();
  perform staff_audit('staff_fx_rate', null, 'staff_fx_set', v_before,
                      jsonb_build_object('period', v_period, 'rate', round(p_rate, 4), 'source', p_source), 'Cotización del dólar');
end;
$$;

create or replace function internal_staff_add_adjustment(p_member uuid, p_period date, p_amount_cents bigint, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_period date := date_trunc('month', p_period)::date;
  v_id     uuid;
begin
  perform staff_assert_owner();
  perform staff_assert_open(v_period);
  if not exists (select 1 from staff_members where id = p_member and deleted_at is null) then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  insert into staff_adjustments (member_id, period, amount_cents, reason, created_by)
  values (p_member, v_period, p_amount_cents, v_reason, auth.uid())
  returning id into v_id;
  perform staff_audit('staff_adjustment', v_id, 'staff_adjustment_added', null,
                      jsonb_build_object('member_id', p_member, 'period', v_period, 'amount_cents', p_amount_cents), v_reason);
  return v_id;
end;
$$;

create or replace function internal_staff_void_adjustment(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
begin
  perform staff_assert_owner();
  update staff_adjustments set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
   where id = p_id and voided_at is null and run_id is null;
  if not found then
    raise exception 'adjustment_not_voidable' using errcode = '22023';
  end if;
  perform staff_audit('staff_adjustment', p_id, 'staff_adjustment_voided', null, null, v_reason);
end;
$$;

-- -----------------------------------------------------------------------------
-- I) Cuentas de cobro de cada persona (el dueño o la propia persona)
-- -----------------------------------------------------------------------------
create or replace function internal_staff_save_bank_account(p_id uuid, p_member uuid, p jsonb, p_is_default boolean)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id     uuid := p_id;
  v_before jsonb;
  v_cbu    text := nullif(regexp_replace(coalesce(p ->> 'cbu', ''), '\D', '', 'g'), '');
  v_cuit   text := nullif(regexp_replace(coalesce(p ->> 'cuit', ''), '\D', '', 'g'), '');
  v_alias  text := nullif(btrim(coalesce(p ->> 'alias', '')), '');
  v_first  boolean;
begin
  if not (staff_is_owner() or p_member in (select staff_my_member_ids())) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_cbu is not null and not cbu_is_valid(v_cbu) then
    raise exception 'invalid_cbu' using errcode = '22023';
  end if;
  if v_cuit is not null and not cuit_is_valid(v_cuit) then
    raise exception 'invalid_cuit' using errcode = '22023';
  end if;
  if v_cbu is null and v_alias is null then
    raise exception 'cbu_or_alias_required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('staff_bank_accounts:' || p_member::text, 0));
  v_first := not exists (select 1 from staff_bank_accounts where member_id = p_member and deleted_at is null and id is distinct from v_id);
  if coalesce(p_is_default, false) or v_first then
    update staff_bank_accounts set is_default = false, updated_at = now()
     where member_id = p_member and is_default and deleted_at is null and id is distinct from v_id;
  end if;
  if v_id is null then
    insert into staff_bank_accounts (member_id, bank_slug, bank_name, holder_name, cuit, cbu, alias, account_type, currency, note,
                                     is_default, created_by)
    values (p_member, nullif(p ->> 'bank_slug', ''), btrim(p ->> 'bank_name'), btrim(p ->> 'holder_name'), v_cuit, v_cbu, v_alias,
            coalesce(p ->> 'account_type', 'caja_ahorro'), coalesce(p ->> 'currency', 'ARS'), nullif(btrim(coalesce(p ->> 'note', '')), ''),
            coalesce(p_is_default, false) or v_first, auth.uid())
    returning id into v_id;
  else
    select to_jsonb(a) into v_before from staff_bank_accounts a where id = v_id and member_id = p_member and deleted_at is null;
    if v_before is null then
      raise exception 'account_not_found' using errcode = 'P0002';
    end if;
    update staff_bank_accounts
       set bank_slug = nullif(p ->> 'bank_slug', ''), bank_name = btrim(p ->> 'bank_name'), holder_name = btrim(p ->> 'holder_name'),
           cuit = v_cuit, cbu = v_cbu, alias = v_alias, account_type = coalesce(p ->> 'account_type', 'caja_ahorro'),
           currency = coalesce(p ->> 'currency', 'ARS'), note = nullif(btrim(coalesce(p ->> 'note', '')), ''),
           is_default = case when coalesce(p_is_default, false) or v_first then true else is_default end, updated_at = now()
     where id = v_id;
  end if;
  perform staff_audit('staff_bank_account', v_id, case when v_before is null then 'staff_bank_account_created' else 'staff_bank_account_updated' end,
                      v_before, (select to_jsonb(a) from staff_bank_accounts a where id = v_id), 'Cuenta de cobro del staff');
  return v_id;
end;
$$;

create or replace function internal_staff_delete_bank_account(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc staff_bank_accounts%rowtype;
begin
  select * into v_acc from staff_bank_accounts where id = p_id and deleted_at is null;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0002';
  end if;
  if not (staff_is_owner() or v_acc.member_id in (select staff_my_member_ids())) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update staff_bank_accounts set deleted_at = now(), is_default = false, updated_at = now() where id = p_id;
  -- Si era la predeterminada, pasa a la más nueva que quede.
  if v_acc.is_default then
    update staff_bank_accounts set is_default = true, updated_at = now()
     where id = (select id from staff_bank_accounts where member_id = v_acc.member_id and deleted_at is null
                  order by created_at desc limit 1);
  end if;
  perform staff_audit('staff_bank_account', p_id, 'staff_bank_account_deleted', to_jsonb(v_acc), null, 'Cuenta de cobro del staff');
end;
$$;

-- -----------------------------------------------------------------------------
-- J) Insumos del cálculo (sólo service_role: los lee la Edge staff_payouts)
-- -----------------------------------------------------------------------------
-- Hechos de plata sin liquidar hasta el fin del período: pagos (aprobados
-- alguna vez) y reversas (reintegro o contracargo) desde el mes de inicio.
-- Los negocios de prueba no cuentan. Una reversa de un pago anterior al inicio
-- tampoco (ese pago nunca se repartió).
create or replace function staff_unliquidated_items(p_period date)
returns table (source text, source_id uuid, tenant_id uuid, tenant_name text, item_date date, amount_cents bigint, fee_cents bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with cfg as (
    select s.start_period, (date_trunc('month', p_period) + interval '1 month' - interval '1 day')::date as last_day
      from staff_payout_settings s where s.id
  )
  select 'payment'::text, p.id, p.tenant_id, t.name, platform_ar_date(p.paid_at), p.amount_cents, coalesce(p.fee_cents, 0)
    from platform_payments p
    join tenants t on t.id = p.tenant_id
    cross join cfg
   where p.status in ('approved', 'refunded', 'partially_refunded', 'charged_back', 'in_dispute')
     and not t.is_test
     and platform_ar_date(p.paid_at) between cfg.start_period and cfg.last_day
     and not exists (select 1 from staff_payout_items i where i.source = 'payment' and i.source_id = p.id)
  union all
  select 'reversal'::text, l.id, l.tenant_id, t.name, l.effective_date, -l.amount_cents, 0::bigint
    from platform_ledger l
    join platform_payments p on p.id = l.payment_id
    join tenants t on t.id = l.tenant_id
    cross join cfg
   where l.kind in ('refund', 'payment_reversal')
     and not t.is_test
     and l.effective_date between cfg.start_period and cfg.last_day
     and platform_ar_date(p.paid_at) >= cfg.start_period
     and not exists (select 1 from staff_payout_items i where i.source = 'reversal' and i.source_id = l.id);
$$;

-- Lo que se espera cobrar en el mes p_period (proyección): suscripciones que
-- se cobran (no excluidas), activas o en mora, sin baja programada antes. El
-- mensual cuenta una vez; el anual, sólo si renueva dentro del mes.
create or replace function staff_projection_tenants(p_period date)
returns table (tenant_id uuid, tenant_name text, expected_cents bigint, cycle text, due_date date)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with m as (
    select date_trunc('month', p_period)::date as d0,
           (date_trunc('month', p_period) + interval '1 month' - interval '1 day')::date as d1
  ), subs as (
    select s.tenant_id, t.name, s.billing_cycle,
           platform_ar_date(coalesce(s.current_period_end, now())) as renews,
           s.cancel_at_period_end
      from subscriptions s
      join tenants t on t.id = s.tenant_id
     where s.status in ('active', 'past_due')
       and platform_billing_exclusion(s.tenant_id) is null
  ), due as (
    select x.*,
           case
             when x.billing_cycle = 'yearly' then x.renews
             else (m.d0 + (least(extract(day from x.renews)::int, extract(day from m.d1)::int) - 1))::date
           end as due_day
      from subs x cross join m
  )
  select d.tenant_id, d.name,
         platform_cents((platform_billing_breakdown(d.tenant_id, m.d0) ->> 'total')::numeric),
         d.billing_cycle, d.due_day
    from due d cross join m
   where (d.billing_cycle <> 'yearly' or d.due_day between m.d0 and m.d1)
     and not (d.cancel_at_period_end and d.renews <= m.d1);
$$;

create or replace function staff_settlement_inputs(p_period date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_period date := date_trunc('month', p_period)::date;
  v_next   date := (date_trunc('month', p_period) + interval '1 month')::date;
  v_prev   date := (date_trunc('month', p_period) - interval '1 month')::date;
  v_set    staff_payout_settings%rowtype;
  v_fee_bp int;
begin
  select * into v_set from staff_payout_settings where id;
  select case when coalesce(sum(amount_cents), 0) > 0
              then round(coalesce(sum(fee_cents), 0) * 10000.0 / sum(amount_cents))::int else 0 end
    into v_fee_bp
    from platform_payments
   where fee_cents is not null and status = 'approved' and paid_at >= now() - interval '90 days';

  return jsonb_build_object(
    'period', v_period,
    'settings', jsonb_build_object(
      'start_period', v_set.start_period, 'house_label', v_set.house_label,
      'houseAbsorbsExpenses', v_set.house_absorbs_expenses, 'negativeCarry', v_set.negative_carry,
      'incomeTaxReserveBp', v_set.income_tax_reserve_bp, 'collectionRateBp', v_set.projection_collection_rate_bp,
      'mpToleranceCents', v_set.mp_amount_tolerance_cents),
    'locked_until', staff_locked_until(),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.display_name, 'user_id', m.user_id, 'email', m.email)
                                          order by m.created_at)
                           from staff_members m where m.deleted_at is null), '[]'::jsonb),
    'shares', coalesce((select jsonb_agg(jsonb_build_object('member_id', s.member_id, 'share_bp', s.share_bp, 'expense_bp', s.expense_bp,
                                                            'valid_from', s.valid_from, 'valid_to', s.valid_to) order by s.valid_from)
                          from staff_shares s where s.voided_at is null), '[]'::jsonb),
    'clientRules', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'member_id', r.member_id, 'tenant_id', r.tenant_id,
                                                                 'kind', r.kind, 'value', r.value, 'valid_from', r.valid_from, 'valid_to', r.valid_to))
                               from staff_client_rules r where r.voided_at is null), '[]'::jsonb),
    'appliedSignupRuleIds', coalesce((select jsonb_agg(distinct x) from staff_payout_lines l, unnest(l.signup_rule_ids) x), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('source', i.source, 'id', i.source_id, 'tenant_id', i.tenant_id,
                                                           'tenant_name', i.tenant_name, 'date', i.item_date,
                                                           'amount_cents', i.amount_cents, 'fee_cents', i.fee_cents)
                                        order by i.item_date)
                         from staff_unliquidated_items(v_period) i), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object(
                             'id', e.id, 'name', e.name, 'category', e.category, 'vendor', e.vendor, 'amount_cents', e.amount_cents,
                             'currency', e.currency, 'recurrence', e.recurrence, 'interval_n', e.interval_n, 'start_date', e.start_date,
                             'end_date', e.end_date, 'spread_months', e.spread_months, 'allocation', e.allocation,
                             'member_id', e.member_id, 'tenant_id', e.tenant_id,
                             'custom', coalesce((select jsonb_agg(jsonb_build_object('member_id', x.member_id, 'share_bp', x.share_bp))
                                                   from staff_expense_splits x where x.expense_id = e.id), '[]'::jsonb),
                             'exemptions', coalesce((select jsonb_agg(jsonb_build_object('member_id', x.member_id, 'valid_from', x.valid_from,
                                                                                         'valid_to', x.valid_to))
                                                       from staff_expense_exemptions x where x.expense_id = e.id), '[]'::jsonb),
                             'period_amounts', coalesce((select jsonb_agg(jsonb_build_object('period', x.period, 'amount_cents', x.amount_cents))
                                                           from staff_expense_period_amounts x where x.expense_id = e.id), '[]'::jsonb))
                           order by e.created_at)
                            from staff_expenses e where e.deleted_at is null), '[]'::jsonb),
    'fxRates', coalesce((select jsonb_agg(jsonb_build_object('period', f.period, 'currency', f.currency, 'rate', f.rate)) from staff_fx_rates f), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'member_id', a.member_id, 'amount_cents', a.amount_cents,
                                                                 'reason', a.reason, 'period', a.period))
                               from staff_adjustments a
                              where a.voided_at is null and a.run_id is null and a.period <= v_period), '[]'::jsonb),
    'carryIn', coalesce((select jsonb_agg(jsonb_build_object('member_id', l.member_id, 'amount_cents', l.carry_out_cents))
                           from staff_payout_lines l join staff_payout_runs r on r.id = l.run_id
                          where r.period = v_prev and l.carry_out_cents < 0), '[]'::jsonb),
    'projection', jsonb_build_object(
      'period', v_next,
      'collection_rate_bp', v_set.projection_collection_rate_bp,
      'fee_rate_bp', coalesce(v_fee_bp, 0),
      'tenants', coalesce((select jsonb_agg(jsonb_build_object('tenant_id', x.tenant_id, 'tenant_name', x.tenant_name,
                                                               'expected_cents', x.expected_cents, 'cycle', x.cycle, 'due_date', x.due_date))
                             from staff_projection_tenants(v_next) x), '[]'::jsonb))
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- K) Cierre de la liquidación (super_admin). Recibe el resultado del motor
--    (calculado por la Edge) y verifica en SQL: período terminado y en orden,
--    los hechos sin liquidar son EXACTAMENTE los del resultado, la base
--    coincide, el arrastre y los ajustes coinciden, y personas + casa =
--    a repartir − gastos al centavo. Después es inmutable.
-- -----------------------------------------------------------------------------
create or replace function internal_staff_close_run(p_period date, p_result jsonb, p_notes text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period   date := date_trunc('month', p_period)::date;
  v_set      staff_payout_settings%rowtype;
  v_run      uuid;
  v_base     jsonb := p_result -> 'base';
  v_house    jsonb := p_result -> 'house';
  v_cnt_sql  int;
  v_cnt_res  int;
  v_missing  int;
  v_gross    bigint;
  v_fees     bigint;
  v_revs     bigint;
  v_sum      bigint;
  v_adj_sql  bigint;
  v_adj_res  bigint;
  v_l        jsonb;
begin
  perform staff_assert_owner();
  select * into v_set from staff_payout_settings where id;
  perform pg_advisory_xact_lock(hashtextextended('staff_payout_runs', 0));

  if v_period < v_set.start_period then
    raise exception 'before_start_period' using errcode = '22023';
  end if;
  if v_period >= date_trunc('month', staff_ar_today())::date then
    raise exception 'period_not_finished' using errcode = '22023';
  end if;
  if exists (select 1 from staff_payout_runs where period = v_period) then
    raise exception 'run_exists' using errcode = '23505';
  end if;
  if v_period > v_set.start_period
     and not exists (select 1 from staff_payout_runs where period = (v_period - interval '1 month')::date) then
    raise exception 'previous_period_open' using errcode = '22023';
  end if;
  if coalesce(jsonb_array_length(p_result -> 'errors'), 0) > 0 then
    raise exception 'result_has_errors' using errcode = '22023';
  end if;
  if (p_result ->> 'period')::date is distinct from v_period then
    raise exception 'period_mismatch' using errcode = '22023';
  end if;

  -- Hechos de plata: los mismos, ni uno más ni uno menos.
  select count(*) into v_cnt_sql from staff_unliquidated_items(v_period);
  v_cnt_res := coalesce(jsonb_array_length(p_result -> 'item_ids'), 0);
  select count(*) into v_missing
    from staff_unliquidated_items(v_period) i
   where not exists (select 1 from jsonb_array_elements(p_result -> 'item_ids') x
                      where x ->> 'source' = i.source and (x ->> 'id')::uuid = i.source_id);
  if v_cnt_sql <> v_cnt_res or v_missing > 0 then
    raise exception 'items_changed' using errcode = '40001';
  end if;
  select coalesce(sum(amount_cents) filter (where amount_cents > 0), 0),
         coalesce(sum(fee_cents) filter (where amount_cents > 0), 0),
         coalesce(-sum(amount_cents) filter (where amount_cents < 0), 0)
    into v_gross, v_fees, v_revs
    from staff_unliquidated_items(v_period);
  if v_gross <> (v_base ->> 'gross_cents')::bigint or v_fees <> (v_base ->> 'fees_cents')::bigint
     or v_revs <> (v_base ->> 'reversals_cents')::bigint
     or (v_base ->> 'net_cents')::bigint <> v_gross - v_fees - v_revs
     or (v_base ->> 'distributable_cents')::bigint + (v_base ->> 'reserve_cents')::bigint <> (v_base ->> 'net_cents')::bigint then
    raise exception 'base_mismatch' using errcode = '22023';
  end if;
  if (p_result ->> 'to_share_cents')::bigint <> (v_base ->> 'distributable_cents')::bigint - (p_result ->> 'expenses_cents')::bigint then
    raise exception 'to_share_mismatch' using errcode = '22023';
  end if;

  -- Personas + casa = a repartir, al centavo; cada línea coherente.
  select coalesce(sum((l ->> 'net_cents')::bigint), 0) into v_sum from jsonb_array_elements(p_result -> 'lines') l;
  if v_sum + (v_house ->> 'net_cents')::bigint <> (p_result ->> 'to_share_cents')::bigint then
    raise exception 'invariant_failed' using errcode = '22023';
  end if;
  for v_l in select * from jsonb_array_elements(p_result -> 'lines') loop
    if not exists (select 1 from staff_members where id = (v_l ->> 'member_id')::uuid) then
      raise exception 'member_not_found' using errcode = 'P0002';
    end if;
    if (v_l ->> 'net_cents')::bigint <> (v_l ->> 'income_cents')::bigint + (v_l ->> 'signup_cents')::bigint
         - (v_l ->> 'expense_cents')::bigint + (v_l ->> 'adjustment_cents')::bigint + (v_l ->> 'carry_in_cents')::bigint
       or (v_l ->> 'payable_cents')::bigint <> greatest((v_l ->> 'net_cents')::bigint, 0)
       or (v_l ->> 'carry_out_cents')::bigint <> (case when v_set.negative_carry then least((v_l ->> 'net_cents')::bigint, 0) else 0 end)
       or (v_l ->> 'carry_in_cents')::bigint <> coalesce((select l.carry_out_cents from staff_payout_lines l join staff_payout_runs r on r.id = l.run_id
                                                           where r.period = (v_period - interval '1 month')::date
                                                             and l.member_id = (v_l ->> 'member_id')::uuid), 0) then
      raise exception 'line_mismatch:%', v_l ->> 'member_id' using errcode = '22023';
    end if;
  end loop;
  -- Todo saldo negativo del mes anterior tiene que entrar (aunque la persona ya no esté).
  if coalesce((select sum(l.carry_out_cents) from staff_payout_lines l join staff_payout_runs r on r.id = l.run_id
                where r.period = (v_period - interval '1 month')::date), 0)
     <> coalesce((select sum((l ->> 'carry_in_cents')::bigint) from jsonb_array_elements(p_result -> 'lines') l), 0) then
    raise exception 'carry_mismatch' using errcode = '22023';
  end if;
  select coalesce(sum(amount_cents), 0) into v_adj_sql
    from staff_adjustments where voided_at is null and run_id is null and period <= v_period;
  select coalesce(sum((l ->> 'adjustment_cents')::bigint), 0) into v_adj_res from jsonb_array_elements(p_result -> 'lines') l;
  if v_adj_sql <> v_adj_res then
    raise exception 'adjustments_changed' using errcode = '40001';
  end if;

  insert into staff_payout_runs (period, engine, gross_cents, fees_cents, reversals_cents, net_cents, reserve_cents, distributable_cents,
                                 expenses_cents, to_share_cents, house_net_cents, house_cash_cents, late_net_cents, snapshot, notes, closed_by)
  values (v_period, coalesce(p_result ->> 'engine', 'staff-settlement'), v_gross, v_fees, v_revs, v_gross - v_fees - v_revs,
          (v_base ->> 'reserve_cents')::bigint, (v_base ->> 'distributable_cents')::bigint, (p_result ->> 'expenses_cents')::bigint,
          (p_result ->> 'to_share_cents')::bigint, (v_house ->> 'net_cents')::bigint, (v_house ->> 'cash_cents')::bigint,
          coalesce((v_base ->> 'late_net_cents')::bigint, 0), p_result, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_run;

  insert into staff_payout_items (source, source_id, run_id, tenant_id, item_date, amount_cents, fee_cents)
  select i.source, i.source_id, v_run, i.tenant_id, i.item_date, i.amount_cents, i.fee_cents
    from staff_unliquidated_items(v_period) i;

  insert into staff_payout_lines (run_id, member_id, share_bp_end, income_cents, signup_cents, expense_cents, adjustment_cents,
                                  carry_in_cents, net_cents, payable_cents, carry_out_cents, signup_rule_ids, detail)
  select v_run, (l ->> 'member_id')::uuid, coalesce((l ->> 'share_bp_end')::int, 0), (l ->> 'income_cents')::bigint,
         (l ->> 'signup_cents')::bigint, (l ->> 'expense_cents')::bigint, (l ->> 'adjustment_cents')::bigint,
         (l ->> 'carry_in_cents')::bigint, (l ->> 'net_cents')::bigint, (l ->> 'payable_cents')::bigint,
         (l ->> 'carry_out_cents')::bigint,
         coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(l -> 'signup_rule_ids') x), '{}'),
         jsonb_build_object('name', l ->> 'name', 'share_bp_start', l -> 'share_bp_start', 'expense_bp_end', l -> 'expense_bp_end',
                            'by_tenant', l -> 'by_tenant', 'by_expense', l -> 'by_expense')
    from jsonb_array_elements(p_result -> 'lines') l;

  update staff_adjustments set run_id = v_run where voided_at is null and run_id is null and period <= v_period;

  -- Si nadie tiene nada para cobrar, queda pagada.
  if not exists (select 1 from staff_payout_lines where run_id = v_run and payable_cents > 0) then
    update staff_payout_runs set status = 'paid' where id = v_run;
  end if;

  perform staff_audit('staff_payout_run', v_run, 'staff_run_closed', null,
                      jsonb_build_object('period', v_period, 'net_cents', v_gross - v_fees - v_revs,
                                         'expenses_cents', (p_result ->> 'expenses_cents')::bigint,
                                         'to_share_cents', (p_result ->> 'to_share_cents')::bigint,
                                         'lines', jsonb_array_length(p_result -> 'lines'), 'items', v_cnt_sql),
                      coalesce(nullif(btrim(p_notes), ''), 'Cierre de liquidación'));
  return v_run;
end;
$$;

-- -----------------------------------------------------------------------------
-- L) Pagos al staff (super_admin)
-- -----------------------------------------------------------------------------
create or replace function staff_refresh_run_status(p_run uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_due  bigint;
  v_paid bigint;
begin
  select coalesce(sum(payable_cents), 0) into v_due from staff_payout_lines where run_id = p_run;
  select coalesce(sum(amount_cents), 0) into v_paid from staff_payout_payments where run_id = p_run and voided_at is null;
  update staff_payout_runs
     set status = case when v_paid >= v_due then 'paid' when v_paid > 0 then 'partially_paid' else 'closed' end
   where id = p_run
     and status is distinct from case when v_paid >= v_due then 'paid' when v_paid > 0 then 'partially_paid' else 'closed' end;
end;
$$;

create or replace function staff_money_label(p_cents bigint)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select '$ ' || replace(replace(replace(to_char(p_cents / 100.0, 'FM999G999G999G990D00'), ',', '#'), '.', ','), '#', '.');
$$;

create or replace function internal_staff_register_payment(
  p_line          uuid,
  p_amount_cents  bigint,
  p_method        text,
  p_paid_on       date,
  p_bank_account  uuid,
  p_reference     text,
  p_mp_operation  text,
  p_proof_path    text,
  p_notes         text,
  p_notify        boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line    staff_payout_lines%rowtype;
  v_run     staff_payout_runs%rowtype;
  v_member  staff_members%rowtype;
  v_set     staff_payout_settings%rowtype;
  v_paid    bigint;
  v_acc     jsonb;
  v_lookup  staff_mp_lookups%rowtype;
  v_op      text := nullif(regexp_replace(coalesce(p_mp_operation, ''), '\D', '', 'g'), '');
  v_today   date := staff_ar_today();
  v_id      uuid;
  v_notify  boolean;
  v_method_label text;
begin
  perform staff_assert_owner();
  select * into v_set from staff_payout_settings where id;
  select * into v_line from staff_payout_lines where id = p_line;
  if not found then
    raise exception 'line_not_found' using errcode = 'P0002';
  end if;
  select * into v_run from staff_payout_runs where id = v_line.run_id;
  select * into v_member from staff_members where id = v_line.member_id;
  if p_method not in ('transfer', 'mercadopago', 'cash', 'other') then
    raise exception 'invalid_method' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_paid_on is null or p_paid_on > v_today or p_paid_on < v_run.period then
    raise exception 'invalid_paid_on' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('staff_payout_line:' || p_line::text, 0));
  select coalesce(sum(amount_cents), 0) into v_paid from staff_payout_payments where line_id = p_line and voided_at is null;
  if v_paid + p_amount_cents > v_line.payable_cents then
    raise exception 'overpayment:%', v_line.payable_cents - v_paid using errcode = '22023';
  end if;

  if p_bank_account is not null then
    select to_jsonb(a) - array['created_by', 'created_at', 'updated_at', 'deleted_at'] into v_acc
      from staff_bank_accounts a where id = p_bank_account and member_id = v_line.member_id and deleted_at is null;
    if v_acc is null then
      raise exception 'account_not_found' using errcode = 'P0002';
    end if;
  elsif p_method = 'transfer' then
    raise exception 'account_required' using errcode = '22023';
  end if;

  if p_method = 'mercadopago' then
    if v_op is null then
      raise exception 'mp_operation_required' using errcode = '22023';
    end if;
    if exists (select 1 from staff_payout_payments where mp_operation_id = v_op and voided_at is null) then
      raise exception 'mp_operation_used' using errcode = '23505';
    end if;
    -- El detalle lo trae la Edge desde la cuenta de MP de NinjaSoft; nunca el navegador.
    select * into v_lookup from staff_mp_lookups
     where operation_id = v_op and ok and fetched_at > now() - interval '24 hours'
     order by fetched_at desc limit 1;
    if v_lookup.id is null then
      raise exception 'mp_lookup_required' using errcode = '22023';
    end if;
    if coalesce(v_lookup.summary ->> 'status', '') <> 'approved' then
      raise exception 'mp_not_approved' using errcode = '22023';
    end if;
    if abs((v_lookup.summary ->> 'amount_cents')::bigint - p_amount_cents) > v_set.mp_amount_tolerance_cents then
      raise exception 'mp_amount_mismatch' using errcode = '22023';
    end if;
    if coalesce(v_lookup.summary -> 'check' ->> 'direction', '') = 'incoming' then
      raise exception 'mp_incoming_operation' using errcode = '22023';
    end if;
  end if;

  v_notify := coalesce(p_notify, v_set.notify_on_payment) and v_member.email is not null;
  insert into staff_payout_payments (line_id, run_id, member_id, amount_cents, method, paid_on, bank_account_id, account_snapshot,
                                     reference, mp_operation_id, mp_lookup_id, mp_summary, proof_path, notes, notify, created_by)
  values (p_line, v_line.run_id, v_line.member_id, p_amount_cents, p_method, p_paid_on, p_bank_account, v_acc,
          nullif(btrim(coalesce(p_reference, '')), ''), v_op, v_lookup.id, v_lookup.summary,
          nullif(p_proof_path, ''), nullif(btrim(coalesce(p_notes, '')), ''), v_notify, auth.uid())
  returning id into v_id;

  perform staff_refresh_run_status(v_line.run_id);

  if v_notify then
    v_method_label := case p_method when 'transfer' then 'Transferencia bancaria' when 'mercadopago' then 'Mercado Pago'
                                    when 'cash' then 'Efectivo' else 'Otro medio' end;
    perform enqueue_system_email(
      null, v_member.email, 'staff_payout_credited',
      jsonb_build_object(
        'nombre', v_member.display_name,
        'monto', staff_money_label(p_amount_cents),
        'periodo', to_char(v_run.period, 'MM/YYYY'),
        'medio', v_method_label,
        'fecha', to_char(p_paid_on, 'DD/MM/YYYY'),
        'referencia', coalesce(v_op, nullif(btrim(coalesce(p_reference, '')), ''), 'sin referencia'),
        'cuenta', coalesce((v_acc ->> 'bank_name') || ' · ' || coalesce(v_acc ->> 'alias', right(v_acc ->> 'cbu', 4)), 'sin cuenta')),
      'NinjaSoft te acreditó ' || staff_money_label(p_amount_cents),
      '<p>Hola ' || v_member.display_name || ', NinjaSoft te acreditó ' || staff_money_label(p_amount_cents)
        || ' de la liquidación de ' || to_char(v_run.period, 'MM/YYYY') || ' por ' || v_method_label || '.</p>');
    update staff_payout_payments set email_queued_at = now() where id = v_id;
  end if;

  perform staff_audit('staff_payout_payment', v_id, 'staff_payment_registered', jsonb_build_object('paid_before_cents', v_paid),
                      jsonb_build_object('line_id', p_line, 'member_id', v_line.member_id, 'amount_cents', p_amount_cents,
                                         'method', p_method, 'paid_on', p_paid_on, 'mp_operation_id', v_op, 'notify', v_notify),
                      coalesce(nullif(btrim(p_notes), ''), 'Pago al staff'));
  return v_id;
end;
$$;

create or replace function internal_staff_void_payment(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_pay    staff_payout_payments%rowtype;
begin
  perform staff_assert_owner();
  select * into v_pay from staff_payout_payments where id = p_id and voided_at is null;
  if not found then
    raise exception 'payment_not_found' using errcode = 'P0002';
  end if;
  update staff_payout_payments set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = p_id;
  perform staff_refresh_run_status(v_pay.run_id);
  perform staff_audit('staff_payout_payment', p_id, 'staff_payment_voided', to_jsonb(v_pay), null, v_reason);
end;
$$;

-- -----------------------------------------------------------------------------
-- M) Vista propia de cada persona (sin ver lo de los demás)
-- -----------------------------------------------------------------------------
create or replace function my_staff_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_member staff_members%rowtype;
begin
  if not coalesce((select internal_scope()), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_member from staff_members where user_id = auth.uid() and deleted_at is null;
  if not found then
    return jsonb_build_object('member', null);
  end if;
  return jsonb_build_object(
    'member', jsonb_build_object('id', v_member.id, 'name', v_member.display_name, 'email', v_member.email, 'is_active', v_member.is_active),
    'shares', coalesce((select jsonb_agg(jsonb_build_object('share_bp', s.share_bp, 'expense_bp', s.expense_bp,
                                                            'valid_from', s.valid_from, 'valid_to', s.valid_to) order by s.valid_from desc)
                          from staff_shares s where s.member_id = v_member.id and s.voided_at is null), '[]'::jsonb),
    'rules', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'tenant_name', t.name, 'kind', r.kind, 'value', r.value,
                                                           'valid_from', r.valid_from, 'valid_to', r.valid_to) order by r.valid_from desc)
                         from staff_client_rules r join tenants t on t.id = r.tenant_id
                        where r.member_id = v_member.id and r.voided_at is null), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', l.id, 'period', r.period, 'status', r.status, 'income_cents', l.income_cents, 'signup_cents', l.signup_cents,
                          'expense_cents', l.expense_cents, 'adjustment_cents', l.adjustment_cents, 'carry_in_cents', l.carry_in_cents,
                          'net_cents', l.net_cents, 'payable_cents', l.payable_cents, 'carry_out_cents', l.carry_out_cents,
                          'share_bp_end', l.share_bp_end, 'detail', l.detail,
                          'paid_cents', coalesce((select sum(p.amount_cents) from staff_payout_payments p
                                                   where p.line_id = l.id and p.voided_at is null), 0),
                          'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'amount_cents', p.amount_cents, 'method', p.method,
                                                                                    'paid_on', p.paid_on, 'reference', coalesce(p.mp_operation_id, p.reference),
                                                                                    'account', p.account_snapshot ->> 'bank_name')
                                                                  order by p.paid_on)
                                                  from staff_payout_payments p where p.line_id = l.id and p.voided_at is null), '[]'::jsonb))
                        order by r.period desc)
                         from staff_payout_lines l join staff_payout_runs r on r.id = l.run_id
                        where l.member_id = v_member.id), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(to_jsonb(a) - array['created_by'] order by a.is_default desc, a.created_at)
                            from staff_bank_accounts a where a.member_id = v_member.id and a.deleted_at is null), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- N) Plantilla del email de acreditación (espejo de lib/email/templates.ts;
--    ON CONFLICT DO NOTHING: no pisa lo que el staff edite en /internal/emails)
-- -----------------------------------------------------------------------------
-- <staff-email-template>
insert into system_email_templates (key, subject, html) values
  ('staff_payout_credited',
   $tpl$NinjaSoft te acreditó {{monto}}$tpl$,
   $tpl$<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>NinjaPos</title></head><body style="margin:0;padding:0;background:#f3f2f8;-webkit-font-smoothing:antialiased"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">Pago de tu liquidación de {{periodo}}.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f2f8" style="background:#f3f2f8"><tr><td align="center" style="padding:28px 12px 40px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><tr><td align="center" bgcolor="#09051C" style="background:#09051C;background-image:radial-gradient(120% 90% at 50% 0%,#3a1708 0%,#09051C 60%);border-radius:20px 20px 0 0;padding:40px 40px 36px;text-align:center"><a href="https://pos.soft.ninja" target="_blank" style="text-decoration:none"><img src="https://tgaromemhaixgdsdlxiq.supabase.co/storage/v1/object/public/brand/ninja-isotipo-flame.png" alt="" width="40" height="52" style="display:block;margin:0 auto 16px;width:40px;height:52px;border:0" /><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm" alt="NinjaPOS" height="34" style="display:block;margin:0 auto;height:34px;border:0" /></a></td></tr><tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:40px 40px 0;text-align:center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 22px"><tr><td width="72" height="72" align="center" valign="middle" bgcolor="#e8f7ee" style="width:72px;height:72px;border-radius:50%;background:#e8f7ee;font-size:32px;line-height:72px;text-align:center">💸</td></tr></table><p style="margin:0 0 8px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#15803d">Pago acreditado</p><h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;font-weight:800;letter-spacing:-0.4px;color:#09051C">Te pagamos {{monto}}</h1><p style="margin:0 auto;max-width:420px;font-size:16px;line-height:1.6;color:#6b7280">Hola {{nombre}}, NinjaSoft registró un pago de tu participación de <b>{{periodo}}</b>.</p></td></tr><tr><td bgcolor="#ffffff" style="background:#ffffff;padding:28px 40px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f6fb" style="background:#f7f6fb;border-radius:16px"><tr><td style="padding:14px 20px;font-size:14px;line-height:20px;color:#6b7280">Monto</td><td align="right" style="padding:14px 20px;font-size:15px;line-height:20px;font-weight:700;color:#09051C">{{monto}}</td></tr><tr><td style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:14px;line-height:20px;color:#6b7280">Medio</td><td align="right" style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:15px;line-height:20px;font-weight:700;color:#09051C">{{medio}}</td></tr><tr><td style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:14px;line-height:20px;color:#6b7280">Fecha</td><td align="right" style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:15px;line-height:20px;font-weight:700;color:#09051C">{{fecha}}</td></tr><tr><td style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:14px;line-height:20px;color:#6b7280">Cuenta</td><td align="right" style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:15px;line-height:20px;font-weight:700;color:#09051C">{{cuenta}}</td></tr><tr><td style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:14px;line-height:20px;color:#6b7280">Referencia</td><td align="right" style="padding:14px 20px;border-top:1px solid #ecebf3;font-size:15px;line-height:20px;font-weight:700;color:#09051C">{{referencia}}</td></tr></table></td></tr><tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:32px 40px 44px;text-align:center;border-radius:0 0 20px 20px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" bgcolor="#ff5a1f" style="border-radius:999px;background:#ff5a1f;background-image:linear-gradient(135deg,#ff4b22,#ff8a1f)"><a href="https://pos.soft.ninja/internal/mi-participacion" target="_blank" style="display:inline-block;padding:16px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:999px">Ver mi participación</a></td></tr></table><p style="margin:16px auto 0;max-width:400px;font-size:13px;line-height:1.5;color:#9ca3af">Si algo no coincide con lo que te llegó, respondé este email.</p></td></tr><tr><td style="padding:16px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff;border-radius:20px"><tr><td align="center" style="padding:32px 32px 28px;text-align:center"><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0" alt="NinjaPOS" height="26" style="display:block;margin:0 auto 10px;height:26px;border:0" /><p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:#6b7280">Vendé, cobrá y controlá tu negocio desde una sola pantalla.</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="padding:0 8px 0 0;font-size:12px;line-height:18px;color:#9ca3af">Un producto de</td><td><a href="https://soft.ninja" target="_blank" style="text-decoration:none"><img src="https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_Soft_Dark_h9aklw" alt="Ninja Soft" height="18" style="display:block;height:18px;border:0" /></a></td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px 0 18px"><div style="height:1px;line-height:1px;font-size:1px;background:#f0eff5">&nbsp;</div></td></tr></table><p style="margin:0 0 14px;font-size:13px;line-height:1.6"><a href="https://pos.soft.ninja/login" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">pos.soft.ninja</a> &nbsp;&middot;&nbsp; <a href="https://soft.ninja" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">soft.ninja</a> &nbsp;&middot;&nbsp; <a href="https://www.instagram.com/ninjasoft.latam/" target="_blank" style="color:#09051C;text-decoration:none;font-weight:600">Instagram</a></p><p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#9ca3af">Urquiza 3164 &middot; Rosario, Santa Fe, Argentina</p><p style="margin:0;font-size:11px;line-height:1.6;color:#b0b3ba">Recibiste este email porque participás de la facturación de NinjaSoft.</p></td></tr></table></td></tr></table></td></tr></table></body></html>$tpl$)
on conflict (key) do nothing;
-- </staff-email-template>

-- -----------------------------------------------------------------------------
-- O) Permisos de ejecución
-- -----------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  -- Llamables por usuarios autenticados (cada una valida dueño o persona).
  foreach f in array array[
    'internal_staff_access()',
    'internal_staff_save_settings(jsonb, text)',
    'internal_staff_save_member(uuid, uuid, text, text, text, boolean, text)',
    'internal_staff_set_share(uuid, int, int, date, text)',
    'internal_staff_save_rule(uuid, uuid, text, bigint, date, date, text)',
    'internal_staff_end_rule(uuid, date, text)',
    'internal_staff_save_expense(uuid, jsonb, text)',
    'internal_staff_delete_expense(uuid, text)',
    'internal_staff_set_expense_month(uuid, date, bigint, text)',
    'internal_staff_set_fx(date, numeric, text)',
    'internal_staff_add_adjustment(uuid, date, bigint, text)',
    'internal_staff_void_adjustment(uuid, text)',
    'internal_staff_save_bank_account(uuid, uuid, jsonb, boolean)',
    'internal_staff_delete_bank_account(uuid)',
    'internal_staff_close_run(date, jsonb, text)',
    'internal_staff_register_payment(uuid, bigint, text, date, uuid, text, text, text, text, boolean)',
    'internal_staff_void_payment(uuid, text)',
    'my_staff_summary()',
    'staff_is_owner()',
    'staff_my_member_ids()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- Internas: sólo service_role (la Edge) o las RPC de arriba.
  foreach f in array array[
    'staff_settlement_inputs(date)',
    'staff_unliquidated_items(date)',
    'staff_projection_tenants(date)',
    'staff_assert_owner()',
    'staff_assert_open(date)',
    'staff_locked_until()',
    'staff_shares_overflow()',
    'staff_audit(text, uuid, text, jsonb, jsonb, text)',
    'staff_refresh_run_status(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$grants$;
