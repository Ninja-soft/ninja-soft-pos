-- =============================================================================
-- 20261109200100_gobierno_comercial  (ADR-092 · F14 · H63)
--
-- Maker-checker de cambios comerciales sensibles. Feature OPTIONAL
-- `aprobaciones_comerciales` (Business y Enterprise).
--
--   A) commercial_governance: política por negocio (la edita sólo el dueño).
--        * enabled            prende el circuito.
--        * promo_mode         off | high_impact | all (promociones).
--        * promo_pct          umbral de % estimado para "alto impacto".
--        * promo_amount       umbral en pesos (promos por monto y topes).
--        * surcharge_mode     off | all (planes de cuotas y recargos).
--        * request_ttl_days   días hasta que la solicitud vence.
--   B) commercial_change_requests: la solicitud, con el antes, lo propuesto,
--      el impacto estimado, quién la pidió, quién la decidió y cuándo vence.
--      Lectura: dueño y encargado del negocio (o internal_scope). Sin
--      escritura por REST: la escriben el trigger y las RPC SECURITY DEFINER.
--   C) Trigger BEFORE INSERT/UPDATE en promotions y payment_plans. Si el que
--      escribe es ENCARGADO, el circuito está prendido y el negocio tiene la
--      feature:
--        * promotions: una promo que queda activa, sin baja y de alto impacto
--          (ver _promo_high_impact) no se aplica. En un alta queda inactiva;
--          en una edición la fila no cambia y todo lo editado queda como
--          propuesta. Desactivar, dar de baja o tocar sólo nombre, texto del
--          ticket o prioridad pasa directo.
--        * payment_plans: todo alta o cambio de un plan que queda activo se
--          retiene igual (crear "Visa 6 cuotas +18%" o subir un recargo).
--          Desactivar un plan pasa directo. En un upsert que va a chocar con
--          un plan existente decide el BEFORE UPDATE.
--      El dueño (y cualquier escritura sin usuario: cron, service_role) pasa
--      directo: es quien aprueba.
--   D) RPC: commercial_governance_get / _save, commercial_requests,
--      commercial_change_decide (sólo dueño; aprobar aplica lo propuesto) y
--      commercial_change_cancel (quien la pidió o el dueño).
--
-- Notificaciones (tipo `comercial`): al dueño cuando entra una solicitud; a
-- quien la pidió cuando se decide. Todo el circuito queda en audit_logs
-- (commercial_change_requested / _approved / _rejected / _expired /
-- _cancelled y commercial_governance_updated); audit_logs es inmutable.
--
-- No recrea create_sale: una promo o un plan pendiente están inactivos y
-- create_sale ya los ignora. No usa "OR is_internal()" (ADR-052).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Política por negocio.
-- -----------------------------------------------------------------------------
create table if not exists commercial_governance (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  enabled          boolean not null default false,
  promo_mode       text not null default 'high_impact'
                     check (promo_mode in ('off', 'high_impact', 'all')),
  promo_pct        numeric(5,2) not null default 20 check (promo_pct > 0 and promo_pct <= 100),
  promo_amount     numeric(12,2) check (promo_amount is null or promo_amount >= 0),
  surcharge_mode   text not null default 'all' check (surcharge_mode in ('off', 'all')),
  request_ttl_days integer not null default 7 check (request_ttl_days between 1 and 60),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references users(id) on delete set null
);

comment on table commercial_governance is
  'ADR-092: maker-checker comercial. El encargado propone, el dueño aprueba.';

alter table commercial_governance enable row level security;
drop policy if exists commercial_governance_select on commercial_governance;
create policy commercial_governance_select on commercial_governance
  for select using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
revoke insert, update, delete on commercial_governance from anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Solicitudes.
-- -----------------------------------------------------------------------------
create table if not exists commercial_change_requests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  entity_type   text not null check (entity_type in ('promotions', 'payment_plans')),
  entity_id     uuid not null,
  entity_label  text check (entity_label is null or char_length(entity_label) <= 120),
  kind          text not null check (kind in ('create', 'update')),
  before_data   jsonb not null default '{}'::jsonb,
  proposed      jsonb not null check (jsonb_typeof(proposed) = 'object'),
  impact        jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  requested_by  uuid references users(id) on delete set null,
  requested_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  decided_by    uuid references users(id) on delete set null,
  decided_at    timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 300)
);

create index if not exists commercial_requests_tenant_idx
  on commercial_change_requests (tenant_id, status, requested_at desc);
create index if not exists commercial_requests_entity_idx
  on commercial_change_requests (entity_type, entity_id) where status = 'pending';
-- Índices de las FK a users (ADR F4: toda FK nueva con índice).
create index if not exists commercial_requests_requested_by_idx
  on commercial_change_requests (requested_by) where requested_by is not null;
create index if not exists commercial_requests_decided_by_idx
  on commercial_change_requests (decided_by) where decided_by is not null;
create index if not exists commercial_governance_updated_by_idx
  on commercial_governance (updated_by) where updated_by is not null;

alter table commercial_change_requests enable row level security;
drop policy if exists commercial_requests_select on commercial_change_requests;
create policy commercial_requests_select on commercial_change_requests
  for select using (
    (tenant_id = (select current_tenant_id())
     and (select member_role_in((select current_tenant_id()))) in ('owner', 'manager'))
    or (select internal_scope())
  );
revoke insert, update, delete on commercial_change_requests from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Impacto de una promoción (espejo de lib/commercial/governance.ts).
-- % máximo estimado sobre las unidades alcanzadas; null si no se puede
-- estimar (monto fijo, precio fijo, combo, regalo).
-- -----------------------------------------------------------------------------
create or replace function _promo_impact_pct(p jsonb)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_type text := p ->> 'action_type';
  v_val  numeric := coalesce((p ->> 'action_value')::numeric, 0);
  v_buy  integer := coalesce((p ->> 'buy_qty')::integer, 0);
  v_pay  integer := coalesce((p ->> 'pay_qty')::integer, 0);
  v_max  numeric := 0;
  t      jsonb;
begin
  if v_type = 'percent' then
    return least(greatest(v_val, 0), 100);
  elsif v_type = 'second_item' then
    return round(least(greatest(v_val, 0), 100) / 2, 2);
  elsif v_type = 'nxm' then
    if v_buy >= 2 and v_pay >= 1 and v_pay < v_buy then
      return round((v_buy - v_pay)::numeric * 100 / v_buy, 2);
    end if;
    return 0;
  elsif v_type = 'volume_tier' then
    if jsonb_typeof(p -> 'volume_tiers') = 'array' then
      for t in select * from jsonb_array_elements(p -> 'volume_tiers') loop
        v_max := greatest(v_max, least(coalesce((t ->> 'pct')::numeric, 0), 100));
      end loop;
    end if;
    return v_max;
  end if;
  return null;
end;
$$;
grant execute on function _promo_impact_pct(jsonb) to authenticated, service_role;

create or replace function _promo_high_impact(p jsonb, p_mode text, p_pct numeric, p_amount numeric)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_pct numeric;
  v_cap numeric := (p ->> 'max_discount')::numeric;
begin
  if p_mode = 'all' then return true; end if;
  if p_mode = 'off' then return false; end if;
  -- Un tope por ticket chico la acota, aunque el % sea alto.
  if v_cap is not null and p_amount is not null and v_cap <= p_amount then
    return false;
  end if;
  v_pct := _promo_impact_pct(p);
  if v_pct is not null then
    return v_pct >= p_pct;
  end if;
  if p ->> 'action_type' = 'amount' and p_amount is not null then
    return coalesce((p ->> 'action_value')::numeric, 0) > p_amount;
  end if;
  -- Sin forma de estimar el impacto: se revisa.
  return true;
end;
$$;
grant execute on function _promo_high_impact(jsonb, text, numeric, numeric) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Notificación del circuito (nunca rompe la escritura).
-- -----------------------------------------------------------------------------
create or replace function _commercial_notify(
  p_tenant uuid, p_role text, p_user uuid, p_severity text, p_title text, p_body text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into notifications (target_tenant_id, target_role, target_user_id, type, severity,
                             title, body, action_label, action_url, expires_at)
  values (p_tenant, p_role, p_user, 'comercial', p_severity, left(p_title, 200), left(p_body, 600),
          'Revisar', '/comercial', now() + interval '30 days');
exception when others then
  raise warning '_commercial_notify: %', sqlerrm;
end;
$$;
revoke all on function _commercial_notify(uuid, text, uuid, text, text, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- C) Trigger maker-checker.
-- -----------------------------------------------------------------------------
create or replace function trg_commercial_maker_checker()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := new.tenant_id;
  v_g       commercial_governance;
  v_new     jsonb := to_jsonb(new);
  v_old     jsonb;
  v_patch   jsonb := '{}'::jsonb;
  v_before  jsonb := '{}'::jsonb;
  v_prev    jsonb;
  v_cosm    text[];
  v_key     text;
  v_kind    text;
  v_impact  jsonb;
  v_req     uuid;
  v_label   text;
  v_expires timestamptz;
begin
  if auth.uid() is null then return new; end if;
  -- Aplicación de una solicitud aprobada (commercial_change_decide).
  if coalesce(current_setting('ninja.commercial_apply', true), '') <> '' then return new; end if;
  if member_role_in(v_tenant) is distinct from 'manager' then return new; end if;

  select * into v_g from commercial_governance where tenant_id = v_tenant;
  if v_g.tenant_id is null or not v_g.enabled then return new; end if;
  if not tenant_has_feature_for(v_tenant, 'aprobaciones_comerciales') then return new; end if;

  -- Lo que queda activo es lo único que se retiene.
  if not coalesce((v_new ->> 'is_active')::boolean, false) then return new; end if;

  if tg_table_name = 'promotions' then
    if v_new ->> 'deleted_at' is not null then return new; end if;
    if not _promo_high_impact(v_new, v_g.promo_mode, v_g.promo_pct, v_g.promo_amount) then
      return new;
    end if;
    v_impact := jsonb_build_object('pct', _promo_impact_pct(v_new), 'mode', v_g.promo_mode,
                                   'threshold_pct', v_g.promo_pct, 'threshold_amount', v_g.promo_amount);
    v_cosm := array['name', 'ticket_label', 'priority'];
    v_label := v_new ->> 'name';
  elsif tg_table_name = 'payment_plans' then
    if v_g.surcharge_mode = 'off' then return new; end if;
    -- Upsert que va a chocar con un plan existente: decide el BEFORE UPDATE.
    if tg_op = 'INSERT' and exists (
      select 1 from payment_plans x
       where x.tenant_id = v_tenant
         and x.provider_key is not distinct from (v_new ->> 'provider_key')
         and x.code is not distinct from (v_new ->> 'code')
         and x.store_id is not distinct from (v_new ->> 'store_id')::uuid
    ) then
      return new;
    end if;
    v_impact := jsonb_build_object('surcharge_pct', (v_new ->> 'surcharge_pct')::numeric,
                                   'installments', (v_new ->> 'installments')::integer);
    v_cosm := array['label', 'sort'];
    v_label := v_new ->> 'label';
  else
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_kind := 'create';
    v_patch := jsonb_build_object('is_active', true);
    v_before := jsonb_build_object('is_active', false);
    new.is_active := false;
  else
    v_old := to_jsonb(old);
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key in ('id', 'tenant_id', 'created_at', 'updated_at') then continue; end if;
      if (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_patch := v_patch || jsonb_build_object(v_key, v_new -> v_key);
        v_before := v_before || jsonb_build_object(v_key, v_old -> v_key);
      end if;
    end loop;
    if v_patch = '{}'::jsonb then return new; end if;
    -- Ya activa y sólo cambia lo cosmético: pasa.
    if coalesce((v_old ->> 'is_active')::boolean, false) and (v_patch - v_cosm) = '{}'::jsonb then
      return new;
    end if;
    v_kind := 'update';
    -- La fila no cambia: todo lo editado queda como propuesta.
    new := old;
  end if;

  -- Una propuesta nueva reemplaza a la pendiente del mismo registro (suma lo
  -- que esa proponía y no se volvió a tocar).
  select r.proposed into v_prev
    from commercial_change_requests r
   where r.entity_type = tg_table_name and r.entity_id = new.id and r.status = 'pending'
   order by r.requested_at desc
   limit 1;
  if v_prev is not null then
    v_patch := v_prev || v_patch;
    update commercial_change_requests
       set status = 'cancelled', decided_at = now(),
           decision_note = 'Reemplazada por una propuesta nueva'
     where entity_type = tg_table_name and entity_id = new.id and status = 'pending';
  end if;

  v_expires := now() + make_interval(days => v_g.request_ttl_days);
  insert into commercial_change_requests (tenant_id, entity_type, entity_id, entity_label, kind,
                                          before_data, proposed, impact, requested_by, expires_at)
  values (v_tenant, tg_table_name, new.id, left(v_label, 120), v_kind,
          v_before, v_patch, v_impact, auth.uid(), v_expires)
  returning id into v_req;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tenant, auth.uid(), 'commercial_change_requests', v_req, 'commercial_change_requested',
          jsonb_build_object('entity_type', tg_table_name, 'entity_id', new.id, 'values', v_before),
          jsonb_build_object('entity_type', tg_table_name, 'entity_id', new.id, 'kind', v_kind,
                             'proposed', v_patch, 'impact', v_impact, 'expires_at', v_expires));

  perform _commercial_notify(
    v_tenant, 'owner', null, 'warning',
    case when tg_table_name = 'promotions' then 'Promoción para aprobar' else 'Recargo para aprobar' end,
    coalesce(v_label, 'Un cambio') || ': un encargado propuso un cambio que necesita tu aprobación.');

  return new;
end;
$$;
revoke all on function trg_commercial_maker_checker() from public, anon, authenticated;

drop trigger if exists commercial_maker_checker on promotions;
create trigger commercial_maker_checker
  before insert or update on promotions
  for each row execute function trg_commercial_maker_checker();

drop trigger if exists commercial_maker_checker on payment_plans;
create trigger commercial_maker_checker
  before insert or update on payment_plans
  for each row execute function trg_commercial_maker_checker();

-- -----------------------------------------------------------------------------
-- D) RPC.
-- -----------------------------------------------------------------------------
create or replace function commercial_governance_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_g      commercial_governance;
begin
  if v_tenant is null or member_role_in(v_tenant) is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_g from commercial_governance where tenant_id = v_tenant;
  return jsonb_build_object(
    'enabled', coalesce(v_g.enabled, false),
    'promo_mode', coalesce(v_g.promo_mode, 'high_impact'),
    'promo_pct', coalesce(v_g.promo_pct, 20),
    'promo_amount', v_g.promo_amount,
    'surcharge_mode', coalesce(v_g.surcharge_mode, 'all'),
    'request_ttl_days', coalesce(v_g.request_ttl_days, 7),
    'has_feature', tenant_has_feature_for(v_tenant, 'aprobaciones_comerciales'));
end;
$$;
revoke all on function commercial_governance_get() from public, anon;
grant execute on function commercial_governance_get() to authenticated;

-- Sólo el dueño: es un control sobre el encargado.
create or replace function commercial_governance_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_before jsonb;
  v_after  jsonb;
begin
  if v_tenant is null or member_role_in(v_tenant) is distinct from 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'aprobaciones_comerciales') then
    raise exception 'feature_not_in_plan: aprobaciones_comerciales';
  end if;
  if jsonb_typeof(coalesce(p, 'null'::jsonb)) <> 'object' then
    raise exception 'invalid_payload';
  end if;

  select to_jsonb(g) into v_before from commercial_governance g where g.tenant_id = v_tenant;

  insert into commercial_governance as g (tenant_id, enabled, promo_mode, promo_pct, promo_amount,
                                          surcharge_mode, request_ttl_days, updated_at, updated_by)
  values (v_tenant,
          coalesce((p ->> 'enabled')::boolean, false),
          coalesce(p ->> 'promo_mode', 'high_impact'),
          coalesce((p ->> 'promo_pct')::numeric, 20),
          (p ->> 'promo_amount')::numeric,
          coalesce(p ->> 'surcharge_mode', 'all'),
          coalesce((p ->> 'request_ttl_days')::integer, 7),
          now(), auth.uid())
  on conflict (tenant_id) do update
    set enabled = excluded.enabled, promo_mode = excluded.promo_mode,
        promo_pct = excluded.promo_pct, promo_amount = excluded.promo_amount,
        surcharge_mode = excluded.surcharge_mode, request_ttl_days = excluded.request_ttl_days,
        updated_at = now(), updated_by = auth.uid();

  select to_jsonb(g) into v_after from commercial_governance g where g.tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'commercial_governance', v_tenant, 'commercial_governance_updated',
          v_before, v_after);
  return commercial_governance_get();
end;
$$;
revoke all on function commercial_governance_save(jsonb) from public, anon;
grant execute on function commercial_governance_save(jsonb) to authenticated;

-- Bandeja: solicitudes del negocio con el nombre de quien pidió y decidió.
-- Las pendientes vencidas salen como 'expired' (se marcan al decidir).
create or replace function commercial_requests(p_status text default 'pending', p_limit integer default 100)
returns table (
  id             uuid,
  entity_type    text,
  entity_id      uuid,
  entity_label   text,
  kind           text,
  before_data    jsonb,
  proposed       jsonb,
  impact         jsonb,
  status         text,
  requested_by   uuid,
  requested_name text,
  requested_at   timestamptz,
  expires_at     timestamptz,
  decided_by     uuid,
  decided_name   text,
  decided_at     timestamptz,
  decision_note  text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or coalesce(member_role_in(v_tenant), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select r.id, r.entity_type, r.entity_id, r.entity_label, r.kind, r.before_data, r.proposed, r.impact,
         case when r.status = 'pending' and r.expires_at <= now() then 'expired' else r.status end,
         r.requested_by, coalesce(nullif(ur.full_name, ''), ur.email),
         r.requested_at, r.expires_at,
         r.decided_by, coalesce(nullif(ud.full_name, ''), ud.email),
         r.decided_at, r.decision_note
    from commercial_change_requests r
    left join users ur on ur.id = r.requested_by
    left join users ud on ud.id = r.decided_by
   where r.tenant_id = v_tenant
     and (p_status is null or p_status = 'all'
          or (p_status = 'pending' and r.status = 'pending' and r.expires_at > now())
          or (p_status <> 'pending' and r.status = p_status))
   order by r.requested_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;
revoke all on function commercial_requests(text, integer) from public, anon;
grant execute on function commercial_requests(text, integer) to authenticated;

-- Aplica lo propuesto sobre la fila (tabla en lista cerrada, columnas reales).
create or replace function _commercial_apply(p_table text, p_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sets text;
  v_n    integer;
begin
  if p_table not in ('promotions', 'payment_plans') then
    raise exception 'invalid_entity';
  end if;
  select string_agg(format('%I = r.%I', k, k), ', ')
    into v_sets
    from jsonb_object_keys(p_patch) k
   where k not in ('id', 'tenant_id', 'created_at', 'updated_at')
     and exists (select 1 from information_schema.columns c
                  where c.table_schema = 'public' and c.table_name = p_table and c.column_name = k);
  if v_sets is null then return; end if;
  execute format(
    'update public.%I t set %s from (select (jsonb_populate_record(x, $2)).* from public.%I x where x.id = $1) r where t.id = $1',
    p_table, v_sets, p_table)
  using p_id, p_patch;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'entity_not_found'; end if;
end;
$$;
revoke all on function _commercial_apply(text, uuid, jsonb) from public, anon, authenticated;

create or replace function commercial_change_decide(p_id uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  r        commercial_change_requests;
  v_status text;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_gone   boolean;
begin
  if v_tenant is null or member_role_in(v_tenant) is distinct from 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'aprobaciones_comerciales') then
    raise exception 'feature_not_in_plan: aprobaciones_comerciales';
  end if;
  if p_approve is null then raise exception 'invalid_decision'; end if;
  if not p_approve and v_note is null then raise exception 'reason_required'; end if;
  if v_note is not null and char_length(v_note) > 300 then raise exception 'note_too_long'; end if;

  select * into r from commercial_change_requests
   where id = p_id and tenant_id = v_tenant
   for update;
  if r.id is null then raise exception 'request_not_found'; end if;
  if r.status <> 'pending' then raise exception 'request_not_pending'; end if;

  if r.expires_at <= now() then
    v_status := 'expired';
  elsif p_approve then
    if r.entity_type = 'promotions' then
      select not exists (select 1 from promotions x where x.id = r.entity_id and x.deleted_at is null)
        into v_gone;
    else
      select not exists (select 1 from payment_plans x where x.id = r.entity_id) into v_gone;
    end if;
    if v_gone then raise exception 'entity_not_found'; end if;
    perform set_config('ninja.commercial_apply', r.id::text, true);
    perform _commercial_apply(r.entity_type, r.entity_id, r.proposed);
    perform set_config('ninja.commercial_apply', '', true);
    v_status := 'approved';
  else
    v_status := 'rejected';
  end if;

  update commercial_change_requests
     set status = v_status, decided_by = auth.uid(), decided_at = now(),
         decision_note = case when v_status = 'expired' then 'Venció sin decisión' else v_note end
   where id = r.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'commercial_change_requests', r.id, 'commercial_change_' || v_status,
          jsonb_build_object('entity_type', r.entity_type, 'entity_id', r.entity_id, 'values', r.before_data),
          jsonb_build_object('entity_type', r.entity_type, 'entity_id', r.entity_id,
                             'proposed', r.proposed, 'requested_by', r.requested_by, 'status', v_status),
          v_note);

  if r.requested_by is not null then
    perform _commercial_notify(
      v_tenant, null, r.requested_by,
      case v_status when 'approved' then 'success' when 'rejected' then 'warning' else 'info' end,
      case v_status when 'approved' then 'Cambio aprobado'
                    when 'rejected' then 'Cambio rechazado'
                    else 'Solicitud vencida' end,
      coalesce(r.entity_label, 'Tu cambio') ||
        case v_status when 'approved' then ': el dueño lo aprobó y ya está aplicado.'
                      when 'rejected' then ': el dueño lo rechazó. ' || coalesce(v_note, '')
                      else ': venció sin decisión; volvé a proponerlo si sigue haciendo falta.' end);
  end if;

  return jsonb_build_object('id', r.id, 'status', v_status);
end;
$$;
revoke all on function commercial_change_decide(uuid, boolean, text) from public, anon;
grant execute on function commercial_change_decide(uuid, boolean, text) to authenticated;

create or replace function commercial_change_cancel(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  r        commercial_change_requests;
begin
  select * into r from commercial_change_requests
   where id = p_id and tenant_id = v_tenant
   for update;
  if r.id is null then raise exception 'request_not_found'; end if;
  if r.requested_by is distinct from auth.uid() and member_role_in(v_tenant) is distinct from 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if r.status <> 'pending' then raise exception 'request_not_pending'; end if;

  update commercial_change_requests
     set status = 'cancelled', decided_by = auth.uid(), decided_at = now(),
         decision_note = 'Cancelada'
   where id = r.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'commercial_change_requests', r.id, 'commercial_change_cancelled',
          jsonb_build_object('status', 'pending'),
          jsonb_build_object('status', 'cancelled', 'entity_type', r.entity_type, 'entity_id', r.entity_id));
end;
$$;
revoke all on function commercial_change_cancel(uuid) from public, anon;
grant execute on function commercial_change_cancel(uuid) to authenticated;
