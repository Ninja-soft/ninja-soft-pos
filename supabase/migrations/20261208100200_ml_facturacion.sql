-- =============================================================================
-- 20261208100200_ml_facturacion  (ADR-141 · parte B)
--
-- Facturación de Mercado Libre con reglas y configuración amplia. Diseño en
-- docs/43-mercadolibre-facturacion.md (tomado de cómo factura hoy ANDESMAR).
--
--   A) Columnas: ml_orders.payments / coupon_amount / shipping_paid,
--      invoice_status 'hold' y 'review', ml_accounts.invoice_mode
--      'on_delivered'.
--   B) Tablas: ml_billing_settings (por cuenta), ml_invoice_plans (la factura
--      armada de cada carrito y lo elegido para esa venta),
--      ml_perception_charges (cobro de percepciones por link de pago) y
--      ml_fiscal_uploads (qué comprobante se sube a la venta de ML).
--      tenant_id NOT NULL sin default, RLS de lectura con
--      (select current_tenant_id()), escritura sólo por RPC SECURITY DEFINER o
--      service_role, role_write_guard. Nunca `OR is_internal()`.
--   C) Guardas: ml_billing_assert (UI), ml_edge_guard_billing (Edge).
--   D) Contexto para el worker (ml_billing_context) y guardado del plan.
--   E) Emisión: _ml_invoice_emit, siempre por la cola de ARCA
--      (arca_enqueue_sale) con la letra validada contra la matriz de ADR-133
--      (cbte_letter_check) y el bloqueo de _arca_blocker; punto de venta,
--      concepto y receptor por venta en el comprobante (receptor_override).
--      Percepción cobrada: sale_tax_lines + total + pago, y el asiento se
--      rearma (acc_sync_safe).
--   F) Recreadas desde su última definición (20261110400200, ninguna otra
--      rama las tocó): ml_ingest_pack (renglones del plan, envío y cupón),
--      ml_shipment_upsert (al despachar o al entregar), trg_ml_fiscal_status
--      (subidas elegibles, notas de crédito), ml_invoice_pdf_data (A4 o
--      ticket, descuento, percepciones, rótulo del comprobante),
--      ml_invoice_uploaded, ml_order_invoice y ml_order_invoice_upload_retry.
--   G) RPC de la UI: configuración, bandeja, elección por venta, emisión,
--      omisión, nota de crédito, subida elegida, percepciones a mano.
--   H) Percepciones: pago del link (trigger en mp_payment_intents, como
--      cobros en espera) y vencimiento (ml_perception_expire_due, cron en
--      20261208100300).
--   I) Reintegro total en un reclamo (ml_claims, ADR-132): nota de crédito
--      automática o "a revisar" según la cuenta.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Columnas
-- -----------------------------------------------------------------------------
alter table ml_orders add column if not exists payments jsonb not null default '[]'::jsonb;
alter table ml_orders add column if not exists coupon_amount numeric(14,2) not null default 0;
alter table ml_orders add column if not exists shipping_paid numeric(14,2) not null default 0;

alter table ml_orders drop constraint if exists ml_orders_invoice_status_check;
alter table ml_orders add constraint ml_orders_invoice_status_check
  check (invoice_status in ('none', 'pending', 'queued', 'approved', 'uploaded', 'error', 'not_applicable', 'hold', 'review'));

alter table ml_accounts drop constraint if exists ml_accounts_invoice_mode_check;
alter table ml_accounts add constraint ml_accounts_invoice_mode_check
  check (invoice_mode in ('on_paid', 'on_shipped', 'on_delivered', 'manual', 'ml_billing', 'none'));

-- -----------------------------------------------------------------------------
-- B) Tablas
-- -----------------------------------------------------------------------------
create table if not exists ml_billing_settings (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  account_id           uuid not null references ml_accounts(id) on delete cascade,
  -- Comprobante: punto de venta propio de la cuenta (null = el de la sucursal),
  -- concepto (null = según los productos) y formato del PDF que se sube.
  pto_vta              integer check (pto_vta is null or pto_vta between 1 and 99998),
  concepto             integer check (concepto is null or concepto in (1, 2, 3)),
  pdf_format           text not null default 'a4' check (pdf_format in ('a4', 'ticket')),
  upload_credit_notes  boolean not null default false,
  nc_on_refund         text not null default 'review' check (nc_on_refund in ('review', 'auto')),
  -- Reglas del armado (invoicePlan.ts · planSettingsFrom): cupón, envío,
  -- receptor, padrón, consumidor final, jurisdicciones bloqueadas, control de
  -- lo cobrado y percepciones (modo, estrategia por envío y reglas por
  -- jurisdicción).
  rules                jsonb not null default '{}'::jsonb
                         check (jsonb_typeof(rules) = 'object' and pg_column_size(rules) <= 32768),
  perc_link_days       integer not null default 3 check (perc_link_days between 1 and 30),
  perc_on_expire       text not null default 'invoice_b' check (perc_on_expire in ('invoice_b', 'invoice_a', 'hold')),
  perc_message         text check (perc_message is null or char_length(perc_message) <= 1000),
  updated_by           uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table ml_billing_settings is
  'ADR-141: reglas de facturación de las ventas de una cuenta de Mercado Libre. Escribe sólo ml_billing_settings_save.';
create unique index if not exists ml_billing_settings_account_uq on ml_billing_settings (account_id);
create index if not exists ml_billing_settings_tenant_idx on ml_billing_settings (tenant_id);
create index if not exists ml_billing_settings_updated_by_idx on ml_billing_settings (updated_by) where updated_by is not null;
drop trigger if exists set_updated_at_ml_billing_settings on ml_billing_settings;
create trigger set_updated_at_ml_billing_settings before update on ml_billing_settings
  for each row execute function set_updated_at();

create table if not exists ml_invoice_plans (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  account_id          uuid not null references ml_accounts(id) on delete cascade,
  pack_key            text not null check (char_length(pack_key) <= 30),
  sale_id             uuid references sales(id) on delete set null,
  plan                jsonb not null check (jsonb_typeof(plan) = 'object' and pg_column_size(plan) <= 65536),
  status              text not null default 'ready'
                        check (status in ('ready', 'hold_perception', 'needs_review', 'blocked', 'queued', 'approved',
                                          'error', 'skipped', 'cancelled')),
  warnings            text[] not null default '{}',
  -- Lo elegido para esta venta (null = lo que sugiere el plan o la cuenta).
  choice              text not null default 'billing' check (choice in ('billing', 'consumidor_final')),
  letter              text check (letter is null or letter in ('A', 'B', 'C', 'M')),
  pto_vta             integer check (pto_vta is null or pto_vta between 1 and 99998),
  concepto            integer check (concepto is null or concepto in (1, 2, 3)),
  pdf_format          text check (pdf_format is null or pdf_format in ('a4', 'ticket')),
  -- Percepción: cobrarla (link o a mano) o facturar sin percibir.
  perception_mode     text not null default 'charge' check (perception_mode in ('charge', 'skip')),
  chosen_by           uuid references public.users(id) on delete set null,
  chosen_at           timestamptz,
  skip_reason         text check (skip_reason is null or char_length(skip_reason) <= 300),
  fiscal_document_id  uuid references fiscal_documents(id) on delete set null,
  last_error          text check (last_error is null or char_length(last_error) <= 500),
  emitted_at          timestamptz,
  computed_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table ml_invoice_plans is
  'ADR-141: factura armada de un carrito de ML (invoicePlan.ts) y lo elegido para esa venta (receptor, letra dentro de la matriz de ARCA, punto de venta, concepto, formato). Escribe sólo RPC o service_role.';
create unique index if not exists ml_invoice_plans_pack_uq on ml_invoice_plans (account_id, pack_key);
create index if not exists ml_invoice_plans_tenant_status_idx on ml_invoice_plans (tenant_id, status, created_at desc);
create index if not exists ml_invoice_plans_account_created_idx on ml_invoice_plans (account_id, created_at desc);
create index if not exists ml_invoice_plans_sale_idx on ml_invoice_plans (sale_id) where sale_id is not null;
create index if not exists ml_invoice_plans_fiscal_idx on ml_invoice_plans (fiscal_document_id) where fiscal_document_id is not null;
create index if not exists ml_invoice_plans_chosen_by_idx on ml_invoice_plans (chosen_by) where chosen_by is not null;
drop trigger if exists set_updated_at_ml_invoice_plans on ml_invoice_plans;
create trigger set_updated_at_ml_invoice_plans before update on ml_invoice_plans
  for each row execute function set_updated_at();

create table if not exists ml_perception_charges (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  account_id       uuid not null references ml_accounts(id) on delete cascade,
  plan_id          uuid not null references ml_invoice_plans(id) on delete cascade,
  pack_key         text not null check (char_length(pack_key) <= 30),
  amount           numeric(14,2) not null check (amount > 0),
  detail           jsonb not null default '[]'::jsonb check (jsonb_typeof(detail) = 'array'),
  status           text not null default 'link_sent'
                     check (status in ('link_sent', 'paid', 'paid_manual', 'paid_late', 'expired', 'cancelled')),
  provider         text not null default 'mercadopago' check (provider in ('mercadopago', 'manual')),
  intent_id        uuid references mp_payment_intents(id) on delete set null,
  init_point       text check (init_point is null or char_length(init_point) <= 1000),
  expires_at       timestamptz,
  paid_at          timestamptz,
  payment_ref      text check (payment_ref is null or char_length(payment_ref) <= 120),
  message          text check (message is null or char_length(message) <= 3500),
  message_sent_at  timestamptz,
  message_error    text check (message_error is null or char_length(message_error) <= 300),
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table ml_perception_charges is
  'ADR-141: percepción de IIBB cobrada por link de pago (o a mano) antes de emitir la factura A de una venta de ML.';
create unique index if not exists ml_perception_charges_open_uq on ml_perception_charges (plan_id)
  where status in ('link_sent', 'paid', 'paid_manual');
create index if not exists ml_perception_charges_tenant_idx on ml_perception_charges (tenant_id, status, created_at desc);
create index if not exists ml_perception_charges_account_idx on ml_perception_charges (account_id);
create index if not exists ml_perception_charges_plan_idx on ml_perception_charges (plan_id);
create index if not exists ml_perception_charges_intent_idx on ml_perception_charges (intent_id) where intent_id is not null;
create index if not exists ml_perception_charges_due_idx on ml_perception_charges (expires_at) where status = 'link_sent';
create index if not exists ml_perception_charges_created_by_idx on ml_perception_charges (created_by) where created_by is not null;
drop trigger if exists set_updated_at_ml_perception_charges on ml_perception_charges;
create trigger set_updated_at_ml_perception_charges before update on ml_perception_charges
  for each row execute function set_updated_at();

create table if not exists ml_fiscal_uploads (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  account_id          uuid not null references ml_accounts(id) on delete cascade,
  pack_key            text not null check (char_length(pack_key) <= 30),
  fiscal_document_id  uuid not null references fiscal_documents(id) on delete cascade,
  kind                text not null check (kind in ('factura', 'nota_credito')),
  sync                boolean not null default true,
  status              text not null default 'pending' check (status in ('pending', 'queued', 'uploaded', 'error', 'skipped')),
  ml_doc_id           text check (ml_doc_id is null or char_length(ml_doc_id) <= 120),
  attempts            integer not null default 0,
  last_error          text check (last_error is null or char_length(last_error) <= 500),
  uploaded_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table ml_fiscal_uploads is
  'ADR-141: comprobantes de una venta de ML y si se suben a la venta (elección por comprobante, reintentos y reemplazo).';
create unique index if not exists ml_fiscal_uploads_doc_uq on ml_fiscal_uploads (fiscal_document_id);
create index if not exists ml_fiscal_uploads_tenant_idx on ml_fiscal_uploads (tenant_id, status);
create index if not exists ml_fiscal_uploads_pack_idx on ml_fiscal_uploads (account_id, pack_key);
drop trigger if exists set_updated_at_ml_fiscal_uploads on ml_fiscal_uploads;
create trigger set_updated_at_ml_fiscal_uploads before update on ml_fiscal_uploads
  for each row execute function set_updated_at();

alter table ml_billing_settings   enable row level security;
alter table ml_invoice_plans      enable row level security;
alter table ml_perception_charges enable row level security;
alter table ml_fiscal_uploads     enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['ml_billing_settings', 'ml_invoice_plans', 'ml_perception_charges', 'ml_fiscal_uploads'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select using (tenant_id = (select current_tenant_id()))',
      t || '_select', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'operate');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Guardas
-- -----------------------------------------------------------------------------
-- UI: ml_assert (rol + `mercadolibre`) + `mercadolibre_facturacion`.
create or replace function ml_billing_assert(p_manage boolean default true)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(p_manage, true);
begin
  if not tenant_has_feature_for(v_tenant, 'mercadolibre_facturacion') then
    raise exception 'feature_not_in_plan: mercadolibre_facturacion' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function ml_billing_assert(boolean) from public, anon;
grant execute on function ml_billing_assert(boolean) to authenticated;

-- Edge (service_role): null = puede; si no, el código del error.
create or replace function ml_edge_guard_billing(p_tenant uuid, p_user uuid, p_manage boolean default true)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_err text := ml_edge_guard(p_tenant, p_user, p_manage);
begin
  if v_err is not null then return v_err; end if;
  if not tenant_has_feature_for(p_tenant, 'mercadolibre_facturacion') then return 'billing_not_in_plan'; end if;
  return null;
end;
$$;
revoke all on function ml_edge_guard_billing(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function ml_edge_guard_billing(uuid, uuid, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- D) Configuración, contexto y plan
-- -----------------------------------------------------------------------------
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
  end if;
  return v;
end;
$$;
revoke all on function _ml_billing_settings(uuid) from public, anon, authenticated;

-- Lo que necesita el armado de la factura (worker y Edge, service_role).
-- p: {cuit, lines: [{ml_item_id, ml_variation_id}]}. Sin la feature,
-- enabled = false y la venta entra como en ADR-104.
create or replace function ml_billing_context(p_account uuid, p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc    ml_accounts%rowtype;
  v_set    ml_billing_settings%rowtype;
  v_tax    jsonb;
  v_today  date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_cuit   text := nullif(regexp_replace(coalesce(p ->> 'cuit', ''), '\D', '', 'g'), '');
  v_env    text;
  v_padron jsonb;
  v_perc   boolean;
begin
  select * into v_acc from ml_accounts where id = p_account;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  if not tenant_has_feature_for(v_acc.tenant_id, 'mercadolibre_facturacion') then
    return jsonb_build_object('enabled', false);
  end if;
  v_set := _ml_billing_settings(p_account);
  v_tax := _tax_settings_eff(v_acc.tenant_id);
  v_perc := tenant_has_feature_for(v_acc.tenant_id, 'percepciones_retenciones');

  -- Padrón de ARCA (cache compartida de ADR-133, sin consultar a ARCA acá).
  if v_cuit is not null and length(v_cuit) = 11 then
    select c.environment into v_env from arca_padron_config c where c.id limit 1;
    select jsonb_build_object('iva_condition', c.result ->> 'iva_condition', 'razon_social', c.result ->> 'razon_social',
                              'domicilio', c.result ->> 'domicilio', 'provincia', c.result ->> 'provincia')
      into v_padron
      from arca_padron_cache c
     where c.cuit = v_cuit and c.status = 'ok' and c.environment = coalesce(v_env, 'produccion')
       and c.fetched_at > now() - interval '30 days';
  end if;

  return jsonb_build_object(
    'enabled', true,
    'settings', v_set.rules,
    'emitter', jsonb_build_object(
      'iva_condition', v_tax ->> 'iva_condition',
      'issues_m', coalesce((v_tax ->> 'issues_cbte_m')::boolean, false),
      'cf_id_threshold', tax_param_for(v_acc.tenant_id, 'cf_id_threshold', v_today),
      'can_perceive', v_perc),
    'padron', v_padron,
    'iibb', case when v_perc and v_cuit is not null then coalesce((
      select jsonb_agg(jsonb_build_object('jurisdiction', e.jurisdiction, 'rate', e.perception_rate,
                                          'valid_from', e.valid_from, 'valid_to', e.valid_to)
                       order by e.jurisdiction, e.valid_from desc)
        from tax_padron_entries e
        join tax_padron_imports i on i.id = e.import_id and i.status = 'ready'
       where e.tenant_id = v_acc.tenant_id and e.cuit = v_cuit and e.perception_rate is not null
         and e.valid_to >= v_today - 62), '[]'::jsonb) else '[]'::jsonb end,
    -- Jurisdicciones con el padrón COMPLETO del período cargado: si el CUIT no
    -- figura, salió del padrón (un import "sólo mis clientes" no cuenta).
    'iibb_loaded', coalesce((
      select jsonb_agg(distinct i.jurisdiction)
        from tax_padron_imports i
       where i.tenant_id = v_acc.tenant_id and i.status = 'ready' and i.format <> 'manual'
         and not i.only_known and i.kind in ('perception', 'both')
         and i.period_from <= v_today and i.period_to >= v_today), '[]'::jsonb),
    'line_rates', coalesce((
      select jsonb_agg(jsonb_build_object('ml_item_id', x.ml_item_id, 'ml_variation_id', x.ml_variation_id, 'rate', x.rate))
        from (
          select distinct on (l ->> 'ml_item_id', coalesce(l ->> 'ml_variation_id', ''))
                 l ->> 'ml_item_id' as ml_item_id, nullif(l ->> 'ml_variation_id', '') as ml_variation_id,
                 (select ir.rate from _tax_iva_rate_eff(v_acc.tenant_id,
                    coalesce(pv.tax_rate_code, pr.tax_rate_code, v_tax ->> 'default_rate_code', '21'), v_today) ir) as rate
            from jsonb_array_elements(case when jsonb_typeof(p -> 'lines') = 'array' then p -> 'lines' else '[]'::jsonb end) l
            left join ml_items i on i.account_id = p_account and i.ml_item_id = l ->> 'ml_item_id'
            left join ml_item_links k on k.item_id = i.id
                  and (k.ml_variation_id is null or k.ml_variation_id::text = coalesce(l ->> 'ml_variation_id', ''))
            left join products pr on pr.id = k.product_id and pr.tenant_id = v_acc.tenant_id
            left join product_variants pv on pv.id = k.variant_id and pv.tenant_id = v_acc.tenant_id
        ) x), '[]'::jsonb),
    'today', v_today);
end;
$$;
revoke all on function ml_billing_context(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_billing_context(uuid, jsonb) to service_role;

-- Receptor del plan -> forma de fiscal_snapshot.receptor / receptor_override.
create or replace function _ml_receptor_json(p_rec jsonb, p_customer uuid)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'customer_id', p_customer,
    'name', coalesce(nullif(p_rec ->> 'name', ''), 'Consumidor Final'),
    'iva_condition', coalesce(nullif(p_rec ->> 'iva_condition', ''), 'consumidor_final'),
    'arca_condition_id', fiscal_condition_arca_id(coalesce(nullif(p_rec ->> 'iva_condition', ''), 'consumidor_final')),
    'doc_type', case when nullif(p_rec ->> 'doc_number', '') is null then null else p_rec ->> 'doc_type' end,
    'arca_doc_type', case when nullif(p_rec ->> 'doc_number', '') is null then 99 else doc_type_arca_id(p_rec ->> 'doc_type') end,
    'doc_number', coalesce(nullif(regexp_replace(coalesce(p_rec ->> 'doc_number', ''), '[^0-9A-Za-z]', '', 'g'), ''), '0'),
    'address', left(p_rec ->> 'address', 300),
    'source', p_rec ->> 'source');
$$;
revoke all on function _ml_receptor_json(jsonb, uuid) from public, anon, authenticated;

-- Guarda el plan de un carrito. Si ya se emitió, no se toca. Si alguien
-- eligió algo a mano para esa venta, se respeta (sólo se actualiza el plan).
create or replace function _ml_plan_store(p_account uuid, p_pack text, p_sale uuid, p_plan jsonb, p_user uuid)
returns ml_invoice_plans
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc  ml_accounts%rowtype;
  v_row  ml_invoice_plans%rowtype;
  v_st   text := coalesce(nullif(p_plan ->> 'status', ''), 'needs_review');
  v_warn text[] := coalesce((select array_agg(w) from jsonb_array_elements_text(coalesce(p_plan -> 'warnings', '[]'::jsonb)) w), '{}');
  v_choice text := case when p_plan ->> 'choice' in ('billing', 'consumidor_final') then p_plan ->> 'choice' else 'billing' end;
  v_pmode text := case when p_plan -> 'perception' ->> 'strategy' = 'skip' then 'skip' else 'charge' end;
begin
  if jsonb_typeof(p_plan) <> 'object' then raise exception 'invalid_plan'; end if;
  if v_st not in ('ready', 'hold_perception', 'needs_review', 'blocked') then v_st := 'needs_review'; end if;
  select * into v_acc from ml_accounts where id = p_account;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  select * into v_row from ml_invoice_plans where account_id = p_account and pack_key = p_pack for update;
  if v_row.id is null then
    insert into ml_invoice_plans (tenant_id, account_id, pack_key, sale_id, plan, status, warnings, choice, perception_mode)
    values (v_acc.tenant_id, p_account, p_pack, p_sale, p_plan, v_st, v_warn, v_choice, v_pmode)
    returning * into v_row;
  elsif v_row.status in ('ready', 'hold_perception', 'needs_review', 'blocked', 'error') and v_row.fiscal_document_id is null then
    -- Con la venta ya creada, los importes son los de la venta: se conservan
    -- los renglones, el cupón, el envío y los totales del plan con el que se
    -- armó; si el plan nuevo da otro total (la orden cambió en ML), a revisar.
    if v_row.sale_id is not null and jsonb_typeof(v_row.plan -> 'totals') = 'object' then
      if abs(coalesce((p_plan -> 'totals' ->> 'invoice')::numeric, 0) - coalesce((v_row.plan -> 'totals' ->> 'invoice')::numeric, 0)) > 0.01 then
        v_warn := array_append(array_remove(v_warn, 'amounts_changed'), 'amounts_changed');
        if v_st in ('ready', 'hold_perception') then v_st := 'needs_review'; end if;
      end if;
      p_plan := p_plan || jsonb_build_object('items', v_row.plan -> 'items', 'shipping', v_row.plan -> 'shipping',
                                             'coupon', v_row.plan -> 'coupon', 'totals', v_row.plan -> 'totals');
    end if;
    update ml_invoice_plans
       set plan = p_plan, sale_id = coalesce(p_sale, sale_id), warnings = v_warn, computed_at = now(),
           -- Lo elegido a mano manda; si no, lo que sugiere el plan.
           choice = case when chosen_at is null then v_choice else choice end,
           perception_mode = case when chosen_at is null then v_pmode else perception_mode end,
           status = case
             when exists (select 1 from ml_perception_charges c where c.plan_id = v_row.id and c.status in ('paid', 'paid_manual'))
                  and v_st = 'hold_perception' then 'ready'
             when chosen_at is not null and v_st = 'hold_perception'
                  and (choice = 'consumidor_final' or perception_mode = 'skip') then 'ready'
             else v_st end,
           last_error = null
     where id = v_row.id
     returning * into v_row;
  end if;
  if p_user is not null then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_acc.tenant_id, p_user, 'ml_invoice_plans', v_row.id, 'ml_invoice_plan_recomputed',
            jsonb_build_object('pack_key', p_pack, 'status', v_row.status, 'total', p_plan -> 'totals' -> 'invoice'));
  end if;
  return v_row;
end;
$$;
revoke all on function _ml_plan_store(uuid, text, uuid, jsonb, uuid) from public, anon, authenticated;

-- Edge ml_facturacion (Rearmar): guarda el plan recalculado.
create or replace function ml_invoice_plan_store(p_account uuid, p_pack text, p_plan jsonb, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row  ml_invoice_plans%rowtype;
  v_sale uuid;
begin
  select max(o.sale_id::text)::uuid into v_sale from ml_orders o where o.account_id = p_account and o.pack_key = p_pack;
  v_row := _ml_plan_store(p_account, p_pack, v_sale, p_plan, p_user);
  return jsonb_build_object('ok', true, 'plan_id', v_row.id, 'status', v_row.status);
end;
$$;
revoke all on function ml_invoice_plan_store(uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function ml_invoice_plan_store(uuid, text, jsonb, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- E) Emisión
-- -----------------------------------------------------------------------------
-- ¿Toca facturar sola ahora? Según el modo de la cuenta y el envío.
create or replace function _ml_invoice_due(p_account uuid, p_pack text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case a.invoice_mode
           when 'on_paid' then true
           when 'on_shipped' then exists (select 1 from ml_shipments s where s.account_id = a.id and s.pack_key = p_pack
                                             and s.status in ('shipped', 'delivered'))
           when 'on_delivered' then exists (select 1 from ml_shipments s where s.account_id = a.id and s.pack_key = p_pack
                                               and s.status = 'delivered')
           else false end
    from ml_accounts a where a.id = p_account;
$$;
revoke all on function _ml_invoice_due(uuid, text) from public, anon, authenticated;

-- Emite la factura de un carrito con lo elegido. Nunca frena nada: devuelve
-- {ok, document_id} o {ok:false, error}. p_user null = automático.
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

  v_pv := coalesce(v_p.pto_vta, v_set.pto_vta, arca_pos_for(v_sale.store_id, null));
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

-- Emite sola si corresponde (modo de la cuenta) y el plan está listo.
create or replace function _ml_invoice_auto(p_plan uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p ml_invoice_plans%rowtype;
begin
  select * into v_p from ml_invoice_plans where id = p_plan;
  if v_p.id is null or v_p.status <> 'ready' or not _ml_invoice_due(v_p.account_id, v_p.pack_key) then
    return jsonb_build_object('ok', false, 'error', 'not_due');
  end if;
  begin
    return _ml_invoice_emit(p_plan, null, false);
  exception when others then
    -- La facturación nunca frena la venta: queda para emitir a mano.
    update ml_invoice_plans set last_error = left(sqlerrm, 500) where id = p_plan;
    return jsonb_build_object('ok', false, 'error', left(sqlerrm, 200));
  end;
end;
$$;
revoke all on function _ml_invoice_auto(uuid) from public, anon, authenticated;

-- Estado de la orden según el plan (para la lista de Ventas).
create or replace function _ml_orders_status_from_plan(p_plan uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update ml_orders o
     set invoice_status = case p.status when 'hold_perception' then 'hold'
                                        when 'needs_review' then 'review'
                                        when 'blocked' then 'review'
                                        when 'skipped' then 'not_applicable'
                                        else o.invoice_status end
    from ml_invoice_plans p
   where p.id = p_plan and o.account_id = p.account_id and o.pack_key = p.pack_key
     and o.invoice_status in ('none', 'pending', 'hold', 'review', 'not_applicable')
     and p.status in ('hold_perception', 'needs_review', 'blocked', 'skipped');
$$;
revoke all on function _ml_orders_status_from_plan(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- F) Recreadas (copia de 20261110400200, la única definición, + ADR-141)
-- -----------------------------------------------------------------------------
-- p: PackPayload (orders.ts) + invoice (MlInvoicePlan, invoicePlan.ts) cuando
-- la cuenta tiene la facturación pro. Con plan: renglones a su precio (cupón
-- prorrateado si es la regla), renglón de envío si lo pagó el comprador,
-- descuento del cupón y plan guardado; sin plan, igual que ADR-104.
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
    v_pname := null; v_psku := null; v_track := false; v_taken := 0;
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
    if v_track then
      v_taken := _ml_stock_apply(v_tenant, v_sale, v_store, v_map.warehouse_id,
                                 (v_l ->> 'product_id')::uuid, nullif(v_l ->> 'variant_id', '')::uuid,
                                 (v_l ->> 'quantity')::numeric, 0, 'sale');
    end if;
    v_lines := jsonb_set(v_lines, array[v_i::text],
                         v_l || jsonb_build_object('applied', v_track, 'store_id', v_store,
                                                   'warehouse_id', v_map.warehouse_id, 'wh_taken', v_taken));
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
                             'plan', v_plan is not null),
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

-- p: ShipmentNormalized (orders.ts). Con la cuenta 'al despacharse' o 'al
-- entregarse', factura la venta del carrito (con plan: _ml_invoice_auto).
create or replace function ml_shipment_upsert(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc   ml_accounts%rowtype;
  v_ship  bigint := (p ->> 'shipment_id')::bigint;
  v_pack  text;
  v_o     record;
  v_doc   uuid;
  v_n     int := 0;
  v_st    text := coalesce(p ->> 'status', '');
  v_plan  uuid;
begin
  select * into v_acc from ml_accounts where id = p_account;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  select o.pack_key into v_pack from ml_orders o
   where o.account_id = p_account and (o.shipment_id = v_ship or o.ml_order_id = nullif(p ->> 'order_id', '')::bigint)
   limit 1;
  insert into ml_shipments (tenant_id, account_id, shipment_id, pack_key, mode, logistic_type, status, substatus,
                            tracking_number, tracking_method, cost, city, state, zip, date_created, synced_at)
  values (v_acc.tenant_id, p_account, v_ship, v_pack, nullif(p ->> 'mode', ''), nullif(p ->> 'logistic_type', ''),
          coalesce(nullif(p ->> 'status', ''), 'pending'), nullif(p ->> 'substatus', ''),
          nullif(p ->> 'tracking_number', ''), nullif(p ->> 'tracking_method', ''), nullif(p ->> 'cost', '')::numeric,
          left(nullif(p ->> 'city', ''), 120), left(nullif(p ->> 'state', ''), 120), left(nullif(p ->> 'zip', ''), 20),
          nullif(p ->> 'date_created', '')::timestamptz, now())
  on conflict (account_id, shipment_id) do update
    set pack_key = coalesce(excluded.pack_key, ml_shipments.pack_key), mode = excluded.mode,
        logistic_type = excluded.logistic_type, status = excluded.status, substatus = excluded.substatus,
        tracking_number = excluded.tracking_number, tracking_method = excluded.tracking_method,
        cost = coalesce(excluded.cost, ml_shipments.cost), city = excluded.city, state = excluded.state,
        zip = excluded.zip, synced_at = now();

  if v_pack is not null then
    update ml_orders set shipping_cost = coalesce(nullif(p ->> 'cost', '')::numeric, shipping_cost)
     where account_id = p_account and pack_key = v_pack;
  end if;

  if v_pack is not null
     and ((v_acc.invoice_mode = 'on_shipped' and v_st in ('shipped', 'delivered'))
          or (v_acc.invoice_mode = 'on_delivered' and v_st = 'delivered'))
     and tenant_has_feature_for(v_acc.tenant_id, 'mercadolibre') then
    select pl.id into v_plan from ml_invoice_plans pl where pl.account_id = p_account and pl.pack_key = v_pack;
    if v_plan is not null then
      if (_ml_invoice_auto(v_plan) ->> 'ok')::boolean then v_n := 1; end if;
    elsif v_acc.invoice_mode = 'on_shipped' then
      for v_o in
        select distinct o.sale_id from ml_orders o
         where o.account_id = p_account and o.pack_key = v_pack and o.sale_id is not null
           and o.invoice_status in ('none', 'pending')
      loop
        v_doc := arca_enqueue_sale(v_o.sale_id, false);
        update ml_orders set invoice_status = case when v_doc is null then 'pending' else 'queued' end,
                             fiscal_document_id = coalesce(v_doc, fiscal_document_id)
         where account_id = p_account and pack_key = v_pack;
        v_n := v_n + 1;
      end loop;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'pack_key', v_pack, 'invoiced', v_n);
end;
$$;
revoke all on function ml_shipment_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_shipment_upsert(uuid, jsonb) to service_role;

-- Comprobante de una venta de ML con estado nuevo: estado en la orden y el
-- plan, y el registro de subida (la factura según la cuenta; las notas de
-- crédito sólo si la cuenta lo pide). Lo elegido a mano para un comprobante
-- (ml_fiscal_uploads.sync) manda.
create or replace function trg_ml_fiscal_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r      record;
  v_kind text := case when new.origin = 'sale' then 'factura' else 'nota_credito' end;
  v_up   ml_fiscal_uploads%rowtype;
  v_sync boolean;
begin
  if new.status is not distinct from old.status then
    return null;
  end if;
  if not exists (select 1 from ml_orders o where o.sale_id = new.sale_id) then
    return null;
  end if;
  begin
    for r in
      select distinct o.account_id, o.pack_key, a.upload_invoice, a.tenant_id,
             coalesce(s.upload_credit_notes, false) as upload_nc
        from ml_orders o join ml_accounts a on a.id = o.account_id
        left join ml_billing_settings s on s.account_id = a.id
       where o.sale_id = new.sale_id
    loop
      if new.status = 'aprobado' then
        if new.origin = 'sale' then
          update ml_orders set invoice_status = 'approved', fiscal_document_id = new.id
           where account_id = r.account_id and pack_key = r.pack_key;
          update ml_invoice_plans set status = 'approved', fiscal_document_id = new.id, last_error = null
           where account_id = r.account_id and pack_key = r.pack_key and status in ('queued', 'error', 'ready');
        end if;
        v_sync := case when v_kind = 'factura' then r.upload_invoice else r.upload_nc end;
        insert into ml_fiscal_uploads (tenant_id, account_id, pack_key, fiscal_document_id, kind, sync, status)
        values (r.tenant_id, r.account_id, r.pack_key, new.id, v_kind, v_sync, 'pending')
        on conflict (fiscal_document_id) do nothing;
        select * into v_up from ml_fiscal_uploads where fiscal_document_id = new.id;
        if v_up.sync and v_up.status in ('pending', 'error') then
          perform _ml_enqueue(r.tenant_id, r.account_id, 'invoice_upload', 'invoice_upload:' || new.id::text,
                              r.pack_key, jsonb_build_object('fiscal_document_id', new.id, 'pack_key', r.pack_key,
                                                             'sale_id', new.sale_id), 0, null);
          update ml_fiscal_uploads set status = 'queued' where id = v_up.id;
        elsif not v_up.sync then
          update ml_fiscal_uploads set status = 'skipped' where id = v_up.id and status = 'pending';
        end if;
      elsif new.origin = 'sale' and new.status in ('rechazado', 'requiere_accion') then
        update ml_orders set invoice_status = 'error', fiscal_document_id = new.id
         where account_id = r.account_id and pack_key = r.pack_key;
        update ml_invoice_plans set status = 'error', last_error = left(coalesce(new.last_error_msg, new.last_error_code), 500)
         where account_id = r.account_id and pack_key = r.pack_key and fiscal_document_id = new.id;
      elsif new.origin = 'sale' and new.status in ('pendiente', 'enviando') then
        update ml_orders set invoice_status = 'queued', fiscal_document_id = new.id
         where account_id = r.account_id and pack_key = r.pack_key and invoice_status <> 'uploaded';
        update ml_invoice_plans set status = 'queued'
         where account_id = r.account_id and pack_key = r.pack_key and fiscal_document_id = new.id and status = 'error';
      end if;
    end loop;
  exception when others then
    raise warning 'trg_ml_fiscal_status: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function trg_ml_fiscal_status() from public, anon, authenticated;
drop trigger if exists ml_fiscal_status on fiscal_documents;
create trigger ml_fiscal_status
  after update of status on fiscal_documents
  for each row execute function trg_ml_fiscal_status();

-- Datos del PDF del comprobante (worker, invoice_upload). ADR-141: rótulo
-- (factura o nota de crédito), A4 o ticket, descuento del cupón,
-- percepciones por jurisdicción y comprobante asociado.
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
    'notes', 'Venta en Mercado Libre ' || coalesce(v_sale.channel_ref, ''));
end;
$$;
revoke all on function ml_invoice_pdf_data(uuid) from public, anon, authenticated;
grant execute on function ml_invoice_pdf_data(uuid) to service_role;

create or replace function ml_invoice_uploaded(p_account uuid, p_pack text, p_doc uuid, p_ok boolean,
                                               p_ml_id text default null, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_kind   text;
begin
  select a.tenant_id into v_tenant from ml_accounts a where a.id = p_account;
  update ml_fiscal_uploads
     set status = case when p_ok then 'uploaded' else 'error' end,
         ml_doc_id = case when p_ok then left(p_ml_id, 120) else ml_doc_id end,
         uploaded_at = case when p_ok then now() else uploaded_at end,
         attempts = attempts + 1,
         last_error = case when p_ok then null else left(p_error, 500) end
   where fiscal_document_id = p_doc
  returning kind into v_kind;
  if coalesce(v_kind, 'factura') = 'factura' then
    update ml_orders
       set invoice_status = case when p_ok then 'uploaded' else invoice_status end,
           ml_fiscal_doc_id = case when p_ok then left(p_ml_id, 120) else ml_fiscal_doc_id end,
           needs_review = case when p_ok then needs_review
                               else left('No se pudo subir la factura a Mercado Libre: ' || coalesce(p_error, ''), 300) end
     where account_id = p_account and pack_key = p_pack;
  end if;
  if v_tenant is not null then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, null, 'fiscal_documents', p_doc, case when p_ok then 'ml_invoice_uploaded' else 'ml_invoice_upload_failed' end,
            jsonb_build_object('pack_key', p_pack, 'ml_fiscal_document_id', p_ml_id, 'kind', coalesce(v_kind, 'factura'),
                               'error', left(p_error, 300)));
  end if;
end;
$$;
revoke all on function ml_invoice_uploaded(uuid, text, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function ml_invoice_uploaded(uuid, text, uuid, boolean, text, text) to service_role;

-- Facturar a mano la venta de un carrito (ADR-104). Con plan, emite con lo
-- elegido (ADR-141); sin plan, la cola ARCA como antes.
create or replace function ml_order_invoice(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_o      ml_orders%rowtype;
  v_doc    uuid;
  v_plan   uuid;
  v_res    jsonb;
begin
  select * into v_o from ml_orders where id = p_order and tenant_id = v_tenant;
  if v_o.id is null then raise exception 'not_found'; end if;
  if v_o.sale_id is null then raise exception 'no_sale'; end if;
  if v_o.fraud_risk then raise exception 'fraud_risk'; end if;
  if not exists (select 1 from arca_settings s where s.tenant_id = v_tenant and s.enabled) then
    raise exception 'arca_not_enabled';
  end if;
  select pl.id into v_plan from ml_invoice_plans pl where pl.account_id = v_o.account_id and pl.pack_key = v_o.pack_key;
  if v_plan is not null and tenant_has_feature_for(v_tenant, 'mercadolibre_facturacion') then
    v_res := _ml_invoice_emit(v_plan, auth.uid(), true);
    if not coalesce((v_res ->> 'ok')::boolean, false) then raise exception '%', v_res ->> 'error'; end if;
    return v_res;
  end if;
  v_doc := arca_enqueue_sale(v_o.sale_id, true);
  if v_doc is null then raise exception 'already_enqueued'; end if;
  update ml_orders set invoice_status = 'queued', fiscal_document_id = v_doc
   where account_id = v_o.account_id and pack_key = v_o.pack_key;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'fiscal_documents', v_doc, 'ml_invoice_enqueued',
          jsonb_build_object('sale_id', v_o.sale_id, 'pack_key', v_o.pack_key));
  return jsonb_build_object('ok', true, 'document_id', v_doc);
end;
$$;
revoke all on function ml_order_invoice(uuid) from public, anon;
grant execute on function ml_order_invoice(uuid) to authenticated;

-- Reintentar la subida de la factura aprobada al pack (ADR-104), auditado.
create or replace function ml_order_invoice_upload_retry(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(true, true);
  v_o      ml_orders%rowtype;
begin
  select * into v_o from ml_orders where id = p_order and tenant_id = v_tenant;
  if v_o.id is null then raise exception 'not_found'; end if;
  if v_o.fiscal_document_id is null or not exists (
       select 1 from fiscal_documents d where d.id = v_o.fiscal_document_id and d.status = 'aprobado') then
    raise exception 'invoice_not_approved';
  end if;
  update ml_fiscal_uploads set sync = true, status = 'queued', last_error = null
   where fiscal_document_id = v_o.fiscal_document_id;
  perform _ml_enqueue(v_tenant, v_o.account_id, 'invoice_upload', 'invoice_upload:' || v_o.fiscal_document_id::text,
                      v_o.pack_key, jsonb_build_object('fiscal_document_id', v_o.fiscal_document_id,
                                                       'pack_key', v_o.pack_key, 'sale_id', v_o.sale_id), 0, auth.uid());
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'fiscal_documents', v_o.fiscal_document_id, 'ml_invoice_upload_requested',
          jsonb_build_object('pack_key', v_o.pack_key));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_order_invoice_upload_retry(uuid) from public, anon;
grant execute on function ml_order_invoice_upload_retry(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- G) RPC de la UI
-- -----------------------------------------------------------------------------
-- Configuración de facturación de una cuenta (cualquier rol operativo lee;
-- la feature sólo hace falta para las reglas pro).
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
    'saved', v_set.id is not null,
    'features', jsonb_build_object(
      'billing', tenant_has_feature_for(v_tenant, 'mercadolibre_facturacion'),
      'perceptions', tenant_has_feature_for(v_tenant, 'percepciones_retenciones'),
      'arca', exists (select 1 from arca_settings s where s.tenant_id = v_tenant and s.enabled),
      'mercado_pago', tenant_has_feature_for(v_tenant, 'mercado_pago')),
    'emitter', jsonb_build_object('iva_condition', v_tax ->> 'iva_condition',
                                  'issues_m', coalesce((v_tax ->> 'issues_cbte_m')::boolean, false)),
    'store_pto_vta', (select s.afip_pos_number from ml_location_map m join stores s on s.id = m.store_id
                       where m.account_id = p_account and m.location_type = 'item_stock' limit 1));
end;
$$;
revoke all on function ml_billing_settings_get(uuid) from public, anon;
grant execute on function ml_billing_settings_get(uuid) to authenticated;

-- Guarda la configuración. Cuándo facturar y subir la factura: dueño o
-- encargado con `mercadolibre` (ADR-104). El resto exige
-- `mercadolibre_facturacion`; las percepciones, además,
-- `percepciones_retenciones`.
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

  select * into v_old from ml_billing_settings where account_id = p_account for update;
  if v_pro then
    insert into ml_billing_settings (tenant_id, account_id, pto_vta, concepto, pdf_format, upload_credit_notes, nc_on_refund,
                                     rules, perc_link_days, perc_on_expire, perc_message, updated_by)
    values (v_tenant, p_account,
            nullif(p ->> 'pto_vta', '')::int, nullif(p ->> 'concepto', '')::int,
            coalesce(nullif(p ->> 'pdf_format', ''), 'a4'),
            coalesce((p ->> 'upload_credit_notes')::boolean, false),
            coalesce(nullif(p ->> 'nc_on_refund', ''), 'review'),
            coalesce(v_rules, '{}'::jsonb),
            coalesce((p ->> 'perc_link_days')::int, 3),
            coalesce(nullif(p ->> 'perc_on_expire', ''), 'invoice_b'),
            nullif(btrim(coalesce(p ->> 'perc_message', '')), ''),
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

-- Bandeja: ventas por facturar, en espera de la percepción, a revisar, con
-- error y facturadas, con el plan, lo elegido, el comprobante, la subida y el
-- cobro de la percepción. p_filter: todo | por_facturar | percepcion |
-- revisar | error | facturadas | omitidas.
create or replace function ml_invoice_inbox(p_account uuid, p_filter text default 'todo', p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_billing_assert(false);
  v_out    jsonb;
  v_counts jsonb;
begin
  if not exists (select 1 from ml_accounts a where a.id = p_account and a.tenant_id = v_tenant) then
    raise exception 'not_found';
  end if;
  select jsonb_build_object(
           'por_facturar', count(*) filter (where p.status = 'ready'),
           'percepcion', count(*) filter (where p.status = 'hold_perception'),
           'revisar', count(*) filter (where p.status in ('needs_review', 'blocked')),
           'error', count(*) filter (where p.status = 'error'
                                       or exists (select 1 from ml_fiscal_uploads u
                                                   where u.fiscal_document_id = p.fiscal_document_id and u.status = 'error')),
           'facturadas', count(*) filter (where p.status in ('queued', 'approved')),
           'omitidas', count(*) filter (where p.status in ('skipped', 'cancelled')))
    into v_counts
    from ml_invoice_plans p
   where p.account_id = p_account and p.tenant_id = v_tenant;

  select coalesce(jsonb_agg(x order by x ->> 'created_at' desc), '[]'::jsonb) into v_out
    from (
      select jsonb_build_object(
               'id', p.id, 'pack_key', p.pack_key, 'sale_id', p.sale_id, 'status', p.status, 'warnings', p.warnings,
               'choice', p.choice, 'letter', p.letter, 'pto_vta', p.pto_vta, 'concepto', p.concepto,
               'pdf_format', p.pdf_format, 'perception_mode', p.perception_mode, 'last_error', p.last_error,
               'skip_reason', p.skip_reason, 'chosen_at', p.chosen_at, 'emitted_at', p.emitted_at,
               'created_at', p.created_at, 'plan', p.plan,
               'sale_number', (select s.number from sales s where s.id = p.sale_id),
               'orders', (select jsonb_agg(jsonb_build_object('ml_order_id', o.ml_order_id, 'status', o.status,
                                                              'buyer_nickname', o.buyer_nickname, 'date_created', o.date_created,
                                                              'total_amount', o.total_amount, 'fraud_risk', o.fraud_risk,
                                                              'needs_review', o.needs_review)
                                          order by o.ml_order_id)
                            from ml_orders o where o.account_id = p.account_id and o.pack_key = p.pack_key),
               'document', (select jsonb_build_object('id', d.id, 'status', d.status, 'letter', d.cbte_letter,
                                                      'pto_vta', d.pto_vta, 'nro', d.cbte_nro, 'cae', d.cae,
                                                      'error_code', d.last_error_code, 'error_msg', d.last_error_msg,
                                                      'total', d.imp_total)
                              from fiscal_documents d where d.id = p.fiscal_document_id),
               'documents', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'id', d.id, 'origin', d.origin, 'status', d.status, 'letter', d.cbte_letter,
                                   'cbte_tipo', d.cbte_tipo, 'pto_vta', d.pto_vta, 'nro', d.cbte_nro, 'total', d.imp_total,
                                   'upload', (select jsonb_build_object('id', u.id, 'sync', u.sync, 'status', u.status,
                                                                        'ml_doc_id', u.ml_doc_id, 'last_error', u.last_error,
                                                                        'uploaded_at', u.uploaded_at)
                                                from ml_fiscal_uploads u where u.fiscal_document_id = d.id))
                                   order by d.created_at), '[]'::jsonb)
                               from fiscal_documents d where d.sale_id = p.sale_id and p.sale_id is not null
                                and d.status <> 'cancelado'),
               'charge', (select jsonb_build_object('id', c.id, 'status', c.status, 'amount', c.amount,
                                                    'init_point', c.init_point, 'expires_at', c.expires_at,
                                                    'paid_at', c.paid_at, 'provider', c.provider,
                                                    'message_sent_at', c.message_sent_at, 'message_error', c.message_error)
                            from ml_perception_charges c where c.plan_id = p.id
                           order by c.created_at desc limit 1)) as x
        from ml_invoice_plans p
       where p.account_id = p_account and p.tenant_id = v_tenant
         and case coalesce(p_filter, 'todo')
               when 'por_facturar' then p.status = 'ready'
               when 'percepcion' then p.status = 'hold_perception'
               when 'revisar' then p.status in ('needs_review', 'blocked')
               when 'error' then p.status = 'error'
                                 or exists (select 1 from ml_fiscal_uploads u
                                             where u.fiscal_document_id = p.fiscal_document_id and u.status = 'error')
               when 'facturadas' then p.status in ('queued', 'approved')
               when 'omitidas' then p.status in ('skipped', 'cancelled')
               else true end
       order by p.created_at desc
       limit least(greatest(coalesce(p_limit, 100), 1), 300)
    ) t;
  return jsonb_build_object('counts', v_counts, 'rows', v_out);
end;
$$;
revoke all on function ml_invoice_inbox(uuid, text, integer) from public, anon;
grant execute on function ml_invoice_inbox(uuid, text, integer) to authenticated;

-- Elegir para una venta: receptor (datos del comprador o consumidor final),
-- letra (validada con la matriz de ARCA), punto de venta, concepto, formato
-- y si la percepción se cobra o se factura sin percibir.
create or replace function ml_invoice_choice_set(p_plan uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_billing_assert(true);
  v_p      ml_invoice_plans%rowtype;
  v_choice text;
  v_letter text;
  v_rec    jsonb;
  v_tax    jsonb;
  v_chk    text;
  v_cond   text;
  v_has    boolean;
  v_pmode  text;
  v_status text;
begin
  select * into v_p from ml_invoice_plans where id = p_plan and tenant_id = v_tenant for update;
  if v_p.id is null then raise exception 'not_found'; end if;
  if v_p.fiscal_document_id is not null or v_p.status in ('queued', 'approved', 'cancelled') then
    raise exception 'already_invoiced';
  end if;
  v_choice := coalesce(nullif(p ->> 'choice', ''), v_p.choice);
  if v_choice not in ('billing', 'consumidor_final') then raise exception 'invalid_choice'; end if;
  v_letter := case when p ? 'letter' then nullif(p ->> 'letter', '') else v_p.letter end;
  v_pmode := coalesce(nullif(p ->> 'perception_mode', ''), v_p.perception_mode);
  if v_pmode not in ('charge', 'skip') then raise exception 'invalid_perception_mode'; end if;
  v_rec := v_p.plan -> 'receptors' -> v_choice;
  v_cond := coalesce(nullif(v_rec ->> 'iva_condition', ''), 'consumidor_final');
  v_has := v_rec ->> 'doc_type' = 'cuit' and length(coalesce(v_rec ->> 'doc_number', '')) = 11 and cuit_is_valid(v_rec ->> 'doc_number');
  if v_letter is not null then
    v_tax := _tax_settings_eff(v_tenant);
    v_chk := cbte_letter_check(v_tax ->> 'iva_condition', v_cond, v_has,
                               coalesce((v_tax ->> 'issues_cbte_m')::boolean, false), v_letter);
    if v_chk is not null then raise exception 'letter_%', v_chk; end if;
  end if;
  if nullif(p ->> 'pto_vta', '') is not null and (p ->> 'pto_vta')::int not between 1 and 99998 then raise exception 'invalid_pto_vta'; end if;
  if nullif(p ->> 'concepto', '') is not null and (p ->> 'concepto')::int not in (1, 2, 3) then raise exception 'invalid_concepto'; end if;
  if nullif(p ->> 'pdf_format', '') is not null and p ->> 'pdf_format' not in ('a4', 'ticket') then raise exception 'invalid_pdf_format'; end if;

  -- Estado: con percepción pendiente sólo si es "datos del comprador" y se cobra.
  v_status := v_p.status;
  if v_status in ('ready', 'hold_perception', 'error') then
    v_status := case
      when v_choice = 'billing' and coalesce((v_p.plan -> 'perception' ->> 'applies')::boolean, false) and v_pmode = 'charge'
           and not exists (select 1 from ml_perception_charges c where c.plan_id = v_p.id and c.status in ('paid', 'paid_manual'))
        then 'hold_perception'
      else 'ready' end;
  end if;

  update ml_invoice_plans
     set choice = v_choice, letter = v_letter, perception_mode = v_pmode,
         pto_vta = case when p ? 'pto_vta' then nullif(p ->> 'pto_vta', '')::int else pto_vta end,
         concepto = case when p ? 'concepto' then nullif(p ->> 'concepto', '')::int else concepto end,
         pdf_format = case when p ? 'pdf_format' then nullif(p ->> 'pdf_format', '') else pdf_format end,
         status = v_status, chosen_by = auth.uid(), chosen_at = now(), last_error = null
   where id = v_p.id;
  perform _ml_orders_status_from_plan(v_p.id);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'ml_invoice_plans', v_p.id, 'ml_invoice_choice_set',
          jsonb_build_object('choice', v_p.choice, 'letter', v_p.letter, 'pto_vta', v_p.pto_vta, 'perception_mode', v_p.perception_mode),
          jsonb_build_object('choice', v_choice, 'letter', v_letter, 'pto_vta', p ->> 'pto_vta',
                             'perception_mode', v_pmode, 'reason', left(p ->> 'reason', 300)));
  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;
revoke all on function ml_invoice_choice_set(uuid, jsonb) from public, anon;
grant execute on function ml_invoice_choice_set(uuid, jsonb) to authenticated;

-- Emitir en lote (hasta 100). Cada una con su resultado; una que falla no
-- frena a las demás. Las "a revisar" se pueden emitir a mano (p_force).
create or replace function ml_invoice_emit_batch(p_plans uuid[], p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_billing_assert(true);
  v_id     uuid;
  v_res    jsonb;
  v_out    jsonb := '[]'::jsonb;
  v_ok     int := 0;
begin
  if coalesce(array_length(p_plans, 1), 0) = 0 then raise exception 'empty'; end if;
  if array_length(p_plans, 1) > 100 then raise exception 'too_many'; end if;
  perform assert_account_active(v_tenant);
  foreach v_id in array p_plans loop
    if not exists (select 1 from ml_invoice_plans p where p.id = v_id and p.tenant_id = v_tenant) then
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'ok', false, 'error', 'not_found'));
      continue;
    end if;
    if not p_force and exists (select 1 from ml_invoice_plans p where p.id = v_id and p.status in ('needs_review', 'blocked')) then
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'ok', false, 'error', 'needs_review'));
      continue;
    end if;
    begin
      v_res := _ml_invoice_emit(v_id, auth.uid(), true);
    exception when others then
      v_res := jsonb_build_object('ok', false, 'error', left(sqlerrm, 200));
    end;
    if coalesce((v_res ->> 'ok')::boolean, false) then v_ok := v_ok + 1; end if;
    v_out := v_out || jsonb_build_array(v_res || jsonb_build_object('id', v_id));
  end loop;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'ml_invoice_plans', null, 'ml_invoice_batch_emitted',
          jsonb_build_object('requested', array_length(p_plans, 1), 'ok', v_ok, 'force', p_force));
  return jsonb_build_object('ok', v_ok, 'results', v_out);
end;
$$;
revoke all on function ml_invoice_emit_batch(uuid[], boolean) from public, anon;
grant execute on function ml_invoice_emit_batch(uuid[], boolean) to authenticated;

-- No facturar estas ventas (o volver a ponerlas para facturar).
create or replace function ml_invoice_skip(p_plans uuid[], p_skip boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_billing_assert(true);
  v_n      int;
begin
  if coalesce(array_length(p_plans, 1), 0) = 0 or array_length(p_plans, 1) > 100 then raise exception 'invalid_selection'; end if;
  if p_skip then
    update ml_invoice_plans
       set status = 'skipped', skip_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Marcada para no facturar.'), 300),
           chosen_by = auth.uid(), chosen_at = now()
     where id = any (p_plans) and tenant_id = v_tenant and fiscal_document_id is null
       and status in ('ready', 'hold_perception', 'needs_review', 'blocked', 'error');
    get diagnostics v_n = row_count;
    update ml_orders o set invoice_status = 'not_applicable'
      from ml_invoice_plans p
     where p.id = any (p_plans) and p.tenant_id = v_tenant and p.status = 'skipped'
       and o.account_id = p.account_id and o.pack_key = p.pack_key and o.invoice_status in ('none', 'pending', 'hold', 'review');
  else
    update ml_invoice_plans
       set status = case when (plan ->> 'status') in ('ready', 'hold_perception', 'needs_review', 'blocked')
                         then plan ->> 'status' else 'needs_review' end,
           skip_reason = null, chosen_by = auth.uid(), chosen_at = now()
     where id = any (p_plans) and tenant_id = v_tenant and status = 'skipped' and fiscal_document_id is null;
    get diagnostics v_n = row_count;
    update ml_orders o set invoice_status = 'pending'
      from ml_invoice_plans p
     where p.id = any (p_plans) and p.tenant_id = v_tenant and p.status <> 'skipped'
       and o.account_id = p.account_id and o.pack_key = p.pack_key and o.invoice_status = 'not_applicable';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'ml_invoice_plans', null, case when p_skip then 'ml_invoice_skipped' else 'ml_invoice_unskipped' end,
          jsonb_build_object('plans', to_jsonb(p_plans), 'count', v_n, 'reason', left(p_reason, 300)));
  return jsonb_build_object('ok', true, 'count', v_n);
end;
$$;
revoke all on function ml_invoice_skip(uuid[], boolean, text) from public, anon;
grant execute on function ml_invoice_skip(uuid[], boolean, text) to authenticated;

-- Elegir qué comprobante se sube a la venta de ML: subir o no, subirlo ya y
-- reemplazar el que ya tenía la venta (DELETE + POST en el worker).
create or replace function ml_invoice_upload_set(p_doc uuid, p_sync boolean, p_now boolean default false,
                                                 p_replace boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_billing_assert(true);
  v_d      fiscal_documents%rowtype;
  v_o      ml_orders%rowtype;
  v_up     ml_fiscal_uploads%rowtype;
  v_prev   text;
begin
  select * into v_d from fiscal_documents where id = p_doc and tenant_id = v_tenant;
  if v_d.id is null then raise exception 'not_found'; end if;
  select * into v_o from ml_orders o where o.sale_id = v_d.sale_id and o.tenant_id = v_tenant limit 1;
  if v_o.id is null then raise exception 'not_ml_sale'; end if;
  insert into ml_fiscal_uploads (tenant_id, account_id, pack_key, fiscal_document_id, kind, sync, status)
  values (v_tenant, v_o.account_id, v_o.pack_key, v_d.id, case when v_d.origin = 'sale' then 'factura' else 'nota_credito' end,
          p_sync, 'pending')
  on conflict (fiscal_document_id) do update set sync = excluded.sync
  returning * into v_up;
  if not p_sync then
    update ml_fiscal_uploads set status = 'skipped' where id = v_up.id and status in ('pending', 'error');
  elsif p_now then
    if v_d.status <> 'aprobado' then raise exception 'invoice_not_approved'; end if;
    if p_replace then
      select u.ml_doc_id into v_prev from ml_fiscal_uploads u
       where u.account_id = v_o.account_id and u.pack_key = v_o.pack_key and u.kind = v_up.kind
         and u.status = 'uploaded' and u.ml_doc_id is not null
       order by u.uploaded_at desc nulls last limit 1;
    end if;
    perform _ml_enqueue(v_tenant, v_o.account_id, 'invoice_upload', 'invoice_upload:' || v_d.id::text, v_o.pack_key,
                        jsonb_build_object('fiscal_document_id', v_d.id, 'pack_key', v_o.pack_key, 'sale_id', v_d.sale_id,
                                           'replace_ml_id', v_prev), 0, auth.uid());
    update ml_fiscal_uploads set status = 'queued', last_error = null where id = v_up.id;
  elsif v_d.status = 'aprobado' and v_up.status in ('pending', 'skipped') then
    perform _ml_enqueue(v_tenant, v_o.account_id, 'invoice_upload', 'invoice_upload:' || v_d.id::text, v_o.pack_key,
                        jsonb_build_object('fiscal_document_id', v_d.id, 'pack_key', v_o.pack_key, 'sale_id', v_d.sale_id),
                        0, auth.uid());
    update ml_fiscal_uploads set status = 'queued', last_error = null where id = v_up.id;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'fiscal_documents', v_d.id, 'ml_invoice_upload_set',
          jsonb_build_object('sync', p_sync, 'now', p_now, 'replace', p_replace, 'replaced_ml_id', v_prev,
                             'pack_key', v_o.pack_key));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_invoice_upload_set(uuid, boolean, boolean, boolean) from public, anon;
grant execute on function ml_invoice_upload_set(uuid, boolean, boolean, boolean) to authenticated;

-- Nota de crédito por el total de la factura (reintegro total en ML que no
-- anula la venta). Con anulación o cancelación, ARCA ya la emite sola.
create or replace function ml_invoice_credit_note(p_plan uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_billing_assert(true);
  v_p      ml_invoice_plans%rowtype;
  v_nc     uuid;
begin
  select * into v_p from ml_invoice_plans where id = p_plan and tenant_id = v_tenant;
  if v_p.id is null then raise exception 'not_found'; end if;
  if v_p.sale_id is null or not exists (select 1 from fiscal_documents d where d.sale_id = v_p.sale_id
                                                                         and d.origin = 'sale' and d.status = 'aprobado') then
    raise exception 'invoice_not_approved';
  end if;
  if exists (select 1 from fiscal_documents d where d.sale_id = v_p.sale_id and d.origin = 'void' and d.status <> 'cancelado') then
    raise exception 'credit_note_exists';
  end if;
  v_nc := arca_enqueue_void_nc(v_p.sale_id);
  if v_nc is null then raise exception 'credit_note_not_enqueued'; end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'fiscal_documents', v_nc, 'ml_credit_note_enqueued',
          jsonb_build_object('pack_key', v_p.pack_key, 'sale_id', v_p.sale_id, 'reason', left(p_reason, 300)));
  return jsonb_build_object('ok', true, 'document_id', v_nc);
end;
$$;
revoke all on function ml_invoice_credit_note(uuid, text) from public, anon;
grant execute on function ml_invoice_credit_note(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- H) Percepciones: link, pago, a mano y vencimiento
-- -----------------------------------------------------------------------------
-- Edge ml_facturacion: registra el link de pago creado (intent de Mercado
-- Pago ya guardado por la Edge) y lo deja esperando el pago.
create or replace function ml_perception_charge_create(p_plan uuid, p_user uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p   ml_invoice_plans%rowtype;
  v_set ml_billing_settings%rowtype;
  v_amt numeric;
  v_id  uuid;
begin
  select * into v_p from ml_invoice_plans where id = p_plan for update;
  if v_p.id is null then raise exception 'not_found'; end if;
  if v_p.fiscal_document_id is not null then raise exception 'already_invoiced'; end if;
  if not coalesce((v_p.plan -> 'perception' ->> 'applies')::boolean, false) then raise exception 'no_perception'; end if;
  v_amt := round((v_p.plan -> 'perception' ->> 'total')::numeric, 2);
  if v_amt is null or v_amt <= 0 then raise exception 'no_perception'; end if;
  if abs(v_amt - coalesce((p ->> 'amount')::numeric, -1)) > 0.01 then raise exception 'amount_mismatch'; end if;
  v_set := _ml_billing_settings(v_p.account_id);
  -- Un link vivo por venta: el anterior queda cancelado.
  update ml_perception_charges set status = 'cancelled' where plan_id = v_p.id and status = 'link_sent';
  insert into ml_perception_charges (tenant_id, account_id, plan_id, pack_key, amount, detail, status, provider, intent_id,
                                     init_point, expires_at, message, created_by)
  values (v_p.tenant_id, v_p.account_id, v_p.id, v_p.pack_key, v_amt, coalesce(v_p.plan -> 'perception' -> 'lines', '[]'::jsonb),
          'link_sent', 'mercadopago', nullif(p ->> 'intent_id', '')::uuid, left(p ->> 'init_point', 1000),
          now() + make_interval(days => v_set.perc_link_days), left(p ->> 'message', 3500), p_user)
  returning id into v_id;
  update ml_invoice_plans set status = 'hold_perception', choice = 'billing', perception_mode = 'charge'
   where id = v_p.id and status in ('ready', 'hold_perception', 'needs_review', 'error');
  perform _ml_orders_status_from_plan(v_p.id);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_p.tenant_id, p_user, 'ml_perception_charges', v_id, 'ml_perception_link_created',
          jsonb_build_object('pack_key', v_p.pack_key, 'amount', v_amt, 'intent_id', p ->> 'intent_id'));
  return jsonb_build_object('ok', true, 'charge_id', v_id, 'amount', v_amt);
end;
$$;
revoke all on function ml_perception_charge_create(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_perception_charge_create(uuid, uuid, jsonb) to service_role;

create or replace function ml_perception_message_sent(p_charge uuid, p_ok boolean, p_error text default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update ml_perception_charges
     set message_sent_at = case when p_ok then now() else message_sent_at end,
         message_error = case when p_ok then null else left(p_error, 300) end
   where id = p_charge;
$$;
revoke all on function ml_perception_message_sent(uuid, boolean, text) from public, anon, authenticated;
grant execute on function ml_perception_message_sent(uuid, boolean, text) to service_role;

-- Percepción pagada: el plan queda listo y, si el modo de la cuenta lo
-- permite, se emite la factura A con la percepción.
create or replace function _ml_perception_paid(p_charge uuid, p_status text, p_ref text, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c ml_perception_charges%rowtype;
begin
  select * into v_c from ml_perception_charges where id = p_charge for update;
  if v_c.id is null then return; end if;
  if v_c.status in ('expired', 'cancelled') and p_status = 'paid' then
    -- Pagó tarde (o después de cancelar): no se factura sola, queda para revisar.
    update ml_perception_charges set status = 'paid_late', paid_at = now(), payment_ref = left(p_ref, 120) where id = v_c.id;
    update ml_invoice_plans set warnings = array_append(array_remove(warnings, 'perception_paid_late'), 'perception_paid_late')
     where id = v_c.plan_id;
    return;
  end if;
  if v_c.status <> 'link_sent' then return; end if;
  update ml_perception_charges set status = p_status, paid_at = now(), payment_ref = left(p_ref, 120) where id = v_c.id;
  update ml_invoice_plans set status = 'ready', choice = 'billing', perception_mode = 'charge'
   where id = v_c.plan_id and status = 'hold_perception';
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_c.tenant_id, p_user, 'ml_perception_charges', v_c.id, 'ml_perception_paid',
          jsonb_build_object('pack_key', v_c.pack_key, 'amount', v_c.amount, 'status', p_status, 'ref', p_ref));
  perform _ml_invoice_auto(v_c.plan_id);
end;
$$;
revoke all on function _ml_perception_paid(uuid, text, text, uuid) from public, anon, authenticated;

-- El link se pagó (mp_webhook marca el intent aprobado; mismo patrón que los
-- cobros en espera, ADR-048).
create or replace function trg_ml_perception_on_intent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if new.status is distinct from old.status and new.status = 'approved' then
    select c.id into v_id from ml_perception_charges c where c.intent_id = new.id limit 1;
    if v_id is not null then
      begin
        perform _ml_perception_paid(v_id, 'paid', coalesce(new.mp_payment_id, new.id::text), null);
      exception when others then
        raise warning 'trg_ml_perception_on_intent: %', sqlerrm;
      end;
    end if;
  end if;
  return null;
end;
$$;
revoke all on function trg_ml_perception_on_intent() from public, anon, authenticated;
drop trigger if exists ml_perception_on_intent on mp_payment_intents;
create trigger ml_perception_on_intent
  after update of status on mp_payment_intents
  for each row execute function trg_ml_perception_on_intent();

-- Cobrada por otro medio (transferencia): dueño o encargado, con referencia.
create or replace function ml_perception_mark_paid(p_plan uuid, p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_billing_assert(true);
  v_p      ml_invoice_plans%rowtype;
  v_c      uuid;
  v_amt    numeric;
begin
  if char_length(btrim(coalesce(p_reference, ''))) < 3 then raise exception 'reference_required'; end if;
  select * into v_p from ml_invoice_plans where id = p_plan and tenant_id = v_tenant for update;
  if v_p.id is null then raise exception 'not_found'; end if;
  if v_p.fiscal_document_id is not null then raise exception 'already_invoiced'; end if;
  v_amt := round((v_p.plan -> 'perception' ->> 'total')::numeric, 2);
  if not coalesce((v_p.plan -> 'perception' ->> 'applies')::boolean, false) or coalesce(v_amt, 0) <= 0 then
    raise exception 'no_perception';
  end if;
  select c.id into v_c from ml_perception_charges c where c.plan_id = v_p.id and c.status = 'link_sent' limit 1;
  if v_c is null then
    insert into ml_perception_charges (tenant_id, account_id, plan_id, pack_key, amount, detail, status, provider, created_by)
    values (v_tenant, v_p.account_id, v_p.id, v_p.pack_key, v_amt, coalesce(v_p.plan -> 'perception' -> 'lines', '[]'::jsonb),
            'link_sent', 'manual', auth.uid())
    returning id into v_c;
  else
    update ml_perception_charges set provider = 'manual' where id = v_c;
  end if;
  perform _ml_perception_paid(v_c, 'paid_manual', btrim(p_reference), auth.uid());
  return jsonb_build_object('ok', true, 'charge_id', v_c);
end;
$$;
revoke all on function ml_perception_mark_paid(uuid, text) from public, anon;
grant execute on function ml_perception_mark_paid(uuid, text) to authenticated;

-- Cancelar el link (el comprador no quiere factura A): factura B, A sin
-- percibir o queda a revisar.
create or replace function ml_perception_cancel(p_plan uuid, p_then text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_billing_assert(true);
  v_p      ml_invoice_plans%rowtype;
begin
  if p_then not in ('invoice_b', 'invoice_a', 'hold') then raise exception 'invalid_option'; end if;
  select * into v_p from ml_invoice_plans where id = p_plan and tenant_id = v_tenant for update;
  if v_p.id is null then raise exception 'not_found'; end if;
  if v_p.fiscal_document_id is not null then raise exception 'already_invoiced'; end if;
  update ml_perception_charges set status = 'cancelled' where plan_id = v_p.id and status = 'link_sent';
  update ml_invoice_plans
     set choice = case when p_then = 'invoice_b' then 'consumidor_final' else choice end,
         perception_mode = case when p_then = 'invoice_a' then 'skip' else perception_mode end,
         status = case when p_then = 'hold' then 'needs_review' else 'ready' end,
         chosen_by = auth.uid(), chosen_at = now()
   where id = v_p.id;
  perform _ml_orders_status_from_plan(v_p.id);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'ml_invoice_plans', v_p.id, 'ml_perception_cancelled',
          jsonb_build_object('pack_key', v_p.pack_key, 'then', p_then));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_perception_cancel(uuid, text) from public, anon;
grant execute on function ml_perception_cancel(uuid, text) to authenticated;

-- Vencimiento de los links (cron cada 30 minutos): según la cuenta, factura
-- B sin percepción, A sin percibir o queda a revisar. El link de Mercado Pago
-- no se borra: si se paga tarde queda "pagó tarde" para revisar.
create or replace function ml_perception_expire_due()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r    record;
  v_n  int := 0;
  v_on text;
begin
  for r in
    select c.id, c.plan_id, c.account_id, c.tenant_id, c.pack_key from ml_perception_charges c
     where c.status = 'link_sent' and c.provider = 'mercadopago' and c.expires_at <= now()
     order by c.expires_at limit 200
  loop
    v_on := (_ml_billing_settings(r.account_id)).perc_on_expire;
    update ml_perception_charges set status = 'expired' where id = r.id and status = 'link_sent';
    update ml_invoice_plans
       set choice = case when v_on = 'invoice_b' then 'consumidor_final' else choice end,
           perception_mode = case when v_on = 'invoice_a' then 'skip' else perception_mode end,
           status = case when v_on = 'hold' then 'needs_review' else 'ready' end,
           warnings = array_append(array_remove(warnings, 'perception_expired'), 'perception_expired')
     where id = r.plan_id and status = 'hold_perception';
    perform _ml_orders_status_from_plan(r.plan_id);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (r.tenant_id, null, 'ml_perception_charges', r.id, 'ml_perception_expired',
            jsonb_build_object('pack_key', r.pack_key, 'then', v_on));
    if v_on <> 'hold' then perform _ml_invoice_auto(r.plan_id); end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function ml_perception_expire_due() from public, anon, authenticated;
grant execute on function ml_perception_expire_due() to service_role;

-- -----------------------------------------------------------------------------
-- I) Reintegro total en un reclamo (ADR-132): nota de crédito
-- -----------------------------------------------------------------------------
create or replace function trg_ml_claim_refund_nc()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p   ml_invoice_plans%rowtype;
  v_set ml_billing_settings%rowtype;
  v_nc  uuid;
begin
  if new.resolution_result is distinct from 'reintegro' or new.pack_key is null
     or (tg_op = 'UPDATE' and old.resolution_result is not distinct from new.resolution_result) then
    return null;
  end if;
  begin
    select * into v_p from ml_invoice_plans p where p.account_id = new.account_id and p.pack_key = new.pack_key;
    if v_p.id is null or v_p.sale_id is null
       or not exists (select 1 from fiscal_documents d where d.sale_id = v_p.sale_id and d.origin = 'sale' and d.status = 'aprobado')
       or exists (select 1 from fiscal_documents d where d.sale_id = v_p.sale_id and d.origin in ('void', 'return')
                                                    and d.status <> 'cancelado') then
      return null;
    end if;
    v_set := _ml_billing_settings(new.account_id);
    if v_set.nc_on_refund = 'auto' then
      v_nc := arca_enqueue_void_nc(v_p.sale_id);
      update ml_orders set needs_review = 'Reintegro en Mercado Libre: salió la nota de crédito. Si el producto vuelve, ajustá el stock.'
       where account_id = new.account_id and pack_key = new.pack_key;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (new.tenant_id, null, 'fiscal_documents', v_nc, 'ml_credit_note_enqueued',
              jsonb_build_object('pack_key', new.pack_key, 'claim_id', new.claim_id, 'auto', true));
    else
      update ml_invoice_plans set warnings = array_append(array_remove(warnings, 'refund_review'), 'refund_review')
       where id = v_p.id;
      update ml_orders set needs_review = 'Reintegro en Mercado Libre: revisá si corresponde la nota de crédito (Facturación).'
       where account_id = new.account_id and pack_key = new.pack_key;
    end if;
  exception when others then
    raise warning 'trg_ml_claim_refund_nc: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function trg_ml_claim_refund_nc() from public, anon, authenticated;
drop trigger if exists ml_claim_refund_nc on ml_claims;
create trigger ml_claim_refund_nc
  after insert or update of resolution_result on ml_claims
  for each row execute function trg_ml_claim_refund_nc();
