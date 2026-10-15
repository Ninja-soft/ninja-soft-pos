-- =============================================================================
-- ADR-145 sobre ADR-141: configuración de la facturación de Mercado Libre más
-- clara, mensaje al facturar, leyenda de la factura y sucursal/depósito por
-- tipo de envío
-- =============================================================================
-- 1) ml_billing_settings suma:
--      * invoice_message_enabled / invoice_message: mensaje al comprador por la
--        mensajería de ML cuando la factura queda subida (activo por defecto;
--        null = el texto de ejemplo de billingConfig.ts).
--      * invoice_notes_enabled / invoice_notes: leyenda impresa en la factura
--        (observaciones del comprobante; activa por defecto; null = ejemplo).
--      * logistic_stores: {default|me2|full|flex|me1|custom|a_convenir|none:
--        {store_id, warehouse_id}}: desde qué sucursal se factura (y con su
--        punto de venta) y de qué depósito sale el stock según el envío.
--    ml_fiscal_uploads suma message_sent_at / message_error (un solo mensaje
--    por factura, aunque se vuelva a subir).
-- 2) _ml_logistic_kind (espejo de logisticKind de invoicePlan.ts) y
--    _ml_logistic_store (espejo de resolveLogisticStore de billingConfig.ts).
-- 3) Se recrean desde 20261208100200_ml_facturacion: _ml_billing_settings,
--    ml_billing_settings_get, ml_billing_settings_save, _ml_invoice_emit (punto
--    de venta de la sucursal de la regla) y ml_invoice_pdf_data (leyenda y
--    mensaje). Nueva ml_invoice_message_sent (service_role).
-- 4) ml_ingest_pack se recrea desde 20261212100000_ml_facturacion_ingest (con
--    los bloques de Full y del plan de factura intactos) y suma la sucursal y
--    el depósito por tipo de envío. Una migración futura que la toque tiene
--    que partir de ESTA.
-- Gating: todo lo nuevo exige `mercadolibre_facturacion` en el servidor
-- (save, ingest, pdf_data). Sin la feature, la venta entra como antes.
-- =============================================================================

alter table ml_billing_settings add column if not exists invoice_message_enabled boolean not null default true;
alter table ml_billing_settings add column if not exists invoice_message text
  check (invoice_message is null or char_length(invoice_message) <= 1000);
alter table ml_billing_settings add column if not exists invoice_notes_enabled boolean not null default true;
alter table ml_billing_settings add column if not exists invoice_notes text
  check (invoice_notes is null or char_length(invoice_notes) <= 300);
alter table ml_billing_settings add column if not exists logistic_stores jsonb not null default '{}'::jsonb
  check (jsonb_typeof(logistic_stores) = 'object' and pg_column_size(logistic_stores) <= 4096);
comment on column ml_billing_settings.logistic_stores is
  'ADR-145: sucursal (factura y punto de venta) y depósito (stock) por tipo de envío de ML. Full: sólo la sucursal; el stock es el depósito virtual Full.';

alter table ml_fiscal_uploads add column if not exists message_sent_at timestamptz;
alter table ml_fiscal_uploads add column if not exists message_error text
  check (message_error is null or char_length(message_error) <= 500);

-- Tipo de envío de ML (igual que logisticKind en invoicePlan.ts).
create or replace function _ml_logistic_kind(p_mode text, p_logistic_type text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when nullif(p_mode, '') is null and nullif(p_logistic_type, '') is null then 'none'
    when p_logistic_type = 'fulfillment' then 'full'
    when p_logistic_type = 'self_service' then 'flex'
    when p_mode = 'me2' then 'me2'
    when p_mode = 'me1' then 'me1'
    when p_mode = 'custom' then 'custom'
    else 'a_convenir'
  end;
$$;
revoke all on function _ml_logistic_kind(text, text) from public, anon, authenticated;

-- Sucursal y depósito de la regla del tipo de envío (o la "por defecto"),
-- validados contra el negocio de la cuenta. null = sin regla (la de la cuenta).
create or replace function _ml_logistic_store(p_account uuid, p_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_rules  jsonb;
  v_r      jsonb;
  v_src    text := 'logistic';
  v_wh     uuid;
begin
  select a.tenant_id into v_tenant from ml_accounts a where a.id = p_account;
  if v_tenant is null then return null; end if;
  select s.logistic_stores into v_rules from ml_billing_settings s where s.account_id = p_account;
  if v_rules is null or v_rules = '{}'::jsonb then return null; end if;
  v_r := v_rules -> coalesce(p_kind, 'none');
  if jsonb_typeof(v_r) <> 'object' or nullif(v_r ->> 'store_id', '') is null then
    v_r := v_rules -> 'default';
    v_src := 'default';
  end if;
  if jsonb_typeof(v_r) <> 'object' or nullif(v_r ->> 'store_id', '') is null then return null; end if;
  if not exists (select 1 from stores s where s.id::text = v_r ->> 'store_id' and s.tenant_id = v_tenant
                                         and s.deleted_at is null and s.is_active) then
    return null;
  end if;
  if p_kind <> 'full' and nullif(v_r ->> 'warehouse_id', '') is not null then
    select w.id into v_wh from warehouses w
     where w.id::text = v_r ->> 'warehouse_id' and w.store_id::text = v_r ->> 'store_id'
       and w.tenant_id = v_tenant and w.deleted_at is null;
  end if;
  return jsonb_build_object('store_id', v_r ->> 'store_id', 'warehouse_id', v_wh, 'source', v_src, 'kind', p_kind);
end;
$$;
revoke all on function _ml_logistic_store(uuid, text) from public, anon, authenticated;

-- Fila de la cuenta (o los valores por defecto si no hay).
create or replace function _ml_billing_settings(p_account uuid)
returns ml_billing_settings
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v ml_billing_settings%rowtype;
begin
  select * into v from ml_billing_settings where account_id = p_account;
  if v.id is null then
    v.account_id := p_account;
    v.pdf_format := 'a4';
    v.upload_credit_notes := false;
    v.nc_on_refund := 'review';
    v.rules := '{}'::jsonb;
    v.perc_link_days := 3;
    v.perc_on_expire := 'invoice_b';
    v.invoice_message_enabled := true;
    v.invoice_notes_enabled := true;
    v.logistic_stores := '{}'::jsonb;
  end if;
  return v;
end;
$$;
revoke all on function _ml_billing_settings(uuid) from public, anon, authenticated;

create or replace function ml_billing_settings_get(p_account uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(false, true);
  v_acc    ml_accounts%rowtype;
  v_set    ml_billing_settings%rowtype;
  v_tax    jsonb;
begin
  select * into v_acc from ml_accounts where id = p_account and tenant_id = v_tenant and deleted_at is null;
  if v_acc.id is null then raise exception 'not_found'; end if;
  v_set := _ml_billing_settings(p_account);
  v_tax := _tax_settings_eff(v_tenant);
  return jsonb_build_object(
    'account_id', p_account,
    'invoice_mode', v_acc.invoice_mode,
    'upload_invoice', v_acc.upload_invoice,
    'pto_vta', v_set.pto_vta,
    'concepto', v_set.concepto,
    'pdf_format', v_set.pdf_format,
    'upload_credit_notes', v_set.upload_credit_notes,
    'nc_on_refund', v_set.nc_on_refund,
    'rules', v_set.rules,
    'perc_link_days', v_set.perc_link_days,
    'perc_on_expire', v_set.perc_on_expire,
    'perc_message', v_set.perc_message,
    'invoice_message_enabled', v_set.invoice_message_enabled,
    'invoice_message', v_set.invoice_message,
    'invoice_notes_enabled', v_set.invoice_notes_enabled,
    'invoice_notes', v_set.invoice_notes,
    'logistic_stores', coalesce(v_set.logistic_stores, '{}'::jsonb),
    'saved', v_set.id is not null,
    'features', jsonb_build_object(
      'billing', tenant_has_feature_for(v_tenant, 'mercadolibre_facturacion'),
      'perceptions', tenant_has_feature_for(v_tenant, 'percepciones_retenciones'),
      'arca', exists (select 1 from arca_settings s where s.tenant_id = v_tenant and s.enabled),
      'mercado_pago', tenant_has_feature_for(v_tenant, 'mercado_pago')),
    'emitter', jsonb_build_object('iva_condition', v_tax ->> 'iva_condition',
                                  'issues_m', coalesce((v_tax ->> 'issues_cbte_m')::boolean, false)),
    'store_pto_vta', (select s.afip_pos_number from ml_location_map m join stores s on s.id = m.store_id
                       where m.account_id = p_account and m.location_type = 'item_stock' limit 1),
    -- ADR-145: sucursal y depósito de la cuenta (lo que se usa sin regla) y
    -- las sucursales con sus depósitos y su punto de venta para elegir por
    -- tipo de envío.
    'account_store', (select jsonb_build_object('store_id', m.store_id, 'warehouse_id', m.warehouse_id)
                        from ml_location_map m where m.account_id = p_account and m.location_type = 'item_stock' limit 1),
    'stores', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', s.id, 'name', s.name, 'pto_vta', s.afip_pos_number, 'is_default', s.is_default,
                          'warehouses', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'kind', w.kind)
                                                                   order by w.sort, w.name)
                                                    from warehouses w
                                                   where w.store_id = s.id and w.tenant_id = v_tenant and w.deleted_at is null),
                                                 '[]'::jsonb))
                          order by s.is_default desc, s.name)
                          from stores s
                         where s.tenant_id = v_tenant and s.deleted_at is null and s.is_active), '[]'::jsonb));
end;
$$;
revoke all on function ml_billing_settings_get(uuid) from public, anon;
grant execute on function ml_billing_settings_get(uuid) to authenticated;

create or replace function ml_billing_settings_save(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_acc    ml_accounts%rowtype;
  v_old    ml_billing_settings%rowtype;
  v_new    ml_billing_settings%rowtype;
  v_pro    boolean;
  v_rules  jsonb;
  v_rule   jsonb;
  v_mode   text := nullif(p ->> 'invoice_mode', '');
  v_ls     jsonb;
  v_key    text;
  v_val    jsonb;
begin
  perform assert_account_active(v_tenant);
  select * into v_acc from ml_accounts where id = p_account and tenant_id = v_tenant and deleted_at is null for update;
  if v_acc.id is null then raise exception 'not_found'; end if;
  if v_mode is not null and v_mode not in ('on_paid', 'on_shipped', 'on_delivered', 'manual', 'none') then
    raise exception 'invalid_invoice_mode';
  end if;
  v_pro := (p - 'invoice_mode' - 'upload_invoice') <> '{}'::jsonb;
  if v_pro and not tenant_has_feature_for(v_tenant, 'mercadolibre_facturacion') then
    raise exception 'feature_not_in_plan: mercadolibre_facturacion' using errcode = '42501';
  end if;
  if v_mode = 'on_delivered' and not tenant_has_feature_for(v_tenant, 'mercadolibre_facturacion') then
    raise exception 'feature_not_in_plan: mercadolibre_facturacion' using errcode = '42501';
  end if;
  v_rules := case when jsonb_typeof(p -> 'rules') = 'object' then p -> 'rules' end;
  if v_rules is not null then
    if coalesce(v_rules ->> 'coupon_mode', 'discount_line') not in ('discount_line', 'prorate', 'none') then raise exception 'invalid_coupon_mode'; end if;
    if coalesce(v_rules ->> 'receptor_policy', 'auto') not in ('auto', 'always_cf') then raise exception 'invalid_receptor_policy'; end if;
    if coalesce(v_rules ->> 'perc_mode', 'acumulado') not in ('acumulado', 'destino') then raise exception 'invalid_perc_mode'; end if;
    if coalesce((v_rules ->> 'perc_enabled')::boolean, false)
       and not tenant_has_feature_for(v_tenant, 'percepciones_retenciones') then
      raise exception 'feature_not_in_plan: percepciones_retenciones' using errcode = '42501';
    end if;
    for v_rule in select value from jsonb_array_elements(case when jsonb_typeof(v_rules -> 'perc_rules') = 'array'
                                                              then v_rules -> 'perc_rules' else '[]'::jsonb end) loop
      if not exists (select 1 from tax_jurisdictions j where j.code = v_rule ->> 'jurisdiction') then
        raise exception 'invalid_jurisdiction';
      end if;
      if coalesce(v_rule ->> 'rate_source', 'padron') not in ('padron', 'fixed', 'zero') then raise exception 'invalid_rate_source'; end if;
      if coalesce((v_rule ->> 'rate')::numeric, 0) not between 0 and 30 then raise exception 'invalid_rate'; end if;
      if coalesce((v_rule ->> 'base_pct')::numeric, 100) not between 1 and 100 then raise exception 'invalid_base_pct'; end if;
      if coalesce((v_rule ->> 'min_base')::numeric, 0) < 0 or coalesce((v_rule ->> 'min_amount')::numeric, 0) < 0 then
        raise exception 'invalid_minimum';
      end if;
    end loop;
  end if;
  if nullif(p ->> 'pto_vta', '') is not null and (p ->> 'pto_vta')::int not between 1 and 99998 then raise exception 'invalid_pto_vta'; end if;
  -- ADR-145: plantillas del mensaje al facturar y de la leyenda de la factura.
  if char_length(coalesce(p ->> 'invoice_message', '')) > 1000 then raise exception 'invalid_invoice_message'; end if;
  if char_length(coalesce(p ->> 'invoice_notes', '')) > 300 then raise exception 'invalid_invoice_notes'; end if;
  -- ADR-145: sucursal y depósito por tipo de envío. Sólo claves conocidas,
  -- sucursales activas del negocio y depósitos de esa sucursal; Full nunca
  -- lleva depósito (su stock es el depósito virtual de ADR-142).
  if p ? 'logistic_stores' then
    if jsonb_typeof(p -> 'logistic_stores') <> 'object' then raise exception 'invalid_logistic_stores'; end if;
    v_ls := '{}'::jsonb;
    for v_key, v_val in select key, value from jsonb_each(p -> 'logistic_stores') loop
      if v_key not in ('default', 'me2', 'full', 'flex', 'me1', 'custom', 'a_convenir', 'none') then
        raise exception 'invalid_logistic_kind';
      end if;
      continue when jsonb_typeof(v_val) <> 'object' or nullif(v_val ->> 'store_id', '') is null;
      if not exists (select 1 from stores s where s.id::text = v_val ->> 'store_id' and s.tenant_id = v_tenant
                                             and s.deleted_at is null and s.is_active) then
        raise exception 'invalid_store';
      end if;
      if v_key <> 'full' and nullif(v_val ->> 'warehouse_id', '') is not null and not exists (
           select 1 from warehouses w where w.id::text = v_val ->> 'warehouse_id' and w.tenant_id = v_tenant
                                        and w.store_id::text = v_val ->> 'store_id' and w.deleted_at is null) then
        raise exception 'invalid_warehouse';
      end if;
      v_ls := v_ls || jsonb_build_object(v_key, jsonb_build_object(
        'store_id', v_val ->> 'store_id',
        'warehouse_id', case when v_key = 'full' then null else nullif(v_val ->> 'warehouse_id', '') end));
    end loop;
  end if;

  select * into v_old from ml_billing_settings where account_id = p_account for update;
  if v_pro then
    insert into ml_billing_settings (tenant_id, account_id, pto_vta, concepto, pdf_format, upload_credit_notes, nc_on_refund,
                                     rules, perc_link_days, perc_on_expire, perc_message,
                                     invoice_message_enabled, invoice_message, invoice_notes_enabled, invoice_notes,
                                     logistic_stores, updated_by)
    values (v_tenant, p_account,
            nullif(p ->> 'pto_vta', '')::int, nullif(p ->> 'concepto', '')::int,
            coalesce(nullif(p ->> 'pdf_format', ''), 'a4'),
            coalesce((p ->> 'upload_credit_notes')::boolean, false),
            coalesce(nullif(p ->> 'nc_on_refund', ''), 'review'),
            coalesce(v_rules, '{}'::jsonb),
            coalesce((p ->> 'perc_link_days')::int, 3),
            coalesce(nullif(p ->> 'perc_on_expire', ''), 'invoice_b'),
            nullif(btrim(coalesce(p ->> 'perc_message', '')), ''),
            coalesce((p ->> 'invoice_message_enabled')::boolean, true),
            nullif(btrim(coalesce(p ->> 'invoice_message', '')), ''),
            coalesce((p ->> 'invoice_notes_enabled')::boolean, true),
            nullif(btrim(coalesce(p ->> 'invoice_notes', '')), ''),
            coalesce(v_ls, '{}'::jsonb),
            auth.uid())
    on conflict (account_id) do update
      set pto_vta = case when p ? 'pto_vta' then nullif(p ->> 'pto_vta', '')::int else ml_billing_settings.pto_vta end,
          concepto = case when p ? 'concepto' then nullif(p ->> 'concepto', '')::int else ml_billing_settings.concepto end,
          pdf_format = coalesce(nullif(p ->> 'pdf_format', ''), ml_billing_settings.pdf_format),
          upload_credit_notes = coalesce((p ->> 'upload_credit_notes')::boolean, ml_billing_settings.upload_credit_notes),
          nc_on_refund = coalesce(nullif(p ->> 'nc_on_refund', ''), ml_billing_settings.nc_on_refund),
          rules = coalesce(v_rules, ml_billing_settings.rules),
          perc_link_days = coalesce((p ->> 'perc_link_days')::int, ml_billing_settings.perc_link_days),
          perc_on_expire = coalesce(nullif(p ->> 'perc_on_expire', ''), ml_billing_settings.perc_on_expire),
          perc_message = case when p ? 'perc_message' then nullif(btrim(coalesce(p ->> 'perc_message', '')), '')
                              else ml_billing_settings.perc_message end,
          invoice_message_enabled = coalesce((p ->> 'invoice_message_enabled')::boolean, ml_billing_settings.invoice_message_enabled),
          invoice_message = case when p ? 'invoice_message' then nullif(btrim(coalesce(p ->> 'invoice_message', '')), '')
                                 else ml_billing_settings.invoice_message end,
          invoice_notes_enabled = coalesce((p ->> 'invoice_notes_enabled')::boolean, ml_billing_settings.invoice_notes_enabled),
          invoice_notes = case when p ? 'invoice_notes' then nullif(btrim(coalesce(p ->> 'invoice_notes', '')), '')
                               else ml_billing_settings.invoice_notes end,
          logistic_stores = coalesce(v_ls, ml_billing_settings.logistic_stores),
          updated_by = auth.uid()
    returning * into v_new;
  end if;
  update ml_accounts
     set invoice_mode = coalesce(v_mode, invoice_mode),
         upload_invoice = coalesce((p ->> 'upload_invoice')::boolean, upload_invoice)
   where id = p_account
  returning * into v_acc;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'ml_accounts', p_account, 'ml_billing_settings_saved',
          to_jsonb(v_old) - 'updated_at' - 'created_at',
          coalesce(to_jsonb(v_new) - 'updated_at' - 'created_at', '{}'::jsonb)
            || jsonb_build_object('invoice_mode', v_acc.invoice_mode, 'upload_invoice', v_acc.upload_invoice));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_billing_settings_save(uuid, jsonb) from public, anon;
grant execute on function ml_billing_settings_save(uuid, jsonb) to authenticated;

create or replace function _ml_invoice_emit(p_plan uuid, p_user uuid, p_manual boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p       ml_invoice_plans%rowtype;
  v_sale    sales%rowtype;
  v_set     ml_billing_settings%rowtype;
  v_tax     jsonb;
  v_rec     jsonb;
  v_recj    jsonb;
  v_cond    text;
  v_letter  text;
  v_chk     text;
  v_has     boolean;
  v_m       boolean;
  v_pv      integer;
  v_doc     uuid;
  v_block   text;
  v_charge  ml_perception_charges%rowtype;
  v_perc    numeric := 0;
  v_l       jsonb;
  v_err     text;
  v_rule    jsonb;
begin
  select * into v_p from ml_invoice_plans where id = p_plan for update;
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not tenant_has_feature_for(v_p.tenant_id, 'mercadolibre_facturacion') then
    return jsonb_build_object('ok', false, 'error', 'feature_not_in_plan');
  end if;
  if v_p.status in ('queued', 'approved') or v_p.fiscal_document_id is not null then
    return jsonb_build_object('ok', false, 'error', 'already_invoiced');
  end if;
  if v_p.status in ('skipped', 'cancelled') then return jsonb_build_object('ok', false, 'error', 'plan_' || v_p.status); end if;
  if v_p.status = 'blocked' and not p_manual then return jsonb_build_object('ok', false, 'error', 'blocked_jurisdiction'); end if;
  if v_p.status = 'needs_review' and not p_manual then return jsonb_build_object('ok', false, 'error', 'needs_review'); end if;
  if exists (select 1 from ml_orders o where o.account_id = v_p.account_id and o.pack_key = v_p.pack_key and o.fraud_risk) then
    return jsonb_build_object('ok', false, 'error', 'fraud_risk');
  end if;
  select * into v_sale from sales where id = v_p.sale_id for update;
  if v_sale.id is null or v_sale.status <> 'completed' then return jsonb_build_object('ok', false, 'error', 'no_sale'); end if;
  if not exists (select 1 from arca_settings s where s.tenant_id = v_p.tenant_id and s.enabled) then
    return jsonb_build_object('ok', false, 'error', 'arca_not_enabled');
  end if;

  v_set := _ml_billing_settings(v_p.account_id);
  v_tax := _tax_settings_eff(v_p.tenant_id);
  v_m := coalesce((v_tax ->> 'issues_cbte_m')::boolean, false);
  v_rec := v_p.plan -> 'receptors' -> v_p.choice;
  if jsonb_typeof(v_rec) <> 'object' then return jsonb_build_object('ok', false, 'error', 'invalid_plan'); end if;
  v_cond := coalesce(nullif(v_rec ->> 'iva_condition', ''), 'consumidor_final');
  v_has := v_rec ->> 'doc_type' = 'cuit' and length(coalesce(v_rec ->> 'doc_number', '')) = 11
           and cuit_is_valid(v_rec ->> 'doc_number');
  if coalesce((v_rec ->> 'needs_id')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'cf_identification_required');
  end if;

  -- Letra: la elegida o la sugerida, siempre dentro de la matriz de ARCA (ADR-133).
  v_letter := coalesce(v_p.letter, cbte_letter_infer(v_tax ->> 'iva_condition', v_cond, v_m));
  v_chk := cbte_letter_check(v_tax ->> 'iva_condition', v_cond, v_has, v_m, v_letter);
  if v_chk is not null then
    update ml_invoice_plans set last_error = 'letter_' || v_chk where id = v_p.id;
    return jsonb_build_object('ok', false, 'error', 'letter_' || v_chk);
  end if;

  -- Percepción: la factura A sale con lo cobrado por el link (o a mano).
  if v_p.choice = 'billing' and coalesce((v_p.plan -> 'perception' ->> 'applies')::boolean, false)
     and v_p.perception_mode = 'charge' then
    select * into v_charge from ml_perception_charges c
     where c.plan_id = v_p.id and c.status in ('paid', 'paid_manual') order by c.paid_at desc nulls last limit 1;
    if v_charge.id is null then
      return jsonb_build_object('ok', false, 'error', 'perception_pending');
    end if;
    if not exists (select 1 from sale_tax_lines t where t.sale_id = v_sale.id and t.kind = 'perception') then
      for v_l in select value from jsonb_array_elements(coalesce(v_p.plan -> 'perception' -> 'lines', '[]'::jsonb)) loop
        insert into sale_tax_lines (tenant_id, sale_id, kind, tax, jurisdiction, rate, base, amount, arca_id, source, name)
        values (v_sale.tenant_id, v_sale.id, 'perception', 'iibb', v_l ->> 'jurisdiction',
                (v_l ->> 'effective_rate')::numeric, (v_l ->> 'base')::numeric, (v_l ->> 'amount')::numeric, 7,
                case when v_l ->> 'source' = 'padron' then 'padron' else 'default' end,
                left('Percepción IIBB ' || coalesce((select j.name from tax_jurisdictions j where j.code = v_l ->> 'jurisdiction'),
                                                     v_l ->> 'jurisdiction'), 80));
        v_perc := v_perc + (v_l ->> 'amount')::numeric;
      end loop;
      -- Lo cobrado de más o de menos queda a la vista (tolerancia $ 1).
      if abs(v_perc - v_charge.amount) > 1 then
        raise exception 'perception_mismatch';
      end if;
      update sales
         set perception_total = coalesce(perception_total, 0) + v_perc,
             tax_total = coalesce(tax_total, 0) + v_perc,
             total = total + v_perc
       where id = v_sale.id
      returning * into v_sale;
      insert into payments (tenant_id, sale_id, method, amount, reference, card_voucher)
      values (v_sale.tenant_id, v_sale.id,
              case when v_charge.provider = 'manual' then 'transfer' else 'mercadolibre' end, v_perc,
              left('Percepción IIBB ' || coalesce(v_charge.payment_ref, v_charge.id::text), 120), '{}'::jsonb);
      if to_regproc('acc_sync_safe') is not null then
        perform acc_sync_safe(v_sale.tenant_id, 'sale', v_sale.id, true);
      end if;
    end if;
  end if;

  v_recj := _ml_receptor_json(v_rec, v_sale.customer_id);
  update sales
     set cbte_letter = v_letter,
         fiscal_snapshot = coalesce(fiscal_snapshot, '{}'::jsonb) || jsonb_build_object('receptor', v_recj)
   where id = v_sale.id;

  v_doc := arca_enqueue_sale(v_sale.id, p_manual);
  if v_doc is null then
    v_err := case when exists (select 1 from fiscal_documents d where d.sale_id = v_sale.id and d.origin = 'sale'
                                                                   and d.status <> 'cancelado')
                  then 'already_invoiced' else 'not_enqueued' end;
    update ml_invoice_plans set last_error = v_err where id = v_p.id;
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;

  -- ADR-145: si el tipo de envío (o la regla por defecto) eligió una
  -- sucursal, la factura sale con el punto de venta de esa sucursal (la venta
  -- ya nació en ella). Lo elegido en la venta manda sobre todo.
  v_rule := _ml_logistic_store(v_p.account_id, coalesce(nullif(v_p.plan ->> 'logistic', ''), 'none'));
  v_pv := coalesce(v_p.pto_vta,
                   case when v_rule is not null and (v_rule ->> 'store_id')::uuid = v_sale.store_id
                        then arca_pos_for(v_sale.store_id, null) end,
                   v_set.pto_vta, arca_pos_for(v_sale.store_id, null));
  v_block := _arca_blocker(v_letter, v_pv, v_recj || jsonb_build_object('requires_identification', false), 'sale');
  update fiscal_documents
     set pto_vta = v_pv,
         concepto = coalesce(v_p.concepto, v_set.concepto, concepto),
         receptor_override = v_recj,
         status = case when v_block is null then 'pendiente' else 'requiere_accion' end,
         last_error_code = v_block,
         last_error_msg = _arca_blocker_msg(v_block)
   where id = v_doc and cbte_nro is null;

  update ml_invoice_plans
     set status = 'queued', fiscal_document_id = v_doc, emitted_at = now(), last_error = null
   where id = v_p.id;
  update ml_orders set invoice_status = 'queued', fiscal_document_id = v_doc
   where account_id = v_p.account_id and pack_key = v_p.pack_key;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_p.tenant_id, p_user, 'fiscal_documents', v_doc, 'ml_invoice_emitted',
          jsonb_build_object('pack_key', v_p.pack_key, 'sale_id', v_sale.id, 'letter', v_letter, 'receptor', v_p.choice,
                             'forced_letter', v_p.letter is not null, 'pto_vta', v_pv, 'perception', v_perc,
                             'store_rule', v_rule ->> 'source',
                             'manual', p_manual, 'blocked', v_block));
  return jsonb_build_object('ok', true, 'document_id', v_doc, 'letter', v_letter, 'blocked', v_block);
exception when others then
  if sqlerrm = 'perception_mismatch' then
    return jsonb_build_object('ok', false, 'error', 'perception_mismatch');
  end if;
  raise;
end;
$$;
revoke all on function _ml_invoice_emit(uuid, uuid, boolean) from public, anon, authenticated;

create or replace function ml_invoice_pdf_data(p_doc uuid)
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
  v_b     tenant_branding%rowtype;
  v_rec   jsonb;
  v_plan  ml_invoice_plans%rowtype;
  v_set   ml_billing_settings%rowtype;
  v_assoc fiscal_documents%rowtype;
  v_nc    boolean;
  v_ratio numeric := 1;
  v_up    ml_fiscal_uploads%rowtype;
  v_acc   ml_accounts%rowtype;
  v_pro   boolean := false;
  v_buyer record;
  v_pack  text;
begin
  select * into v_doc from fiscal_documents where id = p_doc;
  if v_doc.id is null or v_doc.status <> 'aprobado' then return null; end if;
  select * into v_sale from sales where id = v_doc.sale_id;
  select * into v_b from tenant_branding where tenant_id = v_doc.tenant_id;
  v_tax := _tax_settings_eff(v_doc.tenant_id);
  v_rec := coalesce(v_doc.receptor_override, v_sale.fiscal_snapshot -> 'receptor', '{}'::jsonb);
  select pl.* into v_plan from ml_invoice_plans pl
   where pl.sale_id = v_doc.sale_id order by pl.created_at desc limit 1;
  if v_plan.id is not null then v_set := _ml_billing_settings(v_plan.account_id); end if;
  v_nc := v_doc.cbte_tipo in (3, 8, 13, 53);
  if v_doc.assoc_document_id is not null then
    select * into v_assoc from fiscal_documents where id = v_doc.assoc_document_id;
  end if;
  if v_nc and coalesce(v_sale.total, 0) > 0 then v_ratio := least(v_doc.imp_total / v_sale.total, 1); end if;
  -- ADR-145: leyenda y mensaje al comprador (facturación pro).
  if v_plan.id is not null then
    v_pro := tenant_has_feature_for(v_doc.tenant_id, 'mercadolibre_facturacion');
    select * into v_acc from ml_accounts where id = v_plan.account_id;
    select * into v_up from ml_fiscal_uploads where fiscal_document_id = v_doc.id;
    select o.buyer_id, o.buyer_nickname into v_buyer from ml_orders o
     where o.account_id = v_plan.account_id and o.pack_key = v_plan.pack_key order by o.ml_order_id limit 1;
    v_pack := v_plan.pack_key;
  end if;
  return jsonb_build_object(
    'emitter', jsonb_build_object(
      'name', coalesce(nullif(v_b.legal_name, ''), (select t.name from tenants t where t.id = v_doc.tenant_id)),
      'cuit', v_tax ->> 'cuit', 'ivaCondition', v_tax ->> 'iva_condition', 'address', v_b.address,
      'iibb', v_tax ->> 'iibb_number', 'activityStart', v_tax ->> 'activity_start'),
    'doc', jsonb_build_object(
      'letter', v_doc.cbte_letter, 'cbteTipo', v_doc.cbte_tipo, 'ptoVta', v_doc.pto_vta, 'nro', v_doc.cbte_nro,
      'label', case when v_nc then 'NOTA DE CRÉDITO' else 'FACTURA' end,
      'fecha', v_doc.cbte_fch, 'cae', v_doc.cae, 'caeVto', v_doc.cae_vto, 'qrUrl', v_doc.qr_url,
      'total', v_doc.imp_total, 'netTaxed', round(coalesce(v_sale.net_taxed, 0) * v_ratio, 2),
      'iva', round(coalesce(v_sale.iva_total, 0) * v_ratio, 2),
      'otherTaxes', round((coalesce(v_sale.internal_tax_total, 0) + coalesce(v_sale.perception_total, 0)) * v_ratio, 2)),
    'receptor', jsonb_build_object(
      'name', coalesce(v_rec ->> 'name', 'Consumidor Final'), 'docType', v_rec ->> 'doc_type',
      'docNumber', nullif(v_rec ->> 'doc_number', '0'), 'ivaCondition', v_rec ->> 'iva_condition',
      'address', v_rec ->> 'address'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('description', i.product_name, 'qty', i.quantity,
                                                           'unitPrice', i.unit_price, 'subtotal', i.subtotal)
                                        order by i.created_at, i.id)
                         from sale_items i where i.sale_id = v_sale.id), '[]'::jsonb),
    'discount', case when v_nc then 0 else coalesce(v_sale.discount_total, 0) end,
    'perceptions', coalesce((select jsonb_agg(jsonb_build_object('name', coalesce(j.name, l.jurisdiction), 'amount', l.amount))
                               from sale_tax_lines l left join tax_jurisdictions j on j.code = l.jurisdiction
                              where l.sale_id = v_sale.id and l.kind = 'perception'), '[]'::jsonb),
    'format', coalesce(v_plan.pdf_format, v_set.pdf_format, 'a4'),
    'assoc', case when v_assoc.id is null then null
                  else 'Factura ' || v_assoc.cbte_letter || ' ' || lpad(v_assoc.pto_vta::text, 5, '0') || '-'
                       || lpad(v_assoc.cbte_nro::text, 8, '0') end,
    'notes', 'Venta en Mercado Libre ' || coalesce(v_sale.channel_ref, ''),
    -- ADR-145: la leyenda la arma el worker con la plantilla (null = la de
    -- ejemplo); apagada, la factura sale sin leyenda.
    'notes_config', case when v_pro then jsonb_build_object(
        'enabled', coalesce(v_set.invoice_notes_enabled, true),
        'template', v_set.invoice_notes,
        'vars', jsonb_build_object(
          'venta', coalesce(v_pack, v_sale.channel_ref, ''),
          'comprador', coalesce(nullif(split_part(coalesce(v_rec ->> 'name', ''), ' ', 1), ''), ''),
          'envio', coalesce(v_plan.plan ->> 'logistic', ''),
          'fecha', to_char(coalesce(v_sale.created_at, now()) at time zone 'America/Argentina/Buenos_Aires', 'DD/MM/YYYY')))
      end,
    -- ADR-145: mensaje al comprador después de subir la factura (una sola
    -- vez por comprobante; nunca para notas de crédito).
    'buyer_message', case when v_pro and not v_nc and v_up.id is not null and v_up.kind = 'factura'
                               and v_up.message_sent_at is null
                               and coalesce(v_set.invoice_message_enabled, true)
                               and v_acc.id is not null and v_acc.status = 'active'
                          then jsonb_build_object(
        'template', v_set.invoice_message,
        'seller_id', v_acc.ml_user_id,
        'buyer_id', v_buyer.buyer_id,
        'vars', jsonb_build_object(
          'comprador', coalesce(nullif(split_part(coalesce(v_plan.plan -> 'receptors' -> 'billing' ->> 'name', ''), ' ', 1), ''),
                                v_buyer.buyer_nickname, ''),
          'factura', v_doc.cbte_letter || ' ' || lpad(v_doc.pto_vta::text, 5, '0') || '-' || lpad(v_doc.cbte_nro::text, 8, '0'),
          'total', v_doc.imp_total,
          'venta', coalesce(v_pack, ''),
          'fecha', v_doc.cbte_fch))
      end);
end;
$$;
revoke all on function ml_invoice_pdf_data(uuid) from public, anon, authenticated;
grant execute on function ml_invoice_pdf_data(uuid) to service_role;

-- El worker avisa si el mensaje al comprador salió (una sola vez por factura).
create or replace function ml_invoice_message_sent(p_doc uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_up ml_fiscal_uploads%rowtype;
begin
  update ml_fiscal_uploads
     set message_sent_at = case when p_ok then now() else message_sent_at end,
         message_error = case when p_ok then null else left(coalesce(p_error, 'error'), 500) end
   where fiscal_document_id = p_doc and message_sent_at is null
  returning * into v_up;
  if v_up.id is not null then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_up.tenant_id, null, 'fiscal_documents', p_doc,
            case when p_ok then 'ml_invoice_message_sent' else 'ml_invoice_message_failed' end,
            jsonb_build_object('pack_key', v_up.pack_key, 'error', left(p_error, 300)));
  end if;
end;
$$;
revoke all on function ml_invoice_message_sent(uuid, boolean, text) from public, anon, authenticated;
grant execute on function ml_invoice_message_sent(uuid, boolean, text) to service_role;

-- ml_ingest_pack: la de 20261212100000 (Full + plan de factura) + sucursal y
-- depósito por tipo de envío (ADR-145).
create or replace function ml_ingest_pack(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc        ml_accounts%rowtype;
  v_tenant     uuid;
  v_pack       text := nullif(btrim(coalesce(p ->> 'pack_key', '')), '');
  v_o          jsonb;
  v_l          jsonb;
  v_all_paid   boolean;
  v_all_cancel boolean;
  v_any_cancel boolean;
  v_fraud      boolean;
  v_sale       uuid;
  v_sale_row   sales%rowtype;
  v_map        ml_location_map%rowtype;
  v_store      uuid;
  v_bill       jsonb := case when jsonb_typeof(p -> 'billing') = 'object' then p -> 'billing' end;
  v_doc        text;
  v_customer   uuid;
  v_lines      jsonb := '[]'::jsonb;
  v_lp         uuid;
  v_lv         uuid;
  v_tax_in     jsonb := '[]'::jsonb;
  v_tax        jsonb;
  v_tl         jsonb;
  v_total      numeric := 0;
  v_gross      numeric;
  v_number     bigint;
  v_i          int := 0;
  v_pname      text;
  v_psku       text;
  v_track      boolean;
  v_taken      numeric;
  v_fiscal     uuid;
  v_decision   text;
  v_ord        record;
  v_reverted   int := 0;
  v_unlinked   int;
  -- ADR-141
  v_plan       jsonb := case when jsonb_typeof(p -> 'invoice') = 'object'
                              and tenant_has_feature_for((select a.tenant_id from ml_accounts a where a.id = p_account),
                                                         'mercadolibre_facturacion')
                             then p -> 'invoice' end;
  v_items      jsonb := '[]'::jsonb;
  v_used       boolean[] := '{}';
  v_k          int;
  v_ship       numeric := 0;
  v_ship_label text;
  v_discount   numeric := 0;
  v_subtotal   numeric := 0;
  v_prow       ml_invoice_plans%rowtype;
  v_auto       jsonb;
  -- ADR-142: ventas por Full (las despacha ML desde su centro).
  v_full_pack  boolean := coalesce(p -> 'shipment' ->> 'logistic_type', '') = 'fulfillment';
  v_has_ship   boolean := jsonb_typeof(p -> 'shipment') = 'object';
  v_line_full  boolean;
  v_full_inv   text;
  v_full_lines int := 0;
  v_full_feat  boolean;
  -- ADR-145: sucursal y depósito por tipo de envío.
  v_kind       text;
  v_rule       jsonb;
begin
  if v_pack is null or jsonb_typeof(p -> 'orders') <> 'array' or jsonb_array_length(p -> 'orders') = 0 then
    raise exception 'invalid_payload';
  end if;
  select * into v_acc from ml_accounts where id = p_account;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  v_tenant := v_acc.tenant_id;
  if not tenant_has_feature_for(v_tenant, 'mercadolibre') then
    return jsonb_build_object('ok', false, 'error', 'feature_not_in_plan');
  end if;
  -- Dos notificaciones del mismo carrito no crean dos ventas.
  perform pg_advisory_xact_lock(hashtext('ml_pack:' || p_account::text || ':' || v_pack));

  -- 1) Espejo de cada orden (no pisa con un estado más viejo).
  for v_o in select value from jsonb_array_elements(p -> 'orders') loop
    insert into ml_orders (tenant_id, account_id, ml_order_id, pack_key, pack_id, status, status_detail, tags,
                           date_created, date_closed, ml_last_updated, total_amount, paid_amount, currency,
                           sale_fee_total, buyer_id, buyer_nickname, shipment_id, fraud_risk, cancel_detail, lines,
                           payments, coupon_amount, shipping_paid)
    values (v_tenant, p_account, (v_o ->> 'ml_order_id')::bigint, v_pack, nullif(p ->> 'pack_id', '')::bigint,
            left(coalesce(v_o ->> 'status', 'unknown'), 40), left(v_o ->> 'status_detail', 200),
            coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v_o -> 'tags', '[]'::jsonb)) x), '{}'),
            nullif(v_o ->> 'date_created', '')::timestamptz, nullif(v_o ->> 'date_closed', '')::timestamptz,
            nullif(v_o ->> 'last_updated', '')::timestamptz,
            coalesce((v_o ->> 'total_amount')::numeric, 0), coalesce((v_o ->> 'paid_amount')::numeric, 0),
            coalesce(nullif(v_o ->> 'currency', ''), 'ARS'), coalesce((v_o ->> 'sale_fee_total')::numeric, 0),
            nullif(v_o -> 'buyer' ->> 'id', '')::bigint, left(v_o -> 'buyer' ->> 'nickname', 120),
            nullif(v_o ->> 'shipment_id', '')::bigint, coalesce((v_o ->> 'fraud_risk')::boolean, false),
            case when jsonb_typeof(v_o -> 'cancel_detail') = 'object' then v_o -> 'cancel_detail' end,
            coalesce(v_o -> 'lines', '[]'::jsonb),
            case when jsonb_typeof(v_o -> 'payments') = 'array' then v_o -> 'payments' else '[]'::jsonb end,
            coalesce((v_o ->> 'coupon_amount')::numeric, 0), coalesce((v_o ->> 'shipping_paid')::numeric, 0))
    on conflict (account_id, ml_order_id) do update
      set status = excluded.status, status_detail = excluded.status_detail, tags = excluded.tags,
          date_closed = excluded.date_closed, ml_last_updated = excluded.ml_last_updated,
          total_amount = excluded.total_amount, paid_amount = excluded.paid_amount,
          sale_fee_total = excluded.sale_fee_total, shipment_id = coalesce(excluded.shipment_id, ml_orders.shipment_id),
          fraud_risk = excluded.fraud_risk, cancel_detail = excluded.cancel_detail,
          pack_key = excluded.pack_key, pack_id = excluded.pack_id,
          payments = excluded.payments, coupon_amount = excluded.coupon_amount, shipping_paid = excluded.shipping_paid,
          -- Las líneas resueltas (producto, stock aplicado) no se pisan después de la venta.
          lines = case when ml_orders.sale_id is null then excluded.lines else ml_orders.lines end
      where ml_orders.ml_last_updated is null or excluded.ml_last_updated is null
         or excluded.ml_last_updated >= ml_orders.ml_last_updated;
  end loop;

  -- Costo de envío (si vino el envío normalizado).
  if jsonb_typeof(p -> 'shipment') = 'object' and nullif(p -> 'shipment' ->> 'cost', '') is not null then
    update ml_orders set shipping_cost = (p -> 'shipment' ->> 'cost')::numeric
     where account_id = p_account and pack_key = v_pack;
  end if;

  -- 2) Estado del carrito completo.
  select bool_and(o.status = 'paid'), bool_and(o.status in ('cancelled', 'invalid')),
         bool_or(o.status in ('cancelled', 'invalid')), bool_or(o.fraud_risk), max(o.sale_id::text)::uuid
    into v_all_paid, v_all_cancel, v_any_cancel, v_fraud, v_sale
    from ml_orders o
   where o.account_id = p_account and o.pack_key = v_pack;

  -- 2.a) Fraude sin venta: no se crea (ML la cancela; no despachar).
  if v_fraud and v_sale is null then
    update ml_orders set needs_review = 'Mercado Libre detectó riesgo de fraude: no despachar.'
     where account_id = p_account and pack_key = v_pack;
    return jsonb_build_object('ok', true, 'decision', 'fraud');
  end if;
  if v_fraud then
    update ml_orders set needs_review = 'Mercado Libre detectó riesgo de fraude después del pago: no despachar; se anula si ML la cancela.'
     where account_id = p_account and pack_key = v_pack and needs_review is null;
  end if;

  -- 2.b) Cancelaciones: revierte el stock de cada orden cancelada.
  if v_any_cancel then
    for v_ord in
      select o.id from ml_orders o
       where o.account_id = p_account and o.pack_key = v_pack and o.status in ('cancelled', 'invalid')
    loop
      if _ml_order_revert(v_ord.id) then v_reverted := v_reverted + 1; end if;
    end loop;
    if v_all_cancel then
      if v_sale is not null then
        -- Anular la venta: si estaba facturada, ARCA emite la nota de crédito
        -- por el total (arca_on_void); si no, el comprobante se cancela.
        update sales
           set status = 'voided', voided_at = now(), void_reason = 'Cancelada en Mercado Libre'
         where id = v_sale and tenant_id = v_tenant and status = 'completed';
        if found then
          insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
          values (v_tenant, null, 'sales', v_sale, 'ml_sale_cancelled',
                  jsonb_build_object('pack_key', v_pack, 'reverted_orders', v_reverted));
        end if;
      end if;
      -- ADR-141: el plan sin emitir se cancela y el link de percepción también.
      update ml_invoice_plans set status = 'cancelled'
       where account_id = p_account and pack_key = v_pack and fiscal_document_id is null
         and status in ('ready', 'hold_perception', 'needs_review', 'blocked', 'error');
      update ml_perception_charges set status = 'cancelled'
       where account_id = p_account and pack_key = v_pack and status = 'link_sent';
      update ml_orders set needs_review = null
       where account_id = p_account and pack_key = v_pack and needs_review like 'Carrito%';
      return jsonb_build_object('ok', true, 'decision', 'cancel', 'sale_id', v_sale, 'reverted', v_reverted);
    end if;
    update ml_orders set needs_review = 'Carrito con órdenes canceladas y otras no: revisá la venta (devolución parcial).'
     where account_id = p_account and pack_key = v_pack and needs_review is null;
    if v_reverted > 0 then
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (v_tenant, null, 'sales', v_sale, 'ml_order_partial_cancel',
              jsonb_build_object('pack_key', v_pack, 'reverted_orders', v_reverted));
    end if;
    return jsonb_build_object('ok', true, 'decision', 'partial_cancel', 'sale_id', v_sale, 'reverted', v_reverted);
  end if;

  if v_sale is not null then
    -- ADR-141: venta existente sin plan (o con plan sin emitir): se guarda el plan nuevo.
    if v_plan is not null then
      v_prow := _ml_plan_store(p_account, v_pack, v_sale, v_plan, null);
      perform _ml_orders_status_from_plan(v_prow.id);
    end if;
    return jsonb_build_object('ok', true, 'decision', 'noop', 'sale_id', v_sale);
  end if;
  if not coalesce(v_all_paid, false) then
    return jsonb_build_object('ok', true, 'decision', 'wait_payment');
  end if;

  -- 3) Crear la venta.
  perform assert_account_active(v_tenant);
  select * into v_map from ml_location_map m where m.account_id = p_account and m.location_type = 'item_stock';
  v_store := coalesce(v_map.store_id, stock_default_store(v_tenant));
  -- ADR-145: con la facturación pro, la sucursal (factura y punto de venta) y
  -- el depósito (stock) salen del tipo de envío: la regla del tipo, si no la
  -- "por defecto", si no la de la cuenta. Full factura en la sucursal elegida
  -- pero su stock sigue saliendo del depósito virtual Full (ADR-142).
  if tenant_has_feature_for(v_tenant, 'mercadolibre_facturacion') then
    v_kind := coalesce(nullif(v_plan ->> 'logistic', ''),
                       case when v_has_ship then _ml_logistic_kind(p -> 'shipment' ->> 'mode', p -> 'shipment' ->> 'logistic_type')
                            when exists (select 1 from ml_orders o, jsonb_array_elements(o.lines) x, ml_items mi
                                          where o.account_id = p_account and o.pack_key = v_pack
                                            and mi.account_id = p_account and mi.ml_item_id = x ->> 'ml_item_id'
                                            and mi.logistic_type = 'fulfillment') then 'full'
                            else 'none' end);
    v_rule := _ml_logistic_store(p_account, v_kind);
    if v_rule is not null then
      v_store := (v_rule ->> 'store_id')::uuid;
      v_map.warehouse_id := nullif(v_rule ->> 'warehouse_id', '')::uuid;
    end if;
  end if;
  if v_store is null then raise exception 'no_store'; end if;
  if v_map.warehouse_id is not null and not exists (
       select 1 from warehouses w where w.id = v_map.warehouse_id and w.store_id = v_store and w.deleted_at is null) then
    v_map.warehouse_id := null;
  end if;

  -- Cliente desde los datos de facturación (o consumidor final).
  if v_bill is not null then
    v_doc := nullif(regexp_replace(coalesce(v_bill ->> 'docNumber', ''), '\D', '', 'g'), '');
    if v_doc is not null then
      select c.id into v_customer from customers c
       where c.tenant_id = v_tenant and c.deleted_at is null
         and regexp_replace(coalesce(c.document_number, ''), '\D', '', 'g') = v_doc
       order by c.created_at limit 1;
      if v_customer is null then
        insert into customers (tenant_id, name, document_type, document_number, iva_condition, address, metadata)
        values (v_tenant,
                left(coalesce(nullif(v_plan -> 'receptors' -> 'billing' ->> 'name', ''), nullif(v_bill ->> 'name', ''),
                              'Comprador de Mercado Libre'), 200),
                case when v_bill ->> 'docType' in ('cuit', 'cuil', 'dni', 'passport', 'other') then v_bill ->> 'docType' else 'other' end,
                v_doc,
                case when coalesce(v_plan -> 'receptors' -> 'billing' ->> 'iva_condition', v_bill ->> 'ivaCondition')
                          in ('consumidor_final', 'responsable_inscripto', 'monotributo',
                              'monotributo_social', 'exento', 'no_alcanzado', 'no_categorizado')
                     then coalesce(v_plan -> 'receptors' -> 'billing' ->> 'iva_condition', v_bill ->> 'ivaCondition')
                     else 'consumidor_final' end,
                left(coalesce(nullif(v_plan -> 'receptors' -> 'billing' ->> 'address', ''), v_bill ->> 'address'), 300),
                jsonb_build_object('source', 'mercadolibre', 'ml_account_id', p_account,
                                   'taxpayer_type', v_bill ->> 'taxpayerRaw'))
        returning id into v_customer;
      end if;
    end if;
  end if;

  -- ADR-141: renglones del plan (precio con el cupón prorrateado si es la regla).
  if v_plan is not null and jsonb_typeof(v_plan -> 'items') = 'array' then
    v_items := v_plan -> 'items';
    for v_k in 0 .. jsonb_array_length(v_items) - 1 loop v_used[v_k + 1] := false; end loop;
  end if;

  -- Líneas: publicación (y variación) vinculada -> producto/variante del POS.
  for v_ord in
    select o.id, o.ml_order_id, o.lines from ml_orders o
     where o.account_id = p_account and o.pack_key = v_pack order by o.ml_order_id
  loop
    for v_l in select value from jsonb_array_elements(v_ord.lines) loop
      v_lp := null; v_lv := null;
      select l.product_id, l.variant_id into v_lp, v_lv
        from ml_item_links l
        join ml_items i on i.id = l.item_id
       where i.account_id = p_account and i.ml_item_id = v_l ->> 'ml_item_id'
         and (l.ml_variation_id is null or l.ml_variation_id::text = coalesce(v_l ->> 'ml_variation_id', ''))
       order by (l.ml_variation_id is null)
       limit 1;
      v_gross := round(coalesce((v_l ->> 'unit_price')::numeric, 0) * coalesce((v_l ->> 'quantity')::numeric, 0), 2);
      if jsonb_array_length(v_items) > 0 then
        -- El renglón del plan de la misma orden, publicación y variación.
        for v_k in 0 .. jsonb_array_length(v_items) - 1 loop
          if not v_used[v_k + 1]
             and v_items -> v_k ->> 'ml_order_id' = v_ord.ml_order_id::text
             and v_items -> v_k ->> 'ml_item_id' = v_l ->> 'ml_item_id'
             and coalesce(v_items -> v_k ->> 'ml_variation_id', '') = coalesce(v_l ->> 'ml_variation_id', '') then
            v_used[v_k + 1] := true;
            v_gross := (v_items -> v_k ->> 'gross')::numeric;
            v_l := v_l || jsonb_build_object('unit_price', (v_items -> v_k ->> 'unit_price')::numeric,
                                             'list_unit_price', (v_items -> v_k ->> 'list_unit_price')::numeric);
            exit;
          end if;
        end loop;
      end if;
      v_total := v_total + v_gross;
      v_lines := v_lines || jsonb_build_array(v_l || jsonb_build_object(
        'order_row', v_ord.id, 'product_id', v_lp, 'variant_id', v_lv, 'gross', v_gross));
      v_tax_in := v_tax_in || jsonb_build_array(jsonb_build_object(
        'product_id', v_lp, 'variant_id', v_lv,
        'quantity', coalesce((v_l ->> 'quantity')::numeric, 0), 'gross', v_gross));
    end loop;
  end loop;
  if v_total <= 0 then raise exception 'empty_sale'; end if;

  -- ADR-141: envío que pagó el comprador (renglón) y cupón (descuento).
  v_subtotal := v_total;
  if v_plan is not null then
    if coalesce((v_plan -> 'shipping' ->> 'line')::boolean, false) and coalesce((v_plan -> 'shipping' ->> 'amount')::numeric, 0) > 0 then
      v_ship := round((v_plan -> 'shipping' ->> 'amount')::numeric, 2);
      v_ship_label := left(coalesce(nullif(v_plan -> 'shipping' ->> 'label', ''), 'Envío'), 120);
      v_tax_in := v_tax_in || jsonb_build_array(jsonb_build_object(
        'product_id', null, 'variant_id', null, 'quantity', 1, 'gross', v_ship));
      v_subtotal := v_subtotal + v_ship;
    end if;
    v_discount := least(greatest(coalesce((v_plan -> 'coupon' ->> 'discount')::numeric, 0), 0), v_total);
    v_total := round(v_subtotal - v_discount, 2);
  end if;

  -- Desglose fiscal (letra según emisor y receptor). La venta de ML no lleva
  -- percepciones al crearse: el precio lo fijó ML y ya está cobrado (ADR-141:
  -- si corresponden, se cobran por link y se suman al emitir).
  v_tax := _sale_tax_compute(v_tenant, v_customer, v_tax_in, v_total, now());

  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from sales where tenant_id = v_tenant;

  insert into sales (tenant_id, store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes, channel, channel_ref,
                     cbte_letter, fiscal_snapshot, net_taxed, net_exempt, net_untaxed,
                     iva_total, internal_tax_total, perception_total, created_by)
  values (v_tenant, v_store, null, v_customer, v_number, 'completed',
          v_subtotal, v_discount,
          coalesce((v_tax ->> 'iva_total')::numeric, 0) + coalesce((v_tax ->> 'internal_total')::numeric, 0),
          v_total, left('Mercado Libre ' || case when nullif(p ->> 'pack_id', '') is not null then 'carrito ' else 'orden ' end || v_pack, 200),
          'mercadolibre', v_pack,
          v_tax ->> 'letter',
          jsonb_build_object('emitter', v_tax -> 'emitter', 'receptor', v_tax -> 'receptor',
                             'requires_identification', v_tax -> 'requires_identification',
                             'warnings', v_tax -> 'warnings'),
          coalesce((v_tax ->> 'net_taxed')::numeric, 0), coalesce((v_tax ->> 'net_exempt')::numeric, 0),
          coalesce((v_tax ->> 'net_untaxed')::numeric, 0), coalesce((v_tax ->> 'iva_total')::numeric, 0),
          coalesce((v_tax ->> 'internal_total')::numeric, 0), 0, null)
  returning * into v_sale_row;
  v_sale := v_sale_row.id;

  insert into sale_tax_lines (tenant_id, sale_id, kind, tax, rate_code, rate, base, amount, arca_id, source)
  select v_tenant, v_sale, 'iva', 'iva', x.code, x.rate, x.base, x.amount, x.arca_id, 'product'
    from jsonb_to_recordset(coalesce(v_tax -> 'iva', '[]'::jsonb))
      as x(code text, rate numeric, base numeric, amount numeric, arca_id int);
  if coalesce((v_tax ->> 'internal_total')::numeric, 0) > 0 then
    insert into sale_tax_lines (tenant_id, sale_id, kind, tax, base, amount, arca_id, source, name)
    values (v_tenant, v_sale, 'internos', 'internos', coalesce((v_tax ->> 'internal_base')::numeric, 0),
            (v_tax ->> 'internal_total')::numeric, 4, 'product', 'Impuestos internos');
  end if;

  -- Renglones y stock (una sola vez; la cancelación revierte lo mismo).
  for v_i in 0 .. jsonb_array_length(v_lines) - 1 loop
    v_l := v_lines -> v_i;
    v_tl := v_tax -> 'lines' -> v_i;
    v_pname := null; v_psku := null; v_track := false; v_taken := 0; v_full_inv := null;
    if nullif(v_l ->> 'product_id', '') is not null then
      select p2.name, p2.sku, coalesce(p2.track_stock, true) and not coalesce(p2.is_kit, false)
        into v_pname, v_psku, v_track
        from products p2 where p2.id = (v_l ->> 'product_id')::uuid and p2.tenant_id = v_tenant;
      if nullif(v_l ->> 'variant_id', '') is not null then
        select v_pname || ' · ' || v.option1 || coalesce(' / ' || v.option2, ''), coalesce(v.sku, v_psku)
          into v_pname, v_psku
          from product_variants v where v.id = (v_l ->> 'variant_id')::uuid and v.tenant_id = v_tenant;
      end if;
    end if;
    insert into sale_items (tenant_id, sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_tenant, v_sale, nullif(v_l ->> 'product_id', '')::uuid, nullif(v_l ->> 'variant_id', '')::uuid,
            left(coalesce(v_pname, v_l ->> 'title', 'Publicación de Mercado Libre'), 250),
            coalesce(v_psku, nullif(v_l ->> 'seller_sku', '')), null,
            (v_l ->> 'quantity')::numeric, (v_l ->> 'unit_price')::numeric, 0, (v_l ->> 'gross')::numeric, '[]'::jsonb,
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
    -- ADR-142: una línea despachada por Full no sale del stock propio (nunca
    -- estuvo en el mostrador); descuenta el depósito Full hasta la próxima
    -- sincronización. Sin el envío normalizado, decide la publicación.
    v_line_full := v_full_pack or (not v_has_ship and exists (
      select 1 from ml_items mi
       where mi.account_id = p_account and mi.ml_item_id = v_l ->> 'ml_item_id'
         and mi.logistic_type = 'fulfillment'));
    if v_line_full then
      v_track := false;
      v_full_lines := v_full_lines + 1;
      if v_full_feat is null then
        v_full_feat := tenant_has_feature_for(v_tenant, 'mercadolibre_full');
      end if;
      if v_full_feat then
        v_full_inv := _ml_full_sale_apply(p_account, v_l ->> 'ml_item_id', v_l ->> 'ml_variation_id',
                                          (v_l ->> 'quantity')::numeric);
      end if;
    end if;
    if v_track then
      v_taken := _ml_stock_apply(v_tenant, v_sale, v_store, v_map.warehouse_id,
                                 (v_l ->> 'product_id')::uuid, nullif(v_l ->> 'variant_id', '')::uuid,
                                 (v_l ->> 'quantity')::numeric, 0, 'sale');
    end if;
    v_lines := jsonb_set(v_lines, array[v_i::text],
                         v_l || jsonb_build_object('applied', v_track, 'store_id', v_store,
                                                   'warehouse_id', v_map.warehouse_id, 'wh_taken', v_taken,
                                                   'full', v_line_full, 'full_inventory_id', v_full_inv));
  end loop;

  -- ADR-141: renglón del envío cobrado al comprador (sin producto ni stock).
  if v_ship > 0 then
    v_tl := v_tax -> 'lines' -> jsonb_array_length(v_lines);
    insert into sale_items (tenant_id, sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_tenant, v_sale, null, null, v_ship_label, null, null, 1, v_ship, 0, v_ship, '[]'::jsonb,
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
  end if;

  -- Cobro del canal: sin caja (lo liquida Mercado Pago).
  insert into payments (tenant_id, sale_id, method, amount, reference, card_voucher)
  values (v_tenant, v_sale, 'mercadolibre', v_total, left('ML ' || v_pack, 120), '{}'::jsonb);

  -- Cada orden guarda sus líneas resueltas (para revertir exacto).
  for v_ord in
    select o.id from ml_orders o where o.account_id = p_account and o.pack_key = v_pack
  loop
    select count(*) filter (where nullif(x ->> 'product_id', '') is null) into v_unlinked
      from jsonb_array_elements(v_lines) x where (x ->> 'order_row')::uuid = v_ord.id;
    update ml_orders
       set sale_id = v_sale, stock_applied_at = now(),
           lines = coalesce((select jsonb_agg(x - 'order_row') from jsonb_array_elements(v_lines) x
                              where (x ->> 'order_row')::uuid = v_ord.id), '[]'::jsonb),
           unlinked_lines = coalesce(v_unlinked, 0),
           needs_review = case when coalesce(v_unlinked, 0) > 0
                               then 'Hay publicaciones sin vincular: la venta se registró sin descontar su stock.'
                               else needs_review end,
           invoice_status = case v_acc.invoice_mode when 'none' then 'not_applicable'
                                                    when 'ml_billing' then 'not_applicable'
                                                    else 'pending' end
     where id = v_ord.id;
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, null, 'sales', v_sale, 'ml_sale_ingested',
          jsonb_build_object('pack_key', v_pack, 'sale_number', v_number, 'total', v_total,
                             'orders', (select jsonb_agg(o.ml_order_id) from ml_orders o
                                         where o.account_id = p_account and o.pack_key = v_pack),
                             'account_id', p_account, 'shipping_line', v_ship, 'coupon_discount', v_discount,
                             'plan', v_plan is not null, 'full_lines', v_full_lines,
                             'logistic', v_kind, 'store_rule', v_rule ->> 'source'),
          v_store);

  if v_plan is not null then
    -- ADR-141: plan guardado; factura sola si el modo y el plan lo permiten.
    v_prow := _ml_plan_store(p_account, v_pack, v_sale, v_plan, null);
    if v_acc.invoice_mode in ('none', 'ml_billing') then
      update ml_invoice_plans set status = 'skipped', skip_reason = 'La cuenta no factura las ventas de Mercado Libre.'
       where id = v_prow.id and fiscal_document_id is null;
    else
      v_auto := _ml_invoice_auto(v_prow.id);
      perform _ml_orders_status_from_plan(v_prow.id);
    end if;
  elsif v_acc.invoice_mode = 'on_paid' then
    -- Facturación al pagar (cola ARCA existente; nunca frena la venta).
    begin
      v_fiscal := arca_enqueue_sale(v_sale, false);
      if v_fiscal is not null then
        update ml_orders set invoice_status = 'queued', fiscal_document_id = v_fiscal
         where account_id = p_account and pack_key = v_pack;
      end if;
    exception when others then
      raise warning 'ml_ingest_pack arca: %', sqlerrm;
    end;
  end if;

  return jsonb_build_object('ok', true, 'decision', 'create_sale', 'sale_id', v_sale, 'number', v_number,
                            'total', v_total, 'invoice', coalesce(v_auto, 'null'::jsonb));
end;
$$;
revoke all on function ml_ingest_pack(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_ingest_pack(uuid, jsonb) to service_role;
