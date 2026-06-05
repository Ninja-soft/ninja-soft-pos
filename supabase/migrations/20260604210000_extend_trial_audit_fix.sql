-- =============================================================================
-- 20260604210000_extend_trial_audit_fix
-- Fix: internal_extend_trial llamaba write_audit_log(5 args) — esa función es
-- una trigger function sin argumentos y la llamada fallaba en runtime.
-- Se reemplaza por insert directo a audit_logs (patrón de internal_set_plan)
-- y se agrega el guard de nivel: 'support' no puede extender trials.
-- =============================================================================

create or replace function internal_extend_trial(
  p_tenant_id uuid,
  p_days      int
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new_end timestamptz;
begin
  if not is_internal() or coalesce(internal_level(),'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_days < 0 or p_days > 365 then raise exception 'invalid_days'; end if;

  update tenants
     set trial_ends_at = greatest(coalesce(trial_ends_at, now()), now())
                         + (p_days || ' days')::interval,
         updated_at    = now()
   where id = p_tenant_id
  returning trial_ends_at into v_new_end;

  if v_new_end is null then raise exception 'tenant_not_found'; end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'tenants', p_tenant_id, 'trial_extended',
          jsonb_build_object('days', p_days, 'new_end', v_new_end));

  return v_new_end;
end;
$$;
revoke execute on function internal_extend_trial(uuid, int) from public, anon;
grant  execute on function internal_extend_trial(uuid, int) to authenticated;
