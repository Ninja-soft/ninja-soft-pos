-- =============================================================================
-- 20261105100200_heartbeat_cajas  (F17 · H99 · H115 · ADR-080)
--
-- Heartbeat de cada caja y último cobro de cada terminal en el monitor de
-- sucursales. El dueño necesita saber "la Caja 2 de Norte no da señales desde
-- las 10:12" y "el Point de Centro rechazó el último cobro".
--
--   * register_heartbeats: una fila por caja (la última señal), no un log.
--     Quién, en qué turno, versión de la app y estado del equipo (impresora,
--     pantalla del cliente, balanza, cajón, conexión) informado por el POS.
--   * register_heartbeat(caja, info): RPC SECURITY DEFINER que escribe la
--     señal. Valida negocio, caja viva y acceso del usuario a la sucursal.
--     Sanea `info` contra una whitelist. Sin escritura directa por REST.
--     Throttle de 20 s por caja para no escribir de más con varias pestañas.
--   * branch_monitor_overview(): recreada desde su ÚNICA definición
--     (20261020150000_monitor_sucursales) sumando `registers` (cajas vivas
--     con su última señal), `register_id` en los turnos abiertos, el último
--     cobro de cada terminal (`last_charge`: integrada por
--     terminal_transactions o Point / QR por mp_payment_intents) y los
--     correlativos de sucursal en `last_z` (20261105100100).
--
-- Plan (CLAUDE.md §6): sin key nueva. Registrar la señal es BASE (como el
-- registro de terminales); verla es parte del monitor (`monitor_cajas`, BASE,
-- gateado en branch_monitor_overview). La key Enterprise
-- `monitoreo_sucursales` queda para el monitor avanzado (historial de señales,
-- avisos push), que todavía no existe. Ver ADR-080.
--
-- Auditoría: el heartbeat no es una acción crítica (no cambia plata, stock ni
-- permisos) y escribiría cada minuto; no va a audit_logs.
-- =============================================================================

create table if not exists register_heartbeats (
  cash_register_id uuid primary key references cash_registers(id) on delete cascade,
  tenant_id        uuid not null references tenants(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  user_id          uuid references public.users(id) on delete set null,
  cash_shift_id    uuid references cash_shifts(id) on delete set null,
  app_version      text check (app_version is null or char_length(app_version) <= 40),
  info             jsonb not null default '{}'::jsonb check (jsonb_typeof(info) = 'object'),
  last_ping_at     timestamptz not null default now(),
  first_ping_at    timestamptz not null default now()
);

create index if not exists register_heartbeats_tenant_store_idx
  on register_heartbeats (tenant_id, store_id);

alter table register_heartbeats enable row level security;
revoke insert, update, delete on register_heartbeats from anon, authenticated;

drop policy if exists register_heartbeats_select on register_heartbeats;
create policy register_heartbeats_select on register_heartbeats
  for select using (
    internal_scope()
    or (tenant_id = current_tenant_id()
        and store_id = any ((select user_allowed_store_ids())::uuid[]))
  );

-- -----------------------------------------------------------------------------
-- A) Saneo de la información del equipo (whitelist)
-- -----------------------------------------------------------------------------
create or replace function heartbeat_info_clean(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_out  jsonb := '{}'::jsonb;
  v_key  text;
  v_val  text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return v_out;
  end if;
  -- Estados de periféricos: valores cortos conocidos.
  foreach v_key in array array['printer', 'display', 'scale', 'drawer', 'terminal'] loop
    v_val := p ->> v_key;
    if v_val in ('ok', 'error', 'off', 'none', 'unknown') then
      v_out := v_out || jsonb_build_object(v_key, v_val);
    end if;
  end loop;
  if jsonb_typeof(p -> 'online') = 'boolean' then
    v_out := v_out || jsonb_build_object('online', (p ->> 'online')::boolean);
  end if;
  if jsonb_typeof(p -> 'visible') = 'boolean' then
    v_out := v_out || jsonb_build_object('visible', (p ->> 'visible')::boolean);
  end if;
  v_val := p ->> 'platform';
  if v_val is not null then
    v_out := v_out || jsonb_build_object('platform', left(regexp_replace(v_val, '[^A-Za-z0-9 ._()/-]', '', 'g'), 60));
  end if;
  v_val := p ->> 'browser';
  if v_val is not null then
    v_out := v_out || jsonb_build_object('browser', left(regexp_replace(v_val, '[^A-Za-z0-9 ._()/-]', '', 'g'), 60));
  end if;
  return v_out;
end;
$$;

-- -----------------------------------------------------------------------------
-- B) RPC de señal
-- -----------------------------------------------------------------------------
create or replace function register_heartbeat(
  p_register_id uuid,
  p_info        jsonb default '{}'::jsonb,
  p_app_version text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_uid    uuid := auth.uid();
  v_store  uuid;
  v_shift  uuid;
  v_last   record;
  v_ver    text := nullif(left(regexp_replace(coalesce(p_app_version, ''), '[^A-Za-z0-9 ._+-]', '', 'g'), 40), '');
  v_info   jsonb := heartbeat_info_clean(p_info);
begin
  if v_tenant is null or v_uid is null then
    raise exception 'no_tenant';
  end if;

  select cr.store_id into v_store
    from cash_registers cr
    join stores s on s.id = cr.store_id
   where cr.id = p_register_id and cr.tenant_id = v_tenant
     and cr.deleted_at is null and s.deleted_at is null;
  if v_store is null then
    raise exception 'register_not_found';
  end if;
  if not coalesce(user_can_access_store(v_store), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Turno abierto de la caja (si lo hay), para mostrar quién la está usando.
  select cs.id into v_shift
    from cash_shifts cs
   where cs.cash_register_id = p_register_id and cs.tenant_id = v_tenant and cs.status = 'open'
   order by cs.opened_at desc
   limit 1;

  select h.last_ping_at, h.user_id, h.cash_shift_id, h.info, h.app_version into v_last
    from register_heartbeats h
   where h.cash_register_id = p_register_id;

  -- Throttle: misma persona, mismo turno y mismo estado hace menos de 20 s.
  if v_last.last_ping_at is not null
     and v_last.last_ping_at > now() - interval '20 seconds'
     and v_last.user_id is not distinct from v_uid
     and v_last.cash_shift_id is not distinct from v_shift
     and v_last.info = v_info
     and v_last.app_version is not distinct from v_ver then
    return v_last.last_ping_at;
  end if;

  insert into register_heartbeats as h
    (cash_register_id, tenant_id, store_id, user_id, cash_shift_id, app_version, info, last_ping_at, first_ping_at)
  values
    (p_register_id, v_tenant, v_store, v_uid, v_shift, v_ver, v_info, now(), now())
  on conflict (cash_register_id) do update
     set tenant_id     = excluded.tenant_id,
         store_id      = excluded.store_id,
         user_id       = excluded.user_id,
         cash_shift_id = excluded.cash_shift_id,
         app_version   = coalesce(excluded.app_version, h.app_version),
         info          = excluded.info,
         last_ping_at  = excluded.last_ping_at;

  return now();
end;
$$;
revoke all on function register_heartbeat(uuid, jsonb, text) from public, anon;
grant execute on function register_heartbeat(uuid, jsonb, text) to authenticated;

-- Último cobro por terminal (Point / QR): lo lee el monitor.
create index if not exists mpi_terminal_idx
  on mp_payment_intents (payment_terminal_id, created_at desc)
  where payment_terminal_id is not null;

-- -----------------------------------------------------------------------------
-- C) Monitor de sucursales con señales y último cobro por terminal
--    (copia de 20261020150000; cambios marcados con "H99 heartbeat").
-- -----------------------------------------------------------------------------
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
             -- H99 heartbeat: cajas vivas con su última señal.
             'registers', coalesce(hb.list, '[]'::jsonb),
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
                 -- H99 heartbeat: caja del turno, para cruzar con la señal.
                 'register_id', cs.cash_register_id,
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
                 'last_seen_at', t.last_seen_at, 'register_id', t.cash_register_id,
                 -- H99 heartbeat: último cobro aprobado o rechazado.
                 'last_charge', lc.charge)
                 order by t.label) as list
          from payment_terminals t
          left join lateral (
            select jsonb_build_object('at', c.at, 'status', c.status, 'amount', c.amount) as charge
              from (
                select tt.created_at as at,
                       case when tt.status = 'approved' then 'approved' else 'rejected' end as status,
                       tt.amount
                  from terminal_transactions tt
                 where tt.terminal_id = t.id and tt.op = 'sale'
                   and tt.status in ('approved', 'declined', 'error')
                 union all
                select coalesce(mi.updated_at, mi.created_at) as at, mi.status, mi.amount
                  from mp_payment_intents mi
                 where mi.tenant_id = v_tenant and mi.payment_terminal_id = t.id
                   and mi.status in ('approved', 'rejected')
              ) c
             order by c.at desc
             limit 1
          ) lc on true
         where t.tenant_id = v_tenant and t.store_id = s.id and t.deleted_at is null and t.active
      ) tm on true
      left join lateral (
        select jsonb_agg(jsonb_build_object(
                 'id', cr.id, 'name', cr.name,
                 'last_ping_at', h.last_ping_at, 'app_version', h.app_version,
                 'info', coalesce(h.info, '{}'::jsonb),
                 'user_name', coalesce(nullif(htu.display_name, ''), nullif(hu.full_name, ''), hu.email),
                 'shift_open', exists (select 1 from cash_shifts os
                                        where os.cash_register_id = cr.id and os.status = 'open'),
                 'last_sale_at', (select max(x.created_at)
                                    from sales x
                                    join cash_shifts xs on xs.id = x.cash_shift_id
                                   where xs.cash_register_id = cr.id and x.tenant_id = v_tenant
                                     and x.status = 'completed' and x.created_at >= v_from))
                 order by cr.sort, cr.created_at) as list
          from cash_registers cr
          left join register_heartbeats h on h.cash_register_id = cr.id
          left join public.users hu on hu.id = h.user_id
          left join tenant_users htu on htu.tenant_id = cr.tenant_id and htu.user_id = h.user_id
         where cr.store_id = s.id and cr.tenant_id = v_tenant
           and cr.deleted_at is null and coalesce(cr.is_active, true)
      ) hb on true
      left join lateral (
        select jsonb_build_object('closed_at', z.closed_at, 'difference', z.difference, 'z_number', z.z_number,
                                  'store_z_number', z.store_z_number) as z
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
