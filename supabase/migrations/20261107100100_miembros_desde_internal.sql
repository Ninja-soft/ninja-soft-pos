-- =============================================================================
-- 20261107100100_miembros_desde_internal  (F7 · H11c · ADR-084)
--
-- Gestión de los miembros de un negocio desde el panel interno, con motivo y
-- auditoría. Complementa a la Edge internal_tenant_members (invitar, reenviar
-- la invitación y mandar el email de recupero), que usa service_role porque
-- necesita la API de administración de Auth.
--
--   A) internal_tenant_members(tenant): lista de miembros con estado de la
--      cuenta (invitación pendiente, último ingreso). Cualquier nivel de staff,
--      sólo bajo internal_scope() (ADR-052).
--   B) internal_member_admin(tenant, user, action, role, reason):
--        · set_role     : cambia el rol. Tocar el rol de dueño (dar o quitar)
--                         es sólo super_admin. El negocio nunca queda sin un
--                         dueño activo.
--        · suspend      : membresía suspendida + corta sesiones y negocio
--                         activo (staff_revoke_access, ADR-051).
--        · reactivate   : vuelve a activo (+ staff_grant_access). Una baja de
--                         personal (inactive) vuelve por Reingreso del dueño,
--                         no desde acá.
--        · reset_access : corta todas las sesiones de la cuenta (el email de
--                         recupero lo manda la Edge). Soporte puede (matriz H11).
--      Motivo obligatorio (5 a 500). Nadie se toca a sí mismo. Audita en
--      audit_logs con antes, después y motivo en la misma transacción.
--
--   No hay tablas nuevas ni políticas: tenant_users ya tiene su RLS y todo
--   pasa por RPC SECURITY DEFINER con search_path fijo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Lista de miembros para el panel interno
-- -----------------------------------------------------------------------------
create or replace function internal_tenant_members(p_tenant uuid)
returns table (
  user_id            uuid,
  email              text,
  full_name          text,
  display_name       text,
  role               text,
  status             text,
  invited_at         timestamptz,
  joined_at          timestamptz,
  created_at         timestamptz,
  last_sign_in_at    timestamptz,
  email_confirmed_at timestamptz,
  is_staff           boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select tu.user_id,
         u.email::text,
         u.full_name::text,
         tu.display_name::text,
         tu.role::text,
         tu.status::text,
         tu.invited_at,
         tu.joined_at,
         tu.created_at,
         au.last_sign_in_at,
         au.email_confirmed_at,
         (u.internal_level is not null)
    from tenant_users tu
    join public.users u on u.id = tu.user_id
    left join auth.users au on au.id = tu.user_id
   where tu.tenant_id = p_tenant
   order by case tu.role when 'owner' then 0 when 'manager' then 1 when 'cashier' then 2 else 3 end,
            tu.created_at;
end;
$$;

revoke all on function internal_tenant_members(uuid) from public, anon;
grant execute on function internal_tenant_members(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Acciones sobre un miembro
-- -----------------------------------------------------------------------------
create or replace function internal_member_admin(
  p_tenant uuid,
  p_user   uuid,
  p_action text,
  p_role   text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_level   text := coalesce(internal_level(), 'admin');
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_m       tenant_users%rowtype;
  v_owners  integer;
  v_after   jsonb;
  v_audit   text;
begin
  if not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_action not in ('set_role', 'suspend', 'reactivate', 'reset_access') then
    raise exception 'invalid_action';
  end if;
  if p_action <> 'reset_access' and v_level = 'support' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(v_reason) < 5 then
    raise exception 'reason_required';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'reason_too_long';
  end if;
  if p_user = auth.uid() then
    raise exception 'cannot_change_self';
  end if;

  select * into v_m
    from tenant_users
   where tenant_id = p_tenant and user_id = p_user
   for update;
  if not found then
    raise exception 'member_not_found';
  end if;

  -- Dueños activos que quedarían sin contar a este miembro.
  select count(*) into v_owners
    from tenant_users
   where tenant_id = p_tenant and role = 'owner' and status = 'active'
     and user_id <> p_user;

  if p_action = 'set_role' then
    if p_role is null or p_role not in ('owner', 'manager', 'cashier', 'viewer') then
      raise exception 'invalid_role';
    end if;
    if p_role = v_m.role then
      raise exception 'nothing_to_update';
    end if;
    if (p_role = 'owner' or v_m.role = 'owner') and v_level <> 'super_admin' then
      raise exception 'forbidden_super_admin_only' using errcode = '42501';
    end if;
    if v_m.role = 'owner' and v_m.status = 'active' and v_owners = 0 then
      raise exception 'last_owner';
    end if;
    update tenant_users set role = p_role, updated_at = now()
     where id = v_m.id;
    v_after := jsonb_build_object('role', p_role);
    v_audit := 'member_role_changed_internal';

  elsif p_action = 'suspend' then
    if v_m.status not in ('active', 'invited') then
      raise exception 'invalid_transition';
    end if;
    if v_m.role = 'owner' and v_owners = 0 then
      raise exception 'last_owner';
    end if;
    update tenant_users set status = 'suspended', updated_at = now()
     where id = v_m.id;
    perform staff_revoke_access(p_tenant, p_user);
    v_after := jsonb_build_object('status', 'suspended');
    v_audit := 'member_suspended_internal';

  elsif p_action = 'reactivate' then
    if v_m.status = 'inactive' then
      raise exception 'member_terminated';
    end if;
    if v_m.status <> 'suspended' then
      raise exception 'invalid_transition';
    end if;
    update tenant_users set status = 'active', updated_at = now()
     where id = v_m.id;
    perform staff_grant_access(p_tenant, p_user);
    v_after := jsonb_build_object('status', 'active');
    v_audit := 'member_reactivated_internal';

  else
    -- reset_access: corta las sesiones abiertas de la cuenta. El email de
    -- recupero lo envía la Edge internal_tenant_members después de esto.
    begin
      delete from auth.sessions where user_id = p_user;
    exception when others then
      raise warning 'internal_member_admin reset_access: %', sqlerrm;
    end;
    v_after := jsonb_build_object('sessions_revoked', true);
    v_audit := 'member_access_reset_internal';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id,
                          action, before_data, after_data, reason)
  values (p_tenant, auth.uid(), 'tenant_users', p_user, v_audit,
          jsonb_build_object('role', v_m.role, 'status', v_m.status),
          v_after, v_reason);

  return v_after;
end;
$$;

revoke all on function internal_member_admin(uuid, uuid, text, text, text) from public, anon;
grant execute on function internal_member_admin(uuid, uuid, text, text, text) to authenticated;

comment on function internal_member_admin(uuid, uuid, text, text, text) is
  'Panel interno (ADR-084): cambiar rol, suspender, reactivar o cortar sesiones de un miembro del negocio. Motivo obligatorio, auditado.';
