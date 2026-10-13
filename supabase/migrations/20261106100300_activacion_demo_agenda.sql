-- =============================================================================
-- 20261106100300_activacion_demo_agenda  (ADR-082 · F12 · H42)
--
-- 1) internal_tenant_activation(p_tenant): métricas de activación de un negocio
--    para el panel interno (hitos con fecha). Sólo staff interno con el scope
--    del panel (internal_scope(), ADR-052): un usuario interno parado en el
--    panel de un negocio no la puede llamar.
--      - alta del negocio y primer cobro real (venta completada), minutos
--        entre ambos y cantidad de ventas;
--      - primer turno agendado y cantidad de turnos;
--      - primer cliente recurrente (momento de la segunda venta completada de
--        un mismo cliente);
--      - primer pack de sesiones vendido;
--      - botones favoritos cargados y su participación en las líneas vendidas
--        de los últimos 30 días.
--    Taps y segundos por venta no se miden (no hay instrumentación): deuda.
--
-- 2) Datos de ejemplo de la agenda (agenda_demo_seed / agenda_demo_clear):
--    para mostrar un negocio de servicios funcionando en minutos. Dueño o
--    encargado, con la feature `agenda`. Siembra dos profesionales, dos
--    clientes, cuatro turnos de hoy con los servicios del catálogo (o nombres
--    de ejemplo si no hay), un recurso si el plan tiene `agenda_recursos` y
--    una entrada de lista de espera si tiene `lista_espera`. Cada fila queda
--    registrada en agenda_demo_rows para quitarla después:
--      - turnos y entradas de espera sin venta: borrado físico (son datos
--        sintéticos, ADR-082); un turno demo ya cobrado se conserva;
--      - profesionales, clientes y recursos: baja lógica (deleted_at).
--    Las dos acciones quedan en audit_logs.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Activación
-- -----------------------------------------------------------------------------
create or replace function internal_tenant_activation(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_created   timestamptz;
  v_first     timestamptz;
  v_sales     int;
  v_first_ap  timestamptz;
  v_appts     int;
  v_recurrent timestamptz;
  v_pack      timestamptz;
  v_favs      int;
  v_lines     numeric;
  v_fav_lines numeric;
begin
  if not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select created_at into v_created from tenants where id = p_tenant;
  if not found then
    raise exception 'tenant_not_found';
  end if;

  select min(created_at), count(*)::int into v_first, v_sales
    from sales where tenant_id = p_tenant and status = 'completed';

  select min(created_at), count(*)::int into v_first_ap, v_appts
    from appointments where tenant_id = p_tenant;

  select min(x.created_at) into v_recurrent
    from (
      select s.created_at,
             row_number() over (partition by s.customer_id order by s.created_at) as n
        from sales s
       where s.tenant_id = p_tenant and s.status = 'completed' and s.customer_id is not null
    ) x
   where x.n = 2;

  select min(created_at) into v_pack from customer_pack_credits where tenant_id = p_tenant;

  select count(*)::int into v_favs
    from products where tenant_id = p_tenant and is_favorite and deleted_at is null;

  select count(*), count(*) filter (where p.is_favorite)
    into v_lines, v_fav_lines
    from sale_items si
    join sales s on s.id = si.sale_id
    left join products p on p.id = si.product_id
   where si.tenant_id = p_tenant
     and s.status = 'completed'
     and s.created_at >= now() - interval '30 days';

  return jsonb_build_object(
    'tenant_created_at', v_created,
    'first_sale_at', v_first,
    'minutes_to_first_sale', case when v_first is null then null
                                  else greatest(0, floor(extract(epoch from (v_first - v_created)) / 60))::int end,
    'sales_count', v_sales,
    'first_appointment_at', v_first_ap,
    'appointments_count', v_appts,
    'first_recurring_customer_at', v_recurrent,
    'first_pack_sold_at', v_pack,
    'favorites_count', v_favs,
    'favorite_lines_share_30d', case when coalesce(v_lines, 0) = 0 then null
                                     else round(v_fav_lines / v_lines, 4) end
  );
end;
$$;
revoke all on function internal_tenant_activation(uuid) from public, anon;
grant execute on function internal_tenant_activation(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 2) Datos de ejemplo de la agenda
-- -----------------------------------------------------------------------------
create table if not exists agenda_demo_rows (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  entity     text not null check (entity in ('professionals', 'customers', 'appointments', 'agenda_resources', 'agenda_waitlist')),
  row_id     uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists agenda_demo_rows_tenant_idx on agenda_demo_rows (tenant_id);

alter table agenda_demo_rows enable row level security;
drop policy if exists agenda_demo_rows_select on agenda_demo_rows;
create policy agenda_demo_rows_select on agenda_demo_rows
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
-- Sin policies de escritura: sólo las RPC.

create or replace function _agenda_demo_assert()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if coalesce(agenda_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'agenda') then
    raise exception 'feature_not_in_plan: agenda' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _agenda_demo_assert() from public, anon, authenticated;

create or replace function agenda_demo_seed()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := _agenda_demo_assert();
  v_tz       text := 'America/Argentina/Buenos_Aires';
  v_day      date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_prof1    uuid;
  v_prof2    uuid;
  v_cust1    uuid;
  v_cust2    uuid;
  v_res      uuid;
  v_wait     uuid;
  v_appt     uuid;
  v_services jsonb;
  v_svc      jsonb;
  v_slots    text[] := array['10:00', '11:30', '15:00', '17:30'];
  v_i        int;
  v_count    int := 0;
begin
  if exists (select 1 from agenda_demo_rows where tenant_id = v_tenant) then
    return jsonb_build_object('seeded', false, 'already', true);
  end if;

  insert into professionals (tenant_id, name, color, commission_pct, sort)
  values (v_tenant, 'Sofía (ejemplo)', '#ff5a2c', 40, 900)
  returning id into v_prof1;
  insert into professionals (tenant_id, name, color, commission_pct, sort)
  values (v_tenant, 'Martín (ejemplo)', '#38bdf8', 35, 901)
  returning id into v_prof2;
  insert into agenda_demo_rows (tenant_id, entity, row_id) values
    (v_tenant, 'professionals', v_prof1), (v_tenant, 'professionals', v_prof2);

  insert into customers (tenant_id, name, phone, notes)
  values (v_tenant, 'Ana López (ejemplo)', '1155550101', 'Cliente de ejemplo')
  returning id into v_cust1;
  insert into customers (tenant_id, name, phone, notes)
  values (v_tenant, 'Lucía Gómez (ejemplo)', '1155550102', 'Cliente de ejemplo')
  returning id into v_cust2;
  insert into agenda_demo_rows (tenant_id, entity, row_id) values
    (v_tenant, 'customers', v_cust1), (v_tenant, 'customers', v_cust2);

  if tenant_has_feature_for(v_tenant, 'agenda_recursos') then
    insert into agenda_resources (tenant_id, name, kind, sort)
    values (v_tenant, 'Sillón 1 (ejemplo)', 'silla', 900)
    returning id into v_res;
    insert into agenda_demo_rows (tenant_id, entity, row_id) values (v_tenant, 'agenda_resources', v_res);
  end if;

  -- Servicios del catálogo (los que tienen duración o no llevan stock); si no
  -- hay, nombres de ejemplo sin producto.
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_services
    from (
      select p.id, p.name, p.price, coalesce(p.service_duration_min, 30) as dur, p.commission_pct
        from products p
       where p.tenant_id = v_tenant and p.deleted_at is null and p.is_active
         and (p.service_duration_min is not null or p.track_stock = false)
       order by (p.service_duration_min is not null) desc, p.is_favorite desc, p.name
       limit 3
    ) x;
  if jsonb_array_length(v_services) = 0 then
    v_services := '[{"id":null,"name":"Corte","price":8000,"dur":30,"commission_pct":null},
                    {"id":null,"name":"Color","price":18000,"dur":90,"commission_pct":null},
                    {"id":null,"name":"Brushing","price":6000,"dur":30,"commission_pct":null}]'::jsonb;
  end if;

  for v_i in 1..4 loop
    v_svc := v_services -> ((v_i - 1) % jsonb_array_length(v_services));
    insert into appointments (
      tenant_id, professional_id, customer_id, service_product_id, service_name,
      service_price, commission_pct, starts_at, duration_min, status, notes, resource_id
    ) values (
      v_tenant,
      case when v_i % 2 = 1 then v_prof1 else v_prof2 end,
      case when v_i % 2 = 1 then v_cust1 else v_cust2 end,
      nullif(v_svc ->> 'id', '')::uuid,
      v_svc ->> 'name',
      coalesce((v_svc ->> 'price')::numeric, 0),
      coalesce((v_svc ->> 'commission_pct')::numeric,
               case when v_i % 2 = 1 then 40 else 35 end),
      (v_day + v_slots[v_i]::time) at time zone v_tz,
      coalesce((v_svc ->> 'dur')::int, 30),
      case when v_i <= 2 then 'confirmado' else 'reservado' end,
      'Turno de ejemplo',
      case when v_i = 1 then v_res end
    )
    returning id into v_appt;
    insert into agenda_demo_rows (tenant_id, entity, row_id) values (v_tenant, 'appointments', v_appt);
    v_count := v_count + 1;
  end loop;

  if tenant_has_feature_for(v_tenant, 'lista_espera') then
    insert into agenda_waitlist (tenant_id, customer_name, phone, service_name, preferred_date, preferred_slot, notes)
    values (v_tenant, 'Paula Díaz (ejemplo)', '1155550103', v_services -> 0 ->> 'name', v_day, 'tarde',
            'Entrada de ejemplo')
    returning id into v_wait;
    insert into agenda_demo_rows (tenant_id, entity, row_id) values (v_tenant, 'agenda_waitlist', v_wait);
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'agenda', null, 'agenda_demo_seeded',
          jsonb_build_object('appointments', v_count, 'resource', v_res is not null, 'waitlist', v_wait is not null));

  return jsonb_build_object('seeded', true, 'already', false, 'appointments', v_count,
                            'professionals', 2, 'customers', 2,
                            'resource', v_res is not null, 'waitlist', v_wait is not null);
end;
$$;
revoke all on function agenda_demo_seed() from public, anon;
grant execute on function agenda_demo_seed() to authenticated;

create or replace function agenda_demo_clear()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _agenda_demo_assert();
  v_appts  int;
  v_kept   int;
begin
  delete from agenda_waitlist w
   using agenda_demo_rows d
   where d.tenant_id = v_tenant and d.entity = 'agenda_waitlist'
     and w.id = d.row_id and w.tenant_id = v_tenant;

  select count(*)::int into v_kept
    from appointments a join agenda_demo_rows d on d.row_id = a.id
   where d.tenant_id = v_tenant and d.entity = 'appointments' and a.sale_id is not null;

  with del as (
    delete from appointments a
     using agenda_demo_rows d
     where d.tenant_id = v_tenant and d.entity = 'appointments'
       and a.id = d.row_id and a.tenant_id = v_tenant and a.sale_id is null
    returning a.id
  )
  select count(*)::int into v_appts from del;

  update professionals p set deleted_at = now(), is_active = false
    from agenda_demo_rows d
   where d.tenant_id = v_tenant and d.entity = 'professionals'
     and p.id = d.row_id and p.tenant_id = v_tenant and p.deleted_at is null;

  update customers c set deleted_at = now()
    from agenda_demo_rows d
   where d.tenant_id = v_tenant and d.entity = 'customers'
     and c.id = d.row_id and c.tenant_id = v_tenant and c.deleted_at is null;

  update agenda_resources r set deleted_at = now(), is_active = false
    from agenda_demo_rows d
   where d.tenant_id = v_tenant and d.entity = 'agenda_resources'
     and r.id = d.row_id and r.tenant_id = v_tenant and r.deleted_at is null;

  delete from agenda_demo_rows where tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'agenda', null, 'agenda_demo_cleared',
          jsonb_build_object('appointments_deleted', v_appts, 'appointments_kept', v_kept));

  return jsonb_build_object('cleared', true, 'appointments_deleted', v_appts, 'appointments_kept', v_kept);
end;
$$;
revoke all on function agenda_demo_clear() from public, anon;
grant execute on function agenda_demo_clear() to authenticated;
