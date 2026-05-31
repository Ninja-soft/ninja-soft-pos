-- =============================================================================
-- 20260531230000_pos_settings_owner_only
-- Solo el DUEÑO (owner) edita pos_settings (topes de descuento, etc.). El SELECT
-- queda abierto a los miembros del tenant porque create_sale (security invoker)
-- lo lee como el cajero al cobrar.
-- =============================================================================
drop policy if exists pos_settings_write on pos_settings;
create policy pos_settings_write on pos_settings
  for all
  using (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role = 'owner'))
  with check (tenant_id = current_tenant_id() and exists (
    select 1 from tenant_users me where me.tenant_id = current_tenant_id()
      and me.user_id = auth.uid() and me.status = 'active' and me.role = 'owner'));
