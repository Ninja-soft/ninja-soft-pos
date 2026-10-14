-- =============================================================================
-- 20261121100000_presupuestos_v2.sql  (ADR-123)
--
-- Presupuestos v2, sobre ADR-122 (20261120100100_presupuestos, ya aplicada):
--
-- A) Sin vencimiento: quotes.valid_until pasa a admitir NULL = "precio de
--    referencia sujeto a cambios". quote_effective_status ya devuelve el
--    estado tal cual con NULL (NULL < hoy no es verdadero): nunca "vencido".
--    quote_settings.no_expiry_default lo propone en cada alta.
-- B) Varios emails del cliente (destinatarios): quotes.customer_emails
--    (hasta 10). customer_email queda como el primero (compatibilidad).
-- C) Quién emitió y quién modificó: created_by / updated_by ya existían; se
--    suman las fotos de nombre created_by_name / updated_by_name (trigger, así
--    cualquier RPC que toque updated_by las mantiene) para el listado, el
--    documento y el link público sin exponer ids de usuarios.
-- D) quote_save: no_expiry y customer_emails.
-- E) quote_duplicate: conserva "sin vencimiento" y los emails.
-- F) quote_public_get: emisor, sin vencimiento y datos de contacto del negocio.
-- G) Contacto del negocio en el presupuesto y plantilla del email
--    (quote_settings.contact_email / contact_phone / email_subject /
--    email_message).
-- H) Envío por email: quote_emails (registro por destinatario), RPC
--    quote_email_prepare (usuario: rol, negocio y feature `presupuestos` con
--    _quote_guard, tope diario) y quote_email_finish (sólo service_role: la
--    llama la Edge send_quote_email con el resultado del proveedor). Bitácora
--    también en system_emails (kind 'quote').
-- I) quote_issuer_report: presupuestos por emisor (cantidad, monto, aceptados,
--    convertidos) para comisiones.
--
-- Sin feature nueva: todo vive dentro de `presupuestos` (OPTIONAL, Pro+), que
-- cada RPC de escritura exige en la base (_quote_guard).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A, B, C) Columnas
-- -----------------------------------------------------------------------------
alter table quotes alter column valid_until drop not null;

alter table quotes add column if not exists customer_emails text[] not null default '{}';
alter table quotes drop constraint if exists quotes_customer_emails_chk;
alter table quotes add constraint quotes_customer_emails_chk check (cardinality(customer_emails) <= 10);
alter table quotes add column if not exists created_by_name text;
alter table quotes add column if not exists updated_by_name text;
alter table quotes drop constraint if exists quotes_by_names_chk;
alter table quotes add constraint quotes_by_names_chk check (
  (created_by_name is null or char_length(created_by_name) <= 160)
  and (updated_by_name is null or char_length(updated_by_name) <= 160));

comment on column quotes.valid_until is
  'ADR-123: NULL = sin vencimiento (precio de referencia sujeto a cambios); nunca pasa a vencido.';
comment on column quotes.customer_emails is 'ADR-123: emails del cliente (destinatarios del envío), hasta 10. customer_email = el primero.';
comment on column quotes.created_by_name is 'ADR-123: nombre de quien emitió (foto, trigger _quote_user_names).';
comment on column quotes.updated_by_name is 'ADR-123: nombre de quien lo modificó por última vez (foto, trigger _quote_user_names).';

-- Nombre visible de un usuario: nombre completo o la parte local del email.
create or replace function _quote_user_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select left(coalesce(nullif(btrim(u.full_name), ''), nullif(split_part(u.email, '@', 1), '')), 160)
    from users u where u.id = p_user
$$;
revoke all on function _quote_user_name(uuid) from public, anon, authenticated;

create or replace function _quote_user_names()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.created_by is not null
     and (tg_op = 'INSERT' or new.created_by is distinct from old.created_by or new.created_by_name is null) then
    new.created_by_name := coalesce(_quote_user_name(new.created_by), new.created_by_name);
  end if;
  if new.updated_by is not null
     and (tg_op = 'INSERT' or new.updated_by is distinct from old.updated_by or new.updated_by_name is null) then
    new.updated_by_name := coalesce(_quote_user_name(new.updated_by), new.updated_by_name);
  end if;
  return new;
end;
$$;
revoke all on function _quote_user_names() from public, anon, authenticated;

-- Fotos de los presupuestos existentes (sin tocar updated_at).
alter table quotes disable trigger set_updated_at_quotes;
update quotes q
   set created_by_name = coalesce(q.created_by_name, _quote_user_name(q.created_by)),
       updated_by_name = coalesce(q.updated_by_name, _quote_user_name(q.updated_by)),
       customer_emails = case when cardinality(q.customer_emails) = 0 and q.customer_email is not null
                              then array[lower(q.customer_email)] else q.customer_emails end
 where (q.created_by is not null and q.created_by_name is null)
    or (q.updated_by is not null and q.updated_by_name is null)
    or (cardinality(q.customer_emails) = 0 and q.customer_email is not null);
alter table quotes enable trigger set_updated_at_quotes;

drop trigger if exists quote_user_names on quotes;
create trigger quote_user_names
  before insert or update of created_by, updated_by, created_by_name, updated_by_name on quotes
  for each row execute function _quote_user_names();

-- Listado y reporte por emisor.
create index if not exists quotes_tenant_issuer_idx on quotes (tenant_id, created_by, created_at desc) where deleted_at is null;

-- -----------------------------------------------------------------------------
-- G) Contacto del negocio y plantilla del email
-- -----------------------------------------------------------------------------
alter table quote_settings add column if not exists no_expiry_default boolean not null default false;
alter table quote_settings add column if not exists contact_email text;
alter table quote_settings add column if not exists contact_phone text;
alter table quote_settings add column if not exists email_subject text;
alter table quote_settings add column if not exists email_message text;
alter table quote_settings drop constraint if exists quote_settings_v2_chk;
alter table quote_settings add constraint quote_settings_v2_chk check (
  (contact_email is null or (char_length(contact_email) <= 160 and contact_email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'))
  and (contact_phone is null or char_length(contact_phone) <= 40)
  and (email_subject is null or char_length(email_subject) <= 200)
  and (email_message is null or char_length(email_message) <= 4000));

comment on column quote_settings.contact_email is 'ADR-123: email del negocio impreso en el presupuesto y respuesta (reply-to) de los envíos.';
comment on column quote_settings.contact_phone is 'ADR-123: teléfono o WhatsApp del negocio impreso en el presupuesto (vacío = el de la marca).';
comment on column quote_settings.email_subject is 'ADR-123: asunto por defecto del envío por email (variables {numero}, {negocio}, {cliente}, {total}, {validez}).';
comment on column quote_settings.email_message is 'ADR-123: mensaje por defecto del envío por email (mismas variables).';

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
                               'show_signature', old.show_signature, 'default_terms', old.default_terms,
                               'no_expiry_default', old.no_expiry_default, 'contact_email', old.contact_email,
                               'contact_phone', old.contact_phone, 'email_subject', old.email_subject,
                               'email_message', old.email_message)
          end,
          jsonb_build_object('pto_vta', new.pto_vta, 'validity_days', new.validity_days,
                             'show_signature', new.show_signature, 'default_terms', new.default_terms,
                             'no_expiry_default', new.no_expiry_default, 'contact_email', new.contact_email,
                             'contact_phone', new.contact_phone, 'email_subject', new.email_subject,
                             'email_message', new.email_message));
  return null;
end;
$$;
revoke all on function _quote_settings_audit() from public, anon, authenticated;

-- Emails válidos, en minúscula, sin repetir y en orden (hasta 10).
create or replace function _quote_emails(p jsonb)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(array(
    select e from (
      select lower(btrim(x.v #>> '{}')) as e, min(x.o) as o
        from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end)
             with ordinality as x(v, o)
       where jsonb_typeof(x.v) = 'string'
         and char_length(btrim(x.v #>> '{}')) between 3 and 160
         and btrim(x.v #>> '{}') ~* '^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$'
       group by 1
    ) s order by s.o limit 10), '{}')
$$;
revoke all on function _quote_emails(jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) quote_save (ADR-122 + ADR-123)
--
-- Cambios: p_quote.no_expiry (true = sin vencimiento: valid_until NULL; sin
-- validez explícita en un alta se toma quote_settings.no_expiry_default) y
-- p_quote.customer_emails (array, hasta 10; sin él, customer_email).
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
  v_noexp    boolean;
  v_days     int;
  v_cust_id  uuid;
  v_cname    text;
  v_cdoc     text;
  v_cemail   text;
  v_cemails  text[];
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

  -- Validez. Sin vencimiento: valid_until NULL (precio de referencia).
  begin
    v_noexp := nullif(p_quote ->> 'no_expiry', '')::boolean;
  exception when others then
    raise exception 'quote_validity_invalid';
  end;
  if v_noexp is null then
    v_noexp := v_id is null
               and nullif(btrim(coalesce(p_quote ->> 'valid_until', '')), '') is null
               and nullif(p_quote ->> 'validity_days', '') is null
               and coalesce(v_set.no_expiry_default, false);
  end if;
  if v_noexp then
    v_valid := null;
  else
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
  end if;

  -- Emails del cliente (destinatarios): el array o el email suelto.
  if p_quote ? 'customer_emails' then
    v_cemails := _quote_emails(p_quote -> 'customer_emails');
  else
    v_cemails := _quote_emails(jsonb_build_array(coalesce(p_quote ->> 'customer_email', '')));
  end if;

  -- Cliente: con id, la foto sale de la ficha; sin id, lo que se escribió.
  if nullif(p_quote ->> 'customer_id', '') is not null then
    if (p_quote ->> 'customer_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'customer_not_found';
    end if;
    select c.id, c.name, nullif(btrim(concat_ws(' ', c.document_type, c.document_number)), ''),
           c.email,
           coalesce(nullif(btrim(coalesce(p_quote ->> 'customer_phone', '')), ''), c.phone),
           c.address, c.iva_condition
      into v_cust_id, v_cname, v_cdoc, v_cemail, v_cphone, v_caddr, v_civa
      from customers c
     where c.id = (p_quote ->> 'customer_id')::uuid and c.tenant_id = v_tenant and c.deleted_at is null;
    if v_cust_id is null then
      raise exception 'customer_not_found';
    end if;
    if cardinality(v_cemails) = 0 and not (p_quote ? 'customer_emails') then
      v_cemails := _quote_emails(jsonb_build_array(coalesce(v_cemail, '')));
    end if;
  else
    v_cname := nullif(btrim(coalesce(p_quote ->> 'customer_name', '')), '');
    v_cdoc := nullif(btrim(coalesce(p_quote ->> 'customer_doc', '')), '');
    v_cphone := nullif(btrim(coalesce(p_quote ->> 'customer_phone', '')), '');
    v_caddr := nullif(btrim(coalesce(p_quote ->> 'customer_address', '')), '');
    v_civa := null;
  end if;
  v_cemail := v_cemails[1];

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
         customer_emails = v_cemails,
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
-- E) quote_duplicate: copia como borrador nuevo (número nuevo; validez desde
-- hoy, o sin vencimiento si el original no vencía).
-- -----------------------------------------------------------------------------
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
                      customer_email, customer_emails, customer_phone, customer_address, customer_iva, issue_date,
                      valid_until, terms, notes, service_from, service_to, subtotal, discount_total, total,
                      show_signature, parent_quote_id, created_by, updated_by)
  values (v_new, v_tenant, v_q.store_id, v_q.pto_vta, v_number, 'draft', v_q.customer_id, v_q.customer_name,
          v_q.customer_doc, v_q.customer_email, v_q.customer_emails, v_q.customer_phone, v_q.customer_address,
          v_q.customer_iva, _quote_today(),
          case when v_q.valid_until is null then null else _quote_today() + v_days end,
          v_q.terms, v_q.notes, null, null,
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

-- -----------------------------------------------------------------------------
-- F) quote_public_get: suma el emisor, "sin vencimiento" y el contacto del
-- negocio para presupuestos (quote_settings, o el de la marca).
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
  v_s  record;
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
  select s.contact_email, s.contact_phone into v_s from quote_settings s where s.tenant_id = v_q.tenant_id;
  return jsonb_build_object(
    'pto_vta', v_q.pto_vta,
    'number', v_q.number,
    'version', v_q.version,
    'status', quote_effective_status(v_q.status, v_q.valid_until),
    'issue_date', v_q.issue_date,
    'valid_until', v_q.valid_until,
    'no_expiry', v_q.valid_until is null,
    'issued_by_name', v_q.created_by_name,
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
      'phone', coalesce(nullif(btrim(v_s.contact_phone), ''), v_b.phone),
      'email', nullif(btrim(v_s.contact_email), ''),
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

-- -----------------------------------------------------------------------------
-- H) Envío por email
-- -----------------------------------------------------------------------------
create table if not exists quote_emails (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  quote_id       uuid not null references quotes(id) on delete cascade,
  batch_id       uuid not null,
  quote_version  int not null check (quote_version >= 1),
  recipient      text not null check (char_length(recipient) between 3 and 160),
  subject        text not null check (char_length(subject) between 1 and 200),
  message        text check (message is null or char_length(message) <= 4000),
  status         text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  provider       text check (provider is null or provider in ('tenant', 'platform')),
  error_message  text check (error_message is null or char_length(error_message) <= 500),
  sent_by        uuid default auth.uid() references public.users(id) on delete set null,
  sent_by_name   text check (sent_by_name is null or char_length(sent_by_name) <= 160),
  created_at     timestamptz not null default now(),
  sent_at        timestamptz
);
create index if not exists quote_emails_quote_idx on quote_emails (quote_id, created_at desc);
create index if not exists quote_emails_tenant_created_idx on quote_emails (tenant_id, created_at desc);
create index if not exists quote_emails_batch_idx on quote_emails (batch_id);
create index if not exists quote_emails_sent_by_idx on quote_emails (sent_by) where sent_by is not null;

alter table quote_emails enable row level security;
drop policy if exists quote_emails_select on quote_emails;
create policy quote_emails_select on quote_emails
  for select using (tenant_id = (select current_tenant_id()));
-- Sin policies de escritura: sólo quote_email_prepare / quote_email_finish.
revoke insert, update, delete on quote_emails from anon, authenticated;
revoke all on quote_emails from anon;

comment on table quote_emails is
  'ADR-123: envíos por email de un presupuesto (uno por destinatario, agrupados por batch_id). Los escriben quote_email_prepare y quote_email_finish.';

-- Bitácora global de emails: suma el kind 'quote' (y conserva los de cuenta
-- corriente, que 20261014100000 había dejado afuera del check).
alter table system_emails drop constraint if exists system_emails_kind_check;
alter table system_emails add constraint system_emails_kind_check
  check (kind in ('system', 'receipt', 'smtp_test', 'password_recovery', 'account_reminder',
                  'account_statement', 'payment_link', 'quote'));

-- Tope diario de destinatarios por negocio (protege la reputación del envío).
create or replace function _quote_email_daily_cap()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$ select 200 $$;
revoke all on function _quote_email_daily_cap() from public, anon, authenticated;

-- El usuario pide el envío: valida rol, negocio, plan, destinatarios y tope;
-- asegura el link público y deja un registro 'pending' por destinatario. La
-- Edge send_quote_email manda y cierra con quote_email_finish.
-- Devuelve {batch_id, token, quote: {...}, sent_by_name, recipients}.
create or replace function quote_email_prepare(p_id uuid, p_to text[], p_subject text, p_message text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := _quote_guard();
  v_q       quotes%rowtype;
  v_to      text[];
  v_subject text := left(btrim(regexp_replace(coalesce(p_subject, ''), '\s+', ' ', 'g')), 200);
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
  v_batch   uuid := gen_random_uuid();
  v_token   text;
  v_used    int;
  v_name    text := _quote_user_name(auth.uid());
begin
  select * into v_q from quotes where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
  if not found then
    raise exception 'quote_not_found';
  end if;
  if v_q.status in ('converted', 'rejected') then
    raise exception 'quote_status_invalid';
  end if;
  v_to := _quote_emails(to_jsonb(coalesce(p_to, '{}'::text[])));
  if cardinality(v_to) = 0 or cardinality(v_to) <> cardinality(coalesce(p_to, '{}'::text[])) then
    raise exception 'quote_email_invalid';
  end if;
  if v_subject = '' then
    raise exception 'quote_email_subject_required';
  end if;
  if v_message is not null and char_length(v_message) > 4000 then
    raise exception 'quote_email_invalid';
  end if;
  select count(*) into v_used from quote_emails
   where tenant_id = v_tenant and created_at > now() - interval '24 hours';
  if v_used + cardinality(v_to) > _quote_email_daily_cap() then
    raise exception 'quote_email_limit';
  end if;

  v_token := coalesce(v_q.public_token, _quote_token());
  if v_q.public_token is null then
    update quotes set public_token = v_token where id = p_id;
  end if;

  insert into quote_emails (tenant_id, quote_id, batch_id, quote_version, recipient, subject, message, sent_by, sent_by_name)
  select v_tenant, p_id, v_batch, v_q.version, r, v_subject, v_message, auth.uid(), v_name
    from unnest(v_to) as r;

  return jsonb_build_object(
    'batch_id', v_batch,
    'token', v_token,
    'recipients', to_jsonb(v_to),
    'sent_by_name', v_name,
    'quote', jsonb_build_object(
      'id', v_q.id, 'tenant_id', v_tenant, 'pto_vta', v_q.pto_vta, 'number', v_q.number,
      'version', v_q.version, 'total', v_q.total, 'valid_until', v_q.valid_until,
      'customer_name', v_q.customer_name, 'created_by_name', v_q.created_by_name));
end;
$$;
revoke all on function quote_email_prepare(uuid, text[], text, text) from public, anon;
grant execute on function quote_email_prepare(uuid, text[], text, text) to authenticated;

-- Resultado del proveedor (sólo service_role, desde la Edge).
-- p_results: [{recipient, ok, error?}], p_provider: 'tenant' | 'platform'.
-- Con al menos un envío bueno: un borrador pasa a enviado. Audita y deja la
-- bitácora en system_emails.
create or replace function quote_email_finish(p_batch uuid, p_results jsonb, p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row    record;
  v_res    jsonb;
  v_ok     boolean;
  v_sent   int := 0;
  v_failed int := 0;
  v_q      quotes%rowtype;
  v_first  quote_emails%rowtype;
  v_prov   text := case when p_provider in ('tenant', 'platform') then p_provider end;
begin
  select * into v_first from quote_emails where batch_id = p_batch order by created_at limit 1;
  if not found then
    raise exception 'quote_email_not_found';
  end if;
  for v_row in select * from quote_emails where batch_id = p_batch and status = 'pending' loop
    v_res := (select e from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) e
               where lower(e ->> 'recipient') = v_row.recipient limit 1);
    v_ok := coalesce((v_res ->> 'ok')::boolean, false);
    update quote_emails
       set status = case when v_ok then 'sent' else 'failed' end,
           provider = v_prov,
           sent_at = case when v_ok then now() end,
           error_message = case when v_ok then null
                                else left(coalesce(nullif(v_res ->> 'error', ''), 'send_failed'), 500) end
     where id = v_row.id;
    insert into system_emails (tenant_id, recipient, subject, kind, status, error_message, sent_at)
    values (v_row.tenant_id, v_row.recipient, v_row.subject, 'quote',
            case when v_ok then 'sent' else 'failed' end,
            case when v_ok then null else left(coalesce(nullif(v_res ->> 'error', ''), 'send_failed'), 500) end,
            case when v_ok then now() end);
    if v_ok then v_sent := v_sent + 1; else v_failed := v_failed + 1; end if;
  end loop;

  select * into v_q from quotes where id = v_first.quote_id for update;
  if v_sent > 0 and v_q.deleted_at is null then
    update quotes
       set status = case when status = 'draft' then 'sent' else status end,
           sent_at = coalesce(sent_at, now()),
           updated_by = coalesce(v_first.sent_by, updated_by)
     where id = v_q.id;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_first.tenant_id, v_first.sent_by, 'quote', v_first.quote_id, 'quote_emailed',
          jsonb_build_object('status', v_q.status),
          jsonb_build_object('batch_id', p_batch, 'provider', v_prov, 'sent', v_sent, 'failed', v_failed,
                             'recipients', (select jsonb_agg(jsonb_build_object('to', e.recipient, 'status', e.status))
                                              from quote_emails e where e.batch_id = p_batch),
                             'subject', v_first.subject, 'version', v_first.quote_version));

  return jsonb_build_object('batch_id', p_batch, 'sent', v_sent, 'failed', v_failed);
end;
$$;
revoke all on function quote_email_finish(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function quote_email_finish(uuid, jsonb, text) to service_role;

-- -----------------------------------------------------------------------------
-- I) Presupuestos por emisor (comisiones). Período por fecha de alta.
-- Devuelve [{issuer_id, issuer_name, count, total, accepted, converted,
-- converted_total}] ordenado por monto.
-- -----------------------------------------------------------------------------
create or replace function quote_issuer_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or auth.uid() is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if member_role_in(v_tenant) is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'presupuestos') then
    raise exception 'feature_not_in_plan' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(r order by r.total desc, r.issuer_name)
      from (
        select q.created_by as issuer_id,
               coalesce(max(q.created_by_name), 'Sin emisor') as issuer_name,
               count(*)::int as count,
               coalesce(sum(q.total), 0) as total,
               count(*) filter (where q.status in ('accepted', 'converted'))::int as accepted,
               count(*) filter (where q.status = 'converted')::int as converted,
               coalesce(sum(q.total) filter (where q.status = 'converted'), 0) as converted_total
          from quotes q
         where q.tenant_id = v_tenant
           and q.deleted_at is null
           and q.created_at >= p_from
           and q.created_at < p_to
         group by q.created_by
      ) r), '[]'::jsonb);
end;
$$;
revoke all on function quote_issuer_report(timestamptz, timestamptz) from public, anon;
grant execute on function quote_issuer_report(timestamptz, timestamptz) to authenticated;
