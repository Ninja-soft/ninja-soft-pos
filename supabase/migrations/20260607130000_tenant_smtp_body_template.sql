-- =============================================================================
-- 20260607130000_tenant_smtp_body_template  (H9b PR5)
-- Diseño del cuerpo del email del comprobante, elegible por tenant.
-- Claves: brand | clean | dark | warm | minimal (catálogo en send_receipt_email).
-- get_tenant_smtp() lo expone para el selector de Configuración → Email.
-- =============================================================================
alter table tenant_email_smtp add column if not exists body_template text not null default 'brand';

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
          'body_template', body_template,
          'has_password', (password <> '')
        ) from tenant_email_smtp where tenant_id = current_tenant_id()
      ),
      jsonb_build_object('allowed', true, 'configured', false)
    )
  end;
$$;
