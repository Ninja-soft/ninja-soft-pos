-- =============================================================================
-- 20261202100200_remitos  (F11 · H32/H33, ADR-136)
--
-- Remitos de entrega y de envío con COT, sobre la expedición de H32 y las
-- entregas partidas de 20261202100100.
--
--   • remito_points: punto de venta INTERNO de remitos por sucursal (número
--     propio, correlativo, sin CAI): se crea solo con el primer remito.
--   • remitos + remito_items: documento "R" no fiscal con emisor (foto de la
--     marca y la sucursal), receptor, domicilio de entrega, ítems, bultos,
--     peso, valor declarado, transporte (empresa, CUIT, patente, chofer),
--     COT (número, jurisdicción, vigencia, origen manual) y recepción.
--   • remito_issue (idempotente por id), remito_update (transporte, COT y
--     recepción) y remito_void (dueño o encargado, con motivo).
--   • pos_settings.remito_config: umbral de valor para avisar que falta el
--     COT, jurisdicción por defecto, precios en el remito y leyenda.
--   • remito_cot_required: espejo de cotRequired (lib/remitos/logic.ts).
--
-- COT: el número lo carga el negocio (lo obtiene en ARBA, AGIP u otra
-- jurisdicción). La obtención automática por el servicio de ARBA queda como
-- siguiente paso: cot_source admite 'arba_ws' para ese camino (ADR-136).
--
-- Seguridad:
--   • Lectura: tenant_id = (select current_tenant_id()) or (select
--     internal_scope()) + RESTRICTIVE por sucursal en remitos e ítems.
--     Nunca is_internal().
--   • Sin escritura por REST: todo por RPC SECURITY DEFINER, role_write_guard
--     'operate' (remitos, ítems) y 'manage' (puntos de venta).
--   • Gating: tenant_has_feature_for(tenant, 'entregas_remitos') en cada RPC.
--   • audit_logs: remito_issued, remito_updated, remito_cot_set,
--     remito_voided (remito_emailed lo escribe la Edge send_receipt_email).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Configuración
-- -----------------------------------------------------------------------------
alter table pos_settings add column if not exists remito_config jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pos_settings_remito_config_check') then
    alter table pos_settings add constraint pos_settings_remito_config_check
      check (remito_config is null or jsonb_typeof(remito_config) = 'object');
  end if;
end;
$$;

-- Defaults y topes. Espejo: remitoConfig en lib/remitos/logic.ts.
create or replace function remito_config(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r   jsonb;
  v_t numeric;
  v_j text;
begin
  select ps.remito_config into r from pos_settings ps where ps.tenant_id = p_tenant;
  r := coalesce(r, '{}'::jsonb);
  v_t := case when (r ->> 'cot_threshold') ~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' then (r ->> 'cot_threshold')::numeric end;
  v_j := case when r ->> 'cot_jurisdiction' in ('pba', 'caba', 'otra') then r ->> 'cot_jurisdiction' else 'pba' end;
  return jsonb_build_object(
    'cot_threshold', v_t,
    'cot_jurisdiction', v_j,
    'show_prices', case when r ->> 'show_prices' in ('true', 'false') then (r ->> 'show_prices')::boolean else false end,
    'legend', left(nullif(btrim(coalesce(r ->> 'legend', '')), ''), 300)
  );
end;
$$;
revoke all on function remito_config(uuid) from public, anon, authenticated;

-- ¿El remito debería llevar COT? Valor declarado desde el umbral del negocio
-- en PBA o CABA. Sin umbral cargado no avisa (la obligación y el monto los
-- fija cada jurisdicción y cambian: ADR-136).
create or replace function remito_cot_required(p_threshold numeric, p_jurisdiction text, p_value numeric)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_threshold is not null
     and coalesce(p_jurisdiction, 'pba') in ('pba', 'caba')
     and coalesce(p_value, 0) >= p_threshold;
$$;

-- -----------------------------------------------------------------------------
-- B) Tablas
-- -----------------------------------------------------------------------------
create table if not exists remito_points (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  store_id    uuid not null references stores(id),
  pto_vta     int not null check (pto_vta between 1 and 99999),
  last_number int not null default 0 check (last_number >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

comment on table remito_points is
  'Punto de venta interno de remitos por sucursal (ADR-136): numeración propia, no fiscal. Lo crea remito_issue.';

create unique index if not exists remito_points_tenant_pto_key on remito_points(tenant_id, pto_vta) where deleted_at is null;
create unique index if not exists remito_points_store_key on remito_points(store_id) where deleted_at is null;

drop trigger if exists set_updated_at_remito_points on remito_points;
create trigger set_updated_at_remito_points
  before update on remito_points
  for each row execute function set_updated_at();

create table if not exists remitos (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  store_id         uuid not null references stores(id),
  point_id         uuid not null references remito_points(id),
  pto_vta          int not null,
  number           int not null,
  kind             text not null check (kind in ('entrega', 'envio')),
  status           text not null default 'emitido' check (status in ('emitido', 'anulado')),
  dispatch_id      uuid references dispatches(id),
  sale_id          uuid references sales(id),
  issued_at        timestamptz not null default now(),
  issuer           jsonb not null check (jsonb_typeof(issuer) = 'object'),
  receiver_name    text not null check (char_length(btrim(receiver_name)) between 1 and 120),
  receiver_doc     text check (receiver_doc is null or char_length(receiver_doc) <= 40),
  receiver_iva     text check (receiver_iva is null or char_length(receiver_iva) <= 40),
  receiver_address text check (receiver_address is null or char_length(receiver_address) <= 300),
  delivery_address text check (delivery_address is null or char_length(delivery_address) <= 300),
  packages         int not null default 1 check (packages between 1 and 9999),
  weight_kg        numeric(10,2) check (weight_kg is null or weight_kg >= 0),
  declared_value   numeric(14,2) not null default 0 check (declared_value >= 0),
  show_prices      boolean not null default false,
  carrier_name     text check (carrier_name is null or char_length(carrier_name) <= 120),
  carrier_cuit     text check (carrier_cuit is null or carrier_cuit ~ '^[0-9]{11}$'),
  vehicle_plate    text check (vehicle_plate is null or char_length(vehicle_plate) <= 20),
  driver_name      text check (driver_name is null or char_length(driver_name) <= 120),
  cot_number       text check (cot_number is null or cot_number ~ '^[0-9A-Za-z-]{6,40}$'),
  cot_jurisdiction text check (cot_jurisdiction is null or cot_jurisdiction in ('pba', 'caba', 'otra')),
  cot_valid_until  date,
  cot_source       text check (cot_source is null or cot_source in ('manual', 'arba_ws')),
  notes            text check (notes is null or char_length(notes) <= 500),
  legend           text check (legend is null or char_length(legend) <= 300),
  received_name    text check (received_name is null or char_length(received_name) <= 120),
  received_doc     text check (received_doc is null or char_length(received_doc) <= 40),
  received_at      timestamptz,
  emailed_to       text check (emailed_to is null or char_length(emailed_to) <= 200),
  emailed_at       timestamptz,
  void_reason      text check (void_reason is null or char_length(void_reason) <= 300),
  voided_by        uuid references public.users(id),
  voided_at        timestamptz,
  created_by       uuid default auth.uid() references public.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  constraint remitos_number_key unique (tenant_id, pto_vta, number),
  constraint remitos_source_check check (dispatch_id is not null or sale_id is not null)
);

comment on table remitos is
  'Remitos de entrega y de envío (ADR-136). Documento R no fiscal (sin CAI) con numeración propia por punto de venta interno y COT de la jurisdicción. Sólo lo escriben las RPC remito_*.';

create index if not exists remitos_tenant_issued_idx on remitos(tenant_id, issued_at desc);
create index if not exists remitos_store_idx on remitos(store_id, issued_at desc);
create index if not exists remitos_point_idx on remitos(point_id);
create index if not exists remitos_dispatch_idx on remitos(dispatch_id) where dispatch_id is not null;
create unique index if not exists remitos_dispatch_active_key on remitos(dispatch_id)
  where dispatch_id is not null and status = 'emitido' and deleted_at is null;
create index if not exists remitos_sale_idx on remitos(sale_id) where sale_id is not null;
create index if not exists remitos_voided_by_idx on remitos(voided_by) where voided_by is not null;
create index if not exists remitos_created_by_idx on remitos(created_by) where created_by is not null;

drop trigger if exists set_updated_at_remitos on remitos;
create trigger set_updated_at_remitos
  before update on remitos
  for each row execute function set_updated_at();

create table if not exists remito_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  remito_id   uuid not null references remitos(id) on delete cascade,
  store_id    uuid not null references stores(id),
  product_id  uuid references products(id),
  variant_id  uuid references product_variants(id),
  description text not null check (char_length(description) between 1 and 300),
  sku         text,
  unit        text not null default 'un',
  qty         numeric(12,3) not null check (qty > 0),
  unit_price  numeric(14,2),
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists remito_items_remito_idx on remito_items(remito_id);
create index if not exists remito_items_tenant_idx on remito_items(tenant_id);
create index if not exists remito_items_store_idx on remito_items(store_id);
create index if not exists remito_items_product_idx on remito_items(product_id) where product_id is not null;
create index if not exists remito_items_variant_idx on remito_items(variant_id) where variant_id is not null;

-- -----------------------------------------------------------------------------
-- C) RLS
-- -----------------------------------------------------------------------------
alter table remito_points enable row level security;
alter table remitos enable row level security;
alter table remito_items enable row level security;

drop policy if exists remito_points_select on remito_points;
create policy remito_points_select on remito_points
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists remitos_select on remitos;
create policy remitos_select on remitos
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists remitos_branch_scope on remitos;
create policy remitos_branch_scope on remitos
  as restrictive for select
  using ((select internal_scope()) or store_id = any ((select user_allowed_store_ids())::uuid[]));

drop policy if exists remito_items_select on remito_items;
create policy remito_items_select on remito_items
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists remito_items_branch_scope on remito_items;
create policy remito_items_branch_scope on remito_items
  as restrictive for select
  using ((select internal_scope()) or store_id = any ((select user_allowed_store_ids())::uuid[]));

revoke all on remito_points from anon, authenticated;
revoke all on remitos from anon, authenticated;
revoke all on remito_items from anon, authenticated;
grant select on remito_points to authenticated;
grant select on remitos to authenticated;
grant select on remito_items to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['remitos', 'remito_items'] loop
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'operate');
  end loop;
  execute 'drop trigger if exists role_write_guard on public.remito_points';
  execute 'create trigger role_write_guard before insert or update or delete on public.remito_points '
          'for each row execute function trg_role_write_guard(''manage'')';
end;
$$;

-- -----------------------------------------------------------------------------
-- D) RPC
-- -----------------------------------------------------------------------------
create or replace function _remito_assert(p_store uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text := stock_my_role();
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if v_role is null or v_role = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'entregas_remitos') then
    raise exception 'feature_not_in_plan: entregas_remitos' using errcode = 'check_violation';
  end if;
  if p_store is null or not exists (select 1 from stores where id = p_store and tenant_id = v_tenant) then
    raise exception 'store_not_found';
  end if;
  if not coalesce(user_can_access_store(p_store), false) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _remito_assert(uuid) from public, anon, authenticated;

create or replace function _remito_text(p jsonb, p_key text, p_max int)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select left(nullif(btrim(coalesce(p ->> p_key, '')), ''), p_max);
$$;
revoke all on function _remito_text(jsonb, text, int) from public, anon, authenticated;

-- Emite un remito para una entrega (dispatch_id) o una venta (sale_id).
-- p_data: {dispatch_id | sale_id, kind, items?: [{product_id, variant_id, qty}],
--   receiver_name, receiver_doc, receiver_iva, receiver_address,
--   delivery_address, packages, weight_kg, declared_value, show_prices,
--   carrier_name, carrier_cuit, vehicle_plate, driver_name,
--   cot_number, cot_jurisdiction, cot_valid_until, notes}
-- Idempotente por p_id. Devuelve {id, pto_vta, number, cot_required}.
create or replace function remito_issue(p_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid;
  v_ex       remitos;
  v_disp     dispatches;
  v_sale     record;
  v_store    uuid;
  v_kind     text;
  v_cfg      jsonb;
  v_point    remito_points;
  v_number   int;
  v_issuer   jsonb;
  v_cust     record;
  v_items    jsonb;
  v_value    numeric;
  v_cot      text := _remito_text(p_data, 'cot_number', 40);
  v_jur      text;
  v_cuit     text := nullif(regexp_replace(coalesce(p_data ->> 'carrier_cuit', ''), '\D', '', 'g'), '');
  v_recv     text;
  v_show     boolean;
begin
  if p_id is null or jsonb_typeof(p_data) is distinct from 'object' then
    raise exception 'invalid_remito';
  end if;
  select * into v_ex from remitos where id = p_id;
  if v_ex.id is not null then
    if v_ex.tenant_id is distinct from current_tenant_id() then
      raise exception 'remito_not_found';
    end if;
    perform _remito_assert(v_ex.store_id);
    return jsonb_build_object('id', v_ex.id, 'pto_vta', v_ex.pto_vta, 'number', v_ex.number, 'already', true);
  end if;

  -- Origen: la entrega (sale de la sucursal que arma) o la venta.
  if nullif(p_data ->> 'dispatch_id', '') is not null then
    select * into v_disp from dispatches
     where id = (p_data ->> 'dispatch_id')::uuid and tenant_id = current_tenant_id() and deleted_at is null
     for update;
    if v_disp.id is null then
      raise exception 'dispatch_not_found';
    end if;
    if v_disp.status = 'cancelado' then
      raise exception 'dispatch_cancelled';
    end if;
    v_store := v_disp.store_id;
  elsif nullif(p_data ->> 'sale_id', '') is not null then
    v_store := null;
  else
    raise exception 'invalid_remito';
  end if;
  select s.id, s.store_id, s.status, s.customer_id, s.number into v_sale
    from sales s
   where s.id = coalesce(v_disp.sale_id, (p_data ->> 'sale_id')::uuid) and s.tenant_id = current_tenant_id();
  if v_sale.id is null then
    raise exception 'sale_not_found';
  end if;
  if v_sale.status <> 'completed' then
    raise exception 'sale_not_completed';
  end if;
  v_store := coalesce(v_store, v_sale.store_id);
  v_tenant := _remito_assert(v_store);
  v_cfg := remito_config(v_tenant);

  v_kind := coalesce(nullif(p_data ->> 'kind', ''), case when v_disp.delivery_type = 'envio' then 'envio' else 'entrega' end);
  if v_kind not in ('entrega', 'envio') then
    raise exception 'invalid_kind';
  end if;
  v_jur := coalesce(nullif(p_data ->> 'cot_jurisdiction', ''), v_cfg ->> 'cot_jurisdiction');
  if v_jur not in ('pba', 'caba', 'otra') then
    raise exception 'invalid_cot_jurisdiction';
  end if;
  if v_cot is not null and v_cot !~ '^[0-9A-Za-z-]{6,40}$' then
    raise exception 'invalid_cot';
  end if;
  if v_cuit is not null and v_cuit !~ '^[0-9]{11}$' then
    raise exception 'invalid_carrier_cuit';
  end if;
  v_show := coalesce(case when p_data ->> 'show_prices' in ('true', 'false') then (p_data ->> 'show_prices')::boolean end,
                     (v_cfg ->> 'show_prices')::boolean);

  -- Ítems: los de la entrega (venta partida), los de la venta (entrega de H32
  -- o venta suelta) o el subconjunto pedido. Precio unitario neto de la venta.
  with sold as (
    select si.product_id, si.variant_id, min(si.product_name) as name, min(si.sku) as sku,
           coalesce(min(si.unit_label), min(pr.unit), 'un') as unit,
           sum(si.quantity - coalesce(si.returned_qty, 0)) as qty,
           case when sum(si.quantity) > 0 then round(sum(si.subtotal) / sum(si.quantity), 2) end as unit_price
      from sale_items si
      left join products pr on pr.id = si.product_id
     where si.sale_id = v_sale.id and not coalesce(pr.is_service, false)
     group by si.product_id, si.variant_id
  ),
  src as (
    select di.product_id, di.variant_id,
           di.product_name || coalesce(' (' || di.variant_label || ')', '') as description,
           di.sku, di.unit, di.qty
      from dispatch_items di
     where v_disp.id is not null and di.dispatch_id = v_disp.id
    union all
    select s.product_id, s.variant_id, s.name, s.sku, s.unit, s.qty
      from sold s
     where s.qty > 0
       and (v_disp.id is null or not exists (select 1 from dispatch_items di where di.dispatch_id = v_disp.id))
  ),
  pick as (
    select x.product_id, x.variant_id, sum(x.qty) as qty
      from jsonb_to_recordset(coalesce(p_data -> 'items', '[]'::jsonb)) as x(product_id uuid, variant_id uuid, qty numeric)
     group by 1, 2
  ),
  fin as (
    select src.product_id, src.variant_id, src.description, src.sku, src.unit,
           case when jsonb_array_length(coalesce(p_data -> 'items', '[]'::jsonb)) = 0 then src.qty
                else least(src.qty, coalesce(pk.qty, 0)) end as qty,
           sold.unit_price
      from src
      left join pick pk on pk.product_id is not distinct from src.product_id and pk.variant_id is not distinct from src.variant_id
      left join sold on sold.product_id is not distinct from src.product_id and sold.variant_id is not distinct from src.variant_id
  )
  select coalesce(jsonb_agg(to_jsonb(fin) order by fin.description), '[]'::jsonb),
         coalesce(sum(fin.qty * coalesce(fin.unit_price, 0)), 0)
    into v_items, v_value
    from fin
   where fin.qty > 0;
  if jsonb_array_length(v_items) = 0 then
    raise exception 'remito_empty';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(coalesce(p_data -> 'items', '[]'::jsonb)) as x(product_id uuid, variant_id uuid, qty numeric)
     where coalesce(x.qty, 0) <= 0
  ) then
    raise exception 'invalid_qty';
  end if;
  if nullif(p_data ->> 'declared_value', '') is not null then
    v_value := round((p_data ->> 'declared_value')::numeric, 2);
    if v_value < 0 then
      raise exception 'invalid_declared_value';
    end if;
  end if;

  -- Emisor (foto) y receptor (por defecto, el cliente de la venta).
  select jsonb_build_object(
           'legal_name', b.legal_name, 'trade_name', b.trade_name, 'cuit', b.cuit, 'iva_condition', b.iva_condition,
           'iibb', b.iibb, 'activity_start', b.activity_start, 'address', b.address, 'phone', b.phone,
           'logo_url', b.logo_url)
    into v_issuer
    from tenant_branding b where b.tenant_id = v_tenant;
  v_issuer := coalesce(v_issuer, '{}'::jsonb) || (
    select jsonb_build_object('store_name', st.name,
                              'store_address', concat_ws(', ', nullif(st.address, ''), nullif(st.city, ''), nullif(st.province, '')))
      from stores st where st.id = v_store);
  select c.name, nullif(btrim(concat_ws(' ', c.document_type, c.document_number)), '') as doc, c.iva_condition, c.address
    into v_cust
    from customers c where c.id = v_sale.customer_id;
  v_recv := coalesce(_remito_text(p_data, 'receiver_name', 120), v_disp.pickup_name, v_cust.name, v_disp.customer_name);
  if v_recv is null then
    raise exception 'receiver_required';
  end if;

  -- Número del punto de venta interno de la sucursal.
  perform pg_advisory_xact_lock(hashtext('remito_number:' || v_tenant::text));
  select * into v_point from remito_points where store_id = v_store and deleted_at is null;
  if v_point.id is null then
    insert into remito_points (tenant_id, store_id, pto_vta)
    values (v_tenant, v_store,
            coalesce((select max(p.pto_vta) from remito_points p where p.tenant_id = v_tenant and p.deleted_at is null), 0) + 1)
    returning * into v_point;
  end if;
  update remito_points set last_number = last_number + 1 where id = v_point.id returning last_number into v_number;

  insert into remitos (
    id, tenant_id, store_id, point_id, pto_vta, number, kind, dispatch_id, sale_id, issuer,
    receiver_name, receiver_doc, receiver_iva, receiver_address, delivery_address, packages, weight_kg,
    declared_value, show_prices, carrier_name, carrier_cuit, vehicle_plate, driver_name,
    cot_number, cot_jurisdiction, cot_valid_until, cot_source, notes, legend
  ) values (
    p_id, v_tenant, v_store, v_point.id, v_point.pto_vta, v_number, v_kind, v_disp.id, v_sale.id, v_issuer,
    v_recv,
    coalesce(_remito_text(p_data, 'receiver_doc', 40), v_cust.doc),
    coalesce(_remito_text(p_data, 'receiver_iva', 40), v_cust.iva_condition),
    coalesce(_remito_text(p_data, 'receiver_address', 300), v_cust.address),
    coalesce(_remito_text(p_data, 'delivery_address', 300), v_disp.ship_address),
    greatest(1, least(coalesce(nullif(p_data ->> 'packages', '')::int, 1), 9999)),
    nullif(p_data ->> 'weight_kg', '')::numeric,
    v_value, v_show,
    _remito_text(p_data, 'carrier_name', 120), v_cuit,
    upper(_remito_text(p_data, 'vehicle_plate', 20)), _remito_text(p_data, 'driver_name', 120),
    v_cot, v_jur, nullif(p_data ->> 'cot_valid_until', '')::date, case when v_cot is not null then 'manual' end,
    _remito_text(p_data, 'notes', 500), v_cfg ->> 'legend'
  );

  insert into remito_items (tenant_id, remito_id, store_id, product_id, variant_id, description, sku, unit, qty, unit_price, sort)
  select v_tenant, p_id, v_store, x.product_id, x.variant_id, left(x.description, 300), x.sku, coalesce(x.unit, 'un'),
         x.qty, x.unit_price, (row_number() over (order by x.description, x.sku))::int
    from jsonb_to_recordset(v_items) as x(product_id uuid, variant_id uuid, description text, sku text,
                                         unit text, qty numeric, unit_price numeric);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'remitos', p_id, 'remito_issued',
          jsonb_build_object('pto_vta', v_point.pto_vta, 'number', v_number, 'kind', v_kind, 'dispatch_id', v_disp.id,
                             'sale_id', v_sale.id, 'declared_value', v_value, 'cot_number', v_cot,
                             'cot_jurisdiction', v_jur, 'items', jsonb_array_length(v_items)),
          v_store);

  return jsonb_build_object('id', p_id, 'pto_vta', v_point.pto_vta, 'number', v_number,
                            'cot_required', remito_cot_required((v_cfg ->> 'cot_threshold')::numeric, v_jur, v_value)
                                            and v_cot is null);
end;
$$;
revoke all on function remito_issue(uuid, jsonb) from public, anon;
grant execute on function remito_issue(uuid, jsonb) to authenticated;

-- Transporte, COT y recepción de un remito emitido. Sólo cambia lo que viene.
create or replace function remito_update(p_id uuid, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r      remitos;
  v_tenant uuid;
  v_cot    text;
  v_cuit   text;
  v_jur    text;
begin
  select * into v_r from remitos where id = p_id and tenant_id = current_tenant_id() and deleted_at is null for update;
  if v_r.id is null then
    raise exception 'remito_not_found';
  end if;
  v_tenant := _remito_assert(v_r.store_id);
  if v_r.status <> 'emitido' then
    raise exception 'remito_voided';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object' then
    raise exception 'invalid_remito';
  end if;
  v_cot := case when p_data ? 'cot_number' then _remito_text(p_data, 'cot_number', 40) else v_r.cot_number end;
  if v_cot is not null and v_cot !~ '^[0-9A-Za-z-]{6,40}$' then
    raise exception 'invalid_cot';
  end if;
  v_jur := case when p_data ? 'cot_jurisdiction' then coalesce(nullif(p_data ->> 'cot_jurisdiction', ''), 'pba') else v_r.cot_jurisdiction end;
  if v_jur is not null and v_jur not in ('pba', 'caba', 'otra') then
    raise exception 'invalid_cot_jurisdiction';
  end if;
  v_cuit := case when p_data ? 'carrier_cuit'
                 then nullif(regexp_replace(coalesce(p_data ->> 'carrier_cuit', ''), '\D', '', 'g'), '')
                 else v_r.carrier_cuit end;
  if v_cuit is not null and v_cuit !~ '^[0-9]{11}$' then
    raise exception 'invalid_carrier_cuit';
  end if;

  update remitos set
    cot_number       = v_cot,
    cot_jurisdiction = v_jur,
    cot_valid_until  = case when p_data ? 'cot_valid_until' then nullif(p_data ->> 'cot_valid_until', '')::date else cot_valid_until end,
    cot_source       = case when v_cot is null then null when v_cot is distinct from v_r.cot_number then 'manual' else cot_source end,
    carrier_name     = case when p_data ? 'carrier_name' then _remito_text(p_data, 'carrier_name', 120) else carrier_name end,
    carrier_cuit     = v_cuit,
    vehicle_plate    = case when p_data ? 'vehicle_plate' then upper(_remito_text(p_data, 'vehicle_plate', 20)) else vehicle_plate end,
    driver_name      = case when p_data ? 'driver_name' then _remito_text(p_data, 'driver_name', 120) else driver_name end,
    packages         = case when p_data ? 'packages'
                            then greatest(1, least(coalesce(nullif(p_data ->> 'packages', '')::int, 1), 9999)) else packages end,
    weight_kg        = case when p_data ? 'weight_kg' then nullif(p_data ->> 'weight_kg', '')::numeric else weight_kg end,
    received_name    = case when p_data ? 'received_name' then _remito_text(p_data, 'received_name', 120) else received_name end,
    received_doc     = case when p_data ? 'received_doc' then _remito_text(p_data, 'received_doc', 40) else received_doc end,
    received_at      = case when p_data ? 'received_name'
                            then case when _remito_text(p_data, 'received_name', 120) is null then null else coalesce(received_at, now()) end
                            else received_at end
  where id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_tenant, auth.uid(), 'remitos', p_id,
          case when v_cot is distinct from v_r.cot_number then 'remito_cot_set' else 'remito_updated' end,
          jsonb_build_object('cot_number', v_r.cot_number, 'carrier_name', v_r.carrier_name, 'received_name', v_r.received_name),
          p_data - 'received_doc', v_r.store_id);
end;
$$;
revoke all on function remito_update(uuid, jsonb) from public, anon;
grant execute on function remito_update(uuid, jsonb) to authenticated;

-- Anular (dueño o encargado, con motivo). El número no se reutiliza.
create or replace function remito_void(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r      remitos;
  v_tenant uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  select * into v_r from remitos where id = p_id and tenant_id = current_tenant_id() and deleted_at is null for update;
  if v_r.id is null then
    raise exception 'remito_not_found';
  end if;
  v_tenant := _remito_assert(v_r.store_id);
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'void_requires_manager' using errcode = '42501';
  end if;
  if v_r.status <> 'emitido' then
    raise exception 'remito_voided';
  end if;
  update remitos set status = 'anulado', void_reason = left(v_reason, 300), voided_by = auth.uid(), voided_at = now()
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason, store_id)
  values (v_tenant, auth.uid(), 'remitos', p_id, 'remito_voided',
          jsonb_build_object('status', 'emitido', 'number', v_r.number, 'pto_vta', v_r.pto_vta),
          jsonb_build_object('status', 'anulado'), v_reason, v_r.store_id);
end;
$$;
revoke all on function remito_void(uuid, text) from public, anon;
grant execute on function remito_void(uuid, text) to authenticated;

-- Configuración (dueño o encargado; la tabla pos_settings es sólo del dueño
-- por RLS, así que se guarda por RPC).
create or replace function remito_config_save(p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_before jsonb;
  v_t      numeric;
  v_new    jsonb;
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'entregas_remitos') then
    raise exception 'feature_not_in_plan: entregas_remitos' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p_config) is distinct from 'object' then
    raise exception 'invalid_config';
  end if;
  v_t := nullif(p_config ->> 'cot_threshold', '')::numeric;
  if v_t is not null and (v_t < 0 or v_t > 999999999999) then
    raise exception 'invalid_cot_threshold';
  end if;
  v_new := jsonb_strip_nulls(jsonb_build_object(
    'cot_threshold', v_t,
    'cot_jurisdiction', case when p_config ->> 'cot_jurisdiction' in ('pba', 'caba', 'otra') then p_config ->> 'cot_jurisdiction' end,
    'show_prices', case when p_config ->> 'show_prices' in ('true', 'false') then (p_config ->> 'show_prices')::boolean end,
    'legend', left(nullif(btrim(coalesce(p_config ->> 'legend', '')), ''), 300)));
  select ps.remito_config into v_before from pos_settings ps where ps.tenant_id = v_tenant;
  insert into pos_settings (tenant_id, remito_config) values (v_tenant, v_new)
  on conflict (tenant_id) do update set remito_config = excluded.remito_config;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'pos_settings', null, 'remito_config_saved', v_before, v_new);
  return remito_config(v_tenant);
end;
$$;
revoke all on function remito_config_save(jsonb) from public, anon;
grant execute on function remito_config_save(jsonb) to authenticated;

-- Lectura de la configuración normalizada (cualquier miembro del negocio).
create or replace function remito_config_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or stock_my_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return remito_config(v_tenant);
end;
$$;
revoke all on function remito_config_get() from public, anon;
grant execute on function remito_config_get() to authenticated;
