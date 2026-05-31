-- =============================================================================
-- 20260531060000_tenant_industry_fns
-- Vertical/rubro del negocio. Permite cambiar tenants.industry:
--   * set_my_tenant_industry: el dueño/encargado del tenant activo (POS).
--   * internal_set_industry:   staff NinjaSoft sobre cualquier tenant (internal).
-- Ambas SECURITY DEFINER + audit. Ver CLAUDE.md §3, docs/01-mvp.md verticales.
-- =============================================================================

-- Validación compartida del valor de rubro.
create or replace function _assert_valid_industry(p_industry text)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_industry not in ('kiosco','textil','retail','restaurante','pyme','otro') then
    raise exception 'invalid_industry';
  end if;
end;
$$;

-- El dueño/encargado cambia el rubro de SU negocio (tenant activo del JWT).
create or replace function set_my_tenant_industry(p_industry text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  perform _assert_valid_industry(p_industry);

  if not exists (
    select 1 from tenant_users
     where tenant_id = v_tenant
       and user_id = auth.uid()
       and status = 'active'
       and role in ('owner','manager')
  ) then
    raise exception 'forbidden';
  end if;

  update tenants set industry = p_industry, updated_at = now()
   where id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'tenants', v_tenant, 'industry_changed',
          jsonb_build_object('industry', p_industry));
end;
$$;

-- Staff NinjaSoft cambia el rubro de cualquier tenant (override desde internal).
create or replace function internal_set_industry(p_tenant_id uuid, p_industry text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not is_internal() then raise exception 'forbidden'; end if;
  perform _assert_valid_industry(p_industry);

  update tenants set industry = p_industry, updated_at = now()
   where id = p_tenant_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'tenants', p_tenant_id, 'industry_changed',
          jsonb_build_object('industry', p_industry));
end;
$$;

revoke execute on function set_my_tenant_industry(text) from anon;
revoke execute on function internal_set_industry(uuid, text) from anon;
revoke execute on function _assert_valid_industry(text) from anon;
