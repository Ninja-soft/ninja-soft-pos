-- =============================================================================
-- 20260530200000_fn_internal_admin
-- Hito 5 — operaciones del panel interno NinjaSoft. SECURITY DEFINER con guard
-- is_internal(): solo staff. Cada acción audita. Ver docs/01-mvp.md §4.1.8,
-- docs/16-subscription-model.md.
-- =============================================================================

-- Cambiar plan de un tenant.
create or replace function internal_set_plan(p_tenant_id uuid, p_plan_key text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan uuid;
begin
  if not is_internal() then raise exception 'forbidden'; end if;
  select id into v_plan from plans where key = p_plan_key and is_active;
  if v_plan is null then raise exception 'plan_not_found'; end if;

  update subscriptions set plan_id = v_plan, updated_at = now()
   where tenant_id = p_tenant_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'subscriptions', p_tenant_id, 'plan_changed',
          jsonb_build_object('plan', p_plan_key));
end;
$$;

-- Cambiar estado de suscripción (y reflejarlo en el tenant).
create or replace function internal_set_subscription_status(p_tenant_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not is_internal() then raise exception 'forbidden'; end if;
  if p_status not in ('trial','active','past_due','suspended','cancelled') then
    raise exception 'invalid_status';
  end if;

  update subscriptions set status = p_status, updated_at = now()
   where tenant_id = p_tenant_id;
  update tenants set status = p_status, updated_at = now()
   where id = p_tenant_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'subscriptions', p_tenant_id, 'status_changed',
          jsonb_build_object('status', p_status));
end;
$$;

-- Activar/desactivar un feature flag por tenant (upsert).
create or replace function internal_set_flag(
  p_tenant_id uuid,
  p_flag_key  text,
  p_enabled   boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_flag uuid;
begin
  if not is_internal() then raise exception 'forbidden'; end if;
  select id into v_flag from feature_flags where key = p_flag_key;
  if v_flag is null then raise exception 'flag_not_found'; end if;

  insert into tenant_feature_flags (tenant_id, feature_flag_id, enabled, configured_by, configured_at)
  values (p_tenant_id, v_flag, p_enabled, auth.uid(), now())
  on conflict (tenant_id, feature_flag_id)
  do update set enabled = excluded.enabled, configured_by = auth.uid(), configured_at = now();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'tenant_feature_flags', p_tenant_id, 'flag_changed',
          jsonb_build_object('flag', p_flag_key, 'enabled', p_enabled));
end;
$$;

revoke execute on function internal_set_plan(uuid, text) from anon;
revoke execute on function internal_set_subscription_status(uuid, text) from anon;
revoke execute on function internal_set_flag(uuid, text, boolean) from anon;
