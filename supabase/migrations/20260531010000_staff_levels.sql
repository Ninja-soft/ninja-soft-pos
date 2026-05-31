-- =============================================================================
-- 20260531010000_staff_levels  (H11 — F7)
-- Staff NinjaSoft multinivel: support / admin / super_admin.
-- is_internal() (JWT app_metadata.is_internal) = acceso al panel.
-- internal_level() (JWT app_metadata.internal_level) = permisos graduales.
-- Interno legacy sin nivel se trata como 'admin'; solo 'support' es solo-lectura.
-- Aplicada vía Supabase MCP (staff_levels + staff_levels_backward_compat).
-- =============================================================================

alter table public.users
  add column if not exists internal_level text
  check (internal_level in ('support','admin','super_admin'));

create or replace function internal_level()
returns text language sql stable as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'internal_level', '');
$$;

-- Ops internas: requieren admin o super_admin (support solo-lectura). Legacy = admin.
create or replace function internal_set_plan(p_tenant_id uuid, p_plan_key text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_plan uuid;
begin
  if not is_internal() or coalesce(internal_level(),'admin') = 'support' then raise exception 'forbidden'; end if;
  select id into v_plan from plans where key = p_plan_key and is_active;
  if v_plan is null then raise exception 'plan_not_found'; end if;
  update subscriptions set plan_id = v_plan, updated_at = now() where tenant_id = p_tenant_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'subscriptions', p_tenant_id, 'plan_changed', jsonb_build_object('plan', p_plan_key));
end; $$;

create or replace function internal_set_subscription_status(p_tenant_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_internal() or coalesce(internal_level(),'admin') = 'support' then raise exception 'forbidden'; end if;
  if p_status not in ('trial','active','past_due','suspended','cancelled') then raise exception 'invalid_status'; end if;
  update subscriptions set status = p_status, updated_at = now() where tenant_id = p_tenant_id;
  update tenants set status = p_status, updated_at = now() where id = p_tenant_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'subscriptions', p_tenant_id, 'status_changed', jsonb_build_object('status', p_status));
end; $$;

create or replace function internal_set_flag(p_tenant_id uuid, p_flag_key text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_flag uuid;
begin
  if not is_internal() or coalesce(internal_level(),'admin') = 'support' then raise exception 'forbidden'; end if;
  select id into v_flag from feature_flags where key = p_flag_key;
  if v_flag is null then raise exception 'flag_not_found'; end if;
  insert into tenant_feature_flags (tenant_id, feature_flag_id, enabled, configured_by, configured_at)
  values (p_tenant_id, v_flag, p_enabled, auth.uid(), now())
  on conflict (tenant_id, feature_flag_id)
  do update set enabled = excluded.enabled, configured_by = auth.uid(), configured_at = now();
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'tenant_feature_flags', p_tenant_id, 'flag_changed', jsonb_build_object('flag', p_flag_key, 'enabled', p_enabled));
end; $$;

create or replace function internal_list_staff()
returns table (id uuid, email text, full_name text, internal_level text, created_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select u.id, u.email, u.full_name, u.internal_level, u.created_at
  from users u
  where u.internal_level is not null and is_internal()
  order by u.created_at;
$$;
revoke all on function internal_list_staff() from public, anon;
grant execute on function internal_list_staff() to authenticated;
