-- =============================================================================
-- 20261104200100_retenciones_agente_motor  (F18 · H106, ADR-079)
--
-- Cálculo y registro de las retenciones practicadas como agente en la orden
-- de pago. Espejo EXACTO de lib/tax/retentions.ts (paridad probada con
-- tests/fixtures/retentionMatrix.ts).
--
--   A) tax_withholdings: registro de cada cálculo de la orden de pago. Las
--      retenciones practicadas (amount > 0) llevan certificado con numeración
--      correlativa por régimen del agente (tax_regimes: impuesto ×
--      jurisdicción) y la foto del agente y del sujeto. Los cálculos de
--      Ganancias que no retuvieron (por debajo del mínimo no sujeto o del
--      mínimo de retención) también se guardan, con amount = 0 y sin
--      certificado, porque acumulan para el próximo pago del mes (RG 830).
--      Lectura: dueño o encargado (RESTRICTIVE) del negocio, staff por
--      internal_scope(); sin escritura por PostgREST.
--   B) _tax_retention_bases: bases del pago desde la imputación (neto sin IVA,
--      neto gravado, total e IVA de cada comprobante en proporción a lo
--      imputado) o, sin imputación (anticipo), el importe pagado.
--   C) _tax_retention_compute: Ganancias por concepto con acumulado mensual,
--      mínimo no sujeto, escala, inscripto o no inscripto, exclusión y
--      retención mínima; SUSS por actividad del proveedor; IVA e IIBB con
--      padrón, condición o alícuota general. Devuelve cada régimen con
--      `applies` y el motivo (`reason`) para explicarlo en la orden de pago.
--   D) tax_retention_preview(p): lo que ve el usuario antes de registrar.
--   E) supplier_payment_order_create (RECREADA desde 20261022100400, la única
--      definición): con `agent_retentions = true` el servidor recalcula las
--      retenciones (no confía en el cliente), compara con
--      `agent_expected_total` (si difiere: retentions_changed), numera los
--      certificados, guarda tax_withholdings y deja cada retención en
--      supplier_payments.withholdings con su certificado: el asiento contable
--      (acc_sync_supplier_payment, ADR-066) las toma de ahí sin cambios.
--   F) Anular la orden de pago anula sus retenciones (trigger; los números de
--      certificado no se reutilizan).
--   G) tax_withholdings_list / tax_withholdings_export (SICORE y ARBA), con
--      auditoría al exportar.
--
-- Gating: percepciones_retenciones (tenant_has_feature_for) en todas las RPC
-- y en el cálculo de la orden de pago. Rol: dueño o encargado.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Registro
-- -----------------------------------------------------------------------------
create table if not exists tax_withholdings (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  payment_id         uuid not null references supplier_payments(id) on delete cascade,
  payment_number     int not null,
  payment_total      numeric(14,2) not null,
  supplier_id        uuid not null references suppliers(id),
  regime_id          uuid not null references tax_regimes(id),
  tax                text not null check (tax in ('ganancias', 'iva', 'iibb', 'suss')),
  jurisdiction       text references tax_jurisdictions(code),
  date               date not null,
  period             date not null check (period = date_trunc('month', period)::date),
  concept_code       text,
  concept_name       text,
  condition          text,
  payment_base       numeric(14,2) not null default 0,
  prior_base         numeric(14,2) not null default 0,
  accumulated_base   numeric(14,2) not null default 0,
  non_taxable_min    numeric(14,2) not null default 0,
  taxable_base       numeric(14,2) not null default 0,
  month_total        numeric(14,2) not null default 0,
  prior_withheld     numeric(14,2) not null default 0,
  rate               numeric(7,4),
  rate_source        text,
  exemption_pct      numeric(5,2) not null default 0,
  amount             numeric(14,2) not null default 0 check (amount >= 0),
  reason             text not null,
  certificate_number int,
  certificate        text,
  sicore_tax_code    int,
  sicore_regime_code text,
  agent_snapshot     jsonb not null default '{}'::jsonb,
  subject_snapshot   jsonb not null default '{}'::jsonb,
  status             text not null default 'issued' check (status in ('issued', 'voided')),
  voided_at          timestamptz,
  void_reason        text,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  constraint tax_withholdings_certificate check ((amount > 0) = (certificate_number is not null))
);
comment on table tax_withholdings is
  'Retenciones calculadas en órdenes de pago (ADR-079). amount > 0 = practicada, con certificado correlativo por régimen; amount = 0 = cálculo de Ganancias que acumula en el mes sin retener.';

create unique index if not exists tax_withholdings_cert_key
  on tax_withholdings (tenant_id, regime_id, certificate_number) where certificate_number is not null;
create index if not exists tax_withholdings_accum_idx
  on tax_withholdings (tenant_id, supplier_id, tax, concept_code, period) where status = 'issued';
create index if not exists tax_withholdings_period_idx on tax_withholdings (tenant_id, period);
create index if not exists tax_withholdings_payment_idx on tax_withholdings (payment_id);

create or replace function tax_ret_can_read()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select internal_scope() or coalesce(stock_my_role() in ('owner', 'manager'), false);
$$;
revoke all on function tax_ret_can_read() from public, anon;
grant execute on function tax_ret_can_read() to authenticated, service_role;

alter table tax_withholdings enable row level security;
drop policy if exists tax_withholdings_select on tax_withholdings;
create policy tax_withholdings_select on tax_withholdings for select
  using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists tax_withholdings_role on tax_withholdings;
create policy tax_withholdings_role on tax_withholdings as restrictive for select
  using ((select tax_ret_can_read()));
revoke all on tax_withholdings from anon;
revoke insert, update, delete on tax_withholdings from authenticated;
grant select on tax_withholdings to authenticated;

-- Guard: sólo cambia el estado (anulación); lo demás es inmutable.
create or replace function trg_tax_withholdings_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (to_jsonb(new) - array['status', 'voided_at', 'void_reason'])
     is distinct from (to_jsonb(old) - array['status', 'voided_at', 'void_reason']) then
    raise exception 'tax_withholding_immutable';
  end if;
  if old.status = 'voided' and new.status <> 'voided' then
    raise exception 'tax_withholding_immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists tax_withholdings_guard on tax_withholdings;
create trigger tax_withholdings_guard before update on tax_withholdings
  for each row execute function trg_tax_withholdings_guard();

-- -----------------------------------------------------------------------------
-- B) Bases del pago
-- -----------------------------------------------------------------------------
create or replace function _tax_retention_bases(p_tenant uuid, p_supplier uuid, p_allocations jsonb, p_amount numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
  v_amt numeric := round(greatest(coalesce(p_amount, 0), 0), 2);
begin
  if p_allocations is not null and jsonb_typeof(p_allocations) = 'array' then
    select jsonb_build_object(
             'net', round(coalesce(sum(round(a.amount * (i.net_total + i.exempt_amount + i.non_taxed_amount) / i.total, 2)), 0), 2),
             'net_taxed', round(coalesce(sum(round(a.amount * i.net_total / i.total, 2)), 0), 2),
             'total', round(coalesce(sum(round(a.amount, 2)), 0), 2),
             'vat', round(coalesce(sum(round(a.amount * i.vat_total / i.total, 2)), 0), 2),
             'n', count(*))
      into v
      from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
      join supplier_invoices i on i.id = a.invoice_id and i.tenant_id = p_tenant and i.supplier_id = p_supplier
     where coalesce(a.amount, 0) > 0 and i.total > 0;
    if coalesce((v ->> 'n')::int, 0) > 0 then
      return v - 'n';
    end if;
  end if;
  return jsonb_build_object('net', v_amt, 'net_taxed', v_amt, 'total', v_amt, 'vat', 0);
end;
$$;
revoke all on function _tax_retention_bases(uuid, uuid, jsonb, numeric) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- C) Cálculo (espejo de computeRetentions)
--    p_opts: {ganancias_concept?, ganancias_condition?, suss_code?} (una
--    clave presente pisa el perfil del proveedor; ausente usa el perfil).
-- -----------------------------------------------------------------------------
create or replace function _tax_retention_compute(p_tenant uuid, p_supplier uuid, p_bases jsonb, p_at date,
                                                  p_opts jsonb default '{}'::jsonb,
                                                  p_exclude_payment uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sup        record;
  v_prof       supplier_tax_profiles%rowtype;
  v_opts       jsonb := coalesce(p_opts, '{}'::jsonb);
  v_cuit       text;
  v_ivacond    text;
  v_gcond      text;
  v_gcode      text;
  v_scode      text;
  v_gc         jsonb;
  v_sc         jsonb;
  v_at         date := coalesce(p_at, current_date);
  v_month      date := date_trunc('month', coalesce(p_at, current_date))::date;
  b_net        numeric := round(coalesce((p_bases ->> 'net')::numeric, 0), 2);
  b_nt         numeric := round(coalesce((p_bases ->> 'net_taxed')::numeric, 0), 2);
  b_tot        numeric := round(coalesce((p_bases ->> 'total')::numeric, 0), 2);
  b_vat        numeric := round(coalesce((p_bases ->> 'vat')::numeric, 0), 2);
  rg           record;
  v_lines      jsonb := '[]'::jsonb;
  v_total      numeric := 0;
  v_warn       jsonb := '[]'::jsonb;
  v_has_gan    boolean := false;
  -- línea
  v_base       numeric;
  v_rate       numeric;
  v_padron     numeric;
  v_src        text;
  v_ex         numeric;
  v_amt        numeric;
  v_reason     text;
  v_applies    boolean;
  v_prior_base numeric;
  v_prior_wh   numeric;
  v_accum      numeric;
  v_min        numeric;
  v_subject    numeric;
  v_mtotal     numeric;
  v_computed   numeric;
  v_minwh      numeric;
  v_minbase    numeric;
  v_accumulates boolean;
  v_concept    text;
  v_cname      text;
  v_cond_out   text;
begin
  select s.id, s.name, s.cuit, s.iva_condition into v_sup
    from suppliers s where s.id = p_supplier and s.tenant_id = p_tenant;
  if not found then raise exception 'supplier_not_found'; end if;
  select * into v_prof from supplier_tax_profiles where tenant_id = p_tenant and supplier_id = p_supplier;
  v_cuit := nullif(regexp_replace(coalesce(v_sup.cuit, ''), '\D', '', 'g'), '');
  v_ivacond := v_sup.iva_condition;

  v_gcond := case when v_opts ? 'ganancias_condition' then nullif(v_opts ->> 'ganancias_condition', '')
                  else v_prof.ganancias_condition end;
  if v_gcond is not null and v_gcond not in ('inscripto', 'no_inscripto', 'exento', 'no_alcanzado') then
    raise exception 'invalid_condition';
  end if;
  v_gcode := case when v_opts ? 'ganancias_concept' then nullif(v_opts ->> 'ganancias_concept', '')
                  else v_prof.ganancias_concept end;
  v_scode := case when v_opts ? 'suss_code' then nullif(v_opts ->> 'suss_code', '') else v_prof.suss_code end;
  if v_gcode is not null then
    v_gc := tax_ret_concept_eff(p_tenant, 'ganancias', v_gcode, v_at);
    if v_gc is null then raise exception 'invalid_concept'; end if;
    if not coalesce((v_gc ->> 'is_active')::boolean, true) then v_gc := null; end if;
  end if;
  if v_scode is not null then
    v_sc := tax_ret_concept_eff(p_tenant, 'suss', v_scode, v_at);
    if v_sc is null then raise exception 'invalid_suss'; end if;
    if not coalesce((v_sc ->> 'is_active')::boolean, true) then v_sc := null; end if;
  end if;

  for rg in
    select * from tax_regimes r
     where r.tenant_id = p_tenant and r.is_active and r.deleted_at is null and r.role = 'retention'
     order by case r.tax when 'ganancias' then 1 when 'iva' then 2 when 'iibb' then 3 else 4 end,
              coalesce(r.jurisdiction, '')
  loop
    v_base := 0; v_rate := null; v_src := null; v_ex := 0; v_amt := 0; v_reason := null; v_applies := false;
    v_prior_base := 0; v_prior_wh := 0; v_accum := 0; v_min := 0; v_subject := 0; v_mtotal := 0;
    v_computed := 0; v_minwh := 0; v_accumulates := false; v_concept := null; v_cname := null; v_cond_out := null;

    if rg.tax = 'ganancias' then
      v_has_gan := true;
      v_base := b_net;
      if v_ivacond in ('monotributo', 'monotributo_social') then
        v_reason := 'monotributo';
      else
        v_cond_out := coalesce(v_gcond, 'inscripto');
        if v_cond_out in ('exento', 'no_alcanzado') then
          v_reason := 'gan_not_subject';
        elsif v_gc is null then
          v_reason := 'no_concept';
        else
          v_concept := v_gc ->> 'code';
          v_cname := v_gc ->> 'name';
          v_minwh := coalesce((v_gc ->> 'min_withholding')::numeric, 0);
          if v_base <= 0 then
            v_reason := 'no_base';
          else
            v_accumulates := true;
            select coalesce(sum(w.payment_base), 0), coalesce(sum(w.amount), 0)
              into v_prior_base, v_prior_wh
              from tax_withholdings w
             where w.tenant_id = p_tenant and w.supplier_id = p_supplier and w.tax = 'ganancias'
               and w.concept_code = v_concept and w.status = 'issued' and w.period = v_month
               and (p_exclude_payment is null or w.payment_id <> p_exclude_payment);
            v_prior_base := round(v_prior_base, 2);
            v_prior_wh := round(v_prior_wh, 2);
            v_accum := round(v_prior_base + v_base, 2);
            v_min := case when v_cond_out = 'inscripto' or coalesce((v_gc ->> 'unregistered_min_applies')::boolean, false)
                          then coalesce((v_gc ->> 'min_non_taxable')::numeric, 0) else 0 end;
            v_subject := round(greatest(v_accum - v_min, 0), 2);
            if v_cond_out = 'inscripto' and coalesce((v_gc ->> 'uses_scale')::boolean, false) then
              v_src := 'scale';
            else
              v_rate := case when v_cond_out = 'inscripto' then (v_gc ->> 'rate_registered')::numeric
                             else (v_gc ->> 'rate_unregistered')::numeric end;
              v_src := case when v_cond_out = 'inscripto' then 'registered' else 'unregistered' end;
            end if;
            if v_src <> 'scale' and v_rate is null then
              v_reason := 'no_rate';
            else
              v_ex := _tax_exemption_pct(p_tenant, 'supplier', p_supplier, 'ganancias', null, v_at);
              if v_ex >= 100 then
                v_reason := 'exempt';
              elsif v_subject <= 0 then
                v_reason := 'below_non_taxable';
              else
                v_mtotal := case when v_src = 'scale'
                                 then _tax_ret_scale_amount(v_gc ->> 'scale_code', v_subject, v_at)
                                 else round(v_subject * v_rate / 100, 2) end;
                v_computed := round(v_mtotal - v_prior_wh, 2);
                if v_computed <= 0 then
                  v_computed := 0;
                  v_reason := 'already_withheld';
                else
                  v_amt := case when v_ex > 0 then round(v_computed * (100 - v_ex) / 100, 2) else v_computed end;
                  if v_amt <= 0 or v_amt < v_minwh then
                    v_amt := 0;
                    v_reason := 'below_min_withholding';
                  else
                    v_applies := true;
                    v_reason := 'applied';
                  end if;
                end if;
              end if;
            end if;
          end if;
        end if;
      end if;

    else
      v_base := round(case rg.base_kind when 'net_taxed' then b_nt when 'total' then b_tot when 'vat' then b_vat
                                        else b_net end, 2);
      v_minbase := rg.min_base;
      v_minwh := rg.min_amount;
      v_src := 'default';
      if rg.tax = 'suss' then
        if v_sc is null then
          v_reason := 'suss_not_applicable';
        else
          v_concept := v_sc ->> 'code';
          v_cname := v_sc ->> 'name';
          v_minbase := greatest(v_minbase, coalesce((v_sc ->> 'min_non_taxable')::numeric, 0));
          v_minwh := greatest(v_minwh, coalesce((v_sc ->> 'min_withholding')::numeric, 0));
          v_rate := coalesce(rg.default_rate, (v_sc ->> 'rate_registered')::numeric);
        end if;
      end if;
      if v_reason is null then
        if not (coalesce(v_ivacond, 'responsable_inscripto') = any (rg.applies_to)) then
          v_reason := 'condition_not_reached';
        elsif v_base <= 0 then
          v_reason := 'no_base';
        else
          if rg.tax <> 'suss' then
            v_padron := null;
            if rg.padron_source <> 'none' and v_cuit is not null then
              v_padron := _tax_padron_rate(p_tenant, rg.jurisdiction, v_cuit, 'retention', v_at);
            end if;
            if v_padron is not null then
              v_rate := v_padron;
              v_src := 'padron';
            elsif v_ivacond is not null and rg.rates_by_condition ? v_ivacond then
              v_rate := (rg.rates_by_condition ->> v_ivacond)::numeric;
              v_src := 'condition';
            else
              v_rate := rg.default_rate;
            end if;
          end if;
          if v_rate is null or v_rate <= 0 then
            v_reason := 'no_rate';
          else
            v_ex := _tax_exemption_pct(p_tenant, 'supplier', p_supplier, rg.tax, rg.jurisdiction, v_at);
            if v_ex >= 100 then
              v_reason := 'exempt';
            else
              v_rate := round(v_rate * (1 - v_ex / 100), 4);
              if v_base < v_minbase then
                v_reason := 'below_min_base';
              else
                v_amt := round(v_base * v_rate / 100, 2);
                v_computed := v_amt;
                if v_amt <= 0 or v_amt < v_minwh then
                  v_amt := 0;
                  v_reason := 'below_min_amount';
                else
                  v_applies := true;
                  v_reason := 'applied';
                end if;
              end if;
            end if;
          end if;
        end if;
      end if;
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'regime_id', rg.id, 'tax', rg.tax, 'jurisdiction', rg.jurisdiction, 'name', rg.name,
      'agent_number', rg.agent_number, 'regime_code', rg.regime_code,
      'applies', v_applies, 'reason', v_reason, 'amount', case when v_applies then v_amt else 0 end,
      'base', v_base, 'rate', v_rate, 'rate_source', v_src, 'exemption_pct', v_ex,
      'concept_code', v_concept, 'concept_name', v_cname, 'condition', v_cond_out,
      'prior_base', v_prior_base, 'accumulated_base', v_accum, 'non_taxable_min', v_min,
      'taxable_base', v_subject, 'month_total', v_mtotal, 'prior_withheld', v_prior_wh,
      'computed', v_computed, 'min_withholding', v_minwh, 'accumulates', v_accumulates,
      'sicore_tax_code', case rg.tax when 'ganancias' then (v_gc ->> 'sicore_tax_code')::int
                                     when 'suss' then (v_sc ->> 'sicore_tax_code')::int
                                     when 'iva' then 767 end,
      'sicore_regime_code', case rg.tax when 'ganancias' then v_gc ->> 'sicore_regime_code'
                                        when 'suss' then coalesce(v_sc ->> 'sicore_regime_code', rg.regime_code)
                                        else rg.regime_code end));
    if v_applies then
      v_total := v_total + v_amt;
    end if;
  end loop;

  if v_has_gan and v_gcond is null and coalesce(v_ivacond, '') not in ('monotributo', 'monotributo_social') then
    v_warn := v_warn || '["ganancias_condition_unknown"]'::jsonb;
  end if;
  if v_cuit is null then
    v_warn := v_warn || '["supplier_without_cuit"]'::jsonb;
  end if;

  return jsonb_build_object(
    'lines', v_lines,
    'total', round(v_total, 2),
    'bases', jsonb_build_object('net', b_net, 'net_taxed', b_nt, 'total', b_tot, 'vat', b_vat),
    'supplier', jsonb_build_object('id', v_sup.id, 'name', v_sup.name, 'cuit', v_cuit, 'iva_condition', v_ivacond,
                                   'ganancias_condition', v_gcond, 'ganancias_concept', v_gcode, 'suss_code', v_scode,
                                   'has_profile', v_prof.id is not null),
    'warnings', v_warn);
end;
$$;
revoke all on function _tax_retention_compute(uuid, uuid, jsonb, date, jsonb, uuid) from public, anon, authenticated;

create or replace function _tax_ret_assert()
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
revoke all on function _tax_ret_assert() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Vista previa para la orden de pago
--    p: {supplier_id, allocations?: [{invoice_id, amount}], amount?, date?,
--        options?: {ganancias_concept?, ganancias_condition?, suss_code?}}
-- -----------------------------------------------------------------------------
create or replace function tax_retention_preview(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_ret_assert();
  v_sup    uuid := (p ->> 'supplier_id')::uuid;
  v_date   date := coalesce((nullif(p ->> 'date', ''))::date, current_date);
  v_bases  jsonb;
begin
  if not exists (select 1 from suppliers s where s.id = v_sup and s.tenant_id = v_tenant) then
    raise exception 'supplier_not_found';
  end if;
  v_bases := _tax_retention_bases(v_tenant, v_sup, p -> 'allocations', (p ->> 'amount')::numeric);
  return _tax_retention_compute(v_tenant, v_sup, v_bases, v_date, coalesce(p -> 'options', '{}'::jsonb), null)
         || jsonb_build_object('date', v_date);
end;
$$;
revoke all on function tax_retention_preview(jsonb) from public, anon;
grant execute on function tax_retention_preview(jsonb) to authenticated;

-- Foto del agente para el certificado.
create or replace function _tax_ret_agent_snapshot(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'name', coalesce(nullif(btrim(b.legal_name), ''), t.name),
    'cuit', _tax_settings_eff(p_tenant) ->> 'cuit',
    'iva_condition', _tax_settings_eff(p_tenant) ->> 'iva_condition',
    'iibb_number', _tax_settings_eff(p_tenant) ->> 'iibb_number',
    'address', b.address)
    from tenants t
    left join tenant_branding b on b.tenant_id = t.id
   where t.id = p_tenant;
$$;
revoke all on function _tax_ret_agent_snapshot(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- E) Alta de la orden de pago (recreada desde 20261022100400).
--    p: {supplier_id, paid_date?, notes?,
--        lines: [{method, amount, reference?, treasury_account_id?,
--                 cash_shift_id?, cheque_id? (terceros),
--                 cheque?: {number, bank_name?, issue_date?, payment_date}}],
--        withholdings: [{kind, description?, certificate?, amount}],   (manuales)
--        allocations: [{invoice_id, amount}],
--        agent_retentions?: bool, agent_expected_total?: numeric,
--        retention_options?: {ganancias_concept?, ganancias_condition?, suss_code?, save_profile?}}
-- -----------------------------------------------------------------------------
create or replace function supplier_payment_order_create(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := purchase_assert(true);
  v_tes      boolean;
  v_sup      suppliers;
  v_date     date := coalesce((nullif(p ->> 'paid_date', ''))::date, current_date);
  v_wh       jsonb := coalesce(p -> 'withholdings', '[]'::jsonb);
  v_whtot    numeric;
  v_net      numeric := 0;
  v_alloc    numeric := 0;
  v_line     record;
  v_al       record;
  v_open     numeric;
  v_inv      supplier_invoices;
  v_number   int;
  v_pay      uuid := gen_random_uuid();
  v_label    text;
  v_methods  text[] := '{}';
  v_method   text;
  v_shift    uuid;
  v_cash     uuid;
  v_acc      treasury_accounts;
  v_tmov     uuid;
  v_cheque   uuid;
  v_ch       cheques;
  v_sort     int := 0;
  -- retenciones como agente (ADR-079)
  v_agent    boolean := coalesce((p ->> 'agent_retentions')::boolean, false);
  v_opts     jsonb := coalesce(p -> 'retention_options', '{}'::jsonb);
  v_calc     jsonb;
  v_rl       jsonb;
  v_cert     int;
  v_certtxt  text;
  v_whid     uuid;
  v_agentsnap jsonb;
  v_subjsnap jsonb;
  v_regs     jsonb := '[]'::jsonb;
  v_issued   jsonb := '[]'::jsonb;
begin
  select * into v_sup from suppliers
   where id = (p ->> 'supplier_id')::uuid and tenant_id = v_tenant and deleted_at is null;
  if v_sup.id is null then
    raise exception 'supplier_not_found';
  end if;
  if p -> 'lines' is null or jsonb_typeof(p -> 'lines') <> 'array' then
    raise exception 'invalid_lines';
  end if;
  if p -> 'allocations' is not null and jsonb_typeof(p -> 'allocations') <> 'array' then
    raise exception 'invalid_lines';
  end if;
  if jsonb_typeof(v_wh) <> 'array' then
    raise exception 'invalid_lines';
  end if;
  v_tes := tenant_has_feature_for(v_tenant, 'tesoreria');

  for v_line in
    select x.method, round(coalesce(x.amount, 0), 2) as amount
      from jsonb_to_recordset(p -> 'lines') as x(method text, amount numeric)
  loop
    if v_line.amount <= 0 then
      raise exception 'invalid_amount';
    end if;
    v_net := v_net + v_line.amount;
    if not v_line.method = any (v_methods) then
      v_methods := v_methods || v_line.method;
    end if;
  end loop;

  -- Retenciones como agente: el servidor las calcula (las del cliente con
  -- regime_id se descartan) y numera los certificados.
  if v_agent then
    if not tenant_has_feature_for(v_tenant, 'percepciones_retenciones') then
      raise exception 'feature_not_in_plan: percepciones_retenciones' using errcode = 'check_violation';
    end if;
    perform pg_advisory_xact_lock(hashtext('tax_wh_supplier:' || v_sup.id::text));
    v_wh := coalesce((select jsonb_agg(x) from jsonb_array_elements(v_wh) x
                       where coalesce(x ->> 'regime_id', '') = ''), '[]'::jsonb);
    v_calc := _tax_retention_compute(
      v_tenant, v_sup.id,
      _tax_retention_bases(v_tenant, v_sup.id, p -> 'allocations', v_net + purchase_withholdings_total(v_wh)),
      v_date, v_opts - 'save_profile', null);
    if p ? 'agent_expected_total'
       and abs((v_calc ->> 'total')::numeric - coalesce((p ->> 'agent_expected_total')::numeric, 0)) > 0.009 then
      raise exception 'retentions_changed';
    end if;
    if coalesce((v_opts ->> 'save_profile')::boolean, false) then
      insert into supplier_tax_profiles as t (tenant_id, supplier_id, ganancias_condition, ganancias_concept, suss_code)
      values (v_tenant, v_sup.id, v_calc -> 'supplier' ->> 'ganancias_condition',
              v_calc -> 'supplier' ->> 'ganancias_concept', v_calc -> 'supplier' ->> 'suss_code')
      on conflict (tenant_id, supplier_id) do update
        set ganancias_condition = excluded.ganancias_condition,
            ganancias_concept = excluded.ganancias_concept,
            suss_code = excluded.suss_code;
    end if;
    if (v_calc ->> 'total')::numeric > 0 then
      v_agentsnap := _tax_ret_agent_snapshot(v_tenant);
      if nullif(v_agentsnap ->> 'cuit', '') is null then
        raise exception 'agent_cuit_missing';
      end if;
    end if;
    v_subjsnap := jsonb_build_object(
      'name', v_sup.name, 'cuit', v_sup.cuit, 'address', v_sup.address, 'city', v_sup.city,
      'province', v_sup.province, 'iva_condition', v_sup.iva_condition,
      'ganancias_condition', v_calc -> 'supplier' ->> 'ganancias_condition');
    for v_rl in select * from jsonb_array_elements(v_calc -> 'lines') loop
      continue when not ((v_rl ->> 'applies')::boolean or (v_rl ->> 'accumulates')::boolean);
      v_cert := null; v_certtxt := null;
      v_whid := gen_random_uuid();
      if (v_rl ->> 'applies')::boolean then
        perform pg_advisory_xact_lock(hashtext('tax_wh_cert:' || (v_rl ->> 'regime_id')));
        select coalesce(max(w.certificate_number), 0) + 1 into v_cert
          from tax_withholdings w
         where w.tenant_id = v_tenant and w.regime_id = (v_rl ->> 'regime_id')::uuid;
        v_certtxt := case v_rl ->> 'tax' when 'ganancias' then 'GAN' when 'iva' then 'IVA' when 'suss' then 'SUSS'
                                        else 'IIBB' || coalesce(v_rl ->> 'jurisdiction', '') end
                     || '-' || lpad(v_cert::text, 8, '0');
        v_wh := v_wh || jsonb_build_array(jsonb_build_object(
          'kind', v_rl ->> 'tax',
          'description', left(coalesce(v_rl ->> 'name', '') || coalesce(' · ' || (v_rl ->> 'concept_name'), ''), 120),
          'certificate', v_certtxt, 'amount', (v_rl ->> 'amount')::numeric,
          'regime_id', v_rl ->> 'regime_id', 'withholding_id', v_whid,
          'jurisdiction', v_rl ->> 'jurisdiction', 'base', (v_rl ->> 'base')::numeric,
          'rate', (v_rl ->> 'rate')::numeric));
        v_issued := v_issued || jsonb_build_array(jsonb_build_object(
          'certificate', v_certtxt, 'tax', v_rl ->> 'tax', 'amount', (v_rl ->> 'amount')::numeric));
      end if;
      v_regs := v_regs || jsonb_build_array(v_rl || jsonb_build_object(
        'id', v_whid, 'certificate_number', v_cert, 'certificate', v_certtxt));
    end loop;
  end if;

  v_whtot := purchase_withholdings_total(v_wh);
  if v_net + v_whtot <= 0 then
    raise exception 'invalid_amount';
  end if;

  v_method := case
    when array_length(v_methods, 1) is null then 'otro'
    when array_length(v_methods, 1) > 1 then 'mixto'
    when v_methods[1] in ('cheque_propio', 'cheque_tercero') then 'cheque'
    else v_methods[1]
  end;

  perform pg_advisory_xact_lock(hashtext('supplier_payment_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from supplier_payments where tenant_id = v_tenant;
  v_label := 'OP-' || lpad(v_number::text, 6, '0');

  insert into supplier_payments (id, tenant_id, number, supplier_id, paid_date, method, reference, currency, fx_rate,
                                 amount, withholdings, withholdings_total, net_paid, notes, kind, created_by)
  values (v_pay, v_tenant, v_number, v_sup.id, v_date, v_method, null, 'ARS', 1, v_net + v_whtot, v_wh, v_whtot, v_net,
          nullif(trim(coalesce(p ->> 'notes', '')), ''), 'order', auth.uid());

  -- Registro de retenciones (con la OP ya creada).
  for v_rl in select * from jsonb_array_elements(v_regs) loop
    insert into tax_withholdings (
      id, tenant_id, payment_id, payment_number, payment_total, supplier_id, regime_id, tax, jurisdiction,
      date, period, concept_code, concept_name, condition, payment_base, prior_base, accumulated_base,
      non_taxable_min, taxable_base, month_total, prior_withheld, rate, rate_source, exemption_pct, amount, reason,
      certificate_number, certificate, sicore_tax_code, sicore_regime_code, agent_snapshot, subject_snapshot)
    values (
      (v_rl ->> 'id')::uuid, v_tenant, v_pay, v_number, v_net + v_whtot, v_sup.id, (v_rl ->> 'regime_id')::uuid,
      v_rl ->> 'tax', v_rl ->> 'jurisdiction', v_date, date_trunc('month', v_date)::date,
      v_rl ->> 'concept_code', v_rl ->> 'concept_name', v_rl ->> 'condition',
      coalesce((v_rl ->> 'base')::numeric, 0), coalesce((v_rl ->> 'prior_base')::numeric, 0),
      coalesce((v_rl ->> 'accumulated_base')::numeric, 0), coalesce((v_rl ->> 'non_taxable_min')::numeric, 0),
      coalesce((v_rl ->> 'taxable_base')::numeric, 0), coalesce((v_rl ->> 'month_total')::numeric, 0),
      coalesce((v_rl ->> 'prior_withheld')::numeric, 0), (v_rl ->> 'rate')::numeric, v_rl ->> 'rate_source',
      coalesce((v_rl ->> 'exemption_pct')::numeric, 0),
      case when (v_rl ->> 'applies')::boolean then (v_rl ->> 'amount')::numeric else 0 end,
      v_rl ->> 'reason', (v_rl ->> 'certificate_number')::int, v_rl ->> 'certificate',
      (v_rl ->> 'sicore_tax_code')::int, v_rl ->> 'sicore_regime_code',
      coalesce(v_agentsnap, '{}'::jsonb) || jsonb_build_object('agent_number', v_rl ->> 'agent_number'),
      v_subjsnap);
  end loop;

  -- Medios.
  for v_line in
    select x.method, round(coalesce(x.amount, 0), 2) as amount,
           nullif(trim(coalesce(x.reference, '')), '') as reference,
           x.treasury_account_id, x.cash_shift_id, x.cheque_id, x.cheque
      from jsonb_to_recordset(p -> 'lines')
        as x(method text, amount numeric, reference text, treasury_account_id uuid, cash_shift_id uuid,
             cheque_id uuid, cheque jsonb)
  loop
    v_shift := null; v_cash := null; v_tmov := null; v_cheque := null; v_acc := null;

    if v_line.method = 'efectivo' then
      -- Retiro de la caja propia: el turno abierto de quien paga (ADR-051).
      v_shift := coalesce(v_line.cash_shift_id, (
        select cs.id from cash_shifts cs
         where cs.tenant_id = v_tenant and cs.status = 'open' and cs.opened_by = auth.uid()
         order by cs.opened_at desc limit 1));
      if v_shift is null then
        raise exception 'cash_shift_required';
      end if;
      perform assert_staff_operational();
      perform assert_shift_owner(v_shift, 'cash_out');
      perform require_supervisor('cash_out', v_line.amount, v_shift);
      insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reason, reference_id,
                                  created_by)
      values (v_tenant, v_shift, 'expense', v_line.amount, 'cash',
              'Orden de pago ' || v_label || ' · ' || v_sup.name, v_pay, auth.uid())
      returning id into v_cash;

    elsif v_line.method in ('transferencia', 'deposito') and v_line.treasury_account_id is not null then
      if not v_tes then
        raise exception 'feature_not_in_plan: tesoreria';
      end if;
      v_acc := treasury_account_get(v_tenant, v_line.treasury_account_id);
      v_tmov := _treasury_move(v_tenant, v_acc.id, v_date, -v_line.amount, 'supplier_payment',
                               'Orden de pago ' || v_label || ' · ' || v_sup.name, 'supplier_payment', v_pay);

    elsif v_line.method in ('cheque_propio', 'echeq') then
      if not v_tes then
        raise exception 'feature_not_in_plan: tesoreria';
      end if;
      v_acc := treasury_account_get(v_tenant, v_line.treasury_account_id);
      if v_acc.kind <> 'bank' then
        raise exception 'bank_account_required';
      end if;
      if v_line.cheque is null or nullif(trim(coalesce(v_line.cheque ->> 'number', '')), '') is null
         or nullif(v_line.cheque ->> 'payment_date', '') is null then
        raise exception 'cheque_data_required';
      end if;
      insert into cheques (tenant_id, kind, is_echeq, number, bank_name, issue_date, payment_date, amount, status,
                           account_id, delivered_to_supplier_id, payment_id, created_by)
      values (v_tenant, 'own', v_line.method = 'echeq', trim(v_line.cheque ->> 'number'),
              coalesce(nullif(trim(coalesce(v_line.cheque ->> 'bank_name', '')), ''), v_acc.bank_name),
              coalesce((nullif(v_line.cheque ->> 'issue_date', ''))::date, v_date),
              (v_line.cheque ->> 'payment_date')::date, v_line.amount, 'entregado', v_acc.id, v_sup.id, v_pay,
              auth.uid())
      returning id into v_cheque;

    elsif v_line.method = 'cheque_tercero' then
      if not v_tes then
        raise exception 'feature_not_in_plan: tesoreria';
      end if;
      select * into v_ch from cheques
       where id = v_line.cheque_id and tenant_id = v_tenant
       for update;
      if v_ch.id is null then
        raise exception 'cheque_not_found';
      end if;
      if v_ch.kind <> 'third_party' or v_ch.status <> 'en_cartera' then
        raise exception 'cheque_not_available';
      end if;
      if abs(v_ch.amount - v_line.amount) > 0.004 then
        raise exception 'cheque_amount_mismatch';
      end if;
      update cheques set status = 'entregado', delivered_to_supplier_id = v_sup.id, payment_id = v_pay
       where id = v_ch.id;
      v_cheque := v_ch.id;

    elsif v_line.method not in ('transferencia', 'deposito', 'tarjeta', 'otro') then
      raise exception 'invalid_payment_method';
    end if;

    v_sort := v_sort + 1;
    insert into supplier_payment_lines (tenant_id, payment_id, method, amount, reference, cash_shift_id,
                                        cash_movement_id, treasury_account_id, treasury_movement_id, cheque_id, sort)
    values (v_tenant, v_pay, v_line.method, v_line.amount, v_line.reference, v_shift, v_cash, v_acc.id, v_tmov,
            v_cheque, v_sort);
  end loop;

  -- Imputación.
  for v_al in
    select x.invoice_id, round(coalesce(x.amount, 0), 2) as amount
      from jsonb_to_recordset(coalesce(p -> 'allocations', '[]'::jsonb)) as x(invoice_id uuid, amount numeric)
  loop
    continue when v_al.amount = 0;
    if v_al.amount < 0 then
      raise exception 'invalid_amount';
    end if;
    select * into v_inv from supplier_invoices
     where id = v_al.invoice_id and tenant_id = v_tenant
     for update;
    if v_inv.id is null or v_inv.status <> 'posted' or v_inv.supplier_id <> v_sup.id
       or v_inv.kind not in ('invoice', 'debit_note') then
      raise exception 'invoice_not_allocatable';
    end if;
    select round(v_inv.total * v_inv.fx_rate, 2) - coalesce(sum(a.amount), 0) into v_open
      from supplier_payment_allocations a
     where a.invoice_id = v_inv.id and a.released_at is null;
    if v_al.amount > v_open + 0.005 then
      raise exception 'allocation_exceeds_open';
    end if;
    insert into supplier_payment_allocations (tenant_id, payment_id, invoice_id, amount)
    values (v_tenant, v_pay, v_inv.id, v_al.amount);
    v_alloc := v_alloc + v_al.amount;
  end loop;
  if v_alloc > v_net + v_whtot + 0.005 then
    raise exception 'allocation_exceeds_payment';
  end if;

  perform purchase_log(v_tenant, 'payment', v_pay, 'created', null, 'posted', p ->> 'notes',
                       jsonb_build_object('number', v_number, 'supplier_id', v_sup.id, 'kind', 'order',
                                          'amount', v_net + v_whtot, 'net_paid', v_net,
                                          'withholdings_total', v_whtot, 'allocated', v_alloc,
                                          'on_account', v_net + v_whtot - v_alloc, 'method', v_method,
                                          'agent_retentions', v_agent));
  if v_agent and jsonb_array_length(v_issued) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'tax_withholdings', v_pay, 'tax_withholdings_issued',
            jsonb_build_object('payment', v_label, 'supplier_id', v_sup.id, 'retentions', v_issued,
                               'total', (v_calc ->> 'total')::numeric));
  end if;
  return v_pay;
end;
$$;
revoke all on function supplier_payment_order_create(jsonb) from public, anon;
grant execute on function supplier_payment_order_create(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Anulación de la orden de pago → anula sus retenciones
-- -----------------------------------------------------------------------------
create or replace function trg_supplier_payments_void_withholdings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n   int;
  v_cer jsonb;
begin
  with u as (
    update tax_withholdings
       set status = 'voided', voided_at = now(), void_reason = new.void_reason
     where payment_id = new.id and status = 'issued'
    returning certificate, amount
  )
  select count(*) filter (where amount > 0),
         coalesce(jsonb_agg(certificate) filter (where certificate is not null), '[]'::jsonb)
    into v_n, v_cer
    from u;
  if v_n > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, auth.uid(), 'tax_withholdings', new.id, 'tax_withholdings_voided',
            jsonb_build_object('certificates', v_cer, 'reason', new.void_reason));
  end if;
  return new;
end;
$$;
revoke all on function trg_supplier_payments_void_withholdings() from public, anon, authenticated;

drop trigger if exists supplier_payments_void_withholdings on supplier_payments;
create trigger supplier_payments_void_withholdings after update of status on supplier_payments
  for each row when (new.status = 'voided' and old.status is distinct from 'voided')
  execute function trg_supplier_payments_void_withholdings();

-- -----------------------------------------------------------------------------
-- G) Registro del período y exportación
-- -----------------------------------------------------------------------------
create or replace function tax_withholdings_list(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_ret_assert();
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception 'invalid_period'; end if;
  if p_to - p_from > 400 then raise exception 'period_too_long'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(w) || jsonb_build_object('supplier_name', s.name) order by w.date desc, w.created_at desc)
      from tax_withholdings w
      join suppliers s on s.id = w.supplier_id
     where w.tenant_id = v_tenant and w.amount > 0 and w.date between p_from and p_to), '[]'::jsonb);
end;
$$;
revoke all on function tax_withholdings_list(date, date) from public, anon;
grant execute on function tax_withholdings_list(date, date) to authenticated;

-- p_format: 'sicore' (Ganancias, IVA y SUSS) o 'arba' (IIBB Buenos Aires).
-- Sólo retenciones vigentes del mes. Queda en audit_logs antes de responder.
create or replace function tax_withholdings_export(p_period date, p_format text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_ret_assert();
  v_month  date := date_trunc('month', p_period)::date;
  v_rows   jsonb;
begin
  if p_period is null then raise exception 'invalid_period'; end if;
  if p_format not in ('sicore', 'arba') then raise exception 'invalid_format'; end if;
  select coalesce(jsonb_agg(to_jsonb(w) order by w.date, w.payment_number, w.certificate_number), '[]'::jsonb)
    into v_rows
    from tax_withholdings w
   where w.tenant_id = v_tenant and w.period = v_month and w.status = 'issued' and w.amount > 0
     and ((p_format = 'sicore' and w.tax in ('ganancias', 'iva', 'suss'))
       or (p_format = 'arba' and w.tax = 'iibb' and w.jurisdiction = '902'));
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'tax_withholdings', v_tenant, 'tax_withholdings_exported',
          jsonb_build_object('period', v_month, 'format', p_format, 'rows', jsonb_array_length(v_rows),
                             'total', (select coalesce(sum((x ->> 'amount')::numeric), 0) from jsonb_array_elements(v_rows) x)));
  return jsonb_build_object('period', v_month, 'format', p_format, 'agent', _tax_ret_agent_snapshot(v_tenant),
                            'rows', v_rows);
end;
$$;
revoke all on function tax_withholdings_export(date, text) from public, anon;
grant execute on function tax_withholdings_export(date, text) to authenticated;

comment on function tax_retention_suggest(uuid, jsonb, numeric, date) is
  'ADR-068 (sugerencia simple sin acumulado). Reemplazada en la orden de pago por tax_retention_preview (ADR-079); se mantiene por compatibilidad.';
