-- =============================================================================
-- 20261224100000_addon_email_cobro  (ADR-156)
--
-- 1) Complemento "Email con dominio NinjaSoft" (ADDON, tabla de addons; no se
--    gatea por plans.limits.modules):
--    · plan_addons 'email_ninjasoft' (arranca no disponible hasta que el staff
--      verifica el dominio y carga al menos un escalón).
--    · email_addon_settings (fila única): dominio remitente, formato del
--      remitente, política al pasar el cupo y estado del dominio en Resend. La
--      API key vive en platform_secrets 'email_addon' (sólo service_role; la
--      escribe la Edge email_addon_admin después de probarla contra Resend).
--    · email_addon_tiers: escalones (emails por mes y precio).
--    · subscription_addons suma tier_id, quota_monthly, el cambio de escalón
--      programado (pending_*) y trial_ends_at (prueba del complemento IA).
--    · email_addon_usage: contador por negocio y mes (hora de Argentina), con
--      avisos al 80 % y al 100 % una sola vez por mes.
--    · email_addon_consume / email_addon_release: la única puerta de envío
--      (service_role, desde _shared/ninjaEmail.ts). Bloquea, avisa o cuenta
--      el excedente según la política.
--    · email_addon_bill_overage: el día 1 carga el excedente del mes anterior
--      en la cuenta corriente (cargo 'addon', entra al próximo débito de MP).
--    · RPC del dueño: oferta, cotización y alta/cambio de escalón con el precio
--      que vio (price_changed). RPC del staff: configuración y escalones.
--
-- 2) Arreglos del cobro (auditoría de ADR-156, hallazgos C1 a M4 del ADR):
--    · C1  Un complemento dado de baja seguía 'active' para siempre: se cobraba
--          en cada período (cuenta corriente y monto de MP) y seguía habilitado.
--          Ahora se factura sólo si el fin de su período es posterior a la
--          fecha del cobro, el acceso dura hasta ese día inclusive y el cron
--          diario platform-addons-daily lo pasa a 'cancelled'.
--    · C1b cancel_addon tomaba el fin de período guardado en el addon (viejo
--          después de cada renovación) y podía cortarlo en el acto: ahora usa
--          el período vigente de la suscripción.
--    · H1  El monto de MP no se recalculaba nunca solo (bajas que vencen,
--          descuentos que empiezan o terminan, prueba del addon IA): monto
--          esperado del próximo débito (platform_mp_expected_amount) y
--          sincronización diaria por la Edge (platform-mp-amount-sync).
--    · H2  El prorrateo de un addon o de un upgrade quedaba como deuda en la
--          cuenta corriente de un negocio con débito automático (MP cobra el
--          monto fijo) y la escalera de mora lo perseguía: el monto esperado
--          suma esos ajustes al próximo débito y vuelve al normal después.
--    · H3  Un negocio en prueba que pagaba antes de terminarla quedaba con
--          tenants.status = 'trial' y el cron de prueba vencida lo daba de
--          baja: reanchor_subscription_period lo pasa a 'active'.
--    · H4  Con el débito diferido al fin de la prueba (start_date en el
--          checkout), la prueba vencida no da de baja a quien ya autorizó el
--          débito: espera 5 días al primer cobro.
--    · M1  "X días gratis" del Asistente IA no se aplicaba: trial_ends_at.
--    · M2  activate_addon con la suscripción suspendida, cancelada o con baja
--          programada: ahora se rechaza.
--
-- Multi-tenant: las tablas nuevas tienen RLS sin policies (todo por RPC
-- SECURITY DEFINER). Staff por internal_scope() + nivel admin/super_admin,
-- nunca is_internal() suelto. Auditoría en audit_logs.
-- NO aplicar sin revisar el ADR-156 (sección "Cómo aplicar").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Catálogo, configuración y escalones
-- -----------------------------------------------------------------------------
insert into plan_addons (key, label, description, monthly_price_ars, is_active)
values ('email_ninjasoft', 'Email con dominio NinjaSoft',
        'Tus comprobantes, presupuestos y avisos salen desde una casilla @soft.ninja con respuesta a tu email, sin configurar nada.',
        0, false)
on conflict (key) do nothing;

create table if not exists email_addon_settings (
  id                      boolean primary key default true check (id),
  domain                  text not null default 'soft.ninja'
                            check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  -- business: {negocio}@dominio · fixed: {fixed_local}@dominio. Siempre con
  -- respuesta (reply-to) al email del negocio.
  sender_mode             text not null default 'business' check (sender_mode in ('business', 'fixed')),
  fixed_local             text not null default 'notificaciones'
                            check (fixed_local ~ '^[a-z0-9]([a-z0-9._-]{0,38}[a-z0-9])?$'),
  overage_policy          text not null default 'block' check (overage_policy in ('block', 'warn', 'charge')),
  overage_block_size      int not null default 1000 check (overage_block_size between 1 and 1000000),
  overage_block_price_ars numeric(12,2) not null default 0 check (overage_block_price_ars >= 0),
  key_source              text check (key_source in ('own', 'system')),
  key_hint                text,
  key_checked_at          timestamptz,
  domain_id               text,
  domain_status           text,
  domain_region           text,
  dns_records             jsonb not null default '[]'::jsonb,
  domain_checked_at       timestamptz,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references users(id)
);
alter table email_addon_settings enable row level security;  -- sin policies: sólo RPC
insert into email_addon_settings (id) values (true) on conflict (id) do nothing;

create table if not exists email_addon_tiers (
  id                uuid primary key default gen_random_uuid(),
  label             text not null check (length(btrim(label)) between 1 and 60),
  monthly_quota     int not null check (monthly_quota between 1 and 10000000),
  monthly_price_ars numeric(12,2) not null check (monthly_price_ars > 0),
  sort              int not null default 0,
  is_active         boolean not null default true,
  created_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
alter table email_addon_tiers enable row level security;  -- sin policies: sólo RPC

alter table subscription_addons add column if not exists tier_id uuid references email_addon_tiers(id);
alter table subscription_addons add column if not exists quota_monthly int check (quota_monthly is null or quota_monthly > 0);
alter table subscription_addons add column if not exists pending_tier_id uuid references email_addon_tiers(id);
alter table subscription_addons add column if not exists pending_price_ars numeric(12,2);
alter table subscription_addons add column if not exists pending_quota int;
alter table subscription_addons add column if not exists pending_from date;
alter table subscription_addons add column if not exists trial_ends_at date;
create index if not exists idx_subscription_addons_tier on subscription_addons (tier_id) where tier_id is not null;
create index if not exists idx_subscription_addons_pending_tier on subscription_addons (pending_tier_id) where pending_tier_id is not null;

create table if not exists email_addon_usage (
  tenant_id        uuid not null references tenants(id) on delete cascade,
  period           text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  sent             int not null default 0 check (sent >= 0),
  quota            int not null default 0,
  overage          int not null default 0 check (overage >= 0),
  overage_policy   text,
  warned_80_at     timestamptz,
  warned_100_at    timestamptz,
  blocked          int not null default 0,
  billed_charge_id uuid references platform_charges(id),
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, period)
);
alter table email_addon_usage enable row level security;  -- sin policies: sólo RPC
create index if not exists idx_email_addon_usage_charge on email_addon_usage (billed_charge_id) where billed_charge_id is not null;

-- Monto sincronizado con el preapproval de MP y su estado (H1, H4).
alter table subscriptions add column if not exists mp_amount_synced numeric(12,2);
alter table subscriptions add column if not exists mp_amount_synced_at timestamptz;
alter table subscriptions add column if not exists mp_preapproval_status text;

-- -----------------------------------------------------------------------------
-- B) Reglas únicas de "addon vigente" (C1). Espejo: lib/billing/ledger.ts.
--    · Se factura en un cobro con fecha p_at si está activo y, si tiene baja
--      programada, el fin de su período es POSTERIOR a p_at (el período que
--      arranca ese día ya no lo incluye).
--    · Se puede usar hasta el fin de su período inclusive.
-- -----------------------------------------------------------------------------
create or replace function platform_addon_billable(p_status text, p_cancel boolean, p_end date, p_at date)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_status = 'active'
     and (not coalesce(p_cancel, false) or p_end is null or p_end > p_at)
$$;

create or replace function platform_addon_usable(p_status text, p_cancel boolean, p_end date, p_today date)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_status = 'active'
     and (not coalesce(p_cancel, false) or p_end is null or p_end >= p_today)
$$;

-- Precio mensual del addon en un cobro con fecha p_at: bonificado o en prueba
-- = 0; el escalón programado rige desde pending_from.
create or replace function platform_addon_price_on(
  p_source text, p_price numeric, p_catalog numeric, p_trial_ends date,
  p_pending_price numeric, p_pending_from date, p_at date
)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
           when p_source = 'granted' then 0
           when p_trial_ends is not null and p_trial_ends > p_at then 0
           when p_pending_from is not null and p_pending_price is not null and p_pending_from <= p_at then p_pending_price
           else coalesce(p_price, p_catalog, 0)
         end
$$;

-- Desglose (copia de 20261126100000 con la regla nueva de addons y la etiqueta
-- con el cupo del escalón).
create or replace function platform_billing_breakdown_for(p_tenant uuid, p_at date, p_plan uuid, p_cycle text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_at             date := coalesce(p_at, (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  v_cycle          text;
  v_yearly         boolean;
  v_plan_id        uuid;
  v_plan_key       text;
  v_plan_name      text;
  v_plan_amount    numeric;
  v_addons         jsonb;
  v_addons_monthly numeric;
  v_addons_amount  numeric;
  v_gross          numeric;
  v_pct            numeric;
  v_fixed          numeric;
  v_discount       numeric;
  v_discounts      jsonb;
begin
  if p_tenant is null then
    return null;
  end if;

  select coalesce(p_cycle, s.billing_cycle), p.id, p.key, p.name,
         case when coalesce(p_cycle, s.billing_cycle) = 'yearly'
              then coalesce(nullif(p.yearly_price_ars, 0), p.monthly_price_ars * 12)
              else p.monthly_price_ars end
    into v_cycle, v_plan_id, v_plan_key, v_plan_name, v_plan_amount
    from subscriptions s
    join plans p on p.id = coalesce(p_plan, s.plan_id)
   where s.tenant_id = p_tenant;

  if v_cycle is null then
    return null;
  end if;
  v_yearly := (v_cycle = 'yearly');
  v_plan_amount := coalesce(v_plan_amount, 0);

  select coalesce(jsonb_agg(jsonb_build_object(
           'key', a.addon_key, 'name', a.label, 'monthly', a.price) order by a.addon_key)
           filter (where a.price > 0), '[]'::jsonb),
         coalesce(sum(a.price), 0)
    into v_addons, v_addons_monthly
    from (
      select sa.addon_key,
             coalesce(pa.label, sa.addon_key)
               || case when coalesce(sa.pending_quota, sa.quota_monthly) is not null
                       then ' · ' || replace(to_char(
                              case when sa.pending_from is not null and sa.pending_from <= v_at and sa.pending_quota is not null
                                   then sa.pending_quota else sa.quota_monthly end, 'FM999,999,999'), ',', '.') || ' emails'
                       else '' end as label,
             platform_addon_price_on(sa.source, sa.monthly_price_ars, pa.monthly_price_ars, sa.trial_ends_at,
                                     sa.pending_price_ars, sa.pending_from, v_at) as price
        from subscription_addons sa
        left join plan_addons pa on pa.key = sa.addon_key
       where sa.tenant_id = p_tenant
         and platform_addon_billable(sa.status, sa.cancel_at_period_end, sa.current_period_end, v_at)
    ) a;

  v_addons_amount := case when v_yearly then v_addons_monthly * 12 else v_addons_monthly end;
  v_gross := v_plan_amount + v_addons_amount;

  select least(100, coalesce(sum(d.value) filter (where d.kind = 'percent'), 0)),
         coalesce(sum(d.value) filter (where d.kind = 'fixed'), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'kind', d.kind, 'value', d.value, 'reason', d.reason,
           'valid_from', d.valid_from, 'valid_until', d.valid_until) order by d.created_at), '[]'::jsonb)
    into v_pct, v_fixed, v_discounts
    from tenant_discounts d
   where d.tenant_id = p_tenant
     and d.deleted_at is null
     and d.value > 0
     and d.valid_from <= v_at
     and (d.valid_until is null or d.valid_until >= v_at);

  if v_yearly then
    v_fixed := v_fixed * 12;
  end if;
  v_discount := least(v_gross, round(v_gross * v_pct / 100, 2) + v_fixed);

  return jsonb_build_object(
    'tenant_id', p_tenant,
    'at', v_at,
    'billing_cycle', v_cycle,
    'currency', 'ARS',
    'plan_id', v_plan_id,
    'plan_key', v_plan_key,
    'plan_name', v_plan_name,
    'plan_amount', v_plan_amount,
    'addons', v_addons,
    'addons_amount', v_addons_amount,
    'addons_monthly', v_addons_monthly,
    'gross', v_gross,
    'percent_off', v_pct,
    'fixed_off', v_fixed,
    'discount_amount', v_discount,
    'discounts', v_discounts,
    'total', v_gross - v_discount
  );
end;
$fn$;

-- Acceso a la feature del addon (copia de 20260710100000 con la regla única).
create or replace function tenant_has_feature_for(p_tenant uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select tff.enabled from tenant_feature_flags tff
       join feature_flags ff on ff.id = tff.feature_flag_id
      where tff.tenant_id = p_tenant
        and ff.key = any (feature_addon_keys(p_key))
      limit 1),
    (select true from subscription_addons sa
      where sa.tenant_id = p_tenant
        and sa.addon_key = any (feature_addon_keys(p_key))
        and platform_addon_usable(sa.status, sa.cancel_at_period_end, sa.current_period_end,
                                  platform_ar_date(now()))
      limit 1),
    (select (p.limits -> 'modules' ->> p_key)::boolean
       from subscriptions s join plans p on p.id = s.plan_id
      where s.tenant_id = p_tenant limit 1),
    (select is_basic from features where key = p_key),
    false
  );
$$;
revoke all on function tenant_has_feature_for(uuid, text) from public, anon;
grant execute on function tenant_has_feature_for(uuid, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- C) Prorrateo de addons: cotización pura y cargo (§17.4, ADR-131)
-- -----------------------------------------------------------------------------
-- ¿Cuánto se carga hoy por sumar p_monthly por mes hasta el fin del período?
-- Mismas condiciones que el trigger de ADR-131: suscripción activa o en mora,
-- período vigente con su cargo generado y negocio sin exclusión.
create or replace function platform_addon_proration_quote(p_tenant uuid, p_monthly numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub   subscriptions%rowtype;
  v_today date := platform_ar_date(now());
  v_start date;
  v_end   date;
  v_days  int;
  v_left  int;
  v_mult  int;
  v_pct   int;
  v_cents bigint;
begin
  select * into v_sub from subscriptions where tenant_id = p_tenant;
  if not found then
    return jsonb_build_object('applies', false, 'reason', 'no_subscription', 'cents', 0);
  end if;
  if v_sub.status not in ('active', 'past_due') then
    return jsonb_build_object('applies', false, 'reason', 'status_' || v_sub.status, 'cents', 0);
  end if;
  if v_sub.current_period_start is null or v_sub.current_period_end is null or v_sub.current_period_end <= now() then
    return jsonb_build_object('applies', false, 'reason', 'no_period', 'cents', 0);
  end if;
  if platform_billing_exclusion(p_tenant) is not null then
    return jsonb_build_object('applies', false, 'reason', 'excluded', 'cents', 0);
  end if;
  v_start := platform_period_date(v_sub.current_period_start);
  v_end := platform_period_date(v_sub.current_period_end);
  if not exists (select 1 from platform_charges c
                  where c.idempotency_key = 'sub:' || v_sub.id::text || ':' || v_start::text || ':subscription_period'
                    and c.voided_at is null) then
    -- El cargo del período todavía no se generó: va a salir con el addon
    -- entero (sin prorrateo, para no cobrar doble).
    return jsonb_build_object('applies', false, 'reason', 'period_not_charged', 'cents', 0,
                              'period_start', v_start, 'period_end', v_end);
  end if;
  v_days := v_end - v_start;
  v_left := least(v_days, v_end - v_today);
  if v_days <= 0 or v_left <= 0 or coalesce(p_monthly, 0) <= 0 then
    return jsonb_build_object('applies', false, 'reason', 'nothing_left', 'cents', 0);
  end if;
  v_mult := case when v_sub.billing_cycle = 'yearly' then 12 else 1 end;
  v_pct := platform_percent_off_bp(p_tenant, v_today);
  v_cents := platform_prorate_cents(platform_cents(p_monthly * v_mult), v_pct, v_left, v_days);
  return jsonb_build_object('applies', v_cents > 0, 'reason', case when v_cents > 0 then null else 'zero' end,
                            'cents', greatest(v_cents, 0), 'days', v_days, 'days_left', v_left,
                            'percent_bp', v_pct, 'period_start', v_start, 'period_end', v_end,
                            'subscription_id', v_sub.id, 'plan_id', v_sub.plan_id, 'cycle', v_sub.billing_cycle);
end;
$$;

-- Crea el cargo del prorrateo (idempotente por clave). Nunca falla hacia
-- afuera: un error queda en audit_logs y el alta sigue.
create or replace function platform_addon_proration_charge(
  p_tenant uuid, p_addon_key text, p_label text, p_monthly numeric, p_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_q  jsonb;
  v_id uuid;
begin
  v_q := platform_addon_proration_quote(p_tenant, p_monthly);
  if not coalesce((v_q ->> 'applies')::boolean, false) then
    return v_q;
  end if;
  begin
    v_id := platform_create_charge(
      p_tenant, (v_q ->> 'subscription_id')::uuid, 'addon',
      p_label || ' hasta el fin del período (' || (v_q ->> 'days_left') || ' de ' || (v_q ->> 'days') || ' días)',
      platform_ar_date(now()), (v_q ->> 'period_end')::date, (v_q ->> 'period_end')::date,
      jsonb_build_array(jsonb_build_object('source', 'proration_debit',
        'description', p_label || ' · ' || (v_q ->> 'days_left') || ' días', 'amount_cents', (v_q ->> 'cents')::bigint)),
      p_key, auth.uid(), 'plan_change', null);
    insert into platform_plan_changes (tenant_id, subscription_id, kind, from_plan_id, to_plan_id, from_cycle, to_cycle, addon_key,
                                       timing, status, effective_on, quote, charge_id, charge_cents, source, created_by, applied_at)
    values (p_tenant, (v_q ->> 'subscription_id')::uuid, 'addon_add', (v_q ->> 'plan_id')::uuid, (v_q ->> 'plan_id')::uuid,
            v_q ->> 'cycle', v_q ->> 'cycle', p_addon_key, 'immediate', 'applied', platform_ar_date(now()),
            v_q, v_id, (v_q ->> 'cents')::bigint, 'trigger', auth.uid(), now());
    return v_q || jsonb_build_object('charge_id', v_id);
  exception when others then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (p_tenant, null, 'platform_charge', null, 'platform_proration_failed',
            jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate, 'addon', p_addon_key, 'key', p_key));
    return v_q || jsonb_build_object('applies', false, 'reason', 'error');
  end;
end;
$$;

-- Trigger de ADR-131, ahora sobre el cálculo único y sin cobrar la prueba (M1).
create or replace function trg_subscription_addons_proration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := platform_ar_date(now());
  v_label text;
  v_price numeric;
  v_start date;
begin
  if new.status <> 'active' or coalesce(new.source, '') = 'granted' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = 'active' then
    return null;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.cancel_at_period_end, false) and old.current_period_end is not null
     and old.current_period_end::date >= v_today then
    return null;
  end if;
  if new.trial_ends_at is not null and new.trial_ends_at > v_today then
    return null;
  end if;
  select coalesce(new.monthly_price_ars, pa.monthly_price_ars, 0), coalesce(pa.label, new.addon_key)
    into v_price, v_label
    from (select 1) x left join plan_addons pa on pa.key = new.addon_key;
  -- Un error del prorrateo nunca impide activar el complemento (como ADR-131):
  -- queda en la auditoría y la conciliación lo levanta.
  begin
    select platform_period_date(s.current_period_start) into v_start from subscriptions s where s.tenant_id = new.tenant_id;
    perform platform_addon_proration_charge(new.tenant_id, new.addon_key, v_label, v_price,
                                            'addon:' || new.id::text || ':' || coalesce(v_start::text, 'none'));
  exception when others then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, null, 'subscription_addons', new.id, 'platform_proration_failed',
            jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate, 'addon', new.addon_key));
  end;
  return null;
end;
$$;
drop trigger if exists subscription_addons_proration on subscription_addons;
create trigger subscription_addons_proration after insert or update of status on subscription_addons
  for each row execute function trg_subscription_addons_proration();

-- -----------------------------------------------------------------------------
-- D) Alta y baja de addons del dueño (C1b, M1, M2)
-- -----------------------------------------------------------------------------
create or replace function activate_addon(p_addon_key text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tid uuid := current_tenant_id();
  v_sub record;
  v_price numeric;
  v_pstart date;
  v_pend date;
  v_tenant_name text;
  v_owner_email text;
  v_label text;
  v_existing record;
  v_trial_days int;
  v_trial date;
begin
  if v_tid is null or not is_tenant_owner() then
    raise exception 'forbidden';
  end if;
  if coalesce(btrim(p_addon_key), '') = '' then
    raise exception 'invalid_addon';
  end if;
  -- El email de NinjaSoft se contrata por escalón (owner_email_addon_activate).
  if p_addon_key = 'email_ninjasoft' then
    raise exception 'use_email_addon_activate';
  end if;

  if not exists (select 1 from plan_addons where key = p_addon_key and is_active) then
    raise exception 'addon_not_found';
  end if;

  select s.current_period_start, s.current_period_end, s.status, coalesce(s.cancel_at_period_end, false) as ending
    into v_sub
    from subscriptions s where s.tenant_id = v_tid;
  if not found then
    raise exception 'subscription_not_found';
  end if;
  if v_sub.status in ('suspended', 'cancelled') then
    raise exception 'subscription_inactive';
  end if;
  if v_sub.ending then
    raise exception 'subscription_ending';
  end if;

  v_pstart := coalesce(platform_period_date(v_sub.current_period_start), current_date);
  v_pend := coalesce(platform_period_date(v_sub.current_period_end), (current_date + interval '1 month')::date);

  if p_addon_key in ('ai_assistant', 'asistente_ia') then
    select nullif(s.secrets ->> 'addon_price_ars', '')::numeric,
           nullif(regexp_replace(coalesce(s.secrets ->> 'addon_trial_days', ''), '[^0-9]', '', 'g'), '')::int
      into v_price, v_trial_days
      from platform_secrets s where s.key = 'ai_config';
  end if;
  if v_price is null then
    select monthly_price_ars into v_price from plan_addons where key = p_addon_key;
  end if;
  v_price := coalesce(v_price, 0);

  select coalesce(pa.label, p_addon_key) into v_label
    from plan_addons pa where pa.key = p_addon_key;
  v_label := coalesce(v_label, p_addon_key);

  select * into v_existing
    from subscription_addons where tenant_id = v_tid and addon_key = p_addon_key;

  -- Prueba gratis del complemento: sólo la primera vez que el negocio lo activa.
  if v_existing.tenant_id is null and coalesce(v_trial_days, 0) > 0 then
    v_trial := platform_ar_date(now()) + least(v_trial_days, 365);
  end if;

  insert into subscription_addons (tenant_id, addon_key, status, source,
                                   monthly_price_ars, current_period_start, current_period_end,
                                   cancel_at_period_end, trial_ends_at)
  values (v_tid, p_addon_key, 'active', 'purchased',
          v_price, v_pstart, v_pend, false, v_trial)
  on conflict (tenant_id, addon_key) do update
     set status = 'active',
         cancel_at_period_end = false,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         -- Una bonificación vencida (granted + cancelled) no revive gratis: el
         -- dueño que la reactiva la compra (si no, expire_granted_addons la
         -- vuelve a cancelar al día siguiente y nunca la puede comprar).
         source = case when subscription_addons.source = 'granted' and subscription_addons.status = 'active'
                       then 'granted' else 'purchased' end,
         monthly_price_ars = case when subscription_addons.source = 'granted' and subscription_addons.status = 'active'
                                  then null else excluded.monthly_price_ars end,
         granted_until = case when subscription_addons.source = 'granted' and subscription_addons.status = 'active'
                              then subscription_addons.granted_until else null end;

  insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
  values (v_tid, 'owner', 'plan', 'info',
          'Activaste un complemento',
          'Activaste "' || v_label || '". Ya está disponible para todo tu equipo.'
            || case when v_trial is not null
                    then ' Es gratis hasta el ' || to_char(v_trial, 'DD/MM/YYYY') || '.' else '' end,
          false);

  if p_addon_key in ('ai_assistant', 'asistente_ia') then
    select t.name, u.email into v_tenant_name, v_owner_email
      from tenants t
      join tenant_users tu on tu.tenant_id = t.id and tu.role = 'owner' and tu.status = 'active'
      join users u on u.id = tu.user_id
     where t.id = v_tid
     order by tu.created_at limit 1;
    perform enqueue_system_email(
      v_tid, v_owner_email, 'addon_ai_activated',
      jsonb_build_object('negocio', coalesce(v_tenant_name, '')),
      'Activaste el Asistente IA en NinjaPos',
      _dunning_email_html(coalesce(v_tenant_name, ''), 'Activaste el Asistente IA',
        'Activaste el Asistente IA de NinjaPos. Ya podés usarlo desde la burbuja del '
          || 'asistente en cualquier pantalla del sistema. Te responde sobre tus ventas, '
          || 'tu stock y cómo usar cada función.'));
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tid, auth.uid(), 'subscription_addons', v_tid, 'addon_activated',
          case when v_existing.tenant_id is null then null
               else jsonb_build_object('status', v_existing.status,
                                       'cancel_at_period_end', v_existing.cancel_at_period_end) end,
          jsonb_build_object('addon', p_addon_key, 'status', 'active',
                             'monthly_price_ars', v_price,
                             'trial_ends_at', v_trial,
                             'current_period_start', v_pstart,
                             'current_period_end', v_pend));
end;
$fn$;

create or replace function cancel_addon(p_addon_key text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tid uuid := current_tenant_id();
  v_addon record;
  v_tenant_name text;
  v_owner_email text;
  v_period_end date;
  v_today date := platform_ar_date(now());
  v_label text;
  v_sub_status text;
begin
  if v_tid is null or not is_tenant_owner() then
    raise exception 'forbidden';
  end if;
  if coalesce(btrim(p_addon_key), '') = '' then
    raise exception 'invalid_addon';
  end if;

  select * into v_addon
    from subscription_addons
   where tenant_id = v_tid and addon_key = p_addon_key;
  if not found then
    raise exception 'addon_not_found';
  end if;

  if v_addon.status = 'cancelled' or v_addon.cancel_at_period_end then
    return;
  end if;

  -- C1b: el fin del período pago es el de la suscripción vigente (el guardado
  -- en el addon queda viejo después de cada renovación). En prueba del plan o
  -- del addon no hay nada pago: la baja es inmediata.
  select s.status, platform_period_date(s.current_period_end)
    into v_sub_status, v_period_end
    from subscriptions s
   where s.tenant_id = v_tid;
  if v_sub_status = 'trial' or v_addon.source = 'granted'
     or (v_addon.trial_ends_at is not null and v_addon.trial_ends_at > v_today) then
    v_period_end := null;
  end if;

  if v_period_end is not null and v_period_end > v_today then
    update subscription_addons
       set cancel_at_period_end = true,
           current_period_end = v_period_end,
           pending_tier_id = null, pending_price_ars = null, pending_quota = null, pending_from = null
     where tenant_id = v_tid and addon_key = p_addon_key;
  else
    update subscription_addons
       set status = 'cancelled',
           cancel_at_period_end = true,
           current_period_end = coalesce(v_period_end, v_today),
           pending_tier_id = null, pending_price_ars = null, pending_quota = null, pending_from = null
     where tenant_id = v_tid and addon_key = p_addon_key;
    if p_addon_key = 'email_ninjasoft' then
      perform email_addon_restore_provider(v_tid);
    end if;
  end if;

  select coalesce(pa.label, p_addon_key) into v_label
    from plan_addons pa where pa.key = p_addon_key;
  v_label := coalesce(v_label, p_addon_key);

  insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
  values (v_tid, 'owner', 'plan', 'info',
          'Diste de baja un complemento',
          case when v_period_end is not null and v_period_end > v_today
               then 'El complemento "' || v_label || '" sigue activo hasta el '
                      || to_char(v_period_end, 'DD/MM/YYYY') || '. Desde esa fecha deja de cobrarse.'
               else 'El complemento "' || v_label || '" quedó dado de baja y no se cobra más.' end,
          false);

  if p_addon_key in ('ai_assistant', 'asistente_ia') then
    select t.name, u.email into v_tenant_name, v_owner_email
      from tenants t
      join tenant_users tu on tu.tenant_id = t.id and tu.role = 'owner' and tu.status = 'active'
      join users u on u.id = tu.user_id
     where t.id = v_tid
     order by tu.created_at limit 1;
    perform enqueue_system_email(
      v_tid, v_owner_email, 'addon_ai_cancelled',
      jsonb_build_object('negocio', coalesce(v_tenant_name, ''),
                         'vence', coalesce(to_char(v_period_end, 'DD/MM/YYYY'), 'hoy')),
      'Diste de baja el Asistente IA',
      _dunning_email_html(coalesce(v_tenant_name, ''), 'Diste de baja el Asistente IA',
        'Diste de baja el Asistente IA. Lo vas a poder seguir usando hasta '
          || coalesce(to_char(v_period_end, 'DD/MM/YYYY'), 'hoy')
          || '. Desde esa fecha deja de cobrarse y se desactiva. '
          || 'Podés reactivarlo cuando quieras desde el Panel del dueño.'));
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tid, auth.uid(), 'subscription_addons', v_tid, 'addon_cancel_at_period_end',
          jsonb_build_object('addon', p_addon_key, 'status', v_addon.status,
                             'cancel_at_period_end', v_addon.cancel_at_period_end,
                             'current_period_end', v_addon.current_period_end),
          jsonb_build_object('addon', p_addon_key, 'cancel_at_period_end', true,
                             'current_period_end', v_period_end));
end;
$fn$;

-- -----------------------------------------------------------------------------
-- E) Remitente del negocio y uso del cupo
-- -----------------------------------------------------------------------------
-- Parte local del remitente a partir del slug (espejo: emailLocalPart en
-- supabase/functions/_shared/billing/emailAddon.ts).
create or replace function email_addon_local_part(p_slug text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(nullif(
    left(
      btrim(regexp_replace(regexp_replace(translate(lower(coalesce(p_slug, '')), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'), '[^a-z0-9.-]+', '-', 'g'), '[-.]{2,}', '-', 'g'), '-.'),
      40),
    ''), 'negocio')
$$;

-- Vuelve el envío del negocio a su cuenta propia (Resend o SMTP) cuando el
-- complemento deja de estar vigente.
create or replace function email_addon_restore_provider(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update tenant_email_smtp
     set provider = case when resend_api_key <> '' and from_email <> '' then 'resend' else 'smtp' end,
         updated_at = now()
   where tenant_id = p_tenant and provider = 'ninjasoft';
  if found then
    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (p_tenant, 'owner', 'plan', 'warning',
            'Tus emails vuelven a tu cuenta',
            'El email de NinjaSoft terminó. Los comprobantes salen otra vez con tu cuenta de correo: revisala en Configuración › Email del negocio.',
            false);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (p_tenant, null, 'tenant', p_tenant, 'email_addon_provider_restored', jsonb_build_object('reason', 'addon_ended'));
  end if;
end;
$$;

-- Remitente efectivo del negocio con el complemento (sin consumir cupo).
create or replace function email_addon_sender(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_set   email_addon_settings%rowtype;
  v_slug  text;
  v_name  text;
  v_reply text;
  v_local text;
begin
  select * into v_set from email_addon_settings where id;
  select t.slug, t.name into v_slug, v_name from tenants t where t.id = p_tenant;
  -- Respuesta: el email propio del negocio (el de su cuenta de envío) o, si no
  -- cargó ninguno, el del dueño.
  select nullif(btrim(e.from_email), '') into v_reply
    from tenant_email_smtp e
   where e.tenant_id = p_tenant;
  if v_reply is null then
    select u.email into v_reply
      from tenant_users tu join users u on u.id = tu.user_id
     where tu.tenant_id = p_tenant and tu.role = 'owner' and tu.status = 'active'
     order by tu.created_at limit 1;
  end if;
  v_local := case when coalesce(v_set.sender_mode, 'business') = 'fixed'
                  then v_set.fixed_local else email_addon_local_part(v_slug) end;
  return jsonb_build_object(
    'domain', coalesce(v_set.domain, 'soft.ninja'),
    'from_email', v_local || '@' || coalesce(v_set.domain, 'soft.ninja'),
    'from_name', coalesce(v_name, ''),
    'reply_to', v_reply,
    'domain_status', v_set.domain_status,
    'sender_mode', coalesce(v_set.sender_mode, 'business'));
end;
$$;

-- Aviso al 80 % o al 100 % del cupo (una vez por mes y nivel).
create or replace function email_addon_warn(p_tenant uuid, p_level int, p_sent int, p_quota int, p_policy text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_name  text;
  v_title text;
  v_body  text;
begin
  select t.name, u.email into v_name, v_email
    from tenants t
    left join tenant_users tu on tu.tenant_id = t.id and tu.role = 'owner' and tu.status = 'active'
    left join users u on u.id = tu.user_id
   where t.id = p_tenant
   order by tu.created_at limit 1;
  if p_level >= 100 then
    v_title := 'Usaste todos los emails del mes';
    v_body := 'Enviaste ' || p_sent || ' de ' || p_quota || ' emails de este mes. '
      || case p_policy
           when 'block' then 'Hasta el mes que viene los emails no salen: podés pasar a un escalón más grande en Configuración › Email del negocio.'
           when 'charge' then 'Los emails que sigas enviando se cobran aparte como excedente en tu próximo cobro.'
           else 'Podés seguir enviando, pero te conviene pasar a un escalón más grande en Configuración › Email del negocio.' end;
  else
    v_title := 'Usaste el 80 % de tus emails del mes';
    v_body := 'Enviaste ' || p_sent || ' de ' || p_quota || ' emails de este mes. Si necesitás más, cambiá de escalón en Configuración › Email del negocio.';
  end if;
  insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
  values (p_tenant, 'owner', 'plan', case when p_level >= 100 then 'warning' else 'info' end, v_title, v_body, false);
  perform enqueue_system_email(
    p_tenant, v_email, case when p_level >= 100 then 'email_addon_quota_100' else 'email_addon_quota_80' end,
    jsonb_build_object('negocio', coalesce(v_name, ''), 'enviados', p_sent::text, 'cupo', p_quota::text),
    v_title, _dunning_email_html(coalesce(v_name, ''), v_title, v_body));
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, null, 'email_addon_usage', p_tenant, 'email_addon_quota_warning',
          jsonb_build_object('level', p_level, 'sent', p_sent, 'quota', p_quota, 'policy', p_policy));
end;
$$;

-- Única puerta de envío por el dominio de NinjaSoft (service_role). Reserva
-- p_count emails del cupo del mes o explica por qué no.
create or replace function email_addon_consume(p_tenant uuid, p_count int default 1)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sa     subscription_addons%rowtype;
  v_set    email_addon_settings%rowtype;
  v_status text;
  v_today  date := platform_ar_date(now());
  v_period text := to_char(platform_ar_date(now()), 'YYYY-MM');
  v_quota  int;
  v_use    email_addon_usage%rowtype;
  v_n      int := greatest(coalesce(p_count, 1), 1);
  v_new    int;
  v_over   int;
  v_sender jsonb;
begin
  select * into v_sa from subscription_addons where tenant_id = p_tenant and addon_key = 'email_ninjasoft';
  if not found or not platform_addon_usable(v_sa.status, v_sa.cancel_at_period_end, v_sa.current_period_end, v_today) then
    return jsonb_build_object('allowed', false, 'reason', 'addon_inactive');
  end if;
  select status into v_status from subscriptions where tenant_id = p_tenant;
  if v_status in ('suspended', 'cancelled') then
    return jsonb_build_object('allowed', false, 'reason', 'subscription_inactive');
  end if;
  select * into v_set from email_addon_settings where id;
  if coalesce(v_set.domain_status, '') <> 'verified' then
    return jsonb_build_object('allowed', false, 'reason', 'domain_not_verified');
  end if;

  v_quota := coalesce(
    case when v_sa.pending_from is not null and v_sa.pending_from <= v_today then v_sa.pending_quota end,
    v_sa.quota_monthly,
    (select min(t.monthly_quota) from email_addon_tiers t where t.is_active and t.deleted_at is null),
    0);

  insert into email_addon_usage (tenant_id, period, quota) values (p_tenant, v_period, v_quota)
  on conflict (tenant_id, period) do nothing;
  select * into v_use from email_addon_usage where tenant_id = p_tenant and period = v_period for update;

  v_new := v_use.sent + v_n;
  v_over := greatest(0, v_new - greatest(v_use.sent, v_quota));
  if v_over > 0 and v_set.overage_policy = 'block' then
    update email_addon_usage set blocked = blocked + v_n, quota = v_quota, updated_at = now()
     where tenant_id = p_tenant and period = v_period;
    if v_use.warned_100_at is null then
      update email_addon_usage set warned_100_at = now() where tenant_id = p_tenant and period = v_period;
      perform email_addon_warn(p_tenant, 100, v_use.sent, v_quota, v_set.overage_policy);
    end if;
    return jsonb_build_object('allowed', false, 'reason', 'quota_exceeded', 'sent', v_use.sent, 'quota', v_quota);
  end if;

  update email_addon_usage
     set sent = v_new,
         quota = v_quota,
         overage = overage + v_over,
         overage_policy = case when v_over > 0 then v_set.overage_policy else overage_policy end,
         updated_at = now()
   where tenant_id = p_tenant and period = v_period;

  if v_quota > 0 and v_new * 100 >= v_quota * 80 and v_use.warned_80_at is null and v_new < v_quota then
    update email_addon_usage set warned_80_at = now() where tenant_id = p_tenant and period = v_period;
    perform email_addon_warn(p_tenant, 80, v_new, v_quota, v_set.overage_policy);
  end if;
  if v_quota > 0 and v_new >= v_quota and v_use.warned_100_at is null then
    update email_addon_usage set warned_100_at = now(), warned_80_at = coalesce(warned_80_at, now())
     where tenant_id = p_tenant and period = v_period;
    perform email_addon_warn(p_tenant, 100, v_new, v_quota, v_set.overage_policy);
  end if;

  v_sender := email_addon_sender(p_tenant);
  return v_sender || jsonb_build_object('allowed', true, 'sent', v_new, 'quota', v_quota, 'overage', v_over,
                                        'period', v_period, 'policy', v_set.overage_policy);
end;
$$;

-- Devuelve el cupo reservado cuando el envío falló.
create or replace function email_addon_release(p_tenant uuid, p_count int default 1)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int := greatest(coalesce(p_count, 1), 1);
begin
  update email_addon_usage
     set sent = greatest(0, sent - v_n),
         overage = greatest(0, overage - least(overage, v_n)),
         updated_at = now()
   where tenant_id = p_tenant and period = to_char(platform_ar_date(now()), 'YYYY-MM');
end;
$$;

-- Excedente del mes con política 'charge': un cargo 'addon' por negocio y mes,
-- con vencimiento en el próximo cobro (entra al débito de MP por el monto
-- esperado, H2). Idempotente por clave.
create or replace function email_addon_bill_overage(p_period text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period text := coalesce(p_period, to_char((date_trunc('month', platform_ar_date(now())) - interval '1 day')::date, 'YYYY-MM'));
  v_set    email_addon_settings%rowtype;
  r        record;
  v_blocks int;
  v_unit   bigint;
  v_sub    subscriptions%rowtype;
  v_due    date;
  v_id     uuid;
  v_n      int := 0;
begin
  select * into v_set from email_addon_settings where id;
  v_unit := platform_cents(coalesce(v_set.overage_block_price_ars, 0));
  if v_unit <= 0 then
    return jsonb_build_object('period', v_period, 'charged', 0, 'reason', 'no_price');
  end if;
  for r in
    select u.* from email_addon_usage u
     where u.period = v_period and u.overage > 0 and u.overage_policy = 'charge' and u.billed_charge_id is null
  loop
    if platform_billing_exclusion(r.tenant_id) is not null then
      continue;
    end if;
    select * into v_sub from subscriptions where tenant_id = r.tenant_id;
    v_blocks := ceil(r.overage::numeric / greatest(v_set.overage_block_size, 1))::int;
    v_due := greatest(platform_ar_date(now()), coalesce(platform_period_date(v_sub.current_period_end), platform_ar_date(now())));
    v_id := platform_create_charge(
      r.tenant_id, v_sub.id, 'addon',
      'Emails adicionales de ' || substr(v_period, 6, 2) || '/' || substr(v_period, 1, 4),
      null, null, v_due,
      jsonb_build_array(jsonb_build_object('source', 'addon',
        'description', r.overage || ' emails sobre el cupo (' || v_blocks || ' bloque' || case when v_blocks = 1 then '' else 's' end
          || ' de ' || v_set.overage_block_size || ')',
        'qty', v_blocks, 'unit_cents', v_unit, 'amount_cents', v_unit * v_blocks)),
      'email_overage:' || r.tenant_id::text || ':' || v_period, null, 'cron', null);
    update email_addon_usage set billed_charge_id = v_id, updated_at = now()
     where tenant_id = r.tenant_id and period = v_period;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('period', v_period, 'charged', v_n);
end;
$$;

-- -----------------------------------------------------------------------------
-- F) Monto esperado del próximo débito de Mercado Pago (H1, H2)
-- -----------------------------------------------------------------------------
-- Próximo débito = total del período que arranca en la fecha del cobro (con
-- las bajas, pruebas, escalones y descuentos de ESE día) + los ajustes abiertos
-- (prorrateos de addons y de upgrade, excedente de emails) que vencen hasta esa
-- fecha. Espejo: expectedMpAmount en _shared/billing/mpAmount.ts.
create or replace function platform_mp_expected_amount(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub    subscriptions%rowtype;
  v_trial  timestamptz;
  v_mode   text;
  v_next   date;
  v_b      jsonb;
  v_period numeric;
  v_adj    bigint := 0;
  v_items  jsonb;
  v_amount numeric;
begin
  select * into v_sub from subscriptions where tenant_id = p_tenant;
  if not found then
    return jsonb_build_object('applies', false, 'reason', 'no_subscription');
  end if;
  select trial_ends_at into v_trial from tenants where id = p_tenant;
  v_mode := platform_effective_billing_mode(p_tenant);
  v_next := case
              when v_sub.status = 'trial' and v_trial is not null and v_trial > now() then platform_period_date(v_trial)
              else coalesce(platform_period_date(v_sub.current_period_end), platform_ar_date(now()))
            end;
  v_b := platform_billing_breakdown(p_tenant, v_next);
  v_period := coalesce((v_b ->> 'total')::numeric, 0);

  select coalesce(sum(o.open_cents), 0),
         coalesce(jsonb_agg(jsonb_build_object('charge_id', o.id, 'kind', o.kind, 'description', o.description,
                                               'due_date', o.due_date, 'open_cents', o.open_cents) order by o.due_date), '[]'::jsonb)
    into v_adj, v_items
    from (
      select c.id, c.kind, c.description, c.due_date,
             coalesce((select sum(platform_movement_open_cents(l.id)) from platform_ledger l
                        where l.charge_id = c.id and l.kind = 'charge'), 0) as open_cents
        from platform_charges c
       where c.tenant_id = p_tenant
         and c.kind in ('proration', 'addon')
         and c.status in ('open', 'partially_paid')
         and c.voided_at is null
         and c.due_date <= v_next
    ) o
   where o.open_cents > 0;

  v_amount := v_period + round(v_adj::numeric / 100, 2);
  return jsonb_build_object(
    'applies', v_mode = 'mp_subscription' and coalesce(btrim(v_sub.mp_preapproval_id), '') <> ''
               and v_sub.status in ('trial', 'active', 'past_due'),
    'reason', case
                when v_mode <> 'mp_subscription' then 'mode_' || v_mode
                when coalesce(btrim(v_sub.mp_preapproval_id), '') = '' then 'no_preapproval'
                when v_sub.status not in ('trial', 'active', 'past_due') then 'status_' || v_sub.status
              end,
    'mode', v_mode,
    'status', v_sub.status,
    'preapproval_id', v_sub.mp_preapproval_id,
    'preapproval_status', v_sub.mp_preapproval_status,
    'next_charge_date', v_next,
    'period_total', v_period,
    'adjustments_cents', v_adj,
    'adjustments', v_items,
    'amount', v_amount,
    'synced_amount', v_sub.mp_amount_synced,
    'synced_at', v_sub.mp_amount_synced_at,
    'breakdown', v_b);
end;
$$;

-- Negocios con débito automático cuyo monto en MP no coincide con el esperado
-- (la Edge mp_update_subscription_amount, modo cron, los sincroniza).
create or replace function platform_mp_amount_targets(p_limit int default 200)
returns table (tenant_id uuid, preapproval_id text, amount numeric, synced_amount numeric, next_charge_date date)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select x.tenant_id, x.e ->> 'preapproval_id', (x.e ->> 'amount')::numeric,
         nullif(x.e ->> 'synced_amount', '')::numeric, (x.e ->> 'next_charge_date')::date
    from (
      select s.tenant_id, platform_mp_expected_amount(s.tenant_id) as e
        from subscriptions s
        join tenants t on t.id = s.tenant_id and t.deleted_at is null
       where coalesce(btrim(s.mp_preapproval_id), '') <> ''
         and s.status in ('trial', 'active', 'past_due')
         and coalesce(s.mp_preapproval_status, 'authorized') in ('authorized', 'pending')
    ) x
   where coalesce((x.e ->> 'applies')::boolean, false)
     and (x.e ->> 'amount')::numeric > 0
     and coalesce(nullif(x.e ->> 'synced_amount', '')::numeric, -1) <> (x.e ->> 'amount')::numeric
   order by x.tenant_id
   limit greatest(coalesce(p_limit, 200), 1)
$$;

-- -----------------------------------------------------------------------------
-- G) Período reanclado y prueba (H3, H4)
-- -----------------------------------------------------------------------------
create or replace function reanchor_subscription_period(
  p_subscription_id uuid,
  p_months          int default 1,
  p_now             timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_sub       subscriptions%rowtype;
  v_months    int := greatest(coalesce(p_months, 1), 1);
  v_anchor    timestamptz;
  v_end       timestamptz;
  v_guard     int := 0;
  v_trial_end timestamptz;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if not found then
    raise exception 'subscription_not_found';
  end if;

  if coalesce(v_sub.cancel_at_period_end, false)
     and v_sub.current_period_end is not null
     and v_sub.current_period_end <= p_now then
    update subscriptions
       set status = 'cancelled', updated_at = now()
     where id = p_subscription_id;
    update tenants
       set status = 'cancelled', updated_at = now()
     where id = v_sub.tenant_id
       and status in ('past_due', 'suspended', 'active');
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                            before_data, after_data)
    values (v_sub.tenant_id, null, 'subscriptions', p_subscription_id,
            'subscription_cancelled_on_reanchor',
            jsonb_build_object('status', v_sub.status,
                               'cancel_at_period_end', true,
                               'current_period_end', v_sub.current_period_end),
            jsonb_build_object('status', 'cancelled',
                               'reason', 'cancel_at_period_end_expired'));
    return v_sub.current_period_end;
  end if;

  select t.trial_ends_at into v_trial_end from tenants t where t.id = v_sub.tenant_id;

  if v_sub.status = 'trial' and v_trial_end is not null and v_trial_end > p_now then
    v_anchor := v_trial_end;
  else
    v_anchor := coalesce(v_sub.current_period_end, v_sub.current_period_start, p_now);
  end if;
  v_end := v_anchor + make_interval(months => v_months);

  while v_end <= p_now and v_guard < 240 loop
    v_anchor := v_end;
    v_end    := v_anchor + make_interval(months => v_months);
    v_guard  := v_guard + 1;
  end loop;

  update subscriptions
     set status               = 'active',
         current_period_start = v_anchor,
         current_period_end   = v_end,
         updated_at           = now()
   where id = p_subscription_id;

  -- H3: un pago también saca al negocio de la prueba (si no, el cron de prueba
  -- vencida lo daba de baja) y reactiva a uno cancelado que vuelve a pagar.
  update tenants
     set status = 'active', updated_at = now()
   where id = v_sub.tenant_id
     and status in ('past_due', 'suspended', 'trial', 'cancelled')
     and deleted_at is null;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_sub.tenant_id, null, 'subscriptions', p_subscription_id, 'subscription_reactivated',
          jsonb_build_object('status', v_sub.status,
                             'current_period_start', v_sub.current_period_start,
                             'current_period_end', v_sub.current_period_end),
          jsonb_build_object('status', 'active',
                             'current_period_start', v_anchor,
                             'current_period_end', v_end,
                             'anchored_to_previous_due', v_sub.status <> 'trial',
                             'anchored_to_trial_end', v_sub.status = 'trial' and v_anchor = v_trial_end,
                             'cycles_advanced', v_guard));

  return v_end;
end;
$fn$;

-- ¿El negocio ya autorizó el débito automático y espera el primer cobro?
-- (H4: no se le da de baja la prueba durante 5 días.)
create or replace function platform_trial_debit_pending(p_tenant uuid, p_trial_end timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from subscriptions s
     where s.tenant_id = p_tenant
       and (s.status in ('active', 'past_due')
            or (coalesce(s.mp_preapproval_status, '') = 'authorized'
                and coalesce(btrim(s.mp_preapproval_id), '') <> ''
                and p_trial_end > now() - interval '5 days'))
  )
$$;

create or replace function run_saas_dunning()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reminder   int;
  v_reminder_c int := 0;
  v_trial_end  int := 0;
  v_trial_exp  int := 0;
  r            record;
  v_owner_email text;
  v_owner_id    uuid;
  v_period   text;
  v_vence    text;
  v_dias     text;
begin
  select reminder_days into v_reminder from platform_settings where id = true;
  v_reminder := coalesce(v_reminder, 3);

  for r in
    select s.id as sub_id, s.tenant_id, s.current_period_end, t.name as tenant_name
      from subscriptions s
      join tenants t on t.id = s.tenant_id
     where s.status = 'active'
       and coalesce(s.is_lifetime, false) = false
       and s.current_period_end is not null
       and s.current_period_end >= now()
       and s.current_period_end <= now() + make_interval(days => v_reminder)
       and t.deleted_at is null
       and platform_billing_exclusion(s.tenant_id) is null
       and platform_effective_billing_mode(s.tenant_id) = 'mp_subscription'
  loop
    v_period := to_char(r.current_period_end, 'YYYY-MM');
    if exists (select 1 from dunning_events
                where tenant_id = r.tenant_id and kind = 'payment_reminder'
                  and period_key = v_period) then
      continue;
    end if;

    select u.id, u.email into v_owner_id, v_owner_email
      from tenant_users tu join users u on u.id = tu.user_id
     where tu.tenant_id = r.tenant_id and tu.role = 'owner' and tu.status = 'active'
     order by tu.created_at limit 1;

    v_vence := to_char(r.current_period_end, 'DD/MM/YYYY');

    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (r.tenant_id, 'owner', 'billing', 'info',
            'Tu suscripción se renueva pronto',
            'Tu suscripción se renueva el ' || v_vence
              || '. Asegurate de tener un medio de pago activo en Mercado Pago.',
            false);

    perform enqueue_system_email(
      r.tenant_id, v_owner_email, 'payment_reminder',
      jsonb_build_object('negocio', coalesce(r.tenant_name, ''), 'vence', v_vence),
      'Tu suscripción de NinjaPos se renueva pronto',
      _dunning_email_html(r.tenant_name, 'Tu suscripción de NinjaPos se renueva pronto',
        'Tu suscripción se renueva el ' || v_vence
          || '. El cobro es automático por Mercado Pago; verificá que tu medio de pago esté activo.'));

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'payment_reminder', v_period);
    v_reminder_c := v_reminder_c + 1;
  end loop;

  for r in
    select t.id as tenant_id, t.name as tenant_name, t.trial_ends_at
      from tenants t
     where t.status = 'trial'
       and t.deleted_at is null
       and t.trial_ends_at is not null
       and t.trial_ends_at >= now()
       and t.trial_ends_at <= now() + interval '3 days'
       and not exists (
         select 1 from subscriptions s
          where s.tenant_id = t.id and coalesce(s.is_lifetime, false) = true
       )
       -- H4: quien ya autorizó el débito no recibe "activá un plan".
       and not platform_trial_debit_pending(t.id, t.trial_ends_at)
  loop
    v_period := to_char(r.trial_ends_at, 'YYYY-MM-DD');
    if exists (select 1 from dunning_events
                where tenant_id = r.tenant_id and kind = 'trial_ending'
                  and period_key = v_period) then
      continue;
    end if;

    select u.id, u.email into v_owner_id, v_owner_email
      from tenant_users tu join users u on u.id = tu.user_id
     where tu.tenant_id = r.tenant_id and tu.role = 'owner' and tu.status = 'active'
     order by tu.created_at limit 1;

    v_vence := to_char(r.trial_ends_at, 'DD/MM/YYYY');
    v_dias  := greatest(0, ceil(extract(epoch from (r.trial_ends_at - now())) / 86400.0)::int)::text;

    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (r.tenant_id, 'owner', 'billing', 'warning',
            'Tu prueba gratis está por terminar',
            'Tu período de prueba termina el ' || v_vence
              || '. Activá un plan para no perder acceso.',
            false);

    perform enqueue_system_email(
      r.tenant_id, v_owner_email, 'trial_ending',
      jsonb_build_object('negocio', coalesce(r.tenant_name, ''), 'vence', v_vence, 'dias', v_dias),
      'Tu prueba de NinjaPos está por terminar',
      _dunning_email_html(r.tenant_name, 'Tu prueba de NinjaPos está por terminar',
        'Tu período de prueba termina el ' || v_vence
          || '. Activá un plan desde tu panel para seguir usando NinjaPos sin interrupciones.'));

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'trial_ending', v_period);
    v_trial_end := v_trial_end + 1;
  end loop;

  for r in
    select t.id as tenant_id, t.name as tenant_name, t.trial_ends_at
      from tenants t
     where t.status = 'trial'
       and t.deleted_at is null
       and t.trial_ends_at is not null
       and t.trial_ends_at < now()
       and not exists (
         select 1 from subscriptions s
          where s.tenant_id = t.id and coalesce(s.is_lifetime, false) = true
       )
       -- H3/H4: ya paga, o autorizó el débito y el primer cobro está en camino.
       and not platform_trial_debit_pending(t.id, t.trial_ends_at)
  loop
    v_period := to_char(r.trial_ends_at, 'YYYY-MM');
    if exists (select 1 from dunning_events
                where tenant_id = r.tenant_id and kind = 'trial_expired'
                  and period_key = v_period) then
      continue;
    end if;

    update tenants set status = 'cancelled', updated_at = now() where id = r.tenant_id;
    update subscriptions set status = 'cancelled', updated_at = now()
     where tenant_id = r.tenant_id and status = 'trial' and coalesce(is_lifetime, false) = false;

    select u.id, u.email into v_owner_id, v_owner_email
      from tenant_users tu join users u on u.id = tu.user_id
     where tu.tenant_id = r.tenant_id and tu.role = 'owner' and tu.status = 'active'
     order by tu.created_at limit 1;

    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (r.tenant_id, 'owner', 'billing', 'critical',
            'Tu prueba gratis terminó',
            'Tu período de prueba terminó. Activá un plan para reactivar tu cuenta.',
            false);

    perform enqueue_system_email(
      r.tenant_id, v_owner_email, 'trial_expired',
      jsonb_build_object('negocio', coalesce(r.tenant_name, '')),
      'Tu prueba de NinjaPos terminó',
      _dunning_email_html(r.tenant_name, 'Tu prueba de NinjaPos terminó',
        'Tu período de prueba terminó y pausamos tu cuenta. Activá un plan cuando quieras para retomar donde lo dejaste.'));

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'trial_expired', v_period);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (r.tenant_id, null, 'tenants', r.tenant_id, 'dunning_trial_expired',
            jsonb_build_object('period', v_period));
    v_trial_exp := v_trial_exp + 1;
  end loop;

  return jsonb_build_object(
    'payment_reminder', v_reminder_c,
    'trial_ending', v_trial_end,
    'trial_expired', v_trial_exp
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- H) Job diario de addons (C1): bajas vencidas y escalones programados
-- -----------------------------------------------------------------------------
create or replace function platform_addons_daily()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today   date := platform_ar_date(now());
  r         record;
  v_expired int := 0;
  v_tiers   int := 0;
begin
  for r in
    select sa.id, sa.tenant_id, sa.addon_key, sa.current_period_end
      from subscription_addons sa
     where sa.status = 'active'
       and coalesce(sa.cancel_at_period_end, false)
       and sa.current_period_end is not null
       and sa.current_period_end < v_today
     for update skip locked
  loop
    update subscription_addons set status = 'cancelled' where id = r.id;
    if r.addon_key = 'email_ninjasoft' then
      perform email_addon_restore_provider(r.tenant_id);
    end if;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (r.tenant_id, null, 'subscription_addons', r.id, 'addon_cancelled',
            jsonb_build_object('addon', r.addon_key, 'reason', 'period_end', 'current_period_end', r.current_period_end));
    v_expired := v_expired + 1;
  end loop;

  for r in
    select sa.id, sa.tenant_id, sa.addon_key, sa.tier_id, sa.pending_tier_id, sa.pending_price_ars, sa.pending_quota,
           sa.monthly_price_ars, sa.quota_monthly
      from subscription_addons sa
     where sa.pending_from is not null and sa.pending_from <= v_today
     for update skip locked
  loop
    update subscription_addons
       set tier_id = coalesce(r.pending_tier_id, tier_id),
           monthly_price_ars = case when source = 'granted' then null else coalesce(r.pending_price_ars, monthly_price_ars) end,
           quota_monthly = coalesce(r.pending_quota, quota_monthly),
           pending_tier_id = null, pending_price_ars = null, pending_quota = null, pending_from = null
     where id = r.id;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
    values (r.tenant_id, null, 'subscription_addons', r.id, 'addon_tier_applied',
            jsonb_build_object('tier_id', r.tier_id, 'monthly_price_ars', r.monthly_price_ars, 'quota', r.quota_monthly),
            jsonb_build_object('tier_id', r.pending_tier_id, 'monthly_price_ars', r.pending_price_ars, 'quota', r.pending_quota));
    v_tiers := v_tiers + 1;
  end loop;

  return jsonb_build_object('expired', v_expired, 'tiers_applied', v_tiers);
end;
$$;

-- -----------------------------------------------------------------------------
-- I) RPC del dueño: oferta, cotización, alta y uso del remitente
-- -----------------------------------------------------------------------------
create or replace function email_addon_ready()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from plan_addons where key = 'email_ninjasoft' and is_active)
     and exists (select 1 from email_addon_settings where id and domain_status = 'verified' and key_source is not null)
     and exists (select 1 from email_addon_tiers where is_active and deleted_at is null)
$$;

create or replace function owner_email_addon_offer()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tid    uuid := current_tenant_id();
  v_set    email_addon_settings%rowtype;
  v_sa     subscription_addons%rowtype;
  v_sub    subscriptions%rowtype;
  v_trial  timestamptz;
  v_today  date := platform_ar_date(now());
  v_use    email_addon_usage%rowtype;
  v_tiers  jsonb;
  v_pa     plan_addons%rowtype;
begin
  if v_tid is null or not exists (
       select 1 from tenant_users me
        where me.tenant_id = v_tid and me.user_id = auth.uid() and me.status = 'active'
          and me.role in ('owner', 'manager')) then
    return jsonb_build_object('allowed', false);
  end if;
  select * into v_set from email_addon_settings where id;
  select * into v_pa from plan_addons where key = 'email_ninjasoft';
  select * into v_sa from subscription_addons where tenant_id = v_tid and addon_key = 'email_ninjasoft';
  select * into v_sub from subscriptions where tenant_id = v_tid;
  select trial_ends_at into v_trial from tenants where id = v_tid;
  select * into v_use from email_addon_usage where tenant_id = v_tid and period = to_char(v_today, 'YYYY-MM');
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label, 'quota', t.monthly_quota,
                                               'price', t.monthly_price_ars) order by t.sort, t.monthly_price_ars), '[]'::jsonb)
    into v_tiers
    from email_addon_tiers t where t.is_active and t.deleted_at is null;

  return jsonb_build_object(
    'allowed', true,
    'is_owner', is_tenant_owner(),
    'available', email_addon_ready(),
    'label', coalesce(v_pa.label, 'Email con dominio NinjaSoft'),
    'description', v_pa.description,
    'sender', email_addon_sender(v_tid),
    'tiers', v_tiers,
    'overage', jsonb_build_object('policy', v_set.overage_policy, 'block_size', v_set.overage_block_size,
                                  'block_price', v_set.overage_block_price_ars),
    'addon', case when v_sa.id is null then null else jsonb_build_object(
      'status', v_sa.status,
      'usable', platform_addon_usable(v_sa.status, v_sa.cancel_at_period_end, v_sa.current_period_end, v_today),
      'source', v_sa.source,
      'tier_id', v_sa.tier_id,
      'quota', v_sa.quota_monthly,
      'price', v_sa.monthly_price_ars,
      'cancel_at_period_end', coalesce(v_sa.cancel_at_period_end, false),
      'current_period_end', v_sa.current_period_end,
      'pending_tier_id', v_sa.pending_tier_id,
      'pending_quota', v_sa.pending_quota,
      'pending_price', v_sa.pending_price_ars,
      'pending_from', v_sa.pending_from) end,
    'usage', jsonb_build_object('period', to_char(v_today, 'YYYY-MM'), 'sent', coalesce(v_use.sent, 0),
                                'quota', coalesce(v_use.quota, v_sa.quota_monthly, 0), 'overage', coalesce(v_use.overage, 0),
                                'blocked', coalesce(v_use.blocked, 0)),
    'using_ninjasoft', exists (select 1 from tenant_email_smtp e where e.tenant_id = v_tid and e.provider = 'ninjasoft'),
    'billing', jsonb_build_object(
      'mode', platform_effective_billing_mode(v_tid),
      'status', v_sub.status,
      'cancel_at_period_end', coalesce(v_sub.cancel_at_period_end, false),
      'trial_ends_at', v_trial,
      'has_preapproval', coalesce(btrim(v_sub.mp_preapproval_id), '') <> '',
      'cycle', v_sub.billing_cycle,
      'current_period_end', v_sub.current_period_end));
end;
$$;

-- Cotización de un escalón para el negocio actual (no escribe nada).
create or replace function owner_email_addon_quote(p_tier uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tid    uuid := current_tenant_id();
  v_tier   email_addon_tiers%rowtype;
  v_sa     subscription_addons%rowtype;
  v_sub    subscriptions%rowtype;
  v_today  date := platform_ar_date(now());
  v_old    numeric := 0;
  v_kind   text;
  v_delta  numeric;
  v_q      jsonb := jsonb_build_object('applies', false, 'cents', 0);
  v_mode   text;
  v_exp    jsonb;
  v_pct    numeric;
  v_mult   int;
  v_after  numeric;
  v_when   text;
  v_now    bigint;
begin
  if v_tid is null or not is_tenant_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_tier from email_addon_tiers where id = p_tier and is_active and deleted_at is null;
  if not found then
    raise exception 'tier_not_found';
  end if;
  select * into v_sub from subscriptions where tenant_id = v_tid;
  select * into v_sa from subscription_addons where tenant_id = v_tid and addon_key = 'email_ninjasoft';
  if v_sa.id is not null and platform_addon_billable(v_sa.status, v_sa.cancel_at_period_end, v_sa.current_period_end, v_today)
     and not coalesce(v_sa.cancel_at_period_end, false) then
    v_old := coalesce(v_sa.monthly_price_ars, 0);
    v_kind := case when v_sa.tier_id = p_tier then 'same'
                   when v_tier.monthly_price_ars > v_old then 'upgrade' else 'downgrade' end;
  else
    v_kind := 'new';
  end if;
  v_delta := case v_kind when 'new' then v_tier.monthly_price_ars
                         when 'upgrade' then v_tier.monthly_price_ars - v_old else 0 end;
  if v_kind in ('new', 'upgrade') and v_sub.status <> 'trial' then
    v_q := platform_addon_proration_quote(v_tid, v_delta);
  end if;
  v_now := case when coalesce((v_q ->> 'applies')::boolean, false) then (v_q ->> 'cents')::bigint else 0 end;
  v_mode := platform_effective_billing_mode(v_tid);
  v_exp := platform_mp_expected_amount(v_tid);
  v_pct := coalesce((v_exp -> 'breakdown' ->> 'percent_off')::numeric, 0);
  v_mult := case when v_sub.billing_cycle = 'yearly' then 12 else 1 end;
  -- Total de cada ciclo después del cambio (el descuento porcentual también
  -- alcanza al complemento).
  v_after := coalesce((v_exp ->> 'period_total')::numeric, 0)
             + round((v_tier.monthly_price_ars - case when v_kind = 'new' then 0 else v_old end) * v_mult * (100 - v_pct) / 100, 2);
  v_when := case
              when v_sub.status = 'trial' then 'trial'
              when v_kind = 'downgrade' then 'next_period'
              when v_now = 0 then 'next_period'
              when v_mode = 'mp_subscription' then 'next_debit'
              when v_mode in ('account', 'manual') then 'account'
              else 'none'
            end;
  return jsonb_build_object(
    'kind', v_kind,
    'tier', jsonb_build_object('id', v_tier.id, 'label', v_tier.label, 'quota', v_tier.monthly_quota, 'price', v_tier.monthly_price_ars),
    'old_price', v_old,
    'charge_now_cents', v_now,
    'proration', v_q,
    'when', v_when,
    'mode', v_mode,
    'cycle', v_sub.billing_cycle,
    'next_charge_date', v_exp ->> 'next_charge_date',
    'cycle_total_after', v_after,
    'next_debit_amount', case when v_mode = 'mp_subscription'
                              then v_after + round(((v_exp ->> 'adjustments_cents')::bigint + v_now)::numeric / 100, 2) end,
    'effective_from', case when v_kind = 'downgrade' then platform_period_date(v_sub.current_period_end) else v_today end);
end;
$$;

-- Alta o cambio de escalón con el precio que vio el dueño.
create or replace function owner_email_addon_activate(p_tier uuid, p_expected_price numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tid    uuid := current_tenant_id();
  v_tier   email_addon_tiers%rowtype;
  v_sub    subscriptions%rowtype;
  v_sa     subscription_addons%rowtype;
  v_today  date := platform_ar_date(now());
  v_quote  jsonb;
  v_kind   text;
  v_pstart date;
  v_pend   date;
  v_charge jsonb;
  v_label  text;
  v_name   text;
  v_email  text;
  v_sender jsonb;
begin
  if v_tid is null or not is_tenant_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not email_addon_ready() then
    raise exception 'addon_not_available';
  end if;
  select * into v_tier from email_addon_tiers where id = p_tier and is_active and deleted_at is null for share;
  if not found then
    raise exception 'tier_not_found';
  end if;
  if p_expected_price is null or round(p_expected_price, 2) <> round(v_tier.monthly_price_ars, 2) then
    raise exception 'price_changed';
  end if;
  select * into v_sub from subscriptions where tenant_id = v_tid for update;
  if not found then
    raise exception 'subscription_not_found';
  end if;
  if v_sub.status in ('suspended', 'cancelled') then
    raise exception 'subscription_inactive';
  end if;
  if coalesce(v_sub.cancel_at_period_end, false) then
    raise exception 'subscription_ending';
  end if;
  select * into v_sa from subscription_addons where tenant_id = v_tid and addon_key = 'email_ninjasoft' for update;
  if v_sa.id is not null and v_sa.source = 'granted'
     and platform_addon_usable(v_sa.status, v_sa.cancel_at_period_end, v_sa.current_period_end, v_today) then
    raise exception 'addon_granted';
  end if;

  v_quote := owner_email_addon_quote(p_tier);
  v_kind := v_quote ->> 'kind';
  v_pstart := coalesce(platform_period_date(v_sub.current_period_start), v_today);
  v_pend := coalesce(platform_period_date(v_sub.current_period_end), (v_today + interval '1 month')::date);
  v_label := 'Email NinjaSoft · ' || replace(to_char(v_tier.monthly_quota, 'FM999,999,999'), ',', '.') || ' emails';

  if v_kind = 'same' then
    -- Mismo escalón: sólo deshace un cambio programado.
    update subscription_addons
       set pending_tier_id = null, pending_price_ars = null, pending_quota = null, pending_from = null
     where id = v_sa.id;
  elsif v_kind = 'new' then
    insert into subscription_addons (tenant_id, addon_key, status, source, monthly_price_ars,
                                     current_period_start, current_period_end, cancel_at_period_end,
                                     tier_id, quota_monthly, pending_tier_id, pending_price_ars, pending_quota, pending_from)
    values (v_tid, 'email_ninjasoft', 'active', 'purchased', v_tier.monthly_price_ars,
            v_pstart, v_pend, false, v_tier.id, v_tier.monthly_quota, null, null, null, null)
    on conflict (tenant_id, addon_key) do update
       set status = 'active',
           source = 'purchased',
           monthly_price_ars = excluded.monthly_price_ars,
           current_period_start = excluded.current_period_start,
           current_period_end = excluded.current_period_end,
           cancel_at_period_end = false,
           tier_id = excluded.tier_id,
           quota_monthly = excluded.quota_monthly,
           pending_tier_id = null, pending_price_ars = null, pending_quota = null, pending_from = null;
    -- Una baja programada que se deshace no dispara el trigger (sigue
    -- 'active'): el período ya estaba pago con el precio viejo, el cambio de
    -- precio se cobra prorrateado acá.
    if v_sa.id is not null and v_sa.status = 'active' then
      if v_tier.monthly_price_ars > coalesce(v_sa.monthly_price_ars, 0) and v_sub.status <> 'trial' then
        v_charge := platform_addon_proration_charge(v_tid, 'email_ninjasoft', v_label,
          v_tier.monthly_price_ars - coalesce(v_sa.monthly_price_ars, 0),
          'addon_tier:' || v_sa.id::text || ':' || v_tier.id::text || ':' || v_pstart::text);
      end if;
    end if;
  elsif v_kind = 'upgrade' then
    update subscription_addons
       set tier_id = v_tier.id, quota_monthly = v_tier.monthly_quota, monthly_price_ars = v_tier.monthly_price_ars,
           pending_tier_id = null, pending_price_ars = null, pending_quota = null, pending_from = null
     where id = v_sa.id;
    if v_sub.status <> 'trial' then
      v_charge := platform_addon_proration_charge(v_tid, 'email_ninjasoft', v_label,
        v_tier.monthly_price_ars - coalesce(v_sa.monthly_price_ars, 0),
        'addon_tier:' || v_sa.id::text || ':' || v_tier.id::text || ':' || v_pstart::text);
    end if;
  else
    -- downgrade: el cupo y el precio bajan al empezar el próximo período (lo
    -- pagado se respeta y no se devuelve).
    update subscription_addons
       set pending_tier_id = v_tier.id, pending_price_ars = v_tier.monthly_price_ars,
           pending_quota = v_tier.monthly_quota, pending_from = v_pend
     where id = v_sa.id;
  end if;

  -- El envío del negocio pasa a salir por el remitente de NinjaSoft.
  insert into tenant_email_smtp (tenant_id, provider) values (v_tid, 'ninjasoft')
  on conflict (tenant_id) do update set provider = 'ninjasoft', updated_at = now();

  v_sender := email_addon_sender(v_tid);
  select t.name, u.email into v_name, v_email
    from tenants t
    left join tenant_users tu on tu.tenant_id = t.id and tu.role = 'owner' and tu.status = 'active'
    left join users u on u.id = tu.user_id
   where t.id = v_tid
   order by tu.created_at limit 1;

  if v_kind <> 'same' then
    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (v_tid, 'owner', 'plan', 'success',
            case v_kind when 'new' then 'Sumaste el email de NinjaSoft' else 'Cambiaste tu escalón de emails' end,
            'Tus emails salen desde ' || (v_sender ->> 'from_email') || ' con ' ||
              replace(to_char(v_tier.monthly_quota, 'FM999,999,999'), ',', '.') || ' emails por mes'
              || case when v_kind = 'downgrade' then ' desde el ' || to_char(v_pend, 'DD/MM/YYYY') else '' end || '.',
            false);
    perform enqueue_system_email(
      v_tid, v_email, 'addon_email_activated',
      jsonb_build_object('negocio', coalesce(v_name, ''), 'remitente', v_sender ->> 'from_email',
                         'cupo', v_tier.monthly_quota::text, 'precio', platform_format_ars(platform_cents(v_tier.monthly_price_ars))),
      'Tus emails ya salen con NinjaSoft',
      _dunning_email_html(coalesce(v_name, ''), 'Tus emails ya salen con NinjaSoft',
        'Desde ahora tus comprobantes, presupuestos y avisos salen desde ' || (v_sender ->> 'from_email')
          || ' y las respuestas te llegan a ' || coalesce(v_sender ->> 'reply_to', 'tu email')
          || '. Tu escalón: ' || replace(to_char(v_tier.monthly_quota, 'FM999,999,999'), ',', '.')
          || ' emails por mes por ' || platform_format_ars(platform_cents(v_tier.monthly_price_ars)) || ', que se suman a tu suscripción.'));
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tid, auth.uid(), 'subscription_addons', v_tid, 'addon_email_activated',
          case when v_sa.id is null then null else jsonb_build_object(
            'status', v_sa.status, 'tier_id', v_sa.tier_id, 'monthly_price_ars', v_sa.monthly_price_ars,
            'cancel_at_period_end', v_sa.cancel_at_period_end) end,
          jsonb_build_object('kind', v_kind, 'tier_id', v_tier.id, 'quota', v_tier.monthly_quota,
                             'monthly_price_ars', v_tier.monthly_price_ars, 'quote', v_quote, 'charge', v_charge,
                             'from_email', v_sender ->> 'from_email'));

  return jsonb_build_object('ok', true, 'kind', v_kind, 'quote', v_quote, 'charge', v_charge,
                            'sender', v_sender, 'expected', platform_mp_expected_amount(v_tid));
end;
$$;

-- Elegir (o dejar) el remitente de NinjaSoft para los emails del negocio.
create or replace function owner_email_addon_use(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tid uuid := current_tenant_id();
  v_sa  subscription_addons%rowtype;
begin
  if v_tid is null or not exists (
       select 1 from tenant_users me
        where me.tenant_id = v_tid and me.user_id = auth.uid() and me.status = 'active'
          and me.role in ('owner', 'manager')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(p_on, false) then
    select * into v_sa from subscription_addons where tenant_id = v_tid and addon_key = 'email_ninjasoft';
    if v_sa.id is null or not platform_addon_usable(v_sa.status, v_sa.cancel_at_period_end, v_sa.current_period_end,
                                                    platform_ar_date(now())) then
      raise exception 'addon_inactive';
    end if;
    insert into tenant_email_smtp (tenant_id, provider) values (v_tid, 'ninjasoft')
    on conflict (tenant_id) do update set provider = 'ninjasoft', updated_at = now();
  else
    perform email_addon_restore_provider(v_tid);
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tid, auth.uid(), 'tenant', v_tid, 'tenant_smtp_updated',
          jsonb_build_object('provider', case when p_on then 'ninjasoft' else 'own' end));
  return jsonb_build_object('ok', true, 'provider', case when p_on then 'ninjasoft' else 'own' end);
end;
$$;

-- get_tenant_smtp (copia de 20260608235000) con el proveedor 'ninjasoft'.
create or replace function get_tenant_smtp()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when not exists (
      select 1 from tenant_users me
      where me.tenant_id = current_tenant_id()
        and me.user_id = auth.uid()
        and me.status = 'active'
        and me.role in ('owner', 'manager')
    ) then jsonb_build_object('allowed', false, 'configured', false)
    else coalesce(
      (
        select jsonb_build_object(
          'allowed', true,
          'configured', case
            when coalesce(provider, 'smtp') = 'ninjasoft'
              then exists (select 1 from subscription_addons sa
                            where sa.tenant_id = e.tenant_id and sa.addon_key = 'email_ninjasoft'
                              and platform_addon_usable(sa.status, sa.cancel_at_period_end, sa.current_period_end,
                                                        platform_ar_date(now())))
            when coalesce(provider, 'smtp') = 'resend'
              then (resend_api_key <> '' and from_email <> '')
            else (host <> '' and from_email <> '')
          end,
          'provider', coalesce(provider, 'smtp'),
          'host', host, 'port', port, 'secure', secure, 'username', username,
          'from_name', from_name, 'from_email', from_email,
          'body_text', body_text,
          'body_template', body_template,
          'has_password', (password <> ''),
          'has_resend_key', (resend_api_key <> '')
        ) from tenant_email_smtp e where e.tenant_id = current_tenant_id()
      ),
      jsonb_build_object('allowed', true, 'configured', false)
    )
  end;
$$;

-- -----------------------------------------------------------------------------
-- J) RPC del staff (Complementos): configuración y escalones
-- -----------------------------------------------------------------------------
create or replace function email_addon_assert_staff()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(platform_staff_billing_role(), '') not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

create or replace function internal_email_addon_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_set    email_addon_settings%rowtype;
  v_period text := to_char(platform_ar_date(now()), 'YYYY-MM');
begin
  perform email_addon_assert_staff();
  select * into v_set from email_addon_settings where id;
  return jsonb_build_object(
    'settings', jsonb_build_object(
      'domain', v_set.domain, 'sender_mode', v_set.sender_mode, 'fixed_local', v_set.fixed_local,
      'overage_policy', v_set.overage_policy, 'overage_block_size', v_set.overage_block_size,
      'overage_block_price', v_set.overage_block_price_ars,
      'key_source', v_set.key_source, 'key_hint', v_set.key_hint, 'key_checked_at', v_set.key_checked_at,
      'domain_id', v_set.domain_id, 'domain_status', v_set.domain_status, 'domain_region', v_set.domain_region,
      'dns_records', v_set.dns_records, 'domain_checked_at', v_set.domain_checked_at,
      'updated_at', v_set.updated_at),
    'is_active', coalesce((select is_active from plan_addons where key = 'email_ninjasoft'), false),
    'ready', email_addon_ready(),
    'tiers', coalesce((select jsonb_agg(jsonb_build_object(
                'id', t.id, 'label', t.label, 'quota', t.monthly_quota, 'price', t.monthly_price_ars,
                'sort', t.sort, 'is_active', t.is_active,
                'tenants', (select count(*) from subscription_addons sa
                             where sa.tier_id = t.id and sa.status = 'active')) order by t.sort, t.monthly_price_ars)
              from email_addon_tiers t where t.deleted_at is null), '[]'::jsonb),
    'usage', coalesce((select jsonb_agg(jsonb_build_object(
                'tenant_id', u.tenant_id, 'tenant_name', tn.name, 'sent', u.sent, 'quota', u.quota,
                'overage', u.overage, 'blocked', u.blocked) order by u.sent desc)
              from (select * from email_addon_usage where period = v_period order by sent desc limit 50) u
              join tenants tn on tn.id = u.tenant_id), '[]'::jsonb),
    'period', v_period);
end;
$$;

create or replace function internal_email_addon_save_settings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old email_addon_settings%rowtype;
  v_new email_addon_settings%rowtype;
  v_active boolean;
begin
  perform email_addon_assert_staff();
  select * into v_old from email_addon_settings where id for update;
  update email_addon_settings
     set sender_mode = coalesce(nullif(p ->> 'sender_mode', ''), sender_mode),
         fixed_local = coalesce(nullif(lower(btrim(p ->> 'fixed_local')), ''), fixed_local),
         overage_policy = coalesce(nullif(p ->> 'overage_policy', ''), overage_policy),
         overage_block_size = coalesce(nullif(p ->> 'overage_block_size', '')::int, overage_block_size),
         overage_block_price_ars = coalesce(nullif(p ->> 'overage_block_price', '')::numeric, overage_block_price_ars),
         updated_at = now(),
         updated_by = auth.uid()
   where id
   returning * into v_new;
  if v_new.overage_policy = 'charge' and coalesce(v_new.overage_block_price_ars, 0) <= 0 then
    raise exception 'overage_price_required';
  end if;

  if p ? 'is_active' then
    v_active := coalesce((p ->> 'is_active')::boolean, false);
    if v_active and not (coalesce(v_new.domain_status, '') = 'verified' and v_new.key_source is not null
                         and exists (select 1 from email_addon_tiers where is_active and deleted_at is null)) then
      raise exception 'addon_not_ready';
    end if;
    update plan_addons set is_active = v_active where key = 'email_ninjasoft';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (null, auth.uid(), 'email_addon_settings', null, 'email_addon_settings_saved',
          jsonb_build_object('sender_mode', v_old.sender_mode, 'fixed_local', v_old.fixed_local,
                             'overage_policy', v_old.overage_policy, 'overage_block_size', v_old.overage_block_size,
                             'overage_block_price', v_old.overage_block_price_ars),
          jsonb_build_object('sender_mode', v_new.sender_mode, 'fixed_local', v_new.fixed_local,
                             'overage_policy', v_new.overage_policy, 'overage_block_size', v_new.overage_block_size,
                             'overage_block_price', v_new.overage_block_price_ars, 'is_active', v_active));
  return internal_email_addon_get();
end;
$$;

create or replace function internal_email_addon_save_tier(
  p_id uuid, p_label text, p_quota int, p_price numeric, p_sort int default 0, p_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old email_addon_tiers%rowtype;
  v_id  uuid;
begin
  perform email_addon_assert_staff();
  if coalesce(btrim(p_label), '') = '' then raise exception 'invalid_label'; end if;
  if coalesce(p_quota, 0) <= 0 then raise exception 'invalid_quota'; end if;
  if coalesce(p_price, 0) <= 0 then raise exception 'invalid_price'; end if;
  if p_id is null then
    insert into email_addon_tiers (label, monthly_quota, monthly_price_ars, sort, is_active, created_by)
    values (btrim(p_label), p_quota, round(p_price, 2), coalesce(p_sort, 0), coalesce(p_active, true), auth.uid())
    returning id into v_id;
  else
    select * into v_old from email_addon_tiers where id = p_id and deleted_at is null for update;
    if not found then raise exception 'tier_not_found'; end if;
    -- Precio y cupo de un escalón rigen para las altas nuevas: los negocios que
    -- ya lo tienen conservan lo que contrataron (subscription_addons guarda su
    -- precio y su cupo).
    update email_addon_tiers
       set label = btrim(p_label), monthly_quota = p_quota, monthly_price_ars = round(p_price, 2),
           sort = coalesce(p_sort, sort), is_active = coalesce(p_active, is_active), updated_at = now()
     where id = p_id;
    v_id := p_id;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (null, auth.uid(), 'email_addon_tiers', v_id, case when p_id is null then 'email_addon_tier_created' else 'email_addon_tier_updated' end,
          case when p_id is null then null else jsonb_build_object('label', v_old.label, 'quota', v_old.monthly_quota,
                                                                    'price', v_old.monthly_price_ars, 'is_active', v_old.is_active) end,
          jsonb_build_object('label', btrim(p_label), 'quota', p_quota, 'price', round(p_price, 2), 'is_active', p_active));
  return v_id;
end;
$$;

create or replace function internal_email_addon_delete_tier(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform email_addon_assert_staff();
  update email_addon_tiers set deleted_at = now(), is_active = false, updated_at = now()
   where id = p_id and deleted_at is null;
  if not found then raise exception 'tier_not_found'; end if;
  if not exists (select 1 from email_addon_tiers where is_active and deleted_at is null) then
    update plan_addons set is_active = false where key = 'email_ninjasoft';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (null, auth.uid(), 'email_addon_tiers', p_id, 'email_addon_tier_deleted', jsonb_build_object('deleted', true));
end;
$$;

-- Lo graba la Edge email_addon_admin (service_role) después de probar la key
-- y el dominio contra Resend.
create or replace function email_addon_set_provider_state(p jsonb, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update email_addon_settings
     set key_source = case when p ? 'key_source' then nullif(p ->> 'key_source', '') else key_source end,
         key_hint = case when p ? 'key_hint' then nullif(p ->> 'key_hint', '') else key_hint end,
         key_checked_at = case when p ? 'key_source' then now() else key_checked_at end,
         domain = coalesce(nullif(lower(btrim(p ->> 'domain')), ''), domain),
         domain_id = case when p ? 'domain_id' then nullif(p ->> 'domain_id', '') else domain_id end,
         domain_status = case when p ? 'domain_status' then nullif(p ->> 'domain_status', '') else domain_status end,
         domain_region = case when p ? 'domain_region' then nullif(p ->> 'domain_region', '') else domain_region end,
         dns_records = case when p ? 'dns_records' then coalesce(p -> 'dns_records', '[]'::jsonb) else dns_records end,
         domain_checked_at = case when p ? 'domain_status' then now() else domain_checked_at end,
         updated_at = now(),
         updated_by = coalesce(p_actor, updated_by)
   where id;
  -- Sin dominio verificado o sin key el complemento deja de venderse (los que
  -- lo tienen ven el error en el envío y en su panel).
  if exists (select 1 from email_addon_settings where id and (coalesce(domain_status, '') <> 'verified' or key_source is null)) then
    update plan_addons set is_active = false where key = 'email_ninjasoft' and is_active;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (null, p_actor, 'email_addon_settings', null, 'email_addon_provider_checked',
          p - 'dns_records');
end;
$$;

-- -----------------------------------------------------------------------------
-- K) Permisos
-- -----------------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'owner_email_addon_offer()',
    'owner_email_addon_quote(uuid)',
    'owner_email_addon_activate(uuid, numeric)',
    'owner_email_addon_use(boolean)',
    'internal_email_addon_get()',
    'internal_email_addon_save_settings(jsonb)',
    'internal_email_addon_save_tier(uuid, text, int, numeric, int, boolean)',
    'internal_email_addon_delete_tier(uuid)',
    'activate_addon(text)',
    'cancel_addon(text)',
    'get_tenant_smtp()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  foreach f in array array[
    'email_addon_consume(uuid, int)',
    'email_addon_release(uuid, int)',
    'email_addon_bill_overage(text)',
    'email_addon_sender(uuid)',
    'email_addon_warn(uuid, int, int, int, text)',
    'email_addon_restore_provider(uuid)',
    'email_addon_set_provider_state(jsonb, uuid)',
    'platform_mp_expected_amount(uuid)',
    'platform_mp_amount_targets(int)',
    'platform_addons_daily()',
    'platform_addon_proration_quote(uuid, numeric)',
    'platform_addon_proration_charge(uuid, text, text, numeric, text)',
    'platform_trial_debit_pending(uuid, timestamptz)',
    'trg_subscription_addons_proration()',
    'reanchor_subscription_period(uuid, int, timestamptz)',
    'run_saas_dunning()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- Helpers puros: los usan las RPC de arriba.
  foreach f in array array[
    'platform_addon_billable(text, boolean, date, date)',
    'platform_addon_usable(text, boolean, date, date)',
    'platform_addon_price_on(text, numeric, numeric, date, numeric, date, date)',
    'email_addon_local_part(text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;

  execute 'revoke all on function email_addon_ready() from public, anon';
  execute 'grant execute on function email_addon_ready() to authenticated, service_role';
  execute 'revoke all on function email_addon_assert_staff() from public, anon';
  execute 'grant execute on function email_addon_assert_staff() to authenticated';
end
$grants$;

-- -----------------------------------------------------------------------------
-- L) pg_cron: addons (03:20 ART), excedente de emails (día 1, 03:40 ART) y
--    sincronización del monto de MP por la Edge (08:30 ART). Sin pg_cron o sin
--    pg_net (local, CI) se omite.
-- -----------------------------------------------------------------------------
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/mp_update_subscription_amount';
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omiten platform-addons-daily, email-addon-overage y platform-mp-amount-sync.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'platform-addons-daily') then
    perform cron.unschedule('platform-addons-daily');
  end if;
  perform cron.schedule('platform-addons-daily', '20 6 * * *', $$select public.platform_addons_daily()$$);
  if exists (select 1 from cron.job where jobname = 'email-addon-overage') then
    perform cron.unschedule('email-addon-overage');
  end if;
  perform cron.schedule('email-addon-overage', '40 6 1 * *', $$select public.email_addon_bill_overage(null)$$);

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omite platform-mp-amount-sync.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'platform-mp-amount-sync') then
    perform cron.unschedule('platform-mp-amount-sync');
  end if;
  perform cron.schedule('platform-mp-amount-sync', '30 11 * * *', format($job$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'apikey', (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'X-Cron-Secret', (select secrets ->> 'token' from platform_secrets where key = 'internal_cron')
      ),
      body := jsonb_build_object('mode', 'cron'),
      timeout_milliseconds := 55000
    );
  $job$, v_url));
end
$cron$;
