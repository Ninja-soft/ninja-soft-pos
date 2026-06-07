-- =============================================================================
-- 20260607150000_custom_plans_overrides_discounts  (H12 — F7)
--
-- A) Planes custom por cliente: plans deja de estar limitado a 4 keys fijas;
--    un plan puede pertenecer a un tenant (tenant_id) clonado de un plan base.
--    RPCs internal_clone_plan / internal_update_custom_plan (auditadas).
-- B) Overrides de cuota/límites por cliente: subscriptions.limit_overrides
--    (jsonb) + RPC internal_set_limit_override (key/valor, null = quitar).
-- C) Descuentos comerciales: tenant_discounts (percent/fixed, vigencia,
--    motivo, baja lógica). RLS solo staff interno.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Planes custom.
-- -----------------------------------------------------------------------------
alter table plans drop constraint if exists plans_key_check;
alter table plans add column if not exists tenant_id uuid references tenants(id) on delete cascade;
alter table plans add column if not exists base_plan_key text;
create index if not exists idx_plans_tenant on plans(tenant_id) where tenant_id is not null;

-- Clona un plan base como plan custom del tenant y lo asigna a su suscripción.
create or replace function internal_clone_plan(
  p_tenant_id uuid,
  p_base_plan_key text,
  p_name text,
  p_monthly_price numeric
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_base plans%rowtype;
  v_new_id uuid;
  v_key text;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_monthly_price is null or p_monthly_price < 0 then
    raise exception 'invalid_price';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'invalid_name';
  end if;

  select * into v_base from plans
   where key = p_base_plan_key and tenant_id is null and is_active;
  if not found then
    raise exception 'base_plan_not_found';
  end if;

  v_key := 'custom_' || replace(left(p_tenant_id::text, 8), '-', '') || '_'
           || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');

  insert into plans (key, name, description, monthly_price_ars, yearly_price_ars,
                     limits, is_active, tenant_id, base_plan_key)
  values (v_key, btrim(p_name), 'Plan custom (base ' || v_base.name || ')',
          p_monthly_price, v_base.yearly_price_ars,
          v_base.limits, true, p_tenant_id, p_base_plan_key)
  returning id into v_new_id;

  update subscriptions set plan_id = v_new_id, updated_at = now()
   where tenant_id = p_tenant_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'plans', v_new_id, 'custom_plan_created',
          jsonb_build_object('name', btrim(p_name), 'base', p_base_plan_key,
                             'monthly_price_ars', p_monthly_price));
  return v_new_id;
end;
$$;
revoke all on function internal_clone_plan(uuid, text, text, numeric) from public, anon;
grant execute on function internal_clone_plan(uuid, text, text, numeric) to authenticated;

-- Edita un plan custom (nunca los globales). Auditado con before/after.
create or replace function internal_update_custom_plan(
  p_plan_id uuid,
  p_name text,
  p_monthly_price numeric,
  p_limits jsonb,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old plans%rowtype;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;

  select * into v_old from plans where id = p_plan_id;
  if not found then
    raise exception 'plan_not_found';
  end if;
  if v_old.tenant_id is null then
    raise exception 'not_custom_plan';
  end if;
  if p_monthly_price is null or p_monthly_price < 0 then
    raise exception 'invalid_price';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'invalid_name';
  end if;

  update plans
     set name = btrim(p_name),
         monthly_price_ars = p_monthly_price,
         limits = coalesce(p_limits, limits)
   where id = p_plan_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_old.tenant_id, auth.uid(), 'plans', p_plan_id, 'custom_plan_updated',
          jsonb_build_object('name', v_old.name, 'monthly_price_ars', v_old.monthly_price_ars,
                             'limits', v_old.limits),
          jsonb_build_object('name', btrim(p_name), 'monthly_price_ars', p_monthly_price,
                             'limits', coalesce(p_limits, v_old.limits),
                             'reason', p_reason));
end;
$$;
revoke all on function internal_update_custom_plan(uuid, text, numeric, jsonb, text) from public, anon;
grant execute on function internal_update_custom_plan(uuid, text, numeric, jsonb, text) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Overrides de límites por tenant.
-- -----------------------------------------------------------------------------
alter table subscriptions add column if not exists limit_overrides jsonb not null default '{}'::jsonb;

-- Setea/elimina un override puntual (valor null = quitar). Auditado.
create or replace function internal_set_limit_override(
  p_tenant_id uuid,
  p_key text,
  p_value numeric,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_key is null or p_key !~ '^[a-z0-9_]{1,40}$' then
    raise exception 'invalid_key';
  end if;

  select limit_overrides into v_old from subscriptions where tenant_id = p_tenant_id;
  if not found then
    raise exception 'subscription_not_found';
  end if;

  if p_value is null then
    v_new := v_old - p_key;
  else
    v_new := v_old || jsonb_build_object(p_key, p_value);
  end if;

  update subscriptions set limit_overrides = v_new, updated_at = now()
   where tenant_id = p_tenant_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (p_tenant_id, auth.uid(), 'subscriptions', p_tenant_id, 'limit_override_set',
          jsonb_build_object('overrides', v_old),
          jsonb_build_object('overrides', v_new, 'key', p_key, 'value', p_value,
                             'reason', p_reason));
  return v_new;
end;
$$;
revoke all on function internal_set_limit_override(uuid, text, numeric, text) from public, anon;
grant execute on function internal_set_limit_override(uuid, text, numeric, text) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Descuentos comerciales por tenant.
-- -----------------------------------------------------------------------------
create table if not exists tenant_discounts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  kind        text not null check (kind in ('percent','fixed')),
  value       numeric(12,2) not null check (value > 0),
  reason      text,
  valid_from  date not null default current_date,
  valid_until date,
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists idx_tenant_discounts_tenant on tenant_discounts(tenant_id);

alter table tenant_discounts enable row level security;

-- Solo staff interno ve y administra descuentos (mismo criterio que billing_records).
create policy tenant_discounts_select on tenant_discounts
  for select using ((select is_internal()));
create policy tenant_discounts_insert on tenant_discounts
  for insert with check ((select is_internal()));
create policy tenant_discounts_update on tenant_discounts
  for update using ((select is_internal())) with check ((select is_internal()));
