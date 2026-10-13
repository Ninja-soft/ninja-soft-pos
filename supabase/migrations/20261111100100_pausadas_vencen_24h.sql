-- =============================================================================
-- 20261111100100_pausadas_vencen_24h  (ADR-108 · sobre ADR-106)
--
-- Pedido del dueño: "que se borren a las 24 hs". Una venta pausada (o
-- retomada y abandonada) vence 24 h después de su último movimiento (pausar o
-- retomar). Baja lógica: status = 'expired' + expired_at; nunca DELETE.
--
--   * expires_at   lo mantiene un trigger BEFORE (último movimiento + 24 h).
--   * expired_at   cuándo venció.
--   * expiry_held_at  venció con pagos vivos: NO se vence (ver abajo) y queda
--                  marcada "requiere atención" una sola vez, con auditoría.
--
-- Pagos (decisión de ADR-108): una pausada con pagos vivos (línea confirmada
-- como efectivo en el cajón, tarjeta con cupón o transferencia; QR o link
-- pendiente o aprobado) NO vence en silencio: la plata ya está en el cajón o
-- en el proveedor y ADR-106 exige devolverla a mano (y, si está acreditada,
-- que lo confirme dueño o encargado con motivo). El job la deja viva, marca
-- expiry_held_at y escribe paused_sale_expiry_held; el POS la sigue mostrando
-- como "Venció: resolvela" hasta que la retomen o la descarten con las reglas
-- de siempre. Los intents muertos (rechazado, cancelado, vencido) no cuentan.
--
-- El criterio es del servidor aunque el cron no haya corrido:
--   * list_open_paused_sales (SECURITY INVOKER, con RLS) no devuelve las
--     vencidas sin pagos;
--   * resume_paused_sale rechaza las vencidas ('paused_sale_expired').
--
-- Job pg_cron 'paused-sales-expire' cada 15 min: expire_paused_sales(500).
-- Una fila de audit_logs por pausada (paused_sale_expired /
-- paused_sale_expiry_held), actor null (sistema).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Esquema
-- -----------------------------------------------------------------------------
alter table paused_sales add column if not exists expires_at timestamptz;
alter table paused_sales add column if not exists expired_at timestamptz;
alter table paused_sales add column if not exists expiry_held_at timestamptz;

alter table paused_sales drop constraint if exists paused_sales_status_check;
alter table paused_sales add constraint paused_sales_status_check
  check (status in ('paused', 'resumed', 'completed', 'discarded', 'expired'));

-- Vida de una venta pausada. Espejo de PAUSED_TTL_HOURS (modules/paused-sales/logic.ts).
create or replace function paused_sale_ttl()
returns interval
language sql
immutable
set search_path = public, pg_temp
as $$
  select interval '24 hours';
$$;
grant execute on function paused_sale_ttl() to authenticated, service_role;

-- Vencimiento = último movimiento (pausar o retomar) + 24 h. Volver a pausar o
-- retomar reinicia el reloj y la marca de "requiere atención".
create or replace function paused_sales_set_expiry()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or new.status in ('paused', 'resumed') then
    new.expires_at := greatest(new.paused_at, coalesce(new.resumed_at, new.paused_at)) + paused_sale_ttl();
    if tg_op = 'UPDATE' and new.expires_at > now() then
      new.expiry_held_at := null;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function paused_sales_set_expiry() from public, anon, authenticated;

drop trigger if exists paused_sales_set_expiry on paused_sales;
create trigger paused_sales_set_expiry
  before insert or update on paused_sales
  for each row execute function paused_sales_set_expiry();

-- Las que ya existen (sin auth.uid(): role_write_guard no aplica).
update paused_sales
   set expires_at = greatest(paused_at, coalesce(resumed_at, paused_at)) + interval '24 hours'
 where expires_at is null;
alter table paused_sales alter column expires_at set not null;

-- Lo que busca el job: abiertas por vencimiento.
create index if not exists paused_sales_expiry_idx
  on paused_sales (expires_at)
  where status in ('paused', 'resumed') and deleted_at is null;

comment on column paused_sales.expires_at is
  'ADR-108: último movimiento (pausar o retomar) + 24 h. Lo mantiene el trigger paused_sales_set_expiry.';
comment on column paused_sales.expiry_held_at is
  'ADR-108: venció con pagos vivos; no se vence en silencio y queda para resolver en el POS.';

-- -----------------------------------------------------------------------------
-- B) Helper: ¿tiene pagos vivos? (efectivo o tarjeta en la hoja, QR o link
--    pendiente o aprobado). Los intents rechazados, cancelados o vencidos no.
-- -----------------------------------------------------------------------------
create or replace function _paused_sale_has_live_payments(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from paused_sale_payments
     where paused_sale_id = p_id
       and status in ('confirmed', 'pending', 'approved', 'used')
  );
$$;
revoke all on function _paused_sale_has_live_payments(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- C) Lista del POS con el criterio del servidor (RLS del que llama). Devuelve
--    filas de paused_sales: PostgREST permite embeber paused_sale_payments.
-- -----------------------------------------------------------------------------
create or replace function list_open_paused_sales(p_store_id uuid)
returns setof paused_sales
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select ps.*
    from paused_sales ps
   where ps.tenant_id = (select current_tenant_id())
     and ps.store_id = p_store_id
     and ps.deleted_at is null
     and ps.status in ('paused', 'resumed')
     and (
       ps.expires_at > now()
       or exists (
         select 1 from paused_sale_payments psp
          where psp.paused_sale_id = ps.id
            and psp.status in ('confirmed', 'pending', 'approved', 'used')
       )
     )
   order by ps.paused_at desc
   limit 60;
$$;
revoke all on function list_open_paused_sales(uuid) from public, anon;
grant execute on function list_open_paused_sales(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- D) Job: vence las pausadas sin pagos, marca las que tienen pagos y completa
--    las que ya terminaron en venta por su intent. Idempotente, SKIP LOCKED.
-- -----------------------------------------------------------------------------
create or replace function expire_paused_sales(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r        paused_sales%rowtype;
  v_sale   uuid;
  v_exp    integer := 0;
  v_held   integer := 0;
  v_done   integer := 0;
begin
  for r in
    select * from paused_sales
     where status in ('paused', 'resumed') and deleted_at is null and expires_at <= now()
     order by expiry_held_at nulls first, expires_at
     limit greatest(1, least(coalesce(p_limit, 500), 5000))
     for update skip locked
  loop
    -- Si un intent ya es venta, la pausada se completa (como al retomar).
    v_sale := _paused_sale_refresh_intents(r.id);
    if v_sale is not null then
      update paused_sales
         set status = 'completed', completed_at = now(), sale_id = v_sale, version = version + 1
       where id = r.id;
      insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
      values (r.tenant_id, null, 'paused_sales', r.id, 'paused_sale_completed',
              jsonb_build_object('sale_id', v_sale, 'via', 'expiry_job'), r.store_id);
      v_done := v_done + 1;
      continue;
    end if;

    -- Con pagos vivos no se vence en silencio: queda para resolver.
    if _paused_sale_has_live_payments(r.id) then
      if r.expiry_held_at is null then
        update paused_sales set expiry_held_at = now() where id = r.id;
        insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
        values (r.tenant_id, null, 'paused_sales', r.id, 'paused_sale_expiry_held',
                jsonb_build_object('total', r.total, 'paid_amount', r.paid_amount, 'label', r.label,
                                   'expires_at', r.expires_at, 'status', r.status,
                                   'payments', _paused_sale_payments_summary(r.id)),
                r.store_id);
        v_held := v_held + 1;
      end if;
      continue;
    end if;

    update paused_sales
       set status = 'expired', expired_at = now(), carry_over = false, version = version + 1
     where id = r.id;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
    values (r.tenant_id, null, 'paused_sales', r.id, 'paused_sale_expired',
            jsonb_build_object('status', r.status, 'total', r.total, 'label', r.label,
                               'customer_id', r.customer_id, 'item_count', r.item_count,
                               'paused_at', r.paused_at, 'resumed_at', r.resumed_at),
            jsonb_build_object('expires_at', r.expires_at, 'via', 'expiry_job',
                               'payments', _paused_sale_payments_summary(r.id)),
            r.store_id);
    v_exp := v_exp + 1;
  end loop;

  return jsonb_build_object('expired', v_exp, 'held', v_held, 'completed', v_done);
end;
$$;
revoke all on function expire_paused_sales(integer) from public, anon, authenticated;
grant execute on function expire_paused_sales(integer) to service_role;

-- -----------------------------------------------------------------------------
-- E) resume_paused_sale: igual a ADR-106 más el rechazo de las vencidas.
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
  -- Vencida (ADR-108): por el job o por el reloj, aunque el job no haya
  -- corrido. Con pagos vivos no vence: se puede retomar para resolverla.
  if v_row.status = 'expired' then raise exception 'paused_sale_expired'; end if;
  if v_row.expires_at <= now() and not _paused_sale_has_live_payments(p_id) then
    raise exception 'paused_sale_expired';
  end if;
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
-- F) Trigger de intents: un pago tardío sobre una pausada vencida también
--    queda para revisión (antes sólo sobre las descartadas).
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
               -- Pago tardío sobre una pausada descartada o vencida: la plata entró.
               needs_review = needs_review or v_st in ('discarded', 'expired'),
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

-- -----------------------------------------------------------------------------
-- G) pg_cron: cada 15 minutos. Sin pg_cron (stack local, CI) se omite.
-- -----------------------------------------------------------------------------
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el vencimiento de ventas pausadas.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'paused-sales-expire') then
    perform cron.unschedule('paused-sales-expire');
  end if;
  perform cron.schedule('paused-sales-expire', '*/15 * * * *', $$select public.expire_paused_sales(500)$$);
end
$cron$;
