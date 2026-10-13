-- =============================================================================
-- 20261109100100_reservas_stock  (F16 · H77, H78, ADR-091)
--
-- Reservas de stock y retiro en tienda (Click & Collect) sin tocar
-- create_sale, return_sale ni el libro de stock por sucursal (ADR-046).
--
-- Modelo:
--   • stock_reservations: una reserva para un cliente en una sucursal (donde
--     está el stock y donde retira). `origin_store_id` es la sucursal desde
--     donde se pidió cuando no es la misma (venta asistida con stock de otra
--     tienda). Canal: mostrador, teléfono, WhatsApp, web u otra sucursal.
--     Estados: reservada → preparada → entregada; o cancelada / vencida.
--   • stock_reservation_items: renglones (producto, variante, cantidad).
--   • La reserva NO mueve stock. Compromete: lo disponible para reservar en
--     la sucursal es product_stock.qty − lo reservado vigente (reservada o
--     preparada, sin vencer). Al retirar, el cajero cobra en el POS (la venta
--     descuenta el stock como siempre) y la reserva se entrega con el número
--     de esa venta: el servidor valida que la venta sea de la misma sucursal,
--     esté completada, cubra los renglones y no esté usada por otra reserva.
--   • Deuda documentada (ADR-091): create_sale no conoce las reservas, así
--     que una venta de mostrador puede consumir stock reservado. El POS lo
--     avisa (disponible = stock − reservado) y el cockpit muestra lo
--     comprometido; el bloqueo duro queda para la próxima versión de
--     create_sale.
--
-- Identidad al retirar: código de 6 dígitos que se muestra UNA vez al crear
-- (se guarda sólo el hash con la reserva como sal) o el documento del
-- cliente. Cinco intentos fallidos bloquean el código; desde ahí sólo un
-- dueño o encargado entrega, con motivo (queda en audit_logs).
--
-- Seguridad:
--   • Lectura: tenant_id = (select current_tenant_id()) or (select
--     internal_scope()) + RESTRICTIVE por sucursal: la de la reserva o la de
--     origen dentro de user_allowed_store_ids().
--   • Escritura sólo por RPC SECURITY DEFINER (sin policies de escritura) +
--     role_write_guard 'operate' (ADR-071): solo lectura no escribe nunca.
--   • Roles: dueño, encargado y cajero crean, preparan, entregan y cancelan
--     (es operación de mostrador); la entrega sin código pide encargado.
--   • Gating: feature `reservas_stock` en todas las RPC; fuera de la
--     sucursal principal pide también `stock_sucursales`.
--   • audit_logs en cada escritura.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tablas
-- -----------------------------------------------------------------------------
create table if not exists stock_reservations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  number           int not null,
  store_id         uuid not null references stores(id),
  origin_store_id  uuid references stores(id),
  channel          text not null default 'mostrador'
                     check (channel in ('mostrador', 'telefono', 'whatsapp', 'web', 'otra_sucursal')),
  customer_id      uuid references customers(id) on delete set null,
  customer_name    text not null check (char_length(btrim(customer_name)) between 1 and 120),
  customer_phone   text check (customer_phone is null or char_length(customer_phone) <= 40),
  customer_doc     text check (customer_doc is null or customer_doc ~ '^[0-9]{6,11}$'),
  pickup_code_hash text not null,
  failed_attempts  int not null default 0 check (failed_attempts >= 0),
  status           text not null default 'reservada'
                     check (status in ('reservada', 'preparada', 'entregada', 'cancelada', 'vencida')),
  expires_at       timestamptz not null,
  notes            text check (notes is null or char_length(notes) <= 500),
  total_units      numeric(14,3) not null default 0,
  total_value      numeric(14,2) not null default 0,
  sale_id          uuid references sales(id) on delete set null,
  cancel_reason    text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  override_reason  text check (override_reason is null or char_length(override_reason) <= 300),
  created_by       uuid default auth.uid() references public.users(id),
  prepared_by      uuid references public.users(id),
  prepared_at      timestamptz,
  delivered_by     uuid references public.users(id),
  delivered_at     timestamptz,
  cancelled_by     uuid references public.users(id),
  cancelled_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint stock_reservations_tenant_number_key unique (tenant_id, number),
  constraint stock_reservations_origin_distinct check (origin_store_id is null or origin_store_id <> store_id)
);

comment on table stock_reservations is
  'Reservas de stock con retiro en tienda (F16/H77, ADR-091). No mueven stock: comprometen lo disponible de la sucursal hasta entregarse con una venta, cancelarse o vencer.';

create index if not exists stock_reservations_tenant_status_idx
  on stock_reservations(tenant_id, status, expires_at);
create index if not exists stock_reservations_store_idx on stock_reservations(store_id, status);
create index if not exists stock_reservations_origin_idx on stock_reservations(origin_store_id)
  where origin_store_id is not null;
create unique index if not exists stock_reservations_sale_key on stock_reservations(sale_id)
  where sale_id is not null;
-- Índices de las FK (guard de rendimiento F4).
create index if not exists stock_reservations_customer_idx on stock_reservations(customer_id)
  where customer_id is not null;
create index if not exists stock_reservations_created_by_idx on stock_reservations(created_by);
create index if not exists stock_reservations_prepared_by_idx on stock_reservations(prepared_by)
  where prepared_by is not null;
create index if not exists stock_reservations_delivered_by_idx on stock_reservations(delivered_by)
  where delivered_by is not null;
create index if not exists stock_reservations_cancelled_by_idx on stock_reservations(cancelled_by)
  where cancelled_by is not null;

drop trigger if exists set_updated_at_stock_reservations on stock_reservations;
create trigger set_updated_at_stock_reservations
  before update on stock_reservations
  for each row execute function set_updated_at();

create table if not exists stock_reservation_items (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  reservation_id uuid not null references stock_reservations(id) on delete cascade,
  store_id       uuid not null references stores(id),
  product_id     uuid not null references products(id),
  variant_id     uuid references product_variants(id),
  product_name   text not null,
  variant_label  text,
  sku            text,
  unit           text not null default 'un',
  qty            numeric(12,3) not null check (qty > 0),
  unit_price     numeric(12,2) not null default 0,
  sort           int not null default 0,
  created_at     timestamptz not null default now(),
  constraint stock_reservation_items_line_key unique nulls not distinct (reservation_id, product_id, variant_id)
);

create index if not exists stock_reservation_items_reservation_idx on stock_reservation_items(reservation_id);
create index if not exists stock_reservation_items_item_idx on stock_reservation_items(store_id, product_id, variant_id);
create index if not exists stock_reservation_items_tenant_idx on stock_reservation_items(tenant_id);
create index if not exists stock_reservation_items_product_idx on stock_reservation_items(product_id);
create index if not exists stock_reservation_items_variant_idx on stock_reservation_items(variant_id)
  where variant_id is not null;

-- -----------------------------------------------------------------------------
-- B) RLS: lectura por negocio + alcance de sucursal. Sin policies de escritura.
-- -----------------------------------------------------------------------------
alter table stock_reservations enable row level security;
alter table stock_reservation_items enable row level security;

drop policy if exists stock_reservations_select on stock_reservations;
create policy stock_reservations_select on stock_reservations
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists stock_reservation_items_select on stock_reservation_items;
create policy stock_reservation_items_select on stock_reservation_items
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

drop policy if exists stock_reservations_branch_scope on stock_reservations;
create policy stock_reservations_branch_scope on stock_reservations
  as restrictive for select
  using (
    (select internal_scope())
    or store_id = any ((select user_allowed_store_ids())::uuid[])
    or origin_store_id = any ((select user_allowed_store_ids())::uuid[])
  );

drop policy if exists stock_reservation_items_branch_scope on stock_reservation_items;
create policy stock_reservation_items_branch_scope on stock_reservation_items
  as restrictive for select
  using (
    (select internal_scope())
    or exists (
      select 1 from stock_reservations r
       where r.id = stock_reservation_items.reservation_id
         and (r.store_id = any ((select user_allowed_store_ids())::uuid[])
              or r.origin_store_id = any ((select user_allowed_store_ids())::uuid[]))
    )
  );

-- Permisos por rol (ADR-071): operación de mostrador, modo 'operate'.
do $$
declare
  t text;
begin
  foreach t in array array['stock_reservations', 'stock_reservation_items'] loop
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'operate');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Helpers
-- -----------------------------------------------------------------------------
-- Guard común: negocio, miembro activo que no es solo lectura, plan y
-- sucursal. Con p_origin, alcanza con acceder a la sucursal de origen (venta
-- asistida con stock de otra tienda). Devuelve el tenant.
create or replace function stock_reservation_assert(p_store_id uuid, p_origin_store_id uuid default null)
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
  if not tenant_has_feature_for(v_tenant, 'reservas_stock') then
    raise exception 'feature_not_in_plan: reservas_stock' using errcode = 'check_violation';
  end if;
  if p_store_id is null or not exists (
    select 1 from stores where id = p_store_id and tenant_id = v_tenant and deleted_at is null
  ) then
    raise exception 'store_not_found';
  end if;
  if p_store_id is distinct from stock_default_store(v_tenant)
     and not tenant_has_feature_for(v_tenant, 'stock_sucursales') then
    raise exception 'feature_not_in_plan: stock_sucursales' using errcode = 'check_violation';
  end if;
  if not coalesce(user_can_access_store(p_store_id), false)
     and not (p_origin_store_id is not null
              and exists (select 1 from stores where id = p_origin_store_id and tenant_id = v_tenant)
              and coalesce(user_can_access_store(p_origin_store_id), false)) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function stock_reservation_assert(uuid, uuid) from public, anon, authenticated;

-- Hash del código de retiro (la reserva es la sal).
create or replace function stock_reservation_code_hash(p_id uuid, p_code text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select encode(digest(convert_to(p_id::text || ':' || btrim(coalesce(p_code, '')), 'UTF8'), 'sha256'), 'hex');
$$;
revoke all on function stock_reservation_code_hash(uuid, text) from public, anon, authenticated;

-- Reservado vigente de un ítem en una sucursal (reservada o preparada, sin
-- vencer). p_exclude deja afuera una reserva (para recalcular la propia).
create or replace function stock_reserved_qty(p_store uuid, p_product uuid, p_variant uuid, p_exclude uuid default null)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(i.qty), 0)
    from stock_reservation_items i
    join stock_reservations r on r.id = i.reservation_id
   where i.store_id = p_store
     and i.product_id = p_product
     and i.variant_id is not distinct from p_variant
     and r.status in ('reservada', 'preparada')
     and r.expires_at > now()
     and (p_exclude is null or r.id <> p_exclude);
$$;
revoke all on function stock_reserved_qty(uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- Pasa a 'vencida' las reservas del negocio que vencieron. Lo llaman las RPC
-- de escritura y la lista (perezoso, sin cron).
create or replace function stock_reservations_expire_due(p_tenant uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  with due as (
    update stock_reservations
       set status = 'vencida'
     where tenant_id = p_tenant
       and status in ('reservada', 'preparada')
       and expires_at <= now()
    returning id, store_id
  ), aud as (
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    select p_tenant, auth.uid(), 'stock_reservations', d.id, 'stock_reservation_expired',
           jsonb_build_object('store_id', d.store_id)
      from due d
    returning 1
  )
  select count(*) into v_n from aud;
  return v_n;
end;
$$;
revoke all on function stock_reservations_expire_due(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Crear
-- -----------------------------------------------------------------------------
-- p_items: [{product_id, variant_id, qty}]. Devuelve {id, number, pickup_code}.
-- El código se muestra UNA vez: sólo se guarda su hash.
create or replace function stock_reservation_create(
  p_store_id        uuid,
  p_items           jsonb,
  p_customer_name   text,
  p_customer_id     uuid default null,
  p_customer_phone  text default null,
  p_customer_doc    text default null,
  p_channel         text default 'mostrador',
  p_expires_at      timestamptz default null,
  p_notes           text default null,
  p_origin_store_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant  uuid;
  v_id      uuid := gen_random_uuid();
  v_number  int;
  v_code    text;
  v_expires timestamptz := coalesce(p_expires_at, now() + interval '48 hours');
  v_doc     text := nullif(regexp_replace(coalesce(p_customer_doc, ''), '\D', '', 'g'), '');
  v_origin  uuid := case when p_origin_store_id = p_store_id then null else p_origin_store_id end;
  v_channel text := coalesce(nullif(btrim(p_channel), ''), 'mostrador');
  v_it      record;
  v_info    record;
  v_price   numeric;
  v_avail   numeric;
  v_units   numeric := 0;
  v_value   numeric := 0;
  v_sort    int := 0;
begin
  v_tenant := stock_reservation_assert(p_store_id, v_origin);

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'items_required';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'too_many_items';
  end if;
  if char_length(btrim(coalesce(p_customer_name, ''))) = 0 then
    raise exception 'customer_name_required';
  end if;
  if v_expires <= now() + interval '5 minutes' or v_expires > now() + interval '30 days' then
    raise exception 'invalid_expiry';
  end if;
  if v_doc is not null and v_doc !~ '^[0-9]{6,11}$' then
    raise exception 'invalid_customer_doc';
  end if;
  if v_origin is not null and v_channel = 'mostrador' then
    v_channel := 'otra_sucursal';
  end if;
  if p_customer_id is not null and not exists (
    select 1 from customers where id = p_customer_id and tenant_id = v_tenant
  ) then
    raise exception 'customer_not_found';
  end if;

  perform stock_reservations_expire_due(v_tenant);

  -- Serializa las reservas de la sucursal: dos reservas simultáneas no
  -- comprometen el mismo disponible.
  perform pg_advisory_xact_lock(hashtext('stock_reservation:' || p_store_id::text));
  perform pg_advisory_xact_lock(hashtext('stock_reservation_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from stock_reservations where tenant_id = v_tenant;

  v_code := otp_random_digits(6);

  insert into stock_reservations (
    id, tenant_id, number, store_id, origin_store_id, channel, customer_id, customer_name,
    customer_phone, customer_doc, pickup_code_hash, expires_at, notes
  ) values (
    v_id, v_tenant, v_number, p_store_id, v_origin, v_channel, p_customer_id, btrim(p_customer_name),
    nullif(btrim(coalesce(p_customer_phone, '')), ''), v_doc,
    stock_reservation_code_hash(v_id, v_code), v_expires,
    nullif(btrim(coalesce(p_notes, '')), '')
  );

  for v_it in
    select x.product_id, x.variant_id, x.qty
      from jsonb_to_recordset(p_items) as x(product_id uuid, variant_id uuid, qty numeric)
  loop
    if v_it.product_id is null or coalesce(v_it.qty, 0) <= 0 then
      raise exception 'invalid_item';
    end if;
    select * into v_info from warehouse_item_info(v_tenant, v_it.product_id, v_it.variant_id);

    select coalesce(v.price_override, p.price, 0) into v_price
      from products p
      left join product_variants v on v.id = v_it.variant_id
     where p.id = v_it.product_id;

    v_avail := coalesce((select ps.qty from product_stock ps
                          where ps.store_id = p_store_id and ps.product_id = v_it.product_id
                            and ps.variant_id is not distinct from v_it.variant_id), 0)
             - stock_reserved_qty(p_store_id, v_it.product_id, v_it.variant_id, v_id);
    if v_avail < v_it.qty then
      raise exception 'insufficient_available_stock: %', v_info.product_name;
    end if;

    begin
      insert into stock_reservation_items (
        tenant_id, reservation_id, store_id, product_id, variant_id, product_name, variant_label,
        sku, unit, qty, unit_price, sort
      ) values (
        v_tenant, v_id, p_store_id, v_it.product_id, v_it.variant_id, v_info.product_name,
        v_info.variant_label, v_info.sku, v_info.unit, v_it.qty, coalesce(v_price, 0), v_sort
      );
    exception when unique_violation then
      raise exception 'duplicate_item';
    end;
    v_sort := v_sort + 1;
    v_units := v_units + v_it.qty;
    v_value := v_value + v_it.qty * coalesce(v_price, 0);
  end loop;

  update stock_reservations
     set total_units = v_units, total_value = round(v_value, 2)
   where id = v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'stock_reservations', v_id, 'stock_reservation_created',
          jsonb_build_object('number', v_number, 'store_id', p_store_id, 'origin_store_id', v_origin,
                             'channel', v_channel, 'customer_name', btrim(p_customer_name),
                             'total_units', v_units, 'expires_at', v_expires));

  return jsonb_build_object('id', v_id, 'number', v_number, 'pickup_code', v_code, 'expires_at', v_expires);
end;
$$;
revoke all on function stock_reservation_create(uuid, jsonb, text, uuid, text, text, text, timestamptz, text, uuid) from public, anon;
grant execute on function stock_reservation_create(uuid, jsonb, text, uuid, text, text, text, timestamptz, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Preparar
-- -----------------------------------------------------------------------------
create or replace function stock_reservation_prepare(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res    stock_reservations;
  v_tenant uuid;
begin
  select * into v_res from stock_reservations where id = p_id and tenant_id = current_tenant_id() for update;
  if v_res.id is null then
    raise exception 'reservation_not_found';
  end if;
  v_tenant := stock_reservation_assert(v_res.store_id, null);
  perform stock_reservations_expire_due(v_tenant);
  select * into v_res from stock_reservations where id = p_id;
  if v_res.status <> 'reservada' then
    raise exception 'invalid_status: %', v_res.status;
  end if;
  update stock_reservations
     set status = 'preparada', prepared_by = auth.uid(), prepared_at = now()
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'stock_reservations', p_id, 'stock_reservation_prepared',
          jsonb_build_object('status', v_res.status), jsonb_build_object('status', 'preparada'));
end;
$$;
revoke all on function stock_reservation_prepare(uuid) from public, anon;
grant execute on function stock_reservation_prepare(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Entregar (retiro en tienda)
-- -----------------------------------------------------------------------------
-- Valida identidad (código o documento) y la venta con la que se cobró.
-- Devuelve {ok: true} o {ok: false, error}: un código mal tipeado NO lanza
-- excepción para que el intento fallido quede contado.
create or replace function stock_reservation_deliver(
  p_id              uuid,
  p_sale_number     bigint,
  p_code            text default null,
  p_customer_doc    text default null,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_res      stock_reservations;
  v_tenant   uuid;
  v_role     text := stock_my_role();
  v_doc      text := nullif(regexp_replace(coalesce(p_customer_doc, ''), '\D', '', 'g'), '');
  v_override text := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_ok_code  boolean := false;
  v_ok_doc   boolean := false;
  v_sale     record;
  v_missing  int;
begin
  select * into v_res from stock_reservations where id = p_id and tenant_id = current_tenant_id() for update;
  if v_res.id is null then
    raise exception 'reservation_not_found';
  end if;
  v_tenant := stock_reservation_assert(v_res.store_id, null);
  if not coalesce(user_can_access_store(v_res.store_id), false) then
    -- Retira el cliente en la sucursal de la reserva: entrega quien está ahí.
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  if v_res.status in ('reservada', 'preparada') and v_res.expires_at <= now() then
    perform stock_reservations_expire_due(v_tenant);
    raise exception 'reservation_expired';
  end if;
  if v_res.status not in ('reservada', 'preparada') then
    raise exception 'invalid_status: %', v_res.status;
  end if;

  -- Identidad.
  if v_res.failed_attempts < 5 and nullif(btrim(coalesce(p_code, '')), '') is not null then
    v_ok_code := stock_reservation_code_hash(v_res.id, p_code) = v_res.pickup_code_hash;
  end if;
  if v_doc is not null and v_res.customer_doc is not null then
    v_ok_doc := v_doc = v_res.customer_doc;
  end if;
  if not (v_ok_code or v_ok_doc) then
    if v_override is not null then
      if v_role not in ('owner', 'manager') then
        raise exception 'override_requires_manager' using errcode = '42501';
      end if;
    else
      update stock_reservations set failed_attempts = failed_attempts + 1 where id = p_id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (v_tenant, auth.uid(), 'stock_reservations', p_id, 'stock_reservation_pickup_failed',
              jsonb_build_object('failed_attempts', v_res.failed_attempts + 1));
      return jsonb_build_object(
        'ok', false,
        'error', case when v_res.failed_attempts + 1 >= 5 then 'pickup_code_locked' else 'pickup_code_invalid' end,
        'attempts_left', greatest(5 - (v_res.failed_attempts + 1), 0));
    end if;
  end if;

  -- Venta con la que se cobró el retiro.
  if p_sale_number is null then
    raise exception 'sale_required';
  end if;
  select s.id, s.store_id, s.status into v_sale
    from sales s
   where s.tenant_id = v_tenant and s.number = p_sale_number;
  if v_sale.id is null then
    raise exception 'sale_not_found';
  end if;
  if v_sale.status <> 'completed' then
    raise exception 'sale_not_completed';
  end if;
  if v_sale.store_id <> v_res.store_id then
    raise exception 'sale_wrong_store';
  end if;
  if exists (select 1 from stock_reservations where sale_id = v_sale.id and id <> p_id) then
    raise exception 'sale_already_used';
  end if;
  select count(*) into v_missing
    from stock_reservation_items i
   where i.reservation_id = p_id
     and i.qty > coalesce((
       select sum(si.quantity - coalesce(si.returned_qty, 0))
         from sale_items si
        where si.sale_id = v_sale.id
          and si.product_id = i.product_id
          and si.variant_id is not distinct from i.variant_id), 0);
  if v_missing > 0 then
    raise exception 'sale_items_mismatch';
  end if;

  update stock_reservations
     set status = 'entregada', sale_id = v_sale.id, delivered_by = auth.uid(), delivered_at = now(),
         override_reason = case when v_ok_code or v_ok_doc then null else v_override end
   where id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'stock_reservations', p_id, 'stock_reservation_delivered',
          jsonb_build_object('status', v_res.status),
          jsonb_build_object('status', 'entregada', 'sale_id', v_sale.id,
                             'verified_by', case when v_ok_code then 'code' when v_ok_doc then 'doc' else 'override' end),
          case when v_ok_code or v_ok_doc then null else v_override end);

  return jsonb_build_object('ok', true, 'sale_id', v_sale.id);
end;
$$;
revoke all on function stock_reservation_deliver(uuid, bigint, text, text, text) from public, anon;
grant execute on function stock_reservation_deliver(uuid, bigint, text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- G) Cancelar
-- -----------------------------------------------------------------------------
create or replace function stock_reservation_cancel(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res    stock_reservations;
  v_tenant uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_reason is null then
    raise exception 'reason_required';
  end if;
  select * into v_res from stock_reservations where id = p_id and tenant_id = current_tenant_id() for update;
  if v_res.id is null then
    raise exception 'reservation_not_found';
  end if;
  v_tenant := stock_reservation_assert(v_res.store_id, v_res.origin_store_id);
  if v_res.status not in ('reservada', 'preparada') then
    raise exception 'invalid_status: %', v_res.status;
  end if;
  update stock_reservations
     set status = 'cancelada', cancel_reason = left(v_reason, 300),
         cancelled_by = auth.uid(), cancelled_at = now()
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'stock_reservations', p_id, 'stock_reservation_cancelled',
          jsonb_build_object('status', v_res.status), jsonb_build_object('status', 'cancelada'), v_reason);
end;
$$;
revoke all on function stock_reservation_cancel(uuid, text) from public, anon;
grant execute on function stock_reservation_cancel(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- H) Disponible para reservar (para el formulario y el POS)
-- -----------------------------------------------------------------------------
-- Por cada ítem pedido: stock de la sucursal, reservado vigente y disponible.
create or replace function stock_reservation_availability(p_store_id uuid, p_product_ids uuid[])
returns table (product_id uuid, variant_id uuid, on_hand numeric, reserved numeric, available numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if stock_my_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'reservas_stock') then
    raise exception 'feature_not_in_plan: reservas_stock' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from stores where id = p_store_id and tenant_id = v_tenant) then
    raise exception 'store_not_found';
  end if;
  if coalesce(array_length(p_product_ids, 1), 0) > 200 then
    raise exception 'too_many_items';
  end if;
  -- El stock de otras sucursales es legible por decisión (ADR-080).
  return query
    select ps.product_id, ps.variant_id, ps.qty,
           stock_reserved_qty(p_store_id, ps.product_id, ps.variant_id, null),
           ps.qty - stock_reserved_qty(p_store_id, ps.product_id, ps.variant_id, null)
      from product_stock ps
     where ps.store_id = p_store_id
       and ps.tenant_id = v_tenant
       and ps.product_id = any (coalesce(p_product_ids, '{}'::uuid[]));
end;
$$;
revoke all on function stock_reservation_availability(uuid, uuid[]) from public, anon;
grant execute on function stock_reservation_availability(uuid, uuid[]) to authenticated;
