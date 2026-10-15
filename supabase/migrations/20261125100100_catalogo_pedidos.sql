-- =============================================================================
-- 20261125100100_catalogo_pedidos  (F6 · H10, ADR-130)
--
-- Carrito y pedido del catálogo público (/c/<slug>). El pedido NO es un modelo
-- nuevo: entra como pedido de salón de H32 (sale_orders, ADR-129) con origen
-- 'catalogo_publico', reserva de stock canal 'pedido' con los minutos de
-- order_config, y sigue el circuito de siempre: la caja lo levanta y lo cobra
-- (sale_order_take + create_sale con la reserva) y expedición lo entrega o lo
-- despacha. Nada de sale_order_take, sale_order_complete, la expiración ni la
-- expedición cambia.
--
-- Flujo:
--   1. public_catalog(slug) suma, si el negocio recibe pedidos, el bloque
--      'ordering' (tipos de entrega, sucursales de retiro, pago con link) y
--      las variantes con su precio y disponible de la sucursal del catálogo.
--   2. El cliente confirma: public_catalog_order_create(slug, pedido). El
--      servidor resuelve precios (lista 'catalogo'), valida stock disponible,
--      tipo de entrega y datos, aplica rate limit por IP y negocio y el
--      honeypot, crea el pedido con el carrito en el formato de
--      paused_sales.cart (el POS lo carga igual que uno del vendedor), reserva
--      el stock, avisa al negocio (centro de notificaciones) y encola el email
--      de confirmación (system_emails, mailer de plataforma) si dejó email.
--   3. El cliente sigue el pedido con el token (public_catalog_order_status).
--      El token lo genera el navegador (reintento idempotente sin perderlo) y
--      se guarda sólo su hash.
--
-- Seguridad:
--   • Las dos RPC públicas son SECURITY DEFINER con search_path fijo; validan
--     slug, estado del negocio y plan (catalogo_publico + catalogo_pedidos +
--     pedidos_despacho con tenant_has_feature_for) y que el dueño lo prendió.
--   • Precios, totales, disponible y sucursal salen del servidor: del cliente
--     sólo se toman ids, cantidades y datos de contacto.
--   • Sin ids ni datos de otros negocios: todo se busca por tenant_id del slug
--     y el seguimiento devuelve sólo el pedido de ese token.
--   • catalog_order_attempts: RLS activa sin policies ni grants.
--   • sale_orders sigue sin escritura por REST; el hash del token no se
--     concede por columna ni sale en _sale_order_json.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) sale_orders: origen, email, preferencia de pago y token de seguimiento
-- -----------------------------------------------------------------------------
alter table sale_orders add column if not exists source text not null default 'pos';
alter table sale_orders add column if not exists customer_email text;
alter table sale_orders add column if not exists payment_preference text;
alter table sale_orders add column if not exists public_token_hash text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sale_orders_source_check') then
    alter table sale_orders add constraint sale_orders_source_check
      check (source in ('pos', 'catalogo_publico'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sale_orders_customer_email_check') then
    alter table sale_orders add constraint sale_orders_customer_email_check
      check (customer_email is null or char_length(customer_email) <= 160);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sale_orders_payment_preference_check') then
    alter table sale_orders add constraint sale_orders_payment_preference_check
      check (payment_preference is null or payment_preference in ('al_retirar', 'link'));
  end if;
end;
$$;

create unique index if not exists sale_orders_public_token_key on sale_orders(public_token_hash)
  where public_token_hash is not null;

comment on column sale_orders.source is
  'Origen del pedido (ADR-130): pos (lo armó el vendedor) o catalogo_publico (lo hizo el cliente en /c/<slug>).';
comment on column sale_orders.public_token_hash is
  'sha256 del token de seguimiento del cliente (ADR-130). No se concede por columna.';

grant select (source, customer_email, payment_preference) on sale_orders to authenticated;

-- Fila del pedido para el POS: tampoco devuelve el hash del token.
create or replace function _sale_order_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (to_jsonb(o) - 'pickup_code_hash' - 'public_token_hash')
         || jsonb_build_object('reservation_active', _sale_order_resv_active(o.reservation_id),
                               'has_pickup_code', o.pickup_code_hash is not null)
    from sale_orders o where o.id = p_id;
$$;
revoke all on function _sale_order_json(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Notificaciones: tipo 'pedidos'. Copia de la lista más nueva
--    (20261109200000_features_f14_comercial) + 'pedidos'.
-- -----------------------------------------------------------------------------
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications
  add constraint notifications_type_check
  check (type in ('news','plan','billing','usage','security','afip','maintenance','support',
                  'cobros','disputas','comercial','pedidos'));

-- -----------------------------------------------------------------------------
-- C) Rate limit: un registro por pedido creado (IP con hash, nunca en claro)
-- -----------------------------------------------------------------------------
create table if not exists catalog_order_attempts (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  ip_hash    text not null,
  created_at timestamptz not null default now()
);
comment on table catalog_order_attempts is
  'Rate limit de los pedidos del catálogo público (ADR-130): sha256(IP + negocio) y cuándo. Sólo la RPC escribe y lee.';
create index if not exists catalog_order_attempts_tenant_ip_idx
  on catalog_order_attempts(tenant_id, ip_hash, created_at);
create index if not exists catalog_order_attempts_tenant_created_idx
  on catalog_order_attempts(tenant_id, created_at);
alter table catalog_order_attempts enable row level security;
revoke all on catalog_order_attempts from anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Helpers
-- -----------------------------------------------------------------------------
-- Config de pedidos del catálogo: pos_settings.order_config -> 'catalog'.
-- Espejo en lib/orders/logic.ts (orderConfig().catalog), con test.
create or replace function _catalog_order_config(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'enabled', _jbool(c, 'enabled', false),
    'store_id', case when (c ->> 'store_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then c ->> 'store_id' end,
    'pay_link', _jbool(c, 'pay_link', false)
  )
  from (
    select coalesce((
      select case when jsonb_typeof(ps.order_config -> 'catalog') = 'object' then ps.order_config -> 'catalog' end
        from pos_settings ps where ps.tenant_id = p_tenant
    ), '{}'::jsonb) as c
  ) x;
$$;
revoke all on function _catalog_order_config(uuid) from public, anon, authenticated;

-- Sucursal del catálogo: donde se reserva, se cobra y desde donde se despacha
-- (la elegida en la config si sigue viva; si no, la principal del negocio).
create or replace function _catalog_order_store(p_tenant uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select s.id from stores s
      where s.id = (_catalog_order_config(p_tenant) ->> 'store_id')::uuid
        and s.tenant_id = p_tenant and s.deleted_at is null and coalesce(s.is_active, true)),
    stock_default_store(p_tenant)
  );
$$;
revoke all on function _catalog_order_store(uuid) from public, anon, authenticated;

-- ¿El negocio recibe pedidos desde el catálogo? Plan + dueño + algún tipo
-- de entrega del catálogo (retiro o envío) habilitado.
create or replace function _catalog_ordering(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select t.deleted_at is null and t.status in ('trial', 'active') from tenants t where t.id = p_tenant), false)
     and tenant_has_feature_for(p_tenant, 'catalogo_publico')
     and tenant_has_feature_for(p_tenant, 'catalogo_pedidos')
     and tenant_has_feature_for(p_tenant, 'pedidos_despacho')
     and (_catalog_order_config(p_tenant) ->> 'enabled')::boolean
     and (
       (pos_order_config(p_tenant) -> 'delivery_types' -> 'retiro' ->> 'enabled')::boolean
       or (pos_order_config(p_tenant) -> 'delivery_types' -> 'envio' ->> 'enabled')::boolean
     );
$$;
revoke all on function _catalog_ordering(uuid) from public, anon, authenticated;

-- Precio del catálogo (lista 'catalogo' activa): ítem de la variante → ítem
-- del producto → ajuste % sobre la base (precio de la variante o del
-- producto) → base. Espejo de resolvePrice (lib/prices/resolve.ts).
create or replace function _catalog_unit_price(
  p_list uuid, p_adj numeric, p_product uuid, p_variant uuid, p_base numeric
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when p_list is null then coalesce(p_base, 0) else coalesce(
    (select pli.price from price_list_items pli
      where p_variant is not null and pli.price_list_id = p_list
        and pli.product_id = p_product and pli.variant_id = p_variant
      limit 1),
    (select pli.price from price_list_items pli
      where pli.price_list_id = p_list and pli.product_id = p_product and pli.variant_id is null
      limit 1),
    case when p_adj is not null then round(coalesce(p_base, 0) * (1 + p_adj / 100), 2) end,
    coalesce(p_base, 0)
  ) end;
$$;
revoke all on function _catalog_unit_price(uuid, numeric, uuid, uuid, numeric) from public, anon, authenticated;

-- ¿Hay un proveedor de link de pago conectado? (Mercado Pago, MODO, Payway…)
create or replace function _catalog_link_ready(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (_catalog_order_config(p_tenant) ->> 'pay_link')::boolean
     and exists (
       select 1 from payment_secrets s
         join payment_providers pp on pp.key = s.provider_key
        where s.tenant_id = p_tenant and pp.channel = 'qr_link' and pp.is_active
     );
$$;
revoke all on function _catalog_link_ready(uuid) from public, anon, authenticated;

-- Disponible de la sucursal: stock − reservado vigente (todas las variantes
-- si p_all_variants).
create or replace function _catalog_available(
  p_store uuid, p_product uuid, p_variant uuid, p_all_variants boolean
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select greatest(
    coalesce((select sum(ps.qty) from product_stock ps
               where ps.store_id = p_store and ps.product_id = p_product
                 and (p_all_variants or ps.variant_id is not distinct from p_variant)), 0)
    - coalesce((select sum(i.qty) from stock_reservation_items i
                  join stock_reservations r on r.id = i.reservation_id
                 where i.store_id = p_store and i.product_id = p_product
                   and (p_all_variants or i.variant_id is not distinct from p_variant)
                   and r.status in ('reservada', 'preparada') and r.expires_at > now()), 0),
    0);
$$;
revoke all on function _catalog_available(uuid, uuid, uuid, boolean) from public, anon, authenticated;

-- Plata para textos del servidor: "$ 12.300,50" (formato argentino).
create or replace function _catalog_money(p numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select '$ ' || translate(to_char(round(coalesce(p, 0), 2), 'FM999G999G999G990D00'), ',.', '.,');
$$;
revoke all on function _catalog_money(numeric) from public, anon, authenticated;

create or replace function _catalog_html(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select replace(replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
                 '"', '&quot;'), '''', '&#39;');
$$;
revoke all on function _catalog_html(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- E) Catálogo público: + variantes, disponible de la sucursal del catálogo y
--    bloque 'ordering'. Copia de 20261123100100_pedidos_despacho (L).
-- -----------------------------------------------------------------------------
create or replace function public.public_catalog(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_t     record;
  v_order boolean := false;
  v_store uuid;
  v_list  uuid;
  v_adj   numeric;
  v_cfg   jsonb;
  v_ord   jsonb;
  v_home  jsonb;
begin
  select id, name, slug into v_t from tenants
   where slug = p_slug and deleted_at is null and status in ('trial', 'active')
     -- Gate de plan: sin catalogo_publico no se publica el storefront.
     and tenant_has_feature_for(id, 'catalogo_publico')
   limit 1;
  if v_t.id is null then
    return null;
  end if;

  select pl.id, pl.adjustment_pct into v_list, v_adj from price_lists pl
   where pl.tenant_id = v_t.id and pl.channel = 'catalogo' and pl.is_active and pl.deleted_at is null
   limit 1;

  -- ADR-130: pedidos desde el catálogo.
  if _catalog_ordering(v_t.id) then
    v_store := _catalog_order_store(v_t.id);
    v_order := v_store is not null;
  end if;
  if v_order then
    v_cfg := pos_order_config(v_t.id);
    select jsonb_build_object('id', s.id, 'name', coalesce(nullif(btrim(s.short_name), ''), s.name), 'address', s.address)
      into v_home from stores s where s.id = v_store;
    v_ord := jsonb_build_object(
      'enabled', true,
      'store', v_home,
      'reservation_minutes', (v_cfg ->> 'reservation_minutes')::int,
      'retiro', jsonb_build_object(
        'enabled', (v_cfg -> 'delivery_types' -> 'retiro' ->> 'enabled')::boolean,
        'pickup_code', (v_cfg -> 'delivery_types' -> 'retiro' ->> 'pickup_code')::boolean,
        'stores', case when (v_cfg -> 'delivery_types' -> 'retiro' ->> 'cross_branch')::boolean then coalesce((
            select jsonb_agg(jsonb_build_object('id', s.id, 'name', coalesce(nullif(btrim(s.short_name), ''), s.name),
                                                'address', s.address)
                             order by (s.id <> v_store), s.sort, s.name)
              from stores s
             where s.tenant_id = v_t.id and s.deleted_at is null and coalesce(s.is_active, true)
          ), jsonb_build_array(v_home)) else jsonb_build_array(v_home) end
      ),
      'envio', jsonb_build_object('enabled', (v_cfg -> 'delivery_types' -> 'envio' ->> 'enabled')::boolean),
      'pay_link', _catalog_link_ready(v_t.id)
    );
  end if;

  return jsonb_build_object(
    'tenant', jsonb_build_object('name', v_t.name, 'slug', v_t.slug),
    'branding', (
      select jsonb_build_object(
        'logo_url', b.logo_url, 'accent', b.accent, 'legal_name', b.legal_name,
        -- ADR-124: nombre de fantasía (el catálogo lo usa como título).
        'trade_name', nullif(btrim(b.trade_name), ''),
        'phone', b.phone, 'address', b.address
      ) from tenant_branding b where b.tenant_id = v_t.id
    ),
    'ordering', v_ord,
    'products', coalesce((
      select jsonb_agg(s.x order by s.name) from (
        select p.name,
          jsonb_build_object(
            'id', p.id, 'name', p.name,
            -- Precio resuelto por la lista 'catalogo' activa (item por producto →
            -- ajuste % → base). Sin lista activa → precio base.
            'price', _catalog_unit_price(v_list, v_adj, p.id, null, p.price),
            'image_url', p.image_url, 'category', c.name,
            'unit', coalesce(p.unit, 'un'),
            'has_variants', coalesce(p.has_variants, false),
            -- ADR-129: disponible = stock − reservado vigente (pedidos y
            -- reservas). null = no controla stock (kits, servicios).
            -- ADR-130: con pedidos, el de la sucursal del catálogo (donde se
            -- reserva); sin pedidos, el del negocio.
            'available', case
              when coalesce(p.track_stock, true) and not coalesce(p.is_kit, false)
                   and not coalesce(p.is_service, false)
              then case when v_order then _catalog_available(v_store, p.id, null, true)
                   else greatest(coalesce(p.stock, 0) - coalesce((
                     select sum(ri.qty)
                       from stock_reservation_items ri
                       join stock_reservations r on r.id = ri.reservation_id
                      where ri.product_id = p.id and r.tenant_id = v_t.id
                        and r.status in ('reservada', 'preparada') and r.expires_at > now()), 0), 0)
                   end
            end,
            'variants', case when coalesce(p.has_variants, false) then coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id', v.id,
                       'label', coalesce(nullif(concat_ws(' / ', nullif(btrim(v.option1), ''), nullif(btrim(v.option2), '')), ''), 'Única'),
                       'price', _catalog_unit_price(v_list, v_adj, p.id, v.id, coalesce(v.price_override, p.price)),
                       'available', case
                         when coalesce(p.track_stock, true) and not coalesce(p.is_kit, false)
                              and not coalesce(p.is_service, false)
                         then case when v_order then _catalog_available(v_store, p.id, v.id, false)
                              else greatest(coalesce(v.stock, 0) - coalesce((
                                select sum(ri.qty)
                                  from stock_reservation_items ri
                                  join stock_reservations r on r.id = ri.reservation_id
                                 where ri.product_id = p.id and ri.variant_id = v.id and r.tenant_id = v_t.id
                                   and r.status in ('reservada', 'preparada') and r.expires_at > now()), 0), 0)
                              end
                       end)
                     order by v.option1 nulls last, v.option2 nulls last, v.created_at)
                from product_variants v
               where v.product_id = p.id and v.tenant_id = v_t.id and v.deleted_at is null
            ), '[]'::jsonb) end
          ) as x
        from products p
        left join categories c on c.id = p.category_id
        where p.tenant_id = v_t.id and p.is_active and p.deleted_at is null
      ) s
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public_catalog(text) from public;
grant execute on function public_catalog(text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- F) Crear el pedido desde el catálogo (anon)
-- -----------------------------------------------------------------------------
-- p_order: {id (uuid del navegador, idempotencia), token (32 a 128 de
--   [A-Za-z0-9_-], generado por el navegador), items: [{product_id,
--   variant_id, qty}], delivery_type ('retiro' | 'envio'), pickup_store_id,
--   customer_name, customer_phone, customer_email, ship_address, notes,
--   payment_preference ('al_retirar' | 'link'), website (honeypot)}.
-- Devuelve {ok, number, total, item_count, delivery_type, pickup_code,
--   reserved_until, payment_preference}. El código de retiro se muestra UNA
--   vez (se guarda sólo el hash); un reintento con el mismo id y token
--   devuelve el pedido sin el código.
create or replace function public_catalog_order_create(p_slug text, p_order jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  c_ip_max      constant int := 5;    -- pedidos por IP y negocio cada 10 minutos
  c_tenant_max  constant int := 60;   -- pedidos por negocio por hora
  v_tenant   uuid;
  v_slug     text;
  v_id       uuid;
  v_token    text := p_order ->> 'token';
  v_thash    text;
  v_existing sale_orders;
  v_hdr      jsonb;
  v_ip       text;
  v_iphash   text;
  v_store    uuid;
  v_cfg      jsonb;
  v_type     text := nullif(btrim(coalesce(p_order ->> 'delivery_type', '')), '');
  v_ful      uuid;
  v_name     text := nullif(btrim(regexp_replace(coalesce(p_order ->> 'customer_name', ''), '\s+', ' ', 'g')), '');
  v_phone    text := nullif(btrim(coalesce(p_order ->> 'customer_phone', '')), '');
  v_email    text := lower(nullif(btrim(coalesce(p_order ->> 'customer_email', '')), ''));
  v_addr     text := nullif(btrim(coalesce(p_order ->> 'ship_address', '')), '');
  v_notes    text := nullif(btrim(coalesce(p_order ->> 'notes', '')), '');
  v_pay      text := coalesce(nullif(btrim(coalesce(p_order ->> 'payment_preference', '')), ''), 'al_retirar');
  v_list     uuid;
  v_adj      numeric;
  v_number   int;
  v_it       record;
  v_p        products;
  v_vlabel   text;
  v_vsku     text;
  v_vbase    numeric;
  v_price    numeric;
  v_exp      numeric;
  v_tracks   boolean;
  v_avail    numeric;
  v_lines    jsonb := '[]'::jsonb;
  v_resv_its jsonb := '[]'::jsonb;
  v_n        int := 0;
  v_total    numeric := 0;
  v_count    numeric := 0;
  v_code     text;
  v_hash     text;
  v_until    timestamptz;
  v_resv     uuid;
  v_rnum     int;
  v_info     record;
  v_units    numeric := 0;
  v_value    numeric := 0;
  v_r        record;
  v_disp     text;
  v_brand    record;
  v_store_name text;
  v_ful_name text;
  v_ful_addr text;
  v_link     text;
  v_html     text;
  v_u        record;
begin
  -- Honeypot: un bot que completa el campo oculto recibe un "ok" sin pedido.
  if nullif(btrim(coalesce(p_order ->> 'website', '')), '') is not null then
    return jsonb_build_object('ok', true, 'number', null);
  end if;
  if p_order is null or jsonb_typeof(p_order) <> 'object' then
    raise exception 'invalid_order';
  end if;

  select t.id, t.slug into v_tenant, v_slug from tenants t
   where t.slug = p_slug and t.deleted_at is null and t.status in ('trial', 'active')
   limit 1;
  if v_tenant is null or not _catalog_ordering(v_tenant) then
    raise exception 'catalog_orders_unavailable';
  end if;
  v_store := _catalog_order_store(v_tenant);
  if v_store is null then
    raise exception 'catalog_orders_unavailable';
  end if;

  if coalesce(p_order ->> 'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'id_required';
  end if;
  v_id := (p_order ->> 'id')::uuid;
  if coalesce(v_token, '') !~ '^[A-Za-z0-9_-]{32,128}$' then
    raise exception 'token_required';
  end if;
  v_thash := encode(digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex');

  -- Reintento: el mismo pedido (mismo negocio, id y token) vuelve sin código.
  select * into v_existing from sale_orders where id = v_id;
  if v_existing.id is not null then
    if v_existing.tenant_id <> v_tenant or v_existing.public_token_hash is distinct from v_thash then
      raise exception 'order_conflict';
    end if;
    return jsonb_build_object('ok', true, 'number', v_existing.number, 'total', v_existing.total,
                              'item_count', v_existing.item_count, 'delivery_type', v_existing.delivery_type,
                              'pickup_code', null, 'reserved_until', v_existing.reserved_until,
                              'payment_preference', v_existing.payment_preference, 'already', true);
  end if;

  -- Rate limit por IP (hash con el negocio) y por negocio.
  begin
    v_hdr := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_hdr := null;
  end;
  v_ip := nullif(btrim(split_part(coalesce(v_hdr ->> 'x-forwarded-for', v_hdr ->> 'cf-connecting-ip',
                                           v_hdr ->> 'x-real-ip', ''), ',', 1)), '');
  v_iphash := encode(digest(convert_to(coalesce(v_ip, 'sin-ip') || ':' || v_tenant::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtext('catalog_order_rate:' || v_tenant::text));
  delete from catalog_order_attempts where tenant_id = v_tenant and created_at < now() - interval '1 day';
  if (select count(*) from catalog_order_attempts
       where tenant_id = v_tenant and ip_hash = v_iphash and created_at > now() - interval '10 minutes') >= c_ip_max
     or (select count(*) from catalog_order_attempts
          where tenant_id = v_tenant and created_at > now() - interval '1 hour') >= c_tenant_max then
    raise exception 'rate_limited';
  end if;

  -- Datos del cliente.
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'customer_name_required';
  end if;
  if v_phone is null or char_length(v_phone) > 40
     or char_length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 8 and 15
     or v_phone !~ '^[0-9+()\s.-]+$' then
    raise exception 'customer_phone_invalid';
  end if;
  if v_email is not null and (char_length(v_email) > 160 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$') then
    raise exception 'customer_email_invalid';
  end if;
  if v_notes is not null and char_length(v_notes) > 500 then
    raise exception 'notes_too_long';
  end if;
  if v_addr is not null and char_length(v_addr) > 300 then
    raise exception 'ship_address_too_long';
  end if;

  -- Entrega: sólo retiro o envío (el retiro inmediato es del mostrador).
  if v_type is null or v_type not in ('retiro', 'envio') then
    raise exception 'invalid_delivery_type';
  end if;
  v_ful := _order_delivery_check(v_tenant, v_store, v_type,
                                 case when v_type = 'retiro'
                                      then nullif(p_order ->> 'pickup_store_id', '')::uuid end,
                                 v_addr);
  if v_ful <> v_store and not exists (
    select 1 from stores where id = v_ful and tenant_id = v_tenant and deleted_at is null and coalesce(is_active, true)
  ) then
    raise exception 'store_not_found';
  end if;
  if v_pay not in ('al_retirar', 'link') then
    raise exception 'invalid_payment_preference';
  end if;
  if v_pay = 'link' and not _catalog_link_ready(v_tenant) then
    raise exception 'payment_link_unavailable';
  end if;

  if jsonb_typeof(p_order -> 'items') <> 'array' or jsonb_array_length(p_order -> 'items') = 0 then
    raise exception 'cart_required';
  end if;
  if jsonb_array_length(p_order -> 'items') > 50 then
    raise exception 'too_many_items';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_order -> 'items') e
     where jsonb_typeof(e) <> 'object'
        or coalesce(e ->> 'product_id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        or (nullif(e ->> 'variant_id', '') is not null
            and e ->> 'variant_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
        or coalesce(e ->> 'qty', '') !~ '^[0-9]{1,4}(\.[0-9]{1,3})?$'
  ) then
    raise exception 'invalid_quantity';
  end if;

  v_cfg := pos_order_config(v_tenant);
  select pl.id, pl.adjustment_pct into v_list, v_adj from price_lists pl
   where pl.tenant_id = v_tenant and pl.channel = 'catalogo' and pl.is_active and pl.deleted_at is null
   limit 1;

  perform pg_advisory_xact_lock(hashtext('sale_order_number:' || v_tenant::text));
  select coalesce(max(number), 0) + 1 into v_number from sale_orders where tenant_id = v_tenant;

  -- Mismo lock que las reservas y los pedidos de la sucursal (ADR-091/129).
  perform pg_advisory_xact_lock(hashtext('stock_reservation:' || v_store::text));
  perform stock_reservations_expire_due(v_tenant);

  for v_it in
    select (a.e ->> 'product_id')::uuid as product_id, nullif(a.e ->> 'variant_id', '')::uuid as variant_id,
           sum((a.e ->> 'qty')::numeric) as qty
      from jsonb_array_elements(p_order -> 'items') with ordinality as a(e, ord)
     group by 1, 2
     order by min(a.ord)
  loop
    if v_it.product_id is null or v_it.qty is null or v_it.qty <= 0 or v_it.qty > 999 then
      raise exception 'invalid_quantity';
    end if;
    select * into v_p from products p
     where p.id = v_it.product_id and p.tenant_id = v_tenant and p.is_active and p.deleted_at is null;
    if v_p.id is null then
      raise exception 'product_unavailable';
    end if;
    if coalesce(v_p.unit, 'un') <> 'kg' and v_it.qty <> trunc(v_it.qty) then
      raise exception 'invalid_quantity';
    end if;
    v_vlabel := null;
    v_vsku := null;
    v_vbase := v_p.price;
    if coalesce(v_p.has_variants, false) then
      if v_it.variant_id is null then
        raise exception 'variant_required: %', v_p.name;
      end if;
      select coalesce(nullif(concat_ws(' / ', nullif(btrim(v.option1), ''), nullif(btrim(v.option2), '')), ''), 'Única'),
             v.sku, coalesce(v.price_override, v_p.price)
        into v_vlabel, v_vsku, v_vbase
        from product_variants v
       where v.id = v_it.variant_id and v.product_id = v_p.id and v.tenant_id = v_tenant and v.deleted_at is null;
      if not found then
        raise exception 'variant_unavailable: %', v_p.name;
      end if;
    elsif v_it.variant_id is not null then
      raise exception 'variant_unavailable: %', v_p.name;
    end if;

    -- Precio del servidor (lista del catálogo); nunca el del cliente.
    v_price := round(_catalog_unit_price(v_list, v_adj, v_p.id, v_it.variant_id, v_vbase), 2);
    -- Precio que la caja va a esperar: si difiere, la línea viaja como cambio
    -- de precio con motivo (ADR-056) y create_sale la valida al cobrar.
    v_exp := round(coalesce(_resolve_unit_price(v_tenant, v_p.id, v_it.variant_id, v_it.qty, null, v_store), v_price), 2);

    -- Disponible: lo que controla stock nunca se pide de más desde la web
    -- (aunque el negocio venda en negativo en el mostrador).
    v_tracks := coalesce(v_p.track_stock, true) and not coalesce(v_p.is_kit, false) and not coalesce(v_p.is_service, false);
    if v_tracks then
      v_avail := coalesce((select ps.qty from product_stock ps
                            where ps.store_id = v_store and ps.product_id = v_p.id
                              and ps.variant_id is not distinct from v_it.variant_id), 0)
               - stock_reserved_qty(v_store, v_p.id, v_it.variant_id, null);
      if v_avail < v_it.qty then
        raise exception 'insufficient_available_stock: %', v_p.name || coalesce(' (' || v_vlabel || ')', '');
      end if;
      v_resv_its := v_resv_its || jsonb_build_array(jsonb_build_object(
        'product_id', v_p.id, 'variant_id', v_it.variant_id, 'qty', v_it.qty, 'price', v_price));
    end if;

    v_n := v_n + 1;
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'lineId', 'web-' || v_number || '-' || v_n,
        'productId', v_p.id,
        'categoryId', v_p.category_id,
        'name', v_p.name,
        'sku', coalesce(v_vsku, v_p.sku),
        'unitPrice', v_price,
        'quantity', v_it.qty,
        'discount', 0,
        'unit', coalesce(v_p.unit, 'un'),
        'variantId', v_it.variant_id,
        'warrantyMonths', coalesce(v_p.warranty_months, 0)
      )
      || case when v_vlabel is not null then jsonb_build_object('variantLabel', v_vlabel) else '{}'::jsonb end
      || case when abs(v_price - v_exp) > 0.01
              then jsonb_build_object('priceOverride', true, 'listPrice', v_exp,
                                      'overrideReason', 'Precio del catálogo web (pedido N° ' || v_number || ')')
              else '{}'::jsonb end
    );
    v_total := v_total + round(v_price * v_it.qty, 2);
    v_count := v_count + v_it.qty;
  end loop;

  if v_type = 'retiro' and (v_cfg -> 'delivery_types' -> 'retiro' ->> 'pickup_code')::boolean then
    v_code := otp_random_digits(6);
    v_hash := stock_reservation_code_hash(v_id, v_code);
  end if;
  v_until := now() + make_interval(mins => (v_cfg ->> 'reservation_minutes')::int);

  insert into sale_orders (
    id, tenant_id, number, store_id, fulfillment_store_id, delivery_type, customer_name, customer_phone,
    customer_email, pickup_name, pickup_code_hash, ship_address, notes, seller_name, cart, total, item_count,
    reserved_until, source, payment_preference, public_token_hash
  ) values (
    v_id, v_tenant, v_number, v_store, v_ful, v_type, left(v_name, 120), left(v_phone, 40),
    v_email, case when v_type = 'retiro' then left(v_name, 120) end, v_hash,
    case when v_type = 'envio' then left(v_addr, 300) end, left(v_notes, 500), 'Catálogo web',
    jsonb_build_object('v', 1, 'lines', v_lines, 'discountTotal', 0, 'couponCode', null,
                       'customer', null, 'offeredWarrantyId', '',
                       'pricing', jsonb_build_object('listId', null, 'termId', null), 'notes', null),
    round(v_total, 2), v_count, v_until, 'catalogo_publico', v_pay, v_thash
  );

  -- Reserva del stock (ADR-091) con la feature, igual que sale_order_create.
  if tenant_has_feature_for(v_tenant, 'reservas_stock') and jsonb_array_length(v_resv_its) > 0 then
    perform pg_advisory_xact_lock(hashtext('stock_reservation_number:' || v_tenant::text));
    select coalesce(max(number), 0) + 1 into v_rnum from stock_reservations where tenant_id = v_tenant;
    v_resv := gen_random_uuid();
    insert into stock_reservations (
      id, tenant_id, number, store_id, channel, customer_name, customer_phone,
      pickup_code_hash, expires_at, notes, sale_order_id, created_by
    ) values (
      v_resv, v_tenant, v_rnum, v_store, 'pedido', left(v_name, 120), left(v_phone, 40),
      -- El retiro de un pedido se valida al levantarlo: este código no se usa.
      stock_reservation_code_hash(v_resv, gen_random_uuid()::text),
      v_until, 'Pedido del catálogo web N° ' || v_number, v_id, null
    );
    for v_r in
      select (e ->> 'product_id')::uuid as product_id, nullif(e ->> 'variant_id', '')::uuid as variant_id,
             (e ->> 'qty')::numeric as qty, (e ->> 'price')::numeric as price, ord
        from jsonb_array_elements(v_resv_its) with ordinality as a(e, ord)
    loop
      select * into v_info from warehouse_item_info(v_tenant, v_r.product_id, v_r.variant_id);
      insert into stock_reservation_items (
        tenant_id, reservation_id, store_id, product_id, variant_id, product_name, variant_label,
        sku, unit, qty, unit_price, sort
      ) values (
        v_tenant, v_resv, v_store, v_r.product_id, v_r.variant_id, v_info.product_name,
        v_info.variant_label, v_info.sku, v_info.unit, v_r.qty, v_r.price, v_r.ord - 1
      );
      v_units := v_units + v_r.qty;
      v_value := v_value + v_r.qty * v_r.price;
    end loop;
    update stock_reservations set total_units = v_units, total_value = round(v_value, 2) where id = v_resv;
    update sale_orders set reservation_id = v_resv where id = v_id;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, null, 'stock_reservations', v_resv, 'stock_reservation_created',
            jsonb_build_object('number', v_rnum, 'store_id', v_store, 'channel', 'pedido',
                               'sale_order_id', v_id, 'total_units', v_units, 'expires_at', v_until,
                               'source', 'catalogo_publico'),
            v_store);
  end if;

  insert into catalog_order_attempts (tenant_id, ip_hash) values (v_tenant, v_iphash);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, null, 'sale_orders', v_id, 'sale_order_created',
          jsonb_build_object('number', v_number, 'store_id', v_store, 'fulfillment_store_id', v_ful,
                             'delivery_type', v_type, 'total', round(v_total, 2), 'reservation_id', v_resv,
                             'reserved_until', v_until, 'customer_name', v_name,
                             'source', 'catalogo_publico', 'payment_preference', v_pay),
          v_store);

  -- Aviso al negocio (centro de notificaciones): quien opera la sucursal del
  -- pedido o la de entrega. Nunca rompe el pedido.
  begin
    select coalesce(nullif(btrim(s.short_name), ''), s.name) into v_store_name from stores s where s.id = v_store;
    select coalesce(nullif(btrim(s.short_name), ''), s.name), s.address into v_ful_name, v_ful_addr
      from stores s where s.id = v_ful;
    v_disp := case when v_type = 'envio' then 'Envío a domicilio' else 'Retira en ' || coalesce(v_ful_name, 'la sucursal') end;
    for v_u in
      select tu.user_id, tu.role from tenant_users tu
       where tu.tenant_id = v_tenant and tu.status = 'active' and tu.role in ('owner', 'manager', 'cashier')
    loop
      if v_store = any (staff_allowed_store_ids(v_tenant, v_u.user_id, null, v_u.role, null))
         or v_ful = any (staff_allowed_store_ids(v_tenant, v_u.user_id, null, v_u.role, null)) then
        insert into notifications (target_tenant_id, target_user_id, type, severity, title, body,
                                   action_label, action_url, expires_at)
        values (v_tenant, v_u.user_id, 'pedidos', 'info',
                'Pedido nuevo del catálogo N° ' || v_number,
                v_name || ' · ' || _catalog_money(v_total) || ' · ' || v_disp
                  || case when v_pay = 'link' then ' · Quiere pagar con link' else '' end,
                'Ver pedidos', '/pedidos', now() + interval '7 days');
      end if;
    end loop;
  exception when others then
    raise warning 'catalog order notify: %', sqlerrm;
  end;

  -- Confirmación por email (cola del sistema, mailer de plataforma). Nunca
  -- rompe el pedido.
  if v_email is not null then
    begin
      select coalesce(nullif(btrim(b.trade_name), ''), t.name) as name, b.logo_url, b.phone
        into v_brand
        from tenants t left join tenant_branding b on b.tenant_id = t.id
       where t.id = v_tenant;
      v_link := 'https://pos.soft.ninja/c/' || v_slug || '/pedido/' || v_token;
      v_html :=
        '<div style="font-family:-apple-system,BlinkMacSystemFont,''Segoe UI'',Roboto,Helvetica,Arial,sans-serif;'
        || 'background:#f3f2f8;padding:24px;color:#09051C">'
        || '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">'
        || '<p style="margin:0 0 4px;font-size:13px;color:#6b7280">' || _catalog_html(v_brand.name) || '</p>'
        || '<h1 style="margin:0 0 12px;font-size:20px">Recibimos tu pedido N° ' || v_number || '</h1>'
        || '<p style="margin:0 0 16px;font-size:14px">Hola ' || _catalog_html(split_part(v_name, ' ', 1))
        || ', el negocio ya tiene tu pedido. '
        || case when v_type = 'envio' then 'Te lo enviamos a ' || _catalog_html(v_addr) || '.'
                else 'Lo retirás en ' || _catalog_html(coalesce(v_ful_name, 'la sucursal'))
                     || coalesce(' (' || _catalog_html(v_ful_addr) || ')', '') || '.' end
        || '</p>'
        || coalesce((
             select '<table style="width:100%;border-collapse:collapse;font-size:14px">'
                    || string_agg('<tr><td style="padding:6px 0;border-bottom:1px solid #ebe9f2">'
                                  || _catalog_html((l ->> 'quantity')) || ' × ' || _catalog_html(l ->> 'name')
                                  || coalesce(' (' || _catalog_html(l ->> 'variantLabel') || ')', '')
                                  || '</td><td style="padding:6px 0;border-bottom:1px solid #ebe9f2;text-align:right">'
                                  || _catalog_money((l ->> 'unitPrice')::numeric * (l ->> 'quantity')::numeric)
                                  || '</td></tr>', '' order by o)
                    || '</table>'
               from jsonb_array_elements(v_lines) with ordinality as a(l, o)), '')
        || '<p style="margin:12px 0 0;font-size:16px;font-weight:700;text-align:right">Total '
        || _catalog_money(v_total) || '</p>'
        || case when v_code is not null
                then '<p style="margin:16px 0 0;font-size:14px">Código de retiro: <strong style="font-size:18px;letter-spacing:2px">'
                     || v_code || '</strong></p>' else '' end
        || '<p style="margin:16px 0 0;font-size:14px">'
        || case when v_pay = 'link' then 'El negocio te va a mandar el link de pago.'
                when v_type = 'envio' then 'Pagás cuando lo recibís.' else 'Pagás al retirar.' end
        || '</p>'
        || '<p style="margin:20px 0 0"><a href="' || _catalog_html(v_link)
        || '" style="display:inline-block;background:#09051C;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Ver mi pedido</a></p>'
        || '</div></div>';
      perform enqueue_system_email(v_tenant, v_email, 'catalog_order_received',
                                   jsonb_build_object('number', v_number, 'business', v_brand.name, 'link', v_link),
                                   'Tu pedido N° ' || v_number || ' en ' || v_brand.name, v_html);
    exception when others then
      raise warning 'catalog order email: %', sqlerrm;
    end;
  end if;

  return jsonb_build_object('ok', true, 'number', v_number, 'total', round(v_total, 2), 'item_count', v_count,
                            'delivery_type', v_type, 'pickup_code', v_code, 'reserved_until', v_until,
                            'payment_preference', v_pay);
end;
$$;
revoke all on function public_catalog_order_create(text, jsonb) from public;
grant execute on function public_catalog_order_create(text, jsonb) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- G) Seguimiento del cliente por token (anon)
-- -----------------------------------------------------------------------------
create or replace function public_catalog_order_status(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_o sale_orders;
  v_d record;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{32,128}$' then
    return null;
  end if;
  select * into v_o from sale_orders o
   where o.public_token_hash = encode(digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
     and o.source = 'catalogo_publico' and o.deleted_at is null;
  if v_o.id is null then
    return null;
  end if;
  select d.status, d.tracking, d.ready_at, d.delivered_at, d.sent_at, d.arrived_at into v_d
    from dispatches d
   where d.sale_order_id = v_o.id and d.deleted_at is null
   order by (d.status <> 'cancelado') desc, d.created_at desc
   limit 1;

  return jsonb_build_object(
    'number', v_o.number,
    'status', v_o.status,
    'delivery_type', v_o.delivery_type,
    'created_at', v_o.created_at,
    'paid_at', v_o.paid_at,
    'total', v_o.total,
    'item_count', v_o.item_count,
    'customer_name', v_o.customer_name,
    'ship_address', v_o.ship_address,
    'payment_preference', v_o.payment_preference,
    'reserved_until', v_o.reserved_until,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', l ->> 'name', 'variant', l ->> 'variantLabel',
               'qty', (l ->> 'quantity')::numeric, 'unit_price', (l ->> 'unitPrice')::numeric,
               'unit', coalesce(l ->> 'unit', 'un')) order by o)
        from jsonb_array_elements(case when jsonb_typeof(v_o.cart -> 'lines') = 'array' then v_o.cart -> 'lines' else '[]'::jsonb end)
             with ordinality as a(l, o)
    ), '[]'::jsonb),
    'dispatch', case when v_d.status is not null then jsonb_build_object(
      'status', v_d.status, 'tracking', v_d.tracking, 'ready_at', v_d.ready_at,
      'sent_at', v_d.sent_at, 'arrived_at', v_d.arrived_at, 'delivered_at', v_d.delivered_at) end,
    'pickup_store', (
      select jsonb_build_object('name', coalesce(nullif(btrim(s.short_name), ''), s.name), 'address', s.address, 'phone', s.phone)
        from stores s where s.id = v_o.fulfillment_store_id),
    'business', (
      select jsonb_build_object('name', t.name, 'slug', t.slug, 'logo_url', b.logo_url, 'accent', b.accent,
                                'legal_name', b.legal_name, 'trade_name', nullif(btrim(b.trade_name), ''),
                                'phone', b.phone)
        from tenants t left join tenant_branding b on b.tenant_id = t.id
       where t.id = v_o.tenant_id)
  );
end;
$$;
revoke all on function public_catalog_order_status(text) from public;
grant execute on function public_catalog_order_status(text) to anon, authenticated;
