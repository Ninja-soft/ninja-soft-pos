-- =============================================================================
-- 20260608185000_onboarding_status_v3  (SAAS Wave 2-C — aplicada en remoto vía MCP)
-- Fix detección real de Mercado Pago en el onboarding.
--
-- Bug previo (v1/v2): el paso `mp` chequeaba
--   tenant_payment_methods.provider_key = 'mercado_pago' (con guión bajo) AND enabled
-- pero el flujo real de conexión (mp_oauth_callback / set_payment_secret) persiste
-- SIEMPRE con provider_key = 'mercadopago' (sin guión bajo) y guarda el token en
-- payment_secrets (RLS deny-all, ilegible con SECURITY INVOKER). Resultado: `mp`
-- daba false aunque el usuario tuviera Mercado Pago conectado.
--
-- Fix: onboarding_status() pasa a SECURITY DEFINER para poder leer payment_secrets,
-- y la señal real de "MP conectado" es:
--   existe payment_secrets para el tenant con provider 'mercadopago' y access_token
--   OR tenant_payment_methods 'mercadopago' enabled.
--
-- Scoping: sigue acotado a current_tenant_id() (auth.jwt() resuelve el JWT del
-- llamador aunque la función sea DEFINER). Si no hay tenant en contexto, devuelve
-- todo en false (nunca filtra datos de otro tenant).
-- =============================================================================
create or replace function onboarding_status()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with t as (select current_tenant_id() as tid)
  select jsonb_build_object(
    'fiscal', (select tid is not null and exists (
      select 1 from tenant_branding
      where tenant_id = t.tid and coalesce(cuit, '') <> ''
    ) from t),
    'mp', (select tid is not null and (
      exists (
        select 1 from payment_secrets
        where tenant_id = t.tid
          and provider_key = 'mercadopago'
          and coalesce(secrets->>'access_token', '') <> ''
      )
      or exists (
        select 1 from tenant_payment_methods
        where tenant_id = t.tid and provider_key = 'mercadopago' and enabled
      )
    ) from t),
    'producto', (select tid is not null and exists (
      select 1 from products
      where tenant_id = t.tid and deleted_at is null
    ) from t),
    'ticket', (select tid is not null and exists (
      select 1 from ticket_templates
      where tenant_id = t.tid and print_active and deleted_at is null
    ) from t),
    'venta', (select tid is not null and exists (
      select 1 from sales where tenant_id = t.tid
    ) from t)
  );
$$;

revoke all on function onboarding_status() from public, anon;
grant execute on function onboarding_status() to authenticated;
