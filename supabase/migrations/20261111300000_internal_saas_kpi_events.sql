-- =============================================================================
-- 20261111200000_internal_saas_kpi_events  (F20-0a · H125 · ADR-110)
--
-- Insumos del dashboard interno con KPIs corregidos (spec docs/40 §15).
-- Hasta que existan los snapshots de MRR (F20-2), el churn y la base "paga al
-- inicio del período" se reconstruyen desde la auditoría de subscriptions
-- (trigger write_audit_log: action 'UPDATE' con before_data/after_data), no
-- desde subscriptions.updated_at, que se mueve con cualquier UPDATE.
--
-- internal_saas_kpi_events(p_since) devuelve sólo lo necesario (nunca los
-- jsonb completos de la auditoría):
--   · status_changes: cambios de subscriptions.status desde p_since
--     (tenant, suscripción, fecha, estado anterior y nuevo);
--   · rejected_debits: débitos recurrentes de Mercado Pago rechazados desde
--     p_since (mp_billing_webhook audita 'subscription_webhook' con ap_status).
-- Guard (select internal_scope()) (ADR-052): fuera del panel interno, forbidden.
-- Ventana máxima: 400 días.
--
-- Índice parcial sobre audit_logs para no recorrer toda la auditoría (ventas,
-- caja, etc.) al buscar las filas de subscriptions por fecha.
--
-- Aditiva. NO aplicada todavía.
-- =============================================================================

create index if not exists audit_logs_subscriptions_created_idx
  on audit_logs (created_at desc)
  where entity_type = 'subscriptions';

create or replace function internal_saas_kpi_events(p_since timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_since timestamptz;
begin
  if not (select internal_scope()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_since := greatest(coalesce(p_since, now() - interval '400 days'), now() - interval '400 days');

  return jsonb_build_object(
    'status_changes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tenant_id', a.tenant_id,
               'subscription_id', a.entity_id,
               'at', a.created_at,
               'from', a.before_data ->> 'status',
               'to', a.after_data ->> 'status')
             order by a.created_at)
        from audit_logs a
       where a.entity_type = 'subscriptions'
         and a.created_at >= v_since
         and a.action = 'UPDATE'
         and a.tenant_id is not null
         and (a.before_data ->> 'status') is distinct from (a.after_data ->> 'status')
    ), '[]'::jsonb),
    'rejected_debits', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tenant_id', a.tenant_id,
               'at', a.created_at)
             order by a.created_at)
        from audit_logs a
       where a.entity_type = 'subscriptions'
         and a.created_at >= v_since
         and a.action = 'subscription_webhook'
         and a.tenant_id is not null
         and (a.after_data ->> 'ap_status') = 'rejected'
    ), '[]'::jsonb)
  );
end;
$$;

comment on function internal_saas_kpi_events(timestamptz) is
  'F20-0a: cambios de estado de suscripciones y débitos MP rechazados desde la auditoría, para los KPIs del panel interno. Sólo staff bajo internal_scope().';

revoke execute on function internal_saas_kpi_events(timestamptz) from public;
revoke execute on function internal_saas_kpi_events(timestamptz) from anon;
grant execute on function internal_saas_kpi_events(timestamptz) to authenticated;
