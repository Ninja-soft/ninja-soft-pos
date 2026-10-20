-- =============================================================================
-- 20270115100000_h163_catalogo  (F24 · H163, ADR-177)
--
-- Catálogo PRO (BASE, sin feature de plan nueva):
--
--   A) products.usage: 'both' (default), 'sale' o 'purchase'. Un insumo
--      (sólo compra) no se vende: trigger BEFORE INSERT en sale_items
--      ('product_not_for_sale') y no aparece en el catálogo público.
--   B) product_barcodes: códigos alternativos por artículo (y por variante),
--      opcionalmente de un proveedor. Código normalizado (mayúsculas, sin
--      espacios) y único por negocio entre las filas vivas; no puede pisar el
--      código principal de otro artículo ni de una variante ni el de una
--      unidad de venta (y al revés: products.barcode y
--      product_variants.barcode no pueden pisar un alternativo).
--   C) product_sale_units: unidad de venta con coeficiente (bulto, caja,
--      pack): N unidades del artículo, precio propio o derivado (N × precio
--      unitario con descuento opcional) y código propio. No se combina con
--      pesables (unit 'kg'), variantes, serializados ni servicios.
--   D) product_by_code(p_code): EL resolver de códigos (variante, artículo
--      por barcode/SKU/PLU, alternativo, unidad de venta y PLU sin ceros a
--      la izquierda). SECURITY INVOKER: corre con la RLS del usuario.
--   E) Venta por unidad de venta sin tocar create_sale: el POS manda el
--      renglón ya expandido (cantidad = packs × N, precio unitario de lista,
--      descuento del renglón = lo que baja el pack) con sale_unit_id. El
--      stock y el precio los valida create_sale como siempre;
--      _sale_apply_service (que create_sale ya llama con los renglones)
--      valida que la unidad sea del artículo y que la cantidad sea múltiplo
--      exacto, y la deja en sale_items (sale_unit_id, sale_unit_label,
--      sale_unit_qty).
--   F) public_catalog sin los artículos de sólo compra.
--
-- NO aplicada en ningún entorno al commitear.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Artículo de compra, venta o ambos
-- -----------------------------------------------------------------------------
alter table public.products add column if not exists usage text not null default 'both';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_usage_check') then
    alter table public.products add constraint products_usage_check
      check (usage in ('both', 'sale', 'purchase'));
  end if;
end;
$$;

comment on column public.products.usage is
  'H163: both (compra y venta), sale (sólo venta: no aparece al comprar) o purchase (insumo: no se vende ni sale en el catálogo).';

create or replace function public.trg_sale_item_for_sale()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.product_id is not null
     and exists (select 1 from products p where p.id = new.product_id and p.usage = 'purchase') then
    raise exception 'product_not_for_sale'
      using detail = new.product_name, errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.trg_sale_item_for_sale() from public, anon, authenticated;

drop trigger if exists sale_item_for_sale on public.sale_items;
create trigger sale_item_for_sale
  before insert on public.sale_items
  for each row execute function public.trg_sale_item_for_sale();

-- -----------------------------------------------------------------------------
-- B) Códigos alternativos
-- -----------------------------------------------------------------------------
create table if not exists public.product_barcodes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  variant_id  uuid references product_variants(id) on delete cascade,
  code        text not null check (code ~ '^[A-Z0-9._-]{1,60}$'),
  kind        text not null default 'alt' check (kind in ('alt', 'supplier')),
  supplier_id uuid references suppliers(id) on delete set null,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Un código vivo por negocio (también sirve de índice de búsqueda y de tenant).
create unique index if not exists uq_product_barcodes_code
  on public.product_barcodes(tenant_id, code) where deleted_at is null;
create index if not exists idx_product_barcodes_product
  on public.product_barcodes(product_id) where deleted_at is null;
create index if not exists idx_product_barcodes_variant
  on public.product_barcodes(variant_id) where variant_id is not null;
create index if not exists idx_product_barcodes_supplier
  on public.product_barcodes(supplier_id) where supplier_id is not null;

comment on table public.product_barcodes is
  'H163: códigos alternativos de un artículo (o de una variante), opcionalmente de un proveedor. El buscador y el scanner los resuelven con product_by_code.';

-- -----------------------------------------------------------------------------
-- C) Unidades de venta con coeficiente (antes que el trigger de B, que la lee)
-- -----------------------------------------------------------------------------
create table if not exists public.product_sale_units (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  product_id   uuid not null references products(id) on delete cascade,
  label        text not null default 'Bulto' check (char_length(btrim(label)) between 1 and 20),
  units        int  not null check (units between 2 and 10000),
  -- Precio del bulto. null = derivado: units × precio unitario × (1 - discount_pct/100).
  price        numeric(14, 2) check (price is null or price > 0),
  discount_pct numeric(5, 2) not null default 0 check (discount_pct >= 0 and discount_pct < 100),
  barcode      text check (barcode is null or barcode ~ '^[A-Z0-9._-]{1,60}$'),
  is_active    boolean not null default true,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create index if not exists idx_product_sale_units_product
  on public.product_sale_units(product_id) where deleted_at is null;
create unique index if not exists uq_product_sale_units_barcode
  on public.product_sale_units(tenant_id, barcode) where barcode is not null and deleted_at is null;

drop trigger if exists set_updated_at_product_sale_units on public.product_sale_units;
create trigger set_updated_at_product_sale_units
  before update on public.product_sale_units
  for each row execute function set_updated_at();

comment on table public.product_sale_units is
  'H163: unidad de venta con coeficiente (bulto, caja, pack). Vender 1 = vender units del artículo (stock descuenta units). Precio propio o derivado.';

-- ¿Quién usa este código en el negocio? Devuelve el origen o null. p_kind es
-- de dónde viene el código que se valida (no se compara contra sí mismo). El
-- principal del artículo y el de la variante no se cruzan entre sí acá (eso
-- ya lo resuelve el índice único y el orden del resolver): sólo contra los
-- alternativos y las unidades de venta.
create or replace function public._catalog_code_taken(
  p_tenant  uuid,
  p_code    text,
  p_kind    text,
  p_self    uuid,
  p_product uuid default null
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select k from (
    select 'product'::text as k, 1 as o
      from products p
     where p_kind not in ('product', 'variant')
       and p.tenant_id = p_tenant and p.deleted_at is null
       and p.barcode = any (array[p_code, lower(p_code)])
    union all
    select 'variant', 2
      from product_variants v
     where p_kind not in ('product', 'variant')
       and v.tenant_id = p_tenant and v.deleted_at is null
       and v.barcode = any (array[p_code, lower(p_code)])
    union all
    select 'alt', 3
      from product_barcodes b
     where b.tenant_id = p_tenant and b.deleted_at is null and b.code = p_code
       and (p_kind <> 'alt' or b.id <> p_self)
       -- El principal puede pasar a ser uno de sus propios alternativos (se
       -- graba el artículo antes que la lista).
       and (p_kind not in ('product', 'variant') or b.product_id <> p_product)
    union all
    select 'sale_unit', 4
      from product_sale_units u
     where u.tenant_id = p_tenant and u.deleted_at is null and u.barcode = p_code
       and (p_kind <> 'sale_unit' or u.id <> p_self)
  ) x
  order by o
  limit 1;
$$;
revoke all on function public._catalog_code_taken(uuid, text, text, uuid, uuid) from public, anon, authenticated;

-- B) normalización y choque de códigos alternativos.
create or replace function public.trg_product_barcodes_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_taken text;
begin
  new.code := upper(regexp_replace(coalesce(new.code, ''), '\s+', '', 'g'));
  if new.code = '' or new.code !~ '^[A-Z0-9._-]{1,60}$' then
    raise exception 'barcode_invalid' using errcode = 'P0001';
  end if;
  if not exists (select 1 from products p
                  where p.id = new.product_id and p.tenant_id = new.tenant_id) then
    raise exception 'product_not_found' using errcode = 'P0001';
  end if;
  if new.variant_id is not null and not exists (
       select 1 from product_variants v
        where v.id = new.variant_id and v.product_id = new.product_id and v.tenant_id = new.tenant_id) then
    raise exception 'variant_not_found' using errcode = 'P0001';
  end if;
  if new.supplier_id is not null and not exists (
       select 1 from suppliers s where s.id = new.supplier_id and s.tenant_id = new.tenant_id) then
    raise exception 'supplier_not_found' using errcode = 'P0001';
  end if;
  new.kind := case when new.supplier_id is not null then 'supplier' else coalesce(new.kind, 'alt') end;
  if new.deleted_at is null then
    v_taken := _catalog_code_taken(new.tenant_id, new.code, 'alt', new.id);
    if v_taken is not null then
      raise exception 'barcode_taken:%', v_taken using detail = new.code, errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.trg_product_barcodes_guard() from public, anon, authenticated;

drop trigger if exists product_barcodes_guard on public.product_barcodes;
create trigger product_barcodes_guard
  before insert or update on public.product_barcodes
  for each row execute function public.trg_product_barcodes_guard();

-- C) validación de la unidad de venta.
create or replace function public.trg_product_sale_units_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p     record;
  v_taken text;
begin
  new.label := btrim(coalesce(new.label, ''));
  new.barcode := nullif(upper(regexp_replace(coalesce(new.barcode, ''), '\s+', '', 'g')), '');
  if new.barcode is not null and new.barcode !~ '^[A-Z0-9._-]{1,60}$' then
    raise exception 'barcode_invalid' using errcode = 'P0001';
  end if;
  select p.unit, p.has_variants, p.is_serialized, p.is_service into v_p
    from products p where p.id = new.product_id and p.tenant_id = new.tenant_id;
  if not found then
    raise exception 'product_not_found' using errcode = 'P0001';
  end if;
  if new.deleted_at is null then
    if coalesce(v_p.unit, 'un') = 'kg' then
      raise exception 'sale_unit_weighted_not_allowed' using errcode = 'P0001';
    end if;
    if coalesce(v_p.has_variants, false) or coalesce(v_p.is_serialized, false) or coalesce(v_p.is_service, false) then
      raise exception 'sale_unit_not_allowed' using errcode = 'P0001';
    end if;
    if new.barcode is not null then
      v_taken := _catalog_code_taken(new.tenant_id, new.barcode, 'sale_unit', new.id);
      if v_taken is not null then
        raise exception 'barcode_taken:%', v_taken using detail = new.barcode, errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.trg_product_sale_units_guard() from public, anon, authenticated;

drop trigger if exists product_sale_units_guard on public.product_sale_units;
create trigger product_sale_units_guard
  before insert or update on public.product_sale_units
  for each row execute function public.trg_product_sale_units_guard();

-- El código principal (del artículo o de la variante) tampoco puede pisar un
-- alternativo o el de una unidad de venta; y un artículo con unidades de
-- venta no pasa a pesable, con variantes ni serializado.
create or replace function public.trg_products_code_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check boolean := false;
  v_code  text;
  v_taken text;
begin
  if new.barcode is not null and new.deleted_at is null then
    if tg_op = 'INSERT' then
      v_check := true;
    elsif new.barcode is distinct from old.barcode or old.deleted_at is not null then
      v_check := true;
    end if;
  end if;
  if v_check then
    v_code := upper(btrim(new.barcode));
    if v_code <> '' then
      v_taken := _catalog_code_taken(new.tenant_id, v_code, 'product', new.id, new.id);
      if v_taken is not null then
        raise exception 'barcode_taken:%', v_taken using detail = new.barcode, errcode = 'P0001';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.deleted_at is null
     and (coalesce(new.unit, 'un') = 'kg' or coalesce(new.has_variants, false) or coalesce(new.is_serialized, false)
          or coalesce(new.is_service, false))
     and exists (select 1 from product_sale_units u
                  where u.product_id = new.id and u.deleted_at is null and u.is_active) then
    raise exception 'sale_unit_not_allowed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.trg_products_code_guard() from public, anon, authenticated;

drop trigger if exists products_code_guard on public.products;
create trigger products_code_guard
  before insert or update of barcode, unit, has_variants, is_serialized, is_service, deleted_at on public.products
  for each row execute function public.trg_products_code_guard();

create or replace function public.trg_product_variants_code_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check boolean := false;
  v_taken text;
begin
  if new.barcode is not null and btrim(new.barcode) <> '' and new.deleted_at is null then
    if tg_op = 'INSERT' then
      v_check := true;
    elsif new.barcode is distinct from old.barcode or old.deleted_at is not null then
      v_check := true;
    end if;
  end if;
  if v_check then
    v_taken := _catalog_code_taken(new.tenant_id, upper(btrim(new.barcode)), 'variant', new.id, new.product_id);
    if v_taken is not null then
      raise exception 'barcode_taken:%', v_taken using detail = new.barcode, errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.trg_product_variants_code_guard() from public, anon, authenticated;

drop trigger if exists product_variants_code_guard on public.product_variants;
create trigger product_variants_code_guard
  before insert or update of barcode, deleted_at on public.product_variants
  for each row execute function public.trg_product_variants_code_guard();

-- RLS (B y C): lectura del negocio; alta y edición con products.edit. Sin
-- DELETE: baja lógica.
alter table public.product_barcodes enable row level security;
alter table public.product_sale_units enable row level security;

drop policy if exists product_barcodes_select on public.product_barcodes;
create policy product_barcodes_select on public.product_barcodes
  for select using (tenant_id = (select current_tenant_id()));

drop policy if exists product_barcodes_insert on public.product_barcodes;
create policy product_barcodes_insert on public.product_barcodes
  for insert with check (
    tenant_id = (select current_tenant_id())
    and (select has_capability('products.edit'))
  );

drop policy if exists product_barcodes_update on public.product_barcodes;
create policy product_barcodes_update on public.product_barcodes
  for update using (
    tenant_id = (select current_tenant_id())
    and (select has_capability('products.edit'))
  )
  with check (
    tenant_id = (select current_tenant_id())
    and (select has_capability('products.edit'))
  );

drop policy if exists product_sale_units_select on public.product_sale_units;
create policy product_sale_units_select on public.product_sale_units
  for select using (tenant_id = (select current_tenant_id()));

drop policy if exists product_sale_units_insert on public.product_sale_units;
create policy product_sale_units_insert on public.product_sale_units
  for insert with check (
    tenant_id = (select current_tenant_id())
    and (select has_capability('products.edit'))
  );

drop policy if exists product_sale_units_update on public.product_sale_units;
create policy product_sale_units_update on public.product_sale_units
  for update using (
    tenant_id = (select current_tenant_id())
    and (select has_capability('products.edit'))
  )
  with check (
    tenant_id = (select current_tenant_id())
    and (select has_capability('products.edit'))
  );

grant select, insert, update on public.product_barcodes to authenticated;
grant select, insert, update on public.product_sale_units to authenticated;

drop trigger if exists audit_product_barcodes on public.product_barcodes;
create trigger audit_product_barcodes
  after insert or update or delete on public.product_barcodes
  for each row execute function write_audit_log();

drop trigger if exists audit_product_sale_units on public.product_sale_units;
create trigger audit_product_sale_units
  after insert or update or delete on public.product_sale_units
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- D) Resolver de códigos
--
-- Orden: variante (barcode/SKU), artículo (barcode/SKU/PLU), alternativo,
-- unidad de venta y PLU sin ceros a la izquierda ("42" = "000042"). Sólo
-- artículos vivos. Devuelve hasta p_limit coincidencias (1..50).
-- -----------------------------------------------------------------------------
create or replace function public.product_by_code(p_code text, p_limit int default 10)
returns table (
  product_id   uuid,
  variant_id   uuid,
  sale_unit_id uuid,
  match_kind   text
)
language sql
stable
set search_path = public, pg_temp
as $$
  with c as (
    select btrim(coalesce(p_code, '')) as raw,
           upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g')) as up,
           (select current_tenant_id()) as t
  )
  select r.product_id, r.variant_id, r.sale_unit_id, r.match_kind
    from (
      select v.product_id, v.id as variant_id, null::uuid as sale_unit_id, 'variant'::text as match_kind, 1 as o
        from c join product_variants v on v.tenant_id = c.t
        join products p on p.id = v.product_id and p.deleted_at is null
       where c.raw <> '' and v.deleted_at is null and (v.barcode = c.raw or v.sku = c.raw)
      union all
      select p.id, null, null, 'product', 2
        from c join products p on p.tenant_id = c.t
       where c.raw <> '' and p.deleted_at is null and (p.barcode = c.raw or p.sku = c.raw or p.plu = c.raw)
      union all
      select b.product_id, b.variant_id, null, b.kind, 3
        from c join product_barcodes b on b.tenant_id = c.t and b.code = c.up
        join products p on p.id = b.product_id and p.deleted_at is null
       where c.up <> '' and b.deleted_at is null
      union all
      select u.product_id, null, u.id, 'sale_unit', 4
        from c join product_sale_units u on u.tenant_id = c.t and u.barcode = c.up
        join products p on p.id = u.product_id and p.deleted_at is null
       where c.up <> '' and u.deleted_at is null and u.is_active
      union all
      select p.id, null, null, 'plu', 5
        from c join products p on p.tenant_id = c.t and p.plu = lpad(c.raw, 6, '0')
       where c.raw ~ '^[0-9]{1,5}$' and p.deleted_at is null
    ) r
   order by r.o
   limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;
revoke all on function public.product_by_code(text, int) from public, anon;
grant execute on function public.product_by_code(text, int) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Unidad de venta en el renglón vendido
--
-- Sin FK a propósito (sale_items es una tabla grande: una FK pide un índice
-- más en cada venta); el id se valida al grabar en _sale_apply_service.
-- -----------------------------------------------------------------------------
alter table public.sale_items
  add column if not exists sale_unit_id    uuid,
  add column if not exists sale_unit_label text,
  add column if not exists sale_unit_qty   numeric(12, 3);

alter table public.sale_items drop constraint if exists sale_items_sale_unit_chk;
alter table public.sale_items add constraint sale_items_sale_unit_chk
  check ((sale_unit_label is null or char_length(sale_unit_label) <= 40)
         and (sale_unit_qty is null or sale_unit_qty > 0)) not valid;

comment on column public.sale_items.sale_unit_id is
  'H163: unidad de venta (product_sale_units.id) con la que se vendió el renglón. quantity sigue en unidades del artículo.';
comment on column public.sale_items.sale_unit_label is 'H163: "Caja x 12" al vender (para el ticket y los reportes).';
comment on column public.sale_items.sale_unit_qty is 'H163: cantidad de bultos vendidos (quantity / unidades del bulto).';

-- _sale_apply_service: copia de 20261114100000_servicios_profesionales (la
-- única definición) + el bloque H163 de la unidad de venta.
create or replace function public._sale_apply_service(
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
  -- H163: unidad de venta del renglón.
  v_su       uuid;
  v_su_label text;
  v_su_units int;
  v_su_qty   numeric;
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

    -- H163 >>> unidad de venta: el renglón llega expandido (cantidad en
    -- unidades del artículo). La unidad tiene que ser de ese artículo y la
    -- cantidad, un múltiplo exacto de sus unidades.
    if nullif(btrim(coalesce(v_it ->> 'sale_unit_id', '')), '') is not null then
      if (v_it ->> 'sale_unit_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or coalesce(v_it ->> 'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'sale_unit_invalid' using errcode = 'P0001';
      end if;
      select u.id, u.label, u.units into v_su, v_su_label, v_su_units
        from product_sale_units u
       where u.id = (v_it ->> 'sale_unit_id')::uuid and u.tenant_id = p_tenant
         and u.product_id = (v_it ->> 'product_id')::uuid and u.deleted_at is null;
      if v_su is null then
        raise exception 'sale_unit_invalid' using errcode = 'P0001';
      end if;
      v_su_qty := coalesce((v_it ->> 'quantity')::numeric, 0) / v_su_units;
      if v_su_qty <= 0 or v_su_qty <> trunc(v_su_qty) then
        raise exception 'sale_unit_quantity_invalid' using errcode = 'P0001';
      end if;
      update sale_items
         set sale_unit_id = v_su,
             sale_unit_label = left(v_su_label || ' x ' || v_su_units, 40),
             sale_unit_qty = v_su_qty
       where id = p_line_ids[v_i] and tenant_id = p_tenant;
      v_su := null;
    end if;
    -- <<< H163

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
revoke all on function public._sale_apply_service(uuid, uuid, jsonb, uuid[], jsonb, date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- F) Catálogo público sin insumos: copia de 20261125100100_catalogo_pedidos
--    (la última definición) + el filtro de products.usage.
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
          -- H163: los insumos (sólo compra) no se publican.
          and coalesce(p.usage, 'both') <> 'purchase'
      ) s
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public_catalog(text) from public;
grant execute on function public_catalog(text) to anon, authenticated;
