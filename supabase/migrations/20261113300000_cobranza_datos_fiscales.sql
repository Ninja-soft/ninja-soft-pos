-- =============================================================================
-- 20261113300000_cobranza_datos_fiscales  (F20-3 · ADR-110 · ADR-115)
--
-- Datos fiscales del cliente para la facturación de la PLATAFORMA (NinjaSoft
-- le factura la suscripción a cada negocio). Spec: docs/40-cobranza-saas.md
-- §6.2 (tenant_billing_profiles, platform_fiscal_lookups), §7.2 (letra) y §8
-- (flujo y padrón). Decisión del dueño §22 #1: NinjaSoft todavía no tiene
-- CUIT, así que la condición del emisor arranca vacía y la letra queda
-- "pendiente" hasta que el staff la cargue.
--
-- NO toca nada de F20-1 (cuenta corriente de la plataforma, permiso
-- "Cobranzas", tenants.is_test): esas piezas viven en otra rama.
--
--   A) platform_issuer_profile: emisor (NinjaSoft) por ambiente ARCA. Una
--      fila activa: su ambiente es el que usa el padrón y su condición frente
--      al IVA define la letra. Sólo staff lee; escribe super_admin por RPC.
--   B) tenant_billing_profiles: a nombre de quién se factura cada negocio,
--      con historia (se cierra la fila vigente con valid_to y se abre otra) y
--      baja lógica (deleted_at). Sin fila = datos de la empresa del negocio.
--   C) platform_fiscal_lookups: cache y registro de las consultas al padrón
--      (ws_sr_constancia_inscripcion). Escribe sólo service_role (Edge
--      platform_billing); el staff lee.
--   D) Letra: platform_cbte_letter(emisor, receptor), espejo de
--      lib/billing/letter.ts, sobre cbte_letter_infer (ADR-068).
--   E) Perfil efectivo y RPC del negocio (dueño o encargado):
--      my_billing_profile(), owner_set_billing_profile(p).
--   F) RPC internas: internal_billing_profile_get, internal_set_billing_profile
--      (admin+, con motivo y opción "verificado por el staff"),
--      internal_billing_profiles_overview (filtro "sin datos fiscales
--      verificados"), internal_platform_issuer_get / _set (super_admin).
--
-- Seguridad: RLS en las tres tablas, sin políticas de escritura (escriben las
-- RPC security definer o service_role). El negocio lee lo suyo con
-- (select current_tenant_id()) y rol dueño o encargado; el staff con
-- (select internal_scope()). Nunca OR is_internal(). Toda escritura deja
-- before/after en audit_logs antes de responder.
--
-- No es una feature de plan (spec §3.8): datos de facturación de la
-- plataforma, BASE para cualquier negocio.
--
-- Aditiva. NO aplicada todavía.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Emisor de la plataforma
-- -----------------------------------------------------------------------------
create table if not exists platform_issuer_profile (
  environment          text primary key check (environment in ('homologacion', 'produccion')),
  is_active            boolean not null default false,
  cuit                 text check (cuit is null or (cuit ~ '^\d{11}$' and cuit_is_valid(cuit))),
  razon_social         text check (razon_social is null or char_length(razon_social) between 1 and 200),
  -- null = sin definir (NinjaSoft todavía no tiene CUIT, §22 #1): letra pendiente.
  iva_condition        text check (iva_condition is null or iva_condition in
                         ('responsable_inscripto', 'monotributo', 'monotributo_social', 'exento', 'no_alcanzado')),
  domicilio_comercial  text check (domicilio_comercial is null or char_length(domicilio_comercial) <= 300),
  -- Interruptor de la verificación automática con el padrón.
  padron_enabled       boolean not null default true,
  updated_at           timestamptz not null default now(),
  updated_by           uuid
);
comment on table platform_issuer_profile is
  'F20-3 (ADR-110/115): emisor de las facturas de NinjaSoft por ambiente. La fila is_active define la letra (condición frente al IVA) y el ambiente del padrón. El certificado sigue en arca_platform.';

create unique index if not exists platform_issuer_profile_one_active
  on platform_issuer_profile ((true)) where is_active;

insert into platform_issuer_profile (environment, is_active)
values ('homologacion', true), ('produccion', false)
on conflict (environment) do nothing;

alter table platform_issuer_profile enable row level security;
revoke all on platform_issuer_profile from anon, authenticated;
grant select on platform_issuer_profile to authenticated;
drop policy if exists platform_issuer_profile_select on platform_issuer_profile;
create policy platform_issuer_profile_select on platform_issuer_profile
  for select using ((select internal_scope()));

-- -----------------------------------------------------------------------------
-- B) Perfil de facturación por negocio (con historia y baja lógica)
-- -----------------------------------------------------------------------------
create table if not exists tenant_billing_profiles (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  -- true: se factura con los datos de la empresa del negocio (tax_settings /
  -- tenant_branding). Las columnas fiscales guardan, si hay, la copia
  -- verificada de ese CUIT.
  use_company_data   boolean not null default true,
  holder_type        text check (holder_type is null or holder_type in ('empresa', 'persona')),
  doc_tipo           smallint check (doc_tipo is null or doc_tipo in (80, 86, 96)),
  doc_nro            text check (doc_nro is null or doc_nro ~ '^\d{7,11}$'),
  razon_social       text check (razon_social is null or char_length(razon_social) between 1 and 200),
  iva_condition      text check (iva_condition is null or iva_condition in
                       ('consumidor_final', 'responsable_inscripto', 'monotributo', 'monotributo_social', 'exento',
                        'no_responsable', 'no_categorizado', 'no_alcanzado', 'iva_liberado', 'exterior')),
  domicilio          text check (domicilio is null or char_length(domicilio) <= 300),
  -- A dónde va la factura y los avisos. null = email del dueño.
  email_facturacion  text check (email_facturacion is null or
                       (char_length(email_facturacion) <= 254 and email_facturacion ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  -- padron: datos traídos de ARCA · staff: revisados a mano por el staff ·
  -- manual: cargados por el negocio sin verificar · none: sin datos propios.
  verification       text not null default 'none' check (verification in ('padron', 'staff', 'manual', 'none')),
  verified_at        timestamptz,
  verified_by        uuid,
  padron_snapshot    jsonb check (padron_snapshot is null or
                       (jsonb_typeof(padron_snapshot) = 'object' and pg_column_size(padron_snapshot) <= 16384)),
  padron_checked_at  timestamptz,
  source             text not null default 'owner' check (source in ('owner', 'internal', 'system')),
  reason             text check (reason is null or char_length(reason) <= 500),
  valid_from         timestamptz not null default now(),
  valid_to           timestamptz,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by         uuid,
  constraint tenant_billing_profiles_other_complete check (
    use_company_data
    or (holder_type is not null and doc_tipo is not null and doc_nro is not null
        and razon_social is not null and iva_condition is not null)),
  constraint tenant_billing_profiles_doc_pair check ((doc_tipo is null) = (doc_nro is null)),
  constraint tenant_billing_profiles_cuit_valid check (
    doc_tipo is null or doc_tipo = 96 or (char_length(doc_nro) = 11 and cuit_is_valid(doc_nro))),
  constraint tenant_billing_profiles_dni check (
    doc_tipo is distinct from 96
    or (doc_nro ~ '^\d{7,8}$' and holder_type = 'persona' and iva_condition = 'consumidor_final')),
  constraint tenant_billing_profiles_empresa_cuit check (holder_type is distinct from 'empresa' or doc_tipo = 80),
  constraint tenant_billing_profiles_range check (valid_to is null or valid_to >= valid_from)
);
comment on table tenant_billing_profiles is
  'F20-3 (ADR-110/115): a nombre de quién factura NinjaSoft a cada negocio. Historia por vigencia (valid_from/valid_to), una sola fila abierta. Sin fila: datos de la empresa del negocio; sin CUIT: consumidor final.';

create unique index if not exists tenant_billing_profiles_one_open
  on tenant_billing_profiles (tenant_id)
  where valid_to is null and deleted_at is null;
create index if not exists tenant_billing_profiles_tenant_idx
  on tenant_billing_profiles (tenant_id, valid_from desc);

alter table tenant_billing_profiles enable row level security;
revoke all on tenant_billing_profiles from anon, authenticated;
grant select on tenant_billing_profiles to authenticated;
drop policy if exists tenant_billing_profiles_select on tenant_billing_profiles;
create policy tenant_billing_profiles_select on tenant_billing_profiles
  for select using (
    (select internal_scope())
    or (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))
  );

-- -----------------------------------------------------------------------------
-- C) Consultas al padrón (cache 30 días y base del rate limit)
-- -----------------------------------------------------------------------------
create table if not exists platform_fiscal_lookups (
  id            uuid primary key default gen_random_uuid(),
  cuit          text not null check (cuit ~ '^\d{11}$'),
  environment   text not null check (environment in ('homologacion', 'produccion')),
  status        text not null check (status in ('ok', 'no_encontrado', 'error')),
  result        jsonb check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 16384)),
  error         text check (error is null or char_length(error) <= 500),
  tenant_id     uuid references tenants(id) on delete set null,
  requested_by  uuid,
  fetched_at    timestamptz not null default now()
);
comment on table platform_fiscal_lookups is
  'F20-3: respuestas de ws_sr_constancia_inscripcion (padrón A5) por CUIT. Cache 30 días; cuenta para el rate limit (10/h por negocio, 300/h total). Escribe service_role.';

create index if not exists platform_fiscal_lookups_cuit_idx
  on platform_fiscal_lookups (cuit, environment, fetched_at desc);
create index if not exists platform_fiscal_lookups_tenant_idx
  on platform_fiscal_lookups (tenant_id, fetched_at desc) where tenant_id is not null;
create index if not exists platform_fiscal_lookups_fetched_idx
  on platform_fiscal_lookups (fetched_at desc);

alter table platform_fiscal_lookups enable row level security;
revoke all on platform_fiscal_lookups from anon, authenticated;
grant select on platform_fiscal_lookups to authenticated;
drop policy if exists platform_fiscal_lookups_select on platform_fiscal_lookups;
create policy platform_fiscal_lookups_select on platform_fiscal_lookups
  for select using ((select internal_scope()));

-- -----------------------------------------------------------------------------
-- D) Letra del comprobante de la plataforma (espejo de lib/billing/letter.ts)
-- -----------------------------------------------------------------------------
-- null = pendiente (emisor sin condición). El receptor sin condición se
-- resuelve antes (pending_receptor): acá ya llega definido.
create or replace function platform_cbte_letter(p_issuer text, p_receptor text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_issuer is null or p_issuer = '' then null
    else cbte_letter_infer(p_issuer, coalesce(nullif(p_receptor, ''), 'consumidor_final'), false)
  end;
$$;
revoke all on function platform_cbte_letter(text, text) from public, anon;
grant execute on function platform_cbte_letter(text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- E) Perfil efectivo
-- -----------------------------------------------------------------------------
-- Datos fiscales de la empresa del negocio (ADR-068): tax_settings primero,
-- tenant_branding de respaldo, el nombre del negocio como último recurso.
create or replace function _tenant_company_fiscal(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'razon_social', coalesce(nullif(btrim(b.legal_name), ''), t.name),
    'cuit', (select c from (select coalesce(ts.cuit, nullif(regexp_replace(coalesce(b.cuit, ''), '\D', '', 'g'), '')) as c) x
              where c is not null and char_length(c) = 11 and cuit_is_valid(c)),
    'iva_condition', coalesce(ts.iva_condition, b.iva_condition),
    'domicilio', nullif(btrim(b.address), ''))
  from tenants t
  left join tax_settings ts on ts.tenant_id = t.id
  left join tenant_branding b on b.tenant_id = t.id
  where t.id = p_tenant;
$$;
revoke all on function _tenant_company_fiscal(uuid) from public, anon, authenticated;
grant execute on function _tenant_company_fiscal(uuid) to service_role;

create or replace function _tenant_owner_email(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.email
    from tenant_users tu
    join users u on u.id = tu.user_id
   where tu.tenant_id = p_tenant and tu.role = 'owner' and tu.status = 'active'
   order by tu.created_at
   limit 1;
$$;
revoke all on function _tenant_owner_email(uuid) from public, anon, authenticated;
grant execute on function _tenant_owner_email(uuid) to service_role;

-- ¿Se puede consultar el padrón? Emisor activo con el interruptor prendido
-- y el certificado de la plataforma vigente en ese ambiente (arca_platform).
create or replace function _platform_padron_status()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when ip.environment is null then jsonb_build_object('available', false, 'reason', 'issuer_missing', 'environment', null)
    when not ip.padron_enabled then jsonb_build_object('available', false, 'reason', 'disabled', 'environment', ip.environment)
    when not arca_platform_ready(ip.environment) then
      jsonb_build_object('available', false, 'reason', 'certificate_missing', 'environment', ip.environment)
    else jsonb_build_object('available', true, 'reason', null, 'environment', ip.environment)
  end
  from (select 1) one
  left join platform_issuer_profile ip on ip.is_active;
$$;
revoke all on function _platform_padron_status() from public, anon, authenticated;
grant execute on function _platform_padron_status() to service_role;

-- Resolución (espejo de lib/billing/profile.ts → resolveBillingProfile):
--   1. Fila "otro titular": sus datos.
--   2. Datos de la empresa con CUIT: los de la empresa; si la fila vigente
--      guarda una verificación de ESE CUIT, la copia verificada.
--   3. Empresa sin CUIT: consumidor final (doc 99), aviso para completar.
-- Letra: pending_issuer (emisor sin condición), pending_receptor (receptor
-- sin condición) u ok.
create or replace function _tenant_billing_profile_eff(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r          tenant_billing_profiles;
  v_company  jsonb := _tenant_company_fiscal(p_tenant);
  v_iss      platform_issuer_profile;
  v_source   text;
  v_holder   text;
  v_doc_tipo int;
  v_doc_nro  text;
  v_name     text;
  v_cond     text;
  v_dom      text;
  v_ver      text := 'none';
  v_ver_at   timestamptz;
  v_checked  timestamptz;
  v_status   text;
  v_letter   text;
  v_owner    text := _tenant_owner_email(p_tenant);
begin
  select * into r from tenant_billing_profiles
   where tenant_id = p_tenant and valid_to is null and deleted_at is null;
  select * into v_iss from platform_issuer_profile where is_active;

  if r.id is not null and not r.use_company_data then
    v_source := 'other';
    v_holder := r.holder_type;
    v_doc_tipo := r.doc_tipo;
    v_doc_nro := r.doc_nro;
    v_name := r.razon_social;
    v_cond := r.iva_condition;
    v_dom := r.domicilio;
    v_ver := r.verification;
    v_ver_at := r.verified_at;
    v_checked := r.padron_checked_at;
  elsif v_company ->> 'cuit' is not null then
    v_source := 'company';
    v_holder := 'empresa';
    v_doc_tipo := 80;
    v_doc_nro := v_company ->> 'cuit';
    if r.id is not null and r.doc_nro = v_doc_nro and r.verification in ('padron', 'staff') then
      v_name := coalesce(r.razon_social, v_company ->> 'razon_social');
      v_cond := coalesce(r.iva_condition, v_company ->> 'iva_condition');
      v_dom := coalesce(r.domicilio, v_company ->> 'domicilio');
      v_ver := r.verification;
      v_ver_at := r.verified_at;
      v_checked := r.padron_checked_at;
    else
      v_name := v_company ->> 'razon_social';
      v_cond := v_company ->> 'iva_condition';
      v_dom := v_company ->> 'domicilio';
    end if;
  else
    v_source := 'consumidor_final';
    v_holder := null;
    v_doc_tipo := 99;
    v_doc_nro := null;
    v_name := v_company ->> 'razon_social';
    v_cond := 'consumidor_final';
    v_dom := v_company ->> 'domicilio';
  end if;

  if v_iss.iva_condition is null then
    v_status := 'pending_issuer';
  elsif v_cond is null then
    v_status := 'pending_receptor';
  else
    v_status := 'ok';
    v_letter := platform_cbte_letter(v_iss.iva_condition, v_cond);
  end if;

  return jsonb_build_object(
    'tenant_id', p_tenant,
    'source', v_source,
    'use_company_data', coalesce(r.use_company_data, true),
    'has_profile', r.id is not null,
    'profile_id', r.id,
    'valid_from', r.valid_from,
    'holder_type', v_holder,
    'doc_tipo', v_doc_tipo,
    'doc_nro', v_doc_nro,
    'razon_social', v_name,
    'iva_condition', v_cond,
    'iva_condition_arca_id', case when v_cond is not null then fiscal_condition_arca_id(v_cond) end,
    'domicilio', v_dom,
    'email', coalesce(r.email_facturacion, v_owner),
    'email_is_default', r.email_facturacion is null,
    'verification', v_ver,
    'verified', v_ver in ('padron', 'staff'),
    'verified_at', v_ver_at,
    'padron_checked_at', v_checked,
    'letter', v_letter,
    'letter_status', v_status,
    -- Spec §8.1.5: no se emite factura A sin datos verificados.
    'blocked_a_unverified', coalesce(v_letter = 'A', false) and v_ver not in ('padron', 'staff'),
    'issuer', jsonb_build_object('environment', v_iss.environment, 'iva_condition', v_iss.iva_condition,
                                 'configured', v_iss.iva_condition is not null and v_iss.cuit is not null));
end;
$$;
revoke all on function _tenant_billing_profile_eff(uuid) from public, anon, authenticated;
grant execute on function _tenant_billing_profile_eff(uuid) to service_role;

-- Fila sin el snapshot del padrón (para auditoría e historia).
create or replace function _billing_profile_json(r tenant_billing_profiles)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when r.id is null then null else
    jsonb_build_object('id', r.id, 'use_company_data', r.use_company_data, 'holder_type', r.holder_type,
      'doc_tipo', r.doc_tipo, 'doc_nro', r.doc_nro, 'razon_social', r.razon_social,
      'iva_condition', r.iva_condition, 'domicilio', r.domicilio, 'email_facturacion', r.email_facturacion,
      'verification', r.verification, 'verified_at', r.verified_at, 'padron_checked_at', r.padron_checked_at,
      'source', r.source, 'valid_from', r.valid_from, 'valid_to', r.valid_to)
  end;
$$;
revoke all on function _billing_profile_json(tenant_billing_profiles) from public, anon, authenticated;
grant execute on function _billing_profile_json(tenant_billing_profiles) to service_role;

-- Escritura común (dueño/encargado y staff). Cierra la fila vigente y abre
-- otra; no-op si nada cambió. La verificación nunca la declara el cliente:
--   · use_padron: exige una consulta 'ok' de ese CUIT de los últimos 30 días
--     (la grabó la Edge con service_role) y toma de ahí razón social,
--     condición y domicilio.
--   · staff_verified (sólo staff): 'staff'.
--   · misma identidad fiscal que la fila vigente verificada: se conserva.
--   · si no: 'manual' (otro titular) o 'none' (datos de la empresa).
create or replace function _billing_profile_write(
  p_tenant uuid, p jsonb, p_source text, p_actor uuid, p_reason text, p_staff_verify boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old       tenant_billing_profiles;
  v_new       tenant_billing_profiles;
  v_company   jsonb := _tenant_company_fiscal(p_tenant);
  v_use_co    boolean := coalesce((p ->> 'use_company_data')::boolean, true);
  v_holder    text := nullif(btrim(coalesce(p ->> 'holder_type', '')), '');
  v_doc_tipo  smallint := nullif(p ->> 'doc_tipo', '')::smallint;
  v_doc_nro   text := nullif(regexp_replace(coalesce(p ->> 'doc_nro', ''), '\D', '', 'g'), '');
  v_name      text := nullif(btrim(coalesce(p ->> 'razon_social', '')), '');
  v_cond      text := nullif(btrim(coalesce(p ->> 'iva_condition', '')), '');
  v_dom       text := nullif(btrim(coalesce(p ->> 'domicilio', '')), '');
  v_email     text := nullif(lower(btrim(coalesce(p ->> 'email_facturacion', ''))), '');
  v_padron    boolean := coalesce((p ->> 'use_padron')::boolean, false);
  v_ver       text;
  v_ver_at    timestamptz;
  v_ver_by    uuid;
  v_snap      jsonb;
  v_checked   timestamptz;
  v_look      platform_fiscal_lookups;
begin
  if p_source not in ('owner', 'internal') then
    raise exception 'invalid_source';
  end if;
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found';
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'invalid_email';
  end if;

  select * into v_old from tenant_billing_profiles
   where tenant_id = p_tenant and valid_to is null and deleted_at is null
   for update;

  if v_use_co then
    -- Las columnas fiscales sólo guardan la copia verificada del CUIT de la empresa.
    v_holder := null;
    v_doc_nro := v_company ->> 'cuit';
    v_doc_tipo := case when v_doc_nro is not null then 80 end;
    v_name := null;
    v_cond := null;
    v_dom := null;
  else
    if v_holder is null or v_holder not in ('empresa', 'persona') then
      raise exception 'invalid_holder_type';
    end if;
    if v_holder = 'empresa' then
      v_doc_tipo := 80;
    elsif v_doc_tipo is null or v_doc_tipo not in (80, 86, 96) then
      raise exception 'invalid_doc_tipo';
    end if;
    if v_doc_nro is null then
      raise exception 'doc_required';
    end if;
    if v_doc_tipo in (80, 86) and (char_length(v_doc_nro) <> 11 or not cuit_is_valid(v_doc_nro)) then
      raise exception 'invalid_cuit';
    end if;
    if v_doc_tipo = 96 then
      if v_doc_nro !~ '^\d{7,8}$' then
        raise exception 'invalid_dni';
      end if;
      v_cond := 'consumidor_final';
      v_padron := false;
    end if;
    if v_name is null or char_length(v_name) > 200 then
      raise exception 'razon_social_required';
    end if;
    if v_dom is not null and char_length(v_dom) > 300 then
      raise exception 'domicilio_too_long';
    end if;
    if v_cond is null or v_cond not in ('consumidor_final', 'responsable_inscripto', 'monotributo',
        'monotributo_social', 'exento', 'no_responsable', 'no_categorizado', 'no_alcanzado', 'iva_liberado', 'exterior') then
      raise exception 'invalid_iva_condition';
    end if;
  end if;

  -- Verificación.
  if v_padron then
    if v_doc_nro is null or v_doc_tipo not in (80, 86) then
      raise exception 'padron_needs_cuit';
    end if;
    select * into v_look from platform_fiscal_lookups
     where cuit = v_doc_nro and status = 'ok' and fetched_at > now() - interval '30 days'
     order by fetched_at desc limit 1;
    if v_look.id is null then
      raise exception 'padron_lookup_missing';
    end if;
    v_name := coalesce(nullif(btrim(v_look.result ->> 'razon_social'), ''), v_name);
    v_cond := coalesce(nullif(v_look.result ->> 'iva_condition', ''), v_cond);
    v_dom := coalesce(nullif(btrim(v_look.result ->> 'domicilio'), ''), v_dom);
    v_ver := 'padron';
    v_ver_at := now();
    v_snap := v_look.result;
    v_checked := v_look.fetched_at;
  elsif coalesce(p_staff_verify, false) and p_source = 'internal' then
    if v_doc_nro is null then
      raise exception 'verify_needs_doc';
    end if;
    if v_use_co then
      v_name := v_company ->> 'razon_social';
      v_cond := v_company ->> 'iva_condition';
      v_dom := v_company ->> 'domicilio';
    end if;
    v_ver := 'staff';
    v_ver_at := now();
    v_ver_by := p_actor;
  elsif v_old.id is not null and v_old.verification in ('padron', 'staff')
        and v_old.use_company_data = v_use_co
        and v_old.doc_nro is not distinct from v_doc_nro
        and (v_use_co or (v_old.holder_type is not distinct from v_holder
                          and v_old.doc_tipo is not distinct from v_doc_tipo
                          and v_old.razon_social is not distinct from v_name
                          and v_old.iva_condition is not distinct from v_cond
                          and v_old.domicilio is not distinct from v_dom)) then
    -- Misma identidad fiscal: se conserva la verificación (p. ej. cambió sólo el email).
    v_ver := v_old.verification;
    v_ver_at := v_old.verified_at;
    v_ver_by := v_old.verified_by;
    v_snap := v_old.padron_snapshot;
    v_checked := v_old.padron_checked_at;
    if v_use_co then
      v_name := v_old.razon_social;
      v_cond := v_old.iva_condition;
      v_dom := v_old.domicilio;
    end if;
  else
    v_ver := case when v_use_co then 'none' else 'manual' end;
  end if;

  -- Nada cambió: no se abre otra fila.
  if v_old.id is not null
     and v_old.use_company_data = v_use_co
     and v_old.holder_type is not distinct from v_holder
     and v_old.doc_tipo is not distinct from v_doc_tipo
     and v_old.doc_nro is not distinct from v_doc_nro
     and v_old.razon_social is not distinct from v_name
     and v_old.iva_condition is not distinct from v_cond
     and v_old.domicilio is not distinct from v_dom
     and v_old.email_facturacion is not distinct from v_email
     and v_old.verification = v_ver
     and not v_padron
     and not (coalesce(p_staff_verify, false) and p_source = 'internal') then
    return _tenant_billing_profile_eff(p_tenant);
  end if;

  if v_old.id is not null then
    update tenant_billing_profiles set valid_to = now() where id = v_old.id;
  end if;

  insert into tenant_billing_profiles (
    tenant_id, use_company_data, holder_type, doc_tipo, doc_nro, razon_social, iva_condition, domicilio,
    email_facturacion, verification, verified_at, verified_by, padron_snapshot, padron_checked_at,
    source, reason, created_by)
  values (
    p_tenant, v_use_co, v_holder, v_doc_tipo, v_doc_nro, v_name, v_cond, v_dom,
    v_email, v_ver, v_ver_at, v_ver_by, v_snap, v_checked,
    p_source, nullif(btrim(coalesce(p_reason, '')), ''), p_actor)
  returning * into v_new;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (p_tenant, p_actor, 'tenant_billing_profile', v_new.id,
          case when p_source = 'internal' then 'internal_billing_profile_set' else 'billing_profile_set' end,
          _billing_profile_json(v_old), _billing_profile_json(v_new), nullif(btrim(coalesce(p_reason, '')), ''));

  return _tenant_billing_profile_eff(p_tenant);
end;
$$;
revoke all on function _billing_profile_write(uuid, jsonb, text, uuid, text, boolean) from public, anon, authenticated;
grant execute on function _billing_profile_write(uuid, jsonb, text, uuid, text, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- E.2) RPC del negocio (dueño o encargado)
-- -----------------------------------------------------------------------------
create or replace function my_billing_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_row    tenant_billing_profiles;
begin
  if v_tenant is null or not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_row from tenant_billing_profiles
   where tenant_id = v_tenant and valid_to is null and deleted_at is null;
  return jsonb_build_object(
    'tenant_id', v_tenant,
    'effective', _tenant_billing_profile_eff(v_tenant),
    'company', _tenant_company_fiscal(v_tenant),
    'current', _billing_profile_json(v_row),
    'owner_email', _tenant_owner_email(v_tenant),
    'padron', _platform_padron_status());
end;
$$;
revoke all on function my_billing_profile() from public, anon;
grant execute on function my_billing_profile() to authenticated;

create or replace function owner_set_billing_profile(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or not is_tenant_manager() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'invalid_payload';
  end if;
  return _billing_profile_write(v_tenant, p, 'owner', auth.uid(), null, false);
end;
$$;
revoke all on function owner_set_billing_profile(jsonb) from public, anon;
grant execute on function owner_set_billing_profile(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- F) RPC internas
-- -----------------------------------------------------------------------------
create or replace function internal_billing_profile_get(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_eff jsonb;
begin
  if not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from tenants where id = p_tenant) then
    raise exception 'tenant_not_found';
  end if;
  v_eff := _tenant_billing_profile_eff(p_tenant);
  return jsonb_build_object(
    'effective', v_eff,
    'company', _tenant_company_fiscal(p_tenant),
    'padron', _platform_padron_status(),
    'history', coalesce((
      select jsonb_agg(_billing_profile_json(h) || jsonb_build_object(
               'created_by_email', u.email, 'reason', h.reason, 'deleted_at', h.deleted_at)
             order by h.valid_from desc, h.created_at desc)
        from tenant_billing_profiles h
        left join users u on u.id = h.created_by
       where h.tenant_id = p_tenant), '[]'::jsonb),
    'lookups', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'cuit', l.cuit, 'environment', l.environment,
               'status', l.status, 'result', l.result, 'error', l.error, 'fetched_at', l.fetched_at)
             order by l.fetched_at desc)
        from (select * from platform_fiscal_lookups
               where cuit = v_eff ->> 'doc_nro' or tenant_id = p_tenant
               order by fetched_at desc limit 10) l), '[]'::jsonb));
end;
$$;
revoke all on function internal_billing_profile_get(uuid) from public, anon;
grant execute on function internal_billing_profile_get(uuid) to authenticated;

-- Editar los datos de un negocio: admin o super_admin, con motivo.
-- (Cuando F20-1 sume el permiso "Cobranzas", se agrega acá.)
create or replace function internal_set_billing_profile(p_tenant uuid, p jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not internal_scope() or coalesce(internal_level(), '') not in ('admin', 'super_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'reason_required';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'invalid_payload';
  end if;
  return _billing_profile_write(p_tenant, p, 'internal', auth.uid(), p_reason,
                                coalesce((p ->> 'staff_verified')::boolean, false));
end;
$$;
revoke all on function internal_set_billing_profile(uuid, jsonb, text) from public, anon;
grant execute on function internal_set_billing_profile(uuid, jsonb, text) to authenticated;

-- Resumen por negocio para la lista interna (filtro "sin datos fiscales verificados").
create or replace function internal_billing_profiles_overview()
returns table (tenant_id uuid, source text, razon_social text, doc_nro text,
               verification text, verified boolean, letter text, letter_status text, has_profile boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select t.id, e ->> 'source', e ->> 'razon_social', e ->> 'doc_nro', e ->> 'verification',
           (e ->> 'verified')::boolean, e ->> 'letter', e ->> 'letter_status', (e ->> 'has_profile')::boolean
      from tenants t
      cross join lateral (select _tenant_billing_profile_eff(t.id) as e) x
     where t.deleted_at is null;
end;
$$;
revoke all on function internal_billing_profiles_overview() from public, anon;
grant execute on function internal_billing_profiles_overview() to authenticated;

create or replace function internal_platform_issuer_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'profiles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'environment', ip.environment, 'is_active', ip.is_active, 'cuit', ip.cuit,
               'razon_social', ip.razon_social, 'iva_condition', ip.iva_condition,
               'domicilio_comercial', ip.domicilio_comercial, 'padron_enabled', ip.padron_enabled,
               'certificate_ready', arca_platform_ready(ip.environment), 'updated_at', ip.updated_at)
             order by ip.environment)
        from platform_issuer_profile ip), '[]'::jsonb),
    'padron', _platform_padron_status());
end;
$$;
revoke all on function internal_platform_issuer_get() from public, anon;
grant execute on function internal_platform_issuer_get() to authenticated;

-- Configuración del emisor: sólo super_admin (spec §18), con motivo.
create or replace function internal_set_platform_issuer(p_env text, p jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before platform_issuer_profile;
  v_after  platform_issuer_profile;
  v_cuit   text := nullif(regexp_replace(coalesce(p ->> 'cuit', ''), '\D', '', 'g'), '');
  v_cond   text := nullif(btrim(coalesce(p ->> 'iva_condition', '')), '');
begin
  if not internal_scope() or coalesce(internal_level(), '') <> 'super_admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'reason_required';
  end if;
  if p_env not in ('homologacion', 'produccion') then
    raise exception 'invalid_environment';
  end if;
  if v_cuit is not null and (char_length(v_cuit) <> 11 or not cuit_is_valid(v_cuit)) then
    raise exception 'invalid_cuit';
  end if;
  if v_cond is not null and v_cond not in ('responsable_inscripto', 'monotributo', 'monotributo_social', 'exento', 'no_alcanzado') then
    raise exception 'invalid_iva_condition';
  end if;

  select * into v_before from platform_issuer_profile where environment = p_env for update;
  if coalesce((p ->> 'is_active')::boolean, v_before.is_active) and not v_before.is_active then
    update platform_issuer_profile set is_active = false where is_active and environment <> p_env;
  end if;
  update platform_issuer_profile set
    is_active = coalesce((p ->> 'is_active')::boolean, is_active),
    cuit = v_cuit,
    razon_social = nullif(btrim(coalesce(p ->> 'razon_social', '')), ''),
    iva_condition = v_cond,
    domicilio_comercial = nullif(btrim(coalesce(p ->> 'domicilio_comercial', '')), ''),
    padron_enabled = coalesce((p ->> 'padron_enabled')::boolean, padron_enabled),
    updated_at = now(),
    updated_by = auth.uid()
  where environment = p_env
  returning * into v_after;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (null, auth.uid(), 'platform_issuer_profile', null, 'platform_issuer_set',
          to_jsonb(v_before) - 'updated_by', to_jsonb(v_after) - 'updated_by', btrim(p_reason));

  return internal_platform_issuer_get();
end;
$$;
revoke all on function internal_set_platform_issuer(text, jsonb, text) from public, anon;
grant execute on function internal_set_platform_issuer(text, jsonb, text) to authenticated;
