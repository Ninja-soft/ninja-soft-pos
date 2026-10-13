-- =============================================================================
-- 20261108100200_onboarding_activacion_rubro  (ADR-086 · F15 · H71 parcial)
--
-- Señales nuevas para el checklist de activación por rubro. No reemplaza
-- onboarding_status() (los cinco pasos base siguen ahí, sin recrearla) ni las
-- métricas de plataforma de internal_tenant_activation (ADR-082): suma sólo lo
-- que el checklist del dueño necesita y no existía.
--
--   caja    : el negocio abrió al menos un turno de caja.
--   equipo  : hay otro miembro activo además del que creó el negocio.
--   mesas   : hay mesas cargadas (rubros con salón).
--   agenda  : hay al menos un turno agendado (rubros de servicios).
--   arca    : facturación ARCA habilitada y en producción.
--   escuela : alguien del negocio aprobó el curso "POS básico".
--
-- Qué pasos ve cada negocio lo decide el front con su perfil por rubro
-- (ADR-075) y su plan (lib/onboarding/activationChecklist.ts).
--
-- Igual que onboarding_status(): SECURITY DEFINER acotada a current_tenant_id()
-- (que valida la membresía, ADR-083). Sin negocio en contexto, todo false.
-- =============================================================================

create or replace function onboarding_activation_status()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with t as (select current_tenant_id() as tid)
  select jsonb_build_object(
    'caja', (select tid is not null and exists (
      select 1 from cash_shifts where tenant_id = t.tid
    ) from t),
    'equipo', (select tid is not null and (
      select count(*) from tenant_users where tenant_id = t.tid and status = 'active'
    ) > 1 from t),
    'mesas', (select tid is not null and exists (
      select 1 from dining_tables where tenant_id = t.tid
    ) from t),
    'agenda', (select tid is not null and exists (
      select 1 from appointments where tenant_id = t.tid
    ) from t),
    'arca', (select tid is not null and exists (
      select 1 from arca_settings
       where tenant_id = t.tid and enabled and environment = 'produccion'
    ) from t),
    'escuela', (select tid is not null and exists (
      select 1 from school_progress
       where tenant_id = t.tid and course_key = 'pos-basico' and passed_at is not null
    ) from t)
  );
$$;

revoke all on function onboarding_activation_status() from public, anon;
grant execute on function onboarding_activation_status() to authenticated;
