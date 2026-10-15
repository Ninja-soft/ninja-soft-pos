-- =============================================================================
-- 20261128100100_clientes_padron_arca  (F18 · H104 y H107, ADR-133)
--
-- Clientes verificados con el padrón de ARCA para todos los negocios, con el
-- certificado de NinjaSoft, y tipo de comprobante forzado a mano dentro de lo
-- que ARCA acepta.
--
--   A) arca_padron_config: una fila. Ambiente, encendido, cache y cupos de la
--      consulta al padrón para los negocios. El certificado es el de la
--      plataforma (arca_platform, ADR-072) del ambiente elegido. Lee el staff
--      por RPC; edita super_admin con motivo.
--   B) arca_padron_cache: respuesta de ARCA por CUIT y ambiente, compartida
--      por todos los negocios (dato público de ARCA, sin tenant_id). Sólo
--      service_role.
--   C) arca_padron_lookups: registro de cada consulta (negocio, usuario, CUIT,
--      de ARCA o de la cache, resultado). Base del rate limit y del uso que ve
--      el staff. Lee el dueño o encargado lo suyo y el staff con
--      internal_scope; escribe sólo service_role.
--   D) RPC: arca_padron_guard, arca_padron_usage y arca_padron_test_record
--      (service_role, para la Edge arca_padron), arca_padron_status (usuario
--      del negocio), internal_arca_padron_get / _save (staff).
--   E) customers: fiscal_verification ('padron' o 'manual'),
--      fiscal_verified_at, fiscal_verified_condition y fiscal_padron. Los
--      escribe sólo el trigger: "verificado" exige una consulta ok del mismo
--      CUIT hecha por el negocio en las últimas 24 h y toma los datos de la
--      cache, nunca del navegador.
--   F) Tipo de comprobante: cbte_letter_check (matriz de ARCA, espejo de
--      lib/billing/cbteOptions.ts), _arca_blocker con la condición del
--      receptor, sale_letter_overrides + sale_letter_override_set / _clear y
--      el trigger de sales que aplica el tipo elegido a la venta que se crea.
--   G) tenant_branding: fiscal_source ('padron' o 'manual'), fiscal_verified_at
--      y fiscal_padron para los datos del propio negocio (Configuración ›
--      Marca), con la misma regla que el cliente.
--
-- Seguridad: RLS en todas las tablas nuevas, policies con (select ...) y sin
-- is_internal() suelto; escrituras por RPC security definer o service_role,
-- con audit_logs. Fechas del cupo diario en hora de Argentina.
--
-- Aditiva. NO aplicada todavía. Requiere 20261128100000_features_padron_arca.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Configuración del padrón para los negocios
-- -----------------------------------------------------------------------------
create table if not exists arca_padron_config (
  id                 boolean primary key default true check (id),
  enabled            boolean not null default false,
  environment        text not null default 'homologacion' check (environment in ('homologacion', 'produccion')),
  cache_days         integer not null default 7 check (cache_days between 1 and 30),
  tenant_per_hour    integer not null default 30 check (tenant_per_hour between 1 and 1000),
  tenant_per_day     integer not null default 200 check (tenant_per_day between 1 and 10000),
  global_per_hour    integer not null default 1000 check (global_per_hour between 1 and 100000),
  last_test_at       timestamptz,
  last_test_ok       boolean,
  last_test_cuit     text check (last_test_cuit is null or last_test_cuit ~ '^\d{11}$'),
  last_test_message  text check (last_test_message is null or char_length(last_test_message) <= 500),
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);
comment on table arca_padron_config is
  'ADR-133: consulta al padrón de ARCA (ws_sr_constancia_inscripcion) para los negocios con el certificado de la plataforma. Una fila.';
insert into arca_padron_config (id) values (true) on conflict (id) do nothing;
alter table arca_padron_config enable row level security;
revoke all on arca_padron_config from anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Cache compartida por CUIT
-- -----------------------------------------------------------------------------
create table if not exists arca_padron_cache (
  cuit         text not null check (cuit ~ '^\d{11}$'),
  environment  text not null check (environment in ('homologacion', 'produccion')),
  status       text not null check (status in ('ok', 'no_encontrado')),
  result       jsonb check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 16384)),
  message      text check (message is null or char_length(message) <= 500),
  fetched_at   timestamptz not null default now(),
  primary key (cuit, environment)
);
comment on table arca_padron_cache is
  'ADR-133: última respuesta del padrón por CUIT y ambiente, compartida por todos los negocios. Sólo service_role.';
alter table arca_padron_cache enable row level security;
revoke all on arca_padron_cache from anon, authenticated;

-- -----------------------------------------------------------------------------
-- C) Registro de consultas (rate limit y uso)
-- -----------------------------------------------------------------------------
create table if not exists arca_padron_lookups (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  user_id      uuid,
  cuit         text not null check (cuit ~ '^\d{11}$'),
  environment  text not null check (environment in ('homologacion', 'produccion')),
  source       text not null check (source in ('arca', 'cache')),
  status       text not null check (status in ('ok', 'no_encontrado', 'error')),
  error_code   text check (error_code is null or char_length(error_code) <= 80),
  created_at   timestamptz not null default now()
);
comment on table arca_padron_lookups is
  'ADR-133: cada consulta al padrón de un negocio (de ARCA o de la cache). Base del rate limit. Escribe service_role.';

create index if not exists arca_padron_lookups_tenant_idx on arca_padron_lookups (tenant_id, created_at desc);
create index if not exists arca_padron_lookups_tenant_cuit_idx on arca_padron_lookups (tenant_id, cuit, created_at desc);
create index if not exists arca_padron_lookups_arca_idx on arca_padron_lookups (created_at desc) where source = 'arca';

alter table arca_padron_lookups enable row level security;
revoke all on arca_padron_lookups from anon, authenticated;
grant select on arca_padron_lookups to authenticated;
drop policy if exists arca_padron_lookups_select on arca_padron_lookups;
create policy arca_padron_lookups_select on arca_padron_lookups
  for select using (
    (select internal_scope())
    or (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))
  );

-- -----------------------------------------------------------------------------
-- D) RPC
-- -----------------------------------------------------------------------------

-- Inicio del día de hoy en Argentina (el cupo diario se corta a medianoche de
-- Buenos Aires, no de UTC).
create or replace function _ar_day_start(p_now timestamptz default now())
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$
  select (date_trunc('day', p_now at time zone 'America/Argentina/Buenos_Aires'))
           at time zone 'America/Argentina/Buenos_Aires';
$$;
revoke all on function _ar_day_start(timestamptz) from public, anon;
grant execute on function _ar_day_start(timestamptz) to authenticated, service_role;

-- ¿Puede este usuario consultar el padrón para este negocio? (Edge arca_padron)
-- null = sí; si no, el código del motivo.
create or replace function arca_padron_guard(p_tenant uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not exists (select 1 from tenant_users
                      where tenant_id = p_tenant and user_id = p_user and status = 'active') then 'forbidden'
    when not tenant_has_feature_for(p_tenant, 'padron_arca') then 'feature_not_in_plan'
    else null
  end;
$$;
revoke all on function arca_padron_guard(uuid, uuid) from public, anon, authenticated;
grant execute on function arca_padron_guard(uuid, uuid) to service_role;

-- Consultas a ARCA (no cuenta la cache) del negocio en la última hora y en el
-- día de Argentina, y de toda la plataforma en la última hora.
create or replace function arca_padron_usage(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'tenant_hour', (select count(*) from arca_padron_lookups
                     where tenant_id = p_tenant and source = 'arca' and created_at > now() - interval '1 hour'),
    'tenant_day', (select count(*) from arca_padron_lookups
                    where tenant_id = p_tenant and source = 'arca' and created_at >= _ar_day_start()),
    'global_hour', (select count(*) from arca_padron_lookups
                     where source = 'arca' and created_at > now() - interval '1 hour'));
$$;
revoke all on function arca_padron_usage(uuid) from public, anon, authenticated;
grant execute on function arca_padron_usage(uuid) to service_role;

-- Estado para la UI del negocio: ¿se puede verificar en ARCA?
create or replace function arca_padron_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_cfg    arca_padron_config%rowtype;
begin
  if v_tenant is null or stock_my_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_cfg from arca_padron_config where id;
  return jsonb_build_object(
    'available', tenant_has_feature_for(v_tenant, 'padron_arca') and coalesce(v_cfg.enabled, false)
                 and arca_platform_ready(v_cfg.environment),
    'reason', case
      when not tenant_has_feature_for(v_tenant, 'padron_arca') then 'feature_not_in_plan'
      when not coalesce(v_cfg.enabled, false) then 'disabled'
      when not arca_platform_ready(v_cfg.environment) then 'certificate_missing'
      else null end,
    'environment', v_cfg.environment,
    'cache_days', v_cfg.cache_days);
end;
$$;
revoke all on function arca_padron_status() from public, anon;
grant execute on function arca_padron_status() to authenticated;

-- Panel interno: configuración, certificado del ambiente y uso.
create or replace function internal_arca_padron_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg arca_padron_config%rowtype;
  v_day timestamptz := _ar_day_start();
begin
  if not internal_scope() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_cfg from arca_padron_config where id;
  return jsonb_build_object(
    'config', jsonb_build_object(
      'enabled', v_cfg.enabled, 'environment', v_cfg.environment, 'cache_days', v_cfg.cache_days,
      'tenant_per_hour', v_cfg.tenant_per_hour, 'tenant_per_day', v_cfg.tenant_per_day,
      'global_per_hour', v_cfg.global_per_hour, 'last_test_at', v_cfg.last_test_at,
      'last_test_ok', v_cfg.last_test_ok, 'last_test_cuit', v_cfg.last_test_cuit,
      'last_test_message', v_cfg.last_test_message, 'updated_at', v_cfg.updated_at),
    'certificates', coalesce((
      select jsonb_object_agg(pl.environment, jsonb_build_object(
               'cuit', pl.cuit, 'has_cert', pl.cert_pem is not null, 'has_key', pl.key_enc is not null,
               'subject', pl.subject, 'not_after', pl.not_after, 'ready', arca_platform_ready(pl.environment)))
        from arca_platform pl), '{}'::jsonb),
    'usage', jsonb_build_object(
      'arca_hour', (select count(*) from arca_padron_lookups where source = 'arca' and created_at > now() - interval '1 hour'),
      'arca_day', (select count(*) from arca_padron_lookups where source = 'arca' and created_at >= v_day),
      'cache_day', (select count(*) from arca_padron_lookups where source = 'cache' and created_at >= v_day),
      'errors_day', (select count(*) from arca_padron_lookups where status = 'error' and created_at >= v_day),
      'tenants_day', (select count(distinct tenant_id) from arca_padron_lookups where created_at >= v_day),
      'cache_entries', (select count(*) from arca_padron_cache where environment = v_cfg.environment),
      'day_start', v_day),
    'recent', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select l.created_at, l.cuit, l.source, l.status, l.error_code, l.environment,
               t.name as tenant_name, l.tenant_id
          from arca_padron_lookups l
          left join tenants t on t.id = l.tenant_id
         order by l.created_at desc
         limit 15) x), '[]'::jsonb));
end;
$$;
revoke all on function internal_arca_padron_get() from public, anon;
grant execute on function internal_arca_padron_get() to authenticated;

-- Guardar la configuración: super_admin, con motivo, auditado.
create or replace function internal_arca_padron_save(p jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before arca_padron_config%rowtype;
  v_after  arca_padron_config%rowtype;
begin
  if not internal_scope() or coalesce(internal_level(), '') <> 'super_admin' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'reason_required';
  end if;
  if p ? 'environment' and (p ->> 'environment') not in ('homologacion', 'produccion') then
    raise exception 'invalid_environment';
  end if;
  select * into v_before from arca_padron_config where id for update;
  update arca_padron_config set
    enabled = coalesce((p ->> 'enabled')::boolean, enabled),
    environment = coalesce(p ->> 'environment', environment),
    cache_days = coalesce((p ->> 'cache_days')::integer, cache_days),
    tenant_per_hour = coalesce((p ->> 'tenant_per_hour')::integer, tenant_per_hour),
    tenant_per_day = coalesce((p ->> 'tenant_per_day')::integer, tenant_per_day),
    global_per_hour = coalesce((p ->> 'global_per_hour')::integer, global_per_hour),
    updated_at = now(), updated_by = auth.uid()
  where id
  returning * into v_after;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (null, auth.uid(), 'arca_padron_config', null, 'arca_padron_config_updated',
          to_jsonb(v_before) - 'last_test_message', to_jsonb(v_after) - 'last_test_message', p_reason);
  return internal_arca_padron_get();
end;
$$;
revoke all on function internal_arca_padron_save(jsonb, text) from public, anon;
grant execute on function internal_arca_padron_save(jsonb, text) to authenticated;

-- Resultado de "Probar con un CUIT" (Edge arca_padron, staff). Auditado.
create or replace function arca_padron_test_record(p_user uuid, p_cuit text, p_ok boolean, p_message text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update arca_padron_config set
    last_test_at = now(), last_test_ok = p_ok,
    last_test_cuit = case when p_cuit ~ '^\d{11}$' then p_cuit end,
    last_test_message = left(p_message, 500)
  where id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (null, p_user, 'arca_padron_config', null, 'arca_padron_tested',
          jsonb_build_object('cuit', p_cuit, 'ok', p_ok, 'message', left(p_message, 200)));
end;
$$;
revoke all on function arca_padron_test_record(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function arca_padron_test_record(uuid, text, boolean, text) to service_role;

-- -----------------------------------------------------------------------------
-- E) Cliente verificado con el padrón
-- -----------------------------------------------------------------------------
alter table customers add column if not exists fiscal_verification text;
alter table customers drop constraint if exists customers_fiscal_verification_check;
alter table customers add constraint customers_fiscal_verification_check
  check (fiscal_verification is null or fiscal_verification in ('padron', 'manual'));
alter table customers add column if not exists fiscal_verified_at timestamptz;
alter table customers add column if not exists fiscal_verified_condition text;
alter table customers add column if not exists fiscal_padron jsonb;
alter table customers drop constraint if exists customers_fiscal_padron_check;
alter table customers add constraint customers_fiscal_padron_check
  check (fiscal_padron is null or (jsonb_typeof(fiscal_padron) = 'object' and pg_column_size(fiscal_padron) <= 16384));
comment on column customers.fiscal_verification is
  'ADR-133: padron = datos fiscales verificados en ARCA (lo marca el trigger con una consulta real); manual = cargados a mano; null = sin dato.';
comment on column customers.fiscal_verified_at is 'ADR-133: fecha de la respuesta de ARCA usada para verificar (la escribe el trigger).';
comment on column customers.fiscal_verified_condition is 'ADR-133: condición frente al IVA que informó ARCA (la escribe el trigger).';
comment on column customers.fiscal_padron is 'ADR-133: copia de la respuesta del padrón (razón social, domicilio, actividades, estado).';

-- Condiciones equivalentes para comparar con el padrón (monotributo social =
-- monotributo; sin condición = consumidor final).
create or replace function _fiscal_condition_norm(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case coalesce(nullif(p, ''), 'consumidor_final')
    when 'monotributo_social' then 'monotributo'
    else coalesce(nullif(p, ''), 'consumidor_final') end;
$$;

create or replace function trg_customers_fiscal_verify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc     text := regexp_replace(coalesce(new.document_number, ''), '\D', '', 'g');
  v_changed boolean;
  v_claim   boolean;
  v_env     text;
  v_cache   arca_padron_cache%rowtype;
begin
  v_changed := tg_op = 'INSERT'
               or new.document_type is distinct from old.document_type
               or new.document_number is distinct from old.document_number;
  -- Pedido explícito de "verificado": alta, pasar a padron, o reverificar
  -- (el navegador manda fiscal_verified_at distinto del guardado).
  v_claim := new.fiscal_verification = 'padron'
             and (tg_op = 'INSERT'
                  or old.fiscal_verification is distinct from 'padron'
                  or new.fiscal_verified_at is distinct from old.fiscal_verified_at);

  -- Los datos verificados los escribe sólo este trigger.
  if tg_op = 'INSERT' then
    new.fiscal_verified_at := null;
    new.fiscal_verified_condition := null;
    new.fiscal_padron := null;
  else
    new.fiscal_verified_at := old.fiscal_verified_at;
    new.fiscal_verified_condition := old.fiscal_verified_condition;
    new.fiscal_padron := old.fiscal_padron;
  end if;

  if v_claim then
    if not tenant_has_feature_for(new.tenant_id, 'padron_arca') then
      raise exception 'feature_not_in_plan' using errcode = '42501';
    end if;
    if coalesce(new.document_type, '') not in ('cuit', 'cuil') or length(v_doc) <> 11 or not cuit_is_valid(v_doc) then
      raise exception 'padron_verification_missing' using errcode = 'check_violation';
    end if;
    select environment into v_env from arca_padron_config where id;
    if not exists (select 1 from arca_padron_lookups l
                    where l.tenant_id = new.tenant_id and l.cuit = v_doc and l.status = 'ok'
                      and l.created_at > now() - interval '24 hours') then
      raise exception 'padron_verification_missing' using errcode = 'check_violation';
    end if;
    select * into v_cache from arca_padron_cache c
     where c.cuit = v_doc and c.environment = v_env and c.status = 'ok';
    if not found then
      raise exception 'padron_verification_missing' using errcode = 'check_violation';
    end if;
    new.fiscal_verified_at := v_cache.fetched_at;
    new.fiscal_verified_condition := v_cache.result ->> 'iva_condition';
    new.fiscal_padron := v_cache.result;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, auth.uid(), 'customers', new.id, 'customer_fiscal_verified',
            jsonb_build_object('cuit', v_doc, 'iva_condition', new.fiscal_verified_condition,
                               'arca_fetched_at', v_cache.fetched_at, 'environment', v_env,
                               'razon_social', v_cache.result ->> 'razon_social'));
  elsif v_changed and tg_op = 'UPDATE' then
    -- Otro documento: la verificación anterior no vale para éste.
    new.fiscal_verified_at := null;
    new.fiscal_verified_condition := null;
    new.fiscal_padron := null;
    if new.fiscal_verification = 'padron' then
      new.fiscal_verification := 'manual';
    end if;
  end if;

  -- Si la condición cargada deja de coincidir con la de ARCA, ya no es "verificada".
  if new.fiscal_verification = 'padron'
     and _fiscal_condition_norm(new.iva_condition) is distinct from _fiscal_condition_norm(new.fiscal_verified_condition) then
    new.fiscal_verification := 'manual';
  end if;
  return new;
end;
$$;
revoke all on function trg_customers_fiscal_verify() from public, anon, authenticated;

drop trigger if exists customers_fiscal_verify on customers;
create trigger customers_fiscal_verify
  before insert or update of document_type, document_number, iva_condition, fiscal_verification,
                             fiscal_verified_at, fiscal_verified_condition, fiscal_padron
  on customers
  for each row execute function trg_customers_fiscal_verify();

-- -----------------------------------------------------------------------------
-- F) Tipo de comprobante: lo que ARCA acepta y el forzado a mano
-- -----------------------------------------------------------------------------

-- Matriz de ARCA (WSFEv1, FEParamGetCondicionIvaReceptor, RG 5616): clase A y
-- M sólo a RI, monotributo y monotributo social; clase B al resto; clase C a
-- cualquiera. El emisor RI emite A, B o M (M sólo si ARCA se lo pidió, y
-- entonces no A); el monotributista o exento sólo C. E (exportación) va por
-- WSFEX y NinjaSoft todavía no la emite. null = válido; si no, el motivo.
-- Espejo: lib/billing/cbteOptions.ts → checkLetter().
create or replace function cbte_letter_check(p_emitter text, p_receptor text, p_has_cuit boolean,
                                             p_issues_m boolean, p_letter text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_emitter is null or p_emitter = '' then 'emisor_sin_configurar'
    when p_letter is null or p_letter not in ('A', 'B', 'C', 'M', 'E') then 'letra_invalida'
    when p_letter = 'E' then 'exportacion_no_soportada'
    when not _tax_discriminates(p_emitter) and p_letter <> 'C' then 'letra_no_habilitada_emisor'
    when _tax_discriminates(p_emitter) and p_letter = 'C' then 'letra_no_habilitada_emisor'
    when p_letter in ('A', 'M')
         and coalesce(nullif(p_receptor, ''), 'consumidor_final')
             not in ('responsable_inscripto', 'monotributo', 'monotributo_social') then 'condicion_receptor_no_valida'
    when p_letter = 'B'
         and coalesce(nullif(p_receptor, ''), 'consumidor_final')
             in ('responsable_inscripto', 'monotributo', 'monotributo_social') then 'condicion_receptor_no_valida'
    when p_letter in ('A', 'M') and not coalesce(p_has_cuit, false) then 'receptor_sin_cuit'
    when p_letter = 'A' and coalesce(p_issues_m, false) then 'emisor_emite_m'
    when p_letter = 'M' and not coalesce(p_issues_m, false) then 'm_no_habilitada'
    else null
  end;
$$;
grant execute on function cbte_letter_check(text, text, boolean, boolean, text) to authenticated, service_role;

-- Bloqueos de la cola de ARCA (ADR-072) + la condición del receptor: ninguna
-- combinación que ARCA rechaza llega a mandarse (cualquier camino: venta,
-- forzado, reintento). Misma firma; sólo se suma el chequeo de clase.
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
    when p_letter in ('A', 'M') and p_receptor ? 'iva_condition'
         and coalesce(nullif(p_receptor ->> 'iva_condition', ''), 'consumidor_final')
             not in ('responsable_inscripto', 'monotributo', 'monotributo_social')
      then 'condicion_receptor_no_valida'
    when p_letter = 'B' and p_receptor ? 'iva_condition'
         and coalesce(p_receptor ->> 'iva_condition', '') in ('responsable_inscripto', 'monotributo', 'monotributo_social')
      then 'condicion_receptor_no_valida'
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
    when 'condicion_receptor_no_valida' then 'ARCA no acepta esa letra para la condición frente al IVA del cliente. Revisá la condición del cliente.'
    when 'consumidor_final_sin_identificar' then 'Por el monto, el consumidor final tiene que estar identificado con su documento.'
    else p_code
  end;
$$;

-- Tipo elegido a mano en la hoja de cobro, pendiente de aplicar a la venta
-- que el mismo usuario cree para ese cliente en los próximos 30 minutos.
create table if not exists sale_letter_overrides (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  user_id           uuid not null,
  customer_id       uuid,
  letter            text not null check (letter in ('A', 'B', 'C', 'M')),
  suggested_letter  text check (suggested_letter is null or suggested_letter in ('A', 'B', 'C', 'M', 'E')),
  reason            text check (reason is null or char_length(reason) <= 300),
  created_at        timestamptz not null default now(),
  consumed_at       timestamptz,
  consumed_sale_id  uuid,
  deleted_at        timestamptz
);
comment on table sale_letter_overrides is
  'ADR-133: tipo de comprobante elegido a mano en el POS. Lo aplica el trigger de sales a la próxima venta del mismo usuario y cliente (30 min). Escribe sólo RPC.';
create index if not exists sale_letter_overrides_pending_idx
  on sale_letter_overrides (tenant_id, user_id, created_at desc)
  where consumed_at is null and deleted_at is null;
create index if not exists sale_letter_overrides_tenant_idx on sale_letter_overrides (tenant_id, created_at desc);

alter table sale_letter_overrides enable row level security;
revoke all on sale_letter_overrides from anon, authenticated;
grant select on sale_letter_overrides to authenticated;
drop policy if exists sale_letter_overrides_select on sale_letter_overrides;
create policy sale_letter_overrides_select on sale_letter_overrides
  for select using (
    (select internal_scope())
    or (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))
  );

-- Elegir el tipo para la venta en curso. Valida con la matriz de ARCA y los
-- datos fiscales de HOY del negocio y del cliente. Mismo tipo que el sugerido
-- = vuelve al automático.
create or replace function sale_letter_override_set(p_customer uuid, p_letter text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_uid    uuid := auth.uid();
  v_set    jsonb;
  v_cond   text;
  v_m      boolean;
  v_rcond  text := 'consumidor_final';
  v_cuit   boolean := false;
  v_doc    text;
  v_ctype  text;
  v_cdoc   text;
  v_ccond  text;
  v_sug    text;
  v_err    text;
  v_id     uuid;
begin
  if v_tenant is null or v_uid is null or stock_my_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'facturacion_afip') then
    raise exception 'feature_not_in_plan' using errcode = '42501';
  end if;
  v_set := _tax_settings_eff(v_tenant);
  v_cond := v_set ->> 'iva_condition';
  v_m := coalesce((v_set ->> 'issues_cbte_m')::boolean, false);
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
  v_sug := cbte_letter_infer(v_cond, v_rcond, v_m);

  -- Uno pendiente por usuario: el nuevo reemplaza al anterior.
  update sale_letter_overrides set deleted_at = now()
   where tenant_id = v_tenant and user_id = v_uid and consumed_at is null and deleted_at is null;

  if p_letter is null or p_letter = v_sug then
    return jsonb_build_object('ok', true, 'forced', false, 'letter', v_sug, 'suggested', v_sug);
  end if;
  v_err := cbte_letter_check(v_cond, v_rcond, v_cuit, v_m, p_letter);
  if v_err is not null then
    raise exception '%', v_err using errcode = 'check_violation';
  end if;

  insert into sale_letter_overrides (tenant_id, user_id, customer_id, letter, suggested_letter, reason)
  values (v_tenant, v_uid, p_customer, p_letter, v_sug, nullif(left(btrim(coalesce(p_reason, '')), 300), ''))
  returning id into v_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, reason)
  values (v_tenant, v_uid, 'sale_letter_overrides', v_id, 'sale_letter_override_set',
          jsonb_build_object('customer_id', p_customer, 'suggested', v_sug, 'letter', p_letter,
                             'emitter', v_cond, 'receptor', v_rcond),
          nullif(left(btrim(coalesce(p_reason, '')), 300), ''));
  return jsonb_build_object('ok', true, 'forced', true, 'letter', p_letter, 'suggested', v_sug, 'id', v_id);
end;
$$;
revoke all on function sale_letter_override_set(uuid, text, text) from public, anon;
grant execute on function sale_letter_override_set(uuid, text, text) to authenticated;

-- Descartar el tipo elegido (se cerró la hoja sin cobrar o se volvió al sugerido).
create or replace function sale_letter_override_clear()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update sale_letter_overrides set deleted_at = now()
   where tenant_id = current_tenant_id() and user_id = auth.uid()
     and consumed_at is null and deleted_at is null;
end;
$$;
revoke all on function sale_letter_override_clear() from public, anon;
grant execute on function sale_letter_override_clear() to authenticated;

-- Aplica el tipo elegido a la venta que se está creando (antes del trigger
-- AFTER de ARCA que la encola). Se revalida con el emisor y el receptor que
-- calculó create_sale; si ya no vale, queda la sugerida con un aviso.
create or replace function trg_sales_letter_override()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_o    sale_letter_overrides%rowtype;
  v_snap jsonb;
  v_err  text;
  v_m    boolean;
begin
  if v_uid is null or new.status is distinct from 'completed' or new.cbte_letter is null then
    return new;
  end if;
  select * into v_o from sale_letter_overrides o
   where o.tenant_id = new.tenant_id and o.user_id = v_uid
     and o.consumed_at is null and o.deleted_at is null
     and o.customer_id is not distinct from new.customer_id
     and o.created_at > now() - interval '30 minutes'
   order by o.created_at desc
   limit 1
   for update skip locked;
  if not found then
    return new;
  end if;

  v_snap := coalesce(new.fiscal_snapshot, '{}'::jsonb);
  v_m := coalesce((_tax_settings_eff(new.tenant_id) ->> 'issues_cbte_m')::boolean, false);
  v_err := cbte_letter_check(
    v_snap -> 'emitter' ->> 'iva_condition',
    coalesce(v_snap -> 'receptor' ->> 'iva_condition', 'consumidor_final'),
    coalesce((v_snap -> 'receptor' ->> 'arca_doc_type')::int, 99) = 80,
    v_m,
    v_o.letter);

  update sale_letter_overrides set consumed_at = now(), consumed_sale_id = new.id where id = v_o.id;

  if v_err is null and v_o.letter is distinct from new.cbte_letter then
    new.fiscal_snapshot := v_snap || jsonb_build_object('letter_override', jsonb_build_object(
      'suggested', new.cbte_letter, 'letter', v_o.letter, 'reason', v_o.reason,
      'by', v_uid, 'override_id', v_o.id));
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
    values (new.tenant_id, v_uid, 'sales', new.id, 'sale_letter_forced',
            jsonb_build_object('cbte_letter', new.cbte_letter),
            jsonb_build_object('cbte_letter', v_o.letter, 'override_id', v_o.id, 'customer_id', new.customer_id),
            v_o.reason);
    new.cbte_letter := v_o.letter;
  elsif v_err is not null then
    new.fiscal_snapshot := v_snap || jsonb_build_object(
      'warnings', coalesce(v_snap -> 'warnings', '[]'::jsonb) || jsonb_build_array('letter_override_rejected'),
      'letter_override', jsonb_build_object('rejected', v_err, 'letter', v_o.letter, 'override_id', v_o.id));
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, v_uid, 'sales', new.id, 'sale_letter_override_rejected',
            jsonb_build_object('letter', v_o.letter, 'kept', new.cbte_letter, 'error', v_err, 'override_id', v_o.id));
  end if;
  return new;
end;
$$;
revoke all on function trg_sales_letter_override() from public, anon, authenticated;

drop trigger if exists sales_letter_override on sales;
create trigger sales_letter_override
  before insert on sales
  for each row execute function trg_sales_letter_override();

-- -----------------------------------------------------------------------------
-- G) Datos del propio negocio (Configuración › Marca) traídos del padrón
--
-- Misma regla que el cliente: fiscal_source = 'padron' sólo si el negocio
-- consultó ESE CUIT en las últimas 24 h; fecha y copia de la respuesta las
-- escribe el trigger. Inicio de actividades e IIBB siguen en
-- tenant_branding.activity_start / iibb (los lee el comprobante) y en
-- tax_settings (por tax_settings_save); ARCA no informa IIBB en esta consulta.
-- -----------------------------------------------------------------------------
alter table tenant_branding add column if not exists fiscal_source text;
alter table tenant_branding drop constraint if exists tenant_branding_fiscal_source_check;
alter table tenant_branding add constraint tenant_branding_fiscal_source_check
  check (fiscal_source is null or fiscal_source in ('padron', 'manual'));
alter table tenant_branding add column if not exists fiscal_verified_at timestamptz;
alter table tenant_branding add column if not exists fiscal_padron jsonb;
alter table tenant_branding drop constraint if exists tenant_branding_fiscal_padron_check;
alter table tenant_branding add constraint tenant_branding_fiscal_padron_check
  check (fiscal_padron is null or (jsonb_typeof(fiscal_padron) = 'object' and pg_column_size(fiscal_padron) <= 16384));
comment on column tenant_branding.fiscal_source is
  'ADR-133: padron = razón social, condición y domicilio traídos de ARCA (lo valida el trigger); manual = cargados a mano.';

create or replace function trg_tenant_branding_fiscal_verify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc     text := regexp_replace(coalesce(new.cuit, ''), '\D', '', 'g');
  v_changed boolean;
  v_claim   boolean;
  v_env     text;
  v_cache   arca_padron_cache%rowtype;
begin
  v_changed := tg_op = 'INSERT' or new.cuit is distinct from old.cuit;
  v_claim := new.fiscal_source = 'padron'
             and (tg_op = 'INSERT'
                  or old.fiscal_source is distinct from 'padron'
                  or new.fiscal_verified_at is distinct from old.fiscal_verified_at);
  if tg_op = 'INSERT' then
    new.fiscal_verified_at := null;
    new.fiscal_padron := null;
  else
    new.fiscal_verified_at := old.fiscal_verified_at;
    new.fiscal_padron := old.fiscal_padron;
  end if;

  if v_claim then
    if not tenant_has_feature_for(new.tenant_id, 'padron_arca') then
      raise exception 'feature_not_in_plan' using errcode = '42501';
    end if;
    if length(v_doc) <> 11 or not cuit_is_valid(v_doc) then
      raise exception 'padron_verification_missing' using errcode = 'check_violation';
    end if;
    select environment into v_env from arca_padron_config where id;
    if not exists (select 1 from arca_padron_lookups l
                    where l.tenant_id = new.tenant_id and l.cuit = v_doc and l.status = 'ok'
                      and l.created_at > now() - interval '24 hours') then
      raise exception 'padron_verification_missing' using errcode = 'check_violation';
    end if;
    select * into v_cache from arca_padron_cache c
     where c.cuit = v_doc and c.environment = v_env and c.status = 'ok';
    if not found then
      raise exception 'padron_verification_missing' using errcode = 'check_violation';
    end if;
    new.fiscal_verified_at := v_cache.fetched_at;
    new.fiscal_padron := v_cache.result;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (new.tenant_id, auth.uid(), 'tenant_branding', new.tenant_id, 'branding_fiscal_verified',
            jsonb_build_object('cuit', v_doc, 'iva_condition', v_cache.result ->> 'iva_condition',
                               'arca_fetched_at', v_cache.fetched_at, 'environment', v_env,
                               'razon_social', v_cache.result ->> 'razon_social'));
  elsif v_changed and tg_op = 'UPDATE' then
    new.fiscal_verified_at := null;
    new.fiscal_padron := null;
    if new.fiscal_source = 'padron' then
      new.fiscal_source := 'manual';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function trg_tenant_branding_fiscal_verify() from public, anon, authenticated;

drop trigger if exists tenant_branding_fiscal_verify on tenant_branding;
create trigger tenant_branding_fiscal_verify
  before insert or update of cuit, fiscal_source, fiscal_verified_at, fiscal_padron
  on tenant_branding
  for each row execute function trg_tenant_branding_fiscal_verify();
