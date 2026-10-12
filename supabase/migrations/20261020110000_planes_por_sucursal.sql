-- =============================================================================
-- 20261020110000_planes_por_sucursal  (F17 · H93 · ADR-057)
--
-- Planes de cuotas y recargos por sucursal, con herencia.
--
--   * payment_plans.store_id (null = plan del negocio). Un plan de sucursal
--     pisa al del negocio con la misma combinación (medio + code, y el code es
--     base + marca + cuotas). Una fila de sucursal inactiva (is_active=false)
--     oculta en esa sucursal el plan del negocio. Lo que la sucursal no pisa
--     lo hereda: un cambio del negocio llega a todas las que no lo pisaron.
--   * Unicidad (tenant_id, provider_key, code, store_id) NULLS NOT DISTINCT:
--     el upsert de PostgREST pasa a onConflict
--     "tenant_id,provider_key,code,store_id" (mismo índice para las dos clases
--     de fila).
--   * Escritura: las policies de siempre (dueño o encargado) más una
--     RESTRICTIVE para las filas de sucursal: acceso a esa sucursal y plan con
--     multi_sucursal (bajar de plan no borra nada: dejan de editarse y el POS
--     deja de aplicarlas, ver effective_payment_plans).
--   * effective_payment_plans(p_store_id): planes efectivos de una sucursal,
--     mismo criterio que lib/payments/planScope.ts. La conciliación no cambia
--     (usa el n° de comercio efectivo, no los planes).
-- =============================================================================

alter table payment_plans add column if not exists store_id uuid references stores(id) on delete cascade;

drop index if exists payment_plans_tenant_provider_code_uk;
create unique index if not exists payment_plans_scope_code_uk
  on payment_plans (tenant_id, provider_key, code, store_id) nulls not distinct;
create index if not exists payment_plans_store_idx
  on payment_plans (store_id) where store_id is not null;

-- La sucursal tiene que ser del mismo negocio.
create or replace function payment_plans_store_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.store_id is not null and not exists (
    select 1 from stores s where s.id = new.store_id and s.tenant_id = new.tenant_id
  ) then
    raise exception 'store_not_in_tenant' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists payment_plans_store_guard on payment_plans;
create trigger payment_plans_store_guard
  before insert or update of store_id, tenant_id on payment_plans
  for each row execute function payment_plans_store_guard();

-- Filas de sucursal: acceso a la sucursal + multi_sucursal (server-side).
drop policy if exists payment_plans_branch_insert on payment_plans;
create policy payment_plans_branch_insert on payment_plans
  as restrictive for insert
  with check (
    store_id is null
    or ((select tenant_has_feature_for(current_tenant_id(), 'multi_sucursal'))
        and user_can_access_store(store_id))
  );
drop policy if exists payment_plans_branch_update on payment_plans;
create policy payment_plans_branch_update on payment_plans
  as restrictive for update
  using (
    store_id is null
    or ((select tenant_has_feature_for(current_tenant_id(), 'multi_sucursal'))
        and user_can_access_store(store_id))
  )
  with check (
    store_id is null
    or ((select tenant_has_feature_for(current_tenant_id(), 'multi_sucursal'))
        and user_can_access_store(store_id))
  );
drop policy if exists payment_plans_branch_delete on payment_plans;
create policy payment_plans_branch_delete on payment_plans
  as restrictive for delete
  using (
    store_id is null
    or user_can_access_store(store_id)
  );

drop trigger if exists audit_payment_plans on payment_plans;
create trigger audit_payment_plans
  after insert or update or delete on payment_plans
  for each row execute function write_audit_log();

-- Planes efectivos de una sucursal (null = sólo los del negocio). Sin
-- multi_sucursal en el plan, las filas de sucursal no se aplican.
create or replace function effective_payment_plans(p_store_id uuid default null)
returns setof payment_plans
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with base as (
    select p as plan,
           p.is_active,
           row_number() over (
             partition by p.provider_key, coalesce(p.code, p.id::text)
             order by (p.store_id is not null) desc
           ) as rn
      from payment_plans p
     where p.tenant_id = current_tenant_id()
       and (p.store_id is null
            or (p_store_id is not null
                and p.store_id = p_store_id
                and tenant_has_feature_for(p.tenant_id, 'multi_sucursal')))
  )
  select (b.plan).*
    from base b
   where b.rn = 1 and b.is_active
   order by (b.plan).sort, (b.plan).label;
$$;
revoke all on function effective_payment_plans(uuid) from public, anon;
grant execute on function effective_payment_plans(uuid) to authenticated;

comment on column payment_plans.store_id is
  'F17 · ADR-057: null = plan del negocio; con valor, plan de esa sucursal que pisa al del negocio con el mismo medio y code.';
