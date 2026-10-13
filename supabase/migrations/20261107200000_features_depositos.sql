-- =============================================================================
-- 20261107200000_features_depositos  (F11 · H33, ADR-085)
--
-- Feature de plan nueva (convención CLAUDE.md §6, categoría OPTIONAL):
--   • depositos: depósitos dentro de cada sucursal (salón de ventas, reserva,
--     devoluciones, merma) con stock por depósito, movimientos internos con
--     tránsito, recepción parcial con diferencias, conteo por depósito y
--     reposición del salón sugerida por mínimos.
--
-- Tiering: Pro, Business y Enterprise. Un local de ropa o de electro con un
-- solo punto de venta ya tiene "salón y depósito": no depende de tener varias
-- sucursales (en una sucursal que no es la principal sí pide stock_sucursales,
-- porque sin eso no hay stock separado de esa sucursal). Start no la trae.
--
-- El gating real vive en las RPC de 20261107200100 (warehouse_assert). La UI
-- (página Depósitos) es sólo cortesía. Idempotente: sólo escribe la key en
-- los planes globales que todavía no la tienen.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('depositos', 'Depósitos internos',
   'Depósitos dentro de cada sucursal (salón, reserva, devoluciones, merma) con stock por depósito, movimientos internos en tránsito, recepción parcial con diferencias y reposición del salón por mínimos',
   'catalogo', false, 73)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = false;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('depositos', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'depositos');
