-- =============================================================================
-- 20261020150000_monitor_sucursales  (F17 · H99 primer corte · H115 · ADR-057)
--
-- Vista general de sucursales para el Monitor de cajas: una tarjeta por
-- sucursal con lo que está pasando ahora.
--
--   branch_monitor_overview(): por cada sucursal viva que el usuario ve
--     (user_allowed_store_ids): horario, cajas (abiertas / total), turnos
--     abiertos (caja, quién, desde cuándo), ventas de hoy (total, cantidad,
--     última venta), personal en turno y personal asignado hoy, faltantes de
--     stock (stock_low_by_store), cobros en espera (esperando, pagados sin
--     venta), terminales activas con su última señal y el último cierre Z
--     (diferencia y tolerancia efectiva de la sucursal).
--
--   Devuelve hechos; las alertas (caja abierta hace más de N horas, sucursal
--   sin caja en horario, cobros pagados sin venta, terminal sin señal,
--   diferencia de caja sobre la tolerancia, faltantes) se calculan en
--   lib/branches/monitorAlerts.ts para que el umbral sea configurable en la
--   pantalla y testeable.
--
-- BASE dentro de `monitor_cajas` (no hay key nueva): es lo mismo que el
-- dueño o el encargado ya ven en Caja, Ventas, Stock y Cobros en espera, junto.
-- Sólo dueño y encargado (is_tenant_manager). El heartbeat de cada equipo y
-- `monitoreo_sucursales` (Enterprise) quedan para H99.
-- =============================================================================

create or replace function branch_monitor_overview()
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
  v_low     jsonb := '{}'::jsonb;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not tenant_has_feature_for(v_tenant, 'monitor_cajas') then
    raise exception 'feature_not_in_plan: monitor_cajas' using errcode = 'check_violation';
  end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;
  v_allowed := user_allowed_store_ids();
  v_from := (v_today::timestamp at time zone 'America/Argentina/Buenos_Aires');

  -- Faltantes por sucursal (best effort: sin stock por sucursal, vacío).
  begin
    select coalesce(jsonb_object_agg(x.store_id::text, x.n), '{}'::jsonb) into v_low
      from (select l.store_id, count(*) as n from stock_low_by_store(5000) l group by l.store_id) x;
  exception when others then
    v_low := '{}'::jsonb;
  end;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'store_id', s.id, 'name', s.name, 'short_name', s.short_name, 'color', s.color,
             'is_default', s.is_default, 'is_active', s.is_active,
             'opening_hours', s.opening_hours,
             'registers_total', coalesce(rg.total, 0),
             'registers_open', coalesce(sh.cnt, 0),
             'open_shifts', coalesce(sh.list, '[]'::jsonb),
             'sales_today_total', coalesce(sa.total, 0),
             'sales_today_count', coalesce(sa.cnt, 0),
             'last_sale_at', sa.last_at,
             'staff_on_shift', coalesce(sh.people, 0),
             'staff_assigned', coalesce(st.n, 0),
             'low_stock_count', coalesce((v_low ->> s.id::text)::int, 0),
             'pending_waiting', coalesce(pc.waiting, 0),
             'pending_waiting_amount', coalesce(pc.waiting_amount, 0),
             'pending_paid_unsold', coalesce(pc.paid, 0),
             'terminals', coalesce(tm.list, '[]'::jsonb),
             'last_z', lz.z,
             'close_tolerance', coalesce(
               (_effective_config(v_tenant, 'pos_settings', '', s.id, null) -> 'value' ->> 'close_tolerance')::numeric,
               0))
             order by s.is_default desc, s.sort, s.created_at)
      from stores s
      left join lateral (
        select count(*) as total from cash_registers cr
         where cr.store_id = s.id and cr.deleted_at is null and coalesce(cr.is_active, true)
      ) rg on true
      left join lateral (
        select count(*) as cnt,
               count(distinct cs.opened_by) as people,
               jsonb_agg(jsonb_build_object(
                 'shift_id', cs.id, 'register_name', cr.name, 'opened_at', cs.opened_at,
                 'opened_by_name', coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email, 'Usuario'))
                 order by cs.opened_at) as list
          from cash_shifts cs
          join cash_registers cr on cr.id = cs.cash_register_id
          left join public.users u on u.id = cs.opened_by
          left join tenant_users tu on tu.tenant_id = cs.tenant_id and tu.user_id = cs.opened_by
         where cs.tenant_id = v_tenant and cs.store_id = s.id and cs.status = 'open'
      ) sh on true
      left join lateral (
        select count(*) as cnt, sum(x.total) as total, max(x.created_at) as last_at
          from sales x
         where x.tenant_id = v_tenant and x.store_id = s.id and x.status = 'completed'
           and x.created_at >= v_from
      ) sa on true
      left join lateral (
        select count(distinct coalesce(a.user_id, a.cashier_profile_id)) as n
          from staff_branch_assignments a
         where a.tenant_id = v_tenant and a.store_id = s.id and a.deleted_at is null
           and a.valid_from <= v_today and (a.valid_until is null or a.valid_until >= v_today)
      ) st on true
      left join lateral (
        select count(*) filter (where p.status = 'waiting' and p.expires_at > now()) as waiting,
               coalesce(sum(p.amount) filter (where p.status = 'waiting' and p.expires_at > now()), 0) as waiting_amount,
               count(*) filter (where p.status = 'paid') as paid
          from pending_charges p
         where p.tenant_id = v_tenant and p.store_id = s.id
           and p.status in ('waiting', 'paid')
      ) pc on true
      left join lateral (
        select jsonb_agg(jsonb_build_object(
                 'id', t.id, 'label', t.label, 'provider_key', t.provider_key, 'kind', t.kind,
                 'last_seen_at', t.last_seen_at, 'register_id', t.cash_register_id)
                 order by t.label) as list
          from payment_terminals t
         where t.tenant_id = v_tenant and t.store_id = s.id and t.deleted_at is null and t.active
      ) tm on true
      left join lateral (
        select jsonb_build_object('closed_at', z.closed_at, 'difference', z.difference, 'z_number', z.z_number) as z
          from cash_z_closures z
         where z.tenant_id = v_tenant and z.store_id = s.id
         order by z.closed_at desc limit 1
      ) lz on true
     where s.tenant_id = v_tenant and s.deleted_at is null
       and s.id = any (v_allowed)), '[]'::jsonb);
end;
$$;
revoke all on function branch_monitor_overview() from public, anon;
grant execute on function branch_monitor_overview() to authenticated;
