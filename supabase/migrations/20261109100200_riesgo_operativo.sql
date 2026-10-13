-- =============================================================================
-- 20261109100200_riesgo_operativo  (F16 · H82, ADR-091)
--
-- Prevención de fraude y riesgo operativo, sin tocar create_sale, void_sale
-- ni return_sale_v2:
--   • risk_settings: umbrales del negocio (una fila por negocio; sin fila
--     valen los de risk_settings_effective).
--   • risk_flags: marcas de revisión. Las crean triggers sobre devoluciones
--     (sale_returns) y anulaciones (sales.status → voided) cuando el puntaje
--     llega al mínimo del negocio. Quedan pendientes hasta que un dueño o
--     encargado las marca revisadas o descartadas (con nota, auditado).
--   • operational_risk_signals(): señales por persona en un rango (ventas,
--     anulaciones, descuentos, devoluciones, cobros rechazados, diferencias
--     de caja y marcas pendientes). El puntaje por persona se calcula en el
--     front con lib/risk/operationalRisk.ts sobre estos números.
--
-- Puntaje de una operación (espejo de lib/risk/riskScore.ts, mismos pesos):
--   devolución: monto alto 40, fuera de plazo 20, devoluciones repetidas del
--     usuario en el día 25, efectivo sin cliente 15, misma persona vendió y
--     devolvió 20.
--   anulación: monto alto 40, anulaciones repetidas del usuario en el día 30,
--     anulada más de 2 horas después 15, turno de la venta ya cerrado 25,
--     misma persona vendió y anuló 15.
--   Tope 100. Se marca si puntaje >= flag_score_min (50 por defecto).
--
-- La devolución usa un CONSTRAINT TRIGGER diferido: return_sale_v2 inserta
-- con total 0 y lo actualiza al final; al commit se lee el total real. Los
-- triggers nunca hacen fallar la operación (best effort con aviso).
--
-- Seguridad:
--   • Lectura: sólo dueño o encargado del negocio (is_tenant_manager) o
--     staff interno con internal_scope(); las marcas suman una RESTRICTIVE
--     por sucursal (user_allowed_store_ids).
--   • Escritura sólo por RPC SECURITY DEFINER o los triggers + role_write_guard
--     'manage' (ADR-071).
--   • Gating: feature `prevencion_fraude` en RPC y triggers.
--   • audit_logs en cada marca, revisión y cambio de reglas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tablas
-- -----------------------------------------------------------------------------
create table if not exists risk_settings (
  tenant_id            uuid primary key references tenants(id) on delete cascade,
  return_amount_high   numeric(14,2) not null default 50000 check (return_amount_high > 0),
  return_days_late     int not null default 30 check (return_days_late between 1 and 365),
  returns_per_user_day int not null default 3 check (returns_per_user_day between 1 and 100),
  voids_per_user_day   int not null default 3 check (voids_per_user_day between 1 and 100),
  discount_pct_high    numeric(5,2) not null default 20 check (discount_pct_high > 0 and discount_pct_high <= 100),
  cash_diff_abs        numeric(14,2) not null default 5000 check (cash_diff_abs >= 0),
  flag_score_min       int not null default 50 check (flag_score_min between 1 and 100),
  updated_by           uuid default auth.uid() references public.users(id),
  updated_at           timestamptz not null default now()
);

comment on table risk_settings is
  'Umbrales de riesgo operativo del negocio (F16/H82, ADR-091). Sin fila valen los de risk_settings_effective().';

drop trigger if exists set_updated_at_risk_settings on risk_settings;
create trigger set_updated_at_risk_settings
  before update on risk_settings
  for each row execute function set_updated_at();

create table if not exists risk_flags (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  store_id     uuid references stores(id) on delete set null,
  kind         text not null check (kind in ('return', 'void')),
  entity_type  text not null check (entity_type in ('sale_returns', 'sales')),
  entity_id    uuid not null,
  sale_id      uuid references sales(id) on delete set null,
  actor_id     uuid references public.users(id) on delete set null,
  amount       numeric(14,2) not null default 0,
  score        int not null check (score between 0 and 100),
  reasons      jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  status       text not null default 'pendiente' check (status in ('pendiente', 'revisada', 'descartada')),
  review_note  text check (review_note is null or char_length(review_note) <= 500),
  reviewed_by  uuid references public.users(id),
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint risk_flags_entity_key unique (kind, entity_id)
);

comment on table risk_flags is
  'Operaciones marcadas para revisión por riesgo (F16/H82, ADR-091). Las crean los triggers de devoluciones y anulaciones.';

create index if not exists risk_flags_tenant_status_idx on risk_flags(tenant_id, status, created_at desc);
create index if not exists risk_flags_store_idx on risk_flags(store_id);
create index if not exists risk_flags_actor_idx on risk_flags(tenant_id, actor_id, created_at desc);
-- Índices de las FK (guard de rendimiento F4).
create index if not exists risk_flags_actor_fk_idx on risk_flags(actor_id) where actor_id is not null;
create index if not exists risk_flags_sale_idx on risk_flags(sale_id) where sale_id is not null;
create index if not exists risk_flags_reviewed_by_idx on risk_flags(reviewed_by) where reviewed_by is not null;
create index if not exists risk_settings_updated_by_idx on risk_settings(updated_by);

drop trigger if exists set_updated_at_risk_flags on risk_flags;
create trigger set_updated_at_risk_flags
  before update on risk_flags
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- B) RLS
-- -----------------------------------------------------------------------------
alter table risk_settings enable row level security;
alter table risk_flags enable row level security;

drop policy if exists risk_settings_select on risk_settings;
create policy risk_settings_select on risk_settings
  for select using (
    (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))
    or (select internal_scope())
  );

drop policy if exists risk_flags_select on risk_flags;
create policy risk_flags_select on risk_flags
  for select using (
    (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))
    or (select internal_scope())
  );

drop policy if exists risk_flags_branch_scope on risk_flags;
create policy risk_flags_branch_scope on risk_flags
  as restrictive for select
  using (
    (select internal_scope())
    or store_id is null
    or store_id = any ((select user_allowed_store_ids())::uuid[])
  );

do $$
declare
  t text;
begin
  foreach t in array array['risk_settings', 'risk_flags'] loop
    execute format('drop trigger if exists role_write_guard on public.%I', t);
    execute format(
      'create trigger role_write_guard before insert or update or delete on public.%I '
      'for each row execute function trg_role_write_guard(%L)', t, 'manage');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Umbrales efectivos y puntajes
-- -----------------------------------------------------------------------------
create or replace function risk_settings_effective(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'return_amount_high',   coalesce(rs.return_amount_high, 50000),
    'return_days_late',     coalesce(rs.return_days_late, 30),
    'returns_per_user_day', coalesce(rs.returns_per_user_day, 3),
    'voids_per_user_day',   coalesce(rs.voids_per_user_day, 3),
    'discount_pct_high',    coalesce(rs.discount_pct_high, 20),
    'cash_diff_abs',        coalesce(rs.cash_diff_abs, 5000),
    'flag_score_min',       coalesce(rs.flag_score_min, 50)
  )
  from (select 1) one
  left join risk_settings rs on rs.tenant_id = p_tenant;
$$;
revoke all on function risk_settings_effective(uuid) from public, anon, authenticated;

-- Puntaje de una devolución. Espejo de scoreReturn (lib/risk/riskScore.ts).
create or replace function risk_score_return(
  p_settings          jsonb,
  p_amount            numeric,
  p_days_since_sale   numeric,
  p_user_returns_day  int,
  p_cash_no_customer  boolean,
  p_same_user_sold    boolean
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_score   int := 0;
  v_reasons jsonb := '[]'::jsonb;
begin
  if p_amount >= (p_settings ->> 'return_amount_high')::numeric then
    v_score := v_score + 40; v_reasons := v_reasons || '["monto_alto"]'::jsonb;
  end if;
  if p_days_since_sale > (p_settings ->> 'return_days_late')::numeric then
    v_score := v_score + 20; v_reasons := v_reasons || '["fuera_de_plazo"]'::jsonb;
  end if;
  if p_user_returns_day > (p_settings ->> 'returns_per_user_day')::int then
    v_score := v_score + 25; v_reasons := v_reasons || '["devoluciones_repetidas"]'::jsonb;
  end if;
  if p_cash_no_customer then
    v_score := v_score + 15; v_reasons := v_reasons || '["efectivo_sin_cliente"]'::jsonb;
  end if;
  if p_same_user_sold then
    v_score := v_score + 20; v_reasons := v_reasons || '["misma_persona"]'::jsonb;
  end if;
  return jsonb_build_object('score', least(v_score, 100), 'reasons', v_reasons);
end;
$$;

-- Puntaje de una anulación. Espejo de scoreVoid (lib/risk/riskScore.ts).
create or replace function risk_score_void(
  p_settings        jsonb,
  p_amount          numeric,
  p_user_voids_day  int,
  p_minutes_after   numeric,
  p_shift_closed    boolean,
  p_same_user_sold  boolean
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_score   int := 0;
  v_reasons jsonb := '[]'::jsonb;
begin
  if p_amount >= (p_settings ->> 'return_amount_high')::numeric then
    v_score := v_score + 40; v_reasons := v_reasons || '["monto_alto"]'::jsonb;
  end if;
  if p_user_voids_day > (p_settings ->> 'voids_per_user_day')::int then
    v_score := v_score + 30; v_reasons := v_reasons || '["anulaciones_repetidas"]'::jsonb;
  end if;
  if p_minutes_after > 120 then
    v_score := v_score + 15; v_reasons := v_reasons || '["anulada_tarde"]'::jsonb;
  end if;
  if p_shift_closed then
    v_score := v_score + 25; v_reasons := v_reasons || '["turno_cerrado"]'::jsonb;
  end if;
  if p_same_user_sold then
    v_score := v_score + 15; v_reasons := v_reasons || '["misma_persona"]'::jsonb;
  end if;
  return jsonb_build_object('score', least(v_score, 100), 'reasons', v_reasons);
end;
$$;

-- Inserta la marca (idempotente por operación) y la audita. Interno.
create or replace function risk_flag_raise(
  p_tenant uuid, p_store uuid, p_kind text, p_entity_type text, p_entity uuid,
  p_sale uuid, p_actor uuid, p_amount numeric, p_result jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into risk_flags (tenant_id, store_id, kind, entity_type, entity_id, sale_id, actor_id, amount, score, reasons)
  values (p_tenant, p_store, p_kind, p_entity_type, p_entity, p_sale, p_actor, coalesce(p_amount, 0),
          (p_result ->> 'score')::int, coalesce(p_result -> 'reasons', '[]'::jsonb))
  on conflict (kind, entity_id) do nothing
  returning id into v_id;
  if v_id is not null then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (p_tenant, p_actor, 'risk_flags', v_id, 'risk_flag_raised',
            jsonb_build_object('kind', p_kind, 'entity_id', p_entity, 'sale_id', p_sale,
                               'store_id', p_store, 'score', p_result -> 'score',
                               'reasons', p_result -> 'reasons', 'amount', p_amount));
  end if;
end;
$$;
revoke all on function risk_flag_raise(uuid, uuid, text, text, uuid, uuid, uuid, numeric, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Triggers
-- -----------------------------------------------------------------------------
create or replace function trg_risk_flag_return()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ret      record;
  v_sale     record;
  v_settings jsonb;
  v_count    int;
  v_result   jsonb;
  v_actor    uuid;
begin
  begin
    if not tenant_has_feature_for(new.tenant_id, 'prevencion_fraude') then
      return null;
    end if;
    -- Fila final (el total se actualiza después del insert).
    select * into v_ret from sale_returns where id = new.id;
    if v_ret.id is null then
      return null;
    end if;
    select s.id, s.store_id, s.created_at, s.created_by into v_sale from sales s where s.id = v_ret.sale_id;
    v_actor := coalesce(v_ret.created_by, auth.uid());
    v_settings := risk_settings_effective(new.tenant_id);
    select count(*) into v_count
      from sale_returns r
     where r.tenant_id = new.tenant_id
       and r.created_by is not distinct from v_actor
       and r.created_at >= date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires')
                             at time zone 'America/Argentina/Buenos_Aires';
    v_result := risk_score_return(
      v_settings,
      coalesce(v_ret.total, 0),
      extract(epoch from (v_ret.created_at - coalesce(v_sale.created_at, v_ret.created_at))) / 86400.0,
      v_count,
      v_ret.refund_method = 'cash' and v_ret.customer_id is null,
      v_actor is not null and v_sale.created_by is not distinct from v_actor
    );
    if (v_result ->> 'score')::int >= (v_settings ->> 'flag_score_min')::int then
      perform risk_flag_raise(new.tenant_id, v_sale.store_id, 'return', 'sale_returns', v_ret.id,
                              v_ret.sale_id, v_actor, v_ret.total, v_result);
    end if;
  exception when others then
    raise warning 'risk_flag_return: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function trg_risk_flag_return() from public, anon, authenticated;

drop trigger if exists risk_flag_return on sale_returns;
create constraint trigger risk_flag_return
  after insert on sale_returns
  deferrable initially deferred
  for each row execute function trg_risk_flag_return();

create or replace function trg_risk_flag_void()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb;
  v_count    int;
  v_result   jsonb;
  v_actor    uuid;
  v_closed   boolean;
begin
  if new.status <> 'voided' or old.status = 'voided' then
    return null;
  end if;
  begin
    if not tenant_has_feature_for(new.tenant_id, 'prevencion_fraude') then
      return null;
    end if;
    v_actor := coalesce(new.voided_by, auth.uid());
    v_settings := risk_settings_effective(new.tenant_id);
    select count(*) into v_count
      from sales s
     where s.tenant_id = new.tenant_id
       and s.status = 'voided'
       and s.voided_by is not distinct from v_actor
       and s.voided_at >= date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires')
                            at time zone 'America/Argentina/Buenos_Aires';
    select cs.status = 'closed' into v_closed from cash_shifts cs where cs.id = new.cash_shift_id;
    v_result := risk_score_void(
      v_settings,
      coalesce(new.total, 0),
      v_count,
      extract(epoch from (coalesce(new.voided_at, now()) - new.created_at)) / 60.0,
      coalesce(v_closed, false),
      v_actor is not null and new.created_by is not distinct from v_actor
    );
    if (v_result ->> 'score')::int >= (v_settings ->> 'flag_score_min')::int then
      perform risk_flag_raise(new.tenant_id, new.store_id, 'void', 'sales', new.id,
                              new.id, v_actor, new.total, v_result);
    end if;
  exception when others then
    raise warning 'risk_flag_void: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function trg_risk_flag_void() from public, anon, authenticated;

drop trigger if exists risk_flag_void on sales;
create trigger risk_flag_void
  after update of status on sales
  for each row execute function trg_risk_flag_void();

-- -----------------------------------------------------------------------------
-- E) RPC
-- -----------------------------------------------------------------------------
-- Guard: negocio, dueño o encargado, plan.
create or replace function risk_assert_manager()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'prevencion_fraude') then
    raise exception 'feature_not_in_plan: prevencion_fraude' using errcode = 'check_violation';
  end if;
  return v_tenant;
end;
$$;
revoke all on function risk_assert_manager() from public, anon, authenticated;

create or replace function risk_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return risk_settings_effective(risk_assert_manager());
end;
$$;
revoke all on function risk_settings_get() from public, anon;
grant execute on function risk_settings_get() to authenticated;

create or replace function risk_settings_save(p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := risk_assert_manager();
  v_before jsonb := risk_settings_effective(v_tenant);
  v_new    jsonb;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'invalid_settings';
  end if;
  v_new := v_before || (p_settings - array(
    select k from jsonb_object_keys(p_settings) k
     where k not in ('return_amount_high', 'return_days_late', 'returns_per_user_day',
                     'voids_per_user_day', 'discount_pct_high', 'cash_diff_abs', 'flag_score_min')));
  insert into risk_settings (tenant_id, return_amount_high, return_days_late, returns_per_user_day,
                             voids_per_user_day, discount_pct_high, cash_diff_abs, flag_score_min, updated_by)
  values (v_tenant,
          (v_new ->> 'return_amount_high')::numeric, (v_new ->> 'return_days_late')::int,
          (v_new ->> 'returns_per_user_day')::int, (v_new ->> 'voids_per_user_day')::int,
          (v_new ->> 'discount_pct_high')::numeric, (v_new ->> 'cash_diff_abs')::numeric,
          (v_new ->> 'flag_score_min')::int, auth.uid())
  on conflict (tenant_id) do update
    set return_amount_high   = excluded.return_amount_high,
        return_days_late     = excluded.return_days_late,
        returns_per_user_day = excluded.returns_per_user_day,
        voids_per_user_day   = excluded.voids_per_user_day,
        discount_pct_high    = excluded.discount_pct_high,
        cash_diff_abs        = excluded.cash_diff_abs,
        flag_score_min       = excluded.flag_score_min,
        updated_by           = auth.uid();
  v_new := risk_settings_effective(v_tenant);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'risk_settings', null, 'risk_settings_updated', v_before, v_new);
  return v_new;
end;
$$;
revoke all on function risk_settings_save(jsonb) from public, anon;
grant execute on function risk_settings_save(jsonb) to authenticated;

create or replace function risk_flag_review(p_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := risk_assert_manager();
  v_flag   risk_flags;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_status not in ('revisada', 'descartada', 'pendiente') then
    raise exception 'invalid_status';
  end if;
  if p_status = 'descartada' and v_note is null then
    raise exception 'note_required';
  end if;
  select * into v_flag from risk_flags where id = p_id and tenant_id = v_tenant for update;
  if v_flag.id is null then
    raise exception 'flag_not_found';
  end if;
  if v_flag.store_id is not null and not coalesce(user_can_access_store(v_flag.store_id), false) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  update risk_flags
     set status = p_status,
         review_note = left(v_note, 500),
         reviewed_by = case when p_status = 'pendiente' then null else auth.uid() end,
         reviewed_at = case when p_status = 'pendiente' then null else now() end
   where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'risk_flags', p_id, 'risk_flag_reviewed',
          jsonb_build_object('status', v_flag.status, 'store_id', v_flag.store_id),
          jsonb_build_object('status', p_status, 'store_id', v_flag.store_id), v_note);
end;
$$;
revoke all on function risk_flag_review(uuid, text, text) from public, anon;
grant execute on function risk_flag_review(uuid, text, text) to authenticated;

-- Señales por persona en un rango (máximo 92 días). Acotado a las sucursales
-- del usuario (report_store_filter).
create or replace function operational_risk_signals(
  p_from     timestamptz,
  p_to       timestamptz,
  p_store_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := risk_assert_manager();
  v_stores uuid[] := report_store_filter(p_store_id);
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'invalid_range';
  end if;
  if p_to - p_from > interval '92 days' then
    raise exception 'range_too_long';
  end if;

  return jsonb_build_object(
    'settings', risk_settings_effective(v_tenant),
    'people', coalesce((
      with
      sl as (
        select s.created_by as user_id,
               count(*) filter (where s.status = 'completed') as sales_count,
               coalesce(sum(s.total) filter (where s.status = 'completed'), 0) as sales_total,
               coalesce(sum(s.subtotal) filter (where s.status = 'completed'), 0) as sales_subtotal,
               coalesce(sum(coalesce(s.discount_total, 0)) filter (where s.status = 'completed'), 0) as discount_total,
               count(*) filter (where s.status = 'completed'
                                  and s.subtotal > 0 and coalesce(s.discount_total, 0) > 0) as discounted_sales
          from sales s
         where s.tenant_id = v_tenant
           and s.created_at >= p_from and s.created_at < p_to
           and (v_stores is null or s.store_id = any (v_stores))
         group by s.created_by
      ),
      vd as (
        select s.voided_by as user_id, count(*) as voids_count, coalesce(sum(s.total), 0) as voids_total
          from sales s
         where s.tenant_id = v_tenant and s.status = 'voided'
           and s.voided_at >= p_from and s.voided_at < p_to
           and (v_stores is null or s.store_id = any (v_stores))
         group by s.voided_by
      ),
      rt as (
        select r.created_by as user_id, count(*) as returns_count, coalesce(sum(r.total), 0) as returns_total
          from sale_returns r
          join sales s on s.id = r.sale_id
         where r.tenant_id = v_tenant
           and r.created_at >= p_from and r.created_at < p_to
           and (v_stores is null or s.store_id = any (v_stores))
         group by r.created_by
      ),
      tx as (
        select t.created_by as user_id, count(*) as rejected_payments
          from terminal_transactions t
         where t.tenant_id = v_tenant
           and t.status in ('declined', 'error', 'timeout')
           and t.created_at >= p_from and t.created_at < p_to
           and (v_stores is null or t.store_id = any (v_stores))
         group by t.created_by
      ),
      cd as (
        select cs.closed_by as user_id,
               count(*) as shifts_closed,
               coalesce(sum(abs(cs.difference)), 0) as cash_diff_total,
               count(*) filter (where abs(coalesce(cs.difference, 0))
                                  > (risk_settings_effective(v_tenant) ->> 'cash_diff_abs')::numeric) as cash_diff_shifts
          from cash_shifts cs
         where cs.tenant_id = v_tenant and cs.status = 'closed'
           and cs.closed_at >= p_from and cs.closed_at < p_to
           and (v_stores is null or cs.store_id = any (v_stores))
         group by cs.closed_by
      ),
      fl as (
        select f.actor_id as user_id, count(*) filter (where f.status = 'pendiente') as flags_pending,
               count(*) as flags_total
          from risk_flags f
         where f.tenant_id = v_tenant
           and f.created_at >= p_from and f.created_at < p_to
           and (v_stores is null or f.store_id is null or f.store_id = any (v_stores))
         group by f.actor_id
      ),
      ids as (
        select user_id from sl union select user_id from vd union select user_id from rt
        union select user_id from tx union select user_id from cd union select user_id from fl
      )
      select jsonb_agg(jsonb_build_object(
               'user_id', ids.user_id,
               'name', coalesce(nullif(btrim(u.full_name), ''), u.email, 'Sin usuario'),
               'sales_count', coalesce(sl.sales_count, 0),
               'sales_total', coalesce(sl.sales_total, 0),
               'sales_subtotal', coalesce(sl.sales_subtotal, 0),
               'discount_total', coalesce(sl.discount_total, 0),
               'discounted_sales', coalesce(sl.discounted_sales, 0),
               'voids_count', coalesce(vd.voids_count, 0),
               'voids_total', coalesce(vd.voids_total, 0),
               'returns_count', coalesce(rt.returns_count, 0),
               'returns_total', coalesce(rt.returns_total, 0),
               'rejected_payments', coalesce(tx.rejected_payments, 0),
               'shifts_closed', coalesce(cd.shifts_closed, 0),
               'cash_diff_total', coalesce(cd.cash_diff_total, 0),
               'cash_diff_shifts', coalesce(cd.cash_diff_shifts, 0),
               'flags_pending', coalesce(fl.flags_pending, 0),
               'flags_total', coalesce(fl.flags_total, 0)
             ) order by coalesce(fl.flags_pending, 0) desc, coalesce(vd.voids_count, 0) desc)
        from ids
        left join public.users u on u.id = ids.user_id
        left join sl on sl.user_id is not distinct from ids.user_id
        left join vd on vd.user_id is not distinct from ids.user_id
        left join rt on rt.user_id is not distinct from ids.user_id
        left join tx on tx.user_id is not distinct from ids.user_id
        left join cd on cd.user_id is not distinct from ids.user_id
        left join fl on fl.user_id is not distinct from ids.user_id
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function operational_risk_signals(timestamptz, timestamptz, uuid) from public, anon;
grant execute on function operational_risk_signals(timestamptz, timestamptz, uuid) to authenticated;
