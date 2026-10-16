-- =============================================================================
-- 20261231100100_conciliacion_bancaria  (F23 · H152, ADR-162)
--
-- Extracto del banco contra Tesorería y "a acreditar" con fecha:
--
--   A) Feature nueva conciliacion_bancaria (OPTIONAL, Business y Enterprise),
--      convención CLAUDE.md §6: key en features, marcada en plans.limits.modules,
--      gating real en las RPC (bank_statement_assert), copy en featureInfo y
--      comparación de planes derivada.
--   B) bank_statement_imports / bank_statement_lines: el extracto subido
--      (CSV o XLSX, el mapeo de columnas y los presets de bancos viven en el
--      front, lib/treasury/bankStatement.ts) con matching contra los
--      movimientos de la cuenta: mismo importe al centavo, primero el mismo
--      día y después hasta 4 días de diferencia si hay un solo candidato. Lo
--      que coincide queda tildado (treasury_movements.reconciled_at); lo que
--      no, en "Pendientes de revisar" para vincular, ignorar o crear el
--      movimiento (comisión del banco, impuesto, transferencia no cargada).
--   C) A acreditar con fecha estimada: _treasury_pending devuelve la fecha de
--      acreditación de la liquidación si ya llegó sin liberar, o la estimada
--      por medio (débito 2 días, crédito 14, QR y billeteras 1). La usan la
--      pantalla A acreditar y el flujo de fondos (T6).
--
-- Seguridad: tenant_id + RLS con (select current_tenant_id()) y
-- (select internal_scope()); sin escritura directa (todo por RPC SECURITY
-- DEFINER con treasury_assert + la feature) y audit_logs en cada acción.
-- Tablas nuevas: no hay datos que migrar.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Feature.
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('conciliacion_bancaria', 'Conciliación bancaria',
   'Subí el extracto del banco o de la billetera (CSV o Excel, con los formatos de los bancos más usados) y se tilda solo contra los movimientos de Tesorería; lo que no coincide queda para revisar',
   'reportes', false, 177)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('conciliacion_bancaria', p.key in ('business', 'enterprise')),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'conciliacion_bancaria');

create or replace function treasury_can_view()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(stock_my_role() in ('owner', 'manager'), false);
$$;
revoke all on function treasury_can_view() from public, anon;
grant execute on function treasury_can_view() to authenticated;

create or replace function bank_statement_assert()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
begin
  if not tenant_has_feature_for(v_tenant, 'conciliacion_bancaria') then
    raise exception 'feature_not_in_plan: conciliacion_bancaria';
  end if;
  return v_tenant;
end;
$$;
revoke all on function bank_statement_assert() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Extractos.
-- -----------------------------------------------------------------------------
create table if not exists bank_statement_imports (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  treasury_account_id uuid not null references treasury_accounts(id),
  file_name           text check (file_name is null or char_length(file_name) <= 200),
  bank_preset         text check (bank_preset is null or bank_preset ~ '^[a-z0-9_]{2,40}$'),
  period_from         date,
  period_to           date,
  row_count           integer not null default 0,
  inserted_count      integer not null default 0,
  matched_count       integer not null default 0,
  created_by          uuid default auth.uid(),
  created_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  deleted_by          uuid
);
comment on table bank_statement_imports is
  'ADR-162 (H152): extractos de banco o billetera subidos para conciliar contra Tesorería. Escritura por RPC.';
create index if not exists bank_statement_imports_tenant_idx
  on bank_statement_imports(tenant_id, created_at desc) where deleted_at is null;
create index if not exists bank_statement_imports_account_idx on bank_statement_imports(treasury_account_id);

create table if not exists bank_statement_lines (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  import_id            uuid not null references bank_statement_imports(id),
  treasury_account_id  uuid not null references treasury_accounts(id),
  line_date            date not null,
  description          text check (description is null or char_length(description) <= 300),
  reference            text check (reference is null or char_length(reference) <= 80),
  amount               numeric(16,2) not null check (amount <> 0),
  balance              numeric(16,2),
  line_key             text not null,
  match_status         text not null default 'pending' check (match_status in ('pending', 'matched', 'ignored')),
  match_method         text check (match_method is null or match_method in ('auto_exact', 'auto_near', 'manual', 'created')),
  treasury_movement_id uuid references treasury_movements(id),
  matched_at           timestamptz,
  matched_by           uuid,
  review_note          text check (review_note is null or char_length(review_note) <= 300),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  constraint bank_statement_lines_match_shape
    check ((match_status = 'matched') = (treasury_movement_id is not null))
);
comment on table bank_statement_lines is
  'ADR-162 (H152): renglones del extracto. matched = vinculado a un movimiento de Tesorería (que queda conciliado). Escritura por RPC.';
create unique index if not exists bank_statement_lines_key_uidx
  on bank_statement_lines(treasury_account_id, line_key) where deleted_at is null;
create unique index if not exists bank_statement_lines_movement_uidx
  on bank_statement_lines(treasury_movement_id) where deleted_at is null and treasury_movement_id is not null;
create index if not exists bank_statement_lines_import_idx on bank_statement_lines(import_id);
create index if not exists bank_statement_lines_pending_idx
  on bank_statement_lines(tenant_id, treasury_account_id, line_date) where deleted_at is null and match_status = 'pending';

drop trigger if exists set_updated_at_bank_statement_lines on bank_statement_lines;
create trigger set_updated_at_bank_statement_lines
  before update on bank_statement_lines
  for each row execute function set_updated_at();

alter table bank_statement_imports enable row level security;
alter table bank_statement_lines enable row level security;
drop policy if exists bank_statement_imports_select on bank_statement_imports;
create policy bank_statement_imports_select on bank_statement_imports
  for select using ((tenant_id = (select current_tenant_id()) and (select treasury_can_view()))
                    or (select internal_scope()));
drop policy if exists bank_statement_lines_select on bank_statement_lines;
create policy bank_statement_lines_select on bank_statement_lines
  for select using ((tenant_id = (select current_tenant_id()) and (select treasury_can_view()))
                    or (select internal_scope()));
revoke insert, update, delete on bank_statement_imports, bank_statement_lines from anon, authenticated;
grant select on bank_statement_imports, bank_statement_lines to authenticated;

-- Texto normalizado para la clave del renglón (sin tildes ni espacios dobles).
create or replace function bank_statement_norm(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select lower(regexp_replace(translate(coalesce(p, ''), 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'), '\s+', ' ', 'g'));
$$;

-- Marca un renglón como vinculado y concilia el movimiento.
create or replace function _bank_statement_link(p_line uuid, p_movement uuid, p_method text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  l bank_statement_lines%rowtype;
begin
  select * into l from bank_statement_lines where id = p_line;
  update bank_statement_lines
     set match_status = 'matched', match_method = p_method, treasury_movement_id = p_movement,
         matched_at = now(), matched_by = auth.uid(),
         review_note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 300), ''), review_note)
   where id = p_line;
  update treasury_movements
     set reconciled_at = coalesce(reconciled_at, now()),
         reconciled_by = coalesce(reconciled_by, auth.uid()),
         statement_ref = coalesce(statement_ref,
                                  left('Extracto ' || to_char(l.line_date, 'DD/MM/YYYY')
                                       || coalesce(' · ' || nullif(btrim(l.reference), ''), ''), 80))
   where id = p_movement;
end;
$$;
revoke all on function _bank_statement_link(uuid, uuid, text, text) from public, anon, authenticated;

-- Matching de los renglones pendientes de una cuenta (o de un extracto):
--   1. mismo importe al centavo y mismo día;
--   2. mismo importe y hasta 4 días de diferencia, sólo si hay un único
--      movimiento candidato (si hay dos, queda para revisar).
-- Nunca usa un movimiento anulado ni uno ya vinculado a otro renglón.
create or replace function _bank_statement_match(p_tenant uuid, p_account uuid, p_import uuid default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  l     record;
  v_mv  uuid;
  v_n   int := 0;
  v_cnt int;
begin
  for l in
    select b.* from bank_statement_lines b
     where b.tenant_id = p_tenant and b.treasury_account_id = p_account and b.deleted_at is null
       and b.match_status = 'pending' and (p_import is null or b.import_id = p_import)
     order by b.line_date, b.created_at, b.id
  loop
    v_mv := null;
    select m.id into v_mv
      from treasury_movements m
     where m.tenant_id = p_tenant and m.account_id = p_account and m.voided_at is null
       and m.amount = l.amount and m.movement_date = l.line_date
       and not exists (select 1 from bank_statement_lines x
                        where x.treasury_movement_id = m.id and x.deleted_at is null)
     order by (m.reconciled_at is null) desc,
              (l.reference is not null and position(lower(l.reference) in lower(coalesce(m.description, '') || ' ' || coalesce(m.statement_ref, ''))) > 0) desc,
              m.created_at
     limit 1;
    if v_mv is not null then
      perform _bank_statement_link(l.id, v_mv, 'auto_exact');
      v_n := v_n + 1;
      continue;
    end if;
    select count(*), min(m.id::text)::uuid into v_cnt, v_mv
      from treasury_movements m
     where m.tenant_id = p_tenant and m.account_id = p_account and m.voided_at is null
       and m.amount = l.amount and abs(m.movement_date - l.line_date) <= 4
       and not exists (select 1 from bank_statement_lines x
                        where x.treasury_movement_id = m.id and x.deleted_at is null);
    if v_cnt = 1 then
      perform _bank_statement_link(l.id, v_mv, 'auto_near');
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
revoke all on function _bank_statement_match(uuid, uuid, uuid) from public, anon, authenticated;

-- Subir un extracto. p_lines: [{date: 'aaaa-mm-dd', description, reference,
-- amount (positivo entra, negativo sale), balance?}]. Idempotente por renglón
-- (fecha, importe, descripción, referencia y repetición dentro del archivo):
-- volver a subir el mismo extracto no duplica nada.
create or replace function bank_statement_import(p_account uuid, p_file_name text, p_preset text, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := bank_statement_assert();
  ta        treasury_accounts;
  v_imp     uuid;
  v_rows    int;
  v_ins     int := 0;
  v_matched int := 0;
  v_from    date;
  v_to      date;
begin
  ta := treasury_account_get(v_tenant, p_account);
  if ta.kind not in ('bank', 'wallet', 'cash') then
    raise exception 'treasury_system_account';
  end if;
  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid_lines';
  end if;
  v_rows := jsonb_array_length(p_lines);
  if v_rows = 0 or v_rows > 5000 then
    raise exception 'invalid_lines';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) e
     where coalesce(e ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$'
        or coalesce(e ->> 'amount', '') !~ '^-?\d+(\.\d+)?$'
        or (e ->> 'amount')::numeric = 0
        or (e ->> 'balance' is not null and e ->> 'balance' !~ '^-?\d+(\.\d+)?$')
  ) then
    raise exception 'invalid_lines';
  end if;
  select min((e ->> 'date')::date), max((e ->> 'date')::date) into v_from, v_to from jsonb_array_elements(p_lines) e;
  if v_from < date '2000-01-01' or v_to > acc_ar_date(now()) + 1 then
    raise exception 'invalid_lines';
  end if;

  insert into bank_statement_imports (tenant_id, treasury_account_id, file_name, bank_preset, period_from, period_to, row_count)
  values (v_tenant, ta.id, left(nullif(btrim(coalesce(p_file_name, '')), ''), 200),
          nullif(lower(btrim(coalesce(p_preset, ''))), ''), v_from, v_to, v_rows)
  returning id into v_imp;

  with src as (
    select (e ->> 'date')::date as d,
           left(nullif(btrim(coalesce(e ->> 'description', '')), ''), 300) as descr,
           left(nullif(btrim(coalesce(e ->> 'reference', '')), ''), 80) as ref,
           round((e ->> 'amount')::numeric, 2) as amt,
           round(nullif(e ->> 'balance', '')::numeric, 2) as bal,
           o
      from jsonb_array_elements(p_lines) with ordinality as x(e, o)
  ), keyed as (
    select s.*, md5(s.d::text || '|' || s.amt::text || '|' || bank_statement_norm(s.descr) || '|'
                    || coalesce(bank_statement_norm(s.ref), '') || '|'
                    || row_number() over (partition by s.d, s.amt, bank_statement_norm(s.descr),
                                                       coalesce(bank_statement_norm(s.ref), '') order by s.o)) as k
      from src s
  ), ins as (
    insert into bank_statement_lines (tenant_id, import_id, treasury_account_id, line_date, description, reference,
                                      amount, balance, line_key)
    select v_tenant, v_imp, ta.id, k.d, k.descr, k.ref, k.amt, k.bal, k.k
      from keyed k
     order by k.o
    on conflict (treasury_account_id, line_key) where deleted_at is null do nothing
    returning 1
  )
  select count(*) into v_ins from ins;

  v_matched := _bank_statement_match(v_tenant, ta.id, v_imp);
  update bank_statement_imports set inserted_count = v_ins, matched_count = v_matched where id = v_imp;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'bank_statement_imports', v_imp, 'bank_statement_imported',
          jsonb_build_object('treasury_account_id', ta.id, 'file_name', p_file_name, 'preset', p_preset,
                             'rows', v_rows, 'inserted', v_ins, 'matched', v_matched,
                             'from', v_from, 'to', v_to));
  return jsonb_build_object('import_id', v_imp, 'rows', v_rows, 'inserted', v_ins,
                            'duplicates', v_rows - v_ins, 'matched', v_matched,
                            'pending', (select count(*) from bank_statement_lines
                                         where import_id = v_imp and match_status = 'pending' and deleted_at is null));
end;
$$;
revoke all on function bank_statement_import(uuid, text, text, jsonb) from public, anon;
grant execute on function bank_statement_import(uuid, text, text, jsonb) to authenticated;

-- Volver a cruzar los pendientes de una cuenta (después de cargar movimientos).
create or replace function bank_statement_rematch(p_account uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := bank_statement_assert();
  ta       treasury_accounts;
  v_n      int;
begin
  ta := treasury_account_get(v_tenant, p_account);
  v_n := _bank_statement_match(v_tenant, ta.id, null);
  if v_n > 0 then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (v_tenant, auth.uid(), 'treasury_accounts', ta.id, 'bank_statement_rematched',
            jsonb_build_object('matched', v_n));
  end if;
  return v_n;
end;
$$;
revoke all on function bank_statement_rematch(uuid) from public, anon;
grant execute on function bank_statement_rematch(uuid) to authenticated;

-- Resolver un renglón:
--   link     vincular con un movimiento de la misma cuenta y el mismo importe
--   unlink   desvincular (el movimiento deja de estar conciliado)
--   ignore   no corresponde a ningún movimiento (con motivo)
--   unignore volver a pendiente
--   create   crear el movimiento desde el renglón y vincularlo: un ingreso o un
--            retiro (con cuenta de gasto opcional en p.expense_account_id, como
--            un gasto de Tesorería) con la fecha y el detalle del extracto.
create or replace function bank_statement_line_resolve(p_line uuid, p_action text, p_movement uuid default null,
                                                       p_note text default null, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := bank_statement_assert();
  l        bank_statement_lines%rowtype;
  m        treasury_movements%rowtype;
  v_new    uuid;
begin
  select * into l from bank_statement_lines
   where id = p_line and tenant_id = v_tenant and deleted_at is null
   for update;
  if l.id is null then
    raise exception 'line_not_found' using errcode = '42501';
  end if;

  if p_action = 'link' then
    if l.match_status = 'matched' then
      raise exception 'line_already_matched';
    end if;
    select * into m from treasury_movements
     where id = p_movement and tenant_id = v_tenant and account_id = l.treasury_account_id and voided_at is null;
    if m.id is null then
      raise exception 'movement_not_found';
    end if;
    if m.amount <> l.amount then
      raise exception 'amount_mismatch';
    end if;
    if exists (select 1 from bank_statement_lines x where x.treasury_movement_id = m.id and x.deleted_at is null) then
      raise exception 'movement_already_linked';
    end if;
    perform _bank_statement_link(l.id, m.id, 'manual', p_note);
  elsif p_action = 'unlink' then
    if l.match_status <> 'matched' then
      raise exception 'line_not_matched';
    end if;
    update bank_statement_lines
       set match_status = 'pending', match_method = null, treasury_movement_id = null,
           matched_at = null, matched_by = null
     where id = l.id;
    update treasury_movements
       set reconciled_at = null, reconciled_by = null, statement_ref = null
     where id = l.treasury_movement_id and statement_ref like 'Extracto %';
  elsif p_action = 'ignore' then
    if char_length(btrim(coalesce(p_note, ''))) < 3 then
      raise exception 'reason_required';
    end if;
    if l.match_status = 'matched' then
      raise exception 'line_already_matched';
    end if;
    update bank_statement_lines
       set match_status = 'ignored', review_note = left(btrim(p_note), 300), matched_at = now(), matched_by = auth.uid()
     where id = l.id;
  elsif p_action = 'unignore' then
    update bank_statement_lines
       set match_status = 'pending', review_note = null, matched_at = null, matched_by = null
     where id = l.id and match_status = 'ignored';
  elsif p_action = 'create' then
    if l.match_status <> 'pending' then
      raise exception 'line_not_pending';
    end if;
    v_new := treasury_movement_create(jsonb_build_object(
      'account_id', l.treasury_account_id,
      'type', case when l.amount > 0 then 'deposit' else 'withdrawal' end,
      'amount', abs(l.amount),
      'date', l.line_date,
      'description', coalesce(nullif(btrim(coalesce(p ->> 'description', '')), ''), l.description, 'Movimiento del extracto'),
      'expense_account_id', case when l.amount < 0 then nullif(p ->> 'expense_account_id', '') end,
      'receipt_vat', case when l.amount < 0 then nullif(p ->> 'receipt_vat', '') end));
    perform _bank_statement_link(l.id, v_new, 'created', p_note);
  else
    raise exception 'invalid_action';
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'bank_statement_lines', l.id, 'bank_statement_line_' || p_action,
          jsonb_build_object('match_status', l.match_status, 'treasury_movement_id', l.treasury_movement_id),
          jsonb_build_object('treasury_movement_id', coalesce(v_new, p_movement), 'amount', l.amount,
                             'date', l.line_date, 'account_id', l.treasury_account_id),
          nullif(left(btrim(coalesce(p_note, '')), 300), ''));
  return (select to_jsonb(x) from bank_statement_lines x where x.id = l.id);
end;
$$;
revoke all on function bank_statement_line_resolve(uuid, text, uuid, text, jsonb) from public, anon;
grant execute on function bank_statement_line_resolve(uuid, text, uuid, text, jsonb) to authenticated;

-- Borrar un extracto (baja lógica): sus renglones dejan de contar y los
-- movimientos que había conciliado vuelven a pendientes.
create or replace function bank_statement_import_delete(p_import uuid, p_reason text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := bank_statement_assert();
  i        bank_statement_imports%rowtype;
  v_n      int;
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'reason_required';
  end if;
  select * into i from bank_statement_imports where id = p_import and tenant_id = v_tenant and deleted_at is null;
  if i.id is null then
    raise exception 'import_not_found';
  end if;
  update treasury_movements m
     set reconciled_at = null, reconciled_by = null, statement_ref = null
    from bank_statement_lines l
   where l.import_id = i.id and l.deleted_at is null and l.treasury_movement_id = m.id
     and m.statement_ref like 'Extracto %';
  update bank_statement_lines set deleted_at = now() where import_id = i.id and deleted_at is null;
  get diagnostics v_n = row_count;
  update bank_statement_imports set deleted_at = now(), deleted_by = auth.uid() where id = i.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (v_tenant, auth.uid(), 'bank_statement_imports', i.id, 'bank_statement_deleted',
          jsonb_build_object('lines', v_n, 'treasury_account_id', i.treasury_account_id), btrim(p_reason));
  return v_n;
end;
$$;
revoke all on function bank_statement_import_delete(uuid, text) from public, anon;
grant execute on function bank_statement_import_delete(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- C) A acreditar con fecha (T6).
-- -----------------------------------------------------------------------------
-- Fecha estimada de acreditación de un cobro que todavía no tiene liquidación:
-- débito 2 días, crédito 14 (10 hábiles), QR, billeteras y Directo 1,
-- Mercado Libre 14, plataformas 7. Es un estimado: la fecha real llega con la
-- liquidación.
create or replace function treasury_expected_release(p_method text, p_provider text, p_at timestamptz)
returns date
language sql
immutable
set search_path = public, pg_temp
as $$
  select ((p_at at time zone 'America/Argentina/Buenos_Aires')::date
          + case
              when p_method = 'debit' then 2
              when p_method = 'credit' then 14
              when p_method = 'mercadolibre' then 14
              when p_method = 'plataforma' then 7
              else 1
            end)::date;
$$;

drop function if exists treasury_pending_collections(text);
drop function if exists _treasury_pending(uuid);

-- Cobros sin liquidar (definición viva de ADR-158) + fecha de acreditación:
-- la de la liquidación si ya llegó sin liberar, si no la estimada.
create or replace function _treasury_pending(p_tenant uuid)
returns table (payment_id uuid, sale_id uuid, sale_number bigint, method text, provider_key text,
               amount numeric, created_at timestamptz, store_id uuid, expected_date date, expected_known boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select x.id, x.sale_id, x.number, x.method, x.prov, x.amount, x.created_at, x.store_id,
         coalesce(x.release, treasury_expected_release(x.method, x.prov, x.created_at)),
         x.release is not null
    from (
      select p.id, p.sale_id, s.number, p.method,
             treasury_payment_provider(p_tenant, p.method, p.reference, p.card_voucher) as prov,
             p.amount, p.created_at, s.store_id,
             (select acc_ar_date(sl.release_date) from settlement_lines sl
               where sl.payment_id = p.id and sl.tenant_id = p_tenant and not sl.released
                 and sl.release_date is not null
               order by sl.release_date limit 1) as release
        from payments p
        join sales s on s.id = p.sale_id and s.status = 'completed'
       where p.tenant_id = p_tenant
         and p.created_at >= now() - interval '180 days'
         and p.method in ('debit', 'credit', 'qr', 'directo', 'ualabis', 'mercadolibre', 'plataforma')
         and p.reconciled_at is null
         and coalesce(p.amount, 0) > 0
         and not exists (select 1 from settlement_lines sl
                          where sl.payment_id = p.id and sl.tenant_id = p_tenant and sl.released)
    ) x
   where x.prov is not null;
$$;
revoke all on function _treasury_pending(uuid) from public, anon, authenticated;

create or replace function treasury_pending_collections(p_provider text default null)
returns table (payment_id uuid, sale_id uuid, sale_number bigint, method text, provider_key text,
               amount numeric, created_at timestamptz, store_id uuid, expected_date date, expected_known boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := treasury_assert();
begin
  return query
    select t.payment_id, t.sale_id, t.sale_number, t.method, t.provider_key, round(t.amount, 2), t.created_at,
           t.store_id, t.expected_date, t.expected_known
      from _treasury_pending(v_tenant) t
     where p_provider is null or t.provider_key = p_provider
     order by t.expected_date, t.created_at desc
     limit 2000;
end;
$$;
revoke all on function treasury_pending_collections(text) from public, anon;
grant execute on function treasury_pending_collections(text) to authenticated;
