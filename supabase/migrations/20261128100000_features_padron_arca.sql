-- =============================================================================
-- 20261128100000_features_padron_arca  (F18 · H104, ADR-133)
--
-- Feature de plan nueva (convención CLAUDE.md §6):
--   • padron_arca (BASE, grupo ventas): verificar el CUIT o CUIL de un cliente
--     contra el padrón de ARCA (constancia de inscripción) al darlo de alta o
--     editarlo, desde Clientes o desde el POS, con el certificado de NinjaSoft.
--     Autocompleta razón social, condición frente al IVA y domicilio fiscal y
--     muestra qué factura le corresponde.
--     BASE porque es lo mínimo para facturar bien a cualquier cliente (la
--     letra sale de su condición frente al IVA, ADR-068) y no le cuesta nada
--     a NinjaSoft por consulta: el freno es el rate limit, no el plan.
--
-- Gating real: la Edge arca_padron pide arca_padron_guard (tenant_has_feature_for)
-- y el trigger de customers exige la feature para marcar un cliente como
-- verificado por el padrón (20261128100100). La UI es cortesía.
-- Idempotente: sólo escribe la key en los planes globales que no la tienen.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('padron_arca', 'Verificar clientes en ARCA',
   'Verificar el CUIT o CUIL del cliente en el padrón de ARCA al darlo de alta: razón social, condición frente al IVA, monotributo, domicilio fiscal, actividades y estado de la CUIT, con la factura que le corresponde',
   'ventas', true, 49)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = true;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('padron_arca', true),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'padron_arca');
