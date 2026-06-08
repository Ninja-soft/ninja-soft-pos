-- =============================================================================
-- 20260608400000_security_hardening
-- Hardening de seguridad/performance (auditoría). SOLO DB: ni frontend ni edge.
--
-- 1) (MEDIO) Cierra `plans` a anon: la policy de SELECT dejaba leer TODOS los
--    planes (incluidos los custom por tenant). Se reemplaza por un predicado que
--    solo expone los globales (tenant_id IS NULL), los del tenant actual, o todo
--    si sos staff interno. El front público usa el RPC public_plans() (definer),
--    así que el listado de precios no se rompe.
-- 2) (BAJO) Guard de propiedad en catalog_product_count(): única función de
--    catálogo sin check; ahora exige compra del catálogo (o staff interno).
-- 3) (BAJO) Revoca EXECUTE de la trigger function trg_payments_assert_method()
--    a anon/authenticated (es trigger, no RPC).
-- 4) (BAJO, defensa en profundidad) Revoca los grants por defecto de PostgREST
--    en las tablas de secretos/billing (RLS ya las bloquea con deny-all).
-- 5) (BAJO perf) ticket_templates: RLS initplan — auth.uid()/current_tenant_id()
--    envueltos en (select ...).
-- 6) (BAJO perf) multiple_permissive_policies: las policies *_write FOR ALL
--    solapaban el SELECT con su *_read. Se dividen en insert/update/delete con la
--    MISMA lógica de autorización (is_internal / owner-manager).
-- 7) (INFO perf) Índices de cobertura en FKs calientes sin indexar.
--
-- Definiciones verificadas contra pg_policies / pg_get_functiondef /
-- information_schema antes de reescribir.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) plans: cerrar lectura directa de planes custom a anon.
-- ---------------------------------------------------------------------------
drop policy if exists plans_select on public.plans;
create policy plans_select on public.plans
  for select using (
    tenant_id is null
    or (select is_internal())
    or tenant_id = (select current_tenant_id())
  );

-- ---------------------------------------------------------------------------
-- 2) catalog_product_count: guard de propiedad (compra del catálogo).
--    Se recrea conservando firma (uuid) -> bigint, STABLE SECURITY DEFINER y
--    search_path fijo. Solo se agrega el check al inicio.
-- ---------------------------------------------------------------------------
create or replace function public.catalog_product_count(p_catalog_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_dedupe boolean;
  v_total bigint;
begin
  if not is_internal() and not exists (
    select 1
      from tenant_catalog_purchases p
      join catalog_store_map m on m.catalog_id = p.catalog_id
     where p.tenant_id = current_tenant_id()
       and p.catalog_id = p_catalog_id
  ) then
    raise exception 'forbidden';
  end if;

  select c.dedupe_by_ean into v_dedupe from catalogs c where c.id = p_catalog_id;
  if v_dedupe is null then
    return 0;
  end if;

  if v_dedupe then
    select count(distinct cp.ean) into v_total
      from catalog_products cp
      join catalog_store_map csm on csm.store_key = cp.store_key
     where csm.catalog_id = p_catalog_id;
  else
    select count(*) into v_total
      from catalog_products cp
      join catalog_store_map csm on csm.store_key = cp.store_key
     where csm.catalog_id = p_catalog_id;
  end if;

  return coalesce(v_total, 0);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3) trg_payments_assert_method(): es trigger, no debe ser invocable como RPC.
--    Se incluye `public` (igual que 20260603120000): sin él, anon/authenticated
--    siguen heredando EXECUTE vía el grant por defecto a PUBLIC y la función
--    queda expuesta en /rest/v1/rpc.
-- ---------------------------------------------------------------------------
revoke execute on function public.trg_payments_assert_method() from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 4) Revoca grants redundantes en tablas de secretos/billing (RLS deny-all ya
--    las protege; el grant por defecto de PostgREST sobra).
-- ---------------------------------------------------------------------------
revoke all on public.platform_secrets   from anon, authenticated;
revoke all on public.payment_secrets    from anon, authenticated;
revoke all on public.email_providers    from anon, authenticated;
revoke all on public.system_email_smtp  from anon, authenticated;
revoke all on public.tenant_email_smtp  from anon, authenticated;
revoke all on public.mp_oauth_states    from anon, authenticated;
revoke all on public.billing_records    from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5 + 6) ticket_templates: split FOR ALL -> insert/update/delete + initplan.
--   Misma autorización: tenant actual + miembro activo owner/manager.
-- ---------------------------------------------------------------------------
drop policy if exists ticket_templates_write on public.ticket_templates;

create policy ticket_templates_insert on public.ticket_templates
  for insert with check (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from public.tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );
create policy ticket_templates_update on public.ticket_templates
  for update using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from public.tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  )
  with check (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from public.tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );
create policy ticket_templates_delete on public.ticket_templates
  for delete using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from public.tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    )
  );

-- ---------------------------------------------------------------------------
-- 6) Catálogo SaaS: split de las policies *_write FOR ALL (is_internal()) en
--    insert/update/delete, para que NO se evalúen en SELECT. is_internal()
--    envuelto en (select ...) para evitar re-evaluación por fila.
--    El acceso de escritura interno se preserva idéntico.
-- ---------------------------------------------------------------------------

-- catalogs
drop policy if exists catalogs_write on public.catalogs;
create policy catalogs_insert on public.catalogs
  for insert with check ((select is_internal()));
create policy catalogs_update on public.catalogs
  for update using ((select is_internal())) with check ((select is_internal()));
create policy catalogs_delete on public.catalogs
  for delete using ((select is_internal()));

-- catalog_products
drop policy if exists catalog_products_write on public.catalog_products;
create policy catalog_products_insert on public.catalog_products
  for insert with check ((select is_internal()));
create policy catalog_products_update on public.catalog_products
  for update using ((select is_internal())) with check ((select is_internal()));
create policy catalog_products_delete on public.catalog_products
  for delete using ((select is_internal()));

-- catalog_stores
drop policy if exists catalog_stores_write on public.catalog_stores;
create policy catalog_stores_insert on public.catalog_stores
  for insert with check ((select is_internal()));
create policy catalog_stores_update on public.catalog_stores
  for update using ((select is_internal())) with check ((select is_internal()));
create policy catalog_stores_delete on public.catalog_stores
  for delete using ((select is_internal()));

-- catalog_store_map
drop policy if exists catalog_store_map_write on public.catalog_store_map;
create policy catalog_store_map_insert on public.catalog_store_map
  for insert with check ((select is_internal()));
create policy catalog_store_map_update on public.catalog_store_map
  for update using ((select is_internal())) with check ((select is_internal()));
create policy catalog_store_map_delete on public.catalog_store_map
  for delete using ((select is_internal()));

-- tenant_catalog_purchases
drop policy if exists tcp_write on public.tenant_catalog_purchases;
create policy tcp_insert on public.tenant_catalog_purchases
  for insert with check ((select is_internal()));
create policy tcp_update on public.tenant_catalog_purchases
  for update using ((select is_internal())) with check ((select is_internal()));
create policy tcp_delete on public.tenant_catalog_purchases
  for delete using ((select is_internal()));

-- ---------------------------------------------------------------------------
-- 7) Índices de cobertura en FKs calientes sin indexar (unindexed_foreign_keys).
--    `if not exists` para idempotencia. NO se indexa catalog_products (ya cubre).
-- ---------------------------------------------------------------------------

-- store_credit_vouchers (5 FKs sin cubrir; tenant_id ya estaba)
create index if not exists store_credit_vouchers_created_by_idx
  on public.store_credit_vouchers (created_by);
create index if not exists store_credit_vouchers_customer_id_idx
  on public.store_credit_vouchers (customer_id);
create index if not exists store_credit_vouchers_redeemed_by_idx
  on public.store_credit_vouchers (redeemed_by);
create index if not exists store_credit_vouchers_redeemed_customer_id_idx
  on public.store_credit_vouchers (redeemed_customer_id);
create index if not exists store_credit_vouchers_sale_return_id_idx
  on public.store_credit_vouchers (sale_return_id);

-- notifications
create index if not exists notifications_created_by_idx
  on public.notifications (created_by);
create index if not exists notifications_target_user_id_idx
  on public.notifications (target_user_id);

-- catalogs
create index if not exists catalogs_created_by_idx
  on public.catalogs (created_by);

-- invite_codes
create index if not exists invite_codes_created_by_idx
  on public.invite_codes (created_by);

-- billing_records
create index if not exists billing_records_recorded_by_idx
  on public.billing_records (recorded_by);

-- store_credit_movements
create index if not exists store_credit_movements_voucher_id_idx
  on public.store_credit_movements (voucher_id);

-- ai_usage
create index if not exists ai_usage_user_id_idx
  on public.ai_usage (user_id);

-- price_list_items
create index if not exists price_list_items_variant_id_idx
  on public.price_list_items (variant_id);

-- tenant_discounts
create index if not exists tenant_discounts_created_by_idx
  on public.tenant_discounts (created_by);
