-- =============================================================================
-- 20261024100100_conciliacion_procesadores  (ADR-061)
--
-- Detalle de la venta con los datos del procesador y conciliación v2 contra
-- las liquidaciones de los procesadores (Mercado Pago por API, Payway y
-- cualquier adquirente por archivo).
--
--  A) payment_provider_snapshots: foto normalizada (y cruda) del cobro según
--     la API del procesador (comisiones, neto, acreditación, cuotas, tarjeta,
--     pagador). La escribe la Edge payment_provider_data (service_role).
--  B) settlement_imports / settlement_lines: liquidaciones importadas y el
--     resultado del cruce con los cobros del POS (payment_id, intent_id,
--     match_status, match_method, diferencia, revisión).
--  C) settlement_sync_state: última sincronización por proveedor y alcance de
--     la credencial (negocio o sucursal, ADR-057) y si el cron la toma.
--  D) RPC settlement_import_lines (archivo), settlement_line_resolve (revisar,
--     vincular, desvincular) y _settlement_apply_matches (service_role, la
--     llama la Edge `settlements` con el resultado del motor de cruce).
--  E) Cron diario: POST a la Edge `settlements` con X-Cron-Secret (patrón de
--     pending_charges_sync).
--
-- RLS (ADR-052): lectura `tenant_id = current_tenant_id() or internal_scope()`
-- más una RESTRICTIVE de dueño o encargado (comisiones e impuestos son datos
-- administrativos). Sin policies de escritura: sólo RPC SECURITY DEFINER y
-- service_role.
--
-- Conciliado: un cobro que cierra con su línea se marca en payments
-- .reconciled_at / reconciled_by (misma semántica que set_payments_reconciled,
-- ADR-044) con audit `payments_reconciled` y `source = 'settlement'`. Desvincular
-- una línea desmarca sólo lo que marcó la conciliación de procesadores
-- (settlement_lines.reconciled_payment).
--
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Fotos del procesador
-- -----------------------------------------------------------------------------
create table if not exists payment_provider_snapshots (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  payment_id   uuid references payments(id) on delete cascade,
  intent_id    uuid references mp_payment_intents(id) on delete cascade,
  provider_key text not null,
  external_id  text not null,
  normalized   jsonb not null default '{}'::jsonb,
  raw          jsonb,
  error        text,
  fetched_at   timestamptz not null default now(),
  fetched_by   uuid references public.users(id) on delete set null
);
create unique index if not exists payment_provider_snapshots_uniq
  on payment_provider_snapshots (tenant_id, provider_key, external_id);
create index if not exists payment_provider_snapshots_payment_idx
  on payment_provider_snapshots (payment_id) where payment_id is not null;
create index if not exists payment_provider_snapshots_intent_idx
  on payment_provider_snapshots (intent_id) where intent_id is not null;

alter table payment_provider_snapshots enable row level security;
drop policy if exists pps_select on payment_provider_snapshots;
create policy pps_select on payment_provider_snapshots
  for select using (tenant_id = current_tenant_id() or internal_scope());
drop policy if exists pps_managers on payment_provider_snapshots;
create policy pps_managers on payment_provider_snapshots
  as restrictive for select using (is_tenant_manager() or internal_scope());

comment on table payment_provider_snapshots is
  'ADR-061: datos del cobro según la API del procesador (normalizados + crudos). Escritura sólo service_role (Edge payment_provider_data).';

-- -----------------------------------------------------------------------------
-- B) Liquidaciones
-- -----------------------------------------------------------------------------
create table if not exists settlement_imports (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  provider_key  text not null,
  source        text not null check (source in ('api', 'file')),
  scope_store_id uuid references stores(id) on delete set null,
  file_name     text,
  period_from   date,
  period_to     date,
  row_count     int not null default 0,
  meta          jsonb not null default '{}'::jsonb,
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists settlement_imports_tenant_idx on settlement_imports (tenant_id, created_at desc);

create table if not exists settlement_lines (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  import_id          uuid references settlement_imports(id) on delete set null,
  provider_key       text not null,
  scope_store_id     uuid references stores(id) on delete set null,
  line_key           text not null,
  external_id        text,
  order_id           text,
  external_reference text,
  kind               text not null default 'payment' check (kind in ('payment', 'refund', 'chargeback', 'other')),
  status             text not null default 'approved',
  operation_at       timestamptz not null,
  release_date       timestamptz,
  released           boolean not null default false,
  gross              numeric(14,2) not null,
  fee                numeric(14,2) not null default 0,
  taxes              numeric(14,2) not null default 0,
  net                numeric(14,2) not null,
  refunded           numeric(14,2) not null default 0,
  currency           text,
  payment_method     text,
  payment_type       text,
  card_brand         text,
  last4              text,
  installments       int,
  lote               text,
  cupon              text,
  autorizacion       text,
  comercio           text,
  terminal           text,
  pos_id             text,
  store_ext_id       text,
  description        text,
  payer              text,
  fee_detail         jsonb not null default '[]'::jsonb,
  raw                jsonb,
  -- Cruce con el POS
  payment_id         uuid references payments(id) on delete set null,
  intent_id          uuid references mp_payment_intents(id) on delete set null,
  sale_id            uuid references sales(id) on delete set null,
  match_status       text not null default 'missing_in_pos'
                       check (match_status in ('matched', 'amount_diff', 'missing_in_pos', 'ignored')),
  match_method       text check (match_method in ('provider_id', 'voucher', 'authorization', 'amount_date', 'manual')),
  diff_amount        numeric(14,2) not null default 0,
  matched_at         timestamptz,
  reconciled_payment boolean not null default false,
  reviewed_at        timestamptz,
  reviewed_by        uuid references public.users(id) on delete set null,
  review_note        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists settlement_lines_key_uniq
  on settlement_lines (tenant_id, provider_key, line_key);
create index if not exists settlement_lines_tenant_date_idx
  on settlement_lines (tenant_id, provider_key, operation_at desc);
create index if not exists settlement_lines_payment_idx
  on settlement_lines (payment_id) where payment_id is not null;
create index if not exists settlement_lines_release_idx
  on settlement_lines (tenant_id, release_date) where released = false;

drop trigger if exists set_updated_at_settlement_lines on settlement_lines;
create trigger set_updated_at_settlement_lines
  before update on settlement_lines
  for each row execute function set_updated_at();

alter table settlement_imports enable row level security;
alter table settlement_lines enable row level security;

drop policy if exists si_select on settlement_imports;
create policy si_select on settlement_imports
  for select using (tenant_id = current_tenant_id() or internal_scope());
drop policy if exists si_managers on settlement_imports;
create policy si_managers on settlement_imports
  as restrictive for select using (is_tenant_manager() or internal_scope());

drop policy if exists sl_select on settlement_lines;
create policy sl_select on settlement_lines
  for select using (tenant_id = current_tenant_id() or internal_scope());
drop policy if exists sl_managers on settlement_lines;
create policy sl_managers on settlement_lines
  as restrictive for select using (is_tenant_manager() or internal_scope());

-- -----------------------------------------------------------------------------
-- C) Estado de la sincronización por proveedor y alcance de credencial
-- -----------------------------------------------------------------------------
create table if not exists settlement_sync_state (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  provider_key   text not null,
  scope_store_id uuid references stores(id) on delete cascade,
  auto_sync      boolean not null default true,
  last_sync_at   timestamptz,
  last_from      timestamptz,
  last_to        timestamptz,
  last_status    text,
  last_error     text,
  last_count     int not null default 0,
  updated_at     timestamptz not null default now()
);
create unique index if not exists settlement_sync_state_uniq
  on settlement_sync_state (tenant_id, provider_key, scope_store_id) nulls not distinct;

alter table settlement_sync_state enable row level security;
drop policy if exists sss_select on settlement_sync_state;
create policy sss_select on settlement_sync_state
  for select using (tenant_id = current_tenant_id() or internal_scope());
drop policy if exists sss_managers on settlement_sync_state;
create policy sss_managers on settlement_sync_state
  as restrictive for select using (is_tenant_manager() or internal_scope());

-- -----------------------------------------------------------------------------
-- D1) Guard común de las RPC: tenant, dueño o encargado y plan.
-- -----------------------------------------------------------------------------
create or replace function _settlement_assert()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if auth.uid() is null or v_tenant is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'conciliacion_procesadores') then
    raise exception 'feature_not_in_plan: conciliacion_procesadores' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _settlement_assert() from public, anon, authenticated;

-- Texto limpio y acotado (lote, cupón, comercio...).
create or replace function _settlement_txt(p jsonb, k text, maxlen int default 40)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(left(btrim(coalesce(p ->> k, '')), maxlen), '');
$$;
revoke all on function _settlement_txt(jsonb, text, int) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D2) Importar líneas de un archivo (Payway, Getnet, Fiserv/Posnet, otros).
--     El front parsea el XLSX/CSV con el mapeo de columnas y manda las filas
--     ya normalizadas (SettlementLineInput). El servidor valida, acota y hace
--     upsert por (negocio, proveedor, line_key): reimportar el mismo archivo
--     no duplica. El cruce lo corre después la Edge `settlements` (match).
--     Devuelve { import_id, inserted, updated, skipped }.
-- -----------------------------------------------------------------------------
create or replace function settlement_import_lines(
  p_provider  text,
  p_file_name text,
  p_lines     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := _settlement_assert();
  v_uid      uuid := auth.uid();
  v_import   uuid;
  v_line     jsonb;
  v_key      text;
  v_at       timestamptz;
  v_gross    numeric;
  v_fee      numeric;
  v_taxes    numeric;
  v_net      numeric;
  v_rel      timestamptz;
  v_ins      int := 0;
  v_upd      int := 0;
  v_skip     int := 0;
  v_min      timestamptz;
  v_max      timestamptz;
  v_inserted boolean;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,40}$' then
    raise exception 'invalid_provider';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid_lines';
  end if;
  if jsonb_array_length(p_lines) > 5000 then
    raise exception 'too_many_lines';
  end if;

  insert into settlement_imports (tenant_id, provider_key, source, file_name, created_by)
  values (v_tenant, p_provider, 'file', left(p_file_name, 200), v_uid)
  returning id into v_import;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    begin
      v_at    := (v_line ->> 'operation_at')::timestamptz;
      v_gross := round((v_line ->> 'gross')::numeric, 2);
      v_fee   := round(coalesce((v_line ->> 'fee')::numeric, 0), 2);
      v_taxes := round(coalesce((v_line ->> 'taxes')::numeric, 0), 2);
      v_net   := round(coalesce((v_line ->> 'net')::numeric, v_gross - v_fee - v_taxes), 2);
      v_rel   := nullif(v_line ->> 'release_date', '')::timestamptz;
    exception when others then
      v_skip := v_skip + 1;
      continue;
    end;
    if v_at is null or v_gross is null or abs(v_gross) > 1000000000 then
      v_skip := v_skip + 1;
      continue;
    end if;
    v_key := coalesce(
      _settlement_txt(v_line, 'line_key', 120),
      'f:' || md5(concat_ws('|', p_provider, v_at::text, v_gross::text,
                            _settlement_txt(v_line, 'lote'), _settlement_txt(v_line, 'cupon'),
                            _settlement_txt(v_line, 'autorizacion'), _settlement_txt(v_line, 'comercio'),
                            _settlement_txt(v_line, 'external_id', 80)))
    );

    insert into settlement_lines (
      tenant_id, import_id, provider_key, line_key, external_id, order_id, external_reference,
      kind, status, operation_at, release_date, released, gross, fee, taxes, net, refunded,
      currency, payment_method, payment_type, card_brand, last4, installments,
      lote, cupon, autorizacion, comercio, terminal, description, fee_detail
    ) values (
      v_tenant, v_import, p_provider, v_key,
      _settlement_txt(v_line, 'external_id', 80), _settlement_txt(v_line, 'order_id', 80),
      _settlement_txt(v_line, 'external_reference', 80),
      case when v_line ->> 'kind' in ('payment', 'refund', 'chargeback', 'other') then v_line ->> 'kind' else 'payment' end,
      coalesce(_settlement_txt(v_line, 'status', 30), 'approved'),
      v_at, v_rel,
      coalesce((v_line ->> 'released')::boolean, v_rel is not null and v_rel <= now()),
      v_gross, v_fee, v_taxes, v_net,
      round(coalesce((v_line ->> 'refunded')::numeric, 0), 2),
      _settlement_txt(v_line, 'currency', 5), _settlement_txt(v_line, 'payment_method'),
      _settlement_txt(v_line, 'payment_type'), _settlement_txt(v_line, 'card_brand'),
      nullif(right(regexp_replace(coalesce(v_line ->> 'last4', ''), '\D', '', 'g'), 4), ''),
      nullif(least(greatest(coalesce((v_line ->> 'installments')::numeric, 0), 0), 99)::int, 0),
      _settlement_txt(v_line, 'lote', 12), _settlement_txt(v_line, 'cupon', 16),
      upper(_settlement_txt(v_line, 'autorizacion', 20)), _settlement_txt(v_line, 'comercio', 20),
      _settlement_txt(v_line, 'terminal', 30), _settlement_txt(v_line, 'description', 200),
      case when jsonb_typeof(v_line -> 'fee_detail') = 'array' then v_line -> 'fee_detail' else '[]'::jsonb end
    )
    on conflict (tenant_id, provider_key, line_key) do update set
      import_id    = excluded.import_id,
      status       = excluded.status,
      release_date = excluded.release_date,
      released     = excluded.released,
      gross        = excluded.gross,
      fee          = excluded.fee,
      taxes        = excluded.taxes,
      net          = excluded.net,
      refunded     = excluded.refunded,
      fee_detail   = excluded.fee_detail
    returning (xmax = 0) into v_inserted;

    if v_inserted then v_ins := v_ins + 1; else v_upd := v_upd + 1; end if;
    v_min := least(coalesce(v_min, v_at), v_at);
    v_max := greatest(coalesce(v_max, v_at), v_at);
  end loop;

  -- Último dato de la importación (el día en Argentina).
  update settlement_imports
     set row_count = v_ins + v_upd,
         period_from = (v_min at time zone 'America/Argentina/Buenos_Aires')::date,
         period_to = (v_max at time zone 'America/Argentina/Buenos_Aires')::date,
         meta = jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'skipped', v_skip)
   where id = v_import;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, v_uid, 'settlement_imports', v_import, 'settlement_imported',
          jsonb_build_object('provider', p_provider, 'file', left(p_file_name, 200),
                             'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip));

  return jsonb_build_object('import_id', v_import, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip,
                            'from', v_min, 'to', v_max);
end;
$$;
revoke all on function settlement_import_lines(text, text, jsonb) from public, anon;
grant execute on function settlement_import_lines(text, text, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- D3) Marca o desmarca la conciliación de un cobro desde la conciliación de
--     procesadores. Sólo toca lo que cambia; audit con source 'settlement'.
-- -----------------------------------------------------------------------------
create or replace function _settlement_mark_payment(
  p_tenant uuid, p_payment uuid, p_reconciled boolean, p_actor uuid, p_line uuid, p_source text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_amount numeric;
begin
  update payments
     set reconciled_at = case when p_reconciled then now() end,
         reconciled_by = case when p_reconciled then p_actor end
   where id = p_payment
     and tenant_id = p_tenant
     and (reconciled_at is null) = p_reconciled
  returning amount into v_amount;
  if not found then
    return false;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, p_actor, 'payments', p_payment,
          case when p_reconciled then 'payments_reconciled' else 'payments_unreconciled' end,
          jsonb_build_object('payment_ids', jsonb_build_array(p_payment), 'count', 1, 'amount', v_amount,
                             'source', p_source, 'settlement_line_id', p_line));
  return true;
end;
$$;
revoke all on function _settlement_mark_payment(uuid, uuid, boolean, uuid, uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D4) Resolver una línea desde la pantalla de revisión.
--     p_action: 'ignore' (marcar revisado, con nota), 'unignore', 'link'
--     (vincular a un cobro del POS a mano: queda fijo, el cruce automático no
--     lo pisa) o 'unlink' (vuelve al cruce automático).
-- -----------------------------------------------------------------------------
create or replace function settlement_line_resolve(
  p_line_id    uuid,
  p_action     text,
  p_payment_id uuid default null,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _settlement_assert();
  v_uid    uuid := auth.uid();
  v_line   settlement_lines%rowtype;
  v_pay    record;
  v_diff   numeric;
  v_status text;
  v_marked boolean := false;
  v_prev   boolean := false;
begin
  select * into v_line from settlement_lines
   where id = p_line_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'line_not_found' using errcode = '42501';
  end if;

  if p_action = 'ignore' then
    update settlement_lines
       set match_status = 'ignored', reviewed_at = now(), reviewed_by = v_uid,
           review_note = nullif(left(btrim(coalesce(p_note, '')), 300), '')
     where id = v_line.id;
  elsif p_action = 'unignore' then
    update settlement_lines
       set match_status = case when payment_id is null then 'missing_in_pos' else 'matched' end,
           match_method = case when match_method = 'manual' then match_method end,
           reviewed_at = null, reviewed_by = null, review_note = null
     where id = v_line.id;
  elsif p_action = 'link' then
    if p_payment_id is null then
      raise exception 'invalid_args';
    end if;
    select p.id, p.amount, p.sale_id, s.status as sale_status
      into v_pay
      from payments p
      join sales s on s.id = p.sale_id
     where p.id = p_payment_id and p.tenant_id = v_tenant;
    if not found then
      raise exception 'payment_not_found' using errcode = '42501';
    end if;
    if exists (select 1 from settlement_lines
                where tenant_id = v_tenant and payment_id = p_payment_id and id <> v_line.id
                  and match_status <> 'ignored') then
      raise exception 'payment_already_linked';
    end if;
    v_diff := round((v_line.gross - v_line.refunded)
                    - case when v_pay.sale_status = 'voided' then 0 else v_pay.amount end, 2);
    v_status := case when abs(v_diff) > 0.01 then 'amount_diff' else 'matched' end;
    -- Lo que esta línea había marcado en otro cobro (o en este, si ya no cierra) se desmarca.
    v_prev := v_line.reconciled_payment;
    if v_prev and v_line.payment_id is not null
       and (v_line.payment_id <> p_payment_id or v_status <> 'matched') then
      perform _settlement_mark_payment(v_tenant, v_line.payment_id, false, v_uid, v_line.id, 'settlement_manual');
      v_prev := false;
    end if;
    if v_status = 'matched' then
      v_marked := _settlement_mark_payment(v_tenant, p_payment_id, true, v_uid, v_line.id, 'settlement_manual');
    end if;
    update settlement_lines
       set payment_id = p_payment_id, sale_id = v_pay.sale_id, match_status = v_status,
           match_method = 'manual', diff_amount = v_diff, matched_at = now(),
           reconciled_payment = v_marked or (v_prev and v_status = 'matched'),
           reviewed_at = now(), reviewed_by = v_uid,
           review_note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 300), ''), review_note)
     where id = v_line.id;
  elsif p_action = 'unlink' then
    if v_line.payment_id is not null and v_line.reconciled_payment then
      perform _settlement_mark_payment(v_tenant, v_line.payment_id, false, v_uid, v_line.id, 'settlement_manual');
    end if;
    update settlement_lines
       set payment_id = null, sale_id = null, match_status = 'missing_in_pos', match_method = null,
           diff_amount = round(gross - refunded, 2), matched_at = null, reconciled_payment = false,
           reviewed_at = now(), reviewed_by = v_uid
     where id = v_line.id;
  else
    raise exception 'invalid_action';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, v_uid, 'settlement_lines', v_line.id, 'settlement_line_' || p_action,
          jsonb_build_object('match_status', v_line.match_status, 'payment_id', v_line.payment_id),
          jsonb_build_object('payment_id', p_payment_id, 'note', left(p_note, 300),
                             'provider', v_line.provider_key, 'external_id', v_line.external_id,
                             'gross', v_line.gross));

  return (select to_jsonb(l) - 'raw' from settlement_lines l where l.id = v_line.id);
end;
$$;
revoke all on function settlement_line_resolve(uuid, text, uuid, text) from public, anon;
grant execute on function settlement_line_resolve(uuid, text, uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- D5) Aplicar el resultado del motor de cruce (Edge `settlements`, service).
--     p_matches: [{ line_id, match_status, match_method, payment_id,
--     intent_id, sale_id, diff_amount }]. Valida que líneas, cobros, intents y
--     ventas sean del negocio; no pisa líneas manuales ni revisadas; marca
--     conciliados los cobros que cierran y desmarca los que marcó y dejaron de
--     cerrar. Devuelve { updated, reconciled, unreconciled }.
-- -----------------------------------------------------------------------------
create or replace function _settlement_apply_matches(p_tenant uuid, p_matches jsonb, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_m      jsonb;
  v_line   settlement_lines%rowtype;
  v_status text;
  v_pay    uuid;
  v_intent uuid;
  v_sale   uuid;
  v_upd    int := 0;
  v_rec    int := 0;
  v_unrec  int := 0;
  v_keep   boolean;
begin
  if p_tenant is null or p_matches is null or jsonb_typeof(p_matches) <> 'array' then
    raise exception 'invalid_args';
  end if;
  if not tenant_has_feature_for(p_tenant, 'conciliacion_procesadores') then
    raise exception 'feature_not_in_plan: conciliacion_procesadores' using errcode = '42501';
  end if;

  for v_m in select * from jsonb_array_elements(p_matches)
  loop
    select * into v_line from settlement_lines
     where id = (v_m ->> 'line_id')::uuid and tenant_id = p_tenant
     for update;
    if not found or v_line.match_status = 'ignored' or v_line.match_method = 'manual' then
      continue;
    end if;
    v_status := v_m ->> 'match_status';
    if v_status not in ('matched', 'amount_diff', 'missing_in_pos') then
      continue;
    end if;
    -- Aislamiento explícito: todo lo vinculado tiene que ser del negocio.
    select p.id, p.sale_id into v_pay, v_sale from payments p
     where p.id = nullif(v_m ->> 'payment_id', '')::uuid and p.tenant_id = p_tenant;
    select i.id into v_intent from mp_payment_intents i
     where i.id = nullif(v_m ->> 'intent_id', '')::uuid and i.tenant_id = p_tenant;
    if v_pay is null and v_status <> 'missing_in_pos' then
      v_status := 'missing_in_pos';
    end if;

    -- Desmarcar si lo marcó esta conciliación y ya no cierra con ese cobro.
    v_keep := v_line.reconciled_payment and v_line.payment_id is not distinct from v_pay and v_status = 'matched';
    if v_line.reconciled_payment and not v_keep and v_line.payment_id is not null then
      if _settlement_mark_payment(p_tenant, v_line.payment_id, false, p_actor, v_line.id, 'settlement_auto') then
        v_unrec := v_unrec + 1;
      end if;
    end if;
    if v_status = 'matched' and not v_keep then
      v_keep := _settlement_mark_payment(p_tenant, v_pay, true, p_actor, v_line.id, 'settlement_auto');
      if v_keep then v_rec := v_rec + 1; end if;
    end if;

    update settlement_lines
       set payment_id = v_pay,
           intent_id = v_intent,
           sale_id = v_sale,
           match_status = v_status,
           match_method = case when v_m ->> 'match_method' in ('provider_id', 'voucher', 'authorization', 'amount_date')
                               then v_m ->> 'match_method' end,
           diff_amount = round(coalesce((v_m ->> 'diff_amount')::numeric, 0), 2),
           matched_at = case when v_pay is not null then coalesce(matched_at, now()) end,
           reconciled_payment = v_keep and v_status = 'matched'
     where id = v_line.id
       and (payment_id is distinct from v_pay
            or intent_id is distinct from v_intent
            or match_status is distinct from v_status
            or diff_amount is distinct from round(coalesce((v_m ->> 'diff_amount')::numeric, 0), 2)
            or reconciled_payment is distinct from (v_keep and v_status = 'matched'));
    if found then v_upd := v_upd + 1; end if;
  end loop;

  return jsonb_build_object('updated', v_upd, 'reconciled', v_rec, 'unreconciled', v_unrec);
end;
$$;
revoke all on function _settlement_apply_matches(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function _settlement_apply_matches(uuid, jsonb, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- D6) Auto-sincronización: el dueño la apaga o prende por proveedor.
-- -----------------------------------------------------------------------------
create or replace function settlement_set_auto_sync(p_provider text, p_auto boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _settlement_assert();
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,40}$' or p_auto is null then
    raise exception 'invalid_args';
  end if;
  insert into settlement_sync_state (tenant_id, provider_key, scope_store_id, auto_sync)
  values (v_tenant, p_provider, null, p_auto)
  on conflict (tenant_id, provider_key, scope_store_id) do update set auto_sync = excluded.auto_sync, updated_at = now();
  insert into audit_logs (tenant_id, actor_user_id, entity_type, action, after_data)
  values (v_tenant, auth.uid(), 'settlement_sync_state', 'settlement_auto_sync_set',
          jsonb_build_object('provider', p_provider, 'auto_sync', p_auto));
end;
$$;
revoke all on function settlement_set_auto_sync(text, boolean) from public, anon;
grant execute on function settlement_set_auto_sync(text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Cron diario: sincroniza Mercado Pago (06:20 de Argentina) y vuelve a
--    cruzar. Mismo patrón que pending_charges_sync (X-Cron-Secret leído de
--    platform_secrets 'internal_cron' en cada corrida).
-- -----------------------------------------------------------------------------
do $cron$
declare
  v_url text := 'https://hrkditzrsavehnhngakb.supabase.co/functions/v1/settlements';
  v_cmd text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omite el job de conciliación de procesadores.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net no disponible; se omite el job de conciliación de procesadores.';
    return;
  end if;

  v_cmd := format($job$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'apikey', (select secrets ->> 'apikey' from platform_secrets where key = 'internal_cron'),
        'X-Cron-Secret', (select secrets ->> 'token' from platform_secrets where key = 'internal_cron')
      ),
      body := '{"mode":"cron"}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$, v_url);

  if exists (select 1 from cron.job where jobname = 'settlements-sync') then
    perform cron.unschedule('settlements-sync');
  end if;
  perform cron.schedule('settlements-sync', '20 9 * * *', v_cmd);
end;
$cron$;
