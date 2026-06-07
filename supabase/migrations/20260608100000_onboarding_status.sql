-- =============================================================================
-- 20260608100000_onboarding_status  (SAAS-B — aplicada en remoto vía MCP)
-- Onboarding checklist antifallas: estado derivado de datos reales, sin
-- duplicación. onboarding_status() devuelve booleans por paso (miembros del
-- tenant, SECURITY INVOKER). pos_settings.onboarding_dismissed: cierre
-- permanente del widget. La señal de MP es tenant_payment_methods.enabled
-- (payment_secrets es deny-all e ilegible con INVOKER).
-- =============================================================================
alter table pos_settings add column if not exists onboarding_dismissed boolean not null default false;

create or replace function onboarding_status()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'fiscal', exists (
      select 1 from tenant_branding
      where tenant_id = current_tenant_id() and coalesce(cuit, '') <> ''
    ),
    'mp', exists (
      select 1 from tenant_payment_methods
      where tenant_id = current_tenant_id() and provider_key = 'mercado_pago' and enabled
    ),
    'producto', exists (
      select 1 from products
      where tenant_id = current_tenant_id() and deleted_at is null
    ),
    'ticket', exists (
      select 1 from ticket_templates
      where tenant_id = current_tenant_id() and print_active and deleted_at is null
    ),
    'venta', exists (
      select 1 from sales where tenant_id = current_tenant_id()
    )
  );
$$;
revoke all on function onboarding_status() from public, anon;
grant execute on function onboarding_status() to authenticated;
