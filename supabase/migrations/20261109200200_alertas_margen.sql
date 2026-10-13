-- =============================================================================
-- 20261109200200_alertas_margen  (ADR-092 · F14 · H67)
--
-- Costos y márgenes con alertas. Feature BASE `alertas_margen`.
--
--   A) margin_alert_settings: margen mínimo del negocio (sobre el precio de
--      venta) y si se avisa. Lectura del negocio; escritura sólo por RPC
--      (dueño o encargado), auditada.
--   B) margin_alerts(): productos activos con costo y precio cargados cuyo
--      margen está debajo del mínimo, es negativo (se vende bajo costo) o
--      cuyo precio está por debajo del precio mínimo (products.min_price,
--      ADR-058). Devuelve el precio sugerido para volver al mínimo.
--      margin_summary(): cuántos están en cada caso y cuántos no tienen
--      costo. Las dos, sólo dueño o encargado (el costo no lo ve el cajero).
--   C) Aviso: trigger AFTER UPDATE OF cost, price en products. Cuando un
--      producto CRUZA el mínimo hacia abajo (una recepción que sube el costo,
--      un cambio de precio) avisa a dueño y encargado, como mucho una vez
--      cada 30 minutos por negocio (una recepción de 200 productos no inunda
--      la campana). Sólo dispara si cambia costo o precio: no toca la venta
--      (create_sale actualiza stock, no costo ni precio).
--
-- Margen = (precio - costo) / precio. El costo es products.cost, que ya
-- sigue la base de costo elegida en Compras (último, promedio o
-- reposición, ADR-050). Las variantes con precio propio quedan fuera de este
-- primer corte (deuda en ADR-092).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Configuración.
-- -----------------------------------------------------------------------------
create table if not exists margin_alert_settings (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  min_margin_pct   numeric(5,2) not null default 20 check (min_margin_pct >= 0 and min_margin_pct < 100),
  notify           boolean not null default true,
  last_notified_at timestamptz,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references users(id) on delete set null
);

create index if not exists margin_alert_settings_updated_by_idx
  on margin_alert_settings (updated_by) where updated_by is not null;

alter table margin_alert_settings enable row level security;
drop policy if exists margin_alert_settings_select on margin_alert_settings;
create policy margin_alert_settings_select on margin_alert_settings
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
revoke insert, update, delete on margin_alert_settings from anon, authenticated;

create or replace function _margin_assert()
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
  if not tenant_has_feature_for(v_tenant, 'alertas_margen') then
    raise exception 'feature_not_in_plan: alertas_margen';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _margin_assert() from public, anon, authenticated;

create or replace function margin_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _margin_assert();
  v_s      margin_alert_settings;
begin
  select * into v_s from margin_alert_settings where tenant_id = v_tenant;
  return jsonb_build_object('min_margin_pct', coalesce(v_s.min_margin_pct, 20),
                            'notify', coalesce(v_s.notify, true));
end;
$$;
revoke all on function margin_settings_get() from public, anon;
grant execute on function margin_settings_get() to authenticated;

create or replace function margin_settings_save(p_min_margin_pct numeric, p_notify boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _margin_assert();
  v_before jsonb;
begin
  if p_min_margin_pct is null or p_min_margin_pct < 0 or p_min_margin_pct >= 100 then
    raise exception 'invalid_margin';
  end if;
  select to_jsonb(s) into v_before from margin_alert_settings s where s.tenant_id = v_tenant;

  insert into margin_alert_settings as s (tenant_id, min_margin_pct, notify, updated_at, updated_by)
  values (v_tenant, round(p_min_margin_pct, 2), coalesce(p_notify, true), now(), auth.uid())
  on conflict (tenant_id) do update
    set min_margin_pct = excluded.min_margin_pct, notify = excluded.notify,
        updated_at = now(), updated_by = auth.uid();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'margin_alert_settings', v_tenant, 'margin_settings_updated',
          v_before, jsonb_build_object('min_margin_pct', round(p_min_margin_pct, 2),
                                       'notify', coalesce(p_notify, true)));
  return margin_settings_get();
end;
$$;
revoke all on function margin_settings_save(numeric, boolean) from public, anon;
grant execute on function margin_settings_save(numeric, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Lecturas (espejo de lib/commercial/margins.ts).
-- -----------------------------------------------------------------------------
create or replace function margin_alerts(p_min_pct numeric default null, p_limit integer default 300)
returns table (
  product_id      uuid,
  name            text,
  sku             text,
  category_id     uuid,
  price           numeric,
  cost            numeric,
  margin_pct      numeric,
  min_price       numeric,
  level           text,
  suggested_price numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_tenant uuid := _margin_assert();
  v_min    numeric;
begin
  select coalesce(p_min_pct, s.min_margin_pct, 20) into v_min
    from (select 1) one
    left join margin_alert_settings s on s.tenant_id = v_tenant;
  if v_min < 0 or v_min >= 100 then raise exception 'invalid_margin'; end if;

  return query
  with base as (
    select p.id, p.name, p.sku, p.category_id, p.price::numeric as price, p.cost::numeric as cost,
           p.min_price::numeric as min_price,
           round((p.price - p.cost) * 100 / p.price, 2) as m
      from products p
     where p.tenant_id = v_tenant and p.deleted_at is null and p.is_active
       and coalesce(p.price, 0) > 0 and coalesce(p.cost, 0) > 0
  )
  select b.id, b.name, b.sku, b.category_id, b.price, b.cost, b.m, b.min_price,
         case when b.price < b.cost then 'negative'
              when b.min_price is not null and b.price < b.min_price then 'below_min_price'
              else 'low' end,
         greatest(round(b.cost * 100 / (100 - v_min), 2), coalesce(b.min_price, 0))
    from base b
   where b.price < b.cost
      or (b.min_price is not null and b.price < b.min_price)
      or b.m < v_min
   order by b.m asc, b.name
   limit greatest(1, least(coalesce(p_limit, 300), 1000));
end;
$$;
revoke all on function margin_alerts(numeric, integer) from public, anon;
grant execute on function margin_alerts(numeric, integer) to authenticated;

create or replace function margin_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _margin_assert();
  v_min    numeric;
  v_out    jsonb;
begin
  select coalesce(s.min_margin_pct, 20) into v_min
    from (select 1) one
    left join margin_alert_settings s on s.tenant_id = v_tenant;

  select jsonb_build_object(
           'min_margin_pct', v_min,
           'active', count(*),
           'without_cost', count(*) filter (where coalesce(p.cost, 0) <= 0 and coalesce(p.price, 0) > 0),
           'negative', count(*) filter (where coalesce(p.cost, 0) > 0 and p.price > 0 and p.price < p.cost),
           'low', count(*) filter (where coalesce(p.cost, 0) > 0 and p.price > 0 and p.price >= p.cost
                                     and (p.price - p.cost) * 100 / p.price < v_min),
           'below_min_price', count(*) filter (where p.min_price is not null and p.price > 0 and p.price < p.min_price))
    into v_out
    from products p
   where p.tenant_id = v_tenant and p.deleted_at is null and p.is_active;
  return v_out;
end;
$$;
revoke all on function margin_summary() from public, anon;
grant execute on function margin_summary() to authenticated;

-- -----------------------------------------------------------------------------
-- C) Aviso cuando un producto cruza el mínimo.
-- -----------------------------------------------------------------------------
create or replace function trg_products_margin_watch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_s     margin_alert_settings;
  v_min   numeric;
  v_new_m numeric;
  v_role  text;
begin
  if new.deleted_at is not null or not coalesce(new.is_active, true) then return null; end if;
  if coalesce(new.price, 0) <= 0 or coalesce(new.cost, 0) <= 0 then return null; end if;

  select * into v_s from margin_alert_settings where tenant_id = new.tenant_id;
  if v_s.tenant_id is not null and not v_s.notify then return null; end if;
  v_min := coalesce(v_s.min_margin_pct, 20);

  v_new_m := (new.price - new.cost) * 100 / new.price;
  if v_new_m >= v_min then return null; end if;
  -- Ya estaba abajo: no es un cruce.
  if coalesce(old.price, 0) > 0 and coalesce(old.cost, 0) > 0
     and (old.price - old.cost) * 100 / old.price < v_min then
    return null;
  end if;
  if not tenant_has_feature_for(new.tenant_id, 'alertas_margen') then return null; end if;
  -- Un aviso cada 30 minutos por negocio.
  if v_s.last_notified_at is not null and v_s.last_notified_at > now() - interval '30 minutes' then
    return null;
  end if;

  insert into margin_alert_settings as s (tenant_id, last_notified_at)
  values (new.tenant_id, now())
  on conflict (tenant_id) do update set last_notified_at = excluded.last_notified_at;

  foreach v_role in array array['owner', 'manager'] loop
    insert into notifications (target_tenant_id, target_role, type, severity, title, body,
                               action_label, action_url, expires_at)
    values (new.tenant_id, v_role, 'comercial', 'warning', 'Margen bajo',
            left(new.name, 120) || ' quedó con ' || round(v_new_m, 1)::text
              || ' % de margen (mínimo ' || round(v_min, 1)::text || ' %). Revisá el precio.',
            'Ver márgenes', '/comercial?tab=margenes', now() + interval '14 days');
  end loop;
  return null;
exception when others then
  -- Un aviso nunca rompe una recepción ni un cambio de precio.
  raise warning 'trg_products_margin_watch: %', sqlerrm;
  return null;
end;
$$;
revoke all on function trg_products_margin_watch() from public, anon, authenticated;

drop trigger if exists products_margin_watch on products;
create trigger products_margin_watch
  after update of cost, price on products
  for each row
  when (old.cost is distinct from new.cost or old.price is distinct from new.price)
  execute function trg_products_margin_watch();
