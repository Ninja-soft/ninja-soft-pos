-- =============================================================================
-- 20260608330000_ai_public_config_provider_image  (SaaS Fix — Asistente IA)
--
-- A) ai_public_config(): ahora expone la imagen del PROVEEDOR ACTIVO (la que ve
--    el cliente con el addon como ícono de la burbuja). Antes devolvía un único
--    image_url; ahora elige gemini_image_url | claude_image_url según
--    ai_config.provider, con fallback a la image_url legacy y, si todo está
--    vacío, al SVG de marca por defecto servido por la app (public/ia/*.svg).
--    Sigue SECURITY DEFINER (platform_secrets tiene RLS deny) y NUNCA expone la
--    api_key ni ningún secreto. Mantiene commercial_text/precio/trial.
--
-- B) Bucket público `ai-assets` (idempotente) para los avatares del asistente.
--    Son GLOBALES (no scoped por tenant): lectura pública, escritura sólo staff
--    interno (is_internal()). Mismo patrón que plan-assets.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) ai_public_config(): imagen del proveedor activo + textos públicos.
-- -----------------------------------------------------------------------------
create or replace function ai_public_config()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- Imagen del proveedor ACTIVO: su campo *_image_url; si vacío, la legacy
    -- image_url; si también vacía, el SVG de marca por defecto de la app.
    'image_url',
      coalesce(
        nullif(
          case when coalesce(s.secrets ->> 'provider', 'gemini') = 'claude'
               then s.secrets ->> 'claude_image_url'
               else s.secrets ->> 'gemini_image_url'
          end, ''),
        nullif(s.secrets ->> 'image_url', ''),
        case when coalesce(s.secrets ->> 'provider', 'gemini') = 'claude'
             then '/ia/claude.svg'
             else '/ia/gemini.svg'
        end
      ),
    'provider',        coalesce(s.secrets ->> 'provider', 'gemini'),
    'commercial_text', coalesce(s.secrets ->> 'commercial_text', ''),
    'addon_price_ars', coalesce(s.secrets ->> 'addon_price_ars', ''),
    'addon_trial_days', coalesce(s.secrets ->> 'addon_trial_days', '')
  )
  from platform_secrets s
  where s.key = 'ai_config';
$$;

-- Si no hay fila ai_config, la función devuelve NULL (sin filas). El cliente
-- trata NULL como "sin config pública" y cae al SVG/texto por defecto.
revoke all on function ai_public_config() from public, anon;
grant execute on function ai_public_config() to authenticated;

-- -----------------------------------------------------------------------------
-- B) Bucket público ai-assets (avatares globales del asistente).
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('ai-assets', 'ai-assets', true)
on conflict (id) do nothing;

drop policy if exists "ai_assets_write" on storage.objects;
drop policy if exists "ai_assets_modify" on storage.objects;
drop policy if exists "ai_assets_remove" on storage.objects;

-- Subida/edición/borrado: sólo staff interno (is_internal()). Lectura pública
-- (el bucket es public => getPublicUrl resuelve sin auth).
create policy "ai_assets_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'ai-assets' and is_internal());
create policy "ai_assets_modify" on storage.objects for update to authenticated
  using (bucket_id = 'ai-assets' and is_internal())
  with check (bucket_id = 'ai-assets' and is_internal());
create policy "ai_assets_remove" on storage.objects for delete to authenticated
  using (bucket_id = 'ai-assets' and is_internal());
