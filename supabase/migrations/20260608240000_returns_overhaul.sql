-- =============================================================================
-- 20260608240000_returns_overhaul  (Devoluciones PRO)
-- -----------------------------------------------------------------------------
-- Sobre la base H29 (sale_returns / sale_return_items / store_credit_movements /
-- return_reasons), suma:
--   1) Motivos con DESTINO de stock medible y auditable (resale/warehouse/loss/
--      review) + código único por tenant + baja lógica. Seed de motivos default.
--   2) Política de devolución por tenant (cashier_choice/always_credit/always_cash)
--      y validez del vale en meses (null = sin vencimiento), en pos_settings.
--   3) Vales con CÓDIGO único canjeable: store_credit_vouchers (code, expires_at,
--      allowed_branch_ids para multi-sucursal, status). Respaldados por el ledger
--      store_credit_movements existente (canje acredita saldo al cliente).
--   4) return_sale_v2: aplica destino por motivo, política, emite vale con código,
--      y AUDITA todo (devolución, vale emitido, reingreso de stock con destino).
--   5) redeem_store_credit_voucher: canje por código en el POS (valida vencimiento,
--      estado y sucursal) → acredita saldo a favor del cliente + audita.
-- No regresiona return_sale (H29) ni create_sale: son funciones nuevas/aditivas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) return_reasons — destino de stock + código + baja lógica.
-- -----------------------------------------------------------------------------
alter table return_reasons
  add column if not exists code              text,
  add column if not exists stock_destination text not null default 'resale',
  add column if not exists deleted_at        timestamptz;

-- Destinos válidos. 'resale' reingresa a stock vendible; 'warehouse' deja el
-- producto fuera de venta (a depósito/revisión); 'loss' es merma (no reingresa).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.return_reasons'::regclass
      and conname = 'return_reasons_stock_destination_check'
  ) then
    alter table return_reasons
      add constraint return_reasons_stock_destination_check
      check (stock_destination in ('resale','warehouse','loss','review'));
  end if;
end $$;

-- Código único por tenant (entre los no eliminados).
create unique index if not exists uq_return_reasons_tenant_code
  on return_reasons(tenant_id, code) where deleted_at is null and code is not null;

-- -----------------------------------------------------------------------------
-- Seed de motivos default por tenant. Idempotente: respeta los códigos ya
-- existentes (no pisa lo que el comercio editó). Mapea destino de stock típico.
-- -----------------------------------------------------------------------------
create or replace function seed_default_return_reasons(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into return_reasons (tenant_id, label, code, stock_destination, sort, is_active)
  select p_tenant, d.label, d.code, d.dest, d.sort, true
  from (values
    ('Arrepentimiento',        'arrepentimiento', 'resale',    10),
    ('Cambio de talle/color',  'talle_color',     'resale',    20),
    ('Producto fallado',       'fallado',         'loss',      30),
    ('Producto defectuoso',    'defectuoso',      'warehouse', 40),
    ('Error de carga',         'error_carga',     'resale',    50),
    ('Producto equivocado',    'equivocado',      'resale',    60),
    ('Garantía',               'garantia',        'warehouse', 70)
  ) as d(label, code, dest, sort)
  where not exists (
    select 1 from return_reasons r
    where r.tenant_id = p_tenant and r.code = d.code and r.deleted_at is null
  );
end;
$$;
revoke all on function seed_default_return_reasons(uuid) from public, anon;
grant execute on function seed_default_return_reasons(uuid) to authenticated;

-- Backfill: siembra defaults en todos los tenants existentes que aún no tengan
-- motivos cargados (no toca a quien ya configuró sus motivos).
do $$
declare t record;
begin
  for t in
    select id from tenants
    where not exists (
      select 1 from return_reasons r where r.tenant_id = tenants.id and r.deleted_at is null
    )
  loop
    perform seed_default_return_reasons(t.id);
  end loop;
end $$;

-- Tenants nuevos: el bootstrap siempre crea una sucursal (stores). Al insertarse
-- la primera store del tenant, sembramos los motivos default si no hay ninguno.
create or replace function seed_return_reasons_on_store()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from return_reasons r where r.tenant_id = new.tenant_id and r.deleted_at is null
  ) then
    perform seed_default_return_reasons(new.tenant_id);
  end if;
  return new;
end;
$$;
revoke all on function seed_return_reasons_on_store() from public, anon;

drop trigger if exists seed_return_reasons_after_store on stores;
create trigger seed_return_reasons_after_store
  after insert on stores
  for each row execute function seed_return_reasons_on_store();

-- -----------------------------------------------------------------------------
-- 2) Política de devolución + validez del vale, por tenant (pos_settings).
--   return_policy: 'cashier_choice' (default) | 'always_credit' | 'always_cash'.
--   voucher_validity_months: null = vale sin vencimiento.
-- -----------------------------------------------------------------------------
alter table pos_settings
  add column if not exists return_policy           text not null default 'cashier_choice',
  add column if not exists voucher_validity_months int;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pos_settings'::regclass
      and conname = 'pos_settings_return_policy_check'
  ) then
    alter table pos_settings
      add constraint pos_settings_return_policy_check
      check (return_policy in ('cashier_choice','always_credit','always_cash'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pos_settings'::regclass
      and conname = 'pos_settings_voucher_validity_check'
  ) then
    alter table pos_settings
      add constraint pos_settings_voucher_validity_check
      check (voucher_validity_months is null or voucher_validity_months between 1 and 120);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 3) Vales con código único canjeable. El saldo "vive" en store_credit_movements
--    (ledger por cliente, ya usado por create_sale). El voucher es el documento
--    canjeable: al canjearlo, se acredita el ledger del cliente que lo presenta.
--    allowed_branch_ids: null = vale válido en cualquier sucursal.
-- -----------------------------------------------------------------------------
create table if not exists store_credit_vouchers (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  code              text not null,
  amount            numeric(12,2) not null check (amount > 0),
  customer_id       uuid references customers(id),
  status            text not null default 'active' check (status in ('active','redeemed','void')),
  expires_at        timestamptz,
  allowed_branch_ids uuid[],
  sale_return_id    uuid references sale_returns(id),
  redeemed_at       timestamptz,
  redeemed_by       uuid references public.users(id),
  redeemed_customer_id uuid references customers(id),
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid() references public.users(id)
);
create unique index if not exists uq_store_credit_vouchers_code
  on store_credit_vouchers(tenant_id, code);
create index if not exists store_credit_vouchers_tenant_idx
  on store_credit_vouchers(tenant_id, created_at desc);
create index if not exists store_credit_vouchers_customer_idx
  on store_credit_vouchers(tenant_id, customer_id);

alter table store_credit_vouchers enable row level security;
create policy store_credit_vouchers_select on store_credit_vouchers
  for select using (tenant_id = current_tenant_id() or is_internal());
create policy store_credit_vouchers_insert on store_credit_vouchers
  for insert with check (tenant_id = current_tenant_id());
-- Sin UPDATE/DELETE desde el cliente: el canje pasa por la RPC (security definer).

-- Vincula el movimiento de saldo con el vale que lo originó (trazabilidad).
alter table store_credit_movements
  add column if not exists voucher_id uuid references store_credit_vouchers(id);

-- Generador de código de vale: VAL- + 8 chars base32 sin ambigüedad (sin O/0/I/1).
create or replace function gen_voucher_code()
returns text
language plpgsql
volatile
as $$
declare
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code     text;
  i          int;
begin
  loop
    v_code := 'VAL-';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from store_credit_vouchers where code = v_code);
  end loop;
  return v_code;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4) return_sale_v2 — devolución PRO. Usa el motivo (return_reasons) para fijar
--    el destino de stock, aplica la política del tenant, emite vale con código
--    (+ scoping de sucursales) y AUDITA cada paso.
--    p_items: [{sale_item_id, quantity}]  (el destino lo define el motivo)
--    p_reason_id: motivo elegido (define stock_destination)
--    p_refund: 'cash' | 'store_credit' (la política puede forzarlo)
--    p_customer_id: cliente a asociar si la venta no tenía (para el vale)
--    p_allowed_branch_ids: sucursales donde vale el comprobante (null = todas)
-- -----------------------------------------------------------------------------
create or replace function return_sale_v2(
  p_sale_id            uuid,
  p_items              jsonb,
  p_reason_id          uuid    default null,
  p_refund             text    default 'cash',
  p_customer_id        uuid    default null,
  p_allowed_branch_ids uuid[]  default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_sale     record;
  v_reason   record;
  v_dest     text := 'resale';
  v_reason_label text;
  v_store    uuid;
  v_shift    uuid;
  v_number   bigint;
  v_total    numeric := 0;
  v_ret      uuid;
  v_it       record;
  v_si       record;
  v_unit     numeric;
  v_qty      numeric;
  v_line     numeric;
  v_ratio    numeric := 1;
  v_policy   text := 'cashier_choice';
  v_validity int;
  v_refund   text;
  v_customer uuid;
  v_voucher_id uuid;
  v_voucher_code text;
  v_expires  timestamptz;
  v_restock  text;  -- mapeo a sale_return_items.restock (stock/review/discard)
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if p_refund not in ('cash','store_credit') then raise exception 'invalid_refund'; end if;

  select * into v_sale from sales where id = p_sale_id and tenant_id = v_tenant;
  if not found then raise exception 'sale_not_found'; end if;
  if v_sale.status <> 'completed' then raise exception 'sale_not_returnable'; end if;

  -- Política y validez de vale del tenant.
  select coalesce(return_policy, 'cashier_choice'), voucher_validity_months
    into v_policy, v_validity
  from pos_settings where tenant_id = v_tenant;
  if not found then v_policy := 'cashier_choice'; end if;

  -- La política puede forzar el medio de reintegro.
  v_refund := p_refund;
  if v_policy = 'always_credit' then v_refund := 'store_credit';
  elsif v_policy = 'always_cash' then v_refund := 'cash';
  end if;

  -- Cliente del vale: el de la venta, o el que se carga en la devolución.
  v_customer := coalesce(v_sale.customer_id, p_customer_id);
  if v_refund = 'store_credit' and v_customer is null then
    raise exception 'store_credit_needs_customer';
  end if;

  -- Motivo → destino de stock.
  if p_reason_id is not null then
    select * into v_reason from return_reasons
      where id = p_reason_id and tenant_id = v_tenant and deleted_at is null;
    if found then
      v_dest := coalesce(v_reason.stock_destination, 'resale');
      v_reason_label := v_reason.label;
    end if;
  end if;
  -- resale → reingresa al inventario; warehouse/loss → no reingresa (queda
  -- registrado el destino para medirlo). sale_return_items.restock guarda el
  -- mapeo: resale='stock', warehouse='review', loss='discard'.
  v_restock := case v_dest
                 when 'resale' then 'stock'
                 when 'warehouse' then 'review'
                 when 'review' then 'review'
                 else 'discard'
               end;

  -- Proporción real pagada (descuento global + redondeo absorbido).
  if v_sale.subtotal is not null and v_sale.subtotal > 0 then
    v_ratio := v_sale.total / v_sale.subtotal;
  end if;

  select id into v_store from stores
   where tenant_id = v_tenant and deleted_at is null
   order by is_default desc, created_at limit 1;

  if v_refund = 'cash' then
    select cs.id into v_shift from cash_shifts cs
      join cash_registers cr on cr.id = cs.cash_register_id
     where cs.tenant_id = v_tenant and cs.status = 'open' and cr.store_id = v_store
     order by cs.opened_at desc limit 1;
    if v_shift is null then raise exception 'no_open_shift'; end if;
  end if;

  select coalesce(max(number), 0) + 1 into v_number from sale_returns where tenant_id = v_tenant;
  insert into sale_returns (sale_id, customer_id, number, reason, refund_method, total)
  values (p_sale_id, v_customer, v_number, v_reason_label, v_refund, 0)
  returning id into v_ret;

  for v_it in
    select * from jsonb_to_recordset(p_items) as x(sale_item_id uuid, quantity numeric)
  loop
    v_qty := coalesce(v_it.quantity, 0);
    if v_qty <= 0 then continue; end if;

    -- Lock de la línea (anti doble-devolución concurrente).
    select * into v_si from sale_items
      where id = v_it.sale_item_id and sale_id = p_sale_id for update;
    if not found then raise exception 'item_not_found'; end if;
    if v_qty > (v_si.quantity - coalesce(v_si.returned_qty, 0)) then
      raise exception 'qty_exceeds';
    end if;

    v_unit := case when v_si.quantity > 0 then v_si.subtotal / v_si.quantity else v_si.unit_price end;
    v_line := round(v_unit * v_qty * v_ratio, 2);
    v_total := v_total + v_line;

    insert into sale_return_items (return_id, sale_item_id, product_id, quantity, unit_price, subtotal, restock)
    values (v_ret, v_si.id, v_si.product_id, v_qty, v_unit, v_line, v_restock);

    update sale_items set returned_qty = coalesce(returned_qty, 0) + v_qty where id = v_si.id;

    -- Solo 'resale' reingresa stock vendible. warehouse/loss NO reingresan.
    if v_dest = 'resale' and v_si.product_id is not null then
      update products set stock = stock + v_qty, updated_at = now()
        where id = v_si.product_id and tenant_id = v_tenant and track_stock;
      if found then
        insert into stock_movements (tenant_id, product_id, store_id, delta, reason, reference_id)
        values (v_tenant, v_si.product_id, v_store, v_qty, 'return', v_ret);
        -- Auditoría: reingreso de stock con destino.
        insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
        values (v_tenant, auth.uid(), 'stock_movements', v_si.product_id, 'return_restock',
          jsonb_build_object('return_id', v_ret, 'product_id', v_si.product_id,
            'qty', v_qty, 'destination', v_dest));
      end if;
    end if;
  end loop;

  if v_total <= 0 then raise exception 'empty_return'; end if;
  update sale_returns set total = v_total where id = v_ret;

  -- Reintegro: efectivo (sale de caja) o vale (emite voucher + acredita ledger).
  if v_refund = 'cash' then
    insert into cash_movements (cash_shift_id, type, amount, payment_method, reason, reference_id)
    values (v_shift, 'expense', v_total, 'cash', 'Devolución venta #' || v_sale.number, v_ret);
  else
    -- Vencimiento del vale por la validez configurada (null = sin vencimiento).
    v_expires := case when v_validity is not null
                      then now() + make_interval(months => v_validity)
                      else null end;
    v_voucher_code := gen_voucher_code();
    insert into store_credit_vouchers
      (tenant_id, code, amount, customer_id, status, expires_at, allowed_branch_ids, sale_return_id)
    values
      (v_tenant, v_voucher_code, v_total, v_customer, 'active', v_expires, p_allowed_branch_ids, v_ret)
    returning id into v_voucher_id;

    -- El saldo se acredita al cliente del vale (igual que H29, + voucher_id).
    insert into store_credit_movements (customer_id, delta, reason, sale_return_id, voucher_id)
    values (v_customer, v_total, 'Vale ' || v_voucher_code || ' (dev #' || v_number || ')', v_ret, v_voucher_id);

    -- Auditoría: vale emitido.
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'store_credit_vouchers', v_voucher_id, 'voucher_issued',
      jsonb_build_object('code', v_voucher_code, 'amount', v_total, 'customer_id', v_customer,
        'expires_at', v_expires, 'allowed_branch_ids', p_allowed_branch_ids, 'return_id', v_ret));
  end if;

  -- Auditoría: devolución creada.
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'sale_returns', v_ret, 'return_created',
    jsonb_build_object('number', v_number, 'sale_id', p_sale_id, 'total', v_total,
      'refund', v_refund, 'reason_id', p_reason_id, 'stock_destination', v_dest));

  return jsonb_build_object(
    'return_id', v_ret, 'number', v_number, 'total', v_total,
    'refund', v_refund, 'stock_destination', v_dest,
    'voucher_code', v_voucher_code, 'voucher_expires_at', v_expires
  );
end;
$$;
revoke all on function return_sale_v2(uuid, jsonb, uuid, text, uuid, uuid[]) from public, anon;
grant execute on function return_sale_v2(uuid, jsonb, uuid, text, uuid, uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
-- 5) redeem_store_credit_voucher — canje por código (POS). Valida vencimiento,
--    estado y sucursal; acredita el saldo a favor al cliente que lo presenta y
--    marca el vale como canjeado. Idempotente por estado (un vale = un canje).
--    p_code: código del vale.  p_customer_id: cliente al que se acredita.
--    p_store_id: sucursal donde se canjea (para validar allowed_branch_ids).
-- -----------------------------------------------------------------------------
create or replace function redeem_store_credit_voucher(
  p_code        text,
  p_customer_id uuid default null,
  p_store_id    uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_v       record;
  v_target  uuid;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if p_code is null or btrim(p_code) = '' then raise exception 'voucher_not_found'; end if;

  select * into v_v from store_credit_vouchers
    where tenant_id = v_tenant and upper(btrim(code)) = upper(btrim(p_code))
    for update;
  if not found then raise exception 'voucher_not_found'; end if;
  if v_v.status = 'redeemed' then raise exception 'voucher_already_redeemed'; end if;
  if v_v.status = 'void' then raise exception 'voucher_void'; end if;
  if v_v.expires_at is not null and v_v.expires_at < now() then
    raise exception 'voucher_expired';
  end if;
  -- Scoping de sucursal: si el vale limita sucursales, la de canje debe estar.
  if v_v.allowed_branch_ids is not null and array_length(v_v.allowed_branch_ids, 1) is not null then
    if p_store_id is null or not (p_store_id = any (v_v.allowed_branch_ids)) then
      raise exception 'voucher_wrong_branch';
    end if;
  end if;

  -- Cliente destino del saldo: el del vale, o el indicado al canjear.
  v_target := coalesce(v_v.customer_id, p_customer_id);
  if v_target is null then raise exception 'voucher_needs_customer'; end if;

  update store_credit_vouchers
     set status = 'redeemed', redeemed_at = now(), redeemed_by = auth.uid(),
         redeemed_customer_id = v_target
   where id = v_v.id;

  -- Acredita el saldo a favor al cliente que canjea (ledger).
  insert into store_credit_movements (customer_id, delta, reason, voucher_id)
  values (v_target, v_v.amount, 'Canje vale ' || v_v.code, v_v.id);

  -- Auditoría: vale canjeado.
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'store_credit_vouchers', v_v.id, 'voucher_redeemed',
    jsonb_build_object('code', v_v.code, 'amount', v_v.amount, 'customer_id', v_target,
      'store_id', p_store_id));

  return jsonb_build_object('voucher_id', v_v.id, 'amount', v_v.amount, 'customer_id', v_target);
end;
$$;
revoke all on function redeem_store_credit_voucher(text, uuid, uuid) from public, anon;
grant execute on function redeem_store_credit_voucher(text, uuid, uuid) to authenticated;

-- Lookup de vale por código (POS): datos seguros para previsualizar antes de
-- canjear (monto, estado efectivo, cliente). No expone otros tenants (RLS).
create or replace function lookup_store_credit_voucher(p_code text)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select case when v.id is null then null else jsonb_build_object(
    'id', v.id,
    'code', v.code,
    'amount', v.amount,
    'customer_id', v.customer_id,
    'allowed_branch_ids', v.allowed_branch_ids,
    'expires_at', v.expires_at,
    'status', case
      when v.status <> 'active' then v.status
      when v.expires_at is not null and v.expires_at < now() then 'expired'
      else 'active' end
  ) end
  from (
    select * from store_credit_vouchers
    where tenant_id = current_tenant_id()
      and upper(btrim(code)) = upper(btrim(p_code))
    limit 1
  ) v;
$$;
revoke all on function lookup_store_credit_voucher(text) from public, anon;
grant execute on function lookup_store_credit_voucher(text) to authenticated;
