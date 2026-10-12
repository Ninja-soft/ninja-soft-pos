-- =============================================================================
-- 20261020130000_clientes_sucursal_alta  (F17 · H96 · ADR-057)
--
-- Clientes compartidos entre sucursales (la RLS no cambia: el cliente es del
-- negocio y se vende y se cobra en cualquier sucursal) con sucursal de alta y
-- estadísticas por sucursal.
--
--   A) customers.store_id_alta: sucursal donde se dio de alta. La completa un
--      trigger BEFORE INSERT con la sucursal actual del usuario
--      (user_current_store_id: su turno abierto → su sucursal base vigente →
--      su única sucursal permitida → la principal). Si el cliente manda una
--      sucursal (el POS manda la suya) se respeta sólo si es del negocio y el
--      usuario tiene acceso; si no, se deriva. Altas sin usuario (service
--      role, tiendita) quedan con la principal.
--   B) Backfill: la sucursal de la primera venta del cliente, o la principal.
--   C) customer_branch_stats(cliente): compras, total, ticket promedio,
--      última compra y devoluciones por sucursal, acotado a las sucursales que
--      el usuario puede ver (report_store_filter).
-- =============================================================================

alter table customers add column if not exists store_id_alta uuid references stores(id) on delete set null;
create index if not exists customers_store_alta_idx
  on customers (tenant_id, store_id_alta) where deleted_at is null;

-- -----------------------------------------------------------------------------
-- Sucursal actual del usuario del JWT
-- -----------------------------------------------------------------------------
create or replace function user_current_store_id()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_store   uuid;
  v_allowed uuid[];
begin
  if v_tenant is null then return null; end if;
  if auth.uid() is not null then
    select cs.store_id into v_store from cash_shifts cs
     where cs.tenant_id = v_tenant and cs.opened_by = auth.uid() and cs.status = 'open'
     order by cs.opened_at desc limit 1;
    if v_store is not null then return v_store; end if;

    select a.store_id into v_store from staff_branch_assignments a
      join stores s on s.id = a.store_id and s.deleted_at is null
     where a.tenant_id = v_tenant and a.user_id = auth.uid() and a.deleted_at is null
       and a.valid_from <= branch_today()
       and (a.valid_until is null or a.valid_until >= branch_today())
     order by (a.kind = 'cover') desc, (a.kind = 'home') desc, a.valid_from desc
     limit 1;
    if v_store is not null then return v_store; end if;

    v_allowed := user_allowed_store_ids();
    if cardinality(v_allowed) = 1 then return v_allowed[1]; end if;
  end if;
  select id into v_store from stores
   where tenant_id = v_tenant and deleted_at is null
   order by is_default desc, created_at limit 1;
  return v_store;
end;
$$;
revoke all on function user_current_store_id() from public, anon;
grant execute on function user_current_store_id() to authenticated;

create or replace function customers_fill_store_alta()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.store_id_alta is not null then
    if not exists (select 1 from stores s where s.id = new.store_id_alta and s.tenant_id = new.tenant_id)
       or (auth.uid() is not null and not coalesce(user_can_access_store(new.store_id_alta), false)) then
      new.store_id_alta := null;
    end if;
  end if;
  if new.store_id_alta is null then
    if auth.uid() is not null and new.tenant_id = current_tenant_id() then
      new.store_id_alta := user_current_store_id();
    else
      select id into new.store_id_alta from stores
       where tenant_id = new.tenant_id and deleted_at is null
       order by is_default desc, created_at limit 1;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists customers_fill_store_alta on customers;
create trigger customers_fill_store_alta
  before insert on customers
  for each row execute function customers_fill_store_alta();

-- La sucursal de alta tiene que ser del negocio también al editar.
create or replace function customers_store_alta_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.store_id_alta is not null and new.store_id_alta is distinct from old.store_id_alta
     and not exists (select 1 from stores s where s.id = new.store_id_alta and s.tenant_id = new.tenant_id) then
    raise exception 'store_not_in_tenant' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists customers_store_alta_guard on customers;
create trigger customers_store_alta_guard
  before update of store_id_alta on customers
  for each row execute function customers_store_alta_guard();

-- -----------------------------------------------------------------------------
-- B) Backfill (idempotente). Sin tocar updated_at.
-- -----------------------------------------------------------------------------
alter table customers disable trigger set_updated_at_customers;
update customers c
   set store_id_alta = coalesce(
         (select sa.store_id from sales sa
           where sa.customer_id = c.id and sa.tenant_id = c.tenant_id and sa.store_id is not null
           order by sa.created_at limit 1),
         (select s.id from stores s
           where s.tenant_id = c.tenant_id and s.deleted_at is null
           order by s.is_default desc, s.created_at limit 1))
 where c.store_id_alta is null;
alter table customers enable trigger set_updated_at_customers;

-- -----------------------------------------------------------------------------
-- C) Estadísticas del cliente por sucursal
-- -----------------------------------------------------------------------------
create or replace function customer_branch_stats(p_customer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_ids    uuid[];
  v_alta   uuid;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  select store_id_alta into v_alta from customers where id = p_customer and tenant_id = v_tenant;
  if not found then raise exception 'customer_not_found'; end if;
  v_ids := report_store_filter(null);

  return jsonb_build_object(
    'store_id_alta', v_alta,
    'by_store', coalesce((
      select jsonb_agg(jsonb_build_object(
               'store_id', st.id, 'name', st.name, 'short_name', st.short_name, 'color', st.color,
               'count', x.cnt, 'total', x.total,
               'avg_ticket', case when x.cnt > 0 then round(x.total / x.cnt, 2) else 0 end,
               'last_at', x.last_at, 'first_at', x.first_at,
               'returns_total', coalesce(rt.total, 0))
               order by x.total desc)
        from (
          select sa.store_id, count(*) as cnt, sum(sa.total) as total,
                 max(sa.created_at) as last_at, min(sa.created_at) as first_at
            from sales sa
           where sa.tenant_id = v_tenant and sa.customer_id = p_customer and sa.status = 'completed'
             and (v_ids is null or sa.store_id = any (v_ids))
           group by sa.store_id
        ) x
        join stores st on st.id = x.store_id
        left join lateral (
          select sum(r.total) as total
            from sale_returns r join sales s2 on s2.id = r.sale_id
           where r.tenant_id = v_tenant and s2.customer_id = p_customer and s2.store_id = x.store_id
        ) rt on true), '[]'::jsonb));
end;
$$;
revoke all on function customer_branch_stats(uuid) from public, anon;
grant execute on function customer_branch_stats(uuid) to authenticated;

comment on column customers.store_id_alta is
  'F17 · H96 · ADR-057: sucursal donde se dio de alta el cliente (trigger customers_fill_store_alta). El cliente es del negocio.';
