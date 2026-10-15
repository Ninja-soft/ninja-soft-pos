-- =============================================================================
-- 20261127100100_features_mercadolibre_gestor  (H141 · ADR-132 · parte B)
--
-- Feature `mercadolibre_gestor`: OPTIONAL (convención CLAUDE.md §6), requiere
-- `mercadolibre`. Métricas y reputación, posventa (reclamos, mediaciones y
-- devoluciones), embudos, plantillas de respuesta y umbrales.
--   1. Key en `features` (grupo integraciones, is_basic = false).
--   2. Marca por plan: Pro, Business y Enterprise sí (los mismos que
--      `mercadolibre`, para no quitarle nada a nadie); Start no. Lo ya
--      declarado en un plan gana (sólo se completa si falta).
--   3. Gating real server-side: ml_gestor_assert (RPC de la UI),
--      ml_edge_guard_gestor (Edge ml_gestor), ml_claim_upsert y
--      ml_reputation_snapshot_save (ingesta del worker) en
--      20261127100200_ml_gestor_posventa.
--   4. Copy en lib/saas/featureInfo.ts; 5. comparación derivada de la matriz.
-- Notificaciones: tipo 'mercadolibre' (copia de la lista más nueva,
-- 20261125100100_catalogo_pedidos, + 'mercadolibre').
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('mercadolibre_gestor', 'Gestor de Mercado Libre',
   'Métricas y reputación con el margen que te queda antes de perder el verde, posventa (reclamos, mediaciones y devoluciones con vencimiento, responder, pedir la mediación, aceptar la devolución), embudos de ventas y posventa, plantillas de respuesta y avisos',
   'integraciones', false, 231)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('mercadolibre_gestor', (p.key in ('pro', 'business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'mercadolibre_gestor');

alter table notifications drop constraint if exists notifications_type_check;
alter table notifications
  add constraint notifications_type_check
  check (type in ('news','plan','billing','usage','security','afip','maintenance','support',
                  'cobros','disputas','comercial','pedidos','mercadolibre'));
