-- =============================================================================
-- 20260608660000_saas_billing_fixes  (SaaS / billing — correcciones 🔴/🟠/🟡)
--
-- Corrige defectos del cobro de la suscripción a NinjaSoft (preapproval de MP) y
-- de los addons. Cinco fixes, todos en este archivo para versionarlos juntos:
--
--  BUG 4  (🔴 defensa SQL) — Cancelar/dar de baja NO debe seguir cobrando. La
--         pausa del preapproval en MP la hace una Edge Function nueva
--         (mp_subscription_pause). Acá, defensa en profundidad:
--         reanchor_subscription_period() RESPETA cancel_at_period_end: si el
--         dueño marcó cancelar y el período venció, la suscripción pasa a
--         'cancelled' (no se reactiva), de modo que un webhook 'authorized'
--         tardío no resucite una cuenta dada de baja.
--
--  BUG 5  (🟠) — Un addon BONIFICADO (source='granted') no debe facturarse.
--         (a) subscription_billing_total() excluye source='granted' de la suma.
--         (b) activate_addon() deja monthly_price_ars NULL cuando el addon queda
--             como 'granted' (no escribe el precio del catálogo encima).
--
--  BUG 8  (🟠) — Webhook idempotente ante 'authorized' repetido. Se agrega la
--         tabla mp_webhook_events (dedup por id de evento/pago de MP). El guard
--         se evalúa ANTES de reanclar (en la Edge Function); acá se crea la
--         tabla + el helper claim_mp_webhook_event() que inserta-si-no-existe de
--         forma atómica y devuelve si el evento es nuevo.
--
--  BUG 19 (🟡) — my_subscription() perdió blocked/past_due_since (la 600000
--         reescribió la función sin esos campos al sumar 'source'). Se consolida:
--         source (addon) + blocked + past_due_since juntos.
--
--  BUG 20 (🟡) — set_cancel_at_period_end() existía sólo en la DB (no en
--         migraciones). Se versiona su definición (idéntica a la viva) para que
--         un db:reset no la pierda.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- BUG 5(a) — subscription_billing_total: NO sumar addons bonificados.
--   Antes: sum(coalesce(sa.monthly_price_ars, pa.monthly_price_ars, 0)) sobre
--   todo addon facturable, sin mirar el source. Un addon 'granted' con precio
--   (p. ej. un grant viejo que dejó monthly_price_ars) se cobraba aunque la UI
--   diga "Bonificado". Ahora: case when sa.source='granted' then 0 else ... end.
--   El resto (ventana cancel_at_period_end, x12 anual, desglose) es idéntico a
--   20260608300000.
-- -----------------------------------------------------------------------------
create or replace function subscription_billing_total(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_cycle text;
  v_yearly boolean;
  v_plan_amount numeric;
  v_addons_monthly numeric;
  v_addons_amount numeric;
  v_total numeric;
begin
  if p_tenant is null then
    return null;
  end if;

  select s.billing_cycle,
         case when s.billing_cycle = 'yearly'
              then coalesce(p.yearly_price_ars, p.monthly_price_ars * 12)
              else p.monthly_price_ars end
    into v_cycle, v_plan_amount
    from subscriptions s
    join plans p on p.id = s.plan_id
   where s.tenant_id = p_tenant;

  if v_cycle is null then
    return null;  -- sin suscripción
  end if;
  v_yearly := (v_cycle = 'yearly');
  v_plan_amount := coalesce(v_plan_amount, 0);

  -- Addons FACTURABLES: activos, o cancelados pero todavía dentro de su ventana
  -- pagada (mismo criterio que ai_available / el panel). Precio mensual de cada
  -- addon (subscription_addons.monthly_price_ars; fallback al catálogo). Los
  -- BONIFICADOS (source='granted') suman 0: la UI los muestra "Bonificado por
  -- NinjaSoft" y NO se facturan (consistencia con SubscriptionCard.aiComped).
  select coalesce(sum(
           case when sa.source = 'granted'
                then 0
                else coalesce(sa.monthly_price_ars, pa.monthly_price_ars, 0)
           end), 0)
    into v_addons_monthly
    from subscription_addons sa
    left join plan_addons pa on pa.key = sa.addon_key
   where sa.tenant_id = p_tenant
     and (
       sa.status = 'active'
       or (sa.cancel_at_period_end
           and sa.current_period_end is not null
           and sa.current_period_end >= current_date)
     );

  v_addons_monthly := coalesce(v_addons_monthly, 0);
  -- Alinear el addon a la frecuencia del preapproval (anual = x12).
  v_addons_amount := case when v_yearly then v_addons_monthly * 12 else v_addons_monthly end;
  v_total := v_plan_amount + v_addons_amount;

  return jsonb_build_object(
    'tenant_id', p_tenant,
    'billing_cycle', v_cycle,
    'currency', 'ARS',
    'plan_amount', v_plan_amount,
    'addons_amount', v_addons_amount,
    'addons_monthly', v_addons_monthly,
    'total', v_total
  );
end;
$fn$;

revoke all on function subscription_billing_total(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- BUG 5(b) — activate_addon: no escribir precio en un addon BONIFICADO.
--   El camino "Reactivar" hacía on conflict do update y SIEMPRE seteaba
--   monthly_price_ars = excluded (= precio del catálogo/ai_config), incluso
--   cuando conservaba source='granted'. Resultado: addon granted + precio →
--   subscription_billing_total (antes del 5a) lo cobraba. Ahora: si el source
--   resultante es 'granted', monthly_price_ars queda NULL (sin cobro); si es
--   'purchased', se escribe el precio como antes. Idéntico al resto de la
--   función viva (notificación, email IA, audit).
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

  -- Alta nueva (no existía): la inicia el dueño → 'purchased' con su precio.
  -- Reactivación (on conflict): si la fila venía 'granted' (bonificada), se
  -- MANTIENE 'granted' y el precio queda NULL (no se factura); si era de pago,
  -- 'purchased' + precio. Esto evita el bug "bonificado con precio → se cobra".
  insert into subscription_addons (tenant_id, addon_key, status, source,
                                   monthly_price_ars, current_period_start, current_period_end,
                                   cancel_at_period_end)
  values (v_tid, p_addon_key, 'active', 'purchased',
          v_price, v_pstart, v_pend, false)
  on conflict (tenant_id, addon_key) do update
     set status = 'active',
         cancel_at_period_end = false,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         source = case when subscription_addons.source = 'granted'
                       then 'granted' else 'purchased' end,
         -- Bonificado ⇒ sin precio (NULL). Pago ⇒ precio del catálogo/ai_config.
         monthly_price_ars = case when subscription_addons.source = 'granted'
                                  then null else excluded.monthly_price_ars end;

  insert into notifications (target_tenant_id, target_role, type, severity, title, body, requires_ack)
  values (v_tid, 'owner', 'plan', 'info',
          'Activaste un complemento',
          'Activaste "' || v_label || '". Ya está disponible para todo tu equipo.',
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
                             'current_period_start', v_pstart,
                             'current_period_end', v_pend));
end;
$fn$;

revoke all on function activate_addon(text) from public, anon;
grant execute on function activate_addon(text) to authenticated;

-- -----------------------------------------------------------------------------
-- BUG 8 — Idempotencia del webhook de cobro (mp_billing_webhook).
--   El webhook llamaba reanchor_subscription_period() en CADA 'authorized'; la
--   dedup del billing_record (por period_end) corría DESPUÉS, así que un reenvío
--   del mismo evento avanzaba el período +1 mes ANTES de descartarse. Ahora la
--   idempotencia se evalúa ANTES de reanclar, por id de EVENTO/PAGO de MP (no por
--   period_end). Esta tabla guarda los eventos ya procesados; el helper inserta
--   atómicamente (on conflict do nothing) y dice si el evento es NUEVO.
-- -----------------------------------------------------------------------------
create table if not exists mp_webhook_events (
  event_key    text primary key,           -- id único del evento/pago de MP
  topic        text,                        -- preapproval / subscription_authorized_payment / ...
  preapproval_id text,
  tenant_id    uuid references tenants(id) on delete set null,
  mp_status    text,
  processed_at timestamptz not null default now()
);

comment on table mp_webhook_events is
  'Dedup de notificaciones de Mercado Pago ya procesadas por mp_billing_webhook. '
  'La PK event_key es el id único del evento/pago de MP. Garantiza idempotencia: '
  'un reenvío del mismo authorized NO vuelve a reanclar el período ni a registrar '
  'un cobro. La pueblan las Edge Functions con service_role.';

alter table mp_webhook_events enable row level security;
-- Sin políticas: sólo accesible por service_role (edge fns). authenticated/anon
-- no leen ni escriben (RLS sin policy = deniega).
revoke all on table mp_webhook_events from anon, authenticated;

-- claim_mp_webhook_event: inserta el evento si no existía y devuelve true cuando
-- es NUEVO (procesarlo), false si ya estaba (saltearlo). Atómico vía on conflict.
-- SECURITY DEFINER + edge-only: lo invoca el webhook con service_role por RPC,
-- así no acopla el SQL del "claim" al cliente.
create or replace function claim_mp_webhook_event(
  p_event_key      text,
  p_topic          text default null,
  p_preapproval_id text default null,
  p_tenant_id      uuid default null,
  p_mp_status      text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_inserted boolean := false;
begin
  if coalesce(btrim(p_event_key), '') = '' then
    -- Sin clave estable no podemos deduplicar: tratamos como nuevo (no bloquear
    -- un cobro legítimo) pero no dejamos rastro que cause falsos positivos.
    return true;
  end if;

  insert into mp_webhook_events (event_key, topic, preapproval_id, tenant_id, mp_status)
  values (btrim(p_event_key), p_topic, p_preapproval_id, p_tenant_id, p_mp_status)
  on conflict (event_key) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;  -- true = fila insertada (evento nuevo); false = ya existía.
end;
$fn$;

revoke all on function claim_mp_webhook_event(text, text, text, uuid, text)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- BUG 4 (defensa SQL) — reanchor_subscription_period RESPETA cancel_at_period_end.
--   Si el dueño marcó cancelar (cancel_at_period_end=true) o pidió la baja de la
--   cuenta, y el período YA venció, un 'authorized' tardío de MP NO debe
--   reactivar la cuenta: se pasa a 'cancelled'. Si todavía no venció, se honra el
--   cobro (reancla normal) — el cobro pendiente corresponde al período corriente;
--   la baja efectiva ocurre al vencimiento. Reproduce 20260608350000 con ese
--   guard al inicio. El resto (cálculo del ancla, audit) es idéntico.
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

  -- BUG 4 — Cancelación programada + período vencido ⇒ NO reactivar. Un webhook
  -- 'authorized' que llega después de que la cuenta venció (y con la baja
  -- programada) pasa a 'cancelled' en vez de resucitarla y reanclar. Así MP no
  -- mantiene "viva" una cuenta dada de baja aunque la pausa del preapproval no
  -- haya alcanzado a aplicarse. Si el período NO venció, se honra el cobro
  -- normalmente (corresponde al ciclo corriente; la baja opera al vencimiento).
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

  -- Ancla = vencimiento anterior. Si por algún motivo no hay período previo
  -- (datos viejos), caemos a current_period_start o, último recurso, a p_now
  -- (en ese caso no hay lapso que "anclar"; arranca ahora).
  v_anchor := coalesce(v_sub.current_period_end, v_sub.current_period_start, p_now);
  v_end    := v_anchor + make_interval(months => v_months);

  -- Si el atraso cubrió varios ciclos, avanzamos el ancla de a v_months ciclos
  -- (manteniendo el día del mes) hasta que el período vigente contenga a p_now.
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
$fn$;

revoke all on function reanchor_subscription_period(uuid, int, timestamptz) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- BUG 20 — Versionar set_cancel_at_period_end (existía sólo en la DB).
--   Definición idéntica a la viva (pg_get_functiondef). Owner-gated, audita el
--   cambio. La card del dueño la usa para programar/deshacer la cancelación.
-- -----------------------------------------------------------------------------
create or replace function set_cancel_at_period_end(p_cancel boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tid uuid := current_tenant_id();
  v_old boolean;
begin
  if v_tid is null or not is_tenant_owner() then
    raise exception 'forbidden';
  end if;

  select cancel_at_period_end into v_old from subscriptions where tenant_id = v_tid;
  if not found then
    raise exception 'subscription_not_found';
  end if;

  update subscriptions
     set cancel_at_period_end = coalesce(p_cancel, false), updated_at = now()
   where tenant_id = v_tid;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (v_tid, auth.uid(), 'subscriptions', v_tid, 'cancel_at_period_end_set',
          jsonb_build_object('cancel_at_period_end', coalesce(v_old, false)),
          jsonb_build_object('cancel_at_period_end', coalesce(p_cancel, false)));
end;
$fn$;

revoke all on function set_cancel_at_period_end(boolean) from public, anon;
grant execute on function set_cancel_at_period_end(boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- BUG 19 — my_subscription(): consolidar source (addon) + blocked + past_due_since.
--   La 350000 agregó blocked/past_due_since; la 600000 (al sumar addon.source)
--   reescribió la función SIN ellos. Acá se unifica: el addon expone `source` Y
--   el objeto raíz expone `blocked` + `past_due_since` (contrato que lee el
--   gating de la app y el panel del dueño). Sin otros cambios de comportamiento.
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
    -- Contrato de bloqueo para el gating de la app (recuperado de la 350000).
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
        -- 'granted' = bonificado por NinjaSoft (sin cobro); 'purchased' = pago.
        'source', sa.source,
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
