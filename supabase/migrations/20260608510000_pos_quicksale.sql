-- =============================================================================
-- 20260608510000_pos_quicksale  (F12 · H36 — POS rápido por botones)
-- Capa de venta rápida para catálogo chico (heladerías / cafeterías / mostrador):
--   * products.is_favorite  — marca el producto/servicio como botón rápido del POS.
--   * products.favorite_order — orden opcional de los botones favoritos (asc).
--   * pos_settings.allow_free_sale — habilita la "Venta libre" (monto manual) en el
--     POS. El chequeo de rol vive en el cliente (owner/manager); este flag deja al
--     dueño apagar la función por completo aun para roles habilitados.
-- Conservador: defaults no rompen nada (favorito off; venta libre on por defecto,
-- igual que hoy donde la habilita el rubro quickSale). No toca create_sale: la
-- venta libre ya entra como ítem product_id NULL (ver quick_sale_free_items).
-- =============================================================================

alter table products
  add column if not exists is_favorite boolean not null default false,
  add column if not exists favorite_order integer not null default 0;

-- Índice parcial: la grilla de favoritos del POS filtra is_favorite = true.
create index if not exists products_favorite_idx
  on products (tenant_id, favorite_order, name)
  where is_favorite and deleted_at is null;

alter table pos_settings
  add column if not exists allow_free_sale boolean not null default true;
