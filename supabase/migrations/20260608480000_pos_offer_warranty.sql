-- =============================================================================
-- 20260608480000_pos_offer_warranty  (H28 — oferta contextual automática)
-- Flag por tenant para des/activar la oferta contextual automática de garantía
-- extendida en el POS: cuando el carrito tiene un producto con garantía de
-- fábrica declarada (products.warranty_months > 0), el POS ofrece solo los
-- planes de garantía extendida (warranty_plans) aplicables. Default TRUE
-- (se ofrece de forma predeterminada). Solo afecta la UI de oferta; la prima
-- sigue entrando como línea de la venta con el mecanismo existente.
-- =============================================================================
alter table pos_settings
  add column if not exists offer_warranty boolean not null default true;
