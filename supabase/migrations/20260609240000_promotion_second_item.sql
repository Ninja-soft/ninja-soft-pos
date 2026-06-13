-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F9 · H54 — Tipo de promoción: descuento por 2º ítem ("2do al X%")          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Suma el action_type 'second_item' al motor de promociones: en cada par de
-- unidades del alcance, el más barato recibe `action_value`% de descuento.
-- Reusa action_value (el %); no necesita columnas nuevas. ADITIVO: sólo extiende
-- el CHECK de action_type y agrega la cota de % (≤ 100), como en 'percent'.

alter table promotions drop constraint if exists promotions_action_type_check;
alter table promotions
  add constraint promotions_action_type_check
  check (action_type in ('percent','amount','nxm','fixed_price','second_item'));

alter table promotions drop constraint if exists promotions_second_item_pct_check;
alter table promotions
  add constraint promotions_second_item_pct_check
  check (action_type <> 'second_item' or action_value <= 100);
