-- =============================================================================
-- 20260608270000_owner_subscription_panel
--   Panel del dueño (self-service de suscripción) + corrección de la semántica
--   de facturación del addon IA + baja de cuenta.
--
-- A) subscription_addons.cancel_at_period_end: el addon cancelado SIGUE activo
--    hasta current_period_end (igual que la suscripción). Se agrega la columna
--    del flag (el CHECK de status se mantiene 'active'|'cancelled').
-- B) cancel_addon(): ya NO corta el acceso al instante. Marca cancel_at_period_end
--    = true y MANTIENE status='active' hasta current_period_end. Si el addon no
--    tiene período (granted sin fecha / ya vencido) se corta igual.
-- C) activate_addon(p_addon_key): NUEVO, owner-gated. Activa el addon con
--    monthly_price_ars (de ai_config.addon_price_ars para el addon IA, si no del
--    plan_addons) y períodos alineados a la suscripción del plan. Cobro real de
--    MP del addon queda PENDIENTE de integrar (ver nota DESIGN): se deja el addon
--    con precio + períodos correctos en subscription_addons (no se finge cobro).
-- D) ai_available(): el guard ahora honra la ventana cancel_at_period_end. El
--    guard server-side equivalente vive en la Edge Function ai_assistant.
-- E) tenants.closure_requested_at + request_account_closure(p_reason): baja de
--    cuenta SOLICITADA (baja lógica/marca), owner-gated, auditada, sin borrar
--    datos. Mantiene acceso hasta fin de período (no cambia status acá).
-- F) Notificaciones in-app (insert directo en notifications — internal_notify es
--    staff-gated y no sirve desde contexto de dueño) en activar/cancelar addon y
--    en cambio de plan; emails del sistema vía system_emails + _dunning_email_html.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Flag de cancelación a fin de período en los addons.
-- -----------------------------------------------------------------------------
alter table subscription_addons
  add column if not exists cancel_at_period_end boolean not null default false;

-- -----------------------------------------------------------------------------
-- B) cancel_addon — baja a fin de período (NO corta al instante).
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

  -- Ya cancelado (status o flag) → idempotente.
  if v_addon.status = 'cancelled' or v_addon.cancel_at_period_end then
    return;
  end if;

  -- Período del addon (date). Si no hay, alineamos al de la suscripción.
  select coalesce(v_addon.current_period_end, s.current_period_end::date)
    into v_period_end
    from subscriptions s
   where s.tenant_id = v_tid;

  if v_period_end is not null and v_period_end > current_date then
    -- Hay ventana: sigue activo hasta fin de período.
    update subscription_addons
       set cancel_at_period_end = true,
           current_period_end = v_period_end
     where tenant_id = v_tid and addon_key = p_addon_key;
  else
    -- Sin ventana válida (granted sin fecha, o ya vencido) → corte directo.
    update subscription_addons
       set status = 'cancelled',
           cancel_at_period_end = true
     where tenant_id = v_tid and addon_key = p_addon_key;
  end if;

  -- Label legible para los avisos.
  select coalesce(pa.label, p_addon_key) into v_label
    from plan_addons pa where pa.key = p_addon_key;
  v_label := coalesce(v_label, p_addon_key);

  -- Aviso in-app al dueño.
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
    if v_owner_email is not null then
      insert into system_emails (tenant_id, recipient, subject, kind, status, html_content)
      values (v_tid, v_owner_email, 'Diste de baja el Asistente IA', 'system', 'pending',
              _dunning_email_html(coalesce(v_tenant_name, ''), 'Diste de baja el Asistente IA',
                'Diste de baja el Asistente IA. Lo vas a poder seguir usando hasta '
                  || coalesce(to_char(v_period_end, 'DD/MM/YYYY'), 'el fin de tu período actual')
                  || '. Después de esa fecha deja de facturarse y se desactiva. '
                  || 'Podés reactivarlo cuando quieras desde el Panel del dueño.'));
    end if;
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

-- -----------------------------------------------------------------------------
-- C) activate_addon — alta del addon por el dueño, con precio + períodos.
--    DESIGN — cobro real de MP: hoy mp_subscription_checkout crea un preapproval
--    SOLO por el monto del plan. Integrar el addon como ítem extra del preapproval
--    (o un segundo preapproval) excede este cambio y depende de la operatoria de
--    MP. Por eso acá dejamos el addon con monthly_price_ars + períodos alineados
--    al plan (la fuente de verdad para "qué se cobra"), pero NO inventamos un
--    cobro real: queda documentado como pendiente. El acceso al addon se habilita
--    igual (modelo: NinjaSoft concilia el cobro del addon por fuera por ahora).
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
begin
  if v_tid is null or not is_tenant_owner() then
    raise exception 'forbidden';
  end if;
  if coalesce(btrim(p_addon_key), '') = '' then
    raise exception 'invalid_addon';
  end if;

  -- El addon debe existir y estar activo en el catálogo.
  if not exists (select 1 from plan_addons where key = p_addon_key and is_active) then
    raise exception 'addon_not_found';
  end if;

  select s.current_period_start, s.current_period_end into v_sub
    from subscriptions s where s.tenant_id = v_tid;
  if not found then
    raise exception 'subscription_not_found';
  end if;

  -- Períodos alineados al plan (date). Si la suscripción no tiene período (raro),
  -- usamos hoy → +1 mes para no dejar el addon sin ventana.
  v_pstart := coalesce(v_sub.current_period_start::date, current_date);
  v_pend := coalesce(v_sub.current_period_end::date, (current_date + interval '1 month')::date);

  -- Precio: para el addon IA, ai_config.addon_price_ars manda (es el que se le
  -- muestra al dueño). Para el resto, plan_addons.monthly_price_ars.
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

  -- Alta/actualización: activo, con precio y períodos, flag de baja en false.
  -- source='purchased' porque lo contrata el dueño (no es un grant interno).
  -- Si ya era 'granted' (cortesía interna) lo respetamos.
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

  -- Aviso in-app.
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
    if v_owner_email is not null then
      insert into system_emails (tenant_id, recipient, subject, kind, status, html_content)
      values (v_tid, v_owner_email, 'Activaste el Asistente IA en NinjaPos', 'system', 'pending',
              _dunning_email_html(coalesce(v_tenant_name, ''), 'Activaste el Asistente IA',
                'Activaste el Asistente IA de NinjaPos. Ya podés usarlo desde la burbuja del '
                  || 'asistente en cualquier pantalla del sistema. Te responde sobre tus ventas, '
                  || 'tu stock y cómo usar cada función.'));
    end if;
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
-- D) ai_available — el guard honra la ventana cancel_at_period_end.
--    active OR (cancel_at_period_end AND current_date <= current_period_end).
-- -----------------------------------------------------------------------------
create or replace function ai_available()
returns boolean
language sql
stable security definer
set search_path = public, pg_temp
as $fn$
  with t as (select current_tenant_id() as tid)
  select coalesce(
    (select true from subscription_addons sa join t on t.tid = sa.tenant_id
      where sa.addon_key in ('asistente_ia', 'ai_assistant')
        and (
          sa.status = 'active'
          or (sa.cancel_at_period_end
              and sa.current_period_end is not null
              and sa.current_period_end >= current_date)
        )
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
$fn$;

-- -----------------------------------------------------------------------------
-- E) Baja de cuenta solicitada.
-- -----------------------------------------------------------------------------
alter table tenants
  add column if not exists closure_requested_at timestamptz,
  add column if not exists closure_reason text;

create or replace function request_account_closure(p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tid uuid := current_tenant_id();
  v_tenant record;
begin
  if v_tid is null or not is_tenant_owner() then
    raise exception 'forbidden';
  end if;

  select * into v_tenant from tenants where id = v_tid;
  if not found then
    raise exception 'tenant_not_found';
  end if;

  -- Idempotente: si ya está solicitada, no re-marcamos (pero no fallamos).
  if v_tenant.closure_requested_at is not null then
    return;
  end if;

  -- Baja LÓGICA/solicitud: marcamos la fecha + motivo. NO borramos datos ni
  -- cambiamos status (el acceso sigue hasta fin de período; el cierre efectivo
  -- lo opera NinjaSoft). Adicionalmente programamos la cancelación a fin de
  -- período de la suscripción (deja de renovar).
  update tenants
     set closure_requested_at = now(),
         closure_reason = nullif(btrim(p_reason), ''),
         updated_at = now()
   where id = v_tid;

  update subscriptions
     set cancel_at_period_end = true, updated_at = now()
   where tenant_id = v_tid;

  -- NOTA: no se emite notificación a rol staff porque notifications.target_role
  -- solo admite roles de tenant (owner/manager/cashier/viewer). NinjaSoft ve la
  -- solicitud por tenants.closure_requested_at + el audit_log de abajo.

  -- Aviso in-app al dueño confirmando la solicitud.
  insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
  values (v_tid, 'owner', 'billing', 'warning',
          'Solicitaste dar de baja tu cuenta',
          'Registramos tu solicitud de baja. Vas a mantener el acceso hasta el fin '
            || 'de tu período actual. Si fue un error, escribinos para revertirla.',
          false);

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tid, auth.uid(), 'tenants', v_tid, 'account_closure_requested',
          jsonb_build_object('reason', nullif(btrim(p_reason), ''),
                             'requested_at', now()));
end;
$fn$;

revoke all on function request_account_closure(text) from public, anon;
grant execute on function request_account_closure(text) to authenticated;

-- -----------------------------------------------------------------------------
-- F) request_plan_change — agregar aviso in-app de upgrade/downgrade.
--    Reproducción de owner_subscription con el bloque de notificación AGREGADO.
-- -----------------------------------------------------------------------------
create or replace function request_plan_change(p_plan_key text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tid uuid := current_tenant_id();
  v_new_plan plans%rowtype;
  v_old_plan_id uuid;
  v_old_key text;
  v_old_price numeric;
  v_kind text;
begin
  if v_tid is null or not is_tenant_owner() then
    raise exception 'forbidden';
  end if;
  if coalesce(btrim(p_plan_key), '') = '' then
    raise exception 'invalid_plan';
  end if;

  select * into v_new_plan from plans
   where key = p_plan_key and tenant_id is null and is_active
   limit 1;
  if not found then
    raise exception 'plan_not_found';
  end if;

  select s.plan_id, p.key, p.monthly_price_ars into v_old_plan_id, v_old_key, v_old_price
    from subscriptions s join plans p on p.id = s.plan_id
   where s.tenant_id = v_tid;
  if not found then
    raise exception 'subscription_not_found';
  end if;

  update subscriptions
     set plan_id = v_new_plan.id,
         cancel_at_period_end = false,
         updated_at = now()
   where tenant_id = v_tid;

  -- Tipo de cambio para el aviso.
  v_kind := case
    when v_new_plan.monthly_price_ars > coalesce(v_old_price, 0) then 'upgrade'
    when v_new_plan.monthly_price_ars < coalesce(v_old_price, 0) then 'downgrade'
    else 'change'
  end;

  if v_old_key is distinct from p_plan_key then
    insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
    values (v_tid, 'owner', 'plan', 'info',
            case v_kind
              when 'upgrade' then 'Mejoraste tu plan'
              when 'downgrade' then 'Cambiaste a un plan menor'
              else 'Cambiaste de plan'
            end,
            'Tu plan ahora es "' || coalesce(v_new_plan.name, p_plan_key)
              || '". El nuevo precio se aplica desde tu próximo ciclo de facturación.',
            false);
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tid, auth.uid(), 'subscriptions', v_tid, 'plan_change_requested',
          jsonb_build_object('plan_key', v_old_key, 'monthly_price_ars', v_old_price),
          jsonb_build_object('plan_key', p_plan_key, 'kind', v_kind,
                             'monthly_price_ars', v_new_plan.monthly_price_ars));
end;
$fn$;

revoke all on function request_plan_change(text) from public, anon;
grant execute on function request_plan_change(text) to authenticated;

-- -----------------------------------------------------------------------------
-- G) my_subscription — exponer cancel_at_period_end del addon + closure de la
--    cuenta para que el panel del dueño pueda mostrar esos estados.
--    Reproducción de owner_subscription con esos dos campos AGREGADOS.
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
