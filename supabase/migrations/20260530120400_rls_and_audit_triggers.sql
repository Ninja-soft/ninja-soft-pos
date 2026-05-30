-- =============================================================================
-- 20260530120400_rls_and_audit_triggers
-- Hito 0 — habilita RLS y policies en todas las tablas base, y conecta los
-- triggers de auditoría. Ver docs/05-security.md §4, docs/08-multi-tenant.md §5-6.
--
-- Convención de escritura:
--   • Tablas globales del SaaS (tenants, plans, feature_flags, subscriptions,
--     tenant_feature_flags, system_settings, tenant_users) las ESCRIBE el
--     panel interno / Edge Functions vía service_role (bypassa RLS). Por eso
--     no se definen policies de INSERT/UPDATE para anon/authenticated: quedan
--     denegadas por defecto al activar RLS.
--   • users permite auto-edición de columnas seguras (grant a nivel columna).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- tenants — cada usuario ve solo los suyos (vía tenant_users); internal ve todo.
-- -----------------------------------------------------------------------------
alter table tenants enable row level security;

create policy tenants_select on tenants
  for select
  using (
    is_internal()
    or id in (
      select tenant_id from tenant_users
      where user_id = auth.uid() and status = 'active'
    )
  );

-- -----------------------------------------------------------------------------
-- users — cada usuario se ve solo a sí mismo; internal ve todos.
-- Hardening: solo se pueden auto-editar columnas seguras. email / is_internal
-- quedan fuera del grant => no se pueden cambiar vía PostgREST (anti escalada).
-- -----------------------------------------------------------------------------
alter table public.users enable row level security;

create policy users_select on public.users
  for select
  using (id = auth.uid() or is_internal());

create policy users_update_self on public.users
  for update
  using (id = auth.uid())
  with check (id = auth.uid());

revoke update on public.users from authenticated;
grant  update (full_name, avatar_url, locale) on public.users to authenticated;

-- -----------------------------------------------------------------------------
-- tenant_users — el usuario ve sus membresías y las del tenant activo.
-- -----------------------------------------------------------------------------
alter table tenant_users enable row level security;

create policy tenant_users_select on tenant_users
  for select
  using (
    user_id = auth.uid()
    or tenant_id = current_tenant_id()
    or is_internal()
  );

-- -----------------------------------------------------------------------------
-- plans — lectura pública (landing/pricing incluido).
-- -----------------------------------------------------------------------------
alter table plans enable row level security;

create policy plans_select on plans
  for select
  to anon, authenticated
  using (true);

-- -----------------------------------------------------------------------------
-- feature_flags — catálogo de lectura pública.
-- -----------------------------------------------------------------------------
alter table feature_flags enable row level security;

create policy feature_flags_select on feature_flags
  for select
  to anon, authenticated
  using (true);

-- -----------------------------------------------------------------------------
-- subscriptions — aisladas por tenant; internal ve todo.
-- -----------------------------------------------------------------------------
alter table subscriptions enable row level security;

create policy subscriptions_select on subscriptions
  for select
  using (tenant_id = current_tenant_id() or is_internal());

-- -----------------------------------------------------------------------------
-- tenant_feature_flags — aisladas por tenant; internal ve todo.
-- -----------------------------------------------------------------------------
alter table tenant_feature_flags enable row level security;

create policy tenant_feature_flags_select on tenant_feature_flags
  for select
  using (tenant_id = current_tenant_id() or is_internal());

-- -----------------------------------------------------------------------------
-- system_settings — solo internal.
-- -----------------------------------------------------------------------------
alter table system_settings enable row level security;

create policy system_settings_select on system_settings
  for select
  using (is_internal());

-- -----------------------------------------------------------------------------
-- audit_logs — append-only. Ver docs/08-multi-tenant.md §6.
-- -----------------------------------------------------------------------------
alter table audit_logs enable row level security;

create policy audit_logs_select on audit_logs
  for select
  using (tenant_id = current_tenant_id() or is_internal());

create policy audit_logs_insert on audit_logs
  for insert
  with check (tenant_id = current_tenant_id() or current_tenant_id() is null);

-- (sin policies de UPDATE/DELETE => denegadas para todos salvo service_role)

-- -----------------------------------------------------------------------------
-- Triggers de auditoría sobre tablas críticas que poseen tenant_id.
-- (users se audita aparte en un hito posterior: no tiene columna tenant_id y
--  la función genérica write_audit_log la requiere.)
-- -----------------------------------------------------------------------------
create trigger audit_tenant_users
  after insert or update or delete on tenant_users
  for each row execute function write_audit_log();

create trigger audit_subscriptions
  after insert or update or delete on subscriptions
  for each row execute function write_audit_log();

create trigger audit_tenant_feature_flags
  after insert or update or delete on tenant_feature_flags
  for each row execute function write_audit_log();
