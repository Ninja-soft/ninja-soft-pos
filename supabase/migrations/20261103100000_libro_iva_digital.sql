-- =============================================================================
-- 20261103100000_libro_iva_digital  (F18 · H108, ADR-076)
--
-- Libro IVA Digital (RG 4597 de ARCA): datos del período para armar los
-- archivos de importación del Portal IVA (VENTAS_CBTE, VENTAS_ALICUOTAS,
-- COMPRAS_CBTE, COMPRAS_ALICUOTAS). El ancho fijo, las validaciones y el zip
-- los arma el servidor de Next (app/api/libro-iva, lib/tax/libroIva.ts) con
-- lo que devuelven estas RPC.
--
--   · libro_iva_data(período): ventas = comprobantes de ARCA aprobados en
--     PRODUCCIÓN (CAE o CAEA) con fecha en el mes y su desglose
--     (sale_tax_lines, el mismo que se mandó a ARCA); comprobantes del mes
--     todavía sin CAE (pendiente, enviando, requiere acción, rechazado);
--     compras = comprobantes de proveedor vigentes con fecha en el mes y su
--     desglose (vat_lines, exento, no gravado, other_taxes) y el proveedor.
--   · libro_iva_log(período, resumen): auditoría de cada archivo generado.
--
-- Gating: feature `facturacion_afip` (el libro de ventas sale de la
-- facturación electrónica; ADR-076) con tenant_has_feature_for en el
-- servidor. Sólo dueño o encargado. Sin tablas nuevas: las RPC son SECURITY
-- DEFINER y filtran por current_tenant_id() (nunca leen otro negocio; el
-- staff interno no tiene camino acá, ADR-052).
-- =============================================================================

create or replace function libro_iva_assert()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'facturacion_afip') then
    raise exception 'feature_not_in_plan: facturacion_afip';
  end if;
  return v_tenant;
end;
$$;
revoke all on function libro_iva_assert() from public, anon;
grant execute on function libro_iva_assert() to authenticated;

create or replace function libro_iva_data(p_period date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := libro_iva_assert();
  v_from   date;
  v_to     date;
  v_tax    jsonb;
begin
  if p_period is null then
    raise exception 'period_invalid';
  end if;
  v_from := date_trunc('month', p_period)::date;
  v_to := (v_from + interval '1 month')::date;
  if v_from < date '2000-01-01' or v_from > (now() at time zone 'America/Argentina/Buenos_Aires')::date then
    raise exception 'period_invalid';
  end if;
  v_tax := _tax_settings_eff(v_tenant);

  return jsonb_build_object(
    'period', to_char(v_from, 'YYYY-MM'),
    'today', (now() at time zone 'America/Argentina/Buenos_Aires')::date,
    'emitter', jsonb_build_object(
      'cuit', v_tax ->> 'cuit',
      'iva_condition', v_tax ->> 'iva_condition',
      'name', (select coalesce(nullif(trim(b.legal_name), ''), t.name)
                 from tenants t left join tenant_branding b on b.tenant_id = t.id
                where t.id = v_tenant)),
    'environment', (select s.environment from arca_settings s where s.tenant_id = v_tenant),
    'ventas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'origin', d.origin, 'cbte_tipo', d.cbte_tipo, 'pto_vta', d.pto_vta,
               'cbte_nro', d.cbte_nro, 'cbte_fch', d.cbte_fch, 'concepto', d.concepto,
               'doc_tipo', d.doc_tipo, 'doc_nro', d.doc_nro, 'imp_total', d.imp_total,
               'emission_type', d.emission_type, 'inform_status', d.inform_status,
               'receptor_name', coalesce(d.receptor_override ->> 'name', s.fiscal_snapshot -> 'receptor' ->> 'name'),
               'sale', jsonb_build_object('number', s.number, 'total', s.total,
                                          'net_taxed', s.net_taxed, 'iva_total', s.iva_total),
               'tax_lines', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'kind', l.kind, 'tax', l.tax, 'rate_code', l.rate_code, 'rate', l.rate,
                          'base', l.base, 'amount', l.amount, 'arca_id', l.arca_id,
                          'jurisdiction', l.jurisdiction, 'name', l.name) order by l.created_at, l.id)
                   from sale_tax_lines l where l.sale_id = s.id), '[]'::jsonb))
             order by d.cbte_fch, d.cbte_tipo, d.pto_vta, d.cbte_nro)
        from fiscal_documents d
        join sales s on s.id = d.sale_id
       where d.tenant_id = v_tenant
         and d.environment = 'produccion'
         and d.status = 'aprobado'
         and d.cbte_fch >= v_from and d.cbte_fch < v_to), '[]'::jsonb),
    -- Comprobantes del mes que todavía no tienen CAE: bloquean la generación.
    'pending', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'origin', d.origin, 'cbte_tipo', d.cbte_tipo, 'pto_vta', d.pto_vta,
               'cbte_nro', d.cbte_nro, 'status', d.status, 'error_code', d.last_error_code,
               'sale_number', s.number,
               'date', coalesce(d.cbte_fch, (d.created_at at time zone 'America/Argentina/Buenos_Aires')::date))
             order by d.created_at)
        from fiscal_documents d
        join sales s on s.id = d.sale_id
       where d.tenant_id = v_tenant
         and d.environment = 'produccion'
         and d.status in ('pendiente', 'enviando', 'requiere_accion', 'rechazado')
         and coalesce(d.cbte_fch, (d.created_at at time zone 'America/Argentina/Buenos_Aires')::date) >= v_from
         and coalesce(d.cbte_fch, (d.created_at at time zone 'America/Argentina/Buenos_Aires')::date) < v_to), '[]'::jsonb),
    'homologacion_count', (
      select count(*) from fiscal_documents d
       where d.tenant_id = v_tenant and d.environment = 'homologacion' and d.status = 'aprobado'
         and d.cbte_fch >= v_from and d.cbte_fch < v_to),
    'compras', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'kind', i.kind, 'letter', i.letter, 'point_of_sale', i.point_of_sale,
               'number', i.number, 'issue_date', i.issue_date, 'currency', i.currency,
               'fx_rate', i.fx_rate, 'vat_lines', i.vat_lines, 'exempt_amount', i.exempt_amount,
               'non_taxed_amount', i.non_taxed_amount, 'other_taxes', i.other_taxes, 'total', i.total,
               'supplier', jsonb_build_object('id', sp.id, 'name', sp.name, 'cuit', sp.cuit,
                                              'iva_condition', sp.iva_condition,
                                              'foreign_tax_id', sp.foreign_tax_id))
             order by i.issue_date, sp.name, i.point_of_sale, i.number)
        from supplier_invoices i
        join suppliers sp on sp.id = i.supplier_id
       where i.tenant_id = v_tenant
         and i.status = 'posted'
         and i.issue_date >= v_from and i.issue_date < v_to), '[]'::jsonb));
end;
$$;
revoke all on function libro_iva_data(date) from public, anon;
grant execute on function libro_iva_data(date) to authenticated;
comment on function libro_iva_data(date) is
  'Libro IVA Digital (ADR-076): ventas aprobadas en producción, pendientes de CAE y compras del mes, del negocio activo. Dueño o encargado con facturacion_afip.';

-- Auditoría de cada generación (antes de entregar el archivo).
create or replace function libro_iva_log(p_period date, p_summary jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := libro_iva_assert();
  v_id     uuid;
begin
  if p_period is null then
    raise exception 'period_invalid';
  end if;
  if p_summary is null or jsonb_typeof(p_summary) <> 'object' or length(p_summary::text) > 20000 then
    raise exception 'summary_invalid';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'libro_iva_digital', null, 'libro_iva_generated',
          jsonb_build_object('period', to_char(date_trunc('month', p_period), 'YYYY-MM'), 'summary', p_summary))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'audit_id', v_id);
end;
$$;
revoke all on function libro_iva_log(date, jsonb) from public, anon;
grant execute on function libro_iva_log(date, jsonb) to authenticated;
