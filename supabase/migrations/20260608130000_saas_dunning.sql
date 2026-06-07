-- =============================================================================
-- 20260608130000_saas_dunning  (SAAS Fase E — motor de cobros + emails)
--
-- MP preapproval cobra solo; NUESTRO motor CONCILIA estados y COMUNICA.
-- Antifallas: derivado de datos, idempotente (dunning_events), vitalicios
-- salteados, cada transición auditada, cada email logueado en system_emails.
--
-- A) system_emails.html_content: cuerpo HTML del email del sistema (lo arma la
--    SQL fn; lo envía la Edge Function process_pending_emails por SMTP del
--    sistema).
-- B) platform_settings: singleton de config del motor (grace_days, reminder_days).
-- C) dunning_events: idempotencia de avisos (tenant, kind, period_key unique).
-- D) run_saas_dunning(): transiciones + notificaciones in-app + emails pending.
-- E) pg_cron: un job diario que llama run_saas_dunning(). El ENVÍO real de los
--    emails pending lo dispara staff con el botón "Procesar pendientes" de
--    /internal/emails (ver nota DESIGN abajo).
-- F) internal_save_plan(): se reproduce 1:1 de 20260608110000 y se le AGREGA el
--    bloque de aviso de aumento de precio a los suscriptos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Cuerpo HTML del email del sistema.
-- -----------------------------------------------------------------------------
alter table system_emails add column if not exists html_content text;

-- -----------------------------------------------------------------------------
-- B) Config singleton del motor de cobros.
-- -----------------------------------------------------------------------------
create table if not exists platform_settings (
  id            boolean primary key default true check (id),
  grace_days    int not null default 7,
  reminder_days int not null default 3,
  updated_at    timestamptz not null default now()
);

alter table platform_settings enable row level security;

create policy platform_settings_select on platform_settings
  for select using ((select is_internal()));
create policy platform_settings_update on platform_settings
  for update using ((select is_internal())) with check ((select is_internal()));

insert into platform_settings (id) values (true) on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- C) Idempotencia de avisos del motor.
-- -----------------------------------------------------------------------------
create table if not exists dunning_events (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  kind       text not null
               check (kind in ('payment_reminder','no_payment_method','past_due',
                               'suspended','trial_ending','trial_expired',
                               'payment_ok','price_increase')),
  period_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, kind, period_key)
);
create index if not exists idx_dunning_events_tenant on dunning_events(tenant_id);

alter table dunning_events enable row level security;

-- Solo lectura para staff interno (escribe el motor vía SECURITY DEFINER).
create policy dunning_events_select on dunning_events
  for select using ((select is_internal()));

-- -----------------------------------------------------------------------------
-- D) Motor de cobros. SECURITY DEFINER (corre por pg_cron sin sesión de usuario).
--    Devuelve jsonb con los contadores de cada transición.
-- -----------------------------------------------------------------------------
-- Helper: HTML branded mínimo (footer oscuro NinjaPos), solo estilos inline.
-- Se define ANTES de run_saas_dunning / internal_save_plan que lo usan.
create or replace function _dunning_email_html(p_tenant text, p_title text, p_body text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $h$
  select
    '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;background:#111827;border-radius:14px;overflow:hidden">'
    || '<div style="padding:28px 24px 20px;text-align:center">'
    || '<img src="https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-dark-mode.webp" alt="NinjaPos" style="max-height:24px;display:inline-block" />'
    || '<div style="color:#ffffff;font-size:17px;font-weight:bold;margin-top:12px">'
    || replace(replace(replace(coalesce(p_title,''),'&','&amp;'),'<','&lt;'),'>','&gt;')
    || '</div>'
    || '<div style="height:3px;width:48px;background:#f97316;border-radius:99px;margin:16px auto 0"></div>'
    || '</div>'
    || '<div style="padding:8px 28px 28px;color:#e5e7eb;line-height:1.6">'
    || '<p style="margin:0 0 14px;font-size:15px">'
    || replace(replace(replace(coalesce(p_body,''),'&','&amp;'),'<','&lt;'),'>','&gt;')
    || '</p></div>'
    || '<div style="background:#09051C;padding:18px 12px;text-align:center">'
    || '<img src="https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-dark-mode.webp" alt="NinjaPos" style="max-height:20px;display:inline-block" />'
    || '<div style="color:#9ca3af;font-size:11px;margin-top:8px">Enviado con NinjaPos</div>'
    || '</div></div>';
$h$;

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
  v_grace    := coalesce(v_grace, 7);
  v_reminder := coalesce(v_reminder, 3);

  -- ===========================================================================
  -- A) Vencidas sin pago → past_due.
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

    update subscriptions set status = 'past_due', updated_at = now() where id = r.sub_id;
    update tenants set status = 'past_due', updated_at = now() where id = r.tenant_id;

    select u.id, u.email into v_owner_id, v_owner_email
      from tenant_users tu join users u on u.id = tu.user_id
     where tu.tenant_id = r.tenant_id and tu.role = 'owner' and tu.status = 'active'
     order by tu.created_at limit 1;

    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (r.tenant_id, 'owner', 'billing', 'critical',
            'Hubo un problema con tu cobro',
            'No pudimos confirmar el pago de tu suscripción. Revisá tu medio de pago para no perder acceso.',
            false);

    if v_owner_email is not null then
      v_subject := 'Hubo un problema con tu cobro';
      v_html := _dunning_email_html(r.tenant_name, v_subject,
        'No pudimos confirmar el pago de tu suscripción de NinjaPos. Para no perder acceso, revisá tu medio de pago en Mercado Pago. Si ya pagaste, podés ignorar este aviso.');
      insert into system_emails (tenant_id, recipient, subject, kind, status, html_content)
      values (r.tenant_id, v_owner_email, v_subject, 'system', 'pending', v_html);
    end if;

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'past_due', v_period);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (r.tenant_id, null, 'subscriptions', r.sub_id, 'dunning_past_due',
            jsonb_build_object('period', v_period));
    v_past_due := v_past_due + 1;
  end loop;

  -- ===========================================================================
  -- B) past_due por más de grace_days → suspended.
  -- ===========================================================================
  for r in
    select s.id as sub_id, s.tenant_id, s.current_period_end, t.name as tenant_name
      from subscriptions s
      join tenants t on t.id = s.tenant_id
     where s.status = 'past_due'
       and coalesce(s.is_lifetime, false) = false
       and s.updated_at < now() - make_interval(days => v_grace)
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
            'Tu cuenta fue suspendida',
            'Suspendimos tu cuenta por falta de pago. Regularizá tu suscripción para reactivarla.',
            true);

    if v_owner_email is not null then
      v_subject := 'Tu cuenta de NinjaPos fue suspendida';
      v_html := _dunning_email_html(r.tenant_name, v_subject,
        'Suspendimos tu cuenta por falta de pago. Para reactivarla, regularizá tu suscripción desde tu panel. Si ya pagaste, escribinos.');
      insert into system_emails (tenant_id, recipient, subject, kind, status, html_content)
      values (r.tenant_id, v_owner_email, v_subject, 'system', 'pending', v_html);
    end if;

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'suspended', v_period);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (r.tenant_id, null, 'subscriptions', r.sub_id, 'dunning_suspended',
            jsonb_build_object('period', v_period));
    v_suspended := v_suspended + 1;
  end loop;

  -- ===========================================================================
  -- C) Vencimiento próximo (active, dentro de reminder_days) → recordatorio.
  --    Simplificación: recordatorio a TODOS los active con vencimiento próximo
  --    (no se distingue 'no_payment_method': no hay tabla de preapproval por
  --    tenant más allá de subscriptions.mp_preapproval_id; ver nota DESIGN).
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
-- E) pg_cron: un job diario que calcula transiciones + encola emails pending.
--    El ENVÍO real (SMTP) lo dispara staff con "Procesar pendientes" en
--    /internal/emails (process_pending_emails). Ver nota DESIGN.
-- -----------------------------------------------------------------------------
-- DESIGN — por qué NO hay un segundo cron con pg_net:
--   El envío necesita autenticar contra la Edge Function. Meter el service_role
--   key en el cuerpo del cron job lo dejaría en texto plano dentro de este
--   archivo versionado (git) → fuga de secreto. La alternativa (header secreto
--   en platform_secrets + verify_jwt false) agrega plumbing frágil. Decisión:
--   un único cron que SOLO toca la base (run_saas_dunning); los emails pending
--   se envían cuando staff abre /internal/emails y toca "Procesar pendientes"
--   (invoca process_pending_emails con su JWT de staff). Robusto, auditable y
--   sin secretos en git. Si más adelante se quiere 100% automático, se agrega
--   el job pg_net seteando el secreto post-deploy (fuera de la migración).
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'saas-dunning') then
      perform cron.unschedule('saas-dunning');
    end if;
    perform cron.schedule('saas-dunning', '23 5 * * *', 'select run_saas_dunning();');
  end if;
end;
$cron$;

-- -----------------------------------------------------------------------------
-- F) internal_save_plan() + aviso de aumento de precio (Fase E).
--    Reproducción 1:1 de 20260608110000 con el bloque de aumento AGREGADO al
--    final de la rama de edición (antes del return p_id).
-- -----------------------------------------------------------------------------
create or replace function internal_save_plan(
  p_id            uuid,
  p_key           text,
  p_name          text,
  p_description   text,
  p_icon          text,
  p_monthly_price numeric,
  p_trial_days    int,
  p_limits        jsonb,
  p_is_active     boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old plans%rowtype;
  v_id  uuid;
  v_key text;
  r     record;
  v_email text;
  v_period text;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_monthly_price is null or p_monthly_price < 0 then
    raise exception 'invalid_price';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'invalid_name';
  end if;

  if p_id is null then
    -- Alta de plan global nuevo.
    v_key := coalesce(
      nullif(btrim(p_key), ''),
      regexp_replace(lower(p_name), '[^a-z0-9]+', '_', 'g') || '_'
        || substr(md5(random()::text), 1, 4)
    );

    insert into plans (key, name, description, icon, monthly_price_ars,
                       trial_days, limits, is_active, sort, tenant_id)
    values (v_key, btrim(p_name), p_description, p_icon, p_monthly_price,
            coalesce(p_trial_days, 14), coalesce(p_limits, '{}'::jsonb),
            coalesce(p_is_active, true), 0, null)
    returning id into v_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (null, auth.uid(), 'plans', v_id, 'plan_saved',
            jsonb_build_object('key', v_key, 'name', btrim(p_name),
                               'monthly_price_ars', p_monthly_price,
                               'trial_days', coalesce(p_trial_days, 14),
                               'is_active', coalesce(p_is_active, true),
                               'limits', coalesce(p_limits, '{}'::jsonb)));
    return v_id;
  end if;

  -- Edición: solo planes globales (tenant_id null).
  select * into v_old from plans where id = p_id;
  if not found then
    raise exception 'plan_not_found';
  end if;
  if v_old.tenant_id is not null then
    raise exception 'not_global_plan';
  end if;

  update plans
     set name              = btrim(p_name),
         description        = p_description,
         icon              = p_icon,
         monthly_price_ars = p_monthly_price,
         trial_days        = coalesce(p_trial_days, v_old.trial_days),
         limits            = coalesce(p_limits, v_old.limits),
         is_active         = coalesce(p_is_active, v_old.is_active)
   where id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (null, auth.uid(), 'plans', p_id, 'plan_saved',
          jsonb_build_object('name', v_old.name, 'description', v_old.description,
                             'icon', v_old.icon, 'monthly_price_ars', v_old.monthly_price_ars,
                             'trial_days', v_old.trial_days, 'is_active', v_old.is_active,
                             'limits', v_old.limits),
          jsonb_build_object('name', btrim(p_name), 'description', p_description,
                             'icon', p_icon, 'monthly_price_ars', p_monthly_price,
                             'trial_days', coalesce(p_trial_days, v_old.trial_days),
                             'is_active', coalesce(p_is_active, v_old.is_active),
                             'limits', coalesce(p_limits, v_old.limits)));

  -- Fase E — aviso de AUMENTO de precio a los suscriptos afectados.
  -- Solo si subió el precio y hay suscripciones vivas (trial/active/past_due).
  if p_monthly_price > v_old.monthly_price_ars then
    v_period := to_char(now(), 'YYYY-MM');
    for r in
      select distinct s.tenant_id, t.name as tenant_name
        from subscriptions s
        join tenants t on t.id = s.tenant_id
       where s.plan_id = p_id
         and s.status in ('trial','active','past_due')
         and coalesce(s.is_lifetime, false) = false
         and t.deleted_at is null
    loop
      -- Idempotencia: un solo aviso de aumento por tenant y mes.
      if exists (select 1 from dunning_events
                  where tenant_id = r.tenant_id and kind = 'price_increase'
                    and period_key = v_period) then
        continue;
      end if;

      insert into notifications (target_tenant_id, target_role, type, severity, title, body,
                                 requires_ack, created_by)
      values (r.tenant_id, 'owner', 'plan', 'warning',
              'Actualización de tarifa',
              'Tu plan "' || btrim(p_name) || '" pasa de $' || v_old.monthly_price_ars::text
                || ' a $' || p_monthly_price::text || ' por mes desde tu próximo ciclo.',
              true, auth.uid());

      select u.email into v_email
        from tenant_users tu join users u on u.id = tu.user_id
       where tu.tenant_id = r.tenant_id and tu.role = 'owner' and tu.status = 'active'
       order by tu.created_at limit 1;

      if v_email is not null then
        insert into system_emails (tenant_id, recipient, subject, kind, status, html_content)
        values (r.tenant_id, v_email, 'Actualización de tarifa de tu plan', 'system', 'pending',
                _dunning_email_html(r.tenant_name, 'Actualización de tarifa',
                  'Te avisamos que tu plan "' || btrim(p_name) || '" pasa de $'
                    || v_old.monthly_price_ars::text || ' a $' || p_monthly_price::text
                    || ' por mes a partir de tu próximo ciclo de facturación.'));
      end if;

      insert into dunning_events (tenant_id, kind, period_key)
      values (r.tenant_id, 'price_increase', v_period);
    end loop;
  end if;

  return p_id;
end;
$$;
revoke all on function internal_save_plan(uuid, text, text, text, text, numeric, int, jsonb, boolean) from public, anon;
grant execute on function internal_save_plan(uuid, text, text, text, text, numeric, int, jsonb, boolean) to authenticated;
