-- =============================================================================
-- Tiendita — Compra de catálogos (pago ÚNICO por Mercado Pago de NinjaSoft).
--
-- A diferencia de la suscripción (preapproval recurrente), un catálogo se cobra
-- UNA sola vez: el cliente paga el price_ars y obtiene acceso permanente
-- (tenant_catalog_purchases.source = 'paid'). El cobro lo hace NinjaSoft con SU
-- cuenta de Mercado Pago (platform_secrets key 'mercadopago'), vía una
-- preference de Checkout Pro.
--
-- Esta migración define:
--   - catalog_payment_intents: un intent por intento de compra (idempotencia +
--     trazabilidad del webhook).
--   - finalize_catalog_purchase(intent, payment_id, price): RPC SECURITY DEFINER
--     que el webhook (service_role) invoca al aprobarse el pago. Inserta la
--     compra de forma idempotente y notifica al tenant. Devuelve si fue la
--     primera acreditación (para no notificar dos veces).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- catalog_payment_intents — intento de compra de un catálogo.
-- status: pending → approved | rejected | cancelled (lo mueve el webhook).
-- mp_preference_id: la preference creada en MP. mp_payment_id: el pago real.
-- -----------------------------------------------------------------------------
create table if not exists catalog_payment_intents (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  catalog_id       uuid not null references catalogs(id) on delete cascade,
  status           text not null default 'pending'
                     check (status in ('pending','approved','rejected','cancelled')),
  amount           numeric(12,2) not null check (amount >= 0),
  mp_preference_id text,
  mp_payment_id    text,
  init_point       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists catalog_payment_intents_tenant_idx
  on catalog_payment_intents(tenant_id);
create index if not exists catalog_payment_intents_catalog_idx
  on catalog_payment_intents(catalog_id);

drop trigger if exists trg_catalog_payment_intents_updated on catalog_payment_intents;
create trigger trg_catalog_payment_intents_updated before update on catalog_payment_intents
  for each row execute function set_updated_at();

-- RLS: el tenant ve/gestiona sus propios intents (para que el storefront pueda
-- leer el estado tras volver de MP); staff interno ve todo. El alta real la hace
-- el checkout server-side (service_role, saltea RLS); esta policy permite además
-- que el dueño cree el intent desde su sesión si hiciera falta.
alter table catalog_payment_intents enable row level security;

drop policy if exists catalog_payment_intents_read on catalog_payment_intents;
create policy catalog_payment_intents_read on catalog_payment_intents
  for select to authenticated
  using (tenant_id = current_tenant_id() or is_internal());

-- =============================================================================
-- Función: finalize_catalog_purchase(p_intent_id, p_payment_id, p_price)
-- La invoca el webhook (catalog_purchase_webhook) con service_role al confirmar
-- en MP que el pago está aprobado. Es idempotente: si la compra ya existía (o el
-- intent ya estaba aprobado), no vuelve a notificar.
--
-- Devuelve TRUE sólo en la PRIMERA acreditación (cuando se crea la compra), para
-- que el webhook sepa si debe disparar el aviso "ya tenés acceso".
--
-- SECURITY DEFINER + chequeo explícito: sólo service_role (sin JWT de usuario:
-- auth.uid() is null y no es internal) o staff interno pueden ejecutarla. Un
-- tenant cualquiera NO puede auto-acreditarse una compra llamando a este RPC.
-- =============================================================================
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
  v_existing uuid;
  v_first    boolean := false;
begin
  -- Autorización: service_role (el webhook corre sin sesión de usuario → no es
  -- internal y auth.uid() es null) o staff interno. Cualquier otro: prohibido.
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

  -- Marcar el intent como aprobado (idempotente) y guardar el payment id.
  update catalog_payment_intents
     set status = 'approved',
         mp_payment_id = coalesce(p_payment_id, mp_payment_id)
   where id = p_intent_id;

  -- ¿Ya tenía acceso (compra previa o grant)? Entonces no es la primera vez.
  select id into v_existing
    from tenant_catalog_purchases
   where tenant_id = v_intent.tenant_id
     and catalog_id = v_intent.catalog_id;

  if v_existing is null then
    insert into tenant_catalog_purchases (tenant_id, catalog_id, source, price_paid)
    values (v_intent.tenant_id, v_intent.catalog_id, 'paid',
            coalesce(p_price, v_intent.amount))
    on conflict (tenant_id, catalog_id) do nothing;
    -- ¿Se insertó realmente (no había compra)? Entonces es la primera vez.
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
  end if;

  return v_first;
end;
$function$;

-- Sólo service_role / definer. No se expone a authenticated ni anon: el flujo
-- legítimo es el webhook (service_role). El chequeo interno es la red de
-- seguridad por si alguien obtuviera execute.
revoke all on function public.finalize_catalog_purchase(uuid, text, numeric)
  from public, anon, authenticated;
