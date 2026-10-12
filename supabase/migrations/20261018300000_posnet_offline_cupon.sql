-- =============================================================================
-- 20261018300000_posnet_offline_cupon  (ADR-054 · Tarjeta en posnet pro)
--
-- Reglas del cupón del posnet offline ("Tarjeta en posnet", ADR-042):
--
--   A) pos_settings.card_voucher_rules (jsonb): por dato del cupón (lote,
--      cupon, autorizacion, ultimos4, comercio, cuotas) pedir sí/no,
--      obligatorio u opcional, numérico o alfanumérico y largo (min/max, igual
--      = exacto), con excepciones por adquirente (by_acquirer) y la lista de
--      adquirentes que se ofrecen en el POS (acquirers). Forma validada por
--      card_voucher_rules_error (CHECK + whitelist de configuración).
--   B) Herencia por sucursal y caja (ADR-049): card_voucher_rules entra a la
--      whitelist de pos_settings en todos los alcances (map_any: se pisa por
--      clave de primer nivel). config_field_type y config_field_error se
--      recrean idénticos a 20261015100000 + el campo nuevo.
--   C) Enforcement en payments: BEFORE INSERT valida card_voucher de los
--      cobros débito/crédito NO integrados contra las reglas efectivas de la
--      sucursal y caja de la venta (obligatorio + formato + adquirente). Así
--      ni el front ni una llamada directa a create_sale las saltean.
--      Compatibilidad con pos_settings.require_card_voucher (H27): prendido,
--      cupón, lote y autorización son obligatorios (antes sólo lo exigía la UI).
--
-- No se tocan create_sale ni close_cash_shift (recreadas en 20261015120000).
-- No es feature de plan nueva: es parte de Tarjeta en posnet (BASE).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Forma de las reglas
-- -----------------------------------------------------------------------------
create or replace function card_voucher_rules_error(p_rules jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_fields   text[] := array['lote', 'cupon', 'autorizacion', 'ultimos4', 'comercio', 'cuotas'];
  v_acqs     text[] := array['getnet', 'payway', 'mercadopago', 'fiserv', 'nave', 'other'];
  k          text;
  v          jsonb;
  a          text;
  ap         jsonb;
  f          text;
  r          jsonb;
  rk         text;
  rv         jsonb;
  v_patches  jsonb := '[]'::jsonb;
  p          jsonb;
begin
  if p_rules is null or jsonb_typeof(p_rules) <> 'object' then return 'invalid_type'; end if;
  if pg_column_size(p_rules) > 16000 then return 'too_long'; end if;
  for k, v in select * from jsonb_each(p_rules) loop
    if k = 'acquirers' then
      if jsonb_typeof(v) <> 'array' then return 'invalid_type'; end if;
      for ap in select * from jsonb_array_elements(v) loop
        if jsonb_typeof(ap) <> 'string' or not ((ap #>> '{}') = any (v_acqs)) then return 'invalid_acquirer'; end if;
      end loop;
    elsif k = 'fields' then
      v_patches := v_patches || jsonb_build_array(v);
    elsif k = 'by_acquirer' then
      if jsonb_typeof(v) <> 'object' then return 'invalid_type'; end if;
      for a, ap in select * from jsonb_each(v) loop
        if not (a = any (v_acqs)) then return 'invalid_acquirer'; end if;
        v_patches := v_patches || jsonb_build_array(ap);
      end loop;
    else
      return 'invalid_key';
    end if;
  end loop;

  for p in select * from jsonb_array_elements(v_patches) loop
    if jsonb_typeof(p) <> 'object' then return 'invalid_type'; end if;
    for f, r in select * from jsonb_each(p) loop
      if not (f = any (v_fields)) then return 'invalid_key'; end if;
      if jsonb_typeof(r) <> 'object' then return 'invalid_type'; end if;
      for rk, rv in select * from jsonb_each(r) loop
        if rk in ('ask', 'required') then
          if jsonb_typeof(rv) <> 'boolean' then return 'invalid_type'; end if;
        elsif rk = 'type' then
          if jsonb_typeof(rv) <> 'string' or (rv #>> '{}') not in ('numeric', 'alnum') then return 'invalid_type'; end if;
        elsif rk in ('min', 'max') then
          if jsonb_typeof(rv) <> 'number' then return 'out_of_range'; end if;
          if (rv #>> '{}')::numeric <> trunc((rv #>> '{}')::numeric)
             or (rv #>> '{}')::numeric < 1 or (rv #>> '{}')::numeric > 20 then
            return 'out_of_range';
          end if;
        else
          return 'invalid_key';
        end if;
      end loop;
      if jsonb_typeof(r -> 'min') = 'number' and jsonb_typeof(r -> 'max') = 'number'
         and (r ->> 'min')::numeric > (r ->> 'max')::numeric then
        return 'out_of_range';
      end if;
    end loop;
  end loop;
  return null;
end;
$$;
grant execute on function card_voucher_rules_error(jsonb) to authenticated, service_role;

alter table pos_settings
  add column if not exists card_voucher_rules jsonb not null default '{}'::jsonb;

alter table pos_settings drop constraint if exists pos_settings_card_voucher_rules_check;
alter table pos_settings add constraint pos_settings_card_voucher_rules_check
  check (card_voucher_rules_error(card_voucher_rules) is null);

comment on column pos_settings.card_voucher_rules is
  'Reglas del cupón del posnet offline (ADR-054): {acquirers?: text[], fields?: {campo: regla}, by_acquirer?: {adquirente: {campo: regla}}}. Regla: {ask, required, type numeric|alnum, min, max}.';

-- -----------------------------------------------------------------------------
-- B) Whitelist de configuración heredable (copia de 20261015100000 + campo)
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
        -- ADR-054: reglas del cupón, también por caja (el posnet es de la caja).
        when p_field in ('print_profiles', 'pos_layout', 'card_voucher_rules') then 'map_any'
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
-- C) Regla efectiva de un dato (espejo de lib/payments/voucherRules.ts)
-- -----------------------------------------------------------------------------
create or replace function _card_voucher_apply_rule(p_base jsonb, p_patch jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_out jsonb := p_base;
  v_min int;
  v_max int;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then return v_out; end if;
  if jsonb_typeof(p_patch -> 'ask') = 'boolean' then v_out := v_out || jsonb_build_object('ask', p_patch -> 'ask'); end if;
  if jsonb_typeof(p_patch -> 'required') = 'boolean' then
    v_out := v_out || jsonb_build_object('required', p_patch -> 'required');
  end if;
  if (p_patch ->> 'type') in ('numeric', 'alnum') then
    v_out := v_out || jsonb_build_object('type', p_patch ->> 'type');
  end if;
  if jsonb_typeof(p_patch -> 'min') = 'number' then
    v_out := v_out || jsonb_build_object('min', least(20, greatest(1, trunc((p_patch ->> 'min')::numeric)::int)));
  end if;
  if jsonb_typeof(p_patch -> 'max') = 'number' then
    v_out := v_out || jsonb_build_object('max', least(20, greatest(1, trunc((p_patch ->> 'max')::numeric)::int)));
  end if;
  v_min := (v_out ->> 'min')::int;
  v_max := (v_out ->> 'max')::int;
  if v_min > v_max then v_out := v_out || jsonb_build_object('max', v_min); end if;
  return v_out;
end;
$$;

create or replace function _card_voucher_field_rule(p_rules jsonb, p_require boolean, p_acq text, p_field text)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_rule jsonb;
begin
  -- Base de siempre (lo que pedía el POS antes de las reglas).
  v_rule := case p_field
    when 'ultimos4' then '{"ask": true, "required": false, "type": "numeric", "min": 4, "max": 4}'::jsonb
    when 'comercio' then '{"ask": false, "required": false, "type": "alnum", "min": 1, "max": 20}'::jsonb
    when 'cuotas'   then '{"ask": false, "required": false, "type": "numeric", "min": 1, "max": 2}'::jsonb
    else '{"ask": true, "required": false, "type": "alnum", "min": 1, "max": 20}'::jsonb
  end;
  v_rule := _card_voucher_apply_rule(v_rule, coalesce(p_rules, '{}'::jsonb) -> 'fields' -> p_field);
  if p_acq in ('getnet', 'payway', 'mercadopago', 'fiserv', 'nave', 'other') then
    v_rule := _card_voucher_apply_rule(v_rule, coalesce(p_rules, '{}'::jsonb) -> 'by_acquirer' -> p_acq -> p_field);
  end if;
  if coalesce(p_require, false) and p_field in ('cupon', 'lote', 'autorizacion') then
    v_rule := v_rule || '{"ask": true, "required": true}'::jsonb;
  end if;
  if not (v_rule ->> 'ask')::boolean then v_rule := v_rule || '{"required": false}'::jsonb; end if;
  return v_rule;
end;
$$;
grant execute on function _card_voucher_apply_rule(jsonb, jsonb) to authenticated, service_role;
grant execute on function _card_voucher_field_rule(jsonb, boolean, text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- D) Enforcement en payments
-- -----------------------------------------------------------------------------
create or replace function trg_payments_card_voucher()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store    uuid;
  v_register uuid;
  v_eff      jsonb;
  v_rules    jsonb;
  v_require  boolean;
  v_acq      text;
  v_cv       jsonb := coalesce(new.card_voucher, '{}'::jsonb);
  f          text;
  v_rule     jsonb;
  v_val      text;
begin
  if new.method not in ('debit', 'credit') then return new; end if;
  if coalesce(new.amount, 0) <= 0 then return new; end if;
  -- Ensayo de cobros en espera (_pc_dry_run): no es un cobro real.
  if coalesce(current_setting('ninja.pc_dry_run', true), '') = 'on' then return new; end if;

  -- Cobro integrado (Point, terminal por API, cobro en espera): el proveedor
  -- ya verificó la operación; el cupón lo completa la integración.
  if new.reference is not null and exists (
       select 1 from mp_payment_intents i
        where i.tenant_id = new.tenant_id
          and (i.id::text = new.reference or i.mp_payment_id = new.reference)) then
    return new;
  end if;

  v_acq := nullif(btrim(coalesce(v_cv ->> 'adquirente', '')), '');
  if v_acq is not null and v_acq not in ('getnet', 'payway', 'mercadopago', 'fiserv', 'nave', 'other') then
    raise exception 'card_voucher_invalid: adquirente' using errcode = 'check_violation';
  end if;

  -- Barato: sin reglas ni voucher obligatorio en el negocio, nada que mirar.
  if not exists (select 1 from pos_settings s
                  where s.tenant_id = new.tenant_id
                    and (s.require_card_voucher or s.card_voucher_rules <> '{}'::jsonb))
     and not exists (select 1 from config_overrides o
                      where o.tenant_id = new.tenant_id and o.domain = 'pos_settings'
                        and o.deleted_at is null
                        and (o.patch ? 'card_voucher_rules' or o.patch ? 'require_card_voucher')) then
    return new;
  end if;

  -- Cambio (exchange_sale): la diferencia con tarjeta se cobra desde la
  -- pantalla de cambios, que no carga cupón. Se reconoce por la devolución
  -- a crédito creada en la MISMA transacción (created_at = now()).
  if exists (select 1 from sale_returns r
              where r.tenant_id = new.tenant_id and r.created_at = now()
                and r.refund_method = 'store_credit') then
    return new;
  end if;

  select s.store_id, cs.cash_register_id into v_store, v_register
    from sales s left join cash_shifts cs on cs.id = s.cash_shift_id
   where s.id = new.sale_id;

  v_eff := _effective_config(new.tenant_id, 'pos_settings', '', v_store, v_register) -> 'value';
  v_rules := coalesce(v_eff -> 'card_voucher_rules', '{}'::jsonb);
  v_require := coalesce((v_eff ->> 'require_card_voucher')::boolean, false);

  foreach f in array array['lote', 'cupon', 'autorizacion', 'ultimos4', 'comercio', 'cuotas'] loop
    v_rule := _card_voucher_field_rule(v_rules, v_require, v_acq, f);
    continue when not (v_rule ->> 'ask')::boolean;
    v_val := nullif(btrim(coalesce(v_cv ->> f, '')), '');
    if v_val is null then
      if (v_rule ->> 'required')::boolean then
        raise exception 'card_voucher_required: %', f using errcode = 'check_violation';
      end if;
      continue;
    end if;
    if v_val !~ (case when v_rule ->> 'type' = 'numeric' then '^[0-9]+$' else '^[0-9A-Za-z]+$' end)
       or char_length(v_val) < (v_rule ->> 'min')::int
       or char_length(v_val) > (v_rule ->> 'max')::int then
      raise exception 'card_voucher_invalid: %', f using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists payments_card_voucher on payments;
create trigger payments_card_voucher
  before insert on payments
  for each row execute function trg_payments_card_voucher();
