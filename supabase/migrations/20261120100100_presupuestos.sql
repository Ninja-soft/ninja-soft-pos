-- =============================================================================
-- 20261120100100_presupuestos.sql  (ADR-122)
--
-- Presupuestos: documento con número propio (punto de venta interno), cliente,
-- renglones de productos y servicios (con las aclaraciones de ADR-116 y el tipo
-- de servicio de 20261120100000), descuento, validez, condiciones, estado y
-- revisiones. Se emite desde el POS (sin cobrar ni mover stock) y se gestiona
-- en la sección Presupuestos; se convierte en venta cargando el carrito del POS
-- y cobrando por el flujo normal (create_sale no cambia).
--
-- Clasificación (CLAUDE.md §6): OPTIONAL `presupuestos` (is_basic = false,
-- grupo ventas), desde Pro (Pro, Business, Enterprise). Gating real: cada RPC
-- de escritura llama a tenant_has_feature_for(tenant, 'presupuestos'). Las
-- tablas no tienen policies de escritura: sólo se escriben por estas RPC.
--
-- A) Feature y planes.
-- B) quote_settings: punto de venta, validez y condiciones por defecto, firma.
-- C) quotes, quote_items, quote_revisions (RLS de lectura por negocio).
-- D) quote_save: alta y edición (renglones con fotos del servicio; una
--    edición de un presupuesto enviado, rechazado o vencido guarda la versión
--    anterior en quote_revisions, sube la versión y vuelve a borrador).
--    Numeración concurrente-segura: pg_advisory_xact_lock por negocio y punto
--    de venta + max + 1 + unique (tenant_id, pto_vta, number).
-- E) quote_set_status, quote_share (link público con token), quote_duplicate,
--    quote_delete (baja lógica), quote_link_sale (convertido en venta).
-- F) quote_public_get / quote_public_respond: el cliente ve el presupuesto y
--    lo acepta o rechaza con el token (anon). Sólo datos del presupuesto y de
--    la marca del negocio; nunca ids internos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Feature `presupuestos` (OPTIONAL, desde Pro)
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('presupuestos', 'Presupuestos',
   'Presupuestos de productos y servicios con validez, condiciones, link de aceptación y conversión en venta',
   'ventas', false, 55)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object('presupuestos', (p.key in ('pro', 'business', 'enterprise')))
    || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'presupuestos');

-- -----------------------------------------------------------------------------
-- B) Configuración de presupuestos del negocio
-- -----------------------------------------------------------------------------
create table if not exists quote_settings (
  tenant_id      uuid primary key references tenants(id) on delete cascade,
  pto_vta        int not null default 1 check (pto_vta between 1 and 99999),
  validity_days  int not null default 15 check (validity_days between 1 and 365),
  default_terms  text check (default_terms is null or char_length(default_terms) <= 2000),
  show_signature boolean not null default true,
  updated_by     uuid default auth.uid() references public.users(id) on delete set null,
  updated_at     timestamptz not null default now()
);
create index if not exists quote_settings_updated_by_idx on quote_settings (updated_by) where updated_by is not null;

drop trigger if exists set_updated_at_quote_settings on quote_settings;
create trigger set_updated_at_quote_settings
  before update on quote_settings
  for each row execute function set_updated_at();

alter table quote_settings enable row level security;
drop policy if exists quote_settings_select on quote_settings;
create policy quote_settings_select on quote_settings
  for select using (tenant_id = (select current_tenant_id()));
drop policy if exists quote_settings_insert on quote_settings;
create policy quote_settings_insert on quote_settings
  for insert with check (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
drop policy if exists quote_settings_update on quote_settings;
create policy quote_settings_update on quote_settings
  for update using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))
  with check (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
revoke delete on quote_settings from anon, authenticated;
revoke all on quote_settings from anon;

drop trigger if exists role_write_guard on quote_settings;
create trigger role_write_guard before insert or update or delete on quote_settings
  for each row execute function trg_role_write_guard('manage');

create or replace function _quote_settings_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (new.tenant_id, auth.uid(), 'quote_settings', new.tenant_id, 'quote_settings_updated',
          case when tg_op = 'UPDATE' then
            jsonb_build_object('pto_vta', old.pto_vta, 'validity_days', old.validity_days,
                               'show_signature', old.show_signature, 'default_terms', old.default_terms)
          end,
          jsonb_build_object('pto_vta', new.pto_vta, 'validity_days', new.validity_days,
                             'show_signature', new.show_signature, 'default_terms', new.default_terms));
  return null;
end;
$$;
revoke all on function _quote_settings_audit() from public, anon, authenticated;

drop trigger if exists quote_settings_audit on quote_settings;
create trigger quote_settings_audit
  after insert or update on quote_settings
  for each row execute function _quote_settings_audit();

-- -----------------------------------------------------------------------------
-- C) Presupuestos
-- -----------------------------------------------------------------------------
create table if not exists quotes (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  store_id          uuid references stores(id) on delete set null,
  pto_vta           int not null check (pto_vta between 1 and 99999),
  number            int not null check (number > 0),
  version           int not null default 1 check (version >= 1),
  status            text not null default 'draft'
                    check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired', 'converted')),
  customer_id       uuid references customers(id) on delete set null,
  customer_name     text check (customer_name is null or char_length(customer_name) <= 160),
  customer_doc      text check (customer_doc is null or char_length(customer_doc) <= 40),
  customer_email    text check (customer_email is null or char_length(customer_email) <= 160),
  customer_phone    text check (customer_phone is null or char_length(customer_phone) <= 40),
  customer_address  text check (customer_address is null or char_length(customer_address) <= 240),
  customer_iva      text check (customer_iva is null or char_length(customer_iva) <= 40),
  issue_date        date not null default ((now() at time zone 'America/Argentina/Buenos_Aires')::date),
  valid_until       date not null,
  terms             text check (terms is null or char_length(terms) <= 2000),
  notes             text check (notes is null or char_length(notes) <= 2000),
  service_from      date,
  service_to        date,
  subtotal          numeric(14,2) not null default 0 check (subtotal >= 0),
  discount_total    numeric(14,2) not null default 0 check (discount_total >= 0),
  total             numeric(14,2) not null default 0 check (total >= 0),
  currency          text not null default 'ARS' check (currency = 'ARS'),
  show_signature    boolean not null default true,
  public_token      text unique check (public_token is null or char_length(public_token) between 32 and 80),
  sent_at           timestamptz,
  accepted_at       timestamptz,
  accepted_via      text check (accepted_via is null or accepted_via in ('staff', 'link')),
  accepted_by       uuid references public.users(id) on delete set null,
  accepted_by_name  text check (accepted_by_name is null or char_length(accepted_by_name) <= 160),
  rejected_at       timestamptz,
  rejection_reason  text check (rejection_reason is null or char_length(rejection_reason) <= 500),
  converted_sale_id uuid references sales(id) on delete set null,
  converted_at      timestamptz,
  parent_quote_id   uuid references quotes(id) on delete set null,
  created_by        uuid default auth.uid() references public.users(id) on delete set null,
  updated_by        uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  constraint quotes_tenant_number_key unique (tenant_id, pto_vta, number),
  constraint quotes_validity_chk check (valid_until >= issue_date),
  constraint quotes_service_period_chk check (service_from is null or service_to is null or service_from <= service_to),
  constraint quotes_total_chk check (total = subtotal - discount_total)
);

create index if not exists quotes_tenant_created_idx on quotes (tenant_id, created_at desc) where deleted_at is null;
create index if not exists quotes_tenant_status_idx on quotes (tenant_id, status, valid_until) where deleted_at is null;
create index if not exists quotes_customer_idx on quotes (customer_id) where customer_id is not null;
create index if not exists quotes_store_idx on quotes (store_id) where store_id is not null;
create index if not exists quotes_converted_sale_idx on quotes (converted_sale_id) where converted_sale_id is not null;
create index if not exists quotes_parent_idx on quotes (parent_quote_id) where parent_quote_id is not null;
create index if not exists quotes_created_by_idx on quotes (created_by) where created_by is not null;
create index if not exists quotes_updated_by_idx on quotes (updated_by) where updated_by is not null;
create index if not exists quotes_accepted_by_idx on quotes (accepted_by) where accepted_by is not null;

drop trigger if exists set_updated_at_quotes on quotes;
create trigger set_updated_at_quotes
  before update on quotes
  for each row execute function set_updated_at();

create table if not exists quote_items (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  quote_id            uuid not null references quotes(id) on delete cascade,
  sort                int not null default 0 check (sort between 0 and 999),
  product_id          uuid references products(id) on delete set null,
  variant_id          uuid,
  variant_label       text check (variant_label is null or char_length(variant_label) <= 120),
  name                text not null check (char_length(btrim(name)) between 1 and 200),
  sku                 text check (sku is null or char_length(sku) <= 80),
  quantity            numeric(14,3) not null check (quantity > 0 and quantity <= 1000000),
  unit_price          numeric(14,2) not null check (unit_price >= 0),
  discount            numeric(14,2) not null default 0 check (discount >= 0),
  subtotal            numeric(14,2) not null check (subtotal >= 0),
  is_service          boolean not null default false,
  unit_label          text check (unit_label is null or char_length(unit_label) <= 20),
  service_type_name   text check (service_type_name is null or char_length(service_type_name) <= 40),
  line_detail         text check (line_detail is null or char_length(line_detail) <= 2000),
  line_note           text check (line_note is null or char_length(line_note) <= 1000),
  line_clarifications text[] check (line_clarifications is null or cardinality(line_clarifications) <= 20),
  clarification_ids   uuid[] not null default '{}' check (cardinality(clarification_ids) <= 20),
  created_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create index if not exists quote_items_quote_idx on quote_items (quote_id, sort) where deleted_at is null;
create index if not exists quote_items_tenant_created_idx on quote_items (tenant_id, created_at desc);
create index if not exists quote_items_product_idx on quote_items (product_id) where product_id is not null;

create table if not exists quote_revisions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  quote_id    uuid not null references quotes(id) on delete cascade,
  version     int not null check (version >= 1),
  snapshot    jsonb not null,
  reason      text check (reason is null or char_length(reason) <= 300),
  created_by  uuid default auth.uid() references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint quote_revisions_version_key unique (quote_id, version)
);
create index if not exists quote_revisions_tenant_created_idx on quote_revisions (tenant_id, created_at desc);
create index if not exists quote_revisions_created_by_idx on quote_revisions (created_by) where created_by is not null;

alter table quotes enable row level security;
alter table quote_items enable row level security;
alter table quote_revisions enable row level security;

drop policy if exists quotes_select on quotes;
create policy quotes_select on quotes
  for select using (tenant_id = (select current_tenant_id()));
drop policy if exists quote_items_select on quote_items;
create policy quote_items_select on quote_items
  for select using (tenant_id = (select current_tenant_id()));
drop policy if exists quote_revisions_select on quote_revisions;
create policy quote_revisions_select on quote_revisions
  for select using (tenant_id = (select current_tenant_id()));

-- Sin policies de escritura: sólo las RPC de abajo (SECURITY DEFINER) escriben.
revoke insert, update, delete on quotes, quote_items, quote_revisions from anon, authenticated;
revoke all on quotes, quote_items, quote_revisions from anon;

comment on table quotes is
  'ADR-122: presupuestos. Número propio por punto de venta interno; estado draft/sent/accepted/rejected/converted (vencido = draft o sent con valid_until pasado). Se escribe sólo por RPC.';
comment on table quote_items is 'ADR-122: renglones del presupuesto con fotos del servicio (tipo, unidad, detalle y aclaraciones).';
comment on table quote_revisions is 'ADR-122: versiones anteriores del presupuesto (cabecera y renglones) al editar uno ya enviado.';

-- -----------------------------------------------------------------------------
-- Helpers internos
-- -----------------------------------------------------------------------------

-- Hoy en Argentina.
create or replace function _quote_today()
returns date
language sql
stable
set search_path = public, pg_temp
as $$ select (now() at time zone 'America/Argentina/Buenos_Aires')::date $$;
revoke all on function _quote_today() from public, anon;
grant execute on function _quote_today() to authenticated;

-- Estado efectivo: un borrador o enviado con la validez vencida está vencido.
create or replace function quote_effective_status(p_status text, p_valid_until date)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_status in ('draft', 'sent') and p_valid_until < _quote_today() then 'expired'
    else p_status
  end
$$;
revoke all on function quote_effective_status(text, date) from public, anon;
grant execute on function quote_effective_status(text, date) to authenticated;

-- Negocio del JWT, rol operativo y feature. Devuelve el negocio.
create or replace function _quote_guard()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text;
begin
  if v_tenant is null or auth.uid() is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  v_role := member_role_in(v_tenant);
  if v_role is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_role = 'viewer' then
    raise exception 'forbidden_read_only' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'presupuestos') then
    raise exception 'feature_not_in_plan' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _quote_guard() from public, anon, authenticated;

-- Foto completa (cabecera + renglones vigentes) para revisiones y auditoría.
create or replace function _quote_snapshot(p_quote uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'quote', to_jsonb(q) - 'public_token',
    'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.sort)
                         from quote_items i where i.quote_id = q.id and i.deleted_at is null), '[]'::jsonb))
    from quotes q where q.id = p_quote
$$;
revoke all on function _quote_snapshot(uuid) from public, anon, authenticated;

create or replace function _quote_audit(p_tenant uuid, p_quote uuid, p_action text, p_before jsonb, p_after jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (p_tenant, auth.uid(), 'quote', p_quote, p_action, p_before, p_after)
$$;
revoke all on function _quote_audit(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;

-- Token del link público (dos uuid v4 sin guiones: 244 bits, sin pgcrypto).
create or replace function _quote_token()
returns text
language sql
volatile
set search_path = public, pg_temp
as $$ select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;
revoke all on function _quote_token() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) quote_save
--
-- p_quote: {id?, customer_id?, customer_name?, customer_doc?, customer_email?,
--   customer_phone?, customer_address?, valid_until? (AAAA-MM-DD) |
--   validity_days?, terms?, notes?, discount_total?, store_id?,
--   service_from?, service_to?, show_signature?, reason?}
-- p_items: [{product_id?, variant_id?, variant_label?, name?, sku?, quantity,
--   unit_price?, discount?, line_note?, line_detail?, clarification_ids?}]
--   Con product_id: nombre, SKU y precio por defecto los del catálogo; si es
--   servicio, unidad, tipo, detalle y aclaraciones (sin las claves
--   line_detail / clarification_ids, las del servicio: mismo criterio que
--   _sale_apply_service de ADR-116). Sin product_id: renglón libre.
-- Devuelve {id, pto_vta, number, version, status, total}.
-- -----------------------------------------------------------------------------
create or replace function quote_save(p_quote jsonb, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := _quote_guard();
  v_uid      uuid := auth.uid();
  v_id       uuid;
  v_old      quotes%rowtype;
  v_set      quote_settings%rowtype;
  v_pto      int;
  v_number   int;
  v_version  int := 1;
  v_status   text := 'draft';
  v_today    date := _quote_today();
  v_issue    date;
  v_valid    date;
  v_days     int;
  v_cust_id  uuid;
  v_cname    text;
  v_cdoc     text;
  v_cemail   text;
  v_cphone   text;
  v_caddr    text;
  v_civa     text;
  v_store    uuid;
  v_sfrom    date;
  v_sto      date;
  v_disc     numeric;
  v_subtotal numeric := 0;
  v_it       jsonb;
  v_i        int := 0;
  v_pid      uuid;
  v_pname    text;
  v_psku     text;
  v_pprice   numeric;
  v_punit    text;
  v_pdetail  text;
  v_pcl      uuid[];
  v_ptype    text;
  v_name     text;
  v_qty      numeric;
  v_price    numeric;
  v_ldisc    numeric;
  v_lsub     numeric;
  v_is_srv   boolean;
  v_unit     text;
  v_type     text;
  v_detail   text;
  v_note     text;
  v_ids      uuid[];
  v_cl       text[];
  v_before   jsonb;
begin
  if p_quote is null or jsonb_typeof(p_quote) <> 'object' then
    raise exception 'quote_invalid';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 200 then
    raise exception 'quote_items_invalid';
  end if;

  select * into v_set from quote_settings where tenant_id = v_tenant;
  v_pto := coalesce(v_set.pto_vta, 1);
  v_days := coalesce(v_set.validity_days, 15);

  -- Edición: el presupuesto existe, es del negocio y no está cerrado.
  if nullif(p_quote ->> 'id', '') is not null then
    begin
      v_id := (p_quote ->> 'id')::uuid;
    exception when others then
      raise exception 'quote_not_found';
    end;
    select * into v_old from quotes
     where id = v_id and tenant_id = v_tenant and deleted_at is null
     for update;
    if not found then
      raise exception 'quote_not_found';
    end if;
    if v_old.status in ('accepted', 'converted') then
      raise exception 'quote_locked';
    end if;
    v_before := _quote_snapshot(v_id);
    v_pto := v_old.pto_vta;
    v_number := v_old.number;
    v_issue := v_old.issue_date;
    v_version := v_old.version;
    -- Un presupuesto que ya vio el cliente (enviado, rechazado o vencido)
    -- guarda su versión y vuelve a borrador con la versión siguiente.
    if v_old.status <> 'draft' then
      insert into quote_revisions (tenant_id, quote_id, version, snapshot, reason, created_by)
      values (v_tenant, v_id, v_old.version, v_before,
              left(nullif(btrim(coalesce(p_quote ->> 'reason', '')), ''), 300), v_uid)
      on conflict (quote_id, version) do nothing;
      v_version := v_old.version + 1;
    end if;
    v_status := 'draft';
  else
    v_issue := v_today;
  end if;

  -- Validez.
  begin
    v_valid := nullif(btrim(coalesce(p_quote ->> 'valid_until', '')), '')::date;
  exception when others then
    raise exception 'quote_validity_invalid';
  end;
  if v_valid is null then
    if nullif(p_quote ->> 'validity_days', '') is not null then
      begin
        v_days := (p_quote ->> 'validity_days')::int;
      exception when others then
        raise exception 'quote_validity_invalid';
      end;
    end if;
    if v_days < 1 or v_days > 365 then
      raise exception 'quote_validity_invalid';
    end if;
    v_valid := greatest(v_issue, v_today) + v_days;
  end if;
  if v_valid < v_today or v_valid < v_issue or v_valid > v_today + 366 then
    raise exception 'quote_validity_invalid';
  end if;

  -- Cliente: con id, la foto sale de la ficha; sin id, lo que se escribió.
  if nullif(p_quote ->> 'customer_id', '') is not null then
    if (p_quote ->> 'customer_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'customer_not_found';
    end if;
    select c.id, c.name, nullif(btrim(concat_ws(' ', c.document_type, c.document_number)), ''),
           coalesce(nullif(btrim(coalesce(p_quote ->> 'customer_email', '')), ''), c.email),
           coalesce(nullif(btrim(coalesce(p_quote ->> 'customer_phone', '')), ''), c.phone),
           c.address, c.iva_condition
      into v_cust_id, v_cname, v_cdoc, v_cemail, v_cphone, v_caddr, v_civa
      from customers c
     where c.id = (p_quote ->> 'customer_id')::uuid and c.tenant_id = v_tenant and c.deleted_at is null;
    if v_cust_id is null then
      raise exception 'customer_not_found';
    end if;
  else
    v_cname := nullif(btrim(coalesce(p_quote ->> 'customer_name', '')), '');
    v_cdoc := nullif(btrim(coalesce(p_quote ->> 'customer_doc', '')), '');
    v_cemail := nullif(btrim(coalesce(p_quote ->> 'customer_email', '')), '');
    v_cphone := nullif(btrim(coalesce(p_quote ->> 'customer_phone', '')), '');
    v_caddr := nullif(btrim(coalesce(p_quote ->> 'customer_address', '')), '');
    v_civa := null;
  end if;

  -- Sucursal (opcional, del negocio).
  if nullif(p_quote ->> 'store_id', '') is not null then
    select s.id into v_store from stores s where s.id = (p_quote ->> 'store_id')::uuid and s.tenant_id = v_tenant;
  end if;

  -- Período del servicio (opcional).
  begin
    v_sfrom := nullif(btrim(coalesce(p_quote ->> 'service_from', '')), '')::date;
    v_sto := nullif(btrim(coalesce(p_quote ->> 'service_to', '')), '')::date;
  exception when others then
    raise exception 'service_period_invalid';
  end;
  if v_sfrom is not null and v_sto is not null and v_sto < v_sfrom then
    raise exception 'service_period_invalid';
  end if;

  begin
    v_disc := round(coalesce(nullif(p_quote ->> 'discount_total', '')::numeric, 0), 2);
  exception when others then
    raise exception 'quote_discount_invalid';
  end;
  if v_disc < 0 then
    raise exception 'quote_discount_invalid';
  end if;

  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('quote_number:' || v_tenant::text || ':' || v_pto::text));
    select coalesce(max(number), 0) + 1 into v_number from quotes where tenant_id = v_tenant and pto_vta = v_pto;
    v_id := gen_random_uuid();
    insert into quotes (id, tenant_id, pto_vta, number, valid_until, issue_date, created_by, updated_by)
    values (v_id, v_tenant, v_pto, v_number, v_valid, v_issue, v_uid, v_uid);
  else
    update quote_items set deleted_at = now()
     where quote_id = v_id and tenant_id = v_tenant and deleted_at is null;
  end if;

  -- Renglones.
  for v_it in select e from jsonb_array_elements(p_items) as e loop
    if jsonb_typeof(v_it) <> 'object' then
      raise exception 'quote_items_invalid';
    end if;
    v_pid := null; v_pname := null; v_psku := null; v_pprice := null;
    v_punit := null; v_pdetail := null; v_pcl := '{}'; v_ptype := null;
    v_is_srv := false;
    v_unit := null;
    v_type := null;
    if nullif(v_it ->> 'product_id', '') is not null then
      if (v_it ->> 'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'product_not_found';
      end if;
      select p.id, p.name, p.sku, p.price, p.unit, coalesce(p.is_service, false),
             p.invoice_detail, coalesce(p.service_clarification_ids, '{}'), t.name
        into v_pid, v_pname, v_psku, v_pprice, v_punit, v_is_srv, v_pdetail, v_pcl, v_ptype
        from products p
        left join service_types t on t.id = p.service_type_id and t.tenant_id = p.tenant_id and t.deleted_at is null
       where p.id = (v_it ->> 'product_id')::uuid and p.tenant_id = v_tenant and p.deleted_at is null;
      if v_pid is null then
        raise exception 'product_not_found';
      end if;
      v_is_srv := coalesce(v_is_srv, false);
    end if;

    v_name := left(coalesce(nullif(btrim(coalesce(v_it ->> 'name', '')), ''), v_pname), 200);
    if v_name is null then
      raise exception 'quote_item_name_required';
    end if;
    begin
      v_qty := round(coalesce(nullif(v_it ->> 'quantity', '')::numeric, 1), 3);
      v_price := round(coalesce(nullif(v_it ->> 'unit_price', '')::numeric, v_pprice, 0), 2);
      v_ldisc := round(coalesce(nullif(v_it ->> 'discount', '')::numeric, 0), 2);
    exception when others then
      raise exception 'quote_item_invalid';
    end;
    if v_qty <= 0 or v_qty > 1000000 or v_price < 0 or v_price > 10000000000 or v_ldisc < 0 then
      raise exception 'quote_item_invalid';
    end if;
    v_lsub := round(v_qty * v_price, 2) - v_ldisc;
    if v_lsub < 0 then
      raise exception 'quote_item_invalid';
    end if;

    v_note := left(nullif(btrim(coalesce(v_it ->> 'line_note', '')), ''), 1000);
    v_detail := null;
    v_cl := null;
    v_ids := '{}';
    if v_is_srv then
      v_unit := case when coalesce(btrim(v_punit), '') in ('', 'un') then 'unidad' else left(btrim(v_punit), 20) end;
      v_type := left(v_ptype, 40);
      v_detail := left(nullif(btrim(coalesce(
        case when v_it ? 'line_detail' then v_it ->> 'line_detail' else v_pdetail end, '')), ''), 2000);
      if jsonb_typeof(v_it -> 'clarification_ids') = 'array' then
        v_ids := array(
          select (e.v #>> '{}')::uuid
            from jsonb_array_elements(v_it -> 'clarification_ids') with ordinality as e(v, o)
           where jsonb_typeof(e.v) = 'string'
             and (e.v #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           order by e.o
           limit 20);
      else
        v_ids := v_pcl;
      end if;
      v_ids := array(
        select c.id
          from unnest(v_ids) with ordinality as u(id, o)
          join service_clarifications c
            on c.id = u.id and c.tenant_id = v_tenant and c.deleted_at is null and c.is_active
         order by u.o
         limit 20);
      v_cl := array(
        select c.body
          from unnest(v_ids) with ordinality as u(id, o)
          join service_clarifications c on c.id = u.id
         order by u.o);
      if cardinality(v_cl) = 0 then
        v_cl := null;
      end if;
    end if;

    insert into quote_items (tenant_id, quote_id, sort, product_id, variant_id, variant_label, name, sku,
                             quantity, unit_price, discount, subtotal, is_service, unit_label,
                             service_type_name, line_detail, line_note, line_clarifications, clarification_ids)
    values (v_tenant, v_id, v_i, v_pid,
            case when coalesce(v_it ->> 'variant_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (v_it ->> 'variant_id')::uuid end,
            left(nullif(btrim(coalesce(v_it ->> 'variant_label', '')), ''), 120),
            v_name,
            left(coalesce(nullif(btrim(coalesce(v_it ->> 'sku', '')), ''), v_psku), 80),
            v_qty, v_price, v_ldisc, v_lsub, v_is_srv, v_unit, v_type, v_detail, v_note, v_cl, v_ids);
    v_subtotal := v_subtotal + v_lsub;
    v_i := v_i + 1;
  end loop;

  if v_disc > v_subtotal then
    raise exception 'quote_discount_invalid';
  end if;

  update quotes
     set version = v_version,
         status = v_status,
         customer_id = v_cust_id,
         customer_name = left(v_cname, 160),
         customer_doc = left(v_cdoc, 40),
         customer_email = left(v_cemail, 160),
         customer_phone = left(v_cphone, 40),
         customer_address = left(v_caddr, 240),
         customer_iva = left(v_civa, 40),
         valid_until = v_valid,
         terms = left(nullif(btrim(coalesce(p_quote ->> 'terms', v_set.default_terms, '')), ''), 2000),
         notes = left(nullif(btrim(coalesce(p_quote ->> 'notes', '')), ''), 2000),
         store_id = v_store,
         service_from = v_sfrom,
         service_to = case when v_sfrom is not null then coalesce(v_sto, v_sfrom) else v_sto end,
         subtotal = v_subtotal,
         discount_total = v_disc,
         total = v_subtotal - v_disc,
         show_signature = coalesce((p_quote ->> 'show_signature')::boolean, v_set.show_signature, true),
         rejected_at = null,
         rejection_reason = null,
         updated_by = v_uid
   where id = v_id;

  perform _quote_audit(v_tenant, v_id,
    case when v_before is null then 'quote_created' else 'quote_updated' end,
    v_before, _quote_snapshot(v_id));

  return jsonb_build_object('id', v_id, 'pto_vta', v_pto, 'number', v_number, 'version', v_version,
                            'status', v_status, 'total', v_subtotal - v_disc);
end;
$$;
revoke all on function quote_save(jsonb, jsonb) from public, anon;
grant execute on function quote_save(jsonb, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Estado, link público, duplicar, baja y conversión
-- -----------------------------------------------------------------------------

-- p_status: 'sent' | 'accepted' | 'rejected'. p_reason: motivo del rechazo.
create or replace function quote_set_status(p_id uuid, p_status text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _quote_guard();
  v_q      quotes%rowtype;
  v_eff    text;
begin
  select * into v_q from quotes where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
  if not found then
    raise exception 'quote_not_found';
  end if;
  v_eff := quote_effective_status(v_q.status, v_q.valid_until);
  if p_status = 'sent' then
    if v_q.status not in ('draft', 'sent') then
      raise exception 'quote_status_invalid';
    end if;
    update quotes set status = 'sent', sent_at = now(), updated_by = auth.uid() where id = p_id;
  elsif p_status = 'accepted' then
    if v_q.status not in ('draft', 'sent') then
      raise exception 'quote_status_invalid';
    end if;
    if v_eff = 'expired' then
      raise exception 'quote_expired';
    end if;
    update quotes
       set status = 'accepted', accepted_at = now(), accepted_via = 'staff', accepted_by = auth.uid(),
           accepted_by_name = left(nullif(btrim(coalesce(p_reason, '')), ''), 160), updated_by = auth.uid()
     where id = p_id;
  elsif p_status = 'rejected' then
    if v_q.status not in ('draft', 'sent', 'accepted') then
      raise exception 'quote_status_invalid';
    end if;
    update quotes
       set status = 'rejected', rejected_at = now(),
           rejection_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 500), updated_by = auth.uid()
     where id = p_id;
  else
    raise exception 'quote_status_invalid';
  end if;
  perform _quote_audit(v_tenant, p_id, 'quote_' || p_status,
    jsonb_build_object('status', v_q.status), jsonb_build_object('status', p_status, 'reason', p_reason));
  return jsonb_build_object('id', p_id, 'status', p_status);
end;
$$;
revoke all on function quote_set_status(uuid, text, text) from public, anon;
grant execute on function quote_set_status(uuid, text, text) to authenticated;

-- Link público: genera el token (una vez) y marca enviado un borrador.
create or replace function quote_share(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _quote_guard();
  v_q      quotes%rowtype;
  v_token  text;
begin
  select * into v_q from quotes where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
  if not found then
    raise exception 'quote_not_found';
  end if;
  if v_q.status in ('converted', 'rejected') then
    raise exception 'quote_status_invalid';
  end if;
  v_token := coalesce(v_q.public_token, _quote_token());
  update quotes
     set public_token = v_token,
         status = case when status = 'draft' then 'sent' else status end,
         sent_at = coalesce(sent_at, now()),
         updated_by = auth.uid()
   where id = p_id;
  if v_q.public_token is null or v_q.status = 'draft' then
    perform _quote_audit(v_tenant, p_id, 'quote_shared',
      jsonb_build_object('status', v_q.status), jsonb_build_object('status', case when v_q.status = 'draft' then 'sent' else v_q.status end));
  end if;
  return jsonb_build_object('id', p_id, 'token', v_token);
end;
$$;
revoke all on function quote_share(uuid) from public, anon;
grant execute on function quote_share(uuid) to authenticated;

-- Copia como borrador nuevo (número nuevo, validez desde hoy).
create or replace function quote_duplicate(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _quote_guard();
  v_q      quotes%rowtype;
  v_set    quote_settings%rowtype;
  v_new    uuid := gen_random_uuid();
  v_number int;
  v_days   int;
begin
  select * into v_q from quotes where id = p_id and tenant_id = v_tenant and deleted_at is null;
  if not found then
    raise exception 'quote_not_found';
  end if;
  select * into v_set from quote_settings where tenant_id = v_tenant;
  v_days := greatest(1, coalesce(v_set.validity_days, v_q.valid_until - v_q.issue_date, 15));
  perform pg_advisory_xact_lock(hashtext('quote_number:' || v_tenant::text || ':' || v_q.pto_vta::text));
  select coalesce(max(number), 0) + 1 into v_number from quotes where tenant_id = v_tenant and pto_vta = v_q.pto_vta;
  insert into quotes (id, tenant_id, store_id, pto_vta, number, status, customer_id, customer_name, customer_doc,
                      customer_email, customer_phone, customer_address, customer_iva, issue_date, valid_until,
                      terms, notes, service_from, service_to, subtotal, discount_total, total, show_signature,
                      parent_quote_id, created_by, updated_by)
  values (v_new, v_tenant, v_q.store_id, v_q.pto_vta, v_number, 'draft', v_q.customer_id, v_q.customer_name,
          v_q.customer_doc, v_q.customer_email, v_q.customer_phone, v_q.customer_address, v_q.customer_iva,
          _quote_today(), _quote_today() + v_days, v_q.terms, v_q.notes, null, null,
          v_q.subtotal, v_q.discount_total, v_q.total, v_q.show_signature, v_q.id, auth.uid(), auth.uid());
  insert into quote_items (tenant_id, quote_id, sort, product_id, variant_id, variant_label, name, sku, quantity,
                           unit_price, discount, subtotal, is_service, unit_label, service_type_name, line_detail,
                           line_note, line_clarifications, clarification_ids)
  select v_tenant, v_new, i.sort, i.product_id, i.variant_id, i.variant_label, i.name, i.sku, i.quantity,
         i.unit_price, i.discount, i.subtotal, i.is_service, i.unit_label, i.service_type_name, i.line_detail,
         i.line_note, i.line_clarifications, i.clarification_ids
    from quote_items i
   where i.quote_id = v_q.id and i.deleted_at is null;
  perform _quote_audit(v_tenant, v_new, 'quote_duplicated', jsonb_build_object('from', v_q.id), _quote_snapshot(v_new));
  return jsonb_build_object('id', v_new, 'pto_vta', v_q.pto_vta, 'number', v_number);
end;
$$;
revoke all on function quote_duplicate(uuid) from public, anon;
grant execute on function quote_duplicate(uuid) to authenticated;

-- Baja lógica. Un presupuesto convertido no se borra (está atado a la venta).
-- El cajero sólo da de baja los que creó él.
create or replace function quote_delete(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _quote_guard();
  v_q      quotes%rowtype;
begin
  select * into v_q from quotes where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
  if not found then
    raise exception 'quote_not_found';
  end if;
  if v_q.status = 'converted' then
    raise exception 'quote_locked';
  end if;
  if not is_tenant_manager() and v_q.created_by is distinct from auth.uid() then
    raise exception 'forbidden_role' using errcode = '42501';
  end if;
  update quotes set deleted_at = now(), public_token = null, updated_by = auth.uid() where id = p_id;
  perform _quote_audit(v_tenant, p_id, 'quote_deleted', jsonb_build_object('status', v_q.status), null);
  return jsonb_build_object('id', p_id, 'deleted', true);
end;
$$;
revoke all on function quote_delete(uuid) from public, anon;
grant execute on function quote_delete(uuid) to authenticated;

-- La venta cobrada en el POS desde el presupuesto lo marca convertido.
create or replace function quote_link_sale(p_id uuid, p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _quote_guard();
  v_q      quotes%rowtype;
  v_sale   record;
begin
  select * into v_q from quotes where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
  if not found then
    raise exception 'quote_not_found';
  end if;
  if v_q.status = 'converted' then
    if v_q.converted_sale_id = p_sale_id then
      return jsonb_build_object('id', p_id, 'status', 'converted', 'sale_id', p_sale_id);
    end if;
    raise exception 'quote_already_converted';
  end if;
  if v_q.status = 'rejected' then
    raise exception 'quote_status_invalid';
  end if;
  select s.id, s.status, s.number, s.total into v_sale from sales s where s.id = p_sale_id and s.tenant_id = v_tenant;
  if v_sale.id is null or v_sale.status = 'voided' then
    raise exception 'sale_not_found';
  end if;
  update quotes
     set status = 'converted', converted_sale_id = p_sale_id, converted_at = now(),
         accepted_at = coalesce(accepted_at, now()),
         accepted_via = coalesce(accepted_via, 'staff'),
         accepted_by = coalesce(accepted_by, auth.uid()),
         updated_by = auth.uid()
   where id = p_id;
  perform _quote_audit(v_tenant, p_id, 'quote_converted', jsonb_build_object('status', v_q.status),
    jsonb_build_object('status', 'converted', 'sale_id', p_sale_id, 'sale_number', v_sale.number,
                       'sale_total', v_sale.total, 'quote_total', v_q.total));
  return jsonb_build_object('id', p_id, 'status', 'converted', 'sale_id', p_sale_id);
end;
$$;
revoke all on function quote_link_sale(uuid, uuid) from public, anon;
grant execute on function quote_link_sale(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Link público (anon): ver y responder
-- -----------------------------------------------------------------------------
create or replace function quote_public_get(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q  quotes%rowtype;
  v_b  record;
  v_t  record;
begin
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 80 then
    return null;
  end if;
  select * into v_q from quotes where public_token = p_token and deleted_at is null;
  if not found then
    return null;
  end if;
  select b.legal_name, b.logo_url, b.accent, b.cuit, b.address, b.phone, b.iva_condition
    into v_b from tenant_branding b where b.tenant_id = v_q.tenant_id;
  select t.name into v_t from tenants t where t.id = v_q.tenant_id;
  return jsonb_build_object(
    'pto_vta', v_q.pto_vta,
    'number', v_q.number,
    'version', v_q.version,
    'status', quote_effective_status(v_q.status, v_q.valid_until),
    'issue_date', v_q.issue_date,
    'valid_until', v_q.valid_until,
    'customer_name', v_q.customer_name,
    'customer_doc', v_q.customer_doc,
    'customer_address', v_q.customer_address,
    'customer_iva', v_q.customer_iva,
    'terms', v_q.terms,
    'notes', v_q.notes,
    'service_from', v_q.service_from,
    'service_to', v_q.service_to,
    'subtotal', v_q.subtotal,
    'discount_total', v_q.discount_total,
    'total', v_q.total,
    'show_signature', v_q.show_signature,
    'accepted_at', v_q.accepted_at,
    'accepted_by_name', v_q.accepted_by_name,
    'rejected_at', v_q.rejected_at,
    'issuer', jsonb_build_object(
      'name', coalesce(nullif(btrim(v_b.legal_name), ''), v_t.name),
      'trade_name', v_t.name,
      'logo_url', v_b.logo_url,
      'accent', v_b.accent,
      'cuit', v_b.cuit,
      'address', v_b.address,
      'phone', v_b.phone,
      'iva_condition', v_b.iva_condition),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', i.name, 'sku', i.sku, 'quantity', i.quantity, 'unit_price', i.unit_price,
               'discount', i.discount, 'subtotal', i.subtotal, 'is_service', i.is_service,
               'unit_label', i.unit_label, 'service_type_name', i.service_type_name,
               'variant_label', i.variant_label, 'line_detail', i.line_detail, 'line_note', i.line_note,
               'line_clarifications', i.line_clarifications) order by i.sort)
        from quote_items i where i.quote_id = v_q.id and i.deleted_at is null), '[]'::jsonb)
  );
end;
$$;
revoke all on function quote_public_get(text) from public;
grant execute on function quote_public_get(text) to anon, authenticated;

create or replace function quote_public_respond(p_token text, p_accept boolean, p_name text default null, p_comment text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_q    quotes%rowtype;
  v_name text := left(nullif(btrim(coalesce(p_name, '')), ''), 160);
begin
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 80 or p_accept is null then
    raise exception 'quote_not_found';
  end if;
  select * into v_q from quotes where public_token = p_token and deleted_at is null for update;
  if not found then
    raise exception 'quote_not_found';
  end if;
  if v_q.status not in ('draft', 'sent') then
    raise exception 'quote_already_answered';
  end if;
  if quote_effective_status(v_q.status, v_q.valid_until) = 'expired' then
    raise exception 'quote_expired';
  end if;
  if p_accept then
    if v_name is null then
      raise exception 'quote_name_required';
    end if;
    update quotes
       set status = 'accepted', accepted_at = now(), accepted_via = 'link', accepted_by_name = v_name
     where id = v_q.id;
  else
    update quotes
       set status = 'rejected', rejected_at = now(),
           rejection_reason = left(concat_ws(': ', v_name, nullif(btrim(coalesce(p_comment, '')), '')), 500)
     where id = v_q.id;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_q.tenant_id, null, 'quote', v_q.id,
          case when p_accept then 'quote_accepted_by_link' else 'quote_rejected_by_link' end,
          jsonb_build_object('status', v_q.status),
          jsonb_build_object('status', case when p_accept then 'accepted' else 'rejected' end,
                             'name', v_name, 'comment', left(p_comment, 500)));
  return jsonb_build_object('status', case when p_accept then 'accepted' else 'rejected' end);
end;
$$;
revoke all on function quote_public_respond(text, boolean, text, text) from public;
grant execute on function quote_public_respond(text, boolean, text, text) to anon, authenticated;
