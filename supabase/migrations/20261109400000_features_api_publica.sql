-- =============================================================================
-- 20261109400000_features_api_publica  (ADR-094 · F5 · API pública v1)
--
-- `api_publica` deja de ser MARKETING-FUTURO y pasa a OPTIONAL real, sólo en
-- Enterprise (convención CLAUDE.md §6):
--   1. Key en `features` (ya existía desde 20260608110000): se actualiza el
--      texto, is_basic = false y grupo integraciones.
--   2. Marca por plan: Enterprise sí, Start, Pro y Business no (ya estaba
--      declarada en 20260608150000; acá se completa sólo si falta).
--   3. Gating real server-side: api_token_issue y _api_auth (20261109400200)
--      exigen tenant_has_feature_for(tenant, 'api_publica') al emitir el token
--      y en CADA llamada a la API; api_client_create / _rotate / _update
--      (20261109400100) también.
--   4. Copy en lib/saas/featureInfo.ts; 5. comparación derivada de la matriz.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('api_publica', 'API pública',
   'API REST versionada (/api/v1) con credenciales OAuth2 por negocio y permisos por alcance: productos, stock por sucursal, precios, ventas y clientes',
   'integraciones', false, 210)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  -- Lo ya declarado gana: sólo se completa la key si falta.
  jsonb_build_object('api_publica', (p.key = 'enterprise'))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'api_publica');
