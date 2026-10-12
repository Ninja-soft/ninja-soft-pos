-- =============================================================================
-- 20261018400000_transferencias_cuentas  (ADR-055)
--
-- Cuentas para cobrar por transferencia: banco o billetera (catálogo con logo
-- o "Otra" con logo propio), titular, CUIT, CBU / CVU, alias, tipo de cuenta,
-- moneda y nota. El POS muestra los datos en una pantalla de transferencia
-- (y en la pantalla del cliente) o cierra el ticket directo, según la config.
--
--   A) Feature `transferencia_multicuenta` (OPTIONAL, desde Pro): más de una
--      cuenta activa y elegir por sucursal o caja qué cuentas se muestran. Una
--      cuenta, la pantalla y el logo propio son BASE (parte de `transferencia`).
--   B) Validadores: cbu_is_valid (CBU y CVU, dos dígitos verificadores) y
--      cuit_is_valid (misma definición que 20261016100100).
--   C) transfer_accounts: RLS (lectura del negocio, escritura owner/manager),
--      guard con validaciones, gating y una sola cuenta por defecto. Baja
--      lógica. Auditoría con write_audit_log.
--   D) Bucket `transfer-logos` (logo propio del banco): carpeta del negocio,
--      sólo owner/manager, png / jpeg / webp hasta 512 KB.
--   E) Herencia (ADR-049): campos nuevos del medio 'transfer' en la whitelist:
--      transfer_show_screen (hasta caja), transfer_require_reference,
--      transfer_accounts (mapa id → visible) y transfer_default_account
--      (grupo y sucursal). Base del negocio en tenant_payment_methods.config.
--   F) transfer_settings_save: guarda la base del negocio (pantalla y n° de
--      operación obligatorio) con auditoría.
--   G) _transfer_effective / transfer_effective: cuentas que ve una sucursal
--      o caja, cuenta por defecto y flags.
--   H) Trigger en payments: toda transferencia guarda en metadata.transfer la
--      cuenta elegida (o la por defecto) con un snapshot para conciliar. El POS
--      manda la cuenta en card_voucher.transfer_account_id (create_sale pasa
--      card_voucher tal cual); el trigger la mueve a metadata y limpia
--      card_voucher. Con transfer_pos (marca del POS) y n° de operación
--      obligatorio, rechaza la transferencia sin número.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Feature
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('transferencia_multicuenta', 'Varias cuentas de transferencia',
   'Más de una cuenta para cobrar por transferencia y cuentas distintas por sucursal o caja',
   'pagos', false, 21)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('transferencia_multicuenta', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'transferencia_multicuenta');

-- -----------------------------------------------------------------------------
-- B) Validadores
-- -----------------------------------------------------------------------------
-- CBU / CVU de 22 dígitos: bloque 1 (entidad + sucursal, o 000 + PSP) con
-- pesos 7139713 y bloque 2 (cuenta) con pesos 3971397139713. Espejo de
-- isValidCbu (lib/purchases/suppliers.ts).
create or replace function cbu_is_valid(p text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  d  text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
  w1 int[] := array[7,1,3,9,7,1,3];
  w2 int[] := array[3,9,7,1,3,9,7,1,3,9,7,1,3];
  s  int := 0;
begin
  if length(d) <> 22 then return false; end if;
  for i in 1..7 loop s := s + substr(d, i, 1)::int * w1[i]; end loop;
  if (10 - s % 10) % 10 <> substr(d, 8, 1)::int then return false; end if;
  s := 0;
  for i in 1..13 loop s := s + substr(d, 8 + i, 1)::int * w2[i]; end loop;
  return (10 - s % 10) % 10 = substr(d, 22, 1)::int;
end;
$$;
grant execute on function cbu_is_valid(text) to authenticated, service_role;

-- Misma definición que 20261016100100 (idempotente si esa migración ya corrió).
create or replace function cuit_is_valid(p text)
returns boolean
language plpgsql
immutable
as $$
declare
  d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
  w int[] := array[5,4,3,2,7,6,5,4,3,2];
  s int := 0;
  c int;
begin
  if length(d) <> 11 then
    return false;
  end if;
  for i in 1..10 loop
    s := s + substr(d, i, 1)::int * w[i];
  end loop;
  c := 11 - (s % 11);
  if c = 11 then c := 0; end if;
  if c = 10 then c := 9; end if;
  return c = substr(d, 11, 1)::int;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Cuentas
-- -----------------------------------------------------------------------------
create table if not exists transfer_accounts (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  -- Slug del catálogo (lib/payments/banks.ts) o null para "Otra".
  bank_slug        text check (bank_slug is null or bank_slug ~ '^[a-z0-9-]{2,40}$'),
  bank_name        text not null check (char_length(btrim(bank_name)) between 1 and 80),
  -- Logo propio (bucket transfer-logos, carpeta del negocio).
  custom_logo_path text,
  custom_logo_url  text check (custom_logo_url is null or char_length(custom_logo_url) <= 500),
  holder_name      text not null check (char_length(btrim(holder_name)) between 1 and 120),
  cuit             text check (cuit is null or (cuit ~ '^\d{11}$' and cuit_is_valid(cuit))),
  cbu              text check (cbu is null or (cbu ~ '^\d{22}$' and cbu_is_valid(cbu))),
  alias            text check (alias is null or alias ~ '^[A-Za-z0-9.-]{6,20}$'),
  account_type     text not null default 'caja_ahorro'
                   check (account_type in ('caja_ahorro', 'cuenta_corriente', 'cuenta_virtual', 'otra')),
  currency         text not null default 'ARS' check (currency in ('ARS', 'USD')),
  note             text check (note is null or char_length(note) <= 200),
  is_default       boolean not null default false,
  is_active        boolean not null default true,
  sort             int not null default 0,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  constraint transfer_accounts_cbu_or_alias check (cbu is not null or alias is not null)
);
create index if not exists transfer_accounts_tenant_idx
  on transfer_accounts (tenant_id, sort) where deleted_at is null;
create unique index if not exists transfer_accounts_cbu_key
  on transfer_accounts (tenant_id, cbu) where deleted_at is null and cbu is not null;
create unique index if not exists transfer_accounts_alias_key
  on transfer_accounts (tenant_id, lower(alias)) where deleted_at is null and alias is not null;
create unique index if not exists transfer_accounts_default_key
  on transfer_accounts (tenant_id) where deleted_at is null and is_default;

drop trigger if exists set_updated_at_transfer_accounts on transfer_accounts;
create trigger set_updated_at_transfer_accounts
  before update on transfer_accounts
  for each row execute function set_updated_at();

-- Lectura: miembros del negocio (el POS muestra la cuenta al cobrar).
-- Escritura: owner / manager. Sin DELETE: baja lógica con deleted_at.
alter table transfer_accounts enable row level security;
drop policy if exists transfer_accounts_select on transfer_accounts;
drop policy if exists transfer_accounts_insert on transfer_accounts;
drop policy if exists transfer_accounts_update on transfer_accounts;
create policy transfer_accounts_select on transfer_accounts
  for select using (tenant_id = current_tenant_id() or internal_scope());
create policy transfer_accounts_insert on transfer_accounts
  for insert with check (tenant_id = current_tenant_id() and is_tenant_manager());
create policy transfer_accounts_update on transfer_accounts
  for update using (tenant_id = current_tenant_id() and is_tenant_manager())
  with check (tenant_id = current_tenant_id() and is_tenant_manager());

-- Normaliza, valida el logo propio, aplica el plan y deja una sola cuenta por
-- defecto.
create or replace function transfer_accounts_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_live boolean;
begin
  new.cbu   := nullif(regexp_replace(coalesce(new.cbu, ''), '\D', '', 'g'), '');
  new.cuit  := nullif(regexp_replace(coalesce(new.cuit, ''), '\D', '', 'g'), '');
  new.alias := nullif(btrim(coalesce(new.alias, '')), '');
  new.note  := nullif(btrim(coalesce(new.note, '')), '');
  new.bank_name   := btrim(new.bank_name);
  new.holder_name := btrim(new.holder_name);

  if tg_op = 'UPDATE' and new.tenant_id <> old.tenant_id then
    raise exception 'tenant_immutable' using errcode = '42501';
  end if;

  -- Logo propio: sólo de la carpeta del negocio en el bucket de logos.
  if new.custom_logo_path is not null
     and split_part(new.custom_logo_path, '/', 1) <> new.tenant_id::text then
    raise exception 'invalid_logo_path' using errcode = '42501';
  end if;
  if new.custom_logo_path is null then new.custom_logo_url := null; end if;

  v_live := new.deleted_at is null and new.is_active;
  if not v_live then new.is_default := false; end if;

  if v_live and (tg_op = 'INSERT' or not (old.deleted_at is null and old.is_active)) then
    if not tenant_has_feature_for(new.tenant_id, 'transferencia') then
      raise exception 'feature_not_in_plan: transferencia' using errcode = '42501';
    end if;
    -- Una cuenta activa es BASE; la segunda pide la feature.
    if exists (select 1 from transfer_accounts a
                where a.tenant_id = new.tenant_id and a.id <> new.id
                  and a.deleted_at is null and a.is_active)
       and not tenant_has_feature_for(new.tenant_id, 'transferencia_multicuenta') then
      raise exception 'feature_not_in_plan: transferencia_multicuenta' using errcode = '42501';
    end if;
  end if;

  -- Cambio de cuenta por defecto en curso (el update de abajo): no se repite.
  if coalesce(current_setting('ninja.transfer_default_swap', true), '') = 'on' then
    return new;
  end if;

  -- La primera cuenta activa queda por defecto.
  if v_live and not new.is_default
     and not exists (select 1 from transfer_accounts a
                      where a.tenant_id = new.tenant_id and a.id <> new.id
                        and a.deleted_at is null and a.is_default) then
    new.is_default := true;
  end if;
  if new.is_default then
    perform set_config('ninja.transfer_default_swap', 'on', true);
    update transfer_accounts set is_default = false
     where tenant_id = new.tenant_id and id <> new.id and is_default;
    perform set_config('ninja.transfer_default_swap', '', true);
  end if;
  return new;
end;
$$;
drop trigger if exists transfer_accounts_guard on transfer_accounts;
create trigger transfer_accounts_guard
  before insert or update on transfer_accounts
  for each row execute function transfer_accounts_guard();

-- Al dar de baja o pausar la cuenta por defecto, pasa a la siguiente activa.
create or replace function transfer_accounts_next_default()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('ninja.transfer_default_swap', true), '') = 'on' then
    return null;
  end if;
  if old.is_default and not new.is_default
     and not exists (select 1 from transfer_accounts a
                      where a.tenant_id = new.tenant_id and a.deleted_at is null and a.is_default) then
    update transfer_accounts set is_default = true
     where id = (select a.id from transfer_accounts a
                  where a.tenant_id = new.tenant_id and a.deleted_at is null and a.is_active
                    and a.id <> new.id
                  order by a.sort, a.created_at limit 1);
  end if;
  return null;
end;
$$;
drop trigger if exists transfer_accounts_next_default on transfer_accounts;
create trigger transfer_accounts_next_default
  after update of is_default, is_active, deleted_at on transfer_accounts
  for each row execute function transfer_accounts_next_default();

drop trigger if exists audit_transfer_accounts on transfer_accounts;
create trigger audit_transfer_accounts
  after insert or update or delete on transfer_accounts
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- D) Logos propios
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('transfer-logos', 'transfer-logos', true, 524288,
        array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "transfer_logos_read" on storage.objects;
drop policy if exists "transfer_logos_write" on storage.objects;
drop policy if exists "transfer_logos_modify" on storage.objects;
drop policy if exists "transfer_logos_remove" on storage.objects;
-- El bucket es público para mostrar el logo (URL directa); listar y borrar
-- sólo dentro de la carpeta del negocio y con rol owner / manager.
create policy "transfer_logos_read" on storage.objects for select to authenticated
  using (bucket_id = 'transfer-logos'
         and (storage.foldername(name))[1] = current_tenant_id()::text
         and is_tenant_manager());
create policy "transfer_logos_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'transfer-logos'
              and (storage.foldername(name))[1] = current_tenant_id()::text
              and is_tenant_manager());
create policy "transfer_logos_modify" on storage.objects for update to authenticated
  using (bucket_id = 'transfer-logos'
         and (storage.foldername(name))[1] = current_tenant_id()::text
         and is_tenant_manager());
create policy "transfer_logos_remove" on storage.objects for delete to authenticated
  using (bucket_id = 'transfer-logos'
         and (storage.foldername(name))[1] = current_tenant_id()::text
         and is_tenant_manager());

-- -----------------------------------------------------------------------------
-- E) Herencia: whitelist, validación y base del negocio
--    config_field_type / config_field_error: copia de 20261018300000 (incluye
--    card_voucher_rules, ADR-054) + los campos de transferencia.
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

-- Base del negocio: suma los campos de transferencia (tenant_payment_methods
-- .config del medio 'transfer'; sin fila, pantalla prendida y n° opcional).
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
  v_cfg  jsonb;
  k      text;
  v      jsonb;
begin
  if p_domain = 'payment_method' then
    select jsonb_build_object(
             'enabled', m.enabled,
             'surcharge_pct', m.surcharge_pct,
             'plan_mode', m.config ->> 'plan_mode',
             'merchant_numbers', coalesce(m.config -> 'merchant_numbers', '{}'::jsonb),
             'sort', m.sort),
           coalesce(m.config, '{}'::jsonb)
      into v_out, v_cfg
      from tenant_payment_methods m
     where m.tenant_id = p_tenant and m.provider_key = p_key;
    -- Sin fila: efectivo y transferencia cuentan como prendidos
    -- (lib/payments/defaults.ts); el resto, apagado.
    v_out := coalesce(v_out, jsonb_build_object(
      'enabled', p_key in ('cash', 'transfer'), 'surcharge_pct', 0, 'plan_mode', null,
      'merchant_numbers', '{}'::jsonb, 'sort', 0));
    if p_key = 'transfer' then
      v_cfg := coalesce(v_cfg, '{}'::jsonb);
      v_out := v_out || jsonb_build_object(
        'transfer_show_screen', coalesce((v_cfg ->> 'transfer_show_screen')::boolean, true),
        'transfer_require_reference', coalesce((v_cfg ->> 'transfer_require_reference')::boolean, false),
        'transfer_accounts', '{}'::jsonb,
        'transfer_default_account', null);
    end if;
    return v_out;
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

-- Los campos de transferencia sólo valen en el medio 'transfer'; elegir
-- cuentas por sucursal o caja pide transferencia_multicuenta (bajar de plan no
-- borra lo guardado: deja de aplicarse, ver _transfer_effective).
create or replace function config_overrides_transfer_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  k text;
begin
  if new.domain <> 'payment_method' or new.deleted_at is not null then return new; end if;
  for k in select jsonb_object_keys(new.patch) loop
    if k like 'transfer\_%' and new.domain_key <> 'transfer' then
      raise exception 'field_not_allowed: %', k using errcode = '22023';
    end if;
    if k in ('transfer_accounts', 'transfer_default_account')
       and (tg_op = 'INSERT' or (new.patch -> k) is distinct from (old.patch -> k))
       and not tenant_has_feature_for(new.tenant_id, 'transferencia_multicuenta') then
      raise exception 'feature_not_in_plan: transferencia_multicuenta' using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists config_overrides_transfer_guard on config_overrides;
create trigger config_overrides_transfer_guard
  before insert or update on config_overrides
  for each row execute function config_overrides_transfer_guard();

-- -----------------------------------------------------------------------------
-- F) Base del negocio
-- -----------------------------------------------------------------------------
create or replace function transfer_settings_save(
  p_show_screen       boolean,
  p_require_reference boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_before jsonb;
  v_patch  jsonb := jsonb_build_object(
    'transfer_show_screen', coalesce(p_show_screen, true),
    'transfer_require_reference', coalesce(p_require_reference, false));
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not tenant_has_feature_for(v_tenant, 'transferencia') then
    raise exception 'feature_not_in_plan: transferencia' using errcode = '42501';
  end if;

  select config into v_before from tenant_payment_methods
   where tenant_id = v_tenant and provider_key = 'transfer';

  insert into tenant_payment_methods (tenant_id, provider_key, enabled, sandbox, surcharge_pct, config)
  values (v_tenant, 'transfer', true, false, 0, v_patch)
  on conflict (tenant_id, provider_key) do update
    set config = coalesce(tenant_payment_methods.config, '{}'::jsonb) || v_patch;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'tenant_payment_methods', null, 'transfer_settings_saved',
          jsonb_build_object('transfer_show_screen', v_before -> 'transfer_show_screen',
                             'transfer_require_reference', v_before -> 'transfer_require_reference'),
          v_patch);
  return v_patch;
end;
$$;
revoke all on function transfer_settings_save(boolean, boolean) from public, anon;
grant execute on function transfer_settings_save(boolean, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- G) Resolución: cuentas que ve una sucursal o caja
-- -----------------------------------------------------------------------------
-- Espejo de resolveTransferConfig (lib/payments/transfer.ts). Sin
-- transferencia_multicuenta sólo vale la cuenta por defecto (o la primera
-- activa) y se ignoran las elecciones por sucursal.
create or replace function _transfer_effective(p_tenant uuid, p_store uuid, p_register uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_eff     jsonb := _effective_config(p_tenant, 'payment_method', 'transfer', p_store, p_register) -> 'value';
  v_multi   boolean := tenant_has_feature_for(p_tenant, 'transferencia_multicuenta');
  v_vis     jsonb := coalesce(v_eff -> 'transfer_accounts', '{}'::jsonb);
  v_ids     uuid[];
  v_default uuid;
  v_want    text := v_eff ->> 'transfer_default_account';
begin
  if jsonb_typeof(v_vis) <> 'object' then v_vis := '{}'::jsonb; end if;
  select coalesce(array_agg(a.id order by a.is_default desc, a.sort, a.created_at), '{}'::uuid[])
    into v_ids
    from transfer_accounts a
   where a.tenant_id = p_tenant and a.deleted_at is null and a.is_active
     and (not v_multi or coalesce((v_vis ->> a.id::text)::boolean, true));
  if not v_multi then
    v_ids := v_ids[1:1];
    v_want := null;
  end if;
  if v_want is not null and v_want::uuid = any (v_ids) then
    v_default := v_want::uuid;
  else
    v_default := v_ids[1];
  end if;
  return jsonb_build_object(
    'show_screen', coalesce((v_eff ->> 'transfer_show_screen')::boolean, true),
    'require_reference', coalesce((v_eff ->> 'transfer_require_reference')::boolean, false),
    'default_account_id', v_default,
    'account_ids', to_jsonb(v_ids));
end;
$$;
revoke all on function _transfer_effective(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function _transfer_effective(uuid, uuid, uuid) to service_role;

-- Para el usuario del JWT (mismos chequeos de acceso que effective_config).
create or replace function transfer_effective(p_store_id uuid default null, p_register_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_store  uuid := p_store_id;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if p_register_id is not null then
    select store_id into v_store from cash_registers where id = p_register_id and tenant_id = v_tenant;
    if v_store is null then raise exception 'register_not_found'; end if;
  end if;
  if v_store is not null then
    if not exists (select 1 from stores where id = v_store and tenant_id = v_tenant) then
      raise exception 'store_not_found';
    end if;
    if not (internal_scope() or user_can_access_store(v_store)) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;
  return _transfer_effective(v_tenant, v_store, p_register_id);
end;
$$;
revoke all on function transfer_effective(uuid, uuid) from public, anon;
grant execute on function transfer_effective(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- H) Pagos por transferencia: cuenta elegida + snapshot para conciliar
-- -----------------------------------------------------------------------------
create or replace function trg_payments_transfer_account()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cv       jsonb := coalesce(new.card_voucher, '{}'::jsonb);
  v_pos      boolean;
  v_id       uuid;
  v_chosen   boolean := false;
  v_store    uuid;
  v_register uuid;
  v_eff      jsonb;
  v_acc      transfer_accounts%rowtype;
begin
  if new.method <> 'transfer' then return new; end if;
  if jsonb_typeof(v_cv) <> 'object' then v_cv := '{}'::jsonb; end if;
  v_pos := v_cv ? 'transfer_pos' or v_cv ? 'transfer_account_id';
  if (v_cv ->> 'transfer_account_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    v_id := (v_cv ->> 'transfer_account_id')::uuid;
    v_chosen := true;
  end if;
  -- card_voucher sólo transporta la cuenta: no queda guardada ahí.
  new.card_voucher := v_cv - 'transfer_account_id' - 'transfer_pos';

  select s.store_id, cs.cash_register_id into v_store, v_register
    from sales s left join cash_shifts cs on cs.id = s.cash_shift_id
   where s.id = new.sale_id;
  v_eff := _transfer_effective(new.tenant_id, v_store, v_register);

  if v_pos and coalesce((v_eff ->> 'require_reference')::boolean, false)
     and coalesce(btrim(new.reference), '') = '' then
    raise exception 'transfer_reference_required' using errcode = 'check_violation';
  end if;

  if v_id is not null then
    if not (v_eff -> 'account_ids') @> to_jsonb(array[v_id::text]) then
      raise exception 'transfer_account_not_available' using errcode = 'check_violation';
    end if;
  else
    v_id := nullif(v_eff ->> 'default_account_id', '')::uuid;
  end if;
  if v_id is null then return new; end if;

  select * into v_acc from transfer_accounts where id = v_id and tenant_id = new.tenant_id;
  if v_acc.id is null then return new; end if;

  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('transfer', jsonb_build_object(
    'account_id', v_acc.id,
    'chosen', v_chosen,
    'bank_slug', v_acc.bank_slug,
    'bank_name', v_acc.bank_name,
    'holder_name', v_acc.holder_name,
    'cuit', v_acc.cuit,
    'cbu', v_acc.cbu,
    'alias', v_acc.alias,
    'account_type', v_acc.account_type,
    'currency', v_acc.currency,
    'operation', nullif(btrim(coalesce(new.reference, '')), '')));
  return new;
end;
$$;
drop trigger if exists payments_transfer_account on payments;
create trigger payments_transfer_account
  before insert on payments
  for each row execute function trg_payments_transfer_account();
