-- =============================================================================
-- 20261101100100_arca_facturacion  (F3 · ADR-072)
--
-- Facturación electrónica con ARCA (ex AFIP) por WSFEv1. El cajero nunca
-- queda bloqueado: la venta se completa siempre y el comprobante fiscal va a
-- una cola que procesa la Edge `arca_wsfe` (cron cada minuto o a pedido).
--
-- Piezas:
--   A) arca_settings: por negocio (activa, ambiente homologacion|produccion,
--      reintentos, última conexión, verificación de producción).
--   B) arca_certificates: certificado PEM + clave privada CIFRADA (AES-GCM con
--      la clave del secret de Edge ARCA_KEY_ENC; la base nunca ve la clave en
--      claro). RLS activa SIN policies y sin grants: sólo service_role. El
--      front ve metadata por arca_config_get().
--   C) arca_tickets: tickets de acceso de WSAA cacheados (12 h). Sólo
--      service_role (token y sign dan acceso al webservice por el CUIT).
--   D) fiscal_documents: un comprobante por venta (factura), devolución (nota
--      de crédito) o anulación (nota de crédito total), con tipo, punto de
--      venta, número, CAE, vencimiento, estado, intentos, próximo intento,
--      último error de ARCA y el XML enviado y recibido (sin token ni sign).
--      Idempotencia: única por (negocio, venta, tipo, punto de venta, origen,
--      devolución). fiscal_document_events: historial de cada intento.
--   E) Tipo de comprobante: arca_cbte_tipo(letra, clase) con la letra que ya
--      infiere el motor de impuestos (sales.cbte_letter, ADR-068); punto de
--      venta de la caja o, si no tiene, de la sucursal (ADR-045).
--   F) Encolado por triggers (venta completada, devolución, anulación) que
--      NUNCA frenan la venta: cualquier error queda como warning.
--   G) RPC de la pantalla (dueño o encargado; escribir pide la feature
--      `facturacion_afip`): configuración, ambiente con checklist y bloqueo
--      de producción, reproceso manual, emitir una venta, borrar certificado.
--      Todo auditado en audit_logs.
--   H) RPC del worker (sólo service_role): negocios vencidos, toma con lease
--      por serie (un comprobante en vuelo por punto de venta y tipo), foto de
--      la venta, número asignado, resultado con backoff y dead-letter,
--      conexión y certificados.
--
-- RLS: staff interno por internal_scope() (ADR-052), nunca is_internal().
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Configuración por negocio
-- -----------------------------------------------------------------------------
create table if not exists arca_settings (
  tenant_id                 uuid primary key references tenants(id) on delete cascade,
  enabled                   boolean not null default false,
  -- delegado: el negocio delega el servicio wsfe a la CUIT de NinjaSoft y se
  -- factura con el certificado de la plataforma como CUIT representada.
  -- propio: certificado del negocio (clave generada y cifrada en el servidor).
  auth_mode                 text not null default 'propio' check (auth_mode in ('delegado', 'propio')),
  environment               text not null default 'homologacion'
                              check (environment in ('homologacion', 'produccion')),
  start_at                  timestamptz,
  max_attempts              integer not null default 10 check (max_attempts between 3 and 30),
  homo_min_approved         integer not null default 3 check (homo_min_approved between 1 and 100),
  last_connection_at        timestamptz,
  last_connection_env       text check (last_connection_env in ('homologacion', 'produccion')),
  last_connection_ok        boolean,
  last_connection_message   text,
  prod_test_ok_at           timestamptz,
  prod_pos_verified         integer[],
  prod_pos_verified_at      timestamptz,
  last_worker_at            timestamptz,
  -- Contingencia CAEA (sección I): opcional por negocio, con su punto de
  -- venta propio (ARCA exige uno distinto del de CAE).
  caea_enabled              boolean not null default false,
  caea_pto_vta              integer check (caea_pto_vta is null or caea_pto_vta between 1 and 99998),
  caea_timeout_seconds      integer not null default 10 check (caea_timeout_seconds between 3 and 60),
  caea_next_check_at        timestamptz,
  caea_last_message         text,
  contingency_since         timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  updated_by                uuid references public.users(id) on delete set null
);
drop trigger if exists set_updated_at_arca_settings on arca_settings;
create trigger set_updated_at_arca_settings before update on arca_settings
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- B) Certificados (ilegibles por PostgREST)
-- -----------------------------------------------------------------------------
create table if not exists arca_certificates (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  environment         text not null check (environment in ('homologacion', 'produccion')),
  status              text not null default 'active' check (status in ('pending_csr', 'active', 'replaced')),
  cert_pem            text check (cert_pem is null or (length(cert_pem) < 20000 and cert_pem like '-----BEGIN CERTIFICATE-----%')),
  csr_pem             text check (csr_pem is null or length(csr_pem) < 20000),
  key_enc             text not null check (key_enc like 'v1:%' and length(key_enc) < 20000),
  cuit                text check (cuit is null or cuit ~ '^\d{11}$'),
  subject             text,
  issuer              text,
  serial              text,
  not_before          timestamptz,
  not_after           timestamptz,
  fingerprint_sha256  text,
  created_at          timestamptz not null default now(),
  created_by          uuid references public.users(id) on delete set null,
  deleted_at          timestamptz,
  check ((status = 'pending_csr') = (cert_pem is null))
);
create unique index if not exists arca_certificates_active_uq
  on arca_certificates (tenant_id, environment) where status = 'active' and deleted_at is null;
create unique index if not exists arca_certificates_pending_uq
  on arca_certificates (tenant_id, environment) where status = 'pending_csr' and deleted_at is null;
alter table arca_certificates enable row level security;
revoke all on arca_certificates from anon, authenticated;

-- -----------------------------------------------------------------------------
-- C) Tickets de acceso (WSAA)
-- -----------------------------------------------------------------------------
create table if not exists arca_tickets (
  tenant_id      uuid not null references tenants(id) on delete cascade,
  environment    text not null check (environment in ('homologacion', 'produccion')),
  service        text not null default 'wsfe' check (service ~ '^[a-z0-9_]{2,30}$'),
  certificate_id uuid references arca_certificates(id) on delete cascade,
  token          text not null,
  sign           text not null,
  generated_at   timestamptz not null,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  primary key (tenant_id, environment, service)
);
alter table arca_tickets enable row level security;
revoke all on arca_tickets from anon, authenticated;

-- Plataforma (modo delegado): CUIT de NinjaSoft a la que el negocio delega
-- el servicio wsfe y certificado de la plataforma (clave cifrada igual que
-- la de los negocios). SIN valores por defecto: mientras no haya CUIT y
-- certificado vigentes del ambiente, el camino "delegar" se muestra como
-- "Disponible próximamente" y el único activo es el certificado propio. Lo
-- carga el staff interno desde /internal/configuracion (Edge arca_wsfe,
-- acciones platform_*). Sólo service_role; la metadata sale por
-- arca_config_get (CUIT y si está lista) y arca_platform_get (staff).
create table if not exists arca_platform (
  environment         text primary key check (environment in ('homologacion', 'produccion')),
  cuit                text check (cuit is null or cuit ~ '^\d{11}$'),
  cert_pem            text check (cert_pem is null or (length(cert_pem) < 20000 and cert_pem like '-----BEGIN CERTIFICATE-----%')),
  csr_pem             text check (csr_pem is null or length(csr_pem) < 20000),
  key_enc             text check (key_enc is null or (key_enc like 'v1:%' and length(key_enc) < 20000)),
  subject             text,
  issuer              text,
  serial              text,
  not_after           timestamptz,
  fingerprint_sha256  text,
  updated_at          timestamptz not null default now(),
  updated_by          uuid
);
insert into arca_platform (environment) values ('homologacion'), ('produccion')
on conflict (environment) do nothing;
alter table arca_platform enable row level security;
revoke all on arca_platform from anon, authenticated;

-- ¿El camino delegado está disponible en ese ambiente?
create or replace function arca_platform_ready(p_env text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select pl.cuit is not null and pl.cert_pem is not null and pl.key_enc is not null
                          and pl.not_after > now()
                     from arca_platform pl where pl.environment = p_env), false);
$$;
revoke all on function arca_platform_ready(text) from public, anon;
grant execute on function arca_platform_ready(text) to authenticated, service_role;

-- Ticket de acceso del certificado de la plataforma (compartido por todos
-- los negocios que delegan). Sólo service_role.
create table if not exists arca_platform_tickets (
  environment   text not null check (environment in ('homologacion', 'produccion')),
  service       text not null default 'wsfe' check (service ~ '^[a-z0-9_]{2,30}$'),
  token         text not null,
  sign          text not null,
  generated_at  timestamptz not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  primary key (environment, service)
);
alter table arca_platform_tickets enable row level security;
revoke all on arca_platform_tickets from anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Comprobantes fiscales y su historial
-- -----------------------------------------------------------------------------
create table if not exists fiscal_documents (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  sale_id            uuid not null references sales(id) on delete cascade,
  return_id          uuid references sale_returns(id) on delete cascade,
  origin             text not null check (origin in ('sale', 'return', 'void')),
  assoc_document_id  uuid references fiscal_documents(id) on delete set null,
  environment        text not null check (environment in ('homologacion', 'produccion')),
  store_id           uuid references stores(id) on delete set null,
  cbte_letter        text check (cbte_letter is null or cbte_letter in ('A', 'B', 'C', 'M', 'E')),
  cbte_tipo          integer,
  pto_vta            integer check (pto_vta is null or pto_vta between 1 and 99998),
  cbte_nro           bigint check (cbte_nro is null or cbte_nro between 1 and 99999999),
  cbte_fch           date,
  concepto           integer check (concepto is null or concepto in (1, 2, 3)),
  doc_tipo           integer,
  doc_nro            text,
  imp_total          numeric(14,2),
  receptor_override  jsonb,
  status             text not null default 'pendiente'
                       check (status in ('pendiente', 'enviando', 'aprobado', 'rechazado', 'requiere_accion', 'cancelado')),
  attempts           integer not null default 0,
  next_attempt_at    timestamptz not null default now(),
  claimed_at         timestamptz,
  void_requested     boolean not null default false,
  dead_letter_at     timestamptz,
  cae                text check (cae is null or cae ~ '^\d{14}$'),
  cae_vto            date,
  qr_url             text,
  last_error_code    text,
  last_error_msg     text,
  observations       jsonb not null default '[]'::jsonb,
  events             jsonb not null default '[]'::jsonb,
  request_xml        text,
  response_xml       text,
  approved_at        timestamptz,
  -- CAE (en línea) o CAEA (contingencia, se informa después a ARCA).
  emission_type      text not null default 'CAE' check (emission_type in ('CAE', 'CAEA')),
  caea_id            uuid,
  inform_status      text check (inform_status is null or inform_status in ('pendiente', 'informado', 'rechazado')),
  inform_attempts    integer not null default 0,
  inform_next_at     timestamptz,
  informed_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid,
  check ((origin = 'return') = (return_id is not null)),
  check (status <> 'aprobado' or (cae is not null and cbte_nro is not null and cae_vto is not null))
);
comment on table fiscal_documents is
  'Comprobantes fiscales de ARCA (ADR-072): uno por venta, devolución o anulación. El XML se guarda sin Token ni Sign.';

-- Idempotencia fiscal: una venta no se factura dos veces con el mismo tipo y
-- punto de venta (ni una devolución se acredita dos veces).
create unique index if not exists fiscal_documents_idem_uq
  on fiscal_documents (tenant_id, sale_id, coalesce(cbte_tipo, 0), coalesce(pto_vta, 0), origin,
                       coalesce(return_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status <> 'cancelado';
-- Un número autorizado por serie.
create unique index if not exists fiscal_documents_number_uq
  on fiscal_documents (tenant_id, environment, pto_vta, cbte_tipo, cbte_nro)
  where status = 'aprobado';
create index if not exists fiscal_documents_queue_idx
  on fiscal_documents (status, next_attempt_at) where status in ('pendiente', 'enviando');
create index if not exists fiscal_documents_tenant_idx on fiscal_documents (tenant_id, created_at desc);
create index if not exists fiscal_documents_sale_idx on fiscal_documents (sale_id);
drop trigger if exists set_updated_at_fiscal_documents on fiscal_documents;
create trigger set_updated_at_fiscal_documents before update on fiscal_documents
  for each row execute function set_updated_at();

create table if not exists fiscal_document_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  document_id   uuid references fiscal_documents(id) on delete cascade,
  environment   text,
  action        text not null,
  outcome       text not null,
  attempt       integer,
  error_code    text,
  error_msg     text,
  duration_ms   integer,
  request_xml   text,
  response_xml  text,
  created_at    timestamptz not null default now(),
  created_by    uuid
);
create index if not exists fiscal_document_events_tenant_idx on fiscal_document_events (tenant_id, created_at desc);
create index if not exists fiscal_document_events_doc_idx on fiscal_document_events (document_id, created_at desc);

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
create or replace function arca_can_manage()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(stock_my_role() in ('owner', 'manager'), false);
$$;
revoke all on function arca_can_manage() from public, anon;
grant execute on function arca_can_manage() to authenticated;

alter table arca_settings enable row level security;
drop policy if exists arca_settings_select on arca_settings;
create policy arca_settings_select on arca_settings for select
  using ((tenant_id = current_tenant_id() and (select arca_can_manage())) or internal_scope());

-- El estado fiscal se ve donde se ve la venta (hereda la RLS de sales, con
-- su alcance por sucursal): el cajero ve el CAE de su ticket.
alter table fiscal_documents enable row level security;
drop policy if exists fiscal_documents_select on fiscal_documents;
create policy fiscal_documents_select on fiscal_documents for select
  using ((tenant_id = current_tenant_id()
          and exists (select 1 from sales s where s.id = fiscal_documents.sale_id))
         or internal_scope());

alter table fiscal_document_events enable row level security;
drop policy if exists fiscal_document_events_select on fiscal_document_events;
create policy fiscal_document_events_select on fiscal_document_events for select
  using ((tenant_id = current_tenant_id() and (select arca_can_manage())) or internal_scope());

revoke insert, update, delete on arca_settings, fiscal_documents, fiscal_document_events from anon, authenticated;
grant select on arca_settings, fiscal_documents, fiscal_document_events to authenticated;

-- -----------------------------------------------------------------------------
-- E) Tipo de comprobante y punto de venta
-- -----------------------------------------------------------------------------
-- Espejo de cbteTipoFor() (supabase/functions/_shared/arca/comprobante.ts).
-- Códigos de FEParamGetTiposCbte: 1/2/3 A, 6/7/8 B, 11/12/13 C, 51/52/53 M,
-- 19/20/21 E (exportación, WSFEX: no se emite por WSFEv1).
create or replace function arca_cbte_tipo(p_letter text, p_kind text)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_letter
    when 'A' then case p_kind when 'factura' then 1 when 'nd' then 2 when 'nc' then 3 end
    when 'B' then case p_kind when 'factura' then 6 when 'nd' then 7 when 'nc' then 8 end
    when 'C' then case p_kind when 'factura' then 11 when 'nd' then 12 when 'nc' then 13 end
    when 'M' then case p_kind when 'factura' then 51 when 'nd' then 52 when 'nc' then 53 end
    when 'E' then case p_kind when 'factura' then 19 when 'nd' then 20 when 'nc' then 21 end
  end;
$$;
grant execute on function arca_cbte_tipo(text, text) to authenticated, service_role;

-- Punto de venta: el de la caja del turno; si no tiene, el de la sucursal.
create or replace function arca_pos_for(p_store uuid, p_shift uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select r.afip_pos_number from cash_shifts sh join cash_registers r on r.id = sh.cash_register_id
      where sh.id = p_shift),
    (select s.afip_pos_number from stores s where s.id = p_store));
$$;
revoke all on function arca_pos_for(uuid, uuid) from public, anon;
grant execute on function arca_pos_for(uuid, uuid) to authenticated, service_role;

-- Qué falta para poder mandar el comprobante (null = nada).
create or replace function _arca_blocker(p_letter text, p_pv integer, p_receptor jsonb, p_origin text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_letter is null then 'emisor_sin_configurar'
    when p_letter = 'E' then 'exportacion_no_soportada'
    when p_pv is null then 'sin_punto_de_venta'
    when p_letter in ('A', 'M') and coalesce((p_receptor ->> 'arca_doc_type')::int, 99) <> 80
      then 'receptor_sin_cuit'
    when p_origin = 'sale' and coalesce((p_receptor ->> 'requires_identification')::boolean, false)
         and coalesce(nullif(p_receptor ->> 'doc_number', ''), '0') = '0'
      then 'consumidor_final_sin_identificar'
    else null
  end;
$$;

create or replace function _arca_blocker_msg(p_code text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_code
    when 'emisor_sin_configurar' then 'Faltan la condición frente al IVA y el CUIT del negocio (Configuración > Impuestos).'
    when 'exportacion_no_soportada' then 'La factura E de exportación va por WSFEX y todavía no se emite.'
    when 'sin_punto_de_venta' then 'La sucursal o la caja no tiene punto de venta de ARCA.'
    when 'receptor_sin_cuit' then 'La factura A necesita el CUIT del cliente.'
    when 'consumidor_final_sin_identificar' then 'Por el monto, el consumidor final tiene que estar identificado con su documento.'
    else p_code
  end;
$$;

-- -----------------------------------------------------------------------------
-- F) Encolado
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

-- Nota de crédito de una devolución: sólo si la venta tiene factura (aprobada
-- o en camino). La NC espera en la cola hasta que la factura esté aprobada.
create or replace function arca_enqueue_return(p_return_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ret  sale_returns%rowtype;
  v_orig fiscal_documents%rowtype;
  v_new  uuid;
begin
  select * into v_ret from sale_returns where id = p_return_id;
  if not found then
    return null;
  end if;
  if not tenant_has_feature_for(v_ret.tenant_id, 'facturacion_afip') then
    return null;
  end if;
  select * into v_orig from fiscal_documents
   where tenant_id = v_ret.tenant_id and sale_id = v_ret.sale_id and origin = 'sale'
     and status not in ('cancelado', 'rechazado')
   order by created_at desc limit 1;
  if not found then
    return null;
  end if;
  insert into fiscal_documents (tenant_id, sale_id, return_id, origin, assoc_document_id, environment, store_id,
                                cbte_letter, cbte_tipo, pto_vta, imp_total, status, last_error_code,
                                last_error_msg, created_by)
  values (v_ret.tenant_id, v_ret.sale_id, v_ret.id, 'return', v_orig.id, v_orig.environment, v_orig.store_id,
          v_orig.cbte_letter, arca_cbte_tipo(v_orig.cbte_letter, 'nc'), v_orig.pto_vta, v_ret.total,
          case when v_orig.cbte_letter is null or v_orig.pto_vta is null then 'requiere_accion' else 'pendiente' end,
          case when v_orig.cbte_letter is null or v_orig.pto_vta is null then 'factura_sin_datos' end,
          case when v_orig.cbte_letter is null or v_orig.pto_vta is null
               then 'La factura original todavía no tiene tipo o punto de venta.' end,
          auth.uid())
  on conflict do nothing
  returning id into v_new;
  return v_new;
end;
$$;
revoke all on function arca_enqueue_return(uuid) from public, anon, authenticated;
grant execute on function arca_enqueue_return(uuid) to service_role;

-- Nota de crédito por el total (anulación de una venta ya facturada).
create or replace function arca_enqueue_void_nc(p_sale_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_orig fiscal_documents%rowtype;
  v_new  uuid;
begin
  select * into v_orig from fiscal_documents
   where sale_id = p_sale_id and origin = 'sale' and status = 'aprobado'
   order by created_at desc limit 1;
  if not found then
    return null;
  end if;
  insert into fiscal_documents (tenant_id, sale_id, origin, assoc_document_id, environment, store_id,
                                cbte_letter, cbte_tipo, pto_vta, imp_total, status, created_by)
  values (v_orig.tenant_id, v_orig.sale_id, 'void', v_orig.id, v_orig.environment, v_orig.store_id,
          v_orig.cbte_letter, arca_cbte_tipo(v_orig.cbte_letter, 'nc'), v_orig.pto_vta, v_orig.imp_total,
          'pendiente', auth.uid())
  on conflict do nothing
  returning id into v_new;
  return v_new;
end;
$$;
revoke all on function arca_enqueue_void_nc(uuid) from public, anon, authenticated;
grant execute on function arca_enqueue_void_nc(uuid) to service_role;

-- Venta anulada: si la factura nunca llegó a ARCA (sin número), se cancela;
-- si está en vuelo o con resultado incierto, se marca y la NC sale al
-- aprobarse; si ya está aprobada, se encola la NC por el total.
create or replace function arca_on_void(p_sale_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc fiscal_documents%rowtype;
begin
  select * into v_doc from fiscal_documents
   where sale_id = p_sale_id and origin = 'sale' and status <> 'cancelado'
   order by created_at desc limit 1
   for update;
  if not found then
    return;
  end if;
  if v_doc.status = 'aprobado' then
    perform arca_enqueue_void_nc(p_sale_id);
  elsif v_doc.status <> 'enviando' and v_doc.cbte_nro is null then
    update fiscal_documents
       set status = 'cancelado', last_error_code = 'venta_anulada',
           last_error_msg = 'Venta anulada antes de facturar', claimed_at = null
     where id = v_doc.id;
  else
    update fiscal_documents set void_requested = true where id = v_doc.id;
  end if;
end;
$$;
revoke all on function arca_on_void(uuid) from public, anon, authenticated;
grant execute on function arca_on_void(uuid) to service_role;

create or replace function arca_sales_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from arca_settings where tenant_id = new.tenant_id and enabled) then
    return null;
  end if;
  begin
    if tg_op = 'INSERT' then
      if new.status = 'completed' then
        perform arca_enqueue_sale(new.id, false);
      end if;
    elsif new.status is distinct from old.status then
      if new.status = 'completed' then
        perform arca_enqueue_sale(new.id, false);
      elsif new.status = 'voided' then
        perform arca_on_void(new.id);
      end if;
    end if;
  exception when others then
    -- La facturación nunca frena una venta: queda para emitir a mano.
    raise warning 'arca_sales_trg: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function arca_sales_trg() from public, anon, authenticated;

drop trigger if exists arca_sales_enqueue on sales;
create trigger arca_sales_enqueue
  after insert or update of status on sales
  for each row execute function arca_sales_trg();

create or replace function arca_returns_trg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from arca_settings where tenant_id = new.tenant_id and enabled) then
    return null;
  end if;
  begin
    if tg_op = 'INSERT' then
      perform arca_enqueue_return(new.id);
    elsif new.total is distinct from old.total then
      -- El total de la devolución se completa después de sus renglones.
      update fiscal_documents set imp_total = new.total
       where return_id = new.id and status in ('pendiente', 'requiere_accion') and cbte_nro is null;
    end if;
  exception when others then
    raise warning 'arca_returns_trg: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function arca_returns_trg() from public, anon, authenticated;

drop trigger if exists arca_returns_enqueue on sale_returns;
create trigger arca_returns_enqueue
  after insert or update of total on sale_returns
  for each row execute function arca_returns_trg();

-- -----------------------------------------------------------------------------
-- Checklist de habilitación de producción
-- -----------------------------------------------------------------------------
create or replace function _arca_checklist(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_set     arca_settings%rowtype;
  v_mode    text;
  v_tax     jsonb := _tax_settings_eff(p_tenant);
  v_cuit    text := v_tax ->> 'cuit';
  v_homo    integer;
  v_min     integer;
  v_pvs     integer[];
  v_items   jsonb;
  v_fiscal  boolean;
  v_cert    boolean;
  v_homo_ok boolean;
  v_test    boolean;
  v_pos     boolean;
begin
  select * into v_set from arca_settings where tenant_id = p_tenant;
  v_mode := coalesce(v_set.auth_mode, 'propio');
  v_min := coalesce(v_set.homo_min_approved, 3);
  v_fiscal := v_cuit is not null and (v_tax ->> 'iva_condition') is not null;
  -- Certificado de producción: el propio (vigente y de la CUIT del negocio)
  -- o, delegando, el de la plataforma.
  if v_mode = 'propio' then
    v_cert := exists (select 1 from arca_certificates c
                       where c.tenant_id = p_tenant and c.environment = 'produccion' and c.status = 'active'
                         and c.deleted_at is null and c.not_after > now() + interval '1 day'
                         and c.cuit is not distinct from v_cuit);
  else
    v_cert := arca_platform_ready('produccion');
  end if;
  select count(*) into v_homo from fiscal_documents d
   where d.tenant_id = p_tenant and d.environment = 'homologacion' and d.status = 'aprobado';
  -- Con certificado propio se exigen comprobantes de prueba aprobados; al
  -- delegar, el certificado de la plataforma ya está probado.
  v_homo_ok := v_mode = 'delegado' or v_homo >= v_min;
  -- Prueba completa en producción en los últimos 7 días: WSAA + FEDummy +
  -- FECompUltimoAutorizado con la CUIT del negocio (prueba la autorización
  -- de wsfe o la delegación).
  v_test := v_set.prod_test_ok_at is not null and v_set.prod_test_ok_at > now() - interval '7 days';
  select array_agg(distinct x) into v_pvs from (
    select s.afip_pos_number as x from stores s
     where s.tenant_id = p_tenant and s.deleted_at is null and s.afip_pos_number is not null
    union
    select r.afip_pos_number from cash_registers r join stores s on s.id = r.store_id
     where s.tenant_id = p_tenant and r.deleted_at is null and s.deleted_at is null and r.afip_pos_number is not null
  ) q;
  v_pos := v_pvs is not null and v_set.prod_pos_verified is not null
           and v_set.prod_pos_verified_at > now() - interval '7 days'
           and v_pvs <@ v_set.prod_pos_verified;
  v_items := jsonb_build_array(
    jsonb_build_object('key', 'fiscal_data', 'ok', v_fiscal),
    jsonb_build_object('key', 'certificado', 'ok', v_cert, 'mode', v_mode),
    jsonb_build_object('key', 'homologacion_ok', 'ok', v_homo_ok, 'count', v_homo, 'min', v_min,
                       'required', v_mode = 'propio'),
    jsonb_build_object('key', 'conexion_produccion', 'ok', v_test, 'at', v_set.prod_test_ok_at),
    jsonb_build_object('key', 'puntos_de_venta', 'ok', v_pos, 'pos', to_jsonb(coalesce(v_pvs, '{}')),
                       'verified', to_jsonb(coalesce(v_set.prod_pos_verified, '{}'))));
  return jsonb_build_object(
    'mode', v_mode,
    'items', v_items,
    'ready', v_fiscal and v_cert and v_homo_ok and v_test and v_pos);
end;
$$;
revoke all on function _arca_checklist(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- G) RPC de la pantalla
-- -----------------------------------------------------------------------------
create or replace function arca_assert(p_write boolean default true)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if coalesce(stock_my_role(), '') not in ('owner', 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_write and not tenant_has_feature_for(v_tenant, 'facturacion_afip') then
    raise exception 'feature_not_in_plan: facturacion_afip';
  end if;
  return v_tenant;
end;
$$;
revoke all on function arca_assert(boolean) from public, anon;
grant execute on function arca_assert(boolean) to authenticated;

create or replace function arca_config_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := arca_assert(false);
  v_tax    jsonb := _tax_settings_eff(v_tenant);
begin
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from arca_settings s where s.tenant_id = v_tenant),
    'feature', tenant_has_feature_for(v_tenant, 'facturacion_afip'),
    'can_owner', coalesce(stock_my_role() = 'owner', false),
    'platform', coalesce((select jsonb_object_agg(pl.environment, jsonb_build_object(
                  'cuit', case when arca_platform_ready(pl.environment) then pl.cuit end,
                  'ready', arca_platform_ready(pl.environment)))
                  from arca_platform pl), '{}'::jsonb),
    'emitter', jsonb_build_object('cuit', v_tax ->> 'cuit', 'iva_condition', v_tax ->> 'iva_condition'),
    'certificates', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'environment', c.environment, 'status', c.status, 'cuit', c.cuit,
               'subject', c.subject, 'issuer', c.issuer, 'serial', c.serial,
               'not_before', c.not_before, 'not_after', c.not_after,
               'fingerprint_sha256', c.fingerprint_sha256, 'created_at', c.created_at,
               'csr_pem', c.csr_pem)
             order by c.environment, c.created_at desc)
        from arca_certificates c
       where c.tenant_id = v_tenant and c.deleted_at is null and c.status in ('active', 'pending_csr')), '[]'::jsonb),
    'checklist', _arca_checklist(v_tenant),
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'afip_pos_number', s.afip_pos_number, 'is_default', s.is_default,
               'registers', coalesce((
                 select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'afip_pos_number', r.afip_pos_number)
                                  order by r.sort, r.name)
                   from cash_registers r where r.store_id = s.id and r.deleted_at is null), '[]'::jsonb))
             order by s.is_default desc, s.sort, s.name)
        from stores s where s.tenant_id = v_tenant and s.deleted_at is null), '[]'::jsonb),
    'counts', coalesce((
      select jsonb_object_agg(x.status, x.n)
        from (select d.status, count(*) as n from fiscal_documents d
               where d.tenant_id = v_tenant group by d.status) x), '{}'::jsonb),
    'caea', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'environment', c.environment, 'periodo', c.periodo, 'orden', c.orden, 'caea', c.caea,
               'fch_vig_desde', c.fch_vig_desde, 'fch_vig_hasta', c.fch_vig_hasta, 'fch_tope_inf', c.fch_tope_inf,
               'sin_movimiento_at', c.sin_movimiento_at, 'sin_movimiento_error', c.sin_movimiento_error,
               'used', (select count(*) from fiscal_documents d where d.caea_id = c.id),
               'to_inform', (select count(*) from fiscal_documents d where d.caea_id = c.id and d.inform_status = 'pendiente'),
               'rejected', (select count(*) from fiscal_documents d where d.caea_id = c.id and d.inform_status = 'rechazado'))
             order by c.periodo desc, c.orden desc)
        from (select * from arca_caea c where c.tenant_id = v_tenant
               order by c.periodo desc, c.orden desc limit 6) c), '[]'::jsonb),
    'dead_letter', (select count(*) from fiscal_documents d
                     where d.tenant_id = v_tenant and d.dead_letter_at is not null and d.status = 'requiere_accion'));
end;
$$;
revoke all on function arca_config_get() from public, anon;
grant execute on function arca_config_get() to authenticated;

create or replace function arca_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := arca_assert(true);
  v_before arca_settings%rowtype;
  v_row    arca_settings%rowtype;
  v_tax    jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'invalid_settings';
  end if;
  insert into arca_settings (tenant_id) values (v_tenant) on conflict (tenant_id) do nothing;
  select * into v_before from arca_settings where tenant_id = v_tenant for update;
  v_row := v_before;
  if p ? 'enabled' then v_row.enabled := coalesce((p ->> 'enabled')::boolean, false); end if;
  if p ? 'auth_mode' then
    if p ->> 'auth_mode' not in ('delegado', 'propio') then raise exception 'invalid_auth_mode'; end if;
    -- Cambiar de camino en producción no se hace en caliente.
    if p ->> 'auth_mode' <> v_before.auth_mode and v_before.environment = 'produccion' then
      raise exception 'auth_mode_locked_in_production';
    end if;
    if p ->> 'auth_mode' = 'delegado' and not arca_platform_ready(v_before.environment) then
      raise exception 'platform_not_configured';
    end if;
    v_row.auth_mode := p ->> 'auth_mode';
  end if;
  if p ? 'max_attempts' then v_row.max_attempts := (p ->> 'max_attempts')::integer; end if;
  if p ? 'homo_min_approved' then v_row.homo_min_approved := (p ->> 'homo_min_approved')::integer; end if;
  if p ? 'caea_enabled' then v_row.caea_enabled := coalesce((p ->> 'caea_enabled')::boolean, false); end if;
  if p ? 'caea_pto_vta' then v_row.caea_pto_vta := nullif(p ->> 'caea_pto_vta', '')::integer; end if;
  if p ? 'caea_timeout_seconds' then v_row.caea_timeout_seconds := (p ->> 'caea_timeout_seconds')::integer; end if;
  if v_row.caea_enabled then
    if v_row.caea_pto_vta is null then
      raise exception 'caea_pto_vta_missing';
    end if;
    -- ARCA exige un punto de venta exclusivo para CAEA.
    if exists (select 1 from stores s where s.tenant_id = v_tenant and s.deleted_at is null
                  and s.afip_pos_number = v_row.caea_pto_vta)
       or exists (select 1 from cash_registers r join stores s on s.id = r.store_id
                   where s.tenant_id = v_tenant and r.deleted_at is null and r.afip_pos_number = v_row.caea_pto_vta) then
      raise exception 'caea_pto_vta_in_use';
    end if;
    if not v_before.caea_enabled or v_before.caea_pto_vta is distinct from v_row.caea_pto_vta then
      v_row.caea_next_check_at := now();
    end if;
  end if;
  if v_row.enabled then
    v_tax := _tax_settings_eff(v_tenant);
    if (v_tax ->> 'cuit') is null or (v_tax ->> 'iva_condition') is null then
      raise exception 'fiscal_data_missing';
    end if;
    if v_row.auth_mode = 'propio' and not exists (
         select 1 from arca_certificates c
          where c.tenant_id = v_tenant and c.environment = v_row.environment
            and c.status = 'active' and c.deleted_at is null) then
      raise exception 'certificate_missing';
    end if;
    if v_row.auth_mode = 'delegado' and not arca_platform_ready(v_row.environment) then
      raise exception 'platform_not_configured';
    end if;
    -- Al prender: desde ahora (nunca una avalancha de ventas viejas).
    if not v_before.enabled then
      v_row.start_at := now();
    end if;
  end if;
  update arca_settings set
    enabled = v_row.enabled, auth_mode = v_row.auth_mode, start_at = v_row.start_at, max_attempts = v_row.max_attempts,
    homo_min_approved = v_row.homo_min_approved, caea_enabled = v_row.caea_enabled,
    caea_pto_vta = v_row.caea_pto_vta, caea_timeout_seconds = v_row.caea_timeout_seconds,
    caea_next_check_at = v_row.caea_next_check_at, updated_by = auth.uid()
  where tenant_id = v_tenant
  returning * into v_row;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'arca_settings', null, 'arca_settings_updated',
          jsonb_build_object('enabled', v_before.enabled, 'auth_mode', v_before.auth_mode,
                             'max_attempts', v_before.max_attempts, 'homo_min_approved', v_before.homo_min_approved),
          jsonb_build_object('enabled', v_row.enabled, 'auth_mode', v_row.auth_mode, 'max_attempts', v_row.max_attempts,
                             'homo_min_approved', v_row.homo_min_approved, 'caea_enabled', v_row.caea_enabled,
                             'caea_pto_vta', v_row.caea_pto_vta, 'caea_timeout_seconds', v_row.caea_timeout_seconds));
  return to_jsonb(v_row);
end;
$$;
revoke all on function arca_settings_save(jsonb) from public, anon;
grant execute on function arca_settings_save(jsonb) to authenticated;

-- Ambiente. A producción sólo con el checklist completo; volver a
-- homologación siempre se puede. Los comprobantes ya encolados siguen en el
-- ambiente en el que se crearon.
create or replace function arca_set_environment(p_environment text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := arca_assert(true);
  v_before text;
  v_check  jsonb;
begin
  if p_environment not in ('homologacion', 'produccion') then
    raise exception 'invalid_environment';
  end if;
  insert into arca_settings (tenant_id) values (v_tenant) on conflict (tenant_id) do nothing;
  select environment into v_before from arca_settings where tenant_id = v_tenant for update;
  v_check := _arca_checklist(v_tenant);
  if p_environment = 'produccion' and not coalesce((v_check ->> 'ready')::boolean, false) then
    raise exception 'checklist_incomplete';
  end if;
  if p_environment = 'produccion' and coalesce(stock_my_role(), '') <> 'owner' then
    raise exception 'owner_required' using errcode = '42501';
  end if;
  update arca_settings set environment = p_environment, updated_by = auth.uid() where tenant_id = v_tenant;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'arca_settings', null, 'arca_environment_changed',
          jsonb_build_object('environment', v_before),
          jsonb_build_object('environment', p_environment, 'checklist', v_check),
          nullif(btrim(coalesce(p_reason, '')), ''));
  return jsonb_build_object('ok', true, 'environment', p_environment, 'checklist', v_check);
end;
$$;
revoke all on function arca_set_environment(text, text) from public, anon;
grant execute on function arca_set_environment(text, text) to authenticated;

-- Reproceso manual: un comprobante rechazado o que pide acción vuelve a la
-- cola. Sin número asignado, se recalculan letra, tipo y punto de venta con
-- los datos de hoy y se refresca el receptor desde la ficha del cliente.
create or replace function arca_document_retry(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := arca_assert(true);
  v_doc    fiscal_documents%rowtype;
  v_sale   sales%rowtype;
  v_cust   customers%rowtype;
  v_rec    jsonb;
  v_letter text;
  v_pv     integer;
  v_block  text;
  v_tax    jsonb;
  v_doc_n  text;
begin
  select * into v_doc from fiscal_documents where id = p_id and tenant_id = v_tenant for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_doc.status not in ('rechazado', 'requiere_accion') then
    raise exception 'invalid_status';
  end if;
  select * into v_sale from sales where id = v_doc.sale_id;
  v_rec := coalesce(v_doc.receptor_override, v_sale.fiscal_snapshot -> 'receptor', '{}'::jsonb);
  v_letter := v_doc.cbte_letter;
  v_pv := v_doc.pto_vta;

  if v_doc.cbte_nro is null and v_doc.origin = 'sale' then
    if v_sale.customer_id is not null then
      select * into v_cust from customers where id = v_sale.customer_id and tenant_id = v_tenant;
      if found then
        v_doc_n := nullif(regexp_replace(coalesce(v_cust.document_number, ''), '\D', '', 'g'), '');
        v_rec := jsonb_build_object(
          'customer_id', v_cust.id, 'name', v_cust.name,
          'iva_condition', coalesce(v_cust.iva_condition, 'consumidor_final'),
          'arca_condition_id', fiscal_condition_arca_id(v_cust.iva_condition),
          'doc_type', case when v_doc_n is null then null else v_cust.document_type end,
          'arca_doc_type', case when v_doc_n is null then 99 else doc_type_arca_id(v_cust.document_type) end,
          'doc_number', coalesce(v_doc_n, '0'), 'address', v_cust.address);
      end if;
    end if;
    -- Letra con los datos de hoy (el negocio pudo completar su condición o
    -- el cliente su CUIT); sin emisor configurado queda la de la venta.
    v_tax := _tax_settings_eff(v_tenant);
    if (v_tax ->> 'iva_condition') is not null then
      v_letter := cbte_letter_infer(v_tax ->> 'iva_condition', v_rec ->> 'iva_condition',
                                    coalesce((v_tax ->> 'issues_cbte_m')::boolean, false));
    else
      v_letter := v_sale.cbte_letter;
    end if;
    v_pv := coalesce(v_doc.pto_vta, arca_pos_for(v_sale.store_id, v_sale.cash_shift_id));
    v_block := _arca_blocker(v_letter, v_pv,
                             v_rec || jsonb_build_object('requires_identification',
                                        coalesce(v_sale.fiscal_snapshot -> 'requires_identification', 'false'::jsonb)),
                             'sale');
  elsif v_doc.cbte_nro is null then
    v_block := _arca_blocker(v_letter, v_pv, '{"arca_doc_type": 80}'::jsonb, v_doc.origin);
  end if;

  update fiscal_documents set
    cbte_letter = v_letter,
    cbte_tipo = case when cbte_nro is null
                     then arca_cbte_tipo(v_letter, case when origin = 'sale' then 'factura' else 'nc' end)
                     else cbte_tipo end,
    pto_vta = v_pv,
    receptor_override = case when origin = 'sale' and cbte_nro is null then v_rec else receptor_override end,
    status = case when v_block is null then 'pendiente' else 'requiere_accion' end,
    attempts = 0, next_attempt_at = now(), claimed_at = null, dead_letter_at = null,
    last_error_code = v_block, last_error_msg = _arca_blocker_msg(v_block)
  where id = p_id
  returning * into v_doc;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'fiscal_documents', p_id, 'arca_document_retry',
          jsonb_build_object('status', v_doc.status, 'cbte_tipo', v_doc.cbte_tipo, 'pto_vta', v_doc.pto_vta,
                             'blocker', v_block));
  return jsonb_build_object('ok', true, 'status', v_doc.status, 'blocker', v_block);
end;
$$;
revoke all on function arca_document_retry(uuid) from public, anon;
grant execute on function arca_document_retry(uuid) to authenticated;

-- Emitir la factura de una venta que no entró sola (anterior a la
-- activación, o encolada a mano).
create or replace function arca_enqueue_sale_manual(p_sale_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := arca_assert(true);
  v_id     uuid;
begin
  if not exists (select 1 from sales where id = p_sale_id and tenant_id = v_tenant) then
    raise exception 'not_found';
  end if;
  if not exists (select 1 from arca_settings where tenant_id = v_tenant and enabled) then
    raise exception 'not_enabled';
  end if;
  v_id := arca_enqueue_sale(p_sale_id, true);
  if v_id is null then
    raise exception 'already_enqueued';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'fiscal_documents', v_id, 'arca_document_enqueued',
          jsonb_build_object('sale_id', p_sale_id));
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
revoke all on function arca_enqueue_sale_manual(uuid) from public, anon;
grant execute on function arca_enqueue_sale_manual(uuid) to authenticated;

-- Borrar (baja lógica) un certificado o un pedido de CSR. La clave cifrada
-- queda en la fila borrada para la auditoría de la cadena; el ticket cacheado
-- se descarta.
create or replace function arca_certificate_delete(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := arca_assert(false);
  v_row    arca_certificates%rowtype;
begin
  update arca_certificates set deleted_at = now()
   where id = p_id and tenant_id = v_tenant and deleted_at is null
  returning * into v_row;
  if not found then
    raise exception 'not_found';
  end if;
  delete from arca_tickets where tenant_id = v_tenant and certificate_id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
  values (v_tenant, auth.uid(), 'arca_certificates', p_id, 'arca_certificate_deleted',
          jsonb_build_object('environment', v_row.environment, 'status', v_row.status, 'cuit', v_row.cuit,
                             'serial', v_row.serial, 'not_after', v_row.not_after));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function arca_certificate_delete(uuid) from public, anon;
grant execute on function arca_certificate_delete(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC de la Edge (sólo service_role)
-- -----------------------------------------------------------------------------
-- El usuario del JWT, ¿puede operar la facturación? null = sí. p_member:
-- cualquier miembro activo (emitir la factura de la venta recién hecha);
-- si no, dueño o encargado.
create or replace function arca_edge_guard(p_tenant uuid, p_user uuid, p_write boolean default true,
                                           p_member boolean default false)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not exists (select 1 from tenant_users
                      where tenant_id = p_tenant and user_id = p_user and status = 'active'
                        and (p_member or role in ('owner', 'manager'))) then 'forbidden'
    when p_write and not tenant_has_feature_for(p_tenant, 'facturacion_afip') then 'feature_not_in_plan'
    else null
  end;
$$;
revoke all on function arca_edge_guard(uuid, uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function arca_edge_guard(uuid, uuid, boolean, boolean) to service_role;

-- Trabajo pendiente de un negocio: comprobantes vencidos en la cola,
-- comprobantes CAEA por informar o tareas de CAEA (pedir el de la quincena,
-- informar sin movimiento) con su revisión vencida.
create or replace function _arca_tenant_due(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
           select 1 from fiscal_documents d
            where d.tenant_id = p_tenant
              and ((d.status = 'pendiente' and d.next_attempt_at <= now())
                   or (d.status = 'enviando' and d.claimed_at < now() - interval '3 minutes')
                   or (d.inform_status = 'pendiente' and coalesce(d.inform_next_at, now()) <= now())))
      or exists (select 1 from arca_settings s
                  where s.tenant_id = p_tenant and s.caea_enabled and s.caea_pto_vta is not null
                    and coalesce(s.caea_next_check_at, now()) <= now());
$$;
revoke all on function _arca_tenant_due(uuid) from public, anon, authenticated;

-- ¿Hay algo para hacer? (condición del cron: no llama a la Edge en vano).
create or replace function arca_any_due()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from arca_settings s where s.enabled and _arca_tenant_due(s.tenant_id));
$$;
revoke all on function arca_any_due() from public, anon, authenticated;
grant execute on function arca_any_due() to service_role, postgres;

create or replace function arca_due_tenants(p_limit integer default 20)
returns table (tenant_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.tenant_id
    from arca_settings s
   where s.enabled
     and _arca_tenant_due(s.tenant_id)
     and tenant_has_feature_for(s.tenant_id, 'facturacion_afip')
   order by coalesce(s.last_worker_at, '-infinity'::timestamptz)
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;
revoke all on function arca_due_tenants(integer) from public, anon, authenticated;
grant execute on function arca_due_tenants(integer) to service_role;

-- Toma con lease: a lo sumo un comprobante en vuelo por serie (ambiente,
-- punto de venta, tipo), porque el número se pide a ARCA justo antes. Un
-- "enviando" con el lease vencido vuelve como recuperación (resultado
-- incierto: la Edge consulta ARCA antes de volver a mandar). Las notas de
-- crédito esperan a que su factura esté aprobada.
create or replace function arca_claim(p_tenant uuid, p_limit integer default 10, p_ids uuid[] default null)
returns table (id uuid, recovering boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r       record;
  v_taken text[] := '{}';
  v_key   text;
  v_n     integer := 0;
begin
  if not exists (select 1 from arca_settings s where s.tenant_id = p_tenant and s.enabled)
     or not tenant_has_feature_for(p_tenant, 'facturacion_afip') then
    return;
  end if;
  for r in
    select d.* from fiscal_documents d
     where d.tenant_id = p_tenant
       and (p_ids is null or d.id = any (p_ids))
       and ((d.status = 'pendiente' and (d.next_attempt_at <= now() or p_ids is not null))
            or (d.status = 'enviando' and d.claimed_at < now() - interval '3 minutes'))
       and (d.assoc_document_id is null
            or exists (select 1 from fiscal_documents a where a.id = d.assoc_document_id and a.status = 'aprobado'))
     order by d.created_at, d.id
     limit 200
     for update skip locked
  loop
    v_key := r.environment || ':' || coalesce(r.pto_vta, 0) || ':' || coalesce(r.cbte_tipo, 0);
    continue when v_key = any (v_taken);
    continue when exists (
      select 1 from fiscal_documents o
       where o.tenant_id = p_tenant and o.environment = r.environment and o.pto_vta = r.pto_vta
         and o.cbte_tipo = r.cbte_tipo and o.status = 'enviando' and o.id <> r.id
         and o.claimed_at >= now() - interval '3 minutes');
    v_taken := v_taken || v_key;
    update fiscal_documents f
       set status = 'enviando', claimed_at = now(), attempts = f.attempts + 1
     where f.id = r.id;
    id := r.id;
    recovering := r.status = 'enviando';
    return next;
    v_n := v_n + 1;
    exit when v_n >= greatest(1, coalesce(p_limit, 10));
  end loop;
end;
$$;
revoke all on function arca_claim(uuid, integer, uuid[]) from public, anon, authenticated;
grant execute on function arca_claim(uuid, integer, uuid[]) to service_role;

-- Foto de lo necesario para armar el FECAESolicitar.
create or replace function arca_snapshot(p_doc uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc   fiscal_documents%rowtype;
  v_sale  sales%rowtype;
  v_tax   jsonb;
  v_assoc fiscal_documents%rowtype;
begin
  select * into v_doc from fiscal_documents where id = p_doc;
  if not found then
    return null;
  end if;
  select * into v_sale from sales where id = v_doc.sale_id;
  v_tax := _tax_settings_eff(v_doc.tenant_id);
  if v_doc.assoc_document_id is not null then
    select * into v_assoc from fiscal_documents where id = v_doc.assoc_document_id;
  end if;
  return jsonb_build_object(
    'document', to_jsonb(v_doc) - 'request_xml' - 'response_xml' - 'events',
    'sale', jsonb_build_object(
      'id', v_sale.id, 'number', v_sale.number, 'created_at', v_sale.created_at, 'status', v_sale.status,
      'total', v_sale.total, 'net_taxed', v_sale.net_taxed, 'net_exempt', v_sale.net_exempt,
      'net_untaxed', v_sale.net_untaxed, 'iva_total', v_sale.iva_total,
      'internal_tax_total', v_sale.internal_tax_total, 'perception_total', v_sale.perception_total,
      'cbte_letter', v_sale.cbte_letter,
      'receptor', coalesce(v_doc.receptor_override, v_sale.fiscal_snapshot -> 'receptor', '{}'::jsonb)),
    'tax_lines', coalesce((
      select jsonb_agg(jsonb_build_object('kind', l.kind, 'tax', l.tax, 'rate_code', l.rate_code, 'rate', l.rate,
                                          'base', l.base, 'amount', l.amount, 'arca_id', l.arca_id,
                                          'jurisdiction', l.jurisdiction, 'name', l.name) order by l.created_at, l.id)
        from sale_tax_lines l where l.sale_id = v_sale.id), '[]'::jsonb),
    'has_services', exists (select 1 from sale_items i join products p on p.id = i.product_id
                             where i.sale_id = v_sale.id and p.is_service),
    'has_goods', exists (select 1 from sale_items i left join products p on p.id = i.product_id
                          where i.sale_id = v_sale.id and coalesce(p.is_service, false) = false),
    'return_total', (select r.total from sale_returns r where r.id = v_doc.return_id),
    'credited_total', coalesce((
      select sum(o.imp_total) from fiscal_documents o
       where o.sale_id = v_doc.sale_id and o.origin = 'return' and o.id <> v_doc.id
         and o.status not in ('cancelado', 'rechazado')), 0),
    'assoc', case when v_doc.assoc_document_id is null then null else jsonb_build_object(
      'cbte_tipo', v_assoc.cbte_tipo, 'pto_vta', v_assoc.pto_vta, 'cbte_nro', v_assoc.cbte_nro,
      'cbte_fch', v_assoc.cbte_fch, 'imp_total', v_assoc.imp_total) end,
    'emitter', jsonb_build_object('cuit', v_tax ->> 'cuit', 'iva_condition', v_tax ->> 'iva_condition'),
    'last_fch', (select max(o.cbte_fch) from fiscal_documents o
                  where o.tenant_id = v_doc.tenant_id and o.environment = v_doc.environment
                    and o.pto_vta = v_doc.pto_vta and o.cbte_tipo = v_doc.cbte_tipo and o.status = 'aprobado'),
    'settings', (select jsonb_build_object('max_attempts', s.max_attempts, 'auth_mode', s.auth_mode,
                                            'caea_enabled', s.caea_enabled, 'caea_pto_vta', s.caea_pto_vta,
                                            'caea_timeout_seconds', s.caea_timeout_seconds)
                   from arca_settings s where s.tenant_id = v_doc.tenant_id));
end;
$$;
revoke all on function arca_snapshot(uuid) from public, anon, authenticated;
grant execute on function arca_snapshot(uuid) to service_role;

-- Número asignado (se guarda ANTES de mandar: si el proceso muere, la
-- recuperación sabe qué número consultar en ARCA).
create or replace function arca_mark_sending(p_doc uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update fiscal_documents set
    cbte_nro = (p ->> 'cbte_nro')::bigint,
    cbte_fch = (p ->> 'cbte_fch')::date,
    concepto = (p ->> 'concepto')::integer,
    doc_tipo = (p ->> 'doc_tipo')::integer,
    doc_nro = p ->> 'doc_nro',
    imp_total = coalesce((p ->> 'imp_total')::numeric, imp_total),
    request_xml = p ->> 'request_xml',
    claimed_at = now()
  where id = p_doc and status = 'enviando';
end;
$$;
revoke all on function arca_mark_sending(uuid, jsonb) from public, anon, authenticated;
grant execute on function arca_mark_sending(uuid, jsonb) to service_role;

-- Resultado de un intento. outcome:
--   aprobado         CAE recibido (o recuperado con FECompConsultar).
--   rechazado        ARCA rechazó el comprobante (Resultado R): el número no
--                    se consumió; se corrige y se reprocesa a mano.
--   reintentar       error transitorio (red, 5xx, 500/501/502, numeración
--                    desfasada): vuelve a la cola en next_attempt_at; al
--                    llegar a max_attempts pasa a dead-letter (requiere_accion).
--   requiere_accion  falta algo del negocio (certificado, CUIT no autorizado,
--                    TA ya emitido sin cache): no se reintenta solo.
create or replace function arca_apply_result(p_doc uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc     fiscal_documents%rowtype;
  v_max     integer;
  v_outcome text := p ->> 'outcome';
  v_status  text;
  v_dead    boolean := false;
begin
  select * into v_doc from fiscal_documents where id = p_doc for update;
  if not found then
    return null;
  end if;
  if v_outcome not in ('aprobado', 'rechazado', 'reintentar', 'requiere_accion') then
    raise exception 'invalid_outcome';
  end if;
  select coalesce(s.max_attempts, 10) into v_max from arca_settings s where s.tenant_id = v_doc.tenant_id;
  v_max := coalesce(v_max, 10);
  v_status := v_outcome;
  if v_outcome = 'reintentar' then
    if v_doc.attempts >= v_max then
      v_status := 'requiere_accion';
      v_dead := true;
    else
      v_status := 'pendiente';
    end if;
  end if;

  update fiscal_documents set
    status = v_status,
    claimed_at = null,
    cbte_nro = case
                 when v_outcome = 'aprobado' then coalesce((p ->> 'cbte_nro')::bigint, cbte_nro)
                 when coalesce((p ->> 'keep_number')::boolean, false) then cbte_nro
                 else null end,
    cbte_fch = case when v_outcome = 'aprobado' then coalesce((p ->> 'cbte_fch')::date, cbte_fch)
                    when coalesce((p ->> 'keep_number')::boolean, false) then cbte_fch else null end,
    cae = case when v_outcome = 'aprobado' then p ->> 'cae' else cae end,
    cae_vto = case when v_outcome = 'aprobado' then (p ->> 'cae_vto')::date else cae_vto end,
    qr_url = case when v_outcome = 'aprobado' then p ->> 'qr_url' else qr_url end,
    approved_at = case when v_outcome = 'aprobado' then now() else approved_at end,
    next_attempt_at = case when v_status = 'pendiente'
                           then coalesce((p ->> 'next_attempt_at')::timestamptz, now() + interval '1 minute')
                           else next_attempt_at end,
    dead_letter_at = case when v_dead then now() else dead_letter_at end,
    last_error_code = case when v_outcome = 'aprobado' then null
                           when v_dead then coalesce(p ->> 'error_code', 'reintentos_agotados')
                           else p ->> 'error_code' end,
    last_error_msg = case when v_outcome = 'aprobado' then null
                          when v_dead then 'Reintentos agotados: ' || coalesce(p ->> 'error_msg', 'sin respuesta de ARCA')
                          else p ->> 'error_msg' end,
    observations = coalesce(p -> 'observations', observations),
    events = coalesce(p -> 'events', events),
    request_xml = coalesce(p ->> 'request_xml', request_xml),
    response_xml = coalesce(p ->> 'response_xml', response_xml)
  where id = p_doc
  returning * into v_doc;

  insert into fiscal_document_events (tenant_id, document_id, environment, action, outcome, attempt, error_code,
                                      error_msg, duration_ms, request_xml, response_xml)
  values (v_doc.tenant_id, v_doc.id, v_doc.environment, coalesce(p ->> 'action', 'FECAESolicitar'),
          case when v_dead then 'dead_letter' else v_outcome end, v_doc.attempts,
          p ->> 'error_code', p ->> 'error_msg', (p ->> 'duration_ms')::integer,
          p ->> 'request_xml', p ->> 'response_xml');

  update arca_settings set last_worker_at = now(),
         contingency_since = case when v_outcome = 'aprobado' then null else contingency_since end
   where tenant_id = v_doc.tenant_id;

  if v_status = 'aprobado' and v_doc.void_requested and v_doc.origin = 'sale' then
    perform arca_enqueue_void_nc(v_doc.sale_id);
  end if;
  return jsonb_build_object('status', v_doc.status, 'dead_letter', v_dead);
end;
$$;
revoke all on function arca_apply_result(uuid, jsonb) from public, anon, authenticated;
grant execute on function arca_apply_result(uuid, jsonb) to service_role;

-- Conexión (test o worker): última conexión y verificación de producción.
create or replace function arca_record_connection(p_tenant uuid, p_env text, p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ok  boolean := coalesce((p ->> 'ok')::boolean, false);
  v_pos integer[];
begin
  insert into arca_settings (tenant_id) values (p_tenant) on conflict (tenant_id) do nothing;
  if p ? 'pos' and jsonb_typeof(p -> 'pos') = 'array' then
    select array_agg(x::integer order by x::integer) into v_pos from jsonb_array_elements_text(p -> 'pos') x;
  end if;
  update arca_settings set
    last_connection_at = now(),
    last_connection_env = p_env,
    last_connection_ok = v_ok,
    last_connection_message = left(p ->> 'message', 500),
    prod_test_ok_at = case when p_env = 'produccion' and v_ok and coalesce((p ->> 'full_test')::boolean, false)
                           then now() else prod_test_ok_at end,
    prod_pos_verified = case when p_env = 'produccion' and v_ok and p ? 'pos' then coalesce(v_pos, '{}') else prod_pos_verified end,
    prod_pos_verified_at = case when p_env = 'produccion' and v_ok and p ? 'pos' then now() else prod_pos_verified_at end
  where tenant_id = p_tenant;
  insert into fiscal_document_events (tenant_id, environment, action, outcome, error_code, error_msg, duration_ms,
                                      created_by)
  values (p_tenant, p_env, coalesce(p ->> 'action', 'test_conexion'), case when v_ok then 'ok' else 'error' end,
          p ->> 'error_code', left(p ->> 'message', 500), (p ->> 'duration_ms')::integer,
          nullif(p ->> 'user_id', '')::uuid);
end;
$$;
revoke all on function arca_record_connection(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function arca_record_connection(uuid, text, jsonb) to service_role;

-- Alta de certificado o de pedido de CSR (la Edge ya cifró la clave).
create or replace function arca_certificate_store(p_tenant uuid, p_user uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_env    text := p ->> 'environment';
  v_status text := coalesce(p ->> 'status', 'active');
  v_id     uuid;
  v_pend   uuid := nullif(p ->> 'pending_id', '')::uuid;
begin
  if v_env not in ('homologacion', 'produccion') or v_status not in ('active', 'pending_csr') then
    raise exception 'invalid_certificate';
  end if;
  if v_status = 'active' then
    update arca_certificates set status = 'replaced', deleted_at = now()
     where tenant_id = p_tenant and environment = v_env and status = 'active' and deleted_at is null;
    delete from arca_tickets where tenant_id = p_tenant and environment = v_env;
  end if;
  if v_status = 'pending_csr' then
    update arca_certificates set deleted_at = now()
     where tenant_id = p_tenant and environment = v_env and status = 'pending_csr' and deleted_at is null;
  end if;

  if v_pend is not null and v_status = 'active' then
    update arca_certificates set
      status = 'active', cert_pem = p ->> 'cert_pem', cuit = p ->> 'cuit', subject = p ->> 'subject',
      issuer = p ->> 'issuer', serial = p ->> 'serial', not_before = (p ->> 'not_before')::timestamptz,
      not_after = (p ->> 'not_after')::timestamptz, fingerprint_sha256 = p ->> 'fingerprint_sha256'
    where id = v_pend and tenant_id = p_tenant and environment = v_env and status = 'pending_csr'
      and deleted_at is null
    returning id into v_id;
    if v_id is null then
      raise exception 'pending_not_found';
    end if;
  else
    insert into arca_certificates (tenant_id, environment, status, cert_pem, csr_pem, key_enc, cuit, subject,
                                   issuer, serial, not_before, not_after, fingerprint_sha256, created_by)
    values (p_tenant, v_env, v_status, p ->> 'cert_pem', p ->> 'csr_pem', p ->> 'key_enc', p ->> 'cuit',
            p ->> 'subject', p ->> 'issuer', p ->> 'serial', (p ->> 'not_before')::timestamptz,
            (p ->> 'not_after')::timestamptz, p ->> 'fingerprint_sha256', p_user)
    returning id into v_id;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, p_user, 'arca_certificates', v_id,
          case when v_status = 'pending_csr' then 'arca_csr_generated' else 'arca_certificate_uploaded' end,
          jsonb_build_object('environment', v_env, 'cuit', p ->> 'cuit', 'serial', p ->> 'serial',
                             'not_after', p ->> 'not_after', 'fingerprint_sha256', p ->> 'fingerprint_sha256'));
  return v_id;
end;
$$;
revoke all on function arca_certificate_store(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function arca_certificate_store(uuid, uuid, jsonb) to service_role;

-- Metadata de la plataforma para el panel interno (staff con is_internal).
create or replace function arca_platform_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not is_internal() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((select jsonb_object_agg(pl.environment, jsonb_build_object(
           'cuit', pl.cuit, 'has_cert', pl.cert_pem is not null, 'has_key', pl.key_enc is not null,
           'pending_csr', pl.cert_pem is null and pl.csr_pem is not null, 'csr_pem', pl.csr_pem,
           'subject', pl.subject, 'issuer', pl.issuer, 'serial', pl.serial, 'not_after', pl.not_after,
           'fingerprint_sha256', pl.fingerprint_sha256, 'ready', arca_platform_ready(pl.environment),
           'updated_at', pl.updated_at))
         from arca_platform pl), '{}'::jsonb);
end;
$$;
revoke all on function arca_platform_get() from public, anon;
grant execute on function arca_platform_get() to authenticated;

-- Escritura de la plataforma (la Edge ya validó y cifró). Auditada.
create or replace function arca_platform_store(p_user uuid, p_env text, p jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  if p_env not in ('homologacion', 'produccion') then
    raise exception 'invalid_environment';
  end if;
  select jsonb_build_object('cuit', cuit, 'serial', serial, 'not_after', not_after) into v_before
    from arca_platform where environment = p_env;
  update arca_platform set
    cuit = case when p ? 'cuit' then nullif(p ->> 'cuit', '') else cuit end,
    csr_pem = case when p ? 'csr_pem' then p ->> 'csr_pem' else csr_pem end,
    key_enc = case when p ? 'key_enc' then p ->> 'key_enc' else key_enc end,
    cert_pem = case when p ? 'cert_pem' then p ->> 'cert_pem' else cert_pem end,
    subject = case when p ? 'cert_pem' then p ->> 'subject' else subject end,
    issuer = case when p ? 'cert_pem' then p ->> 'issuer' else issuer end,
    serial = case when p ? 'cert_pem' then p ->> 'serial' else serial end,
    not_after = case when p ? 'cert_pem' then (p ->> 'not_after')::timestamptz else not_after end,
    fingerprint_sha256 = case when p ? 'cert_pem' then p ->> 'fingerprint_sha256' else fingerprint_sha256 end,
    updated_at = now(), updated_by = p_user
  where environment = p_env;
  if p ? 'cert_pem' or p ? 'key_enc' then
    delete from arca_platform_tickets where environment = p_env;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (null, p_user, 'arca_platform', null, coalesce(p ->> 'audit_action', 'arca_platform_updated'), v_before,
          jsonb_build_object('environment', p_env, 'cuit', p ->> 'cuit', 'serial', p ->> 'serial',
                             'not_after', p ->> 'not_after', 'cert_changed', p ? 'cert_pem',
                             'key_changed', p ? 'key_enc'));
end;
$$;
revoke all on function arca_platform_store(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function arca_platform_store(uuid, text, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- I) Contingencia CAEA (Código de Autorización Electrónico Anticipado)
--
-- El negocio que la activa pide por anticipado a ARCA un CAEA por quincena
-- (FECAEASolicitar: período AAAAMM y orden 1 = días 1 a 15, 2 = 16 a fin de
-- mes; se pide dentro de los 5 días corridos anteriores al inicio de la
-- quincena). Si ARCA no responde al pedir el CAE (error de red, 5xx o error
-- transitorio ANTES de mandar el FECAESolicitar, es decir sin riesgo de que
-- el CAE haya salido), el comprobante se emite al instante con el CAEA
-- vigente en el punto de venta exclusivo de contingencia, con numeración
-- propia de esa serie, y queda para informar (FECAEARegInformativo) dentro
-- del plazo (fch_tope_inf). Una quincena terminada en la que el punto de
-- venta CAEA no se usó se informa "sin movimiento"
-- (FECAEASinMovimientoInformar). Reglas orientativas: ver ADR-072 y
-- docs/33-facturacion-arca.md.
-- -----------------------------------------------------------------------------
create table if not exists arca_caea (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  environment         text not null check (environment in ('homologacion', 'produccion')),
  periodo             integer not null check (periodo between 200001 and 299912),
  orden               integer not null check (orden in (1, 2)),
  caea                text not null check (caea ~ '^\d{14}$'),
  fch_vig_desde       date not null,
  fch_vig_hasta       date not null,
  fch_tope_inf        date not null,
  fch_proceso         timestamptz,
  sin_movimiento_at   timestamptz,
  sin_movimiento_error text,
  created_at          timestamptz not null default now(),
  unique (tenant_id, environment, periodo, orden)
);
create index if not exists arca_caea_tenant_idx on arca_caea (tenant_id, environment, fch_vig_desde desc);

-- Último número usado por serie del punto de venta CAEA (se sincroniza con
-- FECompUltimoAutorizado cuando ARCA responde; con ARCA caído se sigue de acá).
create table if not exists arca_caea_series (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  environment  text not null check (environment in ('homologacion', 'produccion')),
  pto_vta      integer not null,
  cbte_tipo    integer not null,
  last_nro     bigint not null default 0,
  synced_at    timestamptz,
  primary key (tenant_id, environment, pto_vta, cbte_tipo)
);

alter table fiscal_documents drop constraint if exists fiscal_documents_caea_fk;
alter table fiscal_documents add constraint fiscal_documents_caea_fk
  foreign key (caea_id) references arca_caea(id) on delete set null;
create index if not exists fiscal_documents_inform_idx
  on fiscal_documents (tenant_id, inform_status, inform_next_at) where inform_status = 'pendiente';

alter table arca_caea enable row level security;
drop policy if exists arca_caea_select on arca_caea;
create policy arca_caea_select on arca_caea for select
  using ((tenant_id = current_tenant_id() and (select arca_can_manage())) or internal_scope());
alter table arca_caea_series enable row level security;
drop policy if exists arca_caea_series_select on arca_caea_series;
create policy arca_caea_series_select on arca_caea_series for select
  using ((tenant_id = current_tenant_id() and (select arca_can_manage())) or internal_scope());
revoke insert, update, delete on arca_caea, arca_caea_series from anon, authenticated;
grant select on arca_caea, arca_caea_series to authenticated;

-- Fecha de hoy en Argentina.
create or replace function _arca_today()
returns date
language sql
stable
set search_path = public, pg_temp
as $$ select (now() at time zone 'America/Argentina/Buenos_Aires')::date; $$;

-- Tareas de CAEA de un negocio (espejo de caeaPeriodsToRequest en
-- _shared/arca/caea.ts): quincenas a pedir (la vigente si falta y la próxima
-- si empieza en 5 días o menos), comprobantes a informar y CAEA vencidos sin
-- uso a informar sin movimiento (antes de su fecha tope).
create or replace function arca_caea_tasks(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_set    arca_settings%rowtype;
  v_today  date := _arca_today();
  v_cur_p  integer;
  v_cur_o  integer;
  v_next_p integer;
  v_next_o integer;
  v_next_d date;
  v_req    jsonb := '[]'::jsonb;
begin
  select * into v_set from arca_settings where tenant_id = p_tenant;
  if not found or not v_set.caea_enabled or v_set.caea_pto_vta is null then
    return jsonb_build_object('request', '[]'::jsonb, 'inform', '[]'::jsonb, 'sin_movimiento', '[]'::jsonb);
  end if;
  v_cur_p := extract(year from v_today)::integer * 100 + extract(month from v_today)::integer;
  v_cur_o := case when extract(day from v_today) <= 15 then 1 else 2 end;
  if v_cur_o = 1 then
    v_next_p := v_cur_p; v_next_o := 2; v_next_d := date_trunc('month', v_today)::date + 15;
  else
    v_next_d := (date_trunc('month', v_today) + interval '1 month')::date;
    v_next_p := extract(year from v_next_d)::integer * 100 + extract(month from v_next_d)::integer;
    v_next_o := 1;
  end if;
  if not exists (select 1 from arca_caea c where c.tenant_id = p_tenant and c.environment = v_set.environment
                    and c.periodo = v_cur_p and c.orden = v_cur_o) then
    v_req := v_req || jsonb_build_array(jsonb_build_object('periodo', v_cur_p, 'orden', v_cur_o));
  end if;
  if v_next_d - v_today <= 5
     and not exists (select 1 from arca_caea c where c.tenant_id = p_tenant and c.environment = v_set.environment
                        and c.periodo = v_next_p and c.orden = v_next_o) then
    v_req := v_req || jsonb_build_array(jsonb_build_object('periodo', v_next_p, 'orden', v_next_o));
  end if;
  return jsonb_build_object(
    'environment', v_set.environment,
    'pto_vta', v_set.caea_pto_vta,
    'request', v_req,
    'inform', coalesce((select jsonb_agg(d.id order by d.cbte_nro)
                          from fiscal_documents d
                         where d.tenant_id = p_tenant and d.inform_status = 'pendiente'
                           and coalesce(d.inform_next_at, now()) <= now()), '[]'::jsonb),
    'sin_movimiento', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'caea', c.caea, 'environment', c.environment))
                                  from arca_caea c
                                 where c.tenant_id = p_tenant and c.fch_vig_hasta < v_today
                                   and c.fch_tope_inf >= v_today and c.sin_movimiento_at is null
                                   and not exists (select 1 from fiscal_documents d where d.caea_id = c.id)), '[]'::jsonb));
end;
$$;
revoke all on function arca_caea_tasks(uuid) from public, anon, authenticated;
grant execute on function arca_caea_tasks(uuid) to service_role;

create or replace function arca_caea_store(p_tenant uuid, p_env text, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into arca_caea (tenant_id, environment, periodo, orden, caea, fch_vig_desde, fch_vig_hasta, fch_tope_inf,
                         fch_proceso)
  values (p_tenant, p_env, (p ->> 'periodo')::integer, (p ->> 'orden')::integer, p ->> 'caea',
          (p ->> 'fch_vig_desde')::date, (p ->> 'fch_vig_hasta')::date, (p ->> 'fch_tope_inf')::date,
          nullif(p ->> 'fch_proceso', '')::timestamptz)
  on conflict (tenant_id, environment, periodo, orden) do update set
    caea = excluded.caea, fch_vig_desde = excluded.fch_vig_desde, fch_vig_hasta = excluded.fch_vig_hasta,
    fch_tope_inf = excluded.fch_tope_inf, fch_proceso = excluded.fch_proceso
  returning id into v_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, null, 'arca_caea', v_id, 'arca_caea_obtained',
          jsonb_build_object('environment', p_env, 'periodo', p ->> 'periodo', 'orden', p ->> 'orden',
                             'fch_vig_desde', p ->> 'fch_vig_desde', 'fch_vig_hasta', p ->> 'fch_vig_hasta'));
  return v_id;
end;
$$;
revoke all on function arca_caea_store(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function arca_caea_store(uuid, text, jsonb) to service_role;

-- Próxima revisión de las tareas de CAEA y último mensaje.
create or replace function arca_caea_checked(p_tenant uuid, p_next timestamptz, p_message text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update arca_settings set caea_next_check_at = p_next, caea_last_message = left(p_message, 500)
   where tenant_id = p_tenant;
$$;
revoke all on function arca_caea_checked(uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function arca_caea_checked(uuid, timestamptz, text) to service_role;

create or replace function arca_caea_series_sync(p_tenant uuid, p_env text, p_pto_vta integer, p_cbte_tipo integer,
                                                 p_last bigint)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into arca_caea_series (tenant_id, environment, pto_vta, cbte_tipo, last_nro, synced_at)
  values (p_tenant, p_env, p_pto_vta, p_cbte_tipo, greatest(coalesce(p_last, 0), 0), now())
  on conflict (tenant_id, environment, pto_vta, cbte_tipo) do update
    set last_nro = greatest(arca_caea_series.last_nro, excluded.last_nro), synced_at = now();
$$;
revoke all on function arca_caea_series_sync(uuid, text, integer, integer, bigint) from public, anon, authenticated;
grant execute on function arca_caea_series_sync(uuid, text, integer, integer, bigint) to service_role;

-- Emite en contingencia: toma el CAEA vigente hoy del ambiente del
-- comprobante, el número siguiente de la serie CAEA (con lock de fila) y
-- deja el comprobante aprobado y pendiente de informar. null = no hay CAEA
-- vigente o la contingencia está apagada (el comprobante sigue en la cola).
create or replace function arca_caea_issue(p_doc uuid, p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc   fiscal_documents%rowtype;
  v_set   arca_settings%rowtype;
  v_caea  arca_caea%rowtype;
  v_today date := _arca_today();
  v_nro   bigint;
begin
  select * into v_doc from fiscal_documents where id = p_doc for update;
  if not found or v_doc.status not in ('enviando', 'pendiente') or v_doc.cbte_tipo is null then
    return null;
  end if;
  select * into v_set from arca_settings where tenant_id = v_doc.tenant_id;
  if not found or not v_set.caea_enabled or v_set.caea_pto_vta is null then
    return null;
  end if;
  select * into v_caea from arca_caea c
   where c.tenant_id = v_doc.tenant_id and c.environment = v_doc.environment
     and v_today between c.fch_vig_desde and c.fch_vig_hasta
   order by c.fch_vig_desde desc limit 1;
  if not found then
    return null;
  end if;
  insert into arca_caea_series (tenant_id, environment, pto_vta, cbte_tipo, last_nro)
  values (v_doc.tenant_id, v_doc.environment, v_set.caea_pto_vta, v_doc.cbte_tipo, 0)
  on conflict do nothing;
  update arca_caea_series set last_nro = last_nro + 1
   where tenant_id = v_doc.tenant_id and environment = v_doc.environment
     and pto_vta = v_set.caea_pto_vta and cbte_tipo = v_doc.cbte_tipo
  returning last_nro into v_nro;

  update fiscal_documents set
    status = 'aprobado', emission_type = 'CAEA', caea_id = v_caea.id,
    pto_vta = v_set.caea_pto_vta, cbte_nro = v_nro, cbte_fch = v_today,
    concepto = coalesce((p ->> 'concepto')::integer, concepto),
    doc_tipo = coalesce((p ->> 'doc_tipo')::integer, doc_tipo),
    doc_nro = coalesce(p ->> 'doc_nro', doc_nro),
    imp_total = coalesce((p ->> 'imp_total')::numeric, imp_total),
    cae = v_caea.caea, cae_vto = v_caea.fch_vig_hasta, approved_at = now(),
    inform_status = 'pendiente', inform_attempts = 0, inform_next_at = now(),
    claimed_at = null, last_error_code = null, last_error_msg = null
  where id = p_doc;

  update arca_settings set contingency_since = coalesce(contingency_since, now()), last_worker_at = now()
   where tenant_id = v_doc.tenant_id;
  insert into fiscal_document_events (tenant_id, document_id, environment, action, outcome, attempt, error_code, error_msg)
  values (v_doc.tenant_id, p_doc, v_doc.environment, 'CAEA', 'contingencia', v_doc.attempts,
          p ->> 'error_code', left(p ->> 'error_msg', 500));
  return jsonb_build_object('caea', v_caea.caea, 'caea_id', v_caea.id, 'pto_vta', v_set.caea_pto_vta,
                            'cbte_nro', v_nro, 'cbte_fch', v_today, 'fch_vig_hasta', v_caea.fch_vig_hasta);
end;
$$;
revoke all on function arca_caea_issue(uuid, jsonb) from public, anon, authenticated;
grant execute on function arca_caea_issue(uuid, jsonb) to service_role;

-- QR del comprobante emitido (lo arma la Edge con los datos finales).
create or replace function arca_set_qr(p_doc uuid, p_url text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update fiscal_documents set qr_url = p_url where id = p_doc;
$$;
revoke all on function arca_set_qr(uuid, text) from public, anon, authenticated;
grant execute on function arca_set_qr(uuid, text) to service_role;

-- Resultado del informe de un comprobante CAEA (FECAEARegInformativo).
--   informado: listo.  rechazado: el comprobante pasa a requiere_accion.
--   reintentar: error transitorio, vuelve con backoff (hasta la fecha tope).
create or replace function arca_caea_inform_result(p_doc uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc     fiscal_documents%rowtype;
  v_outcome text := p ->> 'outcome';
begin
  select * into v_doc from fiscal_documents where id = p_doc for update;
  if not found or v_doc.emission_type <> 'CAEA' then
    return null;
  end if;
  if v_outcome not in ('informado', 'rechazado', 'reintentar') then
    raise exception 'invalid_outcome';
  end if;
  update fiscal_documents set
    inform_status = case v_outcome when 'reintentar' then 'pendiente' else v_outcome end,
    inform_attempts = inform_attempts + 1,
    inform_next_at = case when v_outcome = 'reintentar'
                          then coalesce((p ->> 'next_attempt_at')::timestamptz, now() + interval '5 minutes') end,
    informed_at = case when v_outcome = 'informado' then now() else informed_at end,
    status = case when v_outcome = 'rechazado' then 'requiere_accion' else status end,
    last_error_code = case when v_outcome = 'informado' then null else p ->> 'error_code' end,
    last_error_msg = case when v_outcome = 'informado' then null
                          when v_outcome = 'rechazado' then 'ARCA rechazó el informe del CAEA: ' || coalesce(p ->> 'error_msg', '')
                          else p ->> 'error_msg' end,
    observations = coalesce(p -> 'observations', observations),
    request_xml = coalesce(p ->> 'request_xml', request_xml),
    response_xml = coalesce(p ->> 'response_xml', response_xml)
  where id = p_doc
  returning * into v_doc;
  insert into fiscal_document_events (tenant_id, document_id, environment, action, outcome, attempt, error_code,
                                      error_msg, duration_ms, request_xml, response_xml)
  values (v_doc.tenant_id, p_doc, v_doc.environment, 'FECAEARegInformativo', v_outcome, v_doc.inform_attempts,
          p ->> 'error_code', p ->> 'error_msg', (p ->> 'duration_ms')::integer, p ->> 'request_xml',
          p ->> 'response_xml');
  return jsonb_build_object('status', v_doc.status, 'inform_status', v_doc.inform_status);
end;
$$;
revoke all on function arca_caea_inform_result(uuid, jsonb) from public, anon, authenticated;
grant execute on function arca_caea_inform_result(uuid, jsonb) to service_role;

create or replace function arca_caea_sin_movimiento_result(p_caea uuid, p_ok boolean, p_message text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update arca_caea set
    sin_movimiento_at = case when p_ok then now() else sin_movimiento_at end,
    sin_movimiento_error = case when p_ok then null else left(p_message, 500) end
  where id = p_caea;
end;
$$;
revoke all on function arca_caea_sin_movimiento_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function arca_caea_sin_movimiento_result(uuid, boolean, text) to service_role;

-- Estado para el POS (cualquier miembro): si la facturación está activa, si
-- se está facturando en contingencia y cuántos comprobantes esperan.
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
    'pending', (select count(*) from fiscal_documents d
                 where d.tenant_id = v_tenant and d.status in ('pendiente', 'enviando')),
    'needs_action', (select count(*) from fiscal_documents d
                      where d.tenant_id = v_tenant and d.status in ('rechazado', 'requiere_accion')));
end;
$$;
revoke all on function arca_status() from public, anon;
grant execute on function arca_status() to authenticated;
