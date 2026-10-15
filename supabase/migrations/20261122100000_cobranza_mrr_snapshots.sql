-- =============================================================================
-- 20261122100000_cobranza_mrr_snapshots  (F20-2 · H128 · ADR-126)
--
-- Snapshots diarios de MRR y KPIs de cobranza (spec docs/40-cobranza-saas.md
-- §6.5, §13.2 y §15).
--
--   · platform_mrr_snapshots  una fila por negocio y día: plan, ciclo, estado,
--                             modalidad, motivo de exclusión, MRR normalizado
--                             a mes y si es cuenta paga ese día.
--   · platform_mrr_daily      el agregado del día (MRR de las cuentas pagas,
--                             cantidad, MRR en mora, trials, excluidas).
--   · platform_mrr_state(d)   foto de un día: el estado de cada suscripción
--                             al cierre del día (hora Argentina) sale de la
--                             auditoría (before_data del primer UPDATE
--                             posterior; si no hubo, la fila actual), y el
--                             MRR con platform_mrr_cents (mismo cálculo que
--                             platform_billing_breakdown, con plan y ciclo de
--                             ese día).
--   · platform_mrr_snapshot_run()  cron diario 00:10 ART: completa desde el
--                             último día guardado hasta ayer (máximo 400 días),
--                             así un cron caído se recupera solo. La misma
--                             función hace el backfill al aplicar.
--   · internal_billing_kpis(meses)  insumos de los KPIs: snapshots de los
--                             cierres de mes (y la foto en vivo de hoy),
--                             cobrado bruto, comisiones y reversas por mes,
--                             efectividad por mes de vencimiento, deuda abierta
--                             y lo cargado en los últimos 90 días. El cálculo
--                             (movimiento de MRR, NRR, GRR, aging, DSO,
--                             efectividad) es puro y vive en
--                             lib/billing/kpis.ts (tests en
--                             tests/unit/billingKpis.test.ts).
--
-- Cuenta paga (§15.2): status active o past_due, sin exclusión y MRR > 0.
-- Exclusiones (§22 #7, mismo orden que platform_billing_exclusion): dado de
-- baja a esa fecha, de prueba (tenants.is_test), dueño staff, lifetime (del
-- estado de ese día) y exento.
--
-- Backfill (aproximaciones documentadas en ADR-126): plan, ciclo, estado y
-- lifetime salen de la auditoría de subscriptions (exactos); is_test, dueño
-- staff y exento son los de hoy; los addons, los vigentes a la fecha según su
-- alta y su ventana paga actual; los descuentos, con su vigencia real.
--
-- RLS: las dos tablas sin políticas ni grants para anon/authenticated. Se leen
-- sólo por internal_billing_kpis, que exige el rol de cobranza (Cobranzas,
-- admin o super_admin) bajo (select internal_scope()) (ADR-052, ADR-115).
--
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tablas
-- -----------------------------------------------------------------------------
create table if not exists platform_mrr_snapshots (
  id              uuid primary key default gen_random_uuid(),
  day             date not null,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  subscription_id uuid,
  plan_key        text,
  billing_cycle   text,
  status          text,
  billing_mode    text,
  -- null = cuenta comercial; si no: deleted, test, staff_owned, lifetime, exempt.
  exclusion       text,
  -- Monto recurrente mensual normalizado (IVA incluido, §22 #2), aunque no sea
  -- cuenta paga ese día. El MRR del día es la suma de las filas is_paying.
  mrr_cents       bigint not null default 0 check (mrr_cents >= 0),
  is_paying       boolean not null default false,
  exempt          boolean not null default false,
  source          text not null default 'cron' check (source in ('cron', 'backfill')),
  computed_at     timestamptz not null default now(),
  constraint platform_mrr_snapshots_tenant_day unique (tenant_id, day)
);
create index if not exists platform_mrr_snapshots_day_idx on platform_mrr_snapshots (day);
create index if not exists platform_mrr_snapshots_paying_idx
  on platform_mrr_snapshots (tenant_id, day) where is_paying;

create table if not exists platform_mrr_daily (
  day                date primary key,
  mrr_cents          bigint not null default 0,
  paying_accounts    int not null default 0,
  past_due_mrr_cents bigint not null default 0,
  trial_accounts     int not null default 0,
  excluded_accounts  int not null default 0,
  source             text not null default 'cron' check (source in ('cron', 'backfill')),
  computed_at        timestamptz not null default now()
);

comment on table platform_mrr_snapshots is
  'F20-2 (ADR-126): foto diaria del MRR por negocio. La escribe platform_mrr_snapshot_run (cron platform-mrr-snapshot). Sólo se lee por internal_billing_kpis.';
comment on table platform_mrr_daily is
  'F20-2 (ADR-126): agregado diario de platform_mrr_snapshots (MRR de cuentas pagas, cantidad, mora, trials, excluidas).';

alter table platform_mrr_snapshots enable row level security;
alter table platform_mrr_daily enable row level security;
revoke all on table platform_mrr_snapshots, platform_mrr_daily from anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) MRR de un negocio con un plan y un ciclo dados, a una fecha
--    Mismo cálculo que platform_billing_breakdown (20261113100000): plan del
--    ciclo (anual = yearly o mensual × 12), addons comprados vigentes (× 12 en
--    el anual), porcentajes sobre el bruto y después los fijos (× 12 en el
--    anual), nunca negativo; normalizado a mes (anual / 12). Espejo en TS:
--    accountMrr (lib/internal/saasKpis.ts) y billingTotal (lib/billing/ledger.ts).
-- -----------------------------------------------------------------------------
create or replace function platform_mrr_cents(p_tenant uuid, p_plan uuid, p_cycle text, p_day date)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with pl as (
    select case when p_cycle = 'yearly'
                then coalesce(nullif(p.yearly_price_ars, 0), p.monthly_price_ars * 12)
                else p.monthly_price_ars end as amount
      from plans p
     where p.id = p_plan
  ),
  ad as (
    select coalesce(sum(case when sa.source = 'granted' then 0
                             else coalesce(sa.monthly_price_ars, pa.monthly_price_ars, 0) end), 0) as monthly
      from subscription_addons sa
      left join plan_addons pa on pa.key = sa.addon_key
     where sa.tenant_id = p_tenant
       and sa.created_at < ((p_day + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
       and (sa.status = 'active'
            or (sa.cancel_at_period_end
                and sa.current_period_end is not null
                and sa.current_period_end::date >= p_day))
  ),
  di as (
    select least(100, coalesce(sum(d.value) filter (where d.kind = 'percent'), 0)) as pct,
           coalesce(sum(d.value) filter (where d.kind = 'fixed'), 0) as fixed
      from tenant_discounts d
     where d.tenant_id = p_tenant
       and d.deleted_at is null
       and d.value > 0
       and d.valid_from <= p_day
       and (d.valid_until is null or d.valid_until >= p_day)
  ),
  g as (
    select coalesce((select amount from pl), 0)
             + case when p_cycle = 'yearly' then ad.monthly * 12 else ad.monthly end as gross,
           di.pct,
           case when p_cycle = 'yearly' then di.fixed * 12 else di.fixed end as fixed
      from ad cross join di
  )
  select greatest(0, round(
           (g.gross - least(g.gross, round(g.gross * g.pct / 100, 2) + g.fixed)) * 100
           / case when p_cycle = 'yearly' then 12 else 1 end))::bigint
    from g;
$$;

-- -----------------------------------------------------------------------------
-- C) Foto de un día (estado al cierre del día, hora Argentina)
-- -----------------------------------------------------------------------------
create or replace function platform_mrr_state(p_day date)
returns table (
  tenant_id       uuid,
  subscription_id uuid,
  plan_key        text,
  billing_cycle   text,
  status          text,
  billing_mode    text,
  exclusion       text,
  mrr_cents       bigint,
  is_paying       boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
#variable_conflict use_column
declare
  v_end timestamptz := ((p_day + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires');
begin
  return query
  with nxt as (
    -- Primer UPDATE de cada suscripción después del cierre del día: su
    -- before_data es el estado de ese cierre (índice parcial de 20261111300000).
    select distinct on (a.entity_id) a.entity_id, a.before_data
      from audit_logs a
     where a.entity_type = 'subscriptions'
       and a.action = 'UPDATE'
       and a.created_at >= v_end
       and a.before_data is not null
     order by a.entity_id, a.created_at, a.id
  ),
  st as (
    select s.id as sid, s.tenant_id as tid,
           coalesce(n.before_data, to_jsonb(s)) as d
      from subscriptions s
      left join nxt n on n.entity_id = s.id
     where s.created_at < v_end
  ),
  ex as (
    select st.sid, st.tid, st.d,
           (st.d ->> 'status') as st_status,
           nullif(st.d ->> 'plan_id', '')::uuid as st_plan,
           coalesce(nullif(st.d ->> 'billing_cycle', ''), 'monthly') as st_cycle,
           case
             when t.deleted_at is not null and t.deleted_at < v_end then 'deleted'
             when t.is_test then 'test'
             when exists (
               select 1
                 from tenant_users tu
                 join users u on u.id = tu.user_id
                where tu.tenant_id = t.id
                  and tu.role = 'owner'
                  and tu.status = 'active'
                  and u.internal_level is not null
             ) then 'staff_owned'
             when coalesce((st.d ->> 'is_lifetime')::boolean, false) then 'lifetime'
             when bt.billing_mode = 'exempt' then 'exempt'
           end as st_excl,
           bt.billing_mode as bt_mode
      from st
      join tenants t on t.id = st.tid
      left join tenant_billing_terms bt on bt.tenant_id = st.tid
  )
  select ex.tid, ex.sid, p.key, ex.st_cycle, ex.st_status,
         case when ex.st_excl is not null then 'exempt'
              when ex.bt_mode is not null then ex.bt_mode
              when nullif(ex.d ->> 'mp_preapproval_id', '') is not null then 'mp_subscription'
              else 'manual' end,
         ex.st_excl,
         m.cents,
         (ex.st_status in ('active', 'past_due') and ex.st_excl is null and m.cents > 0)
    from ex
    left join plans p on p.id = ex.st_plan
    cross join lateral (select coalesce(platform_mrr_cents(ex.tid, ex.st_plan, ex.st_cycle, p_day), 0) as cents) m;
end;
$fn$;

-- -----------------------------------------------------------------------------
-- D) Escritura de un día y corrida del cron
-- -----------------------------------------------------------------------------
create or replace function platform_mrr_snapshot_day(p_day date, p_source text default 'cron')
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_n int;
begin
  insert into platform_mrr_snapshots (day, tenant_id, subscription_id, plan_key, billing_cycle, status,
                                      billing_mode, exclusion, mrr_cents, is_paying, exempt, source)
  select p_day, s.tenant_id, s.subscription_id, s.plan_key, s.billing_cycle, s.status,
         s.billing_mode, s.exclusion, s.mrr_cents, s.is_paying, s.exclusion is not null, p_source
    from platform_mrr_state(p_day) s
  on conflict (tenant_id, day) do update
     set subscription_id = excluded.subscription_id,
         plan_key        = excluded.plan_key,
         billing_cycle   = excluded.billing_cycle,
         status          = excluded.status,
         billing_mode    = excluded.billing_mode,
         exclusion       = excluded.exclusion,
         mrr_cents       = excluded.mrr_cents,
         is_paying       = excluded.is_paying,
         exempt          = excluded.exempt,
         source          = excluded.source,
         computed_at     = now();
  get diagnostics v_n = row_count;

  insert into platform_mrr_daily (day, mrr_cents, paying_accounts, past_due_mrr_cents, trial_accounts,
                                  excluded_accounts, source)
  select p_day,
         coalesce(sum(s.mrr_cents) filter (where s.is_paying), 0),
         count(*) filter (where s.is_paying),
         coalesce(sum(s.mrr_cents) filter (where s.is_paying and s.status = 'past_due'), 0),
         count(*) filter (where s.exclusion is null and s.status = 'trial'),
         count(*) filter (where s.exclusion is not null and s.exclusion <> 'deleted'),
         p_source
    from platform_mrr_snapshots s
   where s.day = p_day
  on conflict (day) do update
     set mrr_cents          = excluded.mrr_cents,
         paying_accounts    = excluded.paying_accounts,
         past_due_mrr_cents = excluded.past_due_mrr_cents,
         trial_accounts     = excluded.trial_accounts,
         excluded_accounts  = excluded.excluded_accounts,
         source             = excluded.source,
         computed_at        = now();
  return v_n;
end;
$fn$;

-- Completa los días que faltan hasta p_until (por defecto, ayer en Argentina).
-- Sin snapshots previos arranca en el alta de la primera suscripción; nunca
-- más de 400 días hacia atrás. Idempotente y serializado con un advisory lock.
create or replace function platform_mrr_snapshot_run(p_until date default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_until date := coalesce(p_until, platform_ar_date(now()) - 1);
  v_from  date;
  v_last  date;
  v_d     date;
  v_days  int := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('platform_mrr_snapshot_run', 0));
  select max(day) into v_last from platform_mrr_daily;
  if v_last is not null then
    v_from := v_last + 1;
  else
    select platform_ar_date(min(s.created_at)) into v_from from subscriptions s;
  end if;
  if v_from is null then
    return 0;
  end if;
  v_from := greatest(v_from, v_until - 399);
  v_d := v_from;
  while v_d <= v_until loop
    perform platform_mrr_snapshot_day(v_d, case when p_until is null and v_d = v_until then 'cron' else 'backfill' end);
    v_days := v_days + 1;
    v_d := v_d + 1;
  end loop;
  return v_days;
end;
$fn$;

revoke all on function platform_mrr_cents(uuid, uuid, text, date) from public, anon, authenticated;
revoke all on function platform_mrr_state(date) from public, anon, authenticated;
revoke all on function platform_mrr_snapshot_day(date, text) from public, anon, authenticated;
revoke all on function platform_mrr_snapshot_run(date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- E) Insumos de los KPIs (sólo rol de cobranza en el panel interno)
-- -----------------------------------------------------------------------------
-- p_months: meses del gráfico (1 a 24, default 12), contando el actual.
-- Devuelve:
--   · boundaries: cierres de mes (el día anterior al primer mes, el último día
--     de cada mes cerrado y hoy en vivo), cada uno con available y las filas
--     de los negocios que fueron cuenta paga en algún cierre de la ventana
--     (tenant_id, mrr_cents, paying, status, plan_key, last_paying_day).
--   · first_paying_day por negocio (para separar nuevo de reactivación).
--   · collections por mes: pagos (bruto y comisiones) y reversas.
--   · effectiveness por mes de vencimiento: debe que vencía, lo condonado o
--     anulado y lo imputado con pagos hasta el cierre del mes.
--   · open_debits: debe abierto por negocio y vencimiento (aging y DSO).
--   · billed_90d_cents: cargos, punitorios y ajustes al debe de los últimos 90
--     días, menos anulaciones (base del DSO mientras no haya facturas, F20-4).
-- Todo sin los negocios excluidos hoy (§22 #7).
create or replace function internal_billing_kpis(p_months int default 12)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role   text := platform_staff_billing_role();
  v_today  date := platform_ar_date(now());
  v_m      int := least(greatest(coalesce(p_months, 12), 1), 24);
  v_first  date;
  v_bounds jsonb;
  v_first_paid jsonb;
  v_coll   jsonb;
  v_eff    jsonb;
  v_open   jsonb;
  v_billed bigint;
  v_excl   int;
  v_since  date;
begin
  if v_role is null or v_role not in ('cobranzas', 'admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_first := (date_trunc('month', v_today) - make_interval(months => v_m - 1))::date;
  select min(day) into v_since from platform_mrr_daily;

  -- Negocios excluidos hoy: fuera de cobrado, efectividad y deuda.
  create temporary table if not exists _kpi_excl (tenant_id uuid primary key) on commit drop;
  truncate _kpi_excl;
  insert into _kpi_excl
  select t.id from tenants t where platform_billing_exclusion(t.id) is not null;
  select count(*) into v_excl from _kpi_excl e join tenants t on t.id = e.tenant_id where t.deleted_at is null;

  -- Cierres: el día anterior al primer mes, el último día de cada mes cerrado
  -- y hoy (en vivo).
  create temporary table if not exists _kpi_b (day date primary key, live boolean, available boolean) on commit drop;
  truncate _kpi_b;
  insert into _kpi_b (day, live, available)
  select b.d, false, exists (select 1 from platform_mrr_daily d where d.day = b.d)
    from (
      select (gs::date - 1) as d
        from generate_series(v_first, date_trunc('month', v_today)::date, interval '1 month') gs
    ) b
   where b.d < v_today;
  insert into _kpi_b (day, live, available) values (v_today, true, true)
  on conflict (day) do nothing;

  create temporary table if not exists _kpi_r (
    day date, tenant_id uuid, mrr_cents bigint, is_paying boolean, status text, plan_key text
  ) on commit drop;
  truncate _kpi_r;
  insert into _kpi_r
  select s.day, s.tenant_id, s.mrr_cents, s.is_paying, s.status, s.plan_key
    from platform_mrr_snapshots s
    join _kpi_b b on b.day = s.day and not b.live;
  insert into _kpi_r
  select v_today, x.tenant_id, x.mrr_cents, x.is_paying, x.status, x.plan_key
    from platform_mrr_state(v_today) x;

  -- Sólo los negocios que fueron cuenta paga en algún cierre de la ventana.
  delete from _kpi_r r
   where not exists (select 1 from _kpi_r p where p.tenant_id = r.tenant_id and p.is_paying);

  select coalesce(jsonb_agg(jsonb_build_object(
           'day', b.day, 'live', b.live, 'available', b.available,
           'rows', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'tenant_id', r.tenant_id, 'mrr_cents', r.mrr_cents, 'paying', r.is_paying,
                      'status', r.status, 'plan_key', r.plan_key,
                      'last_paying_day', case
                        when r.is_paying then r.day
                        else (select max(s.day) from platform_mrr_snapshots s
                               where s.tenant_id = r.tenant_id and s.is_paying and s.day <= r.day) end)
                    order by r.tenant_id)
               from _kpi_r r
              where r.day = b.day), '[]'::jsonb))
         order by b.day), '[]'::jsonb)
    into v_bounds
    from _kpi_b b;

  select coalesce(jsonb_object_agg(f.tenant_id, f.d), '{}'::jsonb)
    into v_first_paid
    from (
      select r.tenant_id,
             least(coalesce((select min(s.day) from platform_mrr_snapshots s
                              where s.tenant_id = r.tenant_id and s.is_paying), v_today),
                   case when bool_or(r.is_paying and r.day = v_today) then v_today end) as d
        from _kpi_r r
       group by r.tenant_id
    ) f;

  -- Cobrado por mes (pagos aprobados alguna vez, por fecha de pago).
  select coalesce(jsonb_agg(jsonb_build_object(
           'month', to_char(m.d, 'YYYY-MM'),
           'payments', coalesce(p.n, 0),
           'gross_cents', coalesce(p.gross, 0),
           'fee_cents', coalesce(p.fee, 0),
           'reversal_cents', coalesce(r.rev, 0)) order by m.d), '[]'::jsonb)
    into v_coll
    from (select gs::date as d from generate_series(v_first, date_trunc('month', v_today)::date, interval '1 month') gs) m
    left join lateral (
      select count(*) as n, sum(pp.amount_cents) as gross, sum(coalesce(pp.fee_cents, 0)) as fee
        from platform_payments pp
       where pp.status in ('approved', 'refunded', 'partially_refunded', 'charged_back', 'in_dispute')
         and platform_ar_date(pp.paid_at) >= m.d
         and platform_ar_date(pp.paid_at) < (m.d + interval '1 month')::date
         and not exists (select 1 from _kpi_excl e where e.tenant_id = pp.tenant_id)
    ) p on true
    left join lateral (
      select sum(l.amount_cents) as rev
        from platform_ledger l
       where l.kind in ('refund', 'payment_reversal')
         and l.effective_date >= m.d
         and l.effective_date < (m.d + interval '1 month')::date
         and not exists (select 1 from _kpi_excl e where e.tenant_id = l.tenant_id)
    ) r on true;

  -- Efectividad por mes de vencimiento (en el mes actual, sólo lo vencido a hoy).
  select coalesce(jsonb_agg(jsonb_build_object(
           'month', to_char(m.d, 'YYYY-MM'),
           'due_cents', coalesce(x.due, 0),
           'forgiven_cents', coalesce(x.forgiven, 0),
           'collected_cents', coalesce(x.collected, 0)) order by m.d), '[]'::jsonb)
    into v_eff
    from (select gs::date as d,
                 least((gs + interval '1 month')::date - 1, v_today) as last_day
            from generate_series(v_first, date_trunc('month', v_today)::date, interval '1 month') gs) m
    left join lateral (
      select sum(l.amount_cents) as due,
             sum((select coalesce(sum(a.amount_cents), 0)
                    from platform_allocations a
                    join platform_ledger c on c.id = a.credit_movement_id
                   where a.debit_movement_id = l.id and a.released_at is null
                     and c.kind <> 'payment')) as forgiven,
             sum((select coalesce(sum(a.amount_cents), 0)
                    from platform_allocations a
                    join platform_ledger c on c.id = a.credit_movement_id
                   where a.debit_movement_id = l.id and a.released_at is null
                     and c.kind = 'payment' and c.effective_date <= m.last_day)) as collected
        from platform_ledger l
       where l.kind in ('charge', 'interest', 'adjustment_debit')
         and coalesce(l.due_date, l.effective_date) >= m.d
         and coalesce(l.due_date, l.effective_date) <= m.last_day
         and not exists (select 1 from _kpi_excl e where e.tenant_id = l.tenant_id)
    ) x on true;

  -- Debe abierto (vencido y a vencer).
  select coalesce(jsonb_agg(jsonb_build_object(
           'tenant_id', o.tenant_id, 'due_date', o.due, 'open_cents', o.open_cents)
           order by o.due, o.tenant_id), '[]'::jsonb)
    into v_open
    from (
      select l.tenant_id, coalesce(l.due_date, l.effective_date) as due,
             l.amount_cents - coalesce((select sum(a.amount_cents) from platform_allocations a
                                         where a.debit_movement_id = l.id and a.released_at is null), 0) as open_cents
        from platform_ledger l
       where l.amount_cents > 0
         and not exists (select 1 from _kpi_excl e where e.tenant_id = l.tenant_id)
    ) o
   where o.open_cents > 0;

  select coalesce(sum(l.amount_cents) filter (where l.kind in ('charge', 'interest', 'adjustment_debit')), 0)
         + coalesce(sum(l.amount_cents) filter (where l.kind = 'charge_void'), 0)
    into v_billed
    from platform_ledger l
   where l.effective_date > v_today - 90
     and l.effective_date <= v_today
     and not exists (select 1 from _kpi_excl e where e.tenant_id = l.tenant_id);

  return jsonb_build_object(
    'as_of', v_today,
    'months', v_m,
    'snapshots_since', v_since,
    'excluded_count', v_excl,
    'boundaries', v_bounds,
    'first_paying_day', v_first_paid,
    'collections', v_coll,
    'effectiveness', v_eff,
    'open_debits', v_open,
    'billed_90d_cents', greatest(v_billed, 0)
  );
end;
$fn$;

comment on function internal_billing_kpis(int) is
  'F20-2 (ADR-126): insumos de los KPIs de MRR y cobranza. Sólo Cobranzas, admin o super_admin bajo internal_scope(). El cálculo vive en lib/billing/kpis.ts.';

revoke all on function internal_billing_kpis(int) from public, anon;
grant execute on function internal_billing_kpis(int) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Backfill (ventana de hasta 400 días hasta ayer)
-- -----------------------------------------------------------------------------
-- Con fecha explícita: todos los días quedan marcados 'backfill'.
select platform_mrr_snapshot_run(platform_ar_date(now()) - 1);

-- -----------------------------------------------------------------------------
-- G) pg_cron: diario 00:10 ART (03:10 UTC). Sin pg_cron (local, CI) se omite.
-- -----------------------------------------------------------------------------
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite platform-mrr-snapshot.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'platform-mrr-snapshot') then
    perform cron.unschedule('platform-mrr-snapshot');
  end if;
  perform cron.schedule('platform-mrr-snapshot', '10 3 * * *', $$select public.platform_mrr_snapshot_run()$$);
end
$cron$;
