-- =============================================================================
-- 20261012010000_medios_pago_por_defecto  (Medios de pago: efectivo y
-- transferencia habilitados por defecto)
--
-- Hallazgo E2E: un negocio nuevo veía Efectivo y Transferencia APAGADOS en
-- Configuración > Medios de pago ("0 canales activos") aunque el POS los
-- ofrecía igual (fallback sin configuración de lib/pos/tenders.ts).
--
-- Regla nueva: efectivo y transferencia vienen prendidos en todo negocio.
--   • App: sin fila en tenant_payment_methods cuentan como habilitados
--     (lib/payments/defaults.ts, usado por la config y por el POS).
--   • Alta: la Edge create_tenant siembra ambas filas habilitadas.
--   • Esta migración siembra las filas faltantes en los negocios existentes.
--
-- Sólo inserta donde NO hay fila (on conflict do nothing): si el dueño ya
-- apagó alguno de los dos, se respeta. No cambia ningún otro medio.
-- El trigger tenant_payment_methods_assert_feature exige la feature al
-- habilitar; efectivo/transferencia son is_basic, pero se filtra igual por
-- tenant_has_feature_for para no abortar si un plan las apagó explícitamente.
-- Idempotente.
-- =============================================================================

insert into tenant_payment_methods (tenant_id, provider_key, enabled, sandbox, sort)
select t.id, p.key, true, false, p.sort
from tenants t
cross join (values ('cash', 0), ('transfer', 1)) as p(key, sort)
where t.deleted_at is null
  and not exists (
    select 1
    from tenant_payment_methods m
    where m.tenant_id = t.id
      and m.provider_key = p.key
  )
  and tenant_has_feature_for(t.id, payment_method_plan_key(p.key))
on conflict (tenant_id, provider_key) do nothing;
