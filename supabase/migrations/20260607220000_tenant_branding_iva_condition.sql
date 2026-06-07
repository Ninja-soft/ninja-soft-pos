-- =============================================================================
-- 20260607220000_tenant_branding_iva_condition  (SAAS-A)
-- Condición frente al IVA del comercio (pendiente de H8, requerida por los
-- datos fiscales opcionales del registro nuevo). Aplicada en remoto vía MCP.
-- =============================================================================
alter table tenant_branding add column if not exists iva_condition text
  check (iva_condition is null or iva_condition in
    ('monotributo','responsable_inscripto','exento','consumidor_final'));
