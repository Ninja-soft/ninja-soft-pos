-- =============================================================================
-- FIS-001 · Fecha real de la venta offline como fecha del comprobante
-- =============================================================================
-- Una venta hecha sin conexión (ADR-077) se sincroniza después: sales.created_at
-- es el momento de la sincronización y sales.offline_sold_at el de la venta
-- real (20261103200000_venta_offline.sql). El worker de ARCA armaba la fecha
-- del comprobante con created_at, así la factura de una venta de ayer salía
-- con fecha de hoy.
--
--   A) arca_snapshot: copia EXACTA de la definición de producción (igual a la
--      de 20261114100000_servicios_profesionales.sql, sin drift) + la clave
--      'offline_sold_at' en el objeto 'sale'. Mismos grants, search_path y
--      SECURITY DEFINER. El worker usa offline_sold_at ?? created_at y
--      pickCbteDate la sigue acotando a la ventana de ARCA (hoy-5 bienes,
--      hoy-10 servicios) y al último autorizado.
--   B) arca_log_event(p_doc, p): evento informativo en fiscal_document_events
--      cuando la fecha del comprobante no es la de la venta ('fecha_ajustada',
--      outcome 'ok', error_code = motivo, error_msg = fecha original y usada).
--      Idempotente: un reintento no duplica el mismo evento. Sólo service_role.
--      Aditiva: si la Edge llega antes que la migración, el worker ignora el
--      error del evento y emite igual (nunca requires_action por la fecha).
--
-- libro_iva_data no cambia: ya filtra y ordena por fiscal_documents.cbte_fch
-- del comprobante aprobado, no por la fecha de la venta.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) arca_snapshot (definición de prod + offline_sold_at)
-- -----------------------------------------------------------------------------
create or replace function arca_snapshot(p_doc uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc   fiscal_documents%rowtype;
  v_sale  sales%rowtype;
  v_tax   jsonb;
  v_assoc fiscal_documents%rowtype;
begin
  select * into v_doc from fiscal_documents where id = p_doc;
  if not found then
    return null;
  end if;
  select * into v_sale from sales where id = v_doc.sale_id;
  v_tax := _tax_settings_eff(v_doc.tenant_id);
  if v_doc.assoc_document_id is not null then
    select * into v_assoc from fiscal_documents where id = v_doc.assoc_document_id;
  end if;
  return jsonb_build_object(
    'document', to_jsonb(v_doc) - 'request_xml' - 'response_xml' - 'events',
    'sale', jsonb_build_object(
      'id', v_sale.id, 'number', v_sale.number, 'created_at', v_sale.created_at, 'status', v_sale.status,
      'total', v_sale.total, 'net_taxed', v_sale.net_taxed, 'net_exempt', v_sale.net_exempt,
      'net_untaxed', v_sale.net_untaxed, 'iva_total', v_sale.iva_total,
      'internal_tax_total', v_sale.internal_tax_total, 'perception_total', v_sale.perception_total,
      'cbte_letter', v_sale.cbte_letter,
      -- ADR-116: período del servicio y vencimiento del pago.
      'service_from', v_sale.service_from, 'service_to', v_sale.service_to, 'payment_due', v_sale.payment_due,
      -- FIS-001: momento real de la venta offline (created_at es el de la sincronización).
      'offline_sold_at', v_sale.offline_sold_at,
      'receptor', coalesce(v_doc.receptor_override, v_sale.fiscal_snapshot -> 'receptor', '{}'::jsonb)),
    'tax_lines', coalesce((
      select jsonb_agg(jsonb_build_object('kind', l.kind, 'tax', l.tax, 'rate_code', l.rate_code, 'rate', l.rate,
                                          'base', l.base, 'amount', l.amount, 'arca_id', l.arca_id,
                                          'jurisdiction', l.jurisdiction, 'name', l.name) order by l.created_at, l.id)
        from sale_tax_lines l where l.sale_id = v_sale.id), '[]'::jsonb),
    'has_services', exists (select 1 from sale_items i join products p on p.id = i.product_id
                             where i.sale_id = v_sale.id and p.is_service),
    'has_goods', exists (select 1 from sale_items i left join products p on p.id = i.product_id
                          where i.sale_id = v_sale.id and coalesce(p.is_service, false) = false),
    'return_total', (select r.total from sale_returns r where r.id = v_doc.return_id),
    'credited_total', coalesce((
      select sum(o.imp_total) from fiscal_documents o
       where o.sale_id = v_doc.sale_id and o.origin = 'return' and o.id <> v_doc.id
         and o.status not in ('cancelado', 'rechazado')), 0),
    'assoc', case when v_doc.assoc_document_id is null then null else jsonb_build_object(
      'cbte_tipo', v_assoc.cbte_tipo, 'pto_vta', v_assoc.pto_vta, 'cbte_nro', v_assoc.cbte_nro,
      'cbte_fch', v_assoc.cbte_fch, 'imp_total', v_assoc.imp_total) end,
    'emitter', jsonb_build_object('cuit', v_tax ->> 'cuit', 'iva_condition', v_tax ->> 'iva_condition'),
    'last_fch', (select max(o.cbte_fch) from fiscal_documents o
                  where o.tenant_id = v_doc.tenant_id and o.environment = v_doc.environment
                    and o.pto_vta = v_doc.pto_vta and o.cbte_tipo = v_doc.cbte_tipo and o.status = 'aprobado'),
    'settings', (select jsonb_build_object('max_attempts', s.max_attempts, 'auth_mode', s.auth_mode,
                                            'caea_enabled', s.caea_enabled, 'caea_pto_vta', s.caea_pto_vta,
                                            'caea_timeout_seconds', s.caea_timeout_seconds)
                   from arca_settings s where s.tenant_id = v_doc.tenant_id));
end;
$$;
revoke all on function arca_snapshot(uuid) from public, anon, authenticated;
grant execute on function arca_snapshot(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- B) arca_log_event: evento informativo del worker (hoy sólo 'fecha_ajustada')
-- -----------------------------------------------------------------------------
create or replace function arca_log_event(p_doc uuid, p jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc    fiscal_documents%rowtype;
  v_action text := p ->> 'action';
  v_code   text := left(p ->> 'error_code', 64);
  v_msg    text := left(p ->> 'error_msg', 500);
begin
  if v_action is null or v_action not in ('fecha_ajustada') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  select * into v_doc from fiscal_documents where id = p_doc;
  if not found then
    return false;
  end if;
  -- Un reintento del mismo comprobante con la misma fecha no duplica el evento.
  if exists (select 1 from fiscal_document_events e
              where e.document_id = v_doc.id and e.action = v_action
                and e.error_code is not distinct from v_code
                and e.error_msg is not distinct from v_msg) then
    return false;
  end if;
  insert into fiscal_document_events (tenant_id, document_id, environment, action, outcome, attempt, error_code, error_msg)
  values (v_doc.tenant_id, v_doc.id, v_doc.environment, v_action, 'ok', v_doc.attempts, v_code, v_msg);
  return true;
end;
$$;
revoke all on function arca_log_event(uuid, jsonb) from public, anon, authenticated;
grant execute on function arca_log_event(uuid, jsonb) to service_role;
comment on function arca_log_event(uuid, jsonb) is
  'FIS-001: evento informativo del worker de ARCA (fecha_ajustada: la fecha del comprobante no es la de la venta). Idempotente. Sólo service_role.';
