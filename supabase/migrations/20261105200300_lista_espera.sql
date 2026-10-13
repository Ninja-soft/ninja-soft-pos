-- =============================================================================
-- 20261105200300_lista_espera  (F13 · H51: lista de espera / waitlist)
-- -----------------------------------------------------------------------------
-- Viernes 21 h, salón lleno: la gente que llega sin reserva se anota en la lista
-- de espera con nombre, teléfono, comensales, prioridad y la espera prometida.
-- Cuando se libera una mesa, se avisa (link de WhatsApp manual, sin integración)
-- y se SIENTA: abre la mesa reusando open_dining_table y deja la referencia en
-- el pedido.
--
-- Estados: esperando → avisado → sentado (+ cancelado / se_fue).
-- RPCs SECURITY DEFINER tenant-scoped (guard _dining_assert_member, search_path
-- fijo), espejo de las de reservas. Lectura por RLS de tenant.
-- Gating: flag operativo (dining_enabled), no feature de plan.
-- Fuera de alcance: aviso automático por WhatsApp/SMS y alta pública por QR.
-- =============================================================================

create table if not exists dining_waitlist (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  customer_id      uuid references customers(id) on delete set null,
  customer_name    text not null check (char_length(btrim(customer_name)) > 0),
  customer_phone   text,
  party_size       int not null default 2 check (party_size > 0 and party_size <= 100),
  -- 0 normal, 1 prioridad (embarazada, adulto mayor, movilidad reducida, VIP).
  priority         smallint not null default 0 check (priority in (0, 1)),
  -- Espera prometida al anotarlo (min). null = sin promesa.
  quoted_minutes   int check (quoted_minutes is null or (quoted_minutes > 0 and quoted_minutes <= 600)),
  area_id          uuid references dining_areas(id) on delete set null,
  status           text not null default 'esperando'
                     check (status in ('esperando','avisado','sentado','cancelado','se_fue')),
  notified_at      timestamptz,
  seated_at        timestamptz,
  table_order_id   uuid references table_orders(id) on delete set null,
  notes            text,
  created_by       uuid references public.users(id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists dining_waitlist_active_idx
  on dining_waitlist (tenant_id, status, created_at) where deleted_at is null;

create trigger set_updated_at_dining_waitlist
  before update on dining_waitlist
  for each row execute function set_updated_at();

alter table dining_waitlist enable row level security;
create policy dining_waitlist_select on dining_waitlist
  for select using (tenant_id = (select current_tenant_id()));
-- Alta directa permitida a miembros del negocio (formulario rápido del mozo).
create policy dining_waitlist_insert on dining_waitlist
  for insert with check (
    tenant_id = (select current_tenant_id())
    and status = 'esperando'
    and exists (
      select 1 from tenant_users me
       where me.tenant_id = (select current_tenant_id())
         and me.user_id = (select auth.uid())
         and me.status = 'active'
    )
  );
-- Cambios de estado: sólo por RPC (sin policy de update/delete).

create trigger audit_dining_waitlist
  after insert or update or delete on dining_waitlist
  for each row execute function write_audit_log();

-- ── set_waitlist_status ──────────────────────────────────────────────────────
create or replace function set_waitlist_status(p_entry_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_entry  dining_waitlist%rowtype;
begin
  if p_status not in ('esperando','avisado','cancelado','se_fue') then
    raise exception 'invalid_status';
  end if;
  select * into v_entry from dining_waitlist
   where id = p_entry_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if not found then
    raise exception 'waitlist_not_found';
  end if;
  if v_entry.status not in ('esperando','avisado') then
    raise exception 'waitlist_closed';
  end if;

  update dining_waitlist
     set status = p_status,
         notified_at = case when p_status = 'avisado' then coalesce(notified_at, now())
                            else notified_at end
   where id = p_entry_id and tenant_id = v_tenant;

  return jsonb_build_object('id', p_entry_id, 'status', p_status);
end;
$$;
revoke all on function set_waitlist_status(uuid, text) from public, anon;
grant execute on function set_waitlist_status(uuid, text) to authenticated;

-- ── seat_waitlist_entry: sienta al grupo en una mesa libre ───────────────────
create or replace function seat_waitlist_entry(p_entry_id uuid, p_table_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_entry  dining_waitlist%rowtype;
  v_table  dining_tables%rowtype;
  v_open   jsonb;
  v_order  uuid;
begin
  select * into v_entry from dining_waitlist
   where id = p_entry_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if not found then
    raise exception 'waitlist_not_found';
  end if;
  if v_entry.status not in ('esperando','avisado') then
    raise exception 'waitlist_closed';
  end if;

  select * into v_table from dining_tables
   where id = p_table_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if not found then
    raise exception 'table_not_found';
  end if;
  if v_table.status <> 'libre' or v_table.current_order_id is not null then
    raise exception 'table_not_free';
  end if;

  v_open := open_dining_table(p_table_id, null);
  v_order := (v_open ->> 'order_id')::uuid;

  update table_orders
     set notes = concat_ws(' · ', nullif(btrim(notes), ''),
                           'Lista de espera: ' || v_entry.customer_name
                           || ' (' || v_entry.party_size || ' pers.)')
   where id = v_order and tenant_id = v_tenant;

  update dining_waitlist
     set status = 'sentado', seated_at = now(), table_order_id = v_order
   where id = p_entry_id and tenant_id = v_tenant;

  return jsonb_build_object('id', p_entry_id, 'order_id', v_order, 'table_id', p_table_id);
end;
$$;
revoke all on function seat_waitlist_entry(uuid, uuid) from public, anon;
grant execute on function seat_waitlist_entry(uuid, uuid) to authenticated;
