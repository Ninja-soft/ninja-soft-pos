-- =============================================================================
-- 20261113100000_cobranza_ledger  (F20-1 · H127 · ADR-110 · ADR-115)
--
-- Cuenta corriente de la PLATAFORMA: lo que cada negocio le debe a NinjaSoft
-- por su suscripción (spec docs/40-cobranza-saas.md §3, §5, §6.2, §6.3, §10,
-- §17 y las decisiones del dueño de §22, que mandan).
--
-- Modelo (todo de plataforma; el staff lee con (select internal_scope()), el
-- negocio sólo ve lo suyo por RPC o por la policy de cargos):
--   · platform_billing_settings  una fila: desde cuándo genera cargos el cron
--                                (ledger_since), plazo de pago por defecto.
--   · tenant_billing_terms       modalidad de cobro por negocio (mp, cuenta
--                                corriente, manual, exento) y plazo.
--   · platform_charges / _lines  cargos con líneas congeladas (precio, addons,
--                                descuentos, prorrateo). Un cargo por período.
--   · platform_payments          pagos (reemplazo de billing_records, que
--                                sigue siendo la entrada legacy del webhook).
--   · platform_ledger            movimientos al debe (>0) y al haber (<0).
--   · platform_allocations       imputaciones haber → debe (FIFO).
--   · platform_ingest_log        qué billing_records ya pasaron al ledger.
--
-- Reglas:
--   · Inmutable: el ledger y las líneas no admiten UPDATE ni DELETE; cargos,
--     pagos e imputaciones sólo cambian estado (y la imputación sólo se
--     libera). Toda corrección es un movimiento compensatorio.
--   · Importes en centavos (bigint). Precios con IVA incluido (§22 #2): el
--     desglose lo hará la factura (F20-4).
--   · Idempotencia: un cargo por (suscripción, inicio de período), un pago por
--     (proveedor, id externo) y por billing_record, un movimiento por clave.
--   · Imputación FIFO: punitorios primero (F20-9), después por vencimiento.
--     El excedente queda como saldo a favor y se aplica solo al próximo cargo.
--   · Pago durante la prueba: el período pago empieza al terminar la prueba
--     (§22 #11) → reanchor_subscription_period.
--   · Upgrade a mitad de período: la diferencia prorrateada se suma al próximo
--     cobro (§22 #12): cargo 'proration' que vence con el próximo período.
--   · subscription_billing_total aplica tenant_discounts (bug reportado).
--   · No se cobra (ni cuenta en KPIs, §22 #7): negocios de prueba
--     (tenants.is_test), cuyo dueño es staff interno, lifetime o exentos.
--
-- Backfill: cada billing_record existente pasa a platform_payments, con un
-- cargo histórico por el mismo importe (el pasado queda saldado; no se
-- inventa deuda). Idempotente: re-ejecutar la migración no duplica nada.
--
-- RPCs del staff y del cliente: 20261113100100_cobranza_ledger_rpc.sql.
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Marca de negocio interno o de prueba (§15.1, §22 #7)
-- -----------------------------------------------------------------------------
alter table tenants add column if not exists is_test boolean not null default false;
comment on column tenants.is_test is
  'Negocio interno o de prueba: no se le cobra y no cuenta en los KPIs (spec cobranza §15.1, §22 #7). Sólo la cambia un super_admin con internal_set_tenant_test.';

-- El tenant de QA de los tests end to end (decisión §22 #7: "casos como el tenant QA").
update tenants set is_test = true where slug = 'ninjasoft-qa' and not is_test;

-- Fecha de pago informada por el staff al registrar un pago manual (la del
-- registro sigue siendo created_at). Sólo la usa el ledger.
alter table billing_records add column if not exists paid_at timestamptz;

-- -----------------------------------------------------------------------------
-- B) Configuración de plataforma y condiciones por negocio
-- -----------------------------------------------------------------------------
create table if not exists platform_billing_settings (
  id                boolean primary key default true check (id),
  -- El cron sólo genera cargos de períodos que empiezan desde esta fecha: al
  -- aplicar la migración no aparece deuda de períodos anteriores.
  ledger_since      date not null default ((now() at time zone 'America/Argentina/Buenos_Aires')::date),
  due_days_default  int not null default 0 check (due_days_default between 0 and 60),
  -- Débito automático: días de espera al webhook antes de generar el cargo.
  mp_wait_days      int not null default 1 check (mp_wait_days between 0 and 10),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references users(id)
);
insert into platform_billing_settings (id) values (true) on conflict (id) do nothing;

create table if not exists tenant_billing_terms (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null unique references tenants(id) on delete restrict,
  -- null = automática: mp_subscription si tiene preapproval, si no manual.
  billing_mode  text check (billing_mode in ('mp_subscription', 'account', 'manual', 'exempt')),
  exempt_reason text,
  due_days      int check (due_days between 0 and 60),
  notes         text,
  created_by    uuid references users(id),
  updated_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint tenant_billing_terms_exempt_reason check (
    billing_mode is distinct from 'exempt' or length(btrim(coalesce(exempt_reason, ''))) >= 5
  )
);
drop trigger if exists set_updated_at_tenant_billing_terms on tenant_billing_terms;
create trigger set_updated_at_tenant_billing_terms
  before update on tenant_billing_terms
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- C) Económico
-- -----------------------------------------------------------------------------
create table if not exists platform_charges (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete restrict,
  subscription_id  uuid references subscriptions(id) on delete set null,
  kind             text not null check (kind in ('subscription_period', 'proration', 'addon', 'one_off', 'interest', 'adjustment')),
  description      text not null,
  period_start     date,
  period_end       date,
  due_date         date not null,
  currency         text not null default 'ARS' check (currency = 'ARS'),
  -- Σ líneas positivas; discount_cents = Σ |líneas negativas| (descuentos,
  -- bonificaciones, crédito del prorrateo). IVA incluido en los importes.
  subtotal_cents   bigint not null check (subtotal_cents >= 0),
  discount_cents   bigint not null default 0 check (discount_cents >= 0),
  total_cents      bigint not null check (total_cents >= 0),
  status           text not null default 'open'
                     check (status in ('open', 'partially_paid', 'paid', 'voided', 'written_off')),
  source           text not null default 'system' check (source in ('system', 'cron', 'payment', 'staff', 'backfill', 'plan_change')),
  idempotency_key  text not null unique,
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  voided_at        timestamptz,
  voided_by        uuid references users(id),
  void_reason      text,
  constraint platform_charges_total check (total_cents = subtotal_cents - discount_cents),
  constraint platform_charges_period check (period_end is null or period_start is null or period_end > period_start)
);
create index if not exists platform_charges_tenant_due_idx on platform_charges (tenant_id, due_date desc);
create index if not exists platform_charges_subscription_idx on platform_charges (subscription_id);
create index if not exists platform_charges_open_idx on platform_charges (due_date) where status in ('open', 'partially_paid');

create table if not exists platform_charge_lines (
  id           uuid primary key default gen_random_uuid(),
  charge_id    uuid not null references platform_charges(id) on delete restrict,
  tenant_id    uuid not null references tenants(id) on delete restrict,
  position     int not null default 0,
  source       text not null check (source in ('plan', 'addon', 'discount', 'bonus', 'proration_credit', 'proration_debit', 'interest', 'manual')),
  description  text not null,
  qty          numeric(12,3) not null default 1,
  unit_cents   bigint not null,
  amount_cents bigint not null,
  ref_id       uuid,
  created_at   timestamptz not null default now()
);
create index if not exists platform_charge_lines_charge_idx on platform_charge_lines (charge_id, position);
create index if not exists platform_charge_lines_tenant_idx on platform_charge_lines (tenant_id);

create table if not exists platform_payments (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete restrict,
  method            text not null check (method in ('mp_preapproval', 'mp_checkout', 'transfer', 'cash', 'other')),
  status            text not null default 'approved'
                      check (status in ('pending_verification', 'approved', 'rejected', 'refunded', 'partially_refunded', 'charged_back', 'in_dispute')),
  amount_cents      bigint not null check (amount_cents > 0),
  fee_cents         bigint check (fee_cents >= 0),
  net_cents         bigint,
  currency          text not null default 'ARS' check (currency = 'ARS'),
  paid_at           timestamptz not null,
  provider          text,
  external_id       text,
  period_start      date,
  period_end        date,
  payer_reference   text,
  notes             text,
  billing_record_id uuid unique references billing_records(id) on delete restrict,
  recorded_by       uuid references users(id),
  idempotency_key   text not null unique,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists platform_payments_provider_ext_uidx
  on platform_payments (provider, external_id) where external_id is not null;
create index if not exists platform_payments_tenant_paid_idx on platform_payments (tenant_id, paid_at desc);

create table if not exists platform_ledger (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete restrict,
  kind            text not null check (kind in (
                    -- debe
                    'charge', 'interest', 'adjustment_debit', 'refund', 'payment_reversal',
                    -- haber
                    'payment', 'bonus_credit', 'interest_waiver', 'adjustment_credit', 'charge_void',
                    -- cualquiera de los dos
                    'opening_balance')),
  amount_cents    bigint not null check (amount_cents <> 0),
  currency        text not null default 'ARS' check (currency = 'ARS'),
  effective_date  date not null,
  due_date        date,
  description     text not null,
  reason          text,
  charge_id       uuid references platform_charges(id) on delete restrict,
  payment_id      uuid references platform_payments(id) on delete restrict,
  parent_id       uuid references platform_ledger(id) on delete restrict,
  created_by      uuid references users(id),
  idempotency_key text not null unique,
  created_at      timestamptz not null default now(),
  -- Signo por tipo: positivo = debe.
  constraint platform_ledger_sign check (
    case
      when kind in ('charge', 'interest', 'adjustment_debit', 'refund', 'payment_reversal') then amount_cents > 0
      when kind in ('payment', 'bonus_credit', 'interest_waiver', 'adjustment_credit', 'charge_void') then amount_cents < 0
      else true
    end
  ),
  -- Los movimientos manuales llevan motivo.
  constraint platform_ledger_reason check (
    kind not in ('adjustment_debit', 'adjustment_credit', 'bonus_credit', 'interest_waiver', 'charge_void', 'refund', 'payment_reversal')
    or length(btrim(coalesce(reason, ''))) >= 5
  )
);
create index if not exists platform_ledger_tenant_date_idx on platform_ledger (tenant_id, effective_date, created_at);
create index if not exists platform_ledger_charge_idx on platform_ledger (charge_id);
create index if not exists platform_ledger_payment_idx on platform_ledger (payment_id);
create index if not exists platform_ledger_parent_idx on platform_ledger (parent_id);

create table if not exists platform_allocations (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete restrict,
  credit_movement_id uuid not null references platform_ledger(id) on delete restrict,
  debit_movement_id  uuid not null references platform_ledger(id) on delete restrict,
  amount_cents       bigint not null check (amount_cents > 0),
  created_by         uuid references users(id),
  created_at         timestamptz not null default now(),
  released_at        timestamptz,
  released_by        uuid references users(id),
  release_reason     text
);
create index if not exists platform_allocations_credit_idx on platform_allocations (credit_movement_id, released_at);
create index if not exists platform_allocations_debit_idx on platform_allocations (debit_movement_id, released_at);
create index if not exists platform_allocations_tenant_idx on platform_allocations (tenant_id, created_at);

create table if not exists platform_ingest_log (
  billing_record_id uuid primary key references billing_records(id) on delete restrict,
  tenant_id         uuid not null references tenants(id) on delete restrict,
  payment_id        uuid references platform_payments(id) on delete restrict,
  outcome           text not null check (outcome in ('ingested', 'duplicate', 'skipped')),
  created_at        timestamptz not null default now()
);
create index if not exists platform_ingest_log_tenant_idx on platform_ingest_log (tenant_id);
create index if not exists platform_ingest_log_payment_idx on platform_ingest_log (payment_id);

-- -----------------------------------------------------------------------------
-- D) Inmutabilidad (nada de UPDATE/DELETE de importes)
-- -----------------------------------------------------------------------------
create or replace function platform_ledger_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% es inmutable: corregí con un movimiento compensatorio', tg_table_name
    using errcode = '42501';
end;
$$;

drop trigger if exists platform_ledger_no_update on platform_ledger;
create trigger platform_ledger_no_update before update or delete on platform_ledger
  for each row execute function platform_ledger_immutable();
drop trigger if exists platform_charge_lines_no_update on platform_charge_lines;
create trigger platform_charge_lines_no_update before update or delete on platform_charge_lines
  for each row execute function platform_ledger_immutable();
drop trigger if exists platform_ingest_log_no_update on platform_ingest_log;
create trigger platform_ingest_log_no_update before update or delete on platform_ingest_log
  for each row execute function platform_ledger_immutable();

-- Cargos: sólo cambian estado, anulación y updated_at.
create or replace function platform_charges_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'platform_charges no se borra: se anula con internal_billing_void_charge' using errcode = '42501';
  end if;
  if (new.tenant_id, new.subscription_id, new.kind, new.period_start, new.period_end, new.due_date,
      new.subtotal_cents, new.discount_cents, new.total_cents, new.idempotency_key, new.created_at, new.description)
     is distinct from
     (old.tenant_id, old.subscription_id, old.kind, old.period_start, old.period_end, old.due_date,
      old.subtotal_cents, old.discount_cents, old.total_cents, old.idempotency_key, old.created_at, old.description) then
    raise exception 'platform_charges: los importes y el período son inmutables' using errcode = '42501';
  end if;
  if old.voided_at is not null and new.voided_at is distinct from old.voided_at then
    raise exception 'platform_charges: la anulación no se deshace' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists platform_charges_guard on platform_charges;
create trigger platform_charges_guard before update or delete on platform_charges
  for each row execute function platform_charges_guard();

-- Pagos: sólo cambia el estado (reversas) y updated_at.
create or replace function platform_payments_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'platform_payments no se borra: se revierte con internal_billing_reverse_payment' using errcode = '42501';
  end if;
  if (new.tenant_id, new.method, new.amount_cents, new.paid_at, new.provider, new.external_id,
      new.billing_record_id, new.idempotency_key, new.created_at)
     is distinct from
     (old.tenant_id, old.method, old.amount_cents, old.paid_at, old.provider, old.external_id,
      old.billing_record_id, old.idempotency_key, old.created_at) then
    raise exception 'platform_payments: el importe y el origen son inmutables' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists platform_payments_guard on platform_payments;
create trigger platform_payments_guard before update or delete on platform_payments
  for each row execute function platform_payments_guard();

-- Imputaciones: sólo se liberan (released_at de null a un valor), una vez.
create or replace function platform_allocations_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'platform_allocations no se borra: se libera' using errcode = '42501';
  end if;
  if (new.tenant_id, new.credit_movement_id, new.debit_movement_id, new.amount_cents, new.created_at, new.created_by)
     is distinct from
     (old.tenant_id, old.credit_movement_id, old.debit_movement_id, old.amount_cents, old.created_at, old.created_by)
     or old.released_at is not null
     or new.released_at is null then
    raise exception 'platform_allocations: sólo se puede liberar una imputación vigente' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists platform_allocations_guard on platform_allocations;
create trigger platform_allocations_guard before update or delete on platform_allocations
  for each row execute function platform_allocations_guard();

-- -----------------------------------------------------------------------------
-- E) RLS (sin políticas FOR ALL; escritura sólo por funciones SECURITY DEFINER)
-- -----------------------------------------------------------------------------
alter table platform_billing_settings enable row level security;
alter table tenant_billing_terms      enable row level security;
alter table platform_charges          enable row level security;
alter table platform_charge_lines     enable row level security;
alter table platform_payments         enable row level security;
alter table platform_ledger           enable row level security;
alter table platform_allocations      enable row level security;
alter table platform_ingest_log       enable row level security;

drop policy if exists platform_billing_settings_staff on platform_billing_settings;
create policy platform_billing_settings_staff on platform_billing_settings
  for select to authenticated using ((select internal_scope()));

drop policy if exists tenant_billing_terms_staff on tenant_billing_terms;
create policy tenant_billing_terms_staff on tenant_billing_terms
  for select to authenticated using ((select internal_scope()));
drop policy if exists tenant_billing_terms_owner on tenant_billing_terms;
create policy tenant_billing_terms_owner on tenant_billing_terms
  for select to authenticated using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));

drop policy if exists platform_charges_staff on platform_charges;
create policy platform_charges_staff on platform_charges
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_charges_owner on platform_charges;
create policy platform_charges_owner on platform_charges
  for select to authenticated using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));

drop policy if exists platform_charge_lines_staff on platform_charge_lines;
create policy platform_charge_lines_staff on platform_charge_lines
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_charge_lines_owner on platform_charge_lines;
create policy platform_charge_lines_owner on platform_charge_lines
  for select to authenticated using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));

-- Ledger, imputaciones, pagos y log: sólo staff. El negocio ve su estado de
-- cuenta armado por my_billing_statement() (sin motivos internos ni autores).
drop policy if exists platform_payments_staff on platform_payments;
create policy platform_payments_staff on platform_payments
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_ledger_staff on platform_ledger;
create policy platform_ledger_staff on platform_ledger
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_allocations_staff on platform_allocations;
create policy platform_allocations_staff on platform_allocations
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_ingest_log_staff on platform_ingest_log;
create policy platform_ingest_log_staff on platform_ingest_log
  for select to authenticated using ((select internal_scope()));

revoke all on table platform_billing_settings, tenant_billing_terms, platform_charges, platform_charge_lines,
  platform_payments, platform_ledger, platform_allocations, platform_ingest_log from anon;
revoke insert, update, delete, truncate on table platform_billing_settings, tenant_billing_terms, platform_charges,
  platform_charge_lines, platform_payments, platform_ledger, platform_allocations, platform_ingest_log from authenticated;
grant select on table platform_billing_settings, tenant_billing_terms, platform_charges, platform_charge_lines,
  platform_payments, platform_ledger, platform_allocations, platform_ingest_log to authenticated;

-- -----------------------------------------------------------------------------
-- F) Exclusión y modalidad efectiva
-- -----------------------------------------------------------------------------
-- Motivo por el que un negocio NO se cobra ni cuenta en los KPIs (null = se
-- cobra). Orden: baja, prueba, dueño staff, lifetime, exento a mano.
create or replace function platform_billing_exclusion(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
           when t.id is null then 'not_found'
           when t.deleted_at is not null then 'deleted'
           when t.is_test then 'test'
           when exists (
             select 1
               from tenant_users tu
               join users u on u.id = tu.user_id
              where tu.tenant_id = t.id
                and tu.role = 'owner'
                and tu.status = 'active'
                and u.internal_level is not null
           ) then 'staff_owned'
           when coalesce(s.is_lifetime, false) then 'lifetime'
           when bt.billing_mode = 'exempt' then 'exempt'
         end
    from (select p_tenant as id) x
    left join tenants t on t.id = x.id
    left join subscriptions s on s.tenant_id = x.id
    left join tenant_billing_terms bt on bt.tenant_id = x.id;
$$;

create or replace function platform_effective_billing_mode(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
           when platform_billing_exclusion(p_tenant) is not null then 'exempt'
           when bt.billing_mode is not null then bt.billing_mode
           when s.mp_preapproval_id is not null then 'mp_subscription'
           else 'manual'
         end
    from (select p_tenant as id) x
    left join subscriptions s on s.tenant_id = x.id
    left join tenant_billing_terms bt on bt.tenant_id = x.id;
$$;

-- -----------------------------------------------------------------------------
-- G) Monto de la suscripción con descuentos (fix: tenant_discounts no se
--    aplicaba). Precios con IVA incluido. Porcentajes sobre el bruto (suma
--    tope 100 %) y después los fijos (mensuales; × 12 en el ciclo anual).
--    Nunca negativo. Mismo cálculo que lib/billing/ledger.ts (billingTotal) y
--    lib/internal/saasKpis.ts (accountMrr).
-- -----------------------------------------------------------------------------
create or replace function platform_billing_breakdown(p_tenant uuid, p_at date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_at             date := coalesce(p_at, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  v_cycle          text;
  v_yearly         boolean;
  v_plan_id        uuid;
  v_plan_key       text;
  v_plan_name      text;
  v_plan_amount    numeric;
  v_addons         jsonb;
  v_addons_monthly numeric;
  v_addons_amount  numeric;
  v_gross          numeric;
  v_pct            numeric;
  v_fixed          numeric;
  v_discount       numeric;
  v_discounts      jsonb;
begin
  if p_tenant is null then
    return null;
  end if;

  select s.billing_cycle, p.id, p.key, p.name,
         case when s.billing_cycle = 'yearly'
              then coalesce(nullif(p.yearly_price_ars, 0), p.monthly_price_ars * 12)
              else p.monthly_price_ars end
    into v_cycle, v_plan_id, v_plan_key, v_plan_name, v_plan_amount
    from subscriptions s
    join plans p on p.id = s.plan_id
   where s.tenant_id = p_tenant;

  if v_cycle is null then
    return null;
  end if;
  v_yearly := (v_cycle = 'yearly');
  v_plan_amount := coalesce(v_plan_amount, 0);

  -- Addons facturables a la fecha: activos o cancelados dentro de su ventana
  -- paga. Los bonificados (granted) suman 0 y no van como línea.
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', a.addon_key, 'name', a.label, 'monthly', a.price) order by a.addon_key)
           filter (where a.price > 0), '[]'::jsonb),
         coalesce(sum(a.price), 0)
    into v_addons, v_addons_monthly
    from (
      select sa.addon_key,
             coalesce(pa.label, sa.addon_key) as label,
             case when sa.source = 'granted' then 0
                  else coalesce(sa.monthly_price_ars, pa.monthly_price_ars, 0) end as price
        from subscription_addons sa
        left join plan_addons pa on pa.key = sa.addon_key
       where sa.tenant_id = p_tenant
         and (sa.status = 'active'
              or (sa.cancel_at_period_end
                  and sa.current_period_end is not null
                  and sa.current_period_end::date >= v_at))
    ) a;

  v_addons_amount := case when v_yearly then v_addons_monthly * 12 else v_addons_monthly end;
  v_gross := v_plan_amount + v_addons_amount;

  -- Descuentos vigentes a la fecha.
  select least(100, coalesce(sum(d.value) filter (where d.kind = 'percent'), 0)),
         coalesce(sum(d.value) filter (where d.kind = 'fixed'), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'kind', d.kind, 'value', d.value, 'reason', d.reason,
           'valid_from', d.valid_from, 'valid_until', d.valid_until) order by d.created_at), '[]'::jsonb)
    into v_pct, v_fixed, v_discounts
    from tenant_discounts d
   where d.tenant_id = p_tenant
     and d.deleted_at is null
     and d.value > 0
     and d.valid_from <= v_at
     and (d.valid_until is null or d.valid_until >= v_at);

  if v_yearly then
    v_fixed := v_fixed * 12;
  end if;
  v_discount := least(v_gross, round(v_gross * v_pct / 100, 2) + v_fixed);

  return jsonb_build_object(
    'tenant_id', p_tenant,
    'at', v_at,
    'billing_cycle', v_cycle,
    'currency', 'ARS',
    'plan_id', v_plan_id,
    'plan_key', v_plan_key,
    'plan_name', v_plan_name,
    'plan_amount', v_plan_amount,
    'addons', v_addons,
    'addons_amount', v_addons_amount,
    'addons_monthly', v_addons_monthly,
    'gross', v_gross,
    'percent_off', v_pct,
    'fixed_off', v_fixed,
    'discount_amount', v_discount,
    'discounts', v_discounts,
    'total', v_gross - v_discount
  );
end;
$fn$;

-- Misma firma y claves de siempre (lo usan mp_subscription_checkout y
-- mp_update_subscription_amount); 'total' ahora es neto de descuentos y se
-- suman 'gross', 'discount_amount' y el detalle.
create or replace function subscription_billing_total(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select platform_billing_breakdown(p_tenant, null);
$fn$;

revoke all on function subscription_billing_total(uuid) from public, anon, authenticated;
revoke all on function platform_billing_breakdown(uuid, date) from public, anon, authenticated;
revoke all on function platform_billing_exclusion(uuid) from public, anon, authenticated;
revoke all on function platform_effective_billing_mode(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- H) Motor del ledger
-- -----------------------------------------------------------------------------
create or replace function platform_cents(p numeric)
returns bigint
language sql
immutable
set search_path = public, pg_temp
as $$ select round(coalesce(p, 0) * 100)::bigint $$;

create or replace function platform_ar_date(p timestamptz)
returns date
language sql
immutable
set search_path = public, pg_temp
as $$ select (p at time zone 'America/Argentina/Buenos_Aires')::date $$;

-- Fecha de período: el webhook guarda period_start/period_end en UTC
-- (toISOString().slice(0, 10)); la clave del cargo usa la misma convención
-- para que webhook y cron caigan en el mismo cargo.
create or replace function platform_period_date(p timestamptz)
returns date
language sql
immutable
set search_path = public, pg_temp
as $$ select (p at time zone 'UTC')::date $$;

create or replace function platform_lock_tenant(p_tenant uuid)
returns void
language sql
volatile
set search_path = public, pg_temp
as $$ select pg_advisory_xact_lock(hashtextextended('platform_ledger:' || p_tenant::text, 0)) $$;

create or replace function platform_movement_open_cents(p_movement uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select abs(l.amount_cents) - coalesce((
           select sum(a.amount_cents)
             from platform_allocations a
            where a.released_at is null
              and (a.credit_movement_id = l.id or a.debit_movement_id = l.id)
         ), 0)
    from platform_ledger l
   where l.id = p_movement;
$$;

-- Movimiento idempotente por clave: si ya existe, devuelve el existente.
create or replace function platform_post_movement(
  p_tenant      uuid,
  p_kind        text,
  p_amount      bigint,
  p_effective   date,
  p_due         date,
  p_description text,
  p_reason      text,
  p_charge      uuid,
  p_payment     uuid,
  p_parent      uuid,
  p_key         text,
  p_actor       uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  select id into v_id from platform_ledger where idempotency_key = p_key;
  if v_id is not null then
    return v_id;
  end if;
  insert into platform_ledger (tenant_id, kind, amount_cents, effective_date, due_date, description, reason,
                               charge_id, payment_id, parent_id, created_by, idempotency_key)
  values (p_tenant, p_kind, p_amount, p_effective,
          case when p_amount > 0 then coalesce(p_due, p_effective) end,
          p_description, nullif(btrim(coalesce(p_reason, '')), ''),
          p_charge, p_payment, p_parent, p_actor, p_key)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from platform_ledger where idempotency_key = p_key;
  end if;
  return v_id;
end;
$$;

create or replace function platform_refresh_charge_status(p_charge uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_charge platform_charges%rowtype;
  v_paid   bigint;
  v_status text;
begin
  select * into v_charge from platform_charges where id = p_charge;
  if not found then
    return null;
  end if;
  if v_charge.voided_at is not null or v_charge.status in ('voided', 'written_off') then
    return v_charge.status;
  end if;
  select coalesce(sum(a.amount_cents), 0)
    into v_paid
    from platform_ledger l
    join platform_allocations a on a.debit_movement_id = l.id and a.released_at is null
   where l.charge_id = p_charge
     and l.kind = 'charge';
  v_status := case
                when v_charge.total_cents = 0 or v_paid >= v_charge.total_cents then 'paid'
                when v_paid > 0 then 'partially_paid'
                else 'open'
              end;
  if v_status is distinct from v_charge.status then
    update platform_charges set status = v_status where id = p_charge;
  end if;
  return v_status;
end;
$$;

-- Imputación FIFO de todo el haber libre contra el debe pendiente del negocio.
-- Orden del debe: punitorios primero, después por vencimiento y antigüedad.
-- Idempotente: sin haber o sin debe libre no hace nada.
create or replace function platform_auto_allocate(p_tenant uuid, p_actor uuid default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c        record;
  d        record;
  v_c_open bigint;
  v_amt    bigint;
  v_n      int := 0;
begin
  perform platform_lock_tenant(p_tenant);
  for c in
    select l.id,
           -l.amount_cents - coalesce((select sum(a.amount_cents) from platform_allocations a
                                        where a.credit_movement_id = l.id and a.released_at is null), 0) as open_cents
      from platform_ledger l
     where l.tenant_id = p_tenant
       and l.amount_cents < 0
     order by l.effective_date, l.created_at, l.id
  loop
    v_c_open := c.open_cents;
    continue when v_c_open <= 0;
    for d in
      select l.id, l.charge_id,
             l.amount_cents - coalesce((select sum(a.amount_cents) from platform_allocations a
                                         where a.debit_movement_id = l.id and a.released_at is null), 0) as open_cents
        from platform_ledger l
       where l.tenant_id = p_tenant
         and l.amount_cents > 0
       order by (l.kind = 'interest') desc, coalesce(l.due_date, l.effective_date), l.created_at, l.id
    loop
      exit when v_c_open <= 0;
      continue when d.open_cents <= 0;
      v_amt := least(v_c_open, d.open_cents);
      insert into platform_allocations (tenant_id, credit_movement_id, debit_movement_id, amount_cents, created_by)
      values (p_tenant, c.id, d.id, v_amt, p_actor);
      v_c_open := v_c_open - v_amt;
      v_n := v_n + 1;
      if d.charge_id is not null then
        perform platform_refresh_charge_status(d.charge_id);
      end if;
    end loop;
  end loop;
  return v_n;
end;
$$;

-- Cargo con líneas congeladas + su movimiento al debe. Idempotente por clave.
-- p_lines: [{source, description, qty?, unit_cents?, amount_cents, ref_id?}]
create or replace function platform_create_charge(
  p_tenant      uuid,
  p_sub         uuid,
  p_kind        text,
  p_description text,
  p_start       date,
  p_end         date,
  p_due         date,
  p_lines       jsonb,
  p_key         text,
  p_actor       uuid,
  p_source      text,
  p_reason      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id       uuid;
  v_pos      int := 0;
  v_line     jsonb;
  v_sub      bigint := 0;
  v_disc     bigint := 0;
  v_amt      bigint;
  v_eff      date;
begin
  select id into v_id from platform_charges where idempotency_key = p_key;
  if v_id is not null then
    return v_id;
  end if;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_amt := (v_line ->> 'amount_cents')::bigint;
    if v_amt > 0 then v_sub := v_sub + v_amt; else v_disc := v_disc - v_amt; end if;
  end loop;
  -- Una bonificación nunca deja el total negativo (§17.8): el excedente no se
  -- descuenta acá.
  v_disc := least(v_disc, v_sub);

  insert into platform_charges (tenant_id, subscription_id, kind, description, period_start, period_end, due_date,
                                subtotal_cents, discount_cents, total_cents, source, idempotency_key, created_by)
  values (p_tenant, p_sub, p_kind, p_description, p_start, p_end, p_due,
          v_sub, v_disc, v_sub - v_disc, coalesce(p_source, 'system'), p_key, p_actor)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from platform_charges where idempotency_key = p_key;
    return v_id;
  end if;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    insert into platform_charge_lines (charge_id, tenant_id, position, source, description, qty, unit_cents, amount_cents, ref_id)
    values (v_id, p_tenant, v_pos, v_line ->> 'source', v_line ->> 'description',
            coalesce((v_line ->> 'qty')::numeric, 1),
            coalesce((v_line ->> 'unit_cents')::bigint, (v_line ->> 'amount_cents')::bigint),
            (v_line ->> 'amount_cents')::bigint,
            nullif(v_line ->> 'ref_id', '')::uuid);
  end loop;

  v_eff := case when p_kind = 'subscription_period' and p_start is not null then p_start
                else platform_ar_date(now()) end;
  if v_sub - v_disc > 0 then
    perform platform_post_movement(p_tenant, 'charge', v_sub - v_disc, v_eff, p_due, p_description, p_reason,
                                   v_id, null, null, 'chg:' || v_id::text, p_actor);
  end if;
  perform platform_auto_allocate(p_tenant, p_actor);
  perform platform_refresh_charge_status(v_id);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (p_tenant, p_actor, 'platform_charge', v_id, 'platform_charge_created',
          jsonb_build_object('kind', p_kind, 'total_cents', v_sub - v_disc, 'period_start', p_start,
                             'period_end', p_end, 'due_date', p_due, 'source', p_source),
          p_reason);
  return v_id;
end;
$$;

-- Líneas del período desde el desglose de la suscripción a la fecha de inicio.
create or replace function platform_period_lines(p_tenant uuid, p_start date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_b     jsonb := platform_billing_breakdown(p_tenant, p_start);
  v_cycle text;
  v_lines jsonb := '[]'::jsonb;
  v_a     jsonb;
  v_mult  int;
begin
  if v_b is null then
    return null;
  end if;
  v_cycle := v_b ->> 'billing_cycle';
  v_mult := case when v_cycle = 'yearly' then 12 else 1 end;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'source', 'plan',
    'description', 'Plan ' || coalesce(v_b ->> 'plan_name', v_b ->> 'plan_key', '') ||
                   case when v_cycle = 'yearly' then ' · anual' else ' · mensual' end,
    'amount_cents', platform_cents((v_b ->> 'plan_amount')::numeric),
    'ref_id', v_b ->> 'plan_id'));
  for v_a in select * from jsonb_array_elements(v_b -> 'addons') loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'source', 'addon',
      'description', (v_a ->> 'name') || case when v_cycle = 'yearly' then ' · anual' else ' · mensual' end,
      'amount_cents', platform_cents((v_a ->> 'monthly')::numeric * v_mult)));
  end loop;
  if (v_b ->> 'discount_amount')::numeric > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'source', 'discount',
      'description', 'Descuento comercial' ||
        case when (v_b ->> 'percent_off')::numeric > 0
             then ' ' || trim(to_char((v_b ->> 'percent_off')::numeric, 'FM990D##')) || ' %' else '' end,
      'amount_cents', -platform_cents((v_b ->> 'discount_amount')::numeric)));
  end if;
  return v_lines;
end;
$$;

-- Cargo de un período de suscripción. Idempotente por (suscripción, inicio).
-- p_amount_override: importe fijo (backfill histórico); sin él se calcula con
-- el desglose a la fecha de inicio y se omite si el negocio no se cobra.
create or replace function platform_ensure_period_charge(
  p_sub      uuid,
  p_start    date,
  p_end      date,
  p_due      date,
  p_override bigint default null,
  p_source   text default 'cron'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub   subscriptions%rowtype;
  v_key   text;
  v_id    uuid;
  v_end   date;
  v_lines jsonb;
  v_plan  text;
begin
  select * into v_sub from subscriptions where id = p_sub;
  if not found or p_start is null then
    return null;
  end if;
  v_key := 'sub:' || p_sub::text || ':' || p_start::text || ':subscription_period';
  select id into v_id from platform_charges where idempotency_key = v_key;
  if v_id is not null then
    return v_id;
  end if;

  v_end := coalesce(p_end, (p_start + case when v_sub.billing_cycle = 'yearly' then interval '12 months' else interval '1 month' end)::date);
  select p.name into v_plan from plans p where p.id = v_sub.plan_id;

  if p_override is null then
    if platform_billing_exclusion(v_sub.tenant_id) is not null then
      return null;
    end if;
    v_lines := platform_period_lines(v_sub.tenant_id, p_start);
    if v_lines is null then
      return null;
    end if;
  else
    if p_override <= 0 then
      return null;
    end if;
    v_lines := jsonb_build_array(jsonb_build_object(
      'source', 'plan',
      'description', 'Suscripción (importe cobrado, registro anterior al estado de cuenta)',
      'amount_cents', p_override));
  end if;

  return platform_create_charge(
    v_sub.tenant_id, p_sub, 'subscription_period',
    'Suscripción ' || coalesce('Plan ' || v_plan, '') || ' · ' || to_char(p_start, 'DD/MM/YYYY') || ' al ' ||
      to_char(v_end - 1, 'DD/MM/YYYY'),
    p_start, v_end, coalesce(p_due, p_start), v_lines, v_key, null, p_source, null);
end;
$$;

-- Pasa un billing_record al ledger: pago (idempotente por billing_record y por
-- (proveedor, id externo)), cargo del período si vino con período, movimiento
-- al haber e imputación FIFO. p_historical = backfill (cargo por el mismo
-- importe: el pasado queda saldado).
create or replace function platform_ingest_billing_record(p_br uuid, p_historical boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_br       billing_records%rowtype;
  v_sub      subscriptions%rowtype;
  v_cents    bigint;
  v_provider text;
  v_ext      text;
  v_method   text;
  v_pay      uuid;
  v_paid_at  timestamptz;
  v_pstart   date;
  v_label    text;
begin
  select * into v_br from billing_records where id = p_br;
  if not found then
    return null;
  end if;
  if exists (select 1 from platform_ingest_log where billing_record_id = v_br.id) then
    return (select payment_id from platform_ingest_log where billing_record_id = v_br.id);
  end if;

  perform platform_lock_tenant(v_br.tenant_id);

  v_cents := platform_cents(v_br.amount);
  if v_cents <= 0 then
    insert into platform_ingest_log (billing_record_id, tenant_id, payment_id, outcome)
    values (v_br.id, v_br.tenant_id, null, 'skipped') on conflict do nothing;
    return null;
  end if;

  v_provider := case when v_br.medium = 'mp' and nullif(btrim(coalesce(v_br.receipt_ref, '')), '') is not null
                     then 'mercadopago' end;
  v_ext := case when v_provider is not null then btrim(v_br.receipt_ref) end;
  if v_provider is not null then
    select id into v_pay from platform_payments where provider = v_provider and external_id = v_ext;
    if v_pay is not null then
      -- El mismo pago de MP ya entró (otro topic del webhook o carga manual).
      insert into platform_ingest_log (billing_record_id, tenant_id, payment_id, outcome)
      values (v_br.id, v_br.tenant_id, v_pay, 'duplicate') on conflict do nothing;
      return v_pay;
    end if;
  end if;

  v_method := case v_br.medium
                when 'mp' then 'mp_preapproval'
                when 'bank_transfer' then 'transfer'
                when 'cash' then 'cash'
                else 'other' end;
  v_paid_at := coalesce(v_br.paid_at, v_br.created_at);
  v_pstart := v_br.period_start;

  -- Cargo del período que paga (el webhook manda el período reanclado).
  select * into v_sub from subscriptions where tenant_id = v_br.tenant_id;
  if v_pstart is not null and v_sub.id is not null then
    perform platform_ensure_period_charge(
      v_sub.id, v_pstart, v_br.period_end, v_pstart,
      case when p_historical then v_cents end,
      case when p_historical then 'backfill' else 'payment' end);
  elsif p_historical then
    -- Pago histórico sin período: cargo por el mismo importe para no dejar un
    -- saldo a favor ficticio.
    perform platform_create_charge(
      v_br.tenant_id, v_sub.id, 'one_off',
      'Cobro registrado antes del estado de cuenta',
      null, null, platform_ar_date(v_paid_at),
      jsonb_build_array(jsonb_build_object('source', 'manual',
        'description', 'Cobro registrado antes del estado de cuenta', 'amount_cents', v_cents)),
      'hist:' || v_br.id::text, null, 'backfill', null);
  end if;

  v_label := case v_method
               when 'mp_preapproval' then 'Pago con Mercado Pago'
               when 'transfer' then 'Pago por transferencia'
               when 'cash' then 'Pago en efectivo'
               else 'Pago' end;

  insert into platform_payments (tenant_id, method, status, amount_cents, paid_at, provider, external_id,
                                 period_start, period_end, payer_reference, notes, billing_record_id,
                                 recorded_by, idempotency_key)
  values (v_br.tenant_id, v_method, 'approved', v_cents, v_paid_at, v_provider, v_ext,
          v_br.period_start, v_br.period_end,
          case when v_provider is null then nullif(btrim(coalesce(v_br.receipt_ref, '')), '') end,
          v_br.notes, v_br.id, v_br.recorded_by, 'br:' || v_br.id::text)
  returning id into v_pay;

  perform platform_post_movement(v_br.tenant_id, 'payment', -v_cents, platform_ar_date(v_paid_at), null,
                                 v_label, null, null, v_pay, null, 'pay:' || v_pay::text, v_br.recorded_by);
  perform platform_auto_allocate(v_br.tenant_id, v_br.recorded_by);

  insert into platform_ingest_log (billing_record_id, tenant_id, payment_id, outcome)
  values (v_br.id, v_br.tenant_id, v_pay, 'ingested');

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_br.tenant_id, v_br.recorded_by, 'platform_payment', v_pay, 'platform_payment_recorded',
          jsonb_build_object('amount_cents', v_cents, 'method', v_method, 'provider', v_provider,
                             'external_id', v_ext, 'billing_record_id', v_br.id,
                             'period_start', v_br.period_start, 'historical', p_historical));
  return v_pay;
end;
$$;

-- Trigger: todo billing_record nuevo (webhook de MP, "Registrar pago" del
-- panel) entra al ledger. Si algo falla, el billing_record se guarda igual (es
-- la plata cobrada) y queda auditado; el cron lo reintenta.
create or replace function trg_billing_records_to_ledger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform platform_ingest_billing_record(new.id, false);
  exception when others then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, null, 'platform_payment', new.id, 'platform_ledger_ingest_failed',
            jsonb_build_object('billing_record_id', new.id, 'error', sqlerrm, 'sqlstate', sqlstate));
  end;
  return null;
end;
$$;
drop trigger if exists billing_records_to_ledger on billing_records;
create trigger billing_records_to_ledger after insert on billing_records
  for each row execute function trg_billing_records_to_ledger();

-- Prorrateo de upgrade a mitad de período (§17.4, §22 #12): crédito por los
-- días que quedan del plan viejo y débito por los del nuevo, en un cargo que
-- vence con el próximo cobro. Downgrade: sin crédito (rige al fin del período).
-- Nunca bloquea el cambio de plan: si falla, queda auditado.
create or replace function trg_subscriptions_proration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_price numeric;
  v_new_price numeric;
  v_old_name  text;
  v_new_name  text;
  v_start     date;
  v_end       date;
  v_today     date := platform_ar_date(now());
  v_days      int;
  v_left      int;
  v_pct       numeric;
  v_credit    bigint;
  v_debit     bigint;
begin
  if new.plan_id is not distinct from old.plan_id then
    return null;
  end if;
  begin
    -- El cambio de ciclo (mensual ↔ anual) no se prorratea acá (§17.4, F20-10).
    if new.status not in ('active', 'past_due')
       or new.billing_cycle is distinct from old.billing_cycle
       or new.current_period_start is null
       or new.current_period_end is null
       or new.current_period_end <= now()
       or platform_billing_exclusion(new.tenant_id) is not null then
      return null;
    end if;

    select case when new.billing_cycle = 'yearly' then coalesce(nullif(p.yearly_price_ars, 0), p.monthly_price_ars * 12)
                else p.monthly_price_ars end, p.name
      into v_old_price, v_old_name
      from plans p where p.id = old.plan_id;
    select case when new.billing_cycle = 'yearly' then coalesce(nullif(p.yearly_price_ars, 0), p.monthly_price_ars * 12)
                else p.monthly_price_ars end, p.name
      into v_new_price, v_new_name
      from plans p where p.id = new.plan_id;
    if coalesce(v_new_price, 0) <= coalesce(v_old_price, 0) then
      return null;
    end if;

    v_start := platform_period_date(new.current_period_start);
    v_end := platform_period_date(new.current_period_end);
    v_days := v_end - v_start;
    v_left := least(v_days, v_end - v_today);
    if v_days <= 0 or v_left <= 0 then
      return null;
    end if;

    -- Los descuentos porcentuales vigentes también aplican a la diferencia.
    select least(100, coalesce(sum(d.value), 0)) into v_pct
      from tenant_discounts d
     where d.tenant_id = new.tenant_id and d.deleted_at is null and d.kind = 'percent' and d.value > 0
       and d.valid_from <= v_today and (d.valid_until is null or d.valid_until >= v_today);

    v_debit := round(coalesce(v_new_price, 0) * (100 - v_pct) * v_left / v_days)::bigint;   -- centavos
    v_credit := round(coalesce(v_old_price, 0) * (100 - v_pct) * v_left / v_days)::bigint;
    if v_debit - v_credit <= 0 then
      return null;
    end if;

    perform platform_create_charge(
      new.tenant_id, new.id, 'proration',
      'Diferencia por pasar a Plan ' || coalesce(v_new_name, '') || ' (' || v_left || ' de ' || v_days || ' días)',
      v_today, v_end, v_end,
      jsonb_build_array(
        jsonb_build_object('source', 'proration_debit',
          'description', 'Plan ' || coalesce(v_new_name, '') || ' · ' || v_left || ' días', 'amount_cents', v_debit,
          'ref_id', new.plan_id),
        jsonb_build_object('source', 'proration_credit',
          'description', 'Crédito Plan ' || coalesce(v_old_name, '') || ' · ' || v_left || ' días', 'amount_cents', -v_credit,
          'ref_id', old.plan_id)),
      'prorate:' || new.id::text || ':' || v_start::text || ':' || new.plan_id::text,
      auth.uid(), 'plan_change', null);
  exception when others then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, null, 'platform_charge', new.id, 'platform_proration_failed',
            jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate, 'old_plan', old.plan_id, 'new_plan', new.plan_id));
  end;
  return null;
end;
$$;
drop trigger if exists subscriptions_proration on subscriptions;
create trigger subscriptions_proration after update of plan_id on subscriptions
  for each row execute function trg_subscriptions_proration();

-- -----------------------------------------------------------------------------
-- I) Pago durante la prueba (§22 #11): el período pago empieza al terminar la
--    prueba, no el día del pago (incluye pruebas extendidas, que mueven
--    tenants.trial_ends_at y no current_period_end). Resto idéntico a
--    20260608660000.
-- -----------------------------------------------------------------------------
create or replace function reanchor_subscription_period(
  p_subscription_id uuid,
  p_months          int default 1,
  p_now             timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_sub       subscriptions%rowtype;
  v_months    int := greatest(coalesce(p_months, 1), 1);
  v_anchor    timestamptz;
  v_end       timestamptz;
  v_guard     int := 0;
  v_trial_end timestamptz;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if not found then
    raise exception 'subscription_not_found';
  end if;

  if coalesce(v_sub.cancel_at_period_end, false)
     and v_sub.current_period_end is not null
     and v_sub.current_period_end <= p_now then
    update subscriptions
       set status = 'cancelled', updated_at = now()
     where id = p_subscription_id;
    update tenants
       set status = 'cancelled', updated_at = now()
     where id = v_sub.tenant_id
       and status in ('past_due', 'suspended', 'active');
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            before_data, after_data)
    values (v_sub.tenant_id, null, 'subscriptions', p_subscription_id,
            'subscription_cancelled_on_reanchor',
            jsonb_build_object('status', v_sub.status,
                               'cancel_at_period_end', true,
                               'current_period_end', v_sub.current_period_end),
            jsonb_build_object('status', 'cancelled',
                               'reason', 'cancel_at_period_end_expired'));
    return v_sub.current_period_end;
  end if;

  select t.trial_ends_at into v_trial_end from tenants t where t.id = v_sub.tenant_id;

  if v_sub.status = 'trial' and v_trial_end is not null and v_trial_end > p_now then
    -- Pagó durante la prueba: el período pago arranca al terminar la prueba.
    v_anchor := v_trial_end;
  else
    v_anchor := coalesce(v_sub.current_period_end, v_sub.current_period_start, p_now);
  end if;
  v_end := v_anchor + make_interval(months => v_months);

  while v_end <= p_now and v_guard < 240 loop
    v_anchor := v_end;
    v_end    := v_anchor + make_interval(months => v_months);
    v_guard  := v_guard + 1;
  end loop;

  update subscriptions
     set status               = 'active',
         current_period_start = v_anchor,
         current_period_end   = v_end,
         updated_at           = now()
   where id = p_subscription_id;

  update tenants
     set status = 'active', updated_at = now()
   where id = v_sub.tenant_id
     and status in ('past_due', 'suspended');

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_sub.tenant_id, null, 'subscriptions', p_subscription_id, 'subscription_reactivated',
          jsonb_build_object('status', v_sub.status,
                             'current_period_start', v_sub.current_period_start,
                             'current_period_end', v_sub.current_period_end),
          jsonb_build_object('status', 'active',
                             'current_period_start', v_anchor,
                             'current_period_end', v_end,
                             'anchored_to_previous_due', v_sub.status <> 'trial',
                             'anchored_to_trial_end', v_sub.status = 'trial' and v_anchor = v_trial_end,
                             'cycles_advanced', v_guard));

  return v_end;
end;
$fn$;
revoke all on function reanchor_subscription_period(uuid, int, timestamptz) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- J) Corrida del cron: reintenta billing_records sin pasar al ledger y genera
--    los cargos de los períodos que empezaron (renovaciones). Idempotente.
--    Débito automático: espera mp_wait_days al webhook antes de generar.
-- -----------------------------------------------------------------------------
create or replace function platform_billing_run(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_set     platform_billing_settings%rowtype;
  v_today   date := platform_ar_date(p_now);
  r         record;
  v_start   date;
  v_end     date;
  v_next    date;
  v_wait    int;
  v_due     int;
  v_synced  int := 0;
  v_charges int := 0;
  v_errors  int := 0;
  v_id      uuid;
begin
  select * into v_set from platform_billing_settings where id;

  -- 1) billing_records que no entraron (error transitorio en el trigger).
  for r in
    select br.id, br.tenant_id
      from billing_records br
     where not exists (select 1 from platform_ingest_log l where l.billing_record_id = br.id)
     order by br.created_at
     limit 500
  loop
    begin
      perform platform_ingest_billing_record(r.id, false);
      v_synced := v_synced + 1;
    exception when others then
      v_errors := v_errors + 1;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (r.tenant_id, null, 'platform_payment', r.id, 'platform_ledger_ingest_failed',
              jsonb_build_object('billing_record_id', r.id, 'error', sqlerrm, 'sqlstate', sqlstate, 'source', 'cron'));
    end;
  end loop;

  -- 2) Cargos de período (vigente y renovación vencida sin pagar).
  for r in
    select s.id, s.tenant_id, s.billing_cycle, s.current_period_start, s.current_period_end
      from subscriptions s
      join tenants t on t.id = s.tenant_id
     where s.status in ('active', 'past_due')
       and s.current_period_start is not null
       and s.current_period_end is not null
       and t.deleted_at is null
  loop
    begin
      continue when platform_billing_exclusion(r.tenant_id) is not null;
      v_wait := case when platform_effective_billing_mode(r.tenant_id) = 'mp_subscription'
                     then v_set.mp_wait_days else 0 end;
      select coalesce(bt.due_days, v_set.due_days_default) into v_due
        from (select 1) x left join tenant_billing_terms bt on bt.tenant_id = r.tenant_id;
      v_start := platform_period_date(r.current_period_start);
      v_end := platform_period_date(r.current_period_end);

      if v_start >= v_set.ledger_since and v_today >= v_start + v_wait then
        v_id := platform_ensure_period_charge(r.id, v_start, v_end, v_start + coalesce(v_due, 0), null, 'cron');
        if v_id is not null then v_charges := v_charges + 1; end if;
      end if;

      if v_end >= v_set.ledger_since and v_today >= v_end + v_wait then
        v_next := (v_end + case when r.billing_cycle = 'yearly' then interval '12 months' else interval '1 month' end)::date;
        v_id := platform_ensure_period_charge(r.id, v_end, v_next, v_end + coalesce(v_due, 0), null, 'cron');
        if v_id is not null then v_charges := v_charges + 1; end if;
      end if;
    exception when others then
      v_errors := v_errors + 1;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (r.tenant_id, null, 'platform_charge', r.id, 'platform_billing_run_failed',
              jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate));
    end;
  end loop;

  return jsonb_build_object('synced', v_synced, 'charges_touched', v_charges, 'errors', v_errors, 'today', v_today);
end;
$$;

revoke all on function platform_cents(numeric) from public, anon, authenticated;
revoke all on function platform_lock_tenant(uuid) from public, anon, authenticated;
revoke all on function platform_movement_open_cents(uuid) from public, anon, authenticated;
revoke all on function platform_post_movement(uuid, text, bigint, date, date, text, text, uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function platform_refresh_charge_status(uuid) from public, anon, authenticated;
revoke all on function platform_auto_allocate(uuid, uuid) from public, anon, authenticated;
revoke all on function platform_create_charge(uuid, uuid, text, text, date, date, date, jsonb, text, uuid, text, text) from public, anon, authenticated;
revoke all on function platform_period_lines(uuid, date) from public, anon, authenticated;
revoke all on function platform_ensure_period_charge(uuid, date, date, date, bigint, text) from public, anon, authenticated;
revoke all on function platform_ingest_billing_record(uuid, boolean) from public, anon, authenticated;
revoke all on function platform_billing_run(timestamptz) from public, anon, authenticated;
revoke all on function trg_billing_records_to_ledger() from public, anon, authenticated;
revoke all on function trg_subscriptions_proration() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- K) Backfill: billing_records existentes → pagos + cargos históricos por el
--    mismo importe. Idempotente (platform_ingest_log).
-- -----------------------------------------------------------------------------
do $backfill$
declare
  r record;
begin
  for r in
    select br.id
      from billing_records br
     where not exists (select 1 from platform_ingest_log l where l.billing_record_id = br.id)
     order by br.created_at, br.id
  loop
    perform platform_ingest_billing_record(r.id, true);
  end loop;
end
$backfill$;

-- Las suscripciones lifetime pasan a la modalidad exenta con motivo (§5.2).
insert into tenant_billing_terms (tenant_id, billing_mode, exempt_reason, notes)
select s.tenant_id, 'exempt', 'Cuenta lifetime (migrada del flag is_lifetime)', 'F20-1'
  from subscriptions s
 where s.is_lifetime
on conflict (tenant_id) do nothing;

-- -----------------------------------------------------------------------------
-- L) pg_cron: cada hora. Sin pg_cron (stack local, CI) se omite.
-- -----------------------------------------------------------------------------
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite platform-billing-run.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'platform-billing-run') then
    perform cron.unschedule('platform-billing-run');
  end if;
  perform cron.schedule('platform-billing-run', '17 * * * *', $$select public.platform_billing_run()$$);
end
$cron$;
