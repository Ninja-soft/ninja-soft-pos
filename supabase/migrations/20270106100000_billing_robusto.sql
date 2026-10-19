-- =============================================================================
-- ADR-167: cobro SaaS robusto. Deudas de la revisión de ADR-156.
--
--   · B-3  email_addon_bill_overage: cada negocio en su propio bloque
--          begin/exception (un error ya no corta el cron del mes), sin
--          suscripción no se cobra (se audita), y el complemento bonificado
--          (source = 'granted') no paga excedente (se audita como bonificado).
--   · B-2  ai_available() y platform_mrr_cents() usan la misma regla que el
--          gating y la facturación: platform_addon_usable (acceso, fecha AR) y
--          platform_addon_billable + platform_addon_price_on (MRR: sin prueba
--          del complemento, escalón pendiente desde su fecha, bonificado en 0).
--   · M-b  Un pago que no es el débito de MP (manual, transferencia, checkout)
--          de un negocio con débito automático re-sincroniza el monto del
--          preapproval en el momento (pg_net a mp_update_subscription_amount en
--          modo cron, que corrige sólo los montos que difieren). Antes había
--          que esperar a la corrida diaria de las 08:30 y MP podía debitar el
--          ajuste ya pagado. Si igual se cobra de más, el ledger lo deja como
--          saldo a favor y lo imputa solo al próximo cargo (no se pierde).
--
-- Base: definiciones vivas en producción (2026-10-19). Sin tablas nuevas.
-- Staff y cron por funciones SECURITY DEFINER; nunca is_internal() suelto.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- B-3 · Excedente de emails: fila por fila
-- -----------------------------------------------------------------------------
create or replace function public.email_addon_bill_overage(p_period text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
  v_failed int := 0;
  v_skip   int := 0;
begin
  select * into v_set from email_addon_settings where id;
  v_unit := platform_cents(coalesce(v_set.overage_block_price_ars, 0));
  if v_unit <= 0 then
    return jsonb_build_object('period', v_period, 'charged', 0, 'reason', 'no_price');
  end if;
  for r in
    select u.* from email_addon_usage u
     where u.period = v_period and u.overage > 0 and u.overage_policy = 'charge' and u.billed_charge_id is null
     order by u.tenant_id
  loop
    begin
      if platform_billing_exclusion(r.tenant_id) is not null then
        continue;
      end if;

      -- Bonificado: NinjaSoft regaló el complemento; el excedente no se cobra.
      if exists (select 1 from subscription_addons sa
                  where sa.tenant_id = r.tenant_id and sa.addon_key = 'email_ninjasoft' and sa.source = 'granted') then
        insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
        values (r.tenant_id, null, 'email_addon_usage', r.tenant_id, 'email_overage_waived',
                jsonb_build_object('period', v_period, 'overage', r.overage, 'reason', 'granted'));
        v_skip := v_skip + 1;
        continue;
      end if;

      v_sub := null;
      select * into v_sub from subscriptions where tenant_id = r.tenant_id;
      if v_sub.id is null then
        insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
        values (r.tenant_id, null, 'email_addon_usage', r.tenant_id, 'email_overage_bill_skipped',
                jsonb_build_object('period', v_period, 'overage', r.overage, 'reason', 'no_subscription'));
        v_skip := v_skip + 1;
        continue;
      end if;

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
    exception when others then
      v_failed := v_failed + 1;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
      values (r.tenant_id, null, 'email_addon_usage', r.tenant_id, 'email_overage_bill_failed',
              jsonb_build_object('period', v_period, 'overage', r.overage, 'error', sqlerrm, 'sqlstate', sqlstate));
    end;
  end loop;
  return jsonb_build_object('period', v_period, 'charged', v_n, 'skipped', v_skip, 'failed', v_failed);
end;
$function$;

-- -----------------------------------------------------------------------------
-- B-2 · Acceso a la IA con la regla del gating (platform_addon_usable, fecha AR)
-- -----------------------------------------------------------------------------
create or replace function public.ai_available()
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  with t as (select current_tenant_id() as tid)
  select coalesce(
    (select true from subscription_addons sa join t on t.tid = sa.tenant_id
      where sa.addon_key in ('asistente_ia', 'ai_assistant')
        and platform_addon_usable(sa.status, sa.cancel_at_period_end, sa.current_period_end,
                                  platform_ar_date(now()))
      limit 1),
    (select tff.enabled from tenant_feature_flags tff
       join feature_flags ff on ff.id = tff.feature_flag_id
       join t on t.tid = tff.tenant_id
      where ff.key in ('asistente_ia', 'ai_assistant') limit 1),
    (select true
       from t
       join tenant_users tu on tu.tenant_id = t.tid
        and tu.role = 'owner' and tu.status = 'active'
       join users u on u.id = tu.user_id
      where lower(u.email) = lower(nullif(
              (select secrets ->> 'beta_owner_email'
                 from platform_secrets where key = 'ai_config'), ''))
      limit 1),
    false
  );
$function$;

-- -----------------------------------------------------------------------------
-- B-2 · MRR con la regla de la facturación (billable + precio del día)
-- -----------------------------------------------------------------------------
create or replace function public.platform_mrr_cents(p_tenant uuid, p_plan uuid, p_cycle text, p_day date)
returns bigint
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  with pl as (
    select case when p_cycle = 'yearly'
                then coalesce(nullif(p.yearly_price_ars, 0), p.monthly_price_ars * 12)
                else p.monthly_price_ars end as amount
      from plans p
     where p.id = p_plan
  ),
  ad as (
    select coalesce(sum(platform_addon_price_on(sa.source, sa.monthly_price_ars, pa.monthly_price_ars, sa.trial_ends_at,
                                                sa.pending_price_ars, sa.pending_from, p_day)), 0) as monthly
      from subscription_addons sa
      left join plan_addons pa on pa.key = sa.addon_key
     where sa.tenant_id = p_tenant
       and sa.created_at < ((p_day + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
       and platform_addon_billable(sa.status, sa.cancel_at_period_end, sa.current_period_end, p_day)
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
$function$;

-- -----------------------------------------------------------------------------
-- M-b · Pago por otro medio → re-sincronizar el monto del débito de MP ya
-- -----------------------------------------------------------------------------
-- Pide la sincronización del monto de los preapprovals (modo cron de la Edge:
-- recorre platform_mp_amount_targets y corrige sólo los que difieren, así que es
-- idempotente y no toca a quien ya está bien). pg_net encola el pedido y lo manda
-- después del commit: la Edge ve el pago ya imputado. Nunca hace fallar el pago.
create or replace function public.platform_request_mp_amount_sync(p_reason text default null)
returns bigint
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sec jsonb;
  v_id  bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return null;
  end if;
  select secrets into v_sec from platform_secrets where key = 'internal_cron';
  if coalesce(v_sec ->> 'token', '') = '' or coalesce(v_sec ->> 'apikey', '') = '' then
    return null;
  end if;
  select net.http_post(
    url := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/mp_update_subscription_amount',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (v_sec ->> 'apikey'),
      'apikey', v_sec ->> 'apikey',
      'X-Cron-Secret', v_sec ->> 'token'),
    body := jsonb_build_object('mode', 'cron', 'reason', coalesce(p_reason, 'manual')),
    timeout_milliseconds := 60000) into v_id;
  return v_id;
end;
$function$;
revoke all on function public.platform_request_mp_amount_sync(text) from public, anon, authenticated;

create or replace function public.trg_platform_payments_mp_amount_sync()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_req bigint;
begin
  if new.method = 'mp_preapproval' or new.status <> 'approved' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' then
    return null;
  end if;
  begin
    if platform_effective_billing_mode(new.tenant_id) <> 'mp_subscription'
       or not exists (select 1 from subscriptions s
                       where s.tenant_id = new.tenant_id
                         and coalesce(btrim(s.mp_preapproval_id), '') <> ''
                         and s.status in ('trial', 'active', 'past_due')) then
      return null;
    end if;
    v_req := platform_request_mp_amount_sync('payment:' || new.id::text);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, null, 'platform_payments', new.id, 'platform_mp_amount_sync_requested',
            jsonb_build_object('method', new.method, 'amount_cents', new.amount_cents, 'request_id', v_req));
  exception when others then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, null, 'platform_payments', new.id, 'platform_mp_amount_sync_failed',
            jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate));
  end;
  return null;
end;
$function$;

drop trigger if exists platform_payments_mp_amount_sync on public.platform_payments;
create trigger platform_payments_mp_amount_sync
  after insert or update of status on public.platform_payments
  for each row execute function public.trg_platform_payments_mp_amount_sync();
