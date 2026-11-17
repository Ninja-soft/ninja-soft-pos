-- =============================================================================
-- 20270122100000_sec23_internal_mfa  (SEC-23 · ADR-186)
--
-- MFA TOTP obligatorio para el staff interno, detrás de un flag global.
--
-- 1. Flag global `internal_mfa_required` en `system_settings` (config de
--    plataforma, sólo staff la lee y nadie la escribe por el Data API). Arranca
--    APAGADO: con el flag apagado nada cambia.
-- 2. `internal_mfa_required()`: lectura barata del flag (PK de system_settings,
--    SECURITY DEFINER para no pasar por la policy de system_settings, que a su
--    vez usa is_internal(): sin esto habría recursión).
-- 3. `is_internal()` (base de internal_scope(), de las policies de tablas de
--    plataforma y de las RPC internas) exige `aal = aal2` en el JWT cuando el
--    usuario es staff Y el flag está prendido. Para un usuario que no es staff
--    devuelve false sin leer el flag (mismo costo que antes); con el flag
--    apagado devuelve exactamente lo mismo que antes. Pasa a plpgsql para que
--    internal_mfa_required() sólo se ejecute para staff: así anon no necesita
--    EXECUTE sobre ella (en SQL la función se prepara entera y Postgres chequea
--    el permiso de cada función llamada aunque la rama no se use).
-- 4. `internal_mfa_reset(p_user_id, p_motivo)`: super_admin borra los factores
--    MFA de otro miembro del staff (perdió el teléfono), corta sus sesiones y
--    deja auditoría.
--
-- Prender el flag (SQL editor / service_role):
--   update public.system_settings set value = 'true'::jsonb, updated_at = now()
--    where key = 'internal_mfa_required';
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Flag global (apagado).
-- -----------------------------------------------------------------------------
insert into public.system_settings (key, value)
values ('internal_mfa_required', 'false'::jsonb)
on conflict (key) do nothing;

-- system_settings no tiene policies de escritura (sólo service_role escribe),
-- pero conservaba INSERT/UPDATE/DELETE para authenticated desde SEC-07: se
-- sacan para que el flag nunca dependa sólo de RLS. anon ya tenía sólo SELECT.
revoke insert, update, delete on table public.system_settings from authenticated;
revoke insert, update, delete on table public.system_settings from anon;

-- -----------------------------------------------------------------------------
-- 2) Lectura del flag. Sólo el literal jsonb `true` lo prende.
-- -----------------------------------------------------------------------------
create or replace function public.internal_mfa_required()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select s.value = 'true'::jsonb
       from public.system_settings s
      where s.key = 'internal_mfa_required'),
    false
  );
$$;

revoke execute on function public.internal_mfa_required() from public, anon;
grant execute on function public.internal_mfa_required() to authenticated, service_role;

comment on function public.internal_mfa_required() is
  'SEC-23 (ADR-186): flag global system_settings.internal_mfa_required. Lo leen is_internal(), el middleware de Next y las Edges de staff.';

-- -----------------------------------------------------------------------------
-- 3) is_internal(): staff + (flag apagado o sesión aal2).
--    Mismo nombre, firma, STABLE y search_path vacío: create or replace
--    conserva los grants (anon y authenticated la evalúan en policies).
-- -----------------------------------------------------------------------------
create or replace function public.is_internal()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_claims jsonb := auth.jwt();
begin
  if not coalesce((v_claims -> 'app_metadata' ->> 'is_internal')::boolean, false) then
    return false;
  end if;
  -- Cache por transacción, sólo del valor PRENDIDO: así en una consulta con
  -- muchas filas el staff lee system_settings una vez. Quien pudiera setear
  -- este GUC sólo podría endurecer la exigencia, nunca apagarla: con 'off' o
  -- vacío se vuelve a leer la tabla.
  if coalesce(current_setting('ninja.internal_mfa_required', true), '') <> 'on' then
    if not public.internal_mfa_required() then
      return true;
    end if;
    perform pg_catalog.set_config('ninja.internal_mfa_required', 'on', true);
  end if;
  return coalesce(v_claims ->> 'aal', 'aal1') = 'aal2';
end;
$$;

comment on function public.is_internal() is
  'Staff NinjaSoft (app_metadata.is_internal). Con system_settings.internal_mfa_required = true exige además aal2 en el JWT (SEC-23, ADR-186).';

-- -----------------------------------------------------------------------------
-- 4) Reset de MFA de otro miembro del staff (sólo super_admin, auditado).
-- -----------------------------------------------------------------------------
create or replace function public.internal_mfa_reset(p_user_id uuid, p_motivo text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason   text := btrim(coalesce(p_motivo, ''));
  v_email    text;
  v_staff    boolean;
  v_factors  jsonb;
  v_deleted  integer := 0;
  v_sessions integer := 0;
  v_sess_ok  boolean := false;
  v_sess_err text;
begin
  if not internal_scope() or internal_level() is distinct from 'super_admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'user_required';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'cannot_reset_self';
  end if;
  if char_length(v_reason) < 5 then
    raise exception 'reason_required';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'reason_too_long';
  end if;

  select u.email, coalesce((u.raw_app_meta_data ->> 'is_internal')::boolean, false)
    into v_email, v_staff
    from auth.users u
   where u.id = p_user_id;
  if not found then
    raise exception 'user_not_found';
  end if;
  -- Sólo staff: los usuarios de negocios no usan MFA del panel interno.
  if not v_staff then
    raise exception 'not_internal_staff';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id,
           'type', f.factor_type,
           'status', f.status,
           'friendly_name', f.friendly_name,
           'created_at', f.created_at
         ) order by f.created_at), '[]'::jsonb)
    into v_factors
    from auth.mfa_factors f
   where f.user_id = p_user_id;

  -- Los challenges caen en cascada (FK de auth.mfa_challenges).
  delete from auth.mfa_factors where user_id = p_user_id;
  get diagnostics v_deleted = row_count;

  -- Una sesión aal2 previa conserva su aal aunque el factor ya no exista:
  -- se cortan (refresh tokens) para que la persona vuelva a entrar y enrole de
  -- nuevo. Los JWT ya emitidos siguen válidos hasta que vencen (jwt_expiry,
  -- ~1 h) en los caminos que sólo miran el token (RLS, Edges).
  begin
    delete from auth.sessions where user_id = p_user_id;
    get diagnostics v_sessions = row_count;
    v_sess_ok := true;
  exception when others then
    v_sess_err := sqlerrm;
    raise warning 'internal_mfa_reset sessions: %', v_sess_err;
  end;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id,
                          action, before_data, after_data, reason)
  values (null, auth.uid(), 'auth_mfa_factors', p_user_id, 'internal_mfa_reset',
          jsonb_build_object('email', v_email, 'factors', v_factors),
          jsonb_build_object('factors_deleted', v_deleted,
                             'sessions_revoked', v_sess_ok,
                             'sessions_deleted', v_sessions,
                             'sessions_error', v_sess_err),
          v_reason);

  return jsonb_build_object('ok', true, 'factors_deleted', v_deleted,
                            'sessions_revoked', v_sess_ok, 'sessions_deleted', v_sessions);
end;
$$;

revoke execute on function public.internal_mfa_reset(uuid, text) from public, anon;
grant execute on function public.internal_mfa_reset(uuid, text) to authenticated;

comment on function public.internal_mfa_reset(uuid, text) is
  'SEC-23 (ADR-186): super_admin borra los factores MFA de otro miembro del staff y corta sus sesiones. Motivo obligatorio, auditado.';
