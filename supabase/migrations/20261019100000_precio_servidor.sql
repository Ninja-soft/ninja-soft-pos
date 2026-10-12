-- =============================================================================
-- 20261019100000_precio_servidor  (F18 · H100 P0 · ADR-056)
--
-- El servidor manda en el precio. Hasta hoy create_sale aceptaba el unit_price
-- que mandaba el navegador; ahora lo recalcula y rechaza lo que no cierra.
--
--   A) _resolve_unit_price / resolve_unit_price: precio de lista autoritativo
--      (espejo de lib/prices/resolve.ts): variante → producto → % de la lista →
--      base (price_override de la variante o precio del producto). Lista: la
--      pedida o la activa del canal 'mostrador' (la que usa el POS). Cantidad,
--      cliente, sucursal y fecha quedan en la firma para escalas, listas por
--      cliente y por sucursal y vigencias (resto de H100).
--   B) _sale_modifier_delta: suma de los deltas de los modificadores elegidos
--      leídos del catálogo (no del navegador).
--   C) PIN de supervisor: acción nueva 'cambio_precio' (umbral en % de desvío
--      contra el precio de lista, encendida por defecto) y varios tokens por
--      request (una venta puede pedir PIN por precio y por descuento).
--   D) Venta libre: 'allow_free_sale' efectivo de la sucursal y la caja (default
--      true) y tope opcional por rol 'max_free_sale' (mapa rol → $ por venta).
--   E) create_sale: copia EXACTA de 20261015120000_venta_config_efectiva (la
--      última definición; 20261017* no la recrea) con la validación de precios
--      antes de calcular el subtotal:
--        · producto: |unit_price − (lista + modificadores)| <= 0,01 o error
--          'price_mismatch:{json}' con el precio esperado de cada línea;
--        · cambio manual: price_override + override_reason; lo puede hacer un
--          supervisor, o cualquiera con PIN de 'cambio_precio' si la política lo
--          pide; queda en sale_items (list_price, price_override_reason) y en
--          audit_logs ('price_override');
--        · regalo de promo a $0, línea cubierta por sesión de pack a $0 y el
--          precio guardado en la mesa o el delivery que se cobra se aceptan;
--        · ítem sin producto: se descuenta contra recargos y garantía (extras),
--          packs vendidos (precio de service_packs) e ítems libres de la mesa o
--          el delivery; lo que sobra es venta libre;
--        · cantidad > 0, precio y descuento de línea >= 0.
--      Cobro en espera que se acredita (ninja.pc_complete): usa el snapshot
--      validado al estacionar (park_pending_charge corre _pc_dry_run, que pasa
--      por esta misma validación con el token del header) y NO se revalida: la
--      plata ya entró y un cambio de lista posterior no puede dejarla colgada.
--   F) Mesas y delivery: trigger en table_order_items y delivery_order_items
--      con la misma regla (el mozo no carga precios a mano; la policy RLS "for
--      all" permitía escribir por REST).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Precio de lista autoritativo
-- -----------------------------------------------------------------------------
create or replace function _resolve_unit_price(
  p_tenant   uuid,
  p_product  uuid,
  p_variant  uuid default null,
  p_qty      numeric default 1,
  p_customer uuid default null,
  p_store    uuid default null,
  p_list_id  uuid default null,
  p_at       timestamptz default now()
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base   numeric;
  v_vprice numeric;
  v_list   price_lists%rowtype;
  v_item   numeric;
begin
  if p_tenant is null or p_product is null then return null; end if;

  select p.price into v_base
    from products p
   where p.id = p_product and p.tenant_id = p_tenant;
  if not found then return null; end if;

  if p_variant is not null then
    select v.price_override into v_vprice
      from product_variants v
     where v.id = p_variant and v.product_id = p_product and v.tenant_id = p_tenant;
    v_base := coalesce(v_vprice, v_base);
  end if;
  v_base := coalesce(v_base, 0);

  if p_list_id is not null then
    select * into v_list from price_lists l
     where l.id = p_list_id and l.tenant_id = p_tenant and l.deleted_at is null and l.is_active;
  else
    -- Igual que el POS (pricesApi.channelPricing('mostrador')): una lista
    -- activa por canal (índice único parcial).
    select * into v_list from price_lists l
     where l.tenant_id = p_tenant and l.channel = 'mostrador' and l.is_active and l.deleted_at is null
     order by l.created_at
     limit 1;
  end if;
  if v_list.id is null then return v_base; end if;

  if p_variant is not null then
    select i.price into v_item from price_list_items i
     where i.price_list_id = v_list.id and i.product_id = p_product and i.variant_id = p_variant
     limit 1;
    if found then return v_item; end if;
  end if;

  select i.price into v_item from price_list_items i
   where i.price_list_id = v_list.id and i.product_id = p_product and i.variant_id is null
   limit 1;
  if found then return v_item; end if;

  if v_list.adjustment_pct is not null then
    return round(v_base * (1 + v_list.adjustment_pct / 100), 2);
  end if;
  return v_base;
end;
$$;
revoke all on function _resolve_unit_price(uuid, uuid, uuid, numeric, uuid, uuid, uuid, timestamptz) from public, anon, authenticated;

-- Wrapper para el usuario: sólo su negocio (o el staff interno con scope).
create or replace function resolve_unit_price(
  p_tenant   uuid,
  p_product  uuid,
  p_variant  uuid default null,
  p_qty      numeric default 1,
  p_customer uuid default null,
  p_store    uuid default null,
  p_list_id  uuid default null,
  p_at       timestamptz default now()
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_tenant is distinct from current_tenant_id() and not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return _resolve_unit_price(p_tenant, p_product, p_variant, p_qty, p_customer, p_store, p_list_id, p_at);
end;
$$;
revoke all on function resolve_unit_price(uuid, uuid, uuid, numeric, uuid, uuid, uuid, timestamptz) from public, anon;
grant execute on function resolve_unit_price(uuid, uuid, uuid, numeric, uuid, uuid, uuid, timestamptz) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Modificadores: deltas del catálogo
-- -----------------------------------------------------------------------------
-- p_mods: snapshot del POS [{ group, options: [{ name, price_delta }] }]. El
-- price_delta que manda el navegador se ignora: vale el de la opción activa.
create or replace function _sale_modifier_delta(p_tenant uuid, p_product uuid, p_mods jsonb)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_total numeric := 0;
  g       jsonb;
  o       jsonb;
  v_gid   uuid;
  v_delta numeric;
begin
  if p_mods is null or jsonb_typeof(p_mods) <> 'array' then return 0; end if;
  for g in select * from jsonb_array_elements(p_mods) loop
    continue when jsonb_typeof(g -> 'options') <> 'array' or jsonb_array_length(g -> 'options') = 0;
    v_gid := null;
    select mg.id into v_gid
      from product_modifier_groups mg
     where mg.tenant_id = p_tenant and mg.product_id = p_product and mg.name = g ->> 'group'
     order by mg.sort, mg.created_at
     limit 1;
    if v_gid is null then raise exception 'modifier_not_found'; end if;
    for o in select * from jsonb_array_elements(g -> 'options') loop
      select mo.price_delta into v_delta
        from product_modifier_options mo
       where mo.tenant_id = p_tenant and mo.group_id = v_gid and mo.name = o ->> 'name' and mo.is_active
       order by mo.sort, mo.created_at
       limit 1;
      if not found then raise exception 'modifier_not_found'; end if;
      v_total := v_total + coalesce(v_delta, 0);
    end loop;
  end loop;
  return v_total;
end;
$$;
revoke all on function _sale_modifier_delta(uuid, uuid, jsonb) from public, anon, authenticated;

-- Índice del primer monto del arreglo que coincide (±0,01) o 0.
create or replace function _amount_index(p_arr numeric[], p_amount numeric)
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce((select i from generate_subscripts(p_arr, 1) i
                    where abs(p_arr[i] - p_amount) <= 0.01
                    order by i limit 1), 0);
$$;

-- -----------------------------------------------------------------------------
-- C) PIN de supervisor: 'cambio_precio' y varios tokens por request
-- -----------------------------------------------------------------------------
-- Encendida por defecto: hoy no hay cambios de precio en el POS, así que no
-- cambia ningún flujo existente; el primero que lo use ya queda controlado.
create or replace function security_default_policy()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'discount_over',     jsonb_build_object('enabled', false, 'threshold', 20),
    'cambio_precio',     jsonb_build_object('enabled', true,  'threshold', 0),
    'sale_void',         jsonb_build_object('enabled', false, 'threshold', 0),
    'sale_return',       jsonb_build_object('enabled', false, 'threshold', 0),
    'cash_out',          jsonb_build_object('enabled', false, 'threshold', 0),
    'cash_in',           jsonb_build_object('enabled', false, 'threshold', 0),
    'shift_force_close', jsonb_build_object('enabled', true,  'threshold', 0));
$$;

-- Copia de 20261017110000 con 'cambio_precio' en porcentaje (como el descuento).
create or replace function pin_action_required(p_tenant uuid, p_action text, p_amount numeric)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v   security_settings%rowtype;
  v_a jsonb;
  v_t numeric;
begin
  if p_action = 'shift_force_close' then return true; end if;
  v := security_effective(p_tenant);
  v_a := v.pin_policy -> p_action;
  if v_a is null or not coalesce((v_a ->> 'enabled')::boolean, false) then return false; end if;
  v_t := coalesce((v_a ->> 'threshold')::numeric, 0);
  if p_action in ('discount_over', 'cambio_precio') then
    return coalesce(p_amount, 0) > v_t + 0.001;
  end if;
  return coalesce(p_amount, 0) >= v_t;
end;
$$;
revoke all on function pin_action_required(uuid, text, numeric) from public, anon;
grant execute on function pin_action_required(uuid, text, numeric) to authenticated;

-- Copia EXACTA de 20261017110000 salvo el tope de 100 % también para 'cambio_precio'.
create or replace function security_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_before  security_settings%rowtype;
  v_policy  jsonb := '{}'::jsonb;
  v_key     text;
  v_val     jsonb;
  v_thr     numeric;
  v_roles   text[];
  v_users   uuid[];
  v_rot     int;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not tenant_has_feature_for(v_tenant, 'pin_supervisor') then
    raise exception 'feature_not_in_plan: pin_supervisor' using errcode = 'check_violation';
  end if;
  v_before := security_effective(v_tenant);

  for v_key, v_val in select * from jsonb_each(coalesce(p -> 'pin_policy', v_before.pin_policy)) loop
    if not (security_default_policy() ? v_key) then raise exception 'invalid_action: %', v_key; end if;
    v_thr := coalesce((v_val ->> 'threshold')::numeric, 0);
    if v_thr < 0 or (v_key in ('discount_over', 'cambio_precio') and v_thr > 100) then raise exception 'invalid_threshold'; end if;
    v_policy := v_policy || jsonb_build_object(v_key, jsonb_build_object(
      'enabled', case when v_key = 'shift_force_close' then true
                      else coalesce((v_val ->> 'enabled')::boolean, false) end,
      'threshold', v_thr));
  end loop;

  v_roles := v_before.supervisor_roles;
  if p ? 'supervisor_roles' then
    v_roles := array(select jsonb_array_elements_text(p -> 'supervisor_roles'));
  end if;
  if not ('owner' = any (v_roles)) then v_roles := v_roles || array['owner']; end if;
  if not (v_roles <@ array['owner', 'manager', 'cashier']) then raise exception 'invalid_roles'; end if;

  v_users := v_before.supervisor_user_ids;
  if p ? 'supervisor_user_ids' then
    v_users := array(select (jsonb_array_elements_text(p -> 'supervisor_user_ids'))::uuid);
    if exists (select 1 from unnest(v_users) u(id)
                where not exists (select 1 from tenant_users tu where tu.tenant_id = v_tenant and tu.user_id = u.id)) then
      raise exception 'member_not_found';
    end if;
  end if;

  v_rot := case when p ? 'pin_rotation_days' then nullif(p ->> 'pin_rotation_days', '')::int else v_before.pin_rotation_days end;

  insert into security_settings as s
    (tenant_id, pin_policy, supervisor_roles, supervisor_user_ids, pin_max_attempts, pin_lock_minutes,
     pin_rotation_days, shared_shift, updated_at, updated_by)
  values
    (v_tenant, v_policy, v_roles, v_users,
     coalesce((p ->> 'pin_max_attempts')::int, v_before.pin_max_attempts),
     coalesce((p ->> 'pin_lock_minutes')::int, v_before.pin_lock_minutes),
     v_rot,
     coalesce((p ->> 'shared_shift')::boolean, v_before.shared_shift),
     now(), auth.uid())
  on conflict (tenant_id) do update
    set pin_policy = excluded.pin_policy,
        supervisor_roles = excluded.supervisor_roles,
        supervisor_user_ids = excluded.supervisor_user_ids,
        pin_max_attempts = excluded.pin_max_attempts,
        pin_lock_minutes = excluded.pin_lock_minutes,
        pin_rotation_days = excluded.pin_rotation_days,
        shared_shift = excluded.shared_shift,
        updated_at = now(),
        updated_by = auth.uid();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'security_settings', v_tenant, 'security_settings_changed',
          jsonb_build_object('pin_policy', v_before.pin_policy, 'supervisor_roles', v_before.supervisor_roles,
                             'supervisor_user_ids', v_before.supervisor_user_ids,
                             'pin_max_attempts', v_before.pin_max_attempts, 'pin_lock_minutes', v_before.pin_lock_minutes,
                             'pin_rotation_days', v_before.pin_rotation_days, 'shared_shift', v_before.shared_shift),
          jsonb_build_object('pin_policy', v_policy, 'supervisor_roles', v_roles, 'supervisor_user_ids', v_users,
                             'pin_max_attempts', coalesce((p ->> 'pin_max_attempts')::int, v_before.pin_max_attempts),
                             'pin_lock_minutes', coalesce((p ->> 'pin_lock_minutes')::int, v_before.pin_lock_minutes),
                             'pin_rotation_days', v_rot,
                             'shared_shift', coalesce((p ->> 'shared_shift')::boolean, v_before.shared_shift)));
  return security_settings_get();
end;
$$;
revoke all on function security_settings_save(jsonb) from public, anon;
grant execute on function security_settings_save(jsonb) to authenticated;

-- Tokens del header (separados por coma). Una venta puede necesitar dos
-- autorizaciones (precio y descuento): el cliente las acumula y reintenta.
create or replace function request_supervisor_tokens()
returns uuid[]
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_txt text;
  v_out uuid[] := '{}';
  t     text;
begin
  v_txt := nullif(current_setting('request.headers', true), '')::json ->> 'x-ninja-supervisor-token';
  if v_txt is null then return v_out; end if;
  foreach t in array string_to_array(v_txt, ',') loop
    t := btrim(t);
    if t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_out := v_out || t::uuid;
    end if;
    exit when array_length(v_out, 1) >= 4;
  end loop;
  return v_out;
exception when others then
  return '{}';
end;
$$;
grant execute on function request_supervisor_tokens() to authenticated;

-- Copia de 20261017110000 que busca el token de la acción entre los del header.
create or replace function require_supervisor(p_action text, p_amount numeric, p_ref uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_tokens uuid[];
  v_tok    supervisor_auth_tokens%rowtype;
begin
  if v_tenant is null or auth.uid() is null then return null; end if;
  if not pin_action_required(v_tenant, p_action, p_amount) then return null; end if;
  if is_supervisor(v_tenant, auth.uid()) then return auth.uid(); end if;

  v_tokens := request_supervisor_tokens();
  if coalesce(array_length(v_tokens, 1), 0) = 0 then
    raise exception 'supervisor_required:%', p_action using errcode = '42501';
  end if;
  update supervisor_auth_tokens t
     set consumed_at = now(), consumed_ref = p_ref
   where t.id = (
           select c.id from supervisor_auth_tokens c
            where c.id = any (v_tokens)
              and c.tenant_id = v_tenant
              and c.action = p_action
              and c.requested_by = auth.uid()
              and c.consumed_at is null
              and c.expires_at > now()
              and (p_amount is null or coalesce(c.amount, 0) + 0.001 >= p_amount)
            order by c.created_at
            limit 1)
  returning t.* into v_tok;
  if not found then
    -- Vinieron tokens pero ninguno de esta acción: hay que pedir esta también.
    if not exists (select 1 from supervisor_auth_tokens c
                    where c.id = any (v_tokens) and c.tenant_id = v_tenant and c.action = p_action) then
      raise exception 'supervisor_required:%', p_action using errcode = '42501';
    end if;
    raise exception 'supervisor_token_invalid' using errcode = '42501';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'users', v_tok.supervisor_id, 'supervisor_override_used', v_tok.reason,
          jsonb_build_object('pin_action', p_action, 'amount', p_amount, 'supervisor_id', v_tok.supervisor_id,
                             'requested_by', auth.uid(), 'ref_id', p_ref, 'token_id', v_tok.id));
  return v_tok.supervisor_id;
end;
$$;
revoke all on function require_supervisor(text, numeric, uuid) from public, anon;
grant execute on function require_supervisor(text, numeric, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Venta libre: tope por rol (mapa rol → $ por venta; sin clave = sin tope)
-- -----------------------------------------------------------------------------
alter table pos_settings add column if not exists max_free_sale jsonb not null default '{}'::jsonb;

-- Copia de 20261018300000 (incluye card_voucher_rules, ADR-054) con 'max_free_sale' (map_num, grupo y sucursal).
create or replace function config_field_type(p_domain text, p_scope text, p_field text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_domain = 'payment_method' then
      case
        when p_field = 'enabled' then 'bool'
        when p_scope = 'register' then null
        when p_field = 'surcharge_pct' then 'num'
        when p_field = 'plan_mode' then 'text'
        when p_field = 'merchant_numbers' then 'map_text'
        when p_field = 'sort' then 'num'
        else null
      end
    when p_domain = 'pos_settings' then
      case
        when p_field in ('blind_close', 'require_close_reason', 'allow_free_sale',
                         'display_show_unit_prices') then 'bool'
        when p_field = 'close_tolerance' then 'num'
        when p_field in ('display_welcome_message', 'display_thanks_message') then 'text'
        -- ADR-054: reglas del cupón, también por caja (el posnet es de la caja).
        when p_field in ('print_profiles', 'pos_layout', 'card_voucher_rules') then 'map_any'
        when p_scope = 'register' then null
        when p_field in ('allow_negative_stock', 'require_customer', 'require_card_voucher',
                         'offer_warranty', 'auto_email_receipt') then 'bool'
        when p_field = 'rounding_multiple' then 'num'
        when p_field in ('max_discount', 'max_free_sale') then 'map_num'
        else null
      end
    when p_domain = 'ticket' then
      case
        when p_scope = 'register' then null
        when p_field = 'use_store_contact' then 'bool'
        when p_field in ('legal_name', 'cuit', 'phone', 'address', 'ticket_title',
                         'ticket_legend', 'ticket_footer') then 'text'
        else null
      end
    else null
  end;
$$;
grant execute on function config_field_type(text, text, text) to authenticated, service_role;

-- Copia de 20261018300000 (incluye card_voucher_rules, ADR-054) con el rango de 'max_free_sale' (>= 0).
create or replace function config_field_error(p_domain text, p_field text, p_type text, p_value jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_num numeric;
  k     text;
  v     jsonb;
begin
  if p_type = 'bool' then
    if jsonb_typeof(p_value) <> 'boolean' then return 'invalid_type'; end if;
  elsif p_type = 'num' then
    if jsonb_typeof(p_value) <> 'number' then return 'invalid_type'; end if;
    v_num := (p_value #>> '{}')::numeric;
    if p_field = 'surcharge_pct' and (v_num < -100 or v_num > 100) then return 'out_of_range'; end if;
    if p_field in ('rounding_multiple', 'close_tolerance') and (v_num < 0 or v_num > 100000000) then
      return 'out_of_range';
    end if;
    if p_field = 'sort' and (v_num < -10000 or v_num > 10000) then return 'out_of_range'; end if;
  elsif p_type = 'text' then
    if jsonb_typeof(p_value) not in ('string', 'null') then return 'invalid_type'; end if;
    if char_length(coalesce(p_value #>> '{}', '')) > 500 then return 'too_long'; end if;
    if p_field = 'plan_mode' and (p_value #>> '{}') not in ('global', 'plans') then return 'out_of_range'; end if;
  elsif p_type in ('map_text', 'map_num', 'map_any') then
    if jsonb_typeof(p_value) <> 'object' then return 'invalid_type'; end if;
    -- ADR-054: la forma de las reglas del cupón se valida igual que en pos_settings.
    if p_field = 'card_voucher_rules' then return card_voucher_rules_error(p_value); end if;
    if p_type <> 'map_any' then
      for k, v in select * from jsonb_each(p_value) loop
        if char_length(k) > 40 then return 'invalid_key'; end if;
        if p_type = 'map_text' then
          if jsonb_typeof(v) <> 'string' then return 'invalid_type'; end if;
          -- n° de comercio: sólo letras y números, hasta 20 (vacío = sin número).
          if p_field = 'merchant_numbers' and (v #>> '{}') !~ '^[0-9A-Za-z]{0,20}$' then
            return 'invalid_merchant_number';
          end if;
        else
          if jsonb_typeof(v) <> 'number' then return 'invalid_type'; end if;
          if p_field = 'max_discount' and ((v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 100) then
            return 'out_of_range';
          end if;
          if p_field = 'max_free_sale' and ((v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 100000000) then
            return 'out_of_range';
          end if;
        end if;
      end loop;
    elsif pg_column_size(p_value) > 32000 then
      return 'too_long';
    end if;
  else
    return 'field_not_allowed';
  end if;
  return null;
end;
$$;
grant execute on function config_field_error(text, text, text, jsonb) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- E) create_sale con precio autoritativo
-- -----------------------------------------------------------------------------
alter table sale_items add column if not exists list_price numeric(12,2);
alter table sale_items add column if not exists price_override_reason text;
comment on column sale_items.list_price is
  'Precio de lista + modificadores calculado por el servidor al vender (ADR-056). Null: ítem sin producto o cobro en espera acreditado.';
comment on column sale_items.price_override_reason is
  'Motivo del cambio manual de precio (ADR-056). Null: se vendió al precio de lista.';

create or replace function public.create_sale(p_items jsonb, p_payments jsonb, p_discount_total numeric DEFAULT 0, p_customer_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_extras jsonb DEFAULT '[]'::jsonb, p_table_order_id uuid DEFAULT NULL::uuid, p_delivery_order_id uuid DEFAULT NULL::uuid, p_promo_discount numeric DEFAULT 0, p_promo_id uuid DEFAULT NULL::uuid, p_promo_name text DEFAULT NULL::text, p_coupon_id uuid DEFAULT NULL::uuid, p_cash_shift_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant   uuid := current_tenant_id();
  v_store    uuid;
  v_shift    uuid;
  v_number   bigint;
  v_subtotal numeric := 0;
  v_total    numeric;
  v_total_pre numeric;
  v_paid     numeric := 0;
  v_sale_id  uuid;
  v_item     record;
  v_pay      record;
  v_comp     record;
  v_pname    text;
  v_psku     text;
  v_is_kit   boolean;
  v_track    boolean;
  v_has_variants boolean;
  v_variant  record;
  v_serial   text;
  v_role     text;
  v_max_disc numeric := 100;
  v_round    numeric := 0;
  v_allow_neg boolean := true;
  -- F17 · H92/H94 (ADR-049): settings efectivos y stock por sucursal.
  v_reg        uuid;
  v_eff        jsonb;
  v_branch_stk boolean := false;
  v_disc_pct numeric;
  v_pallow   boolean;
  v_stock    numeric;
  v_sc_total numeric := 0;
  v_sc_bal   numeric;
  v_pay_feat text;
  v_line_disc numeric := 0;
  v_warranty_prima numeric := 0;
  v_tip_amount numeric := 0;
  v_tip_method text;
  v_professional uuid;
  v_pack     record;
  v_pcredit  record;
  v_pk       service_packs%rowtype;
  v_has_pack_session boolean := false;
  v_table_order table_orders%rowtype;
  v_delivery_order delivery_orders%rowtype;
  v_delivery_fee numeric := 0;
  v_intent   record;
  v_qr_ref   uuid;
  v_qr_sum   numeric;
  v_qr_plain boolean := false;
  v_promo_disc numeric := 0;
  v_coupon_disc numeric := 0;
  v_coupon   coupons%rowtype;
  -- F18 · H100 (ADR-056): precio autoritativo.
  v_pc          boolean := coalesce(current_setting('ninja.pc_complete', true), '') <> '';
  v_i           int;
  v_j           jsonb;
  v_pid         uuid;
  v_vid         uuid;
  v_qty         numeric;
  v_up          numeric;
  v_ldisc       numeric;
  v_exp         numeric;
  v_ok          boolean;
  v_amt         numeric;
  v_k           int;
  v_reason      text;
  v_dev         numeric;
  v_max_dev     numeric := 0;
  v_pool_extra  numeric[] := '{}';
  v_pool_pack   numeric[] := '{}';
  v_pool_order  numeric[] := '{}';
  v_pack_creds  text[] := '{}';
  v_prices      jsonb := '[]'::jsonb;
  v_mismatch    jsonb := '[]'::jsonb;
  v_overrides   jsonb := '[]'::jsonb;
  v_free_total  numeric := 0;
  v_free_any    boolean := false;
  v_free_cap    numeric;
  v_price_sup   uuid;
  v_n           int := 0;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  perform assert_account_active(v_tenant);

  if coalesce(p_discount_total, 0) < 0 then
    raise exception 'invalid_discount';
  end if;

  if p_table_order_id is not null then
    select * into v_table_order from table_orders
     where id = p_table_order_id and tenant_id = v_tenant
     for update;
    if not found then
      raise exception 'table_order_not_open';
    end if;
    if v_table_order.status <> 'abierta' or v_table_order.sale_id is not null then
      raise exception 'table_order_not_open';
    end if;
  end if;

  if p_delivery_order_id is not null then
    select * into v_delivery_order from delivery_orders
     where id = p_delivery_order_id and tenant_id = v_tenant
     for update;
    if not found then
      raise exception 'delivery_order_not_open';
    end if;
    if v_delivery_order.sale_id is not null
       or v_delivery_order.status in ('entregado','cancelado')
       or v_delivery_order.deleted_at is not null then
      raise exception 'delivery_order_not_open';
    end if;
    v_delivery_fee := greatest(coalesce(v_delivery_order.delivery_fee, 0), 0);
  end if;

  -- F17 · H90: la sucursal sale del turno de caja (el que manda el POS o el
  -- inferido), no de la sucursal default. Con una sola sucursal es lo de siempre.
  select r.o_shift_id, r.o_store_id into v_shift, v_store
    from resolve_sale_shift(p_cash_shift_id, true) r;
  if v_shift is null then
    if not exists (select 1 from stores where tenant_id = v_tenant and deleted_at is null) then
      raise exception 'no_store';
    end if;
    raise exception 'no_open_shift';
  end if;

  select role into v_role
  from tenant_users
  where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  limit 1;
  -- F17 · H91: el rol puede estar pisado en esta sucursal (tope de descuento).
  v_role := coalesce(user_store_role(v_store), v_role);

  -- F17 · H92 (ADR-049): descuento máximo, redondeo y venta sin stock salen
  -- de la configuración EFECTIVA de la sucursal y la caja del turno
  -- (negocio ← grupo ← sucursal ← caja). Sin overrides es pos_settings.
  select cs.cash_register_id into v_reg from cash_shifts cs where cs.id = v_shift;
  v_eff := _effective_config(v_tenant, 'pos_settings', '', v_store, v_reg) -> 'value';
  v_max_disc  := coalesce((v_eff -> 'max_discount' ->> coalesce(v_role, 'cashier'))::numeric, 100);
  v_round     := coalesce((v_eff ->> 'rounding_multiple')::numeric, 0);
  v_allow_neg := coalesce((v_eff ->> 'allow_negative_stock')::boolean, true);
  -- Stock por sucursal (ADR-046): con la feature y 2+ sucursales, sin venta en
  -- negativo también se controla el saldo de ESTA sucursal, no sólo el total.
  v_branch_stk := tenant_has_feature_for(v_tenant, 'stock_sucursales')
                  and (select count(*) from stores st
                        where st.tenant_id = v_tenant and st.deleted_at is null) > 1;

  -- F18 · H100 (ADR-056): el servidor manda en el precio. El cobro en espera que
  -- se acredita (ninja.pc_complete) usa el snapshot ya validado al estacionar.
  if not v_pc then
    if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
      raise exception 'invalid_items';
    end if;

    -- Montos sin producto que ya tienen explicación: recargo y garantía (van como
    -- ítem y como extra), packs vendidos (precio del pack) e ítems libres de la
    -- mesa o el delivery que se cobra (los valida el trigger al cargarlos).
    select coalesce(array_agg(round(e.amount, 2)), '{}') into v_pool_extra
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, amount numeric)
     where lower(coalesce(e.kind, '')) in ('warranty', 'surcharge') and coalesce(e.amount, 0) > 0;
    select coalesce(array_agg(sp.price), '{}') into v_pool_pack
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
      join service_packs sp on sp.id::text = e.id and sp.tenant_id = v_tenant and sp.deleted_at is null
     where lower(coalesce(e.kind, '')) = 'pack';
    select coalesce(array_agg(e.id), '{}') into v_pack_creds
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
     where lower(coalesce(e.kind, '')) = 'pack_session' and e.id is not null;
    if p_table_order_id is not null then
      select coalesce(array_agg(round(i.unit_price * i.qty, 2)), '{}') into v_pool_order
        from table_order_items i
       where i.order_id = p_table_order_id and i.tenant_id = v_tenant and i.product_id is null;
    elsif p_delivery_order_id is not null then
      select coalesce(array_agg(round(i.unit_price * i.qty, 2)), '{}') into v_pool_order
        from delivery_order_items i
       where i.order_id = p_delivery_order_id and i.tenant_id = v_tenant and i.product_id is null;
    end if;

    for v_i in 0 .. coalesce(jsonb_array_length(p_items), 0) - 1 loop
      v_j     := p_items -> v_i;
      v_qty   := coalesce((v_j ->> 'quantity')::numeric, 0);
      v_up    := coalesce((v_j ->> 'unit_price')::numeric, 0);
      v_ldisc := coalesce((v_j ->> 'discount')::numeric, 0);
      if v_qty <= 0 then raise exception 'invalid_quantity'; end if;
      if v_up < 0 or v_ldisc < 0 then raise exception 'invalid_price'; end if;
      v_pid := nullif(v_j ->> 'product_id', '')::uuid;

      if v_pid is null then
        v_amt := round(v_up * v_qty, 2);
        v_k := _amount_index(v_pool_extra, v_amt);
        if v_k > 0 then
          v_pool_extra := v_pool_extra[1:v_k - 1] || v_pool_extra[v_k + 1:];
        else
          v_k := _amount_index(v_pool_pack, v_amt);
          if v_k > 0 then
            v_pool_pack := v_pool_pack[1:v_k - 1] || v_pool_pack[v_k + 1:];
          else
            v_k := _amount_index(v_pool_order, v_amt);
            if v_k > 0 then
              v_pool_order := v_pool_order[1:v_k - 1] || v_pool_order[v_k + 1:];
            else
              v_free_any := true;
              v_free_total := v_free_total + greatest(v_amt - v_ldisc, 0);
            end if;
          end if;
        end if;
        v_prices := v_prices || jsonb_build_array(jsonb_build_object('list_price', null));
        continue;
      end if;

      v_vid := nullif(v_j ->> 'variant_id', '')::uuid;
      v_exp := _resolve_unit_price(v_tenant, v_pid, v_vid, v_qty, p_customer_id, v_store, null, now());
      if v_exp is null then raise exception 'product_not_found'; end if;
      v_exp := round(v_exp + _sale_modifier_delta(v_tenant, v_pid, v_j -> 'modifiers'), 2);
      v_ok := abs(v_up - v_exp) <= 0.01;
      v_reason := null;

      -- Regalo de una promo y línea cubierta por una sesión de pack: van a $0.
      if not v_ok and v_up = 0 and nullif(v_j ->> 'gift_promo_id', '') is not null then
        v_ok := exists (select 1 from promotions pr
                         where pr.id::text = v_j ->> 'gift_promo_id' and pr.tenant_id = v_tenant
                           and pr.deleted_at is null);
      end if;
      if not v_ok and v_up = 0 and nullif(v_j ->> 'pack_credit_id', '') is not null then
        v_ok := (v_j ->> 'pack_credit_id') = any (v_pack_creds);
      end if;
      -- Mesa o delivery que se cobra: vale el precio guardado al cargar el ítem.
      if not v_ok and p_table_order_id is not null then
        v_ok := exists (select 1 from table_order_items i
                         where i.order_id = p_table_order_id and i.tenant_id = v_tenant
                           and i.product_id = v_pid and abs(i.unit_price - v_up) <= 0.01);
      end if;
      if not v_ok and p_delivery_order_id is not null then
        v_ok := exists (select 1 from delivery_order_items i
                         where i.order_id = p_delivery_order_id and i.tenant_id = v_tenant
                           and i.product_id = v_pid and abs(i.unit_price - v_up) <= 0.01);
      end if;

      if not v_ok then
        if coalesce((v_j ->> 'price_override')::boolean, false) then
          v_reason := nullif(btrim(coalesce(v_j ->> 'override_reason', '')), '');
          if v_reason is null or char_length(v_reason) < 3 then
            raise exception 'price_override_reason_required';
          end if;
          v_reason := left(v_reason, 200);
          v_dev := case when v_exp > 0 then round(abs(v_up - v_exp) / v_exp * 100, 2) else 100 end;
          v_max_dev := greatest(v_max_dev, v_dev);
          v_overrides := v_overrides || jsonb_build_array(jsonb_build_object(
            'product_id', v_pid, 'variant_id', v_vid, 'expected', v_exp, 'price', v_up,
            'quantity', v_qty, 'deviation_pct', v_dev, 'reason', v_reason));
        else
          v_mismatch := v_mismatch || jsonb_build_array(jsonb_build_object(
            'product_id', v_pid, 'variant_id', v_vid, 'expected', v_exp, 'received', v_up));
        end if;
      end if;
      v_prices := v_prices || jsonb_build_array(jsonb_build_object('list_price', v_exp, 'reason', v_reason));
    end loop;

    -- Primero el precio: el POS refresca y el cajero vuelve a cobrar.
    if jsonb_array_length(v_mismatch) > 0 then
      raise exception using message = 'price_mismatch:' || jsonb_build_object('items', v_mismatch)::text,
                            errcode = 'P0001';
    end if;

    -- Venta libre (monto manual sin producto): flag efectivo y tope por rol.
    if v_free_any then
      if not coalesce((v_eff ->> 'allow_free_sale')::boolean, true) then
        raise exception 'free_sale_not_allowed';
      end if;
      v_free_cap := (v_eff -> 'max_free_sale' ->> coalesce(v_role, 'cashier'))::numeric;
      if v_free_cap is not null and v_free_total > v_free_cap + 0.01 then
        raise exception 'free_sale_exceeds_limit';
      end if;
    end if;

    -- Cambio manual de precio: supervisor, o PIN si la política lo pide.
    if jsonb_array_length(v_overrides) > 0 then
      if is_supervisor(v_tenant, auth.uid()) then
        v_price_sup := auth.uid();
      elsif pin_action_required(v_tenant, 'cambio_precio', v_max_dev) then
        v_price_sup := require_supervisor('cambio_precio', v_max_dev, null);
      end if;
    end if;
  end if;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_price numeric, discount numeric)
  loop
    v_subtotal := v_subtotal
      + (coalesce(v_item.unit_price, 0) * coalesce(v_item.quantity, 0))
      - coalesce(v_item.discount, 0);
    v_line_disc := v_line_disc + coalesce(v_item.discount, 0);
  end loop;

  select exists (
    select 1 from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text)
    where lower(coalesce(e.kind,'')) = 'pack_session'
  ) into v_has_pack_session;

  if v_subtotal < 0 or (v_subtotal = 0 and not v_has_pack_session) then
    raise exception 'empty_sale';
  end if;

  if (coalesce(p_discount_total, 0) > 0 or v_line_disc > 0)
     and not tenant_has_feature('descuentos') then
    raise exception 'feature_not_in_plan: descuentos';
  end if;

  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'warranty'
                           then coalesce(e.amount, 0) else 0 end), 0)
    into v_warranty_prima
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric);
  if v_warranty_prima > 0 and not tenant_has_feature('garantias') then
    raise exception 'feature_not_in_plan: garantias';
  end if;

  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'tip'
                           then coalesce(e.amount, 0) else 0 end), 0),
         max(case when lower(coalesce(e.kind,'')) = 'tip' then e.method end)
    into v_tip_amount, v_tip_method
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric, method text);
  if v_tip_amount < 0 then
    raise exception 'invalid_tip';
  end if;
  if v_tip_amount > 0 and v_tip_method is null then
    v_tip_method := 'cash';
  end if;

  select (e.id)::uuid into v_professional
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, id text)
  where lower(coalesce(e.kind,'')) = 'professional'
    and e.id is not null
  order by (e.id)::uuid
  limit 1;
  if v_professional is not null then
    if not exists (
      select 1 from professionals
      where id = v_professional and tenant_id = v_tenant
        and deleted_at is null and is_active
    ) then
      v_professional := null;
    end if;
  end if;

  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
         as e(kind text)
       where lower(coalesce(e.kind,'')) in ('pack','pack_session')
     )
     and p_customer_id is null then
    raise exception 'pack_needs_customer';
  end if;

  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb))
         as p(method text, amount numeric)
       where p.method = 'account' and coalesce(p.amount, 0) > 0
     )
     and not tenant_has_feature('cuenta_corriente') then
    raise exception 'feature_not_in_plan: cuenta_corriente';
  end if;

  if coalesce(p_discount_total, 0) > 0 and v_subtotal > 0 then
    v_disc_pct := coalesce(p_discount_total, 0) / v_subtotal * 100;
    if v_disc_pct > v_max_disc + 0.001 then
      raise exception 'discount_exceeds_limit';
    end if;
  end if;

  v_promo_disc := least(
    greatest(coalesce(p_promo_discount, 0), 0),
    greatest(v_subtotal - coalesce(p_discount_total, 0), 0)
  );

  -- Cupón (F9 · H54): lock de la fila + validación + cómputo AUTORITATIVO. Bypass
  -- del gating de 'descuentos' y del tope por rol (un cupón no es descuento manual),
  -- igual que la promo. El registro del canje se hace tras insertar la venta.
  if p_coupon_id is not null then
    select * into v_coupon from coupons
      where id = p_coupon_id and tenant_id = v_tenant and deleted_at is null
      for update;
    if not found then raise exception 'coupon_not_found'; end if;
    if not v_coupon.is_active then raise exception 'coupon_inactive'; end if;
    if v_coupon.valid_from is not null
       and (now() at time zone 'America/Argentina/Buenos_Aires')::date < v_coupon.valid_from then
      raise exception 'coupon_not_yet_valid';
    end if;
    if v_coupon.valid_to is not null
       and (now() at time zone 'America/Argentina/Buenos_Aires')::date > v_coupon.valid_to then
      raise exception 'coupon_expired';
    end if;
    if v_subtotal < coalesce(v_coupon.min_amount, 0) then
      raise exception 'coupon_min_amount';
    end if;
    if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then
      raise exception 'coupon_usage_exceeded';
    end if;
    if v_coupon.max_per_customer is not null then
      if p_customer_id is null then raise exception 'coupon_needs_customer'; end if;
      if (select count(*) from coupon_redemptions
            where coupon_id = v_coupon.id and customer_id = p_customer_id)
         >= v_coupon.max_per_customer then
        raise exception 'coupon_customer_exceeded';
      end if;
    end if;
    v_coupon_disc := case when v_coupon.discount_type = 'percent'
                          then v_subtotal * coalesce(v_coupon.discount_value, 0) / 100
                          else coalesce(v_coupon.discount_value, 0) end;
    v_coupon_disc := least(
      greatest(v_coupon_disc, 0),
      greatest(v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc, 0)
    );
  end if;

  v_total_pre := v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc - v_coupon_disc;

  if v_round > 0 then
    v_total := round(v_total_pre / v_round) * v_round;
  else
    v_total := v_total_pre;
  end if;

  if v_delivery_fee > 0 then
    v_subtotal := v_subtotal + v_delivery_fee;
    v_total    := v_total + v_delivery_fee;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments) as x(method text, amount numeric)
  loop
    v_paid := v_paid + coalesce(v_pay.amount, 0);
    if v_pay.method = 'store_credit' then
      v_sc_total := v_sc_total + coalesce(v_pay.amount, 0);
    end if;
  end loop;
  if v_paid < v_total + v_tip_amount then
    raise exception 'insufficient_payment';
  end if;
  if v_sc_total > v_total + 0.001 then
    raise exception 'store_credit_exceeds_total';
  end if;

  if v_sc_total > 0 then
    if p_customer_id is null then
      raise exception 'store_credit_needs_customer';
    end if;
    select coalesce(sum(delta), 0) into v_sc_bal
    from store_credit_movements
    where tenant_id = v_tenant and customer_id = p_customer_id;
    if v_sc_bal < v_sc_total - 0.001 then
      raise exception 'insufficient_store_credit';
    end if;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text)
  loop
    if v_pay.method = 'qr' then
      v_qr_ref := null;
      if v_pay.reference is not null
         and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
        select pi.id, pi.provider_key, pi.sale_id, pi.status, pi.amount
          into v_intent
        from mp_payment_intents pi
        where pi.id = v_pay.reference::uuid
          and pi.tenant_id = v_tenant
        limit 1;
        if found then
          v_qr_ref := v_intent.id;
        end if;
      end if;

      if v_qr_ref is not null then
        if v_intent.status <> 'approved' then
          raise exception 'qr_not_approved';
        end if;
        if v_intent.sale_id is not null then
          raise exception 'qr_already_charged';
        end if;
        if exists (
          select 1 from payments pmt
          join sales s on s.id = pmt.sale_id and s.tenant_id = v_tenant
          where pmt.method = 'qr' and pmt.reference = v_qr_ref::text
        ) then
          raise exception 'qr_already_charged';
        end if;
        select coalesce(sum(coalesce(q.amount, 0)), 0) into v_qr_sum
        from jsonb_to_recordset(p_payments)
          as q(method text, amount numeric, reference text)
        where q.method = 'qr'
          and q.reference is not null
          and q.reference ~ '^[0-9a-fA-F-]{36}$'
          and q.reference::uuid = v_qr_ref;
        if v_qr_sum > coalesce(v_intent.amount, 0) + 0.01 then
          raise exception 'qr_amount_mismatch';
        end if;
        v_pay_feat := case v_intent.provider_key
                        when 'mercadopago' then 'mercado_pago'
                        when 'mobbex'      then 'mobbex'
                        when 'modo'        then 'modo'
                        when 'pagos360'    then 'pagos360'
                        else null
                      end;
        if v_pay_feat is not null and not tenant_has_feature(v_pay_feat) then
          raise exception 'method_not_in_plan';
        end if;
      else
        v_qr_plain := true;
      end if;
    end if;
  end loop;

  if v_qr_plain
     and not (
       tenant_has_feature('mercado_pago')
       or tenant_has_feature('mobbex')
       or tenant_has_feature('modo')
       or tenant_has_feature('pagos360')
     ) then
    raise exception 'qr_not_allowed';
  end if;

  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number
  from sales where tenant_id = v_tenant;

  insert into sales (store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes,
                     professional_id, tip_amount, tip_method,
                     promo_id, promo_name, promo_discount,
                     coupon_id, coupon_code, coupon_discount)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total, 0, v_total, p_notes,
          v_professional, v_tip_amount,
          case when v_tip_amount > 0 then v_tip_method else null end,
          case when v_promo_disc > 0 then p_promo_id else null end,
          case when v_promo_disc > 0 then nullif(btrim(coalesce(p_promo_name, '')), '') else null end,
          v_promo_disc,
          case when v_coupon_disc > 0 then p_coupon_id else null end,
          case when v_coupon_disc > 0 then v_coupon.code else null end,
          v_coupon_disc)
  returning id into v_sale_id;

  -- Registro del canje del cupón (F9 · H54): consume un uso + traza. Atómico:
  -- la fila ya está bloqueada (FOR UPDATE arriba), así que dos cobros simultáneos
  -- no pueden pasar el tope.
  if p_coupon_id is not null and v_coupon_disc > 0 then
    update coupons set used_count = used_count + 1, updated_at = now()
     where id = p_coupon_id and tenant_id = v_tenant;
    insert into coupon_redemptions (tenant_id, coupon_id, sale_id, customer_id, discount)
    values (v_tenant, p_coupon_id, v_sale_id, p_customer_id, v_coupon_disc);
  end if;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, variant_id uuid, name text, serial text, modifiers jsonb,
           quantity numeric, unit_price numeric, discount numeric)
  loop
    if v_item.product_id is not null then
      select p.name, p.sku, p.is_kit, p.track_stock, p.has_variants
        into v_pname, v_psku, v_is_kit, v_track, v_has_variants
      from products p
      where p.id = v_item.product_id and p.tenant_id = v_tenant;
      if not found then
        raise exception 'product_not_found';
      end if;

      if coalesce(v_has_variants, false) then
        if v_item.variant_id is null then
          raise exception 'variant_required';
        end if;
        select * into v_variant from product_variants
         where id = v_item.variant_id and product_id = v_item.product_id
           and tenant_id = v_tenant and deleted_at is null;
        if not found then
          raise exception 'variant_not_found';
        end if;
        v_pname := v_pname || ' · ' || v_variant.option1
                   || coalesce(' / ' || v_variant.option2, '');
      elsif v_item.variant_id is not null then
        raise exception 'variant_not_allowed';
      end if;
    else
      v_pname  := coalesce(nullif(btrim(v_item.name), ''), 'Venta rápida');
      v_psku   := null;
      v_is_kit := false;
      v_track  := false;
      v_has_variants := false;
    end if;

    v_serial := nullif(btrim(coalesce(v_item.serial, '')), '');

    -- ADR-056: precio de lista calculado y motivo del cambio manual (mismo orden
    -- que p_items; vacío en el cobro en espera acreditado).
    insert into sale_items (sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            list_price, price_override_reason)
    values (v_sale_id, v_item.product_id, v_item.variant_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0),
            coalesce(v_item.modifiers, '[]'::jsonb),
            (v_prices -> v_n ->> 'list_price')::numeric,
            v_prices -> v_n ->> 'reason');
    v_n := v_n + 1;

    if v_item.product_id is not null then
      if v_is_kit then
        for v_comp in
          select pkc.component_product_id, pkc.quantity,
                 pr.stock as comp_stock, pr.allow_negative as comp_allow, pr.track_stock as comp_track
          from product_kit_components pkc
          join products pr on pr.id = pkc.component_product_id and pr.tenant_id = v_tenant
          where pkc.kit_product_id = v_item.product_id and pkc.tenant_id = v_tenant
        loop
          if v_comp.comp_track then
            if not coalesce(v_comp.comp_allow, v_allow_neg)
               and v_comp.comp_stock < (v_item.quantity * v_comp.quantity) then
              raise exception 'insufficient_stock';
            end if;
            if v_branch_stk and not coalesce(v_comp.comp_allow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_comp.component_product_id
                                and ps.variant_id is null), 0) < (v_item.quantity * v_comp.quantity) then
              raise exception 'insufficient_stock_branch';
            end if;
            update products
               set stock = stock - (v_item.quantity * v_comp.quantity), updated_at = now()
             where id = v_comp.component_product_id and tenant_id = v_tenant;

            insert into stock_movements (product_id, store_id, delta, reason, reference_id)
            values (v_comp.component_product_id, v_store,
                    -(v_item.quantity * v_comp.quantity), 'sale', v_sale_id);
          end if;
        end loop;
      else
        if v_track then
          if coalesce(v_has_variants, false) then
            select pr.allow_negative into v_pallow from products pr
             where pr.id = v_item.product_id and pr.tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_variant.stock < v_item.quantity then
              raise exception 'insufficient_stock';
            end if;
            if v_branch_stk and not coalesce(v_pallow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_item.product_id
                                and ps.variant_id = v_variant.id), 0) < v_item.quantity then
              raise exception 'insufficient_stock_branch';
            end if;

            update product_variants
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_variant.id and tenant_id = v_tenant;

            insert into stock_movements (product_id, variant_id, store_id, delta, reason, reference_id)
            values (v_item.product_id, v_variant.id, v_store, -v_item.quantity, 'sale', v_sale_id);
          else
            select stock, allow_negative into v_stock, v_pallow
            from products where id = v_item.product_id and tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_stock < v_item.quantity then
              raise exception 'insufficient_stock';
            end if;
            if v_branch_stk and not coalesce(v_pallow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_item.product_id
                                and ps.variant_id is null), 0) < v_item.quantity then
              raise exception 'insufficient_stock_branch';
            end if;

            update products
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_item.product_id and tenant_id = v_tenant;

            insert into stock_movements (product_id, store_id, delta, reason, reference_id)
            values (v_item.product_id, v_store, -v_item.quantity, 'sale', v_sale_id);
          end if;
        end if;

        if v_serial is not null then
          update product_serials
             set status = 'sold', sale_id = v_sale_id
           where product_id = v_item.product_id and tenant_id = v_tenant
             and serial = v_serial and status = 'in_stock';
          if not found then
            insert into product_serials (product_id, serial, status, sale_id)
            values (v_item.product_id, v_serial, 'sold', v_sale_id)
            on conflict (product_id, serial) do update
              set status = 'sold', sale_id = v_sale_id;
          end if;
        end if;
      end if;
    end if;
  end loop;

  -- ADR-056: cambio manual de precio, con quién lo autorizó.
  if jsonb_array_length(v_overrides) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            reason, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale_id, 'price_override',
            v_overrides -> 0 ->> 'reason',
            jsonb_build_object('sale_number', v_number, 'items', v_overrides,
                               'max_deviation_pct', v_max_dev, 'supervisor_id', v_price_sup),
            v_store);
  end if;

  if v_delivery_fee > 0 then
    insert into sale_items (sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers)
    values (v_sale_id, null, null, 'Costo de envío', null, null,
            1, v_delivery_fee, 0, v_delivery_fee, '[]'::jsonb);
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text, card_voucher jsonb)
  loop
    insert into payments (sale_id, method, amount, reference, card_voucher)
    values (v_sale_id, v_pay.method, v_pay.amount, v_pay.reference,
            coalesce(v_pay.card_voucher, '{}'::jsonb));

    if v_pay.method = 'qr'
       and v_pay.reference is not null
       and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
      update mp_payment_intents
         set sale_id = v_sale_id, updated_at = now()
       where id = v_pay.reference::uuid
         and tenant_id = v_tenant
         and sale_id is null;
    end if;

    insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
    values (v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);

    if v_pay.method = 'store_credit' then
      insert into store_credit_movements (customer_id, delta, reason)
      values (p_customer_id, -coalesce(v_pay.amount, 0), 'Pago venta #' || v_number);
    end if;
  end loop;

  for v_pack in
    select (e.id)::uuid as pack_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
    where lower(coalesce(e.kind,'')) = 'pack' and e.id is not null
  loop
    select * into v_pk from service_packs
     where id = v_pack.pack_id and tenant_id = v_tenant and deleted_at is null;
    if not found then
      raise exception 'pack_not_found';
    end if;
    insert into customer_pack_credits (
      customer_id, pack_id, pack_name, product_id,
      sessions_total, sessions_used, expires_at, sale_id
    )
    values (
      p_customer_id, v_pk.id, v_pk.name, v_pk.product_id,
      v_pk.sessions, 0,
      case when v_pk.validity_days is not null
           then now() + make_interval(days => v_pk.validity_days) else null end,
      v_sale_id
    );
  end loop;

  for v_pack in
    select (e.id)::uuid as credit_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
    where lower(coalesce(e.kind,'')) = 'pack_session' and e.id is not null
  loop
    select * into v_pcredit from customer_pack_credits
     where id = v_pack.credit_id and tenant_id = v_tenant
       and customer_id = p_customer_id
     for update;
    if not found then
      raise exception 'pack_credit_not_found';
    end if;
    if v_pcredit.sessions_used >= v_pcredit.sessions_total then
      raise exception 'pack_no_sessions_left';
    end if;
    if v_pcredit.expires_at is not null and v_pcredit.expires_at < now() then
      raise exception 'pack_expired';
    end if;

    update customer_pack_credits
       set sessions_used = sessions_used + 1
     where id = v_pcredit.id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            before_data, after_data)
    values (v_tenant, auth.uid(), 'customer_pack_credits', v_pcredit.id, 'pack_session_used',
            jsonb_build_object('sessions_used', v_pcredit.sessions_used,
                               'sessions_total', v_pcredit.sessions_total),
            jsonb_build_object('sessions_used', v_pcredit.sessions_used + 1,
                               'sessions_total', v_pcredit.sessions_total,
                               'sale_id', v_sale_id, 'sale_number', v_number));
  end loop;

  if p_table_order_id is not null then
    update table_orders
       set sale_id = v_sale_id, status = 'cobrada', updated_at = now()
     where id = p_table_order_id and tenant_id = v_tenant;

    update dining_tables
       set status = 'libre', current_order_id = null, waiter_user_id = null
     where id = v_table_order.table_id and tenant_id = v_tenant
       and current_order_id = p_table_order_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            after_data)
    values (v_tenant, auth.uid(), 'table_orders', p_table_order_id, 'table_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'table_id', v_table_order.table_id));
  end if;

  if p_delivery_order_id is not null then
    update delivery_orders
       set sale_id = v_sale_id, status = 'entregado', updated_at = now()
     where id = p_delivery_order_id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            after_data)
    values (v_tenant, auth.uid(), 'delivery_orders', p_delivery_order_id, 'delivery_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'order_type', v_delivery_order.order_type,
                               'delivery_fee', v_delivery_fee));
  end if;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total,
                            'tip', v_tip_amount, 'promo_discount', v_promo_disc,
                            'coupon_discount', v_coupon_disc);
end;
$function$;

revoke all on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Mesas y delivery: el precio del ítem lo valida el servidor al cargarlo
-- -----------------------------------------------------------------------------
create or replace function trg_order_item_price()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_exp numeric;
begin
  if tg_op = 'UPDATE'
     and new.unit_price is not distinct from old.unit_price
     and new.product_id is not distinct from old.product_id
     and new.modifiers is not distinct from old.modifiers then
    return new;
  end if;
  if new.product_id is null then
    if not coalesce((_effective_config(new.tenant_id, 'pos_settings', '', null, null) -> 'value'
                     ->> 'allow_free_sale')::boolean, true) then
      raise exception 'free_sale_not_allowed';
    end if;
    return new;
  end if;
  v_exp := _resolve_unit_price(new.tenant_id, new.product_id, null, new.qty, null, null, null, now());
  if v_exp is null then raise exception 'product_not_found'; end if;
  v_exp := round(v_exp + _sale_modifier_delta(new.tenant_id, new.product_id, new.modifiers), 2);
  if abs(coalesce(new.unit_price, 0) - v_exp) > 0.01 then
    raise exception using message = 'price_mismatch:' || jsonb_build_object('items', jsonb_build_array(
      jsonb_build_object('product_id', new.product_id, 'variant_id', null,
                         'expected', v_exp, 'received', new.unit_price)))::text,
                          errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function trg_order_item_price() from public, anon, authenticated;

drop trigger if exists table_order_items_price on table_order_items;
create trigger table_order_items_price
  before insert or update of unit_price, product_id, modifiers on table_order_items
  for each row execute function trg_order_item_price();

drop trigger if exists delivery_order_items_price on delivery_order_items;
create trigger delivery_order_items_price
  before insert or update of unit_price, product_id, modifiers on delivery_order_items
  for each row execute function trg_order_item_price();
