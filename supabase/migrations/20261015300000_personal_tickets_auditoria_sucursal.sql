-- =============================================================================
-- 20261015300000_personal_tickets_auditoria_sucursal  (F17 · H91 · ADR-049)
--
--   A) audit_logs.store_id: sucursal de cada evento de auditoría, para filtrar
--      la auditoría por sucursal. Se completa sola con un BEFORE INSERT sobre
--      audit_logs (sirve para write_audit_log y para los inserts a mano de las
--      RPC): la fila de `stores` es su propia sucursal; si no, el store_id de
--      after_data o before_data. Sin backfill (la historia queda en null).
--   B) staff_assign_on_invite(): al invitar un usuario (Edge invite_user) se le
--      asignan sucursales de una vez (la primera como base, el resto como
--      acceso adicional). Sólo service_role: la Edge valida al que invita y
--      esta función vuelve a validar todo (negocio, sucursales vivas, alcance
--      del que invita, feature multi_sucursal) y audita.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) audit_logs.store_id
-- -----------------------------------------------------------------------------
alter table audit_logs add column if not exists store_id uuid;

create index if not exists audit_logs_tenant_store_idx
  on audit_logs (tenant_id, store_id, created_at desc)
  where store_id is not null;

create or replace function audit_logs_fill_store()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_txt text;
begin
  if new.store_id is not null then
    return new;
  end if;
  if new.entity_type = 'stores' and new.entity_id is not null then
    new.store_id := new.entity_id;
    return new;
  end if;
  v_txt := coalesce(
    nullif(new.after_data ->> 'store_id', ''),
    nullif(new.before_data ->> 'store_id', '')
  );
  if v_txt is not null and v_txt ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    new.store_id := v_txt::uuid;
  end if;
  -- Un store_id que no es uuid (p. ej. ids de Mercado Pago en un jsonb) se
  -- ignora: la auditoría nunca falla por no poder deducir la sucursal.
  return new;
end;
$$;

drop trigger if exists audit_logs_fill_store on audit_logs;
create trigger audit_logs_fill_store
  before insert on audit_logs
  for each row execute function audit_logs_fill_store();

-- -----------------------------------------------------------------------------
-- B) Sucursales al invitar un usuario
-- -----------------------------------------------------------------------------
create or replace function staff_assign_on_invite(
  p_tenant    uuid,
  p_actor     uuid,
  p_user      uuid,
  p_store_ids uuid[],
  p_role      text default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today      date := branch_today();
  v_role       text := nullif(lower(btrim(coalesce(p_role, ''))), '');
  v_actor_role text;
  v_member     text;
  v_live       int;
  v_allowed    uuid[];
  v_has_home   boolean;
  v_kind       text;
  v_store      record;
  v_sid        uuid;
  v_ord        bigint;
  v_id         uuid;
  v_count      int := 0;
begin
  if p_store_ids is null or cardinality(p_store_ids) = 0 then
    return 0;
  end if;
  if v_role is not null and v_role not in ('manager', 'cashier', 'viewer') then
    raise exception 'invalid_role';
  end if;

  select role into v_actor_role from tenant_users
   where tenant_id = p_tenant and user_id = p_actor and status = 'active';
  if v_actor_role is null or v_actor_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select role into v_member from tenant_users
   where tenant_id = p_tenant and user_id = p_user;
  if v_member is null then raise exception 'member_not_found'; end if;
  -- El dueño opera en todas: no se asigna.
  if v_member = 'owner' then return 0; end if;

  select count(*) into v_live from stores where tenant_id = p_tenant and deleted_at is null;
  if v_live > 1 and not tenant_has_feature_for(p_tenant, 'multi_sucursal') then
    raise exception 'feature_not_in_plan: multi_sucursal' using errcode = 'check_violation';
  end if;

  -- Todas las sucursales tienen que ser del negocio, estar vivas y dentro del
  -- alcance del que invita (un encargado de Norte no asigna gente a Centro).
  v_allowed := staff_allowed_store_ids(p_tenant, p_actor, null, v_actor_role, null);
  foreach v_sid in array p_store_ids loop
    select * into v_store from stores where id = v_sid and tenant_id = p_tenant;
    if not found or v_store.deleted_at is not null then raise exception 'store_not_found'; end if;
    if not (v_sid = any (v_allowed)) then raise exception 'store_not_allowed'; end if;
  end loop;

  -- ¿Ya tiene una base vigente o programada? Entonces todo entra como adicional.
  select exists (
    select 1 from staff_branch_assignments a
     where a.tenant_id = p_tenant and a.user_id = p_user and a.deleted_at is null
       and a.kind = 'home' and (a.valid_until is null or a.valid_until >= v_today)
  ) into v_has_home;

  for v_sid, v_ord in
    select u.s, min(u.o) from unnest(p_store_ids) with ordinality as u(s, o)
     group by u.s order by 2
  loop
    v_kind := case when not v_has_home then 'home' else 'extra' end;

    -- Ya asignado hoy (o desde antes y sin fin) a esa sucursal: no se duplica.
    if exists (
      select 1 from staff_branch_assignments a
       where a.tenant_id = p_tenant and a.user_id = p_user and a.store_id = v_sid
         and a.deleted_at is null and a.kind in ('home', 'extra')
         and a.valid_from <= v_today
         and (a.valid_until is null or a.valid_until >= v_today)
    ) then
      continue;
    end if;

    insert into staff_branch_assignments
      (tenant_id, store_id, user_id, kind, role, valid_from, valid_until, reason, created_by)
    values
      (p_tenant, v_sid, p_user, v_kind, v_role, v_today, null, 'Asignada al invitar', p_actor)
    returning id into v_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (p_tenant, p_actor, 'staff_branch_assignments', v_id, 'staff_branch_scheduled',
            jsonb_build_object('store_id', v_sid, 'kind', v_kind, 'role', v_role,
                               'user_id', p_user, 'valid_from', v_today,
                               'reason', 'Asignada al invitar', 'source', 'invite'),
            v_sid);

    if v_kind = 'home' then v_has_home := true; end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
revoke all on function staff_assign_on_invite(uuid, uuid, uuid, uuid[], text) from public, anon, authenticated;
grant execute on function staff_assign_on_invite(uuid, uuid, uuid, uuid[], text) to service_role;
