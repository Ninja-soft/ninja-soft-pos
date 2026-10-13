-- =============================================================================
-- 20261107100300_anuncios_por_segmento  (F7 · H13b · ADR-084)
--
-- Anuncios in-app a un SEGMENTO de negocios desde /internal/notificaciones:
-- por plan (familia: start, pro, business, enterprise; los planes a medida
-- cuentan por su plan base), estado de la suscripción, rubro y rango de fecha
-- de alta. Los negocios dados de baja nunca entran.
--
--   A) notifications suma segment_batch_id y segment (jsonb) para agrupar el
--      envío en el historial y saber a qué segmento se mandó.
--   B) internal_segment_tenants(segment): negocios que matchean (staff, bajo
--      internal_scope()). La usa el envío y el test; la UI previsualiza con la
--      misma regla en lib/internal/segments.ts.
--   C) internal_notify_segment(...): una notificación por negocio (target
--      tenant), mismo lote, y una fila de audit_logs por negocio alcanzado.
--      Soporte no envía. Un segmento vacío (sin criterios) se rechaza: para
--      todos los negocios está el envío broadcast. Tope de 5000 negocios.
--   D) internal_delete_notification_batch(batch): baja lógica del lote.
--
--   La RLS de notifications no cambia (cada fila es una notificación dirigida
--   a un negocio, como las de "Un negocio").
-- =============================================================================

alter table notifications add column if not exists segment_batch_id uuid;
alter table notifications add column if not exists segment jsonb;

create index if not exists idx_notifications_segment_batch
  on notifications (segment_batch_id) where segment_batch_id is not null;

-- -----------------------------------------------------------------------------
-- B) Negocios del segmento
-- -----------------------------------------------------------------------------
-- segment = { plans?: text[], statuses?: text[], industries?: text[],
--             created_from?: date, created_to?: date }
create or replace function internal_segment_tenants(p_segment jsonb)
returns table (tenant_id uuid, name text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_plans      text[];
  v_statuses   text[];
  v_industries text[];
  v_from       date;
  v_to         date;
begin
  if not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_segment is null or jsonb_typeof(p_segment) <> 'object' then
    raise exception 'invalid_segment';
  end if;

  select array_agg(x) into v_plans
    from jsonb_array_elements_text(coalesce(p_segment -> 'plans', '[]'::jsonb)) x;
  select array_agg(x) into v_statuses
    from jsonb_array_elements_text(coalesce(p_segment -> 'statuses', '[]'::jsonb)) x;
  select array_agg(x) into v_industries
    from jsonb_array_elements_text(coalesce(p_segment -> 'industries', '[]'::jsonb)) x;
  v_from := nullif(p_segment ->> 'created_from', '')::date;
  v_to   := nullif(p_segment ->> 'created_to', '')::date;

  if v_plans is null and v_statuses is null and v_industries is null
     and v_from is null and v_to is null then
    raise exception 'empty_segment';
  end if;

  return query
  select t.id, t.name::text
    from tenants t
    left join subscriptions s on s.tenant_id = t.id
    left join plans p on p.id = s.plan_id
   where t.deleted_at is null
     and (v_plans is null or coalesce(p.base_plan_key, p.key) = any (v_plans))
     and (v_statuses is null or coalesce(s.status, t.status) = any (v_statuses))
     and (v_industries is null or coalesce(t.industry, 'otro') = any (v_industries))
     and (v_from is null or t.created_at >= v_from)
     and (v_to is null or t.created_at < v_to + 1)
   order by t.name;
end;
$$;

revoke all on function internal_segment_tenants(jsonb) from public, anon;
grant execute on function internal_segment_tenants(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- C) Envío al segmento
-- -----------------------------------------------------------------------------
create or replace function internal_notify_segment(
  p_segment       jsonb,
  p_role          text,
  p_type          text,
  p_severity      text,
  p_title         text,
  p_body          text default null,
  p_action_label  text default null,
  p_action_url    text default null,
  p_requires_ack  boolean default false,
  p_expires_at    timestamptz default null,
  p_display_until timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch uuid := gen_random_uuid();
  v_n     integer := 0;
  v_id    uuid;
  r       record;
begin
  if not internal_scope() or coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(btrim(p_title), '') = '' then
    raise exception 'invalid_title';
  end if;
  if p_role is not null and p_role not in ('owner', 'manager', 'cashier', 'viewer') then
    raise exception 'invalid_role';
  end if;
  if (p_action_label is null) <> (p_action_url is null)
     or (p_action_url is not null and p_action_url !~* '^https?://') then
    raise exception 'invalid_action';
  end if;
  if (select count(*) from internal_segment_tenants(p_segment)) > 5000 then
    raise exception 'segment_too_large';
  end if;

  for r in select * from internal_segment_tenants(p_segment) loop
    insert into notifications (target_tenant_id, target_role, target_user_id, type, severity,
                               title, body, action_label, action_url, requires_ack,
                               expires_at, display_until, created_by,
                               segment_batch_id, segment)
    values (r.tenant_id, p_role, null, coalesce(p_type, 'news'), coalesce(p_severity, 'info'),
            btrim(p_title), p_body, p_action_label, p_action_url, coalesce(p_requires_ack, false),
            p_expires_at, p_display_until, auth.uid(), v_batch, p_segment)
    returning id into v_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (r.tenant_id, auth.uid(), 'notifications', v_id, 'notification_sent',
            jsonb_build_object('title', btrim(p_title), 'severity', coalesce(p_severity, 'info'),
                               'role', p_role, 'segment', p_segment, 'batch', v_batch));
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('batch_id', v_batch, 'sent', v_n);
end;
$$;

revoke all on function internal_notify_segment(jsonb, text, text, text, text, text, text, text, boolean, timestamptz, timestamptz) from public, anon;
grant execute on function internal_notify_segment(jsonb, text, text, text, text, text, text, text, boolean, timestamptz, timestamptz) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Baja lógica del lote
-- -----------------------------------------------------------------------------
create or replace function internal_delete_notification_batch(p_batch uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer := 0;
  r   record;
begin
  if not internal_scope() or coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  for r in
    update notifications set deleted_at = now()
     where segment_batch_id = p_batch and deleted_at is null
    returning id, target_tenant_id, title, severity
  loop
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
    values (r.target_tenant_id, auth.uid(), 'notifications', r.id, 'notification_deleted',
            jsonb_build_object('title', r.title, 'severity', r.severity, 'batch', p_batch));
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then
    raise exception 'notification_not_found';
  end if;
  return v_n;
end;
$$;

revoke all on function internal_delete_notification_batch(uuid) from public, anon;
grant execute on function internal_delete_notification_batch(uuid) to authenticated;
