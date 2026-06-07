-- =============================================================================
-- 20260608140000_ai_usage  (SAAS Fase F — Asistente IA)
--
-- A) ai_usage: bitácora de consumo de tokens del asistente IA por tenant.
--    Insert SOLO service_role (la Edge Function ai_assistant): sin policy de
--    insert → RLS bloquea a authenticated/anon. Lectura: miembro del propio
--    tenant o staff interno (para mostrar la cuota consumida).
-- B) ai_monthly_usage(): suma de tokens del mes corriente para el tenant actual
--    (display de cuota en la UI). SECURITY DEFINER scoped por current_tenant_id().
-- C) ai_available(): bool barato para mostrar/ocultar la burbuja del asistente.
--    true si el addon está activo (asistente_ia | ai_assistant), o flag por
--    tenant, o el owner del tenant es el beta_owner_email de la config IA.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) ai_usage.
-- -----------------------------------------------------------------------------
create table if not exists ai_usage (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  user_id    uuid references users(id),
  provider   text,
  tokens     int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_usage_tenant_created
  on ai_usage(tenant_id, created_at desc);

alter table ai_usage enable row level security;

-- Lectura: miembro del propio tenant o staff interno.
-- Sin policy de insert/update/delete → solo service_role escribe.
create policy ai_usage_select on ai_usage
  for select using (
    tenant_id = (select current_tenant_id()) or (select is_internal())
  );

-- -----------------------------------------------------------------------------
-- B) ai_monthly_usage(): tokens consumidos en el mes corriente por el tenant.
-- -----------------------------------------------------------------------------
create or replace function ai_monthly_usage()
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(au.tokens), 0)::int
    from ai_usage au
   where au.tenant_id = current_tenant_id()
     and au.created_at >= date_trunc('month', now());
$$;
revoke all on function ai_monthly_usage() from public, anon;
grant execute on function ai_monthly_usage() to authenticated;

-- -----------------------------------------------------------------------------
-- C) ai_available(): ¿se le muestra la burbuja del asistente al tenant actual?
--    addon activo (asistente_ia | ai_assistant)  OR  flag por tenant
--    (tenant_feature_flags asistente_ia/ai_assistant)  OR  el owner del tenant
--    == beta_owner_email de platform_secrets.ai_config. SECURITY DEFINER:
--    necesita leer platform_secrets (RLS deny a todos) — devuelve solo un bool,
--    nunca expone secretos.
-- -----------------------------------------------------------------------------
create or replace function ai_available()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with t as (select current_tenant_id() as tid)
  select coalesce(
    -- Addon activo (cualquiera de las dos claves: alineación catálogo/addon).
    (select true from subscription_addons sa join t on t.tid = sa.tenant_id
      where sa.addon_key in ('asistente_ia', 'ai_assistant')
        and sa.status = 'active' limit 1),
    -- Flag exclusivo por tenant.
    (select tff.enabled from tenant_feature_flags tff
       join feature_flags ff on ff.id = tff.feature_flag_id
       join t on t.tid = tff.tenant_id
      where ff.key in ('asistente_ia', 'ai_assistant') limit 1),
    -- Beta: el owner del tenant es el beta_owner_email configurado.
    (select true
       from t
       join tenant_users tu on tu.tenant_id = t.tid
        and tu.role = 'owner' and tu.status = 'active'
       join users u on u.id = tu.user_id
      where lower(u.email) = lower(nullif(
              (select secrets ->> 'beta_owner_email'
                 from platform_secrets where key = 'ai_config'), ''))
      limit 1),
    false
  );
$$;
revoke all on function ai_available() from public, anon;
grant execute on function ai_available() to authenticated;
