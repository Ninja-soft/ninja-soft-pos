-- =============================================================================
-- 20260607110000_ticket_destinations_tenant_smtp  (H9b PR3 — F6)
--
-- A) ticket_templates: activación por DESTINO en lugar de default por tipo:
--    un solo modelo activo para impresión y uno para email por tenant
--    (índices únicos parciales). Los defaults de venta existentes migran a
--    ambos destinos.
-- B) tenant_email_smtp: el email del NEGOCIO (configurado por el dueño en
--    Configuración) para enviar comprobantes a sus clientes. La clave es
--    secreta: RLS sin policies => solo service_role / Edge Functions.
--    get_tenant_smtp() expone la config SIN la clave (guard owner/manager).
--    body_text: texto del cuerpo del email del comprobante, personalizable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Activación por destino.
-- -----------------------------------------------------------------------------
alter table ticket_templates add column if not exists print_active boolean not null default false;
alter table ticket_templates add column if not exists email_active boolean not null default false;

create unique index if not exists uq_ticket_templates_print_active
  on ticket_templates(tenant_id) where print_active and deleted_at is null;
create unique index if not exists uq_ticket_templates_email_active
  on ticket_templates(tenant_id) where email_active and deleted_at is null;

-- Migración de datos: el default de venta pasa a estar activo en ambos destinos.
update ticket_templates
   set print_active = true, email_active = true
 where is_default and kind = 'sale' and deleted_at is null;

-- -----------------------------------------------------------------------------
-- B) Email del negocio (SMTP del tenant).
-- -----------------------------------------------------------------------------
create table if not exists tenant_email_smtp (
  tenant_id  uuid primary key references tenants(id) on delete cascade,
  host       text not null default '',
  port       int  not null default 587,
  secure     boolean not null default false,
  username   text not null default '',
  password   text not null default '',
  from_name  text not null default '',
  from_email text not null default '',
  body_text  text,
  updated_at timestamptz not null default now()
);

create trigger set_updated_at_tenant_email_smtp
  before update on tenant_email_smtp
  for each row execute function set_updated_at();

alter table tenant_email_smtp enable row level security;  -- sin policies: solo service_role

-- Config sin clave para el formulario del tenant (solo owner/manager del tenant).
create or replace function get_tenant_smtp()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when not exists (
      select 1 from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = auth.uid()
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    ) then null
    else (
      select jsonb_build_object(
        'host', host, 'port', port, 'secure', secure, 'username', username,
        'from_name', from_name, 'from_email', from_email,
        'body_text', body_text,
        'has_password', (password <> '')
      ) from tenant_email_smtp where tenant_id = current_tenant_id()
    )
  end;
$$;
revoke all on function get_tenant_smtp() from public, anon;
grant execute on function get_tenant_smtp() to authenticated;
