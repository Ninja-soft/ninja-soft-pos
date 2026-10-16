-- =============================================================================
-- ADR-157 · F22 · H144 (L1 de ADR-149): cliente obligatorio para enviar y
-- direcciones reales con autocompletar, normalización y mapa.
--
--   A) Feature direcciones_geo (BASE): direcciones del cliente con
--      autocompletar y mapa. Mejora la calidad de datos de todos los planes.
--   B) customer_addresses: direcciones de entrega del cliente (varias, una
--      predeterminada), con calle y número separados (como los pide ARBA),
--      localidad, partido, provincia con su letra, lat/lng, origen y calidad
--      de la geocodificación. Escrituras sólo por RPC.
--   C) dispatches.address_id y dispatches.ship_to: copia de la dirección en la
--      entrega. Si el cliente cambia su dirección después, la entrega no
--      cambia. ship_address queda como texto armado (compatibilidad).
--   D) Zonas de envío por localidad: delivery_zones.localities y free_from.
--   E) Edge geo: caché compartida (geocode_cache), interruptor y turno de cada
--      proveedor (geo_providers: Nominatim, 1 pedido por segundo para toda la
--      aplicación) y cupo por negocio (geo_usage). Sólo service_role.
--   F) Cliente obligatorio para enviar, en el SERVIDOR: trigger en dispatches
--      (cubre pos_sale_create_fulfilled y dispatch_create_for_sale sin
--      recrearlas) y pos_sale_create_delivery, que valida la dirección, la
--      guarda en el cliente si se pide y copia la dirección en cada entrega,
--      todo en la misma transacción que la venta.
--
-- create_sale y pos_sale_create_fulfilled NO cambian (tampoco el trigger
-- BEFORE INSERT de sales de ADR-155). Producción: 0 entregas, así que no hay
-- datos que migrar. Las entregas de pedidos (sale_order_id) quedan afuera de
-- la exigencia: el catálogo público y los pedidos de salón traen nombre y
-- teléfono sin cliente cargado (se revisa en L2).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Feature de plan
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('direcciones_geo', 'Direcciones con mapa',
   'Direcciones de entrega del cliente con autocompletar, normalización oficial (Georef), mini mapa con pin y zonas de envío por localidad',
   'envios', true, 299)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('direcciones_geo', true),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'direcciones_geo');

-- -----------------------------------------------------------------------------
-- B) Direcciones del cliente
-- -----------------------------------------------------------------------------
create table if not exists customer_addresses (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  customer_id      uuid not null references customers(id) on delete cascade,
  label            text check (label is null or char_length(label) <= 60),
  street           text not null check (char_length(street) between 2 and 120),
  number           text check (number is null or char_length(number) <= 20),
  floor            text check (floor is null or char_length(floor) <= 20),
  apartment        text check (apartment is null or char_length(apartment) <= 20),
  locality         text check (locality is null or char_length(locality) <= 120),
  partido          text check (partido is null or char_length(partido) <= 120),
  province         text check (province is null or char_length(province) <= 60),
  province_code    text check (province_code is null or province_code ~ '^[A-Z]$'),
  postal_code      text check (postal_code is null or char_length(postal_code) <= 10),
  between_streets  text check (between_streets is null or char_length(between_streets) <= 160),
  reference        text check (reference is null or char_length(reference) <= 200),
  lat              double precision check (lat is null or lat between -90 and 90),
  lng              double precision check (lng is null or lng between -180 and 180),
  geo_source       text not null default 'manual'
                   check (geo_source in ('photon', 'georef', 'nominatim', 'pin', 'manual')),
  geo_quality      text not null default 'sin_geo'
                   check (geo_quality in ('exacta', 'calle', 'localidad', 'sin_geo')),
  normalized       jsonb check (normalized is null or (jsonb_typeof(normalized) = 'object' and pg_column_size(normalized) <= 4096)),
  contact_name     text check (contact_name is null or char_length(contact_name) <= 120),
  contact_phone    text check (contact_phone is null or char_length(contact_phone) <= 40),
  delivery_notes   text check (delivery_notes is null or char_length(delivery_notes) <= 300),
  is_default       boolean not null default false,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  constraint customer_addresses_latlng_pair check ((lat is null) = (lng is null))
);
comment on table customer_addresses is
  'ADR-157 (L1 de ADR-149): direcciones de entrega del cliente. customers.address sigue siendo el domicilio fiscal. Escrituras sólo por RPC.';

create index if not exists customer_addresses_customer_idx
  on customer_addresses (tenant_id, customer_id) where deleted_at is null;
create unique index if not exists customer_addresses_default_key
  on customer_addresses (customer_id) where is_default and deleted_at is null;
create index if not exists customer_addresses_locality_idx
  on customer_addresses (tenant_id, lower(locality)) where deleted_at is null and locality is not null;

drop trigger if exists set_updated_at_customer_addresses on customer_addresses;
create trigger set_updated_at_customer_addresses
  before update on customer_addresses
  for each row execute function set_updated_at();

drop trigger if exists role_write_guard on customer_addresses;
create trigger role_write_guard
  before insert or update or delete on customer_addresses
  for each row execute function trg_role_write_guard('customers');

alter table customer_addresses enable row level security;
revoke all on customer_addresses from anon, authenticated;
grant select on customer_addresses to authenticated;
drop policy if exists customer_addresses_select on customer_addresses;
create policy customer_addresses_select on customer_addresses
  for select using (tenant_id = (select current_tenant_id()));

-- -----------------------------------------------------------------------------
-- C) Copia de la dirección en la entrega
-- -----------------------------------------------------------------------------
alter table dispatches add column if not exists address_id uuid references customer_addresses(id) on delete set null;
alter table dispatches add column if not exists ship_to jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dispatches_ship_to_check') then
    alter table dispatches add constraint dispatches_ship_to_check
      check (ship_to is null or (jsonb_typeof(ship_to) = 'object' and pg_column_size(ship_to) <= 8192));
  end if;
end;
$$;
comment on column dispatches.address_id is 'Dirección del cliente elegida al vender (ADR-157). La entrega usa la copia de ship_to.';
comment on column dispatches.ship_to is
  'Copia estructurada de la dirección al vender (ADR-157): calle, número, localidad, provincia, lat/lng, contacto y notas. No cambia si el cliente edita su dirección.';
create index if not exists dispatches_address_idx on dispatches(address_id) where address_id is not null;
grant select (address_id, ship_to) on dispatches to authenticated;

-- -----------------------------------------------------------------------------
-- D) Zonas de envío por localidad
-- -----------------------------------------------------------------------------
alter table delivery_zones add column if not exists localities text[] not null default '{}';
alter table delivery_zones add column if not exists free_from numeric(12,2);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'delivery_zones_localities_check') then
    alter table delivery_zones add constraint delivery_zones_localities_check
      check (cardinality(localities) <= 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'delivery_zones_free_from_check') then
    alter table delivery_zones add constraint delivery_zones_free_from_check
      check (free_from is null or free_from >= 0);
  end if;
end;
$$;
comment on column delivery_zones.localities is
  'Localidades que cubre la zona (ADR-157). El cobro sugiere el costo de la zona donde cae la dirección; el polígono llega en L3.';
comment on column delivery_zones.free_from is 'Envío sin cargo desde este total de la venta (ADR-157). null = siempre se cobra.';

-- -----------------------------------------------------------------------------
-- E) Edge geo: caché, proveedores y cupo
-- -----------------------------------------------------------------------------
create table if not exists geocode_cache (
  key         text primary key check (key ~ '^[a-f0-9]{64}$'),
  action      text not null check (action in ('suggest', 'normalize', 'reverse')),
  provider    text not null check (char_length(provider) <= 20),
  result      jsonb not null check (pg_column_size(result) <= 32768),
  created_at  timestamptz not null default now()
);
comment on table geocode_cache is
  'ADR-157: respuestas normalizadas de Photon, Georef y Nominatim por hash del pedido. Dato público, compartido entre negocios, vence a los 180 días. Sólo service_role (Edge geo).';
create index if not exists geocode_cache_created_idx on geocode_cache (created_at);
alter table geocode_cache enable row level security;
revoke all on geocode_cache from anon, authenticated;

create table if not exists geo_providers (
  key           text primary key check (key in ('photon', 'georef', 'nominatim')),
  enabled       boolean not null default true,
  min_interval_ms integer not null default 0 check (min_interval_ms between 0 and 60000),
  last_call_at  timestamptz,
  updated_at    timestamptz not null default now()
);
comment on table geo_providers is
  'ADR-157: interruptor por proveedor de la Edge geo (se apaga sin desplegar) y turno global: Nominatim pide como mucho 1 pedido por segundo para toda la aplicación. Sólo service_role.';
insert into geo_providers (key, enabled, min_interval_ms) values
  ('photon', true, 0),
  ('georef', true, 0),
  ('nominatim', true, 1100)
on conflict (key) do nothing;
alter table geo_providers enable row level security;
revoke all on geo_providers from anon, authenticated;

create table if not exists geo_usage (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  kind       text not null check (kind in ('suggest', 'normalize', 'reverse')),
  bucket     timestamptz not null,
  calls      integer not null default 0,
  primary key (tenant_id, kind, bucket)
);
comment on table geo_usage is
  'ADR-157: pedidos de cada negocio a los proveedores de la Edge geo por minuto (la caché no cuenta). Base del cupo. Sólo service_role.';
alter table geo_usage enable row level security;
revoke all on geo_usage from anon, authenticated;

-- ¿Puede este usuario usar la Edge geo en este negocio? null = sí.
create or replace function geo_guard(p_tenant uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not exists (select 1 from tenant_users
                      where tenant_id = p_tenant and user_id = p_user and status = 'active') then 'forbidden'
    when not tenant_has_feature_for(p_tenant, 'direcciones_geo') then 'feature_not_in_plan'
    else null
  end;
$$;
revoke all on function geo_guard(uuid, uuid) from public, anon, authenticated;
grant execute on function geo_guard(uuid, uuid) to service_role;

-- Cuenta un pedido del negocio a un proveedor. 'ok' o el cupo superado.
create or replace function geo_rate_take(p_tenant uuid, p_kind text, p_per_minute integer, p_per_day integer)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bucket timestamptz := date_trunc('minute', now());
  v_min    integer;
  v_day    integer;
begin
  select coalesce(sum(calls) filter (where bucket = v_bucket), 0)::int,
         coalesce(sum(calls) filter (where bucket >= _ar_day_start()), 0)::int
    into v_min, v_day
    from geo_usage
   where tenant_id = p_tenant and kind = p_kind and bucket >= least(v_bucket, _ar_day_start());
  if v_min >= p_per_minute then
    return 'tenant_minute';
  end if;
  if v_day >= p_per_day then
    return 'tenant_day';
  end if;
  insert into geo_usage (tenant_id, kind, bucket, calls) values (p_tenant, p_kind, v_bucket, 1)
  on conflict (tenant_id, kind, bucket) do update set calls = geo_usage.calls + 1;
  -- Limpieza oportunista: con dos días alcanza para el cupo diario.
  delete from geo_usage where tenant_id = p_tenant and kind = p_kind and bucket < now() - interval '2 days';
  return 'ok';
end;
$$;
revoke all on function geo_rate_take(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function geo_rate_take(uuid, text, integer, integer) to service_role;

-- Turno del proveedor: 'ok' (se puede llamar ya), 'busy' (otro pedido usó el
-- turno hace menos del intervalo) o 'disabled' (apagado).
create or replace function geo_provider_take(p_key text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ok boolean;
begin
  update geo_providers
     set last_call_at = clock_timestamp()
   where key = p_key and enabled
     and (last_call_at is null
          or last_call_at <= clock_timestamp() - make_interval(secs => min_interval_ms / 1000.0))
  returning true into v_ok;
  if v_ok then
    return 'ok';
  end if;
  if exists (select 1 from geo_providers where key = p_key and enabled) then
    return 'busy';
  end if;
  return 'disabled';
end;
$$;
revoke all on function geo_provider_take(text) from public, anon, authenticated;
grant execute on function geo_provider_take(text) to service_role;

-- -----------------------------------------------------------------------------
-- F) Dirección limpia, texto y copia
-- -----------------------------------------------------------------------------

-- Texto recortado o null.
create or replace function _geo_txt(p jsonb, p_key text, p_max integer)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select left(nullif(btrim(coalesce(p ->> p_key, '')), ''), p_max);
$$;
revoke all on function _geo_txt(jsonb, text, integer) from public, anon, authenticated;

-- Dirección que viene del POS: sólo las claves conocidas, recortadas y
-- validadas. Sin calle no hay dirección (ship_to_invalid).
create or replace function _ship_to_clean(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_lat    double precision;
  v_lng    double precision;
  v_src    text := coalesce(_geo_txt(p, 'geo_source', 20), 'manual');
  v_q      text := _geo_txt(p, 'geo_quality', 20);
  v_prov   text := upper(_geo_txt(p, 'province_code', 1));
  v_norm   jsonb := case when jsonb_typeof(p -> 'normalized') = 'object' and pg_column_size(p -> 'normalized') <= 4096
                         then p -> 'normalized' end;
begin
  if jsonb_typeof(p) is distinct from 'object' or char_length(coalesce(_geo_txt(p, 'street', 120), '')) < 2 then
    raise exception 'ship_to_invalid';
  end if;
  begin
    v_lat := nullif(p ->> 'lat', '')::double precision;
    v_lng := nullif(p ->> 'lng', '')::double precision;
  exception when others then
    v_lat := null;
    v_lng := null;
  end;
  if v_lat is null or v_lng is null or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
    v_lat := null;
    v_lng := null;
  end if;
  if v_src not in ('photon', 'georef', 'nominatim', 'pin', 'manual') then
    v_src := 'manual';
  end if;
  if v_lat is null then
    v_q := 'sin_geo';
  elsif v_q is null or v_q not in ('exacta', 'calle', 'localidad', 'sin_geo') then
    v_q := 'calle';
  end if;
  if v_prov is not null and v_prov !~ '^[A-Z]$' then
    v_prov := null;
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'label', _geo_txt(p, 'label', 60),
    'street', _geo_txt(p, 'street', 120),
    'number', _geo_txt(p, 'number', 20),
    'floor', _geo_txt(p, 'floor', 20),
    'apartment', _geo_txt(p, 'apartment', 20),
    'locality', _geo_txt(p, 'locality', 120),
    'partido', _geo_txt(p, 'partido', 120),
    'province', _geo_txt(p, 'province', 60),
    'province_code', v_prov,
    'postal_code', _geo_txt(p, 'postal_code', 10),
    'between_streets', _geo_txt(p, 'between_streets', 160),
    'reference', _geo_txt(p, 'reference', 200),
    'contact_name', _geo_txt(p, 'contact_name', 120),
    'contact_phone', _geo_txt(p, 'contact_phone', 40),
    'delivery_notes', _geo_txt(p, 'delivery_notes', 300),
    'lat', v_lat,
    'lng', v_lng,
    'geo_source', v_src,
    'geo_quality', v_q,
    'normalized', v_norm
  ));
end;
$$;
revoke all on function _ship_to_clean(jsonb) from public, anon, authenticated;

-- "Av. San Martín 1234, Piso 3 Dto. B, Pilar, Buenos Aires" (espejo de
-- formatShipTo en lib/geo/address.ts).
create or replace function _ship_to_text(p jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select left(concat_ws(', ',
    nullif(btrim(concat_ws(' ', p ->> 'street', p ->> 'number')), ''),
    nullif(btrim(concat_ws(' ',
      case when nullif(p ->> 'floor', '') is not null then 'Piso ' || (p ->> 'floor') end,
      case when nullif(p ->> 'apartment', '') is not null then 'Dto. ' || (p ->> 'apartment') end)), ''),
    nullif(p ->> 'locality', ''),
    nullif(p ->> 'province', '')), 300);
$$;
revoke all on function _ship_to_text(jsonb) from public, anon, authenticated;

-- Copia de una dirección guardada para la entrega.
create or replace function _customer_address_snapshot(a customer_addresses)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'label', a.label, 'street', a.street, 'number', a.number, 'floor', a.floor, 'apartment', a.apartment,
    'locality', a.locality, 'partido', a.partido, 'province', a.province, 'province_code', a.province_code,
    'postal_code', a.postal_code, 'between_streets', a.between_streets, 'reference', a.reference,
    'contact_name', a.contact_name, 'contact_phone', a.contact_phone, 'delivery_notes', a.delivery_notes,
    'lat', a.lat, 'lng', a.lng, 'geo_source', a.geo_source, 'geo_quality', a.geo_quality,
    'normalized', a.normalized));
$$;
revoke all on function _customer_address_snapshot(customer_addresses) from public, anon, authenticated;

-- Alta de una dirección (interna: la usan customer_address_save y
-- pos_sale_create_delivery, que ya validaron negocio, cliente y permisos).
create or replace function _customer_address_insert(p_tenant uuid, p_customer uuid, p_clean jsonb, p_default boolean)
returns customer_addresses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row   customer_addresses;
  v_first boolean;
begin
  if (select count(*) from customer_addresses
       where customer_id = p_customer and tenant_id = p_tenant and deleted_at is null) >= 20 then
    raise exception 'too_many_addresses';
  end if;
  v_first := not exists (select 1 from customer_addresses
                          where customer_id = p_customer and tenant_id = p_tenant and deleted_at is null);
  if p_default or v_first then
    update customer_addresses set is_default = false
     where customer_id = p_customer and tenant_id = p_tenant and is_default and deleted_at is null;
  end if;
  insert into customer_addresses (
    tenant_id, customer_id, label, street, number, floor, apartment, locality, partido, province,
    province_code, postal_code, between_streets, reference, lat, lng, geo_source, geo_quality, normalized,
    contact_name, contact_phone, delivery_notes, is_default, created_by
  ) values (
    p_tenant, p_customer, p_clean ->> 'label', p_clean ->> 'street', p_clean ->> 'number', p_clean ->> 'floor',
    p_clean ->> 'apartment', p_clean ->> 'locality', p_clean ->> 'partido', p_clean ->> 'province',
    p_clean ->> 'province_code', p_clean ->> 'postal_code', p_clean ->> 'between_streets', p_clean ->> 'reference',
    (p_clean ->> 'lat')::double precision, (p_clean ->> 'lng')::double precision,
    coalesce(p_clean ->> 'geo_source', 'manual'), coalesce(p_clean ->> 'geo_quality', 'sin_geo'),
    p_clean -> 'normalized', p_clean ->> 'contact_name', p_clean ->> 'contact_phone', p_clean ->> 'delivery_notes',
    p_default or v_first, auth.uid()
  )
  returning * into v_row;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, auth.uid(), 'customer_addresses', v_row.id, 'customer_address_created',
          jsonb_build_object('customer_id', p_customer, 'text', _ship_to_text(p_clean),
                             'geo_quality', v_row.geo_quality, 'is_default', v_row.is_default));
  return v_row;
end;
$$;
revoke all on function _customer_address_insert(uuid, uuid, jsonb, boolean) from public, anon, authenticated;

-- Permiso para escribir direcciones: alta de clientes o edición de clientes.
create or replace function _customer_address_assert(p_tenant uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if stock_my_role() is null or stock_my_role() = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(p_tenant, 'direcciones_geo') then
    raise exception 'feature_not_in_plan: direcciones_geo' using errcode = 'check_violation';
  end if;
  if not (member_has_capability(p_tenant, 'customers.edit') or member_has_capability(p_tenant, 'customers.create')) then
    raise exception 'forbidden_role' using errcode = '42501', detail = 'capability:customers.edit';
  end if;
end;
$$;
revoke all on function _customer_address_assert(uuid) from public, anon, authenticated;

-- Alta o edición de una dirección del cliente (ficha del cliente y cobro).
create or replace function public.customer_address_save(p_customer_id uuid, p_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_clean  jsonb;
  v_old    customer_addresses;
  v_row    customer_addresses;
  v_def    boolean := coalesce((p_data ->> 'is_default')::boolean, false);
begin
  perform _customer_address_assert(v_tenant);
  if not exists (select 1 from customers c
                  where c.id = p_customer_id and c.tenant_id = v_tenant and c.deleted_at is null) then
    raise exception 'customer_not_found';
  end if;
  v_clean := _ship_to_clean(p_data);

  if p_id is null then
    v_row := _customer_address_insert(v_tenant, p_customer_id, v_clean, v_def);
    return to_jsonb(v_row);
  end if;

  select * into v_old from customer_addresses
   where id = p_id and tenant_id = v_tenant and customer_id = p_customer_id and deleted_at is null
   for update;
  if v_old.id is null then
    raise exception 'address_not_found';
  end if;
  if v_def and not v_old.is_default then
    update customer_addresses set is_default = false
     where customer_id = p_customer_id and tenant_id = v_tenant and is_default and deleted_at is null;
  end if;
  update customer_addresses set
    label = v_clean ->> 'label', street = v_clean ->> 'street', number = v_clean ->> 'number',
    floor = v_clean ->> 'floor', apartment = v_clean ->> 'apartment', locality = v_clean ->> 'locality',
    partido = v_clean ->> 'partido', province = v_clean ->> 'province', province_code = v_clean ->> 'province_code',
    postal_code = v_clean ->> 'postal_code', between_streets = v_clean ->> 'between_streets',
    reference = v_clean ->> 'reference', lat = (v_clean ->> 'lat')::double precision,
    lng = (v_clean ->> 'lng')::double precision, geo_source = v_clean ->> 'geo_source',
    geo_quality = v_clean ->> 'geo_quality', normalized = v_clean -> 'normalized',
    contact_name = v_clean ->> 'contact_name', contact_phone = v_clean ->> 'contact_phone',
    delivery_notes = v_clean ->> 'delivery_notes', is_default = v_old.is_default or v_def
  where id = p_id
  returning * into v_row;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'customer_addresses', p_id, 'customer_address_updated',
          jsonb_build_object('text', _ship_to_text(_customer_address_snapshot(v_old)), 'geo_quality', v_old.geo_quality),
          jsonb_build_object('customer_id', p_customer_id, 'text', _ship_to_text(v_clean),
                             'geo_quality', v_row.geo_quality, 'is_default', v_row.is_default));
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.customer_address_save(uuid, uuid, jsonb) from public, anon;
grant execute on function public.customer_address_save(uuid, uuid, jsonb) to authenticated;

-- Baja lógica. Si era la predeterminada, pasa a serlo la más nueva.
create or replace function public.customer_address_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_old    customer_addresses;
begin
  perform _customer_address_assert(v_tenant);
  select * into v_old from customer_addresses
   where id = p_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if v_old.id is null then
    raise exception 'address_not_found';
  end if;
  update customer_addresses set deleted_at = now(), is_default = false where id = p_id;
  if v_old.is_default then
    update customer_addresses set is_default = true
     where id = (select a.id from customer_addresses a
                  where a.customer_id = v_old.customer_id and a.tenant_id = v_tenant and a.deleted_at is null
                  order by a.created_at desc limit 1);
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
  values (v_tenant, auth.uid(), 'customer_addresses', p_id, 'customer_address_deleted',
          jsonb_build_object('customer_id', v_old.customer_id, 'text', _ship_to_text(_customer_address_snapshot(v_old))));
end;
$$;
revoke all on function public.customer_address_delete(uuid) from public, anon;
grant execute on function public.customer_address_delete(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- G) Cliente obligatorio para enviar (servidor)
-- -----------------------------------------------------------------------------
-- Toda entrega por envío de una venta del POS lleva cliente. Cubre
-- pos_sale_create_fulfilled y dispatch_create_for_sale sin recrearlas. Las
-- entregas de pedidos (sale_order_id) quedan afuera (ver encabezado).
create or replace function trg_dispatches_customer_required()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.delivery_type is distinct from 'envio' or new.sale_id is null or new.sale_order_id is not null
     or new.status = 'cancelado' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.delivery_type = 'envio' then
      return new;
    end if;
  end if;
  if not exists (select 1 from sales s
                  where s.id = new.sale_id and s.customer_id is not null) then
    raise exception 'customer_required_for_shipping' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function trg_dispatches_customer_required() from public, anon, authenticated;

drop trigger if exists dispatches_customer_required on dispatches;
create trigger dispatches_customer_required
  before insert or update of delivery_type on dispatches
  for each row execute function trg_dispatches_customer_required();

-- Venta con envío desde la hoja de cobro: valida cliente y dirección, guarda
-- la dirección en el cliente si se pide, llama a pos_sale_create_fulfilled
-- (sin cambios) y copia la dirección en cada entrega por envío. Todo en una
-- transacción. Cada entrega de p_plan.deliveries con mode 'envio' acepta:
--   address_id        dirección guardada del cliente, o
--   ship_to           dirección nueva (objeto), y
--   save_to_customer  true para guardarla en el cliente.
create or replace function public.pos_sale_create_delivery(p_sale jsonb, p_plan jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_customer uuid;
  v_dels     jsonb := coalesce(p_plan -> 'deliveries', '[]'::jsonb);
  v_plan     jsonb := p_plan;
  v_d        jsonb;
  v_idx      int;
  v_addr     customer_addresses;
  v_ship     jsonb;
  v_addr_id  uuid;
  v_envio    jsonb := '[]'::jsonb;
  v_res      jsonb;
  v_k        int := 0;
  v_e        jsonb;
  r          jsonb;
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if stock_my_role() is null or stock_my_role() = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_sale) is distinct from 'object' or jsonb_typeof(v_dels) is distinct from 'array'
     or jsonb_array_length(v_dels) > 10 then
    raise exception 'invalid_plan';
  end if;
  begin
    v_customer := nullif(p_sale ->> 'p_customer_id', '')::uuid;
  exception when others then
    raise exception 'customer_not_found';
  end;

  for v_idx in 0 .. jsonb_array_length(v_dels) - 1 loop
    v_d := v_dels -> v_idx;
    if v_d ->> 'mode' is distinct from 'envio' then
      continue;
    end if;
    if v_customer is null then
      raise exception 'customer_required_for_shipping' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from customers c
                    where c.id = v_customer and c.tenant_id = v_tenant and c.deleted_at is null) then
      raise exception 'customer_not_found';
    end if;
    v_ship := null;
    v_addr_id := null;
    if nullif(v_d ->> 'address_id', '') is not null then
      if not tenant_has_feature_for(v_tenant, 'direcciones_geo') then
        raise exception 'feature_not_in_plan: direcciones_geo' using errcode = 'check_violation';
      end if;
      select * into v_addr from customer_addresses a
       where a.id = (v_d ->> 'address_id')::uuid and a.tenant_id = v_tenant
         and a.customer_id = v_customer and a.deleted_at is null;
      if v_addr.id is null then
        raise exception 'address_not_found';
      end if;
      v_addr_id := v_addr.id;
      v_ship := _customer_address_snapshot(v_addr);
    elsif jsonb_typeof(v_d -> 'ship_to') = 'object' then
      if not tenant_has_feature_for(v_tenant, 'direcciones_geo') then
        raise exception 'feature_not_in_plan: direcciones_geo' using errcode = 'check_violation';
      end if;
      v_ship := _ship_to_clean(v_d -> 'ship_to');
      if coalesce((v_d ->> 'save_to_customer')::boolean, false) then
        perform _customer_address_assert(v_tenant);
        v_addr := _customer_address_insert(v_tenant, v_customer, v_ship,
                                           coalesce((v_d ->> 'make_default')::boolean, false));
        v_addr_id := v_addr.id;
      end if;
    end if;
    -- El texto de la entrega sale de la dirección estructurada si no vino.
    if v_ship is not null and char_length(btrim(coalesce(v_d ->> 'ship_address', ''))) < 5 then
      v_plan := jsonb_set(v_plan, array['deliveries', v_idx::text, 'ship_address'], to_jsonb(_ship_to_text(v_ship)));
    end if;
    v_envio := v_envio || jsonb_build_array(jsonb_build_object('address_id', v_addr_id, 'ship_to', v_ship));
  end loop;

  v_res := pos_sale_create_fulfilled(p_sale, v_plan);

  -- pos_sale_create_fulfilled devuelve las entregas por envío en el orden del
  -- plan: la k-ésima es la k-ésima entrega por envío pedida.
  for r in select x from jsonb_array_elements(coalesce(v_res -> 'deliveries', '[]'::jsonb)) x loop
    if r ->> 'mode' is distinct from 'envio' then
      continue;
    end if;
    v_e := v_envio -> v_k;
    v_k := v_k + 1;
    if v_e is null or (v_e -> 'ship_to') is null or jsonb_typeof(v_e -> 'ship_to') = 'null' then
      continue;
    end if;
    update dispatches
       set address_id = nullif(v_e ->> 'address_id', '')::uuid, ship_to = v_e -> 'ship_to'
     where id = (r ->> 'id')::uuid and tenant_id = v_tenant;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'dispatches', (r ->> 'id')::uuid, 'dispatch_address_set',
            jsonb_build_object('address_id', v_e ->> 'address_id', 'text', _ship_to_text(v_e -> 'ship_to'),
                               'geo_quality', v_e -> 'ship_to' ->> 'geo_quality', 'sale_id', v_res ->> 'sale_id'));
  end loop;

  return v_res;
end;
$$;
revoke all on function public.pos_sale_create_delivery(jsonb, jsonb) from public, anon;
grant execute on function public.pos_sale_create_delivery(jsonb, jsonb) to authenticated;

comment on function public.pos_sale_create_delivery(jsonb, jsonb) is
  'Venta con envío (ADR-157): cliente obligatorio, dirección guardada o nueva (y guardarla en el cliente) y copia de la dirección en cada entrega, sobre pos_sale_create_fulfilled en la misma transacción.';
