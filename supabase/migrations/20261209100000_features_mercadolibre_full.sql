-- =============================================================================
-- 20261209100000_features_mercadolibre_full  (ADR-142 · Mercado Libre Full)
--
-- Feature `mercadolibre_full`: OPTIONAL (convención CLAUDE.md §6), requiere
-- `mercadolibre`. Depósito virtual "Mercado Libre Full" por cuenta (stock de
-- Full sincronizado desde la API, no vendible en el POS), envíos a Full con
-- tránsito y conciliación de la recepción, etiquetas de producto y de bulto,
-- cobertura y alertas de quiebre, costos de Full.
--   1. Key en `features` (grupo integraciones, is_basic = false).
--   2. Marca por plan: Business y Enterprise sí; Start y Pro no (Full es para
--      vendedores con volumen que ya operan Mercado Libre; ver ADR-142). Lo ya
--      declarado en un plan gana (sólo se completa si falta).
--   3. Gating real server-side en 20261209100100_mercadolibre_full:
--      ml_full_assert (RPC de la UI), ml_full_edge_guard (Edge ml_full),
--      ml_full_inventory_upsert / ml_full_ops_save / ml_full_costs_save
--      (ingesta del worker) y el descuento del depósito Full en ml_ingest_pack.
--   4. Copy en lib/saas/featureInfo.ts; 5. comparación derivada de la matriz.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('mercadolibre_full', 'Mercado Libre Full',
   'Depósito virtual Mercado Libre Full por cuenta con el stock de Full sincronizado (disponible, no disponible por motivo y en camino), envíos a Full desde tu depósito con tránsito y conciliación de lo recibido, etiquetas de producto y de bulto, cobertura en días y alertas de quiebre, y costos de Full',
   'integraciones', false, 232)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('mercadolibre_full', (p.key in ('business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'mercadolibre_full');
