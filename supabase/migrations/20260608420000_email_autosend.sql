-- =============================================================================
-- 20260608420000_email_autosend  (SaaS — el ciclo de emails se ENVÍA SOLO)
--
-- Cierra los huecos de la auditoría del envío de email del ciclo SaaS:
--
--   1) (CRÍTICO) La cola se despacha SOLA. Un job pg_cron (cada 5 min) invoca la
--      Edge Function process_pending_emails vía pg_net.http_post, autenticando
--      con un secreto guardado en platform_secrets (key 'internal_cron'). Ya no
--      hace falta tocar "Procesar pendientes" en /internal/emails. Sin
--      service_role en git: el secreto se genera acá (gen_random_uuid) y la edge
--      fn lo valida (ver process_pending_emails).
--
--   4) Plantillas DE VERDAD. Los emisores SQL (dunning, addons, aumento de
--      precio, compra de catálogo) dejan de armar HTML inline y resuelven
--      subject+html desde system_email_templates vía render_system_email(): así
--      editar una plantilla en /internal/emails impacta el email real. Si no hay
--      override en la tabla, cae al HTML inline previo (defensivo).
--
--   5) Reintento de fallidos. system_emails suma attempts / last_attempt_at /
--      next_attempt_at. process_pending_emails reintenta los 'failed' con backoff
--      y tope de intentos (la lógica del cap vive en la edge fn; acá están las
--      columnas + el índice).
--
--   6) Compra de catálogo manda email. finalize_catalog_purchase encola un email
--      'catalog_purchased' (plantilla nueva, sembrada abajo).
--
-- Idempotente: extensión IF NOT EXISTS, columnas IF NOT EXISTS, template ON
-- CONFLICT DO NOTHING, secreto solo si falta, cron re-creado (unschedule+schedule).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Extensiones necesarias para el auto-envío (HTTP asíncrono desde Postgres).
--    pg_cron ya está instalado; pg_net puede faltar.
-- -----------------------------------------------------------------------------
create extension if not exists pg_net;

-- -----------------------------------------------------------------------------
-- 1) Reintento de fallidos: contador + backoff en system_emails.
--    attempts: cuántas veces se intentó enviar (sent o failed cuentan como 1).
--    last_attempt_at: cuándo fue el último intento.
--    next_attempt_at: a partir de cuándo se puede reintentar un 'failed'.
-- -----------------------------------------------------------------------------
alter table system_emails
  add column if not exists attempts int not null default 0,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists next_attempt_at timestamptz;

-- Índice para que process_pending_emails encuentre rápido lo enviable
-- (pending siempre; failed cuyo next_attempt_at ya pasó).
create index if not exists idx_system_emails_dispatch
  on system_emails (status, next_attempt_at)
  where status in ('pending', 'failed');

-- -----------------------------------------------------------------------------
-- 2) Plantilla de compra de catálogo (Tiendita). Defaults branded en espejo con
--    lib/email/templates.ts. ON CONFLICT DO NOTHING: no pisa overrides de staff.
-- -----------------------------------------------------------------------------
insert into system_email_templates (key, subject, html) values
  ('catalog_purchased', 'Ya tenés acceso a tu catálogo en NinjaPos',
   '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #eef0f3;border-radius:14px;overflow:hidden"><div style="padding:28px 32px 8px;text-align:center"><img src="https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-light-mode.webp" alt="NinjaPos" style="max-height:26px;display:inline-block" /><div style="height:3px;width:48px;background:#f97316;border-radius:99px;margin:18px auto 0"></div></div><div style="padding:20px 32px 32px;color:#1f2937;line-height:1.6;font-size:15px"><p>¡Listo! Tu compra del catálogo <b>{{catalogo}}</b> para <b>{{negocio}}</b> se acreditó.</p><p>Entrá a Tiendita para buscar productos del catálogo y agregarlos a tu tienda con un clic.</p><div style="text-align:center;margin:22px 0 4px"><a href="https://ninja-soft-pos.vercel.app/login" style="display:inline-block;background:#f97316;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 26px;border-radius:10px;font-size:15px">Ir a Tiendita</a></div></div><div style="background:#09051C;padding:18px 12px;text-align:center"><img src="https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-dark-mode.webp" alt="NinjaPos" style="max-height:20px;display:inline-block" /><div style="color:#9ca3af;font-size:11px;margin-top:8px">Enviado con NinjaPos</div></div></div>')
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- 3) render_system_email(p_key, p_vars) — resuelve subject + html de una
--    plantilla del sistema, renderizando {{var}} con p_vars (jsonb plano de
--    texto). Fuente: system_email_templates (overrides de staff + defaults
--    sembrados). Devuelve NULL si la clave no existe (el emisor decide el
--    fallback).
--
--    El render es el mismo contrato que lib/email/templates.ts::renderTemplate:
--    reemplaza {{ var }} (con o sin espacios) por su valor; si la var no está en
--    p_vars, deja el placeholder intacto.
-- -----------------------------------------------------------------------------
create or replace function render_system_email(p_key text, p_vars jsonb)
returns table (subject text, html text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_subject text;
  v_html    text;
  v_k       text;
  v_v       text;
begin
  select t.subject, t.html into v_subject, v_html
    from system_email_templates t
   where t.key = p_key;
  if v_subject is null and v_html is null then
    return;  -- sin fila: el emisor usa su fallback
  end if;

  -- Render de variables. p_vars es un objeto jsonb {var: "valor", ...}.
  if p_vars is not null then
    for v_k, v_v in select key, value from jsonb_each_text(p_vars)
    loop
      v_subject := replace(replace(v_subject, '{{' || v_k || '}}', v_v),
                           '{{ ' || v_k || ' }}', v_v);
      v_html    := replace(replace(v_html,    '{{' || v_k || '}}', v_v),
                           '{{ ' || v_k || ' }}', v_v);
    end loop;
  end if;

  subject := v_subject;
  html := v_html;
  return next;
end;
$fn$;
revoke all on function render_system_email(text, jsonb) from public, anon;
grant execute on function render_system_email(text, jsonb) to authenticated;

-- Helper interno: encola un email del sistema resolviendo la plantilla por key.
-- Si la plantilla no existe, cae a (p_fallback_subject, p_fallback_html) para no
-- dejar de avisar. Centraliza el patrón "render + insert en system_emails".
create or replace function enqueue_system_email(
  p_tenant_id        uuid,
  p_recipient        text,
  p_key              text,
  p_vars             jsonb,
  p_fallback_subject text,
  p_fallback_html    text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_subject text;
  v_html    text;
begin
  if p_recipient is null or btrim(p_recipient) = '' then
    return;
  end if;
  select r.subject, r.html into v_subject, v_html
    from render_system_email(p_key, p_vars) r;
  if v_subject is null then
    v_subject := p_fallback_subject;
    v_html    := p_fallback_html;
  end if;
  insert into system_emails (tenant_id, recipient, subject, kind, status, html_content)
  values (p_tenant_id, p_recipient, v_subject, 'system', 'pending', v_html);
end;
$fn$;
revoke all on function enqueue_system_email(uuid, text, text, jsonb, text, text)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4) run_saas_dunning(): reproducción 1:1 de 20260608350000 (gracia 3 días +
--    past_due_since) con UN cambio: cada email del sistema se encola vía
--    enqueue_system_email() (plantilla + fallback al HTML inline previo). Las
--    claves de plantilla usadas: payment_failed (past_due), suspended_dunning
--    (suspended), payment_reminder, trial_ending, trial_expired.
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
  v_vence    text;
  v_dias     text;
begin
  select grace_days, reminder_days into v_grace, v_reminder
    from platform_settings where id = true;
  v_grace    := coalesce(v_grace, 3);
  v_reminder := coalesce(v_reminder, 3);

  -- ===========================================================================
  -- A) Vencidas sin pago → past_due (arranca la gracia de 3 días).
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
            'No pudimos confirmar el pago de tu suscripción. Tenés 3 días para '
              || 'regularizarlo; después tu cuenta se bloquea. Revisá tu medio de pago.',
            false);

    perform enqueue_system_email(
      r.tenant_id, v_owner_email, 'payment_failed',
      jsonb_build_object('negocio', coalesce(r.tenant_name, '')),
      'Hubo un problema con tu cobro — tenés 3 días',
      _dunning_email_html(r.tenant_name, 'Hubo un problema con tu cobro — tenés 3 días',
        'No pudimos confirmar el pago de tu suscripción de NinjaPos. Tenés 3 días '
          || 'para regularizarlo desde Mercado Pago; pasado ese plazo tu cuenta se '
          || 'bloquea hasta que pagues. Si ya pagaste, podés ignorar este aviso.'));

    insert into dunning_events (tenant_id, kind, period_key) values (r.tenant_id, 'past_due', v_period);
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (r.tenant_id, null, 'subscriptions', r.sub_id, 'dunning_past_due',
            jsonb_build_object('period', v_period, 'grace_days', v_grace));
    v_past_due := v_past_due + 1;
  end loop;

  -- ===========================================================================
  -- B) past_due por más de grace_days (3) → suspended (BLOQUEADA).
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

    perform enqueue_system_email(
      r.tenant_id, v_owner_email, 'suspended_dunning',
      jsonb_build_object('negocio', coalesce(r.tenant_name, '')),
      'Tu cuenta de NinjaPos fue bloqueada',
      _dunning_email_html(r.tenant_name, 'Tu cuenta de NinjaPos fue bloqueada',
        'Bloqueamos tu cuenta por falta de pago. Para reactivarla, pagá tu plan '
          || 'desde tu panel. Al pagar, tu período se reanuda desde el vencimiento '
          || 'anterior (no perdés ni ganás días). Si ya pagaste, escribinos.'));

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
-- 5) activate_addon / cancel_addon: el email del addon IA usa la plantilla
--    (addon_ai_activated / addon_ai_cancelled) en vez de HTML inline. Reproducción
--    1:1 de 20260608270000 con SOLO el bloque de email cambiado.
-- -----------------------------------------------------------------------------
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
  v_label text;
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

  select coalesce(v_addon.current_period_end, s.current_period_end::date)
    into v_period_end
    from subscriptions s
   where s.tenant_id = v_tid;

  if v_period_end is not null and v_period_end > current_date then
    update subscription_addons
       set cancel_at_period_end = true,
           current_period_end = v_period_end
     where tenant_id = v_tid and addon_key = p_addon_key;
  else
    update subscription_addons
       set status = 'cancelled',
           cancel_at_period_end = true
     where tenant_id = v_tid and addon_key = p_addon_key;
  end if;

  select coalesce(pa.label, p_addon_key) into v_label
    from plan_addons pa where pa.key = p_addon_key;
  v_label := coalesce(v_label, p_addon_key);

  insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
  values (v_tid, 'owner', 'plan', 'info',
          'Diste de baja un complemento',
          'El complemento "' || v_label || '" sigue activo hasta '
            || coalesce(to_char(v_period_end, 'DD/MM/YYYY'), 'el fin del período actual')
            || '. Después de esa fecha deja de facturarse.',
          false);

  -- Email del sistema (solo para el addon IA, que tiene plantilla dedicada).
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
                         'vence', coalesce(to_char(v_period_end, 'DD/MM/YYYY'), 'el fin de tu período actual')),
      'Diste de baja el Asistente IA',
      _dunning_email_html(coalesce(v_tenant_name, ''), 'Diste de baja el Asistente IA',
        'Diste de baja el Asistente IA. Lo vas a poder seguir usando hasta '
          || coalesce(to_char(v_period_end, 'DD/MM/YYYY'), 'el fin de tu período actual')
          || '. Después de esa fecha deja de facturarse y se desactiva. '
          || 'Podés reactivarlo cuando quieras desde el Panel del dueño.'));
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tid, auth.uid(), 'subscription_addons', v_tid, 'addon_cancel_at_period_end',
          jsonb_build_object('addon', p_addon_key, 'status', v_addon.status,
                             'cancel_at_period_end', v_addon.cancel_at_period_end),
          jsonb_build_object('addon', p_addon_key, 'cancel_at_period_end', true,
                             'current_period_end', v_period_end));
end;
$fn$;
revoke all on function cancel_addon(text) from public, anon;
grant execute on function cancel_addon(text) to authenticated;

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
begin
  if v_tid is null or not is_tenant_owner() then
    raise exception 'forbidden';
  end if;
  if coalesce(btrim(p_addon_key), '') = '' then
    raise exception 'invalid_addon';
  end if;

  if not exists (select 1 from plan_addons where key = p_addon_key and is_active) then
    raise exception 'addon_not_found';
  end if;

  select s.current_period_start, s.current_period_end into v_sub
    from subscriptions s where s.tenant_id = v_tid;
  if not found then
    raise exception 'subscription_not_found';
  end if;

  v_pstart := coalesce(v_sub.current_period_start::date, current_date);
  v_pend := coalesce(v_sub.current_period_end::date, (current_date + interval '1 month')::date);

  if p_addon_key in ('ai_assistant', 'asistente_ia') then
    select nullif(s.secrets ->> 'addon_price_ars', '')::numeric into v_price
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

  insert into subscription_addons (tenant_id, addon_key, status, source,
                                   monthly_price_ars, current_period_start, current_period_end,
                                   cancel_at_period_end)
  values (v_tid, p_addon_key, 'active', 'purchased',
          v_price, v_pstart, v_pend, false)
  on conflict (tenant_id, addon_key) do update
     set status = 'active',
         cancel_at_period_end = false,
         monthly_price_ars = excluded.monthly_price_ars,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         source = case when subscription_addons.source = 'granted'
                       then 'granted' else 'purchased' end;

  insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
  values (v_tid, 'owner', 'plan', 'info',
          'Activaste un complemento',
          'Activaste "' || v_label || '". Ya está disponible para todo tu equipo.',
          false);

  -- Email del sistema (solo addon IA).
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
                             'current_period_start', v_pstart,
                             'current_period_end', v_pend));
end;
$fn$;
revoke all on function activate_addon(text) from public, anon;
grant execute on function activate_addon(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 6) finalize_catalog_purchase: encola un email 'catalog_purchased' al acreditar
--    la PRIMERA vez (idempotente). Reproducción 1:1 de 20260608390000 con el
--    bloque de email AGREGADO dentro de "if v_first".
-- -----------------------------------------------------------------------------
create or replace function public.finalize_catalog_purchase(
  p_intent_id  uuid,
  p_payment_id text,
  p_price      numeric
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_intent   catalog_payment_intents%rowtype;
  v_name     text;
  v_tname    text;
  v_email    text;
  v_existing uuid;
  v_first    boolean := false;
begin
  if auth.uid() is not null and not is_internal() then
    raise exception 'forbidden';
  end if;

  select * into v_intent
    from catalog_payment_intents
   where id = p_intent_id
   for update;
  if not found then
    raise exception 'intent_not_found';
  end if;

  update catalog_payment_intents
     set status = 'approved',
         mp_payment_id = coalesce(p_payment_id, mp_payment_id)
   where id = p_intent_id;

  select id into v_existing
    from tenant_catalog_purchases
   where tenant_id = v_intent.tenant_id
     and catalog_id = v_intent.catalog_id;

  if v_existing is null then
    insert into tenant_catalog_purchases (tenant_id, catalog_id, source, price_paid)
    values (v_intent.tenant_id, v_intent.catalog_id, 'paid',
            coalesce(p_price, v_intent.amount))
    on conflict (tenant_id, catalog_id) do nothing;
    get diagnostics v_first = row_count;
  end if;

  if v_first then
    select name into v_name from catalogs where id = v_intent.catalog_id;

    insert into audit_logs (
      tenant_id, actor_user_id, entity_type, entity_id, action, after_data
    )
    values (
      v_intent.tenant_id, null, 'tenant_catalog_purchases', null,
      'catalog_purchased',
      jsonb_build_object('catalog_id', v_intent.catalog_id,
                         'intent_id', p_intent_id,
                         'payment_id', p_payment_id,
                         'price_paid', coalesce(p_price, v_intent.amount))
    );

    insert into notifications (
      target_tenant_id, target_role, type, severity, title, body
    )
    values (
      v_intent.tenant_id, 'owner', 'news', 'success',
      'Ya tenés acceso al catálogo "' || coalesce(v_name, '') || '"',
      'Tu compra se acreditó. Entrá a Tiendita para buscar productos del catálogo '
        || 'y agregarlos a tu tienda con un clic.'
    );

    -- Email de confirmación de compra al dueño (plantilla catalog_purchased).
    select t.name, u.email into v_tname, v_email
      from tenants t
      join tenant_users tu on tu.tenant_id = t.id and tu.role = 'owner' and tu.status = 'active'
      join users u on u.id = tu.user_id
     where t.id = v_intent.tenant_id
     order by tu.created_at limit 1;
    perform enqueue_system_email(
      v_intent.tenant_id, v_email, 'catalog_purchased',
      jsonb_build_object('negocio', coalesce(v_tname, ''), 'catalogo', coalesce(v_name, '')),
      'Ya tenés acceso a tu catálogo en NinjaPos',
      _dunning_email_html(coalesce(v_tname, ''), 'Ya tenés acceso a tu catálogo',
        'Tu compra del catálogo "' || coalesce(v_name, '') || '" se acreditó. Entrá a '
          || 'Tiendita para buscar productos del catálogo y agregarlos a tu tienda con un clic.'));
  end if;

  return v_first;
end;
$function$;
revoke all on function public.finalize_catalog_purchase(uuid, text, numeric)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7) internal_save_plan(): el email de AUMENTO de precio usa la plantilla
--    price_increase. Reproducción 1:1 de 20260608130000 con SOLO el insert del
--    email reemplazado por enqueue_system_email.
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

  -- Aviso de AUMENTO de precio a los suscriptos afectados.
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

      perform enqueue_system_email(
        r.tenant_id, v_email, 'price_increase',
        jsonb_build_object('negocio', coalesce(r.tenant_name, ''),
                           'precio_anterior', '$' || v_old.monthly_price_ars::text,
                           'precio_nuevo', '$' || p_monthly_price::text),
        'Actualización de tarifa de tu plan',
        _dunning_email_html(r.tenant_name, 'Actualización de tarifa',
          'Te avisamos que tu plan "' || btrim(p_name) || '" pasa de $'
            || v_old.monthly_price_ars::text || ' a $' || p_monthly_price::text
            || ' por mes a partir de tu próximo ciclo de facturación.'));

      insert into dunning_events (tenant_id, kind, period_key)
      values (r.tenant_id, 'price_increase', v_period);
    end loop;
  end if;

  return p_id;
end;
$$;
revoke all on function internal_save_plan(uuid, text, text, text, text, numeric, int, jsonb, boolean) from public, anon;
grant execute on function internal_save_plan(uuid, text, text, text, text, numeric, int, jsonb, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- 8) Secreto del cron + job pg_cron que despacha la cola vía pg_net.
--
--    El secreto 'internal_cron' (token) se guarda en platform_secrets (deny-all
--    RLS → solo service_role / SECURITY DEFINER lo leen). process_pending_emails
--    lo exige en el header X-Cron-Secret cuando lo invoca el cron (sin JWT de
--    staff). Se genera acá si falta (no se versiona ningún secreto).
-- -----------------------------------------------------------------------------
-- El secreto guarda dos cosas: el 'token' (X-Cron-Secret que valida la edge fn)
-- y el 'apikey' anon del proyecto (JWT público, necesario para pasar el gateway
-- de funciones porque process_pending_emails conserva verify_jwt=true). El anon
-- key es público (publishable), no es un secreto sensible; vive acá para que el
-- comando del cron lo lea de la base y rotarlo no obligue a recrear el job.
insert into platform_secrets (key, secrets)
values ('internal_cron', jsonb_build_object(
          'token', replace(gen_random_uuid()::text, '-', '')
                || replace(gen_random_uuid()::text, '-', ''),
          'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhya2RpdHpyc2F2ZWhuaG5nYWtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5NjE4NzUsImV4cCI6MjA5NDUzNzg3NX0.IGnXLbzql5dWhve2rCnlV1Hxs3AbvMw3Z-ttmmCnoRw'))
on conflict (key) do update
  set secrets = platform_secrets.secrets
    -- Genera el token si falta (no pisa uno existente).
    || (case when coalesce(platform_secrets.secrets ->> 'token', '') = ''
             then jsonb_build_object('token', replace(gen_random_uuid()::text, '-', '')
                                            || replace(gen_random_uuid()::text, '-', ''))
             else '{}'::jsonb end)
    -- Refresca el apikey anon (público) por si cambió.
    || jsonb_build_object('apikey', excluded.secrets ->> 'apikey');

-- Job de despacho: cada 5 minutos, POST a process_pending_emails con el secreto.
-- pg_net.http_post es asíncrono (no bloquea el worker de cron). La URL del
-- proyecto y el secreto se resuelven en runtime desde platform_secrets (el secreto)
-- y una constante (la URL del proyecto). Idempotente: unschedule + schedule.
do $cron$
declare
  v_url   text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/process_pending_emails';
  v_token text;
  v_cmd   text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el job de despacho de emails.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omite el job de despacho de emails.';
    return;
  end if;

  select secrets ->> 'token' into v_token
    from platform_secrets where key = 'internal_cron';

  -- El comando del job lee el secreto + el apikey anon en CADA corrida desde
  -- platform_secrets (no los hardcodea), así rotarlos no obliga a recrear el job.
  -- Authorization+apikey con el anon JWT (pasa el gateway, verify_jwt=true);
  -- X-Cron-Secret autentica de verdad contra la edge fn (que valida el token).
  v_cmd := format($job$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'apikey', (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'X-Cron-Secret', (select secrets ->> 'token' from platform_secrets where key = 'internal_cron')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 25000
    );
  $job$, v_url);

  if exists (select 1 from cron.job where jobname = 'dispatch-system-emails') then
    perform cron.unschedule('dispatch-system-emails');
  end if;
  perform cron.schedule('dispatch-system-emails', '*/5 * * * *', v_cmd);
end;
$cron$;
