-- =============================================================================
-- 20260607160000_set_plan_tenant_guard  (H12 — fix)
-- internal_set_plan buscaba el plan solo por key: permitía asignarle a un
-- tenant el plan CUSTOM de otro. Ahora solo matchea planes globales o el
-- custom del propio tenant.
-- =============================================================================
create or replace function internal_set_plan(p_tenant_id uuid, p_plan_key text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan_id uuid;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;

  select id into v_plan_id from plans
   where key = p_plan_key and is_active
     and (tenant_id is null or tenant_id = p_tenant_id)
   limit 1;
  if v_plan_id is null then
    raise exception 'plan_not_found';
  end if;

  update subscriptions set plan_id = v_plan_id, updated_at = now()
   where tenant_id = p_tenant_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'subscriptions', p_tenant_id, 'plan_changed',
          jsonb_build_object('plan', p_plan_key));
end;
$$;
