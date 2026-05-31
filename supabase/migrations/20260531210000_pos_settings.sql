-- =============================================================================
-- 20260531210000_pos_settings  (H30 v1 — settings operativos del POS)
-- Tabla de settings por tenant + override de venta en negativo por producto.
-- create_sale aplica: descuento máximo por rol, redondeo del total y bloqueo de
-- stock negativo (salvo permitido). Basado en la create_sale viva (serial/kits/
-- track_stock) — no regresiona esos comportamientos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- pos_settings — una fila por tenant. RLS: miembros leen, owner/manager escriben.
-- max_discount: % máximo de descuento global por rol.
-- rounding_multiple: redondeo del total (0 = sin redondeo).
-- allow_negative_stock: permitir vender sin stock (global).
-- blind_close / close_tolerance / sku_*: usados por H30 PR2.
-- -----------------------------------------------------------------------------
create table if not exists pos_settings (
  tenant_id            uuid primary key references tenants(id) on delete cascade,
  max_discount         jsonb not null default '{"owner":100,"manager":100,"cashier":100,"viewer":100}'::jsonb,
  rounding_multiple    numeric not null default 0,
  allow_negative_stock boolean not null default true,
  blind_close          boolean not null default false,
  close_tolerance      numeric not null default 0,
  sku_auto             boolean not null default false,
  sku_prefix           text not null default '',
  updated_at           timestamptz not null default now()
);
alter table pos_settings enable row level security;

create trigger set_updated_at_pos_settings
  before update on pos_settings
  for each row execute function set_updated_at();

create policy pos_settings_select on pos_settings
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy pos_settings_write on pos_settings
  for all
  using (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active'
      and me.role in ('owner','manager')))
  with check (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active'
      and me.role in ('owner','manager')));

-- Override de venta en negativo por producto. null = usa el global del tenant.
alter table products add column if not exists allow_negative boolean;

-- -----------------------------------------------------------------------------
-- create_sale — agrega descuento máximo por rol, redondeo y bloqueo de negativo.
-- -----------------------------------------------------------------------------
create or replace function create_sale(
  p_items          jsonb,
  p_payments       jsonb,
  p_discount_total numeric default 0,
  p_customer_id    uuid default null,
  p_notes          text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_store    uuid;
  v_shift    uuid;
  v_number   bigint;
  v_subtotal numeric := 0;
  v_total    numeric;
  v_total_pre numeric;
  v_paid     numeric := 0;
  v_sale_id  uuid;
  v_item     record;
  v_pay      record;
  v_comp     record;
  v_pname    text;
  v_psku     text;
  v_is_kit   boolean;
  v_track    boolean;
  v_serial   text;
  v_role     text;
  v_max_disc numeric := 100;
  v_round    numeric := 0;
  v_allow_neg boolean := true;
  v_disc_pct numeric;
  v_pallow   boolean;
  v_stock    numeric;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  select id into v_store
  from stores
  where tenant_id = v_tenant and deleted_at is null
  order by is_default desc, created_at
  limit 1;
  if v_store is null then
    raise exception 'no_store';
  end if;

  select cs.id into v_shift
  from cash_shifts cs
  join cash_registers cr on cr.id = cs.cash_register_id
  where cs.tenant_id = v_tenant and cs.status = 'open' and cr.store_id = v_store
  order by cs.opened_at desc
  limit 1;
  if v_shift is null then
    raise exception 'no_open_shift';
  end if;

  -- Rol del usuario + settings del POS.
  select role into v_role
  from tenant_users
  where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  limit 1;

  select coalesce((ps.max_discount ->> coalesce(v_role, 'cashier'))::numeric, 100),
         coalesce(ps.rounding_multiple, 0),
         coalesce(ps.allow_negative_stock, false)
    into v_max_disc, v_round, v_allow_neg
  from pos_settings ps
  where ps.tenant_id = v_tenant;
  if not found then
    v_max_disc := 100; v_round := 0; v_allow_neg := true;
  end if;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_price numeric, discount numeric)
  loop
    v_subtotal := v_subtotal
      + (coalesce(v_item.unit_price, 0) * coalesce(v_item.quantity, 0))
      - coalesce(v_item.discount, 0);
  end loop;

  if v_subtotal <= 0 then
    raise exception 'empty_sale';
  end if;

  -- Descuento global máximo por rol.
  if coalesce(p_discount_total, 0) > 0 and v_subtotal > 0 then
    v_disc_pct := coalesce(p_discount_total, 0) / v_subtotal * 100;
    if v_disc_pct > v_max_disc + 0.001 then
      raise exception 'discount_exceeds_limit';
    end if;
  end if;

  v_total_pre := v_subtotal - coalesce(p_discount_total, 0);

  -- Redondeo del total (al múltiplo configurado). El delta se absorbe en
  -- discount_total para mantener subtotal - discount_total = total.
  if v_round > 0 then
    v_total := round(v_total_pre / v_round) * v_round;
  else
    v_total := v_total_pre;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments) as x(method text, amount numeric)
  loop
    v_paid := v_paid + coalesce(v_pay.amount, 0);
  end loop;
  if v_paid < v_total then
    raise exception 'insufficient_payment';
  end if;

  select coalesce(max(number), 0) + 1 into v_number
  from sales where tenant_id = v_tenant;

  insert into sales (store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total, 0, v_total, p_notes)
  returning id into v_sale_id;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, name text, serial text, quantity numeric, unit_price numeric, discount numeric)
  loop
    if v_item.product_id is not null then
      select p.name, p.sku, p.is_kit, p.track_stock
        into v_pname, v_psku, v_is_kit, v_track
      from products p
      where p.id = v_item.product_id and p.tenant_id = v_tenant;
      if not found then
        raise exception 'product_not_found';
      end if;
    else
      v_pname  := coalesce(nullif(btrim(v_item.name), ''), 'Venta rápida');
      v_psku   := null;
      v_is_kit := false;
      v_track  := false;
    end if;

    v_serial := nullif(btrim(coalesce(v_item.serial, '')), '');

    insert into sale_items (sale_id, product_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal)
    values (v_sale_id, v_item.product_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0));

    if v_item.product_id is not null then
      if v_is_kit then
        for v_comp in
          select pkc.component_product_id, pkc.quantity,
                 pr.stock as comp_stock, pr.allow_negative as comp_allow, pr.track_stock as comp_track
          from product_kit_components pkc
          join products pr on pr.id = pkc.component_product_id and pr.tenant_id = v_tenant
          where pkc.kit_product_id = v_item.product_id and pkc.tenant_id = v_tenant
        loop
          if v_comp.comp_track then
            if not coalesce(v_comp.comp_allow, v_allow_neg)
               and v_comp.comp_stock < (v_item.quantity * v_comp.quantity) then
              raise exception 'insufficient_stock';
            end if;
            update products
               set stock = stock - (v_item.quantity * v_comp.quantity), updated_at = now()
             where id = v_comp.component_product_id and tenant_id = v_tenant;

            insert into stock_movements (product_id, store_id, delta, reason, reference_id)
            values (v_comp.component_product_id, v_store,
                    -(v_item.quantity * v_comp.quantity), 'sale', v_sale_id);
          end if;
        end loop;
      else
        if v_track then
          select stock, allow_negative into v_stock, v_pallow
          from products where id = v_item.product_id and tenant_id = v_tenant;
          if not coalesce(v_pallow, v_allow_neg) and v_stock < v_item.quantity then
            raise exception 'insufficient_stock';
          end if;

          update products
             set stock = stock - v_item.quantity, updated_at = now()
           where id = v_item.product_id and tenant_id = v_tenant;

          insert into stock_movements (product_id, store_id, delta, reason, reference_id)
          values (v_item.product_id, v_store, -v_item.quantity, 'sale', v_sale_id);
        end if;

        if v_serial is not null then
          update product_serials
             set status = 'sold', sale_id = v_sale_id
           where product_id = v_item.product_id and tenant_id = v_tenant
             and serial = v_serial and status = 'in_stock';
          if not found then
            insert into product_serials (product_id, serial, status, sale_id)
            values (v_item.product_id, v_serial, 'sold', v_sale_id)
            on conflict (product_id, serial) do update
              set status = 'sold', sale_id = v_sale_id;
          end if;
        end if;
      end if;
    end if;
  end loop;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text)
  loop
    insert into payments (sale_id, method, amount, reference)
    values (v_sale_id, v_pay.method, v_pay.amount, v_pay.reference);

    insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
    values (v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total);
end;
$$;
