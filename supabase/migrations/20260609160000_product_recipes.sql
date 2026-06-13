-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F13 · Gastronomía — H50: Recetas / escandallo (costo y margen por plato)  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Un plato gastronómico tiene una RECETA (escandallo): la lista de insumos que
-- consume, con su cantidad, unidad y costo estimado. Sumando el costo de los
-- insumos se obtiene el COSTO del plato, y contra el precio de venta, el MARGEN.
-- El dueño lo carga en la ficha del producto y ve costo + margen estimados.
--
-- Esta entrega es la DEFINICIÓN + costo/margen. El DESCUENTO de insumos al vender
-- (que toca create_sale) y la producción/merma quedan como follow-up (H50 resto).
--
-- Modelo simple v1: ingrediente como TEXTO libre + cantidad + unidad + costo
-- unitario (estimado). Vincular el ingrediente a un producto de stock (para
-- descontar al vender) es follow-up. RLS por tenant con una sola policy (igual que
-- product_modifier_groups/kits/variants); el gating de escritura a owner/manager
-- del dominio de producto vive en la capa de permisos/UI.

create table if not exists product_recipes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  -- Nombre del insumo (texto libre): "Harina 0000", "Muzzarella", "Café molido".
  ingredient  text not null,
  -- Cantidad que consume el plato, en la unidad indicada.
  qty         numeric(12,3) not null default 1 check (qty >= 0),
  -- Unidad libre: g, kg, ml, l, u, cc… (referencial, no se convierte).
  unit        text,
  -- Costo por UNIDAD del insumo (en la misma unidad que qty). costo línea = qty*unit_cost.
  unit_cost   numeric(12,2) not null default 0 check (unit_cost >= 0),
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists product_recipes_product_idx on product_recipes(product_id, sort);
create index if not exists product_recipes_tenant_idx on product_recipes(tenant_id);

create trigger set_updated_at_product_recipes
  before update on product_recipes
  for each row execute function set_updated_at();

alter table product_recipes enable row level security;
create policy product_recipes_tenant_isolation on product_recipes
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
