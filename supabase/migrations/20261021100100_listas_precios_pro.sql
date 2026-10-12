-- =============================================================================
-- 20261021100100_listas_precios_pro  (F18 · H100, ADR-058)
--
-- Modelo de listas de precios PRO. Todo es aditivo: una lista existente queda
-- como 'fixed' (% sobre la base y precio fijo por producto), igual que hoy.
--
--   A) price_lists: tipo (fixed / derived / cost / currency), lista madre,
--      monto fijo además del %, base de costo y markup o margen, moneda y
--      fuente de cotización, redondeo (jsonb), margen mínimo, vigencia
--      (desde / hasta) y "elegible en el POS".
--      products.min_price: piso de precio de venta (PRO).
--   B) price_list_breaks: escalas por cantidad (por producto, variante o toda
--      la lista; precio fijo o %).
--   C) payment_terms: condiciones de pago (contado, 30, 60, 90 días) con
--      recargo financiero; customers.payment_term_id (condición de la ficha).
--   D) price_list_assignments: lista por cliente, grupo de clientes, sucursal
--      o grupo de sucursales (herencia negocio ← grupo ← sucursal, ADR-049).
--   E) fx_rates (cotizaciones por moneda y fuente) y price_index_values
--      (IPC u otro índice cargado a mano).
--   F) price_schedules: precios futuros programados por fecha. El resolver los
--      aplica solo cuando llega la fecha (sin cron); price_schedules_apply_due
--      los consolida después. Un cambio manual posterior los da por aplicados.
--   G) price_settings: modo simple / profesional y aprobación de cambios masivos.
--
-- Gating (CLAUDE.md §6): lo PRO exige `listas_precios_pro` (y `listas_precios`)
-- en triggers y policies; las asignaciones exigen `listas_precios` y, por
-- sucursal, `multi_sucursal`. Bajar de plan no borra nada: el resolver deja de
-- aplicarlo. RLS de lectura: negocio actual o internal_scope() (ADR-052).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helpers de gating
-- -----------------------------------------------------------------------------
create or replace function price_pro_enabled(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(tenant_has_feature_for(p_tenant, 'listas_precios'), false)
     and coalesce(tenant_has_feature_for(p_tenant, 'listas_precios_pro'), false);
$$;
revoke all on function price_pro_enabled(uuid) from public, anon;
grant execute on function price_pro_enabled(uuid) to authenticated, service_role;

-- Dueño o encargado del negocio actual con listas de precios.
create or replace function price_can_write()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(stock_my_role() in ('owner', 'manager'), false)
     and coalesce(tenant_has_feature_for(current_tenant_id(), 'listas_precios'), false);
$$;
revoke all on function price_can_write() from public, anon;
grant execute on function price_can_write() to authenticated;

create or replace function price_pro_can_write()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(stock_my_role() in ('owner', 'manager'), false)
     and price_pro_enabled(current_tenant_id());
$$;
revoke all on function price_pro_can_write() from public, anon;
grant execute on function price_pro_can_write() to authenticated;

-- Forma de la regla de redondeo (null = sin redondeo). Espejo de lib/prices/rounding.ts.
create or replace function price_rounding_error(p jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_mode text;
  v_num  numeric;
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'object' then return 'invalid_rounding'; end if;
  v_mode := coalesce(p ->> 'mode', 'none');
  if v_mode not in ('none', 'multiple', 'ending') then return 'invalid_rounding'; end if;
  if coalesce(p ->> 'direction', 'nearest') not in ('up', 'down', 'nearest') then return 'invalid_rounding'; end if;
  begin
    if v_mode = 'multiple' then
      v_num := (p ->> 'step')::numeric;
      if v_num is null or v_num <= 0 or v_num > 1000000 then return 'invalid_rounding'; end if;
    elsif v_mode = 'ending' then
      v_num := (p ->> 'ending')::numeric;
      if v_num is null or v_num < 0 or v_num >= 100000 or v_num <> round(v_num, 2) then return 'invalid_rounding'; end if;
    end if;
  exception when others then
    return 'invalid_rounding';
  end;
  return null;
end;
$$;
grant execute on function price_rounding_error(jsonb) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- A) price_lists PRO
-- -----------------------------------------------------------------------------
alter table price_lists add column if not exists kind text not null default 'fixed';
alter table price_lists add column if not exists base_list_id uuid references price_lists(id) on delete set null;
alter table price_lists add column if not exists adjustment_amount numeric(12,2);
alter table price_lists add column if not exists cost_basis text;
alter table price_lists add column if not exists markup_mode text;
alter table price_lists add column if not exists markup_value numeric(8,2);
alter table price_lists add column if not exists currency text;
alter table price_lists add column if not exists fx_source text;
alter table price_lists add column if not exists rounding jsonb;
alter table price_lists add column if not exists min_margin_pct numeric(6,2);
alter table price_lists add column if not exists valid_from timestamptz;
alter table price_lists add column if not exists valid_to timestamptz;
alter table price_lists add column if not exists pos_selectable boolean not null default false;
alter table price_lists add column if not exists notes text;

alter table price_lists drop constraint if exists price_lists_pro_check;
alter table price_lists add constraint price_lists_pro_check check (
  kind in ('fixed', 'derived', 'cost', 'currency')
  and (cost_basis is null or cost_basis in ('cost', 'last', 'average', 'replacement'))
  and (markup_mode is null or markup_mode in ('markup', 'margin'))
  and (markup_value is null or (markup_value > -100 and markup_value <= 10000))
  and (markup_mode is distinct from 'margin' or markup_value is null or markup_value < 100)
  and (currency is null or currency ~ '^[A-Z]{3}$')
  and (fx_source is null or fx_source in ('oficial', 'mep', 'bna', 'manual'))
  and (min_margin_pct is null or (min_margin_pct >= 0 and min_margin_pct < 100))
  and (adjustment_amount is null or abs(adjustment_amount) <= 100000000)
  and (valid_from is null or valid_to is null or valid_from < valid_to)
  and (base_list_id is null or base_list_id <> id)
  and (kind <> 'derived' or base_list_id is not null)
  and (kind <> 'currency' or currency is not null)
  and (notes is null or char_length(notes) <= 500)
);

comment on column price_lists.kind is
  'ADR-058: fixed (% y monto sobre la base, precio fijo por producto), derived (de base_list_id), cost (costo × markup o margen), currency (ítems en moneda × cotización).';
comment on column price_lists.rounding is
  'ADR-058: {mode: none|multiple|ending, step, ending, direction: up|down|nearest}. Sólo redondea precios calculados.';

-- Piso de precio de venta del producto (PRO).
alter table products add column if not exists min_price numeric(12,2);
alter table products drop constraint if exists products_min_price_check;
alter table products add constraint products_min_price_check check (min_price is null or min_price >= 0);

-- Gating PRO de las columnas nuevas: sólo cuando cambian (un negocio que bajó
-- de plan puede seguir activando, desactivando o borrando sus listas).
create or replace function trg_price_lists_pro()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_err text;
  v_pro boolean;
begin
  v_err := price_rounding_error(new.rounding);
  if v_err is not null then raise exception '%', v_err using errcode = 'check_violation'; end if;

  if new.base_list_id is not null and not exists (
       select 1 from price_lists b where b.id = new.base_list_id and b.tenant_id = new.tenant_id) then
    raise exception 'base_list_not_found' using errcode = 'check_violation';
  end if;

  v_pro := (new.kind <> 'fixed'
            or (new.rounding is not null and coalesce(new.rounding ->> 'mode', 'none') <> 'none')
            or new.min_margin_pct is not null
            or new.base_list_id is not null
            or new.currency is not null);
  if v_pro and (tg_op = 'INSERT'
                or new.kind is distinct from old.kind
                or new.base_list_id is distinct from old.base_list_id
                or new.cost_basis is distinct from old.cost_basis
                or new.markup_mode is distinct from old.markup_mode
                or new.markup_value is distinct from old.markup_value
                or new.currency is distinct from old.currency
                or new.fx_source is distinct from old.fx_source
                or new.rounding is distinct from old.rounding
                or new.min_margin_pct is distinct from old.min_margin_pct)
     and not price_pro_enabled(new.tenant_id) then
    raise exception 'feature_not_in_plan: listas_precios_pro' using errcode = 'check_violation';
  end if;

  -- Evitar ciclos de derivación (A → B → A).
  if new.base_list_id is not null then
    if exists (
      with recursive chain(id, depth) as (
        select new.base_list_id, 1
        union all
        select l.base_list_id, c.depth + 1
          from price_lists l join chain c on l.id = c.id
         where l.base_list_id is not null and c.depth < 10)
      select 1 from chain where id = new.id) then
      raise exception 'price_list_cycle' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function trg_price_lists_pro() from public, anon, authenticated;

drop trigger if exists price_lists_pro on price_lists;
create trigger price_lists_pro
  before insert or update on price_lists
  for each row execute function trg_price_lists_pro();

create or replace function trg_products_min_price()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.min_price is not null
     and (tg_op = 'INSERT' or new.min_price is distinct from old.min_price)
     and not price_pro_enabled(new.tenant_id) then
    raise exception 'feature_not_in_plan: listas_precios_pro' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function trg_products_min_price() from public, anon, authenticated;

drop trigger if exists products_min_price on products;
create trigger products_min_price
  before insert or update of min_price on products
  for each row execute function trg_products_min_price();

-- -----------------------------------------------------------------------------
-- B) Escalas por cantidad
-- -----------------------------------------------------------------------------
create table if not exists price_list_breaks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  price_list_id uuid not null references price_lists(id) on delete cascade,
  product_id    uuid references products(id) on delete cascade,
  variant_id    uuid references product_variants(id) on delete cascade,
  min_qty       numeric(12,3) not null check (min_qty > 0 and min_qty <= 1000000),
  kind          text not null check (kind in ('price', 'pct')),
  value         numeric(12,2) not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (variant_id is null or product_id is not null),
  check ((kind = 'price' and value >= 0) or (kind = 'pct' and value > -100 and value <= 1000))
);
create unique index if not exists price_list_breaks_key on price_list_breaks(
  price_list_id,
  coalesce(product_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  min_qty);
create index if not exists price_list_breaks_tenant_idx on price_list_breaks(tenant_id);
create index if not exists price_list_breaks_product_idx on price_list_breaks(product_id) where product_id is not null;
create index if not exists price_list_breaks_variant_idx on price_list_breaks(variant_id) where variant_id is not null;

drop trigger if exists set_updated_at_price_list_breaks on price_list_breaks;
create trigger set_updated_at_price_list_breaks
  before update on price_list_breaks
  for each row execute function set_updated_at();

-- La lista, el producto y la variante tienen que ser del mismo negocio.
create or replace function trg_price_breaks_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from price_lists l where l.id = new.price_list_id and l.tenant_id = new.tenant_id) then
    raise exception 'price_list_not_found' using errcode = 'check_violation';
  end if;
  if new.product_id is not null and not exists (
       select 1 from products p where p.id = new.product_id and p.tenant_id = new.tenant_id) then
    raise exception 'product_not_found' using errcode = 'check_violation';
  end if;
  if new.variant_id is not null and not exists (
       select 1 from product_variants v where v.id = new.variant_id and v.product_id = new.product_id
          and v.tenant_id = new.tenant_id) then
    raise exception 'variant_not_found' using errcode = 'check_violation';
  end if;
  if not price_pro_enabled(new.tenant_id) then
    raise exception 'feature_not_in_plan: listas_precios_pro' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function trg_price_breaks_check() from public, anon, authenticated;

drop trigger if exists price_list_breaks_check on price_list_breaks;
create trigger price_list_breaks_check
  before insert or update on price_list_breaks
  for each row execute function trg_price_breaks_check();

alter table price_list_breaks enable row level security;
drop policy if exists price_list_breaks_select on price_list_breaks;
create policy price_list_breaks_select on price_list_breaks
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists price_list_breaks_insert on price_list_breaks;
create policy price_list_breaks_insert on price_list_breaks
  for insert with check (tenant_id = (select current_tenant_id()) and (select price_pro_can_write()));
drop policy if exists price_list_breaks_update on price_list_breaks;
create policy price_list_breaks_update on price_list_breaks
  for update using (tenant_id = (select current_tenant_id()) and (select price_pro_can_write()))
  with check (tenant_id = (select current_tenant_id()) and (select price_pro_can_write()));
-- Una escala es configuración de la lista (como un ítem): se borra físicamente.
drop policy if exists price_list_breaks_delete on price_list_breaks;
create policy price_list_breaks_delete on price_list_breaks
  for delete using (tenant_id = (select current_tenant_id())
                    and coalesce((select stock_my_role()) in ('owner', 'manager'), false));

drop trigger if exists audit_price_list_breaks on price_list_breaks;
create trigger audit_price_list_breaks
  after insert or update or delete on price_list_breaks
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- C) Condiciones de pago
-- -----------------------------------------------------------------------------
create table if not exists payment_terms (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  days          int not null default 0 check (days between 0 and 365),
  surcharge_pct numeric(7,3) not null default 0 check (surcharge_pct > -100 and surcharge_pct <= 300),
  -- Cómo se calculó (sólo para mostrar el cálculo): tasa mensual, simple o compuesto.
  rate_mode     text not null default 'flat' check (rate_mode in ('flat', 'simple', 'compound')),
  monthly_rate  numeric(7,3) check (monthly_rate is null or (monthly_rate >= 0 and monthly_rate <= 100)),
  is_active     boolean not null default true,
  sort          int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index if not exists payment_terms_name_key
  on payment_terms(tenant_id, lower(name)) where deleted_at is null;

drop trigger if exists set_updated_at_payment_terms on payment_terms;
create trigger set_updated_at_payment_terms
  before update on payment_terms
  for each row execute function set_updated_at();

alter table payment_terms enable row level security;
drop policy if exists payment_terms_select on payment_terms;
create policy payment_terms_select on payment_terms
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists payment_terms_insert on payment_terms;
create policy payment_terms_insert on payment_terms
  for insert with check (tenant_id = (select current_tenant_id()) and (select price_pro_can_write()));
drop policy if exists payment_terms_update on payment_terms;
create policy payment_terms_update on payment_terms
  for update using (tenant_id = (select current_tenant_id()) and (select price_pro_can_write()))
  with check (tenant_id = (select current_tenant_id()) and (select price_pro_can_write()));
-- Sin DELETE: baja lógica.

drop trigger if exists audit_payment_terms on payment_terms;
create trigger audit_payment_terms
  after insert or update or delete on payment_terms
  for each row execute function write_audit_log();

alter table customers add column if not exists payment_term_id uuid references payment_terms(id) on delete set null;
create index if not exists customers_payment_term_idx on customers(payment_term_id) where payment_term_id is not null;

create or replace function trg_customers_payment_term()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.payment_term_id is not null
     and (tg_op = 'INSERT' or new.payment_term_id is distinct from old.payment_term_id) then
    if not exists (select 1 from payment_terms t where t.id = new.payment_term_id
                    and t.tenant_id = new.tenant_id and t.deleted_at is null) then
      raise exception 'payment_term_not_found' using errcode = 'check_violation';
    end if;
    if not price_pro_enabled(new.tenant_id) then
      raise exception 'feature_not_in_plan: listas_precios_pro' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function trg_customers_payment_term() from public, anon, authenticated;

drop trigger if exists customers_payment_term on customers;
create trigger customers_payment_term
  before insert or update of payment_term_id on customers
  for each row execute function trg_customers_payment_term();

-- -----------------------------------------------------------------------------
-- D) Asignación de listas (cliente, grupo, sucursal, grupo de sucursales)
-- -----------------------------------------------------------------------------
create table if not exists price_list_assignments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  price_list_id uuid not null references price_lists(id) on delete cascade,
  scope         text not null check (scope in ('customer', 'customer_group', 'store', 'store_group')),
  scope_id      uuid not null,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);
-- Una lista por destino.
create unique index if not exists price_list_assignments_key
  on price_list_assignments(tenant_id, scope, scope_id);
create index if not exists price_list_assignments_list_idx on price_list_assignments(price_list_id);

create or replace function trg_price_assignments_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ok boolean;
begin
  if not exists (select 1 from price_lists l where l.id = new.price_list_id and l.tenant_id = new.tenant_id
                  and l.deleted_at is null) then
    raise exception 'price_list_not_found' using errcode = 'check_violation';
  end if;
  v_ok := case new.scope
    when 'customer' then exists (select 1 from customers c where c.id = new.scope_id and c.tenant_id = new.tenant_id)
    when 'customer_group' then exists (select 1 from customer_groups g where g.id = new.scope_id and g.tenant_id = new.tenant_id)
    when 'store' then exists (select 1 from stores s where s.id = new.scope_id and s.tenant_id = new.tenant_id)
    else exists (select 1 from store_groups g where g.id = new.scope_id and g.tenant_id = new.tenant_id)
  end;
  if not v_ok then raise exception 'scope_not_found' using errcode = 'check_violation'; end if;
  if not tenant_has_feature_for(new.tenant_id, 'listas_precios') then
    raise exception 'feature_not_in_plan: listas_precios' using errcode = 'check_violation';
  end if;
  if new.scope in ('store', 'store_group') and not tenant_has_feature_for(new.tenant_id, 'multi_sucursal') then
    raise exception 'feature_not_in_plan: multi_sucursal' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function trg_price_assignments_check() from public, anon, authenticated;

drop trigger if exists price_list_assignments_check on price_list_assignments;
create trigger price_list_assignments_check
  before insert or update on price_list_assignments
  for each row execute function trg_price_assignments_check();

alter table price_list_assignments enable row level security;
drop policy if exists price_list_assignments_select on price_list_assignments;
create policy price_list_assignments_select on price_list_assignments
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists price_list_assignments_insert on price_list_assignments;
create policy price_list_assignments_insert on price_list_assignments
  for insert with check (tenant_id = (select current_tenant_id()) and (select price_can_write()));
drop policy if exists price_list_assignments_update on price_list_assignments;
create policy price_list_assignments_update on price_list_assignments
  for update using (tenant_id = (select current_tenant_id()) and (select price_can_write()))
  with check (tenant_id = (select current_tenant_id()) and (select price_can_write()));
-- Quitar la asignación = volver a heredar (configuración, como un override).
drop policy if exists price_list_assignments_delete on price_list_assignments;
create policy price_list_assignments_delete on price_list_assignments
  for delete using (tenant_id = (select current_tenant_id())
                    and coalesce((select stock_my_role()) in ('owner', 'manager'), false));

drop trigger if exists audit_price_list_assignments on price_list_assignments;
create trigger audit_price_list_assignments
  after insert or update or delete on price_list_assignments
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- E) Cotizaciones e índices
-- -----------------------------------------------------------------------------
create table if not exists fx_rates (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  currency   text not null check (currency ~ '^[A-Z]{3}$' and currency <> 'ARS'),
  source     text not null check (source in ('oficial', 'mep', 'bna', 'manual')),
  rate_date  date not null,
  rate       numeric(14,4) not null check (rate > 0 and rate < 100000000),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index if not exists fx_rates_key on fx_rates(tenant_id, currency, source, rate_date);

alter table fx_rates enable row level security;
drop policy if exists fx_rates_select on fx_rates;
create policy fx_rates_select on fx_rates
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists fx_rates_insert on fx_rates;
create policy fx_rates_insert on fx_rates
  for insert with check (tenant_id = (select current_tenant_id()) and (select price_pro_can_write()));
drop policy if exists fx_rates_update on fx_rates;
create policy fx_rates_update on fx_rates
  for update using (tenant_id = (select current_tenant_id()) and (select price_pro_can_write()))
  with check (tenant_id = (select current_tenant_id()) and (select price_pro_can_write()));

drop trigger if exists audit_fx_rates on fx_rates;
create trigger audit_fx_rates
  after insert or update or delete on fx_rates
  for each row execute function write_audit_log();

create table if not exists price_index_values (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  index_key  text not null check (index_key ~ '^[a-z0-9_]{2,30}$'),
  period     date not null,
  value      numeric(16,4) not null check (value > 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index if not exists price_index_values_key on price_index_values(tenant_id, index_key, period);

alter table price_index_values enable row level security;
drop policy if exists price_index_values_select on price_index_values;
create policy price_index_values_select on price_index_values
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists price_index_values_insert on price_index_values;
create policy price_index_values_insert on price_index_values
  for insert with check (tenant_id = (select current_tenant_id()) and (select price_pro_can_write()));
drop policy if exists price_index_values_update on price_index_values;
create policy price_index_values_update on price_index_values
  for update using (tenant_id = (select current_tenant_id()) and (select price_pro_can_write()))
  with check (tenant_id = (select current_tenant_id()) and (select price_pro_can_write()));

drop trigger if exists audit_price_index_values on price_index_values;
create trigger audit_price_index_values
  after insert or update or delete on price_index_values
  for each row execute function write_audit_log();

-- -----------------------------------------------------------------------------
-- F) Precios programados
-- -----------------------------------------------------------------------------
create table if not exists price_schedules (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  list_id      uuid references price_lists(id) on delete cascade,   -- null = precio base
  product_id   uuid not null references products(id) on delete cascade,
  variant_id   uuid references product_variants(id) on delete cascade,
  price        numeric(12,2) not null check (price >= 0),
  effective_at timestamptz not null,
  status       text not null default 'scheduled'
                 check (status in ('pending', 'scheduled', 'applied', 'cancelled')),
  batch_id     uuid,
  source       text not null default 'manual' check (source in ('manual', 'import', 'bulk', 'list')),
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  applied_at   timestamptz
);
create index if not exists price_schedules_lookup_idx
  on price_schedules(product_id, effective_at desc) where status = 'scheduled';
create index if not exists price_schedules_tenant_idx on price_schedules(tenant_id, effective_at);
create index if not exists price_schedules_list_idx on price_schedules(list_id) where list_id is not null;
create index if not exists price_schedules_variant_idx on price_schedules(variant_id) where variant_id is not null;
create index if not exists price_schedules_batch_idx on price_schedules(batch_id) where batch_id is not null;

alter table price_schedules enable row level security;
revoke insert, update, delete on price_schedules from anon, authenticated;
drop policy if exists price_schedules_select on price_schedules;
create policy price_schedules_select on price_schedules
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

-- Un cambio manual del precio (o de un ítem) da por aplicados los programados
-- que ya vencieron para ese mismo destino: gana lo último que se hizo.
create or replace function _price_consume_due(p_list uuid, p_product uuid, p_variant uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update price_schedules s
     set status = 'applied', applied_at = coalesce(s.applied_at, now())
   where s.status = 'scheduled'
     and s.effective_at <= now()
     and s.product_id = p_product
     and s.list_id is not distinct from p_list
     and s.variant_id is not distinct from p_variant;
$$;
revoke all on function _price_consume_due(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function trg_price_consume_due()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_table_name = 'products' then
    if tg_op = 'UPDATE' and new.price is not distinct from old.price then return null; end if;
    perform _price_consume_due(null, new.id, null);
  elsif tg_table_name = 'product_variants' then
    if tg_op = 'UPDATE' and new.price_override is not distinct from old.price_override then return null; end if;
    perform _price_consume_due(null, new.product_id, new.id);
  else
    if tg_op = 'UPDATE' and new.price is not distinct from old.price then return null; end if;
    perform _price_consume_due(new.price_list_id, new.product_id, new.variant_id);
  end if;
  return null;
end;
$$;
revoke all on function trg_price_consume_due() from public, anon, authenticated;

drop trigger if exists products_price_consume_due on products;
create trigger products_price_consume_due
  after update of price on products
  for each row execute function trg_price_consume_due();
drop trigger if exists product_variants_price_consume_due on product_variants;
create trigger product_variants_price_consume_due
  after update of price_override on product_variants
  for each row execute function trg_price_consume_due();
drop trigger if exists price_list_items_consume_due on price_list_items;
create trigger price_list_items_consume_due
  after insert or update of price on price_list_items
  for each row execute function trg_price_consume_due();

-- -----------------------------------------------------------------------------
-- G) Configuración de precios por negocio
-- -----------------------------------------------------------------------------
create table if not exists price_settings (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  mode             text not null default 'simple' check (mode in ('simple', 'pro')),
  require_approval boolean not null default false,
  label_queue      boolean not null default true,
  updated_at       timestamptz not null default now(),
  updated_by       uuid default auth.uid()
);

alter table price_settings enable row level security;
revoke insert, update, delete on price_settings from anon, authenticated;
drop policy if exists price_settings_select on price_settings;
create policy price_settings_select on price_settings
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

create or replace function price_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v price_settings%rowtype;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  select * into v from price_settings where tenant_id = v_tenant;
  return jsonb_build_object(
    'mode', coalesce(v.mode, 'simple'),
    'require_approval', coalesce(v.require_approval, false),
    'label_queue', coalesce(v.label_queue, true),
    'pro', price_pro_enabled(v_tenant));
end;
$$;
revoke all on function price_settings_get() from public, anon;
grant execute on function price_settings_get() to authenticated;

-- Modo profesional y aprobación exigen la feature PRO; sólo el dueño cambia la
-- aprobación (es un control sobre el encargado).
create or replace function price_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text := stock_my_role();
  v_before jsonb;
  v_mode   text;
  v_appr   boolean;
  v_labels boolean;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_before := price_settings_get();
  v_mode   := coalesce(p ->> 'mode', v_before ->> 'mode');
  v_appr   := coalesce((p ->> 'require_approval')::boolean, (v_before ->> 'require_approval')::boolean);
  v_labels := coalesce((p ->> 'label_queue')::boolean, (v_before ->> 'label_queue')::boolean);
  if v_mode not in ('simple', 'pro') then raise exception 'invalid_mode'; end if;
  if (v_mode = 'pro' and v_before ->> 'mode' <> 'pro') or (v_appr and not (v_before ->> 'require_approval')::boolean) then
    if not price_pro_enabled(v_tenant) then
      raise exception 'feature_not_in_plan: listas_precios_pro' using errcode = 'check_violation';
    end if;
  end if;
  if v_appr is distinct from (v_before ->> 'require_approval')::boolean and v_role <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into price_settings as s (tenant_id, mode, require_approval, label_queue, updated_at, updated_by)
  values (v_tenant, v_mode, v_appr, v_labels, now(), auth.uid())
  on conflict (tenant_id) do update
    set mode = excluded.mode, require_approval = excluded.require_approval,
        label_queue = excluded.label_queue, updated_at = now(), updated_by = auth.uid();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'price_settings', v_tenant, 'price_settings_changed', v_before,
          jsonb_build_object('mode', v_mode, 'require_approval', v_appr, 'label_queue', v_labels));
  return price_settings_get();
end;
$$;
revoke all on function price_settings_save(jsonb) from public, anon;
grant execute on function price_settings_save(jsonb) to authenticated;
