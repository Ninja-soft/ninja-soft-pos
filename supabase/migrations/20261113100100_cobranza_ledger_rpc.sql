-- =============================================================================
-- 20261113100100_cobranza_ledger_rpc  (F20-1 · H127 · ADR-113)
--
-- Operación de la cuenta corriente de la plataforma (modelo en
-- 20261113100000_cobranza_ledger.sql):
--
--   · Permiso "Cobranzas" para el staff (§22 #8): se suma a cualquier nivel.
--     Un "soporte" con Cobranzas ve y opera cuentas corrientes (registrar
--     pagos, bonificar, anular cargos, revertir pagos, cargar ajustes) sin
--     administrar negocios (las RPC viejas siguen rechazando a 'support').
--     admin y super_admin operan cobranzas por su nivel.
--   · Topes de bonificación por nivel (§22 #9), por operación y por mes por
--     negocio, editables por super_admin (platform_billing_caps). null = sin
--     tope. Cuentan bonificaciones, ajustes al haber, anulaciones de cargo y
--     condonaciones.
--   · Estado de cuenta: internal_billing_statement (staff) y
--     my_billing_statement (dueño o encargado del negocio, sin motivos
--     internos ni autores). Vista general internal_billing_overview.
--   · Marca de prueba: internal_set_tenant_test (super_admin).
--   · KPIs: internal_billing_exclusions() para que el dashboard excluya
--     negocios de prueba, del staff, lifetime y exentos (§22 #7).
--
-- Todo con guard (select internal_scope()) (ADR-052), motivo obligatorio
-- (5 a 500 caracteres) y auditoría antes de responder.
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Permiso Cobranzas y topes
-- -----------------------------------------------------------------------------
create table if not exists platform_staff_permissions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete restrict,
  permission  text not null check (permission in ('cobranzas')),
  granted_by  uuid references users(id),
  reason      text,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid references users(id),
  revoke_reason text
);
create unique index if not exists platform_staff_permissions_active_uidx
  on platform_staff_permissions (user_id, permission) where revoked_at is null;
create index if not exists platform_staff_permissions_granted_by_idx on platform_staff_permissions (granted_by);

create table if not exists platform_billing_caps (
  level               text primary key check (level in ('cobranzas', 'admin', 'super_admin')),
  per_operation_cents bigint check (per_operation_cents >= 0),
  per_month_cents     bigint check (per_month_cents >= 0),
  updated_at          timestamptz not null default now(),
  updated_by          uuid references users(id)
);
-- Defaults de la spec §18.1: $ 50.000 por operación y $ 150.000 por mes por
-- negocio; super_admin sin tope.
insert into platform_billing_caps (level, per_operation_cents, per_month_cents) values
  ('cobranzas', 5000000, 15000000),
  ('admin', 5000000, 15000000),
  ('super_admin', null, null)
on conflict (level) do nothing;

alter table platform_staff_permissions enable row level security;
alter table platform_billing_caps enable row level security;
drop policy if exists platform_staff_permissions_staff on platform_staff_permissions;
create policy platform_staff_permissions_staff on platform_staff_permissions
  for select to authenticated using ((select internal_scope()));
drop policy if exists platform_billing_caps_staff on platform_billing_caps;
create policy platform_billing_caps_staff on platform_billing_caps
  for select to authenticated using ((select internal_scope()));
revoke all on table platform_staff_permissions, platform_billing_caps from anon;
revoke insert, update, delete, truncate on table platform_staff_permissions, platform_billing_caps from authenticated;
grant select on table platform_staff_permissions, platform_billing_caps to authenticated;

-- Rol de cobranza del usuario actual: null (no es staff en el panel interno),
-- 'viewer' (staff que sólo mira), 'cobranzas', 'admin' o 'super_admin'.
-- Interno legacy sin nivel = admin (mismo criterio que las RPC existentes).
create or replace function platform_staff_billing_role()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_level text;
begin
  if not coalesce((select internal_scope()), false) then
    return null;
  end if;
  v_level := coalesce(internal_level(), 'admin');
  if v_level in ('super_admin', 'admin') then
    return v_level;
  end if;
  if exists (select 1 from platform_staff_permissions p
              where p.user_id = auth.uid() and p.permission = 'cobranzas' and p.revoked_at is null) then
    return 'cobranzas';
  end if;
  return 'viewer';
end;
$$;

create or replace function platform_assert_billing_operator()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := platform_staff_billing_role();
begin
  if v_role is null or v_role not in ('cobranzas', 'admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_role;
end;
$$;

create or replace function platform_assert_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text := btrim(coalesce(p_reason, ''));
begin
  if length(v) < 5 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if length(v) > 500 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;
  return v;
end;
$$;

-- Tope de "plata que se resigna" (bonificación, ajuste al haber, anulación,
-- condonación) para el rol actual: por operación y por mes calendario
-- (Argentina) por negocio, sumando lo que hizo cualquier persona del staff.
create or replace function platform_assert_forgiveness_cap(p_tenant uuid, p_amount_cents bigint)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role  text := platform_assert_billing_operator();
  v_cap   platform_billing_caps%rowtype;
  v_from  timestamptz;
  v_used  bigint;
begin
  select * into v_cap from platform_billing_caps where level = v_role;
  if v_cap.per_operation_cents is not null and p_amount_cents > v_cap.per_operation_cents then
    raise exception 'cap_per_operation_exceeded' using errcode = '42501',
      detail = format('Tope por operación: %s centavos', v_cap.per_operation_cents);
  end if;
  if v_cap.per_month_cents is not null then
    v_from := (date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires')) at time zone 'America/Argentina/Buenos_Aires';
    select coalesce(-sum(l.amount_cents), 0) into v_used
      from platform_ledger l
     where l.tenant_id = p_tenant
       and l.kind in ('bonus_credit', 'adjustment_credit', 'charge_void', 'interest_waiver')
       and l.created_at >= v_from;
    if v_used + p_amount_cents > v_cap.per_month_cents then
      raise exception 'cap_per_month_exceeded' using errcode = '42501',
        detail = format('Tope mensual: %s centavos; usado: %s', v_cap.per_month_cents, v_used);
    end if;
  end if;
end;
$$;

-- Para la UI: qué puede hacer el usuario actual y con qué topes.
create or replace function internal_my_billing_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := platform_staff_billing_role();
begin
  if v_role is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'role', v_role,
    'can_operate', v_role in ('cobranzas', 'admin', 'super_admin'),
    'can_set_terms', v_role in ('admin', 'super_admin'),
    'can_configure', v_role = 'super_admin',
    'caps', coalesce((select jsonb_agg(jsonb_build_object(
                        'level', c.level, 'per_operation_cents', c.per_operation_cents,
                        'per_month_cents', c.per_month_cents, 'updated_at', c.updated_at)
                        order by case c.level when 'cobranzas' then 1 when 'admin' then 2 else 3 end)
                      from platform_billing_caps c), '[]'::jsonb)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- B) Estado de cuenta
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
        select * from audit_logs a
         where a.tenant_id = p_tenant
           and (a.entity_type in ('platform_charge', 'platform_payment', 'platform_ledger', 'tenant_billing_terms', 'tenants')
                or a.action in ('plan_changed', 'subscription_webhook', 'subscription_reactivated', 'status_changed',
                                'trial_extended', 'payment_recorded', 'subscription_cancelled_on_reanchor'))
         order by a.created_at desc
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
  ) || case when p_staff then jsonb_build_object('terms', v_terms, 'timeline', v_tl) else '{}'::jsonb end;
end;
$$;
revoke all on function platform_statement(uuid, boolean) from public, anon, authenticated;

create or replace function internal_billing_statement(p_tenant uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if platform_staff_billing_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  return platform_statement(p_tenant, true);
end;
$$;

-- Lo que ve el negocio: dueño o encargado, sólo su cuenta, sólo lectura.
create or replace function my_billing_statement()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tid uuid := current_tenant_id();
begin
  if v_tid is null or not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return platform_statement(v_tid, false);
end;
$$;

-- Vista general de cobranzas: saldo, vencido y aging por negocio, y los
-- próximos vencimientos (45 días).
create or replace function internal_billing_overview()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := platform_ar_date(now());
  v_rows  jsonb;
  v_up    jsonb;
  v_tot   jsonb;
  v_excl  int;
begin
  if platform_staff_billing_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  create temporary table if not exists _po_mv (
    tenant_id uuid, id uuid, amount_cents bigint, due date, open_cents bigint, description text, charge_id uuid
  ) on commit drop;
  truncate _po_mv;
  insert into _po_mv
  select l.tenant_id, l.id, l.amount_cents, coalesce(l.due_date, l.effective_date),
         abs(l.amount_cents) - coalesce((select sum(a.amount_cents) from platform_allocations a
                                          where a.released_at is null
                                            and (a.credit_movement_id = l.id or a.debit_movement_id = l.id)), 0),
         l.description, l.charge_id
    from platform_ledger l;

  select coalesce(jsonb_agg(x.row order by (x.row ->> 'overdue_cents')::bigint desc, (x.row ->> 'balance_cents')::bigint desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'tenant_id', t.id, 'name', t.name, 'slug', t.slug,
               'sub_status', s.status,
               'billing_mode', platform_effective_billing_mode(t.id),
               'exclusion', platform_billing_exclusion(t.id),
               'balance_cents', coalesce(sum(m.amount_cents), 0),
               'overdue_cents', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and m.due < v_today), 0),
               'upcoming_cents', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and m.due >= v_today), 0),
               'credit_cents', coalesce(sum(m.open_cents) filter (where m.amount_cents < 0), 0),
               'oldest_due_date', min(m.due) filter (where m.amount_cents > 0 and m.open_cents > 0 and m.due < v_today),
               'next_due_date', min(m.due) filter (where m.amount_cents > 0 and m.open_cents > 0 and m.due >= v_today),
               'd1_30', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and v_today - m.due between 1 and 30), 0),
               'd31_60', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and v_today - m.due between 31 and 60), 0),
               'd61_90', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and v_today - m.due between 61 and 90), 0),
               'd90_plus', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and v_today - m.due > 90), 0)
             ) as row
        from tenants t
        join _po_mv m on m.tenant_id = t.id
        left join subscriptions s on s.tenant_id = t.id
       group by t.id, t.name, t.slug, s.status
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'tenant_id', m.tenant_id, 'name', t.name, 'due_date', m.due, 'open_cents', m.open_cents,
           'description', m.description, 'charge_id', m.charge_id) order by m.due, t.name), '[]'::jsonb)
    into v_up
    from _po_mv m
    join tenants t on t.id = m.tenant_id
   where m.amount_cents > 0 and m.open_cents > 0 and m.due between v_today and v_today + 45;

  select jsonb_build_object(
           'balance_cents', coalesce(sum(m.amount_cents), 0),
           'overdue_cents', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and m.due < v_today), 0),
           'upcoming_cents', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and m.due >= v_today), 0),
           'credit_cents', coalesce(sum(m.open_cents) filter (where m.amount_cents < 0), 0),
           'd1_30', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and v_today - m.due between 1 and 30), 0),
           'd31_60', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and v_today - m.due between 31 and 60), 0),
           'd61_90', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and v_today - m.due between 61 and 90), 0),
           'd90_plus', coalesce(sum(m.open_cents) filter (where m.amount_cents > 0 and v_today - m.due > 90), 0),
           'tenants_overdue', count(distinct m.tenant_id) filter (where m.amount_cents > 0 and m.open_cents > 0 and m.due < v_today))
    into v_tot
    from _po_mv m;

  select count(*) into v_excl
    from tenants t
   where t.deleted_at is null and platform_billing_exclusion(t.id) is not null;

  return jsonb_build_object('as_of', v_today, 'totals', v_tot, 'tenants', v_rows, 'upcoming', v_up,
                            'excluded_count', v_excl);
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Operaciones del staff (Cobranzas, admin, super_admin)
-- -----------------------------------------------------------------------------
create or replace function platform_tenant_balance(p_tenant uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select coalesce(sum(amount_cents), 0) from platform_ledger where tenant_id = p_tenant $$;
revoke all on function platform_tenant_balance(uuid) from public, anon, authenticated;

-- Pago manual (transferencia, efectivo, Mercado Pago con su id, otro). Entra
-- como billing_record (lo ven el historial del dueño y los KPIs) y el trigger
-- lo pasa al ledger con imputación FIFO.
create or replace function internal_billing_register_payment(
  p_tenant       uuid,
  p_amount_cents bigint,
  p_method       text,
  p_paid_on      date,
  p_reference    text,
  p_reason       text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role    text := platform_assert_billing_operator();
  v_reason  text := platform_assert_reason(p_reason);
  v_ref     text := nullif(btrim(coalesce(p_reference, '')), '');
  v_today   date := platform_ar_date(now());
  v_paid_on date := coalesce(p_paid_on, v_today);
  v_medium  text;
  v_br      uuid;
  v_pay     uuid;
  v_before  bigint;
begin
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 100000000000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if v_paid_on > v_today or v_paid_on < v_today - 400 then
    raise exception 'invalid_paid_on' using errcode = '22023';
  end if;
  v_medium := case p_method
                when 'transfer' then 'bank_transfer'
                when 'cash' then 'cash'
                when 'mp' then 'mp'
                when 'other' then 'other'
              end;
  if v_medium is null then
    raise exception 'invalid_method' using errcode = '22023';
  end if;
  if v_medium = 'mp' then
    if v_ref is null then
      raise exception 'mp_reference_required' using errcode = '22023';
    end if;
    -- §17.8: un pago de MP que ya entró por el webhook no se carga dos veces.
    if exists (select 1 from platform_payments where provider = 'mercadopago' and external_id = v_ref) then
      raise exception 'duplicate_payment' using errcode = '23505';
    end if;
  end if;

  perform platform_lock_tenant(p_tenant);
  v_before := platform_tenant_balance(p_tenant);

  insert into billing_records (tenant_id, amount, currency, medium, receipt_ref, notes, recorded_by, paid_at)
  values (p_tenant, p_amount_cents / 100.0, 'ARS', v_medium, v_ref, v_reason, auth.uid(),
          (v_paid_on::timestamp + interval '12 hours') at time zone 'America/Argentina/Buenos_Aires')
  returning id into v_br;

  select payment_id into v_pay from platform_ingest_log where billing_record_id = v_br;
  if v_pay is null then
    raise exception 'ledger_ingest_failed' using errcode = 'P0001';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, auth.uid(), 'platform_payment', v_pay, 'platform_payment_registered',
          jsonb_build_object('balance_cents', v_before),
          jsonb_build_object('balance_cents', platform_tenant_balance(p_tenant), 'amount_cents', p_amount_cents,
                             'method', p_method, 'paid_on', v_paid_on, 'reference', v_ref, 'role', v_role),
          v_reason);
  return v_pay;
end;
$$;

-- Bonificación (crédito a cuenta) con motivo y tope por nivel. Se imputa FIFO
-- a la deuda más vieja; si no hay deuda queda como saldo a favor.
create or replace function internal_billing_bonus(
  p_tenant       uuid,
  p_amount_cents bigint,
  p_reason       text,
  p_request_id   uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := platform_assert_billing_operator();
  v_reason text := platform_assert_reason(p_reason);
  v_key    text := 'bonus:' || coalesce(p_request_id, gen_random_uuid())::text;
  v_mov    uuid;
  v_before bigint;
begin
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 100000000000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  select id into v_mov from platform_ledger where idempotency_key = v_key;
  if v_mov is not null then
    return v_mov;
  end if;

  perform platform_lock_tenant(p_tenant);
  perform platform_assert_forgiveness_cap(p_tenant, p_amount_cents);
  v_before := platform_tenant_balance(p_tenant);

  v_mov := platform_post_movement(p_tenant, 'bonus_credit', -p_amount_cents, platform_ar_date(now()), null,
                                  'Bonificación', v_reason, null, null, null, v_key, auth.uid());
  perform platform_auto_allocate(p_tenant, auth.uid());

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, auth.uid(), 'platform_ledger', v_mov, 'platform_bonus_granted',
          jsonb_build_object('balance_cents', v_before),
          jsonb_build_object('balance_cents', platform_tenant_balance(p_tenant), 'amount_cents', p_amount_cents, 'role', v_role),
          v_reason);
  return v_mov;
end;
$$;

-- Ajuste al debe: un cargo puntual con descripción y vencimiento.
create or replace function internal_billing_add_charge(
  p_tenant       uuid,
  p_amount_cents bigint,
  p_description  text,
  p_due_date     date,
  p_reason       text,
  p_request_id   uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := platform_assert_billing_operator();
  v_reason text := platform_assert_reason(p_reason);
  v_desc   text := btrim(coalesce(p_description, ''));
  v_today  date := platform_ar_date(now());
  v_sub    uuid;
  v_id     uuid;
  v_before bigint;
begin
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 100000000000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if length(v_desc) < 3 or length(v_desc) > 140 then
    raise exception 'invalid_description' using errcode = '22023';
  end if;
  if p_due_date is not null and (p_due_date < v_today - 30 or p_due_date > v_today + 365) then
    raise exception 'invalid_due_date' using errcode = '22023';
  end if;

  perform platform_lock_tenant(p_tenant);
  v_before := platform_tenant_balance(p_tenant);
  select id into v_sub from subscriptions where tenant_id = p_tenant;
  v_id := platform_create_charge(
    p_tenant, v_sub, 'adjustment', v_desc, null, null, coalesce(p_due_date, v_today),
    jsonb_build_array(jsonb_build_object('source', 'manual', 'description', v_desc, 'amount_cents', p_amount_cents)),
    'manual:' || coalesce(p_request_id, gen_random_uuid())::text, auth.uid(), 'staff', v_reason);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, auth.uid(), 'platform_charge', v_id, 'platform_adjustment_charged',
          jsonb_build_object('balance_cents', v_before),
          jsonb_build_object('balance_cents', platform_tenant_balance(p_tenant), 'amount_cents', p_amount_cents,
                             'description', v_desc, 'due_date', coalesce(p_due_date, v_today), 'role', v_role),
          v_reason);
  return v_id;
end;
$$;

-- Anular un cargo: libera lo que se le había imputado (vuelve a saldo a favor
-- y se reimputa FIFO) y registra el haber compensatorio. Cuenta en el tope.
create or replace function internal_billing_void_charge(p_charge uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := platform_assert_billing_operator();
  v_reason text := platform_assert_reason(p_reason);
  v_charge platform_charges%rowtype;
  v_debit  platform_ledger%rowtype;
  v_void   uuid;
  v_before bigint;
begin
  select * into v_charge from platform_charges where id = p_charge;
  if not found then
    raise exception 'charge_not_found' using errcode = 'P0002';
  end if;
  if v_charge.voided_at is not null or v_charge.status in ('voided', 'written_off') then
    raise exception 'charge_already_voided' using errcode = '22023';
  end if;

  perform platform_lock_tenant(v_charge.tenant_id);
  perform platform_assert_forgiveness_cap(v_charge.tenant_id, v_charge.total_cents);
  v_before := platform_tenant_balance(v_charge.tenant_id);

  select * into v_debit from platform_ledger where charge_id = p_charge and kind = 'charge';
  if v_debit.id is not null then
    update platform_allocations
       set released_at = now(), released_by = auth.uid(), release_reason = 'Anulación del cargo: ' || v_reason
     where debit_movement_id = v_debit.id and released_at is null;
    v_void := platform_post_movement(v_charge.tenant_id, 'charge_void', -v_debit.amount_cents, platform_ar_date(now()), null,
                                     'Anulación: ' || v_charge.description, v_reason, p_charge, null, v_debit.id,
                                     'void:' || p_charge::text, auth.uid());
    insert into platform_allocations (tenant_id, credit_movement_id, debit_movement_id, amount_cents, created_by)
    values (v_charge.tenant_id, v_void, v_debit.id, v_debit.amount_cents, auth.uid());
  end if;

  update platform_charges
     set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
   where id = p_charge;
  perform platform_auto_allocate(v_charge.tenant_id, auth.uid());

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_charge.tenant_id, auth.uid(), 'platform_charge', p_charge, 'platform_charge_voided',
          jsonb_build_object('balance_cents', v_before, 'status', v_charge.status, 'total_cents', v_charge.total_cents),
          jsonb_build_object('balance_cents', platform_tenant_balance(v_charge.tenant_id), 'status', 'voided', 'role', v_role),
          v_reason);
end;
$$;

-- Revertir un pago (contracargo o reintegro): libera sus imputaciones (los
-- cargos vuelven a deberse) y registra el debe compensatorio.
create or replace function internal_billing_reverse_payment(p_payment uuid, p_kind text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role    text := platform_assert_billing_operator();
  v_reason  text := platform_assert_reason(p_reason);
  v_pay     platform_payments%rowtype;
  v_credit  platform_ledger%rowtype;
  v_rev     uuid;
  v_kind    text;
  v_before  bigint;
  v_charges uuid[];
  v_c       uuid;
begin
  if p_kind not in ('chargeback', 'refund') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  select * into v_pay from platform_payments where id = p_payment;
  if not found then
    raise exception 'payment_not_found' using errcode = 'P0002';
  end if;
  if v_pay.status <> 'approved' then
    raise exception 'payment_not_reversible' using errcode = '22023';
  end if;

  perform platform_lock_tenant(v_pay.tenant_id);
  v_before := platform_tenant_balance(v_pay.tenant_id);
  select * into v_credit from platform_ledger where payment_id = p_payment and kind = 'payment';
  if v_credit.id is null then
    raise exception 'payment_without_movement' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct l.charge_id) filter (where l.charge_id is not null), '{}')
    into v_charges
    from platform_allocations a
    join platform_ledger l on l.id = a.debit_movement_id
   where a.credit_movement_id = v_credit.id and a.released_at is null;

  update platform_allocations
     set released_at = now(), released_by = auth.uid(),
         release_reason = case p_kind when 'chargeback' then 'Contracargo: ' else 'Reintegro: ' end || v_reason
   where credit_movement_id = v_credit.id and released_at is null;

  v_kind := case p_kind when 'chargeback' then 'payment_reversal' else 'refund' end;
  v_rev := platform_post_movement(v_pay.tenant_id, v_kind, v_pay.amount_cents, platform_ar_date(now()), platform_ar_date(now()),
                                  case p_kind when 'chargeback' then 'Contracargo del pago' else 'Reintegro del pago' end,
                                  v_reason, null, p_payment, v_credit.id, 'rev:' || p_payment::text, auth.uid());
  insert into platform_allocations (tenant_id, credit_movement_id, debit_movement_id, amount_cents, created_by)
  values (v_pay.tenant_id, v_credit.id, v_rev, v_pay.amount_cents, auth.uid());

  update platform_payments
     set status = case p_kind when 'chargeback' then 'charged_back' else 'refunded' end
   where id = p_payment;

  foreach v_c in array v_charges loop
    perform platform_refresh_charge_status(v_c);
  end loop;
  perform platform_auto_allocate(v_pay.tenant_id, auth.uid());

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_pay.tenant_id, auth.uid(), 'platform_payment', p_payment, 'platform_payment_reversed',
          jsonb_build_object('balance_cents', v_before, 'status', 'approved'),
          jsonb_build_object('balance_cents', platform_tenant_balance(v_pay.tenant_id), 'kind', p_kind,
                             'amount_cents', v_pay.amount_cents, 'role', v_role),
          v_reason);
  return v_rev;
end;
$$;

-- Condiciones de cobro del negocio: modalidad y plazo. admin o super_admin
-- (Cobranzas no administra negocios); marcar exento, sólo super_admin.
create or replace function internal_billing_set_terms(
  p_tenant        uuid,
  p_billing_mode  text,
  p_exempt_reason text,
  p_due_days      int,
  p_reason        text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text := platform_staff_billing_role();
  v_reason text := platform_assert_reason(p_reason);
  v_before jsonb;
  v_after  jsonb;
begin
  if v_role is null or v_role not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_billing_mode is not null and p_billing_mode not in ('mp_subscription', 'account', 'manual', 'exempt') then
    raise exception 'invalid_billing_mode' using errcode = '22023';
  end if;
  if p_billing_mode = 'exempt' and v_role <> 'super_admin' then
    raise exception 'forbidden_exempt' using errcode = '42501';
  end if;
  if p_billing_mode = 'exempt' and length(btrim(coalesce(p_exempt_reason, ''))) < 5 then
    raise exception 'exempt_reason_required' using errcode = '22023';
  end if;
  if p_due_days is not null and (p_due_days < 0 or p_due_days > 60) then
    raise exception 'invalid_due_days' using errcode = '22023';
  end if;
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;

  select to_jsonb(bt) - 'id' into v_before from tenant_billing_terms bt where bt.tenant_id = p_tenant;

  insert into tenant_billing_terms (tenant_id, billing_mode, exempt_reason, due_days, created_by, updated_by)
  values (p_tenant, p_billing_mode, case when p_billing_mode = 'exempt' then btrim(p_exempt_reason) end, p_due_days,
          auth.uid(), auth.uid())
  on conflict (tenant_id) do update
     set billing_mode = excluded.billing_mode,
         exempt_reason = excluded.exempt_reason,
         due_days = excluded.due_days,
         updated_by = auth.uid();

  select to_jsonb(bt) - 'id' into v_after from tenant_billing_terms bt where bt.tenant_id = p_tenant;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, auth.uid(), 'tenant_billing_terms', p_tenant, 'tenant_billing_terms_set', v_before, v_after, v_reason);
end;
$$;

-- -----------------------------------------------------------------------------
-- D) Configuración (super_admin)
-- -----------------------------------------------------------------------------
create or replace function internal_billing_set_caps(
  p_level               text,
  p_per_operation_cents bigint,
  p_per_month_cents     bigint,
  p_reason              text
)
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
  if p_level not in ('cobranzas', 'admin', 'super_admin') then
    raise exception 'invalid_level' using errcode = '22023';
  end if;
  if (p_per_operation_cents is not null and p_per_operation_cents < 0)
     or (p_per_month_cents is not null and p_per_month_cents < 0)
     or (p_per_operation_cents is not null and p_per_month_cents is not null and p_per_operation_cents > p_per_month_cents) then
    raise exception 'invalid_caps' using errcode = '22023';
  end if;

  select to_jsonb(c) into v_before from platform_billing_caps c where c.level = p_level;
  insert into platform_billing_caps (level, per_operation_cents, per_month_cents, updated_at, updated_by)
  values (p_level, p_per_operation_cents, p_per_month_cents, now(), auth.uid())
  on conflict (level) do update
     set per_operation_cents = excluded.per_operation_cents,
         per_month_cents = excluded.per_month_cents,
         updated_at = now(),
         updated_by = auth.uid();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (null, auth.uid(), 'platform_billing_caps', null, 'platform_billing_caps_set', v_before,
          jsonb_build_object('level', p_level, 'per_operation_cents', p_per_operation_cents, 'per_month_cents', p_per_month_cents),
          v_reason);
end;
$$;

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
  if p_permission not in ('cobranzas') then
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

create or replace function internal_list_staff_permissions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if platform_staff_billing_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'permission', p.permission, 'granted_at', p.created_at)
                     order by p.created_at)
      from platform_staff_permissions p
     where p.revoked_at is null), '[]'::jsonb);
end;
$$;

-- Marca de negocio interno o de prueba (super_admin, con motivo).
create or replace function internal_set_tenant_test(p_tenant uuid, p_is_test boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := platform_assert_reason(p_reason);
  v_old    boolean;
begin
  if platform_staff_billing_role() is distinct from 'super_admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select is_test into v_old from tenants where id = p_tenant;
  if not found then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  if v_old = coalesce(p_is_test, false) then
    return;
  end if;
  update tenants set is_test = coalesce(p_is_test, false) where id = p_tenant;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, auth.uid(), 'tenants', p_tenant, 'tenant_test_flag_set',
          jsonb_build_object('is_test', v_old), jsonb_build_object('is_test', coalesce(p_is_test, false)), v_reason);
end;
$$;

-- Negocios que no cuentan en los KPIs ni se cobran (§22 #7), con el motivo.
create or replace function internal_billing_exclusions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if platform_staff_billing_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('tenant_id', x.id, 'reason', x.reason, 'is_test', x.is_test) order by x.id)
      from (select t.id, t.is_test, platform_billing_exclusion(t.id) as reason
              from tenants t
             where t.deleted_at is null) x
     where x.reason is not null), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- E) Grants
-- -----------------------------------------------------------------------------
revoke all on function platform_staff_billing_role() from public, anon;
revoke all on function platform_assert_billing_operator() from public, anon, authenticated;
revoke all on function platform_assert_reason(text) from public, anon, authenticated;
revoke all on function platform_assert_forgiveness_cap(uuid, bigint) from public, anon, authenticated;
grant execute on function platform_staff_billing_role() to authenticated;

do $grants$
declare
  f text;
begin
  foreach f in array array[
    'internal_my_billing_access()',
    'internal_billing_statement(uuid)',
    'my_billing_statement()',
    'internal_billing_overview()',
    'internal_billing_register_payment(uuid, bigint, text, date, text, text)',
    'internal_billing_bonus(uuid, bigint, text, uuid)',
    'internal_billing_add_charge(uuid, bigint, text, date, text, uuid)',
    'internal_billing_void_charge(uuid, text)',
    'internal_billing_reverse_payment(uuid, text, text)',
    'internal_billing_set_terms(uuid, text, text, int, text)',
    'internal_billing_set_caps(text, bigint, bigint, text)',
    'internal_set_staff_permission(uuid, text, boolean, text)',
    'internal_list_staff_permissions()',
    'internal_set_tenant_test(uuid, boolean, text)',
    'internal_billing_exclusions()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$grants$;
