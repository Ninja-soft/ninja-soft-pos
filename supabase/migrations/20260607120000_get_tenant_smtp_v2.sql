-- =============================================================================
-- 20260607120000_get_tenant_smtp_v2  (H9b PR5 — fix)
-- get_tenant_smtp() devolvía NULL tanto para "sin permiso" como para "sin
-- configurar" (sin fila): el card de Configuración → Email le mostraba al
-- dueño el mensaje de "solo el dueño puede configurar". Ahora devuelve
-- siempre un objeto con `allowed` y `configured` explícitos.
-- =============================================================================
create or replace function get_tenant_smtp()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when not exists (
      select 1 from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = auth.uid()
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    ) then jsonb_build_object('allowed', false, 'configured', false)
    else coalesce(
      (
        select jsonb_build_object(
          'allowed', true,
          'configured', (host <> '' and from_email <> ''),
          'host', host, 'port', port, 'secure', secure, 'username', username,
          'from_name', from_name, 'from_email', from_email,
          'body_text', body_text,
          'has_password', (password <> '')
        ) from tenant_email_smtp where tenant_id = current_tenant_id()
      ),
      jsonb_build_object('allowed', true, 'configured', false)
    )
  end;
$$;
