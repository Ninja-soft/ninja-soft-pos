-- =============================================================================
-- 20260608440000_internal_grant_addon  (SAAS — regalar un addon a un negocio)
--
-- "Regalar el Asistente IA" desde el detalle de un negocio en el panel interno.
-- Hasta ahora el acceso sin contratar se daba SÓLO vía ai_config.beta_owner_email
-- (un único tester por email), lo que confundía: no se podía bonificar el addon a
-- un negocio concreto. Estas dos RPC lo resuelven, espejando internal_grant_catalog
-- (Tiendita) sobre la tabla subscription_addons.
--
--  • internal_grant_addon(p_tenant, p_addon_key): bonifica (source='granted',
--    status='active', sin cobro). Idempotente por (tenant_id, addon_key); reactiva
--    un grant cancelado limpiando la ventana cancel_at_period_end. Auditada.
--  • internal_revoke_addon(p_tenant, p_addon_key): cancela el grant (status=
--    'cancelled', corta la ventana de gracia). Sólo toca grants (source='granted');
--    no pisa un addon pago. Auditada.
--
-- Ambas: internal-gated (is_internal y nivel != 'support'), SECURITY DEFINER con
-- search_path fijo. El guard del Asistente (ai_available / ai_assistant) ya
-- reconoce status='active' del addon, así que el grant habilita la IA al instante.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Bonificar un addon a un negocio (source='granted'). Idempotente y auditado.
-- Devuelve el id de la fila de subscription_addons.
-- -----------------------------------------------------------------------------
create or replace function public.internal_grant_addon(
  p_tenant    uuid,
  p_addon_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id  uuid;
  v_key text := btrim(p_addon_key);
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_tenant is null then
    raise exception 'invalid_tenant';
  end if;
  if coalesce(v_key, '') = '' then
    raise exception 'invalid_addon';
  end if;

  -- Alta o reactivación. source='granted' (bonificado, sin cobro). Reseteamos la
  -- ventana de cancelación para que un grant cancelado vuelva a estar plenamente
  -- activo (el guard ai_available honra cancel_at_period_end/current_period_end).
  insert into subscription_addons (tenant_id, addon_key, status, source)
  values (p_tenant, v_key, 'active', 'granted')
  on conflict (tenant_id, addon_key) do update
    set status               = 'active',
        source               = 'granted',
        cancel_at_period_end  = false,
        current_period_end    = null
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, auth.uid(), 'subscription_addons', v_id, 'addon_granted',
          jsonb_build_object('addon', v_key, 'source', 'granted', 'status', 'active'));

  return v_id;
end;
$$;

revoke all on function public.internal_grant_addon(uuid, text) from public, anon;
grant execute on function public.internal_grant_addon(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Cancelar un addon BONIFICADO (source='granted'). No toca addons pagos. Audita.
-- -----------------------------------------------------------------------------
create or replace function public.internal_revoke_addon(
  p_tenant    uuid,
  p_addon_key text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := btrim(p_addon_key);
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_tenant is null then
    raise exception 'invalid_tenant';
  end if;
  if coalesce(v_key, '') = '' then
    raise exception 'invalid_addon';
  end if;

  -- Sólo cancelamos si es un grant (no pisamos un addon pago/contratado). Cortar
  -- la ventana de gracia (cancel_at_period_end/current_period_end) deja al guard
  -- ai_available negando el acceso de inmediato.
  update subscription_addons
     set status               = 'cancelled',
         cancel_at_period_end  = false,
         current_period_end    = null
   where tenant_id = p_tenant
     and addon_key = v_key
     and source    = 'granted';

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, auth.uid(), 'subscription_addons', null, 'addon_revoked',
          jsonb_build_object('addon', v_key, 'source', 'granted', 'status', 'cancelled'));
end;
$$;

revoke all on function public.internal_revoke_addon(uuid, text) from public, anon;
grant execute on function public.internal_revoke_addon(uuid, text) to authenticated;
