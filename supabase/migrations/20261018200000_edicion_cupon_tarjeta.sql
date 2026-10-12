-- =============================================================================
-- 20261018200000_edicion_cupon_tarjeta  (Conciliación de tarjetas · ADR-044, adenda)
--
-- Corrección de la numeración del cupón de un cobro con tarjeta (lote, cupón,
-- autorización, últimos 4, n° de comercio y cuotas) desde /reportes/conciliacion.
--
-- Qué hace:
--  A) Tabla payment_voucher_edits: historial de ediciones (antes / después,
--     quién, cuándo, motivo, si el cobro ya estaba conciliado). Lectura por
--     tenant (internal_scope(), ADR-052); escritura sólo por la RPC.
--  B) RPC update_payment_voucher(p_payment_id, p_patch, p_reason):
--     SECURITY DEFINER con search_path fijo.
--       - Cobro de tarjeta (debit / credit) del tenant actual.
--       - Plan con conciliacion_tarjetas (mismo gating que la pantalla).
--       - Dueño o encargado: cualquier cobro. Cajero: sólo cobros de ventas de
--         un turno de caja que abrió él. Solo lectura: nunca.
--       - Cobro ya conciliado: sólo dueño o encargado; queda conciliado y la
--         edición se marca was_reconciled = true (la pantalla lo señala).
--       - Claves en lista blanca, valores validados y recortados; se mezcla en
--         payments.card_voucher sin tocar las demás claves (marca, etc.).
--       - Escribe payment_voucher_edits y audit_logs (antes / después).
--     No toca reconciled_* (el guard payments_reconcile_guard sigue igual).
--
-- Aditiva: no toca migraciones aplicadas. NO aplicada todavía.
-- Depende de 20261012120000_conciliacion_tarjetas y 20261013900000 (ADR-052).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Historial
-- -----------------------------------------------------------------------------
create table if not exists payment_voucher_edits (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  payment_id     uuid not null references payments(id) on delete cascade,
  edited_by      uuid references public.users(id),
  edited_by_name text,
  edited_at      timestamptz not null default now(),
  changed_keys   text[] not null,
  before_data    jsonb not null default '{}'::jsonb,
  after_data     jsonb not null default '{}'::jsonb,
  was_reconciled boolean not null default false,
  as_supervisor  boolean not null default false,
  reason         text
);

comment on table payment_voucher_edits is
  'Conciliación de tarjetas: historial de correcciones de payments.card_voucher. Sólo se escribe por update_payment_voucher.';

create index if not exists payment_voucher_edits_payment_idx
  on payment_voucher_edits (tenant_id, payment_id, edited_at desc);

alter table payment_voucher_edits enable row level security;

drop policy if exists payment_voucher_edits_select on payment_voucher_edits;
create policy payment_voucher_edits_select on payment_voucher_edits
  for select
  using (tenant_id = current_tenant_id() or internal_scope());

-- Sin policies de escritura: nadie inserta, edita ni borra desde PostgREST.
revoke insert, update, delete on payment_voucher_edits from anon, authenticated;
grant select on payment_voucher_edits to authenticated;

-- -----------------------------------------------------------------------------
-- B) RPC de edición
--    p_patch: objeto con alguna de las claves lote, cupon, autorizacion,
--    ultimos4, comercio, cuotas. null o "" borra la clave.
--    Devuelve { changed, card_voucher, edited_at, was_reconciled }.
-- -----------------------------------------------------------------------------
create or replace function update_payment_voucher(
  p_payment_id uuid,
  p_patch jsonb,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_uid      uuid := auth.uid();
  v_now      timestamptz := now();
  v_role     text;
  v_super    boolean;
  v_pay      record;
  v_own      boolean;
  v_key      text;
  v_raw      jsonb;
  v_txt      text;
  v_num      int;
  v_old      jsonb;
  v_new      jsonb;
  v_changed  text[] := '{}';
  v_before   jsonb := '{}'::jsonb;
  v_after    jsonb := '{}'::jsonb;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_name     text;
  c_keys constant text[] := array['lote', 'cupon', 'autorizacion', 'ultimos4', 'comercio', 'cuotas'];
begin
  if v_uid is null or v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;

  select tu.role into v_role
    from tenant_users tu
   where tu.tenant_id = v_tenant
     and tu.user_id = v_uid
     and tu.status = 'active'
   limit 1;
  if v_role is null or v_role not in ('owner', 'manager', 'cashier') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_super := v_role in ('owner', 'manager');

  if not tenant_has_feature_for(v_tenant, 'conciliacion_tarjetas') then
    raise exception 'feature_not_in_plan: conciliacion_tarjetas' using errcode = '42501';
  end if;

  if p_payment_id is null or p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'invalid_args';
  end if;
  if v_reason is not null and length(v_reason) > 300 then
    raise exception 'invalid_value: reason';
  end if;

  -- Lista blanca de claves.
  for v_key in select jsonb_object_keys(p_patch) loop
    if not (v_key = any(c_keys)) then
      raise exception 'invalid_key: %', v_key;
    end if;
  end loop;

  -- Aislamiento explícito (la función es definer y no pasa por RLS).
  select p.id, p.sale_id, p.amount, p.card_voucher, p.reconciled_at
    into v_pay
    from payments p
   where p.id = p_payment_id
     and p.tenant_id = v_tenant
     and p.method in ('debit', 'credit')
   for update;
  if not found then
    raise exception 'payment_not_found' using errcode = '42501';
  end if;

  if not v_super then
    select exists (
      select 1
        from sales s
        join cash_shifts cs on cs.id = s.cash_shift_id
       where s.id = v_pay.sale_id
         and s.tenant_id = v_tenant
         and cs.tenant_id = v_tenant
         and cs.opened_by = v_uid
    ) into v_own;
    if not v_own then
      raise exception 'not_own_shift' using errcode = '42501';
    end if;
    if v_pay.reconciled_at is not null then
      raise exception 'reconciled_locked' using errcode = '42501';
    end if;
  end if;

  v_old := case when jsonb_typeof(v_pay.card_voucher) = 'object' then v_pay.card_voucher else '{}'::jsonb end;
  v_new := v_old;

  for v_key, v_raw in select * from jsonb_each(p_patch) loop
    if v_raw is null or jsonb_typeof(v_raw) = 'null' then
      v_txt := null;
    elsif jsonb_typeof(v_raw) in ('string', 'number') then
      v_txt := nullif(btrim(v_raw #>> '{}'), '');
    else
      raise exception 'invalid_value: %', v_key;
    end if;

    if v_txt is not null then
      if v_key in ('lote', 'cupon', 'comercio', 'ultimos4') then
        v_txt := replace(v_txt, ' ', '');
      end if;
      if v_key = 'lote' and v_txt !~ '^[0-9]{1,10}$' then
        raise exception 'invalid_value: lote';
      elsif v_key = 'cupon' and v_txt !~ '^[0-9]{1,12}$' then
        raise exception 'invalid_value: cupon';
      elsif v_key = 'comercio' and v_txt !~ '^[0-9]{1,20}$' then
        raise exception 'invalid_value: comercio';
      elsif v_key = 'ultimos4' and v_txt !~ '^[0-9]{4}$' then
        raise exception 'invalid_value: ultimos4';
      elsif v_key = 'autorizacion' then
        v_txt := upper(v_txt);
        if v_txt !~ '^[A-Z0-9]{1,20}$' then
          raise exception 'invalid_value: autorizacion';
        end if;
      elsif v_key = 'cuotas' then
        if v_txt !~ '^[0-9]{1,2}$' then
          raise exception 'invalid_value: cuotas';
        end if;
        v_num := v_txt::int;
        if v_num < 1 or v_num > 99 then
          raise exception 'invalid_value: cuotas';
        end if;
      end if;
    end if;

    if v_txt is null then
      v_new := v_new - v_key;
    elsif v_key = 'cuotas' then
      v_new := v_new || jsonb_build_object('cuotas', v_num);
    else
      v_new := v_new || jsonb_build_object(v_key, v_txt);
    end if;

    if (v_new -> v_key) is distinct from (v_old -> v_key) then
      v_changed := v_changed || v_key;
      v_before := v_before || jsonb_build_object(v_key, v_old -> v_key);
      v_after := v_after || jsonb_build_object(v_key, v_new -> v_key);
    end if;
  end loop;

  if cardinality(v_changed) = 0 then
    return jsonb_build_object(
      'changed', false,
      'card_voucher', v_old,
      'edited_at', null,
      'was_reconciled', v_pay.reconciled_at is not null
    );
  end if;

  update payments
     set card_voucher = v_new
   where id = v_pay.id
     and tenant_id = v_tenant;

  select coalesce(nullif(btrim(u.full_name), ''), u.email) into v_name
    from public.users u
   where u.id = v_uid;

  insert into payment_voucher_edits (
    tenant_id, payment_id, edited_by, edited_by_name, edited_at, changed_keys,
    before_data, after_data, was_reconciled, as_supervisor, reason
  ) values (
    v_tenant, v_pay.id, v_uid, v_name, v_now, v_changed,
    v_before, v_after, v_pay.reconciled_at is not null, v_super, v_reason
  );

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (
    v_tenant, v_uid, 'payments', v_pay.id, 'payment_voucher_updated',
    jsonb_build_object('card_voucher', v_before),
    jsonb_build_object(
      'card_voucher', v_after,
      'changed_keys', to_jsonb(v_changed),
      'was_reconciled', v_pay.reconciled_at is not null,
      'as_supervisor', v_super,
      'amount', v_pay.amount
    ),
    v_reason
  );

  return jsonb_build_object(
    'changed', true,
    'card_voucher', v_new,
    'edited_at', v_now,
    'was_reconciled', v_pay.reconciled_at is not null
  );
end;
$$;
revoke all on function update_payment_voucher(uuid, jsonb, text) from public, anon;
grant execute on function update_payment_voucher(uuid, jsonb, text) to authenticated;
