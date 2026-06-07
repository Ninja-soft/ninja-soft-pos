-- =============================================================================
-- 20260608230000_tenant_resend
-- Proveedor de email del NEGOCIO (tenant): SMTP (default) o Resend (API key).
--   provider:        'smtp' | 'resend'  (cómo se envían los comprobantes).
--   resend_api_key:  clave privada de Resend del tenant. SECRETA: la tabla es
--                    deny-all RLS (sin policies) => solo service_role / Edge Fn.
--                    get_tenant_smtp() NUNCA la devuelve; expone has_resend_key.
-- =============================================================================
alter table tenant_email_smtp
  add column if not exists provider text not null default 'smtp';
alter table tenant_email_smtp
  add column if not exists resend_api_key text not null default '';

-- get_tenant_smtp(): suma provider + has_resend_key (sin exponer la clave).
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
          -- "configurado" = puede enviar: Resend con clave, o SMTP con host+from.
          'configured', case
            when coalesce(provider, 'smtp') = 'resend'
              then (resend_api_key <> '' and from_email <> '')
            else (host <> '' and from_email <> '')
          end,
          'provider', coalesce(provider, 'smtp'),
          'host', host, 'port', port, 'secure', secure, 'username', username,
          'from_name', from_name, 'from_email', from_email,
          'body_text', body_text,
          'body_template', body_template,
          'has_password', (password <> ''),
          'has_resend_key', (resend_api_key <> '')
        ) from tenant_email_smtp where tenant_id = current_tenant_id()
      ),
      jsonb_build_object('allowed', true, 'configured', false)
    )
  end;
$$;
revoke all on function get_tenant_smtp() from public, anon;
grant execute on function get_tenant_smtp() to authenticated;
