-- =============================================================================
-- 20261107100200_ficha_360_negocio  (F7 · H11c · ADR-084)
--
-- Ficha 360 del negocio para el panel interno: una sola RPC que devuelve
-- AGREGADOS (nunca filas de ventas ni datos de clientes finales):
--   · miembros por rol y estado, sucursales, cajas y productos activos;
--   · ventas de hoy, 7 y 30 días (cantidad y total) y última venta;
--   · módulos efectivos (tenant_has_feature_for) y overrides de flags;
--   · últimos errores: webhooks de cobro, comprobantes fiscales rechazados o
--     que requieren acción y emails fallidos;
--   · última actividad (audit_logs) y accesos como el negocio abiertos.
-- Guard internal_scope() (ADR-052): fuera del panel interno no devuelve nada.
-- Cada bloque opcional (fiscal, webhooks) se omite si la tabla no existe.
-- =============================================================================

create or replace function internal_tenant_360(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_out      jsonb;
  v_errors   jsonb := '[]'::jsonb;
  v_part     jsonb;
  v_wh_7d    integer := 0;
  v_fiscal   integer := 0;
begin
  if not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found';
  end if;

  select jsonb_build_object(
    'members', (
      select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where tu.status = 'active'),
        'suspended', count(*) filter (where tu.status = 'suspended'),
        'inactive', count(*) filter (where tu.status = 'inactive'),
        'owners', count(*) filter (where tu.role = 'owner' and tu.status = 'active'),
        'managers', count(*) filter (where tu.role = 'manager' and tu.status = 'active'),
        'cashiers', count(*) filter (where tu.role = 'cashier' and tu.status = 'active'),
        'viewers', count(*) filter (where tu.role = 'viewer' and tu.status = 'active'),
        'last_login_at', max(au.last_sign_in_at))
        from tenant_users tu
        left join auth.users au on au.id = tu.user_id
       where tu.tenant_id = p_tenant),
    'stores', (select count(*) from stores s
                where s.tenant_id = p_tenant and s.deleted_at is null and s.is_active),
    'registers', (select count(*) from cash_registers c
                   where c.tenant_id = p_tenant and c.is_active),
    'products', (select count(*) from products p
                  where p.tenant_id = p_tenant and p.deleted_at is null and p.is_active),
    'sales', (
      select jsonb_build_object(
        'today_count', count(*) filter (where sa.created_at >= date_trunc('day', now())),
        'today_total', coalesce(sum(sa.total) filter (where sa.created_at >= date_trunc('day', now())), 0),
        'd7_count', count(*) filter (where sa.created_at >= now() - interval '7 days'),
        'd7_total', coalesce(sum(sa.total) filter (where sa.created_at >= now() - interval '7 days'), 0),
        'd30_count', count(*),
        'd30_total', coalesce(sum(sa.total), 0))
        from sales sa
       where sa.tenant_id = p_tenant
         and sa.status = 'completed'
         and sa.created_at >= now() - interval '30 days'),
    'last_sale_at', (select max(sa.created_at) from sales sa
                      where sa.tenant_id = p_tenant and sa.status = 'completed'),
    'modules', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', f.key, 'label', f.label, 'grupo', f.grupo, 'is_basic', f.is_basic,
               'enabled', tenant_has_feature_for(p_tenant, f.key))
             order by f.grupo, f.sort, f.key), '[]'::jsonb)
        from features f),
    'flag_overrides', (select count(*) from tenant_feature_flags tff where tff.tenant_id = p_tenant),
    'activity', (
      select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb)
        from (select a.action, a.entity_type, a.created_at, a.reason, u.email as actor_email
                from audit_logs a
                left join public.users u on u.id = a.actor_user_id
               where a.tenant_id = p_tenant
               order by a.created_at desc
               limit 10) x),
    'open_impersonations', (select count(*) from impersonation_sessions i
                             where i.tenant_id = p_tenant and i.ended_at is null
                               and i.expires_at > now())
  ) into v_out;

  -- Errores recientes (cada fuente es opcional según el stack).
  if to_regclass('public.webhook_events') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'source', 'webhook', 'label', w.provider, 'detail', w.error, 'at', w.created_at)
             order by w.created_at desc), '[]'::jsonb)
        from (select provider, error, created_at from webhook_events
               where tenant_id = $1 and status = 'error'
               order by created_at desc limit 5) w$q$
      into v_part using p_tenant;
    v_errors := v_errors || v_part;
    execute $q$select count(*)::int from webhook_events
                where tenant_id = $1 and status = 'error'
                  and created_at >= now() - interval '7 days'$q$
      into v_wh_7d using p_tenant;
  end if;

  if to_regclass('public.fiscal_documents') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'source', 'fiscal', 'label', f.status, 'detail', coalesce(f.last_error_msg, f.last_error_code),
               'at', f.updated_at)
             order by f.updated_at desc), '[]'::jsonb)
        from (select status, last_error_msg, last_error_code, updated_at from fiscal_documents
               where tenant_id = $1 and status in ('rechazado', 'requiere_accion')
               order by updated_at desc limit 5) f$q$
      into v_part using p_tenant;
    v_errors := v_errors || v_part;
    execute $q$select count(*)::int from fiscal_documents
                where tenant_id = $1 and status in ('rechazado', 'requiere_accion')$q$
      into v_fiscal using p_tenant;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'source', 'email', 'label', e.subject, 'detail', e.error_message, 'at', e.created_at)
         order by e.created_at desc), '[]'::jsonb)
    into v_part
    from (select subject, error_message, created_at from system_emails
           where tenant_id = p_tenant and status = 'failed'
           order by created_at desc limit 5) e;
  v_errors := v_errors || v_part;

  return v_out || jsonb_build_object(
    'errors', v_errors,
    'webhook_errors_7d', v_wh_7d,
    'fiscal_pending', v_fiscal);
end;
$$;

revoke all on function internal_tenant_360(uuid) from public, anon;
grant execute on function internal_tenant_360(uuid) to authenticated;

comment on function internal_tenant_360(uuid) is
  'Panel interno (ADR-084): ficha 360 del negocio con agregados, módulos efectivos, errores recientes y actividad. Sólo bajo internal_scope().';
