-- =============================================================================
-- 20261031200000_permisos_por_rol  (ADR-071)
--
-- Auditoría de permisos por rol a nivel base (tests/integration/roles.test.ts).
-- Las tablas del núcleo (H1/H2: products, stock_movements, sales, payments,
-- cash_*, customers, categories, brands, ...) tienen una sola policy
-- "tenant_id = current_tenant_id()" para TODO: cualquier miembro activo del
-- negocio, incluido "Solo lectura", podía escribir por REST. Huecos contra la
-- matriz de docs/06-permissions-roles.md:
--
--   1. viewer (solo lectura) podía crear y editar productos, ajustar stock
--      (adjust_product_stock, register_stock_waste, register_production o un
--      INSERT directo en stock_movements), dar de alta y de baja clientes,
--      abrir un turno de caja (open_cash_shift) y vender, y anular ventas
--      (void_sale, SECURITY INVOKER, sin chequeo de rol).
--   2. cashier podía crear, editar y borrar productos, cambiar precios,
--      variantes, categorías y marcas, y ajustar stock a mano (mismas vías).
--   3. cashier podía dar de baja clientes (deleted_at) o borrarlos.
--   4. cashier podía anular ventas de días anteriores; cualquiera podía
--      cambiar sales.status por REST salteando la reversa de stock y caja.
--
-- Solución:
--   A) role_write_guard: trigger BEFORE INSERT/UPDATE/DELETE en las tablas
--      operativas. Toma el rol del usuario del JWT en el negocio de la fila:
--        * viewer: no escribe nunca (ni por REST ni a través de una RPC).
--        * cashier, por REST o RPC SECURITY INVOKER (current_user cliente):
--          no escribe catálogo ni stock (modo 'manage'), no da de baja
--          clientes (modo 'customers').
--        * nadie cambia sales.status por REST (modo 'sales'): se anula con
--          void_sale.
--      Sin auth.uid() (cron, service_role) o sin membresía (staff interno,
--      ya acotado por internal_scope en RLS) no aplica. Las RPC SECURITY
--      DEFINER (create_sale, return_sale, compras, traslados) siguen
--      moviendo stock en nombre del cajero: current_user no es cliente.
--   B) void_sale pasa a SECURITY DEFINER con chequeos explícitos: miembro
--      operativo, acceso a la sucursal de la venta y, para el cajero (rol
--      efectivo en la sucursal), sólo ventas del día (hora de Argentina).
--      Resto del cuerpo: copia de 20260530170000_fn_void_sale (la única
--      definición). El PIN por política (trigger sales_supervisor) no cambia.
--
-- No usa "OR is_internal()" en ninguna policy (ADR-052).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Rol del usuario del JWT en un negocio (activo). null si no es miembro.
-- -----------------------------------------------------------------------------
create or replace function member_role_in(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select tu.role from tenant_users tu
   where tu.tenant_id = p_tenant and tu.user_id = auth.uid() and tu.status = 'active'
   limit 1;
$$;
revoke all on function member_role_in(uuid) from public, anon;
grant execute on function member_role_in(uuid) to authenticated;

-- SECURITY INVOKER a propósito (como trg_cash_shifts_guard): current_user es
-- 'authenticated' en un acceso por REST o una RPC INVOKER, y el dueño de la
-- función dentro de una RPC SECURITY DEFINER.
create or replace function trg_role_write_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mode   text := coalesce(tg_argv[0], 'operate');
  v_row    jsonb;
  v_old    jsonb;
  v_tenant uuid;
  v_role   text;
  v_client boolean := current_user in ('authenticated', 'anon');
begin
  if auth.uid() is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  -- Todo por jsonb: el trigger se instala en tablas con columnas distintas
  -- y una referencia directa a new.status / new.deleted_at falla con 42703
  -- en las que no la tienen.
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
  else
    v_row := to_jsonb(new);
  end if;
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
  end if;
  v_tenant := coalesce(nullif(v_row ->> 'tenant_id', '')::uuid, current_tenant_id());
  v_role := member_role_in(v_tenant);

  if v_role = 'viewer' then
    raise exception 'forbidden_read_only' using errcode = '42501';
  end if;

  if v_mode = 'manage' and v_client and v_role = 'cashier' then
    raise exception 'forbidden_role' using errcode = '42501';
  end if;

  if v_mode = 'customers' and v_client and v_role = 'cashier' then
    if tg_op = 'DELETE'
       or (tg_op = 'UPDATE'
           and (v_row ->> 'deleted_at') is distinct from (v_old ->> 'deleted_at')) then
      raise exception 'forbidden_role' using errcode = '42501';
    end if;
  end if;

  if v_mode = 'sales' and v_client and tg_op = 'UPDATE'
     and (v_row ->> 'status') is distinct from (v_old ->> 'status') then
    raise exception 'use_void_sale' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function trg_role_write_guard() from public, anon;

do $$
declare
  r record;
begin
  for r in
    select * from (values
      -- Catálogo y stock: owner/manager (el cajero sólo vía RPC DEFINER).
      ('products', 'manage'),
      ('product_variants', 'manage'),
      ('categories', 'manage'),
      ('brands', 'manage'),
      ('stock_movements', 'manage'),
      -- Clientes: el cajero da de alta y edita, no da de baja.
      ('customers', 'customers'),
      -- Ventas: el estado cambia sólo por RPC.
      ('sales', 'sales'),
      -- Operación: cualquiera menos solo lectura.
      ('sale_items', 'operate'),
      ('payments', 'operate'),
      ('cash_shifts', 'operate'),
      ('cash_movements', 'operate'),
      ('cash_z_closures', 'operate'),
      ('sale_returns', 'operate'),
      ('sale_return_items', 'operate'),
      ('store_credit_movements', 'operate'),
      ('store_credit_vouchers', 'operate'),
      ('product_images', 'operate'),
      ('product_kit_components', 'operate'),
      ('product_modifier_groups', 'operate'),
      ('product_modifier_options', 'operate'),
      ('product_recipes', 'operate'),
      ('product_serials', 'operate'),
      ('appointments', 'operate'),
      ('professionals', 'operate'),
      ('service_packs', 'operate'),
      ('customer_pack_credits', 'operate'),
      ('dining_areas', 'operate'),
      ('dining_tables', 'operate'),
      ('dining_reservations', 'operate'),
      ('table_orders', 'operate'),
      ('table_order_items', 'operate'),
      ('delivery_orders', 'operate'),
      ('delivery_order_items', 'operate')
    ) as t(tbl, mode)
  loop
    if to_regclass('public.' || r.tbl) is null then
      continue;
    end if;
    execute format('drop trigger if exists role_write_guard on public.%I', r.tbl);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)',
      r.tbl, r.mode);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- B) void_sale: SECURITY DEFINER con chequeos de rol, sucursal y día.
--    Copia de 20260530170000_fn_void_sale (misma firma y efectos).
-- -----------------------------------------------------------------------------
create or replace function void_sale(
  p_sale_id uuid,
  p_reason  text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_store  uuid;
  v_shift  uuid;
  v_day    date;
  v_role   text;
  v_item   record;
  v_pay    record;
begin
  if v_tenant is null or auth.uid() is null then
    raise exception 'no_tenant';
  end if;
  v_role := member_role_in(v_tenant);
  if v_role is null or v_role = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform assert_staff_operational();

  select store_id, cash_shift_id,
         (created_at at time zone 'America/Argentina/Buenos_Aires')::date
    into v_store, v_shift, v_day
  from sales
  where id = p_sale_id and tenant_id = v_tenant and status = 'completed'
  for update;
  if v_store is null then
    raise exception 'sale_not_found_or_not_voidable';
  end if;
  -- Antes la RLS (alcance por sucursal) filtraba la venta: ahora explícito.
  if not coalesce(user_can_access_store(v_store), false) then
    raise exception 'sale_not_found_or_not_voidable';
  end if;
  -- Cajero (rol efectivo en la sucursal): sólo ventas del día.
  if coalesce(user_store_role(v_store), v_role) = 'cashier' and v_day <> branch_today() then
    raise exception 'forbidden_void_past_day' using errcode = '42501';
  end if;

  update sales
     set status = 'voided',
         voided_at = now(),
         voided_by = auth.uid(),
         void_reason = p_reason,
         updated_at = now()
   where id = p_sale_id and tenant_id = v_tenant;

  -- Revertir stock.
  for v_item in
    select product_id, quantity from sale_items
    where sale_id = p_sale_id and tenant_id = v_tenant
  loop
    update products
       set stock = stock + v_item.quantity, updated_at = now()
     where id = v_item.product_id and tenant_id = v_tenant;

    insert into stock_movements (product_id, store_id, delta, reason, reference_id)
    values (v_item.product_id, v_store, v_item.quantity, 'sale_void', p_sale_id);
  end loop;

  -- Contramovimiento de caja por cada pago (si hay turno).
  if v_shift is not null then
    for v_pay in
      select method, amount from payments
      where sale_id = p_sale_id and tenant_id = v_tenant
    loop
      insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
      values (v_shift, 'sale_void', v_pay.amount, v_pay.method, p_sale_id);
    end loop;
  end if;
end;
$$;
revoke all on function void_sale(uuid, text) from public, anon;
grant execute on function void_sale(uuid, text) to authenticated;
