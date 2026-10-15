-- =============================================================================
-- 20261205100000_garantias_extendidas_tipos  (H28 · ADR-139)
--
-- Tipos de garantía extendida configurables por negocio, con alcance por
-- categoría y producto, precio calculado por el servidor dentro de la venta y
-- vencimiento guardado en la línea vendida.
--
--   A) warranty_plans (el "tipo de garantía"): monto mínimo y máximo,
--      redondeo, condiciones para el comprobante, alcance "todos los
--      productos", baja lógica y updated_at. El % pasa a ser sobre el precio
--      del producto que cubre (antes, sobre el total del ticket) y la prima
--      fija es por unidad.
--   B) warranty_plan_scopes: asignación del tipo a categorías (con herencia
--      hacia abajo en el árbol rubro > categoría > subcategoría) y a
--      productos, como inclusión o exclusión. Sólo lectura directa; se
--      escribe con warranty_plan_save.
--   C) Precio y alcance (espejo exacto de lib/warranty/pricing.ts):
--        warranty_unit_price(precio, %, fija, mín, máx, redondeo)
--        _warranty_plan_resolve(tipo, producto)
--      Precedencia: producto > categoría más específica > todos.
--   D) RPC (dueño o encargado, feature garantias, audit_logs):
--      warranty_plan_save, warranty_plan_set_active, warranty_plan_archive,
--      warranty_plan_reorder. Las escrituras directas a warranty_plans se
--      cierran (sin DELETE físico).
--   E) sale_items: warranty_expires_on y warranty_terms. Un trigger valida la
--      garantía cuando create_sale la enlaza (ADR-096): tipo activo, producto
--      alcanzado y precio = precio calculado x cantidad de la línea cubierta.
--      Calcula el vencimiento (fecha de la venta en hora de Argentina +
--      garantía de fábrica + meses del tipo) y copia las condiciones.
--      Venta offline (ADR-077) y cobro en espera acreditado (ADR-056): la
--      plata ya entró, no se frena; la diferencia queda en audit_logs.
--
-- No recrea create_sale: el enlace de la garantía ya hace un UPDATE de la
-- línea con warranty_plan_id (ADR-096) y el trigger se engancha ahí.
-- Seguridad: RLS en la tabla nueva, policies con (select ...) y sin
-- is_internal() suelto. Gating server-side con tenant_has_feature_for.
--
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tipos de garantía extendida
-- -----------------------------------------------------------------------------
alter table warranty_plans add column if not exists min_price      numeric(12,2);
alter table warranty_plans add column if not exists max_price      numeric(12,2);
alter table warranty_plans add column if not exists rounding_step  numeric(12,2) not null default 0;
alter table warranty_plans add column if not exists terms          text;
alter table warranty_plans add column if not exists applies_to_all boolean not null default true;
alter table warranty_plans add column if not exists updated_at     timestamptz not null default now();
alter table warranty_plans add column if not exists deleted_at     timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'warranty_plans_amounts_check') then
    alter table warranty_plans add constraint warranty_plans_amounts_check check (
      (min_price is null or min_price >= 0)
      and (max_price is null or max_price >= 0)
      and (min_price is null or max_price is null or max_price >= min_price)
      and rounding_step >= 0
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'warranty_plans_terms_check') then
    alter table warranty_plans add constraint warranty_plans_terms_check
      check (terms is null or char_length(terms) <= 1000);
  end if;
end $$;

comment on column warranty_plans.price_pct is
  'ADR-139: % sobre el precio unitario del producto que cubre (antes, sobre el total del ticket).';
comment on column warranty_plans.price is
  'ADR-139: prima fija por unidad cubierta (se usa si price_pct = 0).';
comment on column warranty_plans.applies_to_all is
  'ADR-139: true = todos los productos salvo exclusiones; false = sólo lo incluido en warranty_plan_scopes.';
comment on column warranty_plans.terms is
  'ADR-139: condiciones que salen en el comprobante (se copian a sale_items.warranty_terms al vender).';

create index if not exists warranty_plans_tenant_live_idx
  on warranty_plans (tenant_id, sort) where deleted_at is null;

-- Escrituras sólo por RPC (auditadas, baja lógica). La lectura sigue igual.
drop policy if exists warranty_plans_insert on warranty_plans;
drop policy if exists warranty_plans_update on warranty_plans;
drop policy if exists warranty_plans_delete on warranty_plans;
drop policy if exists warranty_plans_write on warranty_plans;
revoke insert, update, delete on warranty_plans from anon, authenticated;
grant select on warranty_plans to authenticated;

-- -----------------------------------------------------------------------------
-- B) Asignación a categorías y productos
-- -----------------------------------------------------------------------------
create table if not exists warranty_plan_scopes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  plan_id     uuid not null references warranty_plans(id) on delete cascade,
  category_id uuid references categories(id) on delete cascade,
  product_id  uuid references products(id) on delete cascade,
  effect      text not null check (effect in ('include', 'exclude')),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  deleted_at  timestamptz,
  constraint warranty_plan_scopes_target_check
    check ((category_id is not null) <> (product_id is not null))
);
comment on table warranty_plan_scopes is
  'ADR-139: alcance de un tipo de garantía. Categoría (hereda hacia abajo) o producto, incluir o excluir. Escribe warranty_plan_save.';

create unique index if not exists warranty_plan_scopes_target_uidx
  on warranty_plan_scopes (plan_id, coalesce(category_id, product_id)) where deleted_at is null;
create index if not exists warranty_plan_scopes_tenant_idx
  on warranty_plan_scopes (tenant_id, plan_id) where deleted_at is null;
create index if not exists warranty_plan_scopes_category_idx
  on warranty_plan_scopes (category_id) where category_id is not null;
create index if not exists warranty_plan_scopes_product_idx
  on warranty_plan_scopes (product_id) where product_id is not null;

alter table warranty_plan_scopes enable row level security;
revoke all on warranty_plan_scopes from anon, authenticated;
grant select on warranty_plan_scopes to authenticated;
drop policy if exists warranty_plan_scopes_select on warranty_plan_scopes;
create policy warranty_plan_scopes_select on warranty_plan_scopes
  for select using (
    tenant_id = (select current_tenant_id())
    or (select internal_scope())
  );

-- -----------------------------------------------------------------------------
-- C) Precio y alcance (espejo de lib/warranty/pricing.ts)
-- -----------------------------------------------------------------------------
-- Prima por unidad: % del precio (o la fija si el % es 0), redondeada al
-- múltiplo más cercano del paso (0 = centavos) y acotada por mínimo y máximo.
-- Producto a $0 (regalo, pack) = sin garantía.
create or replace function warranty_unit_price(
  p_unit numeric, p_pct numeric, p_fixed numeric,
  p_min numeric, p_max numeric, p_step numeric
) returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when coalesce(p_unit, 0) <= 0 then 0::numeric
    else round(
      case when p_max is not null
           then least(greatest(s.v, coalesce(p_min, 0)), p_max)
           else greatest(s.v, coalesce(p_min, 0)) end, 2)
  end
  from (
    select case when coalesce(p_step, 0) > 0 then round(r.raw / p_step) * p_step else round(r.raw, 2) end as v
      from (select case when coalesce(p_pct, 0) > 0 then p_unit * p_pct / 100 else coalesce(p_fixed, 0) end as raw) r
  ) s;
$$;
grant execute on function warranty_unit_price(numeric, numeric, numeric, numeric, numeric, numeric)
  to authenticated, service_role;

-- ¿El tipo alcanza al producto? Producto > categoría más específica (subiendo
-- por el árbol, sólo categorías vivas) > "todos los productos".
create or replace function _warranty_plan_resolve(p_plan uuid, p_product uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan   warranty_plans%rowtype;
  v_cat    uuid;
  v_effect text;
  v_src    uuid;
begin
  select * into v_plan from warranty_plans where id = p_plan;
  if not found then
    return jsonb_build_object('applies', false, 'reason', 'no_plan');
  end if;
  select p.category_id into v_cat
    from products p
   where p.id = p_product and p.tenant_id = v_plan.tenant_id;
  if not found then
    return jsonb_build_object('applies', false, 'reason', 'no_product');
  end if;

  select s.effect into v_effect
    from warranty_plan_scopes s
   where s.plan_id = p_plan and s.product_id = p_product and s.deleted_at is null
   limit 1;
  if v_effect is not null then
    return jsonb_build_object('applies', v_effect = 'include', 'reason', 'product_' || v_effect);
  end if;

  with recursive chain (id, parent_id, depth) as (
    select c.id, c.parent_id, 0
      from categories c
     where c.id = v_cat and c.tenant_id = v_plan.tenant_id and c.deleted_at is null
    union all
    select c.id, c.parent_id, ch.depth + 1
      from categories c
      join chain ch on c.id = ch.parent_id
     where c.tenant_id = v_plan.tenant_id and c.deleted_at is null and ch.depth < 12
  )
  select s.effect, s.category_id into v_effect, v_src
    from chain ch
    join warranty_plan_scopes s
      on s.category_id = ch.id and s.plan_id = p_plan and s.deleted_at is null
   order by ch.depth
   limit 1;
  if v_effect is not null then
    return jsonb_build_object('applies', v_effect = 'include', 'reason', 'category_' || v_effect,
                              'category_id', v_src);
  end if;

  return jsonb_build_object('applies', v_plan.applies_to_all,
                            'reason', case when v_plan.applies_to_all then 'all' else 'not_assigned' end);
end;
$$;
revoke all on function _warranty_plan_resolve(uuid, uuid) from public, anon, authenticated;
grant execute on function _warranty_plan_resolve(uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- D) RPC de configuración (dueño o encargado)
-- -----------------------------------------------------------------------------
create or replace function _warranty_plan_guard()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or auth.uid() is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'garantias') then
    raise exception 'feature_not_in_plan: garantias' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _warranty_plan_guard() from public, anon, authenticated;

create or replace function _warranty_plan_snapshot(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select to_jsonb(wp) || jsonb_build_object('scopes', coalesce((
           select jsonb_agg(jsonb_build_object('category_id', s.category_id, 'product_id', s.product_id,
                                               'effect', s.effect) order by s.created_at)
             from warranty_plan_scopes s
            where s.plan_id = wp.id and s.deleted_at is null), '[]'::jsonb))
    from warranty_plans wp
   where wp.id = p_id;
$$;
revoke all on function _warranty_plan_snapshot(uuid) from public, anon, authenticated;

-- Alta o edición de un tipo. p_scopes (opcional) reemplaza toda la asignación:
-- [{ "category_id": uuid } | { "product_id": uuid }, "effect": include|exclude].
create or replace function warranty_plan_save(p_plan jsonb, p_scopes jsonb default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _warranty_plan_guard();
  v_id     uuid := nullif(p_plan ->> 'id', '')::uuid;
  v_label  text := btrim(coalesce(p_plan ->> 'label', ''));
  v_months int;
  v_pct    numeric;
  v_price  numeric;
  v_min    numeric;
  v_max    numeric;
  v_step   numeric;
  v_comm   numeric;
  v_sort   int;
  v_all    boolean := coalesce((p_plan ->> 'applies_to_all')::boolean, true);
  v_active boolean := coalesce((p_plan ->> 'is_active')::boolean, true);
  v_desc   text := nullif(btrim(coalesce(p_plan ->> 'description', '')), '');
  v_terms  text := nullif(btrim(coalesce(p_plan ->> 'terms', '')), '');
  v_before jsonb;
  v_s      jsonb;
  v_n      int := 0;
begin
  begin
    v_months := coalesce(nullif(p_plan ->> 'months', '')::int, 0);
    v_pct    := coalesce(nullif(p_plan ->> 'price_pct', '')::numeric, 0);
    v_price  := coalesce(nullif(p_plan ->> 'price', '')::numeric, 0);
    v_min    := nullif(p_plan ->> 'min_price', '')::numeric;
    v_max    := nullif(p_plan ->> 'max_price', '')::numeric;
    v_step   := coalesce(nullif(p_plan ->> 'rounding_step', '')::numeric, 0);
    v_comm   := coalesce(nullif(p_plan ->> 'commission_pct', '')::numeric, 0);
    v_sort   := nullif(p_plan ->> 'sort', '')::int;
  exception when others then
    raise exception 'warranty_plan_invalid' using errcode = '22023';
  end;

  if char_length(v_label) < 1 or char_length(v_label) > 60 then
    raise exception 'warranty_label_invalid' using errcode = '22023';
  end if;
  if v_months < 1 or v_months > 120 then
    raise exception 'warranty_months_invalid' using errcode = '22023';
  end if;
  if v_pct < 0 or v_pct > 100 or v_price < 0 or v_comm < 0 or v_comm > 100 then
    raise exception 'warranty_price_invalid' using errcode = '22023';
  end if;
  if v_pct = 0 and v_price = 0 then
    raise exception 'warranty_price_required' using errcode = '22023';
  end if;
  if (v_min is not null and v_min < 0) or (v_max is not null and v_max < 0)
     or (v_min is not null and v_max is not null and v_max < v_min)
     or v_step < 0 or v_step > 100000 then
    raise exception 'warranty_limits_invalid' using errcode = '22023';
  end if;
  if char_length(coalesce(v_desc, '')) > 300 or char_length(coalesce(v_terms, '')) > 1000 then
    raise exception 'warranty_text_too_long' using errcode = '22023';
  end if;
  if exists (select 1 from warranty_plans w
              where w.tenant_id = v_tenant and w.deleted_at is null
                and lower(w.label) = lower(v_label) and w.id is distinct from v_id) then
    raise exception 'warranty_label_taken' using errcode = '23505';
  end if;

  if v_id is not null then
    perform 1 from warranty_plans
     where id = v_id and tenant_id = v_tenant and deleted_at is null
       for update;
    if not found then
      raise exception 'warranty_plan_not_found' using errcode = 'P0002';
    end if;
    v_before := _warranty_plan_snapshot(v_id);
    update warranty_plans
       set label = v_label, months = v_months, price_pct = v_pct, price = v_price,
           min_price = v_min, max_price = v_max, rounding_step = v_step,
           commission_pct = v_comm, description = v_desc, terms = v_terms,
           applies_to_all = v_all, is_active = v_active,
           sort = coalesce(v_sort, sort), updated_at = now()
     where id = v_id;
  else
    insert into warranty_plans (tenant_id, label, months, price_pct, price, min_price, max_price,
                                rounding_step, commission_pct, description, terms, applies_to_all,
                                is_active, sort)
    values (v_tenant, v_label, v_months, v_pct, v_price, v_min, v_max, v_step, v_comm, v_desc,
            v_terms, v_all, v_active,
            coalesce(v_sort, (select coalesce(max(sort), -1) + 1 from warranty_plans
                               where tenant_id = v_tenant and deleted_at is null)))
    returning id into v_id;
  end if;

  if p_scopes is not null then
    if jsonb_typeof(p_scopes) <> 'array' or jsonb_array_length(p_scopes) > 500 then
      raise exception 'warranty_scopes_invalid' using errcode = '22023';
    end if;
    for v_s in select * from jsonb_array_elements(p_scopes) loop
      v_n := v_n + 1;
      if coalesce(v_s ->> 'effect', '') not in ('include', 'exclude')
         or ((nullif(v_s ->> 'category_id', '') is null) = (nullif(v_s ->> 'product_id', '') is null)) then
        raise exception 'warranty_scopes_invalid' using errcode = '22023';
      end if;
      if nullif(v_s ->> 'category_id', '') is not null and not exists (
           select 1 from categories c
            where c.id::text = v_s ->> 'category_id' and c.tenant_id = v_tenant and c.deleted_at is null) then
        raise exception 'warranty_scope_category_not_found' using errcode = '22023';
      end if;
      if nullif(v_s ->> 'product_id', '') is not null and not exists (
           select 1 from products p
            where p.id::text = v_s ->> 'product_id' and p.tenant_id = v_tenant and p.deleted_at is null) then
        raise exception 'warranty_scope_product_not_found' using errcode = '22023';
      end if;
    end loop;
    if (select count(distinct coalesce(e ->> 'category_id', e ->> 'product_id'))
          from jsonb_array_elements(p_scopes) e) <> v_n then
      raise exception 'warranty_scopes_duplicated' using errcode = '22023';
    end if;

    -- Baja lógica de lo que ya no está (o cambió de efecto) y alta de lo nuevo.
    update warranty_plan_scopes s
       set deleted_at = now()
     where s.plan_id = v_id and s.deleted_at is null
       and not exists (
         select 1 from jsonb_array_elements(p_scopes) e
          where coalesce(e ->> 'category_id', e ->> 'product_id') = coalesce(s.category_id, s.product_id)::text
            and e ->> 'effect' = s.effect);
    insert into warranty_plan_scopes (tenant_id, plan_id, category_id, product_id, effect, created_by)
    select v_tenant, v_id, nullif(e ->> 'category_id', '')::uuid, nullif(e ->> 'product_id', '')::uuid,
           e ->> 'effect', auth.uid()
      from jsonb_array_elements(p_scopes) e
     where not exists (
       select 1 from warranty_plan_scopes s
        where s.plan_id = v_id and s.deleted_at is null
          and coalesce(s.category_id, s.product_id)::text = coalesce(e ->> 'category_id', e ->> 'product_id'));
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'warranty_plans', v_id,
          case when v_before is null then 'warranty_plan_created' else 'warranty_plan_updated' end,
          v_before, _warranty_plan_snapshot(v_id));
  return v_id;
end;
$$;
revoke all on function warranty_plan_save(jsonb, jsonb) from public, anon;
grant execute on function warranty_plan_save(jsonb, jsonb) to authenticated;

create or replace function warranty_plan_set_active(p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _warranty_plan_guard();
  v_before boolean;
begin
  select is_active into v_before from warranty_plans
   where id = p_id and tenant_id = v_tenant and deleted_at is null
     for update;
  if not found then
    raise exception 'warranty_plan_not_found' using errcode = 'P0002';
  end if;
  if v_before is distinct from p_active then
    update warranty_plans set is_active = coalesce(p_active, false), updated_at = now() where id = p_id;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
    values (v_tenant, auth.uid(), 'warranty_plans', p_id,
            case when p_active then 'warranty_plan_activated' else 'warranty_plan_paused' end,
            jsonb_build_object('is_active', v_before), jsonb_build_object('is_active', coalesce(p_active, false)));
  end if;
end;
$$;
revoke all on function warranty_plan_set_active(uuid, boolean) from public, anon;
grant execute on function warranty_plan_set_active(uuid, boolean) to authenticated;

-- Baja lógica: deja de ofrecerse; las ventas que la tienen la siguen mostrando.
create or replace function warranty_plan_archive(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _warranty_plan_guard();
  v_before jsonb;
begin
  perform 1 from warranty_plans
   where id = p_id and tenant_id = v_tenant and deleted_at is null
     for update;
  if not found then
    raise exception 'warranty_plan_not_found' using errcode = 'P0002';
  end if;
  v_before := _warranty_plan_snapshot(p_id);
  update warranty_plans set deleted_at = now(), is_active = false, updated_at = now() where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'warranty_plans', p_id, 'warranty_plan_archived', v_before,
          jsonb_build_object('deleted_at', now()));
end;
$$;
revoke all on function warranty_plan_archive(uuid) from public, anon;
grant execute on function warranty_plan_archive(uuid) to authenticated;

-- Orden de las tarjetas (y del selector del POS): ids en el orden nuevo.
create or replace function warranty_plan_reorder(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _warranty_plan_guard();
  v_before jsonb;
begin
  if p_ids is null or cardinality(p_ids) > 200 or exists (
       select 1 from unnest(p_ids) x(id)
        where not exists (select 1 from warranty_plans w
                           where w.id = x.id and w.tenant_id = v_tenant and w.deleted_at is null)) then
    raise exception 'warranty_plan_not_found' using errcode = 'P0002';
  end if;
  select jsonb_agg(jsonb_build_object('id', id, 'sort', sort) order by sort) into v_before
    from warranty_plans where tenant_id = v_tenant and deleted_at is null;
  update warranty_plans w
     set sort = x.ord - 1, updated_at = now()
    from unnest(p_ids) with ordinality as x(id, ord)
   where w.id = x.id and w.tenant_id = v_tenant;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'warranty_plans', null, 'warranty_plans_reordered', v_before,
          jsonb_build_object('ids', to_jsonb(p_ids)));
end;
$$;
revoke all on function warranty_plan_reorder(uuid[]) from public, anon;
grant execute on function warranty_plan_reorder(uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Línea vendida: vencimiento, condiciones y precio validado
-- -----------------------------------------------------------------------------
alter table sale_items add column if not exists warranty_expires_on date;
alter table sale_items add column if not exists warranty_terms      text;
comment on column sale_items.warranty_expires_on is
  'ADR-139: vencimiento de la garantía extendida (fecha de la venta en AR + fábrica + meses del tipo).';

create or replace function _sale_item_warranty_apply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan     warranty_plans%rowtype;
  v_cov      sale_items%rowtype;
  v_res      jsonb;
  v_unit     numeric;
  v_expected numeric;
  v_received numeric;
  v_factory  int;
  v_sold_at  timestamptz;
  v_lenient  boolean := coalesce(current_setting('ninja.offline_sync', true), '') <> ''
                        or coalesce(current_setting('ninja.pc_complete', true), '') <> '';
  v_issue    text;
begin
  if new.warranty_plan_id is null then
    new.warranty_expires_on := null;
    new.warranty_terms := null;
    return new;
  end if;
  -- Mismo vínculo: lo calculado no se toca a mano.
  if tg_op = 'UPDATE'
     and new.warranty_plan_id is not distinct from old.warranty_plan_id
     and new.warranty_for_item_id is not distinct from old.warranty_for_item_id then
    new.warranty_months := old.warranty_months;
    new.warranty_expires_on := old.warranty_expires_on;
    new.warranty_terms := old.warranty_terms;
    return new;
  end if;

  select * into v_plan from warranty_plans
   where id = new.warranty_plan_id and tenant_id = new.tenant_id;
  select * into v_cov from sale_items
   where id = new.warranty_for_item_id and tenant_id = new.tenant_id and sale_id = new.sale_id;
  if v_plan.id is null or v_cov.id is null or v_cov.product_id is null or new.product_id is not null then
    raise exception 'warranty_link_invalid';
  end if;

  if v_plan.deleted_at is not null or not v_plan.is_active then
    v_issue := 'warranty_plan_inactive';
  else
    v_res := _warranty_plan_resolve(v_plan.id, v_cov.product_id);
    if not coalesce((v_res ->> 'applies')::boolean, false) then
      v_issue := 'warranty_not_applicable';
    end if;
  end if;
  v_unit := warranty_unit_price(v_cov.unit_price, v_plan.price_pct, v_plan.price,
                                v_plan.min_price, v_plan.max_price, v_plan.rounding_step);
  v_expected := round(v_unit * v_cov.quantity, 2);
  v_received := round(coalesce(new.unit_price, 0) * coalesce(new.quantity, 0), 2);
  if v_issue is null and (v_expected <= 0 or abs(v_received - v_expected) > 0.01) then
    v_issue := 'warranty_amount_mismatch';
  end if;

  if v_issue is not null then
    if not v_lenient then
      if v_issue = 'warranty_amount_mismatch' then
        raise exception using errcode = 'P0001',
          message = 'warranty_amount_mismatch:' || jsonb_build_object('expected', v_expected, 'received', v_received)::text;
      end if;
      raise exception '%', v_issue;
    end if;
    -- Offline o cobro en espera ya acreditado: la plata entró; queda registrado.
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, auth.uid(), 'sale_items', new.id, 'warranty_price_conflict',
            jsonb_build_object('sale_id', new.sale_id, 'plan_id', v_plan.id, 'issue', v_issue,
                               'expected', v_expected, 'received', v_received));
  end if;

  select coalesce(p.warranty_months, 0) into v_factory from products p where p.id = v_cov.product_id;
  select s.created_at into v_sold_at from sales s where s.id = new.sale_id;
  new.warranty_months := v_plan.months;
  new.warranty_expires_on := ((coalesce(v_sold_at, now()) at time zone 'America/Argentina/Buenos_Aires')::date
                              + make_interval(months => coalesce(v_factory, 0) + v_plan.months))::date;
  new.warranty_terms := left(coalesce(v_plan.terms, v_plan.description), 1000);
  return new;
end;
$$;
revoke all on function _sale_item_warranty_apply() from public, anon, authenticated;

drop trigger if exists sale_items_warranty_apply on sale_items;
create trigger sale_items_warranty_apply
  before insert or update of warranty_plan_id, warranty_for_item_id, warranty_months,
                             warranty_expires_on, warranty_terms
  on sale_items
  for each row
  execute function _sale_item_warranty_apply();
