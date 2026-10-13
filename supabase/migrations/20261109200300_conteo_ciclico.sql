-- =============================================================================
-- 20261109200300_conteo_ciclico  (ADR-092 · F14 · H64)
--
-- Conteo cíclico por clase ABC. Feature OPTIONAL `conteo_ciclico` (Pro+).
--
--   A) cycle_count_policy: cada cuántos días se cuenta cada clase (A 7, B 30,
--      C 90), el corte de las clases por participación en la venta (A hasta
--      el 80 %, B hasta el 95 %), la ventana de ventas (90 días) y cuántos
--      productos por día se proponen (25).
--   B) cycle_counts + cycle_count_lines: cada conteo aplicado, con lo que
--      decía el sistema, lo contado, la diferencia en unidades y en pesos
--      (al costo) y la exactitud (líneas sin diferencia / líneas contadas).
--      Lectura del negocio con alcance de sucursal; sin escritura por REST;
--      role_write_guard 'manage' (ADR-071).
--   C) cycle_count_due(store): los productos de la sucursal que tocan contar
--      hoy, A primero y después los que hace más que no se cuentan. La clase
--      sale de la venta de la sucursal en la ventana (espejo de
--      lib/stock/cycleCount.ts). Último conteo: el último conteo cíclico o el
--      último movimiento 'count' de la sucursal (un conteo sin diferencia no
--      deja movimiento, por eso se guardan las líneas).
--   D) cycle_count_submit(store, lines, notes): aplica cada diferencia con
--      adjust_store_stock(..., 'set', 'count') (la vía única de conteo por
--      sucursal, que ya mueve el consolidado, deja el movimiento y audita) y
--      guarda el conteo. Dueño o encargado con acceso a la sucursal.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Política.
-- -----------------------------------------------------------------------------
create table if not exists cycle_count_policy (
  tenant_id     uuid primary key references tenants(id) on delete cascade,
  a_days        integer not null default 7 check (a_days between 1 and 365),
  b_days        integer not null default 30 check (b_days between 1 and 365),
  c_days        integer not null default 90 check (c_days between 1 and 365),
  a_share       numeric(5,2) not null default 80 check (a_share > 0 and a_share < 100),
  b_share       numeric(5,2) not null default 95 check (b_share > 0 and b_share <= 100),
  lookback_days integer not null default 90 check (lookback_days between 7 and 365),
  daily_items   integer not null default 25 check (daily_items between 1 and 200),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references users(id) on delete set null,
  check (a_share < b_share),
  check (a_days <= b_days and b_days <= c_days)
);
create index if not exists cycle_count_policy_updated_by_idx
  on cycle_count_policy (updated_by) where updated_by is not null;

alter table cycle_count_policy enable row level security;
drop policy if exists cycle_count_policy_select on cycle_count_policy;
create policy cycle_count_policy_select on cycle_count_policy
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
revoke insert, update, delete on cycle_count_policy from anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Conteos.
-- -----------------------------------------------------------------------------
create table if not exists cycle_counts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  store_id     uuid not null references stores(id),
  notes        text check (notes is null or char_length(notes) <= 300),
  lines_count  integer not null default 0,
  exact_count  integer not null default 0,
  accuracy_pct numeric(5,2),
  units_diff   numeric(14,3) not null default 0,
  value_diff   numeric(14,2) not null default 0,
  counted_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists cycle_counts_tenant_store_idx on cycle_counts (tenant_id, store_id, created_at desc);
create index if not exists cycle_counts_store_idx on cycle_counts (store_id);
create index if not exists cycle_counts_tenant_date_idx on cycle_counts (tenant_id, created_at desc);
create index if not exists cycle_counts_counted_by_idx on cycle_counts (counted_by) where counted_by is not null;

create table if not exists cycle_count_lines (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  count_id     uuid not null references cycle_counts(id) on delete cascade,
  store_id     uuid not null references stores(id),
  product_id   uuid not null references products(id) on delete cascade,
  variant_id   uuid references product_variants(id) on delete cascade,
  abc_class    text check (abc_class is null or abc_class in ('A', 'B', 'C')),
  expected_qty numeric(12,3) not null,
  counted_qty  numeric(12,3) not null check (counted_qty >= 0),
  diff_qty     numeric(12,3) not null,
  unit_cost    numeric(14,4),
  diff_value   numeric(14,2) not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists cycle_count_lines_count_idx on cycle_count_lines (count_id);
create index if not exists cycle_count_lines_last_idx
  on cycle_count_lines (store_id, product_id, variant_id, created_at desc);
create index if not exists cycle_count_lines_product_idx on cycle_count_lines (product_id);
create index if not exists cycle_count_lines_variant_idx on cycle_count_lines (variant_id) where variant_id is not null;
create index if not exists cycle_count_lines_tenant_idx on cycle_count_lines (tenant_id, created_at desc);

alter table cycle_counts enable row level security;
alter table cycle_count_lines enable row level security;

drop policy if exists cycle_counts_select on cycle_counts;
create policy cycle_counts_select on cycle_counts
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists cycle_counts_branch_scope on cycle_counts;
create policy cycle_counts_branch_scope on cycle_counts
  as restrictive for select
  using ((select internal_scope()) or store_id = any ((select user_allowed_store_ids())::uuid[]));

drop policy if exists cycle_count_lines_select on cycle_count_lines;
create policy cycle_count_lines_select on cycle_count_lines
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists cycle_count_lines_branch_scope on cycle_count_lines;
create policy cycle_count_lines_branch_scope on cycle_count_lines
  as restrictive for select
  using ((select internal_scope()) or store_id = any ((select user_allowed_store_ids())::uuid[]));

revoke insert, update, delete on cycle_counts, cycle_count_lines from anon, authenticated;

-- Permisos por rol (ADR-071): stock, modo 'manage'.
do $$
declare
  t text;
begin
  foreach t in array array['cycle_count_policy', 'cycle_counts', 'cycle_count_lines'] loop
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'manage');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Guard común.
-- -----------------------------------------------------------------------------
create or replace function _cycle_assert(p_store_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or coalesce(member_role_in(v_tenant), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'conteo_ciclico') then
    raise exception 'feature_not_in_plan: conteo_ciclico';
  end if;
  if p_store_id is not null then
    if not exists (select 1 from stores s where s.id = p_store_id and s.tenant_id = v_tenant
                     and s.deleted_at is null) then
      raise exception 'store_not_found';
    end if;
    if not user_can_access_store(p_store_id) then
      raise exception 'forbidden_store' using errcode = '42501';
    end if;
  end if;
  return v_tenant;
end;
$$;
revoke all on function _cycle_assert(uuid) from public, anon, authenticated;

create or replace function cycle_count_policy_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _cycle_assert(null);
  v        cycle_count_policy;
begin
  select * into v from cycle_count_policy where tenant_id = v_tenant;
  return jsonb_build_object(
    'a_days', coalesce(v.a_days, 7), 'b_days', coalesce(v.b_days, 30), 'c_days', coalesce(v.c_days, 90),
    'a_share', coalesce(v.a_share, 80), 'b_share', coalesce(v.b_share, 95),
    'lookback_days', coalesce(v.lookback_days, 90), 'daily_items', coalesce(v.daily_items, 25));
end;
$$;
revoke all on function cycle_count_policy_get() from public, anon;
grant execute on function cycle_count_policy_get() to authenticated;

create or replace function cycle_count_policy_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _cycle_assert(null);
  v_before jsonb := cycle_count_policy_get();
  v_after  jsonb;
begin
  if jsonb_typeof(coalesce(p, 'null'::jsonb)) <> 'object' then raise exception 'invalid_payload'; end if;
  insert into cycle_count_policy as c (tenant_id, a_days, b_days, c_days, a_share, b_share,
                                       lookback_days, daily_items, updated_at, updated_by)
  values (v_tenant,
          coalesce((p ->> 'a_days')::integer, (v_before ->> 'a_days')::integer),
          coalesce((p ->> 'b_days')::integer, (v_before ->> 'b_days')::integer),
          coalesce((p ->> 'c_days')::integer, (v_before ->> 'c_days')::integer),
          coalesce((p ->> 'a_share')::numeric, (v_before ->> 'a_share')::numeric),
          coalesce((p ->> 'b_share')::numeric, (v_before ->> 'b_share')::numeric),
          coalesce((p ->> 'lookback_days')::integer, (v_before ->> 'lookback_days')::integer),
          coalesce((p ->> 'daily_items')::integer, (v_before ->> 'daily_items')::integer),
          now(), auth.uid())
  on conflict (tenant_id) do update
    set a_days = excluded.a_days, b_days = excluded.b_days, c_days = excluded.c_days,
        a_share = excluded.a_share, b_share = excluded.b_share,
        lookback_days = excluded.lookback_days, daily_items = excluded.daily_items,
        updated_at = now(), updated_by = auth.uid();
  v_after := cycle_count_policy_get();
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'cycle_count_policy', v_tenant, 'cycle_count_policy_updated', v_before, v_after);
  return v_after;
end;
$$;
revoke all on function cycle_count_policy_save(jsonb) from public, anon;
grant execute on function cycle_count_policy_save(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Qué toca contar hoy.
-- -----------------------------------------------------------------------------
create or replace function cycle_count_due(p_store_id uuid, p_limit integer default null)
returns table (
  product_id      uuid,
  variant_id      uuid,
  product_name    text,
  variant_label   text,
  sku             text,
  unit            text,
  abc_class       text,
  sales_value     numeric,
  system_qty      numeric,
  last_counted_at timestamptz,
  due_days        integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_tenant uuid := _cycle_assert(p_store_id);
  v_pol    jsonb := cycle_count_policy_get();
  v_a      numeric := (v_pol ->> 'a_share')::numeric;
  v_b      numeric := (v_pol ->> 'b_share')::numeric;
  v_since  timestamptz := now() - make_interval(days => (v_pol ->> 'lookback_days')::integer);
begin
  if p_store_id is null then raise exception 'store_required'; end if;

  return query
  with items as (
    select p.id as pid, null::uuid as vid, p.name as pname, null::text as vlabel, p.sku as psku, p.unit as punit
      from products p
     where p.tenant_id = v_tenant and p.deleted_at is null and p.is_active
       and coalesce(p.track_stock, true) and not coalesce(p.is_kit, false)
       and not coalesce(p.has_variants, false)
    union all
    select p.id, v.id, p.name, v.option1 || coalesce(' / ' || v.option2, ''), coalesce(v.sku, p.sku), p.unit
      from product_variants v
      join products p on p.id = v.product_id
     where p.tenant_id = v_tenant and p.deleted_at is null and p.is_active
       and v.deleted_at is null and coalesce(p.track_stock, true) and coalesce(p.has_variants, false)
  ),
  sold as (
    select si.product_id as pid, si.variant_id as vid, sum(si.subtotal) as val
      from sale_items si
      join sales s on s.id = si.sale_id
     where s.tenant_id = v_tenant and s.store_id = p_store_id and s.status = 'completed'
       and s.created_at >= v_since and si.product_id is not null
     group by 1, 2
  ),
  ranked as (
    select i.*, greatest(coalesce(sd.val, 0), 0) as val,
           sum(greatest(coalesce(sd.val, 0), 0)) over (
             order by greatest(coalesce(sd.val, 0), 0) desc, i.pid, i.vid
             rows between unbounded preceding and 1 preceding) as before_cum,
           sum(greatest(coalesce(sd.val, 0), 0)) over () as tot
      from items i
      left join sold sd on sd.pid = i.pid and sd.vid is not distinct from i.vid
  ),
  cls as (
    select r.*,
           case when r.val <= 0 or r.tot <= 0 then 'C'
                when coalesce(r.before_cum, 0) * 100 / r.tot < v_a then 'A'
                when coalesce(r.before_cum, 0) * 100 / r.tot < v_b then 'B'
                else 'C' end as abc
      from ranked r
  ),
  last as (
    select c.*,
           greatest(
             (select max(l.created_at) from cycle_count_lines l
               where l.store_id = p_store_id and l.product_id = c.pid
                 and l.variant_id is not distinct from c.vid),
             (select max(m.created_at) from stock_movements m
               where m.tenant_id = v_tenant and m.store_id = p_store_id and m.reason = 'count'
                 and m.product_id = c.pid and m.variant_id is not distinct from c.vid)
           ) as last_at,
           case c.abc when 'A' then (v_pol ->> 'a_days')::integer
                      when 'B' then (v_pol ->> 'b_days')::integer
                      else (v_pol ->> 'c_days')::integer end as every_days
      from cls c
  )
  select l.pid, l.vid, l.pname, l.vlabel, l.psku, l.punit, l.abc, l.val,
         coalesce((select ps.qty from product_stock ps
                    where ps.store_id = p_store_id and ps.product_id = l.pid
                      and ps.variant_id is not distinct from l.vid), 0),
         l.last_at, l.every_days
    from last l
   where l.last_at is null or l.last_at <= now() - make_interval(days => l.every_days)
   order by l.abc, l.last_at asc nulls first, l.val desc, l.pname
   limit greatest(1, least(coalesce(p_limit, (v_pol ->> 'daily_items')::integer), 500));
end;
$$;
revoke all on function cycle_count_due(uuid, integer) from public, anon;
grant execute on function cycle_count_due(uuid, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Aplicar un conteo.
-- -----------------------------------------------------------------------------
create or replace function cycle_count_submit(p_store_id uuid, p_lines jsonb, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _cycle_assert(p_store_id);
  v_notes  text := nullif(btrim(coalesce(p_notes, '')), '');
  v_id     uuid;
  l        record;
  v_exp    numeric;
  v_cost   numeric;
  v_diff   numeric;
  v_n      integer := 0;
  v_exact  integer := 0;
  v_units  numeric := 0;
  v_value  numeric := 0;
  v_acc    numeric;
begin
  if p_store_id is null then raise exception 'store_required'; end if;
  if jsonb_typeof(coalesce(p_lines, 'null'::jsonb)) <> 'array'
     or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 300 then
    raise exception 'invalid_lines';
  end if;
  if v_notes is not null and char_length(v_notes) > 300 then raise exception 'notes_too_long'; end if;
  if (select count(*) from jsonb_to_recordset(p_lines) as x(product_id uuid, variant_id uuid))
     <> (select count(distinct (x.product_id, x.variant_id))
           from jsonb_to_recordset(p_lines) as x(product_id uuid, variant_id uuid)) then
    raise exception 'duplicate_lines';
  end if;

  insert into cycle_counts (tenant_id, store_id, notes, counted_by)
  values (v_tenant, p_store_id, v_notes, auth.uid())
  returning id into v_id;

  for l in
    select * from jsonb_to_recordset(p_lines)
      as x(product_id uuid, variant_id uuid, counted numeric, abc_class text)
  loop
    if l.product_id is null or l.counted is null or l.counted < 0 then
      raise exception 'invalid_qty';
    end if;
    select p.cost into v_cost from products p
     where p.id = l.product_id and p.tenant_id = v_tenant and p.deleted_at is null;
    if not found then raise exception 'product_not_found'; end if;

    select ps.qty into v_exp from product_stock ps
     where ps.store_id = p_store_id and ps.product_id = l.product_id
       and ps.variant_id is not distinct from l.variant_id
     for update;
    v_exp := coalesce(v_exp, 0);
    v_diff := l.counted - v_exp;

    if v_diff <> 0 then
      perform adjust_store_stock(p_store_id, l.product_id, l.variant_id, l.counted, 'set', 'count',
                                 coalesce(v_notes, 'Conteo cíclico'));
    end if;

    insert into cycle_count_lines (tenant_id, count_id, store_id, product_id, variant_id, abc_class,
                                   expected_qty, counted_qty, diff_qty, unit_cost, diff_value)
    values (v_tenant, v_id, p_store_id, l.product_id, l.variant_id,
            case when l.abc_class in ('A', 'B', 'C') then l.abc_class end,
            v_exp, l.counted, v_diff, v_cost, round(v_diff * coalesce(v_cost, 0), 2));

    v_n := v_n + 1;
    if v_diff = 0 then v_exact := v_exact + 1; end if;
    v_units := v_units + v_diff;
    v_value := v_value + round(v_diff * coalesce(v_cost, 0), 2);
  end loop;

  v_acc := round(v_exact::numeric * 100 / v_n, 2);
  update cycle_counts
     set lines_count = v_n, exact_count = v_exact, accuracy_pct = v_acc,
         units_diff = v_units, value_diff = v_value
   where id = v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (v_tenant, auth.uid(), 'cycle_counts', v_id, 'cycle_count_applied',
          jsonb_build_object('store_id', p_store_id, 'lines', v_n, 'exact', v_exact,
                             'accuracy_pct', v_acc, 'units_diff', v_units, 'value_diff', v_value),
          v_notes);

  return jsonb_build_object('id', v_id, 'lines', v_n, 'exact', v_exact, 'accuracy_pct', v_acc,
                            'units_diff', v_units, 'value_diff', v_value);
end;
$$;
revoke all on function cycle_count_submit(uuid, jsonb, text) from public, anon;
grant execute on function cycle_count_submit(uuid, jsonb, text) to authenticated;
