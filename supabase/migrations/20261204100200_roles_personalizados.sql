-- =============================================================================
-- 20261204100200_roles_personalizados  (ADR-138, parte B)
--
-- RPC del editor de roles y permisos. Las tablas de 20261204100100 no tienen
-- policies de escritura: todo pasa por acá, validado y auditado.
--
--   · permission_overview(): roles (sistema y propios) con capacidades y
--     cantidad de personas, el equipo con su rol, rol por sucursal, permisos
--     puntuales y capacidades efectivas (las de la base). Quien no gestiona
--     personal sólo se ve a sí mismo.
--   · permission_role_save / _duplicate / _delete: sólo el dueño
--     (team.roles), con la feature roles_permisos para crear o cambiar.
--     Borrar no la pide (un negocio que bajó de plan puede ordenar) y siempre
--     reasigna a otro rol.
--   · permission_assign_role / permission_branch_role_set: team.manage. El
--     dueño asigna cualquier rol salvo Dueño; un encargado sólo a cajeros y
--     solo lectura, roles de esos niveles y nunca con capacidades que él no
--     tenga (sin escalada). Roles de sistema en todo plan; propios con la
--     feature. Rol por sucursal con multi_sucursal y una asignación vigente.
--   · permission_override_set: sólo el dueño, con la feature; sin ella, sólo
--     capacidades con grant_feature prendida en el plan (otorgables de
--     Inventario: el auditor de ajustes es stock.adjust.approve dado acá,
--     ADR-137). Conceder algo que el nivel base no permite se rechaza
--     (capability_needs_higher_base: solo lectura nunca escribe, ADR-071).
--
-- Auditoría: permission_role_created / _updated / _deleted,
-- permission_role_assigned, permission_branch_role_set,
-- permission_override_set (entity_type permission_role o member).
-- =============================================================================

-- Dueño activo del negocio actual (los roles los maneja sólo el dueño).
create or replace function _perm_owner_tenant()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  if coalesce(member_role_in(v_tenant), '') <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _perm_owner_tenant() from public, anon, authenticated;

create or replace function _perm_assert_feature(p_tenant uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not coalesce(tenant_has_feature_for(p_tenant, 'roles_permisos'), false) then
    raise exception 'feature_not_in_plan: roles_permisos';
  end if;
end;
$$;
revoke all on function _perm_assert_feature(uuid) from public, anon, authenticated;

-- Capacidades de un rol normalizadas para un nivel: sólo claves conocidas,
-- con sus dependencias y permitidas por el nivel (espejo de
-- normalizeCapabilities en lib/permissions/capabilities.ts).
create or replace function _perm_normalize(p_caps text[], p_base text)
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_unknown text;
  v_all     text[];
  v_rank    int := case p_base when 'owner' then 3 when 'manager' then 2 when 'cashier' then 1 else 0 end;
begin
  select k into v_unknown
    from unnest(coalesce(p_caps, '{}')) k
   where not exists (select 1 from permission_capabilities c where c.key = k)
   limit 1;
  if v_unknown is not null then
    raise exception 'invalid_capability: %', v_unknown using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct x), '{}') into v_all
    from (
      select unnest(coalesce(p_caps, '{}')) as x
      union
      select unnest(c.requires_all) from permission_capabilities c where c.key = any (coalesce(p_caps, '{}'))
    ) s;
  return array(
    select c.key from permission_capabilities c
     where c.key = any (v_all)
       and (case c.min_base when 'owner' then 3 when 'manager' then 2 when 'cashier' then 1 else 0 end) <= v_rank
       and c.requires_all <@ v_all
     order by c.sort);
end;
$$;
revoke all on function _perm_normalize(text[], text) from public, anon, authenticated;

create or replace function _perm_role_caps(p_role uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(rc.capability order by c.sort), '{}')
    from permission_role_capabilities rc
    join permission_capabilities c on c.key = rc.capability
   where rc.role_id = p_role;
$$;
revoke all on function _perm_role_caps(uuid) from public, anon, authenticated;

-- Rol asignable en el negocio: de sistema (no Dueño) o propio vivo.
create or replace function _perm_role_for_assign(p_tenant uuid, p_role uuid)
returns permission_roles
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v permission_roles;
begin
  select * into v from permission_roles where id = p_role;
  if v.id is null or v.deleted_at is not null
     or (v.tenant_id is not null and v.tenant_id <> p_tenant) then
    raise exception 'role_not_found';
  end if;
  if v.base_role = 'owner' then
    raise exception 'cannot_assign_owner' using errcode = '42501';
  end if;
  if v.tenant_id is not null then
    perform _perm_assert_feature(p_tenant);
  end if;
  return v;
end;
$$;
revoke all on function _perm_role_for_assign(uuid, uuid) from public, anon, authenticated;

-- Quien asigna tiene que poder: dueño cualquiera; si no, team.manage, persona
-- de nivel cajero o solo lectura, rol de esos niveles y sin capacidades que
-- él no tenga.
create or replace function _perm_assert_can_assign(p_tenant uuid, p_target uuid, p_role permission_roles)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me     text := member_role_in(p_tenant);
  v_target text;
  v_mine   text[];
  v_extra  text;
begin
  if v_me is null or not has_capability('team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform assert_staff_operational();
  select role into v_target from tenant_users
   where tenant_id = p_tenant and user_id = p_target and status in ('active', 'invited');
  if v_target is null then raise exception 'member_not_found'; end if;
  if p_target = auth.uid() then raise exception 'cannot_change_self' using errcode = '42501'; end if;
  if v_target = 'owner' then raise exception 'cannot_change_owner' using errcode = '42501'; end if;
  if v_me = 'owner' then return; end if;
  if v_target = 'manager' or (p_role.id is not null and p_role.base_role = 'manager') then
    raise exception 'forbidden_role' using errcode = '42501';
  end if;
  if p_role.id is not null then
    v_mine := capabilities_for(p_tenant, auth.uid(), null);
    select k into v_extra
      from unnest(_perm_normalize(_perm_role_caps(p_role.id), p_role.base_role)) k
     where not (k = any (v_mine))
     limit 1;
    if v_extra is not null then
      raise exception 'escalation_not_allowed: %', v_extra using errcode = '42501';
    end if;
  end if;
end;
$$;
revoke all on function _perm_assert_can_assign(uuid, uuid, permission_roles) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Lectura para el editor
-- -----------------------------------------------------------------------------
create or replace function permission_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_me     text;
  v_manage boolean;
  v_roles  jsonb;
  v_people jsonb;
  v_stores jsonb;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  v_me := member_role_in(v_tenant);
  if v_me is null then raise exception 'forbidden' using errcode = '42501'; end if;
  v_manage := v_me = 'owner' or has_capability('team.manage');

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'key', r.key, 'name', r.name, 'description', r.description,
           'color', r.color, 'icon', r.icon, 'base', r.base_role,
           'system', r.tenant_id is null, 'template_key', r.template_key,
           'capabilities', to_jsonb(_perm_role_caps(r.id)),
           'members', (select count(*) from tenant_users tu
                        where tu.tenant_id = v_tenant and tu.status in ('active', 'invited')
                          and coalesce(tu.role_id, (select s.id from permission_roles s
                                                     where s.tenant_id is null and s.key = tu.role)) = r.id),
           'updated_at', r.updated_at)
         order by (r.tenant_id is not null), r.sort, r.name), '[]')
    into v_roles
    from permission_roles r
   where (r.tenant_id is null or r.tenant_id = v_tenant) and r.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', tu.user_id,
           'name', coalesce(nullif(btrim(tu.display_name), ''), nullif(btrim(u.full_name), ''), u.email, 'Miembro'),
           'email', u.email,
           'avatar', coalesce(tu.avatar, u.avatar_url),
           'status', tu.status,
           'base', tu.role,
           'role_id', coalesce(tu.role_id, (select s.id from permission_roles s where s.tenant_id is null and s.key = tu.role)),
           'overrides', coalesce((select jsonb_agg(jsonb_build_object('capability', o.capability, 'effect', o.effect, 'reason', o.reason) order by o.capability)
                                    from permission_user_overrides o
                                   where o.tenant_id = v_tenant and o.user_id = tu.user_id), '[]'),
           'stores', coalesce((select jsonb_agg(jsonb_build_object(
                                        'store_id', a.store_id, 'kind', a.kind, 'base', a.role,
                                        'role_id', coalesce(a.role_id, (select s.id from permission_roles s where s.tenant_id is null and s.key = a.role)))
                                      order by a.store_id)
                                 from staff_branch_assignments a
                                where a.tenant_id = v_tenant and a.user_id = tu.user_id and a.deleted_at is null
                                  and a.valid_from <= branch_today()
                                  and (a.valid_until is null or a.valid_until >= branch_today())), '[]'),
           'effective', to_jsonb(capabilities_for(v_tenant, tu.user_id, null)))
         order by case tu.role when 'owner' then 0 when 'manager' then 1 when 'cashier' then 2 else 3 end,
                  coalesce(nullif(btrim(tu.display_name), ''), u.full_name, u.email)), '[]')
    into v_people
    from tenant_users tu
    join users u on u.id = tu.user_id
   where tu.tenant_id = v_tenant and tu.status in ('active', 'invited')
     and (v_manage or tu.user_id = auth.uid());

  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'short_name', s.short_name, 'color', s.color)
                            order by s.is_default desc, s.name), '[]')
    into v_stores
    from stores s
   where s.tenant_id = v_tenant and s.deleted_at is null;

  return jsonb_build_object(
    'feature', coalesce(tenant_has_feature_for(v_tenant, 'roles_permisos'), false),
    -- Features que habilitan permisos puntuales sin roles_permisos.
    'grant_features', coalesce((select jsonb_agg(f order by f) from (
        select distinct c.grant_feature as f from permission_capabilities c
         where c.grant_feature is not null
           and coalesce(tenant_has_feature_for(v_tenant, c.grant_feature), false)) g), '[]'),
    'multi_sucursal', coalesce(tenant_has_feature_for(v_tenant, 'multi_sucursal'), false),
    'is_owner', v_me = 'owner',
    'can_manage', v_manage,
    'me', auth.uid(),
    'my_capabilities', to_jsonb(capabilities_for(v_tenant, auth.uid(), null)),
    'roles', v_roles,
    'people', v_people,
    'stores', v_stores);
end;
$$;
revoke all on function permission_overview() from public, anon;
grant execute on function permission_overview() to authenticated;

-- -----------------------------------------------------------------------------
-- Roles propios (dueño)
-- -----------------------------------------------------------------------------
create or replace function permission_role_save(
  p_role_id      uuid,
  p_name         text,
  p_description  text,
  p_color        text,
  p_icon         text,
  p_base         text,
  p_capabilities text[],
  p_template     text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _perm_owner_tenant();
  v_name   text := btrim(coalesce(p_name, ''));
  v_desc   text := nullif(btrim(coalesce(p_description, '')), '');
  v_old    permission_roles;
  v_id     uuid;
  v_key    text;
  v_caps   text[];
  v_before text[];
  v_n      int;
begin
  perform _perm_assert_feature(v_tenant);
  if char_length(v_name) < 1 or char_length(v_name) > 40 then raise exception 'invalid_name'; end if;
  if v_desc is not null and char_length(v_desc) > 200 then raise exception 'invalid_description'; end if;
  if p_base not in ('manager', 'cashier', 'viewer') then raise exception 'invalid_base'; end if;
  v_caps := _perm_normalize(p_capabilities, p_base);

  if p_role_id is not null then
    select * into v_old from permission_roles
     where id = p_role_id and tenant_id = v_tenant and deleted_at is null
     for update;
    if v_old.id is null then raise exception 'role_not_found'; end if;
  end if;

  if exists (select 1 from permission_roles r
              where r.tenant_id = v_tenant and r.deleted_at is null
                and lower(btrim(r.name)) = lower(v_name) and r.id is distinct from p_role_id)
     or exists (select 1 from permission_roles r where r.tenant_id is null and lower(r.name) = lower(v_name)) then
    raise exception 'role_name_taken';
  end if;

  if v_old.id is null then
    select count(*) into v_n from permission_roles where tenant_id = v_tenant and deleted_at is null;
    if v_n >= 30 then raise exception 'too_many_roles'; end if;
    v_key := left(regexp_replace(lower(translate(v_name, 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')), '[^a-z0-9]+', '_', 'g'), 30);
    v_key := 'r_' || coalesce(nullif(btrim(v_key, '_'), ''), 'rol');
    while exists (select 1 from permission_roles where tenant_id = v_tenant and key = v_key and deleted_at is null) loop
      v_key := left(v_key, 34) || '_' || substr(md5(random()::text), 1, 4);
    end loop;
    insert into permission_roles (tenant_id, key, name, description, color, icon, base_role, template_key, created_by, updated_by)
    values (v_tenant, v_key, v_name, v_desc, coalesce(p_color, 'slate'), coalesce(p_icon, 'user'), p_base,
            nullif(btrim(coalesce(p_template, '')), ''), auth.uid(), auth.uid())
    returning id into v_id;
  else
    v_id := v_old.id;
    v_before := _perm_role_caps(v_id);
    update permission_roles
       set name = v_name, description = v_desc, color = coalesce(p_color, color), icon = coalesce(p_icon, icon),
           base_role = p_base, updated_by = auth.uid()
     where id = v_id;
  end if;

  delete from permission_role_capabilities where role_id = v_id and not (capability = any (v_caps));
  insert into permission_role_capabilities (role_id, capability, tenant_id)
  select v_id, k, v_tenant from unnest(v_caps) k
  on conflict (role_id, capability) do nothing;

  -- Cambió el nivel: lo siguen las personas y las sucursales con este rol.
  if v_old.id is not null and v_old.base_role <> p_base then
    update tenant_users set role = p_base where tenant_id = v_tenant and role_id = v_id;
    update staff_branch_assignments set role = p_base where tenant_id = v_tenant and role_id = v_id;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'permission_role', v_id,
          case when v_old.id is null then 'permission_role_created' else 'permission_role_updated' end,
          case when v_old.id is null then null else jsonb_build_object(
            'name', v_old.name, 'base', v_old.base_role, 'color', v_old.color, 'icon', v_old.icon,
            'capabilities', to_jsonb(v_before)) end,
          jsonb_build_object('name', v_name, 'base', p_base, 'color', coalesce(p_color, v_old.color, 'slate'),
            'icon', coalesce(p_icon, v_old.icon, 'user'), 'template', p_template,
            'capabilities', to_jsonb(v_caps),
            'added', to_jsonb(array(select unnest(v_caps) except select unnest(coalesce(v_before, '{}')))),
            'removed', to_jsonb(array(select unnest(coalesce(v_before, '{}')) except select unnest(v_caps)))));
  perform set_config('ninja.caps', '', true);
  return v_id;
end;
$$;
revoke all on function permission_role_save(uuid, text, text, text, text, text, text[], text) from public, anon;
grant execute on function permission_role_save(uuid, text, text, text, text, text, text[], text) to authenticated;

create or replace function permission_role_duplicate(p_source uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _perm_owner_tenant();
  v_src    permission_roles;
begin
  select * into v_src from permission_roles
   where id = p_source and deleted_at is null and (tenant_id is null or tenant_id = v_tenant);
  if v_src.id is null then raise exception 'role_not_found'; end if;
  if v_src.base_role = 'owner' then raise exception 'cannot_duplicate_owner'; end if;
  return permission_role_save(null, p_name, v_src.description, v_src.color, v_src.icon, v_src.base_role,
                              _perm_role_caps(v_src.id), v_src.key);
end;
$$;
revoke all on function permission_role_duplicate(uuid, text) from public, anon;
grant execute on function permission_role_duplicate(uuid, text) to authenticated;

create or replace function permission_role_delete(p_role_id uuid, p_reassign_to uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _perm_owner_tenant();
  v_role   permission_roles;
  v_to     permission_roles;
  v_people int;
  v_stores int;
begin
  select * into v_role from permission_roles
   where id = p_role_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if v_role.id is null then raise exception 'role_not_found'; end if;
  if p_reassign_to is null or p_reassign_to = p_role_id then raise exception 'invalid_reassign'; end if;
  v_to := _perm_role_for_assign(v_tenant, p_reassign_to);

  update tenant_users set role_id = v_to.id
   where tenant_id = v_tenant and role_id = v_role.id;
  get diagnostics v_people = row_count;
  update staff_branch_assignments set role_id = v_to.id
   where tenant_id = v_tenant and role_id = v_role.id;
  get diagnostics v_stores = row_count;
  update permission_roles set deleted_at = now(), updated_by = auth.uid() where id = v_role.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'permission_role', v_role.id, 'permission_role_deleted',
          jsonb_build_object('name', v_role.name, 'base', v_role.base_role, 'capabilities', to_jsonb(_perm_role_caps(v_role.id))),
          jsonb_build_object('reassigned_to', v_to.id, 'reassigned_name', v_to.name, 'people', v_people, 'branches', v_stores));
  perform set_config('ninja.caps', '', true);
  return v_people;
end;
$$;
revoke all on function permission_role_delete(uuid, uuid) from public, anon;
grant execute on function permission_role_delete(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Asignaciones
-- -----------------------------------------------------------------------------
create or replace function permission_assign_role(p_user uuid, p_role_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   permission_roles;
  v_before jsonb;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  v_role := _perm_role_for_assign(v_tenant, p_role_id);
  perform _perm_assert_can_assign(v_tenant, p_user, v_role);

  select jsonb_build_object('base', role, 'role_id', role_id) into v_before
    from tenant_users where tenant_id = v_tenant and user_id = p_user;
  update tenant_users set role_id = v_role.id
   where tenant_id = v_tenant and user_id = p_user;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'member', p_user, 'permission_role_assigned', v_before,
          jsonb_build_object('base', v_role.base_role, 'role_id', v_role.id, 'role_name', v_role.name));
  perform set_config('ninja.caps', '', true);
end;
$$;
revoke all on function permission_assign_role(uuid, uuid) from public, anon;
grant execute on function permission_assign_role(uuid, uuid) to authenticated;

-- Rol en una sucursal (sobre la asignación vigente). p_role_id null = sin rol
-- propio en esa sucursal (usa el del negocio).
create or replace function permission_branch_role_set(p_user uuid, p_store uuid, p_role_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   permission_roles;
  v_n      int;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  if not coalesce(tenant_has_feature_for(v_tenant, 'multi_sucursal'), false) then
    raise exception 'feature_not_in_plan: multi_sucursal';
  end if;
  if p_role_id is not null then
    v_role := _perm_role_for_assign(v_tenant, p_role_id);
  end if;
  perform _perm_assert_can_assign(v_tenant, p_user, v_role);

  if p_role_id is null then
    update staff_branch_assignments set role = null, role_id = null
     where tenant_id = v_tenant and user_id = p_user and store_id = p_store and deleted_at is null
       and valid_from <= branch_today() and (valid_until is null or valid_until >= branch_today());
  else
    update staff_branch_assignments set role_id = v_role.id
     where tenant_id = v_tenant and user_id = p_user and store_id = p_store and deleted_at is null
       and valid_from <= branch_today() and (valid_until is null or valid_until >= branch_today());
  end if;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'no_assignment'; end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'member', p_user, 'permission_branch_role_set',
          jsonb_build_object('store_id', p_store, 'role_id', v_role.id, 'role_name', v_role.name,
                             'base', v_role.base_role, 'assignments', v_n),
          p_store);
  perform set_config('ninja.caps', '', true);
  return v_n;
end;
$$;
revoke all on function permission_branch_role_set(uuid, uuid, uuid) from public, anon;
grant execute on function permission_branch_role_set(uuid, uuid, uuid) to authenticated;

-- Permiso puntual: 'grant' concede, 'revoke' quita, null vuelve a lo del rol.
create or replace function permission_override_set(p_user uuid, p_capability text, p_effect text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _perm_owner_tenant();
  v_cap    permission_capabilities;
  v_target text;
  v_before text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_cap from permission_capabilities where key = p_capability;
  if v_cap.key is null then raise exception 'invalid_capability: %', p_capability using errcode = '22023'; end if;
  -- Con roles_permisos, cualquiera; sin ella, sólo las otorgables cuya
  -- feature tiene el plan (mismo criterio que capabilities_for).
  if not (coalesce(tenant_has_feature_for(v_tenant, 'roles_permisos'), false)
          or (v_cap.grant_feature is not null
              and coalesce(tenant_has_feature_for(v_tenant, v_cap.grant_feature), false))) then
    if v_cap.grant_feature is not null then
      raise exception 'feature_not_in_plan: %', v_cap.grant_feature;
    end if;
    raise exception 'feature_not_in_plan: roles_permisos';
  end if;
  if v_cap.min_base = 'owner' then raise exception 'owner_only_capability' using errcode = '42501'; end if;
  if p_effect is not null and p_effect not in ('grant', 'revoke') then raise exception 'invalid_effect'; end if;
  if v_reason is not null and char_length(v_reason) > 300 then raise exception 'invalid_reason'; end if;
  select role into v_target from tenant_users
   where tenant_id = v_tenant and user_id = p_user and status in ('active', 'invited');
  if v_target is null then raise exception 'member_not_found'; end if;
  if v_target = 'owner' then raise exception 'cannot_change_owner' using errcode = '42501'; end if;
  -- Conceder lo que su nivel no permite no contaría: se rechaza (solo
  -- lectura nunca escribe, ADR-071).
  if p_effect = 'grant'
     and (case v_cap.min_base when 'manager' then 2 when 'cashier' then 1 else 0 end)
         > (case v_target when 'manager' then 2 when 'cashier' then 1 else 0 end) then
    raise exception 'capability_needs_higher_base: %', v_target using errcode = '42501';
  end if;

  select effect into v_before from permission_user_overrides
   where tenant_id = v_tenant and user_id = p_user and capability = p_capability;
  if p_effect is null then
    delete from permission_user_overrides
     where tenant_id = v_tenant and user_id = p_user and capability = p_capability;
  else
    insert into permission_user_overrides (tenant_id, user_id, capability, effect, reason, created_by)
    values (v_tenant, p_user, p_capability, p_effect, v_reason, auth.uid())
    on conflict (tenant_id, user_id, capability)
    do update set effect = excluded.effect, reason = excluded.reason, created_by = excluded.created_by, created_at = now();
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'member', p_user, 'permission_override_set',
          jsonb_build_object('capability', p_capability, 'effect', v_before),
          jsonb_build_object('capability', p_capability, 'effect', p_effect),
          v_reason);
  perform set_config('ninja.caps', '', true);
end;
$$;
revoke all on function permission_override_set(uuid, text, text, text) from public, anon;
grant execute on function permission_override_set(uuid, text, text, text) to authenticated;
