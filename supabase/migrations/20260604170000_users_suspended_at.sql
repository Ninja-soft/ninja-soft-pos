-- =============================================================================
-- 20260604170000_users_suspended_at
-- H11 — espejo de suspensión de cuenta (ban en auth) para mostrar el estado en
-- el panel interno. La suspensión real la hace auth.admin (banned_until) desde
-- la Edge Function staff_admin; esta columna es solo lectura para la UI.
-- =============================================================================

alter table users add column if not exists suspended_at timestamptz;
