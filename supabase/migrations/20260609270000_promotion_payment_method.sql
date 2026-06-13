-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F9 · H54 — Condición de promoción: por medio de pago                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Suma una CONDICIÓN (no un tipo de acción) al motor de promociones: una promo
-- puede exigir un medio de pago concreto (ej. "10% en efectivo"). Es ortogonal al
-- action_type: cualquier tipo (percent/amount/nxm/...) puede condicionarse por
-- medio. null = cualquier medio (comportamiento actual). El medio se resuelve en
-- el modal de cobro al elegirlo; la promo se aplica por el canal de promo ya
-- existente en create_sale (NO se toca create_sale). ADITIVO.

alter table promotions
  add column if not exists payment_method text;

-- Sólo los medios que maneja la venta (espeja sales_payments.method). null = todos.
alter table promotions drop constraint if exists promotions_payment_method_check;
alter table promotions
  add constraint promotions_payment_method_check
  check (
    payment_method is null
    or payment_method in ('cash','debit','credit','transfer','qr','store_credit','account','other')
  );
