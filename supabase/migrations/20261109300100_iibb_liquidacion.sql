-- =============================================================================
-- 20261109300100_iibb_liquidacion  (F18 · H106 / H108, ADR-095)
--
-- Liquidación mensual de Ingresos Brutos por jurisdicción (el negocio como
-- contribuyente). No genera el archivo de cada provincia (deuda documentada):
-- arma el cálculo, lo guarda confirmado y alimenta el reporte, el XLSX y el
-- asiento (20261109300200).
--
--   A) iibb_activity_templates (global, orientativo, verify = true) y
--      iibb_activities (por negocio): actividad por jurisdicción con código
--      (NAES), alícuota, impuesto mínimo, categorías de productos que la
--      componen y una principal por jurisdicción (la que toma el resto).
--   B) iibb_cm_coefficients: coeficiente unificado de Convenio Multilateral
--      por jurisdicción y vigencia (lo calcula el contador con el CM05).
--   C) iibb_liquidations: liquidación confirmada por jurisdicción y mes con la
--      foto del cálculo. Bloquea las retenciones sufridas de ese mes y
--      jurisdicción (iibb_period_locked). Se anula sólo la última.
--   D) _iibb_math: el cálculo puro (ESPEJO EXACTO de computeIibb en
--      lib/tax/iibb.ts, paridad con tests/fixtures/iibbMatrix.ts).
--      _iibb_compute: junta los datos del mes y llama a _iibb_math:
--        • base: neto sin IVA, internos ni percepciones de cada ítem
--          (sale_items.net_amount; ventas viejas sin desglose: subtotal sobre
--          1 + alícuota del ítem) de las ventas completadas del mes en las
--          sucursales de la jurisdicción (stores.province; sin provincia, la
--          del negocio) o, en Convenio Multilateral, de todas;
--          menos las ventas de meses anteriores anuladas en el mes y las
--          devoluciones del mes (en proporción a lo vendido de cada
--          actividad en esa venta). Una venta del mes anulada después del
--          cierre del mes se cuenta en su mes y se descuenta en el de la
--          anulación (como una nota de crédito);
--        • actividad de cada ítem: la que tiene la categoría del producto o la
--          principal de la jurisdicción;
--        • deducciones: tax_suffered_entries vigentes de IIBB de la
--          jurisdicción imputadas al mes (retenciones, percepciones, SIRCREB,
--          SIRTAC) y percepciones de IIBB de facturas de proveedor del mes;
--        • saldo a favor anterior: el que dejó la última liquidación
--          confirmada de la jurisdicción (o el inicial que se cargue en la
--          primera).
--   E) RPC: iibb_liquidation_preview, iibb_liquidation_confirm (recalcula y
--      compara con lo que vio el usuario), iibb_liquidation_void (la última,
--      con motivo).
--
-- Seguridad: lectura dueño o encargado (RESTRICTIVE tax_ret_can_read) o staff
-- con internal_scope(); actividades y coeficientes se escriben por PostgREST
-- sólo con tax_can_write('percepciones_retenciones') (dueño o encargado con
-- la feature) + role_write_guard; liquidaciones sólo por RPC. audit_logs en
-- todo. Gating: percepciones_retenciones en RPC y policies.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Actividades
-- -----------------------------------------------------------------------------
create table if not exists iibb_activity_templates (
  jurisdiction text not null references tax_jurisdictions(code),
  code         text not null check (code ~ '^[0-9]{1,6}$'),
  name         text not null,
  rate         numeric(7,4) not null check (rate >= 0 and rate <= 100),
  source       text not null,
  verify       boolean not null default true,
  notes        text,
  primary key (jurisdiction, code)
);
comment on table iibb_activity_templates is
  'Plantillas orientativas de actividad y alícuota de IIBB (ADR-095). verify = true: la alícuota real depende de la ley impositiva del año, de los ingresos del contribuyente y de la actividad exacta; validar con el contador.';

-- Valores orientativos (alícuota general del comercio minorista y de
-- servicios en la ley tarifaria / impositiva). VERIFICAR CON EL CONTADOR: hay
-- alícuotas reducidas o agravadas por nivel de ingresos y por actividad.
insert into iibb_activity_templates (jurisdiction, code, name, rate, source, notes) values
  ('901', '477000', 'Comercio minorista (general)', 3.0, 'Ley Tarifaria CABA (alícuota general de comercio)',
   'Verificar con contador: alícuota según ingresos del año anterior y actividad exacta (NAES).'),
  ('901', '960000', 'Servicios (general)', 3.0, 'Ley Tarifaria CABA (alícuota general de servicios)',
   'Verificar con contador.'),
  ('902', '477000', 'Comercio minorista (general)', 3.5, 'Ley Impositiva Provincia de Buenos Aires (comercio minorista)',
   'Verificar con contador: alícuota según ingresos del año anterior y actividad exacta (NAES).'),
  ('902', '960000', 'Servicios (general)', 3.5, 'Ley Impositiva Provincia de Buenos Aires (servicios)',
   'Verificar con contador.')
on conflict do nothing;

alter table iibb_activity_templates enable row level security;
drop policy if exists iibb_activity_templates_read on iibb_activity_templates;
create policy iibb_activity_templates_read on iibb_activity_templates for select to authenticated using (true);
revoke insert, update, delete on iibb_activity_templates from anon, authenticated;
grant select on iibb_activity_templates to authenticated;

create table if not exists iibb_activities (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  jurisdiction  text not null references tax_jurisdictions(code),
  code          text check (code is null or code ~ '^[0-9]{1,6}$'),
  name          text not null check (char_length(btrim(name)) between 1 and 120),
  rate          numeric(7,4) not null check (rate >= 0 and rate <= 100),
  min_tax       numeric(14,2) not null default 0 check (min_tax >= 0),
  is_default    boolean not null default false,
  category_ids  uuid[] not null default '{}',
  sort          int not null default 0,
  is_active     boolean not null default true,
  notes         text check (notes is null or char_length(notes) <= 300),
  updated_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table iibb_activities is
  'Actividades de IIBB del negocio por jurisdicción (ADR-095): alícuota, impuesto mínimo y categorías de productos. La principal (is_default) toma las ventas sin categoría asignada.';

create unique index if not exists iibb_activities_one_default
  on iibb_activities (tenant_id, jurisdiction) where is_default and is_active;
create index if not exists iibb_activities_tenant_idx on iibb_activities (tenant_id, jurisdiction, sort);
create index if not exists iibb_activities_jurisdiction_idx on iibb_activities (jurisdiction);
create index if not exists iibb_activities_updated_by_idx on iibb_activities (updated_by) where updated_by is not null;

create or replace function trg_iibb_activities_check()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  new.name := btrim(new.name);
  new.category_ids := coalesce((select array_agg(distinct c) from unnest(new.category_ids) c where c is not null), '{}');
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
revoke all on function trg_iibb_activities_check() from public, anon, authenticated;

drop trigger if exists iibb_activities_check on iibb_activities;
create trigger iibb_activities_check before insert or update on iibb_activities
  for each row execute function trg_iibb_activities_check();

alter table iibb_activities enable row level security;
drop policy if exists iibb_activities_read on iibb_activities;
create policy iibb_activities_read on iibb_activities for select
  using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists iibb_activities_role on iibb_activities;
create policy iibb_activities_role on iibb_activities as restrictive for select
  using ((select tax_ret_can_read()));
drop policy if exists iibb_activities_insert on iibb_activities;
create policy iibb_activities_insert on iibb_activities for insert
  with check (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')));
drop policy if exists iibb_activities_update on iibb_activities;
create policy iibb_activities_update on iibb_activities for update
  using (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')))
  with check (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')));
-- Sin DELETE: se desactiva (is_active = false); las liquidaciones guardan la foto.
revoke all on iibb_activities from anon;
revoke delete on iibb_activities from authenticated;
grant select, insert, update on iibb_activities to authenticated;

drop trigger if exists role_write_guard on iibb_activities;
create trigger role_write_guard before insert or update or delete on iibb_activities
  for each row execute function trg_role_write_guard('manage');
drop trigger if exists audit_iibb_activities on iibb_activities;
create trigger audit_iibb_activities after insert or update or delete on iibb_activities
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- B) Coeficientes de Convenio Multilateral
-- -----------------------------------------------------------------------------
create table if not exists iibb_cm_coefficients (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  jurisdiction text not null references tax_jurisdictions(code),
  valid_from   date not null check (valid_from = date_trunc('month', valid_from)::date),
  coefficient  numeric(7,6) not null check (coefficient >= 0 and coefficient <= 1),
  notes        text check (notes is null or char_length(notes) <= 300),
  updated_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint iibb_cm_coefficients_key unique (tenant_id, jurisdiction, valid_from)
);
comment on table iibb_cm_coefficients is
  'Coeficiente unificado de Convenio Multilateral por jurisdicción y vigencia (ADR-095). Lo calcula el contador (CM05); se toma el vigente al mes liquidado.';
create index if not exists iibb_cm_coefficients_jurisdiction_idx on iibb_cm_coefficients (jurisdiction);
create index if not exists iibb_cm_coefficients_updated_by_idx on iibb_cm_coefficients (updated_by) where updated_by is not null;

-- La suma de los coeficientes vigentes a una misma fecha no puede pasar de 1.
create or replace function trg_iibb_cm_check()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_sum numeric;
begin
  if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  select coalesce(sum(x.coefficient), 0) into v_sum
    from (select distinct on (c.jurisdiction) c.jurisdiction, c.coefficient
            from iibb_cm_coefficients c
           where c.tenant_id = new.tenant_id and c.valid_from <= new.valid_from and c.id <> new.id
             and c.jurisdiction <> new.jurisdiction
           order by c.jurisdiction, c.valid_from desc) x;
  if v_sum + new.coefficient > 1.000001 then
    raise exception 'iibb_cm_sum';
  end if;
  return new;
end;
$$;
revoke all on function trg_iibb_cm_check() from public, anon, authenticated;

drop trigger if exists iibb_cm_check on iibb_cm_coefficients;
create trigger iibb_cm_check before insert or update on iibb_cm_coefficients
  for each row execute function trg_iibb_cm_check();

alter table iibb_cm_coefficients enable row level security;
drop policy if exists iibb_cm_read on iibb_cm_coefficients;
create policy iibb_cm_read on iibb_cm_coefficients for select
  using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists iibb_cm_role on iibb_cm_coefficients;
create policy iibb_cm_role on iibb_cm_coefficients as restrictive for select
  using ((select tax_ret_can_read()));
drop policy if exists iibb_cm_insert on iibb_cm_coefficients;
create policy iibb_cm_insert on iibb_cm_coefficients for insert
  with check (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')));
drop policy if exists iibb_cm_update on iibb_cm_coefficients;
create policy iibb_cm_update on iibb_cm_coefficients for update
  using (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')))
  with check (tenant_id = (select current_tenant_id()) and (select tax_can_write('percepciones_retenciones')));
revoke all on iibb_cm_coefficients from anon;
revoke delete on iibb_cm_coefficients from authenticated;
grant select, insert, update on iibb_cm_coefficients to authenticated;

drop trigger if exists role_write_guard on iibb_cm_coefficients;
create trigger role_write_guard before insert or update or delete on iibb_cm_coefficients
  for each row execute function trg_role_write_guard('manage');
drop trigger if exists audit_iibb_cm_coefficients on iibb_cm_coefficients;
create trigger audit_iibb_cm_coefficients after insert or update or delete on iibb_cm_coefficients
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- C) Liquidaciones
-- -----------------------------------------------------------------------------
create table if not exists iibb_liquidations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  jurisdiction     text not null references tax_jurisdictions(code),
  period           date not null check (period = date_trunc('month', period)::date),
  regime           text not null check (regime in ('local', 'cm')),
  coefficient      numeric(7,6),
  base_total       numeric(14,2) not null,
  determined       numeric(14,2) not null check (determined >= 0),
  deductions_total numeric(14,2) not null check (deductions_total >= 0),
  previous_credit  numeric(14,2) not null default 0 check (previous_credit >= 0),
  opening_credit   numeric(14,2) check (opening_credit is null or opening_credit >= 0),
  used             numeric(14,2) not null check (used >= 0),
  to_pay           numeric(14,2) not null check (to_pay >= 0),
  credit_next      numeric(14,2) not null check (credit_next >= 0),
  previous_id      uuid references iibb_liquidations(id) on delete set null,
  snapshot         jsonb not null,
  status           text not null default 'confirmed' check (status in ('confirmed', 'voided')),
  confirmed_by     uuid references public.users(id) on delete set null,
  confirmed_at     timestamptz not null default now(),
  voided_at        timestamptz,
  voided_by        uuid references public.users(id) on delete set null,
  void_reason      text check (void_reason is null or char_length(void_reason) <= 300),
  constraint iibb_liquidations_void check ((status = 'voided') = (voided_at is not null)),
  constraint iibb_liquidations_balance check (to_pay = determined - used and credit_next = previous_credit + deductions_total - used)
);
comment on table iibb_liquidations is
  'Liquidaciones mensuales de IIBB confirmadas por jurisdicción (ADR-095), con la foto del cálculo. Una confirmada por jurisdicción y mes; bloquea las retenciones sufridas del mes. Se anula sólo la última.';

create unique index if not exists iibb_liquidations_one_confirmed
  on iibb_liquidations (tenant_id, jurisdiction, period) where status = 'confirmed';
create index if not exists iibb_liquidations_tenant_idx on iibb_liquidations (tenant_id, period desc);
create index if not exists iibb_liquidations_jurisdiction_idx on iibb_liquidations (jurisdiction);
create index if not exists iibb_liquidations_previous_idx on iibb_liquidations (previous_id) where previous_id is not null;
create index if not exists iibb_liquidations_confirmed_by_idx on iibb_liquidations (confirmed_by) where confirmed_by is not null;
create index if not exists iibb_liquidations_voided_by_idx on iibb_liquidations (voided_by) where voided_by is not null;

-- Inmutable salvo la anulación.
create or replace function trg_iibb_liquidations_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (to_jsonb(new) - array['status', 'voided_at', 'voided_by', 'void_reason'])
     is distinct from (to_jsonb(old) - array['status', 'voided_at', 'voided_by', 'void_reason']) then
    raise exception 'iibb_liquidation_immutable';
  end if;
  if old.status = 'voided' then
    raise exception 'iibb_liquidation_immutable';
  end if;
  return new;
end;
$$;
revoke all on function trg_iibb_liquidations_guard() from public, anon, authenticated;

drop trigger if exists iibb_liquidations_guard on iibb_liquidations;
create trigger iibb_liquidations_guard before update on iibb_liquidations
  for each row execute function trg_iibb_liquidations_guard();

alter table iibb_liquidations enable row level security;
drop policy if exists iibb_liquidations_read on iibb_liquidations;
create policy iibb_liquidations_read on iibb_liquidations for select
  using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists iibb_liquidations_role on iibb_liquidations;
create policy iibb_liquidations_role on iibb_liquidations as restrictive for select
  using ((select tax_ret_can_read()));
revoke all on iibb_liquidations from anon;
revoke insert, update, delete on iibb_liquidations from authenticated;
grant select on iibb_liquidations to authenticated;

drop trigger if exists role_write_guard on iibb_liquidations;
create trigger role_write_guard before insert or update or delete on iibb_liquidations
  for each row execute function trg_role_write_guard('manage');

-- -----------------------------------------------------------------------------
-- D) Cálculo
-- -----------------------------------------------------------------------------

-- Espejo exacto de computeIibb (lib/tax/iibb.ts).
--   p: {activities: [{key, base_raw, rate, min_tax}], coefficient: null | n,
--       deductions: {retencion, percepcion, sircreb, sirtac}, previous_credit}
create or replace function _iibb_math(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_coef numeric := (nullif(p ->> 'coefficient', ''))::numeric;
  a jsonb;
  v_acts jsonb := '[]'::jsonb;
  v_base numeric;
  v_tax numeric;
  v_min numeric;
  v_minimum boolean;
  v_base_total numeric := 0;
  v_det numeric := 0;
  v_ded numeric := 0;
  v_prev numeric := greatest(round(coalesce((p ->> 'previous_credit')::numeric, 0), 2), 0);
  v_avail numeric;
  v_used numeric;
begin
  for a in select * from jsonb_array_elements(coalesce(p -> 'activities', '[]'::jsonb)) loop
    v_base := round(coalesce((a ->> 'base_raw')::numeric, 0), 2);
    if v_coef is not null then
      v_base := round(v_base * v_coef, 2);
    end if;
    v_tax := case when v_base > 0 then round(v_base * coalesce((a ->> 'rate')::numeric, 0) / 100, 2) else 0 end;
    v_min := round(coalesce((a ->> 'min_tax')::numeric, 0), 2);
    v_minimum := v_min > 0 and v_tax < v_min;
    if v_minimum then v_tax := v_min; end if;
    v_acts := v_acts || jsonb_build_object('key', a ->> 'key', 'base', v_base, 'tax', v_tax, 'minimum_applied', v_minimum);
    v_base_total := v_base_total + v_base;
    v_det := v_det + v_tax;
  end loop;
  v_ded := greatest(round(coalesce((p -> 'deductions' ->> 'retencion')::numeric, 0), 2), 0)
         + greatest(round(coalesce((p -> 'deductions' ->> 'percepcion')::numeric, 0), 2), 0)
         + greatest(round(coalesce((p -> 'deductions' ->> 'sircreb')::numeric, 0), 2), 0)
         + greatest(round(coalesce((p -> 'deductions' ->> 'sirtac')::numeric, 0), 2), 0);
  v_avail := v_ded + v_prev;
  v_used := least(v_avail, v_det);
  return jsonb_build_object('activities', v_acts, 'base_total', v_base_total, 'determined', v_det,
                            'deductions_total', v_ded, 'previous_credit', v_prev, 'available', v_avail,
                            'used', v_used, 'to_pay', v_det - v_used, 'credit_next', v_avail - v_used);
end;
$$;
revoke all on function _iibb_math(jsonb) from public, anon, authenticated;
grant execute on function _iibb_math(jsonb) to service_role;

-- Datos del mes + cálculo. p_opening: saldo a favor inicial (sólo si no hay
-- una liquidación anterior confirmada de la jurisdicción).
create or replace function _iibb_compute(p_tenant uuid, p_jur text, p_period date, p_opening numeric default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_month  date := date_trunc('month', p_period)::date;
  v_next   date := (date_trunc('month', p_period) + interval '1 month')::date;
  v_from   timestamptz := (v_month::timestamp at time zone 'America/Argentina/Buenos_Aires');
  v_to     timestamptz := (v_next::timestamp at time zone 'America/Argentina/Buenos_Aires');
  v_set    jsonb := _tax_settings_eff(p_tenant);
  v_cm     boolean := coalesce((v_set ->> 'convenio_multilateral')::boolean, false);
  v_home   text := v_set ->> 'iibb_jurisdiction';
  v_coef   numeric;
  v_acts   jsonb;
  v_ded    jsonb;
  v_compras numeric;
  v_prev   iibb_liquidations%rowtype;
  v_prev_credit numeric := 0;
  v_math   jsonb;
  v_warn   jsonb := '[]'::jsonb;
  v_sales  int;
  v_legacy int;
  v_nomatch boolean;
  v_entries int;
  v_purch  int;
  v_review int;
begin
  if p_jur is null or not exists (select 1 from tax_jurisdictions where code = p_jur) then
    raise exception 'iibb_invalid_jurisdiction';
  end if;
  if not exists (select 1 from iibb_activities a where a.tenant_id = p_tenant and a.jurisdiction = p_jur and a.is_active) then
    raise exception 'iibb_no_activity';
  end if;
  if v_cm then
    select c.coefficient into v_coef from iibb_cm_coefficients c
     where c.tenant_id = p_tenant and c.jurisdiction = p_jur and c.valid_from <= v_month
     order by c.valid_from desc limit 1;
    if v_coef is null then
      v_coef := 0;
      v_warn := v_warn || '"cm_without_coefficient"'::jsonb;
    end if;
  end if;

  -- Base por actividad.
  with acts as (
    select a.* from iibb_activities a
     where a.tenant_id = p_tenant and a.jurisdiction = p_jur and a.is_active
  ),
  def as (
    select id from acts order by is_default desc, sort, created_at limit 1
  ),
  ss as (
    -- Ventas que suman en el mes (+1) o restan por anulación en el mes (−1).
    select s.id, s.total, s.perception_total,
           case when s.created_at >= v_from and s.created_at < v_to then 1 else -1 end as sign
      from sales s
      left join stores st on st.id = s.store_id
     where s.tenant_id = p_tenant
       and (v_cm or coalesce(_tax_jurisdiction_code(st.province), v_home) = p_jur)
       and (
             (s.created_at >= v_from and s.created_at < v_to
              and (s.status = 'completed' or (s.status = 'voided' and s.voided_at >= v_to)))
          or (s.created_at < v_from and s.status = 'voided' and s.voided_at >= v_from and s.voided_at < v_to)
       )
  ),
  rs as (
    -- Ventas con devoluciones en el mes (de cualquier mes).
    select s.id, s.total, s.perception_total, r.total as ret_total
      from sale_returns r
      join sales s on s.id = r.sale_id
      left join stores st on st.id = s.store_id
     where r.tenant_id = p_tenant and r.created_at >= v_from and r.created_at < v_to
       and (v_cm or coalesce(_tax_jurisdiction_code(st.province), v_home) = p_jur)
  ),
  ln as (
    select si.sale_id,
           coalesce((select a.id from acts a where p.category_id = any (a.category_ids)
                      order by a.sort, a.created_at limit 1), (select id from def)) as activity_id,
           (p.category_id is not null and not exists (select 1 from acts a where p.category_id = any (a.category_ids))
            and exists (select 1 from acts a where cardinality(a.category_ids) > 0)) as nomatch,
           coalesce(si.net_amount, round(si.subtotal / (1 + coalesce(si.iva_rate, 21) / 100), 2)) as net,
           si.net_amount is null as legacy
      from sale_items si
      left join products p on p.id = si.product_id
     where si.sale_id in (select id from ss union select id from rs)
  ),
  sale_net as (
    select sale_id, sum(net) as net from ln group by sale_id
  ),
  per_act as (
    select a.id, a.code, a.name, a.rate, a.min_tax, a.sort, a.created_at,
           coalesce((select sum(l.net) from ln l join ss on ss.id = l.sale_id
                      where l.activity_id = a.id and ss.sign = 1), 0) as sales,
           coalesce((select sum(l.net) from ln l join ss on ss.id = l.sale_id
                      where l.activity_id = a.id and ss.sign = -1), 0) as voids,
           coalesce((select sum(round(rs.ret_total * l.net / nullif(rs.total - coalesce(rs.perception_total, 0), 0), 2))
                       from rs join ln l on l.sale_id = rs.id
                      where l.activity_id = a.id), 0) as returns
      from acts a
  )
  select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'rate', rate, 'min_tax', min_tax,
                                      'sales', sales, 'voids', voids, 'returns', returns,
                                      'base_raw', sales - voids - returns)
                   order by sort, created_at),
         (select count(*) from ss where sign = 1),
         (select count(distinct sale_id) from ln where legacy and sale_id in (select id from ss)),
         coalesce((select bool_or(nomatch) from ln), false)
    into v_acts, v_sales, v_legacy, v_nomatch
    from per_act;

  -- Deducciones.
  select jsonb_build_object(
           'retencion', coalesce(sum(amount) filter (where kind = 'retencion' and regime not in ('sircreb', 'sirtac')), 0),
           'percepcion', coalesce(sum(amount) filter (where kind = 'percepcion' and regime not in ('sircreb', 'sirtac')), 0),
           'sircreb', coalesce(sum(amount) filter (where regime = 'sircreb'), 0),
           'sirtac', coalesce(sum(amount) filter (where regime = 'sirtac'), 0)),
         count(*)
    into v_ded, v_entries
    from tax_suffered_entries
   where tenant_id = p_tenant and status = 'active' and tax = 'iibb' and jurisdiction = p_jur and period = v_month;

  select coalesce(sum(v.amount_ars), 0), count(distinct v.source_id)
    into v_compras, v_purch
    from tax_suffered v
   where v.tenant_id = p_tenant and v.kind = 'percepcion_iibb'
     and _tax_jurisdiction_code(v.jurisdiction) = p_jur
     and v.date >= v_month and v.date < v_next;
  v_ded := jsonb_set(v_ded, '{percepcion}', to_jsonb((v_ded ->> 'percepcion')::numeric + v_compras));

  select count(*) into v_review from tax_suffered_entries
   where tenant_id = p_tenant and status = 'active' and tax = 'iibb' and jurisdiction is null and period = v_month;

  -- Saldo a favor anterior.
  select * into v_prev from iibb_liquidations
   where tenant_id = p_tenant and jurisdiction = p_jur and status = 'confirmed' and period < v_month
   order by period desc limit 1;
  if found then
    v_prev_credit := v_prev.credit_next;
    if v_prev.period <> (v_month - interval '1 month')::date then
      v_warn := v_warn || '"gap"'::jsonb;
    end if;
    if coalesce(p_opening, 0) > 0 then
      v_warn := v_warn || '"opening_ignored"'::jsonb;
    end if;
  else
    v_prev_credit := greatest(round(coalesce(p_opening, 0), 2), 0);
  end if;

  v_math := _iibb_math(jsonb_build_object(
    'activities', (select coalesce(jsonb_agg(jsonb_build_object('key', x ->> 'id', 'base_raw', x -> 'base_raw',
                                                                 'rate', x -> 'rate', 'min_tax', x -> 'min_tax')),
                                   '[]'::jsonb)
                     from jsonb_array_elements(v_acts) x),
    'coefficient', case when v_cm then v_coef end,
    'deductions', v_ded,
    'previous_credit', v_prev_credit));

  if (v_set ->> 'iva_condition') in ('monotributo', 'monotributo_social') then
    v_warn := v_warn || '"monotributo"'::jsonb;
  end if;
  if v_nomatch then v_warn := v_warn || '"no_activity_match"'::jsonb; end if;
  if v_legacy > 0 then v_warn := v_warn || '"legacy_sales"'::jsonb; end if;
  if v_review > 0 then v_warn := v_warn || '"review_pending"'::jsonb; end if;
  if exists (select 1 from jsonb_array_elements(v_math -> 'activities') x where (x ->> 'base')::numeric < 0) then
    v_warn := v_warn || '"negative_base"'::jsonb;
  end if;
  if v_next > (now() at time zone 'America/Argentina/Buenos_Aires')::date then
    v_warn := v_warn || '"current_month"'::jsonb;
  end if;

  return jsonb_build_object(
    'jurisdiction', p_jur, 'period', v_month, 'regime', case when v_cm then 'cm' else 'local' end,
    'coefficient', case when v_cm then v_coef end,
    'activities', (select jsonb_agg(x || jsonb_build_object('base', m -> 'base', 'tax', m -> 'tax',
                                                            'minimum_applied', m -> 'minimum_applied') order by o)
                     from jsonb_array_elements(v_acts) with ordinality as a(x, o)
                     join jsonb_array_elements(v_math -> 'activities') m on m ->> 'key' = x ->> 'id'),
    'base_total', v_math -> 'base_total', 'determined', v_math -> 'determined',
    'deductions', v_ded || jsonb_build_object('compras', v_compras),
    'deductions_total', v_math -> 'deductions_total',
    'previous_credit', v_math -> 'previous_credit',
    'previous_liquidation_id', v_prev.id, 'previous_period', v_prev.period,
    'opening_credit', case when v_prev.id is null and coalesce(p_opening, 0) > 0 then round(p_opening, 2) end,
    'available', v_math -> 'available', 'used', v_math -> 'used', 'to_pay', v_math -> 'to_pay',
    'credit_next', v_math -> 'credit_next',
    'entries', v_entries, 'purchase_perceptions', v_purch,
    'sales_count', v_sales, 'sales_without_breakdown', v_legacy,
    'warnings', v_warn);
end;
$$;
revoke all on function _iibb_compute(uuid, text, date, numeric) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- E) RPC
-- -----------------------------------------------------------------------------
create or replace function iibb_liquidation_preview(p_jurisdiction text, p_period date, p_opening_credit numeric default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_ret_assert();
begin
  if p_period is null then raise exception 'invalid_period'; end if;
  return _iibb_compute(v_tenant, p_jurisdiction, p_period, p_opening_credit)
         || jsonb_build_object('confirmed', (select to_jsonb(l) - 'snapshot' from iibb_liquidations l
                                              where l.tenant_id = v_tenant and l.jurisdiction = p_jurisdiction
                                                and l.period = date_trunc('month', p_period)::date
                                                and l.status = 'confirmed'));
end;
$$;
revoke all on function iibb_liquidation_preview(text, date, numeric) from public, anon;
grant execute on function iibb_liquidation_preview(text, date, numeric) to authenticated;

-- Confirma: recalcula en el servidor y compara con lo que vio el usuario
-- (saldo a pagar y saldo a favor). Sólo meses terminados.
create or replace function iibb_liquidation_confirm(p_jurisdiction text, p_period date,
                                                    p_expected_to_pay numeric, p_expected_credit numeric,
                                                    p_opening_credit numeric default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_ret_assert();
  v_month  date := date_trunc('month', p_period)::date;
  v_calc   jsonb;
  v_id     uuid;
begin
  if p_period is null then raise exception 'invalid_period'; end if;
  if (v_month + interval '1 month')::date > (now() at time zone 'America/Argentina/Buenos_Aires')::date then
    raise exception 'iibb_period_not_ended';
  end if;
  perform pg_advisory_xact_lock(hashtext('iibb:' || v_tenant::text || ':' || coalesce(p_jurisdiction, '')));
  if exists (select 1 from iibb_liquidations where tenant_id = v_tenant and jurisdiction = p_jurisdiction
                                               and period = v_month and status = 'confirmed') then
    raise exception 'iibb_already_confirmed';
  end if;
  if exists (select 1 from iibb_liquidations where tenant_id = v_tenant and jurisdiction = p_jurisdiction
                                               and period > v_month and status = 'confirmed') then
    raise exception 'iibb_later_confirmed';
  end if;
  v_calc := _iibb_compute(v_tenant, p_jurisdiction, v_month, p_opening_credit);
  if round(coalesce(p_expected_to_pay, -1), 2) <> (v_calc ->> 'to_pay')::numeric
     or round(coalesce(p_expected_credit, -1), 2) <> (v_calc ->> 'credit_next')::numeric then
    raise exception 'iibb_changed';
  end if;

  insert into iibb_liquidations (tenant_id, jurisdiction, period, regime, coefficient, base_total, determined,
                                 deductions_total, previous_credit, opening_credit, used, to_pay, credit_next,
                                 previous_id, snapshot, confirmed_by)
  values (v_tenant, p_jurisdiction, v_month, v_calc ->> 'regime', (v_calc ->> 'coefficient')::numeric,
          (v_calc ->> 'base_total')::numeric, (v_calc ->> 'determined')::numeric,
          (v_calc ->> 'deductions_total')::numeric, (v_calc ->> 'previous_credit')::numeric,
          (v_calc ->> 'opening_credit')::numeric, (v_calc ->> 'used')::numeric, (v_calc ->> 'to_pay')::numeric,
          (v_calc ->> 'credit_next')::numeric, (v_calc ->> 'previous_liquidation_id')::uuid, v_calc, auth.uid())
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'iibb_liquidations', v_id, 'iibb_liquidation_confirmed',
          jsonb_build_object('jurisdiction', p_jurisdiction, 'period', v_month, 'determined', v_calc -> 'determined',
                             'deductions_total', v_calc -> 'deductions_total', 'to_pay', v_calc -> 'to_pay',
                             'credit_next', v_calc -> 'credit_next'));
  return v_id;
end;
$$;
revoke all on function iibb_liquidation_confirm(text, date, numeric, numeric, numeric) from public, anon;
grant execute on function iibb_liquidation_confirm(text, date, numeric, numeric, numeric) to authenticated;

-- Anula la última confirmada de la jurisdicción (las posteriores arrastran su
-- saldo a favor). Libera las retenciones sufridas del mes.
create or replace function iibb_liquidation_void(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_ret_assert();
  l iibb_liquidations%rowtype;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'reason_required'; end if;
  select * into l from iibb_liquidations where id = p_id and tenant_id = v_tenant for update;
  if not found or l.status <> 'confirmed' then raise exception 'not_found'; end if;
  if exists (select 1 from iibb_liquidations where tenant_id = v_tenant and jurisdiction = l.jurisdiction
                                               and period > l.period and status = 'confirmed') then
    raise exception 'iibb_later_confirmed';
  end if;
  update iibb_liquidations
     set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = left(btrim(p_reason), 300)
   where id = l.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'iibb_liquidations', l.id, 'iibb_liquidation_voided', to_jsonb(l) - 'snapshot',
          jsonb_build_object('status', 'voided'), left(btrim(p_reason), 300));
end;
$$;
revoke all on function iibb_liquidation_void(uuid, text) from public, anon;
grant execute on function iibb_liquidation_void(uuid, text) to authenticated;
