-- =============================================================================
-- 20261218100000_registro_onboarding  (ADR-154)
--
-- Arreglos del registro y la puesta en marcha reportados con una cuenta nueva:
--
-- A) Códigos de invitación que respetan TODO al crear la cuenta:
--    * invite_codes.ai_included / ai_months: el código bonifica el Asistente IA
--      (addon ai_assistant) por N meses o para siempre (ai_months null).
--    * El descuento (discount_percent / discount_months) ahora vale también
--      para los códigos de días de prueba (antes sólo cuenta corriente). En un
--      código de prueba el descuento arranca cuando termina la prueba.
--    * redeem_invite_code: aplica plan, días de prueba (ahora también en el
--      período de la suscripción, no sólo en tenants.trial_ends_at), descuento
--      e IA bonificada del lado del servidor, y lo audita.
-- B) subscription_addons.granted_until: fin de una bonificación con plazo. El
--    job diario `addon-grant-expire` (expire_granted_addons) la da de baja al
--    vencer y avisa al dueño, sin cobrar nada por su cuenta: si lo quiere,
--    lo activa desde Suscripción. internal_grant_addon (bonificación manual
--    del staff) sigue siendo para siempre y limpia un plazo viejo.
-- C) Puesta en marcha: onboarding_tenant_signals suma 'marca' (logo), 'email'
--    (envío de comprobantes configurado) y 'pagos' (algún medio de pago
--    electrónico o una cuenta para transferencias); onboarding_status los
--    devuelve junto con los pasos base.
--
-- Sin tablas ni policies nuevas: los guards rls_internal_scope_leaks(),
-- rls_bare_current_tenant_policies() y rls_policies_without_initplan() no
-- cambian. Todas las funciones son SECURITY DEFINER con search_path fijo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Columnas nuevas
-- -----------------------------------------------------------------------------
alter table invite_codes
  add column if not exists ai_included boolean not null default false,
  add column if not exists ai_months int check (ai_months is null or ai_months between 1 and 60);

comment on column invite_codes.ai_included is
  'ADR-154: el código bonifica el Asistente IA (addon ai_assistant) al canjearse.';
comment on column invite_codes.ai_months is
  'ADR-154: meses de IA bonificada; null = para siempre. Sólo con ai_included.';

alter table subscription_addons
  add column if not exists granted_until date;

comment on column subscription_addons.granted_until is
  'ADR-154: último día de una bonificación con plazo (source = granted). null = sin vencimiento. expire_granted_addons() la da de baja al vencer.';

-- -----------------------------------------------------------------------------
-- A') Alta de códigos (mismo contrato que 20261116100000 + IA y descuento en
--     códigos de prueba).
-- p_data: {code, kind, plan_key, trial_days, max_uses, valid_from, valid_until,
--          due_days, discount_percent, discount_months, billing_cycle, notes,
--          ai_included, ai_months}
-- -----------------------------------------------------------------------------
create or replace function internal_invite_code_create(p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role  text := platform_assert_invite_admin();
  v_code  text := upper(btrim(coalesce(p_data ->> 'code', '')));
  v_kind  text := coalesce(p_data ->> 'kind', '');
  v_plan  text := btrim(coalesce(p_data ->> 'plan_key', ''));
  v_disc  boolean;
  v_ai    boolean := coalesce((p_data ->> 'ai_included')::boolean, false);
  v_id    uuid;
begin
  if v_code !~ '^[A-Z0-9_-]{4,32}$' then
    raise exception 'invalid_code' using errcode = '22023';
  end if;
  if v_kind not in ('lifetime', 'trial_days', 'account') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if v_kind = 'lifetime' and v_role <> 'super_admin' then
    raise exception 'forbidden_lifetime' using errcode = '42501';
  end if;
  if not exists (select 1 from plans where key = v_plan and tenant_id is null and is_active) then
    raise exception 'plan_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from invite_codes where upper(code) = v_code and deleted_at is null) then
    raise exception 'code_taken' using errcode = '23505';
  end if;
  if (p_data ->> 'valid_from') is not null and (p_data ->> 'valid_until') is not null
     and (p_data ->> 'valid_until')::date < (p_data ->> 'valid_from')::date then
    raise exception 'invalid_validity' using errcode = '22023';
  end if;
  if v_ai and not exists (select 1 from plan_addons where key = 'ai_assistant') then
    raise exception 'addon_not_found' using errcode = 'P0002';
  end if;

  -- Descuento: cuenta corriente y días de prueba (un vitalicio no paga).
  v_disc := v_kind in ('account', 'trial_days') and nullif(p_data ->> 'discount_percent', '') is not null;

  insert into invite_codes (code, kind, plan_key, trial_days, max_uses, valid_from, valid_until, due_days,
                            discount_percent, discount_months, billing_cycle, notes,
                            ai_included, ai_months, created_by)
  values (v_code, v_kind, v_plan,
          case when v_kind = 'trial_days' then coalesce((p_data ->> 'trial_days')::int, 14) end,
          nullif(p_data ->> 'max_uses', '')::int,
          nullif(p_data ->> 'valid_from', '')::date,
          nullif(p_data ->> 'valid_until', '')::date,
          case when v_kind = 'account' then coalesce(nullif(p_data ->> 'due_days', '')::int, 10) end,
          case when v_disc then nullif(p_data ->> 'discount_percent', '')::numeric end,
          case when v_disc then nullif(p_data ->> 'discount_months', '')::int end,
          case when v_kind = 'account' then coalesce(nullif(p_data ->> 'billing_cycle', ''), 'monthly') end,
          nullif(btrim(coalesce(p_data ->> 'notes', '')), ''),
          v_ai,
          case when v_ai then nullif(p_data ->> 'ai_months', '')::int end,
          auth.uid())
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  select null, auth.uid(), 'invite_codes', v_id, 'invite_code_created', to_jsonb(c) from invite_codes c where c.id = v_id;
  return v_id;
end;
$$;
revoke all on function internal_invite_code_create(jsonb) from public, anon;
grant execute on function internal_invite_code_create(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- A'') Canje (mismo contrato que 20261116100000) + IA bonificada, descuento en
--      códigos de prueba y período de prueba también en la suscripción.
-- -----------------------------------------------------------------------------
create or replace function redeem_invite_code(p_code text, p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code       invite_codes%rowtype;
  v_plan_id    uuid;
  v_cycle      text;
  v_from       date;
  v_until      date;
  v_trial_end  timestamptz;
  v_ai_until   date;
  v_addon_id   uuid;
  v_today      date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  if not exists (
    select 1 from tenant_users
    where tenant_id = p_tenant_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'forbidden';
  end if;

  select * into v_code from invite_codes
   where upper(code) = upper(btrim(p_code)) and deleted_at is null
   for update;
  if not found then raise exception 'invalid_code'; end if;
  if not v_code.is_active then raise exception 'code_inactive'; end if;
  if v_code.valid_from is not null and current_date < v_code.valid_from then
    raise exception 'code_not_started';
  end if;
  if v_code.valid_until is not null and current_date > v_code.valid_until then
    raise exception 'code_expired';
  end if;
  if v_code.max_uses is not null and v_code.used_count >= v_code.max_uses then
    raise exception 'code_exhausted';
  end if;
  -- Un negocio canjea un solo código de cuenta corriente.
  if v_code.kind = 'account' and exists (
    select 1 from audit_logs a
     where a.tenant_id = p_tenant_id and a.action = 'invite_code_redeemed' and a.after_data ->> 'kind' = 'account'
  ) then
    raise exception 'code_already_redeemed';
  end if;

  select id into v_plan_id from plans
   where key = v_code.plan_key and tenant_id is null and is_active limit 1;
  if v_plan_id is null then raise exception 'plan_not_found'; end if;

  if v_code.kind = 'lifetime' then
    update subscriptions
       set plan_id = v_plan_id, status = 'active', is_lifetime = true,
           updated_at = now()
     where tenant_id = p_tenant_id;
    update tenants set status = 'active', trial_ends_at = null, updated_at = now()
     where id = p_tenant_id;
  elsif v_code.kind = 'account' then
    v_cycle := coalesce(v_code.billing_cycle, 'monthly');
    -- Primero el plan (todavía en prueba: no prorratea) y después el período.
    update subscriptions set plan_id = v_plan_id, updated_at = now() where tenant_id = p_tenant_id;
    update subscriptions
       set status = 'active', is_lifetime = false, billing_cycle = v_cycle,
           cancel_at_period_end = false,
           current_period_start = now(),
           current_period_end = now() + case when v_cycle = 'yearly' then interval '12 months' else interval '1 month' end,
           updated_at = now()
     where tenant_id = p_tenant_id;
    update tenants set status = 'active', trial_ends_at = null, updated_at = now()
     where id = p_tenant_id;

    insert into tenant_billing_terms (tenant_id, billing_mode, due_days, notes, created_by, updated_by)
    values (p_tenant_id, 'account', v_code.due_days, 'Alta con el código ' || v_code.code, auth.uid(), auth.uid())
    on conflict (tenant_id) do update
       set billing_mode = 'account', due_days = excluded.due_days, pending_mode = null, pending_since = null,
           notes = excluded.notes, updated_by = auth.uid();

    insert into platform_billing_mode_changes (tenant_id, from_mode, to_mode, status, source, mp_cancel_status,
                                               reason, created_by, completed_at)
    values (p_tenant_id, null, 'account', 'applied', 'invite_code', 'not_needed',
            'Alta con el código ' || v_code.code, auth.uid(), now());
  else
    -- Días de prueba: el plan del código y la prueba extendida, también en el
    -- período de la suscripción (antes quedaba en los 14 días del alta).
    v_trial_end := now() + make_interval(days => coalesce(v_code.trial_days, 14));
    update subscriptions
       set plan_id = v_plan_id, status = 'trial', is_lifetime = false,
           current_period_start = now(), current_period_end = v_trial_end,
           updated_at = now()
     where tenant_id = p_tenant_id;
    update tenants
       set status = 'trial',
           trial_ends_at = v_trial_end,
           updated_at = now()
     where id = p_tenant_id;
  end if;

  -- Descuento (cuenta corriente desde hoy; prueba desde que termina la prueba).
  if v_code.discount_percent is not null and v_code.kind in ('account', 'trial_days') then
    v_from := case when v_code.kind = 'trial_days'
                   then (v_trial_end at time zone 'America/Argentina/Buenos_Aires')::date
                   else v_today end;
    v_until := case when v_code.discount_months is not null
                    then (v_from + make_interval(months => v_code.discount_months))::date - 1 end;
    insert into tenant_discounts (tenant_id, kind, value, reason, valid_from, valid_until, created_by)
    values (p_tenant_id, 'percent', v_code.discount_percent, 'Código de invitación ' || v_code.code,
            v_from, v_until, auth.uid());
  end if;

  -- Asistente IA bonificado (para siempre o por N meses desde hoy). Nunca
  -- degrada un addon pago: si ya lo pagaba, queda como estaba.
  if v_code.ai_included and exists (select 1 from plan_addons where key = 'ai_assistant') then
    v_ai_until := case when v_code.ai_months is not null
                       then (v_today + make_interval(months => v_code.ai_months))::date - 1 end;
    insert into subscription_addons (tenant_id, addon_key, status, source, monthly_price_ars,
                                     cancel_at_period_end, granted_until)
    values (p_tenant_id, 'ai_assistant', 'active', 'granted', null, false, v_ai_until)
    on conflict (tenant_id, addon_key) do update
       set status = 'active',
           cancel_at_period_end = false,
           source = case when subscription_addons.source = 'purchased'
                          and subscription_addons.status = 'active'
                         then 'purchased' else 'granted' end,
           monthly_price_ars = case when subscription_addons.source = 'purchased'
                                     and subscription_addons.status = 'active'
                                    then subscription_addons.monthly_price_ars else null end,
           granted_until = case when subscription_addons.source = 'purchased'
                                 and subscription_addons.status = 'active'
                                then subscription_addons.granted_until else excluded.granted_until end
    returning id into v_addon_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (p_tenant_id, auth.uid(), 'subscription_addons', v_addon_id, 'addon_granted',
            jsonb_build_object('addon', 'ai_assistant', 'source', 'invite_code', 'code', v_code.code,
                               'granted_until', v_ai_until));
  end if;

  update invite_codes set used_count = used_count + 1, updated_at = now() where id = v_code.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'invite_codes', v_code.id, 'invite_code_redeemed',
          jsonb_build_object('code', v_code.code, 'kind', v_code.kind,
                             'plan', v_code.plan_key, 'trial_days', v_code.trial_days,
                             'due_days', v_code.due_days, 'discount_percent', v_code.discount_percent,
                             'discount_months', v_code.discount_months, 'billing_cycle', v_code.billing_cycle,
                             'ai_included', v_code.ai_included, 'ai_months', v_code.ai_months));

  return jsonb_build_object('kind', v_code.kind, 'plan', v_code.plan_key,
                            'trial_days', v_code.trial_days, 'due_days', v_code.due_days,
                            'discount_percent', v_code.discount_percent,
                            'discount_months', v_code.discount_months,
                            'ai_included', v_code.ai_included, 'ai_months', v_code.ai_months);
end;
$$;
revoke all on function redeem_invite_code(text, uuid) from public, anon;
grant execute on function redeem_invite_code(text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Bonificación manual del staff: igual que antes (para siempre) y limpia un
--    plazo que haya quedado de un código.
-- -----------------------------------------------------------------------------
create or replace function internal_grant_addon(p_tenant uuid, p_addon_key text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id  uuid;
  v_key text := btrim(p_addon_key);
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_tenant is null then
    raise exception 'invalid_tenant';
  end if;
  if coalesce(v_key, '') = '' then
    raise exception 'invalid_addon';
  end if;

  insert into subscription_addons (tenant_id, addon_key, status, source, monthly_price_ars)
  values (p_tenant, v_key, 'active', 'granted', null)
  on conflict (tenant_id, addon_key) do update
    set status               = 'active',
        source               = 'granted',
        -- Bonificado => sin precio (no dejar granted + monthly_price_ars viejo).
        monthly_price_ars    = null,
        cancel_at_period_end = false,
        current_period_end   = null,
        granted_until        = null
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, auth.uid(), 'subscription_addons', v_id, 'addon_granted',
          jsonb_build_object('addon', v_key, 'source', 'granted', 'status', 'active'));

  return v_id;
end;
$$;
revoke all on function internal_grant_addon(uuid, text) from public, anon;
grant execute on function internal_grant_addon(uuid, text) to authenticated;

-- Vencimiento de bonificaciones con plazo: baja el addon (no lo pasa a pago),
-- avisa al dueño y audita. Lo corre sólo el cron (sin grant a usuarios).
create or replace function expire_granted_addons()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r      record;
  v_n    int := 0;
  v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  for r in
    select sa.id, sa.tenant_id, sa.addon_key, sa.granted_until,
           coalesce(pa.label, sa.addon_key) as label
      from subscription_addons sa
      left join plan_addons pa on pa.key = sa.addon_key
     where sa.source = 'granted' and sa.status = 'active'
       and sa.granted_until is not null and sa.granted_until < v_today
     for update of sa skip locked
  loop
    update subscription_addons set status = 'cancelled', cancel_at_period_end = false where id = r.id;

    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (r.tenant_id, 'owner', 'plan', 'info',
            'Terminó tu bonificación',
            'Terminó el período bonificado de "' || r.label || '". Si lo querés seguir usando, '
              || 'activalo desde Suscripción.',
            false);

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
    values (r.tenant_id, null, 'subscription_addons', r.id, 'addon_grant_expired',
            jsonb_build_object('status', 'active', 'source', 'granted', 'granted_until', r.granted_until),
            jsonb_build_object('addon', r.addon_key, 'status', 'cancelled'));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function expire_granted_addons() from public, anon, authenticated;

do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el vencimiento de bonificaciones.';
    return;
  end if;

  perform cron.unschedule(j.jobname) from cron.job j where j.jobname = 'addon-grant-expire';

  -- 06:10 UTC = 03:10 en Argentina.
  perform cron.schedule('addon-grant-expire', '10 6 * * *', $job$
    select public.expire_granted_addons()
     where exists (select 1 from public.subscription_addons
                    where source = 'granted' and status = 'active'
                      and granted_until is not null
                      and granted_until < (now() at time zone 'America/Argentina/Buenos_Aires')::date);
  $job$);
end;
$cron$;

-- -----------------------------------------------------------------------------
-- C) Señales de la puesta en marcha (mismo contrato + marca, email y pagos).
-- -----------------------------------------------------------------------------
create or replace function onboarding_tenant_signals(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- onboarding_status (pasos base)
    'fiscal', p_tenant is not null and exists (
      select 1 from tenant_branding where tenant_id = p_tenant and coalesce(cuit, '') <> ''),
    'mp', p_tenant is not null and (
      exists (
        select 1 from payment_secrets
         where tenant_id = p_tenant and provider_key = 'mercadopago'
           and coalesce(secrets ->> 'access_token', '') <> '')
      or exists (
        select 1 from tenant_payment_methods
         where tenant_id = p_tenant and provider_key = 'mercadopago' and enabled)),
    'producto', p_tenant is not null and exists (
      select 1 from products where tenant_id = p_tenant and deleted_at is null),
    -- ADR-119: diseño de comprobantes guardado (o una plantilla de antes).
    'ticket', p_tenant is not null and (
      exists (
        select 1 from tenant_branding
         where tenant_id = p_tenant and invoice_style <> '{}'::jsonb)
      or exists (
        select 1 from ticket_templates where tenant_id = p_tenant and deleted_at is null)),
    'venta', p_tenant is not null and exists (
      select 1 from sales where tenant_id = p_tenant),
    -- ADR-154: marca (logo cargado), email de comprobantes y medios de pago.
    'marca', p_tenant is not null and exists (
      select 1 from tenant_branding
       where tenant_id = p_tenant
         and (coalesce(logo_url, '') <> '' or coalesce(logo_path, '') <> '')),
    'email', p_tenant is not null and exists (
      select 1 from tenant_email_smtp
       where tenant_id = p_tenant
         and case when coalesce(provider, 'smtp') = 'resend'
                  then coalesce(resend_api_key, '') <> '' and coalesce(from_email, '') <> ''
                  else coalesce(host, '') <> '' and coalesce(from_email, '') <> '' end),
    'pagos', p_tenant is not null and (
      exists (
        select 1 from payment_secrets
         where tenant_id = p_tenant and provider_key = 'mercadopago'
           and coalesce(secrets ->> 'access_token', '') <> '')
      or exists (
        select 1 from tenant_payment_methods
         where tenant_id = p_tenant and enabled and provider_key not in ('cash', 'transfer'))
      or exists (
        select 1 from transfer_accounts
         where tenant_id = p_tenant and is_active and deleted_at is null)),
    -- onboarding_activation_status (ADR-086)
    'caja', p_tenant is not null and exists (
      select 1 from cash_shifts where tenant_id = p_tenant),
    'equipo', p_tenant is not null and (
      select count(*) from tenant_users where tenant_id = p_tenant and status = 'active') > 1,
    'mesas', p_tenant is not null and exists (
      select 1 from dining_tables where tenant_id = p_tenant),
    'agenda', p_tenant is not null and exists (
      select 1 from appointments where tenant_id = p_tenant),
    'arca', p_tenant is not null and exists (
      select 1 from arca_settings where tenant_id = p_tenant and enabled and environment = 'produccion'),
    'escuela', p_tenant is not null and exists (
      select 1 from school_progress
       where tenant_id = p_tenant and course_key = 'pos-basico' and passed_at is not null),
    -- Sólo para el panel interno (H71)
    'medios', p_tenant is not null and exists (
      select 1 from tenant_payment_methods where tenant_id = p_tenant and enabled),
    'first_sale_at', (
      select min(created_at) from sales where tenant_id = p_tenant and status = 'completed'),
    'products_count', (
      select count(*) from products where tenant_id = p_tenant and deleted_at is null),
    'shifts_7d', (
      select count(*) from cash_shifts where tenant_id = p_tenant and opened_at >= now() - interval '7 days')
  );
$$;

create or replace function onboarding_status()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'fiscal', coalesce((s ->> 'fiscal')::boolean, false),
    'mp', coalesce((s ->> 'mp')::boolean, false),
    'producto', coalesce((s ->> 'producto')::boolean, false),
    'ticket', coalesce((s ->> 'ticket')::boolean, false),
    'venta', coalesce((s ->> 'venta')::boolean, false),
    'marca', coalesce((s ->> 'marca')::boolean, false),
    'email', coalesce((s ->> 'email')::boolean, false),
    'pagos', coalesce((s ->> 'pagos')::boolean, false)
  )
  from (select onboarding_tenant_signals(current_tenant_id()) as s) x;
$$;
