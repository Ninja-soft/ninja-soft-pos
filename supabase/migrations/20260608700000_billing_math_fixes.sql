-- =============================================================================
-- 20260608700000_billing_math_fixes  (SaaS / billing — matemática de facturación)
--
-- Tres correcciones de cálculo de cobro. Todas en este archivo para versionarlas
-- juntas. NO toca edge functions, create_sale, webhooks ni frontend.
--
--  BUG 9  (🔴) — Plan ANUAL factura $0 de plan.
--         subscription_billing_total usaba coalesce(p.yearly_price_ars,
--         p.monthly_price_ars*12). Los planes tienen yearly_price_ars = 0.00 (NO
--         null) → coalesce devuelve 0 → preapproval anual con plan gratis. Hoy
--         latente (nada setea billing_cycle='yearly') pero el cálculo está roto y
--         los planes custom lo heredan. FIX: nullif(yearly,0) antes del coalesce,
--         de modo que un yearly 0 caiga al fallback monthly*12. El cálculo MENSUAL
--         es idéntico (no pasa por esa rama). El resto de la función reproduce la
--         viva (20260608660000): granted suma 0, ventana cancel_at_period_end,
--         x12 anual del addon, desglose.
--
--  BUG 10 (🔴) — Catálogo del addon IA = $0 ≠ precio real $15.000.
--         plan_addons.ai_assistant.monthly_price_ars = 0.00 mientras el precio
--         real (UI / platform_secrets['ai_config'].addon_price_ars) es 15000. El
--         billing total usa coalesce(sa.monthly_price_ars, pa.monthly_price_ars,
--         0): si un addon 'purchased' quedara con sa.monthly_price_ars null, se
--         cobraría $0 (under-charge). FIX: alinear el catálogo al precio real.
--         UPDATE de datos (idempotente). Es el único addon de la tabla. No afecta
--         a los 'granted' (facturan 0 por el case source='granted' ya existente).
--
--  BUG 11 (🟠) — internal_set_addon convertía un addon PAGO en bonificado sin
--         querer. on conflict do update set source='granted' a ciegas: un row
--         'purchased' (cliente pagando) dejaba de facturarse y quedaba 'granted'
--         con monthly_price_ars viejo (estado sucio). FIX (mismas firmas):
--           (a) internal_set_addon (toggle staff): al ACTIVAR no pisa un
--               'purchased' existente → preserva su source y su precio (no
--               degrada un addon de pago a gratis). Si crea/queda 'granted',
--               monthly_price_ars = NULL (nunca granted+precio).
--           (b) internal_grant_addon (grant explícito): la intención ES bonificar,
--               así que sí fuerza source='granted', pero SIEMPRE con
--               monthly_price_ars = NULL (evita el estado granted+precio que
--               subscription_billing_total ignora hoy pero ensucia los datos).
--         Consistente con activate_addon (20260608660000), que ya nunca deja un
--         'granted' con precio.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- BUG 9 — subscription_billing_total: yearly 0 (no null) cae a monthly*12.
--   Único cambio funcional vs 20260608660000: nullif(p.yearly_price_ars, 0) en la
--   rama anual. Todo lo demás (mensual, granted=0, ventana, x12, salida) idéntico.
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

  -- BUG 9 — yearly_price_ars = 0 (no null) NO debe facturar $0 de plan. nullif
  -- lo trata como "sin precio anual" y cae al fallback mensual * 12.
  select s.billing_cycle,
         case when s.billing_cycle = 'yearly'
              then coalesce(nullif(p.yearly_price_ars, 0), p.monthly_price_ars * 12)
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
  -- addon (subscription_addons.monthly_price_ars; fallback al catálogo). Los
  -- BONIFICADOS (source='granted') suman 0: la UI los muestra "Bonificado por
  -- NinjaSoft" y NO se facturan (consistencia con SubscriptionCard.aiComped).
  select coalesce(sum(
           case when sa.source = 'granted'
                then 0
                else coalesce(sa.monthly_price_ars, pa.monthly_price_ars, 0)
           end), 0)
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

-- -----------------------------------------------------------------------------
-- BUG 10 — Precio de catálogo del addon IA = precio real (15000).
--   El precio que se le muestra/cobra al dueño vive en
--   platform_secrets['ai_config'].addon_price_ars (= 15000). Alineamos el catálogo
--   para que el fallback coalesce(sa.monthly_price_ars, pa.monthly_price_ars, 0)
--   sea correcto si un addon 'purchased' quedara sin precio en la fila. Idempotente.
-- -----------------------------------------------------------------------------
update plan_addons
   set monthly_price_ars = 15000
 where key = 'ai_assistant'
   and coalesce(monthly_price_ars, 0) <> 15000;

-- -----------------------------------------------------------------------------
-- BUG 11(a) — internal_set_addon: no degradar un addon de pago a bonificado.
--   Toggle staff (activar/desactivar). Al ACTIVAR, si la fila ya existe como
--   'purchased' (cliente pagando), se PRESERVA su source y su monthly_price_ars
--   (no se la convierte a 'granted' ni se pierde el precio). Si se crea nueva, o
--   la fila ya era 'granted', queda 'granted' con monthly_price_ars = NULL (nunca
--   granted + precio). Al DESACTIVAR solo cambia el status (no toca source/precio,
--   para no ensuciar el estado del addon). Misma firma.
-- -----------------------------------------------------------------------------
create or replace function internal_set_addon(p_tenant_id uuid, p_addon_key text, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_status text;
  v_active boolean := coalesce(p_active, false);
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_tenant_id is null then
    raise exception 'invalid_tenant';
  end if;
  if coalesce(btrim(p_addon_key), '') = '' then
    raise exception 'invalid_addon';
  end if;

  v_status := case when v_active then 'active' else 'cancelled' end;

  insert into subscription_addons (tenant_id, addon_key, status, source, monthly_price_ars)
  values (p_tenant_id, p_addon_key, v_status, 'granted', null)
  on conflict (tenant_id, addon_key)
    do update set
      status = excluded.status,
      -- No pisar un 'purchased' (de pago) a ciegas: solo el row existente decide.
      -- granted ⇒ se mantiene granted; purchased ⇒ se mantiene purchased.
      source = subscription_addons.source,
      -- granted no debe quedar con precio (estado sucio); purchased conserva el suyo.
      monthly_price_ars = case when subscription_addons.source = 'granted'
                               then null
                               else subscription_addons.monthly_price_ars end;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'subscription_addons', p_tenant_id, 'addon_set',
          jsonb_build_object('addon', p_addon_key, 'status', v_status));
end;
$fn$;

revoke all on function internal_set_addon(uuid, text, boolean) from public, anon;
grant execute on function internal_set_addon(uuid, text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- BUG 11(b) — internal_grant_addon: bonificación EXPLÍCITA, siempre sin precio.
--   Acá la intención es bonificar (grant interno), así que sí se fuerza
--   source='granted'. Pero nunca debe quedar granted + precio: monthly_price_ars
--   = NULL en el conflicto. Misma firma y demás efectos (audit) idénticos.
-- -----------------------------------------------------------------------------
create or replace function internal_grant_addon(p_tenant uuid, p_addon_key text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id  uuid;
  v_key text := btrim(p_addon_key);
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_tenant is null then
    raise exception 'invalid_tenant';
  end if;
  if coalesce(v_key, '') = '' then
    raise exception 'invalid_addon';
  end if;

  insert into subscription_addons (tenant_id, addon_key, status, source, monthly_price_ars)
  values (p_tenant, v_key, 'active', 'granted', null)
  on conflict (tenant_id, addon_key) do update
    set status               = 'active',
        source               = 'granted',
        -- Bonificado ⇒ sin precio (no dejar granted + monthly_price_ars viejo).
        monthly_price_ars    = null,
        cancel_at_period_end  = false,
        current_period_end    = null
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, auth.uid(), 'subscription_addons', v_id, 'addon_granted',
          jsonb_build_object('addon', v_key, 'source', 'granted', 'status', 'active'));

  return v_id;
end;
$fn$;

revoke all on function internal_grant_addon(uuid, text) from public, anon;
grant execute on function internal_grant_addon(uuid, text) to authenticated;
