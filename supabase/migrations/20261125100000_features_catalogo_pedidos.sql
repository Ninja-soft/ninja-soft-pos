-- =============================================================================
-- 20261125100000_features_catalogo_pedidos  (F6 · H10, ADR-130)
--
-- Feature de plan nueva (convención CLAUDE.md §6):
--   • catalogo_pedidos (OPTIONAL, grupo catalogo): el cliente arma el carrito
--     en el catálogo público, elige retiro o envío, deja sus datos y confirma;
--     el pedido entra como pedido de salón (ADR-129) con el stock reservado,
--     aparece en el POS y en /pedidos, avisa al negocio y el cliente lo sigue
--     con un link.
--     Pro, Business y Enterprise: el pedido se cobra y se entrega con
--     pedidos_despacho (Pro) y se muestra en el catálogo público (Pro); un
--     corte más bajo dejaría pedidos que nadie puede levantar.
--
-- El gating real vive en public_catalog_order_create (20261125100100): exige
-- catalogo_publico, catalogo_pedidos y pedidos_despacho con
-- tenant_has_feature_for, y que el dueño lo haya prendido. La UI es cortesía.
-- Idempotente: sólo escribe la key en los planes globales que no la tienen.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('catalogo_pedidos', 'Pedidos desde el catálogo',
   'El cliente arma el carrito en el catálogo web (variantes, cantidades y stock disponible), elige retiro en sucursal o envío a domicilio y confirma: el pedido entra al POS con el stock reservado, avisa al negocio y el cliente lo sigue con un link',
   'catalogo', false, 101)
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
    || jsonb_build_object('catalogo_pedidos', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'catalogo_pedidos');
