-- =============================================================================
-- 20261017120000_propiedad_caja  (F17 · H114 + H116 · ADR-051)
--
-- Cada usuario opera sólo SU turno de caja. El dueño puede vender en cualquier
-- sucursal pero abriendo su propia caja; nadie vende, retira ni cierra en el
-- turno de otro; un supervisor cierra un turno ajeno sólo con cierre forzado
-- (PIN o sesión de supervisor, motivo y auditoría).
--
--   A) assert_shift_owner(turno, acción). Con security_settings.shared_shift
--      (caja compartida) cualquiera habilitado en la sucursal VENDE en el turno
--      abierto; retiros, ingresos y cierre siguen siendo del dueño del turno.
--   B) resolve_sale_shift (copia de 20261013120000): exige personal operativo
--      y dueño del turno; deja de inferir turnos ajenos. La usan create_sale,
--      return_sale, return_sale_v2, exchange_sale y account_open_shift: no se
--      recrea ninguna de ellas.
--   C) open_cash_shift (copia de 20261013120000): personal operativo y un solo
--      turno abierto por usuario en todo el negocio.
--   D) Guardas por trigger (distinguen cliente de RPC por current_user, como
--      20261012120000):
--        · cash_shifts: sin INSERT/DELETE desde el cliente; el cierre (open →
--          closed) sólo del dueño del turno o por cash_force_close; sin
--          reabrir ni tocar montos o identidad desde el cliente.
--        · cash_movements: desde el cliente sólo ingreso o retiro en el turno
--          propio y abierto (con PIN si la política lo pide) o el
--          contramovimiento de una anulación real del mismo turno; nunca
--          UPDATE ni DELETE.
--   E) cash_force_close(turno, monto contado, motivo).
--   F) PIN por política en anulación (sales), descuento general (sales) y
--      devolución (sale_returns), con el token del header (migración 110000).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Dueño del turno
-- -----------------------------------------------------------------------------
create or replace function shift_owner_ok(p_shift_id uuid, p_action text default 'sell')
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_shift  record;
begin
  if auth.uid() is null then return true; end if;
  select cs.id, cs.opened_by, cs.status, cs.store_id into v_shift
    from cash_shifts cs
   where cs.id = p_shift_id and cs.tenant_id = v_tenant;
  if v_shift.id is null or v_shift.status <> 'open' then return false; end if;
  if v_shift.opened_by = auth.uid() then return true; end if;
  if p_action = 'sell' and (security_effective(v_tenant)).shared_shift
     and user_can_access_store(v_shift.store_id) then
    return true;
  end if;
  return false;
end;
$$;
revoke all on function shift_owner_ok(uuid, text) from public, anon;
grant execute on function shift_owner_ok(uuid, text) to authenticated;

create or replace function assert_shift_owner(p_shift_id uuid, p_action text default 'sell')
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  select status into v_status from cash_shifts
   where id = p_shift_id and tenant_id = current_tenant_id();
  if v_status is null then raise exception 'shift_not_found'; end if;
  if v_status <> 'open' then raise exception 'shift_not_open'; end if;
  if not shift_owner_ok(p_shift_id, p_action) then
    raise exception 'shift_not_owned' using errcode = '42501';
  end if;
end;
$$;
revoke all on function assert_shift_owner(uuid, text) from public, anon;
grant execute on function assert_shift_owner(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- B) resolve_sale_shift: copia de 20261013120000 + personal operativo + dueño
--    del turno. Cambios marcados con "H114".
-- -----------------------------------------------------------------------------
create or replace function resolve_sale_shift(
  p_cash_shift_id uuid default null,
  p_strict        boolean default true,
  out o_shift_id  uuid,
  out o_store_id  uuid
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_live    int;
  v_allowed uuid[];
  v_status  text;
  v_nstores int;
  v_shared  boolean;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  -- H113: suspendido, de licencia o dado de baja no vende ni devuelve.
  perform assert_staff_operational();
  v_shared := (security_effective(v_tenant)).shared_shift;

  -- 1) Turno explícito.
  if p_cash_shift_id is not null then
    select cs.id, cs.store_id, cs.status into o_shift_id, o_store_id, v_status
      from cash_shifts cs
     where cs.id = p_cash_shift_id and cs.tenant_id = v_tenant;
    if o_shift_id is null then
      if p_strict then raise exception 'shift_not_found'; end if;
    elsif v_status <> 'open' then
      if p_strict then raise exception 'shift_not_open'; end if;
      o_shift_id := null; o_store_id := null;
    elsif not user_can_access_store(o_store_id) then
      if p_strict then raise exception 'store_not_allowed'; end if;
      o_shift_id := null; o_store_id := null;
    elsif not shift_owner_ok(o_shift_id, 'sell') then
      -- H114: nadie vende en el turno de otro (salvo caja compartida).
      if p_strict then raise exception 'shift_not_owned' using errcode = '42501'; end if;
      o_shift_id := null; o_store_id := null;
    else
      return;
    end if;
  end if;

  select count(*) into v_live from stores where tenant_id = v_tenant and deleted_at is null;

  -- 2) Una sola sucursal viva: su turno propio (H114) o, con caja compartida,
  --    el último abierto (criterio histórico).
  if v_live <= 1 then
    select s.id into o_store_id
      from stores s
     where s.tenant_id = v_tenant and s.deleted_at is null
     order by s.is_default desc, s.created_at
     limit 1;
    if o_store_id is not null then
      select cs.id into o_shift_id
        from cash_shifts cs
       where cs.tenant_id = v_tenant and cs.status = 'open' and cs.store_id = o_store_id
         and (cs.opened_by = auth.uid() or v_shared or auth.uid() is null)
       order by (cs.opened_by = auth.uid()) desc, cs.opened_at desc
       limit 1;
    end if;
    return;
  end if;

  -- 3) Varias sucursales: inferencia segura.
  v_allowed := user_allowed_store_ids();

  select cs.id, cs.store_id into o_shift_id, o_store_id
    from cash_shifts cs
   where cs.tenant_id = v_tenant and cs.status = 'open'
     and cs.opened_by = auth.uid()
     and cs.store_id = any (v_allowed)
   order by cs.opened_at desc
   limit 1;
  if o_shift_id is not null then return; end if;

  -- H114: sin turno propio, un turno ajeno sólo con caja compartida.
  if v_shared then
    select count(distinct cs.store_id) into v_nstores
      from cash_shifts cs
     where cs.tenant_id = v_tenant and cs.status = 'open' and cs.store_id = any (v_allowed);

    if v_nstores = 1 then
      select cs.id, cs.store_id into o_shift_id, o_store_id
        from cash_shifts cs
       where cs.tenant_id = v_tenant and cs.status = 'open' and cs.store_id = any (v_allowed)
       order by cs.opened_at desc
       limit 1;
      return;
    end if;

    if v_nstores > 1 and p_strict then
      raise exception 'shift_ambiguous';
    end if;
  end if;

  -- Sin turno: si el usuario opera en una sola sucursal, esa es la sucursal.
  if cardinality(v_allowed) = 1 then
    o_store_id := v_allowed[1];
  end if;
end;
$$;
revoke all on function resolve_sale_shift(uuid, boolean) from public, anon;
grant execute on function resolve_sale_shift(uuid, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- C) open_cash_shift: copia de 20261013120000 + personal operativo + un turno
--    abierto por usuario (H114).
-- -----------------------------------------------------------------------------
create or replace function open_cash_shift(
  p_register_id uuid,
  p_opening_amount numeric
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_shift_id uuid;
  v_reg      record;
begin
  -- BUG A: no se opera con la cuenta bloqueada por falta de pago.
  perform assert_account_active(v_tenant);
  -- H113: suspendido, de licencia o dado de baja no abre caja.
  perform assert_staff_operational();

  -- F17 · H89/H91: la caja tiene que ser del negocio, estar activa, en una
  -- sucursal activa y en la que el usuario pueda operar.
  select cr.id, cr.is_active, cr.deleted_at, s.id as store_id,
         s.is_active as store_active, s.deleted_at as store_deleted
    into v_reg
    from cash_registers cr
    join stores s on s.id = cr.store_id
   where cr.id = p_register_id and cr.tenant_id = v_tenant;
  if not found or v_reg.deleted_at is not null or v_reg.store_deleted is not null then
    raise exception 'register_not_found';
  end if;
  if not v_reg.is_active then raise exception 'register_inactive'; end if;
  if not v_reg.store_active then raise exception 'store_paused'; end if;
  if not user_can_access_store(v_reg.store_id) then raise exception 'store_not_allowed'; end if;

  -- Un turno abierto por caja (lock para dos aperturas simultáneas).
  perform pg_advisory_xact_lock(hashtext('open_shift:' || p_register_id::text));
  if exists (
    select 1 from cash_shifts
    where cash_register_id = p_register_id
      and tenant_id = v_tenant
      and status = 'open'
  ) then
    raise exception 'shift_already_open';
  end if;

  -- H114: un turno abierto por usuario en todo el negocio.
  perform pg_advisory_xact_lock(hashtext('open_shift_user:' || v_tenant::text || ':' || coalesce(auth.uid()::text, '')));
  if auth.uid() is not null and exists (
    select 1 from cash_shifts
     where tenant_id = v_tenant and status = 'open' and opened_by = auth.uid()
  ) then
    raise exception 'user_has_open_shift';
  end if;

  insert into cash_shifts (cash_register_id, opening_amount, status)
  values (p_register_id, p_opening_amount, 'open')
  returning id into v_shift_id;

  return v_shift_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- D) Guardas
-- -----------------------------------------------------------------------------
-- SECURITY INVOKER a propósito: current_user es 'authenticated' en un acceso
-- directo por REST y el dueño de la función dentro de una RPC SECURITY DEFINER.
create or replace function trg_cash_shifts_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    if v_client then raise exception 'use_open_cash_shift' using errcode = '42501'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if v_client then raise exception 'shift_immutable' using errcode = '42501'; end if;
    return old;
  end if;

  -- Cierre: sólo el dueño del turno o el cierre forzado (marca de transacción).
  if old.status = 'open' and new.status = 'closed' then
    if auth.uid() is not null
       and old.opened_by is distinct from auth.uid()
       and coalesce(current_setting('ninja.force_close_shift', true), '') <> old.id::text then
      raise exception 'shift_not_owned' using errcode = '42501';
    end if;
    return new;
  end if;

  if v_client then
    if old.status = 'closed' and new.status = 'open' then
      raise exception 'shift_immutable' using errcode = '42501';
    end if;
    if new.opening_amount is distinct from old.opening_amount
       or new.opened_by is distinct from old.opened_by
       or new.opened_at is distinct from old.opened_at
       or new.cash_register_id is distinct from old.cash_register_id
       or new.tenant_id is distinct from old.tenant_id
       or (old.status = 'closed' and (new.closing_amount is distinct from old.closing_amount
                                      or new.expected_amount is distinct from old.expected_amount
                                      or new.closed_by is distinct from old.closed_by
                                      or new.closed_at is distinct from old.closed_at)) then
      raise exception 'shift_immutable' using errcode = '42501';
    end if;
    if old.status = 'open' and old.opened_by is distinct from auth.uid() then
      raise exception 'shift_not_owned' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists cash_shifts_guard on cash_shifts;
create trigger cash_shifts_guard
  before insert or update or delete on cash_shifts
  for each row execute function trg_cash_shifts_guard();

create or replace function trg_cash_movements_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
  v_shift  record;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if v_client then raise exception 'cash_movement_immutable' using errcode = '42501'; end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if not v_client then
    return new;
  end if;

  select cs.id, cs.status, cs.opened_by, cs.tenant_id into v_shift
    from cash_shifts cs
   where cs.id = new.cash_shift_id;
  if v_shift.id is null or v_shift.tenant_id is distinct from current_tenant_id() then
    raise exception 'shift_not_found';
  end if;

  if new.type in ('income', 'expense') then
    if coalesce(new.amount, 0) <= 0 then raise exception 'invalid_amount'; end if;
    if v_shift.status <> 'open' then raise exception 'shift_not_open'; end if;
    perform assert_staff_operational();
    -- Retiros e ingresos: sólo en el turno propio (aun con caja compartida).
    if auth.uid() is not null and v_shift.opened_by is distinct from auth.uid() then
      raise exception 'shift_not_owned' using errcode = '42501';
    end if;
    -- exchange_sale (SECURITY INVOKER) paga el sobrante de un cambio con un
    -- retiro atado a la devolución creada en esta misma transacción: lo cubre
    -- la política de devoluciones, no la de retiros.
    if new.type = 'expense' and exists (
      select 1 from sale_returns r
       where r.id = new.reference_id and r.tenant_id = current_tenant_id() and r.created_at = now()
    ) then
      return new;
    end if;
    perform require_supervisor(case when new.type = 'expense' then 'cash_out' else 'cash_in' end,
                               new.amount, new.cash_shift_id);
    return new;
  end if;

  if new.type = 'sale_void' then
    -- Contramovimiento de void_sale (SECURITY INVOKER): la venta tiene que
    -- estar anulada y ser de ese turno.
    if not exists (
      select 1 from sales s
       where s.id = new.reference_id
         and s.tenant_id = current_tenant_id()
         and s.status = 'voided'
         and s.cash_shift_id = new.cash_shift_id
    ) then
      raise exception 'cash_movement_forbidden' using errcode = '42501';
    end if;
    return new;
  end if;

  raise exception 'cash_movement_forbidden' using errcode = '42501';
end;
$$;

drop trigger if exists cash_movements_guard on cash_movements;
create trigger cash_movements_guard
  before insert or update or delete on cash_movements
  for each row execute function trg_cash_movements_guard();

-- -----------------------------------------------------------------------------
-- E) Cierre forzado de un turno ajeno
-- -----------------------------------------------------------------------------
create or replace function cash_force_close(
  p_shift_id       uuid,
  p_closing_amount numeric,
  p_reason         text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_shift  record;
  v_sup    uuid;
  v_diff   numeric;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if v_reason is null or length(v_reason) < 3 then raise exception 'reason_required'; end if;
  if p_closing_amount is null or p_closing_amount < 0 then raise exception 'invalid_amount'; end if;
  perform assert_staff_operational();

  select cs.id, cs.status, cs.opened_by, cs.store_id, cs.cash_register_id, cs.opened_at
    into v_shift
    from cash_shifts cs
   where cs.id = p_shift_id and cs.tenant_id = v_tenant
   for update;
  if v_shift.id is null then raise exception 'shift_not_found'; end if;
  if v_shift.status <> 'open' then raise exception 'shift_not_open'; end if;
  if not user_can_access_store(v_shift.store_id) then raise exception 'store_not_allowed'; end if;

  v_sup := require_supervisor('shift_force_close', null, p_shift_id);

  perform set_config('ninja.force_close_shift', p_shift_id::text, true);
  v_diff := close_cash_shift(p_shift_id, p_closing_amount, 'Cierre forzado: ' || v_reason);
  perform set_config('ninja.force_close_shift', '', true);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data, store_id)
  values (v_tenant, auth.uid(), 'cash_shifts', p_shift_id, 'cash_shift_force_closed', v_reason,
          jsonb_build_object('opened_by', v_shift.opened_by, 'opened_at', v_shift.opened_at,
                             'cash_register_id', v_shift.cash_register_id, 'store_id', v_shift.store_id,
                             'supervisor_id', v_sup, 'closing_amount', p_closing_amount,
                             'difference', v_diff),
          v_shift.store_id);
  return jsonb_build_object('ok', true, 'difference', v_diff, 'supervisor_id', v_sup);
end;
$$;
revoke all on function cash_force_close(uuid, numeric, text) from public, anon;
grant execute on function cash_force_close(uuid, numeric, text) to authenticated;

-- -----------------------------------------------------------------------------
-- F) PIN por política en ventas y devoluciones
-- -----------------------------------------------------------------------------
create or replace function trg_sales_supervisor()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_manual numeric;
begin
  if tg_op = 'INSERT' then
    -- Descuento general manual (sin promociones ni cupones) sobre el subtotal.
    if coalesce(new.subtotal, 0) > 0 then
      v_manual := greatest(coalesce(new.discount_total, 0)
                           - coalesce(new.promo_discount, 0)
                           - coalesce(new.coupon_discount, 0), 0);
      if v_manual > 0 then
        perform require_supervisor('discount_over', round(v_manual / new.subtotal * 100, 2), new.id);
      end if;
    end if;
    return new;
  end if;
  if old.status = 'completed' and new.status = 'voided' then
    perform require_supervisor('sale_void', old.total, old.id);
  end if;
  return new;
end;
$$;

drop trigger if exists sales_supervisor on sales;
create trigger sales_supervisor
  before insert or update of status on sales
  for each row execute function trg_sales_supervisor();

create or replace function trg_sale_returns_supervisor()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform require_supervisor('sale_return', coalesce(new.total, 0), new.sale_id);
  return new;
end;
$$;

drop trigger if exists sale_returns_supervisor on sale_returns;
create trigger sale_returns_supervisor
  before insert on sale_returns
  for each row execute function trg_sale_returns_supervisor();
