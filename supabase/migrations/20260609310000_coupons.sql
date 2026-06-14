-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ F9 · H54 — Cupones / códigos                                               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Un cupón da % o monto fijo de descuento al ingresar un código, con monto mínimo,
-- vigencia, tope total de usos y tope opcional por cliente. El enforcement del
-- límite de uso es ATÓMICO en create_sale (lock de la fila + registro de canje;
-- ver migración create_sale_coupon). Acá: tablas, RLS, columnas en sales y la RPC
-- de validación (preview read-only para el POS).

create table if not exists coupons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  code text not null,
  discount_type text not null check (discount_type in ('percent','amount')),
  discount_value numeric(12,2) not null check (discount_value >= 0),
  min_amount numeric(12,2) not null default 0 check (min_amount >= 0),
  valid_from date,
  valid_to date,
  max_uses integer check (max_uses is null or max_uses >= 1),
  used_count integer not null default 0,
  max_per_customer integer check (max_per_customer is null or max_per_customer >= 1),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint coupons_pct_check check (discount_type <> 'percent' or discount_value <= 100)
);
create unique index if not exists coupons_code_uq on coupons (tenant_id, lower(code)) where deleted_at is null;

create table if not exists coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  coupon_id uuid not null references coupons(id) on delete cascade,
  sale_id uuid references sales(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  discount numeric(12,2) not null default 0,
  redeemed_at timestamptz not null default now()
);
create index if not exists coupon_redemptions_coupon_idx on coupon_redemptions (coupon_id);
create index if not exists coupon_redemptions_customer_idx on coupon_redemptions (coupon_id, customer_id);

alter table coupons enable row level security;
alter table coupon_redemptions enable row level security;

drop policy if exists coupons_select on coupons;
create policy coupons_select on coupons for select using (tenant_id = current_tenant_id());
drop policy if exists coupons_write on coupons;
create policy coupons_write on coupons for all
  using (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = (select auth.uid()) and me.status = 'active'
      and me.role = any (array['owner','manager'])))
  with check (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = (select auth.uid()) and me.status = 'active'
      and me.role = any (array['owner','manager'])));

drop policy if exists coupon_redemptions_select on coupon_redemptions;
create policy coupon_redemptions_select on coupon_redemptions for select using (tenant_id = current_tenant_id());
-- Escritura sólo vía create_sale (SECURITY DEFINER); no hay policy de write para usuarios.

alter table sales add column if not exists coupon_id uuid references coupons(id) on delete set null;
alter table sales add column if not exists coupon_code text;
alter table sales add column if not exists coupon_discount numeric(12,2) not null default 0;

-- Validación read-only (preview para el POS): NO consume el cupón. Devuelve el
-- descuento calculado para el subtotal dado o un motivo de rechazo.
create or replace function public.validate_coupon(p_code text, p_subtotal numeric, p_customer_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tenant uuid := current_tenant_id();
  v_c coupons%rowtype;
  v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_disc numeric;
  v_uses int;
begin
  if v_tenant is null then return jsonb_build_object('ok', false, 'reason', 'no_tenant'); end if;
  select * into v_c from coupons
   where tenant_id = v_tenant and deleted_at is null and lower(code) = lower(btrim(p_code))
   limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if not v_c.is_active then return jsonb_build_object('ok', false, 'reason', 'inactive'); end if;
  if v_c.valid_from is not null and v_today < v_c.valid_from then return jsonb_build_object('ok', false, 'reason', 'not_yet'); end if;
  if v_c.valid_to is not null and v_today > v_c.valid_to then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if v_c.max_uses is not null and v_c.used_count >= v_c.max_uses then return jsonb_build_object('ok', false, 'reason', 'usage_exceeded'); end if;
  if v_c.max_per_customer is not null then
    if p_customer_id is null then return jsonb_build_object('ok', false, 'reason', 'needs_customer'); end if;
    select count(*) into v_uses from coupon_redemptions where coupon_id = v_c.id and customer_id = p_customer_id;
    if v_uses >= v_c.max_per_customer then return jsonb_build_object('ok', false, 'reason', 'customer_exceeded'); end if;
  end if;
  if coalesce(p_subtotal, 0) < coalesce(v_c.min_amount, 0) then
    return jsonb_build_object('ok', false, 'reason', 'min_amount', 'min_amount', v_c.min_amount);
  end if;
  v_disc := case when v_c.discount_type = 'percent'
                 then coalesce(p_subtotal, 0) * v_c.discount_value / 100
                 else v_c.discount_value end;
  v_disc := least(greatest(v_disc, 0), greatest(coalesce(p_subtotal, 0), 0));
  return jsonb_build_object(
    'ok', true, 'coupon_id', v_c.id, 'code', v_c.code,
    'discount_type', v_c.discount_type, 'discount_value', v_c.discount_value,
    'min_amount', v_c.min_amount, 'discount', round(v_disc * 100) / 100
  );
end;
$function$;
revoke all on function public.validate_coupon(text, numeric, uuid) from public;
grant execute on function public.validate_coupon(text, numeric, uuid) to authenticated;
