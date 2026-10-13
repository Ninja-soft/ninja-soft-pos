-- =============================================================================
-- 20261111100000_pausar_venta  (ADR-106)
--
-- "Pausar venta": el cajero guarda la venta en curso (carrito, cliente,
-- descuentos, cupón, notas, vendedor, propina, garantía y los pagos ya
-- confirmados o en curso), deja el POS limpio para el siguiente cliente y la
-- retoma después con un toque. Pedido literal del dueño: "si estoy cobrando y
-- el cliente quiere interrumpir el cobro (se le apagó el celular) pueda seguir
-- cobrando a otro y luego retomar esa transacción fácil".
--
--   paused_sales          la venta pausada, por negocio, sucursal, caja y
--                         turno. Estado: paused → resumed → completed |
--                         discarded (resumed → paused al volver a pausar).
--   paused_sale_payments  pagos de la venta pausada: líneas ya confirmadas en
--                         la hoja de cobro (efectivo, tarjeta con cupón, QR
--                         aprobado, transferencia) e intents de QR o link
--                         todavía vivos. `credited` = la plata ya entró por un
--                         proveedor (no se puede descartar sin devolverla).
--
-- Nada es venta hasta confirmar: create_sale corre recién al retomar y cobrar.
-- Los pagos acreditados quedan asociados a la venta pausada y no se duplican:
--   * un intent sólo puede estar en UNA venta pausada viva (índice único) y
--     nunca en un cobro en espera (ADR-048);
--   * el trigger AFTER UPDATE en mp_payment_intents (webhooks y sondeos de
--     todos los proveedores) concilia el estado del intent contra la venta
--     pausada; si create_sale ancla el intent a una venta, la pausada queda
--     completada; un pago tardío sobre una pausada descartada queda para
--     revisión (needs_review).
--
-- Escritura SÓLO por RPC SECURITY DEFINER (sin policies de escritura):
--   pause_sale, resume_paused_sale, complete_paused_sale,
--   discard_paused_sale, rename_paused_sale, log_pos_cleared_sale.
-- Todas escriben audit_logs (pausar, retomar, completar, descartar, limpiar
-- con pagos). tenant_id explícito en cada insert.
--
-- Visibilidad (RLS, siempre con "(select ...)", nunca "OR is_internal()"):
-- negocio activo, sucursal permitida y (quien la pausó, quien la retomó, el
-- dueño del turno al que pertenece, o dueño / encargado).
--
-- Cierre de caja: no se recrea close_cash_shift. Un trigger sobre cash_shifts
-- pasa las pausadas del turno que cierra a la próxima apertura de su caja
-- (carry_over) y otro las engancha al abrir: nunca quedan huérfanas. El POS
-- avisa antes de cerrar y ofrece descartar las que no tienen pagos.
--
-- Feature: BASE (parte de `pos`, sin key nueva). Gating server-side con
-- tenant_has_feature('pos').
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tablas
-- -----------------------------------------------------------------------------
create table if not exists paused_sales (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  store_id         uuid not null references stores(id),
  register_id      uuid references cash_registers(id) on delete set null,
  -- Turno al que pertenece hoy (null = pasa a la próxima apertura de su caja).
  cash_shift_id    uuid references cash_shifts(id) on delete set null,
  -- Turno en el que se pausó por primera vez (histórico).
  origin_shift_id  uuid references cash_shifts(id) on delete set null,
  created_by       uuid references public.users(id) on delete set null,
  updated_by       uuid references public.users(id) on delete set null,
  customer_id      uuid references customers(id) on delete set null,
  customer_name    text check (customer_name is null or char_length(customer_name) <= 160),
  -- Nombre editable ("Señora de rojo").
  label            text check (label is null or char_length(label) <= 60),
  -- Carrito del POS tal cual (líneas, descuento, cupón, garantía ofrecida, notas).
  cart             jsonb not null default '{}'::jsonb check (jsonb_typeof(cart) = 'object'),
  -- Estado de la hoja de cobro (propina, garantía, vendedor, líneas de pago).
  checkout         jsonb not null default '{}'::jsonb check (jsonb_typeof(checkout) = 'object'),
  -- Argumentos de create_sale (mismo mapeo que la venta inmediata): para el
  -- ensayo al retomar (stock, precios, cupón, topes).
  sale_args        jsonb not null default '{}'::jsonb check (jsonb_typeof(sale_args) = 'object'),
  item_count       numeric(12,3) not null default 0 check (item_count >= 0),
  total            numeric(12,2) not null default 0 check (total >= 0),
  paid_amount      numeric(12,2) not null default 0 check (paid_amount >= 0),
  status           text not null default 'paused'
                     check (status in ('paused', 'resumed', 'completed', 'discarded')),
  carry_over       boolean not null default false,
  needs_review     boolean not null default false,
  source           text not null default 'online' check (source in ('online', 'offline')),
  paused_at        timestamptz not null default now(),
  resumed_at       timestamptz,
  resumed_by       uuid references public.users(id) on delete set null,
  completed_at     timestamptz,
  sale_id          uuid references sales(id) on delete set null,
  discarded_at     timestamptz,
  discarded_by     uuid references public.users(id) on delete set null,
  discard_reason   text check (discard_reason is null or char_length(discard_reason) <= 300),
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

-- Lista del POS: negocio + sucursal + estado, las más nuevas primero.
create index if not exists paused_sales_tenant_store_status_idx
  on paused_sales (tenant_id, store_id, status, paused_at desc);
create index if not exists paused_sales_tenant_created_idx on paused_sales (tenant_id, created_at desc);
create index if not exists paused_sales_store_idx on paused_sales (store_id);
create index if not exists paused_sales_shift_idx
  on paused_sales (cash_shift_id) where status in ('paused', 'resumed');
create index if not exists paused_sales_cash_shift_fk_idx on paused_sales (cash_shift_id);
create index if not exists paused_sales_carry_idx
  on paused_sales (register_id, store_id) where carry_over and status = 'paused';
create index if not exists paused_sales_register_idx on paused_sales (register_id);
create index if not exists paused_sales_origin_shift_idx on paused_sales (origin_shift_id);
create index if not exists paused_sales_created_by_idx on paused_sales (created_by);
create index if not exists paused_sales_updated_by_idx on paused_sales (updated_by);
create index if not exists paused_sales_customer_idx on paused_sales (customer_id);
create index if not exists paused_sales_resumed_by_idx on paused_sales (resumed_by);
create index if not exists paused_sales_sale_idx on paused_sales (sale_id);
create index if not exists paused_sales_discarded_by_idx on paused_sales (discarded_by);

drop trigger if exists set_updated_at_paused_sales on paused_sales;
create trigger set_updated_at_paused_sales
  before update on paused_sales
  for each row execute function set_updated_at();

create table if not exists paused_sale_payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  paused_sale_id  uuid not null references paused_sales(id) on delete cascade,
  position        integer not null default 0,
  -- line = pago ya registrado en la hoja; intent = QR o link todavía vivo.
  kind            text not null check (kind in ('line', 'intent')),
  method          text not null check (method ~ '^[a-z][a-z0-9_]{1,39}$'),
  amount          numeric(12,2) not null check (amount > 0),
  reference       text check (reference is null or char_length(reference) <= 500),
  card_voucher    jsonb check (card_voucher is null or jsonb_typeof(card_voucher) = 'object'),
  intent_id       uuid references mp_payment_intents(id),
  provider_key    text check (provider_key is null or char_length(provider_key) <= 40),
  channel         text check (channel is null or channel in ('qr', 'link')),
  -- Línea completa de la hoja (título, logo, recargos) para restaurarla igual.
  line            jsonb not null default '{}'::jsonb check (jsonb_typeof(line) = 'object'),
  status          text not null default 'confirmed'
                    check (status in ('confirmed', 'pending', 'approved', 'rejected', 'cancelled', 'expired', 'used')),
  credited        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Un intent vive en UNA sola venta pausada.
create unique index if not exists paused_sale_payments_intent_uidx
  on paused_sale_payments (intent_id) where intent_id is not null;
create index if not exists paused_sale_payments_sale_idx
  on paused_sale_payments (paused_sale_id, position);
create index if not exists paused_sale_payments_tenant_idx
  on paused_sale_payments (tenant_id, created_at desc);

drop trigger if exists set_updated_at_paused_sale_payments on paused_sale_payments;
create trigger set_updated_at_paused_sale_payments
  before update on paused_sale_payments
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- B) RLS (sólo lectura; escritura por RPC)
-- -----------------------------------------------------------------------------
alter table paused_sales enable row level security;
alter table paused_sale_payments enable row level security;

drop policy if exists paused_sales_select on paused_sales;
create policy paused_sales_select on paused_sales
  for select using (
    tenant_id = (select current_tenant_id())
    and deleted_at is null
    and store_id = any ((select user_allowed_store_ids())::uuid[])
    and (
      created_by = (select auth.uid())
      or resumed_by = (select auth.uid())
      or (select is_tenant_manager())
      or exists (
        select 1 from cash_shifts cs
         where cs.id = paused_sales.cash_shift_id
           and cs.opened_by = (select auth.uid())
      )
    )
  );

drop policy if exists paused_sale_payments_select on paused_sale_payments;
create policy paused_sale_payments_select on paused_sale_payments
  for select using (
    tenant_id = (select current_tenant_id())
    and exists (select 1 from paused_sales ps where ps.id = paused_sale_payments.paused_sale_id)
  );

revoke insert, update, delete on paused_sales from anon, authenticated;
revoke insert, update, delete on paused_sale_payments from anon, authenticated;
revoke all on paused_sales from anon;
revoke all on paused_sale_payments from anon;
grant select on paused_sales to authenticated;
grant select on paused_sale_payments to authenticated;

-- Solo lectura no escribe nunca (ni a través de las RPC).
drop trigger if exists role_write_guard on paused_sales;
create trigger role_write_guard before insert or update or delete on paused_sales
  for each row execute function trg_role_write_guard('operate');
drop trigger if exists role_write_guard on paused_sale_payments;
create trigger role_write_guard before insert or update or delete on paused_sale_payments
  for each row execute function trg_role_write_guard('operate');

comment on table paused_sales is
  'ADR-106: venta pausada en el POS (carrito, hoja de cobro y pagos). No es una venta hasta retomarla y confirmarla. Escritura sólo por RPC.';
comment on table paused_sale_payments is
  'ADR-106: pagos de una venta pausada (líneas confirmadas e intents de QR / link vivos). credited = la plata ya entró por un proveedor.';

-- -----------------------------------------------------------------------------
-- C) Helpers internos
-- -----------------------------------------------------------------------------

-- ¿La plata de este pago ya entró por un proveedor? Espejo de
-- modules/paused-sales/logic.ts (isCreditedPayment). Efectivo, cuenta
-- corriente y saldo a favor no: el efectivo está en el cajón (se devuelve a
-- mano) y los otros dos recién se cargan al confirmar la venta.
create or replace function paused_payment_credited(p_kind text, p_method text, p_status text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_kind = 'intent' then p_status in ('approved', 'used')
    else p_method not in ('cash', 'account', 'store_credit')
  end;
$$;
grant execute on function paused_payment_credited(text, text, text) to authenticated, service_role;

-- ¿El usuario del JWT puede ver y operar esta venta pausada? (mismo criterio
-- que la policy de lectura, con el rol efectivo en la sucursal).
create or replace function _paused_sale_visible(p_row paused_sales)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_row.id is null or p_row.deleted_at is not null then return false; end if;
  if p_row.tenant_id is distinct from current_tenant_id() then return false; end if;
  if not user_can_access_store(p_row.store_id) then return false; end if;
  if p_row.created_by = auth.uid() or p_row.resumed_by = auth.uid() then return true; end if;
  if coalesce(user_store_role(p_row.store_id), '') in ('owner', 'manager') then return true; end if;
  return exists (
    select 1 from cash_shifts cs
     where cs.id = p_row.cash_shift_id and cs.tenant_id = p_row.tenant_id and cs.opened_by = auth.uid()
  );
end;
$$;
revoke all on function _paused_sale_visible(paused_sales) from public, anon, authenticated;

-- Carga una venta pausada con lock y valida acceso y versión.
create or replace function _paused_sale_lock(p_id uuid, p_version integer)
returns paused_sales
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row paused_sales%rowtype;
begin
  select * into v_row from paused_sales
   where id = p_id and tenant_id = current_tenant_id() and deleted_at is null
   for update;
  if not found or not _paused_sale_visible(v_row) then
    raise exception 'paused_sale_not_found';
  end if;
  if p_version is not null and p_version <> v_row.version then
    raise exception 'version_conflict';
  end if;
  return v_row;
end;
$$;
revoke all on function _paused_sale_lock(uuid, integer) from public, anon, authenticated;

-- Valida un turno para pausar o retomar: del negocio, abierto, de la sucursal
-- de la venta y propio (ADR-051; con caja compartida, de la sucursal).
create or replace function _paused_sale_shift(p_shift_id uuid, p_store_id uuid)
returns cash_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift cash_shifts%rowtype;
begin
  select * into v_shift from cash_shifts
   where id = p_shift_id and tenant_id = current_tenant_id();
  if not found then raise exception 'shift_not_found'; end if;
  if v_shift.status <> 'open' then raise exception 'shift_not_open'; end if;
  if v_shift.store_id is distinct from p_store_id then raise exception 'paused_sale_other_store'; end if;
  if not shift_owner_ok(v_shift.id, 'sell') then
    raise exception 'shift_not_owned' using errcode = '42501';
  end if;
  return v_shift;
end;
$$;
revoke all on function _paused_sale_shift(uuid, uuid) from public, anon, authenticated;

-- Trae el estado vigente de los intents de la venta pausada (lo escriben las
-- Edges de cada proveedor y sus webhooks). Devuelve si alguno ya es venta.
create or replace function _paused_sale_refresh_intents(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale uuid;
begin
  update paused_sale_payments psp
     set status = case
                    when i.sale_id is not null then 'used'
                    when i.status = 'approved' then 'approved'
                    else i.status
                  end,
         credited = paused_payment_credited(psp.kind, psp.method,
                      case when i.sale_id is not null then 'used' else i.status end),
         amount = case when i.status = 'approved' and i.amount > 0 then i.amount else psp.amount end
    from mp_payment_intents i
   where psp.paused_sale_id = p_id
     and psp.intent_id = i.id
     and psp.kind = 'intent'
     and psp.status not in ('used', 'cancelled');

  select i.sale_id into v_sale
    from paused_sale_payments psp
    join mp_payment_intents i on i.id = psp.intent_id
   where psp.paused_sale_id = p_id and i.sale_id is not null
   limit 1;
  return v_sale;
end;
$$;
revoke all on function _paused_sale_refresh_intents(uuid) from public, anon, authenticated;

-- Cancela localmente los intents pendientes de la venta pausada (create_sale
-- exige 'approved'; si igual se pagan, el trigger lo marca para revisión).
-- Devuelve [{intent_id, provider_key, channel}] para darlos de baja en el
-- proveedor desde el POS donde la API lo permite.
create or replace function _paused_sale_cancel_pending(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'intent_id', psp.intent_id, 'provider_key', psp.provider_key, 'channel', psp.channel)), '[]'::jsonb)
    into v_out
    from paused_sale_payments psp
   where psp.paused_sale_id = p_id and psp.kind = 'intent' and psp.status = 'pending';

  update mp_payment_intents i
     set status = 'cancelled', updated_at = now()
    from paused_sale_payments psp
   where psp.paused_sale_id = p_id and psp.kind = 'intent' and psp.status = 'pending'
     and i.id = psp.intent_id and i.status = 'pending';

  update paused_sale_payments
     set status = 'cancelled', credited = false
   where paused_sale_id = p_id and kind = 'intent' and status = 'pending';
  return v_out;
end;
$$;
revoke all on function _paused_sale_cancel_pending(uuid) from public, anon, authenticated;

-- Resumen de pagos para la auditoría.
create or replace function _paused_sale_payments_summary(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'count', count(*),
    'credited_amount', coalesce(sum(amount) filter (where credited), 0),
    'cash_amount', coalesce(sum(amount) filter (where kind = 'line' and method = 'cash'), 0),
    'pending_intents', count(*) filter (where kind = 'intent' and status = 'pending'),
    'methods', coalesce(jsonb_agg(distinct method), '[]'::jsonb)
  )
  from paused_sale_payments
  where paused_sale_id = p_id;
$$;
revoke all on function _paused_sale_payments_summary(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) RPC: pausar (crea o vuelve a pausar una retomada; idempotente por id)
-- -----------------------------------------------------------------------------
create or replace function pause_sale(
  p_id            uuid,
  p_store_id      uuid,
  p_register_id   uuid default null,
  p_cash_shift_id uuid default null,
  p_customer_id   uuid default null,
  p_customer_name text default null,
  p_label         text default null,
  p_cart          jsonb default '{}'::jsonb,
  p_checkout      jsonb default '{}'::jsonb,
  p_sale_args     jsonb default '{}'::jsonb,
  p_total         numeric default 0,
  p_item_count    numeric default 0,
  p_payments      jsonb default '[]'::jsonb,
  p_source        text default 'online',
  p_version       integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_user     uuid := auth.uid();
  v_row      paused_sales%rowtype;
  v_shift    cash_shifts%rowtype;
  v_exists   boolean := false;
  v_pay      jsonb;
  v_pos      bigint;
  v_kind     text;
  v_method   text;
  v_amount   numeric;
  v_intent   uuid;
  v_i        record;
  v_iprov    text;
  v_status   text;
  v_paid     numeric := 0;
  v_count    integer;
  v_action   text;
  v_ref      text;
begin
  if v_tenant is null or v_user is null then raise exception 'no_tenant'; end if;
  perform assert_account_active(v_tenant);
  perform assert_staff_operational();
  if not tenant_has_feature('pos') then raise exception 'feature_not_in_plan: pos'; end if;
  if p_id is null then raise exception 'invalid_id'; end if;
  if p_source not in ('online', 'offline') then raise exception 'invalid_source'; end if;
  if jsonb_typeof(coalesce(p_cart, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_checkout, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_sale_args, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_payments, '[]'::jsonb)) <> 'array' then
    raise exception 'invalid_payload';
  end if;
  if octet_length(coalesce(p_cart, '{}'::jsonb)::text)
     + octet_length(coalesce(p_checkout, '{}'::jsonb)::text)
     + octet_length(coalesce(p_sale_args, '{}'::jsonb)::text) > 400000 then
    raise exception 'paused_sale_too_large';
  end if;
  if jsonb_array_length(coalesce(p_payments, '[]'::jsonb)) > 20 then raise exception 'too_many_payments'; end if;
  if coalesce(p_total, 0) < 0 or coalesce(p_item_count, 0) < 0 then raise exception 'invalid_total'; end if;

  -- Sucursal y caja del negocio, sucursal permitida.
  if not exists (select 1 from stores s where s.id = p_store_id and s.tenant_id = v_tenant and s.deleted_at is null) then
    raise exception 'store_not_found';
  end if;
  if not user_can_access_store(p_store_id) then raise exception 'store_not_allowed'; end if;
  if p_register_id is not null and not exists (
    select 1 from cash_registers r where r.id = p_register_id and r.tenant_id = v_tenant and r.store_id = p_store_id
  ) then
    raise exception 'register_not_found';
  end if;
  -- Turno: opcional (se puede pausar un carrito sin caja abierta); si viene,
  -- abierto, de la sucursal y propio.
  if p_cash_shift_id is not null then
    v_shift := _paused_sale_shift(p_cash_shift_id, p_store_id);
  end if;
  if p_customer_id is not null and not exists (
    select 1 from customers c where c.id = p_customer_id and c.tenant_id = v_tenant
  ) then
    raise exception 'customer_not_found';
  end if;

  select * into v_row from paused_sales where id = p_id for update;
  if found then
    v_exists := true;
    if v_row.tenant_id <> v_tenant or not _paused_sale_visible(v_row) then
      raise exception 'paused_sale_not_found';
    end if;
    if v_row.status not in ('paused', 'resumed') then raise exception 'paused_sale_closed'; end if;
    if p_version is not null and p_version <> v_row.version then raise exception 'version_conflict'; end if;
    if v_row.store_id <> p_store_id then raise exception 'paused_sale_other_store'; end if;
  else
    select count(*) into v_count
      from paused_sales
     where tenant_id = v_tenant and store_id = p_store_id and status in ('paused', 'resumed')
       and deleted_at is null;
    if v_count >= 50 then raise exception 'too_many_paused_sales'; end if;
  end if;

  if v_exists then
    update paused_sales
       set register_id   = coalesce(p_register_id, register_id),
           cash_shift_id = coalesce(v_shift.id, cash_shift_id),
           updated_by    = v_user,
           customer_id   = p_customer_id,
           customer_name = nullif(btrim(coalesce(p_customer_name, '')), ''),
           label         = coalesce(nullif(btrim(coalesce(p_label, '')), ''), label),
           cart          = coalesce(p_cart, '{}'::jsonb),
           checkout      = coalesce(p_checkout, '{}'::jsonb),
           sale_args     = coalesce(p_sale_args, '{}'::jsonb),
           item_count    = coalesce(p_item_count, 0),
           total         = round(coalesce(p_total, 0), 2),
           status        = 'paused',
           carry_over    = false,
           paused_at     = now(),
           version       = version + 1
     where id = p_id;
    delete from paused_sale_payments where paused_sale_id = p_id;
    v_action := 'paused_sale_repaused';
  else
    insert into paused_sales (
      id, tenant_id, store_id, register_id, cash_shift_id, origin_shift_id, created_by, updated_by,
      customer_id, customer_name, label, cart, checkout, sale_args, item_count, total, source
    ) values (
      p_id, v_tenant, p_store_id, p_register_id, v_shift.id, v_shift.id, v_user, v_user,
      p_customer_id, nullif(btrim(coalesce(p_customer_name, '')), ''),
      nullif(btrim(coalesce(p_label, '')), ''),
      coalesce(p_cart, '{}'::jsonb), coalesce(p_checkout, '{}'::jsonb), coalesce(p_sale_args, '{}'::jsonb),
      coalesce(p_item_count, 0), round(coalesce(p_total, 0), 2), p_source
    );
    v_action := 'paused_sale_paused';
  end if;

  -- Pagos: líneas confirmadas e intents vivos. tenant_id explícito.
  for v_pay, v_pos in
    select e.value, e.ordinality from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) with ordinality e
  loop
    v_kind := coalesce(v_pay ->> 'kind', 'line');
    v_method := v_pay ->> 'method';
    v_amount := round(coalesce((v_pay ->> 'amount')::numeric, 0), 2);
    v_ref := nullif(btrim(coalesce(v_pay ->> 'reference', '')), '');
    if v_kind not in ('line', 'intent') then raise exception 'invalid_payment'; end if;
    if v_method is null or v_method !~ '^[a-z][a-z0-9_]{1,39}$' or v_amount <= 0 then
      raise exception 'invalid_payment';
    end if;
    v_intent := null;
    v_iprov := null;
    v_status := case when v_kind = 'line' then 'confirmed' else 'pending' end;
    if v_kind = 'intent' then
      if coalesce(v_pay ->> 'intent_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'invalid_payment';
      end if;
      v_intent := (v_pay ->> 'intent_id')::uuid;
    elsif v_method = 'qr' and v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      -- QR ya aprobado en la hoja: el intent queda atado a esta venta pausada.
      v_intent := v_ref::uuid;
    end if;

    if v_intent is not null then
      select id, status, sale_id, amount, provider_key into v_i
        from mp_payment_intents
       where id = v_intent and tenant_id = v_tenant
       for update;
      if not found then raise exception 'intent_not_found'; end if;
      v_iprov := v_i.provider_key;
      if v_i.sale_id is not null then raise exception 'intent_already_used'; end if;
      if exists (
        select 1 from pending_charges pc
         where pc.intent_id = v_intent or v_intent = any (pc.previous_intent_ids)
      ) then
        raise exception 'intent_already_parked';
      end if;
      if exists (
        select 1 from paused_sale_payments x
         where x.intent_id = v_intent and x.paused_sale_id <> p_id
      ) then
        raise exception 'intent_in_other_paused_sale';
      end if;
      if v_kind = 'line' and v_i.status <> 'approved' then raise exception 'qr_not_approved'; end if;
      if v_kind = 'intent' then
        if v_i.status not in ('pending', 'approved') then raise exception 'intent_not_pending'; end if;
        v_status := v_i.status;
        if v_i.status = 'approved' and v_i.amount > 0 then v_amount := v_i.amount; end if;
      end if;
    end if;

    insert into paused_sale_payments (
      tenant_id, paused_sale_id, position, kind, method, amount, reference, card_voucher,
      intent_id, provider_key, channel, line, status, credited
    ) values (
      v_tenant, p_id, v_pos::integer, v_kind, v_method, v_amount, v_ref,
      case when jsonb_typeof(v_pay -> 'card_voucher') = 'object' then v_pay -> 'card_voucher' end,
      v_intent,
      coalesce(nullif(v_pay ->> 'provider_key', ''), v_iprov),
      case when v_pay ->> 'channel' in ('qr', 'link') then v_pay ->> 'channel' end,
      case when jsonb_typeof(v_pay -> 'line') = 'object' then v_pay -> 'line' else '{}'::jsonb end,
      v_status,
      paused_payment_credited(v_kind, v_method, v_status)
    );
    if v_kind = 'line' or v_status = 'approved' then v_paid := v_paid + v_amount; end if;
  end loop;

  update paused_sales set paid_amount = round(v_paid, 2) where id = p_id
  returning * into v_row;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, v_user, 'paused_sales', p_id, v_action,
          jsonb_build_object('total', v_row.total, 'paid_amount', v_row.paid_amount,
                             'item_count', v_row.item_count, 'label', v_row.label,
                             'customer_id', v_row.customer_id, 'register_id', v_row.register_id,
                             'shift_id', v_row.cash_shift_id, 'source', p_source,
                             'payments', _paused_sale_payments_summary(p_id)),
          p_store_id);

  return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'status', v_row.status,
                            'paid_amount', v_row.paid_amount, 'label', v_row.label);
end;
$$;
revoke all on function pause_sale(uuid, uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, numeric, numeric, jsonb, text, integer) from public, anon;
grant execute on function pause_sale(uuid, uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, numeric, numeric, jsonb, text, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- E) RPC: retomar. Concilia los intents, cancela los pendientes si se pide,
--    ensaya create_sale con el turno actual y marca la venta como retomada.
-- -----------------------------------------------------------------------------
create or replace function resume_paused_sale(
  p_id             uuid,
  p_cash_shift_id  uuid default null,
  p_cancel_pending boolean default false,
  p_version        integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row       paused_sales%rowtype;
  v_shift     cash_shifts%rowtype;
  v_sale      uuid;
  v_cancelled jsonb := '[]'::jsonb;
  v_dry       jsonb;
  v_dry_err   text;
  v_role      text;
begin
  perform assert_staff_operational();
  v_row := _paused_sale_lock(p_id, p_version);
  if v_row.status in ('completed', 'discarded') then raise exception 'paused_sale_closed'; end if;
  if v_row.status = 'resumed' and v_row.resumed_by is distinct from auth.uid() then
    -- Otra persona la tiene abierta: sólo dueño o encargado la toman.
    v_role := user_store_role(v_row.store_id);
    if coalesce(v_role, '') not in ('owner', 'manager') then raise exception 'paused_sale_in_use'; end if;
  end if;
  if p_cash_shift_id is not null then
    v_shift := _paused_sale_shift(p_cash_shift_id, v_row.store_id);
  end if;

  -- Si un intent ya terminó en venta (el POS que la retomó la cobró y se
  -- cortó antes de avisar), la pausada queda completada.
  v_sale := _paused_sale_refresh_intents(p_id);
  if v_sale is not null then
    update paused_sales
       set status = 'completed', completed_at = now(), sale_id = v_sale, version = version + 1
     where id = p_id
    returning * into v_row;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_row.tenant_id, auth.uid(), 'paused_sales', p_id, 'paused_sale_completed',
            jsonb_build_object('sale_id', v_sale, 'via', 'intent'), v_row.store_id);
    return jsonb_build_object('status', 'completed', 'sale_id', v_sale, 'id', p_id);
  end if;

  if exists (
    select 1 from paused_sale_payments
     where paused_sale_id = p_id and kind = 'intent' and status = 'pending'
  ) then
    if not coalesce(p_cancel_pending, false) then raise exception 'paused_sale_intent_pending'; end if;
    v_cancelled := _paused_sale_cancel_pending(p_id);
  end if;

  -- Ensayo con el criterio del servidor (stock, precio de lista, cupón,
  -- topes de descuento): create_sale en seco, revertido. Sin turno, no.
  if v_shift.id is not null and jsonb_array_length(coalesce(v_row.sale_args -> 'items', '[]'::jsonb)) > 0 then
    begin
      v_dry := _pc_dry_run(v_row.sale_args, v_shift.id);
    exception when others then
      v_dry_err := sqlerrm;
    end;
  end if;

  update paused_sales
     set status = 'resumed', resumed_at = now(), resumed_by = auth.uid(),
         cash_shift_id = coalesce(v_shift.id, cash_shift_id), carry_over = false,
         updated_by = auth.uid(),
         paid_amount = round(coalesce((
           select sum(amount) from paused_sale_payments
            where paused_sale_id = p_id and (kind = 'line' or status = 'approved')), 0), 2),
         version = version + 1
   where id = p_id
  returning * into v_row;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_row.tenant_id, auth.uid(), 'paused_sales', p_id, 'paused_sale_resumed',
          jsonb_build_object('total', v_row.total, 'paid_amount', v_row.paid_amount,
                             'shift_id', v_row.cash_shift_id,
                             'server_total', v_dry -> 'total', 'check_error', v_dry_err,
                             'cancelled_intents', v_cancelled,
                             'payments', _paused_sale_payments_summary(p_id)),
          v_row.store_id);

  return jsonb_build_object(
    'status', 'resumed',
    'id', v_row.id,
    'version', v_row.version,
    'sale', to_jsonb(v_row),
    'payments', coalesce((
      select jsonb_agg(to_jsonb(psp) order by psp.position)
        from paused_sale_payments psp where psp.paused_sale_id = p_id), '[]'::jsonb),
    'check', case
      when v_dry_err is not null then jsonb_build_object('ok', false, 'error', v_dry_err)
      when v_dry is not null then jsonb_build_object('ok', true, 'total', v_dry -> 'total', 'tip', v_dry -> 'tip')
      else null
    end,
    'cancelled_intents', v_cancelled
  );
end;
$$;
revoke all on function resume_paused_sale(uuid, uuid, boolean, integer) from public, anon;
grant execute on function resume_paused_sale(uuid, uuid, boolean, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- F) RPC: completar (el POS la cobró: create_sale devolvió la venta)
-- -----------------------------------------------------------------------------
create or replace function complete_paused_sale(p_id uuid, p_sale_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row paused_sales%rowtype;
begin
  v_row := _paused_sale_lock(p_id, null);
  if v_row.status = 'completed' then
    return jsonb_build_object('id', p_id, 'status', 'completed', 'sale_id', v_row.sale_id);
  end if;
  if v_row.status = 'discarded' then raise exception 'paused_sale_closed'; end if;
  if p_sale_id is not null and not exists (
    select 1 from sales s where s.id = p_sale_id and s.tenant_id = v_row.tenant_id
  ) then
    raise exception 'sale_not_found';
  end if;

  update paused_sale_payments set status = 'used'
   where paused_sale_id = p_id and status in ('confirmed', 'approved');
  update paused_sales
     set status = 'completed', completed_at = now(), sale_id = p_sale_id,
         updated_by = auth.uid(), version = version + 1
   where id = p_id
  returning * into v_row;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_row.tenant_id, auth.uid(), 'paused_sales', p_id, 'paused_sale_completed',
          jsonb_build_object('sale_id', p_sale_id, 'total', v_row.total, 'via', 'pos'), v_row.store_id);
  return jsonb_build_object('id', p_id, 'status', 'completed', 'sale_id', p_sale_id);
end;
$$;
revoke all on function complete_paused_sale(uuid, uuid) from public, anon;
grant execute on function complete_paused_sale(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- G) RPC: descartar. Con pagos acreditados no se descarta sin devolverlos:
--    sólo dueño o encargado, con motivo y "ya lo devolví" (p_refund_confirmed).
-- -----------------------------------------------------------------------------
create or replace function discard_paused_sale(
  p_id               uuid,
  p_reason           text default null,
  p_refund_confirmed boolean default false,
  p_version          integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row       paused_sales%rowtype;
  v_credited  numeric;
  v_cancelled jsonb := '[]'::jsonb;
  v_sale      uuid;
  v_role      text;
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  v_row := _paused_sale_lock(p_id, p_version);
  if v_row.status = 'discarded' then
    return jsonb_build_object('id', p_id, 'status', 'discarded', 'cancelled_intents', '[]'::jsonb);
  end if;
  if v_row.status = 'completed' then raise exception 'paused_sale_closed'; end if;
  if v_reason is not null and char_length(v_reason) > 300 then raise exception 'reason_too_long'; end if;

  v_sale := _paused_sale_refresh_intents(p_id);
  if v_sale is not null then raise exception 'paused_sale_already_charged'; end if;

  select coalesce(sum(amount), 0) into v_credited
    from paused_sale_payments where paused_sale_id = p_id and credited;
  if v_credited > 0 then
    if not coalesce(p_refund_confirmed, false) then
      raise exception 'paused_sale_has_payments';
    end if;
    v_role := user_store_role(v_row.store_id);
    if coalesce(v_role, '') not in ('owner', 'manager') then
      raise exception 'refund_requires_manager' using errcode = '42501';
    end if;
    if v_reason is null then raise exception 'reason_required'; end if;
  end if;

  v_cancelled := _paused_sale_cancel_pending(p_id);

  update paused_sales
     set status = 'discarded', discarded_at = now(), discarded_by = auth.uid(),
         discard_reason = v_reason, updated_by = auth.uid(), version = version + 1
   where id = p_id
  returning * into v_row;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason, store_id)
  values (v_row.tenant_id, auth.uid(), 'paused_sales', p_id, 'paused_sale_discarded',
          jsonb_build_object('total', v_row.total, 'paid_amount', v_row.paid_amount, 'label', v_row.label),
          jsonb_build_object('credited_amount', v_credited, 'refund_confirmed', coalesce(p_refund_confirmed, false),
                             'cancelled_intents', v_cancelled,
                             'payments', _paused_sale_payments_summary(p_id)),
          v_reason, v_row.store_id);

  return jsonb_build_object('id', p_id, 'status', 'discarded', 'cancelled_intents', v_cancelled);
end;
$$;
revoke all on function discard_paused_sale(uuid, text, boolean, integer) from public, anon;
grant execute on function discard_paused_sale(uuid, text, boolean, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC: nombre editable ("Señora de rojo")
-- -----------------------------------------------------------------------------
create or replace function rename_paused_sale(p_id uuid, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row   paused_sales%rowtype;
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
begin
  v_row := _paused_sale_lock(p_id, null);
  if v_row.status not in ('paused', 'resumed') then raise exception 'paused_sale_closed'; end if;
  if v_label is not null and char_length(v_label) > 60 then raise exception 'label_too_long'; end if;
  update paused_sales
     set label = v_label, updated_by = auth.uid(), version = version + 1
   where id = p_id
  returning * into v_row;
  return jsonb_build_object('id', p_id, 'label', v_row.label, 'version', v_row.version);
end;
$$;
revoke all on function rename_paused_sale(uuid, text) from public, anon;
grant execute on function rename_paused_sale(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- I) RPC: "Limpiar" con pagos en curso. El POS sólo la llama si la venta que
--    se limpia tenía pagos (efectivo recibido o un QR pendiente): queda el
--    rastro en audit_logs. Los pagos acreditados no se pueden limpiar (el POS
--    ofrece pausar) y el servidor lo vuelve a exigir acá.
-- -----------------------------------------------------------------------------
create or replace function log_pos_cleared_sale(
  p_store_id      uuid,
  p_cash_shift_id uuid default null,
  p_total         numeric default 0,
  p_payments      jsonb default '[]'::jsonb,
  p_item_count    numeric default 0
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or auth.uid() is null then raise exception 'no_tenant'; end if;
  if member_role_in(v_tenant) is null or member_role_in(v_tenant) = 'viewer' then
    raise exception 'forbidden_read_only' using errcode = '42501';
  end if;
  if not user_can_access_store(p_store_id) then raise exception 'store_not_allowed'; end if;
  if jsonb_typeof(coalesce(p_payments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_payments, '[]'::jsonb)) = 0
     or jsonb_array_length(p_payments) > 20 then
    raise exception 'invalid_payload';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_payments) e
     where paused_payment_credited(coalesce(e.value ->> 'kind', 'line'), coalesce(e.value ->> 'method', ''),
                                   coalesce(e.value ->> 'status', 'confirmed'))
  ) then
    raise exception 'sale_has_credited_payments';
  end if;
  if p_cash_shift_id is not null and not exists (
    select 1 from cash_shifts cs where cs.id = p_cash_shift_id and cs.tenant_id = v_tenant and cs.store_id = p_store_id
  ) then
    raise exception 'shift_not_found';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_tenant, auth.uid(), 'pos_sale', null, 'pos_sale_cleared_with_payments',
          jsonb_build_object('total', round(coalesce(p_total, 0), 2), 'item_count', coalesce(p_item_count, 0),
                             'shift_id', p_cash_shift_id,
                             'payments', (select jsonb_agg(jsonb_build_object(
                                            'kind', e.value ->> 'kind', 'method', e.value ->> 'method',
                                            'amount', e.value -> 'amount', 'status', e.value ->> 'status'))
                                            from jsonb_array_elements(p_payments) e)),
          p_store_id);
end;
$$;
revoke all on function log_pos_cleared_sale(uuid, uuid, numeric, jsonb, numeric) from public, anon;
grant execute on function log_pos_cleared_sale(uuid, uuid, numeric, jsonb, numeric) to authenticated;

-- -----------------------------------------------------------------------------
-- J) Trigger: el intent cambió (webhook, sondeo o create_sale lo anclo a una
--    venta). Nunca hace fallar la actualización del intent.
-- -----------------------------------------------------------------------------
create or replace function paused_sales_on_intent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ps uuid;
  v_st text;
begin
  begin
    select psp.paused_sale_id into v_ps
      from paused_sale_payments psp where psp.intent_id = new.id;
    if v_ps is null then return null; end if;
    select status into v_st from paused_sales where id = v_ps;

    if new.sale_id is not null and old.sale_id is null then
      update paused_sale_payments set status = 'used', credited = true where intent_id = new.id;
      update paused_sales
         set status = 'completed', completed_at = now(), sale_id = new.sale_id, version = version + 1
       where id = v_ps and status in ('paused', 'resumed');
      return null;
    end if;

    if new.status is distinct from old.status then
      update paused_sale_payments
         set status = case when status = 'confirmed' then status else new.status end,
             credited = paused_payment_credited(kind, method,
                          case when status = 'confirmed' then status else new.status end),
             amount = case when kind = 'intent' and new.status = 'approved' and new.amount > 0
                           then new.amount else amount end
       where intent_id = new.id and status not in ('used');
      if new.status = 'approved' then
        update paused_sales
           set paid_amount = round(coalesce((
                 select sum(amount) from paused_sale_payments
                  where paused_sale_id = v_ps and (kind = 'line' or status = 'approved')), 0), 2),
               -- Pago tardío sobre una pausada descartada: la plata entró.
               needs_review = needs_review or v_st = 'discarded',
               version = version + 1
         where id = v_ps;
      end if;
    end if;
  exception when others then
    raise warning 'paused_sales_on_intent(%): %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function paused_sales_on_intent() from public, anon, authenticated;

drop trigger if exists paused_sales_on_intent on mp_payment_intents;
create trigger paused_sales_on_intent
  after update of status, sale_id on mp_payment_intents
  for each row
  when (old.status is distinct from new.status or old.sale_id is distinct from new.sale_id)
  execute function paused_sales_on_intent();

-- -----------------------------------------------------------------------------
-- K) Cierre y apertura de caja: las pausadas nunca quedan huérfanas.
-- -----------------------------------------------------------------------------
create or replace function paused_sales_on_shift_close()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    update paused_sales
       set cash_shift_id = null, carry_over = true, status = 'paused', version = version + 1
     where tenant_id = new.tenant_id and cash_shift_id = new.id and status in ('paused', 'resumed');
  exception when others then
    raise warning 'paused_sales_on_shift_close(%): %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function paused_sales_on_shift_close() from public, anon, authenticated;

drop trigger if exists paused_sales_on_shift_close on cash_shifts;
create trigger paused_sales_on_shift_close
  after update of status on cash_shifts
  for each row
  when (old.status = 'open' and new.status is distinct from 'open')
  execute function paused_sales_on_shift_close();

create or replace function paused_sales_on_shift_open()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if new.status = 'open' then
      update paused_sales
         set cash_shift_id = new.id, carry_over = false, version = version + 1
       where tenant_id = new.tenant_id and carry_over and status = 'paused' and deleted_at is null
         and (register_id = new.cash_register_id
              or (register_id is null and store_id = new.store_id));
    end if;
  exception when others then
    raise warning 'paused_sales_on_shift_open(%): %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function paused_sales_on_shift_open() from public, anon, authenticated;

drop trigger if exists paused_sales_on_shift_open on cash_shifts;
create trigger paused_sales_on_shift_open
  after insert on cash_shifts
  for each row execute function paused_sales_on_shift_open();
