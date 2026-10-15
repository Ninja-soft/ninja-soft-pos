-- =============================================================================
-- 20261126100000_cobranza_360  (F20-10 y F20-11 · H136 · ADR-131)
--
-- Prorrateo, conciliación con Mercado Pago y cobranza 360 de la plataforma
-- (spec docs/40-cobranza-saas.md §9.5, §10.6, §14.3, §17.2, §17.3, §17.4 y
-- §18; decisiones del dueño §22 #8, #9 y #12).
--
-- 1) Prorrateo (F20-10, §17.4). Extiende el de F20-1 (ADR-115) sin duplicar:
--    · platform_prorate_cents()      el único cálculo (centavos, descuento en
--                                     puntos básicos, mitad para arriba). Espejo
--                                     exacto de lib/billing/proration.ts.
--    · platform_billing_breakdown_for / platform_period_lines_for: el desglose
--      y las líneas del período con un plan y un ciclo dados. Las funciones de
--      siempre (platform_billing_breakdown, platform_period_lines) pasan a
--      llamarlas con el plan y el ciclo vigentes: mismo resultado.
--    · platform_proration_core()     upgrade, downgrade, cambio de ciclo
--                                     (mensual ↔ anual) con líneas congeladas.
--    · trg_subscriptions_proration   ahora usa el núcleo (mismo importe y misma
--                                     clave que antes) y no prorratea si el
--                                     cargo del período vigente todavía no se
--                                     generó (saldría con el plan nuevo: era un
--                                     cobro doble).
--    · Addons a mitad de período: cargo 'addon' por los días que quedan hasta
--      el fin del período del plan (vence con el próximo cobro).
--    · internal_billing_proration_preview / internal_billing_plan_change: el
--      simulador del panel interno y la confirmación (cambio inmediato o al fin
--      del período; downgrade inmediato = bonificación con el tope del nivel).
--    · platform_plan_changes: historia de cambios (aplicados y programados) y
--      cron platform-plan-changes que aplica los programados.
--
-- 2) Conciliación diaria con Mercado Pago (F20-10, §9.5, §17.2, §17.3).
--    La Edge platform_mp_reconcile lee la API (sólo GET, cuenta de NinjaSoft,
--    platform_secrets 'mercadopago') y compara con platform_payments con la
--    lógica pura de _shared/billing/reconcile.ts. La base guarda:
--    · platform_mp_recon_runs        corridas (ok, degradada sin credenciales,
--                                     error).
--    · platform_mp_payments_seen     la última foto de cada pago de MP visto.
--    · platform_recon_diffs          bandeja de diferencias (faltantes,
--                                     duplicados, montos distintos,
--                                     contracargos, reintegros, estados).
--    · internal_recon_resolve        imputar, dejar a cuenta, registrar
--                                     reintegro o contracargo, aceptar, ignorar.
--    Cron platform-mp-reconcile 04:00 ART (pg_net → Edge con X-Cron-Secret).
--
-- 3) Cobranza 360 (F20-11, §10.6, §14.3, §18).
--    · Permisos finos sobre el permiso Cobranzas: 'cobranzas' (gestionar, el de
--      siempre), 'cobranzas_ver' (sólo ver) y 'cobranzas_asignar' (asignar
--      cobradores). platform_billing_can('view' | 'manage' | 'assign').
--    · Cobrador asignado en tenant_billing_terms.assigned_staff_id.
--    · platform_collection_notes: notas de gestión con próxima acción.
--    · internal_billing_portfolio(): lista de cobranza (aging, monto, escalera,
--      promesa, cobrador, última gestión).
--    · internal_billing_timeline(): cargos, pagos, imputaciones, punitorios,
--      condonaciones, promesas, pasos de la escalera, avisos, transferencias
--      informadas, cambios de plan y de modalidad, notas y conciliación.
--
-- Exclusiones (§22 #7): negocios de prueba, del staff, lifetime y exentos no
-- se prorratean, no aparecen en la cartera y sus diferencias de conciliación
-- se marcan como excluidas.
--
-- RLS: tablas de plataforma con SELECT sólo staff (select internal_scope()),
-- nunca OR is_internal(); escritura sólo por RPC SECURITY DEFINER con motivo y
-- auditoría. Requiere 20261113100000, 20261113100100, 20261116100000 y
-- 20261124100000 (ADR-115, ADR-120, ADR-128).
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Permisos finos sobre "Cobranzas" (§18, §22 #8)
-- -----------------------------------------------------------------------------
alter table platform_staff_permissions drop constraint if exists platform_staff_permissions_permission_check;
alter table platform_staff_permissions add constraint platform_staff_permissions_permission_check
  check (permission in ('cobranzas', 'cobranzas_ver', 'cobranzas_asignar'));

comment on column platform_staff_permissions.permission is
  'cobranzas = ver y gestionar (registrar pagos, bonificar, notas, promesas, conciliación); cobranzas_ver = sólo ver la cobranza 360; cobranzas_asignar = asignar cobradores. admin y super_admin tienen todo por su nivel (ADR-131).';

-- Capacidades de cobranza del usuario actual: view, manage, assign.
create or replace function platform_billing_capabilities()
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role  text := platform_staff_billing_role();
  v_perms text[];
  v_caps  text[] := '{}';
begin
  if v_role is null then
    return '{}';
  end if;
  if v_role in ('admin', 'super_admin') then
    return array['view', 'manage', 'assign'];
  end if;
  select coalesce(array_agg(p.permission), '{}') into v_perms
    from platform_staff_permissions p
   where p.user_id = auth.uid() and p.revoked_at is null;
  if 'cobranzas' = any(v_perms) then
    v_caps := v_caps || array['view', 'manage'];
  end if;
  if 'cobranzas_asignar' = any(v_perms) then
    v_caps := v_caps || array['view', 'assign'];
  end if;
  if 'cobranzas_ver' = any(v_perms) then
    v_caps := v_caps || array['view'];
  end if;
  return array(select distinct unnest(v_caps) order by 1);
end;
$$;

create or replace function platform_billing_can(p_cap text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select p_cap = any(platform_billing_capabilities()) $$;

create or replace function platform_assert_billing_can(p_cap text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not platform_billing_can(p_cap) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- El alta de permisos acepta los nuevos (super_admin, con motivo y auditoría).
create or replace function internal_set_staff_permission(
  p_user       uuid,
  p_permission text,
  p_enabled    boolean,
  p_reason     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_has    boolean;
begin
  if platform_staff_billing_role() is distinct from 'super_admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_permission not in ('cobranzas', 'cobranzas_ver', 'cobranzas_asignar') then
    raise exception 'invalid_permission' using errcode = '22023';
  end if;
  if not exists (select 1 from users where id = p_user and internal_level is not null) then
    raise exception 'not_staff' using errcode = '22023';
  end if;
  v_has := exists (select 1 from platform_staff_permissions
                    where user_id = p_user and permission = p_permission and revoked_at is null);
  if coalesce(p_enabled, false) = v_has then
    return;
  end if;
  if p_enabled then
    insert into platform_staff_permissions (user_id, permission, granted_by, reason)
    values (p_user, p_permission, auth.uid(), v_reason);
  else
    update platform_staff_permissions
       set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = v_reason
     where user_id = p_user and permission = p_permission and revoked_at is null;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (null, auth.uid(), 'staff', p_user,
          case when p_enabled then 'staff_permission_granted' else 'staff_permission_revoked' end,
          jsonb_build_object('permission', p_permission, 'enabled', v_has),
          jsonb_build_object('permission', p_permission, 'enabled', p_enabled),
          v_reason);
end;
$$;

-- Para la UI: lo de siempre más las capacidades finas.
create or replace function internal_my_billing_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := platform_staff_billing_role();
  v_caps text[];
begin
  if v_role is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_caps := platform_billing_capabilities();
  return jsonb_build_object(
    'role', v_role,
    'can_operate', v_role in ('cobranzas', 'admin', 'super_admin'),
    'can_set_terms', v_role in ('admin', 'super_admin'),
    'can_configure', v_role = 'super_admin',
    'capabilities', to_jsonb(v_caps),
    'can_view_360', 'view' = any(v_caps),
    'can_manage', 'manage' = any(v_caps),
    'can_assign', 'assign' = any(v_caps),
    'caps', coalesce((select jsonb_agg(jsonb_build_object(
                        'level', c.level, 'per_operation_cents', c.per_operation_cents,
                        'per_month_cents', c.per_month_cents, 'updated_at', c.updated_at)
                        order by case c.level when 'cobranzas' then 1 when 'admin' then 2 else 3 end)
                      from platform_billing_caps c), '[]'::jsonb)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- B) Cobrador asignado y notas de gestión (§14.3, §6.3)
-- -----------------------------------------------------------------------------
alter table tenant_billing_terms
  add column if not exists assigned_staff_id uuid references users(id),
  add column if not exists assigned_at timestamptz,
  add column if not exists assigned_by uuid references users(id);
create index if not exists tenant_billing_terms_assigned_idx on tenant_billing_terms (assigned_staff_id);
create index if not exists tenant_billing_terms_assigned_by_idx on tenant_billing_terms (assigned_by);

create table if not exists platform_collection_notes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete restrict,
  kind           text not null check (kind in ('call', 'whatsapp', 'email', 'meeting', 'other')),
  outcome        text check (outcome in ('contacted', 'no_answer', 'promised', 'disputed', 'other')),
  body           text not null check (length(btrim(body)) between 3 and 2000),
  next_action_at date,
  created_by     uuid references users(id),
  created_at     timestamptz not null default now(),
  voided_at      timestamptz,
  voided_by      uuid references users(id),
  void_reason    text,
  constraint platform_collection_notes_void check (voided_at is null or length(btrim(coalesce(void_reason, ''))) >= 5)
);
create index if not exists platform_collection_notes_tenant_idx on platform_collection_notes (tenant_id, created_at desc);
create index if not exists platform_collection_notes_next_idx on platform_collection_notes (next_action_at) where voided_at is null;
create index if not exists platform_collection_notes_created_by_idx on platform_collection_notes (created_by);
create index if not exists platform_collection_notes_voided_by_idx on platform_collection_notes (voided_by);

-- Una nota no se edita ni se borra: sólo se anula una vez.
create or replace function platform_collection_notes_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'platform_collection_notes no se borra: se anula' using errcode = '42501';
  end if;
  if (new.tenant_id, new.kind, new.outcome, new.body, new.next_action_at, new.created_by, new.created_at)
     is distinct from
     (old.tenant_id, old.kind, old.outcome, old.body, old.next_action_at, old.created_by, old.created_at)
     or old.voided_at is not null then
    raise exception 'platform_collection_notes: sólo se puede anular una nota vigente' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists platform_collection_notes_guard on platform_collection_notes;
create trigger platform_collection_notes_guard before update or delete on platform_collection_notes
  for each row execute function platform_collection_notes_guard();

-- -----------------------------------------------------------------------------
-- C) Cambios de plan, ciclo y addons (§17.4)
-- -----------------------------------------------------------------------------
create table if not exists platform_plan_changes (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete restrict,
  subscription_id    uuid references subscriptions(id) on delete restrict,
  kind               text not null check (kind in ('upgrade', 'downgrade', 'lateral', 'cycle_up', 'cycle_down', 'addon_add')),
  from_plan_id       uuid references plans(id) on delete restrict,
  to_plan_id         uuid references plans(id) on delete restrict,
  from_cycle         text check (from_cycle in ('monthly', 'yearly')),
  to_cycle           text check (to_cycle in ('monthly', 'yearly')),
  addon_key          text,
  timing             text not null check (timing in ('immediate', 'period_end')),
  status             text not null check (status in ('applied', 'scheduled', 'cancelled')),
  effective_on       date not null,
  quote              jsonb not null default '{}'::jsonb,
  charge_id          uuid references platform_charges(id) on delete restrict,
  credit_movement_id uuid references platform_ledger(id) on delete restrict,
  charge_cents       bigint not null default 0,
  credit_cents       bigint not null default 0,
  source             text not null default 'staff' check (source in ('staff', 'trigger', 'system')),
  request_id         uuid unique,
  reason             text,
  created_by         uuid references users(id),
  created_at         timestamptz not null default now(),
  applied_at         timestamptz,
  cancelled_at       timestamptz,
  cancelled_by       uuid references users(id),
  cancel_reason      text,
  updated_at         timestamptz not null default now()
);
create index if not exists platform_plan_changes_tenant_idx on platform_plan_changes (tenant_id, created_at desc);
create index if not exists platform_plan_changes_scheduled_idx on platform_plan_changes (effective_on) where status = 'scheduled';
create unique index if not exists platform_plan_changes_one_scheduled_uidx on platform_plan_changes (tenant_id) where status = 'scheduled';
create index if not exists platform_plan_changes_sub_idx on platform_plan_changes (subscription_id);
create index if not exists platform_plan_changes_from_plan_idx on platform_plan_changes (from_plan_id);
create index if not exists platform_plan_changes_to_plan_idx on platform_plan_changes (to_plan_id);
create index if not exists platform_plan_changes_charge_idx on platform_plan_changes (charge_id);
create index if not exists platform_plan_changes_credit_idx on platform_plan_changes (credit_movement_id);
create index if not exists platform_plan_changes_created_by_idx on platform_plan_changes (created_by);
create index if not exists platform_plan_changes_cancelled_by_idx on platform_plan_changes (cancelled_by);
drop trigger if exists set_updated_at_platform_plan_changes on platform_plan_changes;
create trigger set_updated_at_platform_plan_changes
  before update on platform_plan_changes
  for each row execute function set_updated_at();
drop trigger if exists platform_plan_changes_no_delete on platform_plan_changes;
create trigger platform_plan_changes_no_delete before delete on platform_plan_changes
  for each row execute function platform_mora_no_delete();

-- -----------------------------------------------------------------------------
-- D) Conciliación con Mercado Pago (§9.5)
-- -----------------------------------------------------------------------------
alter table platform_billing_settings
  add column if not exists recon_window_hours int not null default 72 check (recon_window_hours between 24 and 720),
  add column if not exists recon_tolerance_cents bigint not null default 100 check (recon_tolerance_cents between 0 and 1000000);

create table if not exists platform_mp_recon_runs (
  id           uuid primary key default gen_random_uuid(),
  source       text not null check (source in ('cron', 'manual')),
  status       text not null default 'running' check (status in ('running', 'ok', 'degraded', 'error')),
  window_from  timestamptz not null,
  window_to    timestamptz not null,
  mp_count     int not null default 0,
  local_count  int not null default 0,
  matched      int not null default 0,
  diffs_new    int not null default 0,
  diffs_closed int not null default 0,
  fees_updated int not null default 0,
  message      text,
  started_by   uuid references users(id),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  constraint platform_mp_recon_runs_window check (window_to > window_from)
);
create index if not exists platform_mp_recon_runs_started_idx on platform_mp_recon_runs (started_at desc);
create index if not exists platform_mp_recon_runs_started_by_idx on platform_mp_recon_runs (started_by);

create table if not exists platform_mp_payments_seen (
  mp_payment_id     text primary key,
  status            text not null,
  status_detail     text,
  operation_type    text,
  amount_cents      bigint not null,
  refunded_cents    bigint not null default 0,
  fee_cents         bigint,
  net_cents         bigint,
  date_created      timestamptz,
  date_approved     timestamptz,
  date_last_updated timestamptz,
  external_reference text,
  preapproval_id    text,
  description       text,
  tenant_id         uuid references tenants(id) on delete restrict,
  payment_id        uuid references platform_payments(id) on delete restrict,
  match_kind        text check (match_kind in ('exact', 'loose')),
  last_run_id       uuid references platform_mp_recon_runs(id) on delete restrict,
  first_seen_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists platform_mp_payments_seen_tenant_idx on platform_mp_payments_seen (tenant_id, date_created desc);
create index if not exists platform_mp_payments_seen_payment_idx on platform_mp_payments_seen (payment_id);
create index if not exists platform_mp_payments_seen_run_idx on platform_mp_payments_seen (last_run_id);

create table if not exists platform_recon_diffs (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references platform_mp_recon_runs(id) on delete restrict,
  last_run_id     uuid not null references platform_mp_recon_runs(id) on delete restrict,
  diff_key        text not null,
  kind            text not null check (kind in ('missing_local', 'missing_mp', 'duplicate', 'amount_mismatch',
                                                 'chargeback', 'refund', 'status_mismatch')),
  severity        text not null default 'medium' check (severity in ('high', 'medium', 'low')),
  status          text not null default 'open' check (status in ('open', 'resolved', 'ignored', 'auto_resolved')),
  tenant_id       uuid references tenants(id) on delete restrict,
  payment_id      uuid references platform_payments(id) on delete restrict,
  mp_payment_id   text,
  expected_cents  bigint,
  actual_cents    bigint,
  detail          jsonb not null default '{}'::jsonb,
  excluded        text,
  resolution      text check (resolution in ('imputed', 'duplicate_kept', 'refund_registered', 'chargeback_registered',
                                             'accepted', 'ignored', 'auto')),
  resolution_ref  uuid,
  resolved_by     uuid references users(id),
  resolved_at     timestamptz,
  resolve_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint platform_recon_diffs_resolution check (
    (status = 'open' and resolution is null) or (status <> 'open' and resolution is not null)
  )
);
create unique index if not exists platform_recon_diffs_open_uidx on platform_recon_diffs (diff_key) where status = 'open';
create index if not exists platform_recon_diffs_status_idx on platform_recon_diffs (status, created_at desc);
create index if not exists platform_recon_diffs_tenant_idx on platform_recon_diffs (tenant_id, created_at desc);
create index if not exists platform_recon_diffs_payment_idx on platform_recon_diffs (payment_id);
create index if not exists platform_recon_diffs_mp_idx on platform_recon_diffs (mp_payment_id);
create index if not exists platform_recon_diffs_run_idx on platform_recon_diffs (run_id);
create index if not exists platform_recon_diffs_last_run_idx on platform_recon_diffs (last_run_id);
create index if not exists platform_recon_diffs_resolved_by_idx on platform_recon_diffs (resolved_by);
drop trigger if exists set_updated_at_platform_recon_diffs on platform_recon_diffs;
create trigger set_updated_at_platform_recon_diffs
  before update on platform_recon_diffs
  for each row execute function set_updated_at();
drop trigger if exists platform_recon_diffs_no_delete on platform_recon_diffs;
create trigger platform_recon_diffs_no_delete before delete on platform_recon_diffs
  for each row execute function platform_mora_no_delete();
drop trigger if exists platform_mp_recon_runs_no_delete on platform_mp_recon_runs;
create trigger platform_mp_recon_runs_no_delete before delete on platform_mp_recon_runs
  for each row execute function platform_mora_no_delete();

-- -----------------------------------------------------------------------------
-- E) RLS: sólo staff lee; nadie escribe directo
-- -----------------------------------------------------------------------------
alter table platform_collection_notes   enable row level security;
alter table platform_plan_changes       enable row level security;
alter table platform_mp_recon_runs      enable row level security;
alter table platform_mp_payments_seen   enable row level security;
alter table platform_recon_diffs        enable row level security;

drop policy if exists platform_collection_notes_staff on platform_collection_notes;
create policy platform_collection_notes_staff on platform_collection_notes
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_plan_changes_staff on platform_plan_changes;
create policy platform_plan_changes_staff on platform_plan_changes
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_mp_recon_runs_staff on platform_mp_recon_runs;
create policy platform_mp_recon_runs_staff on platform_mp_recon_runs
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_mp_payments_seen_staff on platform_mp_payments_seen;
create policy platform_mp_payments_seen_staff on platform_mp_payments_seen
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_recon_diffs_staff on platform_recon_diffs;
create policy platform_recon_diffs_staff on platform_recon_diffs
  for select to authenticated using ((select internal_scope()));

revoke all on table platform_collection_notes, platform_plan_changes, platform_mp_recon_runs,
  platform_mp_payments_seen, platform_recon_diffs from anon;
revoke insert, update, delete, truncate on table platform_collection_notes, platform_plan_changes,
  platform_mp_recon_runs, platform_mp_payments_seen, platform_recon_diffs from authenticated;
grant select on table platform_collection_notes, platform_plan_changes, platform_mp_recon_runs,
  platform_mp_payments_seen, platform_recon_diffs to authenticated;

-- -----------------------------------------------------------------------------
-- F) Núcleo del prorrateo
-- -----------------------------------------------------------------------------
-- El único cálculo: p_cents × (10000 − descuento bp) × días que quedan /
-- (días del período × 10000), redondeado al centavo (mitad para arriba).
-- Espejo exacto de prorateCents() en lib/billing/proration.ts.
create or replace function platform_prorate_cents(p_cents bigint, p_pct_bp int, p_left int, p_days int)
returns bigint
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
           when coalesce(p_cents, 0) <= 0 or coalesce(p_left, 0) <= 0 or coalesce(p_days, 0) <= 0 then 0::bigint
           else floor((2::numeric * p_cents * (10000 - least(10000, greatest(0, coalesce(p_pct_bp, 0)))) * least(p_left, p_days)
                       + p_days::numeric * 10000) / (2::numeric * p_days * 10000))::bigint
         end
$$;

-- Descuento porcentual vigente del negocio en puntos básicos (tope 100 %).
create or replace function platform_percent_off_bp(p_tenant uuid, p_at date)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select least(10000, round(coalesce(sum(d.value), 0) * 100))::int
    from tenant_discounts d
   where d.tenant_id = p_tenant and d.deleted_at is null and d.kind = 'percent' and d.value > 0
     and d.valid_from <= p_at and (d.valid_until is null or d.valid_until >= p_at)
$$;

-- Precio del ciclo de un plan en centavos (anual = yearly o mensual × 12).
create or replace function platform_plan_cycle_cents(p_plan uuid, p_cycle text)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select platform_cents(case when p_cycle = 'yearly'
                             then coalesce(nullif(p.yearly_price_ars, 0), p.monthly_price_ars * 12)
                             else p.monthly_price_ars end)
    from plans p where p.id = p_plan
$$;

-- Desglose con un plan y un ciclo dados (null = los de la suscripción). Mismo
-- cálculo que platform_billing_breakdown de F20-1 (ADR-115), que ahora llama a
-- esta con los vigentes.
create or replace function platform_billing_breakdown_for(p_tenant uuid, p_at date, p_plan uuid, p_cycle text)
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

  select coalesce(p_cycle, s.billing_cycle), p.id, p.key, p.name,
         case when coalesce(p_cycle, s.billing_cycle) = 'yearly'
              then coalesce(nullif(p.yearly_price_ars, 0), p.monthly_price_ars * 12)
              else p.monthly_price_ars end
    into v_cycle, v_plan_id, v_plan_key, v_plan_name, v_plan_amount
    from subscriptions s
    join plans p on p.id = coalesce(p_plan, s.plan_id)
   where s.tenant_id = p_tenant;

  if v_cycle is null then
    return null;
  end if;
  v_yearly := (v_cycle = 'yearly');
  v_plan_amount := coalesce(v_plan_amount, 0);

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

create or replace function platform_billing_breakdown(p_tenant uuid, p_at date default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$ select platform_billing_breakdown_for(p_tenant, p_at, null, null) $fn$;

-- Líneas del período con un plan y un ciclo dados (null = los vigentes).
create or replace function platform_period_lines_for(p_tenant uuid, p_start date, p_plan uuid, p_cycle text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_b     jsonb := platform_billing_breakdown_for(p_tenant, p_start, p_plan, p_cycle);
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

create or replace function platform_period_lines(p_tenant uuid, p_start date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select platform_period_lines_for(p_tenant, p_start, null, null) $$;

-- ¿El período vigente tiene un cargo contra el cual prorratear? Sí si el cargo
-- existe y no está anulado, o si el período es anterior al estado de cuenta
-- (ledger_since: el cron nunca lo va a cargar, igual que en F20-1). No si el
-- cargo todavía no se generó: va a salir con el plan nuevo completo.
create or replace function platform_period_charged(p_sub uuid, p_start date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from platform_charges c
                  where c.idempotency_key = 'sub:' || p_sub::text || ':' || p_start::text || ':subscription_period'
                    and c.voided_at is null and c.status not in ('voided', 'written_off'))
      or p_start < coalesce((select ledger_since from platform_billing_settings where id), p_start)
$$;

-- Núcleo: qué pasa si el negocio cambia de plan y/o de ciclo hoy. Puro sobre
-- sus argumentos más el desglose (addons y descuentos) del negocio. Lo usan el
-- simulador, la confirmación y el trigger de cambio de plan.
--   kind:   upgrade | downgrade | lateral | cycle_up | cycle_down
--   timing: immediate | period_end (p_timing 'auto' = el default del caso)
--   effect: charge | credit | charge_and_credit | scheduled | none
create or replace function platform_proration_core(
  p_tenant     uuid,
  p_sub        uuid,
  p_from_plan  uuid,
  p_from_cycle text,
  p_to_plan    uuid,
  p_to_cycle   text,
  p_start      date,
  p_end        date,
  p_today      date,
  p_timing     text,
  p_charged    boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from_cents bigint := coalesce(platform_plan_cycle_cents(p_from_plan, p_from_cycle), 0);
  v_to_cents   bigint := coalesce(platform_plan_cycle_cents(p_to_plan, p_to_cycle), 0);
  v_from_name  text := (select name from plans where id = p_from_plan);
  v_to_name    text := (select name from plans where id = p_to_plan);
  v_pct        int := platform_percent_off_bp(p_tenant, p_today);
  v_days       int := p_end - p_start;
  v_left       int := least(p_end - p_start, p_end - p_today);
  v_kind       text;
  v_timing     text;
  v_effect     text := 'none';
  v_debit      bigint := 0;
  v_credit     bigint := 0;
  v_charge     jsonb;
  v_bonus      bigint := 0;
  v_lines      jsonb;
  v_sub_total  bigint := 0;
  v_applied    bigint;
  v_new_end    date;
  v_due_days   int;
  v_notes      text[] := '{}';
  v_line       jsonb;
begin
  v_kind := case
              when p_from_cycle is distinct from p_to_cycle and p_to_cycle = 'yearly' then 'cycle_up'
              when p_from_cycle is distinct from p_to_cycle then 'cycle_down'
              when v_to_cents > v_from_cents then 'upgrade'
              when v_to_cents < v_from_cents then 'downgrade'
              else 'lateral'
            end;
  v_timing := case
                when p_timing in ('immediate', 'period_end') then p_timing
                when v_kind in ('upgrade', 'cycle_up', 'lateral') then 'immediate'
                else 'period_end'
              end;
  if v_kind = 'lateral' then
    v_timing := 'immediate';
  end if;
  select coalesce(bt.due_days, s.due_days_default, 0) into v_due_days
    from platform_billing_settings s left join tenant_billing_terms bt on bt.tenant_id = p_tenant
   where s.id;

  if v_days <= 0 or v_left <= 0 then
    v_left := greatest(v_left, 0);
    if v_kind in ('upgrade', 'downgrade') then
      v_notes := v_notes || text 'El período vigente ya terminó: el cambio no tiene prorrateo.';
    end if;
  end if;

  if v_timing = 'period_end' then
    v_effect := 'scheduled';
    v_notes := v_notes || ('El cambio rige al fin del período, el ' || to_char(p_end, 'DD/MM/YYYY') || ', sin crédito ni débito.');
  elsif v_kind = 'upgrade' then
    if not p_charged then
      v_notes := v_notes || text 'El cargo del período vigente todavía no se generó: va a salir con el plan nuevo, sin prorrateo.';
    elsif v_left > 0 and v_days > 0 then
      v_debit := platform_prorate_cents(v_to_cents, v_pct, v_left, v_days);
      v_credit := platform_prorate_cents(v_from_cents, v_pct, v_left, v_days);
      if v_debit - v_credit > 0 then
        v_effect := 'charge';
        v_charge := jsonb_build_object(
          'kind', 'proration',
          'description', 'Diferencia por pasar a Plan ' || coalesce(v_to_name, '') || ' (' || v_left || ' de ' || v_days || ' días)',
          'period_start', p_today, 'period_end', p_end, 'due_date', p_end,
          'lines', jsonb_build_array(
            jsonb_build_object('source', 'proration_debit',
              'description', 'Plan ' || coalesce(v_to_name, '') || ' · ' || v_left || ' días', 'amount_cents', v_debit,
              'ref_id', p_to_plan),
            jsonb_build_object('source', 'proration_credit',
              'description', 'Crédito Plan ' || coalesce(v_from_name, '') || ' · ' || v_left || ' días', 'amount_cents', -v_credit,
              'ref_id', p_from_plan)),
          'total_cents', v_debit - v_credit);
        v_notes := v_notes || ('La diferencia se suma al próximo cobro: vence el ' || to_char(p_end, 'DD/MM/YYYY') || '.');
      end if;
    end if;
  elsif v_kind = 'downgrade' then
    if not p_charged then
      v_notes := v_notes || text 'El cargo del período vigente todavía no se generó: va a salir con el plan nuevo, sin crédito.';
    elsif v_left > 0 and v_days > 0 then
      v_credit := platform_prorate_cents(v_from_cents, v_pct, v_left, v_days);
      v_debit := platform_prorate_cents(v_to_cents, v_pct, v_left, v_days);
      v_bonus := greatest(v_credit - v_debit, 0);
      if v_bonus > 0 then
        v_effect := 'credit';
        v_notes := v_notes || text 'Downgrade inmediato: lo no usado queda como bonificación (cuenta para el tope del nivel).';
      end if;
    end if;
  elsif v_kind in ('cycle_up', 'cycle_down') then
    -- El período nuevo empieza hoy (§17.4).
    v_new_end := (p_today + case when p_to_cycle = 'yearly' then interval '12 months' else interval '1 month' end)::date;
    v_lines := coalesce(platform_period_lines_for(p_tenant, p_today, p_to_plan, p_to_cycle), '[]'::jsonb);
    for v_line in select * from jsonb_array_elements(v_lines) loop
      v_sub_total := v_sub_total + (v_line ->> 'amount_cents')::bigint;
    end loop;
    if p_charged and v_left > 0 and v_days > 0 then
      v_credit := platform_prorate_cents(v_from_cents, v_pct, v_left, v_days);
    end if;
    if v_kind = 'cycle_up' and v_credit > 0 then
      -- Lo no usado del ciclo viejo baja el cargo del ciclo nuevo; si lo
      -- supera, el resto queda a favor.
      v_applied := least(v_credit, greatest(v_sub_total, 0));
      if v_applied > 0 then
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'source', 'proration_credit',
          'description', 'Crédito Plan ' || coalesce(v_from_name, '') ||
                         case when p_from_cycle = 'yearly' then ' anual' else ' mensual' end || ' · ' || v_left || ' días sin usar',
          'amount_cents', -v_applied, 'ref_id', p_from_plan));
      end if;
      v_bonus := v_credit - v_applied;
    elsif v_kind = 'cycle_down' then
      v_bonus := v_credit;
    end if;
    v_charge := jsonb_build_object(
      'kind', 'subscription_period',
      'description', 'Suscripción Plan ' || coalesce(v_to_name, '') ||
                     case when p_to_cycle = 'yearly' then ' anual' else ' mensual' end || ' · ' ||
                     to_char(p_today, 'DD/MM/YYYY') || ' al ' || to_char(v_new_end - 1, 'DD/MM/YYYY') || ' (cambio de ciclo)',
      'period_start', p_today, 'period_end', v_new_end, 'due_date', p_today + coalesce(v_due_days, 0),
      'lines', v_lines,
      'total_cents', greatest(v_sub_total - coalesce(v_applied, 0), 0));
    v_effect := case when v_bonus > 0 then 'charge_and_credit' else 'charge' end;
    v_notes := v_notes || ('El período nuevo empieza hoy y termina el ' || to_char(v_new_end - 1, 'DD/MM/YYYY') || '.');
    if v_kind = 'cycle_down' and v_bonus > 0 then
      v_notes := v_notes || text 'Lo no usado del ciclo anual queda como bonificación (cuenta para el tope del nivel).';
    end if;
    if not p_charged then
      v_notes := v_notes || text 'El período vigente no tiene cargo: no hay crédito por los días sin usar.';
    end if;
  end if;

  return jsonb_build_object(
    'kind', v_kind,
    'timing', v_timing,
    'effect', v_effect,
    'period_start', p_start,
    'period_end', p_end,
    'today', p_today,
    'days', greatest(v_days, 0),
    'days_left', greatest(v_left, 0),
    'percent_bp', v_pct,
    'from', jsonb_build_object('plan_id', p_from_plan, 'plan_name', v_from_name, 'cycle', p_from_cycle, 'cycle_cents', v_from_cents),
    'to', jsonb_build_object('plan_id', p_to_plan, 'plan_name', v_to_name, 'cycle', p_to_cycle, 'cycle_cents', v_to_cents),
    'debit_cents', v_debit,
    'credit_cents', v_credit,
    'charge', v_charge,
    'charge_cents', coalesce((v_charge ->> 'total_cents')::bigint, 0),
    'bonus_cents', v_bonus,
    'new_period', case when v_kind in ('cycle_up', 'cycle_down') and v_timing = 'immediate'
                       then jsonb_build_object('start', p_today, 'end', v_new_end) end,
    'effective_on', case when v_timing = 'period_end' then p_end else p_today end,
    'charged', p_charged,
    'notes', to_jsonb(v_notes)
  );
end;
$$;

-- Cotización sobre la suscripción vigente (simulador y confirmación).
create or replace function platform_proration_quote(p_tenant uuid, p_to_plan uuid, p_to_cycle text, p_timing text, p_today date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := coalesce(p_today, platform_ar_date(now()));
  v_sub   subscriptions%rowtype;
  v_excl  text := platform_billing_exclusion(p_tenant);
  v_cycle text;
  v_start date;
  v_end   date;
  v_q     jsonb;
  v_mode  text := platform_effective_billing_mode(p_tenant);
  v_warn  text[] := '{}';
begin
  select * into v_sub from subscriptions where tenant_id = p_tenant;
  if not found then
    raise exception 'subscription_not_found' using errcode = 'P0002';
  end if;
  v_cycle := coalesce(p_to_cycle, v_sub.billing_cycle);
  if v_cycle not in ('monthly', 'yearly') then
    raise exception 'invalid_cycle' using errcode = '22023';
  end if;
  if not exists (select 1 from plans p where p.id = coalesce(p_to_plan, v_sub.plan_id)
                  and p.is_active and (p.tenant_id is null or p.tenant_id = p_tenant)) then
    raise exception 'plan_not_found' using errcode = 'P0002';
  end if;
  if coalesce(p_to_plan, v_sub.plan_id) = v_sub.plan_id and v_cycle = v_sub.billing_cycle then
    raise exception 'no_change' using errcode = '22023';
  end if;
  if p_timing is not null and p_timing not in ('auto', 'immediate', 'period_end') then
    raise exception 'invalid_timing' using errcode = '22023';
  end if;

  v_start := coalesce(platform_period_date(v_sub.current_period_start), v_today);
  v_end := coalesce(platform_period_date(v_sub.current_period_end), v_today);

  v_q := platform_proration_core(p_tenant, v_sub.id, v_sub.plan_id, v_sub.billing_cycle,
                                 coalesce(p_to_plan, v_sub.plan_id), v_cycle,
                                 v_start, v_end, v_today, coalesce(p_timing, 'auto'),
                                 platform_period_charged(v_sub.id, v_start));

  -- Sin cobro: prueba, negocios excluidos o suscripción sin período vigente.
  if v_excl is not null or v_sub.status not in ('active', 'past_due') or v_sub.current_period_end is null then
    v_q := v_q || jsonb_build_object(
      'effect', case when (v_q ->> 'timing') = 'period_end' then 'scheduled' else 'none' end,
      'charge', null, 'charge_cents', 0, 'bonus_cents', 0, 'debit_cents', 0, 'credit_cents', 0,
      'new_period', null,
      'notes', to_jsonb(array[case when v_excl is not null then 'Negocio que no se cobra (' || v_excl || '): el cambio no genera cargos.'
                                   else 'La suscripción no está paga (' || v_sub.status || '): el cambio no genera cargos.' end]));
  end if;

  if v_mode = 'mp_subscription' then
    if (v_q ->> 'kind') in ('cycle_up', 'cycle_down') then
      v_warn := v_warn || text 'Con débito automático, cambiar el ciclo necesita un débito nuevo: generá el link desde Modalidad y cobro.';
    else
      v_warn := v_warn || text 'Con débito automático, el monto del débito se actualiza para los próximos períodos.';
    end if;
  end if;

  return v_q || jsonb_build_object(
    'tenant_id', p_tenant,
    'subscription_id', v_sub.id,
    'subscription_status', v_sub.status,
    'billing_mode', v_mode,
    'exclusion', v_excl,
    'warnings', to_jsonb(v_warn),
    'scheduled', (select jsonb_build_object('id', c.id, 'effective_on', c.effective_on, 'kind', c.kind)
                    from platform_plan_changes c where c.tenant_id = p_tenant and c.status = 'scheduled'));
end;
$$;

-- Trigger de cambio de plan (F20-1) sobre el núcleo: mismo importe y misma
-- clave de cargo para el upgrade del mismo ciclo. Lo que hace el RPC del
-- panel (app.platform_proration = 'manual') no se vuelve a prorratear acá.
-- Nunca bloquea el cambio de plan: si falla, queda auditado.
create or replace function trg_subscriptions_proration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := platform_ar_date(now());
  v_start date;
  v_end   date;
  v_q     jsonb;
  v_id    uuid;
begin
  if new.plan_id is not distinct from old.plan_id then
    return null;
  end if;
  if coalesce(current_setting('app.platform_proration', true), '') = 'manual' then
    return null;
  end if;
  begin
    -- El cambio de ciclo sólo se hace con internal_billing_plan_change.
    if new.status not in ('active', 'past_due')
       or new.billing_cycle is distinct from old.billing_cycle
       or new.current_period_start is null
       or new.current_period_end is null
       or new.current_period_end <= now()
       or platform_billing_exclusion(new.tenant_id) is not null then
      return null;
    end if;

    v_start := platform_period_date(new.current_period_start);
    v_end := platform_period_date(new.current_period_end);
    v_q := platform_proration_core(new.tenant_id, new.id, old.plan_id, new.billing_cycle, new.plan_id, new.billing_cycle,
                                   v_start, v_end, v_today, 'immediate', platform_period_charged(new.id, v_start));
    -- Sólo el upgrade genera cargo; el downgrade de siempre rige por precio al
    -- próximo período (sin crédito).
    if (v_q ->> 'kind') = 'upgrade' and (v_q ->> 'effect') = 'charge' then
      v_id := platform_create_charge(
        new.tenant_id, new.id, 'proration',
        v_q #>> '{charge,description}', v_today, v_end, v_end,
        v_q #> '{charge,lines}',
        'prorate:' || new.id::text || ':' || v_start::text || ':' || new.plan_id::text,
        auth.uid(), 'plan_change', null);
    end if;
    insert into platform_plan_changes (tenant_id, subscription_id, kind, from_plan_id, to_plan_id, from_cycle, to_cycle,
                                       timing, status, effective_on, quote, charge_id, charge_cents, source, created_by, applied_at)
    values (new.tenant_id, new.id, v_q ->> 'kind', old.plan_id, new.plan_id, new.billing_cycle, new.billing_cycle,
            case when (v_q ->> 'kind') = 'downgrade' then 'period_end' else 'immediate' end,
            'applied', v_today, v_q, v_id, case when v_id is null then 0 else (v_q ->> 'charge_cents')::bigint end,
            'trigger', auth.uid(), now());
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

-- Addon a mitad de período (§17.4): cargo por los días que quedan hasta el fin
-- del período del plan, que vence con el próximo cobro. Sólo addons pagos; si
-- el cargo del período vigente todavía no se generó, lo incluye entero (sin
-- prorrateo, para no cobrar doble). Nunca bloquea el alta.
create or replace function trg_subscription_addons_proration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub    subscriptions%rowtype;
  v_today  date := platform_ar_date(now());
  v_start  date;
  v_end    date;
  v_days   int;
  v_left   int;
  v_price  numeric;
  v_mult   int;
  v_pct    int;
  v_cents  bigint;
  v_label  text;
  v_id     uuid;
begin
  if new.status <> 'active' or coalesce(new.source, '') = 'granted' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = 'active' then
    return null;
  end if;
  -- Reactivación dentro de la ventana paga de una baja programada: ya estaba
  -- en el cargo del período.
  if tg_op = 'UPDATE' and coalesce(old.cancel_at_period_end, false) and old.current_period_end is not null
     and old.current_period_end::date >= v_today then
    return null;
  end if;
  begin
    select * into v_sub from subscriptions where tenant_id = new.tenant_id;
    if not found or v_sub.status not in ('active', 'past_due') or v_sub.current_period_start is null
       or v_sub.current_period_end is null or v_sub.current_period_end <= now()
       or platform_billing_exclusion(new.tenant_id) is not null then
      return null;
    end if;
    v_start := platform_period_date(v_sub.current_period_start);
    v_end := platform_period_date(v_sub.current_period_end);
    if not exists (select 1 from platform_charges c
                    where c.idempotency_key = 'sub:' || v_sub.id::text || ':' || v_start::text || ':subscription_period'
                      and c.voided_at is null) then
      return null;
    end if;
    v_days := v_end - v_start;
    v_left := least(v_days, v_end - v_today);
    if v_days <= 0 or v_left <= 0 then
      return null;
    end if;
    select coalesce(new.monthly_price_ars, pa.monthly_price_ars, 0), coalesce(pa.label, new.addon_key)
      into v_price, v_label
      from (select 1) x left join plan_addons pa on pa.key = new.addon_key;
    v_mult := case when v_sub.billing_cycle = 'yearly' then 12 else 1 end;
    v_pct := platform_percent_off_bp(new.tenant_id, v_today);
    v_cents := platform_prorate_cents(platform_cents(coalesce(v_price, 0) * v_mult), v_pct, v_left, v_days);
    if v_cents <= 0 then
      return null;
    end if;
    v_id := platform_create_charge(
      new.tenant_id, v_sub.id, 'addon',
      coalesce(v_label, new.addon_key) || ' hasta el fin del período (' || v_left || ' de ' || v_days || ' días)',
      v_today, v_end, v_end,
      jsonb_build_array(jsonb_build_object('source', 'proration_debit',
        'description', coalesce(v_label, new.addon_key) || ' · ' || v_left || ' días', 'amount_cents', v_cents)),
      'addon:' || new.id::text || ':' || v_start::text, auth.uid(), 'plan_change', null);
    insert into platform_plan_changes (tenant_id, subscription_id, kind, from_plan_id, to_plan_id, from_cycle, to_cycle, addon_key,
                                       timing, status, effective_on, quote, charge_id, charge_cents, source, created_by, applied_at)
    values (new.tenant_id, v_sub.id, 'addon_add', v_sub.plan_id, v_sub.plan_id, v_sub.billing_cycle, v_sub.billing_cycle, new.addon_key,
            'immediate', 'applied', v_today,
            jsonb_build_object('days', v_days, 'days_left', v_left, 'percent_bp', v_pct, 'charge_cents', v_cents,
                               'period_start', v_start, 'period_end', v_end),
            v_id, v_cents, 'trigger', auth.uid(), now());
  exception when others then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, null, 'platform_charge', new.id, 'platform_proration_failed',
            jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate, 'addon', new.addon_key));
  end;
  return null;
end;
$$;
drop trigger if exists subscription_addons_proration on subscription_addons;
create trigger subscription_addons_proration after insert or update of status on subscription_addons
  for each row execute function trg_subscription_addons_proration();

-- Simulador del panel interno: no escribe nada.
create or replace function internal_billing_proration_preview(p_tenant uuid, p_plan uuid, p_cycle text, p_timing text default 'auto')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform platform_assert_billing_can('view');
  return platform_proration_quote(p_tenant, p_plan, p_cycle, p_timing, null);
end;
$$;

-- Confirmación del cambio. admin o super_admin (cambiar el plan es
-- administrar el negocio). p_expected = {charge_cents, bonus_cents} de lo que
-- vio el staff en el simulador: si cambió, no aplica (quote_changed).
create or replace function internal_billing_plan_change(
  p_tenant     uuid,
  p_plan       uuid,
  p_cycle      text,
  p_timing     text,
  p_reason     text,
  p_request_id uuid,
  p_expected   jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role    text := platform_staff_billing_role();
  v_reason  text := platform_assert_reason(p_reason);
  v_q       jsonb;
  v_sub     subscriptions%rowtype;
  v_change  uuid;
  v_charge  uuid;
  v_bonus   uuid;
  v_key     text;
  v_today   date := platform_ar_date(now());
  v_ns      timestamptz;
  v_ne      timestamptz;
  v_before  bigint;
  v_kind    text;
begin
  if v_role is null or v_role not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;
  select id into v_change from platform_plan_changes where request_id = p_request_id;
  if v_change is not null then
    return (select jsonb_build_object('id', c.id, 'status', c.status, 'charge_id', c.charge_id,
                                      'credit_movement_id', c.credit_movement_id, 'replayed', true)
              from platform_plan_changes c where c.id = v_change);
  end if;

  perform platform_lock_tenant(p_tenant);
  v_q := platform_proration_quote(p_tenant, p_plan, p_cycle, p_timing, v_today);
  if p_expected is not null
     and ((p_expected ? 'charge_cents' and (p_expected ->> 'charge_cents')::bigint is distinct from (v_q ->> 'charge_cents')::bigint)
       or (p_expected ? 'bonus_cents' and (p_expected ->> 'bonus_cents')::bigint is distinct from (v_q ->> 'bonus_cents')::bigint)
       or (p_expected ? 'timing' and p_expected ->> 'timing' is distinct from v_q ->> 'timing')) then
    raise exception 'quote_changed' using errcode = '40001';
  end if;
  select * into v_sub from subscriptions where tenant_id = p_tenant for update;
  v_kind := v_q ->> 'kind';
  v_before := platform_tenant_balance(p_tenant);

  if (v_q ->> 'timing') = 'period_end' then
    -- Uno programado por negocio: el nuevo reemplaza al anterior.
    update platform_plan_changes
       set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = 'Reemplazado por otro cambio programado'
     where tenant_id = p_tenant and status = 'scheduled';
    insert into platform_plan_changes (tenant_id, subscription_id, kind, from_plan_id, to_plan_id, from_cycle, to_cycle,
                                       timing, status, effective_on, quote, source, request_id, reason, created_by)
    values (p_tenant, v_sub.id, v_kind, v_sub.plan_id, coalesce(p_plan, v_sub.plan_id), v_sub.billing_cycle,
            coalesce(p_cycle, v_sub.billing_cycle), 'period_end', 'scheduled', (v_q ->> 'effective_on')::date, v_q,
            'staff', p_request_id, v_reason, auth.uid())
    returning id into v_change;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
    values (p_tenant, auth.uid(), 'platform_plan_change', v_change, 'platform_plan_change_scheduled',
            jsonb_build_object('plan_id', v_sub.plan_id, 'cycle', v_sub.billing_cycle),
            jsonb_build_object('plan_id', coalesce(p_plan, v_sub.plan_id), 'cycle', coalesce(p_cycle, v_sub.billing_cycle),
                               'kind', v_kind, 'effective_on', v_q ->> 'effective_on', 'role', v_role),
            v_reason);
    return jsonb_build_object('id', v_change, 'status', 'scheduled', 'effective_on', v_q ->> 'effective_on', 'quote', v_q);
  end if;

  -- Inmediato: el plan y el ciclo cambian ya; el trigger de F20-1 no vuelve a
  -- prorratear lo que hace este RPC.
  perform set_config('app.platform_proration', 'manual', true);
  if v_q -> 'new_period' is not null and jsonb_typeof(v_q -> 'new_period') = 'object' then
    v_ns := ((v_q #>> '{new_period,start}')::date::timestamp + interval '12 hours') at time zone 'America/Argentina/Buenos_Aires';
    v_ne := ((v_q #>> '{new_period,end}')::date::timestamp + interval '12 hours') at time zone 'America/Argentina/Buenos_Aires';
  end if;
  update subscriptions
     set plan_id = coalesce(p_plan, plan_id),
         billing_cycle = coalesce(p_cycle, billing_cycle),
         current_period_start = coalesce(v_ns, current_period_start),
         current_period_end = coalesce(v_ne, current_period_end),
         updated_at = now()
   where id = v_sub.id;
  perform set_config('app.platform_proration', '', true);

  insert into platform_plan_changes (tenant_id, subscription_id, kind, from_plan_id, to_plan_id, from_cycle, to_cycle,
                                     timing, status, effective_on, quote, source, request_id, reason, created_by, applied_at)
  values (p_tenant, v_sub.id, v_kind, v_sub.plan_id, coalesce(p_plan, v_sub.plan_id), v_sub.billing_cycle,
          coalesce(p_cycle, v_sub.billing_cycle), 'immediate', 'applied', v_today, v_q, 'staff', p_request_id, v_reason,
          auth.uid(), now())
  returning id into v_change;

  if (v_q ->> 'charge_cents')::bigint > 0 and v_q -> 'charge' is not null and jsonb_typeof(v_q -> 'charge') = 'object' then
    if (v_q #>> '{charge,kind}') = 'subscription_period' then
      v_key := 'sub:' || v_sub.id::text || ':' || (v_q #>> '{charge,period_start}') || ':subscription_period';
      if exists (select 1 from platform_charges where idempotency_key = v_key) then
        v_key := v_key || ':c:' || v_change::text;
      end if;
    else
      v_key := 'prorate:' || v_sub.id::text || ':' || (v_q ->> 'period_start') || ':' || coalesce(p_plan, v_sub.plan_id)::text ||
               ':' || v_change::text;
    end if;
    v_charge := platform_create_charge(
      p_tenant, v_sub.id, v_q #>> '{charge,kind}', v_q #>> '{charge,description}',
      (v_q #>> '{charge,period_start}')::date, (v_q #>> '{charge,period_end}')::date, (v_q #>> '{charge,due_date}')::date,
      v_q #> '{charge,lines}', v_key, auth.uid(), 'plan_change', v_reason);
  end if;

  if (v_q ->> 'bonus_cents')::bigint > 0 then
    -- Lo no usado de un downgrade inmediato es una bonificación: tope del nivel.
    perform platform_assert_forgiveness_cap(p_tenant, (v_q ->> 'bonus_cents')::bigint);
    v_bonus := platform_post_movement(p_tenant, 'bonus_credit', -(v_q ->> 'bonus_cents')::bigint, v_today, null,
                                      'Crédito por cambio a Plan ' || coalesce(v_q #>> '{to,plan_name}', '') ||
                                        case when (v_q #>> '{to,cycle}') = 'yearly' then ' anual' else ' mensual' end,
                                      v_reason, null, null, null, 'planchg:' || v_change::text, auth.uid());
    perform platform_auto_allocate(p_tenant, auth.uid());
  end if;

  update platform_plan_changes
     set charge_id = v_charge, credit_movement_id = v_bonus,
         charge_cents = coalesce((select total_cents from platform_charges where id = v_charge), 0),
         credit_cents = coalesce((v_q ->> 'bonus_cents')::bigint, 0)
   where id = v_change;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, auth.uid(), 'platform_plan_change', v_change, 'platform_plan_changed',
          jsonb_build_object('plan_id', v_sub.plan_id, 'cycle', v_sub.billing_cycle, 'balance_cents', v_before,
                             'period_start', v_sub.current_period_start, 'period_end', v_sub.current_period_end),
          jsonb_build_object('plan_id', coalesce(p_plan, v_sub.plan_id), 'cycle', coalesce(p_cycle, v_sub.billing_cycle),
                             'kind', v_kind, 'charge_id', v_charge, 'charge_cents', coalesce((v_q ->> 'charge_cents')::bigint, 0),
                             'bonus_cents', coalesce((v_q ->> 'bonus_cents')::bigint, 0),
                             'balance_cents', platform_tenant_balance(p_tenant), 'role', v_role),
          v_reason);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (p_tenant, auth.uid(), 'subscriptions', p_tenant, 'plan_changed',
          jsonb_build_object('plan', (select key from plans where id = coalesce(p_plan, v_sub.plan_id)),
                             'cycle', coalesce(p_cycle, v_sub.billing_cycle), 'source', 'cobranza_360'),
          v_reason);

  return jsonb_build_object('id', v_change, 'status', 'applied', 'charge_id', v_charge, 'credit_movement_id', v_bonus,
                            'quote', v_q,
                            'mp_amount_sync', platform_effective_billing_mode(p_tenant) = 'mp_subscription');
end;
$$;

create or replace function internal_billing_plan_change_cancel(p_change uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := platform_staff_billing_role();
  v_reason text := platform_assert_reason(p_reason);
  v_c      platform_plan_changes%rowtype;
begin
  if v_role is null or v_role not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_c from platform_plan_changes where id = p_change for update;
  if not found then
    raise exception 'change_not_found' using errcode = 'P0002';
  end if;
  if v_c.status <> 'scheduled' then
    raise exception 'change_not_scheduled' using errcode = '22023';
  end if;
  update platform_plan_changes
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_reason
   where id = p_change;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_c.tenant_id, auth.uid(), 'platform_plan_change', p_change, 'platform_plan_change_cancelled',
          jsonb_build_object('status', 'scheduled', 'effective_on', v_c.effective_on),
          jsonb_build_object('status', 'cancelled', 'role', v_role), v_reason);
end;
$$;

-- Cron: aplica los cambios programados que llegaron a su fecha (antes de que
-- platform-billing-run genere el cargo del período nuevo). Idempotente.
create or replace function platform_plan_changes_run(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today   date := platform_ar_date(p_now);
  r         record;
  v_applied int := 0;
  v_skipped int := 0;
begin
  for r in
    select c.*, s.plan_id as cur_plan, s.billing_cycle as cur_cycle, s.id as cur_sub
      from platform_plan_changes c
      join subscriptions s on s.tenant_id = c.tenant_id
     where c.status = 'scheduled' and c.effective_on <= v_today
     order by c.effective_on, c.created_at
  loop
    begin
      perform platform_lock_tenant(r.tenant_id);
      if r.cur_plan is distinct from r.from_plan_id or r.cur_cycle is distinct from r.from_cycle then
        update platform_plan_changes
           set status = 'cancelled', cancelled_at = now(), cancel_reason = 'La suscripción cambió antes de la fecha programada'
         where id = r.id;
        v_skipped := v_skipped + 1;
        continue;
      end if;
      perform set_config('app.platform_proration', 'manual', true);
      update subscriptions
         set plan_id = coalesce(r.to_plan_id, plan_id), billing_cycle = coalesce(r.to_cycle, billing_cycle), updated_at = now()
       where id = r.cur_sub;
      perform set_config('app.platform_proration', '', true);
      update platform_plan_changes set status = 'applied', applied_at = now() where id = r.id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (r.tenant_id, null, 'platform_plan_change', r.id, 'platform_plan_change_applied',
              jsonb_build_object('plan_id', r.to_plan_id, 'cycle', r.to_cycle, 'kind', r.kind, 'effective_on', r.effective_on));
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (r.tenant_id, null, 'subscriptions', r.tenant_id, 'plan_changed',
              jsonb_build_object('plan', (select key from plans where id = r.to_plan_id), 'cycle', r.to_cycle,
                                 'source', 'cobranza_360_programado'));
      v_applied := v_applied + 1;
    exception when others then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (r.tenant_id, null, 'platform_plan_change', r.id, 'platform_plan_change_failed',
              jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate));
    end;
  end loop;
  return jsonb_build_object('applied', v_applied, 'cancelled', v_skipped, 'today', v_today);
end;
$$;

-- -----------------------------------------------------------------------------
-- G) Conciliación: entrada de la Edge (service_role) y bandeja (staff)
-- -----------------------------------------------------------------------------
create or replace function platform_recon_begin(p_source text, p_from timestamptz, p_to timestamptz, p_actor uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_source not in ('cron', 'manual') or p_from is null or p_to is null or p_to <= p_from then
    raise exception 'invalid_window' using errcode = '22023';
  end if;
  -- Una corrida a la vez (una colgada más de 15 minutos se da por caída).
  update platform_mp_recon_runs
     set status = 'error', finished_at = now(), message = coalesce(message, 'Corrida interrumpida')
   where status = 'running' and started_at < now() - interval '15 minutes';
  if exists (select 1 from platform_mp_recon_runs where status = 'running') then
    raise exception 'recon_running' using errcode = '55P03';
  end if;
  insert into platform_mp_recon_runs (source, window_from, window_to, started_by)
  values (p_source, p_from, p_to, p_actor)
  returning id into v_id;
  return v_id;
end;
$$;

-- Insumos locales para la comparación: pagos de la ventana (con margen para
-- los duplicados del mismo período) y las suscripciones para ubicar al negocio
-- de un pago de MP (external_reference = id de la suscripción, preapproval).
create or replace function platform_recon_inputs(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'settings', (select jsonb_build_object('window_hours', s.recon_window_hours, 'tolerance_cents', s.recon_tolerance_cents)
                   from platform_billing_settings s where s.id),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'tenant_id', p.tenant_id, 'method', p.method, 'status', p.status,
               'amount_cents', p.amount_cents, 'fee_cents', p.fee_cents, 'net_cents', p.net_cents,
               'paid_at', p.paid_at, 'provider', p.provider, 'external_id', p.external_id,
               'period_start', p.period_start,
               'refunded_cents', coalesce((select sum(l.amount_cents) from platform_ledger l
                                            where l.payment_id = p.id and l.kind in ('refund', 'payment_reversal')), 0))
               order by p.paid_at)
        from platform_payments p
       where p.paid_at >= p_from - interval '35 days' and p.paid_at <= p_to + interval '1 day'), '[]'::jsonb),
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'tenant_id', s.tenant_id, 'preapproval_id', s.mp_preapproval_id,
               'tenant_name', t.name, 'excluded', platform_billing_exclusion(s.tenant_id)))
        from subscriptions s join tenants t on t.id = s.tenant_id), '[]'::jsonb),
    'seen', coalesce((
      select jsonb_agg(jsonb_build_object('mp_payment_id', m.mp_payment_id, 'payment_id', m.payment_id, 'tenant_id', m.tenant_id))
        from platform_mp_payments_seen m
       where m.date_created >= p_from - interval '35 days'), '[]'::jsonb)
  )
$$;

-- Cierre de la corrida. p_result:
--   { mp_payments: [{mp_payment_id, status, status_detail, operation_type, amount_cents, refunded_cents,
--                    fee_cents, net_cents, date_created, date_approved, date_last_updated,
--                    external_reference, preapproval_id, description, tenant_id, payment_id, match_kind}],
--     diffs: [{key, kind, severity, tenant_id, payment_id, mp_payment_id, expected_cents, actual_cents, detail}],
--     fees: [{payment_id, fee_cents, net_cents}],
--     matched: n, local_count: n, scope_mp_ids: [...], scope_payment_ids: [...] }
-- Las diferencias abiertas que caen dentro de lo revisado y no volvieron a
-- aparecer se cierran solas (auto_resolved).
create or replace function platform_recon_finish(p_run uuid, p_status text, p_message text, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run    platform_mp_recon_runs%rowtype;
  v_r      jsonb := coalesce(p_result, '{}'::jsonb);
  v_m      jsonb;
  v_d      jsonb;
  v_f      jsonb;
  v_keys   text[] := '{}';
  v_new    int := 0;
  v_closed int := 0;
  v_fees   int := 0;
  v_tenant uuid;
  v_pay    uuid;
  v_n      int;
  v_ins    boolean;
begin
  select * into v_run from platform_mp_recon_runs where id = p_run for update;
  if not found then
    raise exception 'run_not_found' using errcode = 'P0002';
  end if;
  if v_run.status <> 'running' then
    raise exception 'run_finished' using errcode = '22023';
  end if;
  if p_status not in ('ok', 'degraded', 'error') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  for v_m in select * from jsonb_array_elements(coalesce(v_r -> 'mp_payments', '[]'::jsonb)) loop
    v_tenant := nullif(v_m ->> 'tenant_id', '')::uuid;
    v_pay := nullif(v_m ->> 'payment_id', '')::uuid;
    if v_tenant is not null and not exists (select 1 from tenants where id = v_tenant) then v_tenant := null; end if;
    if v_pay is not null and not exists (select 1 from platform_payments where id = v_pay) then v_pay := null; end if;
    insert into platform_mp_payments_seen (mp_payment_id, status, status_detail, operation_type, amount_cents, refunded_cents,
                                           fee_cents, net_cents, date_created, date_approved, date_last_updated,
                                           external_reference, preapproval_id, description, tenant_id, payment_id,
                                           match_kind, last_run_id)
    values (v_m ->> 'mp_payment_id', coalesce(v_m ->> 'status', 'unknown'), v_m ->> 'status_detail', v_m ->> 'operation_type',
            coalesce((v_m ->> 'amount_cents')::bigint, 0), coalesce((v_m ->> 'refunded_cents')::bigint, 0),
            (v_m ->> 'fee_cents')::bigint, (v_m ->> 'net_cents')::bigint,
            (v_m ->> 'date_created')::timestamptz, (v_m ->> 'date_approved')::timestamptz, (v_m ->> 'date_last_updated')::timestamptz,
            left(v_m ->> 'external_reference', 200), left(v_m ->> 'preapproval_id', 120), left(v_m ->> 'description', 200),
            v_tenant, v_pay, nullif(v_m ->> 'match_kind', ''), p_run)
    on conflict (mp_payment_id) do update
       set status = excluded.status, status_detail = excluded.status_detail, operation_type = excluded.operation_type,
           amount_cents = excluded.amount_cents, refunded_cents = excluded.refunded_cents,
           fee_cents = excluded.fee_cents, net_cents = excluded.net_cents,
           date_approved = excluded.date_approved, date_last_updated = excluded.date_last_updated,
           external_reference = excluded.external_reference, preapproval_id = excluded.preapproval_id,
           description = excluded.description,
           tenant_id = coalesce(excluded.tenant_id, platform_mp_payments_seen.tenant_id),
           payment_id = coalesce(excluded.payment_id, platform_mp_payments_seen.payment_id),
           match_kind = coalesce(excluded.match_kind, platform_mp_payments_seen.match_kind),
           last_run_id = p_run, updated_at = now();
  end loop;

  for v_d in select * from jsonb_array_elements(coalesce(v_r -> 'diffs', '[]'::jsonb)) loop
    continue when coalesce(v_d ->> 'key', '') = '' or coalesce(v_d ->> 'kind', '') = '';
    v_keys := v_keys || (v_d ->> 'key');
    v_tenant := nullif(v_d ->> 'tenant_id', '')::uuid;
    v_pay := nullif(v_d ->> 'payment_id', '')::uuid;
    if v_tenant is not null and not exists (select 1 from tenants where id = v_tenant) then v_tenant := null; end if;
    if v_pay is not null and not exists (select 1 from platform_payments where id = v_pay) then v_pay := null; end if;
    -- Una diferencia ya resuelta o ignorada con la misma clave no se reabre.
    continue when exists (select 1 from platform_recon_diffs x where x.diff_key = v_d ->> 'key' and x.status in ('resolved', 'ignored'));
    insert into platform_recon_diffs (run_id, last_run_id, diff_key, kind, severity, tenant_id, payment_id, mp_payment_id,
                                      expected_cents, actual_cents, detail, excluded)
    values (p_run, p_run, v_d ->> 'key', v_d ->> 'kind', coalesce(v_d ->> 'severity', 'medium'), v_tenant, v_pay,
            nullif(v_d ->> 'mp_payment_id', ''), (v_d ->> 'expected_cents')::bigint, (v_d ->> 'actual_cents')::bigint,
            coalesce(v_d -> 'detail', '{}'::jsonb),
            case when v_tenant is not null then platform_billing_exclusion(v_tenant) end)
    on conflict (diff_key) where status = 'open' do update
       set last_run_id = p_run, detail = excluded.detail, expected_cents = excluded.expected_cents,
           actual_cents = excluded.actual_cents, severity = excluded.severity,
           tenant_id = coalesce(excluded.tenant_id, platform_recon_diffs.tenant_id),
           payment_id = coalesce(excluded.payment_id, platform_recon_diffs.payment_id)
    returning (xmax = 0) into v_ins;
    if coalesce(v_ins, false) then
      v_new := v_new + 1;
    end if;
  end loop;

  -- Cierre automático: lo revisado en esta corrida que ya no difiere.
  if p_status = 'ok' then
    update platform_recon_diffs d
       set status = 'auto_resolved', resolution = 'auto', resolved_at = now(),
           resolve_reason = 'Ya no aparece en la conciliación'
     where d.status = 'open'
       and not (d.diff_key = any(v_keys))
       and ((d.mp_payment_id is not null and d.mp_payment_id in (select jsonb_array_elements_text(coalesce(v_r -> 'scope_mp_ids', '[]'::jsonb))))
         or (d.payment_id is not null and d.payment_id::text in (select jsonb_array_elements_text(coalesce(v_r -> 'scope_payment_ids', '[]'::jsonb)))));
    get diagnostics v_closed = row_count;
  end if;

  -- Comisiones y neto de MP en los pagos locales (los usan los KPI y F21).
  for v_f in select * from jsonb_array_elements(coalesce(v_r -> 'fees', '[]'::jsonb)) loop
    update platform_payments p
       set fee_cents = (v_f ->> 'fee_cents')::bigint, net_cents = (v_f ->> 'net_cents')::bigint
     where p.id = nullif(v_f ->> 'payment_id', '')::uuid
       and (v_f ->> 'fee_cents') is not null
       and (p.fee_cents is distinct from (v_f ->> 'fee_cents')::bigint or p.net_cents is distinct from (v_f ->> 'net_cents')::bigint);
    get diagnostics v_n = row_count;
    v_fees := v_fees + v_n;
  end loop;

  update platform_mp_recon_runs
     set status = p_status, message = left(p_message, 500), finished_at = now(),
         mp_count = jsonb_array_length(coalesce(v_r -> 'mp_payments', '[]'::jsonb)),
         local_count = coalesce((v_r ->> 'local_count')::int, 0),
         matched = coalesce((v_r ->> 'matched')::int, 0),
         diffs_new = v_new, diffs_closed = v_closed, fees_updated = v_fees
   where id = p_run;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (null, v_run.started_by, 'platform_recon', p_run, 'platform_recon_run',
          jsonb_build_object('status', p_status, 'source', v_run.source, 'diffs_new', v_new, 'diffs_closed', v_closed,
                             'fees_updated', v_fees, 'message', left(p_message, 200)));
  return jsonb_build_object('run_id', p_run, 'status', p_status, 'diffs_new', v_new, 'diffs_closed', v_closed, 'fees_updated', v_fees);
end;
$$;

-- Bandeja de conciliación (staff con 'view').
create or replace function internal_recon_overview(p_status text default 'open')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_set platform_billing_settings%rowtype;
begin
  perform platform_assert_billing_can('view');
  select * into v_set from platform_billing_settings where id;
  return jsonb_build_object(
    'credentials', exists (select 1 from platform_secrets s
                            where s.key = 'mercadopago' and length(coalesce(s.secrets ->> 'access_token', '')) > 10),
    'settings', jsonb_build_object('window_hours', v_set.recon_window_hours, 'tolerance_cents', v_set.recon_tolerance_cents),
    'can_manage', platform_billing_can('manage'),
    'can_configure', platform_staff_billing_role() = 'super_admin',
    'runs', coalesce((select jsonb_agg(to_jsonb(r) - 'started_by' || jsonb_build_object(
                                 'started_by_name', (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = r.started_by))
                               order by r.started_at desc)
                        from (select * from platform_mp_recon_runs order by started_at desc limit 15) r), '[]'::jsonb),
    'counts', coalesce((select jsonb_object_agg(x.kind, x.n)
                          from (select d.kind, count(*) as n from platform_recon_diffs d where d.status = 'open' group by d.kind) x),
                       '{}'::jsonb),
    'diffs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'kind', d.kind, 'severity', d.severity, 'status', d.status, 'diff_key', d.diff_key,
               'tenant_id', d.tenant_id, 'tenant_name', t.name, 'payment_id', d.payment_id, 'mp_payment_id', d.mp_payment_id,
               'expected_cents', d.expected_cents, 'actual_cents', d.actual_cents, 'detail', d.detail, 'excluded', d.excluded,
               'resolution', d.resolution, 'resolve_reason', d.resolve_reason, 'resolved_at', d.resolved_at,
               'resolved_by_name', (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = d.resolved_by),
               'created_at', d.created_at, 'updated_at', d.updated_at,
               'payment', case when p.id is null then null else jsonb_build_object(
                             'status', p.status, 'amount_cents', p.amount_cents, 'paid_at', p.paid_at, 'method', p.method,
                             'external_id', p.external_id) end,
               'mp', case when m.mp_payment_id is null then null else jsonb_build_object(
                        'status', m.status, 'status_detail', m.status_detail, 'amount_cents', m.amount_cents,
                        'refunded_cents', m.refunded_cents, 'fee_cents', m.fee_cents, 'date_approved', m.date_approved,
                        'date_created', m.date_created, 'description', m.description) end)
               order by case d.severity when 'high' then 0 when 'medium' then 1 else 2 end, d.created_at desc)
        from (select * from platform_recon_diffs
               where (p_status = 'all' or status = coalesce(p_status, 'open')
                      or (p_status = 'closed' and status <> 'open'))
               order by created_at desc limit 300) d
        left join tenants t on t.id = d.tenant_id
        left join platform_payments p on p.id = d.payment_id
        left join platform_mp_payments_seen m on m.mp_payment_id = d.mp_payment_id), '[]'::jsonb),
    'tenants', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name)
        from tenants t where t.deleted_at is null and platform_billing_exclusion(t.id) is null), '[]'::jsonb)
  );
end;
$$;

-- Configuración de la conciliación (super_admin).
create or replace function internal_recon_set_settings(p_window_hours int, p_tolerance_cents bigint, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
begin
  if platform_staff_billing_role() is distinct from 'super_admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_window_hours is null or p_window_hours < 24 or p_window_hours > 720
     or p_tolerance_cents is null or p_tolerance_cents < 0 or p_tolerance_cents > 1000000 then
    raise exception 'invalid_settings' using errcode = '22023';
  end if;
  select jsonb_build_object('window_hours', recon_window_hours, 'tolerance_cents', recon_tolerance_cents)
    into v_before from platform_billing_settings where id;
  update platform_billing_settings
     set recon_window_hours = p_window_hours, recon_tolerance_cents = p_tolerance_cents, updated_at = now(), updated_by = auth.uid()
   where id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (null, auth.uid(), 'platform_billing_settings', null, 'platform_recon_settings_set', v_before,
          jsonb_build_object('window_hours', p_window_hours, 'tolerance_cents', p_tolerance_cents), v_reason);
end;
$$;

-- Reintegro parcial de un pago (MP devolvió una parte): debe compensatorio por
-- lo devuelto, sin liberar las imputaciones (el negocio vuelve a deber esa
-- parte). Idempotente por (pago, total devuelto).
create or replace function platform_register_partial_refund(p_payment uuid, p_refunded_cents bigint, p_reason text, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay    platform_payments%rowtype;
  v_credit uuid;
  v_done   bigint;
  v_delta  bigint;
  v_mov    uuid;
begin
  select * into v_pay from platform_payments where id = p_payment for update;
  if not found then
    raise exception 'payment_not_found' using errcode = 'P0002';
  end if;
  if v_pay.status not in ('approved', 'partially_refunded') then
    raise exception 'payment_not_reversible' using errcode = '22023';
  end if;
  if p_refunded_cents is null or p_refunded_cents <= 0 or p_refunded_cents >= v_pay.amount_cents then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  perform platform_lock_tenant(v_pay.tenant_id);
  select id into v_credit from platform_ledger where payment_id = p_payment and kind = 'payment';
  select coalesce(sum(amount_cents), 0) into v_done from platform_ledger where payment_id = p_payment and kind = 'refund';
  v_delta := p_refunded_cents - v_done;
  if v_delta <= 0 then
    return null;
  end if;
  v_mov := platform_post_movement(v_pay.tenant_id, 'refund', v_delta, platform_ar_date(now()), platform_ar_date(now()),
                                  'Reintegro parcial del pago', p_reason, null, p_payment, v_credit,
                                  'prefund:' || p_payment::text || ':' || p_refunded_cents::text, p_actor);
  update platform_payments set status = 'partially_refunded' where id = p_payment;
  perform platform_auto_allocate(v_pay.tenant_id, p_actor);
  return v_mov;
end;
$$;

-- Acciones de la bandeja (staff con 'manage', motivo obligatorio):
--   impute       faltante en el ledger: entra el pago de MP como cualquier otro
--                (billing_records → ledger, imputación FIFO) al negocio dado.
--   keep_credit  duplicado: queda como saldo a favor del próximo período.
--   refund       el reintegro ya hecho en MP: debe compensatorio (total o
--                parcial). No se llama a la API: esto sólo registra.
--   chargeback   contracargo o mediación: reversa del pago (los cargos vuelven
--                a deberse y la escalera corre otra vez).
--   accept       el monto o el estado distinto queda aceptado con motivo.
--   ignore       se descarta con motivo.
create or replace function internal_recon_resolve(p_diff uuid, p_action text, p_tenant uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason  text := platform_assert_reason(p_reason);
  v_d       platform_recon_diffs%rowtype;
  v_m       platform_mp_payments_seen%rowtype;
  v_tenant  uuid;
  v_br      uuid;
  v_pay     uuid;
  v_ref     uuid;
  v_res     text;
  v_pstat   text;
  v_amount  bigint;
begin
  perform platform_assert_billing_can('manage');
  select * into v_d from platform_recon_diffs where id = p_diff for update;
  if not found then
    raise exception 'diff_not_found' using errcode = 'P0002';
  end if;
  if v_d.status <> 'open' then
    raise exception 'diff_not_open' using errcode = '22023';
  end if;
  if p_action not in ('impute', 'keep_credit', 'refund', 'chargeback', 'accept', 'ignore') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if v_d.mp_payment_id is not null then
    select * into v_m from platform_mp_payments_seen where mp_payment_id = v_d.mp_payment_id;
  end if;

  if p_action = 'impute' then
    if v_d.kind <> 'missing_local' then
      raise exception 'action_not_allowed' using errcode = '22023';
    end if;
    v_tenant := coalesce(p_tenant, v_d.tenant_id);
    if v_tenant is null or not exists (select 1 from tenants where id = v_tenant) then
      raise exception 'tenant_required' using errcode = '22023';
    end if;
    if v_m.mp_payment_id is null or v_m.amount_cents <= 0 then
      raise exception 'mp_payment_unknown' using errcode = 'P0002';
    end if;
    if exists (select 1 from platform_payments where provider = 'mercadopago' and external_id = v_m.mp_payment_id) then
      raise exception 'duplicate_payment' using errcode = '23505';
    end if;
    insert into billing_records (tenant_id, amount, currency, medium, receipt_ref, notes, recorded_by, paid_at)
    values (v_tenant, v_m.amount_cents / 100.0, 'ARS', 'mp', v_m.mp_payment_id,
            'Conciliación con Mercado Pago: ' || v_reason, auth.uid(),
            coalesce(v_m.date_approved, v_m.date_created, now()))
    returning id into v_br;
    select payment_id into v_pay from platform_ingest_log where billing_record_id = v_br;
    if v_pay is null then
      raise exception 'ledger_ingest_failed' using errcode = 'P0001';
    end if;
    update platform_payments set fee_cents = v_m.fee_cents, net_cents = v_m.net_cents
     where id = v_pay and v_m.fee_cents is not null;
    update platform_mp_payments_seen set payment_id = v_pay, tenant_id = v_tenant, match_kind = 'exact', updated_at = now()
     where mp_payment_id = v_m.mp_payment_id;
    v_ref := v_pay;
    v_res := 'imputed';
  elsif p_action = 'keep_credit' then
    if v_d.kind <> 'duplicate' then
      raise exception 'action_not_allowed' using errcode = '22023';
    end if;
    v_res := 'duplicate_kept';
  elsif p_action in ('refund', 'chargeback') then
    if v_d.payment_id is null then
      raise exception 'payment_required' using errcode = '22023';
    end if;
    if p_action = 'chargeback' and v_d.kind not in ('chargeback', 'status_mismatch') then
      raise exception 'action_not_allowed' using errcode = '22023';
    end if;
    if p_action = 'refund' and v_d.kind not in ('refund', 'duplicate') then
      raise exception 'action_not_allowed' using errcode = '22023';
    end if;
    select status, amount_cents into v_pstat, v_amount from platform_payments where id = v_d.payment_id;
    if p_action = 'refund' and v_m.mp_payment_id is not null and v_m.refunded_cents > 0 and v_m.refunded_cents < v_amount then
      v_ref := platform_register_partial_refund(v_d.payment_id, v_m.refunded_cents, v_reason, auth.uid());
    else
      if v_pstat not in ('approved') then
        raise exception 'payment_not_reversible' using errcode = '22023';
      end if;
      v_ref := internal_billing_reverse_payment(v_d.payment_id, p_action, v_reason);
    end if;
    v_res := case p_action when 'refund' then 'refund_registered' else 'chargeback_registered' end;
  elsif p_action = 'accept' then
    v_res := 'accepted';
  else
    v_res := 'ignored';
  end if;

  update platform_recon_diffs
     set status = case when v_res = 'ignored' then 'ignored' else 'resolved' end,
         resolution = v_res, resolution_ref = v_ref, resolved_by = auth.uid(), resolved_at = now(),
         resolve_reason = v_reason, tenant_id = coalesce(v_tenant, tenant_id)
   where id = p_diff;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (coalesce(v_tenant, v_d.tenant_id), auth.uid(), 'platform_recon', p_diff, 'platform_recon_resolved',
          jsonb_build_object('kind', v_d.kind, 'status', 'open', 'mp_payment_id', v_d.mp_payment_id, 'payment_id', v_d.payment_id),
          jsonb_build_object('resolution', v_res, 'ref', v_ref, 'expected_cents', v_d.expected_cents, 'actual_cents', v_d.actual_cents),
          v_reason);
  return jsonb_build_object('id', p_diff, 'resolution', v_res, 'ref', v_ref);
end;
$$;

-- -----------------------------------------------------------------------------
-- H) Cobranza 360: cobradores, asignación, notas, cartera y timeline
-- -----------------------------------------------------------------------------
-- Staff que puede ser cobrador: admin, super_admin o con el permiso Cobranzas.
create or replace function platform_is_collector(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from users u
     where u.id = p_user and u.internal_level is not null
       and (u.internal_level in ('admin', 'super_admin')
            or exists (select 1 from platform_staff_permissions p
                        where p.user_id = u.id and p.permission = 'cobranzas' and p.revoked_at is null)))
$$;

create or replace function internal_billing_collectors()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform platform_assert_billing_can('view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'name', coalesce(nullif(u.full_name, ''), u.email),
                                        'level', u.internal_level,
                                        'tenants', (select count(*) from tenant_billing_terms bt where bt.assigned_staff_id = u.id))
                     order by coalesce(nullif(u.full_name, ''), u.email))
      from users u
     where platform_is_collector(u.id)), '[]'::jsonb);
end;
$$;

-- Asignar (o quitar, p_user null) el cobrador de uno o varios negocios.
create or replace function internal_billing_assign(p_tenants uuid[], p_user uuid, p_reason text default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_t      uuid;
  v_old    uuid;
  v_n      int := 0;
begin
  perform platform_assert_billing_can('assign');
  if p_tenants is null or cardinality(p_tenants) = 0 or cardinality(p_tenants) > 500 then
    raise exception 'invalid_tenants' using errcode = '22023';
  end if;
  if p_user is not null and not platform_is_collector(p_user) then
    raise exception 'not_collector' using errcode = '22023';
  end if;
  if v_reason is not null and length(v_reason) > 500 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;
  foreach v_t in array p_tenants loop
    continue when not exists (select 1 from tenants where id = v_t and deleted_at is null);
    select assigned_staff_id into v_old from tenant_billing_terms where tenant_id = v_t;
    continue when v_old is not distinct from p_user;
    insert into tenant_billing_terms (tenant_id, assigned_staff_id, assigned_at, assigned_by, created_by, updated_by)
    values (v_t, p_user, now(), auth.uid(), auth.uid(), auth.uid())
    on conflict (tenant_id) do update
       set assigned_staff_id = excluded.assigned_staff_id, assigned_at = now(), assigned_by = auth.uid(), updated_by = auth.uid();
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
    values (v_t, auth.uid(), 'tenant_billing_terms', v_t, 'platform_collector_assigned',
            jsonb_build_object('assigned_staff_id', v_old,
                               'name', (select coalesce(nullif(full_name, ''), email) from users where id = v_old)),
            jsonb_build_object('assigned_staff_id', p_user,
                               'name', (select coalesce(nullif(full_name, ''), email) from users where id = p_user)),
            v_reason);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function internal_collection_note_add(
  p_tenant         uuid,
  p_kind           text,
  p_outcome        text,
  p_body           text,
  p_next_action_at date default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body  text := btrim(coalesce(p_body, ''));
  v_today date := platform_ar_date(now());
  v_id    uuid;
begin
  perform platform_assert_billing_can('manage');
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  if p_kind not in ('call', 'whatsapp', 'email', 'meeting', 'other') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if p_outcome is not null and p_outcome not in ('contacted', 'no_answer', 'promised', 'disputed', 'other') then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;
  if length(v_body) < 3 or length(v_body) > 2000 then
    raise exception 'invalid_body' using errcode = '22023';
  end if;
  if p_next_action_at is not null and (p_next_action_at < v_today or p_next_action_at > v_today + 180) then
    raise exception 'invalid_next_action' using errcode = '22023';
  end if;
  insert into platform_collection_notes (tenant_id, kind, outcome, body, next_action_at, created_by)
  values (p_tenant, p_kind, p_outcome, v_body, p_next_action_at, auth.uid())
  returning id into v_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, auth.uid(), 'platform_collection_note', v_id, 'platform_collection_note_added',
          jsonb_build_object('kind', p_kind, 'outcome', p_outcome, 'next_action_at', p_next_action_at));
  return v_id;
end;
$$;

create or replace function internal_collection_note_void(p_note uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_n      platform_collection_notes%rowtype;
begin
  perform platform_assert_billing_can('manage');
  select * into v_n from platform_collection_notes where id = p_note for update;
  if not found then
    raise exception 'note_not_found' using errcode = 'P0002';
  end if;
  if v_n.voided_at is not null then
    raise exception 'note_already_voided' using errcode = '22023';
  end if;
  -- La autora la anula; el resto sólo admin o super_admin.
  if v_n.created_by is distinct from auth.uid() and platform_staff_billing_role() not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update platform_collection_notes set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = p_note;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason)
  values (v_n.tenant_id, auth.uid(), 'platform_collection_note', p_note, 'platform_collection_note_voided', v_reason);
end;
$$;

-- Lista de cobranza: un renglón por negocio que se cobra y tiene algo para
-- gestionar (movimientos, promesa, cobrador o notas). Los filtros (aging,
-- monto, escalera, promesa, cobrador) se aplican en la pantalla sobre esta
-- lista (lib/billing/collection360.ts), que también la exporta a XLSX.
create or replace function internal_billing_portfolio()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := platform_ar_date(now());
  v_rows  jsonb;
  v_excl  int;
begin
  perform platform_assert_billing_can('view');

  create temporary table if not exists _pf_mv (
    tenant_id uuid, amount_cents bigint, due date, open_cents bigint
  ) on commit drop;
  truncate _pf_mv;
  insert into _pf_mv
  select l.tenant_id, l.amount_cents, coalesce(l.due_date, l.effective_date),
         abs(l.amount_cents) - coalesce((select sum(a.amount_cents) from platform_allocations a
                                          where a.released_at is null
                                            and (a.credit_movement_id = l.id or a.debit_movement_id = l.id)), 0)
    from platform_ledger l;

  create temporary table if not exists _pf_t (tenant_id uuid primary key) on commit drop;
  truncate _pf_t;
  insert into _pf_t
  select x.tenant_id from (
    select tenant_id from _pf_mv
    union select tenant_id from platform_promises where status = 'open'
    union select tenant_id from tenant_billing_terms where assigned_staff_id is not null
    union select tenant_id from platform_collection_notes where voided_at is null
    union select tenant_id from platform_collection_status where state <> 'al_dia'
  ) x
  join tenants t on t.id = x.tenant_id
  where t.deleted_at is null and platform_billing_exclusion(t.id) is null
  on conflict do nothing;

  select coalesce(jsonb_agg(r.row order by (r.row ->> 'overdue_cents')::bigint desc, (r.row ->> 'balance_cents')::bigint desc,
                            r.row ->> 'name'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'tenant_id', t.id, 'name', t.name, 'slug', t.slug,
               'billing_mode', platform_effective_billing_mode(t.id),
               'sub_status', s.status, 'plan_name', p.name, 'billing_cycle', s.billing_cycle,
               'balance_cents', coalesce(m.balance, 0),
               'overdue_cents', coalesce(m.overdue, 0),
               'upcoming_cents', coalesce(m.upcoming, 0),
               'credit_cents', coalesce(m.credit, 0),
               'oldest_due_date', m.oldest,
               'days_overdue', case when m.oldest is null then 0 else v_today - m.oldest end,
               'aging', jsonb_build_object('d1_30', coalesce(m.d1_30, 0), 'd31_60', coalesce(m.d31_60, 0),
                                           'd61_90', coalesce(m.d61_90, 0), 'd90_plus', coalesce(m.d90_plus, 0)),
               'collection', case when cs.tenant_id is null then null else jsonb_build_object(
                                'state', cs.state, 'days_overdue', cs.days_overdue, 'soft_restricted', cs.soft_restricted,
                                'last_step_action', ls.action, 'last_step_title', ls.title, 'last_step_at', cs.last_step_at,
                                'next_step_action', ns.action, 'next_step_title', ns.title, 'next_step_date', cs.next_step_date,
                                'suspend_on', cs.suspend_on, 'status_by_ladder', cs.status_by_ladder,
                                'uncollectible_at', cs.uncollectible_at) end,
               'promise', (select jsonb_build_object('id', pr.id, 'amount_cents', pr.amount_cents, 'promised_date', pr.promised_date,
                                                     'channel', pr.channel, 'paid_cents', pr.paid_cents)
                             from platform_promises pr where pr.tenant_id = t.id and pr.status = 'open'),
               'broken_promises_90d', (select count(*) from platform_promises pr
                                        where pr.tenant_id = t.id and pr.status = 'broken'
                                          and pr.resolved_at >= now() - interval '90 days'),
               'collector', case when bt.assigned_staff_id is null then null else jsonb_build_object(
                               'id', bt.assigned_staff_id, 'assigned_at', bt.assigned_at,
                               'name', (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = bt.assigned_staff_id)) end,
               'last_note', (select jsonb_build_object('at', n.created_at, 'kind', n.kind, 'outcome', n.outcome,
                                                       'body', left(n.body, 160), 'next_action_at', n.next_action_at,
                                                       'by', (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = n.created_by))
                               from platform_collection_notes n
                              where n.tenant_id = t.id and n.voided_at is null
                              order by n.created_at desc limit 1),
               'next_action_at', (select min(n.next_action_at) from platform_collection_notes n
                                   where n.tenant_id = t.id and n.voided_at is null and n.next_action_at >= v_today),
               'notes_count', (select count(*) from platform_collection_notes n where n.tenant_id = t.id and n.voided_at is null),
               'last_payment_at', (select max(pp.paid_at) from platform_payments pp where pp.tenant_id = t.id and pp.status = 'approved'),
               'open_diffs', (select count(*) from platform_recon_diffs d where d.tenant_id = t.id and d.status = 'open')
             ) as row
        from _pf_t x
        join tenants t on t.id = x.tenant_id
        left join subscriptions s on s.tenant_id = t.id
        left join plans p on p.id = s.plan_id
        left join tenant_billing_terms bt on bt.tenant_id = t.id
        left join platform_collection_status cs on cs.tenant_id = t.id
        left join platform_dunning_steps ls on ls.id = cs.last_step_id
        left join platform_dunning_steps ns on ns.id = cs.next_step_id
        left join lateral (
          select sum(mv.amount_cents) as balance,
                 sum(mv.open_cents) filter (where mv.amount_cents > 0 and mv.due < v_today) as overdue,
                 sum(mv.open_cents) filter (where mv.amount_cents > 0 and mv.due >= v_today) as upcoming,
                 sum(mv.open_cents) filter (where mv.amount_cents < 0) as credit,
                 min(mv.due) filter (where mv.amount_cents > 0 and mv.open_cents > 0 and mv.due < v_today) as oldest,
                 sum(mv.open_cents) filter (where mv.amount_cents > 0 and v_today - mv.due between 1 and 30) as d1_30,
                 sum(mv.open_cents) filter (where mv.amount_cents > 0 and v_today - mv.due between 31 and 60) as d31_60,
                 sum(mv.open_cents) filter (where mv.amount_cents > 0 and v_today - mv.due between 61 and 90) as d61_90,
                 sum(mv.open_cents) filter (where mv.amount_cents > 0 and v_today - mv.due > 90) as d90_plus
            from _pf_mv mv where mv.tenant_id = t.id
        ) m on true
    ) r;

  select count(*) into v_excl from tenants t where t.deleted_at is null and platform_billing_exclusion(t.id) is not null;

  return jsonb_build_object(
    'as_of', v_today,
    'rows', v_rows,
    'excluded_count', v_excl,
    'me', auth.uid(),
    'can_manage', platform_billing_can('manage'),
    'can_assign', platform_billing_can('assign'),
    'collectors', internal_billing_collectors());
end;
$$;

-- Timeline unificado de un negocio (§10.6). Devuelve hechos con su grupo:
--   plata     cargos, anulaciones, pagos, reversas, imputaciones, punitorios
--             (agrupados por mes), condonaciones, bonificaciones, conciliación
--   mora      pasos de la escalera
--   avisos    avisos de cobro enviados
--   gestion   notas, promesas, cobrador asignado, transferencias informadas
--   plan      cambios de plan, de ciclo, addons y de modalidad
-- El texto lo arma la pantalla (lib/billing/collection360.ts) a partir de
-- kind y data.
create or replace function internal_billing_timeline(p_tenant uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from timestamptz := case when p_from is null then '-infinity'::timestamptz
                             else (p_from::timestamp) at time zone 'America/Argentina/Buenos_Aires' end;
  v_to   timestamptz := case when p_to is null then 'infinity'::timestamptz
                             else ((p_to + 1)::timestamp) at time zone 'America/Argentina/Buenos_Aires' end;
  v_out  jsonb;
begin
  perform platform_assert_billing_can('view');
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;

  with ev as (
    -- Cargos
    select c.id::text || ':c' as id, c.created_at as at, 'plata' as grp, 'charge' as kind,
           c.total_cents as amount_cents, c.created_by as actor,
           jsonb_build_object('charge_kind', c.kind, 'description', c.description, 'status', c.status,
                              'due_date', c.due_date, 'period_start', c.period_start, 'period_end', c.period_end,
                              'source', c.source, 'charge_id', c.id) as data
      from platform_charges c where c.tenant_id = p_tenant
    union all
    select c.id::text || ':v', c.voided_at, 'plata', 'charge_void', -c.total_cents, c.voided_by,
           jsonb_build_object('description', c.description, 'reason', c.void_reason, 'charge_id', c.id)
      from platform_charges c where c.tenant_id = p_tenant and c.voided_at is not null
    -- Pagos
    union all
    select p.id::text || ':p', p.paid_at, 'plata', 'payment', -p.amount_cents, p.recorded_by,
           jsonb_build_object('method', p.method, 'status', p.status, 'provider', p.provider, 'external_id', p.external_id,
                              'fee_cents', p.fee_cents, 'net_cents', p.net_cents, 'period_start', p.period_start, 'payment_id', p.id)
      from platform_payments p where p.tenant_id = p_tenant
    -- Reversas, reintegros, bonificaciones y ajustes del ledger
    union all
    select l.id::text || ':l', l.created_at, 'plata', l.kind, l.amount_cents, l.created_by,
           jsonb_build_object('description', l.description, 'reason', l.reason, 'payment_id', l.payment_id)
      from platform_ledger l
     where l.tenant_id = p_tenant and l.kind in ('payment_reversal', 'refund', 'bonus_credit', 'adjustment_credit', 'adjustment_debit', 'opening_balance')
    -- Imputaciones
    union all
    select a.id::text || ':a', a.created_at, 'plata', 'allocation', a.amount_cents, a.created_by,
           jsonb_build_object('credit', cr.description, 'debit', db.description, 'credit_kind', cr.kind, 'debit_kind', db.kind)
      from platform_allocations a
      join platform_ledger cr on cr.id = a.credit_movement_id
      join platform_ledger db on db.id = a.debit_movement_id
     -- Sin los asientos técnicos de una anulación o de una reversa.
     where a.tenant_id = p_tenant and cr.kind <> 'charge_void' and db.kind not in ('payment_reversal', 'refund')
    union all
    select a.id::text || ':ar', a.released_at, 'plata', 'allocation_released', a.amount_cents, a.released_by,
           jsonb_build_object('credit', cr.description, 'debit', db.description, 'reason', a.release_reason)
      from platform_allocations a
      join platform_ledger cr on cr.id = a.credit_movement_id
      join platform_ledger db on db.id = a.debit_movement_id
     where a.tenant_id = p_tenant and a.released_at is not null
    -- Punitorios: el devengo diario agrupado por mes
    union all
    select 'int:' || to_char(date_trunc('month', l.effective_date), 'YYYY-MM'), max(l.created_at), 'plata', 'interest',
           sum(l.amount_cents), null::uuid,
           jsonb_build_object('month', to_char(date_trunc('month', l.effective_date), 'YYYY-MM'), 'movements', count(*))
      from platform_ledger l
     where l.tenant_id = p_tenant and l.kind = 'interest'
     group by date_trunc('month', l.effective_date)
    -- Condonaciones
    union all
    select w.id::text || ':w', w.created_at, 'plata', 'waiver', -w.amount_cents, w.requested_by,
           jsonb_build_object('status', w.status, 'reason', w.reason, 'applied_cents', w.applied_cents,
                              'decided_at', w.decided_at, 'decision_reason', w.decision_reason)
      from platform_interest_waivers w where w.tenant_id = p_tenant
    -- Promesas
    union all
    select pr.id::text || ':pr', pr.created_at, 'gestion', 'promise', pr.amount_cents, pr.created_by,
           jsonb_build_object('promised_date', pr.promised_date, 'channel', pr.channel, 'note', pr.note, 'status', pr.status)
      from platform_promises pr where pr.tenant_id = p_tenant
    union all
    select pr.id::text || ':prr', pr.resolved_at, 'gestion', 'promise_' || pr.status, pr.paid_cents, pr.resolved_by,
           jsonb_build_object('promised_date', pr.promised_date, 'amount_cents', pr.amount_cents, 'reason', pr.resolve_reason)
      from platform_promises pr where pr.tenant_id = p_tenant and pr.resolved_at is not null and pr.status <> 'open'
    -- Escalera de mora
    union all
    select e.id::text || ':d', e.executed_at, 'mora', 'dunning_step', e.due_cents, null::uuid,
           jsonb_build_object('action', e.action, 'offset_days', e.offset_days, 'days_overdue', e.days_overdue,
                              'notified', e.notified, 'title', st.title, 'closed_at', e.closed_at, 'close_reason', e.close_reason)
      from platform_dunning_events e left join platform_dunning_steps st on st.id = e.step_id
     where e.tenant_id = p_tenant
    -- Avisos de cobro enviados
    union all
    select n.id::text || ':n', n.created_at, 'avisos', 'notice', n.amount_cents, n.created_by,
           jsonb_build_object('notice_kind', n.kind, 'due_date', n.due_date, 'recipients', to_jsonb(n.recipients))
      from platform_billing_notices n where n.tenant_id = p_tenant
    -- Transferencias informadas por el negocio y su verificación
    union all
    select r.id::text || ':t', r.created_at, 'gestion', 'transfer_reported', r.amount_cents, r.reported_by,
           jsonb_build_object('paid_on', r.paid_on, 'reference', r.reference, 'status', r.status)
      from platform_transfer_reports r where r.tenant_id = p_tenant
    union all
    select r.id::text || ':tv', r.verified_at, 'gestion', 'transfer_' || r.status, coalesce(r.approved_cents, r.amount_cents), r.verified_by,
           jsonb_build_object('reject_reason', r.reject_reason, 'payment_id', r.payment_id)
      from platform_transfer_reports r
     where r.tenant_id = p_tenant and r.verified_at is not null and r.status in ('approved', 'rejected')
    -- Cambios de plan, ciclo y addons
    union all
    select pc.id::text || ':pc', coalesce(pc.applied_at, pc.created_at), 'plan', 'plan_change_' || pc.status,
           case when pc.charge_cents > 0 then pc.charge_cents when pc.credit_cents > 0 then -pc.credit_cents end, pc.created_by,
           jsonb_build_object('change_kind', pc.kind, 'timing', pc.timing, 'effective_on', pc.effective_on,
                              'from_plan', (select name from plans where id = pc.from_plan_id),
                              'to_plan', (select name from plans where id = pc.to_plan_id),
                              'from_cycle', pc.from_cycle, 'to_cycle', pc.to_cycle, 'addon_key', pc.addon_key,
                              'reason', pc.reason, 'cancel_reason', pc.cancel_reason, 'source', pc.source)
      from platform_plan_changes pc where pc.tenant_id = p_tenant
    -- Cambios de plan anteriores a esta migración (auditoría)
    union all
    select a.id::text || ':au', a.created_at, 'plan', a.action, null::bigint, a.actor_user_id,
           coalesce(a.after_data, '{}'::jsonb) || jsonb_build_object('reason', a.reason)
      from audit_logs a
     where a.tenant_id = p_tenant
       and a.action in ('plan_changed', 'plan_change_requested', 'addon_activated', 'addon_set', 'addon_cancelled')
       and coalesce(a.after_data ->> 'source', '') not like 'cobranza_360%'
    -- Cambios de modalidad
    union all
    select mc.id::text || ':m', mc.created_at, 'plan', 'mode_change', null::bigint, mc.created_by,
           jsonb_build_object('from_mode', mc.from_mode, 'to_mode', mc.to_mode, 'status', mc.status, 'reason', mc.reason,
                              'source', mc.source)
      from platform_billing_mode_changes mc where mc.tenant_id = p_tenant
    -- Notas de gestión
    union all
    select n.id::text || ':no', n.created_at, 'gestion', 'note', null::bigint, n.created_by,
           jsonb_build_object('note_id', n.id, 'note_kind', n.kind, 'outcome', n.outcome, 'body', n.body,
                              'next_action_at', n.next_action_at, 'voided_at', n.voided_at, 'void_reason', n.void_reason)
      from platform_collection_notes n where n.tenant_id = p_tenant
    -- Cobrador asignado
    union all
    select a.id::text || ':as', a.created_at, 'gestion', 'collector_assigned', null::bigint, a.actor_user_id,
           jsonb_build_object('from', a.before_data ->> 'name', 'to', a.after_data ->> 'name', 'reason', a.reason)
      from audit_logs a where a.tenant_id = p_tenant and a.action = 'platform_collector_assigned'
    -- Conciliación
    union all
    select d.id::text || ':rc', d.created_at, 'plata', 'recon_diff', coalesce(d.actual_cents, d.expected_cents), d.resolved_by,
           jsonb_build_object('diff_kind', d.kind, 'status', d.status, 'resolution', d.resolution,
                              'mp_payment_id', d.mp_payment_id, 'resolve_reason', d.resolve_reason)
      from platform_recon_diffs d where d.tenant_id = p_tenant
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'at', e.at, 'group', e.grp, 'kind', e.kind, 'amount_cents', e.amount_cents,
           'actor', case when e.actor is null then null
                         else (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = e.actor) end,
           'data', e.data) order by e.at desc, e.id), '[]'::jsonb)
    into v_out
    from (select * from ev where ev.at is not null and ev.at >= v_from and ev.at < v_to order by ev.at desc limit 600) e;

  return jsonb_build_object(
    'tenant_id', p_tenant,
    'name', (select name from tenants where id = p_tenant),
    'exclusion', platform_billing_exclusion(p_tenant),
    'can_manage', platform_billing_can('manage'),
    'collector', (select jsonb_build_object('id', bt.assigned_staff_id,
                                            'name', (select coalesce(nullif(u.full_name, ''), u.email) from users u where u.id = bt.assigned_staff_id))
                    from tenant_billing_terms bt where bt.tenant_id = p_tenant and bt.assigned_staff_id is not null),
    'scheduled_change', (select jsonb_build_object('id', c.id, 'kind', c.kind, 'effective_on', c.effective_on,
                                                   'to_plan', (select name from plans where id = c.to_plan_id), 'to_cycle', c.to_cycle)
                           from platform_plan_changes c where c.tenant_id = p_tenant and c.status = 'scheduled'),
    'events', v_out);
end;
$$;

-- -----------------------------------------------------------------------------
-- I) Permisos de ejecución
-- -----------------------------------------------------------------------------
revoke all on function platform_billing_capabilities() from public, anon, authenticated;
revoke all on function platform_billing_can(text) from public, anon, authenticated;
revoke all on function platform_assert_billing_can(text) from public, anon, authenticated;
revoke all on function platform_collection_notes_guard() from public, anon, authenticated;
revoke all on function platform_prorate_cents(bigint, int, int, int) from public, anon, authenticated;
revoke all on function platform_percent_off_bp(uuid, date) from public, anon, authenticated;
revoke all on function platform_plan_cycle_cents(uuid, text) from public, anon, authenticated;
revoke all on function platform_billing_breakdown_for(uuid, date, uuid, text) from public, anon, authenticated;
revoke all on function platform_billing_breakdown(uuid, date) from public, anon, authenticated;
revoke all on function platform_period_lines_for(uuid, date, uuid, text) from public, anon, authenticated;
revoke all on function platform_period_lines(uuid, date) from public, anon, authenticated;
revoke all on function platform_period_charged(uuid, date) from public, anon, authenticated;
revoke all on function platform_proration_core(uuid, uuid, uuid, text, uuid, text, date, date, date, text, boolean) from public, anon, authenticated;
revoke all on function platform_proration_quote(uuid, uuid, text, text, date) from public, anon, authenticated;
revoke all on function trg_subscriptions_proration() from public, anon, authenticated;
revoke all on function trg_subscription_addons_proration() from public, anon, authenticated;
revoke all on function platform_plan_changes_run(timestamptz) from public, anon, authenticated;
revoke all on function platform_recon_begin(text, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function platform_recon_inputs(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function platform_recon_finish(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function platform_register_partial_refund(uuid, bigint, text, uuid) from public, anon, authenticated;
revoke all on function platform_is_collector(uuid) from public, anon, authenticated;

-- La Edge de conciliación usa service_role.
grant execute on function platform_recon_begin(text, timestamptz, timestamptz, uuid) to service_role;
grant execute on function platform_recon_inputs(timestamptz, timestamptz) to service_role;
grant execute on function platform_recon_finish(uuid, text, text, jsonb) to service_role;

do $grants$
declare
  f text;
begin
  foreach f in array array[
    'internal_set_staff_permission(uuid, text, boolean, text)',
    'internal_my_billing_access()',
    'internal_billing_proration_preview(uuid, uuid, text, text)',
    'internal_billing_plan_change(uuid, uuid, text, text, text, uuid, jsonb)',
    'internal_billing_plan_change_cancel(uuid, text)',
    'internal_recon_overview(text)',
    'internal_recon_set_settings(int, bigint, text)',
    'internal_recon_resolve(uuid, text, uuid, text)',
    'internal_billing_collectors()',
    'internal_billing_assign(uuid[], uuid, text)',
    'internal_collection_note_add(uuid, text, text, text, date)',
    'internal_collection_note_void(uuid, text)',
    'internal_billing_portfolio()',
    'internal_billing_timeline(uuid, date, date)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$grants$;

-- -----------------------------------------------------------------------------
-- J) pg_cron: cambios programados (cada hora, antes de platform-billing-run a
--    los :17) y conciliación con MP 04:00 ART (07:00 UTC) por la Edge. Sin
--    pg_cron o sin pg_net (local, CI) se omite.
-- -----------------------------------------------------------------------------
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/platform_mp_reconcile';
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omiten platform-plan-changes y platform-mp-reconcile.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'platform-plan-changes') then
    perform cron.unschedule('platform-plan-changes');
  end if;
  perform cron.schedule('platform-plan-changes', '7 * * * *', $$select public.platform_plan_changes_run()$$);

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omite platform-mp-reconcile.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'platform-mp-reconcile') then
    perform cron.unschedule('platform-mp-reconcile');
  end if;
  perform cron.schedule('platform-mp-reconcile', '0 7 * * *', format($job$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'apikey', (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'X-Cron-Secret', (select secrets ->> 'token' from platform_secrets where key = 'internal_cron')
      ),
      body := jsonb_build_object('mode', 'cron'),
      timeout_milliseconds := 55000
    );
  $job$, v_url));
end
$cron$;
