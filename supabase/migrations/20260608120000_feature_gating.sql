-- tenant_has_feature: resolución de acceso a una funcionalidad para el tenant
-- actual. Orden: override por tenant (tenant_feature_flags) → addon activo
-- (subscription_addons) → módulo del plan (plans.limits->modules) → básica
-- (features.is_basic). SECURITY DEFINER con scope al tenant del JWT.
--
-- Semántica del coalesce (importante): coalesce SÓLO saltea NULLs. El módulo del
-- plan `(p.limits->'modules'->>p_key)::boolean` es NULL cuando la key NO está
-- presente en el mapa modules → cae al fallback de básica. Pero si el plan
-- declara la key explícitamente en FALSE, devuelve `false` (no NULL) y corta la
-- cadena: el plan bloquea la función aunque sea básica. Presente=respeta plan;
-- ausente=fallback a is_basic. Esto es intencional.
create or replace function tenant_has_feature(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with t as (select current_tenant_id() as tid)
  select coalesce(
    (select tff.enabled from tenant_feature_flags tff
       join feature_flags ff on ff.id = tff.feature_flag_id
       join t on t.tid = tff.tenant_id
      where ff.key = p_key limit 1),
    (select true from subscription_addons sa join t on t.tid = sa.tenant_id
      where sa.addon_key = p_key and sa.status = 'active' limit 1),
    (select (p.limits -> 'modules' ->> p_key)::boolean
       from subscriptions s join plans p on p.id = s.plan_id
       join t on t.tid = s.tenant_id limit 1),
    (select is_basic from features where key = p_key),
    false
  );
$$;
revoke all on function tenant_has_feature(text) from public, anon;
grant execute on function tenant_has_feature(text) to authenticated;

-- tenant_limit: límite numérico efectivo (override H12b ?? plan). null = ilimitado.
create or replace function tenant_limit(p_key text)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with t as (select current_tenant_id() as tid)
  select coalesce(
    (select (s.limit_overrides ->> p_key)::numeric from subscriptions s
       join t on t.tid = s.tenant_id limit 1),
    (select (p.limits -> 'limits' ->> p_key)::numeric
       from subscriptions s join plans p on p.id = s.plan_id
       join t on t.tid = s.tenant_id limit 1)
  );
$$;
revoke all on function tenant_limit(text) from public, anon;
grant execute on function tenant_limit(text) to authenticated;

-- gating_summary: todo junto para la UI (un solo round-trip).
create or replace function gating_summary()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'features', (select coalesce(jsonb_object_agg(f.key, tenant_has_feature(f.key)), '{}'::jsonb) from features f),
    'limits', jsonb_build_object(
      'max_stores', tenant_limit('max_stores'),
      'max_users', tenant_limit('max_users'),
      'max_products', tenant_limit('max_products'),
      'max_sales_per_month', tenant_limit('max_sales_per_month')
    ),
    'plan', (select jsonb_build_object('key', p.key, 'name', p.name)
               from subscriptions s join plans p on p.id = s.plan_id
              where s.tenant_id = current_tenant_id() limit 1)
  );
$$;
revoke all on function gating_summary() from public, anon;
grant execute on function gating_summary() to authenticated;
