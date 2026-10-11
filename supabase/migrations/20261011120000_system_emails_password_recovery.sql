-- =============================================================================
-- Recuperación de contraseña por la cadena de proveedores propia (Resend/SMTP),
-- Edge Function send_password_recovery. La bitácora system_emails registra estos
-- envíos con kind 'password_recovery' (también sirve para el límite por email).
-- =============================================================================
alter table system_emails drop constraint if exists system_emails_kind_check;
alter table system_emails
  add constraint system_emails_kind_check
  check (kind in ('system', 'receipt', 'smtp_test', 'password_recovery'));

-- Límite de envíos: búsqueda por destinatario + tipo + fecha.
create index if not exists system_emails_recipient_kind_created_idx
  on system_emails (recipient, kind, created_at desc);
