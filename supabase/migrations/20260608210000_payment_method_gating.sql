-- =============================================================================
-- 20260608210000_payment_method_gating  (BUG seguridad — gating real de medios)
-- El gating de medios de pago por plan era SOLO de UI: sacando el `disabled`
-- por devtools (o llamando la RPC/Edge directo) se podía cobrar con un medio que
-- el plan no habilita (p. ej. MODO o Mobbex en un plan Start). Esta migración
-- mueve el gate al BACKEND, de forma que sea imposible saltearlo desde el cliente.
--
-- Capas de enforcement (defensa en profundidad):
--   1) Coarse: `payments.method` (cash/transfer/qr/…) → feature key del plan,
--      vía trigger BEFORE INSERT en `payments` (efectivo/transferencia).
--   2) Fino (lo que el usuario reportó): para method='qr' el proveedor real
--      (mercadopago/modo/mobbex) NO vive en payments.method sino en el intent
--      QR (mp_payment_intents.provider_key) referenciado por payments.reference.
--      El trigger resuelve el proveedor del intent y exige su feature.
--   3) Las Edge Functions de QR (mp_create_qr / mobbex_create_qr) corren con
--      service_role (saltean RLS) y crean el intent ANTES del pago → ahí también
--      se valida el plan explícitamente (ver supabase/functions, fuera de esta
--      migración).
--
-- Por qué resolver el plan por tenant_id de la FILA y no por current_tenant_id():
-- current_tenant_id() lee el JWT (auth.jwt()->app_metadata->current_tenant_id).
-- En conexiones service_role NO hay JWT → devuelve NULL. Si el trigger usara
-- current_tenant_id() un insert vía service_role saltearía el check. Por eso se
-- usa una variante del check scopeada a un tenant explícito.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- tenant_has_feature_for: misma resolución que tenant_has_feature(key) pero
-- contra un tenant EXPLÍCITO (no el del JWT). Sirve en triggers y en contextos
-- service_role donde current_tenant_id() es NULL.
-- Orden: override (tenant_feature_flags) → addon activo (subscription_addons)
--        → módulo del plan (plans.limits->modules) → básica (features.is_basic)
--        → false. La semántica del coalesce (presente=respeta plan / ausente=
--        fallback a is_basic) es idéntica a tenant_has_feature.
-- ---------------------------------------------------------------------------
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
      where tff.tenant_id = p_tenant and ff.key = p_key limit 1),
    (select true from subscription_addons sa
      where sa.tenant_id = p_tenant and sa.addon_key = p_key
        and sa.status = 'active' limit 1),
    (select (p.limits -> 'modules' ->> p_key)::boolean
       from subscriptions s join plans p on p.id = s.plan_id
      where s.tenant_id = p_tenant limit 1),
    (select is_basic from features where key = p_key),
    false
  );
$$;
revoke all on function tenant_has_feature_for(uuid, text) from public, anon;
grant execute on function tenant_has_feature_for(uuid, text) to authenticated, service_role;

-- Reescribe tenant_has_feature(key) como delegación a la variante explícita,
-- para que ambas funciones compartan exactamente la misma lógica (una sola
-- fuente de verdad). El comportamiento observable no cambia.
create or replace function tenant_has_feature(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select tenant_has_feature_for(current_tenant_id(), p_key);
$$;
revoke all on function tenant_has_feature(text) from public, anon;
grant execute on function tenant_has_feature(text) to authenticated;

-- ---------------------------------------------------------------------------
-- payment_method_plan_key(method): mapea un medio/proveedor a su feature key de
-- plan. Acepta tanto los valores de payments.method (cash/transfer/qr/…) como
-- los provider_key del catálogo (mercadopago/modo/mobbex/…). Devuelve NULL para
-- los medios SIN gating (no tienen feature asociada → siempre permitidos: vale,
-- cuenta corriente, débito/crédito por posnet propio, 'qr' genérico sin
-- proveedor resuelto, y proveedores aún no integrados).
-- IMMUTABLE: el mapeo es estático.
-- ---------------------------------------------------------------------------
create or replace function payment_method_plan_key(p_method text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_method, ''))
    -- Medios básicos (is_basic=true): el gate los deja pasar en todo plan, pero
    -- se mapean explícitamente para que un plan que los apague (futuro) corte.
    when 'cash'              then 'efectivo'
    when 'efectivo'          then 'efectivo'
    when 'transfer'          then 'transferencia'
    when 'transferencia'     then 'transferencia'
    -- Pasarelas con feature de plan (lo que el usuario reportó).
    when 'mercadopago'       then 'mercado_pago'
    when 'mercadopago_point' then 'mercado_pago'
    when 'mp'                then 'mercado_pago'
    when 'mercado_pago'      then 'mercado_pago'
    when 'modo'              then 'modo'
    when 'mobbex'            then 'mobbex'
    -- Sin gating de plan: medios operativos internos y proveedores no integrados.
    -- (debit/credit/qr-genérico/store_credit/account/other/payway/getnet/…)
    else null
  end;
$$;
revoke all on function payment_method_plan_key(text) from public, anon;
grant execute on function payment_method_plan_key(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- assert_payment_method_allowed(method, tenant): si el medio mapea a una feature
-- y el tenant NO la tiene habilitada por su plan → excepción. Sin tenant usa el
-- del JWT (para llamadas desde RPC con sesión de usuario).
-- SECURITY DEFINER para que pueda leer plans/features/etc. saltando RLS.
-- ---------------------------------------------------------------------------
create or replace function assert_payment_method_allowed(
  p_method text,
  p_tenant uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := coalesce(p_tenant, current_tenant_id());
  v_key    text := payment_method_plan_key(p_method);
begin
  -- Medio sin feature de plan → siempre permitido.
  if v_key is null then
    return;
  end if;
  -- Sin tenant resoluble no podemos validar el plan. Fail-closed para medios
  -- gateados que no sean básicos (evita bypass por contexto sin tenant); los
  -- básicos (efectivo/transferencia) no se bloquean por falta de contexto.
  if v_tenant is null then
    if v_key in ('efectivo', 'transferencia') then
      return;
    end if;
    raise exception 'payment_method_not_allowed: % (no_tenant)', p_method
      using errcode = 'check_violation';
  end if;

  if not tenant_has_feature_for(v_tenant, v_key) then
    -- Auditoría barata del intento bloqueado (best-effort; no aborta si falla).
    begin
      insert into audit_logs (tenant_id, actor_user_id, entity_type, action, reason, after_data)
      values (v_tenant, auth.uid(), 'payment', 'payment_method_blocked',
              'plan_gating',
              jsonb_build_object('method', p_method, 'feature', v_key));
    exception when others then
      null;
    end;
    raise exception 'payment_method_not_allowed: %', p_method
      using errcode = 'check_violation';
  end if;
end;
$$;
revoke all on function assert_payment_method_allowed(text, uuid) from public, anon;
grant execute on function assert_payment_method_allowed(text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Trigger BEFORE INSERT en payments: valida el medio contra el plan del tenant
-- de la FILA (no del JWT). Imposible de saltear desde el cliente — toda venta
-- termina insertando acá, venga de create_sale (RPC) o de service_role.
--
-- Para method='qr' resuelve el proveedor real desde el intent QR referenciado
-- (payments.reference = mp_payment_intents.id o .mp_payment_id) y valida ESE
-- proveedor. Así un plan Start, aunque la UI muestre el botón, no puede
-- registrar un cobro MODO/Mobbex/MP por QR. Si no hay intent resoluble cae al
-- gate del method genérico 'qr' (sin gating) — el bloqueo real ya ocurrió en la
-- Edge Function al intentar crear el intent.
-- ---------------------------------------------------------------------------
create or replace function trg_payments_assert_method()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_provider text;
begin
  -- 1) Gate por el método coarse (efectivo/transferencia/…).
  perform assert_payment_method_allowed(new.method, new.tenant_id);

  -- 2) Gate fino para QR: proveedor real del intent referenciado.
  if new.method = 'qr' and new.reference is not null then
    select i.provider_key into v_provider
    from mp_payment_intents i
    where i.tenant_id = new.tenant_id
      and (i.id::text = new.reference or i.mp_payment_id = new.reference)
    order by i.created_at desc
    limit 1;
    if v_provider is not null then
      perform assert_payment_method_allowed(v_provider, new.tenant_id);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists payments_assert_method on payments;
create trigger payments_assert_method
  before insert on payments
  for each row execute function trg_payments_assert_method();

-- ---------------------------------------------------------------------------
-- Nota sobre create_sale: NO se reescribe su cuerpo (250+ líneas, riesgo de
-- drift). El trigger BEFORE INSERT en `payments` es la red de seguridad real y
-- cubre el camino RPC (create_sale es security invoker → new.tenant_id se llena
-- por el default de la fila = current_tenant_id()) y cualquier otro inserter
-- (incl. service_role). El assert vive en el trigger, no en la RPC, justamente
-- para que sea imposible saltearlo.
-- ---------------------------------------------------------------------------
