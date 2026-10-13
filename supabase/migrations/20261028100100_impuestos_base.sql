-- =============================================================================
-- 20261028100100_impuestos_base  (F18 · H103-H106, ADR-068)
--
-- Base fiscal: catálogos, datos fiscales del producto, de la lista, del
-- cliente y del negocio, regímenes de percepción y retención, exclusiones y
-- padrones. El motor de cálculo va en la migración siguiente.
--
--   A) Catálogos globales (lectura para todos, sin escritura por PostgREST):
--      tax_iva_rates (21, 10,5, 27, 5, 2,5, 0, exento y no gravado con su id
--      de ARCA), tax_jurisdictions (códigos de Convenio Multilateral 901 a
--      924) y tax_parameters (valores normativos con vigencia: tope de
--      identificación del consumidor final). tax_param(clave, fecha).
--   B) Producto: tax_rate_code (reemplaza a tax_rate numérico, que queda como
--      espejo para compatibilidad: compras, import y quien escriba tax_rate),
--      is_service (concepto de WSFE) e impuestos internos (modo, base, tasa
--      nominal, monto fijo, incluido o adicional). Variante: tax_rate_code
--      propio opcional. Lista de precios: prices_include_tax (con IVA o neto).
--   C) Cliente: condición fiscal ampliada (RI, monotributo, monotributo
--      social, exento, CF, no responsable, no categorizado, no alcanzado, IVA
--      liberado, exterior), jurisdicción de IIBB y validación del CUIT/CUIL
--      (dígito verificador) y del DNI en el servidor.
--   D) tax_settings: condición frente al IVA del negocio, CUIT, IIBB,
--      jurisdicción, Convenio Multilateral, alícuota de los ítems sin
--      producto y si emite M. tax_settings_get / tax_settings_save (owner o
--      manager, feature impuestos_iva, auditoría; espeja la condición en
--      tenant_branding para el ticket).
--   E) tax_regimes: el negocio como agente (IVA, IIBB por jurisdicción,
--      Ganancias, SUSS) de percepción o retención con padrón, alícuota
--      general, alícuota por condición, base, mínimos y condiciones
--      alcanzadas. Gateado por percepciones_retenciones.
--   F) tax_exemptions: certificados de exclusión por cliente o proveedor.
--   G) Padrones: tax_padron_imports + tax_padron_entries, import por partes
--      desde el navegador (start → rows → finish) y consulta por CUIT.
--
-- RLS: lectura `tenant_id = current_tenant_id() or internal_scope()`
-- (ADR-052); escritura sólo owner o manager con la feature, auditada.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Catálogos
-- -----------------------------------------------------------------------------
create table if not exists tax_iva_rates (
  code    text primary key,
  rate    numeric(5,2) not null check (rate >= 0 and rate <= 100),
  arca_id int not null unique,
  kind    text not null check (kind in ('gravado', 'exento', 'no_gravado')),
  label   text not null,
  sort    int not null default 0
);
comment on table tax_iva_rates is
  'Catálogo cerrado de IVA (ADR-068). arca_id: AlicIva de WSFE (3 a 9) y, para el Libro IVA, 1 no gravado y 2 exento. Orientativo: se confirma con FEParamGetTiposIva.';

insert into tax_iva_rates (code, rate, arca_id, kind, label, sort) values
  ('21',         21,   5, 'gravado',    '21 %',       1),
  ('10.5',       10.5, 4, 'gravado',    '10,5 %',     2),
  ('27',         27,   6, 'gravado',    '27 %',       3),
  ('5',          5,    8, 'gravado',    '5 %',        4),
  ('2.5',        2.5,  9, 'gravado',    '2,5 %',      5),
  ('0',          0,    3, 'gravado',    '0 %',        6),
  ('exento',     0,    2, 'exento',     'Exento',     7),
  ('no_gravado', 0,    1, 'no_gravado', 'No gravado', 8)
on conflict (code) do nothing;

alter table tax_iva_rates enable row level security;
drop policy if exists tax_iva_rates_read on tax_iva_rates;
create policy tax_iva_rates_read on tax_iva_rates for select to authenticated using (true);
revoke insert, update, delete on tax_iva_rates from anon, authenticated;
grant select on tax_iva_rates to authenticated;

create table if not exists tax_jurisdictions (
  code          text primary key check (code ~ '^9\d{2}$'),
  name          text not null,
  agency        text not null,
  padron_format text check (padron_format is null or padron_format in ('arba', 'agip'))
);
comment on table tax_jurisdictions is
  'Jurisdicciones de IIBB con el código de Convenio Multilateral (901 CABA a 924 Tucumán).';

insert into tax_jurisdictions (code, name, agency, padron_format) values
  ('901', 'Ciudad de Buenos Aires', 'AGIP', 'agip'),
  ('902', 'Buenos Aires', 'ARBA', 'arba'),
  ('903', 'Catamarca', 'AGR Catamarca', null),
  ('904', 'Córdoba', 'Rentas Córdoba', null),
  ('905', 'Corrientes', 'DGR Corrientes', null),
  ('906', 'Chaco', 'ATP Chaco', null),
  ('907', 'Chubut', 'DGR Chubut', null),
  ('908', 'Entre Ríos', 'ATER', null),
  ('909', 'Formosa', 'DGR Formosa', null),
  ('910', 'Jujuy', 'DPR Jujuy', null),
  ('911', 'La Pampa', 'DGR La Pampa', null),
  ('912', 'La Rioja', 'DGIP La Rioja', null),
  ('913', 'Mendoza', 'ATM Mendoza', null),
  ('914', 'Misiones', 'DGR Misiones', null),
  ('915', 'Neuquén', 'DPR Neuquén', null),
  ('916', 'Río Negro', 'ART Río Negro', null),
  ('917', 'Salta', 'DGR Salta', null),
  ('918', 'San Juan', 'DGR San Juan', null),
  ('919', 'San Luis', 'DPIP San Luis', null),
  ('920', 'Santa Cruz', 'ASIP Santa Cruz', null),
  ('921', 'Santa Fe', 'API Santa Fe', null),
  ('922', 'Santiago del Estero', 'DGR Santiago del Estero', null),
  ('923', 'Tierra del Fuego', 'AREF', null),
  ('924', 'Tucumán', 'DGR Tucumán', null)
on conflict (code) do nothing;

alter table tax_jurisdictions enable row level security;
drop policy if exists tax_jurisdictions_read on tax_jurisdictions;
create policy tax_jurisdictions_read on tax_jurisdictions for select to authenticated using (true);
revoke insert, update, delete on tax_jurisdictions from anon, authenticated;
grant select on tax_jurisdictions to authenticated;

-- Valores normativos con vigencia: nunca constantes en el código.
create table if not exists tax_parameters (
  key        text not null,
  valid_from date not null,
  value      numeric not null,
  note       text,
  primary key (key, valid_from)
);
comment on table tax_parameters is
  'Parámetros fiscales con vigencia (ADR-068). Se actualizan por migración cuando cambia la norma; los valores sembrados son orientativos.';

insert into tax_parameters (key, valid_from, value, note) values
  ('cf_id_threshold', '2025-05-01', 10000000,
   'Tope de la factura a consumidor final sin identificar al comprador (orientativo: validar la RG vigente con el contador)')
on conflict do nothing;

alter table tax_parameters enable row level security;
drop policy if exists tax_parameters_read on tax_parameters;
create policy tax_parameters_read on tax_parameters for select to authenticated using (true);
revoke insert, update, delete on tax_parameters from anon, authenticated;
grant select on tax_parameters to authenticated;

create or replace function tax_param(p_key text, p_at date default current_date)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select t.value from tax_parameters t
   where t.key = p_key and t.valid_from <= coalesce(p_at, current_date)
   order by t.valid_from desc
   limit 1;
$$;
grant execute on function tax_param(text, date) to authenticated, service_role;

-- Código del catálogo para una alícuota numérica (compatibilidad con tax_rate).
create or replace function _tax_code_from_rate(p_rate numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case coalesce(p_rate, 21)
           when 21 then '21' when 10.5 then '10.5' when 27 then '27'
           when 5 then '5' when 2.5 then '2.5' when 0 then '0'
           else null end;
$$;

-- -----------------------------------------------------------------------------
-- B) Producto, variante y lista
-- -----------------------------------------------------------------------------
alter table products add column if not exists tax_rate_code text not null default '21' references tax_iva_rates(code);
alter table products add column if not exists is_service boolean not null default false;
alter table products add column if not exists internal_tax_mode text not null default 'none';
alter table products add column if not exists internal_tax_base text not null default 'price';
alter table products add column if not exists internal_tax_rate numeric(7,4);
alter table products add column if not exists internal_tax_amount numeric(12,2);
alter table products add column if not exists internal_tax_included boolean not null default true;

alter table products drop constraint if exists products_internal_tax_check;
alter table products add constraint products_internal_tax_check check (
  internal_tax_mode in ('none', 'pct', 'fixed')
  and internal_tax_base in ('price', 'cost')
  and (internal_tax_rate is null or (internal_tax_rate >= 0 and internal_tax_rate < 100))
  and (internal_tax_amount is null or internal_tax_amount >= 0)
  and (internal_tax_mode <> 'pct' or internal_tax_rate is not null)
  and (internal_tax_mode <> 'fixed' or internal_tax_amount is not null)
);

comment on column products.tax_rate_code is
  'Alícuota de IVA del catálogo tax_iva_rates (ADR-068). tax_rate queda como espejo numérico (exento y no gravado = 0).';
comment on column products.internal_tax_rate is
  'Impuestos internos: tasa NOMINAL en %. Sobre el precio integra su propia base (efectiva = t / (1 - t)).';

-- Backfill antes del trigger: sólo las filas que no son 21 % (el default).
update products set tax_rate_code = coalesce(_tax_code_from_rate(tax_rate), '21')
 where tax_rate is distinct from 21 and _tax_code_from_rate(tax_rate) is distinct from '21';

alter table product_variants add column if not exists tax_rate_code text references tax_iva_rates(code);
comment on column product_variants.tax_rate_code is
  'Alícuota de IVA propia de la variante (null = la del producto).';

alter table price_lists add column if not exists prices_include_tax boolean not null default true;
comment on column price_lists.prices_include_tax is
  'true: los precios de la lista son finales (con IVA). false: son netos y el resolver suma el IVA del producto (ADR-068).';

-- tax_rate ↔ tax_rate_code y gating del IVA y de los internos.
create or replace function trg_products_tax()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
begin
  if tg_op = 'INSERT' then
    -- Alta legacy: sólo tax_rate (import, clientes viejos).
    if new.tax_rate_code = '21' and new.tax_rate is distinct from 21 then
      v_code := _tax_code_from_rate(new.tax_rate);
      if v_code is null then raise exception 'invalid_tax_rate' using errcode = 'check_violation'; end if;
      new.tax_rate_code := v_code;
    end if;
  elsif new.tax_rate_code is distinct from old.tax_rate_code then
    null; -- manda el código
  elsif new.tax_rate is distinct from old.tax_rate then
    v_code := _tax_code_from_rate(new.tax_rate);
    if v_code is null then raise exception 'invalid_tax_rate' using errcode = 'check_violation'; end if;
    new.tax_rate_code := v_code;
  end if;
  select r.rate into new.tax_rate from tax_iva_rates r where r.code = new.tax_rate_code;

  if new.tax_rate_code <> '21'
     and (tg_op = 'INSERT' or new.tax_rate_code is distinct from old.tax_rate_code)
     and not tenant_has_feature_for(new.tenant_id, 'impuestos_iva') then
    raise exception 'feature_not_in_plan: impuestos_iva' using errcode = 'check_violation';
  end if;

  if new.internal_tax_mode <> 'none'
     and (tg_op = 'INSERT'
          or old.internal_tax_mode is distinct from new.internal_tax_mode
          or old.internal_tax_rate is distinct from new.internal_tax_rate
          or old.internal_tax_amount is distinct from new.internal_tax_amount
          or old.internal_tax_base is distinct from new.internal_tax_base
          or old.internal_tax_included is distinct from new.internal_tax_included)
     and not tenant_has_feature_for(new.tenant_id, 'impuestos_internos') then
    raise exception 'feature_not_in_plan: impuestos_internos' using errcode = 'check_violation';
  end if;
  if new.internal_tax_mode = 'none' then
    new.internal_tax_rate := null;
    new.internal_tax_amount := null;
    new.internal_tax_included := true;
  end if;
  return new;
end;
$$;
revoke all on function trg_products_tax() from public, anon, authenticated;

drop trigger if exists products_tax on products;
create trigger products_tax
  before insert or update of tax_rate, tax_rate_code, internal_tax_mode, internal_tax_base,
                             internal_tax_rate, internal_tax_amount, internal_tax_included
  on products
  for each row execute function trg_products_tax();

create or replace function trg_variants_tax()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.tax_rate_code is not null
     and (tg_op = 'INSERT' or new.tax_rate_code is distinct from old.tax_rate_code)
     and not tenant_has_feature_for(new.tenant_id, 'impuestos_iva') then
    raise exception 'feature_not_in_plan: impuestos_iva' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function trg_variants_tax() from public, anon, authenticated;

drop trigger if exists product_variants_tax on product_variants;
create trigger product_variants_tax
  before insert or update of tax_rate_code on product_variants
  for each row execute function trg_variants_tax();

-- -----------------------------------------------------------------------------
-- C) Cliente
-- -----------------------------------------------------------------------------
alter table customers drop constraint if exists customers_iva_condition_check;
alter table customers add constraint customers_iva_condition_check check (
  iva_condition is null or iva_condition in
    ('consumidor_final', 'responsable_inscripto', 'monotributo', 'monotributo_social', 'exento',
     'no_responsable', 'no_categorizado', 'no_alcanzado', 'iva_liberado', 'exterior'));

alter table customers add column if not exists iibb_jurisdiction text references tax_jurisdictions(code);
comment on column customers.iibb_jurisdiction is
  'Jurisdicción del domicilio fiscal para IIBB (ADR-068). Informativa: la percepción sale del padrón.';

-- Documento válido (sólo cuando cambia: no rompe la edición de filas viejas).
create or replace function trg_customers_fiscal()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_d text := regexp_replace(coalesce(new.document_number, ''), '\D', '', 'g');
begin
  if tg_op = 'UPDATE'
     and new.document_type is not distinct from old.document_type
     and new.document_number is not distinct from old.document_number then
    return new;
  end if;
  if nullif(btrim(coalesce(new.document_number, '')), '') is null then return new; end if;
  if new.document_type in ('cuit', 'cuil') and not (length(v_d) = 11 and cuit_is_valid(v_d)) then
    raise exception 'invalid_cuit' using errcode = 'check_violation';
  end if;
  if new.document_type = 'dni' and v_d !~ '^\d{7,8}$' then
    raise exception 'invalid_dni' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists customers_fiscal on customers;
create trigger customers_fiscal
  before insert or update of document_type, document_number on customers
  for each row execute function trg_customers_fiscal();

-- Tipo de documento e id de condición de ARCA (orientativos, ver lib/tax/catalog.ts).
create or replace function doc_type_arca_id(p_type text)
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_type when 'cuit' then 80 when 'cuil' then 86 when 'dni' then 96
                     when 'passport' then 94 else 99 end;
$$;
grant execute on function doc_type_arca_id(text) to authenticated, service_role;

create or replace function fiscal_condition_arca_id(p_cond text)
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
  select case coalesce(p_cond, 'consumidor_final')
           when 'responsable_inscripto' then 1 when 'exento' then 4 when 'consumidor_final' then 5
           when 'monotributo' then 6 when 'no_categorizado' then 7 when 'exterior' then 9
           when 'iva_liberado' then 10 when 'monotributo_social' then 13
           when 'no_alcanzado' then 15 when 'no_responsable' then 15 else 5 end;
$$;
grant execute on function fiscal_condition_arca_id(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- D) Datos fiscales del negocio
-- -----------------------------------------------------------------------------
create table if not exists tax_settings (
  tenant_id              uuid primary key references tenants(id) on delete cascade,
  iva_condition          text check (iva_condition is null or iva_condition in
                           ('responsable_inscripto', 'monotributo', 'monotributo_social', 'exento', 'no_alcanzado')),
  cuit                   text check (cuit is null or (cuit ~ '^\d{11}$' and cuit_is_valid(cuit))),
  iibb_number            text check (iibb_number is null or char_length(iibb_number) <= 30),
  iibb_jurisdiction      text references tax_jurisdictions(code),
  convenio_multilateral  boolean not null default false,
  activity_start         date,
  default_rate_code      text not null default '21' references tax_iva_rates(code),
  issues_cbte_m          boolean not null default false,
  updated_at             timestamptz not null default now(),
  updated_by             uuid
);
comment on table tax_settings is
  'Datos fiscales del negocio (ADR-068). Sin fila: condición y CUIT salen de tenant_branding, IVA de los ítems sin producto 21 %.';

alter table tax_settings enable row level security;
drop policy if exists tax_settings_read on tax_settings;
create policy tax_settings_read on tax_settings for select
  using (tenant_id = current_tenant_id() or internal_scope());
revoke insert, update, delete on tax_settings from anon, authenticated;
grant select on tax_settings to authenticated;

-- Efectivos (con los defaults y el respaldo de tenant_branding).
create or replace function _tax_settings_eff(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'iva_condition', coalesce(s.iva_condition,
                              case when b.iva_condition in ('responsable_inscripto', 'monotributo', 'exento')
                                   then b.iva_condition end),
    'cuit', coalesce(s.cuit, nullif(regexp_replace(coalesce(b.cuit, ''), '\D', '', 'g'), '')),
    'iibb_number', s.iibb_number,
    'iibb_jurisdiction', s.iibb_jurisdiction,
    'convenio_multilateral', coalesce(s.convenio_multilateral, false),
    'activity_start', s.activity_start,
    'default_rate_code', coalesce(s.default_rate_code, '21'),
    'issues_cbte_m', coalesce(s.issues_cbte_m, false),
    'configured', s.tenant_id is not null,
    'updated_at', s.updated_at)
  from (select p_tenant as id) t
  left join tax_settings s on s.tenant_id = t.id
  left join tenant_branding b on b.tenant_id = t.id;
$$;
revoke all on function _tax_settings_eff(uuid) from public, anon, authenticated;

create or replace function tax_can_write(p_feature text default 'impuestos_iva')
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(stock_my_role() in ('owner', 'manager'), false)
     and coalesce(tenant_has_feature_for(current_tenant_id(), p_feature), false);
$$;
revoke all on function tax_can_write(text) from public, anon;
grant execute on function tax_can_write(text) to authenticated;

create or replace function tax_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  return _tax_settings_eff(v_tenant) || jsonb_build_object(
    'features', jsonb_build_object(
      'iva', tenant_has_feature_for(v_tenant, 'impuestos_iva'),
      'internos', tenant_has_feature_for(v_tenant, 'impuestos_internos'),
      'percepciones', tenant_has_feature_for(v_tenant, 'percepciones_retenciones')),
    'can_write', coalesce(stock_my_role() in ('owner', 'manager'), false),
    'agent', exists (select 1 from tax_regimes r
                      where r.tenant_id = v_tenant and r.is_active and r.deleted_at is null
                        and r.role = 'perception')
             and tenant_has_feature_for(v_tenant, 'percepciones_retenciones'),
    'cf_id_threshold', tax_param('cf_id_threshold', current_date));
end;
$$;
-- (tax_regimes se crea más abajo; plpgsql resuelve la tabla al ejecutar.)
revoke all on function tax_settings_get() from public, anon;
grant execute on function tax_settings_get() to authenticated;

create or replace function tax_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_before jsonb;
  v_cond   text;
  v_cuit   text;
  v_jur    text;
  v_rate   text;
  v_start  date;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not coalesce(stock_my_role() in ('owner', 'manager'), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'impuestos_iva') then
    raise exception 'feature_not_in_plan: impuestos_iva' using errcode = 'check_violation';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_payload'; end if;
  v_before := _tax_settings_eff(v_tenant);

  v_cond := case when p ? 'iva_condition' then nullif(p ->> 'iva_condition', '') else v_before ->> 'iva_condition' end;
  if v_cond is not null and v_cond not in ('responsable_inscripto', 'monotributo', 'monotributo_social', 'exento', 'no_alcanzado') then
    raise exception 'invalid_iva_condition';
  end if;
  v_cuit := case when p ? 'cuit' then nullif(regexp_replace(coalesce(p ->> 'cuit', ''), '\D', '', 'g'), '')
                 else v_before ->> 'cuit' end;
  if v_cuit is not null and not (length(v_cuit) = 11 and cuit_is_valid(v_cuit)) then
    raise exception 'invalid_cuit';
  end if;
  v_jur := case when p ? 'iibb_jurisdiction' then nullif(p ->> 'iibb_jurisdiction', '') else v_before ->> 'iibb_jurisdiction' end;
  if v_jur is not null and not exists (select 1 from tax_jurisdictions j where j.code = v_jur) then
    raise exception 'invalid_jurisdiction';
  end if;
  v_rate := coalesce(nullif(p ->> 'default_rate_code', ''), v_before ->> 'default_rate_code', '21');
  if not exists (select 1 from tax_iva_rates r where r.code = v_rate) then raise exception 'invalid_tax_rate'; end if;
  v_start := case when p ? 'activity_start' then nullif(p ->> 'activity_start', '')::date
                  else (v_before ->> 'activity_start')::date end;

  insert into tax_settings as s (tenant_id, iva_condition, cuit, iibb_number, iibb_jurisdiction,
                                 convenio_multilateral, activity_start, default_rate_code, issues_cbte_m,
                                 updated_at, updated_by)
  values (v_tenant, v_cond, v_cuit,
          case when p ? 'iibb_number' then left(nullif(btrim(p ->> 'iibb_number'), ''), 30) else v_before ->> 'iibb_number' end,
          v_jur,
          coalesce((p ->> 'convenio_multilateral')::boolean, (v_before ->> 'convenio_multilateral')::boolean, false),
          v_start, v_rate,
          coalesce((p ->> 'issues_cbte_m')::boolean, (v_before ->> 'issues_cbte_m')::boolean, false),
          now(), auth.uid())
  on conflict (tenant_id) do update
    set iva_condition = excluded.iva_condition,
        cuit = excluded.cuit,
        iibb_number = excluded.iibb_number,
        iibb_jurisdiction = excluded.iibb_jurisdiction,
        convenio_multilateral = excluded.convenio_multilateral,
        activity_start = excluded.activity_start,
        default_rate_code = excluded.default_rate_code,
        issues_cbte_m = excluded.issues_cbte_m,
        updated_at = now(),
        updated_by = auth.uid();

  -- El ticket lee la condición de tenant_branding: se mantiene igual.
  if v_cond in ('responsable_inscripto', 'monotributo', 'exento') then
    insert into tenant_branding (tenant_id, iva_condition) values (v_tenant, v_cond)
    on conflict (tenant_id) do update set iva_condition = excluded.iva_condition;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'tax_settings', v_tenant, 'tax_settings_changed', v_before, _tax_settings_eff(v_tenant));
  return tax_settings_get();
end;
$$;
revoke all on function tax_settings_save(jsonb) from public, anon;
grant execute on function tax_settings_save(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Regímenes de percepción y retención (el negocio como agente)
-- -----------------------------------------------------------------------------
create table if not exists tax_regimes (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  tax                text not null check (tax in ('iva', 'iibb', 'ganancias', 'suss')),
  role               text not null check (role in ('perception', 'retention')),
  jurisdiction       text references tax_jurisdictions(code),
  name               text not null check (char_length(btrim(name)) between 1 and 80),
  is_active          boolean not null default true,
  agent_number       text check (agent_number is null or char_length(agent_number) <= 30),
  regime_code        text check (regime_code is null or char_length(regime_code) <= 20),
  padron_source      text not null default 'none' check (padron_source in ('none', 'arba', 'agip', 'generic')),
  default_rate       numeric(7,4) check (default_rate is null or (default_rate >= 0 and default_rate <= 100)),
  rates_by_condition jsonb not null default '{}'::jsonb check (jsonb_typeof(rates_by_condition) = 'object'),
  base_kind          text not null default 'net' check (base_kind in ('net', 'net_taxed', 'total')),
  min_base           numeric(14,2) not null default 0 check (min_base >= 0),
  min_amount         numeric(14,2) not null default 0 check (min_amount >= 0),
  applies_to         text[] not null default array['responsable_inscripto', 'monotributo', 'exento']::text[],
  arca_tributo_id    int,
  notes              text check (notes is null or char_length(notes) <= 300),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  constraint tax_regimes_jurisdiction_check check (
    (tax = 'iibb') = (jurisdiction is not null)),
  constraint tax_regimes_padron_check check (
    padron_source = 'none'
    or (padron_source = 'arba' and jurisdiction = '902')
    or (padron_source = 'agip' and jurisdiction = '901')
    or (padron_source = 'generic' and jurisdiction is not null))
);
comment on table tax_regimes is
  'Regímenes en los que el negocio es agente (ADR-068): jurisdicción × impuesto × condición del cliente → alícuota del padrón o general, base, mínimos.';

create unique index if not exists tax_regimes_unique
  on tax_regimes (tenant_id, tax, role, coalesce(jurisdiction, ''))
  where deleted_at is null;

create or replace function trg_tax_regimes_check()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  k text;
  v jsonb;
  c constant text[] := array['consumidor_final', 'responsable_inscripto', 'monotributo', 'monotributo_social',
                             'exento', 'no_responsable', 'no_categorizado', 'no_alcanzado', 'iva_liberado', 'exterior'];
begin
  if not (new.applies_to <@ c) then raise exception 'invalid_applies_to' using errcode = 'check_violation'; end if;
  for k, v in select * from jsonb_each(new.rates_by_condition) loop
    if not (k = any (c)) or jsonb_typeof(v) <> 'number'
       or (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 100 then
      raise exception 'invalid_rates_by_condition' using errcode = 'check_violation';
    end if;
  end loop;
  if new.arca_tributo_id is null and new.role = 'perception' then
    new.arca_tributo_id := case new.tax when 'iva' then 6 when 'iibb' then 7 else 9 end;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tax_regimes_check on tax_regimes;
create trigger tax_regimes_check before insert or update on tax_regimes
  for each row execute function trg_tax_regimes_check();

alter table tax_regimes enable row level security;
drop policy if exists tax_regimes_read on tax_regimes;
create policy tax_regimes_read on tax_regimes for select
  using (tenant_id = current_tenant_id() or internal_scope());
drop policy if exists tax_regimes_insert on tax_regimes;
create policy tax_regimes_insert on tax_regimes for insert
  with check (tenant_id = current_tenant_id() and tax_can_write('percepciones_retenciones'));
drop policy if exists tax_regimes_update on tax_regimes;
create policy tax_regimes_update on tax_regimes for update
  using (tenant_id = current_tenant_id() and tax_can_write('percepciones_retenciones'))
  with check (tenant_id = current_tenant_id() and tax_can_write('percepciones_retenciones'));
-- Sin DELETE: baja lógica.
revoke delete on tax_regimes from anon, authenticated;
grant select, insert, update on tax_regimes to authenticated;

drop trigger if exists audit_tax_regimes on tax_regimes;
create trigger audit_tax_regimes after insert or update or delete on tax_regimes
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- F) Exclusiones (certificados) de clientes y proveedores
-- -----------------------------------------------------------------------------
create table if not exists tax_exemptions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  party        text not null check (party in ('customer', 'supplier')),
  party_id     uuid not null,
  tax          text not null check (tax in ('iva', 'iibb', 'ganancias', 'suss')),
  jurisdiction text references tax_jurisdictions(code),
  pct          numeric(5,2) not null default 100 check (pct > 0 and pct <= 100),
  valid_from   date not null,
  valid_to     date,
  certificate  text check (certificate is null or char_length(certificate) <= 60),
  notes        text check (notes is null or char_length(notes) <= 300),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint tax_exemptions_dates check (valid_to is null or valid_to >= valid_from)
);
create index if not exists tax_exemptions_party_idx on tax_exemptions (tenant_id, party, party_id) where deleted_at is null;

create or replace function trg_tax_exemptions_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.party = 'customer'
     and not exists (select 1 from customers c where c.id = new.party_id and c.tenant_id = new.tenant_id) then
    raise exception 'customer_not_found';
  end if;
  if new.party = 'supplier'
     and not exists (select 1 from suppliers s where s.id = new.party_id and s.tenant_id = new.tenant_id) then
    raise exception 'supplier_not_found';
  end if;
  return new;
end;
$$;
revoke all on function trg_tax_exemptions_check() from public, anon, authenticated;

drop trigger if exists tax_exemptions_check on tax_exemptions;
create trigger tax_exemptions_check before insert or update of party, party_id on tax_exemptions
  for each row execute function trg_tax_exemptions_check();

alter table tax_exemptions enable row level security;
drop policy if exists tax_exemptions_read on tax_exemptions;
create policy tax_exemptions_read on tax_exemptions for select
  using (tenant_id = current_tenant_id() or internal_scope());
drop policy if exists tax_exemptions_insert on tax_exemptions;
create policy tax_exemptions_insert on tax_exemptions for insert
  with check (tenant_id = current_tenant_id() and tax_can_write('percepciones_retenciones'));
drop policy if exists tax_exemptions_update on tax_exemptions;
create policy tax_exemptions_update on tax_exemptions for update
  using (tenant_id = current_tenant_id() and tax_can_write('percepciones_retenciones'))
  with check (tenant_id = current_tenant_id() and tax_can_write('percepciones_retenciones'));
revoke delete on tax_exemptions from anon, authenticated;
grant select, insert, update on tax_exemptions to authenticated;

drop trigger if exists audit_tax_exemptions on tax_exemptions;
create trigger audit_tax_exemptions after insert or update or delete on tax_exemptions
  for each row execute function write_audit_log();

-- % de exclusión vigente (el mayor) o 0.
create or replace function _tax_exemption_pct(p_tenant uuid, p_party text, p_party_id uuid, p_tax text,
                                              p_jur text, p_at date)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(max(e.pct), 0) from tax_exemptions e
   where e.tenant_id = p_tenant and e.party = p_party and e.party_id = p_party_id
     and e.tax = p_tax and e.deleted_at is null
     and (e.jurisdiction is null or e.jurisdiction is not distinct from p_jur)
     and e.valid_from <= p_at and (e.valid_to is null or e.valid_to >= p_at);
$$;
revoke all on function _tax_exemption_pct(uuid, text, uuid, text, text, date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- G) Padrones
-- -----------------------------------------------------------------------------
create table if not exists tax_padron_imports (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  jurisdiction  text not null references tax_jurisdictions(code),
  format        text not null check (format in ('arba', 'agip', 'generic')),
  kind          text not null check (kind in ('perception', 'retention', 'both')),
  file_name     text check (file_name is null or char_length(file_name) <= 200),
  only_known    boolean not null default true,
  period_from   date,
  period_to     date,
  rows_loaded   int not null default 0,
  rows_skipped  int not null default 0,
  rows_error    int not null default 0,
  status        text not null default 'loading' check (status in ('loading', 'ready', 'error', 'replaced')),
  error         text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists tax_padron_imports_tenant_idx on tax_padron_imports (tenant_id, jurisdiction, status, created_at desc);

create table if not exists tax_padron_entries (
  import_id        uuid not null references tax_padron_imports(id) on delete cascade,
  tenant_id        uuid not null references tenants(id) on delete cascade,
  jurisdiction     text not null,
  cuit             text not null check (cuit ~ '^\d{11}$'),
  valid_from       date not null,
  valid_to         date not null,
  perception_rate  numeric(7,4) check (perception_rate is null or (perception_rate >= 0 and perception_rate <= 100)),
  retention_rate   numeric(7,4) check (retention_rate is null or (retention_rate >= 0 and retention_rate <= 100)),
  group_code       text check (group_code is null or char_length(group_code) <= 10),
  primary key (import_id, cuit, valid_from)
);
create index if not exists tax_padron_entries_lookup on tax_padron_entries (tenant_id, jurisdiction, cuit, valid_from desc);

alter table tax_padron_imports enable row level security;
drop policy if exists tax_padron_imports_read on tax_padron_imports;
create policy tax_padron_imports_read on tax_padron_imports for select
  using (tenant_id = current_tenant_id() or internal_scope());
revoke insert, update, delete on tax_padron_imports from anon, authenticated;
grant select on tax_padron_imports to authenticated;

alter table tax_padron_entries enable row level security;
drop policy if exists tax_padron_entries_read on tax_padron_entries;
create policy tax_padron_entries_read on tax_padron_entries for select
  using (tenant_id = current_tenant_id() or internal_scope());
revoke insert, update, delete on tax_padron_entries from anon, authenticated;
grant select on tax_padron_entries to authenticated;

create or replace function _tax_padron_assert()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not coalesce(stock_my_role() in ('owner', 'manager'), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'percepciones_retenciones') then
    raise exception 'feature_not_in_plan: percepciones_retenciones' using errcode = 'check_violation';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _tax_padron_assert() from public, anon, authenticated;

-- p: {jurisdiction, format, kind?, file_name?, only_known?}
create or replace function tax_padron_import_start(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_padron_assert();
  v_jur    text := p ->> 'jurisdiction';
  v_fmt    text := coalesce(p ->> 'format', 'generic');
  v_kind   text := coalesce(p ->> 'kind', 'both');
  v_id     uuid;
begin
  if not exists (select 1 from tax_jurisdictions j where j.code = v_jur) then raise exception 'invalid_jurisdiction'; end if;
  if v_fmt not in ('arba', 'agip', 'generic') then raise exception 'invalid_format'; end if;
  if (v_fmt = 'arba' and v_jur <> '902') or (v_fmt = 'agip' and v_jur <> '901') then
    raise exception 'format_jurisdiction_mismatch';
  end if;
  if v_kind not in ('perception', 'retention', 'both') then raise exception 'invalid_kind'; end if;
  -- Un import a medio cargar de hace más de un día no sirve: se descarta.
  delete from tax_padron_imports
   where tenant_id = v_tenant and status = 'loading' and created_at < now() - interval '1 day';
  insert into tax_padron_imports (tenant_id, jurisdiction, format, kind, file_name, only_known)
  values (v_tenant, v_jur, v_fmt, v_kind, left(p ->> 'file_name', 200),
          coalesce((p ->> 'only_known')::boolean, true))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function tax_padron_import_start(jsonb) from public, anon;
grant execute on function tax_padron_import_start(jsonb) to authenticated;

-- p_rows: [{cuit, valid_from, valid_to, perception_rate?, retention_rate?, group_code?}] (hasta 5000).
create or replace function tax_padron_import_rows(p_import uuid, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_padron_assert();
  v_imp    tax_padron_imports%rowtype;
  v_n      int;
begin
  select * into v_imp from tax_padron_imports where id = p_import and tenant_id = v_tenant for update;
  if not found then raise exception 'import_not_found'; end if;
  if v_imp.status <> 'loading' then raise exception 'import_closed'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_rows'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'too_many_rows'; end if;

  if exists (
    select 1 from jsonb_to_recordset(p_rows)
      as r(cuit text, valid_from date, valid_to date, perception_rate numeric, retention_rate numeric)
     where coalesce(r.cuit, '') !~ '^\d{11}$' or not cuit_is_valid(r.cuit)
        or r.valid_from is null or r.valid_to is null or r.valid_to < r.valid_from
        or (r.perception_rate is null and r.retention_rate is null)
        or coalesce(r.perception_rate, 0) not between 0 and 100
        or coalesce(r.retention_rate, 0) not between 0 and 100
        or (v_imp.kind = 'perception' and r.perception_rate is null)
        or (v_imp.kind = 'retention' and r.retention_rate is null)) then
    raise exception 'invalid_rows';
  end if;

  insert into tax_padron_entries as e (import_id, tenant_id, jurisdiction, cuit, valid_from, valid_to,
                                       perception_rate, retention_rate, group_code)
  select v_imp.id, v_tenant, v_imp.jurisdiction, r.cuit, r.valid_from, r.valid_to,
         case when v_imp.kind = 'retention' then null else r.perception_rate end,
         case when v_imp.kind = 'perception' then null else r.retention_rate end,
         left(r.group_code, 10)
    from jsonb_to_recordset(p_rows)
      as r(cuit text, valid_from date, valid_to date, perception_rate numeric, retention_rate numeric, group_code text)
  on conflict (import_id, cuit, valid_from) do update
    set valid_to = excluded.valid_to,
        perception_rate = coalesce(excluded.perception_rate, e.perception_rate),
        retention_rate = coalesce(excluded.retention_rate, e.retention_rate),
        group_code = coalesce(excluded.group_code, e.group_code);
  get diagnostics v_n = row_count;
  update tax_padron_imports set rows_loaded = rows_loaded + v_n where id = v_imp.id;
  return v_n;
end;
$$;
revoke all on function tax_padron_import_rows(uuid, jsonb) from public, anon;
grant execute on function tax_padron_import_rows(uuid, jsonb) to authenticated;

-- p: {rows_skipped?, rows_error?, period_from?, period_to?}. Deja el import
-- vigente y reemplaza (borra) los anteriores de la misma jurisdicción, tipo y
-- período: la historia de otros meses se conserva para ventas con fecha vieja.
create or replace function tax_padron_import_finish(p_import uuid, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_padron_assert();
  v_imp    tax_padron_imports%rowtype;
  v_from   date;
  v_to     date;
  v_repl   int;
begin
  select * into v_imp from tax_padron_imports where id = p_import and tenant_id = v_tenant for update;
  if not found then raise exception 'import_not_found'; end if;
  if v_imp.status <> 'loading' then raise exception 'import_closed'; end if;
  select min(e.valid_from), max(e.valid_to) into v_from, v_to from tax_padron_entries e where e.import_id = v_imp.id;
  v_from := coalesce(v_from, nullif(p ->> 'period_from', '')::date);
  v_to := coalesce(v_to, nullif(p ->> 'period_to', '')::date);

  with old as (
    update tax_padron_imports i set status = 'replaced'
     where i.tenant_id = v_tenant and i.id <> v_imp.id and i.status = 'ready'
       and i.jurisdiction = v_imp.jurisdiction
       and (i.kind = v_imp.kind or v_imp.kind = 'both')
       and v_from is not null and i.period_from >= v_from and i.period_to <= v_to
    returning i.id)
  select count(*) into v_repl from old;
  delete from tax_padron_entries e
   using tax_padron_imports i
   where e.import_id = i.id and i.tenant_id = v_tenant and i.status = 'replaced';

  update tax_padron_imports
     set status = 'ready', finished_at = now(), period_from = v_from, period_to = v_to,
         rows_skipped = greatest(coalesce((p ->> 'rows_skipped')::int, 0), 0),
         rows_error = greatest(coalesce((p ->> 'rows_error')::int, 0), 0)
   where id = v_imp.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'tax_padron_imports', v_imp.id, 'tax_padron_imported',
          jsonb_build_object('jurisdiction', v_imp.jurisdiction, 'format', v_imp.format, 'kind', v_imp.kind,
                             'file_name', v_imp.file_name, 'rows', v_imp.rows_loaded,
                             'period_from', v_from, 'period_to', v_to, 'replaced', v_repl));
  return (select to_jsonb(i) from tax_padron_imports i where i.id = v_imp.id);
end;
$$;
revoke all on function tax_padron_import_finish(uuid, jsonb) from public, anon;
grant execute on function tax_padron_import_finish(uuid, jsonb) to authenticated;

create or replace function tax_padron_import_delete(p_import uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_padron_assert();
  v_imp    tax_padron_imports%rowtype;
begin
  select * into v_imp from tax_padron_imports where id = p_import and tenant_id = v_tenant;
  if not found then raise exception 'import_not_found'; end if;
  delete from tax_padron_imports where id = v_imp.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
  values (v_tenant, auth.uid(), 'tax_padron_imports', v_imp.id, 'tax_padron_deleted', to_jsonb(v_imp));
end;
$$;
revoke all on function tax_padron_import_delete(uuid) from public, anon;
grant execute on function tax_padron_import_delete(uuid) to authenticated;

-- Alícuota del padrón vigente a la fecha (null = no figura).
create or replace function _tax_padron_rate(p_tenant uuid, p_jur text, p_cuit text, p_kind text, p_at date)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when p_kind = 'retention' then e.retention_rate else e.perception_rate end
    from tax_padron_entries e
    join tax_padron_imports i on i.id = e.import_id and i.status = 'ready'
   where e.tenant_id = p_tenant and e.jurisdiction = p_jur and e.cuit = p_cuit
     and e.valid_from <= p_at and e.valid_to >= p_at
     and (case when p_kind = 'retention' then e.retention_rate else e.perception_rate end) is not null
   order by i.created_at desc, e.valid_from desc
   limit 1;
$$;
revoke all on function _tax_padron_rate(uuid, text, text, text, date) from public, anon, authenticated;

-- Consulta para la ficha del cliente o del proveedor.
create or replace function tax_padron_lookup(p_cuit text, p_at date default current_date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_cuit   text := regexp_replace(coalesce(p_cuit, ''), '\D', '', 'g');
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not tenant_has_feature_for(v_tenant, 'percepciones_retenciones') or length(v_cuit) <> 11 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'jurisdiction', j.code, 'name', j.name,
             'perception_rate', _tax_padron_rate(v_tenant, j.code, v_cuit, 'perception', p_at),
             'retention_rate', _tax_padron_rate(v_tenant, j.code, v_cuit, 'retention', p_at))
             order by j.code)
      from tax_jurisdictions j
     where exists (select 1 from tax_padron_entries e
                    where e.tenant_id = v_tenant and e.jurisdiction = j.code and e.cuit = v_cuit)), '[]'::jsonb);
end;
$$;
revoke all on function tax_padron_lookup(text, date) from public, anon;
grant execute on function tax_padron_lookup(text, date) to authenticated;
