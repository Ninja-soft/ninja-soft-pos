-- =============================================================================
-- 20261109600300_gastro_r2_aviso_lista_espera  (F13 · H51: aviso automático a
--                                               la lista de espera, ADR-097)
-- -----------------------------------------------------------------------------
-- ADR-081 dejó el aviso como un link de WhatsApp que el mozo arma a mano. Acá
-- el aviso se GENERA solo y queda REGISTRADO, sin API de terceros:
--
--   * Cuando una mesa pasa a 'libre' (cobro, cancelación, mover, liberar), un
--     trigger busca al primer grupo que espera y entra en la mesa (prioridad,
--     después orden de llegada; mismo salón o sin salón) y crea un aviso
--     PENDIENTE en dining_waitlist_notices con el mensaje listo y el teléfono.
--     Un aviso pendiente por grupo y por mesa (no se pisan).
--   * El salón muestra el aviso pendiente: "Enviar por WhatsApp" abre wa.me con
--     el mensaje (el link lo arma el cliente con el teléfono normalizado) y
--     llama mark_waitlist_notice_sent (aviso 'enviado', grupo 'avisado',
--     audit waitlist_notified). "Descartar" lo cierra (dismiss_waitlist_notice).
--   * notify_waitlist_entry: aviso manual desde la fila (mismo registro).
--
-- El envío lo hace la persona desde su WhatsApp: no hay proveedor, plantillas
-- aprobadas ni costo por mensaje. Lectura por negocio; escritura sólo por RPC y
-- por el trigger. Gating: flag operativo (dining_enabled), no feature de plan.
-- =============================================================================

create table if not exists dining_waitlist_notices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  entry_id    uuid not null references dining_waitlist(id) on delete cascade,
  table_id    uuid references dining_tables(id) on delete set null,
  table_label text,
  origin      text not null check (origin in ('mesa_libre', 'manual')),
  phone       text,
  message     text not null check (char_length(message) between 1 and 500),
  status      text not null default 'pendiente'
                check (status in ('pendiente', 'enviado', 'descartado')),
  sent_at     timestamptz,
  sent_by     uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists dining_waitlist_notices_tenant_idx
  on dining_waitlist_notices (tenant_id, status, created_at desc);
create index if not exists dining_waitlist_notices_entry_idx
  on dining_waitlist_notices (entry_id);
create index if not exists dining_waitlist_notices_table_idx
  on dining_waitlist_notices (table_id) where table_id is not null;
create index if not exists dining_waitlist_notices_sent_by_idx
  on dining_waitlist_notices (sent_by) where sent_by is not null;
-- Un aviso pendiente por grupo.
create unique index if not exists dining_waitlist_notices_one_pending
  on dining_waitlist_notices (entry_id) where status = 'pendiente';

alter table dining_waitlist_notices enable row level security;
create policy dining_waitlist_notices_select on dining_waitlist_notices
  for select using (tenant_id = (select current_tenant_id()));
-- Sin policies de escritura: RPC y trigger.

drop trigger if exists role_write_guard on dining_waitlist_notices;
create trigger role_write_guard before insert or update or delete on dining_waitlist_notices
  for each row execute function trg_role_write_guard('operate');

-- ── Mensaje del aviso ────────────────────────────────────────────────────────
create or replace function _waitlist_message(p_tenant uuid, p_name text, p_table_label text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select left(
    'Hola ' || btrim(p_name) || ', tu mesa'
    || coalesce(' en ' || nullif(btrim(coalesce(
         (select b.legal_name from tenant_branding b where b.tenant_id = p_tenant),
         (select t.name from tenants t where t.id = p_tenant), '')), ''), '')
    || ' ya está lista'
    || coalesce(' (mesa ' || nullif(btrim(p_table_label), '') || ')', '')
    || '. Te esperamos.', 500);
$$;
revoke all on function _waitlist_message(uuid, text, text) from public, anon, authenticated;

-- ── Trigger: mesa libre → aviso pendiente al primer grupo que entra ──────────
create or replace function _dining_tables_waitlist_notice()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry dining_waitlist%rowtype;
  v_id    uuid;
begin
  if new.status <> 'libre' or old.status = 'libre' or new.deleted_at is not null then
    return null;
  end if;
  -- Ya hay un aviso pendiente por esta mesa: no se suma otro.
  if exists (select 1 from dining_waitlist_notices n
              where n.table_id = new.id and n.tenant_id = new.tenant_id
                and n.status = 'pendiente') then
    return null;
  end if;

  select w.* into v_entry
    from dining_waitlist w
   where w.tenant_id = new.tenant_id
     and w.status = 'esperando'
     and w.deleted_at is null
     and w.party_size <= greatest(new.capacity, 1)
     and (w.area_id is null or w.area_id = new.area_id)
     and not exists (select 1 from dining_waitlist_notices n
                      where n.entry_id = w.id and n.status = 'pendiente')
   order by w.priority desc, w.created_at asc
   limit 1
   for update of w skip locked;
  if not found then
    return null;
  end if;

  insert into dining_waitlist_notices (tenant_id, entry_id, table_id, table_label, origin,
                                       phone, message)
  values (new.tenant_id, v_entry.id, new.id, new.label, 'mesa_libre',
          nullif(btrim(coalesce(v_entry.customer_phone, '')), ''),
          _waitlist_message(new.tenant_id, v_entry.customer_name, new.label))
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (new.tenant_id, auth.uid(), 'dining_waitlist', v_entry.id, 'waitlist_notice_created',
          jsonb_build_object('notice_id', v_id, 'table_id', new.id, 'table_label', new.label,
                             'origin', 'mesa_libre'));
  return null;
end;
$$;
revoke all on function _dining_tables_waitlist_notice() from public, anon, authenticated;

drop trigger if exists dining_tables_waitlist_notice on dining_tables;
create trigger dining_tables_waitlist_notice
  after update of status on dining_tables
  for each row execute function _dining_tables_waitlist_notice();

-- ── Marcar enviado (desde el aviso pendiente) ────────────────────────────────
create or replace function mark_waitlist_notice_sent(p_notice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_n      dining_waitlist_notices%rowtype;
begin
  select * into v_n from dining_waitlist_notices
   where id = p_notice_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'notice_not_found';
  end if;
  if v_n.status <> 'pendiente' then
    raise exception 'notice_closed';
  end if;

  update dining_waitlist_notices
     set status = 'enviado', sent_at = now(), sent_by = auth.uid()
   where id = p_notice_id and tenant_id = v_tenant;

  update dining_waitlist
     set status = case when status = 'esperando' then 'avisado' else status end,
         notified_at = coalesce(notified_at, now())
   where id = v_n.entry_id and tenant_id = v_tenant and status in ('esperando', 'avisado');

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'dining_waitlist', v_n.entry_id, 'waitlist_notified',
          jsonb_build_object('notice_id', p_notice_id, 'origin', v_n.origin,
                             'table_id', v_n.table_id, 'has_phone', v_n.phone is not null));

  return jsonb_build_object('notice_id', p_notice_id, 'entry_id', v_n.entry_id,
                            'phone', v_n.phone, 'message', v_n.message);
end;
$$;
revoke all on function mark_waitlist_notice_sent(uuid) from public, anon;
grant execute on function mark_waitlist_notice_sent(uuid) to authenticated;

create or replace function dismiss_waitlist_notice(p_notice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_n      dining_waitlist_notices%rowtype;
begin
  select * into v_n from dining_waitlist_notices
   where id = p_notice_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'notice_not_found';
  end if;
  if v_n.status <> 'pendiente' then
    raise exception 'notice_closed';
  end if;

  update dining_waitlist_notices set status = 'descartado'
   where id = p_notice_id and tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'dining_waitlist', v_n.entry_id, 'waitlist_notice_dismissed',
          jsonb_build_object('notice_id', p_notice_id, 'table_id', v_n.table_id));

  return jsonb_build_object('notice_id', p_notice_id, 'status', 'descartado');
end;
$$;
revoke all on function dismiss_waitlist_notice(uuid) from public, anon;
grant execute on function dismiss_waitlist_notice(uuid) to authenticated;

-- ── Aviso manual desde la fila ───────────────────────────────────────────────
create or replace function notify_waitlist_entry(p_entry_id uuid, p_table_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _dining_assert_member();
  v_entry  dining_waitlist%rowtype;
  v_label  text;
  v_pend   uuid;
begin
  select * into v_entry from dining_waitlist
   where id = p_entry_id and tenant_id = v_tenant and deleted_at is null
   for update;
  if not found then
    raise exception 'waitlist_not_found';
  end if;
  if v_entry.status not in ('esperando', 'avisado') then
    raise exception 'waitlist_closed';
  end if;

  -- Si ya había un aviso automático pendiente, se envía ese.
  select id into v_pend from dining_waitlist_notices
   where entry_id = p_entry_id and tenant_id = v_tenant and status = 'pendiente';
  if v_pend is not null then
    return mark_waitlist_notice_sent(v_pend);
  end if;

  if p_table_id is not null then
    select label into v_label from dining_tables
     where id = p_table_id and tenant_id = v_tenant and deleted_at is null;
    if not found then
      raise exception 'table_not_found';
    end if;
  end if;

  insert into dining_waitlist_notices (tenant_id, entry_id, table_id, table_label, origin,
                                       phone, message, status, sent_at, sent_by)
  values (v_tenant, p_entry_id, p_table_id, v_label, 'manual',
          nullif(btrim(coalesce(v_entry.customer_phone, '')), ''),
          _waitlist_message(v_tenant, v_entry.customer_name, v_label),
          'enviado', now(), auth.uid())
  returning id into v_pend;

  update dining_waitlist
     set status = 'avisado', notified_at = coalesce(notified_at, now())
   where id = p_entry_id and tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'dining_waitlist', p_entry_id, 'waitlist_notified',
          jsonb_build_object('notice_id', v_pend, 'origin', 'manual',
                             'table_id', p_table_id,
                             'has_phone', v_entry.customer_phone is not null));

  return (select jsonb_build_object('notice_id', n.id, 'entry_id', n.entry_id,
                                    'phone', n.phone, 'message', n.message)
            from dining_waitlist_notices n where n.id = v_pend);
end;
$$;
revoke all on function notify_waitlist_entry(uuid, uuid) from public, anon;
grant execute on function notify_waitlist_entry(uuid, uuid) to authenticated;
