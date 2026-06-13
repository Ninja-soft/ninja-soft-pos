-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F9 · H54 — Tipo de promoción: % por volumen (escalonado)                   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Suma el action_type 'volume_tier' al motor de promociones: el descuento % sube
-- por TRAMOS de cantidad del alcance (ej. 3+ un = 10%, 6+ = 15%, 12+ = 20%). Los
-- tramos viven en una columna jsonb `volume_tiers` = [{ "min_qty": int, "pct": num }].
-- El motor toma la cantidad de unidades del alcance y aplica el % del tramo más
-- alto que califica (acotado server-side al subtotal del alcance, como el resto).
-- ADITIVO: nueva columna nullable + extensión del CHECK de action_type. No toca
-- ninguna promo existente.

alter table promotions
  add column if not exists volume_tiers jsonb;

alter table promotions drop constraint if exists promotions_action_type_check;
alter table promotions
  add constraint promotions_action_type_check
  check (action_type in ('percent','amount','nxm','fixed_price','second_item','volume_tier'));

-- Coherencia: 'volume_tier' exige un array jsonb NO vacío de tramos; el resto de
-- los tipos no usan la columna. (La forma de cada tramo {min_qty,pct} la
-- sanitiza el cliente y la acota el motor; el CHECK garantiza el contenedor.)
alter table promotions drop constraint if exists promotions_volume_tiers_check;
alter table promotions
  add constraint promotions_volume_tiers_check
  check (
    action_type <> 'volume_tier'
    or (
      volume_tiers is not null
      and jsonb_typeof(volume_tiers) = 'array'
      and jsonb_array_length(volume_tiers) >= 1
    )
  );
