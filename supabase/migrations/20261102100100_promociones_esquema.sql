-- =============================================================================
-- 20261102100100_promociones_esquema  (F9 · H53-H56, ADR-074)
--
-- Completa el modelo de `promotions` (aditivo, no toca promos existentes):
--
--   · Alcance por MARCA (scope 'brand' + scope_brand_id) y alcance con VARIOS
--     ids (scope_ids: categorías, productos o marcas).
--   · Combo / pack a precio fijo por juego completo (action_type 'bundle' +
--     bundle_items = [{product_id, qty}], action_value = precio del juego).
--   · Condiciones de cobro: marcas de tarjeta (card_brands) y bancos (banks),
--     además del medio (payment_method) que ya existía.
--   · Sucursales (store_ids) y listas de precios (price_list_ids). Herencia
--     negocio → sucursal (ADR-049/057): vacío = todo el negocio; con ids = sólo
--     esas sucursales. El dueño crea promos del negocio; un encargado con
--     sucursales asignadas sólo crea o edita promos de sus sucursales.
--   · Topes: max_discount (por ticket), max_uses_total y max_uses_per_customer
--     (cuentan ventas no anuladas en sale_promotions).
--   · Combinabilidad: stackable (acumulable) o excluyente (default, como hoy).
--   · ticket_label: el texto que sale en el ticket (default: el nombre).
--
-- `sale_promotions`: cada promo aplicada en una venta (descuento y regalos),
-- con el reparto por línea. La escribe sólo create_sale (SECURITY DEFINER);
-- lectura del negocio o internal_scope() (ADR-052). Alimenta el ticket, el
-- reporte de rendimiento y los topes de uso.
--
-- RLS de `promotions`: lectura del negocio o internal_scope(); escritura dueño
-- o encargado con la feature `promociones` (gating real) y alcance de
-- sucursal. Auditoría semántica: promotion_created / _updated / _activated /
-- _deactivated / _deleted con antes y después.
-- =============================================================================

alter table promotions
  add column if not exists scope_brand_id        uuid references brands(id) on delete set null,
  add column if not exists scope_ids             uuid[],
  add column if not exists bundle_items          jsonb,
  add column if not exists card_brands           text[],
  add column if not exists banks                 text[],
  add column if not exists store_ids             uuid[],
  add column if not exists price_list_ids        uuid[],
  add column if not exists stackable             boolean not null default false,
  add column if not exists max_discount          numeric(12,2),
  add column if not exists max_uses_total        integer,
  add column if not exists max_uses_per_customer integer,
  add column if not exists ticket_label          text;

-- Los CHECK sin nombre del alcance (20260609210000) se reemplazan por uno que
-- acepta también scope_ids y la marca.
do $$
declare
  r record;
begin
  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.promotions'::regclass
       and c.contype = 'c'
       and (pg_get_constraintdef(c.oid) ilike '%scope_category_id IS NOT NULL%'
            or pg_get_constraintdef(c.oid) ilike '%scope_product_id IS NOT NULL%'
            or (pg_get_constraintdef(c.oid) ilike '%scope%'
                and pg_get_constraintdef(c.oid) ilike '%''cart''%'))
  loop
    execute format('alter table promotions drop constraint %I', r.conname);
  end loop;
end $$;

alter table promotions
  add constraint promotions_scope_check
  check (scope in ('cart', 'category', 'product', 'brand'));

alter table promotions drop constraint if exists promotions_scope_target_check;
alter table promotions
  add constraint promotions_scope_target_check
  check (
    action_type = 'bundle'
    or scope = 'cart'
    or coalesce(cardinality(scope_ids), 0) > 0
    or (scope = 'category' and scope_category_id is not null)
    or (scope = 'product' and scope_product_id is not null)
    or (scope = 'brand' and scope_brand_id is not null)
  );

alter table promotions drop constraint if exists promotions_action_type_check;
alter table promotions
  add constraint promotions_action_type_check
  check (action_type in ('percent', 'amount', 'nxm', 'fixed_price', 'second_item',
                         'volume_tier', 'bundle', 'gift'));

-- Combo: 1 a 10 componentes, cada uno {product_id, qty ≥ 1}.
alter table promotions drop constraint if exists promotions_bundle_check;
alter table promotions
  add constraint promotions_bundle_check
  check (
    action_type <> 'bundle'
    or (bundle_items is not null
        and jsonb_typeof(bundle_items) = 'array'
        and jsonb_array_length(bundle_items) between 1 and 10)
  );

alter table promotions drop constraint if exists promotions_limits_check;
alter table promotions
  add constraint promotions_limits_check
  check (
    (max_discount is null or max_discount >= 0)
    and (max_uses_total is null or max_uses_total >= 1)
    and (max_uses_per_customer is null or max_uses_per_customer >= 1)
    and (ticket_label is null or char_length(ticket_label) <= 40)
    and (card_brands is null or cardinality(card_brands) <= 10)
    and (banks is null or cardinality(banks) <= 20)
  );

comment on column promotions.store_ids is
  'ADR-074: sucursales donde vale la promo. null o vacío = todo el negocio.';
comment on column promotions.stackable is
  'ADR-074: acumulable con otras acumulables. false = excluyente (gana la que más descuenta).';
comment on column promotions.bundle_items is
  'ADR-074: combo [{product_id, qty}]; action_value = precio de cada juego completo.';

-- ── Promos aplicadas en cada venta ───────────────────────────────────────────
create table if not exists sale_promotions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  sale_id      uuid not null references sales(id) on delete cascade,
  promotion_id uuid references promotions(id) on delete set null,
  name         text not null,
  label        text not null,
  kind         text not null default 'discount' check (kind in ('discount', 'gift')),
  -- Descuento otorgado (en 'gift', el valor de lista de lo regalado).
  discount     numeric(12,2) not null default 0 check (discount >= 0),
  customer_id  uuid references customers(id) on delete set null,
  store_id     uuid references stores(id) on delete set null,
  -- Reparto por línea: {"lines": [{"index": n, "discount": x}]}.
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists sale_promotions_sale_idx on sale_promotions(tenant_id, sale_id);
create index if not exists sale_promotions_promo_idx on sale_promotions(promotion_id, customer_id);
create index if not exists sale_promotions_tenant_date_idx on sale_promotions(tenant_id, created_at desc);

alter table sale_promotions enable row level security;
drop policy if exists sale_promotions_select on sale_promotions;
create policy sale_promotions_select on sale_promotions
  for select using (tenant_id = current_tenant_id() or internal_scope());
-- Sin políticas de escritura: la escribe create_sale (SECURITY DEFINER).
revoke insert, update, delete on sale_promotions from anon, authenticated;

-- ── Escritura de promos: rol, plan y sucursales ──────────────────────────────
-- Dueño o encargado activos, con la feature, y con acceso a TODAS las
-- sucursales del alcance (vacío = todas las del negocio: promo del negocio).
create or replace function _promo_can_write(p_tenant uuid, p_store_ids uuid[])
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_allowed uuid[];
  v_need    uuid[];
begin
  if p_tenant is null or p_tenant <> current_tenant_id() then return false; end if;
  if not exists (select 1 from tenant_users me
                  where me.tenant_id = p_tenant and me.user_id = auth.uid()
                    and me.status = 'active' and me.role in ('owner', 'manager')) then
    return false;
  end if;
  if not tenant_has_feature_for(p_tenant, 'promociones') then return false; end if;
  v_allowed := coalesce(user_allowed_store_ids(), '{}');
  if coalesce(cardinality(p_store_ids), 0) = 0 then
    select coalesce(array_agg(s.id), '{}') into v_need
      from stores s where s.tenant_id = p_tenant and s.deleted_at is null;
  else
    v_need := p_store_ids;
  end if;
  return v_need <@ v_allowed;
end;
$$;
revoke all on function _promo_can_write(uuid, uuid[]) from public, anon;
grant execute on function _promo_can_write(uuid, uuid[]) to authenticated;

drop policy if exists promotions_select on promotions;
drop policy if exists promotions_write on promotions;
drop policy if exists promotions_insert on promotions;
drop policy if exists promotions_update on promotions;
drop policy if exists promotions_delete on promotions;

create policy promotions_select on promotions
  for select using (tenant_id = current_tenant_id() or internal_scope());
create policy promotions_insert on promotions
  for insert with check (_promo_can_write(tenant_id, store_ids));
create policy promotions_update on promotions
  for update using (_promo_can_write(tenant_id, store_ids))
  with check (_promo_can_write(tenant_id, store_ids));
create policy promotions_delete on promotions
  for delete using (_promo_can_write(tenant_id, store_ids));

-- ── Auditoría semántica ──────────────────────────────────────────────────────
create or replace function promotions_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'promotion_created';
  elsif tg_op = 'DELETE' then
    v_action := 'promotion_deleted';
  elsif old.deleted_at is null and new.deleted_at is not null then
    v_action := 'promotion_deleted';
  elsif old.is_active and not new.is_active then
    v_action := 'promotion_deactivated';
  elsif not old.is_active and new.is_active then
    v_action := 'promotion_activated';
  else
    v_action := 'promotion_updated';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (coalesce(new.tenant_id, old.tenant_id), auth.uid(), 'promotions',
          coalesce(new.id, old.id), v_action,
          case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end;
$$;
revoke all on function promotions_audit() from public, anon, authenticated;

drop trigger if exists audit_promotions on promotions;
drop trigger if exists promotions_audit on promotions;
create trigger promotions_audit
  after insert or update or delete on promotions
  for each row execute function promotions_audit();
