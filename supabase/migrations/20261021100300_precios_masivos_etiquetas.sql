-- =============================================================================
-- 20261021100300_precios_masivos_etiquetas  (F18 · H100, ADR-058)
--
--   A) Actualización masiva: price_bulk_batches + price_bulk_lines (el diff
--      completo: precio anterior y nuevo por producto, variante y lista).
--      Alcance por proveedor, marca, categoría, tag o productos; destino el
--      precio base o una lista; % o monto (o índice / cotización, PRO);
--      redondeo; vista previa; aprobación opcional del dueño (PRO, setting del
--      negocio); programación por fecha (crea price_schedules) y deshacer
--      (vuelve al precio anterior lo que nadie volvió a tocar).
--      Lógica pura espejo: lib/prices/bulk.ts (_price_bulk_new).
--   B) Índices: % desde cotizaciones (fx_rates) o índices cargados
--      (price_index_values), con tope opcional; queda registrado en el lote.
--   C) price_schedules_apply_due: consolida los precios programados vencidos
--      (el resolver ya los aplicaba solo; esto los escribe en la tabla, deja el
--      historial y encola etiquetas). La llaman el POS, Etiquetas y Precios.
--      price_schedule_set / price_schedule_cancel: programar un precio puntual.
--   D) price_list_import: import XLSX de una lista (o del precio base): ahora o
--      programado.
--   E) Etiquetas a reimprimir: price_label_queue por sucursal, encolada por
--      triggers al cambiar el precio base, una variante o un ítem de una lista
--      de mostrador o asignada a la sucursal. price_labels_mark_printed.
--
-- Gating: destino base y etiquetas BASE; destino lista, programar e importar a
-- lista `listas_precios`; índice y aprobación `listas_precios_pro`. Toda
-- escritura por RPC SECURITY DEFINER con auditoría; las tablas sólo se leen
-- (negocio actual o internal_scope(), ADR-052).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Lotes de actualización masiva
-- -----------------------------------------------------------------------------
create table if not exists price_bulk_batches (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  target_list_id uuid references price_lists(id) on delete set null,
  scope          jsonb not null default '{}'::jsonb,
  mode           text not null check (mode in ('pct', 'amount', 'index')),
  value          numeric(12,4) not null,
  index_info     jsonb,
  rounding       jsonb,
  effective_at   timestamptz,
  status         text not null check (status in ('pending_approval', 'scheduled', 'applied', 'rejected', 'reverted')),
  reason         text check (reason is null or char_length(reason) <= 300),
  line_count     int not null default 0,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  approved_by    uuid,
  approved_at    timestamptz,
  approval_note  text check (approval_note is null or char_length(approval_note) <= 300),
  applied_at     timestamptz,
  reverted_at    timestamptz,
  reverted_by    uuid
);
create index if not exists price_bulk_batches_tenant_idx on price_bulk_batches(tenant_id, created_at desc);
create index if not exists price_bulk_batches_list_idx on price_bulk_batches(target_list_id) where target_list_id is not null;

create table if not exists price_bulk_lines (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  batch_id   uuid not null references price_bulk_batches(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  variant_id uuid references product_variants(id) on delete cascade,
  list_id    uuid references price_lists(id) on delete cascade,
  old_price  numeric(12,2) not null,
  new_price  numeric(12,2) not null check (new_price >= 0)
);
create index if not exists price_bulk_lines_batch_idx on price_bulk_lines(batch_id);
create index if not exists price_bulk_lines_tenant_idx on price_bulk_lines(tenant_id);
create index if not exists price_bulk_lines_product_idx on price_bulk_lines(product_id);
create index if not exists price_bulk_lines_variant_idx on price_bulk_lines(variant_id) where variant_id is not null;
create index if not exists price_bulk_lines_list_idx on price_bulk_lines(list_id) where list_id is not null;

alter table price_schedules drop constraint if exists price_schedules_batch_fk;
alter table price_schedules add constraint price_schedules_batch_fk
  foreign key (batch_id) references price_bulk_batches(id) on delete set null;

alter table price_bulk_batches enable row level security;
alter table price_bulk_lines enable row level security;
revoke insert, update, delete on price_bulk_batches, price_bulk_lines from anon, authenticated;
drop policy if exists price_bulk_batches_select on price_bulk_batches;
create policy price_bulk_batches_select on price_bulk_batches
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists price_bulk_lines_select on price_bulk_lines;
create policy price_bulk_lines_select on price_bulk_lines
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

-- Precio nuevo de una línea (espejo de bulkNewPrice en lib/prices/bulk.ts).
create or replace function _price_bulk_new(p_old numeric, p_mode text, p_value numeric, p_rounding jsonb)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v numeric;
begin
  v := case when p_mode = 'amount' then round(coalesce(p_old, 0) + p_value, 2)
            else round(coalesce(p_old, 0) * (100 + p_value) / 100, 2) end;
  v := greatest(v, 0);
  if p_rounding is not null and coalesce(p_rounding ->> 'mode', 'none') <> 'none' and v > 0 then
    v := _price_round(v, p_rounding);
  end if;
  return v;
end;
$$;
grant execute on function _price_bulk_new(numeric, text, numeric, jsonb) to authenticated, service_role;

-- % de un índice o una cotización entre dos fechas (con tope opcional).
create or replace function _price_index_pct(p_tenant uuid, p jsonb)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text := p ->> 'kind';
  v_from numeric;
  v_to   numeric;
  v_pct  numeric;
  v_cap  numeric := nullif(p ->> 'cap_pct', '')::numeric;
  v_tod  date := coalesce(nullif(p ->> 'to', '')::date, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
begin
  if v_kind = 'fx' then
    select r.rate into v_from from fx_rates r
     where r.tenant_id = p_tenant and r.currency = coalesce(p ->> 'currency', 'USD')
       and r.source = coalesce(p ->> 'source', 'oficial') and r.rate_date <= (p ->> 'from')::date
     order by r.rate_date desc limit 1;
    select r.rate into v_to from fx_rates r
     where r.tenant_id = p_tenant and r.currency = coalesce(p ->> 'currency', 'USD')
       and r.source = coalesce(p ->> 'source', 'oficial') and r.rate_date <= v_tod
     order by r.rate_date desc limit 1;
  elsif v_kind = 'index' then
    select v.value into v_from from price_index_values v
     where v.tenant_id = p_tenant and v.index_key = coalesce(p ->> 'key', 'ipc') and v.period <= (p ->> 'from')::date
     order by v.period desc limit 1;
    select v.value into v_to from price_index_values v
     where v.tenant_id = p_tenant and v.index_key = coalesce(p ->> 'key', 'ipc') and v.period <= v_tod
     order by v.period desc limit 1;
  else
    raise exception 'invalid_index';
  end if;
  if v_from is null or v_to is null or v_from <= 0 then raise exception 'index_value_missing'; end if;
  v_pct := round((v_to / v_from - 1) * 100, 4);
  if v_cap is not null and v_pct > v_cap then v_pct := v_cap; end if;
  return v_pct;
end;
$$;
revoke all on function _price_index_pct(uuid, jsonb) from public, anon, authenticated;

-- Valida el pedido, el rol y el plan. Devuelve el % efectivo para 'index'.
create or replace function _price_bulk_assert(p jsonb, out tenant uuid, out mode text, out value numeric,
                                              out list_id uuid, out index_info jsonb)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := stock_my_role();
  v_err  text;
begin
  tenant := current_tenant_id();
  if tenant is null then raise exception 'no_tenant'; end if;
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  mode := coalesce(p ->> 'mode', 'pct');
  if mode not in ('pct', 'amount', 'index') then raise exception 'invalid_mode'; end if;
  list_id := nullif(p ->> 'list_id', '')::uuid;
  if list_id is not null then
    if not tenant_has_feature_for(tenant, 'listas_precios') then
      raise exception 'feature_not_in_plan: listas_precios' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from price_lists l where l.id = list_id and l.tenant_id = tenant and l.deleted_at is null) then
      raise exception 'price_list_not_found';
    end if;
  end if;
  v_err := price_rounding_error(p -> 'rounding');
  if v_err is not null then raise exception '%', v_err; end if;
  if mode = 'index' then
    if not price_pro_enabled(tenant) then
      raise exception 'feature_not_in_plan: listas_precios_pro' using errcode = 'check_violation';
    end if;
    index_info := p -> 'index';
    value := _price_index_pct(tenant, index_info);
    index_info := index_info || jsonb_build_object('pct', value);
    mode := 'pct';
  else
    value := (p ->> 'value')::numeric;
    if value is null then raise exception 'invalid_value'; end if;
    if mode = 'pct' and (value <= -100 or value > 1000) then raise exception 'invalid_value'; end if;
    if mode = 'amount' and abs(value) > 100000000 then raise exception 'invalid_value'; end if;
  end if;
end;
$$;
revoke all on function _price_bulk_assert(jsonb) from public, anon, authenticated;

-- Productos del alcance: todos, categoría, marca, proveedor, tag o ids.
create or replace function _price_bulk_scope(p_tenant uuid, p_scope jsonb)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id from products p
   where p.tenant_id = p_tenant and p.deleted_at is null
     and (nullif(p_scope ->> 'category_id', '') is null or p.category_id = (p_scope ->> 'category_id')::uuid)
     and (nullif(p_scope ->> 'brand_id', '') is null or p.brand_id = (p_scope ->> 'brand_id')::uuid)
     and (nullif(p_scope ->> 'tag', '') is null or (p_scope ->> 'tag') = any (coalesce(p.tags, '{}')))
     and (nullif(p_scope ->> 'supplier_id', '') is null or exists (
            select 1 from supplier_products sp
             where sp.product_id = p.id and sp.tenant_id = p_tenant and sp.deleted_at is null
               and sp.supplier_id = (p_scope ->> 'supplier_id')::uuid))
     and (jsonb_typeof(p_scope -> 'product_ids') is distinct from 'array' or p.id::text in (
            select jsonb_array_elements_text(p_scope -> 'product_ids')));
$$;
revoke all on function _price_bulk_scope(uuid, jsonb) from public, anon, authenticated;

-- Diff calculado: precio vigente hoy → precio nuevo, sólo lo que cambia.
create or replace function _price_bulk_compute(p_tenant uuid, p_list uuid, p_scope jsonb, p_mode text,
                                               p_value numeric, p_rounding jsonb)
returns table(product_id uuid, variant_id uuid, name text, old_price numeric, new_price numeric, cost numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pro boolean := price_pro_enabled(p_tenant);
  r     record;
  v_old numeric;
  v_new numeric;
  v_b   numeric;
begin
  for r in
    select p.id, p.name, p.price, p.cost from products p
     where p.id in (select _price_bulk_scope(p_tenant, p_scope))
     order by p.name
  loop
    v_b := round(coalesce(_price_sched(p_tenant, null, r.id, null, now()), r.price, 0), 2);
    if p_list is null then
      v_old := v_b;
    else
      select x.price into v_old from _price_list_price(p_tenant, p_list, r.id, null, v_b, now(), v_pro, 0) x;
    end if;
    v_new := _price_bulk_new(v_old, p_mode, p_value, p_rounding);
    if v_new is distinct from v_old then
      product_id := r.id; variant_id := null; name := r.name;
      old_price := v_old; new_price := v_new; cost := r.cost;
      return next;
    end if;
    -- Variantes con precio propio (sólo en el precio base).
    if p_list is null then
      for product_id, variant_id, name, old_price in
        select v.product_id, v.id, r.name || ' · ' || v.option1 || coalesce(' / ' || v.option2, ''),
               round(coalesce(_price_sched(p_tenant, null, r.id, v.id, now()), v.price_override), 2)
          from product_variants v
         where v.product_id = r.id and v.tenant_id = p_tenant and v.deleted_at is null
           and v.price_override is not null
      loop
        new_price := _price_bulk_new(old_price, p_mode, p_value, p_rounding);
        cost := r.cost;
        if new_price is distinct from old_price then return next; end if;
      end loop;
    end if;
  end loop;
end;
$$;
revoke all on function _price_bulk_compute(uuid, uuid, jsonb, text, numeric, jsonb) from public, anon, authenticated;

create or replace function price_bulk_preview(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  select * into a from _price_bulk_assert(p);
  return (
    with d as (
      select * from _price_bulk_compute(a.tenant, a.list_id, coalesce(p -> 'scope', '{}'::jsonb), a.mode, a.value, p -> 'rounding'))
    select jsonb_build_object(
      'count', (select count(*) from d),
      'pct', case when (p ->> 'mode') = 'index' then a.value else null end,
      'before', coalesce((select sum(old_price) from d), 0),
      'after', coalesce((select sum(new_price) from d), 0),
      'below_cost', (select count(*) from d where cost is not null and cost > 0 and new_price < cost),
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'product_id', product_id, 'variant_id', variant_id, 'name', name,
          'old_price', old_price, 'new_price', new_price, 'cost', cost))
        from (select * from d limit 500) x), '[]'::jsonb)));
end;
$$;
revoke all on function price_bulk_preview(jsonb) from public, anon;
grant execute on function price_bulk_preview(jsonb) to authenticated;

-- Escribe el precio de una línea (base, variante o ítem de lista).
create or replace function _price_write(p_tenant uuid, p_list uuid, p_product uuid, p_variant uuid, p_price numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_list is null then
    if p_variant is null then
      update products set price = p_price where id = p_product and tenant_id = p_tenant;
    else
      update product_variants set price_override = p_price where id = p_variant and tenant_id = p_tenant;
    end if;
  else
    update price_list_items set price = p_price
     where price_list_id = p_list and product_id = p_product and variant_id is not distinct from p_variant;
    if not found then
      insert into price_list_items (tenant_id, price_list_id, product_id, variant_id, price)
      values (p_tenant, p_list, p_product, p_variant, p_price);
    end if;
  end if;
end;
$$;
revoke all on function _price_write(uuid, uuid, uuid, uuid, numeric) from public, anon, authenticated;

-- Ejecuta un lote aprobado: ahora o programado.
create or replace function _price_bulk_execute(p_batch uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b price_bulk_batches%rowtype;
  l record;
begin
  select * into b from price_bulk_batches where id = p_batch for update;
  perform set_config('ninja.price_source', 'bulk', true);
  if b.effective_at is not null and b.effective_at > now() then
    insert into price_schedules (tenant_id, list_id, product_id, variant_id, price, effective_at, status, batch_id, source, created_by)
    select b.tenant_id, l2.list_id, l2.product_id, l2.variant_id, l2.new_price, b.effective_at, 'scheduled', b.id, 'bulk', b.created_by
      from price_bulk_lines l2 where l2.batch_id = b.id;
    update price_bulk_batches set status = 'scheduled' where id = b.id;
    return 'scheduled';
  end if;
  for l in select * from price_bulk_lines where batch_id = b.id loop
    perform _price_write(b.tenant_id, l.list_id, l.product_id, l.variant_id, l.new_price);
  end loop;
  update price_bulk_batches set status = 'applied', applied_at = now() where id = b.id;
  return 'applied';
end;
$$;
revoke all on function _price_bulk_execute(uuid) from public, anon, authenticated;

create or replace function price_bulk_create(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a        record;
  v_id     uuid;
  v_count  int;
  v_status text;
  v_eff    timestamptz := nullif(p ->> 'effective_at', '')::timestamptz;
  v_appr   boolean;
begin
  select * into a from _price_bulk_assert(p);
  if v_eff is not null and v_eff < now() - interval '1 minute' then raise exception 'effective_at_past'; end if;

  -- Aprobación (PRO): el encargado carga, el dueño aprueba.
  select coalesce(s.require_approval, false) into v_appr from price_settings s where s.tenant_id = a.tenant;
  v_appr := coalesce(v_appr, false) and price_pro_enabled(a.tenant) and stock_my_role() <> 'owner';

  insert into price_bulk_batches (tenant_id, target_list_id, scope, mode, value, index_info, rounding,
                                  effective_at, status, reason)
  values (a.tenant, a.list_id, coalesce(p -> 'scope', '{}'::jsonb),
          case when (p ->> 'mode') = 'index' then 'index' else a.mode end, a.value, a.index_info,
          p -> 'rounding', v_eff, 'pending_approval', nullif(btrim(coalesce(p ->> 'reason', '')), ''))
  returning id into v_id;

  insert into price_bulk_lines (tenant_id, batch_id, product_id, variant_id, list_id, old_price, new_price)
  select a.tenant, v_id, d.product_id, d.variant_id, a.list_id, d.old_price, d.new_price
    from _price_bulk_compute(a.tenant, a.list_id, coalesce(p -> 'scope', '{}'::jsonb), a.mode, a.value, p -> 'rounding') d;
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'bulk_empty'; end if;
  if v_count > 20000 then raise exception 'bulk_too_large'; end if;
  update price_bulk_batches set line_count = v_count where id = v_id;

  if v_appr then
    v_status := 'pending_approval';
  else
    v_status := _price_bulk_execute(v_id);
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (a.tenant, auth.uid(), 'price_bulk_batches', v_id, 'price_bulk_created',
          jsonb_build_object('status', v_status, 'lines', v_count, 'mode', p ->> 'mode', 'value', a.value,
                             'list_id', a.list_id, 'scope', p -> 'scope', 'effective_at', v_eff,
                             'index', a.index_info));
  return jsonb_build_object('id', v_id, 'status', v_status, 'count', v_count);
end;
$$;
revoke all on function price_bulk_create(jsonb) from public, anon;
grant execute on function price_bulk_create(jsonb) to authenticated;

create or replace function price_bulk_decide(p_batch uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  b        price_bulk_batches%rowtype;
  v_status text;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if coalesce(stock_my_role(), '') <> 'owner' then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into b from price_bulk_batches where id = p_batch and tenant_id = v_tenant for update;
  if not found then raise exception 'batch_not_found'; end if;
  if b.status <> 'pending_approval' then raise exception 'batch_not_pending'; end if;
  if b.created_by = auth.uid() then raise exception 'cannot_approve_own'; end if;
  if p_approve and b.effective_at is not null and b.effective_at < now() then
    update price_bulk_batches set effective_at = null where id = b.id;
  end if;
  update price_bulk_batches
     set approved_by = auth.uid(), approved_at = now(),
         approval_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = b.id;
  if p_approve then
    v_status := _price_bulk_execute(b.id);
  else
    update price_bulk_batches set status = 'rejected' where id = b.id;
    v_status := 'rejected';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, reason, after_data)
  values (v_tenant, auth.uid(), 'price_bulk_batches', b.id,
          case when p_approve then 'price_bulk_approved' else 'price_bulk_rejected' end,
          p_note, jsonb_build_object('status', v_status, 'lines', b.line_count));
  return jsonb_build_object('id', b.id, 'status', v_status);
end;
$$;
revoke all on function price_bulk_decide(uuid, boolean, text) from public, anon;
grant execute on function price_bulk_decide(uuid, boolean, text) to authenticated;

-- Deshacer: cancela lo programado y vuelve al precio anterior lo que sigue con
-- el precio del lote (lo que alguien cambió después no se pisa).
create or replace function price_bulk_revert(p_batch uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  b         price_bulk_batches%rowtype;
  l         record;
  v_cur     numeric;
  v_done    int := 0;
  v_skipped int := 0;
  v_cancel  int := 0;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into b from price_bulk_batches where id = p_batch and tenant_id = v_tenant for update;
  if not found then raise exception 'batch_not_found'; end if;
  if b.status not in ('applied', 'scheduled') then raise exception 'batch_not_revertible'; end if;
  perform set_config('ninja.price_source', 'bulk', true);

  update price_schedules set status = 'cancelled'
   where batch_id = b.id and status in ('scheduled', 'pending');
  get diagnostics v_cancel = row_count;

  if b.status = 'applied' or exists (select 1 from price_schedules s where s.batch_id = b.id and s.status = 'applied') then
    for l in select * from price_bulk_lines where batch_id = b.id loop
      if l.list_id is null and l.variant_id is null then
        select price into v_cur from products where id = l.product_id;
      elsif l.list_id is null then
        select price_override into v_cur from product_variants where id = l.variant_id;
      else
        select price into v_cur from price_list_items
         where price_list_id = l.list_id and product_id = l.product_id and variant_id is not distinct from l.variant_id;
      end if;
      if v_cur is not null and abs(v_cur - l.new_price) <= 0.005 then
        perform _price_write(v_tenant, l.list_id, l.product_id, l.variant_id, l.old_price);
        v_done := v_done + 1;
      else
        v_skipped := v_skipped + 1;
      end if;
    end loop;
  end if;

  update price_bulk_batches set status = 'reverted', reverted_at = now(), reverted_by = auth.uid() where id = b.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'price_bulk_batches', b.id, 'price_bulk_reverted',
          jsonb_build_object('reverted', v_done, 'skipped', v_skipped, 'cancelled', v_cancel));
  return jsonb_build_object('reverted', v_done, 'skipped', v_skipped, 'cancelled', v_cancel);
end;
$$;
revoke all on function price_bulk_revert(uuid) from public, anon;
grant execute on function price_bulk_revert(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Programados: consolidar, programar uno, cancelar
-- -----------------------------------------------------------------------------
create or replace function price_schedules_apply_due()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  s        record;
  v_n      int := 0;
begin
  if v_tenant is null then return 0; end if;
  if not exists (select 1 from tenant_users tu where tu.tenant_id = v_tenant and tu.user_id = auth.uid()
                  and tu.status = 'active') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  for s in
    select distinct on (ps.list_id, ps.product_id, ps.variant_id) ps.*
      from price_schedules ps
     where ps.tenant_id = v_tenant and ps.status = 'scheduled' and ps.effective_at <= now()
     order by ps.list_id, ps.product_id, ps.variant_id, ps.effective_at desc, ps.created_at desc, ps.id desc
  loop
    begin
      perform set_config('ninja.price_source', s.source, true);
      perform _price_write(v_tenant, s.list_id, s.product_id, s.variant_id, s.price);
      update price_schedules set status = 'applied', applied_at = now()
       where tenant_id = v_tenant and status = 'scheduled' and effective_at <= now()
         and product_id = s.product_id and list_id is not distinct from s.list_id
         and variant_id is not distinct from s.variant_id;
      v_n := v_n + 1;
    exception when others then
      -- Lista sin la feature (bajó de plan) u otro rechazo: queda programado.
      null;
    end;
  end loop;
  update price_bulk_batches b set status = 'applied', applied_at = now()
   where b.tenant_id = v_tenant and b.status = 'scheduled'
     and not exists (select 1 from price_schedules x where x.batch_id = b.id and x.status = 'scheduled');
  return v_n;
end;
$$;
revoke all on function price_schedules_apply_due() from public, anon;
grant execute on function price_schedules_apply_due() to authenticated;

create or replace function price_schedule_set(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_list    uuid := nullif(p ->> 'list_id', '')::uuid;
  v_product uuid := (p ->> 'product_id')::uuid;
  v_variant uuid := nullif(p ->> 'variant_id', '')::uuid;
  v_price   numeric := round((p ->> 'price')::numeric, 2);
  v_eff     timestamptz := (p ->> 'effective_at')::timestamptz;
  v_id      uuid;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_price is null or v_price < 0 then raise exception 'invalid_price'; end if;
  if v_eff is null or v_eff <= now() then raise exception 'effective_at_past'; end if;
  if not exists (select 1 from products where id = v_product and tenant_id = v_tenant and deleted_at is null) then
    raise exception 'product_not_found';
  end if;
  if v_variant is not null and not exists (select 1 from product_variants where id = v_variant
                                            and product_id = v_product and tenant_id = v_tenant) then
    raise exception 'variant_not_found';
  end if;
  if v_list is not null then
    if not tenant_has_feature_for(v_tenant, 'listas_precios') then
      raise exception 'feature_not_in_plan: listas_precios' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from price_lists where id = v_list and tenant_id = v_tenant and deleted_at is null) then
      raise exception 'price_list_not_found';
    end if;
  end if;
  insert into price_schedules (tenant_id, list_id, product_id, variant_id, price, effective_at, status, source)
  values (v_tenant, v_list, v_product, v_variant, v_price, v_eff, 'scheduled',
          case when v_list is null then 'manual' else 'list' end)
  returning id into v_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'price_schedules', v_id, 'price_scheduled',
          jsonb_build_object('list_id', v_list, 'product_id', v_product, 'variant_id', v_variant,
                             'price', v_price, 'effective_at', v_eff));
  return v_id;
end;
$$;
revoke all on function price_schedule_set(jsonb) from public, anon;
grant execute on function price_schedule_set(jsonb) to authenticated;

create or replace function price_schedule_cancel(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update price_schedules set status = 'cancelled'
   where id = p_id and tenant_id = v_tenant and status in ('pending', 'scheduled');
  if not found then raise exception 'schedule_not_found'; end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action)
  values (v_tenant, auth.uid(), 'price_schedules', p_id, 'price_schedule_cancelled');
end;
$$;
revoke all on function price_schedule_cancel(uuid) from public, anon;
grant execute on function price_schedule_cancel(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Import de una lista (o del precio base): ahora o programado
-- -----------------------------------------------------------------------------
-- p_rows: [{product_id, variant_id?, price, effective_at?}] (el cliente ya
-- resolvió SKU / código de barras contra el catálogo).
create or replace function price_list_import(p_list uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  r        jsonb;
  v_pid    uuid;
  v_vid    uuid;
  v_price  numeric;
  v_eff    timestamptz;
  v_now    int := 0;
  v_sched  int := 0;
  v_bad    int := 0;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_list is not null then
    if not tenant_has_feature_for(v_tenant, 'listas_precios') then
      raise exception 'feature_not_in_plan: listas_precios' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from price_lists where id = p_list and tenant_id = v_tenant and deleted_at is null) then
      raise exception 'price_list_not_found';
    end if;
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 20000 then raise exception 'invalid_rows'; end if;
  perform set_config('ninja.price_source', 'import', true);

  for r in select * from jsonb_array_elements(p_rows) loop
    begin
      v_pid := (r ->> 'product_id')::uuid;
      v_vid := nullif(r ->> 'variant_id', '')::uuid;
      v_price := round((r ->> 'price')::numeric, 2);
      v_eff := nullif(r ->> 'effective_at', '')::timestamptz;
    exception when others then
      v_bad := v_bad + 1;
      continue;
    end;
    if v_price is null or v_price < 0
       or not exists (select 1 from products where id = v_pid and tenant_id = v_tenant and deleted_at is null)
       or (v_vid is not null and not exists (select 1 from product_variants where id = v_vid and product_id = v_pid
                                              and tenant_id = v_tenant)) then
      v_bad := v_bad + 1;
      continue;
    end if;
    if v_eff is not null and v_eff > now() then
      insert into price_schedules (tenant_id, list_id, product_id, variant_id, price, effective_at, status, source)
      values (v_tenant, p_list, v_pid, v_vid, v_price, v_eff, 'scheduled', 'import');
      v_sched := v_sched + 1;
    else
      perform _price_write(v_tenant, p_list, v_pid, v_vid, v_price);
      v_now := v_now + 1;
    end if;
  end loop;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'price_lists', coalesce(p_list, v_tenant), 'price_list_imported',
          jsonb_build_object('list_id', p_list, 'applied', v_now, 'scheduled', v_sched, 'invalid', v_bad));
  return jsonb_build_object('applied', v_now, 'scheduled', v_sched, 'invalid', v_bad);
end;
$$;
revoke all on function price_list_import(uuid, jsonb) from public, anon;
grant execute on function price_list_import(uuid, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Etiquetas a reimprimir por sucursal
-- -----------------------------------------------------------------------------
create table if not exists price_label_queue (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  store_id   uuid not null references stores(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  variant_id uuid references product_variants(id) on delete cascade,
  list_id    uuid references price_lists(id) on delete set null,
  old_price  numeric(12,2),
  new_price  numeric(12,2),
  source     text not null default 'manual',
  created_at timestamptz not null default now(),
  printed_at timestamptz,
  printed_by uuid
);
create unique index if not exists price_label_queue_pending_key
  on price_label_queue(store_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where printed_at is null;
create index if not exists price_label_queue_tenant_idx on price_label_queue(tenant_id, created_at desc);
create index if not exists price_label_queue_product_idx on price_label_queue(product_id);
create index if not exists price_label_queue_variant_idx on price_label_queue(variant_id) where variant_id is not null;
create index if not exists price_label_queue_list_idx on price_label_queue(list_id) where list_id is not null;

alter table price_label_queue enable row level security;
revoke insert, update, delete on price_label_queue from anon, authenticated;
drop policy if exists price_label_queue_select on price_label_queue;
create policy price_label_queue_select on price_label_queue
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));

create or replace function _price_label_enqueue(p_tenant uuid, p_list uuid, p_product uuid, p_variant uuid,
                                                p_old numeric, p_new numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_on     boolean;
  v_stores uuid[];
  v_store  uuid;
  v_src    text := coalesce(_price_change_source('manual'), 'manual');
begin
  select coalesce(s.label_queue, true) into v_on from price_settings s where s.tenant_id = p_tenant;
  if not coalesce(v_on, true) then return; end if;

  if p_list is null then
    select array_agg(id) into v_stores from stores where tenant_id = p_tenant and deleted_at is null;
  else
    select array_agg(distinct st.id) into v_stores
      from stores st
     where st.tenant_id = p_tenant and st.deleted_at is null
       and (exists (select 1 from price_lists l where l.id = p_list and l.channel = 'mostrador')
            or exists (select 1 from price_list_assignments a where a.price_list_id = p_list and a.tenant_id = p_tenant
                        and ((a.scope = 'store' and a.scope_id = st.id)
                             or (a.scope = 'store_group' and a.scope_id = st.store_group_id))));
  end if;
  if v_stores is null then return; end if;

  foreach v_store in array v_stores loop
    insert into price_label_queue (tenant_id, store_id, product_id, variant_id, list_id, old_price, new_price, source)
    values (p_tenant, v_store, p_product, p_variant, p_list, p_old, p_new, v_src)
    on conflict (store_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
      where printed_at is null
    do update set new_price = excluded.new_price, list_id = excluded.list_id,
                  source = excluded.source, created_at = now();
  end loop;
end;
$$;
revoke all on function _price_label_enqueue(uuid, uuid, uuid, uuid, numeric, numeric) from public, anon, authenticated;

create or replace function trg_price_label_queue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_table_name = 'products' then
    if new.price is distinct from old.price then
      perform _price_label_enqueue(new.tenant_id, null, new.id, null, old.price, new.price);
    end if;
  elsif tg_table_name = 'product_variants' then
    if new.price_override is distinct from old.price_override then
      perform _price_label_enqueue(new.tenant_id, null, new.product_id, new.id, old.price_override, new.price_override);
    end if;
  elsif tg_op = 'INSERT' then
    perform _price_label_enqueue(new.tenant_id, new.price_list_id, new.product_id, new.variant_id, null, new.price);
  elsif new.price is distinct from old.price then
    perform _price_label_enqueue(new.tenant_id, new.price_list_id, new.product_id, new.variant_id, old.price, new.price);
  end if;
  return null;
end;
$$;
revoke all on function trg_price_label_queue() from public, anon, authenticated;

drop trigger if exists products_label_queue on products;
create trigger products_label_queue
  after update of price on products
  for each row execute function trg_price_label_queue();
drop trigger if exists product_variants_label_queue on product_variants;
create trigger product_variants_label_queue
  after update of price_override on product_variants
  for each row execute function trg_price_label_queue();
drop trigger if exists price_list_items_label_queue on price_list_items;
create trigger price_list_items_label_queue
  after insert or update of price on price_list_items
  for each row execute function trg_price_label_queue();

create or replace function price_labels_mark_printed(p_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_n      int;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if stock_my_role() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  update price_label_queue q set printed_at = now(), printed_by = auth.uid()
   where q.id = any (coalesce(p_ids, '{}')) and q.tenant_id = v_tenant and q.printed_at is null
     and (internal_scope() or user_can_access_store(q.store_id));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function price_labels_mark_printed(uuid[]) from public, anon;
grant execute on function price_labels_mark_printed(uuid[]) to authenticated;
