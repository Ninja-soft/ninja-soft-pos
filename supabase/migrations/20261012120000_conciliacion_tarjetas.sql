-- =============================================================================
-- 20261012120000_conciliacion_tarjetas  (Conciliación de tarjetas v1 · ADR-044)
--
-- El dueño o el encargado marcan como conciliados los cobros con tarjeta
-- (débito / crédito) contra la liquidación del adquirente, agrupados por día,
-- número de comercio y lote (datos de payments.card_voucher).
--
-- Qué hace:
--  A) payments.reconciled_at / reconciled_by (null = pendiente).
--  B) Guard: esas dos columnas sólo cambian por la RPC (el UPDATE directo que
--     permite la policy de aislamiento queda bloqueado para authenticated/anon).
--  C) RPC set_payments_reconciled(p_payment_ids, p_reconciled): SECURITY
--     DEFINER, verifica tenant, rol (owner / manager), plan
--     (tenant_has_feature_for 'conciliacion_tarjetas'), que todos los pagos
--     sean del tenant y de tarjeta, y escribe audit_logs.
--  D) Feature de plan `conciliacion_tarjetas` (OPTIONAL, grupo reportes) y su
--     marca en plans.limits.modules: Pro, Business y Enterprise.
--
-- La lectura es un SELECT común sobre payments + sales con RLS (aislamiento
-- por tenant): el índice payments_tenant_method_idx (tenant_id, method,
-- created_at desc) ya cubre el filtro por medio y fecha.
--
-- Aditiva: no toca migraciones aplicadas. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Columnas
-- -----------------------------------------------------------------------------
alter table payments
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciled_by uuid references public.users(id);

comment on column payments.reconciled_at is
  'Conciliación de tarjetas: cuándo se marcó el cobro como conciliado con la liquidación del adquirente (null = pendiente). Sólo vía set_payments_reconciled.';
comment on column payments.reconciled_by is
  'Conciliación de tarjetas: usuario que marcó el cobro como conciliado.';

-- -----------------------------------------------------------------------------
-- B) Guard: la conciliación sólo cambia por la RPC
--    La policy payments_tenant_isolation es FOR ALL, así que cualquier miembro
--    podría hacer UPDATE directo. El trigger corre como el rol de la sentencia
--    (SECURITY INVOKER): dentro de la RPC (definer) el rol es el dueño de la
--    función; desde PostgREST es authenticated / anon y se rechaza.
-- -----------------------------------------------------------------------------
create or replace function trg_payments_reconcile_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (new.reconciled_at is distinct from old.reconciled_at
      or new.reconciled_by is distinct from old.reconciled_by)
     and current_user in ('authenticated', 'anon') then
    raise exception 'reconcile_only_by_rpc' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function trg_payments_reconcile_guard() from public, anon, authenticated;

drop trigger if exists payments_reconcile_guard on payments;
create trigger payments_reconcile_guard
  before update on payments
  for each row execute function trg_payments_reconcile_guard();

-- -----------------------------------------------------------------------------
-- C) RPC de escritura
--    Marca (p_reconciled = true) o desmarca (false) un conjunto de pagos de
--    tarjeta del tenant actual. Todo o nada: si algún id no es un pago de
--    tarjeta del tenant, no cambia nada. Sólo toca los que cambian de estado
--    (marcar dos veces no pisa la fecha ni el usuario originales).
--    Devuelve { updated, amount, reconciled_at }.
-- -----------------------------------------------------------------------------
create or replace function set_payments_reconciled(p_payment_ids uuid[], p_reconciled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_uid     uuid := auth.uid();
  v_now     timestamptz := now();
  v_ids     uuid[];
  v_found   int;
  v_changed uuid[];
  v_count   int;
  v_amount  numeric;
begin
  if v_uid is null or v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'conciliacion_tarjetas') then
    raise exception 'feature_not_in_plan: conciliacion_tarjetas' using errcode = '42501';
  end if;
  if p_reconciled is null then
    raise exception 'invalid_args';
  end if;

  select array_agg(distinct x) into v_ids
    from unnest(coalesce(p_payment_ids, '{}'::uuid[])) as x
   where x is not null;

  if v_ids is null then
    return jsonb_build_object('updated', 0, 'amount', 0, 'reconciled_at', null);
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'too_many_payments';
  end if;

  -- Todos deben ser pagos de tarjeta del tenant actual (aislamiento explícito:
  -- la función es definer y no pasa por RLS).
  select count(*) into v_found
    from payments p
   where p.id = any(v_ids)
     and p.tenant_id = v_tenant
     and p.method in ('debit', 'credit');
  if v_found <> cardinality(v_ids) then
    raise exception 'payment_not_found' using errcode = '42501';
  end if;

  with upd as (
    update payments p
       set reconciled_at = case when p_reconciled then v_now end,
           reconciled_by = case when p_reconciled then v_uid end
     where p.id = any(v_ids)
       and p.tenant_id = v_tenant
       and (p.reconciled_at is null) = p_reconciled
    returning p.id, p.amount
  )
  select coalesce(array_agg(upd.id), '{}'::uuid[]), count(*), coalesce(sum(upd.amount), 0)
    into v_changed, v_count, v_amount
    from upd;

  if v_count > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (
      v_tenant, v_uid, 'payments',
      case when v_count = 1 then v_changed[1] end,
      case when p_reconciled then 'payments_reconciled' else 'payments_unreconciled' end,
      jsonb_build_object('payment_ids', to_jsonb(v_changed), 'count', v_count, 'amount', v_amount)
    );
  end if;

  return jsonb_build_object(
    'updated', v_count,
    'amount', v_amount,
    'reconciled_at', case when p_reconciled then v_now end
  );
end;
$$;
revoke all on function set_payments_reconciled(uuid[], boolean) from public, anon;
grant execute on function set_payments_reconciled(uuid[], boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Feature de plan (convención CLAUDE.md, pasos 1 y 2)
--    OPTIONAL, grupo reportes, entre export_xlsx (170) y metricas_avanzadas (180).
--    Análisis comercial: control administrativo de los cobros con tarjeta, mismo
--    nivel que exportar a Excel (Pro+). Start no la trae.
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('conciliacion_tarjetas', 'Conciliación de tarjetas',
   'Conciliá los cobros con tarjeta por día, número de comercio y lote contra la liquidación del adquirente',
   'reportes', false, 175)
on conflict (key) do nothing;

-- Planes globales: Pro, Business y Enterprise.
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('conciliacion_tarjetas', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'conciliacion_tarjetas');

-- Planes a medida (por tenant): heredan el valor de export_xlsx (mismo nivel).
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object(
         'conciliacion_tarjetas',
         coalesce((p.limits -> 'modules' ->> 'export_xlsx')::boolean, false)
       ),
  true
)
where p.tenant_id is not null
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'conciliacion_tarjetas');
