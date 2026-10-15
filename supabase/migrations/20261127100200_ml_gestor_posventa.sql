-- =============================================================================
-- 20261127100200_ml_gestor_posventa  (H141 · ADR-132 · Gestor de Mercado Libre, parte B)
--
-- Métricas, posventa y embudos (docs/41-mercadolibre-gestor.md):
--
--   ml_gestor_settings      por cuenta: umbrales de reputación (reclamos 1 %,
--                           cancelaciones 0,5 %, demoras 8 %, como ANDESMAR),
--                           motivos de exclusión y avisos.
--   ml_reputation_snapshots foto diaria por cuenta (fecha de Argentina; la
--                           última lectura del día gana) para la evolución.
--   ml_claims               espejo de reclamos, mediaciones y devoluciones con
--                           vencimiento, acciones del vendedor, retorno,
--                           "afecta la reputación", exclusión y asignación.
--   ml_reply_templates      plantillas de respuesta (preguntas, reclamos,
--                           mensajes).
--   ml_board_stages/_cards  embudos de ventas y de posventa: etapas
--                           configurables y tarjetas movidas a mano.
--
-- Gating: feature `mercadolibre_gestor` (+ `mercadolibre`) en cada RPC de la
-- UI (ml_gestor_assert), en la Edge (ml_edge_guard_gestor) y en la ingesta
-- del worker (ml_claim_upsert, ml_reputation_snapshot_save).
-- Seguridad: tenant_id NOT NULL sin default, RLS de lectura con
-- "(select current_tenant_id())", sin policies de escritura (sólo RPC
-- SECURITY DEFINER o service_role), role_write_guard, índice por FK, nunca
-- "OR is_internal()". Acciones críticas en audit_logs.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tablas.
-- -----------------------------------------------------------------------------
create table if not exists ml_gestor_settings (
  account_id         uuid primary key references ml_accounts(id) on delete cascade,
  tenant_id          uuid not null references tenants(id) on delete cascade,
  thresholds         jsonb not null default '{"claims": 1, "cancellations": 0.5, "delayed": 8}'::jsonb,
  exclusion_reasons  text[] not null default array['PDD9939', 'PNR9501', 'PDD9502', 'PDD9829'],
  -- {claims: aviso de reclamo nuevo, due_hours: horas para "vence pronto",
  --  reputation: aviso si una métrica empeora}
  notify             jsonb not null default '{"claims": true, "due_hours": 24, "reputation": true}'::jsonb,
  updated_by         uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists ml_gestor_settings_tenant_idx on ml_gestor_settings (tenant_id);
create index if not exists ml_gestor_settings_updated_by_idx on ml_gestor_settings (updated_by) where updated_by is not null;
drop trigger if exists set_updated_at_ml_gestor_settings on ml_gestor_settings;
create trigger set_updated_at_ml_gestor_settings before update on ml_gestor_settings
  for each row execute function set_updated_at();

create table if not exists ml_reputation_snapshots (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  account_id           uuid not null references ml_accounts(id) on delete cascade,
  snap_date            date not null,
  level_id             text check (level_id is null or char_length(level_id) <= 30),
  power_seller_status  text check (power_seller_status is null or char_length(power_seller_status) <= 30),
  sales_completed      integer not null default 0,
  claims_rate          numeric(8,5) not null default 0,
  cancellations_rate   numeric(8,5) not null default 0,
  delayed_rate         numeric(8,5) not null default 0,
  -- ReputationSnap completo (_shared/mercadolibre/reputation.ts).
  data                 jsonb not null default '{}'::jsonb,
  taken_at             timestamptz not null default now()
);
create unique index if not exists ml_reputation_snapshots_uq on ml_reputation_snapshots (account_id, snap_date);
create index if not exists ml_reputation_snapshots_tenant_idx on ml_reputation_snapshots (tenant_id, snap_date desc);

create table if not exists ml_claims (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  account_id          uuid not null references ml_accounts(id) on delete cascade,
  claim_id            bigint not null,
  resource            text check (resource is null or char_length(resource) <= 30),
  resource_id         bigint,
  pack_key            text check (pack_key is null or char_length(pack_key) <= 30),
  kind                text not null default 'reclamo' check (kind in ('reclamo', 'mediacion', 'devolucion', 'cancelacion')),
  type                text check (type is null or char_length(type) <= 40),
  stage               text check (stage is null or char_length(stage) <= 30),
  status              text not null default 'opened' check (char_length(status) <= 20),
  reason_id           text check (reason_id is null or char_length(reason_id) <= 20),
  due_at              timestamptz,
  action_responsible  text check (action_responsible is null or char_length(action_responsible) <= 20),
  my_actions          jsonb not null default '[]'::jsonb,
  detail_title        text check (detail_title is null or char_length(detail_title) <= 300),
  return_id           bigint,
  return_status       text check (return_status is null or char_length(return_status) <= 30),
  affects_reputation  boolean,
  resolution_reason   text check (resolution_reason is null or char_length(resolution_reason) <= 60),
  resolution_result   text check (resolution_result is null or resolution_result in ('a_favor', 'en_contra', 'reintegro', 'cubierto')),
  exclusion_status    text check (exclusion_status is null or exclusion_status in ('candidato', 'pedida', 'aceptada', 'rechazada', 'descartada')),
  exclusion_note      text check (exclusion_note is null or char_length(exclusion_note) <= 300),
  assigned_to         uuid references public.users(id) on delete set null,
  date_created        timestamptz,
  ml_last_updated     timestamptz,
  synced_at           timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table ml_claims is
  'ADR-132: espejo de reclamos, mediaciones y devoluciones de ML. El estado sale de status (nunca del texto de /detail).';
create unique index if not exists ml_claims_account_claim_uq on ml_claims (account_id, claim_id);
create index if not exists ml_claims_tenant_status_idx on ml_claims (tenant_id, status, due_at);
create index if not exists ml_claims_tenant_created_idx on ml_claims (tenant_id, date_created desc);
create index if not exists ml_claims_resource_idx on ml_claims (account_id, resource_id);
create index if not exists ml_claims_pack_idx on ml_claims (account_id, pack_key) where pack_key is not null;
create index if not exists ml_claims_assigned_idx on ml_claims (assigned_to) where assigned_to is not null;
drop trigger if exists set_updated_at_ml_claims on ml_claims;
create trigger set_updated_at_ml_claims before update on ml_claims
  for each row execute function set_updated_at();

create table if not exists ml_reply_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  scope       text not null check (scope in ('question', 'claim', 'message')),
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  body        text not null check (char_length(btrim(body)) between 2 and 2000),
  sort        integer not null default 0,
  updated_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists ml_reply_templates_tenant_idx on ml_reply_templates (tenant_id, scope, sort) where deleted_at is null;
create index if not exists ml_reply_templates_tenant_created_idx on ml_reply_templates (tenant_id, created_at);
create index if not exists ml_reply_templates_updated_by_idx on ml_reply_templates (updated_by) where updated_by is not null;
drop trigger if exists set_updated_at_ml_reply_templates on ml_reply_templates;
create trigger set_updated_at_ml_reply_templates before update on ml_reply_templates
  for each row execute function set_updated_at();

create table if not exists ml_board_stages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  board       text not null check (board in ('sales', 'claims')),
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  sort        integer not null default 0,
  auto_key    text check (auto_key is null or auto_key in ('new', 'to_prepare', 'shipped', 'delivered', 'claim', 'waiting', 'resolved')),
  is_final    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists ml_board_stages_tenant_idx on ml_board_stages (tenant_id, board, sort) where deleted_at is null;
create index if not exists ml_board_stages_tenant_created_idx on ml_board_stages (tenant_id, created_at);
drop trigger if exists set_updated_at_ml_board_stages on ml_board_stages;
create trigger set_updated_at_ml_board_stages before update on ml_board_stages
  for each row execute function set_updated_at();

create table if not exists ml_board_cards (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  board        text not null check (board in ('sales', 'claims')),
  account_id   uuid not null references ml_accounts(id) on delete cascade,
  -- sales: pack_key; claims: claim_id.
  ref_key      text not null check (char_length(ref_key) between 1 and 30),
  stage_id     uuid references ml_board_stages(id) on delete set null,
  assigned_to  uuid references public.users(id) on delete set null,
  note         text check (note is null or char_length(note) <= 300),
  moved_by     uuid references public.users(id) on delete set null,
  moved_at     timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists ml_board_cards_uq on ml_board_cards (account_id, board, ref_key);
create index if not exists ml_board_cards_tenant_idx on ml_board_cards (tenant_id, board, created_at);
create index if not exists ml_board_cards_stage_idx on ml_board_cards (stage_id) where stage_id is not null;
create index if not exists ml_board_cards_assigned_idx on ml_board_cards (assigned_to) where assigned_to is not null;
create index if not exists ml_board_cards_moved_by_idx on ml_board_cards (moved_by) where moved_by is not null;
drop trigger if exists set_updated_at_ml_board_cards on ml_board_cards;
create trigger set_updated_at_ml_board_cards before update on ml_board_cards
  for each row execute function set_updated_at();

-- Cola: refresco de un reclamo.
alter table ml_sync_jobs drop constraint if exists ml_sync_jobs_kind_check;
alter table ml_sync_jobs add constraint ml_sync_jobs_kind_check
  check (kind in ('stock_push', 'price_push', 'item_status', 'item_refresh', 'invoice_upload', 'answer_question',
                  'me1_tracking', 'order_refresh', 'item_publish', 'claim_refresh'));

-- -----------------------------------------------------------------------------
-- B) RLS: lectura del negocio activo; escritura sólo por RPC.
-- -----------------------------------------------------------------------------
alter table ml_gestor_settings      enable row level security;
alter table ml_reputation_snapshots enable row level security;
alter table ml_claims               enable row level security;
alter table ml_reply_templates      enable row level security;
alter table ml_board_stages         enable row level security;
alter table ml_board_cards          enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['ml_gestor_settings', 'ml_reputation_snapshots', 'ml_claims', 'ml_reply_templates',
                           'ml_board_stages', 'ml_board_cards'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select using (tenant_id = (select current_tenant_id()))',
      t || '_select', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'operate');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Guardas.
-- -----------------------------------------------------------------------------
-- UI: ml_assert (rol + `mercadolibre`) + `mercadolibre_gestor`.
create or replace function ml_gestor_assert(p_manage boolean default true)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_assert(p_manage, true);
begin
  if not tenant_has_feature_for(v_tenant, 'mercadolibre_gestor') then
    raise exception 'feature_not_in_plan: mercadolibre_gestor' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function ml_gestor_assert(boolean) from public, anon;
grant execute on function ml_gestor_assert(boolean) to authenticated;

-- Edge (service_role): null = puede; si no, el código del error.
create or replace function ml_edge_guard_gestor(p_tenant uuid, p_user uuid, p_manage boolean default true)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_err text := ml_edge_guard(p_tenant, p_user, p_manage);
begin
  if v_err is not null then return v_err; end if;
  if not tenant_has_feature_for(p_tenant, 'mercadolibre_gestor') then return 'gestor_not_in_plan'; end if;
  return null;
end;
$$;
revoke all on function ml_edge_guard_gestor(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function ml_edge_guard_gestor(uuid, uuid, boolean) to service_role;

-- Fecha de hoy en Argentina (foto diaria). Espejo: arDate().
create or replace function ml_ar_today()
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (now() at time zone 'America/Argentina/Buenos_Aires')::date;
$$;
revoke all on function ml_ar_today() from public, anon;
grant execute on function ml_ar_today() to authenticated, service_role;

-- Configuración del gestor (con defaults si no hay fila). Interno.
create or replace function _ml_gestor_settings(p_account uuid)
returns ml_gestor_settings
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v ml_gestor_settings%rowtype;
begin
  select * into v from ml_gestor_settings where account_id = p_account;
  if v.account_id is null then
    v.account_id := p_account;
    v.thresholds := '{"claims": 1, "cancellations": 0.5, "delayed": 8}'::jsonb;
    v.exclusion_reasons := array['PDD9939', 'PNR9501', 'PDD9502', 'PDD9829'];
    v.notify := '{"claims": true, "due_hours": 24, "reputation": true}'::jsonb;
  end if;
  return v;
end;
$$;
revoke all on function _ml_gestor_settings(uuid) from public, anon, authenticated;

-- Avisa a dueños y encargados del negocio (centro de notificaciones).
create or replace function _ml_notify_managers(p_tenant uuid, p_title text, p_body text, p_url text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  for r in select tu.user_id from tenant_users tu
            where tu.tenant_id = p_tenant and tu.status = 'active' and tu.role in ('owner', 'manager') loop
    insert into notifications (target_tenant_id, target_user_id, type, severity, title, body, action_label, action_url, expires_at)
    values (p_tenant, r.user_id, 'mercadolibre', 'warning', left(p_title, 200), left(p_body, 500), 'Ver en Mercado Libre',
            p_url, now() + interval '7 days');
  end loop;
exception when others then
  raise warning '_ml_notify_managers: %', sqlerrm;
end;
$$;
revoke all on function _ml_notify_managers(uuid, text, text, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Ingesta del worker y de la Edge (service_role).
-- -----------------------------------------------------------------------------
-- Cuentas con el gestor (foto diaria y reclamos en la reconciliación).
create or replace function ml_gestor_accounts_due(p_kind text)
returns table (account_id uuid, tenant_id uuid, ml_user_id bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.tenant_id, a.ml_user_id
    from ml_accounts a
   where a.deleted_at is null and a.status = 'active'
     and tenant_has_feature_for(a.tenant_id, 'mercadolibre')
     and tenant_has_feature_for(a.tenant_id, 'mercadolibre_gestor')
     and (p_kind <> 'reputation' or not exists (
           select 1 from ml_reputation_snapshots s where s.account_id = a.id and s.snap_date = ml_ar_today()))
   order by a.connected_at
   limit 200;
$$;
revoke all on function ml_gestor_accounts_due(text) from public, anon, authenticated;
grant execute on function ml_gestor_accounts_due(text) to service_role;

-- Foto diaria (la última lectura del día gana). p: ReputationSnap;
-- p_alerts: [{key, from, to, label}] métricas que empeoraron (calculadas en
-- la Edge con crossings()). Devuelve la foto anterior (otro día) para comparar.
create or replace function ml_reputation_snapshot_save(p_account uuid, p jsonb, p_alerts jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc  ml_accounts%rowtype;
  v_set  ml_gestor_settings%rowtype;
  v_a    jsonb;
  v_day  date := ml_ar_today();
begin
  select * into v_acc from ml_accounts where id = p_account and deleted_at is null;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  if not tenant_has_feature_for(v_acc.tenant_id, 'mercadolibre_gestor') then
    return jsonb_build_object('ok', false, 'error', 'feature_off');
  end if;
  insert into ml_reputation_snapshots (tenant_id, account_id, snap_date, level_id, power_seller_status, sales_completed,
                                       claims_rate, cancellations_rate, delayed_rate, data, taken_at)
  values (v_acc.tenant_id, p_account, v_day, nullif(p ->> 'level_id', ''), nullif(p ->> 'power_seller_status', ''),
          coalesce((p ->> 'sales_completed')::int, 0),
          coalesce((p -> 'claims' ->> 'rate')::numeric, 0), coalesce((p -> 'cancellations' ->> 'rate')::numeric, 0),
          coalesce((p -> 'delayed' ->> 'rate')::numeric, 0), coalesce(p, '{}'::jsonb), now())
  on conflict (account_id, snap_date) do update
    set level_id = excluded.level_id, power_seller_status = excluded.power_seller_status,
        sales_completed = excluded.sales_completed, claims_rate = excluded.claims_rate,
        cancellations_rate = excluded.cancellations_rate, delayed_rate = excluded.delayed_rate,
        data = excluded.data, taken_at = now();

  v_set := _ml_gestor_settings(p_account);
  if coalesce((v_set.notify ->> 'reputation')::boolean, true) then
    for v_a in select value from jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) loop
      -- Un aviso por métrica y nivel por día.
      continue when exists (
        select 1 from notifications n
         where n.target_tenant_id = v_acc.tenant_id and n.type = 'mercadolibre'
           and n.title = 'Reputación: ' || coalesce(v_a ->> 'label', v_a ->> 'key') || ' en ' || coalesce(v_a ->> 'to', '')
           and n.created_at >= now() - interval '20 hours');
      perform _ml_notify_managers(v_acc.tenant_id,
        'Reputación: ' || coalesce(v_a ->> 'label', v_a ->> 'key') || ' en ' || coalesce(v_a ->> 'to', ''),
        'La métrica empeoró en ' || coalesce(nullif(v_acc.nickname, ''), 'tu cuenta') || '. Mirá cuánto margen te queda.',
        '/mercadolibre?tab=metrics');
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'snap_date', v_day,
    'previous', (select s.data from ml_reputation_snapshots s
                  where s.account_id = p_account and s.snap_date < v_day order by s.snap_date desc limit 1));
end;
$$;
revoke all on function ml_reputation_snapshot_save(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function ml_reputation_snapshot_save(uuid, jsonb, jsonb) to service_role;

-- Foto anterior (para calcular los avisos antes de guardar).
create or replace function ml_reputation_last(p_account uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.data from ml_reputation_snapshots s
   where s.account_id = p_account and s.snap_date < ml_ar_today()
   order by s.snap_date desc limit 1;
$$;
revoke all on function ml_reputation_last(uuid) from public, anon, authenticated;
grant execute on function ml_reputation_last(uuid) to service_role;

-- Reclamo leído de ML (claimPayload de _shared/mercadolibre/claims.ts). Un
-- retorno o un "afecta" ausentes (no se pudieron leer) no pisan lo conocido.
-- Reclamo nuevo: aviso a dueños y encargados (si está activo).
create or replace function ml_claim_upsert(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acc     ml_accounts%rowtype;
  v_set     ml_gestor_settings%rowtype;
  v_res     bigint := nullif(p ->> 'resource_id', '')::bigint;
  v_pack    text;
  v_id      uuid;
  v_new     boolean;
  v_reason  text := nullif(p ->> 'reason_id', '');
  v_affects boolean := case when p ? 'affects_reputation' then (p ->> 'affects_reputation')::boolean else null end;
  v_last    timestamptz := nullif(p ->> 'last_updated', '')::timestamptz;
begin
  select * into v_acc from ml_accounts where id = p_account and deleted_at is null;
  if v_acc.id is null then raise exception 'account_not_found'; end if;
  if not tenant_has_feature_for(v_acc.tenant_id, 'mercadolibre_gestor') then
    return jsonb_build_object('ok', false, 'error', 'feature_off');
  end if;
  select o.pack_key into v_pack from ml_orders o where o.account_id = p_account and o.ml_order_id = v_res limit 1;
  v_set := _ml_gestor_settings(p_account);

  insert into ml_claims (tenant_id, account_id, claim_id, resource, resource_id, pack_key, kind, type, stage, status, reason_id,
                         due_at, action_responsible, my_actions, detail_title, return_id, return_status, affects_reputation,
                         resolution_reason, resolution_result, exclusion_status, date_created, ml_last_updated, synced_at)
  values (v_acc.tenant_id, p_account, (p ->> 'claim_id')::bigint, nullif(p ->> 'resource', ''), v_res, v_pack,
          coalesce(nullif(p ->> 'kind', ''), 'reclamo'), nullif(p ->> 'type', ''), nullif(p ->> 'stage', ''),
          coalesce(nullif(p ->> 'status', ''), 'opened'), v_reason, nullif(p ->> 'due_at', '')::timestamptz,
          nullif(p ->> 'action_responsible', ''), coalesce(p -> 'my_actions', '[]'::jsonb), nullif(p ->> 'detail_title', ''),
          nullif(p ->> 'return_id', '')::bigint, nullif(p ->> 'return_status', ''), v_affects,
          nullif(p ->> 'resolution_reason', ''), nullif(p ->> 'resolution_result', ''),
          case when v_affects and v_reason = any (v_set.exclusion_reasons) then 'candidato' end,
          nullif(p ->> 'date_created', '')::timestamptz, v_last, now())
  on conflict (account_id, claim_id) do update
    set resource = excluded.resource, resource_id = coalesce(excluded.resource_id, ml_claims.resource_id),
        pack_key = coalesce(excluded.pack_key, ml_claims.pack_key), kind = excluded.kind, type = excluded.type,
        stage = excluded.stage, status = excluded.status, reason_id = coalesce(excluded.reason_id, ml_claims.reason_id),
        due_at = excluded.due_at, action_responsible = excluded.action_responsible, my_actions = excluded.my_actions,
        detail_title = coalesce(excluded.detail_title, ml_claims.detail_title),
        return_id = case when p ? 'return_id' then coalesce(excluded.return_id, ml_claims.return_id) else ml_claims.return_id end,
        return_status = case when p ? 'return_status' then coalesce(excluded.return_status, ml_claims.return_status) else ml_claims.return_status end,
        affects_reputation = case when p ? 'affects_reputation' and excluded.affects_reputation is not null
                                  then excluded.affects_reputation else ml_claims.affects_reputation end,
        resolution_reason = excluded.resolution_reason, resolution_result = excluded.resolution_result,
        exclusion_status = coalesce(ml_claims.exclusion_status,
                                    case when coalesce(excluded.affects_reputation, ml_claims.affects_reputation)
                                              and coalesce(excluded.reason_id, ml_claims.reason_id) = any (v_set.exclusion_reasons)
                                         then 'candidato' end),
        date_created = coalesce(excluded.date_created, ml_claims.date_created),
        -- Un estado viejo que llega tarde no pisa al nuevo.
        ml_last_updated = greatest(excluded.ml_last_updated, ml_claims.ml_last_updated),
        synced_at = now()
    where ml_claims.ml_last_updated is null or excluded.ml_last_updated is null
       or excluded.ml_last_updated >= ml_claims.ml_last_updated
  returning id, (xmax = 0) into v_id, v_new;

  if v_id is null then
    return jsonb_build_object('ok', true, 'skipped', 'stale');
  end if;
  if v_new and coalesce(p ->> 'status', 'opened') = 'opened' and coalesce((v_set.notify ->> 'claims')::boolean, true) then
    perform _ml_notify_managers(v_acc.tenant_id,
      case coalesce(p ->> 'kind', 'reclamo') when 'mediacion' then 'Mediación nueva en Mercado Libre'
                                             when 'devolucion' then 'Devolución nueva en Mercado Libre'
                                             when 'cancelacion' then 'Pedido de cancelación en Mercado Libre'
                                             else 'Reclamo nuevo en Mercado Libre' end,
      coalesce(nullif(p ->> 'detail_title', ''), 'Respondé antes del vencimiento para cuidar tu reputación.'),
      '/mercadolibre?tab=postsale');
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'inserted', v_new);
end;
$$;
revoke all on function ml_claim_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function ml_claim_upsert(uuid, jsonb) to service_role;

-- Última actualización conocida por reclamo (la reconciliación sólo relee
-- los que cambiaron en ML).
create or replace function ml_claims_stamp(p_account uuid, p_ids bigint[])
returns table (claim_id bigint, ml_last_updated timestamptz, status text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.claim_id, c.ml_last_updated, c.status from ml_claims c
   where c.account_id = p_account and c.claim_id = any (p_ids);
$$;
revoke all on function ml_claims_stamp(uuid, bigint[]) from public, anon, authenticated;
grant execute on function ml_claims_stamp(uuid, bigint[]) to service_role;

-- Auditoría de una acción sobre un reclamo (la Edge la llama ANTES de
-- escribir en ML, con el intento, y DESPUÉS con el resultado).
create or replace function ml_claim_audit(p_account uuid, p_user uuid, p_claim uuid, p_action text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from ml_accounts where id = p_account;
  if v_tenant is null then raise exception 'account_not_found'; end if;
  if p_action !~ '^ml_claim_[a-z_]{3,40}$' then raise exception 'invalid_action'; end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, p_user, 'ml_claims', p_claim, p_action, coalesce(p_data, '{}'::jsonb));
end;
$$;
revoke all on function ml_claim_audit(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function ml_claim_audit(uuid, uuid, uuid, text, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- E) RPC de la UI.
-- -----------------------------------------------------------------------------
-- Configuración del gestor. p: {thresholds{claims,cancellations,delayed},
-- exclusion_reasons[], notify{claims,due_hours,reputation}}
create or replace function ml_gestor_settings_save(p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_gestor_assert(true);
  v_before ml_gestor_settings%rowtype;
  v_th     jsonb := p -> 'thresholds';
  v_rs     text[];
  v_n      jsonb := p -> 'notify';
  x        text;
begin
  perform assert_account_active(v_tenant);
  if not exists (select 1 from ml_accounts a where a.id = p_account and a.tenant_id = v_tenant and a.deleted_at is null) then
    raise exception 'not_found';
  end if;
  if v_th is not null and not (
       coalesce((v_th ->> 'claims')::numeric, 1) between 0.1 and 20
       and coalesce((v_th ->> 'cancellations')::numeric, 0.5) between 0.1 and 20
       and coalesce((v_th ->> 'delayed')::numeric, 8) between 0.1 and 50) then
    raise exception 'invalid_thresholds';
  end if;
  if p ? 'exclusion_reasons' then
    select coalesce(array_agg(distinct upper(btrim(v))), '{}') into v_rs
      from jsonb_array_elements_text(coalesce(p -> 'exclusion_reasons', '[]'::jsonb)) v
     where btrim(v) <> '';
    if coalesce(array_length(v_rs, 1), 0) > 50 then raise exception 'invalid_reasons'; end if;
    foreach x in array coalesce(v_rs, '{}') loop
      if x !~ '^[A-Z]{2,4}\d{3,5}$' then raise exception 'invalid_reasons'; end if;
    end loop;
  end if;
  if v_n is not null and coalesce((v_n ->> 'due_hours')::int, 24) not between 1 and 168 then
    raise exception 'invalid_notify';
  end if;
  v_before := _ml_gestor_settings(p_account);
  insert into ml_gestor_settings (account_id, tenant_id, thresholds, exclusion_reasons, notify, updated_by)
  values (p_account, v_tenant,
          case when v_th is null then v_before.thresholds else jsonb_build_object(
            'claims', coalesce((v_th ->> 'claims')::numeric, 1),
            'cancellations', coalesce((v_th ->> 'cancellations')::numeric, 0.5),
            'delayed', coalesce((v_th ->> 'delayed')::numeric, 8)) end,
          case when p ? 'exclusion_reasons' then coalesce(v_rs, '{}') else v_before.exclusion_reasons end,
          case when v_n is null then v_before.notify else jsonb_build_object(
            'claims', coalesce((v_n ->> 'claims')::boolean, true),
            'due_hours', coalesce((v_n ->> 'due_hours')::int, 24),
            'reputation', coalesce((v_n ->> 'reputation')::boolean, true)) end,
          auth.uid())
  on conflict (account_id) do update
    set thresholds = excluded.thresholds, exclusion_reasons = excluded.exclusion_reasons,
        notify = excluded.notify, updated_by = excluded.updated_by;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'ml_accounts', p_account, 'ml_gestor_settings_saved',
          jsonb_build_object('thresholds', v_before.thresholds, 'exclusion_reasons', v_before.exclusion_reasons,
                             'notify', v_before.notify), p);
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_gestor_settings_save(uuid, jsonb) from public, anon;
grant execute on function ml_gestor_settings_save(uuid, jsonb) to authenticated;

-- Exclusión de un caso (no hay API en ML: se registra lo que se pidió a mano).
create or replace function ml_claim_exclusion_set(p_claim uuid, p_status text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_gestor_assert(true);
  v_c      ml_claims%rowtype;
begin
  if p_status is not null and p_status not in ('candidato', 'pedida', 'aceptada', 'rechazada', 'descartada') then
    raise exception 'invalid_status';
  end if;
  update ml_claims set exclusion_status = p_status, exclusion_note = left(nullif(btrim(p_note), ''), 300)
   where id = p_claim and tenant_id = v_tenant
  returning * into v_c;
  if v_c.id is null then raise exception 'not_found'; end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'ml_claims', p_claim, 'ml_claim_exclusion_set',
          jsonb_build_object('claim_id', v_c.claim_id, 'status', p_status, 'note', left(p_note, 300)));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_claim_exclusion_set(uuid, text, text) from public, anon;
grant execute on function ml_claim_exclusion_set(uuid, text, text) to authenticated;

-- Plantillas de respuesta. p: {scope, name, body, sort}
create or replace function ml_reply_template_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_gestor_assert(true);
  v_id     uuid;
begin
  if coalesce(p ->> 'scope', '') not in ('question', 'claim', 'message') then raise exception 'invalid_scope'; end if;
  if char_length(btrim(coalesce(p ->> 'name', ''))) not between 1 and 80
     or char_length(btrim(coalesce(p ->> 'body', ''))) not between 2 and 2000 then
    raise exception 'invalid_template';
  end if;
  if p_id is null then
    insert into ml_reply_templates (tenant_id, scope, name, body, sort, updated_by)
    values (v_tenant, p ->> 'scope', btrim(p ->> 'name'), btrim(p ->> 'body'), coalesce((p ->> 'sort')::int, 0), auth.uid())
    returning id into v_id;
  else
    update ml_reply_templates
       set scope = p ->> 'scope', name = btrim(p ->> 'name'), body = btrim(p ->> 'body'),
           sort = coalesce((p ->> 'sort')::int, sort), updated_by = auth.uid()
     where id = p_id and tenant_id = v_tenant and deleted_at is null
    returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;
  return v_id;
end;
$$;
revoke all on function ml_reply_template_save(uuid, jsonb) from public, anon;
grant execute on function ml_reply_template_save(uuid, jsonb) to authenticated;

create or replace function ml_reply_template_delete(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_gestor_assert(true);
begin
  update ml_reply_templates set deleted_at = now(), updated_by = auth.uid()
   where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_reply_template_delete(uuid) from public, anon;
grant execute on function ml_reply_template_delete(uuid) to authenticated;

-- Etapas por defecto del embudo (si el negocio todavía no tiene). Cualquier
-- rol operativo (lo dispara abrir el tablero).
create or replace function ml_board_stages_ensure(p_board text)
returns setof ml_board_stages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_gestor_assert(false);
begin
  if p_board not in ('sales', 'claims') then raise exception 'invalid_board'; end if;
  if not exists (select 1 from ml_board_stages s where s.tenant_id = v_tenant and s.board = p_board and s.deleted_at is null) then
    -- Lock por negocio y tablero: dos pestañas no crean las etapas dos veces.
    perform pg_advisory_xact_lock(hashtext('ml_board:' || v_tenant::text || ':' || p_board));
    if not exists (select 1 from ml_board_stages s where s.tenant_id = v_tenant and s.board = p_board and s.deleted_at is null) then
      if p_board = 'sales' then
        insert into ml_board_stages (tenant_id, board, name, sort, auto_key, is_final) values
          (v_tenant, 'sales', 'Nueva', 0, 'new', false),
          (v_tenant, 'sales', 'A preparar', 1, 'to_prepare', false),
          (v_tenant, 'sales', 'Despachada', 2, 'shipped', false),
          (v_tenant, 'sales', 'Entregada', 3, 'delivered', false),
          (v_tenant, 'sales', 'Con reclamo', 4, 'claim', false),
          (v_tenant, 'sales', 'Resuelta', 5, 'resolved', true);
      else
        insert into ml_board_stages (tenant_id, board, name, sort, auto_key, is_final) values
          (v_tenant, 'claims', 'Nuevo', 0, 'new', false),
          (v_tenant, 'claims', 'En gestión', 1, null, false),
          (v_tenant, 'claims', 'Esperando', 2, 'waiting', false),
          (v_tenant, 'claims', 'Resuelto', 3, 'resolved', true);
      end if;
    end if;
  end if;
  return query select * from ml_board_stages s
                where s.tenant_id = v_tenant and s.board = p_board and s.deleted_at is null order by s.sort;
end;
$$;
revoke all on function ml_board_stages_ensure(text) from public, anon;
grant execute on function ml_board_stages_ensure(text) to authenticated;

-- Etapas del tablero (reemplaza). p: [{id?, name, auto_key, is_final}] en
-- orden. Las que se sacan quedan dadas de baja y sus tarjetas vuelven a la
-- etapa automática.
create or replace function ml_board_stages_save(p_board text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_gestor_assert(true);
  v_s      jsonb;
  v_keep   uuid[] := '{}';
  v_id     uuid;
  v_i      int := 0;
  v_autos  text[] := '{}';
  v_auto   text;
begin
  if p_board not in ('sales', 'claims') then raise exception 'invalid_board'; end if;
  if jsonb_typeof(coalesce(p, '[]'::jsonb)) <> 'array' or jsonb_array_length(p) not between 1 and 12 then
    raise exception 'invalid_stages';
  end if;
  for v_s in select value from jsonb_array_elements(p) loop
    v_auto := nullif(v_s ->> 'auto_key', '');
    if v_auto is not null then
      if v_auto = any (v_autos) then raise exception 'duplicate_auto_key'; end if;
      v_autos := v_autos || v_auto;
    end if;
    v_id := nullif(v_s ->> 'id', '')::uuid;
    if v_id is not null then
      update ml_board_stages set name = btrim(v_s ->> 'name'), sort = v_i, auto_key = v_auto,
                                 is_final = coalesce((v_s ->> 'is_final')::boolean, false)
       where id = v_id and tenant_id = v_tenant and board = p_board and deleted_at is null
      returning id into v_id;
    end if;
    if v_id is null then
      insert into ml_board_stages (tenant_id, board, name, sort, auto_key, is_final)
      values (v_tenant, p_board, btrim(v_s ->> 'name'), v_i, v_auto, coalesce((v_s ->> 'is_final')::boolean, false))
      returning id into v_id;
    end if;
    v_keep := v_keep || v_id;
    v_i := v_i + 1;
  end loop;
  update ml_board_cards c set stage_id = null
   where c.tenant_id = v_tenant and c.board = p_board and c.stage_id is not null and not (c.stage_id = any (v_keep));
  update ml_board_stages set deleted_at = now()
   where tenant_id = v_tenant and board = p_board and deleted_at is null and not (id = any (v_keep));
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'ml_board_stages', null, 'ml_board_stages_saved', jsonb_build_object('board', p_board, 'stages', p));
  return jsonb_build_object('ok', true, 'count', v_i);
end;
$$;
revoke all on function ml_board_stages_save(text, jsonb) from public, anon;
grant execute on function ml_board_stages_save(text, jsonb) to authenticated;

-- Mover, asignar o anotar una tarjeta. p: {stage_id?, assigned_to?, note?}
-- (cada clave presente se aplica; stage_id null = vuelve a la automática).
create or replace function ml_board_card_set(p_board text, p_account uuid, p_ref_key text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := ml_gestor_assert(false);
  v_stage  uuid := nullif(p ->> 'stage_id', '')::uuid;
  v_user   uuid := nullif(p ->> 'assigned_to', '')::uuid;
begin
  if p_board not in ('sales', 'claims') then raise exception 'invalid_board'; end if;
  if coalesce(p_ref_key, '') !~ '^[0-9A-Za-z_-]{1,30}$' or (p_board = 'claims' and p_ref_key !~ '^\d{1,22}$') then
    raise exception 'invalid_ref';
  end if;
  if not exists (select 1 from ml_accounts a where a.id = p_account and a.tenant_id = v_tenant and a.deleted_at is null) then
    raise exception 'not_found';
  end if;
  if v_stage is not null and not exists (
       select 1 from ml_board_stages s where s.id = v_stage and s.tenant_id = v_tenant and s.board = p_board and s.deleted_at is null) then
    raise exception 'invalid_stage';
  end if;
  if v_user is not null and not exists (
       select 1 from tenant_users tu where tu.tenant_id = v_tenant and tu.user_id = v_user and tu.status = 'active') then
    raise exception 'invalid_user';
  end if;
  insert into ml_board_cards (tenant_id, board, account_id, ref_key, stage_id, assigned_to, note, moved_by, moved_at)
  values (v_tenant, p_board, p_account, p_ref_key, v_stage, v_user, left(nullif(btrim(p ->> 'note'), ''), 300),
          case when p ? 'stage_id' then auth.uid() end, case when p ? 'stage_id' then now() end)
  on conflict (account_id, board, ref_key) do update
    set stage_id = case when p ? 'stage_id' then excluded.stage_id else ml_board_cards.stage_id end,
        assigned_to = case when p ? 'assigned_to' then excluded.assigned_to else ml_board_cards.assigned_to end,
        note = case when p ? 'note' then excluded.note else ml_board_cards.note end,
        moved_by = case when p ? 'stage_id' then auth.uid() else ml_board_cards.moved_by end,
        moved_at = case when p ? 'stage_id' then now() else ml_board_cards.moved_at end;
  -- La asignación del caso también queda en el reclamo (filtro "míos").
  if p_board = 'claims' and p ? 'assigned_to' then
    update ml_claims set assigned_to = v_user
     where tenant_id = v_tenant and account_id = p_account and claim_id = p_ref_key::bigint;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function ml_board_card_set(text, uuid, text, jsonb) from public, anon;
grant execute on function ml_board_card_set(text, uuid, text, jsonb) to authenticated;
