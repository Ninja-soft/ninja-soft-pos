-- Performance advisor fixes (Supabase advisors, 2026-06-04) — parte 2: RLS.
-- Mismas reglas de acceso que las policies actuales; solo optimización.
--
-- 1) auth_rls_initplan: auth.uid()/current_tenant_id()/is_internal() se
--    envuelven en subqueries escalares `(select fn())` para que Postgres
--    los evalúe una vez por query (initplan) en vez de una vez por fila.
-- 2) multiple_permissive_policies: las policies "*_write" eran FOR ALL y
--    solapaban SELECT con su "*_select". Se dividen en insert/update/delete
--    con el mismo predicado (owner/manager; pos_settings solo owner).
--
-- Definiciones actuales verificadas contra pg_policies antes de reescribir.

-- ---------------------------------------------------------------------------
-- 1) RLS initplan (policies que no participan del split FOR ALL)
-- ---------------------------------------------------------------------------

drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
  for select using (
    (select is_internal())
    or id in (
      select tenant_id from public.tenant_users
      where user_id = (select auth.uid()) and status = 'active'
    )
  );

drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select using (id = (select auth.uid()) or (select is_internal()));

drop policy if exists users_update_self on public.users;
create policy users_update_self on public.users
  for update using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists tenant_users_select on public.tenant_users;
create policy tenant_users_select on public.tenant_users
  for select using (
    user_id = (select auth.uid())
    or tenant_id = (select current_tenant_id())
    or (select is_internal())
  );

drop policy if exists cust_account_write on public.customer_account_movements;
create policy cust_account_write on public.customer_account_movements
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

-- ---------------------------------------------------------------------------
-- 2) Split de policies FOR ALL "*_write" (también arregla su lint initplan)
-- ---------------------------------------------------------------------------

-- customer_groups (owner/manager)
drop policy if exists customer_groups_write on public.customer_groups;
create policy customer_groups_insert on public.customer_groups
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
create policy customer_groups_update on public.customer_groups
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
create policy customer_groups_delete on public.customer_groups
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

-- email_templates (owner/manager)
drop policy if exists email_templates_write on public.email_templates;
create policy email_templates_insert on public.email_templates
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
create policy email_templates_update on public.email_templates
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
create policy email_templates_delete on public.email_templates
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

-- payment_plans (owner/manager)
drop policy if exists payment_plans_write on public.payment_plans;
create policy payment_plans_insert on public.payment_plans
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
create policy payment_plans_update on public.payment_plans
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
create policy payment_plans_delete on public.payment_plans
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

-- pos_settings (solo owner)
drop policy if exists pos_settings_write on public.pos_settings;
create policy pos_settings_insert on public.pos_settings
  for insert with check (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from public.tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role = 'owner'
    )
  );
create policy pos_settings_update on public.pos_settings
  for update using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from public.tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role = 'owner'
    )
  )
  with check (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from public.tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role = 'owner'
    )
  );
create policy pos_settings_delete on public.pos_settings
  for delete using (
    tenant_id = (select current_tenant_id())
    and exists (
      select 1 from public.tenant_users me
      where me.tenant_id = (select current_tenant_id())
        and me.user_id = (select auth.uid())
        and me.status = 'active'
        and me.role = 'owner'
    )
  );

-- return_reasons (owner/manager)
drop policy if exists return_reasons_write on public.return_reasons;
create policy return_reasons_insert on public.return_reasons
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
create policy return_reasons_update on public.return_reasons
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
create policy return_reasons_delete on public.return_reasons
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

-- tenant_branding (owner/manager)
drop policy if exists tenant_branding_write on public.tenant_branding;
create policy tenant_branding_insert on public.tenant_branding
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
create policy tenant_branding_update on public.tenant_branding
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
create policy tenant_branding_delete on public.tenant_branding
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

-- tenant_payment_methods (owner/manager)
drop policy if exists tpm_write on public.tenant_payment_methods;
create policy tpm_insert on public.tenant_payment_methods
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
create policy tpm_update on public.tenant_payment_methods
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
create policy tpm_delete on public.tenant_payment_methods
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

-- warranty_plans (owner/manager)
drop policy if exists warranty_plans_write on public.warranty_plans;
create policy warranty_plans_insert on public.warranty_plans
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
create policy warranty_plans_update on public.warranty_plans
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
create policy warranty_plans_delete on public.warranty_plans
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
