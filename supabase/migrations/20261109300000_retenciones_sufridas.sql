-- =============================================================================
-- 20261109300000_retenciones_sufridas  (F18 · H106 como SUJETO, ADR-095)
--
-- Registro de las retenciones, percepciones y pagos a cuenta que el negocio
-- SUFRE (no las que practica: esas son tax_withholdings, ADR-079):
--
--   A) tax_suffered_entries: una fila por retención o percepción sufrida con
--      impuesto, tipo (retención, percepción, pago a cuenta), régimen
--      (general, SIRCREB, SIRTAC, procesador), jurisdicción de IIBB, período
--      de imputación (el mes de la DDJJ donde se toma como saldo a favor),
--      agente (CUIT), certificado y el documento donde está la plata que
--      falta: un cobro de venta (payments), un cobro de cuenta corriente
--      (customer_account_movements), una línea de liquidación de un
--      procesador (settlement_lines) o un débito del banco
--      (treasury_movements). Las percepciones de facturas de proveedor siguen
--      en la vista tax_suffered (ADR-068) y se suman en los reportes.
--   B) _tax_jurisdiction_code y _tax_suffered_classify: clasifican el texto
--      del impuesto (Mercado Pago charges_details, columnas de un archivo de
--      liquidación, extracto). ESPEJO EXACTO de lib/tax/suffered.ts
--      (classifyTaxText, jurisdictionFromText): \y en SQL = \b en JS.
--   C) Desde las liquidaciones de procesadores (ADR-061): cada impuesto de
--      settlement_lines.fee_detail (kind = 'tax') pasa a una fila con clave
--      'sl:<línea>:<posición>' (idempotente). Lo hace un trigger al importar
--      o sincronizar la liquidación y la RPC tax_suffered_sync_settlements
--      para lo ya importado. El IVA sobre la comisión NO es una retención
--      (es crédito fiscal) y se saltea.
--   D) RPC: tax_suffered_register (alta manual, con alta opcional del débito
--      en la cuenta bancaria de tesorería), tax_suffered_update (impuesto,
--      jurisdicción, período, vínculo, revisión), tax_suffered_void,
--      tax_suffered_import (Mis Retenciones, SIRCREB, SIRTAC o planilla),
--      tax_suffered_list y tax_suffered_export (auditada).
--
-- El asiento contable (reclasificación desde la cuenta del documento a la de
-- retenciones sufridas del impuesto) está en 20261109300200.
--
-- Seguridad:
--   • Lectura: dueño o encargado del negocio (RESTRICTIVE tax_ret_can_read) o
--     staff con internal_scope(). Sin escritura por PostgREST: sólo RPC
--     SECURITY DEFINER y el trigger de liquidaciones. role_write_guard
--     'manage' (ADR-071).
--   • Gating: percepciones_retenciones (tenant_has_feature_for) en las RPC
--     (_tax_ret_assert, ADR-079) y en el trigger de liquidaciones.
--   • audit_logs en cada alta, cambio, anulación, importación y exportación.
--   • Un mes de IIBB ya liquidado (iibb_liquidations, 20261109300100) no se
--     puede tocar: la guarda está en el trigger de esta tabla.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Tabla
-- -----------------------------------------------------------------------------
create table if not exists tax_suffered_entries (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  store_id             uuid references stores(id) on delete set null,
  tax                  text not null check (tax in ('iibb', 'iva', 'ganancias', 'suss', 'debitos_creditos', 'otro')),
  kind                 text not null check (kind in ('retencion', 'percepcion', 'pago_a_cuenta')),
  regime               text not null default 'general'
                         check (regime in ('general', 'sircreb', 'sirtac', 'procesador', 'otro')),
  jurisdiction         text references tax_jurisdictions(code),
  origin               text not null check (origin in ('cliente', 'procesador', 'banco', 'manual', 'importado')),
  operation_date       date not null,
  period               date not null check (period = date_trunc('month', period)::date),
  amount               numeric(14,2) not null check (amount > 0),
  base_amount          numeric(14,2) check (base_amount is null or base_amount >= 0),
  rate                 numeric(7,4) check (rate is null or (rate >= 0 and rate <= 100)),
  agent_cuit           text,
  agent_name           text check (agent_name is null or char_length(agent_name) <= 120),
  certificate          text check (certificate is null or char_length(certificate) <= 40),
  customer_id          uuid references customers(id) on delete set null,
  payment_id           uuid references payments(id) on delete set null,
  cc_movement_id       uuid references customer_account_movements(id) on delete set null,
  settlement_line_id   uuid references settlement_lines(id) on delete set null,
  treasury_movement_id uuid references treasury_movements(id) on delete set null,
  source_key           text check (source_key is null or char_length(source_key) <= 200),
  needs_review         boolean not null default false,
  notes                text check (notes is null or char_length(notes) <= 300),
  status               text not null default 'active' check (status in ('active', 'voided')),
  voided_at            timestamptz,
  voided_by            uuid references public.users(id) on delete set null,
  void_reason          text check (void_reason is null or char_length(void_reason) <= 300),
  created_by           uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint tax_suffered_entries_agent_cuit
    check (agent_cuit is null or (agent_cuit ~ '^\d{11}$' and cuit_is_valid(agent_cuit))),
  -- La jurisdicción es de IIBB. Una de IIBB sin jurisdicción queda "para
  -- revisar" y no entra en la liquidación hasta que se la asignen.
  constraint tax_suffered_entries_jurisdiction
    check (jurisdiction is null or tax = 'iibb'),
  constraint tax_suffered_entries_review
    check (tax <> 'iibb' or jurisdiction is not null or needs_review),
  constraint tax_suffered_entries_kind
    check ((tax = 'debitos_creditos') = (kind = 'pago_a_cuenta')),
  constraint tax_suffered_entries_one_link
    check (num_nonnulls(payment_id, cc_movement_id, settlement_line_id, treasury_movement_id) <= 1),
  constraint tax_suffered_entries_void
    check ((status = 'voided') = (voided_at is not null))
);

comment on table tax_suffered_entries is
  'Retenciones, percepciones y pagos a cuenta SUFRIDOS por el negocio (ADR-095): saldo a favor por impuesto y jurisdicción para la DDJJ. Las percepciones de facturas de proveedor siguen en la vista tax_suffered.';
comment on column tax_suffered_entries.period is
  'Mes de imputación (primer día): la DDJJ donde se toma como saldo a favor. Por defecto el mes de la fecha.';
comment on column tax_suffered_entries.source_key is
  'Clave de idempotencia: sl:<línea>:<posición> para liquidaciones de procesadores, imp:<hash> para importaciones.';

create unique index if not exists tax_suffered_entries_source_key
  on tax_suffered_entries (tenant_id, source_key) where source_key is not null;
create index if not exists tax_suffered_entries_period_idx
  on tax_suffered_entries (tenant_id, period, tax, jurisdiction) where status = 'active';
create index if not exists tax_suffered_entries_date_idx
  on tax_suffered_entries (tenant_id, operation_date desc);
-- Índices de las FK (guard de rendimiento F4).
create index if not exists tax_suffered_entries_store_idx
  on tax_suffered_entries (store_id) where store_id is not null;
create index if not exists tax_suffered_entries_customer_idx
  on tax_suffered_entries (customer_id) where customer_id is not null;
create index if not exists tax_suffered_entries_payment_idx
  on tax_suffered_entries (payment_id) where payment_id is not null;
create index if not exists tax_suffered_entries_cc_idx
  on tax_suffered_entries (cc_movement_id) where cc_movement_id is not null;
create index if not exists tax_suffered_entries_settlement_idx
  on tax_suffered_entries (settlement_line_id) where settlement_line_id is not null;
create index if not exists tax_suffered_entries_treasury_idx
  on tax_suffered_entries (treasury_movement_id) where treasury_movement_id is not null;
create index if not exists tax_suffered_entries_jurisdiction_idx
  on tax_suffered_entries (jurisdiction) where jurisdiction is not null;
create index if not exists tax_suffered_entries_voided_by_idx
  on tax_suffered_entries (voided_by) where voided_by is not null;
create index if not exists tax_suffered_entries_created_by_idx
  on tax_suffered_entries (created_by) where created_by is not null;

drop trigger if exists set_updated_at_tax_suffered_entries on tax_suffered_entries;
create trigger set_updated_at_tax_suffered_entries
  before update on tax_suffered_entries
  for each row execute function set_updated_at();

alter table tax_suffered_entries enable row level security;
drop policy if exists tax_suffered_entries_select on tax_suffered_entries;
create policy tax_suffered_entries_select on tax_suffered_entries for select
  using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
drop policy if exists tax_suffered_entries_role on tax_suffered_entries;
create policy tax_suffered_entries_role on tax_suffered_entries as restrictive for select
  using ((select tax_ret_can_read()));
revoke all on tax_suffered_entries from anon;
revoke insert, update, delete on tax_suffered_entries from authenticated;
grant select on tax_suffered_entries to authenticated;

drop trigger if exists role_write_guard on tax_suffered_entries;
create trigger role_write_guard before insert or update or delete on tax_suffered_entries
  for each row execute function trg_role_write_guard('manage');

-- -----------------------------------------------------------------------------
-- B) Clasificación del texto (espejo de lib/tax/suffered.ts)
-- -----------------------------------------------------------------------------
create or replace function _tax_text_norm(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select translate(lower(coalesce(p, '')), 'áéíóúüñ_-./', 'aeiouun    ');
$$;

-- Código de jurisdicción mencionado en un texto ("CABA", "Buenos Aires",
-- "902", "Retención IIBB Córdoba"). null si no hay ninguno.
create or replace function _tax_jurisdiction_code(p text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  t text := _tax_text_norm(p);
  v text;
begin
  if btrim(t) = '' then
    return null;
  end if;
  v := substring(t from '\y9(?:0[1-9]|1[0-9]|2[0-4])\y');
  if v is not null then return v; end if;
  if t ~ '(\ycaba\y|ciudad autonoma|ciudad de buenos aires|capital federal|\yagip\y|\yarciba\y)' then return '901'; end if;
  if t ~ '(\yarba\y|provincia de buenos aires|\ypba\y|\ybs as\y|buenos aires)' then return '902'; end if;
  if t ~ 'catamarca' then return '903'; end if;
  if t ~ 'cordoba' then return '904'; end if;
  if t ~ 'corrientes' then return '905'; end if;
  if t ~ 'chaco' then return '906'; end if;
  if t ~ 'chubut' then return '907'; end if;
  if t ~ 'entre rios' then return '908'; end if;
  if t ~ 'formosa' then return '909'; end if;
  if t ~ 'jujuy' then return '910'; end if;
  if t ~ 'la pampa' then return '911'; end if;
  if t ~ 'la rioja' then return '912'; end if;
  if t ~ 'mendoza' then return '913'; end if;
  if t ~ 'misiones' then return '914'; end if;
  if t ~ 'neuquen' then return '915'; end if;
  if t ~ 'rio negro' then return '916'; end if;
  if t ~ 'salta' then return '917'; end if;
  if t ~ 'san juan' then return '918'; end if;
  if t ~ 'san luis' then return '919'; end if;
  if t ~ 'santa cruz' then return '920'; end if;
  if t ~ 'santa fe' then return '921'; end if;
  if t ~ 'santiago del estero' then return '922'; end if;
  if t ~ 'tierra del fuego' then return '923'; end if;
  if t ~ 'tucuman' then return '924'; end if;
  return null;
end;
$$;

-- {skip, tax, kind, regime, jurisdiction, needs_review}
create or replace function _tax_suffered_classify(p_text text, p_default_jur text default null,
                                                  p_default_regime text default 'procesador')
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  t text := _tax_text_norm(p_text);
  v_skip boolean;
  v_regime text;
  v_tax text;
  v_kind text;
  v_jur text;
  v_review boolean;
begin
  v_skip := t ~ '\yiva\y' and t ~ '(comision|\yfee\y|arancel|servicio)' and t !~ '(reten|percep|withholding|perception)';
  v_regime := case when t ~ 'sirtac' then 'sirtac' when t ~ 'sircreb' then 'sircreb' else p_default_regime end;
  v_tax := case
    when t ~ '(debitos? y creditos?|debitos creditos|25413|25 413|impuesto al cheque|imp cheque|\yidc\y)' then 'debitos_creditos'
    when t ~ '(iibb|ingresos brutos|sirtac|sircreb|\yarba\y|\yagip\y|\yiibb\y)' then 'iibb'
    when t ~ 'ganancias' then 'ganancias'
    when t ~ '\yiva\y' then 'iva'
    when t ~ '(\ysuss\y|seguridad social)' then 'suss'
    else 'otro' end;
  v_kind := case when v_tax = 'debitos_creditos' then 'pago_a_cuenta'
                 when t ~ '(percep|perception)' then 'percepcion'
                 else 'retencion' end;
  v_review := v_tax = 'otro';
  if v_tax = 'iibb' then
    v_jur := _tax_jurisdiction_code(t);
    if v_jur is null then
      v_jur := p_default_jur;
      v_review := true;
    end if;
  end if;
  return jsonb_build_object('skip', v_skip, 'tax', v_tax, 'kind', v_kind, 'regime', v_regime,
                            'jurisdiction', v_jur, 'needs_review', v_review);
end;
$$;

revoke all on function _tax_text_norm(text) from public, anon, authenticated;
revoke all on function _tax_jurisdiction_code(text) from public, anon, authenticated;
revoke all on function _tax_suffered_classify(text, text, text) from public, anon, authenticated;
-- Paridad con lib/tax/suffered.ts desde la integración (service role).
grant execute on function _tax_suffered_classify(text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- Guarda: anuladas inmutables; importe, fecha, origen y clave no cambian; un
-- mes de IIBB liquidado no se toca (ni para entrar ni para salir).
-- iibb_period_locked se define acá y se completa en 20261109300100 (la tabla
-- de liquidaciones todavía no existe: devuelve false hasta entonces).
-- -----------------------------------------------------------------------------
create or replace function iibb_period_locked(p_tenant uuid, p_jur text, p_period date)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_jur is null or p_period is null or to_regclass('public.iibb_liquidations') is null then
    return false;
  end if;
  return exists (select 1 from iibb_liquidations l
                  where l.tenant_id = p_tenant and l.jurisdiction = p_jur
                    and l.period = date_trunc('month', p_period)::date and l.status = 'confirmed');
end;
$$;
revoke all on function iibb_period_locked(uuid, text, date) from public, anon, authenticated;

create or replace function trg_tax_suffered_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.tax = 'iibb' and new.status = 'active' and iibb_period_locked(new.tenant_id, new.jurisdiction, new.period) then
      raise exception 'iibb_period_liquidated';
    end if;
    return new;
  end if;
  if old.status = 'voided' then
    raise exception 'suffered_voided';
  end if;
  if (new.tenant_id, new.amount, new.operation_date, new.origin, new.source_key, new.created_at, new.created_by)
     is distinct from
     (old.tenant_id, old.amount, old.operation_date, old.origin, old.source_key, old.created_at, old.created_by) then
    raise exception 'suffered_immutable';
  end if;
  if old.tax = 'iibb' and iibb_period_locked(old.tenant_id, old.jurisdiction, old.period)
     and (new.status, new.tax, new.kind, new.regime, new.jurisdiction, new.period)
         is distinct from (old.status, old.tax, old.kind, old.regime, old.jurisdiction, old.period) then
    raise exception 'iibb_period_liquidated';
  end if;
  if new.tax = 'iibb' and new.status = 'active' and iibb_period_locked(new.tenant_id, new.jurisdiction, new.period)
     and (new.tax, new.kind, new.regime, new.jurisdiction, new.period)
         is distinct from (old.tax, old.kind, old.regime, old.jurisdiction, old.period) then
    raise exception 'iibb_period_liquidated';
  end if;
  return new;
end;
$$;
revoke all on function trg_tax_suffered_guard() from public, anon, authenticated;

drop trigger if exists tax_suffered_guard on tax_suffered_entries;
create trigger tax_suffered_guard before insert or update on tax_suffered_entries
  for each row execute function trg_tax_suffered_guard();

-- -----------------------------------------------------------------------------
-- C) Desde las liquidaciones de procesadores
-- -----------------------------------------------------------------------------
-- Crea (si faltan) las filas de una línea de liquidación. Idempotente por
-- source_key. Devuelve cuántas creó.
create or replace function _tax_suffered_from_settlement(p_line uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sl settlement_lines%rowtype;
  v_home text;
  v_store uuid;
  v_c jsonb;
  v_n int := 0;
  v_date date;
  v_amt numeric;
  f record;
begin
  select * into sl from settlement_lines where id = p_line;
  if not found or sl.kind <> 'payment' or coalesce(sl.taxes, 0) = 0 then
    return 0;
  end if;
  v_home := _tax_settings_eff(sl.tenant_id) ->> 'iibb_jurisdiction';
  select s.store_id into v_store from sales s where s.id = sl.sale_id;
  v_store := coalesce(sl.scope_store_id, v_store);
  v_date := (sl.operation_at at time zone 'America/Argentina/Buenos_Aires')::date;

  if jsonb_typeof(sl.fee_detail) = 'array' and exists (
       select 1 from jsonb_array_elements(sl.fee_detail) e where e ->> 'kind' = 'tax') then
    for f in
      select e, o from jsonb_array_elements(sl.fee_detail) with ordinality as x(e, o)
       where e ->> 'kind' = 'tax'
    loop
      v_amt := round(abs(coalesce((f.e ->> 'amount')::numeric, 0)), 2);
      continue when v_amt <= 0;
      v_c := _tax_suffered_classify(concat_ws(' ', f.e ->> 'code', f.e ->> 'label'), v_home, 'procesador');
      continue when (v_c ->> 'skip')::boolean;
      insert into tax_suffered_entries (tenant_id, store_id, tax, kind, regime, jurisdiction, origin, operation_date,
                                        period, amount, settlement_line_id, source_key, needs_review, notes)
      values (sl.tenant_id, v_store, v_c ->> 'tax', v_c ->> 'kind', v_c ->> 'regime', v_c ->> 'jurisdiction',
              'procesador', v_date, date_trunc('month', v_date)::date, v_amt, sl.id,
              'sl:' || sl.id::text || ':' || f.o::text, (v_c ->> 'needs_review')::boolean,
              left(sl.provider_key || ' · ' || coalesce(f.e ->> 'label', 'Impuesto'), 300))
      on conflict (tenant_id, source_key) where source_key is not null do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  else
    -- Sin detalle: el total de impuestos, para revisar.
    insert into tax_suffered_entries (tenant_id, store_id, tax, kind, regime, jurisdiction, origin, operation_date,
                                      period, amount, settlement_line_id, source_key, needs_review, notes)
    values (sl.tenant_id, v_store, 'otro', 'retencion', 'procesador', null, 'procesador', v_date,
            date_trunc('month', v_date)::date, round(abs(sl.taxes), 2), sl.id, 'sl:' || sl.id::text || ':0', true,
            left(sl.provider_key || ' · Impuestos sin detalle', 300))
    on conflict (tenant_id, source_key) where source_key is not null do nothing;
    if found then v_n := v_n + 1; end if;
  end if;
  return v_n;
exception when others then
  -- Nunca frena la importación de la liquidación (p. ej. mes de IIBB ya
  -- liquidado): queda para la RPC de sincronización.
  return 0;
end;
$$;
revoke all on function _tax_suffered_from_settlement(uuid) from public, anon, authenticated;

create or replace function trg_settlement_lines_tax_suffered()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tenant_has_feature_for(new.tenant_id, 'percepciones_retenciones') then
    perform _tax_suffered_from_settlement(new.id);
  end if;
  return null;
end;
$$;
revoke all on function trg_settlement_lines_tax_suffered() from public, anon, authenticated;

drop trigger if exists settlement_lines_tax_suffered on settlement_lines;
create trigger settlement_lines_tax_suffered after insert or update of fee_detail, taxes, kind on settlement_lines
  for each row
  when (new.kind = 'payment' and new.taxes <> 0)
  execute function trg_settlement_lines_tax_suffered();

-- -----------------------------------------------------------------------------
-- D) RPC
-- -----------------------------------------------------------------------------

-- Valida y normaliza los datos comunes de una fila (alta, cambio, import).
create or replace function _tax_suffered_check(p_tax text, p_kind text, p_regime text, p_jur text)
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if p_tax is null or p_tax not in ('iibb', 'iva', 'ganancias', 'suss', 'debitos_creditos', 'otro') then
    raise exception 'suffered_invalid_tax';
  end if;
  if p_kind is null or p_kind not in ('retencion', 'percepcion', 'pago_a_cuenta')
     or (p_tax = 'debitos_creditos') <> (p_kind = 'pago_a_cuenta') then
    raise exception 'suffered_invalid_kind';
  end if;
  if p_regime is null or p_regime not in ('general', 'sircreb', 'sirtac', 'procesador', 'otro') then
    raise exception 'suffered_invalid_regime';
  end if;
  if (p_tax = 'iibb') <> (p_jur is not null) then
    raise exception 'suffered_jurisdiction_required';
  end if;
  if p_jur is not null and not exists (select 1 from tax_jurisdictions where code = p_jur) then
    raise exception 'suffered_jurisdiction_required';
  end if;
end;
$$;
revoke all on function _tax_suffered_check(text, text, text, text) from public, anon, authenticated;

-- Verifica que el documento vinculado sea del negocio. Devuelve el cliente
-- (si el vínculo lo trae) para completar customer_id.
create or replace function _tax_suffered_link_check(p_tenant uuid, p jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer uuid;
begin
  if num_nonnulls(nullif(p ->> 'payment_id', ''), nullif(p ->> 'cc_movement_id', ''),
                  nullif(p ->> 'settlement_line_id', ''), nullif(p ->> 'treasury_movement_id', '')) > 1 then
    raise exception 'suffered_link_mismatch';
  end if;
  if nullif(p ->> 'payment_id', '') is not null then
    select s.customer_id into v_customer from payments pm left join sales s on s.id = pm.sale_id
     where pm.id = (p ->> 'payment_id')::uuid and pm.tenant_id = p_tenant;
    if not found then raise exception 'suffered_link_not_found'; end if;
  elsif nullif(p ->> 'cc_movement_id', '') is not null then
    select m.customer_id into v_customer from customer_account_movements m
     where m.id = (p ->> 'cc_movement_id')::uuid and m.tenant_id = p_tenant and m.kind = 'payment';
    if not found then raise exception 'suffered_link_not_found'; end if;
  elsif nullif(p ->> 'settlement_line_id', '') is not null then
    perform 1 from settlement_lines where id = (p ->> 'settlement_line_id')::uuid and tenant_id = p_tenant;
    if not found then raise exception 'suffered_link_not_found'; end if;
  elsif nullif(p ->> 'treasury_movement_id', '') is not null then
    perform 1 from treasury_movements where id = (p ->> 'treasury_movement_id')::uuid and tenant_id = p_tenant
       and voided_at is null and amount < 0;
    if not found then raise exception 'suffered_link_not_found'; end if;
  end if;
  if nullif(p ->> 'customer_id', '') is not null then
    perform 1 from customers where id = (p ->> 'customer_id')::uuid and tenant_id = p_tenant;
    if not found then raise exception 'suffered_link_not_found'; end if;
    v_customer := (p ->> 'customer_id')::uuid;
  end if;
  return v_customer;
end;
$$;
revoke all on function _tax_suffered_link_check(uuid, jsonb) from public, anon, authenticated;

-- Alta manual.
--   p: {tax, kind, regime?, jurisdiction?, origin?: cliente|banco|manual,
--       operation_date, period?, amount, base_amount?, rate?, agent_cuit?,
--       agent_name?, certificate?, customer_id?, payment_id? | cc_movement_id?
--       | settlement_line_id? | treasury_movement_id?, store_id?, notes?,
--       treasury_account_id?: registra además el débito en esa cuenta de
--       tesorería (feature tesoreria) y lo vincula}
create or replace function tax_suffered_register(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := _tax_ret_assert();
  v_id      uuid := gen_random_uuid();
  v_tax     text := p ->> 'tax';
  v_kind    text := coalesce(nullif(p ->> 'kind', ''), case when p ->> 'tax' = 'debitos_creditos' then 'pago_a_cuenta' else 'retencion' end);
  v_regime  text := coalesce(nullif(p ->> 'regime', ''), 'general');
  v_jur     text := nullif(p ->> 'jurisdiction', '');
  v_origin  text := coalesce(nullif(p ->> 'origin', ''), 'manual');
  v_date    date;
  v_period  date;
  v_amount  numeric := round(coalesce((nullif(p ->> 'amount', ''))::numeric, 0), 2);
  v_cuit    text := nullif(regexp_replace(coalesce(p ->> 'agent_cuit', ''), '\D', '', 'g'), '');
  v_customer uuid;
  v_mov     uuid := nullif(p ->> 'treasury_movement_id', '')::uuid;
  v_acc     treasury_accounts;
  v_store   uuid := nullif(p ->> 'store_id', '')::uuid;
begin
  begin
    v_date := (p ->> 'operation_date')::date;
    v_period := coalesce(date_trunc('month', (nullif(p ->> 'period', ''))::date)::date, date_trunc('month', v_date)::date);
  exception when others then
    raise exception 'suffered_invalid_date';
  end;
  if v_date is null or v_date > current_date + 1 or v_date < date '2000-01-01' then
    raise exception 'suffered_invalid_date';
  end if;
  if v_amount <= 0 then raise exception 'suffered_invalid_amount'; end if;
  if v_origin not in ('cliente', 'banco', 'manual') then v_origin := 'manual'; end if;
  perform _tax_suffered_check(v_tax, v_kind, v_regime, v_jur);
  if v_cuit is not null and not (v_cuit ~ '^\d{11}$' and cuit_is_valid(v_cuit)) then
    raise exception 'invalid_cuit';
  end if;
  if v_store is not null and not exists (select 1 from stores where id = v_store and tenant_id = v_tenant) then
    raise exception 'suffered_link_not_found';
  end if;
  v_customer := _tax_suffered_link_check(v_tenant, p);

  -- Débito en la cuenta bancaria (SIRCREB, débitos y créditos): se registra
  -- el movimiento de tesorería y se vincula.
  if nullif(p ->> 'treasury_account_id', '') is not null then
    if v_mov is not null or nullif(p ->> 'payment_id', '') is not null or nullif(p ->> 'cc_movement_id', '') is not null
       or nullif(p ->> 'settlement_line_id', '') is not null then
      raise exception 'suffered_link_mismatch';
    end if;
    if not tenant_has_feature_for(v_tenant, 'tesoreria') then
      raise exception 'feature_not_in_plan: tesoreria' using errcode = 'check_violation';
    end if;
    select * into v_acc from treasury_accounts
     where id = (p ->> 'treasury_account_id')::uuid and tenant_id = v_tenant and deleted_at is null;
    if not found then raise exception 'treasury_account_not_found'; end if;
    v_mov := _treasury_move(v_tenant, v_acc.id, v_date, -v_amount, 'withdrawal',
                            left(case when v_tax = 'debitos_creditos' then 'Impuesto a los débitos y créditos'
                                      else case v_kind when 'percepcion' then 'Percepción ' else 'Retención ' end
                                           || upper(v_tax) end
                                 || case when v_regime in ('sircreb', 'sirtac') then ' ' || upper(v_regime) else '' end, 300),
                            'tax_suffered', v_id);
    v_origin := 'banco';
  end if;

  insert into tax_suffered_entries (id, tenant_id, store_id, tax, kind, regime, jurisdiction, origin, operation_date,
                                    period, amount, base_amount, rate, agent_cuit, agent_name, certificate,
                                    customer_id, payment_id, cc_movement_id, settlement_line_id, treasury_movement_id,
                                    needs_review, notes, created_by)
  values (v_id, v_tenant, v_store, v_tax, v_kind, v_regime, v_jur, v_origin, v_date, v_period, v_amount,
          round((nullif(p ->> 'base_amount', ''))::numeric, 2), (nullif(p ->> 'rate', ''))::numeric, v_cuit,
          nullif(btrim(left(p ->> 'agent_name', 120)), ''), nullif(btrim(left(p ->> 'certificate', 40)), ''),
          v_customer, nullif(p ->> 'payment_id', '')::uuid, nullif(p ->> 'cc_movement_id', '')::uuid,
          nullif(p ->> 'settlement_line_id', '')::uuid, v_mov, false,
          nullif(btrim(left(p ->> 'notes', 300)), ''), auth.uid());

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'tax_suffered_entries', v_id, 'tax_suffered_registered',
          (select to_jsonb(e) from tax_suffered_entries e where e.id = v_id));
  return v_id;
end;
$$;
revoke all on function tax_suffered_register(jsonb) from public, anon;
grant execute on function tax_suffered_register(jsonb) to authenticated;

-- Cambio de clasificación, período, agente, vínculo o revisión. El importe,
-- la fecha y el origen no cambian (se anula y se carga de nuevo).
create or replace function tax_suffered_update(p_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_ret_assert();
  e tax_suffered_entries%rowtype;
  v_new tax_suffered_entries%rowtype;
  v_customer uuid;
  v_cuit text;
begin
  select * into e from tax_suffered_entries where id = p_id and tenant_id = v_tenant for update;
  if not found then raise exception 'suffered_link_not_found'; end if;
  if e.status = 'voided' then raise exception 'suffered_voided'; end if;
  v_new := e;
  if p ? 'tax' then v_new.tax := p ->> 'tax'; end if;
  if p ? 'kind' then v_new.kind := p ->> 'kind'; end if;
  if p ? 'regime' then v_new.regime := p ->> 'regime'; end if;
  if p ? 'jurisdiction' then v_new.jurisdiction := nullif(p ->> 'jurisdiction', ''); end if;
  if v_new.tax <> 'iibb' then v_new.jurisdiction := null; end if;
  if v_new.tax = 'debitos_creditos' then v_new.kind := 'pago_a_cuenta';
  elsif v_new.kind = 'pago_a_cuenta' then v_new.kind := 'retencion'; end if;
  if p ? 'period' then v_new.period := date_trunc('month', (p ->> 'period')::date)::date; end if;
  if p ? 'agent_cuit' then
    v_cuit := nullif(regexp_replace(coalesce(p ->> 'agent_cuit', ''), '\D', '', 'g'), '');
    if v_cuit is not null and not (v_cuit ~ '^\d{11}$' and cuit_is_valid(v_cuit)) then
      raise exception 'invalid_cuit';
    end if;
    v_new.agent_cuit := v_cuit;
  end if;
  if p ? 'agent_name' then v_new.agent_name := nullif(btrim(left(p ->> 'agent_name', 120)), ''); end if;
  if p ? 'certificate' then v_new.certificate := nullif(btrim(left(p ->> 'certificate', 40)), ''); end if;
  if p ? 'base_amount' then v_new.base_amount := round((nullif(p ->> 'base_amount', ''))::numeric, 2); end if;
  if p ? 'rate' then v_new.rate := (nullif(p ->> 'rate', ''))::numeric; end if;
  if p ? 'notes' then v_new.notes := nullif(btrim(left(p ->> 'notes', 300)), ''); end if;
  if p ? 'store_id' then
    v_new.store_id := nullif(p ->> 'store_id', '')::uuid;
    if v_new.store_id is not null and not exists (select 1 from stores where id = v_new.store_id and tenant_id = v_tenant) then
      raise exception 'suffered_link_not_found';
    end if;
  end if;
  if p ? 'link' then
    -- Reemplaza el vínculo: {payment_id? | cc_movement_id? | settlement_line_id? | treasury_movement_id?, customer_id?}
    v_customer := _tax_suffered_link_check(v_tenant, p -> 'link');
    v_new.payment_id := nullif(p -> 'link' ->> 'payment_id', '')::uuid;
    v_new.cc_movement_id := nullif(p -> 'link' ->> 'cc_movement_id', '')::uuid;
    v_new.settlement_line_id := nullif(p -> 'link' ->> 'settlement_line_id', '')::uuid;
    v_new.treasury_movement_id := nullif(p -> 'link' ->> 'treasury_movement_id', '')::uuid;
    v_new.customer_id := v_customer;
  end if;
  perform _tax_suffered_check(v_new.tax, v_new.kind, v_new.regime, v_new.jurisdiction);
  -- Revisada: al clasificarla (impuesto identificado y, si es IIBB, con
  -- jurisdicción) sale de "para revisar", salvo que se diga lo contrario.
  if p ? 'needs_review' then
    v_new.needs_review := coalesce((p ->> 'needs_review')::boolean, false);
  elsif p ? 'tax' or p ? 'jurisdiction' then
    v_new.needs_review := v_new.tax = 'otro';
  end if;

  update tax_suffered_entries
     set tax = v_new.tax, kind = v_new.kind, regime = v_new.regime, jurisdiction = v_new.jurisdiction,
         period = v_new.period, agent_cuit = v_new.agent_cuit, agent_name = v_new.agent_name,
         certificate = v_new.certificate, base_amount = v_new.base_amount, rate = v_new.rate, notes = v_new.notes,
         store_id = v_new.store_id, payment_id = v_new.payment_id, cc_movement_id = v_new.cc_movement_id,
         settlement_line_id = v_new.settlement_line_id, treasury_movement_id = v_new.treasury_movement_id,
         customer_id = v_new.customer_id, needs_review = v_new.needs_review
   where id = e.id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'tax_suffered_entries', e.id, 'tax_suffered_updated', to_jsonb(e),
          (select to_jsonb(x) from tax_suffered_entries x where x.id = e.id));
end;
$$;
revoke all on function tax_suffered_update(uuid, jsonb) from public, anon;
grant execute on function tax_suffered_update(uuid, jsonb) to authenticated;

-- Anulación (con motivo). El débito de tesorería que se registró con ella
-- queda: el banco lo debitó igual; si fue un error se anula en Tesorería.
create or replace function tax_suffered_void(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_ret_assert();
  e tax_suffered_entries%rowtype;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'reason_required'; end if;
  select * into e from tax_suffered_entries where id = p_id and tenant_id = v_tenant for update;
  if not found then raise exception 'suffered_link_not_found'; end if;
  if e.status = 'voided' then raise exception 'suffered_voided'; end if;
  update tax_suffered_entries
     set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = left(btrim(p_reason), 300)
   where id = e.id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'tax_suffered_entries', e.id, 'tax_suffered_voided', to_jsonb(e),
          jsonb_build_object('status', 'voided'), left(btrim(p_reason), 300));
end;
$$;
revoke all on function tax_suffered_void(uuid, text) from public, anon;
grant execute on function tax_suffered_void(uuid, text) to authenticated;

-- Importación (hasta 2000 filas). p_source: 'mis_retenciones', 'sircreb',
-- 'sirtac' o 'planilla' (sólo para la auditoría). Cada fila:
--   {tax, kind, regime?, jurisdiction?, operation_date, amount, base_amount?,
--    rate?, agent_cuit?, agent_name?, certificate?, needs_review?}
-- Idempotente: la clave es un hash de agente, certificado, fecha, importe,
-- impuesto y jurisdicción; además se saltea si ya hay una vigente con el
-- mismo agente, certificado e importe (cargada a mano o desde otro origen).
create or replace function tax_suffered_import(p_rows jsonb, p_source text default 'planilla')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := _tax_ret_assert();
  r jsonb;
  i int := 0;
  v_ins int := 0;
  v_dup int := 0;
  v_errors jsonb := '[]'::jsonb;
  v_tax text; v_kind text; v_regime text; v_jur text; v_date date; v_amt numeric; v_cuit text; v_cert text;
  v_key text;
  v_review boolean;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_rows'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'too_many_rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_tax := r ->> 'tax';
      v_kind := coalesce(nullif(r ->> 'kind', ''), case when v_tax = 'debitos_creditos' then 'pago_a_cuenta' else 'retencion' end);
      v_regime := coalesce(nullif(r ->> 'regime', ''), 'general');
      v_jur := nullif(r ->> 'jurisdiction', '');
      v_review := coalesce((r ->> 'needs_review')::boolean, false);
      if v_tax = 'iibb' and v_jur is null then v_review := true; end if;
      v_date := (r ->> 'operation_date')::date;
      v_amt := round((r ->> 'amount')::numeric, 2);
      if v_date is null or v_date > current_date + 1 or v_date < date '2000-01-01' then raise exception 'suffered_invalid_date'; end if;
      if v_amt is null or v_amt <= 0 then raise exception 'suffered_invalid_amount'; end if;
      if v_tax is null or v_tax not in ('iibb', 'iva', 'ganancias', 'suss', 'debitos_creditos', 'otro') then
        raise exception 'suffered_invalid_tax';
      end if;
      -- IIBB sin jurisdicción entra "para revisar": se valida el resto con una
      -- jurisdicción cualquiera sólo para el chequeo.
      perform _tax_suffered_check(v_tax, v_kind, v_regime,
                                  coalesce(v_jur, case when v_tax = 'iibb' then '901' end));
      v_cuit := nullif(regexp_replace(coalesce(r ->> 'agent_cuit', ''), '\D', '', 'g'), '');
      if v_cuit is not null and not (v_cuit ~ '^\d{11}$' and cuit_is_valid(v_cuit)) then v_cuit := null; end if;
      v_cert := nullif(btrim(left(r ->> 'certificate', 40)), '');
      v_key := 'imp:' || md5(concat_ws('|', v_cuit, v_cert, v_date::text, v_amt::text, v_tax, v_jur));
      if v_cert is not null and v_cuit is not null and exists (
           select 1 from tax_suffered_entries x
            where x.tenant_id = v_tenant and x.status = 'active' and x.agent_cuit = v_cuit
              and x.certificate = v_cert and x.amount = v_amt) then
        v_dup := v_dup + 1;
        continue;
      end if;
      insert into tax_suffered_entries (tenant_id, tax, kind, regime, jurisdiction, origin, operation_date, period,
                                        amount, base_amount, rate, agent_cuit, agent_name, certificate, source_key,
                                        needs_review, created_by)
      values (v_tenant, v_tax, v_kind, v_regime, v_jur, 'importado', v_date, date_trunc('month', v_date)::date, v_amt,
              round((nullif(r ->> 'base_amount', ''))::numeric, 2),
              case when (nullif(r ->> 'rate', ''))::numeric between 0 and 100 then (r ->> 'rate')::numeric end,
              v_cuit, nullif(btrim(left(r ->> 'agent_name', 120)), ''), v_cert, v_key, v_review, auth.uid())
      on conflict (tenant_id, source_key) where source_key is not null do nothing;
      if found then v_ins := v_ins + 1; else v_dup := v_dup + 1; end if;
    exception when others then
      if jsonb_array_length(v_errors) < 50 then
        v_errors := v_errors || jsonb_build_object('row', i, 'message', left(sqlerrm, 120));
      end if;
    end;
  end loop;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'tax_suffered_entries', null, 'tax_suffered_imported',
          jsonb_build_object('source', left(coalesce(p_source, 'planilla'), 40), 'rows', i, 'inserted', v_ins,
                             'duplicates', v_dup, 'errors', jsonb_array_length(v_errors)));
  return jsonb_build_object('rows', i, 'inserted', v_ins, 'duplicates', v_dup, 'errors', v_errors);
end;
$$;
revoke all on function tax_suffered_import(jsonb, text) from public, anon;
grant execute on function tax_suffered_import(jsonb, text) to authenticated;

-- Trae los impuestos de las liquidaciones ya importadas en el rango.
create or replace function tax_suffered_sync_settlements(p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_ret_assert();
  v_lines int := 0;
  v_ins int := 0;
  r record;
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception 'invalid_period'; end if;
  if p_to - p_from > 400 then raise exception 'period_too_long'; end if;
  for r in
    select id from settlement_lines
     where tenant_id = v_tenant and kind = 'payment' and taxes <> 0
       and operation_at >= (p_from::timestamp at time zone 'America/Argentina/Buenos_Aires')
       and operation_at < ((p_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
  loop
    v_lines := v_lines + 1;
    v_ins := v_ins + _tax_suffered_from_settlement(r.id);
  end loop;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'tax_suffered_entries', null, 'tax_suffered_synced',
          jsonb_build_object('from', p_from, 'to', p_to, 'lines', v_lines, 'inserted', v_ins));
  return jsonb_build_object('lines', v_lines, 'inserted', v_ins);
end;
$$;
revoke all on function tax_suffered_sync_settlements(date, date) from public, anon;
grant execute on function tax_suffered_sync_settlements(date, date) to authenticated;

-- Filas del período (mes de imputación): las sufridas registradas y las
-- percepciones de facturas de proveedor (vista tax_suffered) del mes.
create or replace function _tax_suffered_rows(p_tenant uuid, p_period date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with m as (select date_trunc('month', p_period)::date as d)
  select coalesce(jsonb_agg(x order by x ->> 'operation_date', x ->> 'id'), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'id', e.id, 'source', 'entry', 'tax', e.tax, 'kind', e.kind, 'regime', e.regime,
               'jurisdiction', e.jurisdiction, 'origin', e.origin, 'operation_date', e.operation_date,
               'period', e.period, 'amount', e.amount, 'base_amount', e.base_amount, 'rate', e.rate,
               'agent_cuit', e.agent_cuit, 'agent_name', e.agent_name, 'certificate', e.certificate,
               'status', e.status, 'needs_review', e.needs_review, 'notes', e.notes,
               'void_reason', e.void_reason, 'store_id', e.store_id,
               'customer_id', e.customer_id, 'customer_name', c.name,
               'payment_id', e.payment_id, 'cc_movement_id', e.cc_movement_id,
               'settlement_line_id', e.settlement_line_id, 'treasury_movement_id', e.treasury_movement_id,
               'provider_key', sl.provider_key,
               'linked', case when e.payment_id is not null then 'payment'
                              when e.cc_movement_id is not null then 'cc_movement'
                              when e.settlement_line_id is not null then 'settlement_line'
                              when e.treasury_movement_id is not null then 'treasury_movement' end,
               'liquidated', e.tax = 'iibb' and iibb_period_locked(e.tenant_id, e.jurisdiction, e.period)) as x
        from tax_suffered_entries e
        cross join m
        left join customers c on c.id = e.customer_id
        left join settlement_lines sl on sl.id = e.settlement_line_id
       where e.tenant_id = p_tenant and e.period = m.d
      union all
      select jsonb_build_object(
               'id', v.source_id::text || ':' || v.kind || ':' || coalesce(v.jurisdiction, ''), 'source', 'purchase',
               'tax', case v.kind when 'percepcion_iibb' then 'iibb' when 'percepcion_iva' then 'iva'
                                  when 'percepcion_ganancias' then 'ganancias' else 'otro' end,
               'kind', 'percepcion', 'regime', 'general',
               'jurisdiction', case when v.kind = 'percepcion_iibb' then _tax_jurisdiction_code(v.jurisdiction) end,
               'origin', 'compra', 'operation_date', v.date, 'period', m.d, 'amount', sum(v.amount_ars),
               'base_amount', null, 'rate', null, 'agent_cuit', s.cuit, 'agent_name', s.name,
               'certificate', coalesce(v.letter, '') || ' ' || lpad(coalesce(v.point_of_sale, 0)::text, 5, '0') || '-'
                              || lpad(coalesce(v.number, 0)::text, 8, '0'),
               'status', 'active',
               'needs_review', v.kind = 'percepcion_iibb' and _tax_jurisdiction_code(v.jurisdiction) is null,
               'notes', v.description, 'linked', null, 'liquidated',
               v.kind = 'percepcion_iibb' and iibb_period_locked(p_tenant, _tax_jurisdiction_code(v.jurisdiction), m.d))
        from tax_suffered v
        cross join m
        left join suppliers s on s.id = v.supplier_id
       where v.tenant_id = p_tenant and v.kind in ('percepcion_iibb', 'percepcion_iva', 'percepcion_ganancias')
         and v.date >= m.d and v.date < (m.d + interval '1 month')::date
       group by v.source_id, v.kind, v.jurisdiction, v.date, v.letter, v.point_of_sale, v.number, v.description,
                s.cuit, s.name, m.d
    ) q;
$$;
revoke all on function _tax_suffered_rows(uuid, date) from public, anon, authenticated;

create or replace function tax_suffered_list(p_period date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_ret_assert();
begin
  if p_period is null then raise exception 'invalid_period'; end if;
  return _tax_suffered_rows(v_tenant, p_period);
end;
$$;
revoke all on function tax_suffered_list(date) from public, anon;
grant execute on function tax_suffered_list(date) to authenticated;

-- Lo mismo para descargar el reporte de la DDJJ: queda en audit_logs antes de
-- responder.
create or replace function tax_suffered_export(p_period date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _tax_ret_assert();
  v_rows jsonb;
begin
  if p_period is null then raise exception 'invalid_period'; end if;
  v_rows := _tax_suffered_rows(v_tenant, p_period);
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'tax_suffered_entries', v_tenant, 'tax_suffered_exported',
          jsonb_build_object('period', date_trunc('month', p_period)::date, 'rows', jsonb_array_length(v_rows)));
  return jsonb_build_object('period', date_trunc('month', p_period)::date, 'rows', v_rows,
                            'agent', _tax_settings_eff(v_tenant));
end;
$$;
revoke all on function tax_suffered_export(date) from public, anon;
grant execute on function tax_suffered_export(date) to authenticated;

-- -----------------------------------------------------------------------------
-- Feature: sin key nueva (ADR-095). Copy de la descripción.
-- -----------------------------------------------------------------------------
update features
   set description = 'Percepciones y retenciones como agente (regímenes, padrones, exclusiones, certificados, SICORE y ARBA) y como sujeto (retenciones y percepciones sufridas, SIRCREB, SIRTAC y procesadores) con la liquidación mensual de Ingresos Brutos'
 where key = 'percepciones_retenciones';
