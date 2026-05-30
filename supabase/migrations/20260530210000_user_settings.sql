-- =============================================================================
-- 20260530210000_user_settings
-- Preferencias de UI por usuario (tema, fuentes, fondo) persistidas para que
-- sigan al usuario en cualquier dispositivo. Columna jsonb en public.users.
-- El usuario solo edita la suya (RLS users_update_self + grant a nivel columna).
-- =============================================================================
alter table public.users
  add column if not exists settings jsonb not null default '{}'::jsonb;

grant update (settings) on public.users to authenticated;
