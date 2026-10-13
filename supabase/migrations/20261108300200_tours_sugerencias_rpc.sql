-- =============================================================================
-- 20261108300200_tours_sugerencias_rpc  (ADR-089 · F15 · H70, H74)
--
-- Negocio (miembro activo del negocio activo, con la feature):
--   * tours_for_me()            versiones publicadas que le tocan (audiencia o
--                               asignación correctiva) + estado del usuario.
--   * nudge_next(evento, sesión, ruta)  la mejor sugerencia vigente respetando
--                               cooldown, máximo de impresiones, expiración y
--                               el límite por sesión y por día; registra `shown`.
--
-- Staff (internal_scope(); escribir no lo hace soporte; todo auditado con
-- tenant_id null porque es configuración de plataforma):
--   * internal_tour_save / internal_tour_publish / internal_tour_set_status
--   * internal_tour_metrics(tour)  inicio, finalización, abandono por paso y
--                                  conversión a primera venta.
--   * internal_nudge_save / internal_nudge_set_status / internal_nudge_settings_save
--   * internal_nudge_metrics()
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Negocio
-- -----------------------------------------------------------------------------
create or replace function tours_for_me()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_user   uuid := auth.uid();
  v_role   text;
  v_out    jsonb;
begin
  if v_tenant is null or v_user is null then
    return '[]'::jsonb;
  end if;
  select tu.role into v_role
    from tenant_users tu
   where tu.tenant_id = v_tenant and tu.user_id = v_user and tu.status = 'active'
   limit 1;
  -- Staff mirando un negocio sin membresía: sin recorridos.
  if v_role is null or not tenant_has_feature_for(v_tenant, 'tours') then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(x.j order by x.assigned desc, x.priority desc, x.key), '[]'::jsonb)
    into v_out
    from (
      select a.id is not null as assigned,
             v.priority,
             t.key,
             jsonb_build_object(
               'tour_id', t.id,
               'key', t.key,
               'version', v.version,
               'title', v.title,
               'description', v.description,
               'trigger_event', v.trigger_event,
               'priority', v.priority,
               'steps', v.steps,
               'assigned', a.id is not null,
               'trigger_active', onboarding_event_active(v_tenant, v_user, v.trigger_event),
               'completed', exists (
                 select 1 from onboarding_tour_events e
                  where e.tenant_id = v_tenant and e.user_id = v_user and e.tour_id = t.id
                    and e.event = 'complete'),
               'dismissed', exists (
                 select 1 from onboarding_tour_events e
                  where e.tenant_id = v_tenant and e.user_id = v_user and e.tour_id = t.id
                    and e.event = 'dismiss')
             ) as j
        from onboarding_tours t
        join onboarding_tour_versions v on v.tour_id = t.id and v.version = t.published_version
        left join lateral (
          select oa.id
            from onboarding_assignments oa
           where oa.tenant_id = v_tenant and oa.kind = 'tour' and oa.tour_id = t.id
             and oa.consumed_at is null and oa.cancelled_at is null and oa.expires_at > now()
             and (oa.target_role is null or oa.target_role = v_role)
           order by oa.created_at desc
           limit 1
        ) a on true
       where t.status = 'published'
         and (a.id is not null or onboarding_audience_match(v_tenant, v_role, v.audience))
    ) x;
  return v_out;
end;
$$;

revoke all on function tours_for_me() from public, anon;
grant execute on function tours_for_me() to authenticated;

create or replace function nudge_next(
  p_event   text default null,
  p_session text default null,
  p_route   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_user    uuid := auth.uid();
  v_role    text;
  v_cfg     onboarding_nudge_settings%rowtype;
  v_day0    timestamptz;
  v_event   text;
  r         record;
begin
  if v_tenant is null or v_user is null then
    return null;
  end if;
  select tu.role into v_role
    from tenant_users tu
   where tu.tenant_id = v_tenant and tu.user_id = v_user and tu.status = 'active'
   limit 1;
  if v_role is null or not tenant_has_feature_for(v_tenant, 'sugerencias') then
    return null;
  end if;
  if p_session is not null and p_session !~ '^[A-Za-z0-9-]{8,64}$' then
    raise exception 'invalid_session';
  end if;
  -- Del cliente sólo vale un evento puntual (no un estado del negocio).
  v_event := case when p_event = 'venta_fallida' then p_event end;

  select * into v_cfg from onboarding_nudge_settings where id;
  if not found then
    v_cfg.per_session := 1;
    v_cfg.per_day := 3;
  end if;

  -- "No molestar": tope por día (calendario de Buenos Aires) y por sesión.
  v_day0 := date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires')
            at time zone 'America/Argentina/Buenos_Aires';
  if (select count(*) from onboarding_nudge_events e
       where e.tenant_id = v_tenant and e.user_id = v_user and e.event = 'shown'
         and e.created_at >= v_day0) >= v_cfg.per_day then
    return null;
  end if;
  if p_session is not null and (
       select count(*) from onboarding_nudge_events e
        where e.tenant_id = v_tenant and e.user_id = v_user and e.event = 'shown'
          and e.session_id = p_session) >= v_cfg.per_session then
    return null;
  end if;

  select n.*, a.id as assignment_id
    into r
    from onboarding_nudges n
    left join lateral (
      select oa.id
        from onboarding_assignments oa
       where oa.tenant_id = v_tenant and oa.kind = 'nudge' and oa.nudge_id = n.id
         and oa.consumed_at is null and oa.cancelled_at is null and oa.expires_at > now()
         and (oa.target_role is null or oa.target_role = v_role)
       order by oa.created_at desc
       limit 1
    ) a on true
   where n.status = 'published'
     and (n.starts_at is null or n.starts_at <= now())
     and (n.expires_at is null or n.expires_at > now())
     and (
       a.id is not null
       or (
         onboarding_audience_match(v_tenant, v_role, n.audience)
         and (n.event = v_event or onboarding_event_active(v_tenant, v_user, n.event))
         and not exists (
           select 1 from onboarding_nudge_events e
            where e.tenant_id = v_tenant and e.user_id = v_user and e.nudge_id = n.id
              and e.event = 'dismissed')
         and (select count(*) from onboarding_nudge_events e
               where e.tenant_id = v_tenant and e.user_id = v_user and e.nudge_id = n.id
                 and e.event = 'shown') < n.max_impressions
       )
     )
     and not exists (
       select 1 from onboarding_nudge_events e
        where e.tenant_id = v_tenant and e.user_id = v_user and e.nudge_id = n.id
          and e.event = 'shown'
          and e.created_at > now() - make_interval(hours => n.cooldown_hours))
   order by (a.id is not null) desc, n.priority desc, n.created_at
   limit 1;

  if not found then
    return null;
  end if;

  perform set_config('ninja.nudge_server', '1', true);
  insert into onboarding_nudge_events (tenant_id, user_id, nudge_id, nudge_version, event, session_id, route)
  values (v_tenant, v_user, r.id, r.version, 'shown', p_session, left(p_route, 200));
  perform set_config('ninja.nudge_server', '', true);

  return jsonb_build_object(
    'nudge_id', r.id,
    'key', r.key,
    'version', r.version,
    'title', r.title,
    'body', r.body,
    'event', r.event,
    'cta_label', r.cta_label,
    'cta_href', r.cta_href,
    'support_fallback', r.support_fallback,
    'assigned', r.assignment_id is not null
  );
end;
$$;

revoke all on function nudge_next(text, text, text) from public, anon;
grant execute on function nudge_next(text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Staff: guardas
-- -----------------------------------------------------------------------------
create or replace function onboarding_assert_editor()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not internal_scope() or coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;
revoke all on function onboarding_assert_editor() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Staff: tours
-- -----------------------------------------------------------------------------
create or replace function internal_tour_save(
  p_id          uuid,
  p_key         text,
  p_title       text,
  p_description text,
  p_trigger     text,
  p_audience    jsonb,
  p_priority    integer,
  p_steps       jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old onboarding_tours%rowtype;
  v_id  uuid;
begin
  perform onboarding_assert_editor();
  if not onboarding_steps_valid(p_steps) then raise exception 'invalid_steps'; end if;
  if not onboarding_audience_valid(coalesce(p_audience, '{}'::jsonb)) then raise exception 'invalid_audience'; end if;
  if coalesce(btrim(p_title), '') = '' or position('—' in p_title || coalesce(p_description, '')) > 0 then
    raise exception 'invalid_title';
  end if;

  if p_id is null then
    insert into onboarding_tours (key, title, description, trigger_event, audience, priority, steps,
                                  created_by, updated_by)
    values (p_key, btrim(p_title), nullif(btrim(p_description), ''), coalesce(p_trigger, 'manual'),
            coalesce(p_audience, '{}'::jsonb), coalesce(p_priority, 50), p_steps, auth.uid(), auth.uid())
    returning id into v_id;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (null, auth.uid(), 'onboarding_tours', v_id, 'onboarding_tour_created',
            jsonb_build_object('key', p_key, 'title', btrim(p_title), 'trigger', p_trigger,
                               'steps', jsonb_array_length(p_steps)));
    return v_id;
  end if;

  select * into v_old from onboarding_tours where id = p_id for update;
  if not found then raise exception 'tour_not_found'; end if;
  if v_old.status = 'archived' then raise exception 'tour_archived'; end if;
  if p_key is distinct from v_old.key and v_old.published_version is not null then
    raise exception 'key_locked';
  end if;

  update onboarding_tours
     set key = p_key,
         title = btrim(p_title),
         description = nullif(btrim(p_description), ''),
         trigger_event = coalesce(p_trigger, 'manual'),
         audience = coalesce(p_audience, '{}'::jsonb),
         priority = coalesce(p_priority, 50),
         steps = p_steps,
         draft_updated_at = now(),
         updated_by = auth.uid(),
         updated_at = now()
   where id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (null, auth.uid(), 'onboarding_tours', p_id, 'onboarding_tour_saved',
          jsonb_build_object('key', v_old.key, 'title', v_old.title, 'trigger', v_old.trigger_event,
                             'audience', v_old.audience, 'priority', v_old.priority, 'steps', v_old.steps),
          jsonb_build_object('key', p_key, 'title', btrim(p_title), 'trigger', p_trigger,
                             'audience', p_audience, 'priority', p_priority, 'steps', p_steps));
  return p_id;
end;
$$;

create or replace function internal_tour_publish(p_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t onboarding_tours%rowtype;
  v integer;
begin
  perform onboarding_assert_editor();
  select * into t from onboarding_tours where id = p_id for update;
  if not found then raise exception 'tour_not_found'; end if;
  if t.status = 'archived' then raise exception 'tour_archived'; end if;
  if t.published_version is not null and t.published_at is not null
     and t.draft_updated_at <= t.published_at then
    raise exception 'nothing_to_publish';
  end if;
  v := coalesce(t.published_version, 0) + 1;
  insert into onboarding_tour_versions (tour_id, version, title, description, trigger_event, audience,
                                        priority, steps, published_by)
  values (t.id, v, t.title, t.description, t.trigger_event, t.audience, t.priority, t.steps, auth.uid());
  update onboarding_tours
     set status = 'published', published_version = v, published_at = now(),
         updated_by = auth.uid(), updated_at = now()
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (null, auth.uid(), 'onboarding_tours', p_id, 'onboarding_tour_published',
          jsonb_build_object('key', t.key, 'version', v));
  return v;
end;
$$;

create or replace function internal_tour_set_status(p_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t onboarding_tours%rowtype;
begin
  perform onboarding_assert_editor();
  if p_status not in ('published', 'paused', 'archived') then raise exception 'invalid_status'; end if;
  select * into t from onboarding_tours where id = p_id for update;
  if not found then raise exception 'tour_not_found'; end if;
  if p_status = 'published' and t.published_version is null then raise exception 'never_published'; end if;
  if t.status = 'archived' then raise exception 'tour_archived'; end if;
  update onboarding_tours set status = p_status, updated_by = auth.uid(), updated_at = now() where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (null, auth.uid(), 'onboarding_tours', p_id, 'onboarding_tour_status',
          jsonb_build_object('status', t.status), jsonb_build_object('status', p_status, 'key', t.key),
          nullif(btrim(p_reason), ''));
end;
$$;

-- Métricas: un "run" es un inicio. Abandono por paso = runs sin completar
-- cuyo último paso visto fue ese. Conversión: negocios que vendieron por
-- primera vez después de iniciar el recorrido.
create or replace function internal_tour_metrics(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_versions jsonb;
  v_steps    jsonb;
  v_tenants  integer;
  v_conv     integer;
begin
  if not internal_scope() then raise exception 'forbidden' using errcode = '42501'; end if;

  with runs as (
    select e.run_id, e.tour_version,
           bool_or(e.event = 'complete') as completed,
           bool_or(e.event = 'dismiss') as dismissed
      from onboarding_tour_events e
     where e.tour_id = p_id
     group by e.run_id, e.tour_version
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'version', r.tour_version,
           'starts', r.starts,
           'completed', r.completed,
           'dismissed', r.dismissed,
           'completion_rate', case when r.starts > 0 then round(r.completed::numeric / r.starts, 4) end
         ) order by r.tour_version), '[]'::jsonb)
    into v_versions
    from (
      select tour_version, count(*) as starts,
             count(*) filter (where completed) as completed,
             count(*) filter (where dismissed and not completed) as dismissed
        from runs group by tour_version
    ) r;

  with runs as (
    select e.run_id, e.tour_version,
           bool_or(e.event = 'complete') as completed,
           max(e.step_index) filter (where e.event in ('step_view', 'step_done')) as last_step
      from onboarding_tour_events e
     where e.tour_id = p_id
     group by e.run_id, e.tour_version
  ),
  views as (
    select e.tour_version, e.step_index, max(e.step_id) as step_id, count(distinct e.run_id) as views
      from onboarding_tour_events e
     where e.tour_id = p_id and e.event = 'step_view'
     group by e.tour_version, e.step_index
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'version', s.tour_version, 'step_index', s.step_index, 'step_id', s.step_id,
           'views', s.views,
           'abandoned', (select count(*) from runs r
                          where r.tour_version = s.tour_version and not r.completed
                            and r.last_step = s.step_index)
         ) order by s.tour_version, s.step_index), '[]'::jsonb)
    into v_steps
    from views s;

  select count(distinct e.tenant_id) into v_tenants
    from onboarding_tour_events e
   where e.tour_id = p_id and e.event = 'start';

  select count(*) into v_conv
    from (
      select e.tenant_id, min(e.created_at) as first_start
        from onboarding_tour_events e
       where e.tour_id = p_id and e.event = 'start'
       group by e.tenant_id
    ) f
   where not exists (
           select 1 from sales s
            where s.tenant_id = f.tenant_id and s.status = 'completed' and s.created_at < f.first_start)
     and exists (
           select 1 from sales s
            where s.tenant_id = f.tenant_id and s.status = 'completed' and s.created_at >= f.first_start);

  return jsonb_build_object(
    'versions', v_versions,
    'steps', v_steps,
    'tenants_reached', v_tenants,
    'tenants_first_sale_after', v_conv
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Staff: sugerencias
-- -----------------------------------------------------------------------------
create or replace function internal_nudge_save(
  p_id               uuid,
  p_key              text,
  p_title            text,
  p_body             text,
  p_event            text,
  p_audience         jsonb,
  p_priority         integer,
  p_cooldown_hours   integer,
  p_max_impressions  integer,
  p_starts_at        timestamptz,
  p_expires_at       timestamptz,
  p_cta_label        text,
  p_cta_href         text,
  p_support_fallback boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old onboarding_nudges%rowtype;
  v_id  uuid;
begin
  perform onboarding_assert_editor();
  if not onboarding_audience_valid(coalesce(p_audience, '{}'::jsonb)) then raise exception 'invalid_audience'; end if;

  if p_id is null then
    insert into onboarding_nudges (key, title, body, event, audience, priority, cooldown_hours,
                                   max_impressions, starts_at, expires_at, cta_label, cta_href,
                                   support_fallback, created_by, updated_by)
    values (p_key, btrim(p_title), nullif(btrim(p_body), ''), p_event, coalesce(p_audience, '{}'::jsonb),
            coalesce(p_priority, 50), coalesce(p_cooldown_hours, 24), coalesce(p_max_impressions, 3),
            p_starts_at, p_expires_at, nullif(btrim(p_cta_label), ''), nullif(btrim(p_cta_href), ''),
            coalesce(p_support_fallback, false), auth.uid(), auth.uid())
    returning id into v_id;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (null, auth.uid(), 'onboarding_nudges', v_id, 'onboarding_nudge_created',
            jsonb_build_object('key', p_key, 'title', btrim(p_title), 'event', p_event));
    return v_id;
  end if;

  select * into v_old from onboarding_nudges where id = p_id for update;
  if not found then raise exception 'nudge_not_found'; end if;
  if v_old.status = 'archived' then raise exception 'nudge_archived'; end if;
  if p_key is distinct from v_old.key and v_old.published_at is not null then
    raise exception 'key_locked';
  end if;

  -- Editar una sugerencia publicada es una versión nueva (las métricas la
  -- separan); el cooldown y el máximo de impresiones siguen por sugerencia.
  update onboarding_nudges
     set key = p_key,
         title = btrim(p_title),
         body = nullif(btrim(p_body), ''),
         event = p_event,
         audience = coalesce(p_audience, '{}'::jsonb),
         priority = coalesce(p_priority, 50),
         cooldown_hours = coalesce(p_cooldown_hours, 24),
         max_impressions = coalesce(p_max_impressions, 3),
         starts_at = p_starts_at,
         expires_at = p_expires_at,
         cta_label = nullif(btrim(p_cta_label), ''),
         cta_href = nullif(btrim(p_cta_href), ''),
         support_fallback = coalesce(p_support_fallback, false),
         version = case when v_old.status in ('published', 'paused') then v_old.version + 1 else v_old.version end,
         updated_by = auth.uid(),
         updated_at = now()
   where id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (null, auth.uid(), 'onboarding_nudges', p_id, 'onboarding_nudge_saved',
          to_jsonb(v_old) - 'created_by' - 'updated_by',
          jsonb_build_object('key', p_key, 'title', btrim(p_title), 'body', p_body, 'event', p_event,
                             'audience', p_audience, 'priority', p_priority,
                             'cooldown_hours', p_cooldown_hours, 'max_impressions', p_max_impressions,
                             'starts_at', p_starts_at, 'expires_at', p_expires_at,
                             'cta_label', p_cta_label, 'cta_href', p_cta_href));
  return p_id;
end;
$$;

create or replace function internal_nudge_set_status(p_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n onboarding_nudges%rowtype;
begin
  perform onboarding_assert_editor();
  if p_status not in ('published', 'paused', 'archived') then raise exception 'invalid_status'; end if;
  select * into n from onboarding_nudges where id = p_id for update;
  if not found then raise exception 'nudge_not_found'; end if;
  if n.status = 'archived' then raise exception 'nudge_archived'; end if;
  update onboarding_nudges
     set status = p_status,
         published_at = case when p_status = 'published' then coalesce(published_at, now()) else published_at end,
         updated_by = auth.uid(),
         updated_at = now()
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (null, auth.uid(), 'onboarding_nudges', p_id, 'onboarding_nudge_status',
          jsonb_build_object('status', n.status), jsonb_build_object('status', p_status, 'key', n.key),
          nullif(btrim(p_reason), ''));
end;
$$;

create or replace function internal_nudge_settings_save(p_per_session integer, p_per_day integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o onboarding_nudge_settings%rowtype;
begin
  perform onboarding_assert_editor();
  if p_per_session is null or p_per_day is null or p_per_session > p_per_day then
    raise exception 'invalid_limits';
  end if;
  select * into o from onboarding_nudge_settings where id for update;
  insert into onboarding_nudge_settings (id, per_session, per_day, updated_by, updated_at)
  values (true, p_per_session, p_per_day, auth.uid(), now())
  on conflict (id) do update
    set per_session = excluded.per_session, per_day = excluded.per_day,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (null, auth.uid(), 'onboarding_nudge_settings', null, 'onboarding_nudge_limits',
          jsonb_build_object('per_session', o.per_session, 'per_day', o.per_day),
          jsonb_build_object('per_session', p_per_session, 'per_day', p_per_day));
end;
$$;

create or replace function internal_nudge_metrics()
returns table (
  nudge_id                 uuid,
  shown                    integer,
  clicked                  integer,
  dismissed                integer,
  users_reached            integer,
  tenants_reached          integer,
  tenants_first_sale_after integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not internal_scope() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select n.id,
         (select count(*)::int from onboarding_nudge_events e where e.nudge_id = n.id and e.event = 'shown'),
         (select count(*)::int from onboarding_nudge_events e where e.nudge_id = n.id and e.event = 'clicked'),
         (select count(*)::int from onboarding_nudge_events e where e.nudge_id = n.id and e.event = 'dismissed'),
         (select count(distinct e.user_id)::int from onboarding_nudge_events e where e.nudge_id = n.id),
         (select count(distinct e.tenant_id)::int from onboarding_nudge_events e where e.nudge_id = n.id),
         (select count(*)::int
            from (select e.tenant_id, min(e.created_at) as first_seen
                    from onboarding_nudge_events e
                   where e.nudge_id = n.id and e.event = 'shown'
                   group by e.tenant_id) f
           where not exists (select 1 from sales s where s.tenant_id = f.tenant_id
                               and s.status = 'completed' and s.created_at < f.first_seen)
             and exists (select 1 from sales s where s.tenant_id = f.tenant_id
                           and s.status = 'completed' and s.created_at >= f.first_seen))
    from onboarding_nudges n;
end;
$$;

revoke all on function internal_tour_save(uuid, text, text, text, text, jsonb, integer, jsonb) from public, anon;
revoke all on function internal_tour_publish(uuid) from public, anon;
revoke all on function internal_tour_set_status(uuid, text, text) from public, anon;
revoke all on function internal_tour_metrics(uuid) from public, anon;
revoke all on function internal_nudge_save(uuid, text, text, text, text, jsonb, integer, integer, integer, timestamptz, timestamptz, text, text, boolean) from public, anon;
revoke all on function internal_nudge_set_status(uuid, text, text) from public, anon;
revoke all on function internal_nudge_settings_save(integer, integer) from public, anon;
revoke all on function internal_nudge_metrics() from public, anon;

grant execute on function internal_tour_save(uuid, text, text, text, text, jsonb, integer, jsonb) to authenticated;
grant execute on function internal_tour_publish(uuid) to authenticated;
grant execute on function internal_tour_set_status(uuid, text, text) to authenticated;
grant execute on function internal_tour_metrics(uuid) to authenticated;
grant execute on function internal_nudge_save(uuid, text, text, text, text, jsonb, integer, integer, integer, timestamptz, timestamptz, text, text, boolean) to authenticated;
grant execute on function internal_nudge_set_status(uuid, text, text) to authenticated;
grant execute on function internal_nudge_settings_save(integer, integer) to authenticated;
grant execute on function internal_nudge_metrics() to authenticated;
