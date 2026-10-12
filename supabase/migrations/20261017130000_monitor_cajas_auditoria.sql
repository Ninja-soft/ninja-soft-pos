-- =============================================================================
-- 20261017130000_monitor_cajas_auditoria  (F17 · H115 + H117 + H118 · ADR-051)
--
--   A) cash_monitor(): turnos abiertos con caja, sucursal, usuario, desde
--      cuándo, ventas, total, efectivo esperado, retiros, ingresos y última
--      actividad. Dueño y encargado ven las sucursales de su alcance; el resto,
--      sólo su turno. Feature BASE `monitor_cajas`.
--   B) owner_dashboard_stats(): ventas de hoy y de ayer por sucursal y por
--      hora, turnos abiertos y personal por estado para el Panel del dueño.
--   C) Auditoría: la lectura directa de audit_logs se restringe (RESTRICTIVE):
--      dueño o encargado, o las filas propias. Visor por RPC audit_log_search
--      (filtros, paginado) gateado por la feature OPTIONAL `auditoria`.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('monitor_cajas', 'Monitor de cajas',
   'Cajas abiertas por sucursal: quién, desde cuándo, ventas y efectivo esperado', 'ventas', true, 76)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('monitor_cajas', true), true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'monitor_cajas');

-- -----------------------------------------------------------------------------
-- A) Monitor de cajas
-- -----------------------------------------------------------------------------
create index if not exists cash_shifts_tenant_open_idx
  on cash_shifts (tenant_id, store_id) where status = 'open';

create or replace function cash_monitor(p_store_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_allowed uuid[];
  v_mgr     boolean := is_tenant_manager();
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not tenant_has_feature_for(v_tenant, 'monitor_cajas') then
    raise exception 'feature_not_in_plan: monitor_cajas' using errcode = 'check_violation';
  end if;
  v_allowed := user_allowed_store_ids();
  return coalesce((
    select jsonb_agg(row_to_json(t)::jsonb order by t.store_name, t.opened_at)
      from (
        select cs.id as shift_id,
               cs.store_id,
               s.name as store_name,
               s.short_name as store_short,
               s.color as store_color,
               cs.cash_register_id as register_id,
               cr.name as register_name,
               cr.code as register_code,
               cs.opened_by,
               coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email, 'Usuario') as opened_by_name,
               tu.avatar as opened_by_avatar,
               tu.role as opened_by_role,
               cs.opened_at,
               cs.opening_amount,
               (cs.opened_by = auth.uid()) as is_mine,
               coalesce(m.sales_total, 0) as sales_total,
               coalesce(sa.sales_count, 0) as sales_count,
               coalesce(sa.voids_count, 0) as voids_count,
               coalesce(m.cash_in, 0) as cash_in,
               coalesce(m.cash_out, 0) as cash_out,
               cs.opening_amount + coalesce(m.cash_delta, 0) as cash_expected,
               greatest(cs.opened_at, m.last_at, sa.last_at) as last_activity_at
          from cash_shifts cs
          join stores s on s.id = cs.store_id
          join cash_registers cr on cr.id = cs.cash_register_id
          left join public.users u on u.id = cs.opened_by
          left join tenant_users tu on tu.tenant_id = cs.tenant_id and tu.user_id = cs.opened_by
          left join lateral (
            select sum(case when cm.type = 'sale' then cm.amount when cm.type = 'sale_void' then -cm.amount else 0 end) as sales_total,
                   sum(case when cm.type = 'income' then cm.amount else 0 end) as cash_in,
                   sum(case when cm.type = 'expense' then cm.amount else 0 end) as cash_out,
                   sum(case when cm.type = 'income' then cm.amount
                            when cm.type = 'expense' then -cm.amount
                            when cm.type = 'sale' and cm.payment_method = 'cash' then cm.amount
                            when cm.type = 'sale_void' and cm.payment_method = 'cash' then -cm.amount
                            else 0 end) as cash_delta,
                   max(cm.created_at) as last_at
              from cash_movements cm
             where cm.cash_shift_id = cs.id
          ) m on true
          left join lateral (
            select count(*) filter (where sl.status = 'completed') as sales_count,
                   count(*) filter (where sl.status = 'voided') as voids_count,
                   max(sl.created_at) as last_at
              from sales sl
             where sl.cash_shift_id = cs.id
          ) sa on true
         where cs.tenant_id = v_tenant
           and cs.status = 'open'
           and cs.store_id = any (v_allowed)
           and (p_store_id is null or cs.store_id = p_store_id)
           and (v_mgr or cs.opened_by = auth.uid())
      ) t), '[]'::jsonb);
end;
$$;
revoke all on function cash_monitor(uuid) from public, anon;
grant execute on function cash_monitor(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Panel del dueño
-- -----------------------------------------------------------------------------
create or replace function owner_dashboard_stats(p_store_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_allowed uuid[];
  v_today   date := branch_today();
  v_from    timestamptz;
  v_mid     timestamptz;
  v_to      timestamptz;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;
  v_allowed := user_allowed_store_ids();
  v_from := ((v_today - 1)::timestamp at time zone 'America/Argentina/Buenos_Aires');
  v_mid  := (v_today::timestamp at time zone 'America/Argentina/Buenos_Aires');
  v_to   := ((v_today + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires');

  return jsonb_build_object(
    'today', v_today,
    'by_store', coalesce((
      select jsonb_agg(jsonb_build_object(
               'store_id', st.id, 'name', st.name, 'short_name', st.short_name, 'color', st.color,
               'today_total', coalesce(x.today_total, 0), 'today_count', coalesce(x.today_count, 0),
               'yesterday_total', coalesce(x.yesterday_total, 0), 'yesterday_count', coalesce(x.yesterday_count, 0))
               order by st.is_default desc, st.sort, st.created_at)
        from stores st
        left join lateral (
          select sum(sl.total) filter (where sl.created_at >= v_mid) as today_total,
                 count(*) filter (where sl.created_at >= v_mid) as today_count,
                 sum(sl.total) filter (where sl.created_at < v_mid) as yesterday_total,
                 count(*) filter (where sl.created_at < v_mid) as yesterday_count
            from sales sl
           where sl.tenant_id = v_tenant and sl.store_id = st.id and sl.status = 'completed'
             and sl.created_at >= v_from and sl.created_at < v_to
        ) x on true
       where st.tenant_id = v_tenant and st.deleted_at is null
         and st.id = any (v_allowed)
         and (p_store_id is null or st.id = p_store_id)), '[]'::jsonb),
    'by_hour', coalesce((
      select jsonb_agg(jsonb_build_object('hour', h.hour, 'today', coalesce(t.today, 0), 'yesterday', coalesce(t.yesterday, 0))
               order by h.hour)
        from generate_series(0, 23) as h(hour)
        left join (
          select extract(hour from (sl.created_at at time zone 'America/Argentina/Buenos_Aires'))::int as hour,
                 sum(sl.total) filter (where sl.created_at >= v_mid) as today,
                 sum(sl.total) filter (where sl.created_at < v_mid) as yesterday
            from sales sl
           where sl.tenant_id = v_tenant and sl.status = 'completed'
             and sl.created_at >= v_from and sl.created_at < v_to
             and sl.store_id = any (v_allowed)
             and (p_store_id is null or sl.store_id = p_store_id)
           group by 1
        ) t on t.hour = h.hour), '[]'::jsonb),
    'open_shifts', (
      select count(*) from cash_shifts cs
       where cs.tenant_id = v_tenant and cs.status = 'open'
         and cs.store_id = any (v_allowed)
         and (p_store_id is null or cs.store_id = p_store_id)),
    'staff', (
      select jsonb_build_object(
               'active', count(*) filter (where st = 'active'),
               'suspended', count(*) filter (where st = 'suspended'),
               'on_leave', count(*) filter (where st = 'on_leave'),
               'terminated', count(*) filter (where st = 'terminated'))
        from (
          select case when tu.status = 'inactive' then 'terminated'
                      when tu.role = 'owner' then 'active'
                      else staff_effective_status(v_tenant, tu.user_id, null, null) end as st
            from tenant_users tu
           where tu.tenant_id = v_tenant and tu.status in ('active', 'inactive')
        ) z));
end;
$$;
revoke all on function owner_dashboard_stats(uuid) from public, anon;
grant execute on function owner_dashboard_stats(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Auditoría
-- -----------------------------------------------------------------------------
drop policy if exists audit_logs_role_scope on audit_logs;
create policy audit_logs_role_scope on audit_logs
  as restrictive for select
  using (
    (select is_tenant_manager())
    or actor_user_id = (select auth.uid())
    or (select internal_scope())
  );

create index if not exists audit_logs_tenant_created_idx
  on audit_logs (tenant_id, created_at desc);

create or replace function audit_log_search(
  p_from   timestamptz default null,
  p_to     timestamptz default null,
  p_actor  uuid default null,
  p_store  uuid default null,
  p_action text default null,
  p_entity text default null,
  p_q      text default null,
  p_limit  int default 50,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_owner   boolean := is_tenant_owner();
  v_allowed uuid[];
  v_limit   int := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_q       text := nullif(btrim(coalesce(p_q, '')), '');
  v_total   bigint;
  v_rows    jsonb;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not tenant_has_feature_for(v_tenant, 'auditoria') then
    raise exception 'feature_not_in_plan: auditoria' using errcode = 'check_violation';
  end if;
  v_allowed := user_allowed_store_ids();

  with f as (
    select a.*
      from audit_logs a
     where a.tenant_id = v_tenant
       and (p_from is null or a.created_at >= p_from)
       and (p_to is null or a.created_at < p_to)
       and (p_actor is null or a.actor_user_id = p_actor)
       and (p_store is null or a.store_id = p_store)
       and (p_action is null or a.action = p_action)
       and (p_entity is null or a.entity_type = p_entity)
       and (v_owner or a.store_id is null or a.store_id = any (v_allowed))
       and (v_q is null
            or a.action ilike '%' || v_q || '%'
            or coalesce(a.reason, '') ilike '%' || v_q || '%'
            or a.entity_type ilike '%' || v_q || '%'
            or coalesce(a.after_data::text, '') ilike '%' || v_q || '%')
  )
  select (select count(*) from f),
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'id', x.id, 'created_at', x.created_at, 'action', x.action,
                    'entity_type', x.entity_type, 'entity_id', x.entity_id,
                    'actor_user_id', x.actor_user_id,
                    'actor_name', coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email),
                    'store_id', x.store_id, 'reason', x.reason,
                    'before_data', x.before_data, 'after_data', x.after_data)
                    order by x.created_at desc)
             from (select * from f order by created_at desc limit v_limit offset greatest(coalesce(p_offset, 0), 0)) x
             left join public.users u on u.id = x.actor_user_id
             left join tenant_users tu on tu.tenant_id = v_tenant and tu.user_id = x.actor_user_id
         ), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;
revoke all on function audit_log_search(timestamptz, timestamptz, uuid, uuid, text, text, text, int, int) from public, anon;
grant execute on function audit_log_search(timestamptz, timestamptz, uuid, uuid, text, text, text, int, int) to authenticated;

-- Acciones y entidades presentes (para los filtros del visor).
create or replace function audit_log_facets()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'actions', coalesce((select jsonb_agg(distinct a.action) from audit_logs a
                          where a.tenant_id = v_tenant and a.created_at > now() - interval '180 days'), '[]'::jsonb),
    'entities', coalesce((select jsonb_agg(distinct a.entity_type) from audit_logs a
                           where a.tenant_id = v_tenant and a.created_at > now() - interval '180 days'), '[]'::jsonb));
end;
$$;
revoke all on function audit_log_facets() from public, anon;
grant execute on function audit_log_facets() to authenticated;
