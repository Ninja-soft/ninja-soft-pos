-- =============================================================================
-- 20261104200000_retenciones_agente_catalogo  (F18 · H106, ADR-079)
--
-- Retenciones como AGENTE en la orden de pago: catálogos y configuración.
--
--   A) tax_ret_concepts (global, versionado por vigencia): conceptos de
--      Ganancias de la RG 830 (mínimo no sujeto MENSUAL, alícuota de
--      inscripto y de no inscripto, escala, importe mínimo de retención,
--      códigos de SICORE) y actividades alcanzadas por SUSS (alícuota, pago
--      mínimo, retención mínima). tax_ret_scales: escala del Anexo VIII de la
--      RG 830 (honorarios y similares de inscriptos).
--
--      LOS VALORES SON ORIENTATIVOS Y ESTÁN MARCADOS verify = true: cambian
--      por resolución general. Para actualizarlos se agrega una fila con la
--      nueva valid_from (nunca se pisa la anterior: los pagos viejos se
--      recalculan con lo vigente a su fecha) en una migración nueva. Fuente y
--      procedimiento en docs/32-impuestos.md § Retenciones como agente.
--
--   B) tax_ret_concept_settings (por negocio): el dueño o el contador pueden
--      pisar mínimo, alícuotas, retención mínima y código de régimen de
--      SICORE de un concepto sin esperar una migración, o desactivarlo.
--   C) supplier_tax_profiles (por negocio): condición en Ganancias del
--      proveedor, concepto habitual y actividad de SUSS.
--   D) tax_regimes.base_kind suma 'vat' (retención de IVA sobre el IVA
--      facturado, RG 2854 y similares).
--   E) tax_ret_concept_eff / tax_ret_concepts_list: concepto efectivo a una
--      fecha (catálogo vigente + ajustes del negocio).
--
-- Gating: OPTIONAL percepciones_retenciones (ADR-068) con
-- tenant_has_feature_for en las policies de escritura (tax_can_write). RLS de
-- lectura `tenant_id = current_tenant_id() or internal_scope()` (ADR-052).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Catálogos globales
-- -----------------------------------------------------------------------------
create table if not exists tax_ret_concepts (
  tax                      text not null check (tax in ('ganancias', 'suss')),
  code                     text not null check (code ~ '^[a-z0-9_]{1,20}$'),
  valid_from               date not null,
  name                     text not null,
  min_non_taxable          numeric(14,2) not null default 0 check (min_non_taxable >= 0),
  rate_registered          numeric(7,4) check (rate_registered is null or (rate_registered >= 0 and rate_registered <= 100)),
  rate_unregistered        numeric(7,4) check (rate_unregistered is null or (rate_unregistered >= 0 and rate_unregistered <= 100)),
  uses_scale               boolean not null default false,
  scale_code               text,
  min_withholding          numeric(14,2) not null default 0 check (min_withholding >= 0),
  unregistered_min_applies boolean not null default false,
  sicore_tax_code          int,
  sicore_regime_code       text check (sicore_regime_code is null or sicore_regime_code ~ '^\d{1,3}$'),
  source                   text not null,
  verify                   boolean not null default true,
  notes                    text,
  primary key (tax, code, valid_from),
  constraint tax_ret_concepts_scale check (not uses_scale or scale_code is not null)
);
comment on table tax_ret_concepts is
  'Conceptos de Ganancias (RG 830) y actividades de SUSS para retener como agente (ADR-079). Versionado por valid_from; valores orientativos (verify = true): validar con el contador y la RG vigente.';

create table if not exists tax_ret_scales (
  scale_code  text not null,
  valid_from  date not null,
  from_amount numeric(14,2) not null check (from_amount >= 0),
  to_amount   numeric(14,2),
  fixed       numeric(14,2) not null default 0,
  rate        numeric(7,4) not null check (rate >= 0 and rate <= 100),
  source      text not null,
  verify      boolean not null default true,
  primary key (scale_code, valid_from, from_amount)
);
comment on table tax_ret_scales is
  'Escalas de retención (Anexo VIII RG 830): fijo + (sujeto − desde) × alícuota. Versionada por valid_from; valores orientativos.';

-- Ganancias: RG 830 Anexo VIII con los montos de la RG 5423/2023 (vigencia
-- desde el 1/7/2023 según la norma). VERIFICAR CON EL CONTADOR si hubo
-- actualizaciones posteriores: se agrega una fila nueva con su valid_from.
insert into tax_ret_concepts (tax, code, valid_from, name, min_non_taxable, rate_registered, rate_unregistered,
                              uses_scale, scale_code, min_withholding, sicore_tax_code, sicore_regime_code, source, notes)
values
  ('ganancias', '078', '2023-07-01', 'Enajenación de bienes muebles y bienes de cambio',
   224000, 2, 10, false, null, 240, 217, '078',
   'RG 830 Anexo VIII inc. g) y RG 5423/2023 (montos)', 'Verificar con contador: mínimo, alícuotas y retención mínima.'),
  ('ganancias', '094', '2023-07-01', 'Locaciones de obra y/o servicios (no en relación de dependencia)',
   67170, 2, 28, false, null, 240, 217, '094',
   'RG 830 Anexo VIII inc. l) y RG 5423/2023 (montos)', 'Verificar con contador: mínimo, alícuotas y retención mínima.'),
  ('ganancias', '116', '2023-07-01', 'Honorarios de profesiones liberales, oficios, síndicos y similares',
   67170, null, 28, true, 'rg830_anexo8', 240, 217, '116',
   'RG 830 Anexo VIII inc. i) y RG 5423/2023 (montos)', 'Inscriptos por escala. Verificar con contador: mínimo, escala y retención mínima.'),
  ('ganancias', '031', '2023-07-01', 'Alquileres y arrendamientos de inmuebles urbanos',
   11200, 6, 28, false, null, 240, 217, '031',
   'RG 830 Anexo VIII inc. b) y RG 5423/2023 (montos)', 'Verificar con contador: mínimo, alícuotas y retención mínima.'),
  ('ganancias', '095', '2023-07-01', 'Transporte de carga nacional e internacional',
   67170, 0.25, 28, false, null, 240, 217, '095',
   'RG 830 Anexo VIII inc. m) y RG 5423/2023 (montos)', 'Verificar con contador: mínimo, alícuotas y retención mínima.')
on conflict do nothing;

-- SUSS: actividades alcanzadas. Alícuotas y mínimos orientativos; los códigos
-- de régimen de SICORE quedan sin valor (el negocio los carga en el ajuste
-- del concepto con lo que indique su contador).
insert into tax_ret_concepts (tax, code, valid_from, name, min_non_taxable, rate_registered, rate_unregistered,
                              uses_scale, scale_code, min_withholding, sicore_tax_code, sicore_regime_code, source, notes)
values
  ('suss', 'construccion', '2000-01-01', 'Construcción (empresas constructoras y subcontratistas)',
   0, 1.2, 1.2, false, null, 400, 353, null, 'RG 4052 (ex RG 2682)', 'Verificar con contador: alícuota, mínimo y código de régimen de SICORE.'),
  ('suss', 'limpieza', '2000-01-01', 'Limpieza de inmuebles',
   0, 6, 6, false, null, 400, 353, null, 'RG 1556', 'Verificar con contador: alícuota, mínimo y código de régimen de SICORE.'),
  ('suss', 'seguridad', '2000-01-01', 'Investigación y seguridad',
   0, 6, 6, false, null, 400, 353, null, 'RG 1769', 'Verificar con contador: alícuota, mínimo y código de régimen de SICORE.'),
  ('suss', 'eventuales', '2000-01-01', 'Empresas de servicios eventuales',
   0, 8, 8, false, null, 400, 353, null, 'RG 3983', 'Verificar con contador: alícuota, mínimo y código de régimen de SICORE.')
on conflict do nothing;

-- Escala del Anexo VIII (sobre el importe sujeto a retención del mes).
insert into tax_ret_scales (scale_code, valid_from, from_amount, to_amount, fixed, rate, source) values
  ('rg830_anexo8', '2000-01-01',     0,  8000,     0,  5, 'RG 830 Anexo VIII (escala). Verificar montos vigentes.'),
  ('rg830_anexo8', '2000-01-01',  8000, 16000,   400,  9, 'RG 830 Anexo VIII (escala). Verificar montos vigentes.'),
  ('rg830_anexo8', '2000-01-01', 16000, 24000,  1120, 12, 'RG 830 Anexo VIII (escala). Verificar montos vigentes.'),
  ('rg830_anexo8', '2000-01-01', 24000, 32000,  2080, 15, 'RG 830 Anexo VIII (escala). Verificar montos vigentes.'),
  ('rg830_anexo8', '2000-01-01', 32000, 48000,  3280, 19, 'RG 830 Anexo VIII (escala). Verificar montos vigentes.'),
  ('rg830_anexo8', '2000-01-01', 48000, 64000,  6320, 23, 'RG 830 Anexo VIII (escala). Verificar montos vigentes.'),
  ('rg830_anexo8', '2000-01-01', 64000, 96000, 10000, 27, 'RG 830 Anexo VIII (escala). Verificar montos vigentes.'),
  ('rg830_anexo8', '2000-01-01', 96000,  null, 18640, 31, 'RG 830 Anexo VIII (escala). Verificar montos vigentes.')
on conflict do nothing;

alter table tax_ret_concepts enable row level security;
drop policy if exists tax_ret_concepts_read on tax_ret_concepts;
create policy tax_ret_concepts_read on tax_ret_concepts for select to authenticated using (true);
revoke insert, update, delete on tax_ret_concepts from anon, authenticated;
grant select on tax_ret_concepts to authenticated;

alter table tax_ret_scales enable row level security;
drop policy if exists tax_ret_scales_read on tax_ret_scales;
create policy tax_ret_scales_read on tax_ret_scales for select to authenticated using (true);
revoke insert, update, delete on tax_ret_scales from anon, authenticated;
grant select on tax_ret_scales to authenticated;

-- -----------------------------------------------------------------------------
-- B) Ajustes del negocio sobre el catálogo
-- -----------------------------------------------------------------------------
create table if not exists tax_ret_concept_settings (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  tax                text not null check (tax in ('ganancias', 'suss')),
  code               text not null check (code ~ '^[a-z0-9_]{1,20}$'),
  is_active          boolean not null default true,
  min_non_taxable    numeric(14,2) check (min_non_taxable is null or min_non_taxable >= 0),
  rate_registered    numeric(7,4) check (rate_registered is null or (rate_registered >= 0 and rate_registered <= 100)),
  rate_unregistered  numeric(7,4) check (rate_unregistered is null or (rate_unregistered >= 0 and rate_unregistered <= 100)),
  min_withholding    numeric(14,2) check (min_withholding is null or min_withholding >= 0),
  sicore_regime_code text check (sicore_regime_code is null or sicore_regime_code ~ '^\d{1,3}$'),
  notes              text check (notes is null or char_length(notes) <= 300),
  updated_at         timestamptz not null default now(),
  updated_by         uuid default auth.uid(),
  constraint tax_ret_concept_settings_key unique (tenant_id, tax, code)
);
comment on table tax_ret_concept_settings is
  'Ajustes del negocio sobre tax_ret_concepts (ADR-079): null = usa el catálogo vigente.';

create or replace function trg_tax_ret_concept_settings_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from tax_ret_concepts c where c.tax = new.tax and c.code = new.code) then
    raise exception 'invalid_concept' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
revoke all on function trg_tax_ret_concept_settings_check() from public, anon, authenticated;

drop trigger if exists tax_ret_concept_settings_check on tax_ret_concept_settings;
create trigger tax_ret_concept_settings_check before insert or update on tax_ret_concept_settings
  for each row execute function trg_tax_ret_concept_settings_check();

alter table tax_ret_concept_settings enable row level security;
drop policy if exists tax_ret_concept_settings_read on tax_ret_concept_settings;
create policy tax_ret_concept_settings_read on tax_ret_concept_settings for select
  using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists tax_ret_concept_settings_insert on tax_ret_concept_settings;
create policy tax_ret_concept_settings_insert on tax_ret_concept_settings for insert
  with check (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')));
drop policy if exists tax_ret_concept_settings_update on tax_ret_concept_settings;
create policy tax_ret_concept_settings_update on tax_ret_concept_settings for update
  using (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')))
  with check (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')));
-- Sin DELETE: se desactiva (is_active = false) o se vacían los ajustes.
revoke all on tax_ret_concept_settings from anon;
revoke delete on tax_ret_concept_settings from authenticated;
grant select, insert, update on tax_ret_concept_settings to authenticated;

drop trigger if exists audit_tax_ret_concept_settings on tax_ret_concept_settings;
create trigger audit_tax_ret_concept_settings after insert or update or delete on tax_ret_concept_settings
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- C) Perfil impositivo del proveedor para retener
-- -----------------------------------------------------------------------------
create table if not exists supplier_tax_profiles (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  supplier_id         uuid not null references suppliers(id) on delete cascade,
  ganancias_condition text check (ganancias_condition is null or ganancias_condition in
                                  ('inscripto', 'no_inscripto', 'exento', 'no_alcanzado')),
  ganancias_concept   text check (ganancias_concept is null or ganancias_concept ~ '^[a-z0-9_]{1,20}$'),
  suss_code           text check (suss_code is null or suss_code ~ '^[a-z0-9_]{1,20}$'),
  notes               text check (notes is null or char_length(notes) <= 300),
  updated_at          timestamptz not null default now(),
  updated_by          uuid default auth.uid(),
  constraint supplier_tax_profiles_key unique (tenant_id, supplier_id)
);
comment on table supplier_tax_profiles is
  'Datos del proveedor para retener como agente (ADR-079): condición en Ganancias (vacía = inscripto, con aviso), concepto habitual de la RG 830 y actividad de SUSS.';

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
     and not exists (select 1 from tax_ret_concepts c where c.tax = 'ganancias' and c.code = new.ganancias_concept) then
    raise exception 'invalid_concept' using errcode = 'check_violation';
  end if;
  if new.suss_code is not null
     and not exists (select 1 from tax_ret_concepts c where c.tax = 'suss' and c.code = new.suss_code) then
    raise exception 'invalid_suss' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
revoke all on function trg_supplier_tax_profiles_check() from public, anon, authenticated;

drop trigger if exists supplier_tax_profiles_check on supplier_tax_profiles;
create trigger supplier_tax_profiles_check before insert or update on supplier_tax_profiles
  for each row execute function trg_supplier_tax_profiles_check();

create index if not exists supplier_tax_profiles_supplier_idx on supplier_tax_profiles (supplier_id);

alter table supplier_tax_profiles enable row level security;
drop policy if exists supplier_tax_profiles_read on supplier_tax_profiles;
create policy supplier_tax_profiles_read on supplier_tax_profiles for select
  using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists supplier_tax_profiles_insert on supplier_tax_profiles;
create policy supplier_tax_profiles_insert on supplier_tax_profiles for insert
  with check (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')));
drop policy if exists supplier_tax_profiles_update on supplier_tax_profiles;
create policy supplier_tax_profiles_update on supplier_tax_profiles for update
  using (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')))
  with check (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')));
revoke all on supplier_tax_profiles from anon;
revoke delete on supplier_tax_profiles from authenticated;
grant select, insert, update on supplier_tax_profiles to authenticated;

drop trigger if exists audit_supplier_tax_profiles on supplier_tax_profiles;
create trigger audit_supplier_tax_profiles after insert or update or delete on supplier_tax_profiles
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- D) Retención de IVA sobre el IVA facturado
-- -----------------------------------------------------------------------------
alter table tax_regimes drop constraint if exists tax_regimes_base_kind_check;
alter table tax_regimes add constraint tax_regimes_base_kind_check
  check (base_kind in ('net', 'net_taxed', 'total', 'vat'));
comment on column tax_regimes.base_kind is
  'Base: net (sin IVA), net_taxed (neto gravado), total (con IVA) o vat (el IVA facturado: retención de IVA, ADR-079). vat sólo tiene sentido en retenciones.';
comment on column tax_regimes.regime_code is
  'Código de régimen (para SICORE en IVA y SUSS, ADR-079; informativo en IIBB).';

-- -----------------------------------------------------------------------------
-- E) Concepto efectivo
-- -----------------------------------------------------------------------------
create or replace function tax_ret_concept_eff(p_tenant uuid, p_tax text, p_code text, p_at date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'tax', c.tax, 'code', c.code, 'name', c.name, 'valid_from', c.valid_from,
    'min_non_taxable', coalesce(s.min_non_taxable, c.min_non_taxable),
    'rate_registered', case when c.uses_scale then null else coalesce(s.rate_registered, c.rate_registered) end,
    'rate_unregistered', coalesce(s.rate_unregistered, c.rate_unregistered),
    'uses_scale', c.uses_scale, 'scale_code', c.scale_code,
    'min_withholding', coalesce(s.min_withholding, c.min_withholding),
    'unregistered_min_applies', c.unregistered_min_applies,
    'sicore_tax_code', c.sicore_tax_code,
    'sicore_regime_code', coalesce(s.sicore_regime_code, c.sicore_regime_code),
    'is_active', coalesce(s.is_active, true),
    'overridden', s.id is not null and (s.min_non_taxable is not null or s.rate_registered is not null
                                        or s.rate_unregistered is not null or s.min_withholding is not null
                                        or s.sicore_regime_code is not null),
    'source', c.source, 'verify', c.verify, 'notes', c.notes)
    from tax_ret_concepts c
    left join tax_ret_concept_settings s on s.tenant_id = p_tenant and s.tax = c.tax and s.code = c.code
   where c.tax = p_tax and c.code = p_code and c.valid_from <= coalesce(p_at, current_date)
   order by c.valid_from desc
   limit 1;
$$;
revoke all on function tax_ret_concept_eff(uuid, text, text, date) from public, anon, authenticated;

-- Para la configuración y la orden de pago: conceptos vigentes con los ajustes.
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
    select jsonb_agg(tax_ret_concept_eff(v_tenant, k.tax, k.code, p_at) order by k.tax, k.code)
      from (select distinct tax, code from tax_ret_concepts where valid_from <= coalesce(p_at, current_date)) k),
    '[]'::jsonb);
end;
$$;
revoke all on function tax_ret_concepts_list(date) from public, anon;
grant execute on function tax_ret_concepts_list(date) to authenticated;

-- Escala vigente (sujeto → importe del mes).
create or replace function _tax_ret_scale_amount(p_scale text, p_subject numeric, p_at date)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with v as (
    select max(valid_from) as vf from tax_ret_scales
     where scale_code = p_scale and valid_from <= coalesce(p_at, current_date)
  ), b as (
    select s.* from tax_ret_scales s, v
     where s.scale_code = p_scale and s.valid_from = v.vf
       and (p_subject > s.from_amount or s.from_amount = 0)
     order by s.from_amount desc
     limit 1
  )
  select case when p_subject > 0 then coalesce((select round(b.fixed + round((p_subject - b.from_amount) * b.rate / 100, 2), 2) from b), 0)
              else 0 end;
$$;
revoke all on function _tax_ret_scale_amount(text, numeric, date) from public, anon, authenticated;
