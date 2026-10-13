-- =============================================================================
-- 20261101200000_admin_tenants  (F7 · H11c, ADR-073)
--   Administración interna de negocios: alta manual, ciclo de vida con motivo
--   obligatorio (suspender, reactivar, baja lógica) y bloqueo real del negocio
--   dado de baja.
--
--   1) assert_account_active: además de suspended / cancelled / trial vencido,
--      bloquea al negocio con tenants.deleted_at (baja lógica). create_sale,
--      open_cash_shift y las devoluciones ya la llaman al inicio, así que NO se
--      reescriben (la más nueva de create_sale es 20261028100300_impuestos_venta
--      y sigue llamando a esta función).
--   2) internal_tenant_lifecycle(tenant, action, reason): suspend | reactivate |
--      delete. Motivo obligatorio (5+ caracteres). Baja sólo super_admin. Nunca
--      DELETE físico. Escribe audit_logs con antes, después y motivo en la misma
--      transacción.
--   3) internal_set_subscription_status: ya no suspende, cancela ni reactiva
--      (eso pasa por el ciclo de vida, con motivo). Guarda el estado anterior.
--   4) internal_create_tenant(...): sólo service_role (la Edge Function
--      internal_create_tenant invita al dueño y la llama). Crea negocio,
--      suscripción con plan y trial, membresía de dueño, sucursal y caja por
--      defecto y medios de pago base, y audita.
--
--   Tablas de plataforma (tenants, subscriptions): no se agregan políticas RLS.
--   Todo pasa por RPC SECURITY DEFINER con search_path fijo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Guard de cuenta con baja lógica
-- -----------------------------------------------------------------------------
create or replace function assert_account_active(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status     text;
  v_trial_ends timestamptz;
  v_deleted    timestamptz;
begin
  if p_tenant is null then
    return;
  end if;

  select t.status, t.trial_ends_at, t.deleted_at
    into v_status, v_trial_ends, v_deleted
  from tenants t
  where t.id = p_tenant;

  if not found then
    return;
  end if;

  -- Baja lógica desde el panel interno: no opera aunque el estado diga otra cosa.
  if v_deleted is not null then
    raise exception 'account_inactive' using errcode = 'P0001';
  end if;

  -- Estados claramente no pagos: bloqueo. active y past_due (gracia) operan.
  if v_status in ('suspended', 'cancelled')
     or (v_status = 'trial'
         and v_trial_ends is not null
         and v_trial_ends < now()) then
    raise exception 'account_inactive' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function assert_account_active(uuid) from public, anon;
grant execute on function assert_account_active(uuid) to authenticated;

comment on function assert_account_active(uuid) is
  'Lanza account_inactive si el negocio está dado de baja (deleted_at), '
  'suspendido, cancelado o con el trial vencido. active y past_due (gracia) '
  'operan. La llaman create_sale, open_cash_shift y las devoluciones.';

-- -----------------------------------------------------------------------------
-- 2) Ciclo de vida del negocio
-- -----------------------------------------------------------------------------
create or replace function internal_tenant_lifecycle(
  p_tenant_id uuid,
  p_action    text,
  p_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_level  text := coalesce(internal_level(), 'admin');
  v_reason text := btrim(coalesce(p_reason, ''));
  v_t      record;
  v_status text;
  v_del    timestamptz;
  v_audit  text;
begin
  if not is_internal() or v_level = 'support' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_action not in ('suspend', 'reactivate', 'delete') then
    raise exception 'invalid_action';
  end if;
  if p_action = 'delete' and v_level <> 'super_admin' then
    raise exception 'forbidden_super_admin_only' using errcode = '42501';
  end if;
  if char_length(v_reason) < 5 then
    raise exception 'reason_required';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'reason_too_long';
  end if;

  select id, status, deleted_at into v_t
    from tenants where id = p_tenant_id for update;
  if not found then
    raise exception 'tenant_not_found';
  end if;

  if p_action = 'suspend' then
    if v_t.deleted_at is not null or v_t.status in ('suspended', 'cancelled') then
      raise exception 'invalid_transition';
    end if;
    v_status := 'suspended';
    v_del := null;
    v_audit := 'tenant_suspended';
  elsif p_action = 'reactivate' then
    if v_t.deleted_at is null and v_t.status not in ('suspended', 'cancelled') then
      raise exception 'invalid_transition';
    end if;
    v_status := 'active';
    v_del := null;
    v_audit := 'tenant_reactivated';
  else
    if v_t.deleted_at is not null then
      raise exception 'invalid_transition';
    end if;
    v_status := 'cancelled';
    v_del := now();
    v_audit := 'tenant_deleted';
  end if;

  update tenants
     set status = v_status, deleted_at = v_del, updated_at = now()
   where id = p_tenant_id;
  update subscriptions
     set status = v_status, updated_at = now()
   where tenant_id = p_tenant_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id,
                          action, before_data, after_data, reason)
  values (p_tenant_id, auth.uid(), 'tenants', p_tenant_id, v_audit,
          jsonb_build_object('status', v_t.status, 'deleted_at', v_t.deleted_at),
          jsonb_build_object('status', v_status, 'deleted_at', v_del),
          v_reason);

  return jsonb_build_object('status', v_status, 'deleted_at', v_del);
end;
$$;

revoke all on function internal_tenant_lifecycle(uuid, text, text) from public, anon;
grant execute on function internal_tenant_lifecycle(uuid, text, text) to authenticated;

comment on function internal_tenant_lifecycle(uuid, text, text) is
  'Panel interno: suspender, reactivar o dar de baja (lógica) un negocio. '
  'Motivo obligatorio; baja sólo super_admin; audita antes de responder.';

-- -----------------------------------------------------------------------------
-- 3) Estado de suscripción: sin suspensiones ni reactivaciones sin motivo
-- -----------------------------------------------------------------------------
create or replace function internal_set_subscription_status(p_tenant_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_t record;
begin
  if not is_internal() or coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_status not in ('trial', 'active', 'past_due', 'suspended', 'cancelled') then
    raise exception 'invalid_status';
  end if;
  -- Suspender, cancelar y salir de suspensión o baja piden motivo: van por
  -- internal_tenant_lifecycle (o internal_trial_outcome para el trial perdido).
  if p_status in ('suspended', 'cancelled') then
    raise exception 'use_tenant_lifecycle';
  end if;
  select status, deleted_at into v_t from tenants where id = p_tenant_id for update;
  if not found then
    raise exception 'tenant_not_found';
  end if;
  if v_t.deleted_at is not null or v_t.status in ('suspended', 'cancelled') then
    raise exception 'use_tenant_lifecycle';
  end if;

  update subscriptions set status = p_status, updated_at = now() where tenant_id = p_tenant_id;
  update tenants set status = p_status, updated_at = now() where id = p_tenant_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (p_tenant_id, auth.uid(), 'subscriptions', p_tenant_id, 'status_changed',
          jsonb_build_object('status', v_t.status),
          jsonb_build_object('status', p_status));
end; $$;

revoke all on function internal_set_subscription_status(uuid, text) from public, anon;
grant execute on function internal_set_subscription_status(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 4) Alta manual de negocio (sólo service_role, desde la Edge Function)
-- -----------------------------------------------------------------------------
create or replace function internal_create_tenant(
  p_actor          uuid,
  p_owner_user_id  uuid,
  p_name           text,
  p_slug           text,
  p_industry       text,
  p_plan_key       text,
  p_trial_days     int,
  p_reason         text,
  p_owner_invited  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name     text := btrim(coalesce(p_name, ''));
  v_base     text := lower(btrim(coalesce(p_slug, '')));
  v_slug     text;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_level    text;
  v_is_staff boolean;
  v_owner    record;
  v_plan     uuid;
  v_status   text;
  v_trial    timestamptz;
  v_tenant   uuid;
  v_store    uuid;
  v_i        int := 1;
begin
  -- El actor tiene que ser staff (no soporte). La Edge ya validó su JWT; se
  -- vuelve a mirar el app_metadata guardado por si la llaman con otro actor.
  select coalesce((raw_app_meta_data ->> 'is_internal')::boolean, false),
         coalesce(nullif(raw_app_meta_data ->> 'internal_level', ''), 'admin')
    into v_is_staff, v_level
    from auth.users where id = p_actor;
  if not found or not v_is_staff then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_level = 'support' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'invalid_name';
  end if;
  if v_base !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_base) > 40 then
    raise exception 'invalid_slug';
  end if;
  if p_industry not in ('kiosco','textil','retail','restaurante','heladeria','cafeteria',
                        'panaderia','peluqueria','estetica','servicios','pyme','otro') then
    raise exception 'invalid_industry';
  end if;
  if p_trial_days is null or p_trial_days < 0 or p_trial_days > 90 then
    raise exception 'invalid_trial_days';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'reason_too_long';
  end if;

  select id into v_plan from plans
   where key = p_plan_key and is_active and tenant_id is null;
  if v_plan is null then
    raise exception 'plan_not_found';
  end if;

  select id, email into v_owner from users where id = p_owner_user_id;
  if not found then
    raise exception 'owner_not_found';
  end if;

  -- Slug único: base, base-2, base-3...
  perform pg_advisory_xact_lock(hashtext('tenant_slug:' || v_base));
  v_slug := v_base;
  while exists (select 1 from tenants where slug = v_slug) loop
    v_i := v_i + 1;
    if v_i > 50 then raise exception 'slug_taken'; end if;
    v_slug := left(v_base, 36) || '-' || v_i::text;
  end loop;

  if p_trial_days > 0 then
    v_status := 'trial';
    v_trial := now() + make_interval(days => p_trial_days);
  else
    v_status := 'active';
    v_trial := null;
  end if;

  insert into tenants (name, slug, industry, status, trial_ends_at)
  values (v_name, v_slug, p_industry, v_status, v_trial)
  returning id into v_tenant;

  insert into subscriptions (tenant_id, plan_id, status, billing_cycle,
                             current_period_start, current_period_end)
  values (v_tenant, v_plan, v_status, 'monthly', now(),
          coalesce(v_trial, now() + interval '1 month'));

  insert into tenant_users (tenant_id, user_id, role, status, joined_at)
  values (v_tenant, p_owner_user_id, 'owner', 'active', now());

  insert into stores (tenant_id, name, is_default)
  values (v_tenant, 'Sucursal principal', true)
  returning id into v_store;

  insert into cash_registers (tenant_id, store_id, name)
  values (v_tenant, v_store, 'Caja 1');

  -- Medios base (efectivo y transferencia). Best-effort como en create_tenant:
  -- sin filas la app igual los trata como prendidos (lib/payments/defaults.ts).
  begin
    insert into tenant_payment_methods (tenant_id, provider_key, enabled, sandbox, sort)
    values (v_tenant, 'cash', true, false, 0),
           (v_tenant, 'transfer', true, false, 1)
    on conflict (tenant_id, provider_key) do nothing;
  exception when check_violation then
    null;
  end;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id,
                          action, after_data, reason)
  values (v_tenant, p_actor, 'tenants', v_tenant, 'tenant_created_internal',
          jsonb_build_object(
            'name', v_name, 'slug', v_slug, 'industry', p_industry,
            'plan', p_plan_key, 'status', v_status, 'trial_ends_at', v_trial,
            'owner_user_id', p_owner_user_id, 'owner_email', v_owner.email,
            'owner_invited', coalesce(p_owner_invited, false)),
          v_reason);

  return jsonb_build_object('tenant_id', v_tenant, 'slug', v_slug,
                            'status', v_status, 'trial_ends_at', v_trial);
end;
$$;

revoke all on function internal_create_tenant(uuid, uuid, text, text, text, text, int, text, boolean)
  from public, anon, authenticated;
grant execute on function internal_create_tenant(uuid, uuid, text, text, text, text, int, text, boolean)
  to service_role;

comment on function internal_create_tenant(uuid, uuid, text, text, text, text, int, text, boolean) is
  'Alta manual de negocio desde el panel interno (sólo service_role, Edge '
  'internal_create_tenant). Crea negocio, suscripción, dueño, sucursal, caja y '
  'medios de pago base, y audita en la misma transacción.';
