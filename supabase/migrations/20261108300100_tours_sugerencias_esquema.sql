-- =============================================================================
-- 20261108300100_tours_sugerencias_esquema  (ADR-089 · F15 · H70, H74, H71)
--
-- Configuración de plataforma (sin tenant_id, la edita el staff desde
-- /internal/onboarding sin deploy) y métricas por negocio y usuario.
--
--  A) Validadores puros: onboarding_steps_valid, onboarding_audience_valid
--     (espejo en lib/onboarding/schema.ts; un test compara los dos).
--  B) onboarding_tours (borrador editable) + onboarding_tour_versions (foto
--     inmutable de cada publicación). Los negocios ven SÓLO la versión
--     publicada, y nunca por PostgREST: por la RPC tours_for_me (0200).
--  C) onboarding_nudges + onboarding_nudge_settings (límite por sesión y día).
--  D) onboarding_assignments: tour o sugerencia correctiva que el staff le
--     dispara a un negocio (H71). Se consume al completar o descartar.
--  E) onboarding_tour_events / onboarding_nudge_events: métricas de inicio,
--     paso, fin y abandono. tenant_id + user_id del que mira; el insert es
--     multi-fila por PostgREST (RLS) y un trigger valida tour, versión, paso y
--     feature de plan.
--  F) Helpers SECURITY DEFINER sin grant a clientes: onboarding_audience_match
--     (plan, estado, rubro, rol, features, antigüedad) y onboarding_event_active
--     (registro, primer ingreso, sin productos, sin caja abierta, sin primera
--     venta, trial por vencer).
--
-- RLS: la configuración se lee sólo con (select internal_scope()); nadie la
-- escribe por PostgREST (todo por RPC auditada). Los eventos: cada usuario ve
-- los suyos del negocio activo, el staff los lee con internal_scope().
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Validadores
-- -----------------------------------------------------------------------------
create or replace function onboarding_steps_valid(p_steps jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  s   jsonb;
  ids text[] := '{}';
  v_place text;
  v_anchor text;
begin
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then return false; end if;
  if jsonb_array_length(p_steps) < 1 or jsonb_array_length(p_steps) > 20 then return false; end if;
  for s in select value from jsonb_array_elements(p_steps) loop
    if jsonb_typeof(s) <> 'object' then return false; end if;
    if coalesce(s ->> 'id', '') !~ '^[a-z0-9][a-z0-9-]{0,39}$' then return false; end if;
    if (s ->> 'id') = any (ids) then return false; end if;
    ids := ids || (s ->> 'id');
    if char_length(coalesce(s ->> 'title', '')) not between 2 and 80 then return false; end if;
    if char_length(coalesce(s ->> 'body', '')) > 400 then return false; end if;
    if position('—' in coalesce(s ->> 'title', '') || coalesce(s ->> 'body', '')) > 0 then return false; end if;
    v_place := coalesce(s ->> 'placement', 'tooltip');
    if v_place not in ('tooltip', 'spotlight', 'modal') then return false; end if;
    v_anchor := nullif(s ->> 'anchor', '');
    if v_anchor is not null and v_anchor !~ '^[a-z0-9][a-z0-9-]{1,59}$' then return false; end if;
    if v_place <> 'modal' and v_anchor is null then return false; end if;
    if nullif(s ->> 'route', '') is not null and (s ->> 'route') !~ '^/[a-z0-9/_-]*$' then return false; end if;
    if coalesce(s ->> 'advance', 'next') not in ('next', 'click') then return false; end if;
    if coalesce(s ->> 'advance', 'next') = 'click' and v_anchor is null then return false; end if;
    if s ? 'block' and jsonb_typeof(s -> 'block') <> 'boolean' then return false; end if;
    if s ? 'action' and jsonb_typeof(s -> 'action') <> 'null' then
      if jsonb_typeof(s -> 'action') <> 'object' then return false; end if;
      if char_length(coalesce(s -> 'action' ->> 'label', '')) not between 2 and 40 then return false; end if;
      -- Sólo rutas internas: nada de URLs externas en un recorrido.
      if coalesce(s -> 'action' ->> 'href', '') !~ '^/[a-z0-9/_?=&.-]*$' then return false; end if;
    end if;
  end loop;
  return true;
end;
$$;

create or replace function onboarding_audience_valid(p_audience jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  k text;
begin
  if p_audience is null or jsonb_typeof(p_audience) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(p_audience) loop
    if k not in ('plans', 'statuses', 'industries', 'roles', 'features', 'min_days', 'max_days') then
      return false;
    end if;
    if k in ('min_days', 'max_days') then
      if jsonb_typeof(p_audience -> k) <> 'number' then return false; end if;
      if (p_audience ->> k)::numeric not between 0 and 3650 then return false; end if;
    else
      if jsonb_typeof(p_audience -> k) <> 'array' then return false; end if;
      if jsonb_array_length(p_audience -> k) > 50 then return false; end if;
      if exists (
        select 1 from jsonb_array_elements(p_audience -> k) e(x)
         where jsonb_typeof(e.x) <> 'string' or char_length(e.x #>> '{}') not between 1 and 60
      ) then
        return false;
      end if;
    end if;
  end loop;
  if p_audience ? 'roles' and exists (
    select 1 from jsonb_array_elements_text(p_audience -> 'roles') r
     where r not in ('owner', 'manager', 'cashier', 'viewer')
  ) then
    return false;
  end if;
  if p_audience ? 'min_days' and p_audience ? 'max_days'
     and (p_audience ->> 'min_days')::numeric > (p_audience ->> 'max_days')::numeric then
    return false;
  end if;
  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- B) Tours
-- -----------------------------------------------------------------------------
-- Eventos que disparan un tour o una sugerencia. `venta_fallida` sólo llega
-- desde el cliente (no es un estado del negocio); `manual` sólo se inicia a
-- mano o por una asignación correctiva.
create table if not exists onboarding_tours (
  id                uuid primary key default gen_random_uuid(),
  key               text not null unique check (key ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  title             text not null check (char_length(title) between 3 and 120),
  description       text check (description is null or char_length(description) <= 500),
  status            text not null default 'draft'
                    check (status in ('draft', 'published', 'paused', 'archived')),
  trigger_event     text not null default 'manual'
                    check (trigger_event in ('registro', 'primer_login', 'sin_productos', 'sin_caja_abierta',
                                             'sin_primera_venta', 'trial_por_vencer', 'venta_fallida', 'manual')),
  audience          jsonb not null default '{}'::jsonb check (onboarding_audience_valid(audience)),
  priority          integer not null default 50 check (priority between 0 and 100),
  steps             jsonb not null check (onboarding_steps_valid(steps)),
  published_version integer check (published_version is null or published_version >= 1),
  published_at      timestamptz,
  draft_updated_at  timestamptz not null default now(),
  created_by        uuid,
  updated_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (status <> 'published' or published_version is not null)
);

create table if not exists onboarding_tour_versions (
  tour_id       uuid not null references onboarding_tours(id) on delete cascade,
  version       integer not null check (version >= 1),
  title         text not null,
  description   text,
  trigger_event text not null,
  audience      jsonb not null,
  priority      integer not null,
  steps         jsonb not null check (onboarding_steps_valid(steps)),
  published_at  timestamptz not null default now(),
  published_by  uuid,
  primary key (tour_id, version)
);

-- -----------------------------------------------------------------------------
-- C) Sugerencias (nudges)
-- -----------------------------------------------------------------------------
create table if not exists onboarding_nudges (
  id               uuid primary key default gen_random_uuid(),
  key              text not null unique check (key ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  title            text not null check (char_length(title) between 3 and 80 and position('—' in title) = 0),
  body             text check (body is null or (char_length(body) <= 300 and position('—' in body) = 0)),
  event            text not null
                   check (event in ('registro', 'primer_login', 'sin_productos', 'sin_caja_abierta',
                                    'sin_primera_venta', 'trial_por_vencer', 'venta_fallida', 'manual')),
  audience         jsonb not null default '{}'::jsonb check (onboarding_audience_valid(audience)),
  priority         integer not null default 50 check (priority between 0 and 100),
  cooldown_hours   integer not null default 24 check (cooldown_hours between 1 and 720),
  max_impressions  integer not null default 3 check (max_impressions between 1 and 50),
  starts_at        timestamptz,
  expires_at       timestamptz,
  -- CTA: ruta interna o "tour:<key>" (abre ese recorrido).
  cta_label        text check (cta_label is null or char_length(cta_label) between 2 and 40),
  cta_href         text check (cta_href is null or cta_href ~ '^/[a-z0-9/_?=&.-]*$' or cta_href ~ '^tour:[a-z0-9][a-z0-9-]{1,59}$'),
  support_fallback boolean not null default false,
  status           text not null default 'draft'
                   check (status in ('draft', 'published', 'paused', 'archived')),
  version          integer not null default 1 check (version >= 1),
  published_at     timestamptz,
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check ((cta_label is null) = (cta_href is null)),
  check (expires_at is null or starts_at is null or expires_at > starts_at)
);

-- Una sola fila: "no molestar" de toda la plataforma.
create table if not exists onboarding_nudge_settings (
  id          boolean primary key default true check (id),
  per_session integer not null default 1 check (per_session between 1 and 10),
  per_day     integer not null default 3 check (per_day between 1 and 20),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
insert into onboarding_nudge_settings (id) values (true) on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- D) Asignaciones correctivas (H71)
-- -----------------------------------------------------------------------------
create table if not exists onboarding_assignments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  kind         text not null check (kind in ('tour', 'nudge')),
  tour_id      uuid references onboarding_tours(id) on delete cascade,
  nudge_id     uuid references onboarding_nudges(id) on delete cascade,
  target_role  text check (target_role is null or target_role in ('owner', 'manager', 'cashier', 'viewer')),
  reason       text not null check (char_length(btrim(reason)) between 5 and 500),
  created_by   uuid,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '14 days',
  consumed_at  timestamptz,
  consumed_by  uuid,
  cancelled_at timestamptz,
  check ((kind = 'tour') = (tour_id is not null)),
  check ((kind = 'nudge') = (nudge_id is not null))
);

create index if not exists onboarding_assignments_open_idx
  on onboarding_assignments (tenant_id)
  where consumed_at is null and cancelled_at is null;

-- -----------------------------------------------------------------------------
-- E) Eventos (métricas)
-- -----------------------------------------------------------------------------
create table if not exists onboarding_tour_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  user_id      uuid not null default auth.uid() references public.users(id) on delete cascade,
  tour_id      uuid not null references onboarding_tours(id) on delete cascade,
  tour_version integer not null check (tour_version >= 1),
  run_id       uuid not null,
  event        text not null check (event in ('start', 'step_view', 'step_done', 'complete', 'dismiss')),
  step_index   integer check (step_index is null or step_index between 0 and 19),
  step_id      text check (step_id is null or step_id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  route        text check (route is null or char_length(route) <= 200),
  created_at   timestamptz not null default now()
);

create index if not exists onboarding_tour_events_tour_idx
  on onboarding_tour_events (tour_id, tour_version, event);
create index if not exists onboarding_tour_events_user_idx
  on onboarding_tour_events (tenant_id, user_id, tour_id);

create table if not exists onboarding_nudge_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  user_id       uuid not null default auth.uid() references public.users(id) on delete cascade,
  nudge_id      uuid not null references onboarding_nudges(id) on delete cascade,
  nudge_version integer not null check (nudge_version >= 1),
  event         text not null check (event in ('shown', 'clicked', 'dismissed')),
  session_id    text check (session_id is null or session_id ~ '^[A-Za-z0-9-]{8,64}$'),
  route         text check (route is null or char_length(route) <= 200),
  created_at    timestamptz not null default now()
);

create index if not exists onboarding_nudge_events_user_idx
  on onboarding_nudge_events (tenant_id, user_id, nudge_id, created_at desc);
create index if not exists onboarding_nudge_events_nudge_idx
  on onboarding_nudge_events (nudge_id, event);

-- Valida el evento del tour: versión publicada existente, paso dentro del
-- recorrido, feature de plan y fecha del servidor. Al completar o descartar
-- consume la asignación correctiva abierta de ese tour.
create or replace function trg_onboarding_tour_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_steps jsonb;
begin
  new.created_at := now();
  if not tenant_has_feature_for(new.tenant_id, 'tours') then
    raise exception 'feature_not_in_plan' using errcode = '42501';
  end if;
  select steps into v_steps
    from onboarding_tour_versions
   where tour_id = new.tour_id and version = new.tour_version;
  if v_steps is null then
    raise exception 'tour_version_not_found';
  end if;
  if new.event in ('step_view', 'step_done') and new.step_index is null then
    raise exception 'invalid_step';
  end if;
  if new.step_index is not null and new.step_index >= jsonb_array_length(v_steps) then
    raise exception 'invalid_step';
  end if;
  if new.step_index is not null then
    new.step_id := v_steps -> new.step_index ->> 'id';
  end if;
  if new.event in ('complete', 'dismiss') then
    update onboarding_assignments
       set consumed_at = now(), consumed_by = new.user_id
     where tenant_id = new.tenant_id and kind = 'tour' and tour_id = new.tour_id
       and consumed_at is null and cancelled_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists onboarding_tour_event_check on onboarding_tour_events;
create trigger onboarding_tour_event_check
  before insert on onboarding_tour_events
  for each row execute function trg_onboarding_tour_event();

-- `shown` sólo lo registra nudge_next (así el límite por día no se esquiva);
-- por PostgREST se cargan `clicked` y `dismissed` de una versión real.
create or replace function trg_onboarding_nudge_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.created_at := now();
  if not tenant_has_feature_for(new.tenant_id, 'sugerencias') then
    raise exception 'feature_not_in_plan' using errcode = '42501';
  end if;
  -- nudge_next marca la transacción (GUC local); un cliente no puede.
  if new.event = 'shown'
     and coalesce(current_setting('ninja.nudge_server', true), '') <> '1'
     and coalesce(auth.jwt() ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'shown_is_server_side' using errcode = '42501';
  end if;
  if not exists (
    select 1 from onboarding_nudges where id = new.nudge_id and version >= new.nudge_version
  ) then
    raise exception 'nudge_not_found';
  end if;
  if new.event in ('clicked', 'dismissed') then
    update onboarding_assignments
       set consumed_at = now(), consumed_by = new.user_id
     where tenant_id = new.tenant_id and kind = 'nudge' and nudge_id = new.nudge_id
       and consumed_at is null and cancelled_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists onboarding_nudge_event_check on onboarding_nudge_events;
create trigger onboarding_nudge_event_check
  before insert on onboarding_nudge_events
  for each row execute function trg_onboarding_nudge_event();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table onboarding_tours enable row level security;
alter table onboarding_tour_versions enable row level security;
alter table onboarding_nudges enable row level security;
alter table onboarding_nudge_settings enable row level security;
alter table onboarding_assignments enable row level security;
alter table onboarding_tour_events enable row level security;
alter table onboarding_nudge_events enable row level security;

-- Configuración de plataforma: sólo el staff en el panel interno la lee.
drop policy if exists onboarding_tours_select on onboarding_tours;
create policy onboarding_tours_select on onboarding_tours
  for select using ((select internal_scope()));

drop policy if exists onboarding_tour_versions_select on onboarding_tour_versions;
create policy onboarding_tour_versions_select on onboarding_tour_versions
  for select using ((select internal_scope()));

drop policy if exists onboarding_nudges_select on onboarding_nudges;
create policy onboarding_nudges_select on onboarding_nudges
  for select using ((select internal_scope()));

drop policy if exists onboarding_nudge_settings_select on onboarding_nudge_settings;
create policy onboarding_nudge_settings_select on onboarding_nudge_settings
  for select using ((select internal_scope()));

-- Las asignaciones son del negocio pero las gestiona el staff: el negocio las
-- recibe por tours_for_me / nudge_next, no las lista.
drop policy if exists onboarding_assignments_select on onboarding_assignments;
create policy onboarding_assignments_select on onboarding_assignments
  for select using ((select internal_scope()));

revoke insert, update, delete on onboarding_tours, onboarding_tour_versions, onboarding_nudges,
  onboarding_nudge_settings, onboarding_assignments from anon, authenticated;
grant select on onboarding_tours, onboarding_tour_versions, onboarding_nudges,
  onboarding_nudge_settings, onboarding_assignments to authenticated;

-- Eventos: cada uno ve y carga los suyos en el negocio activo.
drop policy if exists onboarding_tour_events_select on onboarding_tour_events;
create policy onboarding_tour_events_select on onboarding_tour_events
  for select using (
    (tenant_id = (select current_tenant_id()) and user_id = (select auth.uid()))
    or (select internal_scope())
  );

drop policy if exists onboarding_tour_events_insert on onboarding_tour_events;
create policy onboarding_tour_events_insert on onboarding_tour_events
  for insert with check (
    tenant_id = (select current_tenant_id()) and user_id = (select auth.uid())
  );

drop policy if exists onboarding_nudge_events_select on onboarding_nudge_events;
create policy onboarding_nudge_events_select on onboarding_nudge_events
  for select using (
    (tenant_id = (select current_tenant_id()) and user_id = (select auth.uid()))
    or (select internal_scope())
  );

drop policy if exists onboarding_nudge_events_insert on onboarding_nudge_events;
create policy onboarding_nudge_events_insert on onboarding_nudge_events
  for insert with check (
    tenant_id = (select current_tenant_id()) and user_id = (select auth.uid())
  );

-- Sin UPDATE ni DELETE: los eventos son historia.
revoke update, delete on onboarding_tour_events, onboarding_nudge_events from anon, authenticated;
grant select, insert on onboarding_tour_events, onboarding_nudge_events to authenticated;

-- -----------------------------------------------------------------------------
-- F) Helpers (sin grant a clientes: los usan las RPC)
-- -----------------------------------------------------------------------------
-- Misma resolución de plan, estado y rubro que internal_segment_tenants
-- (ADR-084): familia del plan (base_plan_key o key), estado de la suscripción
-- o del negocio, rubro o 'otro'. Un array vacío o ausente no filtra.
create or replace function onboarding_audience_match(p_tenant uuid, p_role text, p_audience jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_family   text;
  v_status   text;
  v_industry text;
  v_created  timestamptz;
  v_days     numeric;
  v_aud      jsonb := coalesce(p_audience, '{}'::jsonb);
  k          text;
begin
  if p_tenant is null then return false; end if;
  select coalesce(p.base_plan_key, p.key), coalesce(s.status, t.status), coalesce(t.industry, 'otro'), t.created_at
    into v_family, v_status, v_industry, v_created
    from tenants t
    left join subscriptions s on s.tenant_id = t.id
    left join plans p on p.id = s.plan_id
   where t.id = p_tenant and t.deleted_at is null
   limit 1;
  if not found then return false; end if;

  if jsonb_array_length(coalesce(v_aud -> 'plans', '[]'::jsonb)) > 0
     and not ((v_aud -> 'plans') ? coalesce(v_family, '')) then return false; end if;
  if jsonb_array_length(coalesce(v_aud -> 'statuses', '[]'::jsonb)) > 0
     and not ((v_aud -> 'statuses') ? coalesce(v_status, '')) then return false; end if;
  if jsonb_array_length(coalesce(v_aud -> 'industries', '[]'::jsonb)) > 0
     and not ((v_aud -> 'industries') ? v_industry) then return false; end if;
  if jsonb_array_length(coalesce(v_aud -> 'roles', '[]'::jsonb)) > 0
     and not ((v_aud -> 'roles') ? coalesce(p_role, '')) then return false; end if;
  for k in select jsonb_array_elements_text(coalesce(v_aud -> 'features', '[]'::jsonb)) loop
    if not tenant_has_feature_for(p_tenant, k) then return false; end if;
  end loop;
  v_days := floor(extract(epoch from (now() - v_created)) / 86400);
  if v_aud ? 'min_days' and v_days < (v_aud ->> 'min_days')::numeric then return false; end if;
  if v_aud ? 'max_days' and v_days > (v_aud ->> 'max_days')::numeric then return false; end if;
  return true;
end;
$$;

-- ¿El evento disparador está vigente para este negocio (y usuario)?
create or replace function onboarding_event_active(p_tenant uuid, p_user uuid, p_event text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_tenant is null then return false; end if;
  case p_event
    when 'registro' then
      return exists (select 1 from tenants where id = p_tenant and created_at >= now() - interval '7 days');
    when 'primer_login' then
      return not exists (select 1 from onboarding_tour_events where tenant_id = p_tenant and user_id = p_user)
         and not exists (select 1 from onboarding_nudge_events where tenant_id = p_tenant and user_id = p_user);
    when 'sin_productos' then
      return not exists (select 1 from products where tenant_id = p_tenant and deleted_at is null);
    when 'sin_caja_abierta' then
      return not exists (select 1 from cash_shifts where tenant_id = p_tenant and status = 'open');
    when 'sin_primera_venta' then
      return not exists (select 1 from sales where tenant_id = p_tenant and status = 'completed');
    when 'trial_por_vencer' then
      return exists (
        select 1
          from tenants t
          left join subscriptions s on s.tenant_id = t.id
         where t.id = p_tenant
           and coalesce(s.status, t.status) = 'trial'
           and t.trial_ends_at is not null
           and t.trial_ends_at <= now() + interval '3 days'
      );
    else
      -- venta_fallida llega del cliente; manual sólo a mano o por asignación.
      return false;
  end case;
end;
$$;

revoke all on function onboarding_audience_match(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function onboarding_event_active(uuid, uuid, text) from public, anon, authenticated;
grant execute on function onboarding_steps_valid(jsonb) to authenticated;
grant execute on function onboarding_audience_valid(jsonb) to authenticated;
