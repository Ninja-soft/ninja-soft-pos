-- =============================================================================
-- 20260530120000_extensions_and_helpers
-- Hito 0 — Fundación técnica.
-- Extensiones base + funciones helper usadas por RLS, timestamps y auditoría.
-- Fuente de verdad multi-tenant: docs/08-multi-tenant.md (app_metadata.current_tenant_id).
-- =============================================================================

-- pgcrypto provee gen_random_uuid() (Postgres 13+ ya lo trae en core, pero lo
-- dejamos explícito para portabilidad).
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- current_tenant_id()
-- Extrae el tenant activo del JWT. Toda policy de RLS la usa.
-- Anónimo o sin tenant => null => las policies `= current_tenant_id()` no
-- matchean nunca (bloqueo total). Ver docs/08-multi-tenant.md §3.
-- -----------------------------------------------------------------------------
create or replace function current_tenant_id()
returns uuid
language sql
stable
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'current_tenant_id')::uuid,
    null
  );
$$;

-- -----------------------------------------------------------------------------
-- is_internal()
-- True si el usuario del JWT es staff NinjaSoft. Usado por tablas globales.
-- -----------------------------------------------------------------------------
create or replace function is_internal()
returns boolean
language sql
stable
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'is_internal')::boolean,
    false
  );
$$;

-- -----------------------------------------------------------------------------
-- set_updated_at()
-- Trigger genérico: mantiene updated_at en cada UPDATE.
-- -----------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- write_audit_log()
-- Trigger genérico de auditoría sobre tablas críticas. Escribe en audit_logs
-- (creada en migración 20260530120300). El cuerpo plpgsql no se valida contra
-- la tabla en tiempo de creación, por eso puede definirse antes que audit_logs.
-- -----------------------------------------------------------------------------
create or replace function write_audit_log()
returns trigger
language plpgsql
as $$
begin
  insert into audit_logs (
    tenant_id, actor_user_id, entity_type, entity_id, action,
    before_data, after_data
  )
  values (
    coalesce(new.tenant_id, old.tenant_id),
    (auth.jwt() ->> 'sub')::uuid,
    tg_table_name,
    coalesce(new.id, old.id),
    tg_op,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;
