-- =============================================================================
-- 20261015100000_config_heredable  (F17 · H92 y H93 · ADR-049)
--
-- Configuración heredable negocio → grupo de sucursales → sucursal → caja.
--
--   A) store_groups (zona o región) y stores.store_group_id.
--   B) config_overrides: override POR CAMPO (patch jsonb parcial) por alcance
--      (store_group, store, register), dominio y clave de dominio. La sucursal
--      sólo guarda lo que pisa: un cambio en el negocio llega a todas las que
--      no lo pisaron.
--   C) Whitelist de campos por dominio y alcance (config_field_type): lo que no
--      está en la lista no se puede pisar (sku_*, numeración, secretos...).
--   D) Resolución server-side: _effective_config (service / triggers) y
--      effective_config (JWT, con chequeo de acceso a la sucursal). Devuelve el
--      valor efectivo y el origen de cada campo.
--   E) Escritura sólo por RPC (config_override_set, config_override_copy,
--      config_override_reset_field): rol, acceso a la sucursal, gating por plan
--      (multi_sucursal para grupo y sucursal, multi_caja para caja), tipos y
--      auditoría. Un override nunca habilita un medio fuera del plan.
--   F) Enforcement en payments: si la sucursal (o su grupo o la caja) APAGÓ
--      un medio, el servidor rechaza el cobro aunque el front lo muestre.
--
-- Dominios del primer corte:
--   * payment_method (domain_key = provider_key): enabled, surcharge_pct,
--     plan_mode, merchant_numbers (mapa marca → n° de comercio), sort. En la
--     caja sólo enabled.
--   * pos_settings (domain_key ''): redondeo, venta en negativo, cierre ciego,
--     tolerancia, motivo de cierre, cliente obligatorio, voucher de tarjeta,
--     venta libre, garantía, recibo por mail, descuento máximo por rol, display
--     de cliente, perfiles de impresión y diseño del POS (mapas: se mezclan por
--     clave). En la caja: cierre, venta libre, display, impresión y diseño.
--   * ticket (domain_key ''): datos del encabezado y pie (razón social, CUIT,
--     teléfono, dirección, título, leyenda, pie) y use_store_contact (usar
--     dirección y teléfono de la sucursal). Sólo grupo y sucursal.
--
-- Sin multi_sucursal los overrides de grupo y sucursal quedan guardados pero
-- NO se aplican (bajar de plan no borra nada); sin multi_caja, los de caja.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) internal_scope() (ADR-052): las políticas nuevas usan internal_scope(),
--    nunca "or is_internal()". La define 20261013900000_aislamiento_staff_interno
--    (fix/sucursales-tenant); se repite IDÉNTICA para que esta rama aplique
--    sola. Con las dos mergeadas, la de acá la redefine igual (sin cambio).
-- -----------------------------------------------------------------------------
create or replace function public.internal_scope()
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.is_internal()
     and coalesce(
       (nullif(current_setting('request.headers', true), '')::json ->> 'x-ninja-scope') = 'internal',
       false
     );
$$;

grant execute on function public.internal_scope() to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- A) Grupos de sucursales
-- -----------------------------------------------------------------------------
create table if not exists store_groups (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  color       text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index if not exists store_groups_tenant_name_key
  on store_groups (tenant_id, lower(btrim(name))) where deleted_at is null;

drop trigger if exists set_updated_at_store_groups on store_groups;
create trigger set_updated_at_store_groups
  before update on store_groups
  for each row execute function set_updated_at();

alter table store_groups enable row level security;
drop policy if exists store_groups_select on store_groups;
drop policy if exists store_groups_insert on store_groups;
drop policy if exists store_groups_update on store_groups;
create policy store_groups_select on store_groups
  for select using (tenant_id = current_tenant_id() or internal_scope());
create policy store_groups_insert on store_groups
  for insert with check (tenant_id = current_tenant_id() and is_tenant_manager()
                         and tenant_has_feature_for(tenant_id, 'multi_sucursal'));
create policy store_groups_update on store_groups
  for update using (tenant_id = current_tenant_id() and is_tenant_manager())
  with check (tenant_id = current_tenant_id() and is_tenant_manager());

drop trigger if exists audit_store_groups on store_groups;
create trigger audit_store_groups
  after insert or update or delete on store_groups
  for each row execute function write_audit_log();

alter table stores
  add column if not exists store_group_id uuid references store_groups(id) on delete set null;
create index if not exists stores_group_idx on stores (store_group_id) where store_group_id is not null;

-- El grupo tiene que ser del mismo negocio y estar vivo.
create or replace function stores_check_group()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.store_group_id is not null
     and (tg_op = 'INSERT' or new.store_group_id is distinct from old.store_group_id) then
    if not exists (select 1 from store_groups g
                    where g.id = new.store_group_id and g.tenant_id = new.tenant_id
                      and g.deleted_at is null) then
      raise exception 'store_group_not_found' using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists stores_check_group on stores;
create trigger stores_check_group
  before insert or update of store_group_id on stores
  for each row execute function stores_check_group();

-- -----------------------------------------------------------------------------
-- B) Overrides
-- -----------------------------------------------------------------------------
create table if not exists config_overrides (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  scope       text not null check (scope in ('store_group', 'store', 'register')),
  scope_id    uuid not null,
  domain      text not null check (domain in ('payment_method', 'pos_settings', 'ticket')),
  domain_key  text not null default '',
  patch       jsonb not null default '{}'::jsonb check (jsonb_typeof(patch) = 'object'),
  updated_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index if not exists config_overrides_scope_key
  on config_overrides (tenant_id, scope, scope_id, domain, domain_key) where deleted_at is null;
create index if not exists config_overrides_domain_idx
  on config_overrides (tenant_id, domain, domain_key) where deleted_at is null;

drop trigger if exists set_updated_at_config_overrides on config_overrides;
create trigger set_updated_at_config_overrides
  before update on config_overrides
  for each row execute function set_updated_at();

-- Lectura: miembros del negocio (el POS resuelve su configuración con esto).
-- Escritura: sólo por RPC (no hay policies de insert/update/delete).
alter table config_overrides enable row level security;
drop policy if exists config_overrides_select on config_overrides;
create policy config_overrides_select on config_overrides
  for select using (tenant_id = current_tenant_id() or internal_scope());

-- -----------------------------------------------------------------------------
-- C) Whitelist de campos. Tipos: bool, num, text, map_text, map_num, map_any.
--    null = el campo no se puede pisar en ese alcance.
-- -----------------------------------------------------------------------------
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
        when p_field in ('print_profiles', 'pos_layout') then 'map_any'
        when p_scope = 'register' then null
        when p_field in ('allow_negative_stock', 'require_customer', 'require_card_voucher',
                         'offer_warranty', 'auto_email_receipt') then 'bool'
        when p_field = 'rounding_multiple' then 'num'
        when p_field = 'max_discount' then 'map_num'
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

-- Valida un valor contra su tipo y reglas del campo. Devuelve el código de
-- error (o null si está bien).
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
-- D) Resolución
-- -----------------------------------------------------------------------------

-- Valor base del negocio para un dominio (sólo campos pisables a nivel
-- sucursal, que es el superconjunto).
create or replace function _config_base(p_tenant uuid, p_domain text, p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_row  jsonb;
  v_out  jsonb := '{}'::jsonb;
  k      text;
  v      jsonb;
begin
  if p_domain = 'payment_method' then
    select jsonb_build_object(
             'enabled', m.enabled,
             'surcharge_pct', m.surcharge_pct,
             'plan_mode', m.config ->> 'plan_mode',
             'merchant_numbers', coalesce(m.config -> 'merchant_numbers', '{}'::jsonb),
             'sort', m.sort)
      into v_out
      from tenant_payment_methods m
     where m.tenant_id = p_tenant and m.provider_key = p_key;
    -- Sin fila: efectivo y transferencia cuentan como prendidos
    -- (lib/payments/defaults.ts); el resto, apagado.
    return coalesce(v_out, jsonb_build_object(
      'enabled', p_key in ('cash', 'transfer'), 'surcharge_pct', 0, 'plan_mode', null,
      'merchant_numbers', '{}'::jsonb, 'sort', 0));
  elsif p_domain = 'pos_settings' then
    select to_jsonb(s) into v_row from pos_settings s where s.tenant_id = p_tenant;
  elsif p_domain = 'ticket' then
    select to_jsonb(b) into v_row from tenant_branding b where b.tenant_id = p_tenant;
    v_out := jsonb_build_object('use_store_contact', false);
  end if;
  for k, v in select * from jsonb_each(coalesce(v_row, '{}'::jsonb)) loop
    if config_field_type(p_domain, 'store', k) is not null then
      v_out := v_out || jsonb_build_object(k, v);
    end if;
  end loop;
  return v_out;
end;
$$;
revoke all on function _config_base(uuid, text, text) from public, anon, authenticated;
grant execute on function _config_base(uuid, text, text) to service_role;

-- Valor efectivo + origen por campo. Sin chequeo de usuario: lo usan triggers,
-- Edges (service_role) y el wrapper effective_config.
create or replace function _effective_config(
  p_tenant      uuid,
  p_domain      text,
  p_key         text,
  p_store_id    uuid,
  p_register_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_value   jsonb := _config_base(p_tenant, p_domain, coalesce(p_key, ''));
  v_sources jsonb := '{}'::jsonb;
  v_store   uuid := p_store_id;
  v_group   uuid;
  v_multi   boolean := tenant_has_feature_for(p_tenant, 'multi_sucursal');
  v_regs    boolean := tenant_has_feature_for(p_tenant, 'multi_caja');
  r         record;
  k         text;
  v         jsonb;
  t         text;
begin
  for k in select jsonb_object_keys(v_value) loop
    v_sources := v_sources || jsonb_build_object(k, 'tenant');
  end loop;

  if p_register_id is not null and v_store is null then
    select store_id into v_store from cash_registers where id = p_register_id and tenant_id = p_tenant;
  end if;
  if v_store is not null then
    select store_group_id into v_group from stores where id = v_store and tenant_id = p_tenant;
  end if;

  for r in
    select o.scope, o.scope_id, o.patch
      from config_overrides o
     where o.tenant_id = p_tenant
       and o.domain = p_domain
       and o.domain_key = coalesce(p_key, '')
       and o.deleted_at is null
       and ((o.scope = 'store_group' and v_multi and o.scope_id = v_group)
         or (o.scope = 'store' and v_multi and o.scope_id = v_store)
         or (o.scope = 'register' and v_regs and o.scope_id = p_register_id))
     order by case o.scope when 'store_group' then 1 when 'store' then 2 else 3 end
  loop
    for k, v in select * from jsonb_each(r.patch) loop
      t := config_field_type(p_domain, r.scope, k);
      continue when t is null;
      if t like 'map%' and jsonb_typeof(v) = 'object' and jsonb_typeof(v_value -> k) = 'object' then
        v_value := v_value || jsonb_build_object(k, (v_value -> k) || v);
      else
        v_value := v_value || jsonb_build_object(k, v);
      end if;
      v_sources := v_sources || jsonb_build_object(k, r.scope || ':' || r.scope_id);
    end loop;
  end loop;

  return jsonb_build_object('value', v_value, 'sources', v_sources);
end;
$$;
revoke all on function _effective_config(uuid, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function _effective_config(uuid, text, text, uuid, uuid) to service_role;

-- Wrapper para el usuario del JWT: la sucursal (o la de la caja) tiene que
-- ser del negocio y estar dentro de su alcance.
create or replace function effective_config(
  p_domain      text,
  p_key         text default '',
  p_store_id    uuid default null,
  p_register_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_store  uuid := p_store_id;
  v_rstore uuid;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if p_domain not in ('payment_method', 'pos_settings', 'ticket') then raise exception 'invalid_domain'; end if;
  if p_register_id is not null then
    select store_id into v_rstore from cash_registers where id = p_register_id and tenant_id = v_tenant;
    if v_rstore is null then raise exception 'register_not_found'; end if;
    if v_store is not null and v_store <> v_rstore then raise exception 'register_store_mismatch'; end if;
    v_store := v_rstore;
  end if;
  if v_store is not null then
    if not exists (select 1 from stores where id = v_store and tenant_id = v_tenant) then
      raise exception 'store_not_found';
    end if;
    if not (internal_scope() or user_can_access_store(v_store)) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;
  return _effective_config(v_tenant, p_domain, coalesce(p_key, ''), v_store, p_register_id);
end;
$$;
revoke all on function effective_config(text, text, uuid, uuid) from public, anon;
grant execute on function effective_config(text, text, uuid, uuid) to authenticated;

-- ¿El medio quedó APAGADO por un override (grupo, sucursal o caja)? Sólo true
-- cuando algún override toca `enabled` y el valor final es false: un medio
-- apagado en el negocio sin overrides sigue con el comportamiento de siempre.
create or replace function payment_method_blocked_at(
  p_tenant      uuid,
  p_provider    text,
  p_store_id    uuid,
  p_register_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_eff jsonb;
begin
  if p_provider is null or (p_store_id is null and p_register_id is null) then return false; end if;
  if not exists (select 1 from config_overrides o
                  where o.tenant_id = p_tenant and o.domain = 'payment_method'
                    and o.domain_key = p_provider and o.deleted_at is null
                    and o.patch ? 'enabled') then
    return false;
  end if;
  v_eff := _effective_config(p_tenant, 'payment_method', p_provider, p_store_id, p_register_id);
  return coalesce(v_eff -> 'sources' ->> 'enabled', 'tenant') <> 'tenant'
     and coalesce((v_eff -> 'value' ->> 'enabled')::boolean, false) = false;
end;
$$;
revoke all on function payment_method_blocked_at(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function payment_method_blocked_at(uuid, text, uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- E) Escritura por RPC
-- -----------------------------------------------------------------------------

-- Chequeo común: alcance válido, del negocio, rol y plan. Devuelve la sucursal
-- del alcance (null para grupos).
create or replace function _config_scope_check(p_tenant uuid, p_scope text, p_scope_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_store   uuid;
  v_allowed uuid[];
begin
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_scope = 'store_group' then
    if not tenant_has_feature_for(p_tenant, 'multi_sucursal') then
      raise exception 'feature_not_in_plan: multi_sucursal' using errcode = '42501';
    end if;
    if not exists (select 1 from store_groups where id = p_scope_id and tenant_id = p_tenant and deleted_at is null) then
      raise exception 'scope_not_found';
    end if;
    -- Un grupo afecta varias sucursales: exige alcance central (todas).
    v_allowed := user_allowed_store_ids();
    if exists (select 1 from stores s where s.tenant_id = p_tenant and s.deleted_at is null
                and not (s.id = any (v_allowed))) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    return null;
  elsif p_scope = 'store' then
    if not tenant_has_feature_for(p_tenant, 'multi_sucursal') then
      raise exception 'feature_not_in_plan: multi_sucursal' using errcode = '42501';
    end if;
    select id into v_store from stores where id = p_scope_id and tenant_id = p_tenant and deleted_at is null;
  elsif p_scope = 'register' then
    if not tenant_has_feature_for(p_tenant, 'multi_caja') then
      raise exception 'feature_not_in_plan: multi_caja' using errcode = '42501';
    end if;
    select store_id into v_store from cash_registers
     where id = p_scope_id and tenant_id = p_tenant and deleted_at is null;
  else
    raise exception 'invalid_scope';
  end if;
  if v_store is null then raise exception 'scope_not_found'; end if;
  if not user_can_access_store(v_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  return v_store;
end;
$$;
revoke all on function _config_scope_check(uuid, text, uuid) from public, anon, authenticated;
grant execute on function _config_scope_check(uuid, text, uuid) to service_role;

-- Guarda campos (p_patch) y/o los vuelve a heredar (p_clear). Patch vacío =
-- baja lógica del override. Devuelve el patch resultante.
create or replace function config_override_set(
  p_scope      text,
  p_scope_id   uuid,
  p_domain     text,
  p_domain_key text default '',
  p_patch      jsonb default '{}'::jsonb,
  p_clear      text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_key    text := coalesce(p_domain_key, '');
  v_row    config_overrides%rowtype;
  v_before jsonb;
  v_after  jsonb;
  v_type   text;
  v_err    text;
  v_feat   text;
  k        text;
  v        jsonb;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if p_domain not in ('payment_method', 'pos_settings', 'ticket') then raise exception 'invalid_domain'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'invalid_patch'; end if;
  perform _config_scope_check(v_tenant, p_scope, p_scope_id);

  if p_domain = 'payment_method' then
    if not exists (select 1 from payment_providers where key = v_key) then
      raise exception 'invalid_domain_key';
    end if;
  elsif v_key <> '' then
    raise exception 'invalid_domain_key';
  end if;

  for k, v in select * from jsonb_each(p_patch) loop
    v_type := config_field_type(p_domain, p_scope, k);
    if v_type is null then raise exception 'field_not_allowed: %', k using errcode = '22023'; end if;
    v_err := config_field_error(p_domain, k, v_type, v);
    if v_err is not null then raise exception '%: %', v_err, k using errcode = '22023'; end if;
  end loop;

  -- Gating antes de la herencia: un override nunca prende un medio que el
  -- plan no tiene.
  if p_domain = 'payment_method' and (p_patch ->> 'enabled')::boolean is true then
    v_feat := payment_method_plan_key(v_key);
    if v_feat is not null and not tenant_has_feature_for(v_tenant, v_feat) then
      raise exception 'payment_method_not_allowed: %', v_key using errcode = '42501';
    end if;
  end if;

  select * into v_row from config_overrides
   where tenant_id = v_tenant and scope = p_scope and scope_id = p_scope_id
     and domain = p_domain and domain_key = v_key and deleted_at is null
   for update;
  v_before := coalesce(v_row.patch, '{}'::jsonb);
  v_after := (v_before || p_patch) - coalesce(p_clear, '{}'::text[]);

  if v_after = v_before then
    return v_after;
  end if;

  if v_row.id is null then
    insert into config_overrides (tenant_id, scope, scope_id, domain, domain_key, patch, updated_by)
    values (v_tenant, p_scope, p_scope_id, p_domain, v_key, v_after, auth.uid())
    returning * into v_row;
  elsif v_after = '{}'::jsonb then
    update config_overrides set patch = v_after, deleted_at = now(), updated_by = auth.uid()
     where id = v_row.id;
  else
    update config_overrides set patch = v_after, updated_by = auth.uid() where id = v_row.id;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'config_overrides', v_row.id,
          case when v_after = '{}'::jsonb then 'config_override_cleared' else 'config_override_set' end,
          jsonb_build_object('scope', p_scope, 'scope_id', p_scope_id, 'domain', p_domain,
                             'domain_key', v_key, 'patch', v_before),
          jsonb_build_object('scope', p_scope, 'scope_id', p_scope_id, 'domain', p_domain,
                             'domain_key', v_key, 'patch', v_after));
  return v_after;
end;
$$;
revoke all on function config_override_set(text, uuid, text, text, jsonb, text[]) from public, anon;
grant execute on function config_override_set(text, uuid, text, text, jsonb, text[]) to authenticated;

-- "Copiar configuración de otra sucursal" (compartir configuración): copia los
-- overrides del origen al destino para los dominios pedidos (null = todos).
-- p_mode 'replace' deja el destino igual al origen (lo que el origen no pisa,
-- el destino vuelve a heredarlo); 'merge' sólo suma o pisa los campos del
-- origen. Los campos que el destino no admite (p. ej. de sucursal a caja) se
-- saltean. Devuelve la cantidad de dominios tocados.
create or replace function config_override_copy(
  p_from_scope text,
  p_from_id    uuid,
  p_to_scope   text,
  p_to_id      uuid,
  p_domains    text[] default null,
  p_mode       text default 'replace'
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_count  int := 0;
  r        record;
  v_src    jsonb;
  v_dst    jsonb;
  v_patch  jsonb;
  v_clear  text[];
  k        text;
  v        jsonb;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if p_mode not in ('replace', 'merge') then raise exception 'invalid_mode'; end if;
  if p_from_scope = p_to_scope and p_from_id = p_to_id then raise exception 'same_scope'; end if;
  perform _config_scope_check(v_tenant, p_from_scope, p_from_id);
  perform _config_scope_check(v_tenant, p_to_scope, p_to_id);

  for r in
    select d.domain, d.domain_key
      from (
        select domain, domain_key from config_overrides
         where tenant_id = v_tenant and deleted_at is null
           and ((scope = p_from_scope and scope_id = p_from_id)
             or (p_mode = 'replace' and scope = p_to_scope and scope_id = p_to_id))
      ) d
     where p_domains is null or d.domain = any (p_domains)
     group by d.domain, d.domain_key
  loop
    select patch into v_src from config_overrides
     where tenant_id = v_tenant and scope = p_from_scope and scope_id = p_from_id
       and domain = r.domain and domain_key = r.domain_key and deleted_at is null;
    select patch into v_dst from config_overrides
     where tenant_id = v_tenant and scope = p_to_scope and scope_id = p_to_id
       and domain = r.domain and domain_key = r.domain_key and deleted_at is null;
    v_src := coalesce(v_src, '{}'::jsonb);
    v_dst := coalesce(v_dst, '{}'::jsonb);
    v_patch := '{}'::jsonb;
    for k, v in select * from jsonb_each(v_src) loop
      if config_field_type(r.domain, p_to_scope, k) is not null then
        v_patch := v_patch || jsonb_build_object(k, v);
      end if;
    end loop;
    v_clear := '{}'::text[];
    if p_mode = 'replace' then
      select coalesce(array_agg(x), '{}'::text[]) into v_clear
        from jsonb_object_keys(v_dst) x where not (v_patch ? x);
    end if;
    if v_patch <> '{}'::jsonb or cardinality(v_clear) > 0 then
      perform config_override_set(p_to_scope, p_to_id, r.domain, r.domain_key, v_patch, v_clear);
      v_count := v_count + 1;
    end if;
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'config_overrides', p_to_id, 'config_override_copied',
          jsonb_build_object('from_scope', p_from_scope, 'from_id', p_from_id,
                             'to_scope', p_to_scope, 'to_id', p_to_id,
                             'domains', p_domains, 'mode', p_mode, 'touched', v_count));
  return v_count;
end;
$$;
revoke all on function config_override_copy(text, uuid, text, uuid, text[], text) from public, anon;
grant execute on function config_override_copy(text, uuid, text, uuid, text[], text) to authenticated;

-- "Aplicar a todas": el campo vuelve a heredar del negocio en TODOS los
-- alcances (grupos, sucursales y cajas) a los que el usuario tiene acceso.
create or replace function config_override_reset_field(
  p_domain     text,
  p_domain_key text,
  p_field      text
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_count  int := 0;
  r        record;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;
  for r in
    select scope, scope_id from config_overrides
     where tenant_id = v_tenant and domain = p_domain and domain_key = coalesce(p_domain_key, '')
       and deleted_at is null and patch ? p_field
  loop
    begin
      perform config_override_set(r.scope, r.scope_id, p_domain, coalesce(p_domain_key, ''),
                                  '{}'::jsonb, array[p_field]);
      v_count := v_count + 1;
    exception when sqlstate '42501' then
      -- Alcance fuera del usuario (o plan sin la feature): se saltea.
      null;
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function config_override_reset_field(text, text, text) from public, anon;
grant execute on function config_override_reset_field(text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Enforcement en payments: medio apagado en la sucursal o caja de la venta.
-- -----------------------------------------------------------------------------
create or replace function trg_payments_branch_method()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store    uuid;
  v_register uuid;
  v_provider text;
begin
  if coalesce(new.amount, 0) <= 0 then return new; end if;
  -- Barato: sin overrides de medios en el negocio no hay nada que mirar.
  if not exists (select 1 from config_overrides o
                  where o.tenant_id = new.tenant_id and o.domain = 'payment_method'
                    and o.deleted_at is null and o.patch ? 'enabled') then
    return new;
  end if;

  select s.store_id, cs.cash_register_id into v_store, v_register
    from sales s left join cash_shifts cs on cs.id = s.cash_shift_id
   where s.id = new.sale_id;

  if new.reference is not null then
    select i.provider_key into v_provider
      from mp_payment_intents i
     where i.tenant_id = new.tenant_id
       and (i.id::text = new.reference or i.mp_payment_id = new.reference)
     order by i.created_at desc
     limit 1;
  end if;
  if v_provider is null and new.method in ('cash', 'transfer') then
    v_provider := new.method;
  end if;

  if v_provider is not null and payment_method_blocked_at(new.tenant_id, v_provider, v_store, v_register) then
    raise exception 'payment_method_disabled_in_store: %', v_provider using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists payments_branch_method on payments;
create trigger payments_branch_method
  before insert on payments
  for each row execute function trg_payments_branch_method();
