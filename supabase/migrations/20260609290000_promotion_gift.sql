-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F9 · H54 — Regalo por compra (gift with purchase)                          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Nuevo action_type 'gift': al cumplir las condiciones (monto mínimo, alcance,
-- día/hora, medio…), el cliente se lleva GRATIS `gift_qty` unidades del producto
-- `gift_product_id`. Es un mecanismo APARTE del descuento (puede convivir con una
-- promo de descuento): en el POS se agrega como una línea a $0 del producto
-- regalado (el motor la pone/quita sola; create_sale le descuenta stock como a
-- cualquier ítem, sin cambios en create_sale). Aditivo.
alter table promotions
  add column if not exists gift_product_id uuid references products(id) on delete set null,
  add column if not exists gift_qty integer;

alter table promotions drop constraint if exists promotions_action_type_check;
alter table promotions
  add constraint promotions_action_type_check
  check (action_type in ('percent','amount','nxm','fixed_price','second_item','volume_tier','gift'));

-- Coherencia: 'gift' exige producto de regalo y cantidad ≥ 1; el resto no usa
-- estas columnas.
alter table promotions drop constraint if exists promotions_gift_check;
alter table promotions
  add constraint promotions_gift_check
  check (
    action_type <> 'gift'
    or (gift_product_id is not null and coalesce(gift_qty, 0) >= 1)
  );
