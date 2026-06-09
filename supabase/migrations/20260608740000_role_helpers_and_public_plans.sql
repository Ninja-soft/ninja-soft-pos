-- =============================================================================
-- 20260608740000_role_helpers_and_public_plans  (DRIFT FIX — versionar helpers)
--
-- is_tenant_owner(), is_tenant_manager() y public_plans() existían en el remoto
-- pero NINGÚN archivo de migración las creaba: se aplicaron por execute_sql
-- durante el panel del dueño (20260608270000+) sin versionar. Un db:reset / un
-- checkout limpio de CI NO las tendría -> 13+ RPCs (que las llaman en cuerpos
-- plpgsql, resolución lazy) y el frontend (public_plans en SubscriptionCard /
-- PlanCards) fallarían en runtime. Esta migración las versiona con la definición
-- EXACTA del remoto (create or replace idempotente). Detectado por la auditoría
-- de push-readiness. Cumple la regla #4 (migraciones versionadas, CLAUDE.md).
--
-- Orden tardío seguro: estas funciones SOLO se usan en cuerpos plpgsql (lazy) y
-- desde el front (runtime) — NUNCA en DDL eager (policies/checks/SQL functions),
-- así que su definición posterior al primer uso no rompe db:reset. Sus deps
-- (tenant_users, current_tenant_id(), auth.uid(), plans) existen desde mucho antes.
-- =============================================================================

create or replace function public.is_tenant_owner()
  returns boolean
  language sql
  stable security definer
  set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from tenant_users tu
     where tu.tenant_id = current_tenant_id()
       and tu.user_id = auth.uid()
       and tu.status = 'active'
       and tu.role = 'owner'
  );
$function$;

create or replace function public.is_tenant_manager()
  returns boolean
  language sql
  stable security definer
  set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from tenant_users tu
     where tu.tenant_id = current_tenant_id()
       and tu.user_id = auth.uid()
       and tu.status = 'active'
       and tu.role in ('owner', 'manager')
  );
$function$;

create or replace function public.public_plans()
  returns jsonb
  language sql
  stable security definer
  set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', p.key,
        'name', p.name,
        'secondary_name', p.secondary_name,
        'description', p.description,
        'image_url', p.image_url,
        'icon', p.icon,
        'monthly_price_ars', p.monthly_price_ars,
        'trial_days', coalesce(p.trial_days, 0),
        'is_recommended', coalesce(p.is_recommended, false),
        'sort', coalesce(p.sort, 0),
        'modules', coalesce(p.limits -> 'modules', '{}'::jsonb),
        'limits', coalesce(p.limits -> 'limits', '{}'::jsonb)
      )
      order by coalesce(p.sort, 0), p.monthly_price_ars
    ),
    '[]'::jsonb
  )
  from plans p
  where p.tenant_id is null and p.is_active;
$function$;
