-- =============================================================================
-- 20260608350000_dunning_3day_grace_reanchor  (SaaS — dunning 3 días + reanclaje)
--
-- Cambio de política de cobros de la suscripción:
--   1) Si el cobro del próximo mes FALLA (o el período vence sin pago) → la
--      cuenta entra en `past_due` y arranca una gracia de SOLO 3 días.
--      Pasados los 3 días sin regularizar → `suspended` (cuenta BLOQUEADA).
--   2) Cuenta `suspended` → para volver a usarla el dueño debe PAGAR el plan
--      (reactivación por pago, vía el preapproval de MP → mp_billing_webhook).
--   3) Al re-pagar, el período NO arranca el día de pago: se ANCLA al
--      vencimiento anterior (el current_period_end que venció). El cliente NO
--      gana los días del lapso de atraso; el "día del mes" de cobro se mantiene.
--
-- Contrato de estados de la suscripción/tenant (lo lee la app para gatear):
--   • active     → OK, al día.
--   • trialing   → (en este esquema se usa `trial`) OK, dentro del trial.
--   • past_due   → USABLE, en gracia de 3 días. Avisar; NO bloquear todavía.
--   • suspended  → BLOQUEADA. El dueño debe pagar para reactivar.
--   • cancelled  → baja (trial vencido sin conversión, o MP canceló).
--
-- Diseño (robustez):
--   • Se agrega subscriptions.past_due_since (timestamptz). Se mantiene con un
--     TRIGGER, no a mano en cada writer: así dunning, webhook y el setter manual
--     interno quedan correctos sin acoplar la lógica a cada lugar.
--       - status → past_due y past_due_since IS NULL  ⇒ past_due_since = now()
--       - status → active/trial/cancelled             ⇒ past_due_since = NULL
--       - status → suspended                          ⇒ se conserva (histórico)
--   • run_saas_dunning(): la suspensión ahora se dispara por past_due_since
--     (> 3 días), NO por updated_at (que cualquier UPDATE reseteaba). El umbral
--     usa platform_settings.grace_days, que pasa a 3.
--   • subscription_blocked(p_tenant) helper: true sii la cuenta está bloqueada
--     (status suspended y no vitalicia). Para que la app consulte un único
--     contrato. my_subscription() expone status + past_due_since + blocked.
--   • El reanclaje del período al re-pagar vive en mp_billing_webhook (Edge);
--     acá se agrega reanchor_subscription_period() como fuente de verdad SQL del
--     cálculo del ancla (el webhook la invoca por RPC para no duplicar lógica).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Columna de inicio de la gracia.
-- -----------------------------------------------------------------------------
alter table subscriptions add column if not exists past_due_since timestamptz;

comment on column subscriptions.past_due_since is
  'Marca el inicio de la gracia (cuando el cobro falló / venció sin pago). La '
  'mantiene el trigger trg_subscriptions_past_due_since. run_saas_dunning '
  'suspende a los 3 días (grace_days). Se limpia al volver a active/trial/cancelled.';

-- Backfill: subs ya en past_due sin marca → usamos su current_period_end (cuándo
-- venció) o, en su defecto, updated_at, como mejor estimación del inicio de la
-- gracia. Así una cuenta ya vencida no "reinicia" su reloj con esta migración.
update subscriptions
   set past_due_since = coalesce(current_period_end, updated_at, now())
 where status = 'past_due' and past_due_since is null;

-- -----------------------------------------------------------------------------
-- 2) Trigger que mantiene past_due_since según las transiciones de status.
--    Centraliza la regla: ningún writer (dunning, webhook, setter manual) tiene
--    que acordarse de tocar la columna.
-- -----------------------------------------------------------------------------
create or replace function trg_set_past_due_since()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'past_due' then
      -- Entra en gracia: marcamos el inicio si no venía marcado.
      if new.past_due_since is null then
        new.past_due_since := now();
      end if;
    elsif new.status in ('active', 'trial', 'cancelled') then
      -- Regularizó / se reactivó / se canceló: el reloj de gracia se limpia.
      new.past_due_since := null;
    end if;
    -- status = 'suspended': se conserva past_due_since (ya transcurrió la gracia;
    -- queda como dato histórico hasta que pague y pase a active → se limpia).
  end if;
  return new;
end;
$$;

drop trigger if exists trg_subscriptions_past_due_since on subscriptions;
create trigger trg_subscriptions_past_due_since
  before update of status on subscriptions
  for each row
  execute function trg_set_past_due_since();

-- -----------------------------------------------------------------------------
-- 3) Gracia a 3 días en la config del motor.
-- -----------------------------------------------------------------------------
update platform_settings set grace_days = 3, updated_at = now() where id = true;

-- -----------------------------------------------------------------------------
-- 4) Helper de bloqueo: contrato único para la app.
--    subscription_blocked(p_tenant) = true sii la cuenta está BLOQUEADA por
--    falta de pago (suspended y no vitalicia). El otro agente (UI) lo consulta.
-- -----------------------------------------------------------------------------
create or replace function subscription_blocked(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from subscriptions s
     where s.tenant_id = p_tenant
       and s.status = 'suspended'
       and coalesce(s.is_lifetime, false) = false
  );
$$;
revoke all on function subscription_blocked(uuid) from public, anon;
grant execute on function subscription_blocked(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 5) Reanclaje del período al re-pagar (fuente de verdad SQL).
--    Calcula el nuevo período anclado al VENCIMIENTO ANTERIOR (el
--    current_period_end que venció), avanzando de a `p_months` ciclos —
--    manteniendo el DÍA DEL MES de cobro — hasta cubrir `p_now`. El cliente NO
--    gana los días del lapso de atraso: el inicio es el vencimiento previo, no
--    `now()`. Aplica status=active, current_period_start/end y limpia
--    past_due_since (vía trigger). Audita y devuelve el nuevo period_end.
--
--    SECURITY DEFINER + revocada de todos: SOLO se invoca server-side (el
--    webhook con service_role la llama por RPC). No es callable por usuarios.
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
as $$
declare
  v_sub      subscriptions%rowtype;
  v_months   int := greatest(coalesce(p_months, 1), 1);
  v_anchor   timestamptz;  -- inicio del nuevo período (= vencimiento anterior)
  v_end      timestamptz;  -- fin del nuevo período
  v_guard    int := 0;     -- corta loops patológicos
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if not found then
    raise exception 'subscription_not_found';
  end if;

  -- Ancla = vencimiento anterior. Si por algún motivo no hay período previo
  -- (datos viejos), caemos a current_period_start o, último recurso, a p_now
  -- (en ese caso no hay lapso que "anclar"; arranca ahora).
  v_anchor := coalesce(v_sub.current_period_end, v_sub.current_period_start, p_now);
  v_end    := v_anchor + make_interval(months => v_months);

  -- Si el atraso cubrió varios ciclos, avanzamos el ancla de a v_months ciclos
  -- (manteniendo el día del mes) hasta que el período vigente contenga a p_now.
  -- Ej: vencía el 10/03, paga el 25/05 → 10/03..10/04 (cubre? no) → ancla 10/04;
  --     10/04..10/05 (no) → ancla 10/05; 10/05..10/06 contiene 25/05 → listo.
  while v_end <= p_now and v_guard < 240 loop
    v_anchor := v_end;
    v_end    := v_anchor + make_interval(months => v_months);
    v_guard  := v_guard + 1;
  end loop;

  update subscriptions
     set status               = 'active',
         current_period_start = v_anchor,
         current_period_end   = v_end,
         -- past_due_since se limpia solo por el trigger al pasar a 'active'.
         updated_at           = now()
   where id = p_subscription_id;

  update tenants
     set status = 'active', updated_at = now()
   where id = v_sub.tenant_id
     and status in ('past_due', 'suspended');

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_sub.tenant_id, null, 'subscriptions', p_subscription_id, 'subscription_reactivated',
          jsonb_build_object('status', v_sub.status,
                             'current_period_start', v_sub.current_period_start,
                             'current_period_end', v_sub.current_period_end),
          jsonb_build_object('status', 'active',
                             'current_period_start', v_anchor,
                             'current_period_end', v_end,
                             'anchored_to_previous_due', true,
                             'cycles_advanced', v_guard));

  return v_end;
end;
$$;
revoke all on function reanchor_subscription_period(uuid, int, timestamptz) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6) run_saas_dunning(): suspensión por past_due_since (3 días), no por
--    updated_at. Se reproduce la función completa con DOS cambios respecto de
--    20260608130000:
--      • Bloque A (vencido → past_due): el insert/update ya queda con
--        past_due_since vía trigger; además el aviso del día 0 dice "3 días".
--      • Bloque B (past_due → suspended): el umbral usa
--        s.past_due_since < now() - grace_days (fallback a updated_at si una
--        fila vieja no tuviera la marca, aunque el backfill la cubre).
--    El resto (recordatorios, trial) es idéntico.
-- -----------------------------------------------------------------------------
create or replace function run_saas_dunning()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_grace    int;
  v_reminder int;
  v_past_due  int := 0;
  v_suspended int := 0;
  v_reminder_c int := 0;
  v_trial_end int := 0;
  v_trial_exp int := 0;
  r record;
  v_owner_email text;
  v_owner_id    uuid;
  v_period   text;
  v_html     text;
  v_subject  text;
begin
  select grace_days, reminder_days into v_grace, v_reminder
    from platform_settings where id = true;
  v_grace    := coalesce(v_grace, 3);
  v_reminder := coalesce(v_reminder, 3);

  -- ===========================================================================
  -- A) Vencidas sin pago → past_due (arranca la gracia de 3 días).
  --    active, no vitalicio, current_period_end < now(), sin billing_record que
  --    cubra el período. Guardado por dunning_events (kind past_due, mes).
  -- ===========================================================================
  for r in
    select s.id as sub_id, s.tenant_id, s.current_period_end, t.name as tenant_name
      from subscriptions s
      join tenants t on t.id = s.tenant_id
     where s.status = 'active'
       and coalesce(s.is_lifetime, false) = false
       and s.current_period_end is not null
       and s.current_period_end < now()
       and t.deleted_at is null
       and not exists (
         select 1 from billing_records b
          where b.tenant_id = s.tenant_id
            and b.period_end is not null
            and b.period_end >= s.current_period_end::date
       )
  loop
    v_period := to_char(r.current_period_end, 'YYYY-MM');
    if exists (select 1 from dunning_events
                where tenant_id = r.tenant_id and kind = 'past_due'
                  and period_key = v_period) then
      continue;
    end if;

    -- past_due_since lo setea el trigger al cambiar a past_due.
    update subscriptions set status = 'past_due', updated_at = now() where id = r.sub_id;
    update tenants set status = 'past_due', updated_at = now() where id = r.tenant_id;

    select u.id, u.email into v_owner_id, v_owner_email
      from tenant_users tu join users u on u.id = tu.user_id
     where tu.tenant_id = r.tenant_id and tu.role = 'owner' and tu.status = 'active'
     order by tu.created_at limit 1;

    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (r.tenant_id, 'owner', 'billing', 'critical',
            'Hubo un problema con tu cobro',
            'No pudimos confirmar el pago de tu suscripción. Tenés 3 días para '
              || 'regularizarlo; después tu cuenta se bloquea. Revisá tu medio de pago.',
            false);

    if v_owner_email is not null then
      v_subject := 'Hubo un problema con tu cobro — tenés 3 días';
      v_html := _dunning_email_html(r.tenant_name, v_subject,
        'No pudimos confirmar el pago de tu suscripción de NinjaPos. Tenés 3 días '
          || 'para regularizarlo desde Mercado Pago; pasado ese plazo tu cuenta se '
          || 'bloquea hasta que pagues. Si ya pagaste, podés ignorar este aviso.');
      insert into system_emails (tenant_id, recipient, subject, kind, status, html_content)
      values (r.tenant_id, v_owner_email, v_subject, 'system', 'pending', v_html);
    end if;

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'past_due', v_period);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (r.tenant_id, null, 'subscriptions', r.sub_id, 'dunning_past_due',
            jsonb_build_object('period', v_period, 'grace_days', v_grace));
    v_past_due := v_past_due + 1;
  end loop;

  -- ===========================================================================
  -- B) past_due por más de grace_days (3) → suspended (BLOQUEADA).
  --    Umbral por past_due_since (no por updated_at, que cualquier UPDATE
  --    reseteaba). Fallback a updated_at si faltara la marca (no debería tras el
  --    backfill, pero es defensivo).
  -- ===========================================================================
  for r in
    select s.id as sub_id, s.tenant_id, s.current_period_end, t.name as tenant_name
      from subscriptions s
      join tenants t on t.id = s.tenant_id
     where s.status = 'past_due'
       and coalesce(s.is_lifetime, false) = false
       and coalesce(s.past_due_since, s.updated_at) < now() - make_interval(days => v_grace)
       and t.deleted_at is null
  loop
    v_period := to_char(coalesce(r.current_period_end, now()), 'YYYY-MM');
    if exists (select 1 from dunning_events
                where tenant_id = r.tenant_id and kind = 'suspended'
                  and period_key = v_period) then
      continue;
    end if;

    update subscriptions set status = 'suspended', updated_at = now() where id = r.sub_id;
    update tenants set status = 'suspended', updated_at = now() where id = r.tenant_id;

    select u.id, u.email into v_owner_id, v_owner_email
      from tenant_users tu join users u on u.id = tu.user_id
     where tu.tenant_id = r.tenant_id and tu.role = 'owner' and tu.status = 'active'
     order by tu.created_at limit 1;

    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (r.tenant_id, 'owner', 'billing', 'blocking',
            'Tu cuenta fue bloqueada',
            'Bloqueamos tu cuenta por falta de pago. Pagá tu plan para reactivarla; '
              || 'al pagar, el período se reanuda desde tu vencimiento anterior.',
            true);

    if v_owner_email is not null then
      v_subject := 'Tu cuenta de NinjaPos fue bloqueada';
      v_html := _dunning_email_html(r.tenant_name, v_subject,
        'Bloqueamos tu cuenta por falta de pago. Para reactivarla, pagá tu plan '
          || 'desde tu panel. Al pagar, tu período se reanuda desde el vencimiento '
          || 'anterior (no perdés ni ganás días). Si ya pagaste, escribinos.');
      insert into system_emails (tenant_id, recipient, subject, kind, status, html_content)
      values (r.tenant_id, v_owner_email, v_subject, 'system', 'pending', v_html);
    end if;

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'suspended', v_period);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (r.tenant_id, null, 'subscriptions', r.sub_id, 'dunning_suspended',
            jsonb_build_object('period', v_period, 'grace_days', v_grace));
    v_suspended := v_suspended + 1;
  end loop;

  -- ===========================================================================
  -- C) Vencimiento próximo (active, dentro de reminder_days) → recordatorio.
  -- ===========================================================================
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

    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (r.tenant_id, 'owner', 'billing', 'info',
            'Tu suscripción se renueva pronto',
            'Tu suscripción se renueva el ' || to_char(r.current_period_end, 'DD/MM/YYYY')
              || '. Asegurate de tener un medio de pago activo en Mercado Pago.',
            false);

    if v_owner_email is not null then
      v_subject := 'Tu suscripción de NinjaPos se renueva pronto';
      v_html := _dunning_email_html(r.tenant_name, v_subject,
        'Tu suscripción se renueva el ' || to_char(r.current_period_end, 'DD/MM/YYYY')
          || '. El cobro es automático por Mercado Pago; verificá que tu medio de pago esté activo.');
      insert into system_emails (tenant_id, recipient, subject, kind, status, html_content)
      values (r.tenant_id, v_owner_email, v_subject, 'system', 'pending', v_html);
    end if;

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'payment_reminder', v_period);
    v_reminder_c := v_reminder_c + 1;
  end loop;

  -- ===========================================================================
  -- D1) Trial por vencer (faltan ≤ 3 días) → aviso.
  -- ===========================================================================
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

    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (r.tenant_id, 'owner', 'billing', 'warning',
            'Tu prueba gratis está por terminar',
            'Tu período de prueba termina el ' || to_char(r.trial_ends_at, 'DD/MM/YYYY')
              || '. Activá un plan para no perder acceso.',
            false);

    if v_owner_email is not null then
      v_subject := 'Tu prueba de NinjaPos está por terminar';
      v_html := _dunning_email_html(r.tenant_name, v_subject,
        'Tu período de prueba termina el ' || to_char(r.trial_ends_at, 'DD/MM/YYYY')
          || '. Activá un plan desde tu panel para seguir usando NinjaPos sin interrupciones.');
      insert into system_emails (tenant_id, recipient, subject, kind, status, html_content)
      values (r.tenant_id, v_owner_email, v_subject, 'system', 'pending', v_html);
    end if;

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'trial_ending', v_period);
    v_trial_end := v_trial_end + 1;
  end loop;

  -- ===========================================================================
  -- D2) Trial vencido sin conversión → cancelled.
  -- ===========================================================================
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

    if v_owner_email is not null then
      v_subject := 'Tu prueba de NinjaPos terminó';
      v_html := _dunning_email_html(r.tenant_name, v_subject,
        'Tu período de prueba terminó y pausamos tu cuenta. Activá un plan cuando quieras para retomar donde lo dejaste.');
      insert into system_emails (tenant_id, recipient, subject, kind, status, html_content)
      values (r.tenant_id, v_owner_email, v_subject, 'system', 'pending', v_html);
    end if;

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'trial_expired', v_period);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (r.tenant_id, null, 'tenants', r.tenant_id, 'dunning_trial_expired',
            jsonb_build_object('period', v_period));
    v_trial_exp := v_trial_exp + 1;
  end loop;

  return jsonb_build_object(
    'past_due', v_past_due,
    'suspended', v_suspended,
    'payment_reminder', v_reminder_c,
    'trial_ending', v_trial_end,
    'trial_expired', v_trial_exp
  );
end;
$fn$;

revoke all on function run_saas_dunning() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7) my_subscription(): exponer past_due_since + blocked para que el panel del
--    dueño (y el gating de la app) lean el contrato sin tocar la tabla. Se
--    reproduce 20260608270000 con esos dos campos AGREGADOS.
-- -----------------------------------------------------------------------------
create or replace function my_subscription()
returns jsonb
language plpgsql
stable security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tid uuid := current_tenant_id();
  v_result jsonb;
begin
  if v_tid is null or not is_tenant_manager() then
    return null;
  end if;

  select jsonb_build_object(
    'plan', jsonb_build_object(
      'key', p.key,
      'name', p.name,
      'secondary_name', p.secondary_name,
      'image_url', p.image_url,
      'icon', p.icon,
      'monthly_price_ars', p.monthly_price_ars,
      'is_custom', (p.tenant_id is not null)
    ),
    'status', s.status,
    'blocked', (s.status = 'suspended' and coalesce(s.is_lifetime, false) = false),
    'past_due_since', s.past_due_since,
    'billing_cycle', s.billing_cycle,
    'current_period_start', s.current_period_start,
    'current_period_end', s.current_period_end,
    'cancel_at_period_end', coalesce(s.cancel_at_period_end, false),
    'is_lifetime', coalesce(s.is_lifetime, false),
    'closure_requested_at', t.closure_requested_at,
    'next_charge', case
      when coalesce(s.is_lifetime, false) then null
      else s.current_period_end
    end,
    'addons', coalesce((
      select jsonb_agg(jsonb_build_object(
        'addon_key', sa.addon_key,
        'label', pa.label,
        'status', sa.status,
        'cancel_at_period_end', coalesce(sa.cancel_at_period_end, false),
        'current_period_end', sa.current_period_end,
        'monthly_price_ars', coalesce(sa.monthly_price_ars, pa.monthly_price_ars)
      ) order by sa.addon_key)
      from subscription_addons sa
      left join plan_addons pa on pa.key = sa.addon_key
      where sa.tenant_id = v_tid
    ), '[]'::jsonb),
    'last_payment', (
      select jsonb_build_object(
        'amount', br.amount,
        'medium', br.medium,
        'period_end', br.period_end,
        'created_at', br.created_at
      )
      from billing_records br
      where br.tenant_id = v_tid
      order by br.created_at desc
      limit 1
    )
  )
  into v_result
  from subscriptions s
  join plans p on p.id = s.plan_id
  join tenants t on t.id = s.tenant_id
  where s.tenant_id = v_tid;

  return v_result;
end;
$fn$;
revoke all on function my_subscription() from public, anon;
grant execute on function my_subscription() to authenticated;
