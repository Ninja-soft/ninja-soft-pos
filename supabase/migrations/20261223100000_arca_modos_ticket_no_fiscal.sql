-- =============================================================================
-- ADR-155: Facturación ARCA: factura o sólo ticket en cada venta.
--
-- El dueño elige en Configuración › Facturación qué pasa por defecto en cada
-- venta (siempre factura, preguntar o sólo ticket) y en la hoja de cobro se
-- alterna con un toque. NO se toca create_sale: la elección viaja como una
-- "intención" pendiente del usuario (mismo patrón que el tipo de comprobante
-- forzado de ADR-133, sale_letter_overrides) que un trigger BEFORE INSERT de
-- sales aplica a la venta que ese usuario crea para ese cliente. La venta queda
-- marcada (sales.non_fiscal) y el encolado de ARCA la saltea. Más tarde se puede
-- facturar a mano (arca_enqueue_sale_manual sigue andando).
--
--   A) arca_settings.ticket_mode ('factura' | 'preguntar' | 'ticket') y la RPC
--      arca_ticket_mode_set (dueño o encargado, feature facturacion_afip,
--      auditada).
--   B) sales.non_fiscal (inmutable después del alta) y la tabla
--      sale_fiscal_intents (escribe sólo RPC; lee dueño o encargado).
--   C) sale_ticket_only_set / sale_ticket_only_clear (cualquier miembro con
--      rol, feature y facturación activa) con avisos (cliente con CUIT,
--      factura A o M) en la auditoría.
--   D) trg_sales_fiscal_intent (BEFORE INSERT) y guardia de inmutabilidad.
--   E) arca_enqueue_sale: una venta sólo ticket no se encola sola.
--   F) arca_status: suma ticket_mode para el POS.
--
-- RLS: staff interno por internal_scope() (ADR-052), nunca is_internal().
-- No recrea create_sale (choca con ADR-151 en integración).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Modo por defecto del negocio
-- -----------------------------------------------------------------------------
alter table arca_settings
  add column if not exists ticket_mode text not null default 'factura';
alter table arca_settings drop constraint if exists arca_settings_ticket_mode_check;
alter table arca_settings add constraint arca_settings_ticket_mode_check
  check (ticket_mode in ('factura', 'preguntar', 'ticket'));
comment on column arca_settings.ticket_mode is
  'ADR-155: qué propone la hoja de cobro. factura = siempre factura (se puede pasar a sólo ticket), preguntar = el cajero elige en cada venta, ticket = sólo ticket por defecto.';

create or replace function arca_ticket_mode_set(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := arca_assert(true);
  v_before text;
begin
  if p_mode is null or p_mode not in ('factura', 'preguntar', 'ticket') then
    raise exception 'invalid_ticket_mode';
  end if;
  insert into arca_settings (tenant_id) values (v_tenant) on conflict (tenant_id) do nothing;
  select ticket_mode into v_before from arca_settings where tenant_id = v_tenant for update;
  update arca_settings set ticket_mode = p_mode, updated_by = auth.uid() where tenant_id = v_tenant;
  if v_before is distinct from p_mode then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
    values (v_tenant, auth.uid(), 'arca_settings', null, 'arca_ticket_mode_changed',
            jsonb_build_object('ticket_mode', v_before), jsonb_build_object('ticket_mode', p_mode));
  end if;
  return jsonb_build_object('ok', true, 'ticket_mode', p_mode);
end;
$$;
revoke all on function arca_ticket_mode_set(text) from public, anon;
grant execute on function arca_ticket_mode_set(text) to authenticated;

-- -----------------------------------------------------------------------------
-- B) Marca en la venta y elección pendiente
-- -----------------------------------------------------------------------------
alter table sales add column if not exists non_fiscal boolean not null default false;
comment on column sales.non_fiscal is
  'ADR-155: la venta se cobró con sólo ticket (sin factura de ARCA). La pone el trigger sales_fiscal_intent; no cambia después del alta.';

create table if not exists sale_fiscal_intents (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  user_id           uuid not null,
  customer_id       uuid,
  mode              text not null default 'ticket' check (mode in ('ticket')),
  reason            text check (reason is null or char_length(reason) <= 300),
  warnings          jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  consumed_at       timestamptz,
  consumed_sale_id  uuid,
  deleted_at        timestamptz
);
comment on table sale_fiscal_intents is
  'ADR-155: "sólo ticket" elegido en la hoja de cobro. Lo aplica el trigger de sales a la próxima venta del mismo usuario y cliente (15 min). Escribe sólo RPC.';
create index if not exists sale_fiscal_intents_pending_idx
  on sale_fiscal_intents (tenant_id, user_id, created_at desc)
  where consumed_at is null and deleted_at is null;
create index if not exists sale_fiscal_intents_tenant_idx on sale_fiscal_intents (tenant_id, created_at desc);

alter table sale_fiscal_intents enable row level security;
revoke all on sale_fiscal_intents from anon, authenticated;
grant select on sale_fiscal_intents to authenticated;
drop policy if exists sale_fiscal_intents_select on sale_fiscal_intents;
create policy sale_fiscal_intents_select on sale_fiscal_intents
  for select using (
    (select internal_scope())
    or (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))
  );

-- -----------------------------------------------------------------------------
-- C) Elegir "sólo ticket" para la venta en curso
-- -----------------------------------------------------------------------------
-- Avisos (no bloquean: la decisión es del negocio y queda auditada): cliente
-- con CUIT (suele necesitar la factura) y factura A o M (el cliente computa el
-- IVA con ella).
create or replace function sale_ticket_only_set(p_customer uuid default null, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_uid    uuid := auth.uid();
  v_set    jsonb;
  v_rcond  text := 'consumidor_final';
  v_cuit   boolean := false;
  v_doc    text;
  v_ctype  text;
  v_cdoc   text;
  v_ccond  text;
  v_letter text;
  v_warn   jsonb := '[]'::jsonb;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 300), '');
  v_id     uuid;
begin
  if v_tenant is null or v_uid is null or stock_my_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'facturacion_afip') then
    raise exception 'feature_not_in_plan: facturacion_afip' using errcode = '42501';
  end if;
  if not exists (select 1 from arca_settings where tenant_id = v_tenant and enabled) then
    raise exception 'not_enabled';
  end if;
  if p_customer is not null then
    select c.document_type, c.document_number, c.iva_condition into v_ctype, v_cdoc, v_ccond
      from customers c
     where c.id = p_customer and c.tenant_id = v_tenant and c.deleted_at is null;
    if not found then
      raise exception 'customer_not_found';
    end if;
    v_rcond := coalesce(nullif(v_ccond, ''), 'consumidor_final');
    v_doc := regexp_replace(coalesce(v_cdoc, ''), '\D', '', 'g');
    v_cuit := v_ctype = 'cuit' and length(v_doc) = 11 and cuit_is_valid(v_doc);
  end if;
  v_set := _tax_settings_eff(v_tenant);
  v_letter := cbte_letter_infer(v_set ->> 'iva_condition', v_rcond,
                                coalesce((v_set ->> 'issues_cbte_m')::boolean, false));
  if v_cuit then
    v_warn := v_warn || jsonb_build_array('cliente_con_cuit');
  end if;
  if v_letter in ('A', 'M') then
    v_warn := v_warn || jsonb_build_array('factura_' || lower(v_letter));
  end if;

  -- Una pendiente por usuario: la nueva reemplaza a la anterior.
  update sale_fiscal_intents set deleted_at = now()
   where tenant_id = v_tenant and user_id = v_uid and consumed_at is null and deleted_at is null;
  insert into sale_fiscal_intents (tenant_id, user_id, customer_id, mode, reason, warnings)
  values (v_tenant, v_uid, p_customer, 'ticket', v_reason, v_warn)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'letter', v_letter, 'warnings', v_warn);
end;
$$;
revoke all on function sale_ticket_only_set(uuid, text) from public, anon;
grant execute on function sale_ticket_only_set(uuid, text) to authenticated;

-- Descartar la elección (volvió a Factura o se cerró la hoja sin cobrar).
create or replace function sale_ticket_only_clear()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_tenant_id() is null or auth.uid() is null then
    return;
  end if;
  update sale_fiscal_intents set deleted_at = now()
   where tenant_id = current_tenant_id() and user_id = auth.uid()
     and consumed_at is null and deleted_at is null;
end;
$$;
revoke all on function sale_ticket_only_clear() from public, anon;
grant execute on function sale_ticket_only_clear() to authenticated;

-- -----------------------------------------------------------------------------
-- D) Aplicar la elección a la venta (antes del trigger AFTER que la encola)
-- -----------------------------------------------------------------------------
create or replace function trg_sales_fiscal_intent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_i   sale_fiscal_intents%rowtype;
begin
  -- La marca sólo la pone una elección registrada por RPC, nunca el insert.
  new.non_fiscal := false;
  if v_uid is null then
    return new;
  end if;
  select * into v_i from sale_fiscal_intents i
   where i.tenant_id = new.tenant_id and i.user_id = v_uid
     and i.consumed_at is null and i.deleted_at is null
     and i.customer_id is not distinct from new.customer_id
     and i.created_at > now() - interval '15 minutes'
   order by i.created_at desc
   limit 1
   for update skip locked;
  if not found then
    return new;
  end if;
  update sale_fiscal_intents set consumed_at = now(), consumed_sale_id = new.id where id = v_i.id;
  new.non_fiscal := true;
  new.fiscal_snapshot := coalesce(new.fiscal_snapshot, '{}'::jsonb) || jsonb_build_object(
    'ticket_only', jsonb_build_object('by', v_uid, 'intent_id', v_i.id, 'reason', v_i.reason,
                                      'warnings', v_i.warnings));
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (new.tenant_id, v_uid, 'sales', new.id, 'sale_ticket_only',
          jsonb_build_object('intent_id', v_i.id, 'customer_id', new.customer_id, 'total', new.total,
                             'cbte_letter', new.cbte_letter, 'warnings', v_i.warnings),
          v_i.reason);
  return new;
end;
$$;
revoke all on function trg_sales_fiscal_intent() from public, anon, authenticated;

drop trigger if exists sales_fiscal_intent on sales;
create trigger sales_fiscal_intent
  before insert on sales
  for each row execute function trg_sales_fiscal_intent();

-- La marca no cambia después del alta (la policy de sales deja actualizar
-- columnas a los miembros: sin esto se podría apagar la factura de un cobro
-- en espera antes de acreditarse).
create or replace function trg_sales_non_fiscal_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.non_fiscal is distinct from old.non_fiscal then
    new.non_fiscal := old.non_fiscal;
  end if;
  return new;
end;
$$;
revoke all on function trg_sales_non_fiscal_guard() from public, anon, authenticated;

drop trigger if exists sales_non_fiscal_guard on sales;
create trigger sales_non_fiscal_guard
  before update of non_fiscal on sales
  for each row execute function trg_sales_non_fiscal_guard();

-- -----------------------------------------------------------------------------
-- E) Encolado: misma función de ADR-072 más el salteo de las ventas sólo
--    ticket (sólo el encolado automático; el manual factura igual).
-- -----------------------------------------------------------------------------
create or replace function arca_enqueue_sale(p_sale_id uuid, p_manual boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale  sales%rowtype;
  v_set   arca_settings%rowtype;
  v_pv    integer;
  v_rec   jsonb;
  v_block text;
  v_new   uuid;
begin
  select * into v_sale from sales where id = p_sale_id;
  if not found or v_sale.status <> 'completed' or coalesce(v_sale.total, 0) <= 0 then
    return null;
  end if;
  -- ADR-155: sólo ticket. Se factura únicamente si alguien lo pide a mano.
  if not p_manual and coalesce(v_sale.non_fiscal, false) then
    return null;
  end if;
  select * into v_set from arca_settings where tenant_id = v_sale.tenant_id;
  if not found or not v_set.enabled then
    return null;
  end if;
  if not p_manual and (v_set.start_at is null or v_sale.created_at < v_set.start_at) then
    return null;
  end if;
  if not tenant_has_feature_for(v_sale.tenant_id, 'facturacion_afip') then
    return null;
  end if;
  if exists (select 1 from fiscal_documents
              where tenant_id = v_sale.tenant_id and sale_id = p_sale_id and origin = 'sale'
                and status <> 'cancelado') then
    return null;
  end if;

  v_pv := arca_pos_for(v_sale.store_id, v_sale.cash_shift_id);
  v_rec := coalesce(v_sale.fiscal_snapshot -> 'receptor', '{}'::jsonb)
           || jsonb_build_object('requires_identification',
                                 coalesce(v_sale.fiscal_snapshot -> 'requires_identification', 'false'::jsonb));
  v_block := _arca_blocker(v_sale.cbte_letter, v_pv, v_rec, 'sale');

  insert into fiscal_documents (tenant_id, sale_id, origin, environment, store_id, cbte_letter, cbte_tipo,
                                pto_vta, imp_total, status, last_error_code, last_error_msg, created_by)
  values (v_sale.tenant_id, v_sale.id, 'sale', v_set.environment, v_sale.store_id, v_sale.cbte_letter,
          arca_cbte_tipo(v_sale.cbte_letter, 'factura'), v_pv, v_sale.total,
          case when v_block is null then 'pendiente' else 'requiere_accion' end,
          v_block, _arca_blocker_msg(v_block), auth.uid())
  on conflict do nothing
  returning id into v_new;
  return v_new;
end;
$$;
revoke all on function arca_enqueue_sale(uuid, boolean) from public, anon, authenticated;
grant execute on function arca_enqueue_sale(uuid, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- F) Estado para el POS: suma el modo por defecto
-- -----------------------------------------------------------------------------
create or replace function arca_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_set    arca_settings%rowtype;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  select * into v_set from arca_settings where tenant_id = v_tenant;
  return jsonb_build_object(
    'enabled', coalesce(v_set.enabled, false) and tenant_has_feature_for(v_tenant, 'facturacion_afip'),
    'environment', coalesce(v_set.environment, 'homologacion'),
    'contingency', v_set.contingency_since is not null,
    'contingency_since', v_set.contingency_since,
    'ticket_mode', coalesce(v_set.ticket_mode, 'factura'),
    'pending', (select count(*) from fiscal_documents d
                 where d.tenant_id = v_tenant and d.status in ('pendiente', 'enviando')),
    'needs_action', (select count(*) from fiscal_documents d
                      where d.tenant_id = v_tenant and d.status in ('rechazado', 'requiere_accion')));
end;
$$;
revoke all on function arca_status() from public, anon;
grant execute on function arca_status() to authenticated;
