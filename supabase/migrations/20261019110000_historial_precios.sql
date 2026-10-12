-- =============================================================================
-- 20261019110000_historial_precios  (F18 · H100 · ADR-056)
--
-- Historial de precios por producto, variante y lista: quién, cuándo, de dónde
-- vino el cambio (manual, import, bulk, list) y el precio anterior y nuevo.
--
--   · product_price_history: sólo lectura por RLS (negocio actual con la
--     feature, o staff interno con scope, ADR-052). Lo escriben los triggers.
--   · Triggers en products (price), product_variants (price_override) y
--     price_list_items (price; alta, cambio y baja). El alta de un producto
--     queda con precio anterior vacío.
--   · Origen: `ninja.price_source` (local a la transacción, para RPC futuras
--     como la actualización masiva) o el header `x-ninja-price-source` que
--     manda el cliente (import de productos); si no, 'manual' o 'list'.
--   · Feature BASE `historial_precios` (ver la consulta; el registro corre
--     siempre, así bajar de plan no deja huecos).
--
-- Fuera de alcance: el cambio del % de una lista (price_lists.adjustment_pct)
-- mueve el precio efectivo de muchos productos y no se expande acá; queda en
-- audit_logs. Lo cubre "versiones de lista" (resto de H100).
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('historial_precios', 'Historial de precios',
   'Historial de precios por producto, variante y lista con quién y cuándo', 'catalogo', true, 91)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('historial_precios', true), true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'historial_precios');

create table if not exists product_price_history (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  variant_id  uuid references product_variants(id) on delete cascade,
  list_id     uuid references price_lists(id) on delete cascade,
  old_price   numeric(12,2),
  new_price   numeric(12,2),
  changed_by  uuid default auth.uid(),
  source      text not null default 'manual' check (source in ('manual', 'import', 'bulk', 'list')),
  at          timestamptz not null default now()
);

create index if not exists product_price_history_product_idx
  on product_price_history(product_id, at desc);
create index if not exists product_price_history_tenant_idx on product_price_history(tenant_id, at desc);

alter table product_price_history enable row level security;
revoke insert, update, delete on product_price_history from anon, authenticated;
drop policy if exists product_price_history_select on product_price_history;
create policy product_price_history_select on product_price_history
  for select using (
    (tenant_id = (select current_tenant_id())
     and (select tenant_has_feature_for((select current_tenant_id()), 'historial_precios')))
    or (select internal_scope())
  );

-- Origen del cambio: setting de la transacción, header del cliente o default.
create or replace function _price_change_source(p_default text)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v text := nullif(current_setting('ninja.price_source', true), '');
begin
  if v is null then
    begin
      v := nullif(current_setting('request.headers', true), '')::json ->> 'x-ninja-price-source';
    exception when others then
      v := null;
    end;
  end if;
  if v in ('manual', 'import', 'bulk', 'list') then return v; end if;
  return p_default;
end;
$$;

create or replace function trg_products_price_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.price is not null then
      insert into product_price_history (tenant_id, product_id, old_price, new_price, source)
      values (new.tenant_id, new.id, null, new.price, _price_change_source('manual'));
    end if;
  elsif new.price is distinct from old.price then
    insert into product_price_history (tenant_id, product_id, old_price, new_price, source)
    values (new.tenant_id, new.id, old.price, new.price, _price_change_source('manual'));
  end if;
  return null;
end;
$$;
revoke all on function trg_products_price_history() from public, anon, authenticated;

drop trigger if exists products_price_history on products;
create trigger products_price_history
  after insert or update of price on products
  for each row execute function trg_products_price_history();

create or replace function trg_variants_price_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.price_override is not null then
      insert into product_price_history (tenant_id, product_id, variant_id, old_price, new_price, source)
      values (new.tenant_id, new.product_id, new.id, null, new.price_override, _price_change_source('manual'));
    end if;
  elsif new.price_override is distinct from old.price_override then
    insert into product_price_history (tenant_id, product_id, variant_id, old_price, new_price, source)
    values (new.tenant_id, new.product_id, new.id, old.price_override, new.price_override,
            _price_change_source('manual'));
  end if;
  return null;
end;
$$;
revoke all on function trg_variants_price_history() from public, anon, authenticated;

drop trigger if exists product_variants_price_history on product_variants;
create trigger product_variants_price_history
  after insert or update of price_override on product_variants
  for each row execute function trg_variants_price_history();

create or replace function trg_price_list_items_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    -- Borrado en cascada de la lista, el producto o la variante: no hay a quién
    -- colgarle la fila (y la FK lo impediría).
    if not exists (select 1 from products where id = old.product_id)
       or not exists (select 1 from price_lists where id = old.price_list_id)
       or (old.variant_id is not null and not exists (select 1 from product_variants where id = old.variant_id)) then
      return null;
    end if;
    insert into product_price_history (tenant_id, product_id, variant_id, list_id, old_price, new_price, source)
    values (old.tenant_id, old.product_id, old.variant_id, old.price_list_id, old.price, null,
            _price_change_source('list'));
  elsif tg_op = 'INSERT' then
    insert into product_price_history (tenant_id, product_id, variant_id, list_id, old_price, new_price, source)
    values (new.tenant_id, new.product_id, new.variant_id, new.price_list_id, null, new.price,
            _price_change_source('list'));
  elsif new.price is distinct from old.price then
    insert into product_price_history (tenant_id, product_id, variant_id, list_id, old_price, new_price, source)
    values (new.tenant_id, new.product_id, new.variant_id, new.price_list_id, old.price, new.price,
            _price_change_source('list'));
  end if;
  return null;
end;
$$;
revoke all on function trg_price_list_items_history() from public, anon, authenticated;

drop trigger if exists price_list_items_history on price_list_items;
create trigger price_list_items_history
  after insert or update of price or delete on price_list_items
  for each row execute function trg_price_list_items_history();
