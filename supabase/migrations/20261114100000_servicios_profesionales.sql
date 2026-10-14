-- =============================================================================
-- 20261114100000_servicios_profesionales.sql  (ADR-116)
--
-- Servicios profesionales: un estudio (bromatología, contable, técnico) carga
-- sus servicios en "Productos" (que pasa a decir "Servicios"), factura un
-- trabajo con aclaraciones por renglón y la factura de ARCA sale con concepto
-- 2 (servicios) o 3 (productos y servicios), período del servicio y
-- vencimiento del pago.
--
-- Clasificación (CLAUDE.md §6): FLAG-OPERATIVO. Sin key nueva en `features`:
--   · catalog_mode es una elección del dueño según su rubro (vocabulario y
--     campos del editor), como dining_enabled o scale_enabled.
--   · Detalle, aclaraciones y período del servicio son datos que exige la
--     factura de servicios (RG 4291 / WSFEv1): no se pueden cobrar aparte.
--   · Las aclaraciones predefinidas son plantillas de texto del negocio.
--
-- A) pos_settings.catalog_mode: 'productos' | 'servicios' | 'mixto'. null =
--    según el rubro (tenants.industry = 'servicios' → 'servicios'). Lo lee la
--    UI (lib/catalog/mode.ts); el servidor no depende de él.
-- B) products: invoice_detail (descripción ampliada que viaja a la factura) y
--    service_clarification_ids (aclaraciones predefinidas que se suman solas
--    al venderlo). products.is_service (ADR-068) es el tipo de ítem
--    "servicio": un trigger lo deja SIN stock (track_stock = false). La unidad
--    del servicio (hora, visita, informe, análisis, muestra, mes) usa
--    products.unit, la alícuota products.tax_rate_code y el código interno
--    products.sku.
-- C) service_clarifications: plantillas de aclaración por negocio. tenant_id,
--    RLS con (select current_tenant_id()), escritura dueño/encargado, baja
--    lógica (sin DELETE) y auditoría por trigger.
-- D) sale_items: line_detail, line_note, line_clarifications y unit_label
--    (fotos del renglón: la factura no cambia si después se edita el
--    servicio o la plantilla). sales: service_from, service_to, payment_due.
-- E) _sale_apply_service: completa esos datos dentro de create_sale.
-- F) create_sale: copia COMPLETA de la definición más nueva
--    (20261109500000_create_sale_reservas_garantia, ADR-096, verificado con
--    grep sobre todas las migraciones) más el parámetro opcional p_service
--    (jsonb, default null) al final. Lo agregado va entre "-- ADR-116 >>>" y
--    "-- <<< ADR-116" o en líneas marcadas ADR-116 (tests/unit/
--    serviciosProfesionales.test.ts lo compara). Las llamadas existentes
--    (POS, offline, cobros en espera, pausadas) siguen iguales: sin
--    p_service, una venta con servicios toma la fecha de la venta como
--    período y vencimiento (lo mismo que mandaba la cola fiscal antes).
-- G) arca_snapshot: misma foto + service_from, service_to y payment_due de
--    la venta. La cola fiscal (supabase/functions/_shared/arca/worker.ts) los
--    manda como FchServDesde, FchServHasta y FchVtoPago (antes iba siempre la
--    fecha del comprobante).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Modo del catálogo (FLAG-OPERATIVO del dueño)
-- -----------------------------------------------------------------------------
alter table pos_settings add column if not exists catalog_mode text;
alter table pos_settings drop constraint if exists pos_settings_catalog_mode_chk;
alter table pos_settings add constraint pos_settings_catalog_mode_chk
  check (catalog_mode is null or catalog_mode in ('productos', 'servicios', 'mixto'));
comment on column pos_settings.catalog_mode is
  'ADR-116: qué vende el negocio (vocabulario y campos del catálogo): productos, servicios o mixto. null = según tenants.industry.';

-- -----------------------------------------------------------------------------
-- B) Servicio como ítem del catálogo
-- -----------------------------------------------------------------------------
alter table products
  add column if not exists invoice_detail text,
  add column if not exists service_clarification_ids uuid[] not null default '{}';

alter table products drop constraint if exists products_invoice_detail_len;
alter table products add constraint products_invoice_detail_len
  check (invoice_detail is null or char_length(invoice_detail) <= 2000) not valid;
alter table products drop constraint if exists products_service_clarifications_max;
alter table products add constraint products_service_clarifications_max
  check (cardinality(service_clarification_ids) <= 20) not valid;

comment on column products.invoice_detail is
  'ADR-116: descripción ampliada del servicio que se copia al renglón de la venta y sale en la factura debajo del nombre.';
comment on column products.service_clarification_ids is
  'ADR-116: aclaraciones predefinidas (service_clarifications) que se suman solas al vender el servicio.';

-- Un servicio no lleva stock: create_sale sólo descuenta con track_stock.
create or replace function _products_service_no_stock()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.is_service, false) then
    new.track_stock := false;
  end if;
  return new;
end;
$$;
revoke all on function _products_service_no_stock() from public, anon, authenticated;

drop trigger if exists products_service_no_stock on products;
create trigger products_service_no_stock
  before insert or update of is_service, track_stock on products
  for each row execute function _products_service_no_stock();

-- -----------------------------------------------------------------------------
-- C) Aclaraciones predefinidas
-- -----------------------------------------------------------------------------
create table if not exists service_clarifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  title       text not null check (char_length(btrim(title)) between 1 and 80),
  body        text not null check (char_length(btrim(body)) between 1 and 1000),
  sort        int not null default 0 check (sort between 0 and 9999),
  is_active   boolean not null default true,
  created_by  uuid default auth.uid() references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists service_clarifications_tenant_sort_idx
  on service_clarifications (tenant_id, sort, created_at) where deleted_at is null;
create index if not exists service_clarifications_tenant_created_idx
  on service_clarifications (tenant_id, created_at desc);
create index if not exists service_clarifications_created_by_idx
  on service_clarifications (created_by) where created_by is not null;

drop trigger if exists set_updated_at_service_clarifications on service_clarifications;
create trigger set_updated_at_service_clarifications
  before update on service_clarifications
  for each row execute function set_updated_at();

alter table service_clarifications enable row level security;
drop policy if exists service_clarifications_select on service_clarifications;
create policy service_clarifications_select on service_clarifications
  for select using (tenant_id = (select current_tenant_id()));
drop policy if exists service_clarifications_insert on service_clarifications;
create policy service_clarifications_insert on service_clarifications
  for insert with check (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
drop policy if exists service_clarifications_update on service_clarifications;
create policy service_clarifications_update on service_clarifications
  for update using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))
  with check (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
-- Sin DELETE: baja lógica con deleted_at (los renglones vendidos guardan su texto).
revoke delete on service_clarifications from anon, authenticated;

drop trigger if exists role_write_guard on service_clarifications;
create trigger role_write_guard before insert or update or delete on service_clarifications
  for each row execute function trg_role_write_guard('manage');

create or replace function _service_clarifications_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (new.tenant_id, auth.uid(), 'service_clarification', new.id,
          case
            when tg_op = 'INSERT' then 'service_clarification_created'
            when new.deleted_at is not null and old.deleted_at is null then 'service_clarification_deleted'
            else 'service_clarification_updated'
          end,
          case when tg_op = 'UPDATE' then
            jsonb_build_object('title', old.title, 'body', old.body, 'is_active', old.is_active, 'sort', old.sort)
          end,
          jsonb_build_object('title', new.title, 'body', new.body, 'is_active', new.is_active, 'sort', new.sort,
                             'deleted', new.deleted_at is not null));
  return null;
end;
$$;
revoke all on function _service_clarifications_audit() from public, anon, authenticated;

drop trigger if exists service_clarifications_audit on service_clarifications;
create trigger service_clarifications_audit
  after insert or update on service_clarifications
  for each row execute function _service_clarifications_audit();

comment on table service_clarifications is
  'ADR-116: aclaraciones predefinidas de servicios ("Incluye toma de muestras", "Normativa CAA art. X"). Se eligen por renglón al facturar; el renglón guarda el texto.';

-- -----------------------------------------------------------------------------
-- D) Fotos del renglón y datos del servicio en la venta
-- -----------------------------------------------------------------------------
alter table sale_items
  add column if not exists line_detail         text,
  add column if not exists line_note           text,
  add column if not exists line_clarifications text[],
  add column if not exists unit_label          text;

alter table sale_items drop constraint if exists sale_items_service_text_len;
alter table sale_items add constraint sale_items_service_text_len
  check ((line_detail is null or char_length(line_detail) <= 2000)
         and (line_note is null or char_length(line_note) <= 1000)
         and (line_clarifications is null or cardinality(line_clarifications) <= 20)
         and (unit_label is null or char_length(unit_label) <= 20)) not valid;

comment on column sale_items.line_detail is 'ADR-116: descripción ampliada del servicio al venderlo (sale en la factura).';
comment on column sale_items.line_note is 'ADR-116: aclaración libre del renglón (lote, dirección del relevamiento, N° de muestra, normativa).';
comment on column sale_items.line_clarifications is 'ADR-116: textos de las aclaraciones predefinidas elegidas para el renglón.';
comment on column sale_items.unit_label is 'ADR-116: unidad del servicio al venderlo (hora, visita, informe, unidad). Sólo en renglones de servicio: null = producto.';

alter table sales
  add column if not exists service_from date,
  add column if not exists service_to   date,
  add column if not exists payment_due  date;

alter table sales drop constraint if exists sales_service_period_chk;
alter table sales add constraint sales_service_period_chk
  check (service_from is null or service_to is null or service_from <= service_to) not valid;

comment on column sales.service_from is 'ADR-116: período del servicio facturado, desde (FchServDesde de ARCA). null = sin servicios.';
comment on column sales.service_to is 'ADR-116: período del servicio facturado, hasta (FchServHasta de ARCA).';
comment on column sales.payment_due is 'ADR-116: vencimiento del pago de la factura de servicios (FchVtoPago de ARCA).';

-- -----------------------------------------------------------------------------
-- E) Datos de servicio de la venta (lo llama create_sale; no es una RPC)
--
-- p_items: los de create_sale. Por renglón (opcionales):
--   line_note          text   aclaración libre (cualquier renglón).
--   line_detail        text   descripción ampliada (servicios). Sin la clave,
--                             la del servicio (products.invoice_detail).
--   clarification_ids  uuid[] aclaraciones predefinidas elegidas (servicios).
--                             Sin la clave, las del servicio.
-- p_line_ids: ids de sale_items en el mismo orden que p_items (v_line_ids).
-- p_service: {from, to, due} en AAAA-MM-DD (opcional). Con servicios en la
--   venta: from y to por defecto la fecha de la venta; due por defecto la
--   fecha de la venta y nunca antes que ella (ARCA no acepta un vencimiento
--   anterior al comprobante).
-- -----------------------------------------------------------------------------
create or replace function _sale_apply_service(
  p_tenant    uuid,
  p_sale      uuid,
  p_items     jsonb,
  p_line_ids  uuid[],
  p_service   jsonb,
  p_sale_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_i        int;
  v_it       jsonb;
  v_is_srv   boolean;
  v_unit     text;
  v_pdetail  text;
  v_pcl      uuid[];
  v_detail   text;
  v_note     text;
  v_ids      uuid[];
  v_cl       text[];
  v_has_srv  boolean := false;
  v_lines    int := 0;
  v_from     date;
  v_to       date;
  v_due      date;
  v_day      date := coalesce(p_sale_date, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return null;
  end if;
  if p_service is not null and jsonb_typeof(p_service) <> 'object' then
    raise exception 'service_period_invalid';
  end if;

  for v_i in 1 .. coalesce(array_length(p_line_ids, 1), 0) loop
    v_it := p_items -> (v_i - 1);
    continue when v_it is null or jsonb_typeof(v_it) <> 'object' or p_line_ids[v_i] is null;

    v_is_srv := false;
    v_unit := null;
    v_pdetail := null;
    v_pcl := '{}';
    if coalesce(v_it ->> 'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select coalesce(p.is_service, false), p.unit, p.invoice_detail, coalesce(p.service_clarification_ids, '{}')
        into v_is_srv, v_unit, v_pdetail, v_pcl
        from products p
       where p.id = (v_it ->> 'product_id')::uuid and p.tenant_id = p_tenant;
      v_is_srv := coalesce(v_is_srv, false);
    end if;

    v_note := left(nullif(btrim(coalesce(v_it ->> 'line_note', '')), ''), 1000);
    v_detail := null;
    v_cl := '{}';
    if v_is_srv then
      v_has_srv := true;
      v_detail := left(nullif(btrim(coalesce(
        case when v_it ? 'line_detail' then v_it ->> 'line_detail' else v_pdetail end, '')), ''), 2000);
      if jsonb_typeof(v_it -> 'clarification_ids') = 'array' then
        v_ids := array(
          select (e.v #>> '{}')::uuid
            from jsonb_array_elements(v_it -> 'clarification_ids') with ordinality as e(v, o)
           where jsonb_typeof(e.v) = 'string'
             and (e.v #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           order by e.o
           limit 20);
      else
        v_ids := v_pcl;
      end if;
      v_cl := array(
        select c.body
          from unnest(v_ids) with ordinality as u(id, o)
          join service_clarifications c
            on c.id = u.id and c.tenant_id = p_tenant and c.deleted_at is null and c.is_active
         order by u.o
         limit 20);
    end if;

    if v_is_srv or v_note is not null then
      update sale_items
         set line_detail = v_detail,
             line_note = v_note,
             line_clarifications = case when cardinality(v_cl) > 0 then v_cl else null end,
             -- Siempre en los renglones de servicio (marca el renglón como
             -- servicio en el comprobante); null en los productos.
             unit_label = case when not v_is_srv then null
                               when coalesce(btrim(v_unit), '') in ('', 'un') then 'unidad'
                               else left(btrim(v_unit), 20) end
       where id = p_line_ids[v_i] and tenant_id = p_tenant;
      v_lines := v_lines + 1;
    end if;
  end loop;

  if not v_has_srv then
    return case when v_lines > 0 then jsonb_build_object('lines', v_lines) else null end;
  end if;

  begin
    v_from := nullif(btrim(coalesce(p_service ->> 'from', '')), '')::date;
    v_to   := nullif(btrim(coalesce(p_service ->> 'to', '')), '')::date;
    v_due  := nullif(btrim(coalesce(p_service ->> 'due', '')), '')::date;
  exception when others then
    raise exception 'service_period_invalid';
  end;
  v_from := coalesce(v_from, v_to, v_day);
  v_to := coalesce(v_to, greatest(v_from, v_day));
  if v_to < v_from or v_from < v_day - 3660 or v_to > v_day + 3660 then
    raise exception 'service_period_invalid';
  end if;
  v_due := coalesce(v_due, v_day);
  if v_due < v_day or v_due > v_day + 3660 then
    raise exception 'service_due_invalid';
  end if;

  update sales
     set service_from = v_from, service_to = v_to, payment_due = v_due
   where id = p_sale and tenant_id = p_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, auth.uid(), 'sales', p_sale, 'sale_service_billed',
          jsonb_build_object('service_from', v_from, 'service_to', v_to, 'payment_due', v_due,
                             'lines', v_lines));

  return jsonb_build_object('lines', v_lines, 'service_from', v_from, 'service_to', v_to, 'payment_due', v_due);
end;
$$;
revoke all on function _sale_apply_service(uuid, uuid, jsonb, uuid[], jsonb, date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- F) create_sale (copia completa de ADR-096 + p_service y bloques ADR-116)
--
-- La firma cambia (un parámetro opcional más): se borra la anterior para que
-- no queden dos sobrecargas (PostgREST y las llamadas por nombre la
-- resolverían de forma ambigua). Las llamadas con los 13 parámetros de antes,
-- por nombre o por posición, resuelven a esta.
-- -----------------------------------------------------------------------------
drop function if exists public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid);

create or replace function public.create_sale(p_items jsonb, p_payments jsonb, p_discount_total numeric DEFAULT 0, p_customer_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_extras jsonb DEFAULT '[]'::jsonb, p_table_order_id uuid DEFAULT NULL::uuid, p_delivery_order_id uuid DEFAULT NULL::uuid, p_promo_discount numeric DEFAULT 0, p_promo_id uuid DEFAULT NULL::uuid, p_promo_name text DEFAULT NULL::text, p_coupon_id uuid DEFAULT NULL::uuid, p_cash_shift_id uuid DEFAULT NULL::uuid, p_service jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant   uuid := current_tenant_id();
  v_store    uuid;
  v_shift    uuid;
  v_number   bigint;
  v_subtotal numeric := 0;
  v_total    numeric;
  v_total_pre numeric;
  v_paid     numeric := 0;
  v_sale_id  uuid;
  v_item     record;
  v_pay      record;
  v_comp     record;
  v_pname    text;
  v_psku     text;
  v_is_kit   boolean;
  v_track    boolean;
  v_has_variants boolean;
  v_variant  record;
  v_serial   text;
  v_role     text;
  v_max_disc numeric := 100;
  v_round    numeric := 0;
  v_allow_neg boolean := true;
  -- F17 · H92/H94 (ADR-049): settings efectivos y stock por sucursal.
  v_reg        uuid;
  v_eff        jsonb;
  v_branch_stk boolean := false;
  v_disc_pct numeric;
  v_pallow   boolean;
  v_stock    numeric;
  v_sc_total numeric := 0;
  v_sc_bal   numeric;
  v_pay_feat text;
  v_line_disc numeric := 0;
  v_warranty_prima numeric := 0;
  v_tip_amount numeric := 0;
  v_tip_method text;
  v_professional uuid;
  v_pack     record;
  v_pcredit  record;
  v_pk       service_packs%rowtype;
  v_has_pack_session boolean := false;
  v_table_order table_orders%rowtype;
  v_delivery_order delivery_orders%rowtype;
  v_delivery_fee numeric := 0;
  v_intent   record;
  v_qr_ref   uuid;
  v_qr_sum   numeric;
  v_qr_plain boolean := false;
  v_promo_disc numeric := 0;
  v_coupon_disc numeric := 0;
  v_coupon   coupons%rowtype;
  -- F18 · H100 (ADR-056): precio autoritativo.
  v_pc          boolean := coalesce(current_setting('ninja.pc_complete', true), '') <> '';
  v_i           int;
  v_j           jsonb;
  v_pid         uuid;
  v_vid         uuid;
  v_qty         numeric;
  v_up          numeric;
  v_ldisc       numeric;
  v_exp         numeric;
  v_ok          boolean;
  v_amt         numeric;
  v_k           int;
  v_reason      text;
  v_dev         numeric;
  v_max_dev     numeric := 0;
  v_pool_extra  numeric[] := '{}';
  v_pool_pack   numeric[] := '{}';
  v_pool_order  numeric[] := '{}';
  v_pack_creds  text[] := '{}';
  v_prices      jsonb := '[]'::jsonb;
  v_mismatch    jsonb := '[]'::jsonb;
  v_overrides   jsonb := '[]'::jsonb;
  v_free_total  numeric := 0;
  v_free_any    boolean := false;
  v_free_cap    numeric;
  v_price_sup   uuid;
  v_n           int := 0;
  -- F18 · H103-H105 (ADR-068): desglose fiscal y percepciones.
  v_tax_in      jsonb := '[]'::jsonb;
  v_tax         jsonb;
  v_tl          jsonb;
  v_perc        numeric := 0;
  v_total_np    numeric;
  -- ADR-077: venta offline que se sincroniza (GUC sólo de _offline_run_sale).
  v_offline     boolean := coalesce(current_setting('ninja.offline_sync', true), '') <> '';
  v_off_conf    jsonb := '[]'::jsonb;
  -- F9 (ADR-074): motor de promociones autoritativo.
  -- ADR-077: offline, las promos se evalúan a la hora real de la venta
  -- (ninja.offline_sold_at, sólo de _offline_run_sale), no a la de la sincronización.
  v_now_ar      timestamp := (case when v_offline
                                   then coalesce(nullif(current_setting('ninja.offline_sold_at', true), '')::timestamptz, now())
                                   else now() end) at time zone 'America/Argentina/Buenos_Aires';
  v_promo_lines jsonb := '[]'::jsonb;
  v_promo_ctx   jsonb;
  v_promo_eval  jsonb := jsonb_build_object('discount', 0, 'applied', '[]'::jsonb, 'gifts', '[]'::jsonb);
  v_promo_calc  numeric := 0;
  v_promo_label text;
  v_promo_first uuid;
  v_promo_left  numeric;
  v_ap          jsonb;
  v_gift        jsonb;
  -- ADR-088: depósitos (ADR-085), seña del turno (ADR-082) y promo por línea (ADR-074).
  v_wh_on       boolean := false;
  v_from_res    boolean := false;
  v_wr          jsonb;
  v_res_taken   jsonb := '[]'::jsonb;
  v_appt_id     uuid;
  v_appt        appointments%rowtype;
  v_sena_paid   numeric := 0;
  v_sena_avail  numeric := 0;
  v_sena_exp    numeric := 0;
  v_sena_left   numeric;
  v_dep         record;
  v_promo_line  numeric[] := '{}';
  v_pl          numeric;
  -- ADR-096 >>>
  -- Reservas de stock (ADR-091) y garantía extendida enlazada (ADR-092).
  v_resv_on     boolean := false;
  v_resv_id     uuid;
  v_resv_n      int := 0;
  v_resv        stock_reservations%rowtype;
  v_resv_short  numeric;
  v_line_id     uuid;
  v_line_ids    uuid[] := '{}';
  v_service     jsonb;  -- ADR-116: datos de servicio de la venta.
  v_wl_plan     uuid;
  v_wl_months   int;
  v_wl_for      int;
  -- <<< ADR-096
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  perform assert_account_active(v_tenant);

  if coalesce(p_discount_total, 0) < 0 then
    raise exception 'invalid_discount';
  end if;

  if p_table_order_id is not null then
    select * into v_table_order from table_orders
     where id = p_table_order_id and tenant_id = v_tenant
     for update;
    if not found then
      raise exception 'table_order_not_open';
    end if;
    if v_table_order.status <> 'abierta' or v_table_order.sale_id is not null then
      raise exception 'table_order_not_open';
    end if;
  end if;

  if p_delivery_order_id is not null then
    select * into v_delivery_order from delivery_orders
     where id = p_delivery_order_id and tenant_id = v_tenant
     for update;
    if not found then
      raise exception 'delivery_order_not_open';
    end if;
    if v_delivery_order.sale_id is not null
       or v_delivery_order.status in ('entregado','cancelado')
       or v_delivery_order.deleted_at is not null then
      raise exception 'delivery_order_not_open';
    end if;
    v_delivery_fee := greatest(coalesce(v_delivery_order.delivery_fee, 0), 0);
  end if;

  -- ADR-088 (ADR-082): cobro de un turno (extra {kind: 'appointment', id}). Se
  -- bloquea el turno y sus señas (dos cobros simultáneos no pasan) y se lee la
  -- seña disponible. Un pago 'sena' sólo vale con el turno.
  select nullif(e.id, '')::uuid into v_appt_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
   where lower(coalesce(e.kind, '')) = 'appointment'
     and e.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   limit 1;
  if exists (select 1 from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as x(method text, amount numeric)
              where x.method = 'sena' and coalesce(x.amount, 0) < 0) then
    raise exception 'invalid_payment';
  end if;
  select coalesce(sum(coalesce(x.amount, 0)), 0) into v_sena_paid
    from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as x(method text, amount numeric)
   where x.method = 'sena';
  if v_appt_id is not null then
    select * into v_appt from appointments
     where id = v_appt_id and tenant_id = v_tenant
     for update;
    if not found then raise exception 'appointment_not_found'; end if;
    if v_appt.sale_id is not null then raise exception 'appointment_already_charged'; end if;
    if v_appt.status = 'cancelado' then raise exception 'appointment_not_active'; end if;
    perform 1 from appointment_deposits d
      where d.appointment_id = v_appt_id and d.tenant_id = v_tenant and d.status = 'held'
      for update;
    select coalesce(sum(d.amount - d.applied_amount - d.refunded_amount), 0) into v_sena_avail
      from appointment_deposits d
     where d.appointment_id = v_appt_id and d.tenant_id = v_tenant and d.status = 'held';
  elsif v_sena_paid <> 0 then
    raise exception 'deposit_needs_appointment';
  end if;

  -- F17 · H90: la sucursal sale del turno de caja (el que manda el POS o el
  -- inferido), no de la sucursal default. Con una sola sucursal es lo de siempre.
  select r.o_shift_id, r.o_store_id into v_shift, v_store
    from resolve_sale_shift(p_cash_shift_id, true) r;
  if v_shift is null then
    if not exists (select 1 from stores where tenant_id = v_tenant and deleted_at is null) then
      raise exception 'no_store';
    end if;
    raise exception 'no_open_shift';
  end if;

  select role into v_role
  from tenant_users
  where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  limit 1;
  -- F17 · H91: el rol puede estar pisado en esta sucursal (tope de descuento).
  v_role := coalesce(user_store_role(v_store), v_role);

  -- F17 · H92 (ADR-049): descuento máximo, redondeo y venta sin stock salen
  -- de la configuración EFECTIVA de la sucursal y la caja del turno
  -- (negocio ← grupo ← sucursal ← caja). Sin overrides es pos_settings.
  select cs.cash_register_id into v_reg from cash_shifts cs where cs.id = v_shift;
  v_eff := _effective_config(v_tenant, 'pos_settings', '', v_store, v_reg) -> 'value';
  v_max_disc  := coalesce((v_eff -> 'max_discount' ->> coalesce(v_role, 'cashier'))::numeric, 100);
  v_round     := coalesce((v_eff ->> 'rounding_multiple')::numeric, 0);
  v_allow_neg := coalesce((v_eff ->> 'allow_negative_stock')::boolean, true);
  -- Stock por sucursal (ADR-046): con la feature y 2+ sucursales, sin venta en
  -- negativo también se controla el saldo de ESTA sucursal, no sólo el total.
  v_branch_stk := tenant_has_feature_for(v_tenant, 'stock_sucursales')
                  and (select count(*) from stores st
                        where st.tenant_id = v_tenant and st.deleted_at is null) > 1;
  -- ADR-088 (ADR-085): con la feature y depósitos en la sucursal del turno, la
  -- venta mira el salón (principal). Sin depósitos, nada cambia.
  v_wh_on := tenant_has_feature_for(v_tenant, 'depositos')
             and exists (select 1 from warehouses w
                          where w.store_id = v_store and w.tenant_id = v_tenant
                            and w.deleted_at is null and w.kind <> 'principal');
  if v_wh_on then
    v_from_res := coalesce((select ps.sell_from_reserve from pos_settings ps where ps.tenant_id = v_tenant), false);
  end if;

  -- ADR-096 >>>
  -- Reservas de stock (ADR-091). Con la feature, lo reservado vigente de la
  -- sucursal no se vende en el mostrador (se valida por línea más abajo) y la
  -- venta puede entregar una reserva (extra {kind: 'reservation', id}). Mismo
  -- lock por sucursal que stock_reservation_create. Sin la feature, nada cambia.
  select count(*), (max(e.id) filter (
           where e.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))::uuid
    into v_resv_n, v_resv_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
   where lower(coalesce(e.kind, '')) = 'reservation';
  v_resv_on := tenant_has_feature_for(v_tenant, 'reservas_stock');
  if v_resv_n > 0 and not v_resv_on then
    raise exception 'feature_not_in_plan: reservas_stock';
  end if;
  if v_resv_n > 1 then
    raise exception 'one_reservation_per_sale';
  end if;
  if v_resv_n = 1 and v_resv_id is null then
    raise exception 'reservation_not_found';
  end if;
  if v_resv_on then
    perform pg_advisory_xact_lock(hashtext('stock_reservation:' || v_store::text));
  end if;
  if v_resv_id is not null then
    select * into v_resv from stock_reservations
     where id = v_resv_id and tenant_id = v_tenant
     for update;
    if not found then raise exception 'reservation_not_found'; end if;
    if v_resv.status not in ('reservada', 'preparada') then raise exception 'reservation_not_open'; end if;
    if v_resv.expires_at <= now() then raise exception 'reservation_expired'; end if;
    if v_resv.store_id <> v_store then raise exception 'reservation_wrong_store'; end if;
    -- La identidad del cliente se valida antes (stock_reservation_pickup_verify,
    -- con los intentos contados): el POS carga la reserva después de eso.
    if v_resv.pickup_verified_at is null or v_resv.pickup_verified_at < now() - interval '2 hours' then
      raise exception 'reservation_not_verified';
    end if;
  end if;
  -- <<< ADR-096

  -- F18 · H100 (ADR-056): el servidor manda en el precio. El cobro en espera que
  -- se acredita (ninja.pc_complete) usa el snapshot ya validado al estacionar.
  if not v_pc then
    if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
      raise exception 'invalid_items';
    end if;

    -- Montos sin producto que ya tienen explicación: recargo y garantía (van como
    -- ítem y como extra), packs vendidos (precio del pack) e ítems libres de la
    -- mesa o el delivery que se cobra (los valida el trigger al cargarlos).
    select coalesce(array_agg(round(e.amount, 2)), '{}') into v_pool_extra
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, amount numeric)
     where lower(coalesce(e.kind, '')) in ('warranty', 'surcharge') and coalesce(e.amount, 0) > 0;
    select coalesce(array_agg(sp.price), '{}') into v_pool_pack
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
      join service_packs sp on sp.id::text = e.id and sp.tenant_id = v_tenant and sp.deleted_at is null
     where lower(coalesce(e.kind, '')) = 'pack';
    select coalesce(array_agg(e.id), '{}') into v_pack_creds
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
     where lower(coalesce(e.kind, '')) = 'pack_session' and e.id is not null;
    if p_table_order_id is not null then
      select coalesce(array_agg(round(i.unit_price * i.qty, 2)), '{}') into v_pool_order
        from table_order_items i
       where i.order_id = p_table_order_id and i.tenant_id = v_tenant and i.product_id is null;
    elsif p_delivery_order_id is not null then
      select coalesce(array_agg(round(i.unit_price * i.qty, 2)), '{}') into v_pool_order
        from delivery_order_items i
       where i.order_id = p_delivery_order_id and i.tenant_id = v_tenant and i.product_id is null;
    end if;

    for v_i in 0 .. coalesce(jsonb_array_length(p_items), 0) - 1 loop
      v_j     := p_items -> v_i;
      v_qty   := coalesce((v_j ->> 'quantity')::numeric, 0);
      v_up    := coalesce((v_j ->> 'unit_price')::numeric, 0);
      v_ldisc := coalesce((v_j ->> 'discount')::numeric, 0);
      if v_qty <= 0 then raise exception 'invalid_quantity'; end if;
      if v_up < 0 or v_ldisc < 0 then raise exception 'invalid_price'; end if;
      v_pid := nullif(v_j ->> 'product_id', '')::uuid;

      if v_pid is null then
        v_amt := round(v_up * v_qty, 2);
        v_k := _amount_index(v_pool_extra, v_amt);
        if v_k > 0 then
          v_pool_extra := v_pool_extra[1:v_k - 1] || v_pool_extra[v_k + 1:];
        else
          v_k := _amount_index(v_pool_pack, v_amt);
          if v_k > 0 then
            v_pool_pack := v_pool_pack[1:v_k - 1] || v_pool_pack[v_k + 1:];
          else
            v_k := _amount_index(v_pool_order, v_amt);
            if v_k > 0 then
              v_pool_order := v_pool_order[1:v_k - 1] || v_pool_order[v_k + 1:];
            else
              v_free_any := true;
              v_free_total := v_free_total + greatest(v_amt - v_ldisc, 0);
            end if;
          end if;
        end if;
        v_prices := v_prices || jsonb_build_array(jsonb_build_object('list_price', null));
        continue;
      end if;

      v_vid := nullif(v_j ->> 'variant_id', '')::uuid;
      v_exp := _resolve_unit_price(v_tenant, v_pid, v_vid, v_qty, p_customer_id, v_store, null, now());
      if v_exp is null then raise exception 'product_not_found'; end if;
      v_exp := round(v_exp + _sale_modifier_delta(v_tenant, v_pid, v_j -> 'modifiers'), 2);
      v_ok := abs(v_up - v_exp) <= 0.01;
      v_reason := null;

      -- Regalo de una promo y línea cubierta por una sesión de pack: van a $0.
      if not v_ok and v_up = 0 and nullif(v_j ->> 'gift_promo_id', '') is not null then
        v_ok := exists (select 1 from promotions pr
                         where pr.id::text = v_j ->> 'gift_promo_id' and pr.tenant_id = v_tenant
                           and pr.deleted_at is null);
      end if;
      if not v_ok and v_up = 0 and nullif(v_j ->> 'pack_credit_id', '') is not null then
        v_ok := (v_j ->> 'pack_credit_id') = any (v_pack_creds);
      end if;
      -- Mesa o delivery que se cobra: vale el precio guardado al cargar el ítem.
      if not v_ok and p_table_order_id is not null then
        v_ok := exists (select 1 from table_order_items i
                         where i.order_id = p_table_order_id and i.tenant_id = v_tenant
                           and i.product_id = v_pid and abs(i.unit_price - v_up) <= 0.01);
      end if;
      if not v_ok and p_delivery_order_id is not null then
        v_ok := exists (select 1 from delivery_order_items i
                         where i.order_id = p_delivery_order_id and i.tenant_id = v_tenant
                           and i.product_id = v_pid and abs(i.unit_price - v_up) <= 0.01);
      end if;

      if not v_ok then
        if coalesce((v_j ->> 'price_override')::boolean, false) then
          v_reason := nullif(btrim(coalesce(v_j ->> 'override_reason', '')), '');
          if v_reason is null or char_length(v_reason) < 3 then
            raise exception 'price_override_reason_required';
          end if;
          v_reason := left(v_reason, 200);
          v_dev := case when v_exp > 0 then round(abs(v_up - v_exp) / v_exp * 100, 2) else 100 end;
          v_max_dev := greatest(v_max_dev, v_dev);
          v_overrides := v_overrides || jsonb_build_array(jsonb_build_object(
            'product_id', v_pid, 'variant_id', v_vid, 'expected', v_exp, 'price', v_up,
            'quantity', v_qty, 'deviation_pct', v_dev, 'reason', v_reason));
        else
          v_mismatch := v_mismatch || jsonb_build_array(jsonb_build_object(
            'product_id', v_pid, 'variant_id', v_vid, 'expected', v_exp, 'received', v_up));
        end if;
      end if;
      v_prices := v_prices || jsonb_build_array(jsonb_build_object('list_price', v_exp, 'reason', v_reason));
    end loop;

    -- Primero el precio: el POS refresca y el cajero vuelve a cobrar.
    -- ADR-077: offline se respeta el precio cobrado y queda el conflicto.
    if jsonb_array_length(v_mismatch) > 0 then
      if v_offline then
        v_off_conf := v_off_conf || (select coalesce(jsonb_agg(m || jsonb_build_object('kind', 'price_changed')), '[]'::jsonb)
                                       from jsonb_array_elements(v_mismatch) as m);
      else
        raise exception using message = 'price_mismatch:' || jsonb_build_object('items', v_mismatch)::text,
                              errcode = 'P0001';
      end if;
    end if;

    -- Venta libre (monto manual sin producto): flag efectivo y tope por rol.
    if v_free_any then
      if not coalesce((v_eff ->> 'allow_free_sale')::boolean, true) then
        raise exception 'free_sale_not_allowed';
      end if;
      v_free_cap := (v_eff -> 'max_free_sale' ->> coalesce(v_role, 'cashier'))::numeric;
      if v_free_cap is not null and v_free_total > v_free_cap + 0.01 then
        raise exception 'free_sale_exceeds_limit';
      end if;
    end if;

    -- Cambio manual de precio: supervisor, o PIN si la política lo pide.
    if jsonb_array_length(v_overrides) > 0 then
      if is_supervisor(v_tenant, auth.uid()) then
        v_price_sup := auth.uid();
      elsif pin_action_required(v_tenant, 'cambio_precio', v_max_dev) then
        v_price_sup := require_supervisor('cambio_precio', v_max_dev, null);
      end if;
    end if;
  end if;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_price numeric, discount numeric)
  loop
    v_subtotal := v_subtotal
      + (coalesce(v_item.unit_price, 0) * coalesce(v_item.quantity, 0))
      - coalesce(v_item.discount, 0);
    v_line_disc := v_line_disc + coalesce(v_item.discount, 0);
  end loop;

  select exists (
    select 1 from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text)
    where lower(coalesce(e.kind,'')) = 'pack_session'
  ) into v_has_pack_session;

  if v_subtotal < 0 or (v_subtotal = 0 and not v_has_pack_session) then
    raise exception 'empty_sale';
  end if;

  if (coalesce(p_discount_total, 0) > 0 or v_line_disc > 0)
     and not tenant_has_feature('descuentos') then
    raise exception 'feature_not_in_plan: descuentos';
  end if;

  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'warranty'
                           then coalesce(e.amount, 0) else 0 end), 0)
    into v_warranty_prima
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric);
  if v_warranty_prima > 0 and not tenant_has_feature('garantias') then
    raise exception 'feature_not_in_plan: garantias';
  end if;

  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'tip'
                           then coalesce(e.amount, 0) else 0 end), 0),
         max(case when lower(coalesce(e.kind,'')) = 'tip' then e.method end)
    into v_tip_amount, v_tip_method
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric, method text);
  if v_tip_amount < 0 then
    raise exception 'invalid_tip';
  end if;
  if v_tip_amount > 0 and v_tip_method is null then
    v_tip_method := 'cash';
  end if;

  select (e.id)::uuid into v_professional
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, id text)
  where lower(coalesce(e.kind,'')) = 'professional'
    and e.id is not null
  order by (e.id)::uuid
  limit 1;
  if v_professional is not null then
    if not exists (
      select 1 from professionals
      where id = v_professional and tenant_id = v_tenant
        and deleted_at is null and is_active
    ) then
      v_professional := null;
    end if;
  end if;

  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
         as e(kind text)
       where lower(coalesce(e.kind,'')) in ('pack','pack_session')
     )
     and p_customer_id is null then
    raise exception 'pack_needs_customer';
  end if;

  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb))
         as p(method text, amount numeric)
       where p.method = 'account' and coalesce(p.amount, 0) > 0
     )
     and not tenant_has_feature('cuenta_corriente') then
    raise exception 'feature_not_in_plan: cuenta_corriente';
  end if;

  if coalesce(p_discount_total, 0) > 0 and v_subtotal > 0 then
    v_disc_pct := coalesce(p_discount_total, 0) / v_subtotal * 100;
    if v_disc_pct > v_max_disc + 0.001 then
      raise exception 'discount_exceeds_limit';
    end if;
  end if;

  -- F9 (ADR-074): promociones calculadas en el servidor, ANTES del cupón, los
  -- impuestos y las percepciones (los recargos de cuotas llegan como ítem sin
  -- producto y no reciben promos). Mismo motor que el POS (lib/promotions/
  -- engine.ts): si el descuento que manda el POS no coincide, se rechaza con
  -- promo_mismatch y el POS vuelve a calcular. No pasa por el gating de
  -- 'descuentos' ni por el tope por rol (una promo no es descuento manual).
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', x.v ->> 'product_id',
           'category_id', p.category_id,
           'brand_id', p.brand_id,
           'quantity', coalesce((x.v ->> 'quantity')::numeric, 0),
           'line_total', round(coalesce((x.v ->> 'unit_price')::numeric, 0) * coalesce((x.v ->> 'quantity')::numeric, 0)
                               - coalesce((x.v ->> 'discount')::numeric, 0), 2),
           'excluded', (nullif(x.v ->> 'gift_promo_id', '') is not null
                        or nullif(x.v ->> 'pack_credit_id', '') is not null)) order by x.i), '[]'::jsonb)
    into v_promo_lines
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, i)
    left join products p on p.id::text = x.v ->> 'product_id' and p.tenant_id = v_tenant;

  v_promo_ctx := jsonb_build_object(
    'weekday', extract(dow from v_now_ar)::int,
    'minutes', (extract(hour from v_now_ar) * 60 + extract(minute from v_now_ar))::int,
    'date', to_char(v_now_ar, 'YYYY-MM-DD'),
    'store_id', v_store,
    'price_list_id', _promo_sale_list(v_tenant, p_customer_id, v_store),
    'customer_id', p_customer_id,
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
                          'method', x.method,
                          'card_brand', x.card_voucher ->> 'marca',
                          'bank', x.card_voucher ->> 'banco',
                          'ineligible', coalesce(x.promo_ineligible, false))), '[]'::jsonb)
                   from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb))
                     as x(method text, amount numeric, card_voucher jsonb, promo_ineligible boolean)
                  where coalesce(x.amount, 0) > 0));

  -- Topes de uso: un cobro a la vez por promo con tope (sin pasarse).
  perform pg_advisory_xact_lock(hashtext('promo_use:' || pr.id::text))
     from promotions pr
    where pr.tenant_id = v_tenant and pr.deleted_at is null and pr.is_active
      and (pr.max_uses_total is not null or pr.max_uses_per_customer is not null)
    order by pr.id;

  v_promo_eval := _promo_evaluate(v_tenant, v_promo_lines, v_promo_ctx);
  -- El cupón es excluyente con las promos de descuento (los regalos conviven).
  if p_coupon_id is not null then
    v_promo_eval := v_promo_eval || jsonb_build_object('discount', 0, 'applied', '[]'::jsonb);
  end if;
  v_promo_calc := least(coalesce((v_promo_eval ->> 'discount')::numeric, 0),
                        greatest(v_subtotal - coalesce(p_discount_total, 0), 0));

  if v_pc then
    -- Cobro en espera acreditado: vale el monto validado en el ensayo (como el
    -- precio). Si el motor ya no da lo mismo (cambió la hora), queda una sola
    -- fila con la promo que se mandó.
    v_promo_disc := least(greatest(coalesce(p_promo_discount, 0), 0),
                          greatest(v_subtotal - coalesce(p_discount_total, 0), 0));
    if abs(v_promo_calc - v_promo_disc) > 0.01 then
      v_promo_eval := v_promo_eval || jsonb_build_object('applied',
        case when v_promo_disc > 0 then jsonb_build_array(jsonb_build_object(
               'id', p_promo_id, 'name', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'label', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'discount', v_promo_disc, 'lines', '[]'::jsonb))
             else '[]'::jsonb end);
    end if;
  else
    if coalesce(p_promo_discount, 0) > 0 and not tenant_has_feature_for(v_tenant, 'promociones') then
      raise exception 'feature_not_in_plan: promociones';
    end if;
    -- Borde de una franja (happy hour, cambio de día): el POS calculó con su
    -- reloj hasta 5 minutos antes (por ejemplo, un QR que tardó en pagarse).
    if abs(greatest(coalesce(p_promo_discount, 0), 0) - v_promo_calc) > 0.01 then
      v_promo_ctx := v_promo_ctx || jsonb_build_object(
        'weekday', extract(dow from v_now_ar - interval '5 minutes')::int,
        'minutes', (extract(hour from v_now_ar - interval '5 minutes') * 60
                    + extract(minute from v_now_ar - interval '5 minutes'))::int,
        'date', to_char(v_now_ar - interval '5 minutes', 'YYYY-MM-DD'));
      v_gift := _promo_evaluate(v_tenant, v_promo_lines, v_promo_ctx);
      if p_coupon_id is not null then
        v_gift := v_gift || jsonb_build_object('discount', 0, 'applied', '[]'::jsonb);
      end if;
      if abs(greatest(coalesce(p_promo_discount, 0), 0)
             - least(coalesce((v_gift ->> 'discount')::numeric, 0),
                     greatest(v_subtotal - coalesce(p_discount_total, 0), 0))) <= 0.01 then
        v_promo_eval := v_gift;
        v_promo_calc := least(coalesce((v_gift ->> 'discount')::numeric, 0),
                              greatest(v_subtotal - coalesce(p_discount_total, 0), 0));
      end if;
    end if;
    if v_offline and abs(greatest(coalesce(p_promo_discount, 0), 0) - v_promo_calc) > 0.01 then
      -- ADR-077: la promo se recalculó al sincronizar y no da lo mismo (venció,
      -- se editó, se agotó el tope...). Se respeta lo cobrado, como el precio,
      -- con una sola fila de la promo que mandó el POS, y queda el conflicto
      -- 'promo_changed' para revisión.
      v_promo_disc := least(greatest(coalesce(p_promo_discount, 0), 0),
                            greatest(v_subtotal - coalesce(p_discount_total, 0), 0));
      v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
        'kind', 'promo_changed',
        'promo_id', p_promo_id,
        'promo_name', nullif(btrim(coalesce(p_promo_name, '')), ''),
        'charged', v_promo_disc,
        'expected', v_promo_calc,
        'expected_applied', coalesce((select jsonb_agg(jsonb_build_object('id', a ->> 'id', 'name', a ->> 'label',
                                                                          'discount', (a ->> 'discount')::numeric))
                                        from jsonb_array_elements(v_promo_eval -> 'applied') a), '[]'::jsonb)));
      v_promo_eval := v_promo_eval || jsonb_build_object('applied',
        case when v_promo_disc > 0 then jsonb_build_array(jsonb_build_object(
               'id', p_promo_id, 'name', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'label', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'discount', v_promo_disc, 'lines', '[]'::jsonb))
             else '[]'::jsonb end);
      v_promo_calc := v_promo_disc;
    end if;
    if abs(greatest(coalesce(p_promo_discount, 0), 0) - v_promo_calc) > 0.01 then
      raise exception using
        message = 'promo_mismatch:' || jsonb_build_object(
          'expected', v_promo_calc,
          'received', coalesce(p_promo_discount, 0),
          'applied', coalesce((select jsonb_agg(jsonb_build_object('id', a ->> 'id', 'name', a ->> 'label',
                                                                  'discount', (a ->> 'discount')::numeric))
                                 from jsonb_array_elements(v_promo_eval -> 'applied') a), '[]'::jsonb))::text,
        errcode = 'P0001';
    end if;
    v_promo_disc := v_promo_calc;
    -- Regalos: cada línea a $0 con gift_promo_id tiene que salir del motor
    -- (misma promo, mismo producto, sin pasarse de la cantidad).
    for v_gift in
      select x.v from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as x(v)
       where nullif(x.v ->> 'gift_promo_id', '') is not null
    loop
      if not exists (
        select 1 from jsonb_array_elements(coalesce(v_promo_eval -> 'gifts', '[]'::jsonb)) g
         where g ->> 'id' = v_gift ->> 'gift_promo_id'
           and g ->> 'product_id' = v_gift ->> 'product_id'
           and coalesce((v_gift ->> 'quantity')::numeric, 0) <= coalesce((g ->> 'qty')::numeric, 0)
           and coalesce((v_gift ->> 'unit_price')::numeric, 0) = 0) then
        if v_offline and coalesce((v_gift ->> 'unit_price')::numeric, 0) = 0 then
          -- ADR-077: regalo entregado sin conexión que el motor ya no da: se
          -- respeta lo entregado y queda el conflicto 'promo_changed'.
          v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
            'kind', 'promo_changed', 'gift', true,
            'promo_id', v_gift ->> 'gift_promo_id', 'product_id', v_gift ->> 'product_id',
            'quantity', v_gift -> 'quantity'));
        else
          raise exception 'promo_gift_invalid';
        end if;
      end if;
    end loop;
  end if;

  select string_agg(coalesce(nullif(a ->> 'label', ''), a ->> 'name'), ' + ' order by o),
         (array_agg(nullif(a ->> 'id', '')::uuid order by o))[1]
    into v_promo_label, v_promo_first
    from jsonb_array_elements(coalesce(v_promo_eval -> 'applied', '[]'::jsonb)) with ordinality as t(a, o);

  -- Cupón (F9 · H54): lock de la fila + validación + cómputo AUTORITATIVO. Bypass
  -- del gating de 'descuentos' y del tope por rol (un cupón no es descuento manual),
  -- igual que la promo. El registro del canje se hace tras insertar la venta.
  if p_coupon_id is not null then
    select * into v_coupon from coupons
      where id = p_coupon_id and tenant_id = v_tenant and deleted_at is null
      for update;
    if not found then raise exception 'coupon_not_found'; end if;
    if not v_coupon.is_active then raise exception 'coupon_inactive'; end if;
    if v_coupon.valid_from is not null
       and (now() at time zone 'America/Argentina/Buenos_Aires')::date < v_coupon.valid_from then
      raise exception 'coupon_not_yet_valid';
    end if;
    if v_coupon.valid_to is not null
       and (now() at time zone 'America/Argentina/Buenos_Aires')::date > v_coupon.valid_to then
      raise exception 'coupon_expired';
    end if;
    if v_subtotal < coalesce(v_coupon.min_amount, 0) then
      raise exception 'coupon_min_amount';
    end if;
    if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then
      raise exception 'coupon_usage_exceeded';
    end if;
    if v_coupon.max_per_customer is not null then
      if p_customer_id is null then raise exception 'coupon_needs_customer'; end if;
      if (select count(*) from coupon_redemptions
            where coupon_id = v_coupon.id and customer_id = p_customer_id)
         >= v_coupon.max_per_customer then
        raise exception 'coupon_customer_exceeded';
      end if;
    end if;
    v_coupon_disc := case when v_coupon.discount_type = 'percent'
                          then v_subtotal * coalesce(v_coupon.discount_value, 0) / 100
                          else coalesce(v_coupon.discount_value, 0) end;
    v_coupon_disc := least(
      greatest(v_coupon_disc, 0),
      greatest(v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc, 0)
    );
  end if;

  v_total_pre := v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc - v_coupon_disc;

  if v_round > 0 then
    v_total := round(v_total_pre / v_round) * v_round;
  else
    v_total := v_total_pre;
  end if;

  if v_delivery_fee > 0 then
    v_subtotal := v_subtotal + v_delivery_fee;
    v_total    := v_total + v_delivery_fee;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments) as x(method text, amount numeric)
  loop
    v_paid := v_paid + coalesce(v_pay.amount, 0);
    if v_pay.method = 'store_credit' then
      v_sc_total := v_sc_total + coalesce(v_pay.amount, 0);
    end if;
  end loop;

  -- F18 · H103-H105 (ADR-068): desglose fiscal. Una línea por ítem en el orden
  -- de p_items (el mismo índice que sale_items) y el envío al final; el total
  -- sin percepciones se reparte entre ellas (descuentos, promo, cupón y
  -- redondeo quedan dentro de cada ítem). Las percepciones se suman al total
  -- y el pago tiene que cubrirlas (el POS las muestra con sale_tax_preview).
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', x.v ->> 'product_id', 'variant_id', x.v ->> 'variant_id',
           'quantity', coalesce((x.v ->> 'quantity')::numeric, 0),
           'gross', round(coalesce((x.v ->> 'unit_price')::numeric, 0) * coalesce((x.v ->> 'quantity')::numeric, 0)
                          - coalesce((x.v ->> 'discount')::numeric, 0), 2)) order by x.i), '[]'::jsonb)
    into v_tax_in
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, i);
  if v_delivery_fee > 0 then
    v_tax_in := v_tax_in || jsonb_build_array(jsonb_build_object('product_id', null, 'quantity', 1, 'gross', v_delivery_fee));
  end if;
  v_total_np := v_total;
  v_tax := _sale_tax_compute(v_tenant, p_customer_id, v_tax_in, v_total_np, now());
  v_perc := coalesce((v_tax ->> 'perception_total')::numeric, 0);
  -- Cobro en espera que se acredita: la plata ya entró por el monto del ensayo.
  -- Si una percepción nueva (padrón cambiado en el medio) no está cubierta, no
  -- se percibe y queda el aviso en la venta.
  if v_perc > 0 and v_pc and v_paid < v_total_np + v_perc + v_tip_amount - 0.001 then
    v_tax := v_tax || jsonb_build_object(
      'perceptions', '[]'::jsonb, 'perception_total', 0,
      'warnings', coalesce(v_tax -> 'warnings', '[]'::jsonb) || jsonb_build_array('perception_skipped_pending_charge'));
    v_perc := 0;
  end if;
  v_total := v_total_np + v_perc;

  -- ADR-088 (ADR-082): la seña cubre hasta el total. El POS la manda como pago
  -- 'sena' por exactamente eso: de menos se cobraría dos veces; de más, no hay.
  if v_appt_id is not null and (v_sena_avail > 0 or v_sena_paid > 0) then
    v_sena_exp := round(least(v_sena_avail, v_total), 2);
    if abs(v_sena_paid - v_sena_exp) > 0.01 then
      raise exception using
        message = 'deposit_mismatch:' || jsonb_build_object('expected', v_sena_exp, 'received', v_sena_paid)::text,
        errcode = 'P0001';
    end if;
  end if;

  if v_paid < v_total + v_tip_amount then
    raise exception 'insufficient_payment';
  end if;
  if v_sc_total > v_total + 0.001 then
    raise exception 'store_credit_exceeds_total';
  end if;

  if v_sc_total > 0 then
    if p_customer_id is null then
      raise exception 'store_credit_needs_customer';
    end if;
    select coalesce(sum(delta), 0) into v_sc_bal
    from store_credit_movements
    where tenant_id = v_tenant and customer_id = p_customer_id;
    if v_sc_bal < v_sc_total - 0.001 then
      raise exception 'insufficient_store_credit';
    end if;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text)
  loop
    if v_pay.method = 'qr' then
      v_qr_ref := null;
      if v_pay.reference is not null
         and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
        select pi.id, pi.provider_key, pi.sale_id, pi.status, pi.amount
          into v_intent
        from mp_payment_intents pi
        where pi.id = v_pay.reference::uuid
          and pi.tenant_id = v_tenant
        limit 1;
        if found then
          v_qr_ref := v_intent.id;
        end if;
      end if;

      if v_qr_ref is not null then
        if v_intent.status <> 'approved' then
          raise exception 'qr_not_approved';
        end if;
        if v_intent.sale_id is not null then
          raise exception 'qr_already_charged';
        end if;
        if exists (
          select 1 from payments pmt
          join sales s on s.id = pmt.sale_id and s.tenant_id = v_tenant
          where pmt.method = 'qr' and pmt.reference = v_qr_ref::text
        ) then
          raise exception 'qr_already_charged';
        end if;
        select coalesce(sum(coalesce(q.amount, 0)), 0) into v_qr_sum
        from jsonb_to_recordset(p_payments)
          as q(method text, amount numeric, reference text)
        where q.method = 'qr'
          and q.reference is not null
          and q.reference ~ '^[0-9a-fA-F-]{36}$'
          and q.reference::uuid = v_qr_ref;
        if v_qr_sum > coalesce(v_intent.amount, 0) + 0.01 then
          raise exception 'qr_amount_mismatch';
        end if;
        v_pay_feat := case v_intent.provider_key
                        when 'mercadopago' then 'mercado_pago'
                        when 'mobbex'      then 'mobbex'
                        when 'modo'        then 'modo'
                        when 'pagos360'    then 'pagos360'
                        else null
                      end;
        if v_pay_feat is not null and not tenant_has_feature(v_pay_feat) then
          raise exception 'method_not_in_plan';
        end if;
      else
        v_qr_plain := true;
      end if;
    end if;
  end loop;

  if v_qr_plain
     and not (
       tenant_has_feature('mercado_pago')
       or tenant_has_feature('mobbex')
       or tenant_has_feature('modo')
       or tenant_has_feature('pagos360')
     ) then
    raise exception 'qr_not_allowed';
  end if;

  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number
  from sales where tenant_id = v_tenant;

  -- ADR-093: tenant_id explícito (sin DEFAULT current_tenant_id() por fila).
  insert into sales (tenant_id, store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes,
                     professional_id, tip_amount, tip_method,
                     promo_id, promo_name, promo_discount,
                     coupon_id, coupon_code, coupon_discount,
                     cbte_letter, fiscal_snapshot, net_taxed, net_exempt, net_untaxed,
                     iva_total, internal_tax_total, perception_total)
  values (v_tenant, v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total_np,
          coalesce((v_tax ->> 'iva_total')::numeric, 0) + coalesce((v_tax ->> 'internal_total')::numeric, 0) + v_perc,
          v_total, p_notes,
          v_professional, v_tip_amount,
          case when v_tip_amount > 0 then v_tip_method else null end,
          case when v_promo_disc > 0 then v_promo_first else null end,
          case when v_promo_disc > 0 then left(v_promo_label, 200) else null end,
          v_promo_disc,
          case when v_coupon_disc > 0 then p_coupon_id else null end,
          case when v_coupon_disc > 0 then v_coupon.code else null end,
          v_coupon_disc,
          v_tax ->> 'letter',
          jsonb_build_object('emitter', v_tax -> 'emitter', 'receptor', v_tax -> 'receptor',
                             'requires_identification', v_tax -> 'requires_identification',
                             'warnings', v_tax -> 'warnings'),
          coalesce((v_tax ->> 'net_taxed')::numeric, 0), coalesce((v_tax ->> 'net_exempt')::numeric, 0),
          coalesce((v_tax ->> 'net_untaxed')::numeric, 0), coalesce((v_tax ->> 'iva_total')::numeric, 0),
          coalesce((v_tax ->> 'internal_total')::numeric, 0), v_perc)
  returning id into v_sale_id;

  -- ADR-068: AlicIva, tributo de internos y percepciones de la venta.
  insert into sale_tax_lines (tenant_id, sale_id, kind, tax, rate_code, rate, base, amount, arca_id, source)
  select v_tenant, v_sale_id, 'iva', 'iva', x.code, x.rate, x.base, x.amount, x.arca_id, 'product'
    from jsonb_to_recordset(coalesce(v_tax -> 'iva', '[]'::jsonb))
      as x(code text, rate numeric, base numeric, amount numeric, arca_id int);
  if coalesce((v_tax ->> 'internal_total')::numeric, 0) > 0 then
    insert into sale_tax_lines (tenant_id, sale_id, kind, tax, base, amount, arca_id, source, name)
    values (v_tenant, v_sale_id, 'internos', 'internos', coalesce((v_tax ->> 'internal_base')::numeric, 0),
            (v_tax ->> 'internal_total')::numeric, 4, 'product', 'Impuestos internos');
  end if;
  insert into sale_tax_lines (tenant_id, sale_id, kind, tax, jurisdiction, rate, base, amount, arca_id,
                              regime_id, source, name)
  select v_tenant, v_sale_id, 'perception', x.tax, x.jurisdiction, x.rate, x.base, x.amount, x.arca_tributo_id,
         x.regime_id, x.source, x.name
    from jsonb_to_recordset(coalesce(v_tax -> 'perceptions', '[]'::jsonb))
      as x(tax text, jurisdiction text, rate numeric, base numeric, amount numeric, arca_tributo_id int,
           regime_id uuid, source text, name text);

  -- Registro del canje del cupón (F9 · H54): consume un uso + traza. Atómico:
  -- la fila ya está bloqueada (FOR UPDATE arriba), así que dos cobros simultáneos
  -- no pueden pasar el tope.
  if p_coupon_id is not null and v_coupon_disc > 0 then
    update coupons set used_count = used_count + 1, updated_at = now()
     where id = p_coupon_id and tenant_id = v_tenant;
    insert into coupon_redemptions (tenant_id, coupon_id, sale_id, customer_id, discount)
    values (v_tenant, p_coupon_id, v_sale_id, p_customer_id, v_coupon_disc);
  end if;

  -- F9 (ADR-074): cada promo aplicada, con su reparto por línea. Si el total
  -- quedó acotado por el descuento manual, se descuenta de las últimas.
  v_promo_left := v_promo_disc;
  for v_ap in
    select a from jsonb_array_elements(coalesce(v_promo_eval -> 'applied', '[]'::jsonb)) a
  loop
    v_amt := least(coalesce((v_ap ->> 'discount')::numeric, 0), v_promo_left);
    exit when v_amt <= 0;
    insert into sale_promotions (tenant_id, sale_id, promotion_id, name, label, kind, discount,
                                 customer_id, store_id, detail)
    values (v_tenant, v_sale_id,
            (select pr.id from promotions pr where pr.id::text = v_ap ->> 'id' and pr.tenant_id = v_tenant),
            coalesce(v_ap ->> 'name', 'Promoción'), coalesce(nullif(v_ap ->> 'label', ''), v_ap ->> 'name', 'Promoción'),
            'discount', v_amt, p_customer_id, v_store,
            jsonb_build_object('lines', coalesce(v_ap -> 'lines', '[]'::jsonb), 'stackable', v_ap -> 'stackable'));
    v_promo_left := v_promo_left - v_amt;
    -- ADR-088 (ADR-074): reparto por línea (índice de p_items), acotado como
    -- la fila si el descuento manual dejó menos. Lo usa la devolución parcial.
    if coalesce((v_ap ->> 'discount')::numeric, 0) > 0 and jsonb_typeof(v_ap -> 'lines') = 'array' then
      for v_i in 0 .. jsonb_array_length(v_ap -> 'lines') - 1 loop
        v_pl := round(coalesce((v_ap -> 'lines' ->> v_i)::numeric, 0) * v_amt / (v_ap ->> 'discount')::numeric, 2);
        if v_pl > 0 then
          v_promo_line[v_i + 1] := coalesce(v_promo_line[v_i + 1], 0) + v_pl;
        end if;
      end loop;
    end if;
  end loop;
  -- Regalos entregados (valor de lista de lo regalado, para el rendimiento).
  insert into sale_promotions (tenant_id, sale_id, promotion_id, name, label, kind, discount,
                               customer_id, store_id, detail)
  select v_tenant, v_sale_id, pr.id, pr.name, coalesce(nullif(btrim(coalesce(pr.ticket_label, '')), ''), pr.name),
         'gift',
         round(coalesce((v_prices -> (x.i - 1)::int ->> 'list_price')::numeric, 0)
               * coalesce((x.v ->> 'quantity')::numeric, 0), 2),
         p_customer_id, v_store,
         jsonb_build_object('product_id', x.v ->> 'product_id', 'quantity', x.v -> 'quantity')
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, i)
    join promotions pr on pr.id::text = x.v ->> 'gift_promo_id' and pr.tenant_id = v_tenant
   where nullif(x.v ->> 'gift_promo_id', '') is not null;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, variant_id uuid, name text, serial text, modifiers jsonb,
           quantity numeric, unit_price numeric, discount numeric)
  loop
    if v_item.product_id is not null then
      select p.name, p.sku, p.is_kit, p.track_stock, p.has_variants
        into v_pname, v_psku, v_is_kit, v_track, v_has_variants
      from products p
      where p.id = v_item.product_id and p.tenant_id = v_tenant;
      if not found then
        raise exception 'product_not_found';
      end if;

      if coalesce(v_has_variants, false) then
        if v_item.variant_id is null then
          raise exception 'variant_required';
        end if;
        select * into v_variant from product_variants
         where id = v_item.variant_id and product_id = v_item.product_id
           and tenant_id = v_tenant and deleted_at is null;
        if not found then
          raise exception 'variant_not_found';
        end if;
        v_pname := v_pname || ' · ' || v_variant.option1
                   || coalesce(' / ' || v_variant.option2, '');
      elsif v_item.variant_id is not null then
        raise exception 'variant_not_allowed';
      end if;
    else
      v_pname  := coalesce(nullif(btrim(v_item.name), ''), 'Venta rápida');
      v_psku   := null;
      v_is_kit := false;
      v_track  := false;
      v_has_variants := false;
    end if;

    v_serial := nullif(btrim(coalesce(v_item.serial, '')), '');

    -- ADR-056: precio de lista calculado y motivo del cambio manual (mismo orden
    -- que p_items; vacío en el cobro en espera acreditado).
    -- ADR-068: alícuota, precio final repartido, neto, IVA e internos.
    v_tl := v_tax -> 'lines' -> v_n;
    -- ADR-093: tenant_id explícito.
    insert into sale_items (tenant_id, sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            list_price, price_override_reason,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount,
                            promo_discount)
    values (v_tenant, v_sale_id, v_item.product_id, v_item.variant_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0),
            coalesce(v_item.modifiers, '[]'::jsonb),
            (v_prices -> v_n ->> 'list_price')::numeric,
            v_prices -> v_n ->> 'reason',
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric,
            -- ADR-088 (ADR-074): parte de la promo de esta línea.
            coalesce(v_promo_line[v_n + 1], 0))
    returning id into v_line_id;  -- ADR-096: id de la línea (vínculo de la garantía).
    v_line_ids := v_line_ids || v_line_id;  -- ADR-096
    v_n := v_n + 1;

    if v_item.product_id is not null then
      if v_is_kit then
        for v_comp in
          select pkc.component_product_id, pkc.quantity,
                 pr.stock as comp_stock, pr.allow_negative as comp_allow, pr.track_stock as comp_track
          from product_kit_components pkc
          join products pr on pr.id = pkc.component_product_id and pr.tenant_id = v_tenant
          where pkc.kit_product_id = v_item.product_id and pkc.tenant_id = v_tenant
        loop
          if v_comp.comp_track then
            if not coalesce(v_comp.comp_allow, v_allow_neg)
               and v_comp.comp_stock < (v_item.quantity * v_comp.quantity) then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            if v_branch_stk and not coalesce(v_comp.comp_allow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_comp.component_product_id
                                and ps.variant_id is null), 0) < (v_item.quantity * v_comp.quantity) then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock_branch'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock_branch', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            -- ADR-096 >>>
            -- ADR-091: lo reservado por otras reservas de la sucursal no se vende.
            if v_resv_on and not coalesce(v_comp.comp_allow, v_allow_neg) then
              v_resv_short := _sale_reserved_short(v_store, v_comp.component_product_id, null, v_item.quantity * v_comp.quantity,
                                                   v_wh_on and not v_from_res, v_resv_id);
              if v_resv_short > 0 then
                -- ADR-077: offline se vende igual y queda el conflicto.
                if not v_offline then raise exception 'insufficient_stock_reserved'; end if;
                v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                  'kind', 'negative_stock_reserved', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                  'quantity', v_item.quantity));
              end if;
            end if;
            -- <<< ADR-096
            -- ADR-088 (ADR-085): el salón tiene que alcanzar (o sale de la reserva).
            if v_wh_on then
              v_wr := _sale_salon_take(v_store, v_comp.component_product_id, null,
                                       v_item.quantity * v_comp.quantity, v_from_res);
              if v_wr is not null then
                if (v_wr ->> 'taken')::numeric > 0 then v_res_taken := v_res_taken || jsonb_build_array(v_wr); end if;
                if (v_wr ->> 'short')::numeric > 0 and not coalesce(v_comp.comp_allow, v_allow_neg) then
                  if not v_offline then raise exception 'insufficient_stock_salon'; end if;
                  v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                    'kind', 'negative_stock_salon', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                    'quantity', v_item.quantity));
                end if;
              end if;
            end if;
            update products
               set stock = stock - (v_item.quantity * v_comp.quantity), updated_at = now()
             where id = v_comp.component_product_id and tenant_id = v_tenant;

            -- ADR-093: tenant_id explícito.
            insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
            values (v_tenant, v_comp.component_product_id, v_store,
                    -(v_item.quantity * v_comp.quantity), 'sale', v_sale_id);
          end if;
        end loop;
      else
        if v_track then
          if coalesce(v_has_variants, false) then
            select pr.allow_negative into v_pallow from products pr
             where pr.id = v_item.product_id and pr.tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_variant.stock < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            if v_branch_stk and not coalesce(v_pallow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_item.product_id
                                and ps.variant_id = v_variant.id), 0) < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock_branch'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock_branch', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            -- ADR-096 >>>
            -- ADR-091: lo reservado por otras reservas de la sucursal no se vende.
            if v_resv_on and not coalesce(v_pallow, v_allow_neg) then
              v_resv_short := _sale_reserved_short(v_store, v_item.product_id, v_variant.id, v_item.quantity,
                                                   v_wh_on and not v_from_res, v_resv_id);
              if v_resv_short > 0 then
                -- ADR-077: offline se vende igual y queda el conflicto.
                if not v_offline then raise exception 'insufficient_stock_reserved'; end if;
                v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                  'kind', 'negative_stock_reserved', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                  'quantity', v_item.quantity));
              end if;
            end if;
            -- <<< ADR-096
            -- ADR-088 (ADR-085): el salón tiene que alcanzar (o sale de la reserva).
            if v_wh_on then
              v_wr := _sale_salon_take(v_store, v_item.product_id, v_variant.id, v_item.quantity, v_from_res);
              if v_wr is not null then
                if (v_wr ->> 'taken')::numeric > 0 then v_res_taken := v_res_taken || jsonb_build_array(v_wr); end if;
                if (v_wr ->> 'short')::numeric > 0 and not coalesce(v_pallow, v_allow_neg) then
                  if not v_offline then raise exception 'insufficient_stock_salon'; end if;
                  v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                    'kind', 'negative_stock_salon', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                    'quantity', v_item.quantity));
                end if;
              end if;
            end if;

            update product_variants
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_variant.id and tenant_id = v_tenant;

            -- ADR-093: tenant_id explícito.
            insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, reference_id)
            values (v_tenant, v_item.product_id, v_variant.id, v_store, -v_item.quantity, 'sale', v_sale_id);
          else
            select stock, allow_negative into v_stock, v_pallow
            from products where id = v_item.product_id and tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_stock < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            if v_branch_stk and not coalesce(v_pallow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_item.product_id
                                and ps.variant_id is null), 0) < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock_branch'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock_branch', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            -- ADR-096 >>>
            -- ADR-091: lo reservado por otras reservas de la sucursal no se vende.
            if v_resv_on and not coalesce(v_pallow, v_allow_neg) then
              v_resv_short := _sale_reserved_short(v_store, v_item.product_id, null, v_item.quantity,
                                                   v_wh_on and not v_from_res, v_resv_id);
              if v_resv_short > 0 then
                -- ADR-077: offline se vende igual y queda el conflicto.
                if not v_offline then raise exception 'insufficient_stock_reserved'; end if;
                v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                  'kind', 'negative_stock_reserved', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                  'quantity', v_item.quantity));
              end if;
            end if;
            -- <<< ADR-096
            -- ADR-088 (ADR-085): el salón tiene que alcanzar (o sale de la reserva).
            if v_wh_on then
              v_wr := _sale_salon_take(v_store, v_item.product_id, null, v_item.quantity, v_from_res);
              if v_wr is not null then
                if (v_wr ->> 'taken')::numeric > 0 then v_res_taken := v_res_taken || jsonb_build_array(v_wr); end if;
                if (v_wr ->> 'short')::numeric > 0 and not coalesce(v_pallow, v_allow_neg) then
                  if not v_offline then raise exception 'insufficient_stock_salon'; end if;
                  v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                    'kind', 'negative_stock_salon', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                    'quantity', v_item.quantity));
                end if;
              end if;
            end if;

            update products
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_item.product_id and tenant_id = v_tenant;

            -- ADR-093: tenant_id explícito.
            insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
            values (v_tenant, v_item.product_id, v_store, -v_item.quantity, 'sale', v_sale_id);
          end if;
        end if;

        if v_serial is not null then
          update product_serials
             set status = 'sold', sale_id = v_sale_id
           where product_id = v_item.product_id and tenant_id = v_tenant
             and serial = v_serial and status = 'in_stock';
          if not found then
            -- ADR-093: tenant_id explícito.
            insert into product_serials (tenant_id, product_id, serial, status, sale_id)
            values (v_tenant, v_item.product_id, v_serial, 'sold', v_sale_id)
            on conflict (product_id, serial) do update
              set status = 'sold', sale_id = v_sale_id;
          end if;
        end if;
      end if;
    end if;
  end loop;

  -- ADR-096 >>>
  -- ADR-092: garantía extendida enlazada a la línea que cubre. La línea de la
  -- garantía (sin producto) trae warranty_plan_id y warranty_for (índice en
  -- p_items de una línea con producto). Offline (ADR-077) un vínculo inválido
  -- no frena la sincronización: la línea queda sin vínculo, como antes.
  for v_i in 0 .. coalesce(jsonb_array_length(p_items), 0) - 1 loop
    v_j := p_items -> v_i;
    continue when nullif(v_j ->> 'warranty_plan_id', '') is null;
    if not tenant_has_feature('garantias') then
      raise exception 'feature_not_in_plan: garantias';
    end if;
    v_wl_plan := null;
    v_wl_months := null;
    v_wl_for := case when (v_j ->> 'warranty_for') ~ '^[0-9]{1,5}$' then (v_j ->> 'warranty_for')::int end;
    select wp.id, wp.months into v_wl_plan, v_wl_months
      from warranty_plans wp
     where wp.id::text = v_j ->> 'warranty_plan_id' and wp.tenant_id = v_tenant;
    if v_wl_plan is null or v_wl_for is null or v_wl_for = v_i
       or v_wl_for >= jsonb_array_length(p_items)
       or nullif(v_j ->> 'product_id', '') is not null
       or nullif(p_items -> v_wl_for ->> 'product_id', '') is null then
      if v_offline then continue; end if;
      raise exception 'warranty_link_invalid';
    end if;
    update sale_items
       set warranty_plan_id = v_wl_plan, warranty_for_item_id = v_line_ids[v_wl_for + 1],
           warranty_months = v_wl_months
     where id = v_line_ids[v_i + 1] and tenant_id = v_tenant;
  end loop;

  -- ADR-091: la venta entrega la reserva. Tiene que cubrir sus renglones; la
  -- reserva queda entregada con esta venta en la misma transacción. Su propia
  -- cantidad no contó como reservada al validar el stock (sin doble descuento).
  if v_resv_id is not null then
    if exists (
      select 1 from stock_reservation_items i
       where i.reservation_id = v_resv_id
         and i.qty > coalesce((select sum(si.quantity) from sale_items si
                                where si.sale_id = v_sale_id and si.product_id = i.product_id
                                  and si.variant_id is not distinct from i.variant_id), 0)) then
      raise exception 'reservation_items_mismatch';
    end if;
    update stock_reservations
       set status = 'entregada', sale_id = v_sale_id, delivered_by = auth.uid(), delivered_at = now()
     where id = v_resv_id and tenant_id = v_tenant;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            before_data, after_data, reason, store_id)
    values (v_tenant, auth.uid(), 'stock_reservations', v_resv_id, 'stock_reservation_delivered',
            jsonb_build_object('status', v_resv.status),
            jsonb_build_object('status', 'entregada', 'sale_id', v_sale_id, 'sale_number', v_number,
                               'verified_by', v_resv.pickup_verified_via, 'source', 'pos'),
            v_resv.override_reason, v_store);
  end if;
  -- <<< ADR-096

  -- ADR-056: cambio manual de precio, con quién lo autorizó.
  if jsonb_array_length(v_overrides) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            reason, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale_id, 'price_override',
            v_overrides -> 0 ->> 'reason',
            jsonb_build_object('sale_number', v_number, 'items', v_overrides,
                               'max_deviation_pct', v_max_dev, 'supervisor_id', v_price_sup),
            v_store);
  end if;

  -- ADR-088 (ADR-085): lo que se vendió de la reserva porque el salón no alcanzaba.
  if jsonb_array_length(v_res_taken) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale_id, 'sale_from_reserve',
            jsonb_build_object('sale_number', v_number, 'items', v_res_taken), v_store);
  end if;

  if v_delivery_fee > 0 then
    v_tl := v_tax -> 'lines' -> v_n;
    -- ADR-093: tenant_id explícito.
    insert into sale_items (tenant_id, sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_tenant, v_sale_id, null, null, 'Costo de envío', null, null,
            1, v_delivery_fee, 0, v_delivery_fee, '[]'::jsonb,
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text, card_voucher jsonb)
  loop
    -- ADR-093: tenant_id explícito en pagos, caja y saldo a favor.
    insert into payments (tenant_id, sale_id, method, amount, reference, card_voucher)
    values (v_tenant, v_sale_id, v_pay.method, v_pay.amount, v_pay.reference,
            coalesce(v_pay.card_voucher, '{}'::jsonb));

    if v_pay.method = 'qr'
       and v_pay.reference is not null
       and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
      update mp_payment_intents
         set sale_id = v_sale_id, updated_at = now()
       where id = v_pay.reference::uuid
         and tenant_id = v_tenant
         and sale_id is null;
    end if;

    insert into cash_movements (tenant_id, cash_shift_id, type, amount, payment_method, reference_id)
    values (v_tenant, v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);

    if v_pay.method = 'store_credit' then
      insert into store_credit_movements (tenant_id, customer_id, delta, reason)
      values (v_tenant, p_customer_id, -coalesce(v_pay.amount, 0), 'Pago venta #' || v_number);
    end if;
  end loop;

  -- ADR-088 (ADR-082): la seña se aplica (la plata ya entró a la caja al
  -- cobrarla) y el turno queda enlazado a la venta en esta misma transacción.
  if v_appt_id is not null then
    v_sena_left := v_sena_exp;
    for v_dep in
      select d.id, d.amount, d.applied_amount, d.refunded_amount
        from appointment_deposits d
       where d.appointment_id = v_appt_id and d.tenant_id = v_tenant and d.status = 'held'
       order by d.created_at, d.id
    loop
      exit when v_sena_left <= 0;
      v_amt := least(v_dep.amount - v_dep.applied_amount - v_dep.refunded_amount, v_sena_left);
      continue when v_amt <= 0;
      update appointment_deposits
         set applied_amount = applied_amount + v_amt,
             sale_id = v_sale_id,
             status = _appointment_deposit_status(amount, applied_amount + v_amt, refunded_amount)
       where id = v_dep.id;
      v_sena_left := v_sena_left - v_amt;
    end loop;

    update appointments
       set sale_id = v_sale_id, status = 'realizado', updated_at = now()
     where id = v_appt_id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'appointments', v_appt_id, 'appointment_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'deposit_applied', v_sena_exp, 'deposit_available', v_sena_avail),
            v_store);
  end if;

  for v_pack in
    select (e.id)::uuid as pack_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
    where lower(coalesce(e.kind,'')) = 'pack' and e.id is not null
  loop
    select * into v_pk from service_packs
     where id = v_pack.pack_id and tenant_id = v_tenant and deleted_at is null;
    if not found then
      raise exception 'pack_not_found';
    end if;
    -- ADR-093: tenant_id explícito.
    insert into customer_pack_credits (
      tenant_id, customer_id, pack_id, pack_name, product_id,
      sessions_total, sessions_used, expires_at, sale_id
    )
    values (
      v_tenant, p_customer_id, v_pk.id, v_pk.name, v_pk.product_id,
      v_pk.sessions, 0,
      case when v_pk.validity_days is not null
           then now() + make_interval(days => v_pk.validity_days) else null end,
      v_sale_id
    );
  end loop;

  for v_pack in
    select (e.id)::uuid as credit_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
    where lower(coalesce(e.kind,'')) = 'pack_session' and e.id is not null
  loop
    select * into v_pcredit from customer_pack_credits
     where id = v_pack.credit_id and tenant_id = v_tenant
       and customer_id = p_customer_id
     for update;
    if not found then
      raise exception 'pack_credit_not_found';
    end if;
    if v_pcredit.sessions_used >= v_pcredit.sessions_total then
      raise exception 'pack_no_sessions_left';
    end if;
    if v_pcredit.expires_at is not null and v_pcredit.expires_at < now() then
      raise exception 'pack_expired';
    end if;

    update customer_pack_credits
       set sessions_used = sessions_used + 1
     where id = v_pcredit.id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            before_data, after_data)
    values (v_tenant, auth.uid(), 'customer_pack_credits', v_pcredit.id, 'pack_session_used',
            jsonb_build_object('sessions_used', v_pcredit.sessions_used,
                               'sessions_total', v_pcredit.sessions_total),
            jsonb_build_object('sessions_used', v_pcredit.sessions_used + 1,
                               'sessions_total', v_pcredit.sessions_total,
                               'sale_id', v_sale_id, 'sale_number', v_number));
  end loop;

  if p_table_order_id is not null then
    update table_orders
       set sale_id = v_sale_id, status = 'cobrada', updated_at = now()
     where id = p_table_order_id and tenant_id = v_tenant;

    update dining_tables
       set status = 'libre', current_order_id = null, waiter_user_id = null
     where id = v_table_order.table_id and tenant_id = v_tenant
       and current_order_id = p_table_order_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            after_data)
    values (v_tenant, auth.uid(), 'table_orders', p_table_order_id, 'table_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'table_id', v_table_order.table_id));
  end if;

  if p_delivery_order_id is not null then
    update delivery_orders
       set sale_id = v_sale_id, status = 'entregado', updated_at = now()
     where id = p_delivery_order_id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            after_data)
    values (v_tenant, auth.uid(), 'delivery_orders', p_delivery_order_id, 'delivery_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'order_type', v_delivery_order.order_type,
                               'delivery_fee', v_delivery_fee));
  end if;

  -- ADR-116 >>>
  -- Servicios profesionales: descripción ampliada, aclaraciones y nota por
  -- renglón (mismo orden que p_items, por v_line_ids) y período del servicio
  -- y vencimiento del pago (concepto 2 o 3 de ARCA). Sin servicios ni notas
  -- no toca nada. Fecha de la venta en hora de Argentina (offline: la real).
  v_service := _sale_apply_service(v_tenant, v_sale_id, p_items, v_line_ids, p_service, v_now_ar::date);
  -- <<< ADR-116

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total,
                            'tip', v_tip_amount, 'promo_discount', v_promo_disc,
                            'promotions', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', sp.promotion_id, 'label', sp.label, 'kind', sp.kind, 'discount', sp.discount)
                                order by sp.kind desc, sp.created_at)
                              from sale_promotions sp where sp.sale_id = v_sale_id), '[]'::jsonb),
                            'coupon_discount', v_coupon_disc,
                            'service', v_service,  -- ADR-116
                            'perception_total', v_perc, 'cbte_letter', v_tax ->> 'letter',
                            -- ADR-077: diferencias de la venta offline (null fuera de ese modo).
                            'offline_conflicts', case when v_offline then v_off_conf else null end,
                            -- ADR-088: aviso de lo que salió de la reserva y seña aplicada.
                            'reserve_taken', v_res_taken,
                            'deposit_applied', v_sena_exp);
end;
$function$;

revoke all on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid, jsonb) from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- G) arca_snapshot (copia de 20261101100100_arca_facturacion, única
--    definición, + período del servicio y vencimiento del pago de la venta)
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
