-- =============================================================================
-- 20261026100100_balanza_cajon  (ADR-063 · F10 H23 / H24 · F17 "abrir cajón sin venta con PIN")
--
-- Balanza y cajón de dinero, separados en dos niveles:
--
--   1. Por negocio / sucursal (capa de herencia de ADR-049, dominio
--      pos_settings): usa productos pesables (scale_enabled), formato de la
--      etiqueta de balanza (scale_label), abrir el cajón al cobrar en efectivo
--      (drawer_open_on_cash) y la política para abrirlo sin venta
--      (drawer_no_sale: allow / pin / deny). Son reglas del negocio: se pisan
--      por grupo o sucursal, nunca por caja.
--   2. Por caja (register_hardware): lo que está ENCHUFADO en esa caja. La
--      balanza (modelo, conexión, protocolo) y el cajón (impresora que lo
--      abre, pulso ESC/POS, "esta caja no tiene cajón"). Es un registro de
--      equipos como payment_terminals y printers (ADR-049, BASE): no depende
--      de multi_caja, porque un kiosco con una sola caja también tiene balanza.
--
-- Cada apertura del cajón (al cobrar, sin venta o de prueba) pasa por
-- cash_drawer_open(): decide con la política efectiva de la caja, pide el PIN
-- de supervisor ('abrir_cajon') cuando corresponde, deja la fila en
-- cash_drawer_events (permitida o rechazada) y en audit_logs, y devuelve si se
-- puede abrir. El navegador manda el pulso sólo con allowed = true.
--
-- Partes:
--   A) pos_settings: columnas, validación y guarda de features.
--   B) config_field_type / config_field_error: copia de 20261019100000 con los
--      campos nuevos; guarda de features en config_overrides.
--   C) register_hardware + register_hardware_set().
--   D) PIN de supervisor: acción 'abrir_cajon'.
--   E) cash_drawer_events + cash_drawer_open().
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) pos_settings
-- -----------------------------------------------------------------------------

-- Forma del formato de etiqueta (espejo de scaleFormatProblem en
-- lib/barcode/scaleLabel.ts). EAN-13: prefijo (2) + código (N) + [dígito del
-- valor] + valor + dígito verificador.
create or replace function scale_label_error(p jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  k       text;
  v_n     int;
  v_dec   int;
  v_vcd   boolean;
  v_len   int;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return 'invalid_type'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('prefixes', 'code_digits', 'embed', 'decimals', 'value_check_digit', 'verify_check_digit') then
      return 'invalid_key';
    end if;
  end loop;
  if jsonb_typeof(p -> 'prefixes') <> 'array'
     or jsonb_array_length(p -> 'prefixes') not between 1 and 10 then
    return 'invalid_prefixes';
  end if;
  if exists (select 1 from jsonb_array_elements(p -> 'prefixes') e
              where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^2[0-9]$') then
    return 'invalid_prefixes';
  end if;
  if jsonb_typeof(p -> 'code_digits') <> 'number' then return 'invalid_type'; end if;
  v_n := (p ->> 'code_digits')::numeric::int;
  if v_n not between 4 and 6 then return 'out_of_range'; end if;
  if coalesce(p ->> 'embed', '') not in ('price', 'weight') then return 'invalid_embed'; end if;
  if jsonb_typeof(p -> 'decimals') <> 'number' then return 'invalid_type'; end if;
  v_dec := (p ->> 'decimals')::numeric::int;
  if v_dec not between 0 and 3 then return 'out_of_range'; end if;
  if jsonb_typeof(coalesce(p -> 'value_check_digit', 'false'::jsonb)) <> 'boolean'
     or jsonb_typeof(coalesce(p -> 'verify_check_digit', 'true'::jsonb)) <> 'boolean' then
    return 'invalid_type';
  end if;
  v_vcd := coalesce((p ->> 'value_check_digit')::boolean, false);
  v_len := 10 - v_n - case when v_vcd then 1 else 0 end;
  -- El dígito del valor sólo existe para valores de 4 o 5 dígitos (GS1).
  if v_vcd and v_len not in (4, 5) then return 'value_check_digit_unsupported'; end if;
  if v_dec > v_len then return 'out_of_range'; end if;
  return null;
end;
$$;
grant execute on function scale_label_error(jsonb) to authenticated, service_role;

alter table pos_settings add column if not exists scale_enabled boolean not null default false;
alter table pos_settings add column if not exists scale_label jsonb not null default
  '{"prefixes":["20","21","22","23","24","25","26","27","28","29"],"code_digits":5,"embed":"price","decimals":0,"value_check_digit":false,"verify_check_digit":true}'::jsonb;
alter table pos_settings add column if not exists drawer_open_on_cash boolean not null default true;
alter table pos_settings add column if not exists drawer_no_sale text not null default 'pin';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pos_settings_scale_label_check') then
    alter table pos_settings add constraint pos_settings_scale_label_check check (scale_label_error(scale_label) is null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pos_settings_drawer_no_sale_check') then
    alter table pos_settings add constraint pos_settings_drawer_no_sale_check
      check (drawer_no_sale in ('allow', 'pin', 'deny'));
  end if;
end $$;

comment on column pos_settings.scale_enabled is 'ADR-063: el negocio vende productos pesables con balanza (lee etiquetas de balanza y el peso en vivo).';
comment on column pos_settings.scale_label is 'ADR-063: formato de la etiqueta de balanza (EAN-13, prefijos 20-29, código, precio o peso embebido).';
comment on column pos_settings.drawer_open_on_cash is 'ADR-063: abrir el cajón al cerrar una venta con efectivo.';
comment on column pos_settings.drawer_no_sale is 'ADR-063: abrir el cajón sin venta: allow (permitido), pin (con PIN de supervisor) o deny (prohibido).';

-- Gating real (CLAUDE.md §6): prender la balanza o cambiar la política del
-- cajón exige la feature. Son BASE: sólo un plan a medida que las apaga corta.
create or replace function pos_settings_hardware_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.scale_enabled
     and (tg_op = 'INSERT' or not old.scale_enabled or new.scale_label is distinct from old.scale_label)
     and not tenant_has_feature_for(new.tenant_id, 'balanza') then
    raise exception 'feature_not_in_plan: balanza' using errcode = '42501';
  end if;
  if (tg_op = 'INSERT' and (new.drawer_no_sale <> 'pin' or not new.drawer_open_on_cash))
     or (tg_op = 'UPDATE' and (new.drawer_no_sale is distinct from old.drawer_no_sale
                               or new.drawer_open_on_cash is distinct from old.drawer_open_on_cash)) then
    if not tenant_has_feature_for(new.tenant_id, 'cajon_dinero') then
      raise exception 'feature_not_in_plan: cajon_dinero' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists pos_settings_hardware_guard on pos_settings;
create trigger pos_settings_hardware_guard
  before insert or update on pos_settings
  for each row execute function pos_settings_hardware_guard();

-- -----------------------------------------------------------------------------
-- B) Whitelist de la herencia (copia de 20261019100000 + campos ADR-063)
-- -----------------------------------------------------------------------------
-- Copia de 20261019100000 (incluye card_voucher_rules, transfer_* y
-- max_free_sale) con scale_enabled, scale_label, drawer_open_on_cash y
-- drawer_no_sale: por grupo y sucursal, NUNCA por caja (lo de la caja vive en
-- register_hardware).
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
        -- Transferencia (ADR-055): la caja puede mostrar u omitir la pantalla.
        when p_field = 'transfer_show_screen' then 'bool'
        when p_scope = 'register' then null
        when p_field = 'surcharge_pct' then 'num'
        when p_field = 'plan_mode' then 'text'
        when p_field = 'merchant_numbers' then 'map_text'
        when p_field = 'sort' then 'num'
        when p_field = 'transfer_require_reference' then 'bool'
        when p_field = 'transfer_accounts' then 'map_any'
        when p_field = 'transfer_default_account' then 'text'
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
        -- ADR-063: balanza y cajón por negocio, grupo o sucursal.
        when p_field in ('scale_enabled', 'drawer_open_on_cash') then 'bool'
        when p_field = 'drawer_no_sale' then 'text'
        when p_field = 'scale_label' then 'map_any'
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

-- Copia de 20261019100000 con drawer_no_sale (valores cerrados) y scale_label
-- (misma validación que la columna).
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
  c_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  -- Transferencia (ADR-055): mapa id de cuenta → visible y cuenta por defecto.
  if p_domain = 'payment_method' and p_field = 'transfer_accounts' then
    if jsonb_typeof(p_value) <> 'object' then return 'invalid_type'; end if;
    for k, v in select * from jsonb_each(p_value) loop
      if k !~ c_uuid then return 'invalid_key'; end if;
      if jsonb_typeof(v) <> 'boolean' then return 'invalid_type'; end if;
    end loop;
    return null;
  end if;
  if p_domain = 'payment_method' and p_field = 'transfer_default_account' then
    if jsonb_typeof(p_value) = 'null' then return null; end if;
    if jsonb_typeof(p_value) <> 'string' or (p_value #>> '{}') !~ c_uuid then return 'invalid_type'; end if;
    return null;
  end if;
  -- ADR-063: política del cajón sin venta y formato de etiqueta de balanza.
  if p_domain = 'pos_settings' and p_field = 'drawer_no_sale' then
    if jsonb_typeof(p_value) <> 'string' or (p_value #>> '{}') not in ('allow', 'pin', 'deny') then
      return 'out_of_range';
    end if;
    return null;
  end if;
  if p_domain = 'pos_settings' and p_field = 'scale_label' then
    return scale_label_error(p_value);
  end if;

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

-- Guarda de features en los overrides (mismo criterio que pos_settings).
create or replace function config_overrides_hardware_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  k text;
begin
  if new.domain <> 'pos_settings' or new.deleted_at is not null then return new; end if;
  for k in select jsonb_object_keys(new.patch) loop
    if tg_op = 'UPDATE' and (new.patch -> k) is not distinct from (old.patch -> k) then continue; end if;
    if k in ('scale_enabled', 'scale_label')
       and not tenant_has_feature_for(new.tenant_id, 'balanza') then
      raise exception 'feature_not_in_plan: balanza' using errcode = '42501';
    end if;
    if k in ('drawer_open_on_cash', 'drawer_no_sale')
       and not tenant_has_feature_for(new.tenant_id, 'cajon_dinero') then
      raise exception 'feature_not_in_plan: cajon_dinero' using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists config_overrides_hardware_guard on config_overrides;
create trigger config_overrides_hardware_guard
  before insert or update on config_overrides
  for each row execute function config_overrides_hardware_guard();

-- -----------------------------------------------------------------------------
-- C) Equipos por caja: balanza y cajón
-- -----------------------------------------------------------------------------

-- Número JSON dentro de un rango (sin castear algo que no es número).
create or replace function _jsonb_num_between(p_val jsonb, p_lo numeric, p_hi numeric)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_val is null or jsonb_typeof(p_val) <> 'number' then return false; end if;
  return (p_val #>> '{}')::numeric between p_lo and p_hi;
end;
$$;
grant execute on function _jsonb_num_between(jsonb, numeric, numeric) to authenticated, service_role;

-- Validación de la forma (espejo de parseScaleDevice / parseDrawerDevice en
-- lib/hardware/config.ts). p_kind: 'scale' | 'drawer'. Null = válido.
create or replace function register_hardware_error(p_kind text, p jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  k      text;
  v_keys text[];
  v_bk   text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return 'invalid_type'; end if;
  if p_kind = 'scale' then
    v_keys := array['enabled', 'model', 'transport', 'protocol', 'mode', 'poll_command', 'poll_ms',
                    'regex', 'unit', 'baud', 'data_bits', 'parity', 'stop_bits',
                    'bridge_kind', 'bridge_path', 'bridge_host', 'bridge_port'];
  elsif p_kind = 'drawer' then
    v_keys := array['has_drawer', 'printer_id', 'transport', 'pin', 'on_ms', 'off_ms', 'baud',
                    'bridge_kind', 'bridge_path', 'bridge_host', 'bridge_port'];
  else
    return 'invalid_kind';
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (v_keys)) then return 'invalid_key'; end if;
  end loop;
  if pg_column_size(p) > 4000 then return 'too_long'; end if;

  -- Conexión al puente (común).
  v_bk := nullif(p ->> 'bridge_kind', '');
  if v_bk is not null and v_bk not in ('serial', 'tcp') then return 'invalid_bridge'; end if;
  if v_bk = 'serial' and coalesce(p ->> 'bridge_path', '') !~ '^[A-Za-z0-9_./:-]{1,64}$' then
    return 'invalid_bridge';
  end if;
  if v_bk = 'tcp' and (coalesce(p ->> 'bridge_host', '') !~ '^[A-Za-z0-9.-]{1,253}$'
                       or not _jsonb_num_between(p -> 'bridge_port', 1, 65535)) then
    return 'invalid_bridge';
  end if;
  if p ? 'baud' then
    if jsonb_typeof(p -> 'baud') <> 'number' then return 'out_of_range'; end if;
    if (p ->> 'baud')::numeric not in (1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200) then
      return 'out_of_range';
    end if;
  end if;

  if p_kind = 'scale' then
    if jsonb_typeof(coalesce(p -> 'enabled', 'false'::jsonb)) <> 'boolean' then return 'invalid_type'; end if;
    if char_length(coalesce(p ->> 'model', '')) > 60 then return 'too_long'; end if;
    if coalesce(p ->> 'transport', 'webserial') not in ('webserial', 'bridge', 'simulator') then return 'invalid_transport'; end if;
    if coalesce(p ->> 'protocol', 'generic') not in ('systel', 'kretz', 'moretti', 'generic') then return 'invalid_protocol'; end if;
    if coalesce(p ->> 'mode', 'continuous') not in ('continuous', 'poll') then return 'invalid_mode'; end if;
    if char_length(coalesce(p ->> 'poll_command', '')) > 24 then return 'too_long'; end if;
    if p ? 'poll_ms' and not _jsonb_num_between(p -> 'poll_ms', 100, 5000) then return 'out_of_range'; end if;
    if char_length(coalesce(p ->> 'regex', '')) > 200 then return 'too_long'; end if;
    if coalesce(p ->> 'unit', 'kg') not in ('kg', 'g') then return 'invalid_unit'; end if;
    if p ? 'data_bits' and coalesce(p ->> 'data_bits', '') not in ('7', '8') then return 'out_of_range'; end if;
    if p ? 'stop_bits' and coalesce(p ->> 'stop_bits', '') not in ('1', '2') then return 'out_of_range'; end if;
    if p ? 'parity' and coalesce(p ->> 'parity', '') not in ('none', 'even', 'odd') then return 'out_of_range'; end if;
    if coalesce(p ->> 'transport', 'webserial') = 'bridge' and v_bk is null then return 'invalid_bridge'; end if;
  else
    if jsonb_typeof(coalesce(p -> 'has_drawer', 'true'::jsonb)) <> 'boolean' then return 'invalid_type'; end if;
    if jsonb_typeof(coalesce(p -> 'printer_id', 'null'::jsonb)) not in ('null', 'string') then return 'invalid_type'; end if;
    if jsonb_typeof(p -> 'printer_id') = 'string'
       and (p ->> 'printer_id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      return 'invalid_type';
    end if;
    if coalesce(p ->> 'transport', 'none') not in ('webserial', 'webusb', 'bridge', 'simulator', 'none') then
      return 'invalid_transport';
    end if;
    if coalesce(p ->> 'pin', '2') not in ('2', '5') then return 'out_of_range'; end if;
    if p ? 'on_ms' and not _jsonb_num_between(p -> 'on_ms', 2, 510) then return 'out_of_range'; end if;
    if p ? 'off_ms' and not _jsonb_num_between(p -> 'off_ms', 2, 510) then return 'out_of_range'; end if;
    if coalesce(p ->> 'transport', 'none') = 'bridge' and v_bk is null then return 'invalid_bridge'; end if;
  end if;
  return null;
end;
$$;
grant execute on function register_hardware_error(text, jsonb) to authenticated, service_role;

create table if not exists register_hardware (
  cash_register_id uuid primary key references cash_registers(id) on delete cascade,
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  scale            jsonb not null default '{"enabled": false}'::jsonb
                     check (register_hardware_error('scale', scale) is null),
  drawer           jsonb not null default '{"has_drawer": true, "transport": "none"}'::jsonb
                     check (register_hardware_error('drawer', drawer) is null),
  updated_at       timestamptz not null default now(),
  updated_by       uuid default auth.uid()
);
create index if not exists register_hardware_tenant_idx on register_hardware (tenant_id, store_id);
comment on table register_hardware is
  'ADR-063: balanza y cajón conectados a cada caja. Escritura sólo por register_hardware_set().';

alter table register_hardware enable row level security;
drop policy if exists register_hardware_select on register_hardware;
create policy register_hardware_select on register_hardware
  for select using (
    internal_scope()
    or (tenant_id = current_tenant_id()
        and store_id = any ((select user_allowed_store_ids())::uuid[]))
  );
-- Sin policies de escritura: sólo la RPC (SECURITY DEFINER).
revoke insert, update, delete on register_hardware from anon, authenticated;
grant select on register_hardware to authenticated;

create or replace function register_hardware_set(
  p_register_id uuid,
  p_scale       jsonb default null,
  p_drawer      jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_store  uuid;
  v_before register_hardware%rowtype;
  v_after  register_hardware%rowtype;
  v_err    text;
  v_pid    uuid;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  select store_id into v_store from cash_registers
   where id = p_register_id and tenant_id = v_tenant and deleted_at is null;
  if v_store is null then raise exception 'register_not_found'; end if;
  if not (is_tenant_manager() and user_can_access_store(v_store)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_scale is not null then
    v_err := register_hardware_error('scale', p_scale);
    if v_err is not null then raise exception 'invalid_scale: %', v_err using errcode = '22023'; end if;
    if coalesce((p_scale ->> 'enabled')::boolean, false) and not tenant_has_feature_for(v_tenant, 'balanza') then
      raise exception 'feature_not_in_plan: balanza' using errcode = '42501';
    end if;
  end if;
  if p_drawer is not null then
    v_err := register_hardware_error('drawer', p_drawer);
    if v_err is not null then raise exception 'invalid_drawer: %', v_err using errcode = '22023'; end if;
    if coalesce((p_drawer ->> 'has_drawer')::boolean, true)
       and coalesce(p_drawer ->> 'transport', 'none') <> 'none'
       and not tenant_has_feature_for(v_tenant, 'cajon_dinero') then
      raise exception 'feature_not_in_plan: cajon_dinero' using errcode = '42501';
    end if;
    -- La impresora que abre el cajón tiene que ser de esta sucursal y de esta
    -- caja (o de la sucursal, sin caja).
    v_pid := nullif(p_drawer ->> 'printer_id', '')::uuid;
    if v_pid is not null and not exists (
         select 1 from printers pr
          where pr.id = v_pid and pr.tenant_id = v_tenant and pr.store_id = v_store
            and pr.deleted_at is null
            and (pr.cash_register_id is null or pr.cash_register_id = p_register_id)) then
      raise exception 'printer_not_found' using errcode = '23503';
    end if;
  end if;

  select * into v_before from register_hardware where cash_register_id = p_register_id;
  insert into register_hardware as h (cash_register_id, tenant_id, store_id, scale, drawer, updated_at, updated_by)
  values (p_register_id, v_tenant, v_store,
          coalesce(p_scale, '{"enabled": false}'::jsonb),
          coalesce(p_drawer, '{"has_drawer": true, "transport": "none"}'::jsonb),
          now(), auth.uid())
  on conflict (cash_register_id) do update
    set scale = coalesce(p_scale, h.scale),
        drawer = coalesce(p_drawer, h.drawer),
        store_id = v_store,
        updated_at = now(),
        updated_by = auth.uid()
  returning * into v_after;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_tenant, auth.uid(), 'cash_registers', p_register_id, 'register_hardware_changed',
          case when v_before.cash_register_id is null then null
               else jsonb_build_object('scale', v_before.scale, 'drawer', v_before.drawer) end,
          jsonb_build_object('scale', v_after.scale, 'drawer', v_after.drawer),
          v_store);
  return to_jsonb(v_after);
end;
$$;
revoke all on function register_hardware_set(uuid, jsonb, jsonb) from public, anon;
grant execute on function register_hardware_set(uuid, jsonb, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- D) PIN de supervisor: 'abrir_cajon'
-- -----------------------------------------------------------------------------
-- Copia de 20261019100000 con 'abrir_cajon'. La acción se pide SIEMPRE que
-- se la consulta: quien decide si hace falta PIN es la política del cajón de
-- la sucursal (pos_settings.drawer_no_sale = 'pin'), no el interruptor de
-- Seguridad. En Seguridad sólo se eligen sus modos (ADR-060).
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
    'shift_force_close', jsonb_build_object('enabled', true,  'threshold', 0),
    'abrir_cajon',       jsonb_build_object('enabled', true,  'threshold', 0));
$$;

-- Copia de 20261019100000 con 'abrir_cajon' (siempre, como el cierre forzado).
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
  if p_action in ('shift_force_close', 'abrir_cajon') then return true; end if;
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

-- -----------------------------------------------------------------------------
-- E) Aperturas del cajón
-- -----------------------------------------------------------------------------
create table if not exists cash_drawer_events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  cash_register_id uuid not null references cash_registers(id) on delete cascade,
  cash_shift_id    uuid references cash_shifts(id) on delete set null,
  user_id          uuid not null default auth.uid(),
  kind             text not null check (kind in ('sale', 'no_sale', 'test')),
  reason           text check (reason is null or char_length(reason) <= 200),
  allowed          boolean not null,
  denied_reason    text,
  supervisor_id    uuid,
  sale_id          uuid references sales(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists cash_drawer_events_register_idx
  on cash_drawer_events (tenant_id, cash_register_id, created_at desc);
create index if not exists cash_drawer_events_shift_idx on cash_drawer_events (cash_shift_id);
-- Una venta abre el cajón una sola vez (no se puede repetir con su id).
create unique index if not exists cash_drawer_events_sale_once
  on cash_drawer_events (sale_id) where allowed and sale_id is not null;
comment on table cash_drawer_events is
  'ADR-063: cada pedido de apertura del cajón (permitido o rechazado). Escritura sólo por cash_drawer_open().';

alter table cash_drawer_events enable row level security;
drop policy if exists cash_drawer_events_select on cash_drawer_events;
create policy cash_drawer_events_select on cash_drawer_events
  for select using (
    internal_scope()
    or (tenant_id = current_tenant_id()
        and store_id = any ((select user_allowed_store_ids())::uuid[])
        and ((select is_tenant_manager()) or user_id = (select auth.uid())))
  );
revoke insert, update, delete on cash_drawer_events from anon, authenticated;
grant select on cash_drawer_events to authenticated;

-- Decide, registra y devuelve si el cajón se puede abrir.
--   p_kind 'sale'    : al cerrar una venta con efectivo (p_sale_id). Política
--                      drawer_open_on_cash; una vez por venta; venta del turno.
--   p_kind 'no_sale' : "Abrir cajón" sin venta, con motivo. Política
--                      drawer_no_sale: allow / pin (require_supervisor
--                      'abrir_cajon', token en el header) / deny.
--   p_kind 'test'    : prueba de hardware; sólo dueño o encargado.
-- Rechazos (no hay cajón, sin turno, política) se registran y vuelven con
-- allowed = false. Pedir PIN corta con 'supervisor_required:abrir_cajon'
-- (withSupervisor reintenta con el token), igual que el resto de las acciones.
create or replace function cash_drawer_open(
  p_register_id uuid,
  p_kind        text,
  p_reason      text default null,
  p_sale_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_uid     uuid := auth.uid();
  v_store   uuid;
  v_shift   uuid;
  v_hw      register_hardware%rowtype;
  v_eff     jsonb;
  v_on_cash boolean;
  v_policy  text;
  v_denied  text;
  v_sup     uuid;
  v_id      uuid;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_tenant is null or v_uid is null then raise exception 'no_tenant'; end if;
  if p_kind is null or p_kind not in ('sale', 'no_sale', 'test') then raise exception 'invalid_kind'; end if;
  if not tenant_has_feature_for(v_tenant, 'cajon_dinero') then
    raise exception 'feature_not_in_plan: cajon_dinero' using errcode = '42501';
  end if;
  select store_id into v_store from cash_registers
   where id = p_register_id and tenant_id = v_tenant and deleted_at is null;
  if v_store is null then raise exception 'register_not_found'; end if;
  if not user_can_access_store(v_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_reason is not null and char_length(v_reason) > 200 then raise exception 'reason_too_long'; end if;
  if p_kind = 'no_sale' and (v_reason is null or char_length(v_reason) < 3) then
    raise exception 'reason_required';
  end if;

  select * into v_hw from register_hardware where cash_register_id = p_register_id and tenant_id = v_tenant;
  v_eff := coalesce(_effective_config(v_tenant, 'pos_settings', '', v_store, p_register_id) -> 'value', '{}'::jsonb);
  v_on_cash := coalesce((v_eff ->> 'drawer_open_on_cash')::boolean, true);
  v_policy := coalesce(v_eff ->> 'drawer_no_sale', 'pin');
  select id into v_shift from cash_shifts
   where tenant_id = v_tenant and cash_register_id = p_register_id and status = 'open'
   order by opened_at desc limit 1;

  if v_hw.cash_register_id is not null and coalesce((v_hw.drawer ->> 'has_drawer')::boolean, true) = false then
    v_denied := 'no_drawer';
  elsif p_kind = 'test' then
    if not is_tenant_manager() then v_denied := 'forbidden'; end if;
  elsif v_shift is null then
    v_denied := 'no_shift';
  elsif not shift_owner_ok(v_shift, 'sell') then
    v_denied := 'shift_not_owned';
  elsif p_kind = 'sale' then
    if not v_on_cash then
      v_denied := 'policy_off';
    elsif p_sale_id is null or not exists (
            select 1 from sales s
             where s.id = p_sale_id and s.tenant_id = v_tenant and s.cash_shift_id = v_shift
               and s.created_at > now() - interval '15 minutes'
               and exists (select 1 from payments p where p.sale_id = s.id and p.method = 'cash')) then
      v_denied := 'sale_not_cash';
    elsif exists (select 1 from cash_drawer_events e where e.sale_id = p_sale_id and e.allowed) then
      v_denied := 'already_opened';
    end if;
  else
    if v_policy = 'deny' then
      v_denied := 'policy_deny';
    elsif v_policy = 'pin' then
      -- Supervisor por rol: su sesión alcanza. Si no, el token del header.
      v_sup := require_supervisor('abrir_cajon', null, p_register_id);
    end if;
  end if;

  insert into cash_drawer_events
    (tenant_id, store_id, cash_register_id, cash_shift_id, user_id, kind, reason, allowed, denied_reason,
     supervisor_id, sale_id)
  values
    (v_tenant, v_store, p_register_id, v_shift, v_uid, p_kind, v_reason, v_denied is null, v_denied,
     v_sup, case when p_kind = 'sale' and v_denied is null then p_sale_id else null end)
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data, store_id)
  values (v_tenant, v_uid, 'cash_registers', p_register_id,
          case when v_denied is null then 'cash_drawer_opened' else 'cash_drawer_denied' end,
          v_reason,
          jsonb_build_object('kind', p_kind, 'cash_shift_id', v_shift, 'sale_id', p_sale_id,
                             'supervisor_id', v_sup, 'denied_reason', v_denied, 'event_id', v_id,
                             'policy', case when p_kind = 'sale' then v_on_cash::text else v_policy end),
          v_store);

  return jsonb_build_object(
    'allowed', v_denied is null,
    'denied_reason', v_denied,
    'event_id', v_id,
    'supervisor_id', v_sup,
    'cash_shift_id', v_shift,
    'kind', p_kind);
end;
$$;
revoke all on function cash_drawer_open(uuid, text, text, uuid) from public, anon;
grant execute on function cash_drawer_open(uuid, text, text, uuid) to authenticated;
