-- =============================================================================
-- 20260608160000_ai_public_config  (SAAS Fix — Asistente IA)
--
-- ai_public_config(): datos PÚBLICOS del addon IA para la burbuja del asistente
-- (avatar + texto comercial + precio). La burbuja se le muestra a TODO usuario
-- autenticado del tenant; si no tiene el complemento, abrirla muestra este
-- explicador comercial. NUNCA expone la api_key ni ningún secreto.
--
-- SECURITY DEFINER: platform_secrets tiene RLS deny a todos; la función lee solo
-- las claves públicas de ai_config y devuelve un jsonb acotado. Callable por
-- authenticated (revoke a public/anon).
-- =============================================================================

create or replace function ai_public_config()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'image_url',       coalesce(s.secrets ->> 'image_url', ''),
    'commercial_text', coalesce(s.secrets ->> 'commercial_text', ''),
    'addon_price_ars', coalesce(s.secrets ->> 'addon_price_ars', ''),
    'addon_trial_days', coalesce(s.secrets ->> 'addon_trial_days', '')
  )
  from platform_secrets s
  where s.key = 'ai_config';
$$;

-- Si no hay fila ai_config, la función devuelve NULL (sin filas). El cliente
-- trata NULL como "sin config pública" y cae al texto por defecto.
revoke all on function ai_public_config() from public, anon;
grant execute on function ai_public_config() to authenticated;
