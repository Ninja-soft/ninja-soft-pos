-- =============================================================================
-- 20260531050000_system_email_smtp  (H13 — F7)
-- Emails del sistema por SMTP propio (configurable desde /internal/emails, sin
-- secrets de backend). La clave es secreta: RLS sin policies => solo service_role.
-- get_email_smtp() expone la config SIN la clave para el formulario. Aplicada vía MCP.
-- =============================================================================
create table if not exists system_email_smtp (
  id         boolean primary key default true check (id = true),
  host       text not null default '',
  port       int  not null default 587,
  secure     boolean not null default false,
  username   text not null default '',
  password   text not null default '',
  from_name  text not null default 'NinjaPos',
  from_email text not null default '',
  updated_at timestamptz not null default now()
);
insert into system_email_smtp (id) values (true) on conflict (id) do nothing;

create trigger set_updated_at_system_email_smtp
  before update on system_email_smtp
  for each row execute function set_updated_at();

alter table system_email_smtp enable row level security;  -- sin policies: solo service_role

create or replace function get_email_smtp()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when not is_internal() then null else (
    select jsonb_build_object(
      'host', host, 'port', port, 'secure', secure, 'username', username,
      'from_name', from_name, 'from_email', from_email,
      'has_password', (password <> '')
    ) from system_email_smtp where id = true
  ) end;
$$;
revoke all on function get_email_smtp() from public, anon;
grant execute on function get_email_smtp() to authenticated;
