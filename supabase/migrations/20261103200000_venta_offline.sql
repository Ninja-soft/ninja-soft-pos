-- =============================================================================
-- 20261103200000_venta_offline  (F3 · Venta offline · ADR-077)
--
-- El POS sigue vendiendo sin conexión con NinjaSoft y sincroniza al volver.
-- Diseño completo: docs/34-venta-offline.md.
--
--   A) pos_settings.offline_policy: política del dueño (prendida, monto
--      máximo por venta, ventas máximas por turno y antigüedad máxima).
--      FLAG-OPERATIVO (CLAUDE.md §6): no es feature de plan; el servidor la
--      aplica al sincronizar. offline_policy_save (dueño o encargado, audita).
--   B) sales.offline_sold_at / sales.offline_client_id: la venta sabe que se
--      hizo sin conexión, cuándo, y con qué id del POS (único por negocio).
--   C) offline_sales: bandeja de ventas offline recibidas. Idempotente por
--      (tenant_id, client_sale_id). Nada se pierde: lo que no se puede
--      registrar queda en 'needs_review' para el dueño. RLS por negocio
--      (ADR-052: `tenant_id = current_tenant_id() or internal_scope()`),
--      cajero sólo ve las suyas, alcance de sucursal. Escritura sólo por RPC.
--   D) create_sale: copia de 20261028100300_impuestos_venta (la definición
--      más nueva) con el modo offline (GUC transaccional ninja.offline_sync,
--      que sólo prende _offline_run_sale): el precio cobrado se respeta y el
--      stock puede quedar negativo; las dos cosas vuelven como conflictos en
--      `offline_conflicts`. Sin el GUC es idéntica a la anterior.
--   E) sync_offline_sale: la RPC que llama el POS al reconectar. Valida
--      negocio, usuario, turno del negocio, política y medios; registra la
--      venta con create_sale (wrapper, no duplica la lógica) y audita los
--      conflictos y los rechazos.
--   F) offline_sale_resolve: el dueño o encargado reintenta (en su caja),
--      descarta con motivo, marca como resuelta o da por vista una venta con
--      diferencias. Auditado.
--
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Política offline del negocio
-- -----------------------------------------------------------------------------
create or replace function offline_policy_defaults()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object('enabled', true, 'max_amount', 50000, 'max_sales', 20, 'max_hours', 48);
$$;
grant execute on function offline_policy_defaults() to authenticated;

-- Valida la forma de la política. null = válida. Claves ausentes = default.
create or replace function offline_policy_error(p jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_n numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return 'offline_policy_not_object'; end if;
  if p ? 'enabled' and jsonb_typeof(p -> 'enabled') <> 'boolean' then return 'offline_policy_enabled'; end if;
  if p ? 'max_amount' then
    if jsonb_typeof(p -> 'max_amount') <> 'number' then return 'offline_policy_max_amount'; end if;
    v_n := (p ->> 'max_amount')::numeric;
    if v_n < 0 or v_n > 100000000 then return 'offline_policy_max_amount'; end if;
  end if;
  if p ? 'max_sales' then
    if jsonb_typeof(p -> 'max_sales') <> 'number' then return 'offline_policy_max_sales'; end if;
    v_n := (p ->> 'max_sales')::numeric;
    if v_n < 1 or v_n > 500 or v_n <> trunc(v_n) then return 'offline_policy_max_sales'; end if;
  end if;
  if p ? 'max_hours' then
    if jsonb_typeof(p -> 'max_hours') <> 'number' then return 'offline_policy_max_hours'; end if;
    v_n := (p ->> 'max_hours')::numeric;
    if v_n < 1 or v_n > 168 or v_n <> trunc(v_n) then return 'offline_policy_max_hours'; end if;
  end if;
  return null;
end;
$$;
grant execute on function offline_policy_error(jsonb) to authenticated;

alter table pos_settings add column if not exists offline_policy jsonb not null default '{}'::jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pos_settings_offline_policy_check') then
    alter table pos_settings add constraint pos_settings_offline_policy_check
      check (offline_policy_error(offline_policy) is null);
  end if;
end;
$$;

-- Política efectiva: defaults pisados por lo que guardó el dueño.
create or replace function offline_policy_effective(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select offline_policy_defaults()
         || coalesce((select ps.offline_policy from pos_settings ps where ps.tenant_id = p_tenant), '{}'::jsonb);
$$;
revoke all on function offline_policy_effective(uuid) from public, anon, authenticated;

-- Guardado por el dueño o encargado (valida y audita).
create or replace function offline_policy_save(p_policy jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_before jsonb;
  v_new    jsonb;
  v_err    text;
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  if not exists (select 1 from tenant_users tu
                  where tu.tenant_id = v_tenant and tu.user_id = auth.uid()
                    and tu.status = 'active' and tu.role in ('owner', 'manager')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_new := offline_policy_defaults()
           || (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
                 from jsonb_each(coalesce(p_policy, '{}'::jsonb)) as e(k, v)
                where k in ('enabled', 'max_amount', 'max_sales', 'max_hours'));
  v_err := offline_policy_error(v_new);
  if v_err is not null then raise exception '%', v_err; end if;

  v_before := offline_policy_effective(v_tenant);
  insert into pos_settings (tenant_id, offline_policy)
  values (v_tenant, v_new)
  on conflict (tenant_id) do update set offline_policy = excluded.offline_policy;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'pos_settings', null, 'offline_policy_saved', v_before, v_new);
  return v_new;
end;
$$;
revoke all on function offline_policy_save(jsonb) from public, anon;
grant execute on function offline_policy_save(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Marcas offline en la venta
-- -----------------------------------------------------------------------------
alter table sales add column if not exists offline_sold_at timestamptz;
alter table sales add column if not exists offline_client_id uuid;
create unique index if not exists sales_offline_client_uniq
  on sales (tenant_id, offline_client_id) where offline_client_id is not null;
comment on column sales.offline_sold_at is
  'ADR-077: momento real de la venta hecha sin conexión (created_at es el de la sincronización).';
comment on column sales.offline_client_id is
  'ADR-077: id que generó el POS para la venta offline (idempotencia, único por negocio).';

-- -----------------------------------------------------------------------------
-- C) Bandeja de ventas offline
-- -----------------------------------------------------------------------------
create table if not exists offline_sales (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  -- Id que generó el POS (crypto.randomUUID): clave de idempotencia.
  client_sale_id  uuid not null,
  submitted_by    uuid references public.users(id) on delete set null,
  cash_shift_id   uuid references cash_shifts(id) on delete set null,
  store_id        uuid references stores(id) on delete set null,
  -- Parámetros de create_sale tal como los armó el POS (sin secretos).
  payload         jsonb not null,
  -- sold_at, user_id, device_id, total, payload_hash, integrity, snapshot_at.
  meta            jsonb not null default '{}'::jsonb,
  sold_at         timestamptz not null,
  -- processing: tomada por la RPC · synced: venta registrada ·
  -- needs_review: no se pudo registrar, la revisa el dueño ·
  -- resolved: el dueño la resolvió por otro lado · discarded: descartada con motivo.
  status          text not null default 'processing'
                    check (status in ('processing', 'synced', 'needs_review', 'resolved', 'discarded')),
  reasons         text[] not null default '{}',
  error           text,
  -- Diferencias con las que se registró: precio cambiado, stock negativo.
  conflicts       jsonb not null default '[]'::jsonb,
  sale_id         uuid references sales(id) on delete set null,
  sale_number     bigint,
  sale_total      numeric(12,2),
  attempts        int not null default 0,
  processed_at    timestamptz,
  reviewed_at     timestamptz,
  resolved_by     uuid references public.users(id) on delete set null,
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists offline_sales_client_uniq on offline_sales (tenant_id, client_sale_id);
create index if not exists offline_sales_tenant_idx on offline_sales (tenant_id, created_at desc);
create index if not exists offline_sales_review_idx on offline_sales (tenant_id)
  where status = 'needs_review' or (status = 'synced' and reviewed_at is null and conflicts <> '[]'::jsonb);
create index if not exists offline_sales_shift_idx on offline_sales (cash_shift_id, submitted_by);
create index if not exists offline_sales_submitted_by_idx on offline_sales (submitted_by) where submitted_by is not null;
create index if not exists offline_sales_store_idx on offline_sales (store_id) where store_id is not null;
create index if not exists offline_sales_sale_idx on offline_sales (sale_id) where sale_id is not null;
create index if not exists offline_sales_resolved_by_idx on offline_sales (resolved_by) where resolved_by is not null;

drop trigger if exists set_updated_at_offline_sales on offline_sales;
create trigger set_updated_at_offline_sales
  before update on offline_sales
  for each row execute function set_updated_at();

alter table offline_sales enable row level security;
drop policy if exists offline_sales_select on offline_sales;
create policy offline_sales_select on offline_sales
  for select using (tenant_id = current_tenant_id() or internal_scope());
-- El cajero ve sólo las suyas; dueño y encargado, todas.
drop policy if exists offline_sales_owner_scope on offline_sales;
create policy offline_sales_owner_scope on offline_sales
  as restrictive for select
  using (
    internal_scope()
    or submitted_by = (select auth.uid())
    or exists (select 1 from tenant_users tu
                where tu.tenant_id = offline_sales.tenant_id and tu.user_id = (select auth.uid())
                  and tu.status = 'active' and tu.role in ('owner', 'manager'))
  );
-- Alcance de sucursal: como las ventas.
drop policy if exists offline_sales_branch on offline_sales;
create policy offline_sales_branch on offline_sales
  as restrictive for select
  using (internal_scope() or store_id is null or store_id = any ((select user_allowed_store_ids())::uuid[]));
revoke insert, update, delete on offline_sales from anon, authenticated;
grant select on offline_sales to authenticated;

comment on table offline_sales is
  'ADR-077: ventas hechas sin conexión recibidas del POS. Escritura sólo por RPC (sync_offline_sale, offline_sale_resolve).';

-- -----------------------------------------------------------------------------
-- D) create_sale con modo offline
-- -----------------------------------------------------------------------------
-- Copia de 20261102100300_promociones_venta (la más nueva: impuestos F18 +
-- promociones F9/ADR-074) + bloques ADR-077:
--   * v_offline: GUC transaccional ninja.offline_sync (sólo _offline_run_sale).
--   * Precio distinto al de lista: se respeta el cobrado y se anota el
--     conflicto 'price_changed' (sale_items.list_price guarda el de lista).
--   * Stock insuficiente: se vende igual (queda negativo) y se anota
--     'negative_stock' / 'negative_stock_branch'.
--   * Promociones: se evalúan a la hora real de la venta (ninja.offline_sold_at).
--     Si el motor ya no da lo mismo, se respeta lo cobrado (una fila en
--     sale_promotions con la promo que mandó el POS) y se anota 'promo_changed'
--     (también para un regalo que ya no corresponde). Nunca promo_mismatch.
--   * Devuelve 'offline_conflicts' (null fuera del modo offline).
create or replace function public.create_sale(p_items jsonb, p_payments jsonb, p_discount_total numeric DEFAULT 0, p_customer_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_extras jsonb DEFAULT '[]'::jsonb, p_table_order_id uuid DEFAULT NULL::uuid, p_delivery_order_id uuid DEFAULT NULL::uuid, p_promo_discount numeric DEFAULT 0, p_promo_id uuid DEFAULT NULL::uuid, p_promo_name text DEFAULT NULL::text, p_coupon_id uuid DEFAULT NULL::uuid, p_cash_shift_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_has_variants boolean;
  v_variant  record;
  v_serial   text;
  v_role     text;
  v_max_disc numeric := 100;
  v_round    numeric := 0;
  v_allow_neg boolean := true;
  -- F17 · H92/H94 (ADR-049): settings efectivos y stock por sucursal.
  v_reg        uuid;
  v_eff        jsonb;
  v_branch_stk boolean := false;
  v_disc_pct numeric;
  v_pallow   boolean;
  v_stock    numeric;
  v_sc_total numeric := 0;
  v_sc_bal   numeric;
  v_pay_feat text;
  v_line_disc numeric := 0;
  v_warranty_prima numeric := 0;
  v_tip_amount numeric := 0;
  v_tip_method text;
  v_professional uuid;
  v_pack     record;
  v_pcredit  record;
  v_pk       service_packs%rowtype;
  v_has_pack_session boolean := false;
  v_table_order table_orders%rowtype;
  v_delivery_order delivery_orders%rowtype;
  v_delivery_fee numeric := 0;
  v_intent   record;
  v_qr_ref   uuid;
  v_qr_sum   numeric;
  v_qr_plain boolean := false;
  v_promo_disc numeric := 0;
  v_coupon_disc numeric := 0;
  v_coupon   coupons%rowtype;
  -- F18 · H100 (ADR-056): precio autoritativo.
  v_pc          boolean := coalesce(current_setting('ninja.pc_complete', true), '') <> '';
  v_i           int;
  v_j           jsonb;
  v_pid         uuid;
  v_vid         uuid;
  v_qty         numeric;
  v_up          numeric;
  v_ldisc       numeric;
  v_exp         numeric;
  v_ok          boolean;
  v_amt         numeric;
  v_k           int;
  v_reason      text;
  v_dev         numeric;
  v_max_dev     numeric := 0;
  v_pool_extra  numeric[] := '{}';
  v_pool_pack   numeric[] := '{}';
  v_pool_order  numeric[] := '{}';
  v_pack_creds  text[] := '{}';
  v_prices      jsonb := '[]'::jsonb;
  v_mismatch    jsonb := '[]'::jsonb;
  v_overrides   jsonb := '[]'::jsonb;
  v_free_total  numeric := 0;
  v_free_any    boolean := false;
  v_free_cap    numeric;
  v_price_sup   uuid;
  v_n           int := 0;
  -- F18 · H103-H105 (ADR-068): desglose fiscal y percepciones.
  v_tax_in      jsonb := '[]'::jsonb;
  v_tax         jsonb;
  v_tl          jsonb;
  v_perc        numeric := 0;
  v_total_np    numeric;
  -- ADR-077: venta offline que se sincroniza (GUC sólo de _offline_run_sale).
  v_offline     boolean := coalesce(current_setting('ninja.offline_sync', true), '') <> '';
  v_off_conf    jsonb := '[]'::jsonb;
  -- F9 (ADR-074): motor de promociones autoritativo.
  -- ADR-077: offline, las promos se evalúan a la hora real de la venta
  -- (ninja.offline_sold_at, sólo de _offline_run_sale), no a la de la sincronización.
  v_now_ar      timestamp := (case when v_offline
                                   then coalesce(nullif(current_setting('ninja.offline_sold_at', true), '')::timestamptz, now())
                                   else now() end) at time zone 'America/Argentina/Buenos_Aires';
  v_promo_lines jsonb := '[]'::jsonb;
  v_promo_ctx   jsonb;
  v_promo_eval  jsonb := jsonb_build_object('discount', 0, 'applied', '[]'::jsonb, 'gifts', '[]'::jsonb);
  v_promo_calc  numeric := 0;
  v_promo_label text;
  v_promo_first uuid;
  v_promo_left  numeric;
  v_ap          jsonb;
  v_gift        jsonb;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  perform assert_account_active(v_tenant);

  if coalesce(p_discount_total, 0) < 0 then
    raise exception 'invalid_discount';
  end if;

  if p_table_order_id is not null then
    select * into v_table_order from table_orders
     where id = p_table_order_id and tenant_id = v_tenant
     for update;
    if not found then
      raise exception 'table_order_not_open';
    end if;
    if v_table_order.status <> 'abierta' or v_table_order.sale_id is not null then
      raise exception 'table_order_not_open';
    end if;
  end if;

  if p_delivery_order_id is not null then
    select * into v_delivery_order from delivery_orders
     where id = p_delivery_order_id and tenant_id = v_tenant
     for update;
    if not found then
      raise exception 'delivery_order_not_open';
    end if;
    if v_delivery_order.sale_id is not null
       or v_delivery_order.status in ('entregado','cancelado')
       or v_delivery_order.deleted_at is not null then
      raise exception 'delivery_order_not_open';
    end if;
    v_delivery_fee := greatest(coalesce(v_delivery_order.delivery_fee, 0), 0);
  end if;

  -- F17 · H90: la sucursal sale del turno de caja (el que manda el POS o el
  -- inferido), no de la sucursal default. Con una sola sucursal es lo de siempre.
  select r.o_shift_id, r.o_store_id into v_shift, v_store
    from resolve_sale_shift(p_cash_shift_id, true) r;
  if v_shift is null then
    if not exists (select 1 from stores where tenant_id = v_tenant and deleted_at is null) then
      raise exception 'no_store';
    end if;
    raise exception 'no_open_shift';
  end if;

  select role into v_role
  from tenant_users
  where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
  limit 1;
  -- F17 · H91: el rol puede estar pisado en esta sucursal (tope de descuento).
  v_role := coalesce(user_store_role(v_store), v_role);

  -- F17 · H92 (ADR-049): descuento máximo, redondeo y venta sin stock salen
  -- de la configuración EFECTIVA de la sucursal y la caja del turno
  -- (negocio ← grupo ← sucursal ← caja). Sin overrides es pos_settings.
  select cs.cash_register_id into v_reg from cash_shifts cs where cs.id = v_shift;
  v_eff := _effective_config(v_tenant, 'pos_settings', '', v_store, v_reg) -> 'value';
  v_max_disc  := coalesce((v_eff -> 'max_discount' ->> coalesce(v_role, 'cashier'))::numeric, 100);
  v_round     := coalesce((v_eff ->> 'rounding_multiple')::numeric, 0);
  v_allow_neg := coalesce((v_eff ->> 'allow_negative_stock')::boolean, true);
  -- Stock por sucursal (ADR-046): con la feature y 2+ sucursales, sin venta en
  -- negativo también se controla el saldo de ESTA sucursal, no sólo el total.
  v_branch_stk := tenant_has_feature_for(v_tenant, 'stock_sucursales')
                  and (select count(*) from stores st
                        where st.tenant_id = v_tenant and st.deleted_at is null) > 1;

  -- F18 · H100 (ADR-056): el servidor manda en el precio. El cobro en espera que
  -- se acredita (ninja.pc_complete) usa el snapshot ya validado al estacionar.
  if not v_pc then
    if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
      raise exception 'invalid_items';
    end if;

    -- Montos sin producto que ya tienen explicación: recargo y garantía (van como
    -- ítem y como extra), packs vendidos (precio del pack) e ítems libres de la
    -- mesa o el delivery que se cobra (los valida el trigger al cargarlos).
    select coalesce(array_agg(round(e.amount, 2)), '{}') into v_pool_extra
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, amount numeric)
     where lower(coalesce(e.kind, '')) in ('warranty', 'surcharge') and coalesce(e.amount, 0) > 0;
    select coalesce(array_agg(sp.price), '{}') into v_pool_pack
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
      join service_packs sp on sp.id::text = e.id and sp.tenant_id = v_tenant and sp.deleted_at is null
     where lower(coalesce(e.kind, '')) = 'pack';
    select coalesce(array_agg(e.id), '{}') into v_pack_creds
      from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
     where lower(coalesce(e.kind, '')) = 'pack_session' and e.id is not null;
    if p_table_order_id is not null then
      select coalesce(array_agg(round(i.unit_price * i.qty, 2)), '{}') into v_pool_order
        from table_order_items i
       where i.order_id = p_table_order_id and i.tenant_id = v_tenant and i.product_id is null;
    elsif p_delivery_order_id is not null then
      select coalesce(array_agg(round(i.unit_price * i.qty, 2)), '{}') into v_pool_order
        from delivery_order_items i
       where i.order_id = p_delivery_order_id and i.tenant_id = v_tenant and i.product_id is null;
    end if;

    for v_i in 0 .. coalesce(jsonb_array_length(p_items), 0) - 1 loop
      v_j     := p_items -> v_i;
      v_qty   := coalesce((v_j ->> 'quantity')::numeric, 0);
      v_up    := coalesce((v_j ->> 'unit_price')::numeric, 0);
      v_ldisc := coalesce((v_j ->> 'discount')::numeric, 0);
      if v_qty <= 0 then raise exception 'invalid_quantity'; end if;
      if v_up < 0 or v_ldisc < 0 then raise exception 'invalid_price'; end if;
      v_pid := nullif(v_j ->> 'product_id', '')::uuid;

      if v_pid is null then
        v_amt := round(v_up * v_qty, 2);
        v_k := _amount_index(v_pool_extra, v_amt);
        if v_k > 0 then
          v_pool_extra := v_pool_extra[1:v_k - 1] || v_pool_extra[v_k + 1:];
        else
          v_k := _amount_index(v_pool_pack, v_amt);
          if v_k > 0 then
            v_pool_pack := v_pool_pack[1:v_k - 1] || v_pool_pack[v_k + 1:];
          else
            v_k := _amount_index(v_pool_order, v_amt);
            if v_k > 0 then
              v_pool_order := v_pool_order[1:v_k - 1] || v_pool_order[v_k + 1:];
            else
              v_free_any := true;
              v_free_total := v_free_total + greatest(v_amt - v_ldisc, 0);
            end if;
          end if;
        end if;
        v_prices := v_prices || jsonb_build_array(jsonb_build_object('list_price', null));
        continue;
      end if;

      v_vid := nullif(v_j ->> 'variant_id', '')::uuid;
      v_exp := _resolve_unit_price(v_tenant, v_pid, v_vid, v_qty, p_customer_id, v_store, null, now());
      if v_exp is null then raise exception 'product_not_found'; end if;
      v_exp := round(v_exp + _sale_modifier_delta(v_tenant, v_pid, v_j -> 'modifiers'), 2);
      v_ok := abs(v_up - v_exp) <= 0.01;
      v_reason := null;

      -- Regalo de una promo y línea cubierta por una sesión de pack: van a $0.
      if not v_ok and v_up = 0 and nullif(v_j ->> 'gift_promo_id', '') is not null then
        v_ok := exists (select 1 from promotions pr
                         where pr.id::text = v_j ->> 'gift_promo_id' and pr.tenant_id = v_tenant
                           and pr.deleted_at is null);
      end if;
      if not v_ok and v_up = 0 and nullif(v_j ->> 'pack_credit_id', '') is not null then
        v_ok := (v_j ->> 'pack_credit_id') = any (v_pack_creds);
      end if;
      -- Mesa o delivery que se cobra: vale el precio guardado al cargar el ítem.
      if not v_ok and p_table_order_id is not null then
        v_ok := exists (select 1 from table_order_items i
                         where i.order_id = p_table_order_id and i.tenant_id = v_tenant
                           and i.product_id = v_pid and abs(i.unit_price - v_up) <= 0.01);
      end if;
      if not v_ok and p_delivery_order_id is not null then
        v_ok := exists (select 1 from delivery_order_items i
                         where i.order_id = p_delivery_order_id and i.tenant_id = v_tenant
                           and i.product_id = v_pid and abs(i.unit_price - v_up) <= 0.01);
      end if;

      if not v_ok then
        if coalesce((v_j ->> 'price_override')::boolean, false) then
          v_reason := nullif(btrim(coalesce(v_j ->> 'override_reason', '')), '');
          if v_reason is null or char_length(v_reason) < 3 then
            raise exception 'price_override_reason_required';
          end if;
          v_reason := left(v_reason, 200);
          v_dev := case when v_exp > 0 then round(abs(v_up - v_exp) / v_exp * 100, 2) else 100 end;
          v_max_dev := greatest(v_max_dev, v_dev);
          v_overrides := v_overrides || jsonb_build_array(jsonb_build_object(
            'product_id', v_pid, 'variant_id', v_vid, 'expected', v_exp, 'price', v_up,
            'quantity', v_qty, 'deviation_pct', v_dev, 'reason', v_reason));
        else
          v_mismatch := v_mismatch || jsonb_build_array(jsonb_build_object(
            'product_id', v_pid, 'variant_id', v_vid, 'expected', v_exp, 'received', v_up));
        end if;
      end if;
      v_prices := v_prices || jsonb_build_array(jsonb_build_object('list_price', v_exp, 'reason', v_reason));
    end loop;

    -- Primero el precio: el POS refresca y el cajero vuelve a cobrar.
    -- ADR-077: offline se respeta el precio cobrado y queda el conflicto.
    if jsonb_array_length(v_mismatch) > 0 then
      if v_offline then
        v_off_conf := v_off_conf || (select coalesce(jsonb_agg(m || jsonb_build_object('kind', 'price_changed')), '[]'::jsonb)
                                       from jsonb_array_elements(v_mismatch) as m);
      else
        raise exception using message = 'price_mismatch:' || jsonb_build_object('items', v_mismatch)::text,
                              errcode = 'P0001';
      end if;
    end if;

    -- Venta libre (monto manual sin producto): flag efectivo y tope por rol.
    if v_free_any then
      if not coalesce((v_eff ->> 'allow_free_sale')::boolean, true) then
        raise exception 'free_sale_not_allowed';
      end if;
      v_free_cap := (v_eff -> 'max_free_sale' ->> coalesce(v_role, 'cashier'))::numeric;
      if v_free_cap is not null and v_free_total > v_free_cap + 0.01 then
        raise exception 'free_sale_exceeds_limit';
      end if;
    end if;

    -- Cambio manual de precio: supervisor, o PIN si la política lo pide.
    if jsonb_array_length(v_overrides) > 0 then
      if is_supervisor(v_tenant, auth.uid()) then
        v_price_sup := auth.uid();
      elsif pin_action_required(v_tenant, 'cambio_precio', v_max_dev) then
        v_price_sup := require_supervisor('cambio_precio', v_max_dev, null);
      end if;
    end if;
  end if;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_price numeric, discount numeric)
  loop
    v_subtotal := v_subtotal
      + (coalesce(v_item.unit_price, 0) * coalesce(v_item.quantity, 0))
      - coalesce(v_item.discount, 0);
    v_line_disc := v_line_disc + coalesce(v_item.discount, 0);
  end loop;

  select exists (
    select 1 from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text)
    where lower(coalesce(e.kind,'')) = 'pack_session'
  ) into v_has_pack_session;

  if v_subtotal < 0 or (v_subtotal = 0 and not v_has_pack_session) then
    raise exception 'empty_sale';
  end if;

  if (coalesce(p_discount_total, 0) > 0 or v_line_disc > 0)
     and not tenant_has_feature('descuentos') then
    raise exception 'feature_not_in_plan: descuentos';
  end if;

  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'warranty'
                           then coalesce(e.amount, 0) else 0 end), 0)
    into v_warranty_prima
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric);
  if v_warranty_prima > 0 and not tenant_has_feature('garantias') then
    raise exception 'feature_not_in_plan: garantias';
  end if;

  select coalesce(sum(case when lower(coalesce(e.kind,'')) = 'tip'
                           then coalesce(e.amount, 0) else 0 end), 0),
         max(case when lower(coalesce(e.kind,'')) = 'tip' then e.method end)
    into v_tip_amount, v_tip_method
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, amount numeric, method text);
  if v_tip_amount < 0 then
    raise exception 'invalid_tip';
  end if;
  if v_tip_amount > 0 and v_tip_method is null then
    v_tip_method := 'cash';
  end if;

  select (e.id)::uuid into v_professional
  from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
    as e(kind text, id text)
  where lower(coalesce(e.kind,'')) = 'professional'
    and e.id is not null
  order by (e.id)::uuid
  limit 1;
  if v_professional is not null then
    if not exists (
      select 1 from professionals
      where id = v_professional and tenant_id = v_tenant
        and deleted_at is null and is_active
    ) then
      v_professional := null;
    end if;
  end if;

  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb))
         as e(kind text)
       where lower(coalesce(e.kind,'')) in ('pack','pack_session')
     )
     and p_customer_id is null then
    raise exception 'pack_needs_customer';
  end if;

  if exists (
       select 1 from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb))
         as p(method text, amount numeric)
       where p.method = 'account' and coalesce(p.amount, 0) > 0
     )
     and not tenant_has_feature('cuenta_corriente') then
    raise exception 'feature_not_in_plan: cuenta_corriente';
  end if;

  if coalesce(p_discount_total, 0) > 0 and v_subtotal > 0 then
    v_disc_pct := coalesce(p_discount_total, 0) / v_subtotal * 100;
    if v_disc_pct > v_max_disc + 0.001 then
      raise exception 'discount_exceeds_limit';
    end if;
  end if;

  -- F9 (ADR-074): promociones calculadas en el servidor, ANTES del cupón, los
  -- impuestos y las percepciones (los recargos de cuotas llegan como ítem sin
  -- producto y no reciben promos). Mismo motor que el POS (lib/promotions/
  -- engine.ts): si el descuento que manda el POS no coincide, se rechaza con
  -- promo_mismatch y el POS vuelve a calcular. No pasa por el gating de
  -- 'descuentos' ni por el tope por rol (una promo no es descuento manual).
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', x.v ->> 'product_id',
           'category_id', p.category_id,
           'brand_id', p.brand_id,
           'quantity', coalesce((x.v ->> 'quantity')::numeric, 0),
           'line_total', round(coalesce((x.v ->> 'unit_price')::numeric, 0) * coalesce((x.v ->> 'quantity')::numeric, 0)
                               - coalesce((x.v ->> 'discount')::numeric, 0), 2),
           'excluded', (nullif(x.v ->> 'gift_promo_id', '') is not null
                        or nullif(x.v ->> 'pack_credit_id', '') is not null)) order by x.i), '[]'::jsonb)
    into v_promo_lines
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, i)
    left join products p on p.id::text = x.v ->> 'product_id' and p.tenant_id = v_tenant;

  v_promo_ctx := jsonb_build_object(
    'weekday', extract(dow from v_now_ar)::int,
    'minutes', (extract(hour from v_now_ar) * 60 + extract(minute from v_now_ar))::int,
    'date', to_char(v_now_ar, 'YYYY-MM-DD'),
    'store_id', v_store,
    'price_list_id', _promo_sale_list(v_tenant, p_customer_id, v_store),
    'customer_id', p_customer_id,
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
                          'method', x.method,
                          'card_brand', x.card_voucher ->> 'marca',
                          'bank', x.card_voucher ->> 'banco',
                          'ineligible', coalesce(x.promo_ineligible, false))), '[]'::jsonb)
                   from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb))
                     as x(method text, amount numeric, card_voucher jsonb, promo_ineligible boolean)
                  where coalesce(x.amount, 0) > 0));

  -- Topes de uso: un cobro a la vez por promo con tope (sin pasarse).
  perform pg_advisory_xact_lock(hashtext('promo_use:' || pr.id::text))
     from promotions pr
    where pr.tenant_id = v_tenant and pr.deleted_at is null and pr.is_active
      and (pr.max_uses_total is not null or pr.max_uses_per_customer is not null)
    order by pr.id;

  v_promo_eval := _promo_evaluate(v_tenant, v_promo_lines, v_promo_ctx);
  -- El cupón es excluyente con las promos de descuento (los regalos conviven).
  if p_coupon_id is not null then
    v_promo_eval := v_promo_eval || jsonb_build_object('discount', 0, 'applied', '[]'::jsonb);
  end if;
  v_promo_calc := least(coalesce((v_promo_eval ->> 'discount')::numeric, 0),
                        greatest(v_subtotal - coalesce(p_discount_total, 0), 0));

  if v_pc then
    -- Cobro en espera acreditado: vale el monto validado en el ensayo (como el
    -- precio). Si el motor ya no da lo mismo (cambió la hora), queda una sola
    -- fila con la promo que se mandó.
    v_promo_disc := least(greatest(coalesce(p_promo_discount, 0), 0),
                          greatest(v_subtotal - coalesce(p_discount_total, 0), 0));
    if abs(v_promo_calc - v_promo_disc) > 0.01 then
      v_promo_eval := v_promo_eval || jsonb_build_object('applied',
        case when v_promo_disc > 0 then jsonb_build_array(jsonb_build_object(
               'id', p_promo_id, 'name', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'label', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'discount', v_promo_disc, 'lines', '[]'::jsonb))
             else '[]'::jsonb end);
    end if;
  else
    if coalesce(p_promo_discount, 0) > 0 and not tenant_has_feature_for(v_tenant, 'promociones') then
      raise exception 'feature_not_in_plan: promociones';
    end if;
    -- Borde de una franja (happy hour, cambio de día): el POS calculó con su
    -- reloj hasta 5 minutos antes (por ejemplo, un QR que tardó en pagarse).
    if abs(greatest(coalesce(p_promo_discount, 0), 0) - v_promo_calc) > 0.01 then
      v_promo_ctx := v_promo_ctx || jsonb_build_object(
        'weekday', extract(dow from v_now_ar - interval '5 minutes')::int,
        'minutes', (extract(hour from v_now_ar - interval '5 minutes') * 60
                    + extract(minute from v_now_ar - interval '5 minutes'))::int,
        'date', to_char(v_now_ar - interval '5 minutes', 'YYYY-MM-DD'));
      v_gift := _promo_evaluate(v_tenant, v_promo_lines, v_promo_ctx);
      if p_coupon_id is not null then
        v_gift := v_gift || jsonb_build_object('discount', 0, 'applied', '[]'::jsonb);
      end if;
      if abs(greatest(coalesce(p_promo_discount, 0), 0)
             - least(coalesce((v_gift ->> 'discount')::numeric, 0),
                     greatest(v_subtotal - coalesce(p_discount_total, 0), 0))) <= 0.01 then
        v_promo_eval := v_gift;
        v_promo_calc := least(coalesce((v_gift ->> 'discount')::numeric, 0),
                              greatest(v_subtotal - coalesce(p_discount_total, 0), 0));
      end if;
    end if;
    if v_offline and abs(greatest(coalesce(p_promo_discount, 0), 0) - v_promo_calc) > 0.01 then
      -- ADR-077: la promo se recalculó al sincronizar y no da lo mismo (venció,
      -- se editó, se agotó el tope...). Se respeta lo cobrado, como el precio,
      -- con una sola fila de la promo que mandó el POS, y queda el conflicto
      -- 'promo_changed' para revisión.
      v_promo_disc := least(greatest(coalesce(p_promo_discount, 0), 0),
                            greatest(v_subtotal - coalesce(p_discount_total, 0), 0));
      v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
        'kind', 'promo_changed',
        'promo_id', p_promo_id,
        'promo_name', nullif(btrim(coalesce(p_promo_name, '')), ''),
        'charged', v_promo_disc,
        'expected', v_promo_calc,
        'expected_applied', coalesce((select jsonb_agg(jsonb_build_object('id', a ->> 'id', 'name', a ->> 'label',
                                                                          'discount', (a ->> 'discount')::numeric))
                                        from jsonb_array_elements(v_promo_eval -> 'applied') a), '[]'::jsonb)));
      v_promo_eval := v_promo_eval || jsonb_build_object('applied',
        case when v_promo_disc > 0 then jsonb_build_array(jsonb_build_object(
               'id', p_promo_id, 'name', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'label', coalesce(nullif(btrim(coalesce(p_promo_name, '')), ''), 'Promoción'),
               'discount', v_promo_disc, 'lines', '[]'::jsonb))
             else '[]'::jsonb end);
      v_promo_calc := v_promo_disc;
    end if;
    if abs(greatest(coalesce(p_promo_discount, 0), 0) - v_promo_calc) > 0.01 then
      raise exception using
        message = 'promo_mismatch:' || jsonb_build_object(
          'expected', v_promo_calc,
          'received', coalesce(p_promo_discount, 0),
          'applied', coalesce((select jsonb_agg(jsonb_build_object('id', a ->> 'id', 'name', a ->> 'label',
                                                                  'discount', (a ->> 'discount')::numeric))
                                 from jsonb_array_elements(v_promo_eval -> 'applied') a), '[]'::jsonb))::text,
        errcode = 'P0001';
    end if;
    v_promo_disc := v_promo_calc;
    -- Regalos: cada línea a $0 con gift_promo_id tiene que salir del motor
    -- (misma promo, mismo producto, sin pasarse de la cantidad).
    for v_gift in
      select x.v from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as x(v)
       where nullif(x.v ->> 'gift_promo_id', '') is not null
    loop
      if not exists (
        select 1 from jsonb_array_elements(coalesce(v_promo_eval -> 'gifts', '[]'::jsonb)) g
         where g ->> 'id' = v_gift ->> 'gift_promo_id'
           and g ->> 'product_id' = v_gift ->> 'product_id'
           and coalesce((v_gift ->> 'quantity')::numeric, 0) <= coalesce((g ->> 'qty')::numeric, 0)
           and coalesce((v_gift ->> 'unit_price')::numeric, 0) = 0) then
        if v_offline and coalesce((v_gift ->> 'unit_price')::numeric, 0) = 0 then
          -- ADR-077: regalo entregado sin conexión que el motor ya no da: se
          -- respeta lo entregado y queda el conflicto 'promo_changed'.
          v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
            'kind', 'promo_changed', 'gift', true,
            'promo_id', v_gift ->> 'gift_promo_id', 'product_id', v_gift ->> 'product_id',
            'quantity', v_gift -> 'quantity'));
        else
          raise exception 'promo_gift_invalid';
        end if;
      end if;
    end loop;
  end if;

  select string_agg(coalesce(nullif(a ->> 'label', ''), a ->> 'name'), ' + ' order by o),
         (array_agg(nullif(a ->> 'id', '')::uuid order by o))[1]
    into v_promo_label, v_promo_first
    from jsonb_array_elements(coalesce(v_promo_eval -> 'applied', '[]'::jsonb)) with ordinality as t(a, o);

  -- Cupón (F9 · H54): lock de la fila + validación + cómputo AUTORITATIVO. Bypass
  -- del gating de 'descuentos' y del tope por rol (un cupón no es descuento manual),
  -- igual que la promo. El registro del canje se hace tras insertar la venta.
  if p_coupon_id is not null then
    select * into v_coupon from coupons
      where id = p_coupon_id and tenant_id = v_tenant and deleted_at is null
      for update;
    if not found then raise exception 'coupon_not_found'; end if;
    if not v_coupon.is_active then raise exception 'coupon_inactive'; end if;
    if v_coupon.valid_from is not null
       and (now() at time zone 'America/Argentina/Buenos_Aires')::date < v_coupon.valid_from then
      raise exception 'coupon_not_yet_valid';
    end if;
    if v_coupon.valid_to is not null
       and (now() at time zone 'America/Argentina/Buenos_Aires')::date > v_coupon.valid_to then
      raise exception 'coupon_expired';
    end if;
    if v_subtotal < coalesce(v_coupon.min_amount, 0) then
      raise exception 'coupon_min_amount';
    end if;
    if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then
      raise exception 'coupon_usage_exceeded';
    end if;
    if v_coupon.max_per_customer is not null then
      if p_customer_id is null then raise exception 'coupon_needs_customer'; end if;
      if (select count(*) from coupon_redemptions
            where coupon_id = v_coupon.id and customer_id = p_customer_id)
         >= v_coupon.max_per_customer then
        raise exception 'coupon_customer_exceeded';
      end if;
    end if;
    v_coupon_disc := case when v_coupon.discount_type = 'percent'
                          then v_subtotal * coalesce(v_coupon.discount_value, 0) / 100
                          else coalesce(v_coupon.discount_value, 0) end;
    v_coupon_disc := least(
      greatest(v_coupon_disc, 0),
      greatest(v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc, 0)
    );
  end if;

  v_total_pre := v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc - v_coupon_disc;

  if v_round > 0 then
    v_total := round(v_total_pre / v_round) * v_round;
  else
    v_total := v_total_pre;
  end if;

  if v_delivery_fee > 0 then
    v_subtotal := v_subtotal + v_delivery_fee;
    v_total    := v_total + v_delivery_fee;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments) as x(method text, amount numeric)
  loop
    v_paid := v_paid + coalesce(v_pay.amount, 0);
    if v_pay.method = 'store_credit' then
      v_sc_total := v_sc_total + coalesce(v_pay.amount, 0);
    end if;
  end loop;

  -- F18 · H103-H105 (ADR-068): desglose fiscal. Una línea por ítem en el orden
  -- de p_items (el mismo índice que sale_items) y el envío al final; el total
  -- sin percepciones se reparte entre ellas (descuentos, promo, cupón y
  -- redondeo quedan dentro de cada ítem). Las percepciones se suman al total
  -- y el pago tiene que cubrirlas (el POS las muestra con sale_tax_preview).
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', x.v ->> 'product_id', 'variant_id', x.v ->> 'variant_id',
           'quantity', coalesce((x.v ->> 'quantity')::numeric, 0),
           'gross', round(coalesce((x.v ->> 'unit_price')::numeric, 0) * coalesce((x.v ->> 'quantity')::numeric, 0)
                          - coalesce((x.v ->> 'discount')::numeric, 0), 2)) order by x.i), '[]'::jsonb)
    into v_tax_in
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, i);
  if v_delivery_fee > 0 then
    v_tax_in := v_tax_in || jsonb_build_array(jsonb_build_object('product_id', null, 'quantity', 1, 'gross', v_delivery_fee));
  end if;
  v_total_np := v_total;
  v_tax := _sale_tax_compute(v_tenant, p_customer_id, v_tax_in, v_total_np, now());
  v_perc := coalesce((v_tax ->> 'perception_total')::numeric, 0);
  -- Cobro en espera que se acredita: la plata ya entró por el monto del ensayo.
  -- Si una percepción nueva (padrón cambiado en el medio) no está cubierta, no
  -- se percibe y queda el aviso en la venta.
  if v_perc > 0 and v_pc and v_paid < v_total_np + v_perc + v_tip_amount - 0.001 then
    v_tax := v_tax || jsonb_build_object(
      'perceptions', '[]'::jsonb, 'perception_total', 0,
      'warnings', coalesce(v_tax -> 'warnings', '[]'::jsonb) || jsonb_build_array('perception_skipped_pending_charge'));
    v_perc := 0;
  end if;
  v_total := v_total_np + v_perc;

  if v_paid < v_total + v_tip_amount then
    raise exception 'insufficient_payment';
  end if;
  if v_sc_total > v_total + 0.001 then
    raise exception 'store_credit_exceeds_total';
  end if;

  if v_sc_total > 0 then
    if p_customer_id is null then
      raise exception 'store_credit_needs_customer';
    end if;
    select coalesce(sum(delta), 0) into v_sc_bal
    from store_credit_movements
    where tenant_id = v_tenant and customer_id = p_customer_id;
    if v_sc_bal < v_sc_total - 0.001 then
      raise exception 'insufficient_store_credit';
    end if;
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text)
  loop
    if v_pay.method = 'qr' then
      v_qr_ref := null;
      if v_pay.reference is not null
         and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
        select pi.id, pi.provider_key, pi.sale_id, pi.status, pi.amount
          into v_intent
        from mp_payment_intents pi
        where pi.id = v_pay.reference::uuid
          and pi.tenant_id = v_tenant
        limit 1;
        if found then
          v_qr_ref := v_intent.id;
        end if;
      end if;

      if v_qr_ref is not null then
        if v_intent.status <> 'approved' then
          raise exception 'qr_not_approved';
        end if;
        if v_intent.sale_id is not null then
          raise exception 'qr_already_charged';
        end if;
        if exists (
          select 1 from payments pmt
          join sales s on s.id = pmt.sale_id and s.tenant_id = v_tenant
          where pmt.method = 'qr' and pmt.reference = v_qr_ref::text
        ) then
          raise exception 'qr_already_charged';
        end if;
        select coalesce(sum(coalesce(q.amount, 0)), 0) into v_qr_sum
        from jsonb_to_recordset(p_payments)
          as q(method text, amount numeric, reference text)
        where q.method = 'qr'
          and q.reference is not null
          and q.reference ~ '^[0-9a-fA-F-]{36}$'
          and q.reference::uuid = v_qr_ref;
        if v_qr_sum > coalesce(v_intent.amount, 0) + 0.01 then
          raise exception 'qr_amount_mismatch';
        end if;
        v_pay_feat := case v_intent.provider_key
                        when 'mercadopago' then 'mercado_pago'
                        when 'mobbex'      then 'mobbex'
                        when 'modo'        then 'modo'
                        when 'pagos360'    then 'pagos360'
                        else null
                      end;
        if v_pay_feat is not null and not tenant_has_feature(v_pay_feat) then
          raise exception 'method_not_in_plan';
        end if;
      else
        v_qr_plain := true;
      end if;
    end if;
  end loop;

  if v_qr_plain
     and not (
       tenant_has_feature('mercado_pago')
       or tenant_has_feature('mobbex')
       or tenant_has_feature('modo')
       or tenant_has_feature('pagos360')
     ) then
    raise exception 'qr_not_allowed';
  end if;

  perform pg_advisory_xact_lock(hashtext('sale_number:' || v_tenant::text));

  select coalesce(max(number), 0) + 1 into v_number
  from sales where tenant_id = v_tenant;

  insert into sales (store_id, cash_shift_id, customer_id, number, status,
                     subtotal, discount_total, tax_total, total, notes,
                     professional_id, tip_amount, tip_method,
                     promo_id, promo_name, promo_discount,
                     coupon_id, coupon_code, coupon_discount,
                     cbte_letter, fiscal_snapshot, net_taxed, net_exempt, net_untaxed,
                     iva_total, internal_tax_total, perception_total)
  values (v_store, v_shift, p_customer_id, v_number, 'completed',
          v_subtotal, v_subtotal - v_total_np,
          coalesce((v_tax ->> 'iva_total')::numeric, 0) + coalesce((v_tax ->> 'internal_total')::numeric, 0) + v_perc,
          v_total, p_notes,
          v_professional, v_tip_amount,
          case when v_tip_amount > 0 then v_tip_method else null end,
          case when v_promo_disc > 0 then v_promo_first else null end,
          case when v_promo_disc > 0 then left(v_promo_label, 200) else null end,
          v_promo_disc,
          case when v_coupon_disc > 0 then p_coupon_id else null end,
          case when v_coupon_disc > 0 then v_coupon.code else null end,
          v_coupon_disc,
          v_tax ->> 'letter',
          jsonb_build_object('emitter', v_tax -> 'emitter', 'receptor', v_tax -> 'receptor',
                             'requires_identification', v_tax -> 'requires_identification',
                             'warnings', v_tax -> 'warnings'),
          coalesce((v_tax ->> 'net_taxed')::numeric, 0), coalesce((v_tax ->> 'net_exempt')::numeric, 0),
          coalesce((v_tax ->> 'net_untaxed')::numeric, 0), coalesce((v_tax ->> 'iva_total')::numeric, 0),
          coalesce((v_tax ->> 'internal_total')::numeric, 0), v_perc)
  returning id into v_sale_id;

  -- ADR-068: AlicIva, tributo de internos y percepciones de la venta.
  insert into sale_tax_lines (tenant_id, sale_id, kind, tax, rate_code, rate, base, amount, arca_id, source)
  select v_tenant, v_sale_id, 'iva', 'iva', x.code, x.rate, x.base, x.amount, x.arca_id, 'product'
    from jsonb_to_recordset(coalesce(v_tax -> 'iva', '[]'::jsonb))
      as x(code text, rate numeric, base numeric, amount numeric, arca_id int);
  if coalesce((v_tax ->> 'internal_total')::numeric, 0) > 0 then
    insert into sale_tax_lines (tenant_id, sale_id, kind, tax, base, amount, arca_id, source, name)
    values (v_tenant, v_sale_id, 'internos', 'internos', coalesce((v_tax ->> 'internal_base')::numeric, 0),
            (v_tax ->> 'internal_total')::numeric, 4, 'product', 'Impuestos internos');
  end if;
  insert into sale_tax_lines (tenant_id, sale_id, kind, tax, jurisdiction, rate, base, amount, arca_id,
                              regime_id, source, name)
  select v_tenant, v_sale_id, 'perception', x.tax, x.jurisdiction, x.rate, x.base, x.amount, x.arca_tributo_id,
         x.regime_id, x.source, x.name
    from jsonb_to_recordset(coalesce(v_tax -> 'perceptions', '[]'::jsonb))
      as x(tax text, jurisdiction text, rate numeric, base numeric, amount numeric, arca_tributo_id int,
           regime_id uuid, source text, name text);

  -- Registro del canje del cupón (F9 · H54): consume un uso + traza. Atómico:
  -- la fila ya está bloqueada (FOR UPDATE arriba), así que dos cobros simultáneos
  -- no pueden pasar el tope.
  if p_coupon_id is not null and v_coupon_disc > 0 then
    update coupons set used_count = used_count + 1, updated_at = now()
     where id = p_coupon_id and tenant_id = v_tenant;
    insert into coupon_redemptions (tenant_id, coupon_id, sale_id, customer_id, discount)
    values (v_tenant, p_coupon_id, v_sale_id, p_customer_id, v_coupon_disc);
  end if;

  -- F9 (ADR-074): cada promo aplicada, con su reparto por línea. Si el total
  -- quedó acotado por el descuento manual, se descuenta de las últimas.
  v_promo_left := v_promo_disc;
  for v_ap in
    select a from jsonb_array_elements(coalesce(v_promo_eval -> 'applied', '[]'::jsonb)) a
  loop
    v_amt := least(coalesce((v_ap ->> 'discount')::numeric, 0), v_promo_left);
    exit when v_amt <= 0;
    insert into sale_promotions (tenant_id, sale_id, promotion_id, name, label, kind, discount,
                                 customer_id, store_id, detail)
    values (v_tenant, v_sale_id,
            (select pr.id from promotions pr where pr.id::text = v_ap ->> 'id' and pr.tenant_id = v_tenant),
            coalesce(v_ap ->> 'name', 'Promoción'), coalesce(nullif(v_ap ->> 'label', ''), v_ap ->> 'name', 'Promoción'),
            'discount', v_amt, p_customer_id, v_store,
            jsonb_build_object('lines', coalesce(v_ap -> 'lines', '[]'::jsonb), 'stackable', v_ap -> 'stackable'));
    v_promo_left := v_promo_left - v_amt;
  end loop;
  -- Regalos entregados (valor de lista de lo regalado, para el rendimiento).
  insert into sale_promotions (tenant_id, sale_id, promotion_id, name, label, kind, discount,
                               customer_id, store_id, detail)
  select v_tenant, v_sale_id, pr.id, pr.name, coalesce(nullif(btrim(coalesce(pr.ticket_label, '')), ''), pr.name),
         'gift',
         round(coalesce((v_prices -> (x.i - 1)::int ->> 'list_price')::numeric, 0)
               * coalesce((x.v ->> 'quantity')::numeric, 0), 2),
         p_customer_id, v_store,
         jsonb_build_object('product_id', x.v ->> 'product_id', 'quantity', x.v -> 'quantity')
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(v, i)
    join promotions pr on pr.id::text = x.v ->> 'gift_promo_id' and pr.tenant_id = v_tenant
   where nullif(x.v ->> 'gift_promo_id', '') is not null;

  for v_item in
    select * from jsonb_to_recordset(p_items)
      as x(product_id uuid, variant_id uuid, name text, serial text, modifiers jsonb,
           quantity numeric, unit_price numeric, discount numeric)
  loop
    if v_item.product_id is not null then
      select p.name, p.sku, p.is_kit, p.track_stock, p.has_variants
        into v_pname, v_psku, v_is_kit, v_track, v_has_variants
      from products p
      where p.id = v_item.product_id and p.tenant_id = v_tenant;
      if not found then
        raise exception 'product_not_found';
      end if;

      if coalesce(v_has_variants, false) then
        if v_item.variant_id is null then
          raise exception 'variant_required';
        end if;
        select * into v_variant from product_variants
         where id = v_item.variant_id and product_id = v_item.product_id
           and tenant_id = v_tenant and deleted_at is null;
        if not found then
          raise exception 'variant_not_found';
        end if;
        v_pname := v_pname || ' · ' || v_variant.option1
                   || coalesce(' / ' || v_variant.option2, '');
      elsif v_item.variant_id is not null then
        raise exception 'variant_not_allowed';
      end if;
    else
      v_pname  := coalesce(nullif(btrim(v_item.name), ''), 'Venta rápida');
      v_psku   := null;
      v_is_kit := false;
      v_track  := false;
      v_has_variants := false;
    end if;

    v_serial := nullif(btrim(coalesce(v_item.serial, '')), '');

    -- ADR-056: precio de lista calculado y motivo del cambio manual (mismo orden
    -- que p_items; vacío en el cobro en espera acreditado).
    -- ADR-068: alícuota, precio final repartido, neto, IVA e internos.
    v_tl := v_tax -> 'lines' -> v_n;
    insert into sale_items (sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            list_price, price_override_reason,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_sale_id, v_item.product_id, v_item.variant_id, v_pname, v_psku, v_serial,
            v_item.quantity, v_item.unit_price, coalesce(v_item.discount, 0),
            (v_item.unit_price * v_item.quantity) - coalesce(v_item.discount, 0),
            coalesce(v_item.modifiers, '[]'::jsonb),
            (v_prices -> v_n ->> 'list_price')::numeric,
            v_prices -> v_n ->> 'reason',
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
    v_n := v_n + 1;

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
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            if v_branch_stk and not coalesce(v_comp.comp_allow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_comp.component_product_id
                                and ps.variant_id is null), 0) < (v_item.quantity * v_comp.quantity) then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock_branch'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock_branch', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
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
          if coalesce(v_has_variants, false) then
            select pr.allow_negative into v_pallow from products pr
             where pr.id = v_item.product_id and pr.tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_variant.stock < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            if v_branch_stk and not coalesce(v_pallow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_item.product_id
                                and ps.variant_id = v_variant.id), 0) < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock_branch'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock_branch', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;

            update product_variants
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_variant.id and tenant_id = v_tenant;

            insert into stock_movements (product_id, variant_id, store_id, delta, reason, reference_id)
            values (v_item.product_id, v_variant.id, v_store, -v_item.quantity, 'sale', v_sale_id);
          else
            select stock, allow_negative into v_stock, v_pallow
            from products where id = v_item.product_id and tenant_id = v_tenant;
            if not coalesce(v_pallow, v_allow_neg) and v_stock < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;
            if v_branch_stk and not coalesce(v_pallow, v_allow_neg)
               and coalesce((select ps.qty from product_stock ps
                              where ps.store_id = v_store and ps.product_id = v_item.product_id
                                and ps.variant_id is null), 0) < v_item.quantity then
              -- ADR-077: offline se vende igual (stock negativo) y queda el conflicto.
              if not v_offline then raise exception 'insufficient_stock_branch'; end if;
              v_off_conf := v_off_conf || jsonb_build_array(jsonb_build_object(
                'kind', 'negative_stock_branch', 'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
                'quantity', v_item.quantity));
            end if;

            update products
               set stock = stock - v_item.quantity, updated_at = now()
             where id = v_item.product_id and tenant_id = v_tenant;

            insert into stock_movements (product_id, store_id, delta, reason, reference_id)
            values (v_item.product_id, v_store, -v_item.quantity, 'sale', v_sale_id);
          end if;
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

  -- ADR-056: cambio manual de precio, con quién lo autorizó.
  if jsonb_array_length(v_overrides) > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            reason, after_data, store_id)
    values (v_tenant, auth.uid(), 'sales', v_sale_id, 'price_override',
            v_overrides -> 0 ->> 'reason',
            jsonb_build_object('sale_number', v_number, 'items', v_overrides,
                               'max_deviation_pct', v_max_dev, 'supervisor_id', v_price_sup),
            v_store);
  end if;

  if v_delivery_fee > 0 then
    v_tl := v_tax -> 'lines' -> v_n;
    insert into sale_items (sale_id, product_id, variant_id, product_name, sku, serial,
                            quantity, unit_price, discount, subtotal, modifiers,
                            tax_rate_code, iva_rate, taxed_total, net_amount, iva_amount, internal_tax_amount)
    values (v_sale_id, null, null, 'Costo de envío', null, null,
            1, v_delivery_fee, 0, v_delivery_fee, '[]'::jsonb,
            v_tl ->> 'tax_rate_code', (v_tl ->> 'iva_rate')::numeric, (v_tl ->> 'taxed_total')::numeric,
            (v_tl ->> 'net')::numeric, (v_tl ->> 'iva')::numeric, (v_tl ->> 'internal')::numeric);
  end if;

  for v_pay in
    select * from jsonb_to_recordset(p_payments)
      as x(method text, amount numeric, reference text, card_voucher jsonb)
  loop
    insert into payments (sale_id, method, amount, reference, card_voucher)
    values (v_sale_id, v_pay.method, v_pay.amount, v_pay.reference,
            coalesce(v_pay.card_voucher, '{}'::jsonb));

    if v_pay.method = 'qr'
       and v_pay.reference is not null
       and v_pay.reference ~ '^[0-9a-fA-F-]{36}$' then
      update mp_payment_intents
         set sale_id = v_sale_id, updated_at = now()
       where id = v_pay.reference::uuid
         and tenant_id = v_tenant
         and sale_id is null;
    end if;

    insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
    values (v_shift, 'sale', v_pay.amount, v_pay.method, v_sale_id);

    if v_pay.method = 'store_credit' then
      insert into store_credit_movements (customer_id, delta, reason)
      values (p_customer_id, -coalesce(v_pay.amount, 0), 'Pago venta #' || v_number);
    end if;
  end loop;

  for v_pack in
    select (e.id)::uuid as pack_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
    where lower(coalesce(e.kind,'')) = 'pack' and e.id is not null
  loop
    select * into v_pk from service_packs
     where id = v_pack.pack_id and tenant_id = v_tenant and deleted_at is null;
    if not found then
      raise exception 'pack_not_found';
    end if;
    insert into customer_pack_credits (
      customer_id, pack_id, pack_name, product_id,
      sessions_total, sessions_used, expires_at, sale_id
    )
    values (
      p_customer_id, v_pk.id, v_pk.name, v_pk.product_id,
      v_pk.sessions, 0,
      case when v_pk.validity_days is not null
           then now() + make_interval(days => v_pk.validity_days) else null end,
      v_sale_id
    );
  end loop;

  for v_pack in
    select (e.id)::uuid as credit_id
    from jsonb_to_recordset(coalesce(p_extras, '[]'::jsonb)) as e(kind text, id text)
    where lower(coalesce(e.kind,'')) = 'pack_session' and e.id is not null
  loop
    select * into v_pcredit from customer_pack_credits
     where id = v_pack.credit_id and tenant_id = v_tenant
       and customer_id = p_customer_id
     for update;
    if not found then
      raise exception 'pack_credit_not_found';
    end if;
    if v_pcredit.sessions_used >= v_pcredit.sessions_total then
      raise exception 'pack_no_sessions_left';
    end if;
    if v_pcredit.expires_at is not null and v_pcredit.expires_at < now() then
      raise exception 'pack_expired';
    end if;

    update customer_pack_credits
       set sessions_used = sessions_used + 1
     where id = v_pcredit.id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            before_data, after_data)
    values (v_tenant, auth.uid(), 'customer_pack_credits', v_pcredit.id, 'pack_session_used',
            jsonb_build_object('sessions_used', v_pcredit.sessions_used,
                               'sessions_total', v_pcredit.sessions_total),
            jsonb_build_object('sessions_used', v_pcredit.sessions_used + 1,
                               'sessions_total', v_pcredit.sessions_total,
                               'sale_id', v_sale_id, 'sale_number', v_number));
  end loop;

  if p_table_order_id is not null then
    update table_orders
       set sale_id = v_sale_id, status = 'cobrada', updated_at = now()
     where id = p_table_order_id and tenant_id = v_tenant;

    update dining_tables
       set status = 'libre', current_order_id = null, waiter_user_id = null
     where id = v_table_order.table_id and tenant_id = v_tenant
       and current_order_id = p_table_order_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            after_data)
    values (v_tenant, auth.uid(), 'table_orders', p_table_order_id, 'table_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'table_id', v_table_order.table_id));
  end if;

  if p_delivery_order_id is not null then
    update delivery_orders
       set sale_id = v_sale_id, status = 'entregado', updated_at = now()
     where id = p_delivery_order_id and tenant_id = v_tenant;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            after_data)
    values (v_tenant, auth.uid(), 'delivery_orders', p_delivery_order_id, 'delivery_charged',
            jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_number,
                               'order_type', v_delivery_order.order_type,
                               'delivery_fee', v_delivery_fee));
  end if;

  return jsonb_build_object('sale_id', v_sale_id, 'number', v_number, 'total', v_total,
                            'tip', v_tip_amount, 'promo_discount', v_promo_disc,
                            'promotions', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', sp.promotion_id, 'label', sp.label, 'kind', sp.kind, 'discount', sp.discount)
                                order by sp.kind desc, sp.created_at)
                              from sale_promotions sp where sp.sale_id = v_sale_id), '[]'::jsonb),
                            'coupon_discount', v_coupon_disc,
                            'perception_total', v_perc, 'cbte_letter', v_tax ->> 'letter',
                            -- ADR-077: diferencias de la venta offline (null fuera de ese modo).
                            'offline_conflicts', case when v_offline then v_off_conf else null end);
end;
$function$;

revoke all on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.create_sale(jsonb, jsonb, numeric, uuid, text, jsonb, uuid, uuid, numeric, uuid, text, uuid, uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- E) Sincronización
-- -----------------------------------------------------------------------------
-- Número desde texto sin explotar (payload armado en el cliente).
create or replace function _offline_num(p text)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  return nullif(btrim(coalesce(p, '')), '')::numeric;
exception when others then
  return null;
end;
$$;
revoke all on function _offline_num(text) from public, anon, authenticated;

-- Respuesta común de la bandeja.
create or replace function _offline_sale_json(p_row offline_sales, p_duplicate boolean)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'client_sale_id', p_row.client_sale_id,
    'status', p_row.status,
    'sale_id', p_row.sale_id,
    'sale_number', p_row.sale_number,
    'sale_total', p_row.sale_total,
    'conflicts', p_row.conflicts,
    'reasons', to_jsonb(p_row.reasons),
    'error', p_row.error,
    'duplicate', p_duplicate);
$$;
revoke all on function _offline_sale_json(offline_sales, boolean) from public, anon, authenticated;

-- Reglas de la venta offline (política del dueño y qué se permite sin
-- conexión). Devuelve los motivos por los que va a revisión; vacío = se
-- intenta registrar. No explota con un payload mal formado.
create or replace function _offline_sale_checks(p_row offline_sales)
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_policy jsonb := offline_policy_effective(p_row.tenant_id);
  v_sale   jsonb := p_row.payload;
  v_items  jsonb := case when jsonb_typeof(p_row.payload -> 'items') = 'array' then p_row.payload -> 'items' else null end;
  v_pays   jsonb := case when jsonb_typeof(p_row.payload -> 'payments') = 'array' then p_row.payload -> 'payments' else null end;
  v_extras jsonb := case when jsonb_typeof(p_row.payload -> 'extras') = 'array' then p_row.payload -> 'extras' else '[]'::jsonb end;
  v_r      text[] := '{}';
  v_total  numeric;
  v_count  int;
begin
  if v_items is null or v_pays is null then
    return array['invalid_payload'];
  end if;
  if not coalesce((v_policy ->> 'enabled')::boolean, true) then
    v_r := v_r || 'offline_disabled'::text;
  end if;

  select coalesce(sum(coalesce(_offline_num(i ->> 'unit_price'), 0) * coalesce(_offline_num(i ->> 'quantity'), 0)
                      - coalesce(_offline_num(i ->> 'discount'), 0)), 0)
    into v_total
    from jsonb_array_elements(v_items) as i;
  v_total := v_total - coalesce(_offline_num(v_sale ->> 'discount_total'), 0)
                     - coalesce(_offline_num(v_sale ->> 'promo_discount'), 0);
  if v_total > coalesce(_offline_num(v_policy ->> 'max_amount'), 50000) + 0.01 then
    v_r := v_r || 'over_amount_limit'::text;
  end if;

  -- Ventas offline previas del mismo usuario en el mismo turno.
  select count(*) into v_count
    from offline_sales o
   where o.tenant_id = p_row.tenant_id and o.cash_shift_id = p_row.cash_shift_id
     and o.submitted_by = p_row.submitted_by and o.id <> p_row.id
     and o.sold_at <= p_row.sold_at;
  if v_count >= coalesce(_offline_num(v_policy ->> 'max_sales'), 20) then
    v_r := v_r || 'over_count_limit'::text;
  end if;

  if p_row.sold_at > now() + interval '10 minutes' then
    v_r := v_r || 'sold_at_in_future'::text;
  elsif p_row.sold_at < now() - make_interval(hours => coalesce(_offline_num(v_policy ->> 'max_hours'), 48)::int) then
    v_r := v_r || 'too_old'::text;
  end if;

  -- Sólo medios manuales sin integración: efectivo, transferencia y tarjeta
  -- en posnet con cupón. Nunca QR, link, terminal integrada, vale ni cuenta.
  if exists (select 1 from jsonb_array_elements(v_pays) as p
              where coalesce(_offline_num(p ->> 'amount'), 0) > 0
                and (coalesce(p ->> 'method', '') not in ('cash', 'transfer', 'debit', 'credit')
                     or coalesce(p -> 'card_voucher' ->> 'origen', '') = 'terminal'
                     or nullif(p -> 'card_voucher' ->> 'terminal_tx', '') is not null)) then
    v_r := v_r || 'method_not_allowed_offline'::text;
  end if;

  if exists (select 1 from jsonb_array_elements(v_extras) as e
              where lower(coalesce(e ->> 'kind', '')) in ('pack', 'pack_session')) then
    v_r := v_r || 'extra_not_allowed_offline'::text;
  end if;

  if exists (select 1 from jsonb_array_elements(v_items) as i
              where coalesce(i ->> 'price_override', '') = 'true') then
    v_r := v_r || 'price_override_offline'::text;
  end if;

  if nullif(v_sale ->> 'coupon_id', '') is not null
     or nullif(v_sale ->> 'table_order_id', '') is not null
     or nullif(v_sale ->> 'delivery_order_id', '') is not null then
    v_r := v_r || 'not_allowed_offline'::text;
  end if;

  if coalesce(p_row.meta ->> 'integrity', 'ok') <> 'ok' then
    v_r := v_r || 'integrity_failed'::text;
  end if;
  return v_r;
end;
$$;
revoke all on function _offline_sale_checks(offline_sales) from public, anon, authenticated;

-- Registra la venta con create_sale en modo offline dentro de un savepoint:
-- si create_sale rechaza, se devuelve el error y la bandeja queda intacta.
-- Mesa, delivery y cupón nunca viajan offline.
create or replace function _offline_run_sale(p_payload jsonb, p_shift uuid, p_client_sale_id uuid, p_sold_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res   jsonb;
  v_sale  uuid;
  v_err   text;
  v_state text;
begin
  perform set_config('ninja.offline_sync', '1', true);
  perform set_config('ninja.offline_sold_at', coalesce(p_sold_at::text, ''), true);
  begin
    v_res := create_sale(
      p_items             => coalesce(p_payload -> 'items', '[]'::jsonb),
      p_payments          => coalesce(p_payload -> 'payments', '[]'::jsonb),
      p_discount_total    => coalesce(_offline_num(p_payload ->> 'discount_total'), 0),
      p_customer_id       => nullif(p_payload ->> 'customer_id', '')::uuid,
      p_notes             => nullif(p_payload ->> 'notes', ''),
      p_extras            => coalesce(p_payload -> 'extras', '[]'::jsonb),
      p_table_order_id    => null,
      p_delivery_order_id => null,
      p_promo_discount    => coalesce(_offline_num(p_payload ->> 'promo_discount'), 0),
      p_promo_id          => nullif(p_payload ->> 'promo_id', '')::uuid,
      p_promo_name        => nullif(p_payload ->> 'promo_name', ''),
      p_coupon_id         => null,
      p_cash_shift_id     => p_shift);
    v_sale := (v_res ->> 'sale_id')::uuid;
    update sales
       set offline_sold_at = p_sold_at, offline_client_id = p_client_sale_id
     where id = v_sale and tenant_id = current_tenant_id();
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    v_err := sqlerrm;
  end;
  perform set_config('ninja.offline_sync', '', true);
  perform set_config('ninja.offline_sold_at', '', true);
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', left(v_err, 500), 'sqlstate', v_state);
  end if;
  return jsonb_build_object('ok', true, 'result', v_res);
end;
$$;
revoke all on function _offline_run_sale(jsonb, uuid, uuid, timestamptz) from public, anon, authenticated;

-- RPC del POS. Idempotente por (negocio, client_sale_id): el reintento
-- devuelve el mismo resultado sin volver a registrar.
--   p_sale: items, payments, discount_total, customer_id, notes, extras,
--           promo_discount, promo_id, promo_name, cash_shift_id.
--   p_meta: sold_at, user_id, device_id, total, payload_hash, integrity,
--           snapshot_at.
-- Errores duros (no se guarda nada y el POS conserva la venta): sin negocio,
-- usuario inactivo, venta de otro usuario, turno inexistente o de otro negocio.
create or replace function sync_offline_sale(p_client_sale_id uuid, p_sale jsonb, p_meta jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_uid     uuid := auth.uid();
  v_meta    jsonb := coalesce(p_meta, '{}'::jsonb);
  v_row     offline_sales%rowtype;
  v_shift   uuid;
  v_store   uuid;
  v_sold_at timestamptz;
  v_bad_at  boolean := false;
  v_reasons text[];
  v_run     jsonb;
  v_conf    jsonb;
begin
  if v_tenant is null or v_uid is null then raise exception 'no_tenant'; end if;
  if not exists (select 1 from tenant_users tu
                  where tu.tenant_id = v_tenant and tu.user_id = v_uid and tu.status = 'active') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_client_sale_id is null or jsonb_typeof(p_sale) is distinct from 'object' then
    raise exception 'invalid_offline_sale';
  end if;
  if nullif(v_meta ->> 'user_id', '') is not null and v_meta ->> 'user_id' <> v_uid::text then
    raise exception 'offline_user_mismatch' using errcode = '42501';
  end if;

  -- Idempotencia: ya recibida (por este usuario) = mismo resultado.
  select * into v_row from offline_sales
   where tenant_id = v_tenant and client_sale_id = p_client_sale_id;
  if found then
    if v_row.submitted_by is distinct from v_uid then
      raise exception 'offline_user_mismatch' using errcode = '42501';
    end if;
    return _offline_sale_json(v_row, true);
  end if;

  begin
    v_shift := nullif(p_sale ->> 'cash_shift_id', '')::uuid;
  exception when others then
    raise exception 'invalid_offline_sale';
  end;
  if v_shift is null then raise exception 'offline_shift_required'; end if;
  select cs.store_id into v_store from cash_shifts cs
   where cs.id = v_shift and cs.tenant_id = v_tenant;
  if not found then raise exception 'shift_not_found' using errcode = '42501'; end if;

  begin
    v_sold_at := coalesce(nullif(v_meta ->> 'sold_at', '')::timestamptz, now());
  exception when others then
    v_sold_at := now();
    v_bad_at := true;
  end;

  insert into offline_sales (tenant_id, client_sale_id, submitted_by, cash_shift_id, store_id,
                             payload, meta, sold_at, status)
  values (v_tenant, p_client_sale_id, v_uid, v_shift, v_store, p_sale, v_meta, v_sold_at, 'processing')
  on conflict (tenant_id, client_sale_id) do nothing
  returning * into v_row;
  if not found then
    -- Otra llamada con el mismo id ganó la carrera: su resultado.
    select * into v_row from offline_sales
     where tenant_id = v_tenant and client_sale_id = p_client_sale_id;
    if v_row.submitted_by is distinct from v_uid then
      raise exception 'offline_user_mismatch' using errcode = '42501';
    end if;
    return _offline_sale_json(v_row, true);
  end if;

  v_reasons := _offline_sale_checks(v_row);
  if v_bad_at then v_reasons := v_reasons || 'invalid_sold_at'::text; end if;

  if cardinality(v_reasons) = 0 then
    v_run := _offline_run_sale(p_sale, v_shift, p_client_sale_id, v_sold_at);
    if coalesce((v_run ->> 'ok')::boolean, false) then
      v_conf := coalesce(nullif(v_run -> 'result' -> 'offline_conflicts', 'null'::jsonb), '[]'::jsonb);
      update offline_sales
         set status = 'synced',
             sale_id = (v_run -> 'result' ->> 'sale_id')::uuid,
             sale_number = (v_run -> 'result' ->> 'number')::bigint,
             sale_total = (v_run -> 'result' ->> 'total')::numeric,
             conflicts = v_conf,
             attempts = attempts + 1,
             processed_at = now()
       where id = v_row.id
      returning * into v_row;
      if jsonb_array_length(v_conf) > 0 then
        insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
        values (v_tenant, v_uid, 'sales', v_row.sale_id, 'offline_sale_conflicts',
                jsonb_build_object('offline_sale_id', v_row.id, 'client_sale_id', p_client_sale_id,
                                   'sale_number', v_row.sale_number, 'sold_at', v_sold_at,
                                   'conflicts', v_conf),
                v_store);
      end if;
      return _offline_sale_json(v_row, false);
    end if;
    v_reasons := array['sale_rejected'];
  end if;

  update offline_sales
     set status = 'needs_review',
         reasons = v_reasons,
         error = v_run ->> 'error',
         attempts = attempts + 1,
         processed_at = now()
   where id = v_row.id
  returning * into v_row;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, v_uid, 'offline_sales', v_row.id, 'offline_sale_needs_review',
          jsonb_build_object('client_sale_id', p_client_sale_id, 'reasons', to_jsonb(v_reasons),
                             'error', v_row.error, 'sold_at', v_sold_at, 'cash_shift_id', v_shift),
          v_store);
  return _offline_sale_json(v_row, false);
end;
$$;
revoke all on function sync_offline_sale(uuid, jsonb, jsonb) from public, anon;
grant execute on function sync_offline_sale(uuid, jsonb, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Revisión del dueño
-- -----------------------------------------------------------------------------
-- p_action:
--   retry       (needs_review) vuelve a registrar sin las reglas de la
--               política (la aprobó quien revisa), en p_cash_shift_id o en el
--               turno original. Si falla, queda en revisión con el error.
--   discard     (needs_review) descarta con motivo obligatorio.
--   resolve     (needs_review) se resolvió por otro lado; motivo obligatorio.
--   acknowledge (synced con diferencias) da por vistas las diferencias.
create or replace function offline_sale_resolve(p_id uuid, p_action text, p_note text default null,
                                                p_cash_shift_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_uid    uuid := auth.uid();
  v_row    offline_sales%rowtype;
  v_before offline_sales%rowtype;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_run    jsonb;
begin
  if v_tenant is null or v_uid is null then raise exception 'no_tenant'; end if;
  if not exists (select 1 from tenant_users tu
                  where tu.tenant_id = v_tenant and tu.user_id = v_uid
                    and tu.status = 'active' and tu.role in ('owner', 'manager')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_row from offline_sales where id = p_id and tenant_id = v_tenant for update;
  if not found then raise exception 'offline_sale_not_found'; end if;
  if v_row.store_id is not null and not user_can_access_store(v_row.store_id) then
    raise exception 'store_not_allowed' using errcode = '42501';
  end if;
  v_before := v_row;
  if v_note is not null then v_note := left(v_note, 500); end if;

  if p_action = 'retry' then
    if v_row.status <> 'needs_review' then raise exception 'offline_sale_not_pending'; end if;
    v_run := _offline_run_sale(v_row.payload, coalesce(p_cash_shift_id, v_row.cash_shift_id),
                               v_row.client_sale_id, v_row.sold_at);
    if coalesce((v_run ->> 'ok')::boolean, false) then
      update offline_sales
         set status = 'synced',
             sale_id = (v_run -> 'result' ->> 'sale_id')::uuid,
             sale_number = (v_run -> 'result' ->> 'number')::bigint,
             sale_total = (v_run -> 'result' ->> 'total')::numeric,
             conflicts = coalesce(nullif(v_run -> 'result' -> 'offline_conflicts', 'null'::jsonb), '[]'::jsonb),
             error = null,
             attempts = attempts + 1,
             processed_at = now(),
             reviewed_at = now(),
             resolved_by = v_uid,
             resolved_at = now(),
             resolution_note = v_note
       where id = v_row.id
      returning * into v_row;
    else
      update offline_sales
         set error = v_run ->> 'error', attempts = attempts + 1, processed_at = now()
       where id = v_row.id
      returning * into v_row;
    end if;
  elsif p_action in ('discard', 'resolve') then
    if v_row.status <> 'needs_review' then raise exception 'offline_sale_not_pending'; end if;
    if v_note is null or char_length(v_note) < 3 then raise exception 'note_required'; end if;
    update offline_sales
       set status = case when p_action = 'discard' then 'discarded' else 'resolved' end,
           reviewed_at = now(), resolved_by = v_uid, resolved_at = now(), resolution_note = v_note
     where id = v_row.id
    returning * into v_row;
  elsif p_action = 'acknowledge' then
    if v_row.status <> 'synced' or v_row.reviewed_at is not null then
      raise exception 'offline_sale_not_pending';
    end if;
    update offline_sales
       set reviewed_at = now(), resolved_by = v_uid, resolution_note = v_note
     where id = v_row.id
    returning * into v_row;
  else
    raise exception 'invalid_action';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason,
                          before_data, after_data, store_id)
  values (v_tenant, v_uid, 'offline_sales', v_row.id, 'offline_sale_' || p_action, v_note,
          jsonb_build_object('status', v_before.status, 'error', v_before.error, 'reasons', to_jsonb(v_before.reasons)),
          jsonb_build_object('status', v_row.status, 'error', v_row.error, 'sale_id', v_row.sale_id,
                             'sale_number', v_row.sale_number,
                             'cash_shift_id', coalesce(p_cash_shift_id, v_row.cash_shift_id)),
          v_row.store_id);
  return _offline_sale_json(v_row, false);
end;
$$;
revoke all on function offline_sale_resolve(uuid, text, text, uuid) from public, anon;
grant execute on function offline_sale_resolve(uuid, text, text, uuid) to authenticated;
