-- =============================================================================
-- 20260608300000_subscription_billing_mp
--   Soporte de cobro REAL de la suscripción a NinjaSoft vía Mercado Pago
--   (preapproval) cuando el monto = plan + addons activos, y self-service del
--   dueño (checkout / cambio de medio de pago). Esta migración es la capa SQL;
--   las llamadas a la API de MP viven en Edge Functions
--   (mp_subscription_checkout, mp_update_subscription_amount, mp_subscription_manage).
--
-- Contexto / fuente de verdad:
--   • subscriptions.mp_preapproval_id YA existe (se guarda al crear el preapproval).
--   • subscription_addons es la fuente de verdad de "qué se cobra" (monthly_price_ars
--     + ventana current_period_end + cancel_at_period_end). Antes el preapproval
--     cobraba SOLO el plan; ahora el monto del preapproval debe REFLEJAR
--     plan + addons facturables.
--
-- Qué agrega:
--   A) subscription_billing_total(p_tenant) — calcula, para un tenant, el monto a
--      cobrar en el preapproval: precio del plan (según billing_cycle) + addons
--      facturables (status='active' OR dentro de la ventana cancel_at_period_end,
--      espejando ai_available()). Es SECURITY DEFINER e INTERNAL/edge-only (la
--      usan las Edge Functions con service_role y el RPC owner de abajo). Devuelve
--      jsonb con desglose para que el panel pueda mostrar "plan + addon = total".
--   B) owner_billing_summary() — RPC owner-gated: el dueño obtiene su
--      mp_preapproval_id, el total calculado y el desglose, para decidir en la UI
--      entre "Pagar y activar" (sin preapproval) vs "Actualizar medio de pago"
--      (con preapproval). No expone secretos.
--
-- NOTA DE DISEÑO (operatoria MP, verificada contra la doc de PreApproval):
--   • Actualizar el monto en vivo: PUT https://api.mercadopago.com/preapproval/{id}
--     con auto_recurring.transaction_amount. MP permite el update del monto sin
--     recrear el preapproval → NO hace falta cancelar/recrear (sin doble cobro).
--   • Cambiar el medio de pago: se redirige al pagador al init_point del propio
--     preapproval (https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=ID),
--     donde MP le permite actualizar/autorizar su tarjeta. No se recrea nada.
--   • El estado del medio (status, payment_method_id) se obtiene de
--     GET /preapproval/{id}. MP NO expone los últimos 4 dígitos en el preapproval
--     (solo card_id / payment_method_id), así que el panel muestra estado + marca.
--   Estas operaciones viven en Edge Functions (no se puede/ni conviene llamar a MP
--   desde Postgres). Acá sólo se calcula el monto canónico y se expone al dueño.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) subscription_billing_total — monto canónico del preapproval de un tenant.
--    plan (monthly/yearly) + addons facturables. Para un ciclo anual, los addons
--    (que tienen precio MENSUAL en la data) se cobran x12 para alinear con la
--    frecuencia del preapproval (frequency = 12 months). Devuelve también el
--    desglose. SECURITY DEFINER porque lee subscriptions/subscription_addons/plans
--    saltando RLS (la usan edge fns y el RPC owner controlado de abajo).
-- -----------------------------------------------------------------------------
create or replace function subscription_billing_total(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_cycle text;
  v_yearly boolean;
  v_plan_amount numeric;
  v_addons_monthly numeric;
  v_addons_amount numeric;
  v_total numeric;
begin
  if p_tenant is null then
    return null;
  end if;

  select s.billing_cycle,
         case when s.billing_cycle = 'yearly'
              then coalesce(p.yearly_price_ars, p.monthly_price_ars * 12)
              else p.monthly_price_ars end
    into v_cycle, v_plan_amount
    from subscriptions s
    join plans p on p.id = s.plan_id
   where s.tenant_id = p_tenant;

  if v_cycle is null then
    return null;  -- sin suscripción
  end if;
  v_yearly := (v_cycle = 'yearly');
  v_plan_amount := coalesce(v_plan_amount, 0);

  -- Addons FACTURABLES: activos, o cancelados pero todavía dentro de su ventana
  -- pagada (mismo criterio que ai_available / el panel). Precio mensual de cada
  -- addon (subscription_addons.monthly_price_ars; fallback al catálogo).
  select coalesce(sum(coalesce(sa.monthly_price_ars, pa.monthly_price_ars, 0)), 0)
    into v_addons_monthly
    from subscription_addons sa
    left join plan_addons pa on pa.key = sa.addon_key
   where sa.tenant_id = p_tenant
     and (
       sa.status = 'active'
       or (sa.cancel_at_period_end
           and sa.current_period_end is not null
           and sa.current_period_end >= current_date)
     );

  v_addons_monthly := coalesce(v_addons_monthly, 0);
  -- Alinear el addon a la frecuencia del preapproval (anual = x12).
  v_addons_amount := case when v_yearly then v_addons_monthly * 12 else v_addons_monthly end;
  v_total := v_plan_amount + v_addons_amount;

  return jsonb_build_object(
    'tenant_id', p_tenant,
    'billing_cycle', v_cycle,
    'currency', 'ARS',
    'plan_amount', v_plan_amount,
    'addons_amount', v_addons_amount,
    'addons_monthly', v_addons_monthly,
    'total', v_total
  );
end;
$fn$;

revoke all on function subscription_billing_total(uuid) from public, anon, authenticated;
-- Solo la usa el rol de servicio (edge fns) y el RPC owner_billing_summary
-- (security definer) de abajo. No se otorga a authenticated directamente.

-- -----------------------------------------------------------------------------
-- B) owner_billing_summary — el dueño consulta su estado de cobro de suscripción.
--    Devuelve el preapproval id (para saber si ya hay suscripción MP creada), el
--    total calculado y el desglose. Owner-gated. No expone access tokens.
-- -----------------------------------------------------------------------------
create or replace function owner_billing_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tid uuid := current_tenant_id();
  v_pre text;
  v_status text;
  v_breakdown jsonb;
begin
  if v_tid is null or not is_tenant_owner() then
    return null;
  end if;

  select s.mp_preapproval_id, s.status
    into v_pre, v_status
    from subscriptions s
   where s.tenant_id = v_tid;

  v_breakdown := subscription_billing_total(v_tid);

  return jsonb_build_object(
    'has_preapproval', (v_pre is not null and btrim(v_pre) <> ''),
    'preapproval_id', v_pre,
    'subscription_status', v_status,
    'billing', v_breakdown
  );
end;
$fn$;

revoke all on function owner_billing_summary() from public, anon;
grant execute on function owner_billing_summary() to authenticated;
