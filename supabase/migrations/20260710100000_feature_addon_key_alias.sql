-- =============================================================================
-- 20260710100000_feature_addon_key_alias
--
-- Bug: el addon del Asistente IA vive en subscription_addons bajo la key
-- 'ai_assistant' (seed de plan_addons), pero la feature del catálogo se llama
-- 'asistente_ia' (tabla features, convención CLAUDE.md §6). ai_available() y la
-- Edge Function ya aceptan AMBAS keys, pero tenant_has_feature_for() hacía
-- match EXACTO por addon_key = p_key, por lo que un addon bonificado/comprado
-- como 'ai_assistant' devolvía false al consultar la feature 'asistente_ia'
-- (gating_summary → useFeature). Divergencia real verificada en remoto:
--   tenant_has_feature_for('asistente_ia') = false
--   tenant_has_feature_for('ai_assistant') = true
--
-- Fix (una sola fuente de verdad):
--   A) feature_addon_keys(p_key): expande una key a su set de aliases
--      conocidos (hoy solo asistente_ia ↔ ai_assistant).
--   B) tenant_has_feature_for(): la rama de addons matchea por alias y suma la
--      ventana de cancelación (cancel_at_period_end + current_period_end
--      vigente), la MISMA semántica que ai_available() y la Edge Function
--      ai_assistant. La rama de flags también matchea por alias, igual que
--      ai_available().
--   C) tenant_has_feature(): se re-asserta como delegación (sin cambios de
--      comportamiento propios; hereda el fix).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) feature_addon_keys(p_key): aliases conocidos entre feature key y addon key.
--    IMMUTABLE: el mapeo es estático.
-- -----------------------------------------------------------------------------
create or replace function feature_addon_keys(p_key text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_key, ''))
    when 'asistente_ia' then array['asistente_ia', 'ai_assistant']
    when 'ai_assistant' then array['asistente_ia', 'ai_assistant']
    else array[coalesce(p_key, '')]
  end;
$$;

revoke all on function feature_addon_keys(text) from public, anon;
grant execute on function feature_addon_keys(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- B) tenant_has_feature_for: flags y addons resuelven por alias; el addon
--    cancelado a fin de período conserva acceso hasta current_period_end
--    (misma semántica que ai_available() y la Edge ai_assistant).
-- -----------------------------------------------------------------------------
create or replace function tenant_has_feature_for(p_tenant uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select tff.enabled from tenant_feature_flags tff
       join feature_flags ff on ff.id = tff.feature_flag_id
      where tff.tenant_id = p_tenant
        and ff.key = any (feature_addon_keys(p_key))
      limit 1),
    (select true from subscription_addons sa
      where sa.tenant_id = p_tenant
        and sa.addon_key = any (feature_addon_keys(p_key))
        and (
          sa.status = 'active'
          or (sa.cancel_at_period_end
              and sa.current_period_end is not null
              and sa.current_period_end >= current_date)
        )
      limit 1),
    (select (p.limits -> 'modules' ->> p_key)::boolean
       from subscriptions s join plans p on p.id = s.plan_id
      where s.tenant_id = p_tenant limit 1),
    (select is_basic from features where key = p_key),
    false
  );
$$;

revoke all on function tenant_has_feature_for(uuid, text) from public, anon;
grant execute on function tenant_has_feature_for(uuid, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- C) tenant_has_feature: delegación (sin lógica propia, hereda el alias).
-- -----------------------------------------------------------------------------
create or replace function tenant_has_feature(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select tenant_has_feature_for(current_tenant_id(), p_key);
$$;

revoke all on function tenant_has_feature(text) from public, anon;
grant execute on function tenant_has_feature(text) to authenticated;
