-- =============================================================================
-- 20260605120000_trial_lifecycle  (H12 — lifecycle comercial del trial)
-- internal_set_trial_end: fija la fecha de fin del trial (acortar, terminar ya
--   o extender a fecha exacta), con motivo opcional, auditado con before/after.
-- internal_trial_outcome: desenlace del trial — convertir a pago ('converted'
--   → active) o marcar perdido ('lost' → cancelled), con motivo, auditado.
-- Guards: is_internal() y nivel != 'support' (mismo patrón que extend_trial).
-- =============================================================================

create or replace function internal_set_trial_end(
  p_tenant_id uuid,
  p_ends_at   timestamptz,
  p_reason    text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old timestamptz;
  v_new timestamptz;
begin
  if not is_internal() or coalesce(internal_level(),'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  -- Permite fechas pasadas (terminar el trial ya) pero no más de 1 año al futuro.
  if p_ends_at is null or p_ends_at > now() + interval '365 days' then
    raise exception 'invalid_date';
  end if;

  select trial_ends_at into v_old from tenants where id = p_tenant_id;
  if not found then raise exception 'tenant_not_found'; end if;

  update tenants
     set trial_ends_at = p_ends_at,
         updated_at    = now()
   where id = p_tenant_id
  returning trial_ends_at into v_new;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id,
                          action, before_data, after_data, reason)
  values (p_tenant_id, auth.uid(), 'tenants', p_tenant_id, 'trial_end_set',
          jsonb_build_object('trial_ends_at', v_old),
          jsonb_build_object('trial_ends_at', v_new),
          nullif(btrim(coalesce(p_reason, '')), ''));

  return v_new;
end;
$$;
revoke execute on function internal_set_trial_end(uuid, timestamptz, text) from public, anon;
grant  execute on function internal_set_trial_end(uuid, timestamptz, text) to authenticated;

create or replace function internal_trial_outcome(
  p_tenant_id uuid,
  p_outcome   text,
  p_reason    text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_old_sub text;
begin
  if not is_internal() or coalesce(internal_level(),'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_outcome not in ('converted','lost') then
    raise exception 'invalid_outcome';
  end if;

  v_status := case p_outcome when 'converted' then 'active' else 'cancelled' end;

  select status into v_old_sub from subscriptions where tenant_id = p_tenant_id;

  update subscriptions set status = v_status, updated_at = now()
   where tenant_id = p_tenant_id;

  update tenants
     set status        = v_status,
         -- El trial termina ahora (si seguía abierto).
         trial_ends_at = least(coalesce(trial_ends_at, now()), now()),
         updated_at    = now()
   where id = p_tenant_id;
  if not found then raise exception 'tenant_not_found'; end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id,
                          action, before_data, after_data, reason)
  values (p_tenant_id, auth.uid(), 'subscriptions', p_tenant_id,
          'trial_' || p_outcome,
          jsonb_build_object('status', v_old_sub),
          jsonb_build_object('status', v_status),
          nullif(btrim(coalesce(p_reason, '')), ''));
end;
$$;
revoke execute on function internal_trial_outcome(uuid, text, text) from public, anon;
grant  execute on function internal_trial_outcome(uuid, text, text) to authenticated;
