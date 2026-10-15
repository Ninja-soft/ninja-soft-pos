-- =============================================================================
-- 20261203100100_ajustes_stock_aprobacion  (ADR-137 · F14 · H64, H34)
--
-- Inventario PRO que se entiende: ajustes de stock con motivo, foto y
-- aprobación opcional (dueño o auditor) desde un umbral; planilla de stock,
-- movimientos y valuación por sucursal; importación de ajustes y conteos con
-- el motor único de ADR-078.
--
--   A) Capacidades por miembro (catálogo en lib/permissions/capabilities.ts):
--      member_capabilities (permisos que se SUMAN al rol), capability_catalog,
--      capability_role_default (lo que trae cada rol), member_has_capability
--      (rol + otorgadas), my_capabilities, member_capability_set (sólo el
--      dueño, auditado) y stock_capability_members. Es el punto de enganche
--      del editor de roles y permisos: el editor escribe otorgamientos y el
--      servidor sigue preguntando a member_has_capability.
--      El "auditor" es un miembro con stock.adjust.approve. Tiene que ser
--      dueño, encargado o cajero: "solo lectura" no escribe nunca (ADR-071,
--      role_write_guard), así que no puede aplicar un ajuste aprobado.
--   B) stock_adjustment_policy: aprobación prendida o no, quién aprueba
--      (sólo el dueño, o el dueño y los auditores), umbral en unidades y en
--      pesos al costo, y foto obligatoria para lo que va a aprobación.
--   C) stock_adjustments: cada ajuste con sucursal, depósito, modo (sumar,
--      restar, fijar), cantidad, motivo del catálogo, nota, foto, lo que
--      decía el sistema, la diferencia, el valor al costo, el estado
--      (pendiente, aplicado, rechazado, cancelado), quién lo pidió y quién lo
--      aprobó. Lectura del negocio con alcance de sucursal; sin escritura por
--      REST; role_write_guard.
--   D) Fotos de respaldo: bucket privado stock-adjustment-photos por carpeta
--      del negocio.
--   E) RPC: stock_adjustment_request, stock_adjustment_decide (y _many),
--      stock_adjustment_cancel, stock_adjustments_list,
--      stock_adjustment_policy_get / _save. El ajuste aplicado mueve el stock
--      igual que adjust_store_stock (consolidado, product_stock por el
--      trigger, movimiento con referencia al ajuste y motivo de merma) y, en
--      un depósito interno, también warehouse_stock (ADR-085).
--   F) Lecturas para la pantalla y el Excel: inventory_stock_sheet,
--      inventory_movements, inventory_valuation. El costo sólo vuelve con
--      stock.valuation.
--   G) Importación: import_stock_adjustments en el motor único
--      (_import_exec recreada con la entidad nueva en la lista).
--
-- Gating: ajustes_stock (BASE) en el pedido, aprobacion_ajustes (OPTIONAL
-- Pro+) para que un ajuste quede pendiente y para que un auditor apruebe,
-- importacion_excel en la importación. Toda acción crítica escribe en
-- audit_logs. Sin "or is_internal()": el staff interno lee por
-- (select internal_scope()).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Capacidades por miembro.
-- -----------------------------------------------------------------------------
create table if not exists member_capabilities (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  -- Formato recurso.accion[.sub]: el catálogo vigente lo valida la RPC
  -- (capability_catalog) para que el editor de permisos sume claves sin
  -- tocar este check.
  capability  text not null check (capability ~ '^[a-z_]+(\.[a-z_]+){1,3}$'),
  granted_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (tenant_id, user_id, capability)
);
create index if not exists member_capabilities_user_idx on member_capabilities (user_id);
create index if not exists member_capabilities_granted_by_idx
  on member_capabilities (granted_by) where granted_by is not null;
create index if not exists member_capabilities_tenant_cap_idx on member_capabilities (tenant_id, capability);

alter table member_capabilities enable row level security;
drop policy if exists member_capabilities_select on member_capabilities;
create policy member_capabilities_select on member_capabilities
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
revoke insert, update, delete on member_capabilities from anon, authenticated;

-- Catálogo vigente (espejo de CAPABILITY_KEYS en lib/permissions/capabilities.ts).
create or replace function capability_catalog()
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select array['stock.view', 'stock.valuation', 'stock.export', 'stock.adjust',
               'stock.count', 'stock.import', 'stock.adjust.approve', 'stock.settings']::text[];
$$;
grant execute on function capability_catalog() to authenticated;

-- Lo que trae cada rol sin otorgar nada (espejo de ROLE_CAPABILITIES).
create or replace function capability_role_default(p_role text, p_cap text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_role = 'owner' then p_cap = any (capability_catalog())
    when p_role = 'manager' then p_cap in ('stock.view', 'stock.valuation', 'stock.export', 'stock.adjust',
                                           'stock.count', 'stock.import')
    when p_role = 'cashier' then p_cap in ('stock.view')
    when p_role = 'viewer' then p_cap in ('stock.view', 'stock.valuation', 'stock.export')
    else false
  end;
$$;
grant execute on function capability_role_default(text, text) to authenticated;

-- Rol del usuario en el negocio + capacidades otorgadas (membresía activa).
create or replace function member_has_capability(p_tenant uuid, p_cap text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select capability_role_default(tu.role, p_cap)
           or exists (select 1 from member_capabilities mc
                       where mc.tenant_id = p_tenant and mc.user_id = tu.user_id
                         and mc.capability = p_cap)
      from tenant_users tu
     where tu.tenant_id = p_tenant and tu.user_id = auth.uid() and tu.status = 'active'
     limit 1), false);
$$;
revoke all on function member_has_capability(uuid, text) from public, anon;
grant execute on function member_has_capability(uuid, text) to authenticated;

-- Capacidades efectivas del usuario en el negocio activo (para la UI).
create or replace function my_capabilities()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(c order by c), '{}'::text[])
    from unnest(capability_catalog()) c
   where member_has_capability(current_tenant_id(), c);
$$;
revoke all on function my_capabilities() from public, anon;
grant execute on function my_capabilities() to authenticated;

-- Otorgar o quitar una capacidad a un miembro. Sólo el dueño; auditado.
create or replace function member_capability_set(
  p_user uuid, p_capability text, p_granted boolean, p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text;
  v_had    boolean;
begin
  if v_tenant is null or coalesce(member_role_in(v_tenant), '') <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_capability is null or not (p_capability = any (capability_catalog())) then
    raise exception 'capability_unknown';
  end if;
  select tu.role into v_role from tenant_users tu
   where tu.tenant_id = v_tenant and tu.user_id = p_user and tu.status = 'active';
  if v_role is null then
    raise exception 'member_not_found';
  end if;
  if v_role = 'owner' then
    raise exception 'capability_owner_has_all';
  end if;
  -- Solo lectura no escribe nunca (ADR-071): no puede ajustar, contar,
  -- importar, aprobar ni configurar.
  if v_role = 'viewer' and coalesce(p_granted, false)
     and p_capability not in ('stock.view', 'stock.valuation', 'stock.export') then
    raise exception 'capability_needs_write_role';
  end if;

  select exists (select 1 from member_capabilities
                  where tenant_id = v_tenant and user_id = p_user and capability = p_capability)
    into v_had;

  if coalesce(p_granted, false) then
    insert into member_capabilities (tenant_id, user_id, capability, granted_by)
    values (v_tenant, p_user, p_capability, auth.uid())
    on conflict (tenant_id, user_id, capability) do nothing;
  else
    delete from member_capabilities
     where tenant_id = v_tenant and user_id = p_user and capability = p_capability;
  end if;

  if v_had is distinct from coalesce(p_granted, false) then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
    values (v_tenant, auth.uid(), 'member_capabilities', p_user,
            case when coalesce(p_granted, false) then 'capability_granted' else 'capability_revoked' end,
            jsonb_build_object('capability', p_capability, 'granted', v_had),
            jsonb_build_object('capability', p_capability, 'granted', coalesce(p_granted, false), 'role', v_role),
            nullif(btrim(coalesce(p_reason, '')), ''));
  end if;
end;
$$;
revoke all on function member_capability_set(uuid, text, boolean, text) from public, anon;
grant execute on function member_capability_set(uuid, text, boolean, text) to authenticated;

-- Miembros activos con sus capacidades otorgadas (pantalla de auditores).
create or replace function stock_capability_members()
returns table (
  user_id      uuid,
  name         text,
  email        text,
  role         text,
  capabilities text[]
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or not member_has_capability(v_tenant, 'stock.settings') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select tu.user_id,
         coalesce(nullif(btrim(tu.display_name), ''), nullif(btrim(u.full_name), ''), u.email)::text,
         u.email::text,
         tu.role::text,
         coalesce((select array_agg(mc.capability order by mc.capability) from member_capabilities mc
                    where mc.tenant_id = v_tenant and mc.user_id = tu.user_id), '{}'::text[])
    from tenant_users tu
    left join users u on u.id = tu.user_id
   where tu.tenant_id = v_tenant and tu.status = 'active'
   order by case tu.role when 'owner' then 0 when 'manager' then 1 when 'cashier' then 2 else 3 end,
            2;
end;
$$;
revoke all on function stock_capability_members() from public, anon;
grant execute on function stock_capability_members() to authenticated;

-- -----------------------------------------------------------------------------
-- B) Política de aprobación.
-- -----------------------------------------------------------------------------
create table if not exists stock_adjustment_policy (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  approval_enabled boolean not null default false,
  approver         text not null default 'owner' check (approver in ('owner', 'auditor')),
  threshold_units  numeric(12,3) check (threshold_units is null or threshold_units > 0),
  threshold_value  numeric(14,2) check (threshold_value is null or threshold_value > 0),
  require_photo    boolean not null default false,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references users(id) on delete set null
);
create index if not exists stock_adjustment_policy_updated_by_idx
  on stock_adjustment_policy (updated_by) where updated_by is not null;

alter table stock_adjustment_policy enable row level security;
drop policy if exists stock_adjustment_policy_select on stock_adjustment_policy;
create policy stock_adjustment_policy_select on stock_adjustment_policy
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
revoke insert, update, delete on stock_adjustment_policy from anon, authenticated;

-- Regla del umbral (espejo de needsApproval en lib/stock/adjustments.ts):
-- con la aprobación prendida, el dueño nunca espera; el resto espera si no
-- hay umbrales (todo se aprueba) o si llega a alguno (unidades o pesos).
create or replace function stock_adjustment_needs_approval(
  p_enabled boolean, p_role text, p_units numeric, p_value numeric,
  p_threshold_units numeric, p_threshold_value numeric
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_enabled, false)
     and coalesce(p_role, '') <> 'owner'
     and (
       (p_threshold_units is null and p_threshold_value is null)
       or (p_threshold_units is not null and abs(coalesce(p_units, 0)) >= p_threshold_units)
       or (p_threshold_value is not null and abs(coalesce(p_value, 0)) >= p_threshold_value)
     );
$$;
grant execute on function stock_adjustment_needs_approval(boolean, text, numeric, numeric, numeric, numeric)
  to authenticated;

create or replace function stock_adjustment_policy_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v        stock_adjustment_policy;
begin
  if v_tenant is null or member_role_in(v_tenant) is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v from stock_adjustment_policy where tenant_id = v_tenant;
  return jsonb_build_object(
    'approval_enabled', coalesce(v.approval_enabled, false),
    'approver', coalesce(v.approver, 'owner'),
    'threshold_units', v.threshold_units,
    'threshold_value', v.threshold_value,
    'require_photo', coalesce(v.require_photo, false),
    'feature', tenant_has_feature_for(v_tenant, 'aprobacion_ajustes'));
end;
$$;
revoke all on function stock_adjustment_policy_get() from public, anon;
grant execute on function stock_adjustment_policy_get() to authenticated;

create or replace function stock_adjustment_policy_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_before  jsonb;
  v_after   jsonb;
  v_enabled boolean;
  v_appr    text;
  v_units   numeric;
  v_value   numeric;
begin
  if v_tenant is null or not member_has_capability(v_tenant, 'stock.settings') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p, 'null'::jsonb)) <> 'object' then
    raise exception 'invalid_payload';
  end if;
  v_enabled := coalesce((p ->> 'approval_enabled')::boolean, false);
  v_appr := coalesce(nullif(p ->> 'approver', ''), 'owner');
  v_units := nullif(p ->> 'threshold_units', '')::numeric;
  v_value := nullif(p ->> 'threshold_value', '')::numeric;
  if v_appr not in ('owner', 'auditor') then raise exception 'invalid_approver'; end if;
  if (v_units is not null and v_units <= 0) or (v_value is not null and v_value <= 0) then
    raise exception 'invalid_threshold';
  end if;
  if v_enabled and not tenant_has_feature_for(v_tenant, 'aprobacion_ajustes') then
    raise exception 'feature_not_in_plan: aprobacion_ajustes';
  end if;

  v_before := stock_adjustment_policy_get();
  insert into stock_adjustment_policy as s (tenant_id, approval_enabled, approver, threshold_units,
                                            threshold_value, require_photo, updated_at, updated_by)
  values (v_tenant, v_enabled, v_appr, v_units, v_value,
          coalesce((p ->> 'require_photo')::boolean, false), now(), auth.uid())
  on conflict (tenant_id) do update
    set approval_enabled = excluded.approval_enabled, approver = excluded.approver,
        threshold_units = excluded.threshold_units, threshold_value = excluded.threshold_value,
        require_photo = excluded.require_photo, updated_at = now(), updated_by = auth.uid();
  v_after := stock_adjustment_policy_get();

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'stock_adjustment_policy', v_tenant, 'stock_adjustment_policy_updated',
          v_before, v_after);
  return v_after;
end;
$$;
revoke all on function stock_adjustment_policy_save(jsonb) from public, anon;
grant execute on function stock_adjustment_policy_save(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Ajustes.
-- -----------------------------------------------------------------------------
create table if not exists stock_adjustments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  store_id       uuid not null references stores(id),
  warehouse_id   uuid references warehouses(id),
  product_id     uuid not null references products(id) on delete cascade,
  variant_id     uuid references product_variants(id) on delete cascade,
  mode           text not null check (mode in ('add', 'remove', 'set')),
  qty            numeric(12,3) not null check (qty >= 0),
  reason         text not null check (reason in ('rotura', 'vencimiento', 'robo', 'error_carga', 'conteo',
                                                 'consumo_interno', 'regalo', 'ingreso', 'otro')),
  notes          text check (notes is null or char_length(notes) <= 300),
  photo_path     text check (photo_path is null or char_length(photo_path) <= 300),
  system_qty     numeric(12,3) not null,
  delta          numeric(12,3) not null,
  unit_cost      numeric(14,4),
  value          numeric(14,2) not null default 0,
  status         text not null default 'pending'
                   check (status in ('pending', 'applied', 'rejected', 'cancelled')),
  needs_approval boolean not null default false,
  source         text not null default 'manual' check (source in ('manual', 'import')),
  requested_by   uuid references users(id) on delete set null,
  requested_at   timestamptz not null default now(),
  decided_by     uuid references users(id) on delete set null,
  decided_at     timestamptz,
  decision_notes text check (decision_notes is null or char_length(decision_notes) <= 300),
  applied_delta  numeric(12,3),
  applied_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists stock_adjustments_tenant_created_idx
  on stock_adjustments (tenant_id, created_at desc);
create index if not exists stock_adjustments_tenant_store_idx
  on stock_adjustments (tenant_id, store_id, created_at desc);
create index if not exists stock_adjustments_pending_idx
  on stock_adjustments (tenant_id, created_at desc) where status = 'pending';
create index if not exists stock_adjustments_store_idx on stock_adjustments (store_id);
create index if not exists stock_adjustments_warehouse_idx
  on stock_adjustments (warehouse_id) where warehouse_id is not null;
create index if not exists stock_adjustments_product_idx on stock_adjustments (product_id);
create index if not exists stock_adjustments_variant_idx
  on stock_adjustments (variant_id) where variant_id is not null;
create index if not exists stock_adjustments_requested_by_idx
  on stock_adjustments (requested_by) where requested_by is not null;
create index if not exists stock_adjustments_decided_by_idx
  on stock_adjustments (decided_by) where decided_by is not null;

alter table stock_adjustments enable row level security;
drop policy if exists stock_adjustments_select on stock_adjustments;
create policy stock_adjustments_select on stock_adjustments
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists stock_adjustments_branch_scope on stock_adjustments;
create policy stock_adjustments_branch_scope on stock_adjustments
  as restrictive for select
  using ((select internal_scope()) or store_id = any ((select user_allowed_store_ids())::uuid[]));
revoke insert, update, delete on stock_adjustments from anon, authenticated;

-- Permisos por rol (ADR-071): solo lectura nunca escribe; la política y las
-- capacidades, además, nunca desde el navegador de un cajero.
do $$
declare
  t text;
begin
  foreach t in array array['stock_adjustments'] loop
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'operate');
  end loop;
  foreach t in array array['stock_adjustment_policy', 'member_capabilities'] loop
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'manage');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- D) Fotos de respaldo (bucket privado, carpeta = negocio).
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stock-adjustment-photos', 'stock-adjustment-photos', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "stock_adjustment_photos_read" on storage.objects;
drop policy if exists "stock_adjustment_photos_write" on storage.objects;
create policy "stock_adjustment_photos_read" on storage.objects for select to authenticated
  using (bucket_id = 'stock-adjustment-photos'
         and (storage.foldername(name))[1] = (select current_tenant_id())::text
         and (select stock_my_role()) is not null);
create policy "stock_adjustment_photos_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'stock-adjustment-photos'
              and (storage.foldername(name))[1] = (select current_tenant_id())::text
              and (select stock_my_role()) in ('owner', 'manager', 'cashier'));

-- -----------------------------------------------------------------------------
-- E) Núcleo del ajuste.
-- -----------------------------------------------------------------------------

-- Lo que hay hoy en el alcance del ajuste: la sucursal entera (sin
-- depósito), el salón (depósito principal, lo que queda de la sucursal) o un
-- depósito interno.
create or replace function _stock_scope_qty(p_store uuid, p_warehouse uuid, p_product uuid, p_variant uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_qty  numeric;
begin
  if p_warehouse is null then
    select ps.qty into v_qty from product_stock ps
     where ps.store_id = p_store and ps.product_id = p_product
       and ps.variant_id is not distinct from p_variant;
    return coalesce(v_qty, 0);
  end if;
  select w.kind into v_kind from warehouses w where w.id = p_warehouse;
  if v_kind = 'principal' then
    return warehouse_principal_qty(p_store, p_product, p_variant);
  end if;
  select ws.qty into v_qty from warehouse_stock ws
   where ws.warehouse_id = p_warehouse and ws.product_id = p_product
     and ws.variant_id is not distinct from p_variant;
  return coalesce(v_qty, 0);
end;
$$;
revoke all on function _stock_scope_qty(uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- Aplica una diferencia: mismo camino que adjust_store_stock (consolidado,
-- movimiento por sucursal que mueve product_stock por trigger) más el
-- depósito interno si corresponde. Sin chequeo de rol: lo hacen quienes la
-- llaman (pedido con stock.adjust, aprobación con stock.adjust.approve).
create or replace function _stock_adjust_apply(
  p_tenant uuid, p_store uuid, p_warehouse uuid, p_product uuid, p_variant uuid,
  p_delta numeric, p_reason text, p_notes text, p_ref uuid
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cur    numeric;
  v_mreason text;
  v_loss   text;
begin
  if coalesce(p_delta, 0) = 0 then
    return _stock_scope_qty(p_store, null, p_product, p_variant);
  end if;
  if p_store is distinct from stock_default_store(p_tenant) then
    if not tenant_has_feature_for(p_tenant, 'multi_sucursal') then
      raise exception 'feature_not_in_plan: multi_sucursal';
    end if;
    if not tenant_has_feature_for(p_tenant, 'stock_sucursales') then
      raise exception 'feature_not_in_plan: stock_sucursales';
    end if;
  end if;

  select qty into v_cur from product_stock
   where store_id = p_store and product_id = p_product and variant_id is not distinct from p_variant
   for update;
  v_cur := coalesce(v_cur, 0);

  v_mreason := case
    when p_reason = 'conteo' then 'count'
    when p_reason in ('rotura', 'vencimiento', 'robo', 'consumo_interno', 'regalo') and p_delta < 0 then 'loss'
    else 'adjustment'
  end;
  v_loss := case
    when v_mreason <> 'loss' then null
    when p_reason = 'rotura' then 'roto'
    when p_reason = 'vencimiento' then 'vencido'
    else 'otro'
  end;

  if p_variant is null then
    update products
       set stock = stock + p_delta, updated_by = auth.uid(), updated_at = now()
     where id = p_product and tenant_id = p_tenant;
  else
    update product_variants
       set stock = stock + p_delta, updated_at = now()
     where id = p_variant and tenant_id = p_tenant;
  end if;

  insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, loss_reason,
                               notes, reference_id, created_by)
  values (p_tenant, p_product, p_variant, p_store, p_delta, v_mreason, v_loss,
          nullif(btrim(coalesce(p_notes, '')), ''), p_ref, auth.uid());

  if p_warehouse is not null then
    perform warehouse_apply(p_tenant, p_warehouse, p_product, p_variant, p_delta);
  end if;

  return v_cur + p_delta;
end;
$$;
revoke all on function _stock_adjust_apply(uuid, uuid, uuid, uuid, uuid, numeric, text, text, uuid)
  from public, anon, authenticated;

-- Quién puede aprobar según la política: el dueño siempre; con "auditor",
-- también quien tenga stock.adjust.approve (y la feature en el plan).
create or replace function _stock_can_approve(p_tenant uuid, p_approver text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(member_role_in(p_tenant), '') = 'owner'
      or (coalesce(p_approver, 'owner') = 'auditor'
          and tenant_has_feature_for(p_tenant, 'aprobacion_ajustes')
          and member_has_capability(p_tenant, 'stock.adjust.approve'));
$$;
revoke all on function _stock_can_approve(uuid, text) from public, anon, authenticated;

-- Aviso a quien aprueba (nunca rompe la escritura).
create or replace function _stock_adj_notify(p_tenant uuid, p_title text, p_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appr text;
  u      uuid;
begin
  select approver into v_appr from stock_adjustment_policy where tenant_id = p_tenant;
  insert into notifications (target_tenant_id, target_role, target_user_id, type, severity,
                             title, body, action_label, action_url, expires_at)
  values (p_tenant, 'owner', null, 'comercial', 'warning', left(p_title, 200), left(p_body, 600),
          'Revisar', '/inventario?tab=ajustes', now() + interval '30 days');
  if coalesce(v_appr, 'owner') = 'auditor' then
    for u in
      select mc.user_id from member_capabilities mc
        join tenant_users tu on tu.tenant_id = mc.tenant_id and tu.user_id = mc.user_id
       where mc.tenant_id = p_tenant and mc.capability = 'stock.adjust.approve'
         and tu.status = 'active' and tu.role <> 'owner'
    loop
      insert into notifications (target_tenant_id, target_role, target_user_id, type, severity,
                                 title, body, action_label, action_url, expires_at)
      values (p_tenant, null, u, 'comercial', 'warning', left(p_title, 200), left(p_body, 600),
              'Revisar', '/inventario?tab=ajustes', now() + interval '30 days');
    end loop;
  end if;
exception when others then
  raise warning '_stock_adj_notify: %', sqlerrm;
end;
$$;
revoke all on function _stock_adj_notify(uuid, text, text) from public, anon, authenticated;

-- Pedido de ajuste (manual o importado). Valida capacidad, feature, sucursal,
-- depósito y producto; calcula la diferencia y el valor; decide si queda
-- pendiente (umbral) o se aplica ya. Devuelve el resultado.
create or replace function _stock_adjustment_request(p_tenant uuid, p jsonb, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_role   text := member_role_in(p_tenant);
  v_store  uuid := nullif(p ->> 'store_id', '')::uuid;
  v_wh     uuid := nullif(p ->> 'warehouse_id', '')::uuid;
  v_prod   uuid := nullif(p ->> 'product_id', '')::uuid;
  v_var    uuid := nullif(p ->> 'variant_id', '')::uuid;
  v_mode   text := p ->> 'mode';
  v_qty    numeric := nullif(p ->> 'qty', '')::numeric;
  v_reason text := p ->> 'reason';
  v_notes  text := nullif(btrim(coalesce(p ->> 'notes', '')), '');
  v_photo  text := nullif(btrim(coalesce(p ->> 'photo_path', '')), '');
  v_p      record;
  v_whrow  warehouses;
  v_sys    numeric;
  v_delta  numeric;
  v_value  numeric;
  v_pol    stock_adjustment_policy;
  v_needs  boolean;
  v_id     uuid;
  v_new    numeric;
begin
  if v_uid is null or v_role is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_role = 'viewer' then
    raise exception 'forbidden_read_only' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(p_tenant, 'ajustes_stock') then
    raise exception 'feature_not_in_plan: ajustes_stock';
  end if;
  if v_reason = 'conteo' then
    if not (member_has_capability(p_tenant, 'stock.count') or member_has_capability(p_tenant, 'stock.adjust')) then
      raise exception 'forbidden_capability: stock.count' using errcode = '42501';
    end if;
  elsif not member_has_capability(p_tenant, 'stock.adjust') then
    raise exception 'forbidden_capability: stock.adjust' using errcode = '42501';
  end if;
  if v_mode is null or v_mode not in ('add', 'remove', 'set') then
    raise exception 'invalid_mode';
  end if;
  if v_qty is null or v_qty < 0 or v_qty >= 1000000000 or (v_mode <> 'set' and v_qty = 0) then
    raise exception 'invalid_qty';
  end if;
  if v_reason is null or v_reason not in ('rotura', 'vencimiento', 'robo', 'error_carga', 'conteo',
                                          'consumo_interno', 'regalo', 'ingreso', 'otro') then
    raise exception 'invalid_reason';
  end if;
  if v_reason = 'otro' and v_notes is null then
    raise exception 'reason_notes_required';
  end if;
  if v_notes is not null and char_length(v_notes) > 300 then
    raise exception 'notes_too_long';
  end if;
  if v_photo is not null and (char_length(v_photo) > 300 or v_photo not like p_tenant::text || '/%') then
    raise exception 'invalid_photo';
  end if;

  v_store := coalesce(v_store, stock_default_store(p_tenant));
  if v_store is null or not exists (
    select 1 from stores s where s.id = v_store and s.tenant_id = p_tenant and s.deleted_at is null
  ) then
    raise exception 'store_not_found';
  end if;
  if not user_can_access_store(v_store) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  if v_store is distinct from stock_default_store(p_tenant) then
    if not tenant_has_feature_for(p_tenant, 'multi_sucursal') then
      raise exception 'feature_not_in_plan: multi_sucursal';
    end if;
    if not tenant_has_feature_for(p_tenant, 'stock_sucursales') then
      raise exception 'feature_not_in_plan: stock_sucursales';
    end if;
  end if;

  if v_wh is not null then
    select * into v_whrow from warehouses w
     where w.id = v_wh and w.tenant_id = p_tenant and w.deleted_at is null;
    if v_whrow.id is null then
      raise exception 'warehouse_not_found';
    end if;
    if v_whrow.store_id <> v_store then
      raise exception 'warehouse_store_mismatch';
    end if;
    if not tenant_has_feature_for(p_tenant, 'depositos') then
      raise exception 'feature_not_in_plan: depositos';
    end if;
  end if;

  select pr.id, pr.has_variants, pr.cost into v_p
    from products pr
   where pr.id = v_prod and pr.tenant_id = p_tenant and pr.deleted_at is null;
  if v_p.id is null then
    raise exception 'product_not_found';
  end if;
  if coalesce(v_p.has_variants, false) then
    if v_var is null then
      raise exception 'variant_required';
    end if;
    if not exists (
      select 1 from product_variants pv
       where pv.id = v_var and pv.product_id = v_prod and pv.tenant_id = p_tenant and pv.deleted_at is null
    ) then
      raise exception 'variant_not_found';
    end if;
  elsif v_var is not null then
    raise exception 'variant_not_allowed';
  end if;

  v_sys := _stock_scope_qty(v_store, v_wh, v_prod, v_var);
  v_delta := case v_mode when 'add' then v_qty when 'remove' then -v_qty else v_qty - v_sys end;
  if v_delta = 0 then
    return jsonb_build_object('id', null, 'status', 'unchanged', 'needs_approval', false,
                              'system_qty', v_sys, 'delta', 0, 'value', 0);
  end if;
  v_value := round(v_delta * coalesce(v_p.cost, 0), 2);

  select * into v_pol from stock_adjustment_policy where tenant_id = p_tenant;
  v_needs := tenant_has_feature_for(p_tenant, 'aprobacion_ajustes')
             and stock_adjustment_needs_approval(v_pol.approval_enabled, v_role, abs(v_delta), abs(v_value),
                                                 v_pol.threshold_units, v_pol.threshold_value);
  if v_needs and coalesce(v_pol.require_photo, false) and v_photo is null then
    raise exception 'photo_required';
  end if;

  insert into stock_adjustments (tenant_id, store_id, warehouse_id, product_id, variant_id, mode, qty, reason,
                                 notes, photo_path, system_qty, delta, unit_cost, value, status,
                                 needs_approval, source, requested_by)
  values (p_tenant, v_store, v_wh, v_prod, v_var, v_mode, v_qty, v_reason, v_notes, v_photo, v_sys, v_delta,
          v_p.cost, v_value, case when v_needs then 'pending' else 'applied' end, v_needs,
          case when p_source = 'import' then 'import' else 'manual' end, v_uid)
  returning id into v_id;

  if not v_needs then
    v_new := _stock_adjust_apply(p_tenant, v_store, v_wh, v_prod, v_var, v_delta, v_reason, v_notes, v_id);
    update stock_adjustments
       set applied_delta = v_delta, applied_at = now(), updated_at = now()
     where id = v_id;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data,
                          reason, store_id)
  values (p_tenant, v_uid, 'stock_adjustments', v_id,
          case when v_needs then 'stock_adjustment_requested' else 'stock_adjustment_applied' end,
          jsonb_build_object('qty', v_sys),
          jsonb_build_object('product_id', v_prod, 'variant_id', v_var, 'warehouse_id', v_wh, 'mode', v_mode,
                             'qty', v_qty, 'delta', v_delta, 'value', v_value, 'reason', v_reason,
                             'source', p_source, 'photo', v_photo is not null),
          v_notes, v_store);

  if v_needs and p_source <> 'import' then
    perform _stock_adj_notify(p_tenant, 'Ajuste de stock para aprobar',
      'Hay un ajuste de ' || abs(v_delta)::text || ' unidades esperando tu aprobación en Inventario.');
  end if;

  return jsonb_build_object('id', v_id, 'status', case when v_needs then 'pending' else 'applied' end,
                            'needs_approval', v_needs, 'system_qty', v_sys, 'delta', v_delta,
                            'value', v_value, 'new_qty', v_new);
end;
$$;
revoke all on function _stock_adjustment_request(uuid, jsonb, text) from public, anon, authenticated;

create or replace function stock_adjustment_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p, 'null'::jsonb)) <> 'object' then
    raise exception 'invalid_payload';
  end if;
  return _stock_adjustment_request(v_tenant, p, 'manual');
end;
$$;
revoke all on function stock_adjustment_request(jsonb) from public, anon;
grant execute on function stock_adjustment_request(jsonb) to authenticated;

-- Aprobar o rechazar un ajuste pendiente. Un "fijar" se recalcula con el
-- stock de ese momento (lo contado manda); sumar y restar aplican la misma
-- diferencia que se pidió.
create or replace function stock_adjustment_decide(p_id uuid, p_approve boolean, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_notes  text := nullif(btrim(coalesce(p_notes, '')), '');
  r        stock_adjustments;
  v_pol    stock_adjustment_policy;
  v_delta  numeric;
  v_new    numeric;
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  select * into r from stock_adjustments where id = p_id and tenant_id = v_tenant for update;
  if r.id is null then
    raise exception 'adjustment_not_found';
  end if;
  if r.status <> 'pending' then
    raise exception 'adjustment_not_pending';
  end if;
  select * into v_pol from stock_adjustment_policy where tenant_id = v_tenant;
  if not _stock_can_approve(v_tenant, v_pol.approver) then
    raise exception 'forbidden_approver' using errcode = '42501';
  end if;
  if r.requested_by = auth.uid() then
    raise exception 'self_approval_forbidden' using errcode = '42501';
  end if;
  if not user_can_access_store(r.store_id) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  if v_notes is not null and char_length(v_notes) > 300 then
    raise exception 'notes_too_long';
  end if;

  if coalesce(p_approve, false) then
    v_delta := case when r.mode = 'set'
                    then r.qty - _stock_scope_qty(r.store_id, r.warehouse_id, r.product_id, r.variant_id)
                    else r.delta end;
    v_new := _stock_adjust_apply(v_tenant, r.store_id, r.warehouse_id, r.product_id, r.variant_id, v_delta,
                                 r.reason, coalesce(r.notes, 'Ajuste aprobado'), r.id);
    update stock_adjustments
       set status = 'applied', decided_by = auth.uid(), decided_at = now(), decision_notes = v_notes,
           applied_delta = v_delta, applied_at = now(), updated_at = now()
     where id = r.id;
  else
    if v_notes is null then
      raise exception 'decision_notes_required';
    end if;
    update stock_adjustments
       set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_notes = v_notes,
           updated_at = now()
     where id = r.id;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data,
                          reason, store_id)
  values (v_tenant, auth.uid(), 'stock_adjustments', r.id,
          case when coalesce(p_approve, false) then 'stock_adjustment_approved' else 'stock_adjustment_rejected' end,
          jsonb_build_object('status', 'pending', 'delta', r.delta, 'requested_by', r.requested_by),
          jsonb_build_object('status', case when coalesce(p_approve, false) then 'applied' else 'rejected' end,
                             'applied_delta', v_delta, 'new_qty', v_new),
          v_notes, r.store_id);

  if r.requested_by is not null then
    begin
      insert into notifications (target_tenant_id, target_role, target_user_id, type, severity,
                                 title, body, action_label, action_url, expires_at)
      values (v_tenant, null, r.requested_by, 'comercial',
              case when coalesce(p_approve, false) then 'info' else 'warning' end,
              case when coalesce(p_approve, false) then 'Ajuste de stock aprobado' else 'Ajuste de stock rechazado' end,
              coalesce(v_notes, 'Revisá el detalle en Inventario.'),
              'Ver', '/inventario?tab=ajustes', now() + interval '30 days');
    exception when others then
      raise warning 'stock_adjustment_decide notify: %', sqlerrm;
    end;
  end if;

  return jsonb_build_object('id', r.id,
                            'status', case when coalesce(p_approve, false) then 'applied' else 'rejected' end,
                            'applied_delta', v_delta, 'new_qty', v_new);
end;
$$;
revoke all on function stock_adjustment_decide(uuid, boolean, text) from public, anon;
grant execute on function stock_adjustment_decide(uuid, boolean, text) to authenticated;

-- Varios a la vez (después de una importación). Cada uno en su subbloque.
create or replace function stock_adjustment_decide_many(p_ids uuid[], p_approve boolean, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   uuid;
  v_ok   integer := 0;
  v_errs jsonb := '[]'::jsonb;
begin
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 300 then
    raise exception 'invalid_ids';
  end if;
  foreach v_id in array p_ids loop
    begin
      perform stock_adjustment_decide(v_id, p_approve, p_notes);
      v_ok := v_ok + 1;
    exception when others then
      v_errs := v_errs || jsonb_build_array(jsonb_build_object('id', v_id, 'message', sqlerrm));
    end;
  end loop;
  return jsonb_build_object('ok', v_ok, 'errors', v_errs);
end;
$$;
revoke all on function stock_adjustment_decide_many(uuid[], boolean, text) from public, anon;
grant execute on function stock_adjustment_decide_many(uuid[], boolean, text) to authenticated;

-- Quien lo pidió (o el dueño) puede retirar un pedido pendiente.
create or replace function stock_adjustment_cancel(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  r        stock_adjustments;
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  select * into r from stock_adjustments where id = p_id and tenant_id = v_tenant for update;
  if r.id is null then
    raise exception 'adjustment_not_found';
  end if;
  if r.status <> 'pending' then
    raise exception 'adjustment_not_pending';
  end if;
  if r.requested_by is distinct from auth.uid() and coalesce(member_role_in(v_tenant), '') <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update stock_adjustments
     set status = 'cancelled', decided_by = auth.uid(), decided_at = now(), updated_at = now()
   where id = r.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_tenant, auth.uid(), 'stock_adjustments', r.id, 'stock_adjustment_cancelled',
          jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'cancelled'), r.store_id);
end;
$$;
revoke all on function stock_adjustment_cancel(uuid) from public, anon;
grant execute on function stock_adjustment_cancel(uuid) to authenticated;

-- Historial y pendientes con nombres, producto y foto del producto.
create or replace function stock_adjustments_list(
  p_store_id uuid default null, p_status text default null, p_limit integer default 100
)
returns table (
  id                uuid,
  store_id          uuid,
  store_name        text,
  warehouse_id      uuid,
  warehouse_name    text,
  product_id        uuid,
  variant_id        uuid,
  product_name      text,
  variant_label     text,
  sku               text,
  image_url         text,
  unit              text,
  mode              text,
  qty               numeric,
  reason            text,
  notes             text,
  photo_path        text,
  system_qty        numeric,
  delta             numeric,
  unit_cost         numeric,
  value             numeric,
  status            text,
  needs_approval    boolean,
  source            text,
  requested_by      uuid,
  requested_by_name text,
  requested_at      timestamptz,
  decided_by        uuid,
  decided_by_name   text,
  decided_at        timestamptz,
  decision_notes    text,
  applied_delta     numeric,
  applied_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_tenant uuid := current_tenant_id();
  v_cost   boolean;
begin
  if v_tenant is null or not member_has_capability(v_tenant, 'stock.view') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('pending', 'applied', 'rejected', 'cancelled') then
    raise exception 'invalid_status';
  end if;
  if p_store_id is not null and not user_can_access_store(p_store_id) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  v_cost := member_has_capability(v_tenant, 'stock.valuation');

  return query
  select a.id, a.store_id, s.name::text, a.warehouse_id, w.name::text,
         a.product_id, a.variant_id, p.name::text,
         case when v.id is null then null else (v.option1 || coalesce(' / ' || v.option2, ''))::text end,
         coalesce(v.sku, p.sku)::text, p.image_url::text, coalesce(p.unit, 'un')::text,
         a.mode, a.qty, a.reason, a.notes, a.photo_path, a.system_qty, a.delta,
         case when v_cost then a.unit_cost end, case when v_cost then a.value end,
         a.status, a.needs_approval, a.source,
         a.requested_by,
         coalesce(nullif(btrim(tr.display_name), ''), nullif(btrim(ur.full_name), ''), ur.email)::text,
         a.requested_at,
         a.decided_by,
         coalesce(nullif(btrim(td.display_name), ''), nullif(btrim(ud.full_name), ''), ud.email)::text,
         a.decided_at, a.decision_notes, a.applied_delta, a.applied_at
    from stock_adjustments a
    join stores s on s.id = a.store_id
    join products p on p.id = a.product_id
    left join product_variants v on v.id = a.variant_id
    left join warehouses w on w.id = a.warehouse_id
    left join users ur on ur.id = a.requested_by
    left join tenant_users tr on tr.tenant_id = a.tenant_id and tr.user_id = a.requested_by
    left join users ud on ud.id = a.decided_by
    left join tenant_users td on td.tenant_id = a.tenant_id and td.user_id = a.decided_by
   where a.tenant_id = v_tenant
     and (p_store_id is null or a.store_id = p_store_id)
     and a.store_id = any (user_allowed_store_ids())
     and (p_status is null or a.status = p_status)
   order by (a.status = 'pending') desc, a.created_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;
revoke all on function stock_adjustments_list(uuid, text, integer) from public, anon;
grant execute on function stock_adjustments_list(uuid, text, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Lecturas de Inventario: planilla de stock, movimientos y valuación.
-- -----------------------------------------------------------------------------
create or replace function _inventory_assert(p_store_id uuid, p_cap text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or not member_has_capability(v_tenant, p_cap) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_store_id is not null then
    if not exists (select 1 from stores s where s.id = p_store_id and s.tenant_id = v_tenant
                     and s.deleted_at is null) then
      raise exception 'store_not_found';
    end if;
    if not user_can_access_store(p_store_id) then
      raise exception 'store_forbidden' using errcode = '42501';
    end if;
  end if;
  return v_tenant;
end;
$$;
revoke all on function _inventory_assert(uuid, text) from public, anon, authenticated;

-- Una fila por producto (o variante) con foto, códigos, costo y stock de la
-- sucursal, desglosado por depósito si los hay. Sirve a la pantalla y al
-- Excel. El costo sólo con stock.valuation.
create or replace function inventory_stock_sheet(
  p_store_id uuid, p_search text default null, p_only_with_stock boolean default false,
  p_limit integer default 200, p_offset integer default 0
)
returns table (
  product_id    uuid,
  variant_id    uuid,
  product_name  text,
  variant_label text,
  sku           text,
  barcode       text,
  image_url     text,
  unit          text,
  category_name text,
  cost          numeric,
  price         numeric,
  store_qty     numeric,
  min_qty       numeric,
  max_qty       numeric,
  location      text,
  principal_qty numeric,
  by_warehouse  jsonb,
  total_count   bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_tenant uuid := _inventory_assert(p_store_id, 'stock.view');
  v_cost   boolean := member_has_capability(v_tenant, 'stock.valuation');
  v_q      text := nullif(btrim(coalesce(p_search, '')), '');
  v_has_wh boolean;
begin
  if p_store_id is null then raise exception 'store_required'; end if;
  v_has_wh := exists (select 1 from warehouses w where w.store_id = p_store_id and w.deleted_at is null
                        and w.kind <> 'principal');

  return query
  with items as (
    select p.id as pid, null::uuid as vid, p.name as pname, null::text as vlabel, p.sku as psku,
           p.barcode as pbar, p.image_url as pimg, p.unit as punit, p.category_id as pcat,
           p.cost as pcost, p.price as pprice
      from products p
     where p.tenant_id = v_tenant and p.deleted_at is null
       and coalesce(p.track_stock, true) and not coalesce(p.is_kit, false)
       and not coalesce(p.has_variants, false)
    union all
    select p.id, v.id, p.name, v.option1 || coalesce(' / ' || v.option2, ''), coalesce(v.sku, p.sku),
           v.barcode, p.image_url, p.unit, p.category_id, p.cost, coalesce(v.price_override, p.price)
      from product_variants v
      join products p on p.id = v.product_id
     where p.tenant_id = v_tenant and p.deleted_at is null and v.deleted_at is null
       and coalesce(p.track_stock, true) and coalesce(p.has_variants, false)
  ),
  sheet as (
    select i.*, ps.qty as sqty, ps.min_qty as smin, ps.max_qty as smax, ps.location as sloc
      from items i
      left join product_stock ps
        on ps.store_id = p_store_id and ps.product_id = i.pid and ps.variant_id is not distinct from i.vid
     where (v_q is null
            or i.pname ilike '%' || v_q || '%'
            or coalesce(i.vlabel, '') ilike '%' || v_q || '%'
            or coalesce(i.psku, '') ilike v_q || '%'
            or coalesce(i.pbar, '') = v_q)
       and (not coalesce(p_only_with_stock, false) or coalesce(ps.qty, 0) <> 0)
  )
  select r.pid, r.vid, r.pname::text, r.vlabel::text, r.psku::text, r.pbar::text, r.pimg::text,
         coalesce(r.punit, 'un')::text, c.name::text,
         case when v_cost then r.pcost end, r.pprice,
         coalesce(r.sqty, 0), r.smin, r.smax, r.sloc::text,
         case when v_has_wh then warehouse_principal_qty(p_store_id, r.pid, r.vid) end,
         case when v_has_wh then
           coalesce((select jsonb_object_agg(ws.warehouse_id::text, ws.qty) from warehouse_stock ws
                      where ws.store_id = p_store_id and ws.product_id = r.pid
                        and ws.variant_id is not distinct from r.vid and ws.qty <> 0), '{}'::jsonb)
         else '{}'::jsonb end,
         count(*) over ()
    from sheet r
    left join categories c on c.id = r.pcat
   order by r.pname, r.vlabel nulls first
   limit greatest(1, least(coalesce(p_limit, 200), 5000))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;
revoke all on function inventory_stock_sheet(uuid, text, boolean, integer, integer) from public, anon;
grant execute on function inventory_stock_sheet(uuid, text, boolean, integer, integer) to authenticated;

-- Kardex de la sucursal: últimos movimientos con producto, foto y quién.
create or replace function inventory_movements(
  p_store_id uuid, p_product_id uuid default null, p_limit integer default 100,
  p_before timestamptz default null
)
returns table (
  id            uuid,
  created_at    timestamptz,
  product_id    uuid,
  variant_id    uuid,
  product_name  text,
  variant_label text,
  sku           text,
  image_url     text,
  unit          text,
  delta         numeric,
  reason        text,
  loss_reason   text,
  notes         text,
  reference_id  uuid,
  actor_name    text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_tenant uuid := _inventory_assert(p_store_id, 'stock.view');
begin
  if p_store_id is null then raise exception 'store_required'; end if;
  return query
  select m.id, m.created_at, m.product_id, m.variant_id, p.name::text,
         case when v.id is null then null else (v.option1 || coalesce(' / ' || v.option2, ''))::text end,
         coalesce(v.sku, p.sku)::text, p.image_url::text, coalesce(p.unit, 'un')::text,
         m.delta, m.reason, m.loss_reason, m.notes, m.reference_id,
         coalesce(nullif(btrim(tu.display_name), ''), nullif(btrim(u.full_name), ''), u.email)::text
    from stock_movements m
    join products p on p.id = m.product_id
    left join product_variants v on v.id = m.variant_id
    left join users u on u.id = m.created_by
    left join tenant_users tu on tu.tenant_id = m.tenant_id and tu.user_id = m.created_by
   where m.tenant_id = v_tenant and m.store_id = p_store_id
     and (p_product_id is null or m.product_id = p_product_id)
     and (p_before is null or m.created_at < p_before)
   order by m.created_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;
revoke all on function inventory_movements(uuid, uuid, integer, timestamptz) from public, anon;
grant execute on function inventory_movements(uuid, uuid, integer, timestamptz) to authenticated;

-- Valuación al costo y a precio de venta, total y por categoría. Sin
-- sucursal: todas las que el usuario puede ver.
create or replace function inventory_valuation(p_store_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _inventory_assert(p_store_id, 'stock.valuation');
  v_tot    jsonb;
  v_cat    jsonb;
begin
  with st as (
    select ps.qty, p.cost, coalesce(v.price_override, p.price) as price,
           coalesce(c.name, 'Sin categoría') as cat
      from product_stock ps
      join products p on p.id = ps.product_id and p.deleted_at is null
      left join product_variants v on v.id = ps.variant_id
      left join categories c on c.id = p.category_id
     where ps.tenant_id = v_tenant and ps.qty <> 0
       and (case when p_store_id is null then ps.store_id = any (user_allowed_store_ids())
                 else ps.store_id = p_store_id end)
  )
  select jsonb_build_object(
           'units', coalesce(sum(qty) filter (where qty > 0), 0),
           'cost_value', coalesce(round(sum(qty * coalesce(cost, 0)) filter (where qty > 0), 2), 0),
           'retail_value', coalesce(round(sum(qty * coalesce(price, 0)) filter (where qty > 0), 2), 0),
           'items_with_stock', count(*) filter (where qty > 0),
           'negative_items', count(*) filter (where qty < 0),
           'no_cost_items', count(*) filter (where qty > 0 and coalesce(cost, 0) = 0)),
         coalesce((select jsonb_agg(x order by (x ->> 'cost_value')::numeric desc) from (
           select jsonb_build_object(
                    'category', cat,
                    'units', sum(qty),
                    'cost_value', round(sum(qty * coalesce(cost, 0)), 2),
                    'retail_value', round(sum(qty * coalesce(price, 0)), 2),
                    'items', count(*)) as x
             from st where qty > 0 group by cat) g), '[]'::jsonb)
    into v_tot, v_cat
    from st;
  return coalesce(v_tot, '{}'::jsonb) || jsonb_build_object('by_category', coalesce(v_cat, '[]'::jsonb));
end;
$$;
revoke all on function inventory_valuation(uuid) from public, anon;
grant execute on function inventory_valuation(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- G) Importación de ajustes y conteos (motor único, ADR-078).
-- -----------------------------------------------------------------------------
create or replace function _import_stock_adjustments_run(p_tenant uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r         jsonb;
  v_out     jsonb := '[]'::jsonb;
  v_row     int;
  v_sid     uuid;
  v_wid     uuid;
  v_wstore  uuid;
  v_item    record;
  v_qty     numeric;
  v_res     jsonb;
  v_pending int := 0;
begin
  if not member_has_capability(p_tenant, 'stock.import') then
    raise exception 'forbidden_capability: stock.import' using errcode = '42501';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_row := coalesce(nullif(r ->> '_row', '')::int, 0);
    begin
      v_qty := _import_num(r, 'qty');
      if v_qty is null then
        v_out := _import_out(v_out, v_row, 'skip', 'no_qty');
        continue;
      end if;

      v_sid := _import_store(p_tenant, _import_txt(r, 'store'));
      if v_sid is null then raise exception 'import_store_not_found'; end if;
      v_wid := null;
      if _import_txt(r, 'warehouse') is not null or _import_txt(r, 'warehouse_code') is not null then
        v_wid := _import_warehouse(p_tenant, _import_txt(r, 'warehouse_code'), v_sid, _import_txt(r, 'warehouse'));
        if v_wid is null then raise exception 'import_warehouse_not_found'; end if;
        -- El código del depósito manda: la sucursal es la del depósito.
        select w.store_id into v_wstore from warehouses w where w.id = v_wid;
        v_sid := v_wstore;
      end if;

      select * into v_item from _import_find_item(p_tenant, _import_txt(r, 'sku'), _import_txt(r, 'barcode'));
      if v_item.product_id is null then raise exception 'import_product_not_found'; end if;

      v_res := _stock_adjustment_request(p_tenant, jsonb_build_object(
        'store_id', v_sid, 'warehouse_id', v_wid,
        'product_id', v_item.product_id, 'variant_id', v_item.variant_id,
        'mode', _import_txt(r, 'op'), 'qty', v_qty, 'reason', _import_txt(r, 'reason'),
        'notes', coalesce(_import_txt(r, 'notes'), 'Importación XLSX')), 'import');

      if v_res ->> 'status' = 'unchanged' then
        v_out := _import_out(v_out, v_row, 'skip', 'unchanged');
      elsif v_res ->> 'status' = 'pending' then
        v_pending := v_pending + 1;
        v_out := _import_out(v_out, v_row, 'create', 'pending_approval');
      else
        v_out := _import_out(v_out, v_row, 'update');
      end if;
    exception when others then
      v_out := _import_out(v_out, v_row, 'error', sqlerrm);
    end;
  end loop;

  if v_pending > 0 then
    perform _stock_adj_notify(p_tenant, 'Ajustes de stock para aprobar',
      v_pending::text || ' ajustes importados desde Excel esperan tu aprobación en Inventario.');
  end if;
  return v_out;
end;
$$;
revoke all on function _import_stock_adjustments_run(uuid, jsonb) from public, anon, authenticated;

-- Copia de 20261107200300_import_depositos + 'stock_adjustments'.
create or replace function _import_exec(p_entity text, p_feature text, p_rows jsonb,
                                        p_apply boolean, p_file text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _import_guard(p_feature, p_rows);
  v_apply  boolean := coalesce(p_apply, false);
  v_out    jsonb;
  v_res    jsonb;
begin
  if p_entity not in ('products', 'customers', 'stock', 'price_lists', 'stores',
                      'warranty_plans', 'return_reasons', 'warehouses', 'warehouse_stock',
                      'stock_adjustments') then
    raise exception 'invalid_entity' using errcode = '22023';
  end if;
  begin
    execute format('select _import_%s_run($1, $2)', p_entity) into v_out using v_tenant, p_rows;
    if not v_apply then
      -- Dry-run: todo lo escrito arriba se revierte; v_out (variable) queda.
      raise exception 'dry_run' using errcode = 'NJDRY';
    end if;
  exception when sqlstate 'NJDRY' then
    null;
  end;
  v_res := _import_summary(v_out);
  if v_apply then
    perform _import_audit(v_tenant, p_entity, p_file, v_res);
  end if;
  return v_res || jsonb_build_object('applied', v_apply, 'entity', p_entity);
end;
$$;
revoke all on function _import_exec(text, text, jsonb, boolean, text) from public, anon, authenticated;

create or replace function import_stock_adjustments(p_rows jsonb, p_apply boolean default false,
                                                    p_file_name text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select _import_exec('stock_adjustments', 'ajustes_stock', p_rows, p_apply, p_file_name);
$$;
revoke all on function import_stock_adjustments(jsonb, boolean, text) from public, anon;
grant execute on function import_stock_adjustments(jsonb, boolean, text) to authenticated;
