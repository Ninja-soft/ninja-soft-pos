-- =============================================================================
-- 20261021100000_features_listas_precios_pro  (F18 · H100, ADR-058)
--
-- Feature de plan nueva (convención CLAUDE.md §6, categoría OPTIONAL):
--   • listas_precios_pro: tipos de lista (derivada, sobre costo, en moneda
--     extranjera), escalas por cantidad, condiciones de pago con recargo
--     financiero, redondeo de lista, piso de precio y margen mínimo,
--     actualización por índice o cotización y aprobación de cambios masivos.
--     Business y Enterprise. Requiere listas_precios.
--
-- Lo simple sigue donde estaba: listas por canal, % y precio fijo, vigencias,
-- listas por cliente, grupo y sucursal y precios programados son
-- `listas_precios` (OPTIONAL, Business). El asistente de actualización masiva
-- del precio base, el historial y la cola de etiquetas son BASE.
--
-- Idempotente: sólo escribe la key en los planes que todavía no la tienen.
-- El gating real vive en 20261021100100 (triggers y policies) y 20261021100300
-- (RPC de actualización masiva).
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('listas_precios_pro', 'Listas de precios PRO',
   'Listas derivadas, sobre costo y en moneda extranjera, escalas, plazos con recargo, redondeo, margen mínimo, índices y aprobación',
   'catalogo', false, 92)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('listas_precios_pro', (p.key in ('business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'listas_precios_pro');
