-- =============================================================================
-- 20261124100000_cobranza_mora_punitorios  (F20-9 · H135 · ADR-128)
--
-- Punitorios, escalera de mora, restricción blanda, promesas de pago y
-- feriados de la cobranza de la plataforma (spec docs/40-cobranza-saas.md
-- §6.1, §6.3, §10.3, §10.5, §11, §13.2, §18 y §22 #4, #5, #6 y #10).
--
--   · platform_interest_policies   tasa mensual, gracia, cálculo diario o por
--                                  mes empezado, tope, mínimo y modo de ND.
--                                  Asignables por plan
--                                  (platform_interest_policy_plans) o por
--                                  negocio (tenant_billing_terms), con default
--                                  de plataforma. Arranca apagado (§22 #4).
--   · platform_interest_schedule() cálculo puro, espejo EXACTO de
--                                  lib/billing/interest.ts (interestSchedule).
--   · platform_interest_accruals   estado de trabajo por cargo (política
--                                  congelada al empezar a devengar, devengado,
--                                  liquidado y posteado por mes).
--   · platform_interest_run()      cron diario 06:30 ART: recalcula desde cero
--                                  y postea en el ledger sólo la diferencia
--                                  (movimientos 'interest' con clave
--                                  int:{cargo}:{mes}:{liquidado}): idempotente
--                                  y se pone al día solo.
--   · Condonar / saldar            internal_interest_waive: total o parcial,
--                                  con el tope por nivel (ADR-115); arriba del
--                                  tope queda pending_approval y lo aprueba un
--                                  super_admin (internal_interest_waiver_decide).
--   · ND y NC (H130)               la factura con CAE todavía no existe: la ND
--                                  por punitorios y la NC por condonación
--                                  quedan como documentos internos pendientes
--                                  en platform_fiscal_pending
--                                  (status 'pending_h130'). HOOK H130: el
--                                  worker platform_invoicing va a tomar esas
--                                  filas, emitirlas y completar document_id.
--                                  Nada de emisión fiscal acá.
--   · Escalera de mora             platform_dunning_ladders / _steps
--                                  configurables (aviso, pago pendiente,
--                                  restricción blanda, suspensión, marcar
--                                  incobrable), por negocio o default.
--                                  REEMPLAZA a saas-dunning: el cron viejo se
--                                  desprograma y run_saas_dunning() queda sólo
--                                  con los avisos de prueba y de renovación de
--                                  Mercado Pago.
--   · Promesas de pago             platform_promises: el staff o el dueño (con
--                                  límites) prometen monto y fecha; frenan los
--                                  pasos marcados requires_no_promise; si se
--                                  incumple, la escalera retoma donde estaba.
--   · Feriados                     platform_holidays (editable): un vencimiento
--                                  en día no hábil corre al próximo hábil y la
--                                  escalera no avanza en fin de semana ni
--                                  feriado.
--   · Timeline                     cada devengo, condonación, promesa y paso de
--                                  la escalera escribe en audit_logs, que
--                                  platform_statement muestra en la historia
--                                  de la cuenta.
--
-- Exclusiones (§22 #7): negocios de prueba, del staff, lifetime y exentos no
-- devengan ni entran en la escalera (platform_billing_exclusion).
--
-- RLS: tablas de plataforma, SELECT sólo staff con (select internal_scope());
-- el negocio no lee ninguna tabla directo: ve su estado de mora con
-- my_billing_mora() (dueño o encargado), la restricción con
-- my_billing_restriction() (cualquier miembro, sin importes) y carga su
-- promesa con owner_promise_create() (sólo dueño). Escritura sólo por RPC
-- SECURITY DEFINER con motivo y auditoría. Nunca OR is_internal().
--
-- Requiere 20261113100000, 20261113100100 y 20261116100000 (ADR-115/120).
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Configuración: políticas, escaleras y feriados
-- -----------------------------------------------------------------------------
create table if not exists platform_interest_policies (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(btrim(name)) between 2 and 80),
  monthly_rate_bp  int not null check (monthly_rate_bp between 0 and 10000),
  grace_days       int not null default 0 check (grace_days between 0 and 90),
  method           text not null default 'daily_prorata' check (method in ('daily_prorata', 'per_month_started')),
  cap_bp           int check (cap_bp is null or cap_bp between 0 and 100000),
  min_amount_cents bigint not null default 0 check (min_amount_cents between 0 and 100000000),
  bill_mode        text not null default 'on_collection' check (bill_mode in ('on_collection', 'monthly')),
  is_active        boolean not null default true,
  created_by       uuid references users(id),
  updated_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  archived_at      timestamptz
);
create index if not exists platform_interest_policies_created_by_idx on platform_interest_policies (created_by);
create index if not exists platform_interest_policies_updated_by_idx on platform_interest_policies (updated_by);

create table if not exists platform_interest_policy_plans (
  plan_id    uuid primary key references plans(id) on delete cascade,
  policy_id  uuid not null references platform_interest_policies(id) on delete restrict,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create index if not exists platform_interest_policy_plans_policy_idx on platform_interest_policy_plans (policy_id);
create index if not exists platform_interest_policy_plans_updated_by_idx on platform_interest_policy_plans (updated_by);

create table if not exists platform_dunning_ladders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 2 and 80),
  is_active   boolean not null default true,
  created_by  uuid references users(id),
  updated_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists platform_dunning_ladders_created_by_idx on platform_dunning_ladders (created_by);
create index if not exists platform_dunning_ladders_updated_by_idx on platform_dunning_ladders (updated_by);

create table if not exists platform_dunning_steps (
  id                  uuid primary key default gen_random_uuid(),
  ladder_id           uuid not null references platform_dunning_ladders(id) on delete restrict,
  position            int not null default 0,
  offset_days         int not null check (offset_days between 0 and 365),
  action              text not null check (action in ('notify', 'past_due', 'soft_restrict', 'suspend', 'mark_uncollectible')),
  channels            text[] not null default '{email,in_app}' check (channels <@ array['email', 'in_app']::text[]),
  requires_no_promise boolean not null default false,
  min_debt_cents      bigint not null default 0 check (min_debt_cents >= 0),
  title               text not null check (length(btrim(title)) between 2 and 120),
  body                text not null check (length(btrim(body)) between 2 and 1000),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create index if not exists platform_dunning_steps_ladder_idx on platform_dunning_steps (ladder_id, offset_days, position);

create table if not exists platform_holidays (
  day        date primary key,
  name       text not null check (length(btrim(name)) between 2 and 80),
  source     text not null default 'seed' check (source in ('seed', 'staff')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists platform_holidays_created_by_idx on platform_holidays (created_by);

comment on table platform_interest_policies is
  'F20-9 (ADR-128): políticas de punitorios (tasa mensual en bp, gracia, diario o por mes empezado, tope sobre el capital, mínimo por mes, ND al cobrar o mensual). Escritura sólo super_admin por RPC.';
comment on table platform_dunning_steps is
  'F20-9 (ADR-128): pasos de la escalera de mora, en días desde el vencimiento efectivo (próximo día hábil). Los pasos se editan en su lugar (el id es la clave de idempotencia); quitar uno es baja lógica.';
comment on table platform_holidays is
  'F20-9 (ADR-128): feriados nacionales. Un vencimiento en día no hábil corre al próximo hábil y la escalera no avanza en fin de semana ni feriado. Editable por super_admin.';

-- Configuración global (§22 #4, #5, #6 y #10).
alter table platform_billing_settings
  add column if not exists interest_enabled boolean not null default false,
  add column if not exists interest_since date,
  add column if not exists interest_on_mp boolean not null default false,
  add column if not exists default_interest_policy_id uuid references platform_interest_policies(id),
  add column if not exists dunning_enabled boolean not null default true,
  add column if not exists default_dunning_ladder_id uuid references platform_dunning_ladders(id),
  add column if not exists dunning_min_debt_cents bigint not null default 100,
  add column if not exists promise_self_enabled boolean not null default true,
  add column if not exists promise_max_days int not null default 15,
  add column if not exists promise_staff_max_days int not null default 30,
  add column if not exists promise_max_broken int not null default 2,
  add column if not exists soft_restrict_areas text[] not null default '{reportes,configuracion}';

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_billing_settings_mora_check') then
    alter table platform_billing_settings add constraint platform_billing_settings_mora_check check (
      dunning_min_debt_cents between 0 and 100000000
      and promise_max_days between 1 and 60
      and promise_staff_max_days between 1 and 90
      and promise_max_broken between 1 and 10
      and soft_restrict_areas <@ array['reportes', 'configuracion', 'importaciones', 'integraciones']::text[]);
  end if;
end
$c$;

-- Por negocio: null = hereda.
alter table tenant_billing_terms
  add column if not exists interest_policy_id uuid references platform_interest_policies(id),
  add column if not exists interest_enabled boolean not null default true,
  add column if not exists dunning_ladder_id uuid references platform_dunning_ladders(id),
  add column if not exists self_promise_enabled boolean;
create index if not exists tenant_billing_terms_interest_policy_idx on tenant_billing_terms (interest_policy_id);
create index if not exists tenant_billing_terms_dunning_ladder_idx on tenant_billing_terms (dunning_ladder_id);

-- -----------------------------------------------------------------------------
-- B) Estado de trabajo, eventos y documentos pendientes
-- -----------------------------------------------------------------------------
-- Pausas del devengamiento [from, to): tenant_id null = pausa global (se
-- apagaron los punitorios de la plataforma). Sólo cortan hacia adelante.
create table if not exists platform_interest_pauses (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references tenants(id) on delete restrict,
  from_date    date not null,
  to_date      date,
  reason       text not null check (length(btrim(reason)) >= 5),
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  ended_by     uuid references users(id),
  ended_at     timestamptz,
  ended_reason text,
  constraint platform_interest_pauses_range check (to_date is null or to_date >= from_date)
);
create unique index if not exists platform_interest_pauses_open_uidx
  on platform_interest_pauses ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))) where to_date is null;
create index if not exists platform_interest_pauses_tenant_idx on platform_interest_pauses (tenant_id, from_date);
create index if not exists platform_interest_pauses_created_by_idx on platform_interest_pauses (created_by);
create index if not exists platform_interest_pauses_ended_by_idx on platform_interest_pauses (ended_by);

create table if not exists platform_interest_accruals (
  charge_id         uuid primary key references platform_charges(id) on delete restrict,
  tenant_id         uuid not null references tenants(id) on delete restrict,
  debit_movement_id uuid not null references platform_ledger(id) on delete restrict,
  policy_id         uuid references platform_interest_policies(id) on delete restrict,
  -- Política congelada al empezar a devengar: cambiar la política después
  -- rige para las deudas nuevas.
  policy            jsonb not null,
  effective_due     date not null,
  accrue_from       date not null,
  original_cents    bigint not null check (original_cents >= 0),
  accrued_cents     bigint not null default 0,
  liquidated_cents  bigint not null default 0,
  pending_cents     bigint not null default 0,
  posted_cents      bigint not null default 0,
  cap_reached       boolean not null default false,
  -- [{month, accrued_cents, liquidated_cents, posted_cents}]
  months            jsonb not null default '[]'::jsonb,
  accrued_through   date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists platform_interest_accruals_tenant_idx on platform_interest_accruals (tenant_id, effective_due);
create index if not exists platform_interest_accruals_debit_idx on platform_interest_accruals (debit_movement_id);
create index if not exists platform_interest_accruals_policy_idx on platform_interest_accruals (policy_id);

create table if not exists platform_interest_waivers (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete restrict,
  request_id         uuid unique,
  -- null = todos los punitorios pendientes ("Saldar punitorios").
  movement_ids       uuid[],
  amount_cents       bigint not null check (amount_cents > 0),
  status             text not null check (status in ('applied', 'pending_approval', 'rejected')),
  reason             text not null check (length(btrim(reason)) >= 5),
  requested_by       uuid references users(id),
  requested_role     text,
  decided_by         uuid references users(id),
  decided_at         timestamptz,
  decision_reason    text,
  ledger_movement_id uuid references platform_ledger(id) on delete restrict,
  applied_cents      bigint,
  credit_note_cents  bigint not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists platform_interest_waivers_tenant_idx on platform_interest_waivers (tenant_id, created_at desc);
create index if not exists platform_interest_waivers_pending_idx on platform_interest_waivers (created_at) where status = 'pending_approval';
create index if not exists platform_interest_waivers_requested_by_idx on platform_interest_waivers (requested_by);
create index if not exists platform_interest_waivers_decided_by_idx on platform_interest_waivers (decided_by);
create index if not exists platform_interest_waivers_movement_idx on platform_interest_waivers (ledger_movement_id);

-- HOOK H130: comprobantes fiscales que la cobranza ya sabe que hay que emitir
-- pero que todavía no se pueden emitir (no hay factura con CAE ni
-- platform_documents). El worker de H130 los toma (status 'pending_h130'),
-- los emite con CbtesAsoc y completa document_id + status 'issued'.
create table if not exists platform_fiscal_pending (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete restrict,
  kind               text not null check (kind in ('debit_note', 'credit_note')),
  concept            text not null check (concept in ('interest_collected', 'interest_month', 'interest_waiver')),
  amount_cents       bigint not null check (amount_cents > 0),
  ledger_movement_id uuid references platform_ledger(id) on delete restrict,
  allocation_id      uuid references platform_allocations(id) on delete restrict,
  waiver_id          uuid references platform_interest_waivers(id) on delete restrict,
  charge_id          uuid references platform_charges(id) on delete restrict,
  period_month       date,
  assoc_id           uuid references platform_fiscal_pending(id) on delete restrict,
  status             text not null default 'pending_h130' check (status in ('pending_h130', 'cancelled', 'issued')),
  document_id        uuid,
  idempotency_key    text not null unique,
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  cancelled_at       timestamptz
);
create index if not exists platform_fiscal_pending_tenant_idx on platform_fiscal_pending (tenant_id, created_at desc);
create index if not exists platform_fiscal_pending_status_idx on platform_fiscal_pending (status, created_at);
create index if not exists platform_fiscal_pending_movement_idx on platform_fiscal_pending (ledger_movement_id);
create index if not exists platform_fiscal_pending_allocation_idx on platform_fiscal_pending (allocation_id);
create index if not exists platform_fiscal_pending_waiver_idx on platform_fiscal_pending (waiver_id);
create index if not exists platform_fiscal_pending_charge_idx on platform_fiscal_pending (charge_id, period_month);
create index if not exists platform_fiscal_pending_assoc_idx on platform_fiscal_pending (assoc_id);

create table if not exists platform_promises (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete restrict,
  amount_cents     bigint not null check (amount_cents > 0),
  promised_date    date not null,
  original_date    date not null,
  status           text not null default 'open' check (status in ('open', 'kept', 'broken', 'cancelled')),
  channel          text not null check (channel in ('owner', 'staff')),
  note             text check (note is null or length(note) <= 500),
  debt_movement_id uuid references platform_ledger(id) on delete restrict,
  paid_cents       bigint,
  extended_count   int not null default 0,
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      uuid references users(id),
  resolve_reason   text,
  updated_at       timestamptz not null default now()
);
create unique index if not exists platform_promises_open_uidx on platform_promises (tenant_id) where status = 'open';
create index if not exists platform_promises_tenant_idx on platform_promises (tenant_id, created_at desc);
create index if not exists platform_promises_debt_idx on platform_promises (debt_movement_id);
create index if not exists platform_promises_created_by_idx on platform_promises (created_by);
create index if not exists platform_promises_resolved_by_idx on platform_promises (resolved_by);

-- Estado de cobranza derivado (spec §5.1 collection_state), lo mantiene el
-- motor de mora. No se edita a mano.
create table if not exists platform_collection_status (
  tenant_id         uuid primary key references tenants(id) on delete restrict,
  state             text not null default 'al_dia' check (state in ('al_dia', 'vencida', 'en_promesa', 'incobrable')),
  days_overdue      int not null default 0,
  due_cents         bigint not null default 0,
  overdue_cents     bigint not null default 0,
  debt_movement_id  uuid references platform_ledger(id) on delete restrict,
  oldest_due        date,
  effective_due     date,
  ladder_id         uuid references platform_dunning_ladders(id) on delete restrict,
  last_step_id      uuid references platform_dunning_steps(id) on delete restrict,
  last_step_at      timestamptz,
  next_step_id      uuid references platform_dunning_steps(id) on delete restrict,
  next_step_date    date,
  suspend_on        date,
  soft_restricted   boolean not null default false,
  restricted_since  timestamptz,
  status_by_ladder  text check (status_by_ladder in ('past_due', 'suspended')),
  uncollectible_at  timestamptz,
  evaluated_at      timestamptz not null default now()
);
create index if not exists platform_collection_status_state_idx on platform_collection_status (state, days_overdue desc);
create index if not exists platform_collection_status_debt_idx on platform_collection_status (debt_movement_id);
create index if not exists platform_collection_status_ladder_idx on platform_collection_status (ladder_id);
create index if not exists platform_collection_status_last_step_idx on platform_collection_status (last_step_id);
create index if not exists platform_collection_status_next_step_idx on platform_collection_status (next_step_id);

-- Pasos ejecutados. Idempotencia (§11.2): un paso por (negocio, paso, deuda
-- más vieja) mientras la deuda siga abierta. Al saldarse la deuda los eventos
-- se cierran: si un contracargo la reabre, la escalera corre otra vez
-- (§17.3).
create table if not exists platform_dunning_events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete restrict,
  ladder_id        uuid references platform_dunning_ladders(id) on delete restrict,
  step_id          uuid not null references platform_dunning_steps(id) on delete restrict,
  debt_movement_id uuid not null references platform_ledger(id) on delete restrict,
  action           text not null,
  offset_days      int not null,
  days_overdue     int not null,
  due_cents        bigint not null,
  notified         boolean not null default false,
  promise_id       uuid references platform_promises(id) on delete restrict,
  executed_at      timestamptz not null default now(),
  closed_at        timestamptz,
  close_reason     text
);
create unique index if not exists platform_dunning_events_open_uidx
  on platform_dunning_events (tenant_id, step_id, debt_movement_id) where closed_at is null;
create index if not exists platform_dunning_events_tenant_idx on platform_dunning_events (tenant_id, executed_at desc);
create index if not exists platform_dunning_events_ladder_idx on platform_dunning_events (ladder_id);
create index if not exists platform_dunning_events_step_idx on platform_dunning_events (step_id);
create index if not exists platform_dunning_events_debt_idx on platform_dunning_events (debt_movement_id);
create index if not exists platform_dunning_events_promise_idx on platform_dunning_events (promise_id);

-- Nada de esto se borra (baja lógica o estado).
create or replace function platform_mora_no_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% no se borra: se cierra o cambia de estado', tg_table_name using errcode = '42501';
end;
$$;
drop trigger if exists platform_dunning_events_no_delete on platform_dunning_events;
create trigger platform_dunning_events_no_delete before delete on platform_dunning_events
  for each row execute function platform_mora_no_delete();
drop trigger if exists platform_promises_no_delete on platform_promises;
create trigger platform_promises_no_delete before delete on platform_promises
  for each row execute function platform_mora_no_delete();
drop trigger if exists platform_interest_waivers_no_delete on platform_interest_waivers;
create trigger platform_interest_waivers_no_delete before delete on platform_interest_waivers
  for each row execute function platform_mora_no_delete();
drop trigger if exists platform_fiscal_pending_no_delete on platform_fiscal_pending;
create trigger platform_fiscal_pending_no_delete before delete on platform_fiscal_pending
  for each row execute function platform_mora_no_delete();
drop trigger if exists platform_interest_pauses_no_delete on platform_interest_pauses;
create trigger platform_interest_pauses_no_delete before delete on platform_interest_pauses
  for each row execute function platform_mora_no_delete();

-- -----------------------------------------------------------------------------
-- C) RLS: sólo staff lee; nadie escribe directo
-- -----------------------------------------------------------------------------
alter table platform_interest_policies     enable row level security;
alter table platform_interest_policy_plans enable row level security;
alter table platform_dunning_ladders       enable row level security;
alter table platform_dunning_steps         enable row level security;
alter table platform_holidays              enable row level security;
alter table platform_interest_pauses       enable row level security;
alter table platform_interest_accruals     enable row level security;
alter table platform_interest_waivers      enable row level security;
alter table platform_fiscal_pending        enable row level security;
alter table platform_promises              enable row level security;
alter table platform_collection_status     enable row level security;
alter table platform_dunning_events        enable row level security;

drop policy if exists platform_interest_policies_staff on platform_interest_policies;
create policy platform_interest_policies_staff on platform_interest_policies
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_interest_policy_plans_staff on platform_interest_policy_plans;
create policy platform_interest_policy_plans_staff on platform_interest_policy_plans
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_dunning_ladders_staff on platform_dunning_ladders;
create policy platform_dunning_ladders_staff on platform_dunning_ladders
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_dunning_steps_staff on platform_dunning_steps;
create policy platform_dunning_steps_staff on platform_dunning_steps
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_holidays_staff on platform_holidays;
create policy platform_holidays_staff on platform_holidays
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_interest_pauses_staff on platform_interest_pauses;
create policy platform_interest_pauses_staff on platform_interest_pauses
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_interest_accruals_staff on platform_interest_accruals;
create policy platform_interest_accruals_staff on platform_interest_accruals
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_interest_waivers_staff on platform_interest_waivers;
create policy platform_interest_waivers_staff on platform_interest_waivers
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_fiscal_pending_staff on platform_fiscal_pending;
create policy platform_fiscal_pending_staff on platform_fiscal_pending
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_promises_staff on platform_promises;
create policy platform_promises_staff on platform_promises
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_collection_status_staff on platform_collection_status;
create policy platform_collection_status_staff on platform_collection_status
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_dunning_events_staff on platform_dunning_events;
create policy platform_dunning_events_staff on platform_dunning_events
  for select to authenticated using ((select internal_scope()));

revoke all on table platform_interest_policies, platform_interest_policy_plans, platform_dunning_ladders,
  platform_dunning_steps, platform_holidays, platform_interest_pauses, platform_interest_accruals,
  platform_interest_waivers, platform_fiscal_pending, platform_promises, platform_collection_status,
  platform_dunning_events from anon;
revoke insert, update, delete, truncate on table platform_interest_policies, platform_interest_policy_plans,
  platform_dunning_ladders, platform_dunning_steps, platform_holidays, platform_interest_pauses,
  platform_interest_accruals, platform_interest_waivers, platform_fiscal_pending, platform_promises,
  platform_collection_status, platform_dunning_events from authenticated;
grant select on table platform_interest_policies, platform_interest_policy_plans, platform_dunning_ladders,
  platform_dunning_steps, platform_holidays, platform_interest_pauses, platform_interest_accruals,
  platform_interest_waivers, platform_fiscal_pending, platform_promises, platform_collection_status,
  platform_dunning_events to authenticated;

-- -----------------------------------------------------------------------------
-- D) Días hábiles (espejo de isBusinessDay / nextBusinessDay de lib/billing/mora.ts)
-- -----------------------------------------------------------------------------
create or replace function platform_is_business_day(p date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select extract(isodow from p) < 6
     and not exists (select 1 from platform_holidays h where h.day = p and h.deleted_at is null)
$$;

create or replace function platform_next_business_day(p date)
returns date
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  d date := p;
  i int := 0;
begin
  if d is null then
    return null;
  end if;
  while i < 60 and not platform_is_business_day(d) loop
    d := d + 1;
    i := i + 1;
  end loop;
  return d;
end;
$$;

-- Feriados nacionales 2026 y 2027 (Ley 27.399 y decretos de feriados puente
-- 2026). Los de 2027 trasladables ya corridos; revisar los puentes cuando se
-- publiquen. Editables desde Cobranzas › Mora.
insert into platform_holidays (day, name) values
  ('2026-01-01', 'Año Nuevo'),
  ('2026-02-16', 'Carnaval'),
  ('2026-02-17', 'Carnaval'),
  ('2026-03-23', 'Feriado puente turístico'),
  ('2026-03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia'),
  ('2026-04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas'),
  ('2026-04-03', 'Viernes Santo'),
  ('2026-05-01', 'Día del Trabajador'),
  ('2026-05-25', 'Día de la Revolución de Mayo'),
  ('2026-06-15', 'Paso a la Inmortalidad del Gral. Martín Miguel de Güemes'),
  ('2026-06-20', 'Paso a la Inmortalidad del Gral. Manuel Belgrano'),
  ('2026-07-09', 'Día de la Independencia'),
  ('2026-07-10', 'Feriado puente turístico'),
  ('2026-08-17', 'Paso a la Inmortalidad del Gral. José de San Martín'),
  ('2026-10-12', 'Día del Respeto a la Diversidad Cultural'),
  ('2026-11-23', 'Día de la Soberanía Nacional'),
  ('2026-12-07', 'Feriado puente turístico'),
  ('2026-12-08', 'Inmaculada Concepción de María'),
  ('2026-12-25', 'Navidad'),
  ('2027-01-01', 'Año Nuevo'),
  ('2027-02-08', 'Carnaval'),
  ('2027-02-09', 'Carnaval'),
  ('2027-03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia'),
  ('2027-03-26', 'Viernes Santo'),
  ('2027-04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas'),
  ('2027-05-01', 'Día del Trabajador'),
  ('2027-05-25', 'Día de la Revolución de Mayo'),
  ('2027-06-20', 'Paso a la Inmortalidad del Gral. Manuel Belgrano'),
  ('2027-06-21', 'Paso a la Inmortalidad del Gral. Martín Miguel de Güemes'),
  ('2027-07-09', 'Día de la Independencia'),
  ('2027-08-16', 'Paso a la Inmortalidad del Gral. José de San Martín'),
  ('2027-10-11', 'Día del Respeto a la Diversidad Cultural'),
  ('2027-11-22', 'Día de la Soberanía Nacional'),
  ('2027-12-08', 'Inmaculada Concepción de María'),
  ('2027-12-25', 'Navidad')
on conflict (day) do nothing;

-- -----------------------------------------------------------------------------
-- E) Cálculo puro del punitorio (espejo EXACTO de interestSchedule)
-- -----------------------------------------------------------------------------
-- p_policy: {monthly_rate_bp, grace_days, method, cap_bp, min_amount_cents}
-- p_reductions: [{date, cents}] (lo imputado al cargo, con la fecha desde la
-- que el capital ya está reducido). p_pauses: [{from, to}] ([from, to)).
-- Devuelve {days_overdue, accrued_cents, liquidated_cents, pending_cents,
-- cap_cents, cap_reached, months: [{month, accrued_cents, liquidated_cents}]}.
create or replace function platform_interest_schedule(
  p_policy      jsonb,
  p_due         date,
  p_original    bigint,
  p_reductions  jsonb,
  p_as_of       date,
  p_accrue_from date default null,
  p_pauses      jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_bp      bigint := greatest(0, coalesce(trunc((p_policy ->> 'monthly_rate_bp')::numeric)::bigint, 0));
  v_grace   int := greatest(0, coalesce(trunc((p_policy ->> 'grace_days')::numeric)::int, 0));
  v_method  text := coalesce(p_policy ->> 'method', 'daily_prorata');
  v_cap_bp  bigint := trunc((p_policy ->> 'cap_bp')::numeric)::bigint;
  v_min     bigint := greatest(0, coalesce(trunc((p_policy ->> 'min_amount_cents')::numeric)::bigint, 0));
  v_orig    bigint := greatest(0, coalesce(p_original, 0));
  v_mstart  date := p_due + v_grace + 1;
  v_start   date := greatest(p_due + v_grace + 1, coalesce(p_accrue_from, p_due + v_grace + 1));
  v_days    int := greatest(0, p_as_of - (p_due + v_grace));
  v_cap     bigint;
  v_raw     jsonb := '{}'::jsonb;
  v_b       date;
  v_capital bigint;
  v_m       text;
  v_a       bigint;
  v_rawtot  bigint := 0;
  v_acc     bigint := 0;
  v_liq     bigint := 0;
  v_pend    bigint := 0;
  v_l       bigint;
  v_months  jsonb := '[]'::jsonb;
  r         record;
begin
  v_cap := case when v_cap_bp is null then null else (v_orig * greatest(0, v_cap_bp)) / 10000 end;

  if v_orig > 0 and v_bp > 0 and v_start <= p_as_of then
    if v_method = 'per_month_started' then
      v_b := v_mstart;
      while v_b <= p_as_of loop
        if v_b >= v_start and not exists (
             select 1 from jsonb_array_elements(coalesce(p_pauses, '[]'::jsonb)) x
              where v_b >= (x ->> 'from')::date
                and (nullif(x ->> 'to', '') is null or v_b < (x ->> 'to')::date)) then
          select greatest(0, v_orig - coalesce(sum(greatest(0, trunc((x ->> 'cents')::numeric)::bigint)), 0))
            into v_capital
            from jsonb_array_elements(coalesce(p_reductions, '[]'::jsonb)) x
           where (x ->> 'date')::date <= v_b;
          v_m := to_char(v_b, 'YYYY-MM');
          v_raw := jsonb_set(v_raw, array[v_m],
                             to_jsonb(coalesce((v_raw ->> v_m)::bigint, 0) + (2 * v_capital * v_bp + 10000) / 20000));
        end if;
        v_b := v_b + 30;
      end loop;
    else
      for r in
        with days as (
          select d::date as d
            from generate_series(v_start, p_as_of, interval '1 day') d
        ), red as (
          select (x ->> 'date')::date as rd, greatest(0, trunc((x ->> 'cents')::numeric)::bigint) as rc
            from jsonb_array_elements(coalesce(p_reductions, '[]'::jsonb)) x
        ), pz as (
          select (x ->> 'from')::date as f, nullif(x ->> 'to', '')::date as t
            from jsonb_array_elements(coalesce(p_pauses, '[]'::jsonb)) x
        )
        select to_char(days.d, 'YYYY-MM') as m,
               sum(greatest(0, v_orig - coalesce((select sum(red.rc) from red where red.rd <= days.d), 0)))::bigint as s
          from days
         where not exists (select 1 from pz where days.d >= pz.f and (pz.t is null or days.d < pz.t))
         group by 1
      loop
        v_raw := jsonb_set(v_raw, array[r.m], to_jsonb((2 * r.s * v_bp + 300000) / 600000));
      end loop;
    end if;
  end if;

  for r in select key as m, value::bigint as a from jsonb_each_text(v_raw) order by key loop
    v_a := r.a;
    v_rawtot := v_rawtot + v_a;
    if v_cap is not null then
      v_a := least(v_a, greatest(0, v_cap - v_acc));
    end if;
    v_acc := v_acc + v_a;
    v_pend := v_pend + v_a;
    v_l := 0;
    if v_pend > 0 and v_pend >= v_min then
      v_l := v_pend;
      v_pend := 0;
    end if;
    v_liq := v_liq + v_l;
    v_months := v_months || jsonb_build_object('month', r.m, 'accrued_cents', v_a, 'liquidated_cents', v_l);
  end loop;

  return jsonb_build_object(
    'days_overdue', v_days,
    'accrued_cents', v_acc,
    'liquidated_cents', v_liq,
    'pending_cents', v_pend,
    'cap_cents', v_cap,
    'cap_reached', v_cap is not null and v_rawtot > 0 and v_rawtot >= v_cap,
    'months', v_months);
end;
$$;

-- -----------------------------------------------------------------------------
-- F) Resolución de la política y la escalera de un negocio
-- -----------------------------------------------------------------------------
-- Política: la del negocio → la del plan → la default. Sólo activas.
create or replace function platform_interest_policy_for(p_tenant uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select p.id from tenant_billing_terms bt join platform_interest_policies p on p.id = bt.interest_policy_id
      where bt.tenant_id = p_tenant and p.is_active and p.archived_at is null),
    (select p.id from subscriptions s
       join platform_interest_policy_plans pp on pp.plan_id = s.plan_id
       join platform_interest_policies p on p.id = pp.policy_id
      where s.tenant_id = p_tenant and p.is_active and p.archived_at is null),
    (select p.id from platform_billing_settings st join platform_interest_policies p on p.id = st.default_interest_policy_id
      where st.id and p.is_active and p.archived_at is null))
$$;

create or replace function platform_interest_policy_source(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when exists (select 1 from tenant_billing_terms bt join platform_interest_policies p on p.id = bt.interest_policy_id
                  where bt.tenant_id = p_tenant and p.is_active and p.archived_at is null) then 'tenant'
    when exists (select 1 from subscriptions s join platform_interest_policy_plans pp on pp.plan_id = s.plan_id
                  join platform_interest_policies p on p.id = pp.policy_id
                  where s.tenant_id = p_tenant and p.is_active and p.archived_at is null) then 'plan'
    when exists (select 1 from platform_billing_settings st join platform_interest_policies p on p.id = st.default_interest_policy_id
                  where st.id and p.is_active and p.archived_at is null) then 'default'
  end
$$;

create or replace function platform_dunning_ladder_for(p_tenant uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select l.id from tenant_billing_terms bt join platform_dunning_ladders l on l.id = bt.dunning_ladder_id
      where bt.tenant_id = p_tenant and l.is_active and l.archived_at is null),
    (select l.id from platform_billing_settings st join platform_dunning_ladders l on l.id = st.default_dunning_ladder_id
      where st.id and l.is_active and l.archived_at is null))
$$;

create or replace function platform_interest_policy_json(p platform_interest_policies)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'monthly_rate_bp', p.monthly_rate_bp, 'grace_days', p.grace_days,
    'method', p.method, 'cap_bp', p.cap_bp, 'min_amount_cents', p.min_amount_cents, 'bill_mode', p.bill_mode)
$$;

-- -----------------------------------------------------------------------------
-- G) Devengamiento (cron platform-interest, 06:30 ART)
-- -----------------------------------------------------------------------------
-- Recalcula cada cargo vencido del negocio desde cero y postea sólo la
-- diferencia con lo ya posteado por mes. Idempotente: la clave del movimiento
-- incluye el liquidado acumulado del mes. Una corrida atrasada se pone al día
-- sola. Si después baja (un pago con fecha anterior), no se despostea: queda
-- lo devengado (ver ADR-128).
create or replace function platform_interest_accrue_tenant(p_tenant uuid, p_today date, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_set      platform_billing_settings%rowtype;
  v_excl     text := platform_billing_exclusion(p_tenant);
  v_mode     text;
  v_pol_id   uuid;
  v_pol      platform_interest_policies%rowtype;
  v_acc      platform_interest_accruals%rowtype;
  v_pauses   jsonb;
  v_red      jsonb;
  v_res      jsonb;
  v_mo       jsonb;
  v_old      jsonb;
  v_months   jsonb;
  v_m        text;
  v_target   bigint;
  v_posted   bigint;
  v_eff      date;
  v_eff_due  date;
  v_total    bigint := 0;
  v_charges  int := 0;
  v_sum_post bigint;
  v_nd       bigint;
  r          record;
begin
  select * into v_set from platform_billing_settings where id;
  if not coalesce(v_set.interest_enabled, false) then
    return jsonb_build_object('skipped', 'disabled');
  end if;
  if v_excl is not null then
    return jsonb_build_object('skipped', v_excl);
  end if;
  v_mode := platform_effective_billing_mode(p_tenant);
  if v_mode = 'mp_subscription' and not v_set.interest_on_mp then
    return jsonb_build_object('skipped', 'mp_subscription');
  end if;

  perform platform_lock_tenant(p_tenant);
  select coalesce(jsonb_agg(jsonb_build_object('from', pz.from_date, 'to', pz.to_date)), '[]'::jsonb)
    into v_pauses
    from platform_interest_pauses pz
   where pz.tenant_id = p_tenant or pz.tenant_id is null;

  for r in
    select c.id as charge_id, c.due_date, c.description, l.id as mv_id, l.amount_cents, l.effective_date as mv_eff
      from platform_charges c
      join platform_ledger l on l.charge_id = c.id and l.kind = 'charge'
     where c.tenant_id = p_tenant
       and c.kind <> 'interest'
       and c.status in ('open', 'partially_paid')
       and c.voided_at is null
       and c.due_date < p_today
     order by c.due_date, c.created_at
  loop
    select * into v_acc from platform_interest_accruals where charge_id = r.charge_id;
    if not found then
      v_pol_id := platform_interest_policy_for(p_tenant);
      continue when v_pol_id is null;
      select * into v_pol from platform_interest_policies where id = v_pol_id;
      v_eff_due := platform_next_business_day(r.due_date);
      insert into platform_interest_accruals (charge_id, tenant_id, debit_movement_id, policy_id, policy, effective_due,
                                              accrue_from, original_cents)
      values (r.charge_id, p_tenant, r.mv_id, v_pol.id, platform_interest_policy_json(v_pol), v_eff_due,
              greatest(v_eff_due + v_pol.grace_days + 1, coalesce(v_set.interest_since, v_eff_due + v_pol.grace_days + 1)),
              r.amount_cents)
      returning * into v_acc;
    end if;

    -- Capital reducido por lo imputado (activo), desde la fecha del crédito o
    -- del cargo, la que sea posterior.
    select coalesce(jsonb_agg(jsonb_build_object('date', greatest(cr.effective_date, r.mv_eff), 'cents', a.amount_cents)), '[]'::jsonb)
      into v_red
      from platform_allocations a
      join platform_ledger cr on cr.id = a.credit_movement_id
     where a.debit_movement_id = r.mv_id
       and a.released_at is null;

    v_res := platform_interest_schedule(v_acc.policy, v_acc.effective_due, v_acc.original_cents, v_red, p_today,
                                        v_acc.accrue_from, v_pauses);
    v_old := v_acc.months;
    v_months := '[]'::jsonb;
    v_sum_post := 0;
    for v_mo in select * from jsonb_array_elements(v_res -> 'months') loop
      v_m := v_mo ->> 'month';
      v_target := (v_mo ->> 'liquidated_cents')::bigint;
      select coalesce(max((x ->> 'posted_cents')::bigint), 0) into v_posted
        from jsonb_array_elements(v_old) x where x ->> 'month' = v_m;
      -- liquidated acumulado del mes: lo de meses anteriores arrastrado por el
      -- mínimo se liquida en este mes.
      if v_target > v_posted then
        v_eff := least(p_today, ((v_m || '-01')::date + interval '1 month - 1 day')::date);
        perform platform_post_movement(
          p_tenant, 'interest', v_target - v_posted, v_eff, v_eff,
          'Punitorio ' || to_char((v_m || '-01')::date, 'MM/YYYY') || ' · ' || r.description,
          null, r.charge_id, null, r.mv_id,
          'int:' || r.charge_id::text || ':' || v_m || ':' || v_target::text, p_actor);
        v_total := v_total + (v_target - v_posted);
        v_posted := v_target;
      end if;
      v_sum_post := v_sum_post + v_posted;
      v_months := v_months || jsonb_build_object(
        'month', v_m, 'accrued_cents', (v_mo ->> 'accrued_cents')::bigint,
        'liquidated_cents', v_target, 'posted_cents', v_posted);
    end loop;
    -- Meses posteados antes que ya no aparecen (no debería pasar): se conservan.
    v_months := v_months || coalesce((
      select jsonb_agg(x) from jsonb_array_elements(v_old) x
       where not exists (select 1 from jsonb_array_elements(v_months) y where y ->> 'month' = x ->> 'month')), '[]'::jsonb);
    select coalesce(sum((x ->> 'posted_cents')::bigint), 0) into v_sum_post from jsonb_array_elements(v_months) x;

    update platform_interest_accruals
       set accrued_cents = (v_res ->> 'accrued_cents')::bigint,
           liquidated_cents = (v_res ->> 'liquidated_cents')::bigint,
           pending_cents = (v_res ->> 'pending_cents')::bigint,
           posted_cents = v_sum_post,
           cap_reached = (v_res ->> 'cap_reached')::boolean,
           months = v_months,
           accrued_through = p_today,
           updated_at = now()
     where charge_id = r.charge_id;
    v_charges := v_charges + 1;
  end loop;

  -- ND mensual (bill_mode 'monthly'): una por cargo y mes cerrado, por lo
  -- posteado que todavía no tenga ND. HOOK H130: queda pendiente de emitir.
  for r in
    select a.charge_id, x ->> 'month' as m, (x ->> 'posted_cents')::bigint as posted
      from platform_interest_accruals a
      cross join lateral jsonb_array_elements(a.months) x
     where a.tenant_id = p_tenant
       and a.policy ->> 'bill_mode' = 'monthly'
       and (x ->> 'posted_cents')::bigint > 0
       and ((x ->> 'month') || '-01')::date < date_trunc('month', p_today)::date
  loop
    select coalesce(sum(f.amount_cents), 0) into v_nd
      from platform_fiscal_pending f
     where f.charge_id = r.charge_id and f.kind = 'debit_note' and f.concept = 'interest_month'
       and f.period_month = (r.m || '-01')::date and f.status <> 'cancelled';
    if r.posted > v_nd then
      insert into platform_fiscal_pending (tenant_id, kind, concept, amount_cents, charge_id, period_month,
                                           ledger_movement_id, idempotency_key, note)
      values (p_tenant, 'debit_note', 'interest_month', r.posted - v_nd, r.charge_id, (r.m || '-01')::date,
              (select l.id from platform_ledger l where l.charge_id = r.charge_id and l.kind = 'interest'
                  and split_part(l.idempotency_key, ':', 3) = r.m order by l.created_at desc limit 1),
              'nd:m:' || r.charge_id::text || ':' || r.m || ':' || r.posted::text,
              'Nota de débito por punitorios del mes (pendiente de H130)')
      on conflict (idempotency_key) do nothing;
    end if;
  end loop;

  if v_total > 0 then
    -- El saldo a favor que hubiera cubre primero los punitorios (FIFO, ADR-115).
    perform platform_auto_allocate(p_tenant, p_actor);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (p_tenant, p_actor, 'platform_ledger', null, 'platform_interest_accrued',
            jsonb_build_object('amount_cents', v_total, 'as_of', p_today, 'charges', v_charges));
  end if;
  return jsonb_build_object('posted_cents', v_total, 'charges', v_charges);
end;
$$;

create or replace function platform_interest_run(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today  date := platform_ar_date(p_now);
  v_set    platform_billing_settings%rowtype;
  v_res    jsonb;
  v_total  bigint := 0;
  v_n      int := 0;
  v_fail   int := 0;
  t        uuid;
begin
  select * into v_set from platform_billing_settings where id;
  if not coalesce(v_set.interest_enabled, false) then
    return jsonb_build_object('skipped', 'disabled', 'as_of', v_today);
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('platform_interest_run', 0)) then
    return jsonb_build_object('skipped', 'running');
  end if;
  for t in
    select distinct c.tenant_id
      from platform_charges c
     where c.status in ('open', 'partially_paid') and c.kind <> 'interest' and c.voided_at is null and c.due_date < v_today
    union
    select distinct a.tenant_id
      from platform_interest_accruals a
     where a.policy ->> 'bill_mode' = 'monthly' and a.posted_cents > 0 and a.updated_at > p_now - interval '62 days'
  loop
    begin
      v_res := platform_interest_accrue_tenant(t, v_today, null);
      v_total := v_total + coalesce((v_res ->> 'posted_cents')::bigint, 0);
      v_n := v_n + 1;
    exception when others then
      v_fail := v_fail + 1;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (t, null, 'platform_ledger', null, 'platform_interest_failed', jsonb_build_object('error', sqlerrm, 'as_of', v_today));
    end;
  end loop;
  return jsonb_build_object('as_of', v_today, 'tenants', v_n, 'posted_cents', v_total, 'failed', v_fail);
end;
$$;

-- ND al cobrar (bill_mode 'on_collection', §10.3): cuando un pago se imputa a
-- un punitorio queda la ND pendiente por lo imputado; si la imputación se
-- libera (reversa) y la ND sigue pendiente, se cancela. Nunca frena el pago.
create or replace function trg_platform_allocations_fiscal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dkind  text;
  v_charge uuid;
  v_ckind  text;
begin
  begin
    if tg_op = 'INSERT' then
      select d.kind, d.charge_id into v_dkind, v_charge from platform_ledger d where d.id = new.debit_movement_id;
      if v_dkind = 'interest' then
        select c.kind into v_ckind from platform_ledger c where c.id = new.credit_movement_id;
        if v_ckind = 'payment'
           and coalesce((select a.policy ->> 'bill_mode' from platform_interest_accruals a where a.charge_id = v_charge), 'on_collection') = 'on_collection' then
          insert into platform_fiscal_pending (tenant_id, kind, concept, amount_cents, ledger_movement_id, allocation_id,
                                               charge_id, idempotency_key, note)
          values (new.tenant_id, 'debit_note', 'interest_collected', new.amount_cents, new.debit_movement_id, new.id,
                  v_charge, 'nd:a:' || new.id::text, 'Nota de débito por punitorio cobrado (pendiente de H130)')
          on conflict (idempotency_key) do nothing;
        end if;
      end if;
    elsif tg_op = 'UPDATE' and old.released_at is null and new.released_at is not null then
      update platform_fiscal_pending
         set status = 'cancelled', cancelled_at = now(), updated_at = now()
       where allocation_id = new.id and status = 'pending_h130';
    end if;
  exception when others then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, null, 'platform_fiscal_pending', null, 'platform_fiscal_hook_failed',
            jsonb_build_object('error', sqlerrm, 'allocation_id', new.id));
  end;
  return null;
end;
$$;
drop trigger if exists platform_allocations_fiscal on platform_allocations;
create trigger platform_allocations_fiscal after insert or update on platform_allocations
  for each row execute function trg_platform_allocations_fiscal();

-- -----------------------------------------------------------------------------
-- H) Motor de mora (cron platform-dunning, 09:00 ART). Reemplaza saas-dunning.
-- -----------------------------------------------------------------------------
-- Deuda de un negocio a una fecha: la más vieja con saldo (vencimiento
-- efectivo = próximo día hábil), lo que vence hasta hoy y lo vencido antes de
-- hoy.
create or replace function platform_mora_debt(p_tenant uuid, p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  with mv as (
    select l.id, l.created_at, coalesce(l.due_date, l.effective_date) as due,
           l.amount_cents - coalesce((select sum(a.amount_cents) from platform_allocations a
                                       where a.debit_movement_id = l.id and a.released_at is null), 0) as open
      from platform_ledger l
     where l.tenant_id = p_tenant
       and l.amount_cents > 0
  ), o as (
    select mv.*, platform_next_business_day(mv.due) as eff from mv where mv.open > 0
  ), oldest as (
    select o.id, o.due, o.eff from o where o.eff <= p_today order by o.eff, o.due, o.created_at, o.id limit 1
  )
  select jsonb_build_object(
           'debt_movement_id', (select oldest.id from oldest),
           'oldest_due', (select oldest.due from oldest),
           'effective_due', (select oldest.eff from oldest),
           'days_overdue', coalesce((select p_today - oldest.eff from oldest), 0),
           'due_cents', coalesce((select sum(o.open) from o where o.eff <= p_today), 0),
           'overdue_cents', coalesce((select sum(o.open) from o where o.eff < p_today), 0),
           'open_cents', coalesce((select sum(o.open) from o), 0))
    into v;
  return v;
end;
$$;

-- Próximo paso pendiente (espejo de nextStep de lib/billing/mora.ts).
create or replace function platform_mora_next_step(
  p_ladder  uuid,
  p_tenant  uuid,
  p_debt    uuid,
  p_eff     date,
  p_today   date,
  p_promise boolean,
  p_actions text[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'step_id', s.id, 'action', s.action, 'title', s.title, 'offset_days', s.offset_days,
           'date', greatest(platform_next_business_day(p_eff + s.offset_days), platform_next_business_day(p_today)))
    from platform_dunning_steps s
   where s.ladder_id = p_ladder
     and p_eff is not null
     and s.is_active
     and s.deleted_at is null
     and (p_actions is null or s.action = any (p_actions))
     and not (s.requires_no_promise and coalesce(p_promise, false))
     and not exists (select 1 from platform_dunning_events e
                      where e.tenant_id = p_tenant and e.step_id = s.id
                        and e.debt_movement_id = p_debt and e.closed_at is null)
   order by s.offset_days, s.position
   limit 1
$$;

-- Texto de un paso (espejo de renderStepText).
create or replace function platform_dunning_render(p_text text, p_monto bigint, p_dias int, p_vence date, p_negocio text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select replace(replace(replace(replace(coalesce(p_text, ''),
           '{monto}', platform_format_ars(coalesce(p_monto, 0))),
           '{dias}', coalesce(p_dias, 0)::text),
           '{vence}', coalesce(to_char(p_vence, 'DD/MM/YYYY'), 'hoy')),
           '{negocio}', coalesce(p_negocio, ''))
$$;

-- Evalúa un negocio: resuelve la promesa, cierra los pasos de deudas saldadas,
-- levanta lo que puso la escalera si ya no hay deuda vencida y, si
-- p_run_steps (cron, día hábil), ejecuta los pasos que tocan. Sólo el último
-- paso del lote avisa al cliente (no le llegan tres emails juntos).
create or replace function platform_mora_evaluate(p_tenant uuid, p_today date, p_run_steps boolean, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_set      platform_billing_settings%rowtype;
  v_cs       platform_collection_status%rowtype;
  v_excl     text := platform_billing_exclusion(p_tenant);
  v_debt     jsonb;
  v_debt_mv  uuid;
  v_eff      date;
  v_days     int;
  v_due      bigint;
  v_over     bigint;
  v_min      bigint;
  v_ladder   uuid;
  v_prom     platform_promises%rowtype;
  v_paid     bigint;
  v_sub      subscriptions%rowtype;
  v_t        tenants%rowtype;
  v_steps    platform_dunning_steps[] := '{}';
  s          platform_dunning_steps%rowtype;
  v_n        int;
  v_i        int;
  v_ev       uuid;
  v_soft     boolean;
  v_since    timestamptz;
  v_by       text;
  v_unc      timestamptz;
  v_last     uuid;
  v_last_at  timestamptz;
  v_state    text;
  v_next     jsonb;
  v_susp     jsonb;
  v_lifted   boolean := false;
  v_held     int := 0;
  v_title    text;
  v_body     text;
  v_r        text;
  v_sev      text;
begin
  perform platform_lock_tenant(p_tenant);
  select * into v_set from platform_billing_settings where id;
  v_min := greatest(1, coalesce(v_set.dunning_min_debt_cents, 100));
  select * into v_cs from platform_collection_status where tenant_id = p_tenant;
  v_soft := coalesce(v_cs.soft_restricted, false);
  v_since := v_cs.restricted_since;
  v_by := v_cs.status_by_ladder;
  v_unc := v_cs.uncollectible_at;
  v_last := v_cs.last_step_id;
  v_last_at := v_cs.last_step_at;
  select * into v_sub from subscriptions where tenant_id = p_tenant;
  select * into v_t from tenants where id = p_tenant;
  v_debt := platform_mora_debt(p_tenant, p_today);
  v_debt_mv := (v_debt ->> 'debt_movement_id')::uuid;
  v_eff := (v_debt ->> 'effective_due')::date;
  v_days := (v_debt ->> 'days_overdue')::int;
  v_due := (v_debt ->> 'due_cents')::bigint;
  v_over := (v_debt ->> 'overdue_cents')::bigint;
  v_ladder := platform_dunning_ladder_for(p_tenant);

  -- 1) Promesa vigente: cumplida si se pagó lo prometido (o ya no hay deuda
  --    vencida); incumplida si pasó la fecha. Al incumplirse, la escalera
  --    retoma donde estaba (los pasos frenados se ejecutan en esta corrida).
  select * into v_prom from platform_promises where tenant_id = p_tenant and status = 'open';
  if v_prom.id is not null then
    select coalesce(-sum(l.amount_cents), 0) into v_paid
      from platform_ledger l
     where l.tenant_id = p_tenant and l.kind = 'payment' and l.created_at >= v_prom.created_at;
    if v_paid >= v_prom.amount_cents or v_over < v_min then
      update platform_promises set status = 'kept', paid_cents = v_paid, resolved_at = now(), updated_at = now()
       where id = v_prom.id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (p_tenant, null, 'platform_promise', v_prom.id, 'platform_promise_kept',
              jsonb_build_object('amount_cents', v_prom.amount_cents, 'paid_cents', v_paid, 'promised_date', v_prom.promised_date));
      v_prom.id := null;
    elsif v_prom.promised_date < p_today then
      update platform_promises set status = 'broken', paid_cents = v_paid, resolved_at = now(), updated_at = now()
       where id = v_prom.id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (p_tenant, null, 'platform_promise', v_prom.id, 'platform_promise_broken',
              jsonb_build_object('amount_cents', v_prom.amount_cents, 'paid_cents', v_paid, 'promised_date', v_prom.promised_date));
      if v_excl is null then
        insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack, action_label, action_url)
        values (p_tenant, 'owner', 'billing', 'warning', 'No registramos el pago prometido',
                'Prometiste pagar ' || platform_format_ars(v_prom.amount_cents) || ' el ' || to_char(v_prom.promised_date, 'DD/MM/YYYY')
                  || ' y no lo vimos acreditado. Si ya pagaste, avisanos.',
                false, 'Ver mi cuenta', '/dashboard-team#mora');
      end if;
      v_prom.id := null;
    end if;
  end if;

  -- 2) Los pasos de una deuda saldada se cierran: si un contracargo la
  --    reabre, la escalera corre otra vez desde el vencimiento original.
  update platform_dunning_events e
     set closed_at = now(), close_reason = case when v_excl is not null then 'excluded' else 'paid' end
   where e.tenant_id = p_tenant
     and e.closed_at is null
     and (v_excl is not null or platform_movement_open_cents(e.debt_movement_id) <= 0);

  -- 3) Sin deuda vencida (o excluido): se levanta lo que puso la escalera.
  if v_excl is not null or v_over < v_min then
    if v_soft or v_by is not null or v_unc is not null then
      if v_by is not null and v_sub.status in ('past_due', 'suspended') then
        update subscriptions set status = 'active' where id = v_sub.id;
        update tenants set status = 'active', updated_at = now() where id = p_tenant and status in ('past_due', 'suspended');
        if v_excl is null then
          insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
          values (p_tenant, 'owner', 'billing', 'success', 'Tu cuenta está al día',
                  'Registramos tu pago y levantamos las restricciones. Gracias.', false);
        end if;
      end if;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (p_tenant, p_actor, 'platform_dunning', null, 'platform_dunning_lifted',
              jsonb_build_object('soft_restricted', v_soft, 'status_by_ladder', v_by, 'uncollectible', v_unc is not null,
                                 'cause', coalesce(v_excl, 'paid'), 'status', v_sub.status));
      v_lifted := true;
    end if;
    v_soft := false;
    v_since := null;
    v_by := null;
    v_unc := null;
  end if;

  -- 4) Pasos de la escalera (sólo cron y día hábil; nunca a excluidos).
  if p_run_steps and v_excl is null and coalesce(v_set.dunning_enabled, true) and v_ladder is not null
     and v_debt_mv is not null and platform_is_business_day(p_today) then
    for s in
      select * from platform_dunning_steps
       where ladder_id = v_ladder and is_active and deleted_at is null
       order by offset_days, position
    loop
      continue when exists (select 1 from platform_dunning_events e
                             where e.tenant_id = p_tenant and e.step_id = s.id
                               and e.debt_movement_id = v_debt_mv and e.closed_at is null);
      continue when s.offset_days > v_days;
      continue when v_due < greatest(s.min_debt_cents, v_min);
      if s.requires_no_promise and v_prom.id is not null then
        v_held := v_held + 1;
        continue;
      end if;
      v_steps := v_steps || s;
    end loop;

    v_n := coalesce(array_length(v_steps, 1), 0);
    for v_i in 1 .. v_n loop
      s := v_steps[v_i];
      if s.action = 'past_due' and v_sub.status = 'active' then
        update subscriptions set status = 'past_due' where id = v_sub.id;
        v_sub.status := 'past_due';
        update tenants set status = 'past_due', updated_at = now() where id = p_tenant and status = 'active';
        v_by := coalesce(v_by, 'past_due');
      elsif s.action = 'soft_restrict' then
        v_soft := true;
        v_since := coalesce(v_since, now());
      elsif s.action = 'suspend' and v_sub.status in ('active', 'past_due') then
        update subscriptions set status = 'suspended' where id = v_sub.id;
        v_sub.status := 'suspended';
        update tenants set status = 'suspended', updated_at = now() where id = p_tenant and status in ('active', 'past_due');
        v_by := 'suspended';
      elsif s.action = 'mark_uncollectible' then
        v_unc := coalesce(v_unc, now());
      end if;
      insert into platform_dunning_events (tenant_id, ladder_id, step_id, debt_movement_id, action, offset_days,
                                           days_overdue, due_cents, notified, promise_id)
      values (p_tenant, v_ladder, s.id, v_debt_mv, s.action, s.offset_days, v_days, v_due,
              v_i = v_n and s.action <> 'mark_uncollectible' and cardinality(s.channels) > 0, null)
      returning id into v_ev;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (p_tenant, null, 'platform_dunning', v_ev, 'platform_dunning_step',
              jsonb_build_object('step', s.title, 'step_action', s.action, 'offset_days', s.offset_days,
                                 'days_overdue', v_days, 'amount_cents', v_due, 'notified', v_i = v_n,
                                 'status', v_sub.status));
      v_last := s.id;
      v_last_at := now();
    end loop;

    -- Aviso al cliente: sólo el último paso del lote.
    if v_n > 0 then
      s := v_steps[v_n];
      if s.action <> 'mark_uncollectible' and cardinality(s.channels) > 0 then
        v_title := platform_dunning_render(s.title, v_due, v_days, v_eff, v_t.name);
        v_body := platform_dunning_render(s.body, v_due, v_days, v_eff, v_t.name);
        v_sev := case s.action when 'suspend' then 'blocking' when 'notify' then 'warning' else 'critical' end;
        if 'in_app' = any (s.channels) then
          insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack, action_label, action_url)
          values (p_tenant, 'owner', 'billing', v_sev, v_title, v_body, s.action = 'suspend', 'Ver mi cuenta', '/dashboard-team#mora');
        end if;
        if 'email' = any (s.channels) then
          foreach v_r in array platform_notice_recipients(p_tenant) loop
            perform enqueue_system_email(
              p_tenant, v_r, 'platform_dunning_step',
              jsonb_build_object('negocio', platform_html_escape(v_t.name), 'titulo', platform_html_escape(v_title),
                                 'texto', platform_html_escape(v_body), 'monto', platform_format_ars(v_due),
                                 'dias', v_days, 'vence', to_char(v_eff, 'DD/MM/YYYY'),
                                 'link', 'https://pos.soft.ninja/dashboard-team#mora'),
              v_title, _dunning_email_html(v_t.name, v_title, v_body));
          end loop;
        end if;
      end if;
    end if;
  end if;

  v_state := case
               when v_excl is not null or v_over < v_min then 'al_dia'
               when v_unc is not null then 'incobrable'
               when v_prom.id is not null then 'en_promesa'
               else 'vencida'
             end;
  if v_state <> 'al_dia' or v_due >= v_min then
    v_next := platform_mora_next_step(v_ladder, p_tenant, v_debt_mv, v_eff, p_today, v_prom.id is not null, null);
    if coalesce(v_sub.status, '') <> 'suspended' then
      v_susp := platform_mora_next_step(v_ladder, p_tenant, v_debt_mv, v_eff, p_today, v_prom.id is not null, array['suspend']);
    end if;
  end if;

  insert into platform_collection_status as cs (
    tenant_id, state, days_overdue, due_cents, overdue_cents, debt_movement_id, oldest_due, effective_due, ladder_id,
    last_step_id, last_step_at, next_step_id, next_step_date, suspend_on, soft_restricted, restricted_since,
    status_by_ladder, uncollectible_at, evaluated_at)
  values (
    p_tenant, v_state, case when v_debt_mv is null then 0 else v_days end, v_due, v_over, v_debt_mv,
    (v_debt ->> 'oldest_due')::date, v_eff, v_ladder, v_last, v_last_at,
    (v_next ->> 'step_id')::uuid, (v_next ->> 'date')::date, (v_susp ->> 'date')::date,
    v_soft, v_since, v_by, v_unc, now())
  on conflict (tenant_id) do update set
    state = excluded.state, days_overdue = excluded.days_overdue, due_cents = excluded.due_cents,
    overdue_cents = excluded.overdue_cents, debt_movement_id = excluded.debt_movement_id,
    oldest_due = excluded.oldest_due, effective_due = excluded.effective_due, ladder_id = excluded.ladder_id,
    last_step_id = excluded.last_step_id, last_step_at = excluded.last_step_at, next_step_id = excluded.next_step_id,
    next_step_date = excluded.next_step_date, suspend_on = excluded.suspend_on,
    soft_restricted = excluded.soft_restricted, restricted_since = excluded.restricted_since,
    status_by_ladder = excluded.status_by_ladder, uncollectible_at = excluded.uncollectible_at,
    evaluated_at = excluded.evaluated_at;

  return jsonb_build_object('tenant_id', p_tenant, 'state', v_state, 'executed', coalesce(array_length(v_steps, 1), 0),
                            'held', v_held, 'lifted', v_lifted, 'days_overdue', v_days, 'due_cents', v_due,
                            'next_step', v_next);
end;
$$;

-- Lo que queda de run_saas_dunning: avisos de prueba por terminar o vencida
-- y el recordatorio de renovación de Mercado Pago (sólo débito automático y no
-- excluidos). Pago pendiente y suspensión pasan a la escalera configurable
-- (platform_mora_evaluate). Mismo cuerpo que en producción para los avisos.
create or replace function run_saas_dunning()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reminder   int;
  v_reminder_c int := 0;
  v_trial_end  int := 0;
  v_trial_exp  int := 0;
  r            record;
  v_owner_email text;
  v_owner_id    uuid;
  v_period   text;
  v_vence    text;
  v_dias     text;
begin
  select reminder_days into v_reminder from platform_settings where id = true;
  v_reminder := coalesce(v_reminder, 3);

  for r in
    select s.id as sub_id, s.tenant_id, s.current_period_end, t.name as tenant_name
      from subscriptions s
      join tenants t on t.id = s.tenant_id
     where s.status = 'active'
       and coalesce(s.is_lifetime, false) = false
       and s.current_period_end is not null
       and s.current_period_end >= now()
       and s.current_period_end <= now() + make_interval(days => v_reminder)
       and t.deleted_at is null
       and platform_billing_exclusion(s.tenant_id) is null
       and platform_effective_billing_mode(s.tenant_id) = 'mp_subscription'
  loop
    v_period := to_char(r.current_period_end, 'YYYY-MM');
    if exists (select 1 from dunning_events
                where tenant_id = r.tenant_id and kind = 'payment_reminder'
                  and period_key = v_period) then
      continue;
    end if;

    select u.id, u.email into v_owner_id, v_owner_email
      from tenant_users tu join users u on u.id = tu.user_id
     where tu.tenant_id = r.tenant_id and tu.role = 'owner' and tu.status = 'active'
     order by tu.created_at limit 1;

    v_vence := to_char(r.current_period_end, 'DD/MM/YYYY');

    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (r.tenant_id, 'owner', 'billing', 'info',
            'Tu suscripción se renueva pronto',
            'Tu suscripción se renueva el ' || v_vence
              || '. Asegurate de tener un medio de pago activo en Mercado Pago.',
            false);

    perform enqueue_system_email(
      r.tenant_id, v_owner_email, 'payment_reminder',
      jsonb_build_object('negocio', coalesce(r.tenant_name, ''), 'vence', v_vence),
      'Tu suscripción de NinjaPos se renueva pronto',
      _dunning_email_html(r.tenant_name, 'Tu suscripción de NinjaPos se renueva pronto',
        'Tu suscripción se renueva el ' || v_vence
          || '. El cobro es automático por Mercado Pago; verificá que tu medio de pago esté activo.'));

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'payment_reminder', v_period);
    v_reminder_c := v_reminder_c + 1;
  end loop;

  for r in
    select t.id as tenant_id, t.name as tenant_name, t.trial_ends_at
      from tenants t
     where t.status = 'trial'
       and t.deleted_at is null
       and t.trial_ends_at is not null
       and t.trial_ends_at >= now()
       and t.trial_ends_at <= now() + interval '3 days'
       and not exists (
         select 1 from subscriptions s
          where s.tenant_id = t.id and coalesce(s.is_lifetime, false) = true
       )
  loop
    v_period := to_char(r.trial_ends_at, 'YYYY-MM-DD');
    if exists (select 1 from dunning_events
                where tenant_id = r.tenant_id and kind = 'trial_ending'
                  and period_key = v_period) then
      continue;
    end if;

    select u.id, u.email into v_owner_id, v_owner_email
      from tenant_users tu join users u on u.id = tu.user_id
     where tu.tenant_id = r.tenant_id and tu.role = 'owner' and tu.status = 'active'
     order by tu.created_at limit 1;

    v_vence := to_char(r.trial_ends_at, 'DD/MM/YYYY');
    v_dias  := greatest(0, ceil(extract(epoch from (r.trial_ends_at - now())) / 86400.0)::int)::text;

    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (r.tenant_id, 'owner', 'billing', 'warning',
            'Tu prueba gratis está por terminar',
            'Tu período de prueba termina el ' || v_vence
              || '. Activá un plan para no perder acceso.',
            false);

    perform enqueue_system_email(
      r.tenant_id, v_owner_email, 'trial_ending',
      jsonb_build_object('negocio', coalesce(r.tenant_name, ''), 'vence', v_vence, 'dias', v_dias),
      'Tu prueba de NinjaPos está por terminar',
      _dunning_email_html(r.tenant_name, 'Tu prueba de NinjaPos está por terminar',
        'Tu período de prueba termina el ' || v_vence
          || '. Activá un plan desde tu panel para seguir usando NinjaPos sin interrupciones.'));

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'trial_ending', v_period);
    v_trial_end := v_trial_end + 1;
  end loop;

  for r in
    select t.id as tenant_id, t.name as tenant_name, t.trial_ends_at
      from tenants t
     where t.status = 'trial'
       and t.deleted_at is null
       and t.trial_ends_at is not null
       and t.trial_ends_at < now()
       and not exists (
         select 1 from subscriptions s
          where s.tenant_id = t.id and coalesce(s.is_lifetime, false) = true
       )
  loop
    v_period := to_char(r.trial_ends_at, 'YYYY-MM');
    if exists (select 1 from dunning_events
                where tenant_id = r.tenant_id and kind = 'trial_expired'
                  and period_key = v_period) then
      continue;
    end if;

    update tenants set status = 'cancelled', updated_at = now() where id = r.tenant_id;
    update subscriptions set status = 'cancelled', updated_at = now()
     where tenant_id = r.tenant_id and status = 'trial' and coalesce(is_lifetime, false) = false;

    select u.id, u.email into v_owner_id, v_owner_email
      from tenant_users tu join users u on u.id = tu.user_id
     where tu.tenant_id = r.tenant_id and tu.role = 'owner' and tu.status = 'active'
     order by tu.created_at limit 1;

    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (r.tenant_id, 'owner', 'billing', 'critical',
            'Tu prueba gratis terminó',
            'Tu período de prueba terminó. Activá un plan para reactivar tu cuenta.',
            false);

    perform enqueue_system_email(
      r.tenant_id, v_owner_email, 'trial_expired',
      jsonb_build_object('negocio', coalesce(r.tenant_name, '')),
      'Tu prueba de NinjaPos terminó',
      _dunning_email_html(r.tenant_name, 'Tu prueba de NinjaPos terminó',
        'Tu período de prueba terminó y pausamos tu cuenta. Activá un plan cuando quieras para retomar donde lo dejaste.'));

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'trial_expired', v_period);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (r.tenant_id, null, 'tenants', r.tenant_id, 'dunning_trial_expired',
            jsonb_build_object('period', v_period));
    v_trial_exp := v_trial_exp + 1;
  end loop;

  return jsonb_build_object(
    'payment_reminder', v_reminder_c,
    'trial_ending', v_trial_end,
    'trial_expired', v_trial_exp
  );
end;
$$;

create or replace function platform_dunning_run(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today   date := platform_ar_date(p_now);
  v_trials  jsonb;
  v_res     jsonb;
  v_n       int := 0;
  v_steps   int := 0;
  v_lifted  int := 0;
  v_fail    int := 0;
  t         uuid;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('platform_dunning_run', 0)) then
    return jsonb_build_object('skipped', 'running');
  end if;
  begin
    v_trials := run_saas_dunning();
  exception when others then
    v_trials := jsonb_build_object('error', sqlerrm);
  end;
  for t in
    select l.tenant_id
      from platform_ledger l
     where l.amount_cents > 0
       and l.amount_cents > coalesce((select sum(a.amount_cents) from platform_allocations a
                                       where a.debit_movement_id = l.id and a.released_at is null), 0)
       and coalesce(l.due_date, l.effective_date) <= v_today
    union
    select cs.tenant_id from platform_collection_status cs
     where cs.state <> 'al_dia' or cs.soft_restricted or cs.status_by_ladder is not null or cs.uncollectible_at is not null
    union
    select p.tenant_id from platform_promises p where p.status = 'open'
  loop
    begin
      v_res := platform_mora_evaluate(t, v_today, true, null);
      v_n := v_n + 1;
      v_steps := v_steps + coalesce((v_res ->> 'executed')::int, 0);
      v_lifted := v_lifted + case when coalesce((v_res ->> 'lifted')::boolean, false) then 1 else 0 end;
    exception when others then
      v_fail := v_fail + 1;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (t, null, 'platform_dunning', null, 'platform_dunning_failed', jsonb_build_object('error', sqlerrm, 'as_of', v_today));
    end;
  end loop;
  return jsonb_build_object('as_of', v_today, 'business_day', platform_is_business_day(v_today), 'tenants', v_n,
                            'steps', v_steps, 'lifted', v_lifted, 'failed', v_fail, 'trials', v_trials);
end;
$$;

-- Al imputarse un pago (o una condonación) se re-evalúa el negocio al final
-- de la transacción: se cumple la promesa y se levantan la restricción y la
-- suspensión que puso la escalera (§11.2: "al pagar todo lo vencido"). Nunca
-- frena el pago: si falla, queda en la auditoría y lo hace el cron.
create or replace function trg_platform_allocations_mora()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from platform_collection_status cs
              where cs.tenant_id = new.tenant_id
                and (cs.state <> 'al_dia' or cs.soft_restricted or cs.status_by_ladder is not null or cs.uncollectible_at is not null))
     or exists (select 1 from platform_promises p where p.tenant_id = new.tenant_id and p.status = 'open') then
    begin
      perform platform_mora_evaluate(new.tenant_id, platform_ar_date(now()), false, null);
    exception when others then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (new.tenant_id, null, 'platform_dunning', null, 'platform_dunning_failed', jsonb_build_object('error', sqlerrm, 'on', 'allocation'));
    end;
  end if;
  return null;
end;
$$;
drop trigger if exists platform_allocations_mora on platform_allocations;
create constraint trigger platform_allocations_mora
  after insert on platform_allocations
  deferrable initially deferred
  for each row execute function trg_platform_allocations_mora();

-- -----------------------------------------------------------------------------
-- I) Condonar o saldar punitorios (§10.3, §18.1)
-- -----------------------------------------------------------------------------
-- Punitorios con saldo de un negocio (opcionalmente sólo los elegidos).
create or replace function platform_interest_open(p_tenant uuid, p_ids uuid[] default null)
returns table (id uuid, charge_id uuid, month text, effective_date date, description text, amount_cents bigint, open_cents bigint, created_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select l.id, l.charge_id, split_part(l.idempotency_key, ':', 3), l.effective_date, l.description, l.amount_cents,
         l.amount_cents - coalesce((select sum(a.amount_cents) from platform_allocations a
                                     where a.debit_movement_id = l.id and a.released_at is null), 0),
         l.created_at
    from platform_ledger l
   where l.tenant_id = p_tenant
     and l.kind = 'interest'
     and (p_ids is null or l.id = any (p_ids))
     and l.amount_cents > coalesce((select sum(a.amount_cents) from platform_allocations a
                                     where a.debit_movement_id = l.id and a.released_at is null), 0)
   order by l.effective_date, l.created_at, l.id
$$;

-- Aplica una condonación: movimiento interest_waiver (haber) imputado a los
-- punitorios en orden de antigüedad y, si alguno ya tenía ND (mensual), la NC
-- pendiente de H130 por lo condonado de ese mes.
create or replace function platform_interest_apply_waiver(p_waiver uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  w        platform_interest_waivers%rowtype;
  v_open   bigint;
  v_amount bigint;
  v_left   bigint;
  v_part   bigint;
  v_mv     uuid;
  v_first  uuid;
  v_nc     bigint := 0;
  v_nd     bigint;
  v_ncprev bigint;
  v_x      bigint;
  r        record;
  g        record;
begin
  select * into w from platform_interest_waivers where id = p_waiver for update;
  perform platform_lock_tenant(w.tenant_id);
  select coalesce(sum(o.open_cents), 0), (array_agg(o.id order by o.effective_date, o.created_at, o.id))[1]
    into v_open, v_first
    from platform_interest_open(w.tenant_id, w.movement_ids) o;
  v_amount := least(w.amount_cents, v_open);
  if v_amount <= 0 then
    raise exception 'nothing_to_waive' using errcode = '22023';
  end if;

  v_mv := platform_post_movement(w.tenant_id, 'interest_waiver', -v_amount, platform_ar_date(now()), null,
                                 'Condonación de punitorios', w.reason, null, null, v_first,
                                 'iw:' || w.id::text, p_actor);
  create temporary table if not exists _iw_parts (charge_id uuid, month text, cents bigint) on commit drop;
  truncate _iw_parts;
  v_left := v_amount;
  for r in select * from platform_interest_open(w.tenant_id, w.movement_ids) loop
    exit when v_left <= 0;
    v_part := least(v_left, r.open_cents);
    insert into platform_allocations (tenant_id, credit_movement_id, debit_movement_id, amount_cents, created_by)
    values (w.tenant_id, v_mv, r.id, v_part, p_actor);
    insert into _iw_parts values (r.charge_id, r.month, v_part);
    v_left := v_left - v_part;
  end loop;

  -- NC sólo por lo que ya tenía ND (bill_mode mensual). En 'on_collection' lo
  -- condonado nunca se facturó: no lleva NC.
  for g in select p.charge_id, p.month, sum(p.cents)::bigint as cents from _iw_parts p group by 1, 2 loop
    select coalesce(sum(f.amount_cents), 0) into v_nd from platform_fiscal_pending f
     where f.charge_id = g.charge_id and f.kind = 'debit_note' and f.status <> 'cancelled'
       and f.period_month = (g.month || '-01')::date;
    select coalesce(sum(f.amount_cents), 0) into v_ncprev from platform_fiscal_pending f
     where f.charge_id = g.charge_id and f.kind = 'credit_note' and f.status <> 'cancelled'
       and f.period_month = (g.month || '-01')::date;
    v_x := least(g.cents, v_nd - v_ncprev);
    if v_x > 0 then
      insert into platform_fiscal_pending (tenant_id, kind, concept, amount_cents, ledger_movement_id, waiver_id, charge_id,
                                           period_month, assoc_id, idempotency_key, note)
      values (w.tenant_id, 'credit_note', 'interest_waiver', v_x, v_mv, w.id, g.charge_id, (g.month || '-01')::date,
              (select f.id from platform_fiscal_pending f where f.charge_id = g.charge_id and f.kind = 'debit_note'
                  and f.status <> 'cancelled' and f.period_month = (g.month || '-01')::date order by f.created_at limit 1),
              'nc:w:' || w.id::text || ':' || g.charge_id::text || ':' || g.month,
              'Nota de crédito por condonación de punitorios (pendiente de H130)')
      on conflict (idempotency_key) do nothing;
      v_nc := v_nc + v_x;
    end if;
  end loop;

  perform platform_auto_allocate(w.tenant_id, p_actor);
  update platform_interest_waivers
     set status = 'applied', applied_cents = v_amount, ledger_movement_id = v_mv, credit_note_cents = v_nc, updated_at = now()
   where id = w.id;
  return jsonb_build_object('waiver_id', w.id, 'applied_cents', v_amount, 'credit_note_cents', v_nc, 'movement_id', v_mv);
end;
$$;

create or replace function platform_waiver_json(w platform_interest_waivers)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', w.id, 'status', w.status, 'amount_cents', w.amount_cents, 'applied_cents', w.applied_cents,
    'credit_note_cents', w.credit_note_cents, 'reason', w.reason, 'movement_ids', w.movement_ids,
    'requested_role', w.requested_role, 'created_at', w.created_at, 'decided_at', w.decided_at,
    'decision_reason', w.decision_reason, 'tenant_id', w.tenant_id,
    'requested_by_name', (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = w.requested_by),
    'decided_by_name', (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = w.decided_by))
$$;

-- Condonar (total o parcial) o "Saldar punitorios" (p_movement_ids y
-- p_amount_cents null = todo lo pendiente). Cobranzas, admin o super_admin,
-- con motivo. Dentro del tope del nivel se aplica; arriba queda
-- pending_approval para un super_admin.
create or replace function internal_interest_waive(
  p_tenant       uuid,
  p_movement_ids uuid[],
  p_amount_cents bigint,
  p_reason       text,
  p_request_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role    text := platform_assert_billing_operator();
  v_reason  text := platform_assert_reason(p_reason);
  v_today   date := platform_ar_date(now());
  w         platform_interest_waivers%rowtype;
  v_open    bigint;
  v_amount  bigint;
  v_cap     text;
  v_before  bigint;
  v_res     jsonb;
begin
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  if p_request_id is not null then
    select * into w from platform_interest_waivers where request_id = p_request_id;
    if found then
      return platform_waiver_json(w);
    end if;
  end if;
  perform platform_lock_tenant(p_tenant);
  -- Primero se pone al día lo devengado hasta hoy.
  perform platform_interest_accrue_tenant(p_tenant, v_today, auth.uid());
  select coalesce(sum(o.open_cents), 0) into v_open from platform_interest_open(p_tenant, p_movement_ids) o;
  if v_open <= 0 then
    raise exception 'nothing_to_waive' using errcode = '22023';
  end if;
  v_amount := coalesce(p_amount_cents, v_open);
  if v_amount <= 0 or v_amount > v_open then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  begin
    perform platform_assert_forgiveness_cap(p_tenant, v_amount);
  exception when insufficient_privilege then
    if sqlerrm like 'cap_%' then
      v_cap := sqlerrm;
    else
      raise;
    end if;
  end;
  v_before := platform_tenant_balance(p_tenant);
  insert into platform_interest_waivers (tenant_id, request_id, movement_ids, amount_cents, status, reason,
                                         requested_by, requested_role)
  values (p_tenant, p_request_id, p_movement_ids, v_amount,
          case when v_cap is null then 'applied' else 'pending_approval' end, v_reason, auth.uid(), v_role)
  returning * into w;

  if v_cap is null then
    v_res := platform_interest_apply_waiver(w.id, auth.uid());
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
    values (p_tenant, auth.uid(), 'platform_ledger', (v_res ->> 'movement_id')::uuid, 'platform_interest_waived',
            jsonb_build_object('balance_cents', v_before),
            jsonb_build_object('balance_cents', platform_tenant_balance(p_tenant), 'amount_cents', v_amount,
                               'credit_note_cents', (v_res ->> 'credit_note_cents')::bigint, 'all', p_movement_ids is null,
                               'waiver_id', w.id, 'role', v_role),
            v_reason);
  else
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
    values (p_tenant, auth.uid(), 'platform_ledger', null, 'platform_interest_waiver_requested',
            jsonb_build_object('amount_cents', v_amount, 'cap', v_cap, 'waiver_id', w.id, 'role', v_role), v_reason);
  end if;
  perform platform_mora_evaluate(p_tenant, v_today, false, auth.uid());
  select * into w from platform_interest_waivers where id = w.id;
  return platform_waiver_json(w);
end;
$$;

-- Aprobar o rechazar una condonación que superó el tope (super_admin).
create or replace function internal_interest_waiver_decide(p_waiver uuid, p_approve boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  w        platform_interest_waivers%rowtype;
  v_res    jsonb;
  v_before bigint;
begin
  perform platform_assert_super_admin();
  select * into w from platform_interest_waivers where id = p_waiver for update;
  if not found or w.status <> 'pending_approval' then
    raise exception 'waiver_not_pending' using errcode = '22023';
  end if;
  if p_approve then
    perform platform_lock_tenant(w.tenant_id);
    perform platform_interest_accrue_tenant(w.tenant_id, platform_ar_date(now()), auth.uid());
    perform platform_assert_forgiveness_cap(w.tenant_id, w.amount_cents);
    v_before := platform_tenant_balance(w.tenant_id);
    v_res := platform_interest_apply_waiver(w.id, auth.uid());
    update platform_interest_waivers set decided_by = auth.uid(), decided_at = now(), decision_reason = v_reason, updated_at = now()
     where id = w.id;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
    values (w.tenant_id, auth.uid(), 'platform_ledger', (v_res ->> 'movement_id')::uuid, 'platform_interest_waived',
            jsonb_build_object('balance_cents', v_before),
            jsonb_build_object('balance_cents', platform_tenant_balance(w.tenant_id), 'amount_cents', (v_res ->> 'applied_cents')::bigint,
                               'credit_note_cents', (v_res ->> 'credit_note_cents')::bigint, 'waiver_id', w.id,
                               'approved', true, 'requested_reason', w.reason),
            v_reason);
    perform platform_mora_evaluate(w.tenant_id, platform_ar_date(now()), false, auth.uid());
  else
    update platform_interest_waivers
       set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_reason = v_reason, updated_at = now()
     where id = w.id;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
    values (w.tenant_id, auth.uid(), 'platform_ledger', null, 'platform_interest_waiver_rejected',
            jsonb_build_object('amount_cents', w.amount_cents, 'waiver_id', w.id), v_reason);
  end if;
  select * into w from platform_interest_waivers where id = p_waiver;
  return platform_waiver_json(w);
end;
$$;

-- -----------------------------------------------------------------------------
-- J) Promesas de pago (§10.5, §22 #10)
-- -----------------------------------------------------------------------------
create or replace function platform_promise_json(p platform_promises)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p.id, 'amount_cents', p.amount_cents, 'promised_date', p.promised_date, 'original_date', p.original_date,
    'status', p.status, 'channel', p.channel, 'note', p.note, 'paid_cents', p.paid_cents,
    'extended_count', p.extended_count, 'created_at', p.created_at, 'resolved_at', p.resolved_at)
$$;

-- El dueño carga su promesa ("Voy a pagar el día…"): sólo con deuda vencida,
-- una por deuda, hasta promise_max_days, y no si rompió promise_max_broken en
-- 90 días.
create or replace function owner_promise_create(p_amount_cents bigint, p_date date, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tid    uuid := current_tenant_id();
  v_today  date := platform_ar_date(now());
  v_set    platform_billing_settings%rowtype;
  v_bt     tenant_billing_terms%rowtype;
  v_debt   jsonb;
  v_bal    bigint;
  p        platform_promises%rowtype;
begin
  if v_tid is null or not is_tenant_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_set from platform_billing_settings where id;
  select * into v_bt from tenant_billing_terms where tenant_id = v_tid;
  if not v_set.promise_self_enabled or coalesce(v_bt.self_promise_enabled, true) = false
     or platform_billing_exclusion(v_tid) is not null then
    raise exception 'promise_disabled' using errcode = '42501';
  end if;
  perform platform_lock_tenant(v_tid);
  if exists (select 1 from platform_promises where tenant_id = v_tid and status = 'open') then
    raise exception 'promise_open_exists' using errcode = '22023';
  end if;
  v_debt := platform_mora_debt(v_tid, v_today);
  if (v_debt ->> 'debt_movement_id') is null or (v_debt ->> 'overdue_cents')::bigint <= 0 then
    raise exception 'nothing_due' using errcode = '22023';
  end if;
  if exists (select 1 from platform_promises where tenant_id = v_tid and channel = 'owner'
              and debt_movement_id = (v_debt ->> 'debt_movement_id')::uuid) then
    raise exception 'promise_already_used' using errcode = '22023';
  end if;
  if (select count(*) from platform_promises where tenant_id = v_tid and status = 'broken'
        and resolved_at >= now() - interval '90 days') >= v_set.promise_max_broken then
    raise exception 'promise_blocked' using errcode = '42501';
  end if;
  if p_date is null or p_date <= v_today or p_date > v_today + v_set.promise_max_days then
    raise exception 'invalid_promise_date' using errcode = '22023';
  end if;
  v_bal := platform_tenant_balance(v_tid);
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > v_bal then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  insert into platform_promises (tenant_id, amount_cents, promised_date, original_date, channel, note, debt_movement_id, created_by)
  values (v_tid, p_amount_cents, p_date, p_date, 'owner', nullif(left(btrim(coalesce(p_note, '')), 500), ''),
          (v_debt ->> 'debt_movement_id')::uuid, auth.uid())
  returning * into p;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tid, auth.uid(), 'platform_promise', p.id, 'platform_promise_created',
          jsonb_build_object('amount_cents', p.amount_cents, 'promised_date', p.promised_date, 'channel', 'owner'));
  perform platform_mora_evaluate(v_tid, v_today, false, auth.uid());
  return platform_promise_json(p);
end;
$$;

create or replace function internal_promise_create(p_tenant uuid, p_amount_cents bigint, p_date date, p_note text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := platform_assert_billing_operator();
  v_reason text := platform_assert_reason(p_reason);
  v_today  date := platform_ar_date(now());
  v_set    platform_billing_settings%rowtype;
  v_debt   jsonb;
  v_bal    bigint;
  p        platform_promises%rowtype;
begin
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  select * into v_set from platform_billing_settings where id;
  perform platform_lock_tenant(p_tenant);
  if exists (select 1 from platform_promises where tenant_id = p_tenant and status = 'open') then
    raise exception 'promise_open_exists' using errcode = '22023';
  end if;
  v_bal := platform_tenant_balance(p_tenant);
  if v_bal <= 0 then
    raise exception 'nothing_due' using errcode = '22023';
  end if;
  if p_date is null or p_date <= v_today or p_date > v_today + v_set.promise_staff_max_days then
    raise exception 'invalid_promise_date' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > v_bal then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  v_debt := platform_mora_debt(p_tenant, v_today);
  insert into platform_promises (tenant_id, amount_cents, promised_date, original_date, channel, note, debt_movement_id, created_by)
  values (p_tenant, p_amount_cents, p_date, p_date, 'staff', nullif(left(btrim(coalesce(p_note, '')), 500), ''),
          (v_debt ->> 'debt_movement_id')::uuid, auth.uid())
  returning * into p;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (p_tenant, auth.uid(), 'platform_promise', p.id, 'platform_promise_created',
          jsonb_build_object('amount_cents', p.amount_cents, 'promised_date', p.promised_date, 'channel', 'staff', 'role', v_role),
          v_reason);
  perform platform_mora_evaluate(p_tenant, v_today, false, auth.uid());
  return platform_promise_json(p);
end;
$$;

-- Ampliar (nueva fecha, hasta promise_staff_max_days desde hoy) o cancelar.
create or replace function internal_promise_update(p_promise uuid, p_action text, p_date date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := platform_assert_billing_operator();
  v_reason text := platform_assert_reason(p_reason);
  v_today  date := platform_ar_date(now());
  v_set    platform_billing_settings%rowtype;
  p        platform_promises%rowtype;
  v_before jsonb;
begin
  select * into v_set from platform_billing_settings where id;
  select * into p from platform_promises where id = p_promise for update;
  if not found or p.status <> 'open' then
    raise exception 'promise_not_open' using errcode = '22023';
  end if;
  v_before := platform_promise_json(p);
  if p_action = 'extend' then
    if p_date is null or p_date <= v_today or p_date > v_today + v_set.promise_staff_max_days then
      raise exception 'invalid_promise_date' using errcode = '22023';
    end if;
    update platform_promises set promised_date = p_date, extended_count = extended_count + 1, updated_at = now()
     where id = p.id returning * into p;
  elsif p_action = 'cancel' then
    update platform_promises
       set status = 'cancelled', resolved_at = now(), resolved_by = auth.uid(), resolve_reason = v_reason, updated_at = now()
     where id = p.id returning * into p;
  else
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p.tenant_id, auth.uid(), 'platform_promise', p.id,
          case when p_action = 'extend' then 'platform_promise_extended' else 'platform_promise_cancelled' end,
          v_before, platform_promise_json(p) || jsonb_build_object('role', v_role), v_reason);
  perform platform_mora_evaluate(p.tenant_id, v_today, false, auth.uid());
  return platform_promise_json(p);
end;
$$;

-- -----------------------------------------------------------------------------
-- K) Lo que ve el negocio
-- -----------------------------------------------------------------------------
-- Estado de mora de su cuenta (dueño o encargado): deuda, días, punitorios,
-- próximo paso que lo afecta, restricción y promesas.
create or replace function my_billing_mora()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tid    uuid := current_tenant_id();
  v_today  date := platform_ar_date(now());
  v_set    platform_billing_settings%rowtype;
  v_bt     tenant_billing_terms%rowtype;
  v_cs     platform_collection_status%rowtype;
  v_debt   jsonb;
  v_prom   platform_promises%rowtype;
  v_ladder uuid;
  v_next   jsonb;
  v_owner  boolean;
  v_reason text;
  v_excl   text;
begin
  if v_tid is null or not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_owner := is_tenant_owner();
  v_excl := platform_billing_exclusion(v_tid);
  select * into v_set from platform_billing_settings where id;
  select * into v_bt from tenant_billing_terms where tenant_id = v_tid;
  select * into v_cs from platform_collection_status where tenant_id = v_tid;
  select * into v_prom from platform_promises where tenant_id = v_tid and status = 'open';
  v_debt := platform_mora_debt(v_tid, v_today);
  v_ladder := platform_dunning_ladder_for(v_tid);
  if v_excl is null and (v_debt ->> 'debt_movement_id') is not null then
    v_next := platform_mora_next_step(v_ladder, v_tid, (v_debt ->> 'debt_movement_id')::uuid, (v_debt ->> 'effective_due')::date,
                                      v_today, v_prom.id is not null, array['past_due', 'soft_restrict', 'suspend']);
  end if;

  v_reason := case
    when not v_owner then 'not_owner'
    when v_excl is not null or not v_set.promise_self_enabled or coalesce(v_bt.self_promise_enabled, true) = false then 'promise_disabled'
    when v_prom.id is not null then 'promise_open_exists'
    when (v_debt ->> 'overdue_cents')::bigint <= 0 then 'nothing_due'
    when exists (select 1 from platform_promises where tenant_id = v_tid and channel = 'owner'
                  and debt_movement_id = (v_debt ->> 'debt_movement_id')::uuid) then 'promise_already_used'
    when (select count(*) from platform_promises where tenant_id = v_tid and status = 'broken'
            and resolved_at >= now() - interval '90 days') >= v_set.promise_max_broken then 'promise_blocked'
  end;

  return jsonb_build_object(
    'as_of', v_today,
    'is_owner', v_owner,
    'state', case when v_excl is not null then 'al_dia'
                  when v_cs.state = 'incobrable' then 'vencida'
                  when v_prom.id is not null then 'en_promesa'
                  when (v_debt ->> 'overdue_cents')::bigint > 0 then 'vencida'
                  else 'al_dia' end,
    'days_overdue', case when (v_debt ->> 'overdue_cents')::bigint > 0 then (v_debt ->> 'days_overdue')::int else 0 end,
    'oldest_due', v_debt ->> 'oldest_due',
    'effective_due', v_debt ->> 'effective_due',
    'overdue_cents', (v_debt ->> 'overdue_cents')::bigint,
    'balance_cents', platform_tenant_balance(v_tid),
    'interest_open_cents', coalesce((select sum(o.open_cents) from platform_interest_open(v_tid, null) o), 0),
    'interest_pending_cents', coalesce((select sum(a.pending_cents) from platform_interest_accruals a
                                          join platform_charges c on c.id = a.charge_id
                                         where a.tenant_id = v_tid and c.status in ('open', 'partially_paid')), 0),
    'interest_enabled', v_excl is null and v_set.interest_enabled and platform_interest_policy_for(v_tid) is not null
                        and coalesce(v_bt.interest_enabled, true)
                        and (platform_effective_billing_mode(v_tid) <> 'mp_subscription' or v_set.interest_on_mp),
    'soft_restricted', coalesce(v_cs.soft_restricted, false),
    'restrict_areas', to_jsonb(v_set.soft_restrict_areas),
    'subscription_status', (select s.status from subscriptions s where s.tenant_id = v_tid),
    'next_step', v_next,
    'promise', case when v_prom.id is null then null else platform_promise_json(v_prom) end,
    'promise_rules', jsonb_build_object(
      'can_create', v_reason is null,
      'reason', v_reason,
      'max_days', v_set.promise_max_days,
      'min_date', v_today + 1,
      'max_date', v_today + v_set.promise_max_days),
    'promises', coalesce((select jsonb_agg(platform_promise_json(p) order by p.created_at desc)
                            from (select * from platform_promises where tenant_id = v_tid order by created_at desc limit 5) p), '[]'::jsonb));
end;
$$;

-- Restricción blanda para cualquier miembro del negocio (sin importes): la
-- usa el overlay de reportes y configuración. El POS nunca se restringe.
create or replace function my_billing_restriction()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tid uuid := current_tenant_id();
  v_cs  platform_collection_status%rowtype;
  v_set platform_billing_settings%rowtype;
begin
  if v_tid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_cs from platform_collection_status where tenant_id = v_tid;
  select * into v_set from platform_billing_settings where id;
  return jsonb_build_object(
    'soft_restricted', coalesce(v_cs.soft_restricted, false) and platform_billing_exclusion(v_tid) is null,
    'areas', to_jsonb(coalesce(v_set.soft_restrict_areas, '{}'::text[])),
    'suspend_on', v_cs.suspend_on,
    'state', coalesce(v_cs.state, 'al_dia'),
    'is_manager', is_tenant_manager());
end;
$$;

-- -----------------------------------------------------------------------------
-- L) Lo que ve el staff
-- -----------------------------------------------------------------------------
create or replace function internal_billing_mora(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := platform_staff_billing_role();
  v_today  date := platform_ar_date(now());
  v_set    platform_billing_settings%rowtype;
  v_bt     tenant_billing_terms%rowtype;
  v_cs     platform_collection_status%rowtype;
  v_debt   jsonb;
  v_prom   platform_promises%rowtype;
  v_ladder uuid;
  v_pol    uuid;
begin
  if v_role is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  select * into v_set from platform_billing_settings where id;
  select * into v_bt from tenant_billing_terms where tenant_id = p_tenant;
  select * into v_cs from platform_collection_status where tenant_id = p_tenant;
  select * into v_prom from platform_promises where tenant_id = p_tenant and status = 'open';
  v_debt := platform_mora_debt(p_tenant, v_today);
  v_ladder := platform_dunning_ladder_for(p_tenant);
  v_pol := platform_interest_policy_for(p_tenant);
  return jsonb_build_object(
    'as_of', v_today,
    'exclusion', platform_billing_exclusion(p_tenant),
    'billing_mode', platform_effective_billing_mode(p_tenant),
    'debt', v_debt,
    'status', case when v_cs.tenant_id is null then null else to_jsonb(v_cs) end,
    'subscription_status', (select s.status from subscriptions s where s.tenant_id = p_tenant),
    'terms', jsonb_build_object(
      'interest_policy_id', v_bt.interest_policy_id, 'interest_enabled', coalesce(v_bt.interest_enabled, true),
      'dunning_ladder_id', v_bt.dunning_ladder_id, 'self_promise_enabled', v_bt.self_promise_enabled),
    'settings', jsonb_build_object(
      'interest_enabled', v_set.interest_enabled, 'interest_on_mp', v_set.interest_on_mp,
      'dunning_enabled', v_set.dunning_enabled, 'promise_staff_max_days', v_set.promise_staff_max_days,
      'promise_max_days', v_set.promise_max_days),
    'policy', (select platform_interest_policy_json(p) from platform_interest_policies p where p.id = v_pol),
    'policy_source', platform_interest_policy_source(p_tenant),
    'ladder', (select jsonb_build_object('id', l.id, 'name', l.name, 'steps', coalesce((
                 select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'offset_days', s.offset_days,
                          'action', s.action, 'channels', s.channels, 'requires_no_promise', s.requires_no_promise,
                          'min_debt_cents', s.min_debt_cents, 'title', s.title, 'body', s.body, 'is_active', s.is_active)
                          order by s.offset_days, s.position)
                   from platform_dunning_steps s where s.ladder_id = l.id and s.deleted_at is null), '[]'::jsonb))
                 from platform_dunning_ladders l where l.id = v_ladder),
    'next_step', case when (v_debt ->> 'debt_movement_id') is null then null
                      else platform_mora_next_step(v_ladder, p_tenant, (v_debt ->> 'debt_movement_id')::uuid,
                                                   (v_debt ->> 'effective_due')::date, v_today, v_prom.id is not null, null) end,
    'executed_step_ids', coalesce((select jsonb_agg(e.step_id) from platform_dunning_events e
                                    where e.tenant_id = p_tenant and e.closed_at is null
                                      and e.debt_movement_id = (v_debt ->> 'debt_movement_id')::uuid), '[]'::jsonb),
    'accruals', coalesce((select jsonb_agg(jsonb_build_object(
                    'charge_id', a.charge_id, 'description', c.description, 'charge_status', c.status,
                    'effective_due', a.effective_due, 'accrue_from', a.accrue_from, 'original_cents', a.original_cents,
                    'accrued_cents', a.accrued_cents, 'liquidated_cents', a.liquidated_cents, 'pending_cents', a.pending_cents,
                    'posted_cents', a.posted_cents, 'cap_reached', a.cap_reached, 'months', a.months,
                    'accrued_through', a.accrued_through, 'policy', a.policy) order by a.effective_due desc)
                  from platform_interest_accruals a join platform_charges c on c.id = a.charge_id
                 where a.tenant_id = p_tenant), '[]'::jsonb),
    'interest_open', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', o.id, 'charge_id', o.charge_id, 'month', o.month, 'effective_date', o.effective_date,
                    'description', o.description, 'amount_cents', o.amount_cents, 'open_cents', o.open_cents))
                  from platform_interest_open(p_tenant, null) o), '[]'::jsonb),
    'interest_open_cents', coalesce((select sum(o.open_cents) from platform_interest_open(p_tenant, null) o), 0),
    'promise', case when v_prom.id is null then null else platform_promise_json(v_prom) end,
    'promises', coalesce((select jsonb_agg(platform_promise_json(p) || jsonb_build_object(
                    'created_by_name', (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = p.created_by))
                    order by p.created_at desc)
                  from (select * from platform_promises where tenant_id = p_tenant order by created_at desc limit 20) p), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', e.id, 'step_id', e.step_id, 'title', s.title, 'action', e.action, 'offset_days', e.offset_days,
                    'days_overdue', e.days_overdue, 'due_cents', e.due_cents, 'notified', e.notified,
                    'executed_at', e.executed_at, 'closed_at', e.closed_at, 'close_reason', e.close_reason)
                    order by e.executed_at desc)
                  from (select * from platform_dunning_events where tenant_id = p_tenant order by executed_at desc limit 40) e
                  join platform_dunning_steps s on s.id = e.step_id), '[]'::jsonb),
    'waivers', coalesce((select jsonb_agg(platform_waiver_json(w) order by w.created_at desc)
                  from (select * from platform_interest_waivers where tenant_id = p_tenant order by created_at desc limit 20) w), '[]'::jsonb),
    'fiscal_pending', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', f.id, 'kind', f.kind, 'concept', f.concept, 'amount_cents', f.amount_cents,
                    'period_month', f.period_month, 'status', f.status, 'created_at', f.created_at, 'note', f.note)
                    order by f.created_at desc)
                  from (select * from platform_fiscal_pending where tenant_id = p_tenant order by created_at desc limit 40) f), '[]'::jsonb),
    'pauses', coalesce((select jsonb_agg(jsonb_build_object('id', z.id, 'from', z.from_date, 'to', z.to_date, 'reason', z.reason)
                    order by z.from_date desc)
                  from platform_interest_pauses z where z.tenant_id = p_tenant), '[]'::jsonb),
    'holidays', coalesce((select jsonb_agg(h.day order by h.day) from platform_holidays h
                           where h.deleted_at is null and h.day between v_today - 120 and v_today + 400), '[]'::jsonb));
end;
$$;

-- Negocios en mora, condonaciones a aprobar y documentos pendientes de H130.
create or replace function internal_billing_mora_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role  text := platform_staff_billing_role();
  v_today date := platform_ar_date(now());
  v_set   platform_billing_settings%rowtype;
begin
  if v_role is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_set from platform_billing_settings where id;
  return jsonb_build_object(
    'as_of', v_today,
    'business_day', platform_is_business_day(v_today),
    'interest_enabled', v_set.interest_enabled,
    'dunning_enabled', v_set.dunning_enabled,
    'tenants', coalesce((select jsonb_agg(jsonb_build_object(
                  'tenant_id', cs.tenant_id, 'name', t.name, 'slug', t.slug, 'state', cs.state,
                  'days_overdue', cs.days_overdue, 'overdue_cents', cs.overdue_cents, 'due_cents', cs.due_cents,
                  'soft_restricted', cs.soft_restricted, 'status_by_ladder', cs.status_by_ladder,
                  'subscription_status', s.status, 'next_step_date', cs.next_step_date,
                  'next_step_action', ns.action, 'next_step_title', ns.title, 'evaluated_at', cs.evaluated_at,
                  'interest_open_cents', coalesce((select sum(o.open_cents) from platform_interest_open(cs.tenant_id, null) o), 0),
                  'promise_date', (select p.promised_date from platform_promises p where p.tenant_id = cs.tenant_id and p.status = 'open'),
                  'promise_cents', (select p.amount_cents from platform_promises p where p.tenant_id = cs.tenant_id and p.status = 'open'))
                  order by cs.days_overdue desc, cs.overdue_cents desc)
                from platform_collection_status cs
                join tenants t on t.id = cs.tenant_id
                left join subscriptions s on s.tenant_id = cs.tenant_id
                left join platform_dunning_steps ns on ns.id = cs.next_step_id
               where cs.state <> 'al_dia' or cs.soft_restricted or cs.status_by_ladder is not null), '[]'::jsonb),
    'pending_waivers', coalesce((select jsonb_agg(platform_waiver_json(w) || jsonb_build_object(
                  'tenant_name', (select t.name from tenants t where t.id = w.tenant_id)) order by w.created_at)
                from platform_interest_waivers w where w.status = 'pending_approval'), '[]'::jsonb),
    'fiscal_pending', jsonb_build_object(
      'debit_notes', (select count(*) from platform_fiscal_pending where status = 'pending_h130' and kind = 'debit_note'),
      'debit_cents', coalesce((select sum(amount_cents) from platform_fiscal_pending where status = 'pending_h130' and kind = 'debit_note'), 0),
      'credit_notes', (select count(*) from platform_fiscal_pending where status = 'pending_h130' and kind = 'credit_note'),
      'credit_cents', coalesce((select sum(amount_cents) from platform_fiscal_pending where status = 'pending_h130' and kind = 'credit_note'), 0)));
end;
$$;

-- Configuración de mora: ajustes, políticas, planes, escaleras y feriados.
create or replace function internal_billing_mora_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role  text := platform_staff_billing_role();
  v_today date := platform_ar_date(now());
  v_set   platform_billing_settings%rowtype;
begin
  if v_role is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_set from platform_billing_settings where id;
  return jsonb_build_object(
    'as_of', v_today,
    'can_configure', v_role = 'super_admin',
    'settings', jsonb_build_object(
      'interest_enabled', v_set.interest_enabled, 'interest_since', v_set.interest_since,
      'interest_on_mp', v_set.interest_on_mp, 'default_interest_policy_id', v_set.default_interest_policy_id,
      'dunning_enabled', v_set.dunning_enabled, 'default_dunning_ladder_id', v_set.default_dunning_ladder_id,
      'dunning_min_debt_cents', v_set.dunning_min_debt_cents, 'promise_self_enabled', v_set.promise_self_enabled,
      'promise_max_days', v_set.promise_max_days, 'promise_staff_max_days', v_set.promise_staff_max_days,
      'promise_max_broken', v_set.promise_max_broken, 'soft_restrict_areas', to_jsonb(v_set.soft_restrict_areas)),
    'policies', coalesce((select jsonb_agg(platform_interest_policy_json(p) || jsonb_build_object(
                    'is_active', p.is_active, 'archived_at', p.archived_at, 'updated_at', p.updated_at,
                    'tenants', (select count(*) from tenant_billing_terms bt where bt.interest_policy_id = p.id))
                    order by p.archived_at nulls first, p.name)
                  from platform_interest_policies p), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(jsonb_build_object('plan_id', pl.id, 'key', pl.key, 'name', pl.name,
                    'policy_id', pp.policy_id) order by pl.monthly_price_ars, pl.name)
                  from plans pl left join platform_interest_policy_plans pp on pp.plan_id = pl.id
                 where pl.tenant_id is null and coalesce(pl.is_active, true)), '[]'::jsonb),
    'ladders', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', l.id, 'name', l.name, 'is_active', l.is_active, 'archived_at', l.archived_at, 'updated_at', l.updated_at,
                    'tenants', (select count(*) from tenant_billing_terms bt where bt.dunning_ladder_id = l.id),
                    'steps', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', s.id, 'position', s.position, 'offset_days', s.offset_days, 'action', s.action,
                        'channels', s.channels, 'requires_no_promise', s.requires_no_promise,
                        'min_debt_cents', s.min_debt_cents, 'title', s.title, 'body', s.body, 'is_active', s.is_active)
                        order by s.offset_days, s.position)
                      from platform_dunning_steps s where s.ladder_id = l.id and s.deleted_at is null), '[]'::jsonb))
                    order by l.archived_at nulls first, l.name)
                  from platform_dunning_ladders l), '[]'::jsonb),
    'holidays', coalesce((select jsonb_agg(jsonb_build_object('day', h.day, 'name', h.name, 'source', h.source) order by h.day)
                  from platform_holidays h where h.deleted_at is null and h.day >= v_today - 400), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- M) Configuración (super_admin) y condiciones por negocio (admin)
-- -----------------------------------------------------------------------------
create or replace function internal_billing_set_mora_settings(p_data jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_today  date := platform_ar_date(now());
  v_before platform_billing_settings%rowtype;
  v_on     boolean;
  v_areas  text[];
begin
  perform platform_assert_super_admin();
  select * into v_before from platform_billing_settings where id for update;
  v_on := coalesce((p_data ->> 'interest_enabled')::boolean, v_before.interest_enabled);
  if p_data ? 'soft_restrict_areas' then
    select coalesce(array_agg(distinct x), '{}') into v_areas from jsonb_array_elements_text(p_data -> 'soft_restrict_areas') x;
  end if;
  if (p_data ? 'default_interest_policy_id') and nullif(p_data ->> 'default_interest_policy_id', '') is not null
     and not exists (select 1 from platform_interest_policies where id = (p_data ->> 'default_interest_policy_id')::uuid
                      and is_active and archived_at is null) then
    raise exception 'policy_not_found' using errcode = 'P0002';
  end if;
  if (p_data ? 'default_dunning_ladder_id') and nullif(p_data ->> 'default_dunning_ladder_id', '') is not null
     and not exists (select 1 from platform_dunning_ladders where id = (p_data ->> 'default_dunning_ladder_id')::uuid
                      and is_active and archived_at is null) then
    raise exception 'ladder_not_found' using errcode = 'P0002';
  end if;

  begin
    update platform_billing_settings
       set interest_enabled = v_on,
           interest_since = case when v_on and interest_since is null then v_today else interest_since end,
           interest_on_mp = coalesce((p_data ->> 'interest_on_mp')::boolean, interest_on_mp),
           default_interest_policy_id = case when p_data ? 'default_interest_policy_id'
                                             then nullif(p_data ->> 'default_interest_policy_id', '')::uuid
                                             else default_interest_policy_id end,
           dunning_enabled = coalesce((p_data ->> 'dunning_enabled')::boolean, dunning_enabled),
           default_dunning_ladder_id = case when p_data ? 'default_dunning_ladder_id'
                                            then nullif(p_data ->> 'default_dunning_ladder_id', '')::uuid
                                            else default_dunning_ladder_id end,
           dunning_min_debt_cents = coalesce((p_data ->> 'dunning_min_debt_cents')::bigint, dunning_min_debt_cents),
           promise_self_enabled = coalesce((p_data ->> 'promise_self_enabled')::boolean, promise_self_enabled),
           promise_max_days = coalesce((p_data ->> 'promise_max_days')::int, promise_max_days),
           promise_staff_max_days = coalesce((p_data ->> 'promise_staff_max_days')::int, promise_staff_max_days),
           promise_max_broken = coalesce((p_data ->> 'promise_max_broken')::int, promise_max_broken),
           soft_restrict_areas = coalesce(v_areas, soft_restrict_areas),
           updated_at = now(),
           updated_by = auth.uid()
     where id;
  exception when check_violation or invalid_text_representation then
    raise exception 'invalid_settings' using errcode = '22023';
  end;

  -- Apagar los punitorios corta hacia adelante (pausa global); prenderlos de
  -- nuevo no devenga los días apagados.
  if v_before.interest_enabled and not v_on then
    insert into platform_interest_pauses (tenant_id, from_date, reason, created_by)
    values (null, v_today, v_reason, auth.uid())
    on conflict do nothing;
  elsif not v_before.interest_enabled and v_on then
    update platform_interest_pauses
       set to_date = v_today, ended_at = now(), ended_by = auth.uid(), ended_reason = v_reason
     where tenant_id is null and to_date is null;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  select null, auth.uid(), 'platform_billing_settings', null, 'platform_mora_settings_set', to_jsonb(v_before), to_jsonb(s), v_reason
    from platform_billing_settings s where id;
end;
$$;

create or replace function internal_interest_policy_save(p_id uuid, p_data jsonb, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
  v_id     uuid := p_id;
begin
  perform platform_assert_super_admin();
  if p_id is not null then
    select to_jsonb(p) into v_before from platform_interest_policies p where id = p_id;
    if v_before is null then
      raise exception 'policy_not_found' using errcode = 'P0002';
    end if;
  end if;
  begin
    if p_id is null then
      insert into platform_interest_policies (name, monthly_rate_bp, grace_days, method, cap_bp, min_amount_cents, bill_mode,
                                              is_active, created_by, updated_by)
      values (btrim(p_data ->> 'name'), (p_data ->> 'monthly_rate_bp')::int, coalesce((p_data ->> 'grace_days')::int, 0),
              coalesce(p_data ->> 'method', 'daily_prorata'), nullif(p_data ->> 'cap_bp', '')::int,
              coalesce((p_data ->> 'min_amount_cents')::bigint, 0), coalesce(p_data ->> 'bill_mode', 'on_collection'),
              coalesce((p_data ->> 'is_active')::boolean, true), auth.uid(), auth.uid())
      returning id into v_id;
    else
      update platform_interest_policies
         set name = coalesce(btrim(p_data ->> 'name'), name),
             monthly_rate_bp = coalesce((p_data ->> 'monthly_rate_bp')::int, monthly_rate_bp),
             grace_days = coalesce((p_data ->> 'grace_days')::int, grace_days),
             method = coalesce(p_data ->> 'method', method),
             cap_bp = case when p_data ? 'cap_bp' then nullif(p_data ->> 'cap_bp', '')::int else cap_bp end,
             min_amount_cents = coalesce((p_data ->> 'min_amount_cents')::bigint, min_amount_cents),
             bill_mode = coalesce(p_data ->> 'bill_mode', bill_mode),
             is_active = coalesce((p_data ->> 'is_active')::boolean, is_active),
             updated_by = auth.uid(),
             updated_at = now()
       where id = p_id;
    end if;
  exception when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid_policy' using errcode = '22023';
  end;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  select null, auth.uid(), 'platform_interest_policy', v_id, 'platform_interest_policy_saved', v_before, to_jsonb(p), v_reason
    from platform_interest_policies p where p.id = v_id;
  return v_id;
end;
$$;

create or replace function internal_interest_policy_archive(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
begin
  perform platform_assert_super_admin();
  if not exists (select 1 from platform_interest_policies where id = p_id and archived_at is null) then
    raise exception 'policy_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from platform_billing_settings where id and default_interest_policy_id = p_id) then
    raise exception 'default_in_use' using errcode = '22023';
  end if;
  update platform_interest_policies set is_active = false, archived_at = now(), updated_by = auth.uid(), updated_at = now()
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (null, auth.uid(), 'platform_interest_policy', p_id, 'platform_interest_policy_archived', jsonb_build_object('id', p_id), v_reason);
end;
$$;

create or replace function internal_interest_policy_assign_plan(p_plan uuid, p_policy uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before uuid;
begin
  perform platform_assert_super_admin();
  if not exists (select 1 from plans where id = p_plan) then
    raise exception 'plan_not_found' using errcode = 'P0002';
  end if;
  if p_policy is not null and not exists (select 1 from platform_interest_policies where id = p_policy and is_active and archived_at is null) then
    raise exception 'policy_not_found' using errcode = 'P0002';
  end if;
  select policy_id into v_before from platform_interest_policy_plans where plan_id = p_plan;
  if p_policy is null then
    delete from platform_interest_policy_plans where plan_id = p_plan;
  else
    insert into platform_interest_policy_plans (plan_id, policy_id, updated_by, updated_at)
    values (p_plan, p_policy, auth.uid(), now())
    on conflict (plan_id) do update set policy_id = excluded.policy_id, updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (null, auth.uid(), 'platform_interest_policy', p_policy, 'platform_interest_policy_plan_set',
          jsonb_build_object('plan_id', p_plan, 'policy_id', v_before), jsonb_build_object('plan_id', p_plan, 'policy_id', p_policy), v_reason);
end;
$$;

-- Alta o edición de una escalera con sus pasos. Los pasos que vienen con id se
-- editan en su lugar (el id es la clave de idempotencia de lo ya ejecutado);
-- los nuevos se agregan; los que no vienen se dan de baja (lógica).
-- p_data: {name, is_active?, steps: [{id?, offset_days, action, channels,
--          requires_no_promise, min_debt_cents, title, body, is_active?}]}
create or replace function internal_dunning_ladder_save(p_id uuid, p_data jsonb, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_id     uuid := p_id;
  v_before jsonb;
  v_step   jsonb;
  v_sid    uuid;
  v_keep   uuid[] := '{}';
  v_pos    int := 0;
begin
  perform platform_assert_super_admin();
  if jsonb_typeof(p_data -> 'steps') <> 'array' or jsonb_array_length(p_data -> 'steps') = 0
     or jsonb_array_length(p_data -> 'steps') > 20 then
    raise exception 'invalid_ladder' using errcode = '22023';
  end if;
  if p_id is not null then
    select jsonb_build_object('ladder', to_jsonb(l), 'steps', (select jsonb_agg(to_jsonb(s)) from platform_dunning_steps s
                                                                where s.ladder_id = l.id and s.deleted_at is null))
      into v_before from platform_dunning_ladders l where l.id = p_id and l.archived_at is null;
    if v_before is null then
      raise exception 'ladder_not_found' using errcode = 'P0002';
    end if;
  end if;
  begin
    if p_id is null then
      insert into platform_dunning_ladders (name, is_active, created_by, updated_by)
      values (btrim(p_data ->> 'name'), coalesce((p_data ->> 'is_active')::boolean, true), auth.uid(), auth.uid())
      returning id into v_id;
    else
      update platform_dunning_ladders
         set name = coalesce(btrim(p_data ->> 'name'), name),
             is_active = coalesce((p_data ->> 'is_active')::boolean, is_active),
             updated_by = auth.uid(), updated_at = now()
       where id = p_id;
    end if;
  exception when check_violation or not_null_violation then
    raise exception 'invalid_ladder' using errcode = '22023';
  end;

  begin
    for v_step in select * from jsonb_array_elements(p_data -> 'steps') loop
      v_pos := v_pos + 1;
      v_sid := nullif(v_step ->> 'id', '')::uuid;
      if v_sid is not null and exists (select 1 from platform_dunning_steps where id = v_sid and ladder_id = v_id and deleted_at is null) then
        update platform_dunning_steps
           set position = v_pos,
               offset_days = (v_step ->> 'offset_days')::int,
               action = v_step ->> 'action',
               channels = coalesce((select array_agg(distinct x) from jsonb_array_elements_text(v_step -> 'channels') x), '{}'),
               requires_no_promise = coalesce((v_step ->> 'requires_no_promise')::boolean, false),
               min_debt_cents = coalesce((v_step ->> 'min_debt_cents')::bigint, 0),
               title = btrim(v_step ->> 'title'),
               body = btrim(v_step ->> 'body'),
               is_active = coalesce((v_step ->> 'is_active')::boolean, true),
               updated_at = now()
         where id = v_sid;
      else
        insert into platform_dunning_steps (ladder_id, position, offset_days, action, channels, requires_no_promise,
                                            min_debt_cents, title, body, is_active)
        values (v_id, v_pos, (v_step ->> 'offset_days')::int, v_step ->> 'action',
                coalesce((select array_agg(distinct x) from jsonb_array_elements_text(v_step -> 'channels') x), '{}'),
                coalesce((v_step ->> 'requires_no_promise')::boolean, false),
                coalesce((v_step ->> 'min_debt_cents')::bigint, 0), btrim(v_step ->> 'title'), btrim(v_step ->> 'body'),
                coalesce((v_step ->> 'is_active')::boolean, true))
        returning id into v_sid;
      end if;
      v_keep := v_keep || v_sid;
    end loop;
  exception when check_violation or not_null_violation or invalid_text_representation then
    raise exception 'invalid_step' using errcode = '22023';
  end;
  update platform_dunning_steps set deleted_at = now(), is_active = false, updated_at = now()
   where ladder_id = v_id and deleted_at is null and not (id = any (v_keep));

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (null, auth.uid(), 'platform_dunning_ladder', v_id, 'platform_dunning_ladder_saved', v_before,
          jsonb_build_object('ladder', (select to_jsonb(l) from platform_dunning_ladders l where l.id = v_id),
                             'steps', (select jsonb_agg(to_jsonb(s) order by s.offset_days, s.position) from platform_dunning_steps s
                                        where s.ladder_id = v_id and s.deleted_at is null)),
          v_reason);
  return v_id;
end;
$$;

create or replace function internal_dunning_ladder_archive(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
begin
  perform platform_assert_super_admin();
  if not exists (select 1 from platform_dunning_ladders where id = p_id and archived_at is null) then
    raise exception 'ladder_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from platform_billing_settings where id and default_dunning_ladder_id = p_id) then
    raise exception 'default_in_use' using errcode = '22023';
  end if;
  update platform_dunning_ladders set is_active = false, archived_at = now(), updated_by = auth.uid(), updated_at = now()
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (null, auth.uid(), 'platform_dunning_ladder', p_id, 'platform_dunning_ladder_archived', jsonb_build_object('id', p_id), v_reason);
end;
$$;

create or replace function internal_holiday_save(p_day date, p_name text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
begin
  perform platform_assert_super_admin();
  if p_day is null or length(btrim(coalesce(p_name, ''))) < 2 or length(btrim(p_name)) > 80 then
    raise exception 'invalid_holiday' using errcode = '22023';
  end if;
  select to_jsonb(h) into v_before from platform_holidays h where h.day = p_day;
  insert into platform_holidays (day, name, source, created_by)
  values (p_day, btrim(p_name), 'staff', auth.uid())
  on conflict (day) do update set name = excluded.name, source = 'staff', deleted_at = null, updated_at = now();
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (null, auth.uid(), 'platform_holiday', null, 'platform_holiday_saved', v_before,
          jsonb_build_object('day', p_day, 'name', btrim(p_name)), v_reason);
end;
$$;

create or replace function internal_holiday_delete(p_day date, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
begin
  perform platform_assert_super_admin();
  select to_jsonb(h) into v_before from platform_holidays h where h.day = p_day and h.deleted_at is null;
  if v_before is null then
    raise exception 'invalid_holiday' using errcode = '22023';
  end if;
  update platform_holidays set deleted_at = now(), updated_at = now() where day = p_day;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (null, auth.uid(), 'platform_holiday', null, 'platform_holiday_deleted', v_before, jsonb_build_object('day', p_day), v_reason);
end;
$$;

-- Política, escalera y promesas propias de un negocio (admin o super_admin).
-- p_data: {interest_policy_id, dunning_ladder_id, self_promise_enabled}
-- (null = hereda; las claves que no vienen no cambian).
create or replace function internal_billing_set_mora_terms(p_tenant uuid, p_data jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := platform_staff_billing_role();
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
  v_pol    uuid := nullif(p_data ->> 'interest_policy_id', '')::uuid;
  v_lad    uuid := nullif(p_data ->> 'dunning_ladder_id', '')::uuid;
begin
  if coalesce(v_role, '') not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  if v_pol is not null and not exists (select 1 from platform_interest_policies where id = v_pol and is_active and archived_at is null) then
    raise exception 'policy_not_found' using errcode = 'P0002';
  end if;
  if v_lad is not null and not exists (select 1 from platform_dunning_ladders where id = v_lad and is_active and archived_at is null) then
    raise exception 'ladder_not_found' using errcode = 'P0002';
  end if;
  insert into tenant_billing_terms (tenant_id, created_by, updated_by) values (p_tenant, auth.uid(), auth.uid())
  on conflict (tenant_id) do nothing;
  select jsonb_build_object('interest_policy_id', interest_policy_id, 'dunning_ladder_id', dunning_ladder_id,
                            'self_promise_enabled', self_promise_enabled)
    into v_before from tenant_billing_terms where tenant_id = p_tenant;
  update tenant_billing_terms
     set interest_policy_id = case when p_data ? 'interest_policy_id' then v_pol else interest_policy_id end,
         dunning_ladder_id = case when p_data ? 'dunning_ladder_id' then v_lad else dunning_ladder_id end,
         self_promise_enabled = case when p_data ? 'self_promise_enabled' then (p_data ->> 'self_promise_enabled')::boolean
                                     else self_promise_enabled end,
         updated_by = auth.uid()
   where tenant_id = p_tenant;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  select p_tenant, auth.uid(), 'tenant_billing_terms', bt.id, 'tenant_billing_mora_terms_set', v_before,
         jsonb_build_object('interest_policy_id', bt.interest_policy_id, 'dunning_ladder_id', bt.dunning_ladder_id,
                            'self_promise_enabled', bt.self_promise_enabled, 'role', v_role),
         v_reason
    from tenant_billing_terms bt where bt.tenant_id = p_tenant;
end;
$$;

-- Suspender o reanudar el devengamiento de un negocio (§10.3): sólo hacia
-- adelante, con motivo (por ejemplo, un reclamo en curso).
create or replace function internal_interest_pause(p_tenant uuid, p_paused boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := platform_staff_billing_role();
  v_reason text := platform_assert_reason(p_reason);
  v_today  date := platform_ar_date(now());
begin
  if coalesce(v_role, '') not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  perform platform_lock_tenant(p_tenant);
  insert into tenant_billing_terms (tenant_id, created_by, updated_by) values (p_tenant, auth.uid(), auth.uid())
  on conflict (tenant_id) do nothing;
  if p_paused then
    -- Lo de hoy queda devengado (el cron corre a la mañana): pausa desde mañana.
    insert into platform_interest_pauses (tenant_id, from_date, reason, created_by)
    select p_tenant, v_today + 1, v_reason, auth.uid()
     where not exists (select 1 from platform_interest_pauses where tenant_id = p_tenant and to_date is null);
    update tenant_billing_terms set interest_enabled = false, updated_by = auth.uid() where tenant_id = p_tenant;
  else
    update platform_interest_pauses
       set to_date = greatest(from_date, v_today + 1), ended_at = now(), ended_by = auth.uid(), ended_reason = v_reason
     where tenant_id = p_tenant and to_date is null;
    update tenant_billing_terms set interest_enabled = true, updated_by = auth.uid() where tenant_id = p_tenant;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (p_tenant, auth.uid(), 'tenant_billing_terms', null,
          case when p_paused then 'platform_interest_paused' else 'platform_interest_resumed' end,
          jsonb_build_object('from', v_today + 1, 'role', v_role), v_reason);
end;
$$;

-- -----------------------------------------------------------------------------
-- N) Historia de la cuenta: suma promesas, pasos de la escalera y documentos
--    pendientes, y agrupa el devengo diario por mes. Mismo cuerpo que
--    20261113100100 en lo demás (verificado igual a producción).
-- -----------------------------------------------------------------------------
create or replace function platform_statement(p_tenant uuid, p_staff boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := platform_ar_date(now());
  v_head  jsonb;
  v_mov   jsonb;
  v_chg   jsonb;
  v_alloc jsonb;
  v_pay   jsonb;
  v_tl    jsonb := '[]'::jsonb;
  v_sub   jsonb;
  v_terms jsonb;
  v_b     jsonb;
begin
  create temporary table if not exists _ps_mv (
    id uuid, kind text, amount_cents bigint, effective_date date, due_date date, description text, reason text,
    charge_id uuid, payment_id uuid, parent_id uuid, created_at timestamptz, created_by uuid, open_cents bigint
  ) on commit drop;
  truncate _ps_mv;
  insert into _ps_mv
  select l.id, l.kind, l.amount_cents, l.effective_date, l.due_date, l.description, l.reason,
         l.charge_id, l.payment_id, l.parent_id, l.created_at, l.created_by,
         abs(l.amount_cents) - coalesce((select sum(a.amount_cents) from platform_allocations a
                                          where a.released_at is null
                                            and (a.credit_movement_id = l.id or a.debit_movement_id = l.id)), 0)
    from platform_ledger l
   where l.tenant_id = p_tenant;

  select jsonb_build_object(
           'balance_cents', coalesce(sum(m.amount_cents), 0),
           'overdue_cents', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and coalesce(m.due_date, m.effective_date) < v_today), 0),
           'upcoming_cents', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and coalesce(m.due_date, m.effective_date) >= v_today), 0),
           'credit_cents', coalesce(sum(m.open_cents) filter (where m.amount_cents < 0), 0),
           'oldest_due_date', min(coalesce(m.due_date, m.effective_date)) filter (where m.amount_cents > 0 and m.open_cents > 0 and coalesce(m.due_date, m.effective_date) < v_today),
           'aging', jsonb_build_object(
             'd1_30', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and v_today - coalesce(m.due_date, m.effective_date) between 1 and 30), 0),
             'd31_60', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and v_today - coalesce(m.due_date, m.effective_date) between 31 and 60), 0),
             'd61_90', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and v_today - coalesce(m.due_date, m.effective_date) between 61 and 90), 0),
             'd90_plus', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and v_today - coalesce(m.due_date, m.effective_date) > 90), 0)))
    into v_head
    from _ps_mv m;

  v_head := v_head || jsonb_build_object('next_due', (
    select jsonb_build_object('date', x.d, 'cents', x.s)
      from (select coalesce(m.due_date, m.effective_date) as d, sum(m.open_cents) as s
              from _ps_mv m
             where m.amount_cents > 0 and m.open_cents > 0 and coalesce(m.due_date, m.effective_date) >= v_today
             group by 1 order by 1 limit 1) x));

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'kind', r.kind, 'description', r.description,
           'effective_date', r.effective_date, 'due_date', r.due_date,
           'amount_cents', r.amount_cents, 'open_cents', r.open_cents,
           'balance_after_cents', r.balance_after,
           'charge_id', r.charge_id, 'payment_id', r.payment_id, 'parent_id', r.parent_id,
           'created_at', r.created_at)
           || case when p_staff then jsonb_build_object(
                'reason', r.reason,
                'created_by_name', (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = r.created_by))
              else '{}'::jsonb end
           order by r.effective_date desc, r.created_at desc, r.id desc), '[]'::jsonb)
    into v_mov
    from (
      select m.*, sum(m.amount_cents) over (order by m.effective_date, m.created_at, m.id
                                            rows between unbounded preceding and current row) as balance_after
        from _ps_mv m
       order by m.effective_date desc, m.created_at desc, m.id desc
       limit 300
    ) r;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'kind', c.kind, 'description', c.description,
           'period_start', c.period_start, 'period_end', c.period_end, 'due_date', c.due_date,
           'subtotal_cents', c.subtotal_cents, 'discount_cents', c.discount_cents, 'total_cents', c.total_cents,
           'status', c.status, 'created_at', c.created_at, 'voided_at', c.voided_at,
           'open_cents', coalesce((select m.open_cents from _ps_mv m where m.charge_id = c.id and m.kind = 'charge'), 0),
           'lines', coalesce((select jsonb_agg(jsonb_build_object(
                       'source', ln.source, 'description', ln.description, 'qty', ln.qty,
                       'unit_cents', ln.unit_cents, 'amount_cents', ln.amount_cents) order by ln.position)
                     from platform_charge_lines ln where ln.charge_id = c.id), '[]'::jsonb))
           || case when p_staff then jsonb_build_object('void_reason', c.void_reason, 'source', c.source) else '{}'::jsonb end
           order by c.due_date desc, c.created_at desc), '[]'::jsonb)
    into v_chg
    from (select * from platform_charges where tenant_id = p_tenant order by due_date desc, created_at desc limit 120) c;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'credit_movement_id', a.credit_movement_id, 'debit_movement_id', a.debit_movement_id,
           'credit_description', cr.description, 'debit_description', db.description,
           'amount_cents', a.amount_cents, 'created_at', a.created_at, 'released_at', a.released_at)
           order by a.created_at desc), '[]'::jsonb)
    into v_alloc
    from (select * from platform_allocations where tenant_id = p_tenant order by created_at desc limit 300) a
    join platform_ledger cr on cr.id = a.credit_movement_id
    join platform_ledger db on db.id = a.debit_movement_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'method', p.method, 'status', p.status, 'amount_cents', p.amount_cents,
           'paid_at', p.paid_at, 'provider', p.provider, 'period_start', p.period_start, 'period_end', p.period_end)
           || case when p_staff then jsonb_build_object(
                'external_id', p.external_id, 'payer_reference', p.payer_reference, 'notes', p.notes,
                'recorded_by_name', (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = p.recorded_by))
              else '{}'::jsonb end
           order by p.paid_at desc), '[]'::jsonb)
    into v_pay
    from (select * from platform_payments where tenant_id = p_tenant order by paid_at desc limit 100) p;

  select jsonb_build_object('status', s.status, 'billing_cycle', s.billing_cycle,
                            'current_period_start', s.current_period_start, 'current_period_end', s.current_period_end,
                            'plan_name', p.name, 'plan_key', p.key, 'has_mp', s.mp_preapproval_id is not null)
    into v_sub
    from subscriptions s join plans p on p.id = s.plan_id
   where s.tenant_id = p_tenant;

  v_b := platform_billing_breakdown(p_tenant, null);

  if p_staff then
    select to_jsonb(bt) - 'id' into v_terms from tenant_billing_terms bt where bt.tenant_id = p_tenant;
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', a.id, 'at', a.created_at, 'action', a.action, 'entity_type', a.entity_type,
             'reason', a.reason, 'data', a.after_data,
             'actor', case when a.actor_user_id is null then null
                           else (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = a.actor_user_id) end)
             order by a.created_at desc), '[]'::jsonb)
      into v_tl
      from (
        select x.id, x.created_at, x.action, x.entity_type, x.reason, x.after_data, x.actor_user_id
          from (
            select a.id, a.created_at, a.action, a.entity_type, a.reason, a.after_data, a.actor_user_id
              from audit_logs a
             where a.tenant_id = p_tenant
               and a.action <> 'platform_interest_accrued'
               and (a.entity_type in ('platform_charge', 'platform_payment', 'platform_ledger', 'tenant_billing_terms', 'tenants',
                                      'platform_promise', 'platform_dunning', 'platform_fiscal_pending')
                    or a.action in ('plan_changed', 'subscription_webhook', 'subscription_reactivated', 'status_changed',
                                    'trial_extended', 'payment_recorded', 'subscription_cancelled_on_reanchor'))
            union all
            -- F20-9 (ADR-128): el devengo diario de punitorios se muestra
            -- agrupado por mes (una fila con el total), para no tapar el resto.
            select (array_agg(a.id order by a.created_at desc))[1], max(a.created_at), 'platform_interest_accrued',
                   'platform_ledger', null::text,
                   jsonb_build_object('amount_cents', sum(coalesce((a.after_data ->> 'amount_cents')::bigint, 0)),
                                      'month', to_char(min(a.created_at) at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM'),
                                      'days', count(*)),
                   null::uuid
              from audit_logs a
             where a.tenant_id = p_tenant
               and a.action = 'platform_interest_accrued'
             group by date_trunc('month', a.created_at at time zone 'America/Argentina/Buenos_Aires')
          ) x
         order by x.created_at desc
         limit 80
      ) a;
  end if;

  return v_head || jsonb_build_object(
    'tenant_id', p_tenant,
    'as_of', v_today,
    'currency', 'ARS',
    'billing_mode', platform_effective_billing_mode(p_tenant),
    'exclusion', platform_billing_exclusion(p_tenant),
    'subscription', v_sub,
    'recurring_cents', case when v_b is null then null else platform_cents((v_b ->> 'total')::numeric) end,
    'recurring_gross_cents', case when v_b is null then null else platform_cents((v_b ->> 'gross')::numeric) end,
    'movements', v_mov,
    'charges', v_chg,
    'allocations', v_alloc,
    'payments', v_pay
  ) || case when p_staff then jsonb_build_object(
         'terms', v_terms, 'timeline', v_tl,
         'is_test', (select t.is_test from tenants t where t.id = p_tenant)) else '{}'::jsonb end;
end;
$$;

revoke all on function platform_statement(uuid, boolean) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- O) Valores iniciales: una política (apagada, §22 #4) y la escalera por
--    defecto de §22 #6 (aviso al día 1, restricción parcial al 7, suspensión
--    al 10), editables. Re-aplicar no duplica.
-- -----------------------------------------------------------------------------
insert into platform_interest_policies (name, monthly_rate_bp, grace_days, method, cap_bp, min_amount_cents, bill_mode)
select 'Punitorio estándar', 500, 0, 'daily_prorata', 5000, 0, 'on_collection'
 where not exists (select 1 from platform_interest_policies);

update platform_billing_settings
   set default_interest_policy_id = (select id from platform_interest_policies where archived_at is null order by created_at limit 1)
 where id and default_interest_policy_id is null;

do $seed$
declare
  v_ladder uuid;
begin
  if exists (select 1 from platform_dunning_ladders) then
    return;
  end if;
  insert into platform_dunning_ladders (name) values ('Escalera estándar') returning id into v_ladder;
  insert into platform_dunning_steps (ladder_id, position, offset_days, action, channels, requires_no_promise, title, body) values
    (v_ladder, 1, 1, 'past_due', '{email,in_app}', false,
     'Tenés un pago pendiente',
     'Tu cuota de {monto} venció el {vence}. Pagala desde tu panel para no tener restricciones. Si ya pagaste, no hace falta que hagas nada.'),
    (v_ladder, 2, 3, 'notify', '{email,in_app}', false,
     'Recordatorio: tenés {monto} vencidos',
     'Llevás {dias} días de atraso. El monto ya incluye los punitorios, si corresponden. Pagá desde tu panel o avisanos si ya transferiste.'),
    (v_ladder, 3, 7, 'soft_restrict', '{email,in_app}', true,
     'Limitamos parte de tu cuenta',
     'Tu deuda de {monto} lleva {dias} días vencida. Podés seguir vendiendo, pero reportes y configuración quedan limitados hasta que regularices.'),
    (v_ladder, 4, 8, 'notify', '{email,in_app}', true,
     'Tu cuenta se suspende en 2 días',
     'Si no registramos el pago de {monto} en los próximos 2 días, tu cuenta pasa a sólo lectura. Regularizá desde tu panel.'),
    (v_ladder, 5, 10, 'suspend', '{email,in_app}', true,
     'Suspendimos tu cuenta',
     'Tu cuenta quedó en sólo lectura por una deuda de {monto}. Al pagar se reactiva sola.'),
    (v_ladder, 6, 60, 'mark_uncollectible', '{}', true,
     'Deuda incobrable',
     'Deuda de {monto} con {dias} días de atraso. Revisar si corresponde la baja.');
end
$seed$;

update platform_billing_settings
   set default_dunning_ladder_id = (select id from platform_dunning_ladders where archived_at is null order by created_at limit 1)
 where id and default_dunning_ladder_id is null;

-- -----------------------------------------------------------------------------
-- P) Permisos de ejecución
-- -----------------------------------------------------------------------------
revoke all on function platform_mora_no_delete() from public, anon, authenticated;
revoke all on function platform_is_business_day(date) from public, anon, authenticated;
revoke all on function platform_next_business_day(date) from public, anon, authenticated;
revoke all on function platform_interest_schedule(jsonb, date, bigint, jsonb, date, date, jsonb) from public, anon, authenticated;
revoke all on function platform_interest_policy_for(uuid) from public, anon, authenticated;
revoke all on function platform_interest_policy_source(uuid) from public, anon, authenticated;
revoke all on function platform_dunning_ladder_for(uuid) from public, anon, authenticated;
revoke all on function platform_interest_policy_json(platform_interest_policies) from public, anon, authenticated;
revoke all on function platform_interest_accrue_tenant(uuid, date, uuid) from public, anon, authenticated;
revoke all on function platform_interest_run(timestamptz) from public, anon, authenticated;
revoke all on function trg_platform_allocations_fiscal() from public, anon, authenticated;
revoke all on function platform_mora_debt(uuid, date) from public, anon, authenticated;
revoke all on function platform_mora_next_step(uuid, uuid, uuid, date, date, boolean, text[]) from public, anon, authenticated;
revoke all on function platform_dunning_render(text, bigint, int, date, text) from public, anon, authenticated;
revoke all on function platform_mora_evaluate(uuid, date, boolean, uuid) from public, anon, authenticated;
revoke all on function run_saas_dunning() from public, anon, authenticated;
revoke all on function platform_dunning_run(timestamptz) from public, anon, authenticated;
revoke all on function trg_platform_allocations_mora() from public, anon, authenticated;
revoke all on function platform_interest_open(uuid, uuid[]) from public, anon, authenticated;
revoke all on function platform_interest_apply_waiver(uuid, uuid) from public, anon, authenticated;
revoke all on function platform_waiver_json(platform_interest_waivers) from public, anon, authenticated;
revoke all on function platform_promise_json(platform_promises) from public, anon, authenticated;

revoke all on function internal_interest_waive(uuid, uuid[], bigint, text, uuid) from public, anon;
revoke all on function internal_interest_waiver_decide(uuid, boolean, text) from public, anon;
revoke all on function owner_promise_create(bigint, date, text) from public, anon;
revoke all on function internal_promise_create(uuid, bigint, date, text, text) from public, anon;
revoke all on function internal_promise_update(uuid, text, date, text) from public, anon;
revoke all on function my_billing_mora() from public, anon;
revoke all on function my_billing_restriction() from public, anon;
revoke all on function internal_billing_mora(uuid) from public, anon;
revoke all on function internal_billing_mora_overview() from public, anon;
revoke all on function internal_billing_mora_config() from public, anon;
revoke all on function internal_billing_set_mora_settings(jsonb, text) from public, anon;
revoke all on function internal_interest_policy_save(uuid, jsonb, text) from public, anon;
revoke all on function internal_interest_policy_archive(uuid, text) from public, anon;
revoke all on function internal_interest_policy_assign_plan(uuid, uuid, text) from public, anon;
revoke all on function internal_dunning_ladder_save(uuid, jsonb, text) from public, anon;
revoke all on function internal_dunning_ladder_archive(uuid, text) from public, anon;
revoke all on function internal_holiday_save(date, text, text) from public, anon;
revoke all on function internal_holiday_delete(date, text) from public, anon;
revoke all on function internal_billing_set_mora_terms(uuid, jsonb, text) from public, anon;
revoke all on function internal_interest_pause(uuid, boolean, text) from public, anon;

grant execute on function internal_interest_waive(uuid, uuid[], bigint, text, uuid) to authenticated;
grant execute on function internal_interest_waiver_decide(uuid, boolean, text) to authenticated;
grant execute on function owner_promise_create(bigint, date, text) to authenticated;
grant execute on function internal_promise_create(uuid, bigint, date, text, text) to authenticated;
grant execute on function internal_promise_update(uuid, text, date, text) to authenticated;
grant execute on function my_billing_mora() to authenticated;
grant execute on function my_billing_restriction() to authenticated;
grant execute on function internal_billing_mora(uuid) to authenticated;
grant execute on function internal_billing_mora_overview() to authenticated;
grant execute on function internal_billing_mora_config() to authenticated;
grant execute on function internal_billing_set_mora_settings(jsonb, text) to authenticated;
grant execute on function internal_interest_policy_save(uuid, jsonb, text) to authenticated;
grant execute on function internal_interest_policy_archive(uuid, text) to authenticated;
grant execute on function internal_interest_policy_assign_plan(uuid, uuid, text) to authenticated;
grant execute on function internal_dunning_ladder_save(uuid, jsonb, text) to authenticated;
grant execute on function internal_dunning_ladder_archive(uuid, text) to authenticated;
grant execute on function internal_holiday_save(date, text, text) to authenticated;
grant execute on function internal_holiday_delete(date, text) to authenticated;
grant execute on function internal_billing_set_mora_terms(uuid, jsonb, text) to authenticated;
grant execute on function internal_interest_pause(uuid, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Q) pg_cron: platform-interest 06:30 ART (09:30 UTC) y platform-dunning
--    09:00 ART (12:00 UTC). saas-dunning se desprograma: la escalera lo
--    reemplaza (§13.2). Sin pg_cron (local, CI) se omite.
-- -----------------------------------------------------------------------------
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omiten platform-interest y platform-dunning.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'saas-dunning') then
    perform cron.unschedule('saas-dunning');
  end if;
  if exists (select 1 from cron.job where jobname = 'platform-interest') then
    perform cron.unschedule('platform-interest');
  end if;
  perform cron.schedule('platform-interest', '30 9 * * *', $$select public.platform_interest_run()$$);
  if exists (select 1 from cron.job where jobname = 'platform-dunning') then
    perform cron.unschedule('platform-dunning');
  end if;
  perform cron.schedule('platform-dunning', '0 12 * * *', $$select public.platform_dunning_run()$$);
end
$cron$;
