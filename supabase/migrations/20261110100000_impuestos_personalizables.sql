-- =============================================================================
-- 20261110100000_impuestos_personalizables  (F18, ADR-105)
--
-- La configuración impositiva es 100 % del negocio: todo valor normativo que
-- NinjaSoft siembra como catálogo global pasa a ser una PLANTILLA que el
-- negocio usa tal cual, pisa con vigencia (desde / hasta), desactiva, amplía
-- con valores propios o vuelve a dejar como vino.
--
--   A) tax_custom_values: valores del negocio con vigencia sobre los
--      catálogos (una fila por versión). Catálogos:
--        iva_rate       alícuota y nombre de IVA (tax_iva_rates; el código y
--                       el id de ARCA no cambian: los fija ARCA)
--        parameter      tax_parameters (tope de identificación del
--                       consumidor final, criterio del proveedor sin
--                       constancia, códigos de los archivos de SICORE y ARBA)
--        ret_concept    conceptos de Ganancias RG 830 y actividades de SUSS
--                       (tax_ret_concepts) y conceptos PROPIOS
--        ret_scale      escalas (tax_ret_scales) y escalas propias
--        regime_values  cambios con vigencia de un régimen del negocio
--                       (tax_regimes: alícuota general, por condición, base,
--                       mínimos) sin perder la numeración de certificados
--        iibb_activity  cambios con vigencia de la alícuota y el mínimo de
--                       una actividad de IIBB (iibb_activities)
--        suffered_rule  reglas propias para clasificar retenciones sufridas
--                       por texto o código
--      Valor efectivo a una fecha = la versión del negocio que cubre la
--      fecha (la de valid_from más nueva) y, si no hay, la plantilla. Una
--      versión con is_active = false desactiva el valor en su vigencia.
--      "Volver a la plantilla" = baja lógica de las versiones.
--   B) Parámetros nuevos (plantilla) y tax_param_for(negocio, clave, fecha).
--   C) Resolución: _tax_custom_at, _tax_iva_rate_eff, _tax_regime_eff,
--      _tax_ret_scale_amount_for, tax_ret_concept_eff (RECREADA desde
--      20261104200000: override con vigencia > ajuste viejo > catálogo, y
--      conceptos propios), tax_ret_concepts_list (suma los propios).
--   D) tax_regimes.valid_from / valid_to: el régimen aplica sólo en su
--      vigencia (lo leen _sale_tax_compute y _tax_retention_compute,
--      recreadas en 20261110100100).
--   E) Padrones: tax_padron_profiles (perfiles de importación del negocio:
--      CSV o ancho fijo, separador, columnas o posiciones, formato de fecha,
--      escala de la alícuota) y carga manual de alícuotas por CUIT
--      (tax_padron_manual_set). tax_padron_imports.profile_id y formatos
--      'profile' y 'manual'.
--   F) RPC: tax_custom_save, tax_custom_delete, tax_custom_reset (volver a la
--      plantilla), tax_custom_history (historial desde audit_logs).
--
-- Seguridad: lectura dueño o encargado (RESTRICTIVE tax_ret_can_read) o
-- staff con internal_scope(); escritura de tax_custom_values sólo por RPC
-- SECURITY DEFINER (valida cada catálogo); perfiles de padrón por PostgREST
-- con tax_can_write('percepciones_retenciones'). role_write_guard 'manage' y
-- write_audit_log en las dos tablas. Gating: impuestos_iva para IVA y el
-- tope del consumidor final; percepciones_retenciones para el resto.
-- Valores orientativos: validar con el contador.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Valores del negocio
-- -----------------------------------------------------------------------------
create table if not exists tax_custom_values (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  catalog     text not null check (catalog in ('iva_rate', 'parameter', 'ret_concept', 'ret_scale',
                                               'regime_values', 'iibb_activity', 'suffered_rule')),
  item_key    text not null check (char_length(item_key) between 1 and 120),
  valid_from  date not null default date '2000-01-01',
  valid_to    date,
  is_active   boolean not null default true,
  is_custom   boolean not null default false,
  data        jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  notes       text check (notes is null or char_length(notes) <= 300),
  created_by  uuid,
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint tax_custom_values_dates check (valid_to is null or valid_to >= valid_from)
);
comment on table tax_custom_values is
  'Valores impositivos del negocio con vigencia sobre los catálogos de NinjaSoft (ADR-105). Efectivo = versión que cubre la fecha > plantilla. is_custom = valor propio sin plantilla. Baja lógica = volver a la plantilla.';

create unique index if not exists tax_custom_values_version_key
  on tax_custom_values (tenant_id, catalog, item_key, valid_from) where deleted_at is null;
-- FK del negocio y lista por fecha (incluye las versiones borradas: historial).
create index if not exists tax_custom_values_tenant_idx on tax_custom_values (tenant_id, created_at desc);

create or replace function trg_tax_custom_values_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and (new.tenant_id, new.catalog, new.item_key, new.created_at, new.created_by)
       is distinct from (old.tenant_id, old.catalog, old.item_key, old.created_at, old.created_by) then
    raise exception 'tax_custom_immutable_key';
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is not null then
    raise exception 'tax_custom_deleted';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
revoke all on function trg_tax_custom_values_touch() from public, anon, authenticated;

drop trigger if exists tax_custom_values_touch on tax_custom_values;
create trigger tax_custom_values_touch before insert or update on tax_custom_values
  for each row execute function trg_tax_custom_values_touch();

alter table tax_custom_values enable row level security;
drop policy if exists tax_custom_values_read on tax_custom_values;
create policy tax_custom_values_read on tax_custom_values for select
  using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists tax_custom_values_role on tax_custom_values;
create policy tax_custom_values_role on tax_custom_values as restrictive for select
  using ((select tax_ret_can_read()));
revoke all on tax_custom_values from anon;
revoke insert, update, delete on tax_custom_values from authenticated;
grant select on tax_custom_values to authenticated;

drop trigger if exists role_write_guard on tax_custom_values;
create trigger role_write_guard before insert or update or delete on tax_custom_values
  for each row execute function trg_role_write_guard('manage');
drop trigger if exists audit_tax_custom_values on tax_custom_values;
create trigger audit_tax_custom_values after insert or update or delete on tax_custom_values
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- B) Parámetros (plantilla) y valor efectivo por negocio
-- -----------------------------------------------------------------------------
insert into tax_parameters (key, valid_from, value, note) values
  ('gan_unknown_as_unregistered', '2000-01-01', 0,
   'Proveedor sin condición en Ganancias cargada: 0 = se toma como inscripto (con aviso), 1 = como no inscripto. Orientativo: definirlo con el contador.'),
  ('sicore_iva_tax_code', '2000-01-01', 767,
   'Código de impuesto de SICORE para las retenciones de IVA (orientativo).'),
  ('sicore_cbte_code', '2000-01-01', 6,
   'Código de comprobante de SICORE para la orden de pago (06, orientativo).'),
  ('arba_branch', '2000-01-01', 1,
   'Sucursal del archivo de retenciones de ARBA (0001, orientativo).'),
  ('arba_activity', '2000-01-01', 6,
   'Actividad del archivo de ARBA en el nombre del lote (6 = retenciones, orientativo).')
on conflict do nothing;

-- Versión del negocio que cubre la fecha (null = no hay: rige la plantilla).
create or replace function _tax_custom_at(p_tenant uuid, p_catalog text, p_key text, p_at date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select to_jsonb(c) from tax_custom_values c
   where c.tenant_id = p_tenant and c.catalog = p_catalog and c.item_key = p_key and c.deleted_at is null
     and c.valid_from <= coalesce(p_at, current_date)
     and (c.valid_to is null or c.valid_to >= coalesce(p_at, current_date))
   order by c.valid_from desc, c.created_at desc
   limit 1;
$$;
revoke all on function _tax_custom_at(uuid, text, text, date) from public, anon, authenticated;

-- Parámetro efectivo: el del negocio (desactivado = null) o el de la plantilla.
create or replace function tax_param_for(p_tenant uuid, p_key text, p_at date default current_date)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o jsonb := _tax_custom_at(p_tenant, 'parameter', p_key, p_at);
begin
  if o is null then
    return tax_param(p_key, p_at);
  end if;
  if not coalesce((o ->> 'is_active')::boolean, true) then
    return null;
  end if;
  return coalesce((o -> 'data' ->> 'value')::numeric, tax_param(p_key, p_at));
end;
$$;
revoke all on function tax_param_for(uuid, text, date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- C) Resolución por catálogo
-- -----------------------------------------------------------------------------

-- IVA: la alícuota (sólo las gravadas) y el nombre son del negocio; el código,
-- el tipo y el id de ARCA, de la plantilla. is_active = se ofrece en las listas.
create or replace function _tax_iva_rate_eff(p_tenant uuid, p_code text, p_at date)
returns table (rate numeric, kind text, arca_id int, label text, is_active boolean, customized boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when r.kind = 'gravado' and o.data ? 'rate' then (o.data ->> 'rate')::numeric else r.rate end,
         r.kind, r.arca_id,
         coalesce(nullif(btrim(o.data ->> 'label'), ''), r.label),
         coalesce(o.is_active, true),
         o.id is not null
    from tax_iva_rates r
    left join lateral (
      select c.id, c.is_active, c.data from tax_custom_values c
       where c.tenant_id = p_tenant and c.catalog = 'iva_rate' and c.item_key = r.code and c.deleted_at is null
         and c.valid_from <= coalesce(p_at, current_date)
         and (c.valid_to is null or c.valid_to >= coalesce(p_at, current_date))
       order by c.valid_from desc, c.created_at desc
       limit 1) o on true
   where r.code = p_code;
$$;
revoke all on function _tax_iva_rate_eff(uuid, text, date) from public, anon, authenticated;

-- Régimen del negocio con los valores que rigen a la fecha. is_active = false
-- en la versión = el régimen no aplica en esa vigencia.
create or replace function _tax_regime_eff(p_regime tax_regimes, p_at date)
returns tax_regimes
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v tax_regimes := p_regime;
  o jsonb;
  d jsonb;
begin
  o := _tax_custom_at(v.tenant_id, 'regime_values', v.id::text, p_at);
  if o is null then
    return v;
  end if;
  if not coalesce((o ->> 'is_active')::boolean, true) then
    v.is_active := false;
    return v;
  end if;
  d := coalesce(o -> 'data', '{}'::jsonb);
  if d ? 'default_rate' then v.default_rate := (d ->> 'default_rate')::numeric; end if;
  if d ? 'rates_by_condition' and jsonb_typeof(d -> 'rates_by_condition') = 'object' then
    v.rates_by_condition := d -> 'rates_by_condition';
  end if;
  if d ? 'base_kind' then v.base_kind := d ->> 'base_kind'; end if;
  if d ? 'min_base' then v.min_base := coalesce((d ->> 'min_base')::numeric, 0); end if;
  if d ? 'min_amount' then v.min_amount := coalesce((d ->> 'min_amount')::numeric, 0); end if;
  return v;
end;
$$;
revoke all on function _tax_regime_eff(tax_regimes, date) from public, anon, authenticated;

-- Escala efectiva: la del negocio ({brackets: [{from, to, fixed, rate}]}) o la
-- de la plantilla. Misma fórmula que _tax_ret_scale_amount.
create or replace function _tax_ret_scale_amount_for(p_tenant uuid, p_scale text, p_subject numeric, p_at date)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o jsonb := _tax_custom_at(p_tenant, 'ret_scale', p_scale, p_at);
  b record;
begin
  if o is null or not coalesce((o ->> 'is_active')::boolean, true)
     or jsonb_typeof(o -> 'data' -> 'brackets') <> 'array' then
    return _tax_ret_scale_amount(p_scale, p_subject, p_at);
  end if;
  if coalesce(p_subject, 0) <= 0 then
    return 0;
  end if;
  select x.from_amount, x.fixed, x.rate into b
    from jsonb_to_recordset(o -> 'data' -> 'brackets') as x(from_amount numeric, to_amount numeric, fixed numeric, rate numeric)
   where p_subject > x.from_amount or x.from_amount = 0
   order by x.from_amount desc
   limit 1;
  if not found then
    return 0;
  end if;
  return round(coalesce(b.fixed, 0) + round((p_subject - b.from_amount) * coalesce(b.rate, 0) / 100, 2), 2);
end;
$$;
revoke all on function _tax_ret_scale_amount_for(uuid, text, numeric, date) from public, anon, authenticated;

-- Concepto efectivo (RECREADA desde 20261104200000): versión del negocio con
-- vigencia > ajuste sin vigencia (tax_ret_concept_settings) > catálogo. Un
-- concepto propio (is_custom) no tiene catálogo: todo sale de su versión.
create or replace function tax_ret_concept_eff(p_tenant uuid, p_tax text, p_code text, p_at date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c tax_ret_concepts%rowtype;
  s tax_ret_concept_settings%rowtype;
  o jsonb := _tax_custom_at(p_tenant, 'ret_concept', p_tax || ':' || p_code, p_at);
  d jsonb := coalesce(o -> 'data', '{}'::jsonb);
  v_custom boolean := coalesce((o ->> 'is_custom')::boolean, false);
  v_has_cat boolean;
  v_tpl jsonb;
  v_legacy boolean;
begin
  select * into c from tax_ret_concepts k
   where k.tax = p_tax and k.code = p_code and k.valid_from <= coalesce(p_at, current_date)
   order by k.valid_from desc limit 1;
  v_has_cat := found;
  if not v_has_cat and not v_custom then
    -- Concepto propio fuera de su vigencia o inexistente.
    if exists (select 1 from tax_custom_values x
                where x.tenant_id = p_tenant and x.catalog = 'ret_concept' and x.item_key = p_tax || ':' || p_code
                  and x.is_custom and x.deleted_at is null) then
      return jsonb_build_object('tax', p_tax, 'code', p_code, 'name', p_code, 'is_active', false, 'custom', true,
                                'overridden', false, 'min_non_taxable', 0, 'min_withholding', 0,
                                'uses_scale', false, 'rate_registered', null, 'rate_unregistered', null,
                                'unregistered_min_applies', false, 'sicore_tax_code', null,
                                'sicore_regime_code', null, 'source', 'Propio', 'verify', false, 'template', null);
    end if;
    return null;
  end if;
  select * into s from tax_ret_concept_settings x where x.tenant_id = p_tenant and x.tax = p_tax and x.code = p_code;
  v_legacy := found and (s.min_non_taxable is not null or s.rate_registered is not null or s.rate_unregistered is not null
                         or s.min_withholding is not null or s.sicore_regime_code is not null or not s.is_active);

  v_tpl := case when v_has_cat then jsonb_build_object(
    'name', c.name, 'min_non_taxable', c.min_non_taxable, 'rate_registered', c.rate_registered,
    'rate_unregistered', c.rate_unregistered, 'uses_scale', c.uses_scale, 'scale_code', c.scale_code,
    'min_withholding', c.min_withholding, 'unregistered_min_applies', c.unregistered_min_applies,
    'sicore_tax_code', c.sicore_tax_code, 'sicore_regime_code', c.sicore_regime_code,
    'valid_from', c.valid_from, 'source', c.source) end;

  return jsonb_build_object(
    'tax', p_tax, 'code', p_code,
    'name', coalesce(nullif(btrim(d ->> 'name'), ''), c.name, p_code),
    'valid_from', coalesce((o ->> 'valid_from')::date, c.valid_from),
    'min_non_taxable', coalesce((d ->> 'min_non_taxable')::numeric, s.min_non_taxable, c.min_non_taxable, 0),
    'rate_registered', case when coalesce((d ->> 'uses_scale')::boolean, c.uses_scale, false) then null
                            else coalesce((d ->> 'rate_registered')::numeric, s.rate_registered, c.rate_registered) end,
    'rate_unregistered', coalesce((d ->> 'rate_unregistered')::numeric, s.rate_unregistered, c.rate_unregistered),
    'uses_scale', coalesce((d ->> 'uses_scale')::boolean, c.uses_scale, false),
    'scale_code', coalesce(nullif(d ->> 'scale_code', ''), c.scale_code),
    'min_withholding', coalesce((d ->> 'min_withholding')::numeric, s.min_withholding, c.min_withholding, 0),
    'unregistered_min_applies', coalesce((d ->> 'unregistered_min_applies')::boolean, c.unregistered_min_applies, false),
    'sicore_tax_code', coalesce((d ->> 'sicore_tax_code')::int, c.sicore_tax_code),
    'sicore_regime_code', coalesce(nullif(d ->> 'sicore_regime_code', ''), s.sicore_regime_code, c.sicore_regime_code),
    'is_active', case when o is not null then coalesce((o ->> 'is_active')::boolean, true)
                      else coalesce(s.is_active, true) end,
    'overridden', (o is not null and not v_custom) or coalesce(v_legacy, false),
    'custom', v_custom,
    'source', case when v_custom then 'Propio' else c.source end,
    'verify', case when v_custom then false else c.verify end,
    'notes', coalesce(o ->> 'notes', s.notes, c.notes),
    'template', v_tpl);
end;
$$;
revoke all on function tax_ret_concept_eff(uuid, text, text, date) from public, anon, authenticated;

-- Conceptos vigentes (catálogo + propios del negocio) con su valor efectivo.
create or replace function tax_ret_concepts_list(p_at date default current_date)
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
  return coalesce((
    select jsonb_agg(e order by e ->> 'tax', coalesce((e ->> 'custom')::boolean, false), e ->> 'code')
      from (
        select tax_ret_concept_eff(v_tenant, k.tax, k.code, p_at) as e
          from (select distinct tax, code from tax_ret_concepts where valid_from <= coalesce(p_at, current_date)
                union
                select split_part(x.item_key, ':', 1), split_part(x.item_key, ':', 2)
                  from tax_custom_values x
                 where x.tenant_id = v_tenant and x.catalog = 'ret_concept' and x.is_custom and x.deleted_at is null) k
      ) z
     where e is not null),
    '[]'::jsonb);
end;
$$;
revoke all on function tax_ret_concepts_list(date) from public, anon;
grant execute on function tax_ret_concepts_list(date) to authenticated;

-- ¿Existe el concepto (catálogo o propio del negocio)?
create or replace function _tax_ret_concept_exists(p_tenant uuid, p_tax text, p_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from tax_ret_concepts c where c.tax = p_tax and c.code = p_code)
      or exists (select 1 from tax_custom_values x
                  where x.tenant_id = p_tenant and x.catalog = 'ret_concept' and x.item_key = p_tax || ':' || p_code
                    and x.is_custom and x.deleted_at is null);
$$;
revoke all on function _tax_ret_concept_exists(uuid, text, text) from public, anon, authenticated;

-- Ajustes viejos y perfil del proveedor aceptan los conceptos propios
-- (RECREADAS desde 20261104200000).
create or replace function trg_tax_ret_concept_settings_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not _tax_ret_concept_exists(new.tenant_id, new.tax, new.code) then
    raise exception 'invalid_concept' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
revoke all on function trg_tax_ret_concept_settings_check() from public, anon, authenticated;

create or replace function trg_supplier_tax_profiles_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from suppliers s where s.id = new.supplier_id and s.tenant_id = new.tenant_id) then
    raise exception 'supplier_not_found';
  end if;
  if new.ganancias_concept is not null
     and not _tax_ret_concept_exists(new.tenant_id, 'ganancias', new.ganancias_concept) then
    raise exception 'invalid_concept' using errcode = 'check_violation';
  end if;
  if new.suss_code is not null
     and not _tax_ret_concept_exists(new.tenant_id, 'suss', new.suss_code) then
    raise exception 'invalid_suss' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
revoke all on function trg_supplier_tax_profiles_check() from public, anon, authenticated;

-- Escala efectiva para la pantalla: [{from_amount, to_amount, fixed, rate}].
create or replace function tax_ret_scale_get(p_scale text, p_at date default current_date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  o jsonb;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not coalesce(tax_ret_can_read(), false) then raise exception 'forbidden' using errcode = '42501'; end if;
  o := _tax_custom_at(v_tenant, 'ret_scale', p_scale, p_at);
  return jsonb_build_object(
    'scale_code', p_scale,
    'customized', o is not null,
    'custom', case when o is not null and coalesce((o ->> 'is_active')::boolean, true) then o -> 'data' -> 'brackets' end,
    'template', coalesce((
      select jsonb_agg(jsonb_build_object('from_amount', s.from_amount, 'to_amount', s.to_amount,
                                          'fixed', s.fixed, 'rate', s.rate) order by s.from_amount)
        from tax_ret_scales s
       where s.scale_code = p_scale
         and s.valid_from = (select max(x.valid_from) from tax_ret_scales x
                              where x.scale_code = p_scale and x.valid_from <= coalesce(p_at, current_date))), '[]'::jsonb));
end;
$$;
revoke all on function tax_ret_scale_get(text, date) from public, anon;
grant execute on function tax_ret_scale_get(text, date) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Vigencia de los regímenes
-- -----------------------------------------------------------------------------
alter table tax_regimes add column if not exists valid_from date;
alter table tax_regimes add column if not exists valid_to date;
alter table tax_regimes drop constraint if exists tax_regimes_validity_check;
alter table tax_regimes add constraint tax_regimes_validity_check
  check (valid_from is null or valid_to is null or valid_to >= valid_from);
comment on column tax_regimes.valid_from is
  'Desde cuándo aplica el régimen (null = desde siempre). Los cambios de valores con vigencia van en tax_custom_values (regime_values).';
comment on column tax_regimes.valid_to is
  'Hasta cuándo aplica el régimen (null = sin fin).';

-- ¿El régimen aplica a la fecha?
create or replace function _tax_regime_in_force(p_from date, p_to date, p_at date)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select (p_from is null or p_from <= p_at) and (p_to is null or p_to >= p_at);
$$;

-- -----------------------------------------------------------------------------
-- E) Padrones: perfiles de importación y alícuotas manuales por CUIT
-- -----------------------------------------------------------------------------
create table if not exists tax_padron_profiles (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  jurisdiction  text not null references tax_jurisdictions(code),
  kind          text not null default 'both' check (kind in ('perception', 'retention', 'both')),
  config        jsonb not null check (jsonb_typeof(config) = 'object'),
  notes         text check (notes is null or char_length(notes) <= 300),
  updated_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
comment on table tax_padron_profiles is
  'Perfiles de importación de padrones del negocio (ADR-105): tipo de archivo (CSV o ancho fijo), separador, columnas o posiciones, formato de fecha y escala de la alícuota. Se reusan cada mes.';
comment on column tax_padron_profiles.config is
  '{file_type: delimited|fixed, separator, has_header, skip_lines, decimal_sep, date_format, rate_divisor, columns: {cuit, perception_rate, retention_rate, rate, regime, valid_from, valid_to, group_code, name} con {index} (1..) o {start, length}, regime_values: {perception, retention}}';

create index if not exists tax_padron_profiles_tenant_idx on tax_padron_profiles (tenant_id, created_at desc);
create index if not exists tax_padron_profiles_jurisdiction_idx on tax_padron_profiles (jurisdiction);

create or replace function trg_tax_padron_profiles_check()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_cols jsonb := new.config -> 'columns';
  k text;
  c jsonb;
begin
  if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(new.config ->> 'file_type', '') not in ('delimited', 'fixed') then
    raise exception 'padron_profile_invalid: file_type';
  end if;
  if jsonb_typeof(v_cols) <> 'object' or not (v_cols ? 'cuit') then
    raise exception 'padron_profile_invalid: cuit';
  end if;
  if not (v_cols ? 'perception_rate' or v_cols ? 'retention_rate' or v_cols ? 'rate') then
    raise exception 'padron_profile_invalid: rate';
  end if;
  for k, c in select * from jsonb_each(v_cols) loop
    continue when c is null or jsonb_typeof(c) = 'null';
    if k not in ('cuit', 'perception_rate', 'retention_rate', 'rate', 'regime', 'valid_from', 'valid_to',
                 'group_code', 'name') then
      raise exception 'padron_profile_invalid: %', k;
    end if;
    if new.config ->> 'file_type' = 'fixed' then
      if coalesce((c ->> 'start')::int, 0) < 1 or coalesce((c ->> 'length')::int, 0) < 1 then
        raise exception 'padron_profile_invalid: %', k;
      end if;
    elsif coalesce((c ->> 'index')::int, 0) < 1 then
      raise exception 'padron_profile_invalid: %', k;
    end if;
  end loop;
  if coalesce((new.config ->> 'rate_divisor')::numeric, 1) <= 0 then
    raise exception 'padron_profile_invalid: rate_divisor';
  end if;
  new.name := btrim(new.name);
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
revoke all on function trg_tax_padron_profiles_check() from public, anon, authenticated;

drop trigger if exists tax_padron_profiles_check on tax_padron_profiles;
create trigger tax_padron_profiles_check before insert or update on tax_padron_profiles
  for each row execute function trg_tax_padron_profiles_check();

alter table tax_padron_profiles enable row level security;
drop policy if exists tax_padron_profiles_read on tax_padron_profiles;
create policy tax_padron_profiles_read on tax_padron_profiles for select
  using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists tax_padron_profiles_role on tax_padron_profiles;
create policy tax_padron_profiles_role on tax_padron_profiles as restrictive for select
  using ((select tax_ret_can_read()));
drop policy if exists tax_padron_profiles_insert on tax_padron_profiles;
create policy tax_padron_profiles_insert on tax_padron_profiles for insert
  with check (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')));
drop policy if exists tax_padron_profiles_update on tax_padron_profiles;
create policy tax_padron_profiles_update on tax_padron_profiles for update
  using (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')))
  with check (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')));
-- Sin DELETE: baja lógica (deleted_at); los imports guardan el perfil usado.
revoke all on tax_padron_profiles from anon;
revoke delete on tax_padron_profiles from authenticated;
grant select, insert, update on tax_padron_profiles to authenticated;

drop trigger if exists role_write_guard on tax_padron_profiles;
create trigger role_write_guard before insert or update or delete on tax_padron_profiles
  for each row execute function trg_role_write_guard('manage');
drop trigger if exists audit_tax_padron_profiles on tax_padron_profiles;
create trigger audit_tax_padron_profiles after insert or update or delete on tax_padron_profiles
  for each row execute function write_audit_log();

alter table tax_padron_imports add column if not exists profile_id uuid references tax_padron_profiles(id) on delete set null;
create index if not exists tax_padron_imports_profile_idx on tax_padron_imports (profile_id) where profile_id is not null;
create index if not exists tax_padron_imports_jurisdiction_idx on tax_padron_imports (jurisdiction);
alter table tax_padron_imports drop constraint if exists tax_padron_imports_format_check;
alter table tax_padron_imports add constraint tax_padron_imports_format_check
  check (format in ('arba', 'agip', 'generic', 'profile', 'manual'));
comment on column tax_padron_imports.format is
  'arba | agip | generic (diseños de NinjaSoft), profile (perfil del negocio, profile_id) o manual (alícuota cargada a mano para un CUIT: manda sobre los archivos).';

-- -----------------------------------------------------------------------------
-- F) RPC
-- -----------------------------------------------------------------------------

-- Feature que gatea cada catálogo (CLAUDE.md §6: gating real en el servidor).
create or replace function _tax_custom_feature(p_catalog text, p_key text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_catalog = 'iva_rate' then 'impuestos_iva'
    when p_catalog = 'parameter' and p_key = 'cf_id_threshold' then 'impuestos_iva'
    else 'percepciones_retenciones' end;
$$;

create or replace function _tax_custom_assert(p_catalog text, p_key text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_feat text := _tax_custom_feature(p_catalog, p_key);
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not coalesce(stock_my_role() in ('owner', 'manager'), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, v_feat) then
    raise exception 'feature_not_in_plan: %', v_feat using errcode = 'check_violation';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _tax_custom_assert(text, text) from public, anon, authenticated;

-- Valida y normaliza los datos de una versión. Devuelve {item_key, data, is_custom}.
create or replace function _tax_custom_validate(p_tenant uuid, p_catalog text, p_key text, p_data jsonb,
                                                p_is_custom boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  d jsonb := coalesce(p_data, '{}'::jsonb);
  v_key text := btrim(coalesce(p_key, ''));
  v_out jsonb := '{}'::jsonb;
  v_custom boolean := coalesce(p_is_custom, false);
  v_kind text;
  k text;
  x jsonb;
  v_prev numeric;
  v_tax text;
  v_code text;
  v_conds constant text[] := array['consumidor_final', 'responsable_inscripto', 'monotributo', 'monotributo_social',
                                   'exento', 'no_responsable', 'no_categorizado', 'no_alcanzado', 'iva_liberado', 'exterior'];
begin
  if jsonb_typeof(d) <> 'object' then raise exception 'tax_custom_invalid: data'; end if;

  if p_catalog = 'iva_rate' then
    select r.kind into v_kind from tax_iva_rates r where r.code = v_key;
    if not found then raise exception 'tax_custom_invalid: key'; end if;
    v_custom := false;
    if d ? 'rate' and jsonb_typeof(d -> 'rate') <> 'null' then
      if v_kind <> 'gravado' then raise exception 'tax_custom_invalid: rate'; end if;
      if (d ->> 'rate')::numeric not between 0 and 100 then raise exception 'tax_custom_invalid: rate'; end if;
      v_out := v_out || jsonb_build_object('rate', round((d ->> 'rate')::numeric, 2));
    end if;
    if nullif(btrim(d ->> 'label'), '') is not null then
      v_out := v_out || jsonb_build_object('label', left(btrim(d ->> 'label'), 40));
    end if;

  elsif p_catalog = 'parameter' then
    if not exists (select 1 from tax_parameters t where t.key = v_key) then raise exception 'tax_custom_invalid: key'; end if;
    v_custom := false;
    if d ? 'value' and jsonb_typeof(d -> 'value') <> 'null' then
      if (d ->> 'value')::numeric < 0 then raise exception 'tax_custom_invalid: value'; end if;
      if v_key = 'gan_unknown_as_unregistered' and (d ->> 'value')::numeric not in (0, 1) then
        raise exception 'tax_custom_invalid: value';
      end if;
      if v_key in ('sicore_iva_tax_code', 'sicore_cbte_code', 'arba_branch', 'arba_activity')
         and ((d ->> 'value')::numeric <> trunc((d ->> 'value')::numeric) or (d ->> 'value')::numeric > 9999) then
        raise exception 'tax_custom_invalid: value';
      end if;
      v_out := jsonb_build_object('value', (d ->> 'value')::numeric);
    end if;

  elsif p_catalog = 'ret_concept' then
    if v_key !~ '^(ganancias|suss):[a-z0-9_]{1,20}$' then raise exception 'tax_custom_invalid: key'; end if;
    v_tax := split_part(v_key, ':', 1);
    v_code := split_part(v_key, ':', 2);
    if exists (select 1 from tax_ret_concepts c where c.tax = v_tax and c.code = v_code) then
      v_custom := false;
    elsif not v_custom then
      raise exception 'tax_custom_invalid: key';
    end if;
    for k in select unnest(array['min_non_taxable', 'min_withholding']) loop
      if d ? k and jsonb_typeof(d -> k) <> 'null' then
        if (d ->> k)::numeric < 0 then raise exception 'tax_custom_invalid: %', k; end if;
        v_out := v_out || jsonb_build_object(k, round((d ->> k)::numeric, 2));
      end if;
    end loop;
    for k in select unnest(array['rate_registered', 'rate_unregistered']) loop
      if d ? k and jsonb_typeof(d -> k) <> 'null' then
        if (d ->> k)::numeric not between 0 and 100 then raise exception 'tax_custom_invalid: %', k; end if;
        v_out := v_out || jsonb_build_object(k, round((d ->> k)::numeric, 4));
      end if;
    end loop;
    if d ? 'uses_scale' and jsonb_typeof(d -> 'uses_scale') = 'boolean' then
      v_out := v_out || jsonb_build_object('uses_scale', (d ->> 'uses_scale')::boolean);
    end if;
    if d ? 'unregistered_min_applies' and jsonb_typeof(d -> 'unregistered_min_applies') = 'boolean' then
      v_out := v_out || jsonb_build_object('unregistered_min_applies', (d ->> 'unregistered_min_applies')::boolean);
    end if;
    if nullif(d ->> 'scale_code', '') is not null then
      if d ->> 'scale_code' !~ '^[a-z0-9_]{1,30}$' then raise exception 'tax_custom_invalid: scale_code'; end if;
      v_out := v_out || jsonb_build_object('scale_code', d ->> 'scale_code');
    end if;
    if nullif(d ->> 'sicore_regime_code', '') is not null then
      if d ->> 'sicore_regime_code' !~ '^\d{1,3}$' then raise exception 'tax_custom_invalid: sicore_regime_code'; end if;
      v_out := v_out || jsonb_build_object('sicore_regime_code', d ->> 'sicore_regime_code');
    end if;
    if d ? 'sicore_tax_code' and jsonb_typeof(d -> 'sicore_tax_code') <> 'null' then
      if (d ->> 'sicore_tax_code')::numeric not between 1 and 999 then raise exception 'tax_custom_invalid: sicore_tax_code'; end if;
      v_out := v_out || jsonb_build_object('sicore_tax_code', (d ->> 'sicore_tax_code')::int);
    end if;
    if nullif(btrim(d ->> 'name'), '') is not null then
      v_out := v_out || jsonb_build_object('name', left(btrim(d ->> 'name'), 120));
    end if;
    if v_custom then
      if not (v_out ? 'name') then raise exception 'tax_custom_invalid: name'; end if;
      if coalesce((v_out ->> 'uses_scale')::boolean, false) and not (v_out ? 'scale_code') then
        raise exception 'tax_custom_invalid: scale_code';
      end if;
      if not coalesce((v_out ->> 'uses_scale')::boolean, false)
         and not (v_out ? 'rate_registered' or v_out ? 'rate_unregistered') then
        raise exception 'tax_custom_invalid: rate_registered';
      end if;
    end if;

  elsif p_catalog = 'ret_scale' then
    if v_key !~ '^[a-z0-9_]{1,30}$' then raise exception 'tax_custom_invalid: key'; end if;
    v_custom := not exists (select 1 from tax_ret_scales s where s.scale_code = v_key);
    if jsonb_typeof(d -> 'brackets') <> 'array' or jsonb_array_length(d -> 'brackets') = 0
       or jsonb_array_length(d -> 'brackets') > 30 then
      raise exception 'tax_custom_invalid: brackets';
    end if;
    v_prev := null;
    for x in select e from jsonb_array_elements(d -> 'brackets') e
              order by (e ->> 'from_amount')::numeric loop
      if (x ->> 'from_amount') is null or (x ->> 'from_amount')::numeric < 0
         or coalesce((x ->> 'fixed')::numeric, 0) < 0
         or (x ->> 'rate') is null or (x ->> 'rate')::numeric not between 0 and 100
         or ((x ->> 'to_amount') is not null and (x ->> 'to_amount')::numeric <= (x ->> 'from_amount')::numeric) then
        raise exception 'tax_custom_invalid: brackets';
      end if;
      if v_prev is null and (x ->> 'from_amount')::numeric <> 0 then raise exception 'tax_custom_invalid: brackets'; end if;
      if v_prev is not null and (x ->> 'from_amount')::numeric = v_prev then raise exception 'tax_custom_invalid: brackets'; end if;
      v_prev := (x ->> 'from_amount')::numeric;
    end loop;
    select jsonb_build_object('brackets', jsonb_agg(jsonb_build_object(
             'from_amount', round((e ->> 'from_amount')::numeric, 2),
             'to_amount', case when e ->> 'to_amount' is null then null else round((e ->> 'to_amount')::numeric, 2) end,
             'fixed', round(coalesce((e ->> 'fixed')::numeric, 0), 2),
             'rate', round((e ->> 'rate')::numeric, 4)) order by (e ->> 'from_amount')::numeric))
      into v_out
      from jsonb_array_elements(d -> 'brackets') e;

  elsif p_catalog = 'regime_values' then
    if not exists (select 1 from tax_regimes r where r.id::text = v_key and r.tenant_id = p_tenant and r.deleted_at is null) then
      raise exception 'tax_custom_invalid: key';
    end if;
    v_custom := false;
    if d ? 'default_rate' then
      if jsonb_typeof(d -> 'default_rate') <> 'null' and (d ->> 'default_rate')::numeric not between 0 and 100 then
        raise exception 'tax_custom_invalid: default_rate';
      end if;
      v_out := v_out || jsonb_build_object('default_rate', case when jsonb_typeof(d -> 'default_rate') = 'null' then null
                                                                 else round((d ->> 'default_rate')::numeric, 4) end);
    end if;
    if d ? 'rates_by_condition' then
      if jsonb_typeof(d -> 'rates_by_condition') <> 'object' then raise exception 'tax_custom_invalid: rates_by_condition'; end if;
      for k, x in select * from jsonb_each(d -> 'rates_by_condition') loop
        if not (k = any (v_conds)) or jsonb_typeof(x) <> 'number' or (x #>> '{}')::numeric not between 0 and 100 then
          raise exception 'tax_custom_invalid: rates_by_condition';
        end if;
      end loop;
      v_out := v_out || jsonb_build_object('rates_by_condition', d -> 'rates_by_condition');
    end if;
    if d ? 'base_kind' then
      if d ->> 'base_kind' not in ('net', 'net_taxed', 'total', 'vat') then raise exception 'tax_custom_invalid: base_kind'; end if;
      v_out := v_out || jsonb_build_object('base_kind', d ->> 'base_kind');
    end if;
    for k in select unnest(array['min_base', 'min_amount']) loop
      if d ? k and jsonb_typeof(d -> k) <> 'null' then
        if (d ->> k)::numeric < 0 then raise exception 'tax_custom_invalid: %', k; end if;
        v_out := v_out || jsonb_build_object(k, round((d ->> k)::numeric, 2));
      end if;
    end loop;

  elsif p_catalog = 'iibb_activity' then
    if not exists (select 1 from iibb_activities a where a.id::text = v_key and a.tenant_id = p_tenant) then
      raise exception 'tax_custom_invalid: key';
    end if;
    v_custom := false;
    if d ? 'rate' and jsonb_typeof(d -> 'rate') <> 'null' then
      if (d ->> 'rate')::numeric not between 0 and 100 then raise exception 'tax_custom_invalid: rate'; end if;
      v_out := v_out || jsonb_build_object('rate', round((d ->> 'rate')::numeric, 4));
    end if;
    if d ? 'min_tax' and jsonb_typeof(d -> 'min_tax') <> 'null' then
      if (d ->> 'min_tax')::numeric < 0 then raise exception 'tax_custom_invalid: min_tax'; end if;
      v_out := v_out || jsonb_build_object('min_tax', round((d ->> 'min_tax')::numeric, 2));
    end if;

  elsif p_catalog = 'suffered_rule' then
    v_key := btrim(regexp_replace(_tax_text_norm(v_key), '\s+', ' ', 'g'));
    if char_length(v_key) not between 2 and 60 then raise exception 'tax_custom_invalid: key'; end if;
    v_custom := true;
    if coalesce((d ->> 'skip')::boolean, false) then
      v_out := jsonb_build_object('skip', true);
    else
      if coalesce(d ->> 'tax', '') not in ('iibb', 'iva', 'ganancias', 'suss', 'debitos_creditos', 'otro') then
        raise exception 'tax_custom_invalid: tax';
      end if;
      v_kind := coalesce(nullif(d ->> 'kind', ''),
                         case when d ->> 'tax' = 'debitos_creditos' then 'pago_a_cuenta' else 'retencion' end);
      if v_kind not in ('retencion', 'percepcion', 'pago_a_cuenta')
         or (d ->> 'tax' = 'debitos_creditos') <> (v_kind = 'pago_a_cuenta') then
        raise exception 'tax_custom_invalid: kind';
      end if;
      if nullif(d ->> 'regime', '') is not null and d ->> 'regime' not in ('general', 'sircreb', 'sirtac', 'procesador', 'otro') then
        raise exception 'tax_custom_invalid: regime';
      end if;
      if nullif(d ->> 'jurisdiction', '') is not null
         and (d ->> 'tax' <> 'iibb' or not exists (select 1 from tax_jurisdictions j where j.code = d ->> 'jurisdiction')) then
        raise exception 'tax_custom_invalid: jurisdiction';
      end if;
      v_out := jsonb_build_object('tax', d ->> 'tax', 'kind', v_kind);
      if nullif(d ->> 'regime', '') is not null then v_out := v_out || jsonb_build_object('regime', d ->> 'regime'); end if;
      if nullif(d ->> 'jurisdiction', '') is not null then
        v_out := v_out || jsonb_build_object('jurisdiction', d ->> 'jurisdiction');
      end if;
    end if;

  else
    raise exception 'tax_custom_invalid: catalog';
  end if;

  return jsonb_build_object('item_key', v_key, 'data', coalesce(v_out, '{}'::jsonb), 'is_custom', v_custom);
end;
$$;
revoke all on function _tax_custom_validate(uuid, text, text, jsonb, boolean) from public, anon, authenticated;

-- Alta o cambio de una versión.
--   p: {id?, catalog, item_key, valid_from?, valid_to?, is_active?, is_custom?, data, notes?}
create or replace function tax_custom_save(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_catalog text := p ->> 'catalog';
  v_tenant  uuid;
  v_norm    jsonb;
  v_id      uuid := nullif(p ->> 'id', '')::uuid;
  v_from    date := coalesce(nullif(p ->> 'valid_from', '')::date, date '2000-01-01');
  v_to      date := nullif(p ->> 'valid_to', '')::date;
  v_row     tax_custom_values%rowtype;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_payload'; end if;
  if v_id is not null then
    select * into v_row from tax_custom_values where id = v_id and deleted_at is null;
    if not found then raise exception 'tax_custom_not_found'; end if;
    v_catalog := v_row.catalog;
  end if;
  v_tenant := _tax_custom_assert(v_catalog, coalesce(v_row.item_key, p ->> 'item_key'));
  if v_id is not null and v_row.tenant_id <> v_tenant then raise exception 'tax_custom_not_found'; end if;
  if v_to is not null and v_to < v_from then raise exception 'tax_custom_invalid: valid_to'; end if;

  v_norm := _tax_custom_validate(v_tenant, v_catalog, coalesce(v_row.item_key, p ->> 'item_key'),
                                 p -> 'data', coalesce(v_row.is_custom, (p ->> 'is_custom')::boolean, false));

  if v_id is null then
    insert into tax_custom_values (tenant_id, catalog, item_key, valid_from, valid_to, is_active, is_custom, data,
                                   notes, created_by, updated_by)
    values (v_tenant, v_catalog, v_norm ->> 'item_key', v_from, v_to, coalesce((p ->> 'is_active')::boolean, true),
            (v_norm ->> 'is_custom')::boolean, v_norm -> 'data', left(nullif(btrim(p ->> 'notes'), ''), 300),
            auth.uid(), auth.uid())
    returning id into v_id;
  else
    update tax_custom_values
       set valid_from = v_from, valid_to = v_to,
           is_active = coalesce((p ->> 'is_active')::boolean, is_active),
           data = v_norm -> 'data',
           notes = left(nullif(btrim(p ->> 'notes'), ''), 300)
     where id = v_id and tenant_id = v_tenant;
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'tax_custom_duplicate_from';
end;
$$;
revoke all on function tax_custom_save(jsonb) from public, anon;
grant execute on function tax_custom_save(jsonb) to authenticated;

-- Quita una versión (baja lógica).
create or replace function tax_custom_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row tax_custom_values%rowtype;
  v_tenant uuid;
begin
  select * into v_row from tax_custom_values where id = p_id and deleted_at is null;
  if not found then raise exception 'tax_custom_not_found'; end if;
  v_tenant := _tax_custom_assert(v_row.catalog, v_row.item_key);
  if v_row.tenant_id <> v_tenant then raise exception 'tax_custom_not_found'; end if;
  update tax_custom_values set deleted_at = now() where id = p_id and tenant_id = v_tenant;
end;
$$;
revoke all on function tax_custom_delete(uuid) from public, anon;
grant execute on function tax_custom_delete(uuid) to authenticated;

-- Volver a la plantilla: baja lógica de todas las versiones del valor (y, en
-- conceptos de retención, vacía el ajuste viejo sin vigencia). Devuelve cuántas.
create or replace function tax_custom_reset(p_catalog text, p_item_key text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_custom_assert(p_catalog, p_item_key);
  v_n int;
begin
  update tax_custom_values set deleted_at = now()
   where tenant_id = v_tenant and catalog = p_catalog and item_key = p_item_key and deleted_at is null;
  get diagnostics v_n = row_count;
  if p_catalog = 'ret_concept' then
    update tax_ret_concept_settings
       set is_active = true, min_non_taxable = null, rate_registered = null, rate_unregistered = null,
           min_withholding = null, sicore_regime_code = null
     where tenant_id = v_tenant and tax = split_part(p_item_key, ':', 1) and code = split_part(p_item_key, ':', 2);
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'tax_custom_values', v_tenant, 'tax_custom_reset',
          jsonb_build_object('catalog', p_catalog, 'item_key', p_item_key, 'versions', v_n));
  return v_n;
end;
$$;
revoke all on function tax_custom_reset(text, text) from public, anon;
grant execute on function tax_custom_reset(text, text) to authenticated;

-- Historial de cambios (audit_logs) de un valor: catálogo + clave, o una
-- entidad del negocio (tax_regimes, iibb_activities, tax_padron_profiles) por id.
create or replace function tax_custom_history(p_catalog text, p_item_key text, p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not coalesce(stock_my_role() in ('owner', 'manager'), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(x order by (x ->> 'at') desc)
      from (
        select jsonb_build_object(
                 'at', a.created_at, 'action', a.action, 'actor', coalesce(u.full_name, u.email),
                 'before', a.before_data, 'after', a.after_data) as x
          from audit_logs a
          left join public.users u on u.id = a.actor_user_id
         where a.tenant_id = v_tenant
           and (
             (p_catalog in ('tax_regimes', 'iibb_activities', 'tax_padron_profiles', 'iibb_cm_coefficients')
              and a.entity_type = p_catalog and a.entity_id::text = p_item_key)
             or (a.entity_type = 'tax_custom_values'
                 and (coalesce(a.after_data, a.before_data) ->> 'catalog') = p_catalog
                 and (coalesce(a.after_data, a.before_data) ->> 'item_key') = p_item_key)
             or (p_catalog = 'ret_concept' and a.entity_type = 'tax_ret_concept_settings'
                 and (coalesce(a.after_data, a.before_data) ->> 'tax') = split_part(p_item_key, ':', 1)
                 and (coalesce(a.after_data, a.before_data) ->> 'code') = split_part(p_item_key, ':', 2))
             or (p_catalog = 'regime_values' and a.entity_type = 'tax_regimes' and a.entity_id::text = p_item_key)
           )
         order by a.created_at desc
         limit v_lim) z), '[]'::jsonb);
end;
$$;
revoke all on function tax_custom_history(text, text, int) from public, anon;
grant execute on function tax_custom_history(text, text, int) to authenticated;

-- Alícuota manual de un CUIT: manda sobre los padrones importados mientras
-- esté vigente. p: {jurisdiction, cuit, perception_rate?, retention_rate?,
-- valid_from, valid_to}. Devuelve el import creado.
create or replace function tax_padron_manual_set(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_padron_assert();
  v_jur  text := p ->> 'jurisdiction';
  v_cuit text := regexp_replace(coalesce(p ->> 'cuit', ''), '\D', '', 'g');
  v_per  numeric := nullif(p ->> 'perception_rate', '')::numeric;
  v_ret  numeric := nullif(p ->> 'retention_rate', '')::numeric;
  v_from date := nullif(p ->> 'valid_from', '')::date;
  v_to   date := nullif(p ->> 'valid_to', '')::date;
  v_id   uuid;
begin
  if not exists (select 1 from tax_jurisdictions j where j.code = v_jur) then raise exception 'invalid_jurisdiction'; end if;
  if length(v_cuit) <> 11 or not cuit_is_valid(v_cuit) then raise exception 'invalid_cuit'; end if;
  if v_per is null and v_ret is null then raise exception 'invalid_rows'; end if;
  if coalesce(v_per, 0) not between 0 and 100 or coalesce(v_ret, 0) not between 0 and 100 then
    raise exception 'invalid_rows';
  end if;
  if v_from is null or v_to is null or v_to < v_from then raise exception 'invalid_rows'; end if;

  insert into tax_padron_imports (tenant_id, jurisdiction, format, kind, file_name, only_known, period_from, period_to,
                                  rows_loaded, status, finished_at)
  values (v_tenant, v_jur, 'manual',
          case when v_per is not null and v_ret is not null then 'both' when v_per is not null then 'perception'
               else 'retention' end,
          'Carga manual ' || v_cuit, false, v_from, v_to, 1, 'ready', now())
  returning id into v_id;
  insert into tax_padron_entries (import_id, tenant_id, jurisdiction, cuit, valid_from, valid_to,
                                  perception_rate, retention_rate, group_code)
  values (v_id, v_tenant, v_jur, v_cuit, v_from, v_to, v_per, v_ret, null);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'tax_padron_imports', v_id, 'tax_padron_manual_set',
          jsonb_build_object('jurisdiction', v_jur, 'cuit', v_cuit, 'perception_rate', v_per,
                             'retention_rate', v_ret, 'valid_from', v_from, 'valid_to', v_to));
  return v_id;
end;
$$;
revoke all on function tax_padron_manual_set(jsonb) from public, anon;
grant execute on function tax_padron_manual_set(jsonb) to authenticated;
