-- =============================================================================
-- 20260608340000_my_payment_history  (SaaS Fix — Registro de pagos del dueño)
--
-- A) my_payment_history(): historial COMPLETO de pagos del tenant para el panel
--    del dueño. billing_records tiene RLS solo-staff (is_internal), así que el
--    dueño no puede leer la tabla directo. Este RPC owner-gated (owner|manager,
--    status='active') devuelve hasta 100 filas (id, amount, currency, medium,
--    period_start/end, receipt_ref, notes, created_at) ordenadas por fecha desc.
--    SECURITY DEFINER + guard explícito; NO expone billing_records de otros
--    tenants (filtra por current_tenant_id()).
--
-- B) ai_public_config(): grant a anon. Su payload es PÚBLICO (imagen/texto/precio
--    /trial del addon IA, sin api_key ni secretos), y se necesita en el registro
--    PRE-AUTH (flujo email, todavía sin sesión) para mostrar el precio "+$X/mes"
--    del complemento. Mantiene SECURITY DEFINER y el grant a authenticated.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) my_payment_history — historial de pagos owner-gated.
-- -----------------------------------------------------------------------------
create or replace function my_payment_history()
returns jsonb language plpgsql security definer set search_path=public,pg_temp stable as $$
declare v jsonb;
begin
  if not exists (
    select 1 from tenant_users
    where tenant_id = current_tenant_id() and user_id = auth.uid()
      and status='active' and role in ('owner','manager')
  ) then raise exception 'forbidden'; end if;
  select coalesce(jsonb_agg(r order by r.created_at desc), '[]'::jsonb) into v
  from (
    select id, amount, currency, medium, period_start, period_end, receipt_ref, notes, created_at
    from billing_records where tenant_id = current_tenant_id()
    order by created_at desc limit 100
  ) r;
  return v;
end; $$;
revoke all on function my_payment_history() from public, anon;
grant execute on function my_payment_history() to authenticated;

-- -----------------------------------------------------------------------------
-- B) ai_public_config() — habilitar a anon para el registro pre-auth.
--    No expone secretos (solo imagen/texto/precio) → seguro para anon.
-- -----------------------------------------------------------------------------
grant execute on function ai_public_config() to anon;
