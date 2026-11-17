-- =============================================================================
-- SEC-14 · Helpers con p_tenant legibles cross-tenant por authenticated
-- =============================================================================
-- Ocho helpers SECURITY DEFINER reciben p_tenant sin validar membresía y eran
-- ejecutables por authenticated: un usuario podía leer el plan, los límites,
-- la política de PIN o la sucursal por defecto de OTRO negocio.
--
-- 1. Seis no tienen llamadores con el rol del usuario (ni policies, ni
--    funciones INVOKER, ni el front): se revocan.
-- 2. tenant_has_feature_for la evalúan 10 policies y 4 funciones INVOKER
--    (incluido un trigger), y stock_default_store 2 funciones INVOKER; además
--    las usan las RPC públicas del catálogo (que un visitante logueado de otro
--    negocio llama con su sesión). Quedan ejecutables y el guard SÓLO actúa en
--    la llamada directa por la API (`/rpc/<helper>`, PostgREST lo informa en
--    request.path): un usuario pidiendo por un negocio que no es el suyo y sin
--    ser staff interno recibe false / null. Policies, funciones del panel, RPC
--    públicas, Edges (service_role) y cron no cambian, y las policies no pagan
--    el costo de current_tenant_id() por fila.
-- =============================================================================

revoke execute on function public.tenant_limit_for(uuid, text) from public, anon, authenticated;
revoke execute on function public.pin_action_modes(uuid, text) from public, anon, authenticated;
revoke execute on function public.pin_action_required(uuid, text, numeric) from public, anon, authenticated;
revoke execute on function public.price_pro_enabled(uuid) from public, anon, authenticated;
revoke execute on function public.stock_store_count(uuid) from public, anon, authenticated;
revoke execute on function public.subscription_blocked(uuid) from public, anon, authenticated;

create or replace function public.tenant_has_feature_for(p_tenant uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when coalesce(auth.role(), '') = 'authenticated'
         and coalesce(current_setting('request.path', true), '') like '%/rpc/tenant_has_feature_for'
         and p_tenant is distinct from current_tenant_id()
         and not coalesce(is_internal(), false)
      then false
    else coalesce(
      (select tff.enabled from tenant_feature_flags tff
         join feature_flags ff on ff.id = tff.feature_flag_id
        where tff.tenant_id = p_tenant
          and ff.key = any (feature_addon_keys(p_key))
        limit 1),
      (select true from subscription_addons sa
        where sa.tenant_id = p_tenant
          and sa.addon_key = any (feature_addon_keys(p_key))
          and platform_addon_usable(sa.status, sa.cancel_at_period_end, sa.current_period_end,
                                    platform_ar_date(now()))
        limit 1),
      (select (p.limits -> 'modules' ->> p_key)::boolean
         from subscriptions s join plans p on p.id = s.plan_id
        where s.tenant_id = p_tenant limit 1),
      (select is_basic from features where key = p_key),
      false
    )
  end;
$$;

create or replace function public.stock_default_store(p_tenant uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id
    from stores s
   where s.tenant_id = p_tenant
     and s.deleted_at is null
     and not (coalesce(auth.role(), '') = 'authenticated'
              and coalesce(current_setting('request.path', true), '') like '%/rpc/stock_default_store'
              and p_tenant is distinct from current_tenant_id()
              and not coalesce(is_internal(), false))
   order by s.is_default desc, s.is_active desc, s.created_at
   limit 1;
$$;
