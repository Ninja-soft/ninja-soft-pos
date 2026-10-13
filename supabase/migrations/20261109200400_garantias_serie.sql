-- =============================================================================
-- 20261109200400_garantias_serie  (ADR-092 · F14 · H64)
--
-- Garantías por número de serie. Feature OPTIONAL `garantias_serie` (Pro+).
--
--   A) serial_lookup(serial): busca la serie en las líneas vendidas
--      (sale_items.serial, la escribe create_sale) y en las series en stock
--      (product_serials). Por cada venta devuelve producto, fecha, sucursal,
--      cliente, garantía de fábrica (products.warranty_months), garantía
--      extendida vendida en el mismo ticket (línea "Garantía <plan>" con el
--      plan de warranty_plans, meses extra que se suman a los de fábrica),
--      fecha de vencimiento, si está vigente y los reclamos de esa serie.
--      Cualquier miembro operativo (el cajero atiende el mostrador de
--      posventa).
--   B) serial_warranty_claims: reclamo de posventa por serie con estado
--      (abierto, en reparación, resuelto, rechazado), motivo, resolución y si
--      estaba en garantía al abrirlo. Escritura sólo por RPC:
--      serial_claim_open (miembro operativo) y serial_claim_update (dueño o
--      encargado), auditadas. role_write_guard 'operate'.
--
-- Índice parcial nuevo en sale_items para buscar por serie sin recorrer la
-- tabla (sólo las líneas que tienen serie).
-- =============================================================================

create index if not exists sale_items_serial_lookup_idx
  on sale_items (tenant_id, upper(btrim(serial)))
  where serial is not null;

create index if not exists product_serials_lookup_idx
  on product_serials (tenant_id, upper(btrim(serial)));

-- -----------------------------------------------------------------------------
-- B) Reclamos.
-- -----------------------------------------------------------------------------
create table if not exists serial_warranty_claims (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  serial         text not null check (char_length(serial) between 3 and 80),
  product_id     uuid references products(id) on delete set null,
  sale_id        uuid references sales(id) on delete set null,
  store_id       uuid references stores(id) on delete set null,
  customer_id    uuid references customers(id) on delete set null,
  in_warranty    boolean not null default false,
  warranty_until date,
  status         text not null default 'open'
                   check (status in ('open', 'in_repair', 'resolved', 'rejected')),
  reason         text not null check (char_length(reason) between 3 and 500),
  resolution     text check (resolution is null or char_length(resolution) <= 500),
  opened_by      uuid references users(id) on delete set null,
  resolved_by    uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  resolved_at    timestamptz
);
create index if not exists serial_claims_tenant_idx on serial_warranty_claims (tenant_id, created_at desc);
create index if not exists serial_claims_status_idx on serial_warranty_claims (tenant_id, status);
create index if not exists serial_claims_serial_idx on serial_warranty_claims (tenant_id, upper(serial));
create index if not exists serial_claims_product_idx on serial_warranty_claims (product_id) where product_id is not null;
create index if not exists serial_claims_sale_idx on serial_warranty_claims (sale_id) where sale_id is not null;
create index if not exists serial_claims_store_idx on serial_warranty_claims (store_id) where store_id is not null;
create index if not exists serial_claims_customer_idx on serial_warranty_claims (customer_id) where customer_id is not null;
create index if not exists serial_claims_opened_by_idx on serial_warranty_claims (opened_by) where opened_by is not null;
create index if not exists serial_claims_resolved_by_idx on serial_warranty_claims (resolved_by) where resolved_by is not null;

alter table serial_warranty_claims enable row level security;
drop policy if exists serial_claims_select on serial_warranty_claims;
create policy serial_claims_select on serial_warranty_claims
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
revoke insert, update, delete on serial_warranty_claims from anon, authenticated;

drop trigger if exists role_write_guard on serial_warranty_claims;
create trigger role_write_guard
  before insert or update or delete on serial_warranty_claims
  for each row execute function trg_role_write_guard('operate');

-- -----------------------------------------------------------------------------
-- Guard común: miembro operativo (o dueño/encargado) con la feature.
-- -----------------------------------------------------------------------------
create or replace function _serial_assert(p_managers boolean default false)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text;
begin
  v_role := case when v_tenant is null then null else member_role_in(v_tenant) end;
  if v_role is null
     or (p_managers and v_role not in ('owner', 'manager'))
     or (not p_managers and v_role not in ('owner', 'manager', 'cashier')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'garantias_serie') then
    raise exception 'feature_not_in_plan: garantias_serie';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _serial_assert(boolean) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- A) Consulta (espejo de lib/stock/serialWarranty.ts).
-- -----------------------------------------------------------------------------
create or replace function serial_lookup(p_serial text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _serial_assert(false);
  v_s      text := upper(btrim(coalesce(p_serial, '')));
  v_today  date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_out    jsonb;
begin
  if char_length(v_s) < 3 then raise exception 'serial_too_short'; end if;

  with sold as (
    select si.id as line_id, si.sale_id, si.product_id, si.product_name, si.serial,
           si.quantity, si.returned_qty,
           s.number, s.status as sale_status, s.store_id, s.customer_id, s.created_at,
           (s.created_at at time zone 'America/Argentina/Buenos_Aires')::date as sale_date,
           coalesce(p.warranty_months, 0) as mf_months
      from sale_items si
      join sales s on s.id = si.sale_id
      left join products p on p.id = si.product_id
     where si.tenant_id = v_tenant and si.serial is not null and upper(btrim(si.serial)) = v_s
     order by s.created_at desc
     limit 10
  ),
  enriched as (
    select so.*,
           ext.label as ext_label, coalesce(ext.months, 0) as ext_months,
           st.name as store_name, c.name as customer_name
      from sold so
      left join lateral (
        select wp.label, wp.months
          from sale_items gi
          join warranty_plans wp on wp.tenant_id = v_tenant
           and gi.product_name ilike ('Garant%' || wp.label)
         where gi.sale_id = so.sale_id and gi.product_id is null
         order by wp.months desc
         limit 1
      ) ext on true
      left join stores st on st.id = so.store_id
      left join customers c on c.id = so.customer_id
  ),
  dated as (
    select e.*,
           case when e.mf_months + e.ext_months > 0
                then (e.sale_date + make_interval(months => e.mf_months + e.ext_months))::date end as until,
           case when e.mf_months > 0
                then (e.sale_date + make_interval(months => e.mf_months))::date end as mf_until
      from enriched e
  )
  select jsonb_build_object(
    'serial', v_s,
    'sales', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_id', d.line_id, 'sale_id', d.sale_id, 'sale_number', d.number,
               'sale_status', d.sale_status, 'sold_at', d.created_at, 'sale_date', d.sale_date,
               'product_id', d.product_id, 'product_name', d.product_name, 'serial', d.serial,
               'returned', coalesce(d.returned_qty, 0) >= d.quantity,
               'store_id', d.store_id, 'store_name', d.store_name,
               'customer_id', d.customer_id, 'customer_name', d.customer_name,
               'manufacturer_months', d.mf_months, 'manufacturer_until', d.mf_until,
               'extended_label', d.ext_label, 'extended_months', d.ext_months,
               'warranty_until', d.until,
               'in_warranty', d.sale_status = 'completed'
                              and coalesce(d.returned_qty, 0) < d.quantity
                              and d.until is not null and d.until >= v_today)
             order by d.created_at desc)
        from dated d), '[]'::jsonb),
    'in_stock', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', ps.product_id, 'product_name', p.name,
                                          'serial', ps.serial, 'status', ps.status))
        from product_serials ps
        join products p on p.id = ps.product_id
       where ps.tenant_id = v_tenant and upper(btrim(ps.serial)) = v_s and ps.status = 'in_stock'), '[]'::jsonb),
    'claims', coalesce((
      select jsonb_agg(to_jsonb(cl) order by cl.created_at desc)
        from serial_warranty_claims cl
       where cl.tenant_id = v_tenant and upper(cl.serial) = v_s), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function serial_lookup(text) from public, anon;
grant execute on function serial_lookup(text) to authenticated;

create or replace function serial_claim_open(p_serial text, p_reason text, p_sale_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _serial_assert(false);
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_info   jsonb;
  v_sale   jsonb;
  v_id     uuid;
begin
  if v_reason is null or char_length(v_reason) < 3 then raise exception 'reason_required'; end if;
  if char_length(v_reason) > 500 then raise exception 'reason_too_long'; end if;
  v_info := serial_lookup(p_serial);

  -- La venta elegida o la más reciente de la serie.
  select x into v_sale
    from jsonb_array_elements(v_info -> 'sales') x
   where p_sale_id is null or (x ->> 'sale_id')::uuid = p_sale_id
   limit 1;
  if p_sale_id is not null and v_sale is null then raise exception 'sale_not_found'; end if;

  insert into serial_warranty_claims (tenant_id, serial, product_id, sale_id, store_id, customer_id,
                                      in_warranty, warranty_until, reason, opened_by)
  values (v_tenant, v_info ->> 'serial',
          coalesce((v_sale ->> 'product_id')::uuid, (v_info -> 'in_stock' -> 0 ->> 'product_id')::uuid),
          (v_sale ->> 'sale_id')::uuid, (v_sale ->> 'store_id')::uuid, (v_sale ->> 'customer_id')::uuid,
          coalesce((v_sale ->> 'in_warranty')::boolean, false), (v_sale ->> 'warranty_until')::date,
          v_reason, auth.uid())
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (v_tenant, auth.uid(), 'serial_warranty_claims', v_id, 'serial_claim_opened',
          jsonb_build_object('serial', v_info ->> 'serial', 'sale_id', v_sale ->> 'sale_id',
                             'in_warranty', coalesce((v_sale ->> 'in_warranty')::boolean, false),
                             'warranty_until', v_sale ->> 'warranty_until'),
          v_reason);
  return v_id;
end;
$$;
revoke all on function serial_claim_open(text, text, uuid) from public, anon;
grant execute on function serial_claim_open(text, text, uuid) to authenticated;

create or replace function serial_claim_update(p_id uuid, p_status text, p_resolution text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _serial_assert(true);
  v_old    serial_warranty_claims;
  v_res    text := nullif(btrim(coalesce(p_resolution, '')), '');
begin
  if p_status not in ('open', 'in_repair', 'resolved', 'rejected') then raise exception 'invalid_status'; end if;
  if p_status in ('resolved', 'rejected') and v_res is null then raise exception 'resolution_required'; end if;
  if v_res is not null and char_length(v_res) > 500 then raise exception 'resolution_too_long'; end if;

  select * into v_old from serial_warranty_claims where id = p_id and tenant_id = v_tenant for update;
  if v_old.id is null then raise exception 'claim_not_found'; end if;
  if v_old.status in ('resolved', 'rejected') then raise exception 'claim_closed'; end if;

  update serial_warranty_claims
     set status = p_status,
         resolution = coalesce(v_res, resolution),
         updated_at = now(),
         resolved_at = case when p_status in ('resolved', 'rejected') then now() end,
         resolved_by = case when p_status in ('resolved', 'rejected') then auth.uid() end
   where id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'serial_warranty_claims', p_id, 'serial_claim_updated',
          jsonb_build_object('status', v_old.status),
          jsonb_build_object('status', p_status, 'resolution', coalesce(v_res, v_old.resolution)),
          v_res);
end;
$$;
revoke all on function serial_claim_update(uuid, text, text) from public, anon;
grant execute on function serial_claim_update(uuid, text, text) to authenticated;
