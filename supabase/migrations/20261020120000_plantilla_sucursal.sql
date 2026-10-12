-- =============================================================================
-- 20261020120000_plantilla_sucursal  (F17 · H89 · H92 · ADR-057)
--
-- Sucursal nueva a partir de otra o de una plantilla guardada.
--
--   * store_templates: plantillas del negocio (nombre, descripción y una foto
--     de la configuración de una sucursal). Lectura: miembros del negocio
--     (internal_scope() para el panel interno, ADR-052). Escritura sólo por
--     RPC (sin policies de insert/update/delete).
--   * Partes que se copian (p_parts, null = todas las que aplican):
--       config          → overrides de pos_settings y ticket de la sucursal
--       payment_methods → overrides de medios de pago (encendido, recargo,
--                         modo de planes, n° de comercio)
--       printers        → impresoras de la sucursal (sin caja: las cajas son
--                         otras) y los perfiles de impresión que las usan,
--                         con los ids remapeados a las impresoras nuevas
--       plans           → planes de cuotas propios de la sucursal
--       staff           → (sólo desde una sucursal) acceso adicional a la
--                         sucursal nueva para el personal vigente de la origen,
--                         con su rol, vía staff_branch_schedule
--     Nunca se copian terminales ni credenciales: son de cada local.
--   * store_template_save(nombre, sucursal, partes, descripción): guarda la
--     foto. store_template_delete(id): baja lógica.
--   * store_copy_setup(destino, desde sucursal | desde plantilla, partes):
--     aplica. Dueño o encargado con acceso a origen y destino, plan con
--     multi_sucursal; todo pasa por config_override_set (whitelist, tipos,
--     gating antes de la herencia y auditoría por campo) y además deja un
--     audit_logs 'store_setup_copied' con lo que hizo.
-- =============================================================================

create table if not exists store_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  description text check (description is null or char_length(description) <= 300),
  source_store_id uuid references stores(id) on delete set null,
  parts       text[] not null default '{}'::text[],
  payload     jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index if not exists store_templates_name_key
  on store_templates (tenant_id, lower(btrim(name))) where deleted_at is null;

drop trigger if exists set_updated_at_store_templates on store_templates;
create trigger set_updated_at_store_templates
  before update on store_templates
  for each row execute function set_updated_at();

alter table store_templates enable row level security;
drop policy if exists store_templates_select on store_templates;
create policy store_templates_select on store_templates
  for select using (tenant_id = current_tenant_id() or internal_scope());

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function _store_setup_parts(p_parts text[], p_from_store boolean)
returns text[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_all text[] := array['config', 'payment_methods', 'printers', 'plans', 'staff'];
  v_out text[];
  x     text;
begin
  if p_parts is null then
    v_out := v_all;
  else
    v_out := '{}'::text[];
    foreach x in array p_parts loop
      if not (x = any (v_all)) then raise exception 'invalid_part: %', x using errcode = '22023'; end if;
      if not (x = any (v_out)) then v_out := v_out || x; end if;
    end loop;
  end if;
  -- El personal sólo se copia de una sucursal real, nunca de una plantilla.
  if not p_from_store then v_out := array_remove(v_out, 'staff'); end if;
  return v_out;
end;
$$;

-- Foto de una sucursal (sin staff): overrides por dominio, impresoras con un
-- token estable en lugar del id (los perfiles apuntan al token) y planes.
create or replace function _store_snapshot(p_tenant uuid, p_store uuid, p_parts text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_domains   text[] := '{}'::text[];
  v_printers  jsonb := '[]'::jsonb;
  v_overrides jsonb;
  v_plans     jsonb := '[]'::jsonb;
  v_text      text;
  r           record;
  n           int := 0;
begin
  if 'config' = any (p_parts) then v_domains := v_domains || array['pos_settings', 'ticket']; end if;
  if 'payment_methods' = any (p_parts) then v_domains := v_domains || array['payment_method']; end if;
  -- Los perfiles de impresión viven en pos_settings: con impresoras se copian
  -- aunque no se pida toda la configuración (sólo el campo print_profiles).
  select coalesce(jsonb_agg(jsonb_build_object('domain', co.domain, 'domain_key', co.domain_key,
                                               'patch', case when co.domain = 'pos_settings'
                                                              and not ('config' = any (p_parts))
                                                             then jsonb_build_object('print_profiles', co.patch -> 'print_profiles')
                                                             else co.patch end)
                            order by co.domain, co.domain_key), '[]'::jsonb)
    into v_overrides
    from config_overrides co
   where co.tenant_id = p_tenant and co.scope = 'store' and co.scope_id = p_store
     and co.deleted_at is null
     and (co.domain = any (v_domains)
          or ('printers' = any (p_parts) and co.domain = 'pos_settings' and co.patch ? 'print_profiles'));

  v_text := v_overrides::text;
  if 'printers' = any (p_parts) then
    for r in
      select id, name, kind, connection, address, notes, active from printers
       where tenant_id = p_tenant and store_id = p_store and deleted_at is null
       order by created_at
    loop
      n := n + 1;
      v_printers := v_printers || jsonb_build_object(
        'ref', 'printer-' || n, 'name', r.name, 'kind', r.kind, 'connection', r.connection,
        'address', r.address, 'notes', r.notes, 'active', r.active);
      v_text := replace(v_text, r.id::text, 'printer-' || n);
    end loop;
  end if;
  v_overrides := v_text::jsonb;

  if 'plans' = any (p_parts) then
    select coalesce(jsonb_agg(jsonb_build_object(
             'provider_key', p.provider_key, 'code', p.code, 'label', p.label, 'base', p.base,
             'brand', p.brand, 'installments', p.installments, 'surcharge_pct', p.surcharge_pct,
             'sort', p.sort, 'is_active', p.is_active, 'valid_from', p.valid_from,
             'valid_until', p.valid_until) order by p.provider_key, p.sort, p.label), '[]'::jsonb)
      into v_plans
      from payment_plans p
     where p.tenant_id = p_tenant and p.store_id = p_store;
  end if;

  return jsonb_build_object('version', 1, 'overrides', v_overrides,
                            'printers', v_printers, 'plans', v_plans);
end;
$$;
revoke all on function _store_snapshot(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function _store_snapshot(uuid, uuid, text[]) to service_role;

create or replace function _store_setup_guard(p_tenant uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not tenant_has_feature_for(p_tenant, 'multi_sucursal') then
    raise exception 'feature_not_in_plan: multi_sucursal' using errcode = '42501';
  end if;
end;
$$;
revoke all on function _store_setup_guard(uuid) from public, anon, authenticated;
grant execute on function _store_setup_guard(uuid) to service_role;

create or replace function _store_live_allowed(p_tenant uuid, p_store uuid)
returns stores
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v stores;
begin
  select * into v from stores where id = p_store and tenant_id = p_tenant and deleted_at is null;
  if not found then raise exception 'store_not_found'; end if;
  if not user_can_access_store(p_store) then raise exception 'forbidden' using errcode = '42501'; end if;
  return v;
end;
$$;
revoke all on function _store_live_allowed(uuid, uuid) from public, anon, authenticated;
grant execute on function _store_live_allowed(uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- Guardar y borrar plantillas
-- -----------------------------------------------------------------------------
create or replace function store_template_save(
  p_name        text,
  p_from_store  uuid,
  p_parts       text[] default null,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_parts  text[];
  v_name   text := btrim(coalesce(p_name, ''));
  v_id     uuid;
  v_store  stores;
  v_payload jsonb;
begin
  perform _store_setup_guard(v_tenant);
  if v_name = '' or char_length(v_name) > 60 then raise exception 'invalid_name' using errcode = '22023'; end if;
  v_store := _store_live_allowed(v_tenant, p_from_store);
  v_parts := _store_setup_parts(p_parts, false);
  if cardinality(v_parts) = 0 then raise exception 'no_parts' using errcode = '22023'; end if;
  if exists (select 1 from store_templates where tenant_id = v_tenant and deleted_at is null
              and lower(btrim(name)) = lower(v_name)) then
    raise exception 'template_name_taken' using errcode = '23505';
  end if;
  v_payload := _store_snapshot(v_tenant, p_from_store, v_parts);

  insert into store_templates (tenant_id, name, description, source_store_id, parts, payload, created_by)
  values (v_tenant, v_name, nullif(btrim(coalesce(p_description, '')), ''), p_from_store, v_parts, v_payload, auth.uid())
  returning id into v_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'store_templates', v_id, 'store_template_saved',
          jsonb_build_object('name', v_name, 'from_store', p_from_store, 'from_store_name', v_store.name,
                             'parts', v_parts,
                             'overrides', jsonb_array_length(v_payload -> 'overrides'),
                             'printers', jsonb_array_length(v_payload -> 'printers'),
                             'plans', jsonb_array_length(v_payload -> 'plans')));
  return v_id;
end;
$$;
revoke all on function store_template_save(text, uuid, text[], text) from public, anon;
grant execute on function store_template_save(text, uuid, text[], text) to authenticated;

create or replace function store_template_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_name   text;
begin
  if v_tenant is null then raise exception 'no_tenant'; end if;
  if not is_tenant_manager() then raise exception 'forbidden' using errcode = '42501'; end if;
  update store_templates set deleted_at = now()
   where id = p_id and tenant_id = v_tenant and deleted_at is null
   returning name into v_name;
  if v_name is null then raise exception 'template_not_found'; end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'store_templates', p_id, 'store_template_deleted',
          jsonb_build_object('name', v_name));
end;
$$;
revoke all on function store_template_delete(uuid) from public, anon;
grant execute on function store_template_delete(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Aplicar: desde otra sucursal o desde una plantilla
-- -----------------------------------------------------------------------------
create or replace function store_copy_setup(
  p_target     uuid,
  p_from_store uuid default null,
  p_template   uuid default null,
  p_parts      text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant   uuid := current_tenant_id();
  v_target   stores;
  v_source   stores;
  v_tpl      store_templates;
  v_parts    text[];
  v_payload  jsonb;
  v_text     text;
  v_map      jsonb := '{}'::jsonb;
  v_new      uuid;
  v_existing uuid;
  v_patch    jsonb;
  v_counts   jsonb := jsonb_build_object('overrides', 0, 'printers', 0, 'plans', 0, 'staff', 0, 'skipped', 0);
  e          jsonb;
  r          record;
  k          text;
  vt         text;
begin
  perform _store_setup_guard(v_tenant);
  if (p_from_store is null) = (p_template is null) then
    raise exception 'invalid_source' using errcode = '22023';
  end if;
  if p_from_store = p_target then raise exception 'same_store' using errcode = '22023'; end if;
  v_target := _store_live_allowed(v_tenant, p_target);

  if p_from_store is not null then
    v_source := _store_live_allowed(v_tenant, p_from_store);
    v_parts := _store_setup_parts(p_parts, true);
    v_payload := _store_snapshot(v_tenant, p_from_store, v_parts);
  else
    select * into v_tpl from store_templates
     where id = p_template and tenant_id = v_tenant and deleted_at is null;
    if not found then raise exception 'template_not_found'; end if;
    v_parts := _store_setup_parts(coalesce(p_parts, v_tpl.parts), false);
    -- Sólo lo que la plantilla tiene.
    select coalesce(array_agg(x), '{}'::text[]) into v_parts
      from unnest(v_parts) x where x = any (v_tpl.parts);
    v_payload := v_tpl.payload;
  end if;
  if cardinality(v_parts) = 0 then raise exception 'no_parts' using errcode = '22023'; end if;

  -- 1) Impresoras (antes que los perfiles, para remapear los ids).
  if 'printers' = any (v_parts) then
    for e in select * from jsonb_array_elements(coalesce(v_payload -> 'printers', '[]'::jsonb)) loop
      select id into v_existing from printers
       where store_id = p_target and deleted_at is null
         and lower(btrim(name)) = lower(btrim(e ->> 'name'));
      if v_existing is null then
        insert into printers (tenant_id, store_id, name, kind, connection, address, notes, active, created_by)
        values (v_tenant, p_target, e ->> 'name', e ->> 'kind', coalesce(e ->> 'connection', 'browser'),
                e ->> 'address', e ->> 'notes', coalesce((e ->> 'active')::boolean, true), auth.uid())
        returning id into v_new;
        v_counts := jsonb_set(v_counts, '{printers}', to_jsonb((v_counts ->> 'printers')::int + 1));
      else
        v_new := v_existing;
      end if;
      v_map := v_map || jsonb_build_object(e ->> 'ref', v_new::text);
    end loop;
  end if;

  -- 2) Overrides (configuración, medios y perfiles de impresión).
  v_text := coalesce(v_payload -> 'overrides', '[]'::jsonb)::text;
  for k, vt in select * from jsonb_each_text(v_map) loop
    v_text := replace(v_text, '"' || k || '"', '"' || vt || '"');
  end loop;
  for e in select * from jsonb_array_elements(v_text::jsonb) loop
    if (e ->> 'domain') = 'payment_method' and not ('payment_methods' = any (v_parts)) then continue; end if;
    if (e ->> 'domain') in ('pos_settings', 'ticket') and not ('config' = any (v_parts)) then
      if not ((e ->> 'domain') = 'pos_settings' and 'printers' = any (v_parts)) then continue; end if;
      v_patch := jsonb_strip_nulls(jsonb_build_object('print_profiles', e -> 'patch' -> 'print_profiles'));
    else
      v_patch := coalesce(e -> 'patch', '{}'::jsonb);
    end if;
    -- Perfiles que apuntan a una impresora que no se copió: se sacan los ids
    -- huérfanos (quedan "la del equipo"), nunca una impresora de otra sucursal.
    if v_patch ? 'print_profiles' and not ('printers' = any (v_parts)) then
      v_patch := v_patch - 'print_profiles';
    end if;
    if v_patch = '{}'::jsonb then continue; end if;
    begin
      perform config_override_set('store', p_target, e ->> 'domain', coalesce(e ->> 'domain_key', ''), v_patch, '{}'::text[]);
      v_counts := jsonb_set(v_counts, '{overrides}', to_jsonb((v_counts ->> 'overrides')::int + 1));
    exception when others then
      -- Medio fuera del plan o campo que ya no existe: se saltea y se informa.
      v_counts := jsonb_set(v_counts, '{skipped}', to_jsonb((v_counts ->> 'skipped')::int + 1));
    end;
  end loop;

  -- 3) Planes propios de la sucursal.
  if 'plans' = any (v_parts) then
    for e in select * from jsonb_array_elements(coalesce(v_payload -> 'plans', '[]'::jsonb)) loop
      insert into payment_plans (tenant_id, store_id, provider_key, code, label, base, brand, installments,
                                 surcharge_pct, sort, is_active, valid_from, valid_until)
      values (v_tenant, p_target, e ->> 'provider_key', e ->> 'code', e ->> 'label',
              coalesce(e ->> 'base', 'otro'), e ->> 'brand', coalesce((e ->> 'installments')::int, 1),
              coalesce((e ->> 'surcharge_pct')::numeric, 0), coalesce((e ->> 'sort')::int, 0),
              coalesce((e ->> 'is_active')::boolean, true),
              (e ->> 'valid_from')::date, (e ->> 'valid_until')::date)
      on conflict (tenant_id, provider_key, code, store_id) do update
        set label = excluded.label, base = excluded.base, brand = excluded.brand,
            installments = excluded.installments, surcharge_pct = excluded.surcharge_pct,
            sort = excluded.sort, is_active = excluded.is_active,
            valid_from = excluded.valid_from, valid_until = excluded.valid_until;
      v_counts := jsonb_set(v_counts, '{plans}', to_jsonb((v_counts ->> 'plans')::int + 1));
    end loop;
  end if;

  -- 4) Personal: acceso adicional a la sucursal nueva, con el rol que tienen
  --    en la origen. Sólo personal operativo hoy; el dueño ya ve todas.
  if 'staff' = any (v_parts) and p_from_store is not null then
    for r in
      select distinct on (coalesce(a.user_id, a.cashier_profile_id))
             a.user_id, a.cashier_profile_id, a.role
        from staff_branch_assignments a
        left join tenant_users tu on tu.tenant_id = a.tenant_id and tu.user_id = a.user_id
       where a.tenant_id = v_tenant and a.store_id = p_from_store and a.deleted_at is null
         and a.valid_from <= branch_today()
         and (a.valid_until is null or a.valid_until >= branch_today())
         and (a.user_id is null or (tu.status = 'active' and tu.role <> 'owner'))
       order by coalesce(a.user_id, a.cashier_profile_id), (a.kind = 'home') desc
    loop
      begin
        perform staff_branch_schedule(p_target, 'extra', r.user_id, r.cashier_profile_id,
                                      branch_today(), null, r.role,
                                      'Copiado de ' || v_source.name);
        v_counts := jsonb_set(v_counts, '{staff}', to_jsonb((v_counts ->> 'staff')::int + 1));
      exception when others then
        v_counts := jsonb_set(v_counts, '{skipped}', to_jsonb((v_counts ->> 'skipped')::int + 1));
      end;
    end loop;
  end if;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'stores', p_target, 'store_setup_copied',
          jsonb_build_object('target', p_target, 'target_name', v_target.name,
                             'from_store', p_from_store,
                             'from_store_name', case when p_from_store is not null then v_source.name end,
                             'template', p_template,
                             'template_name', case when p_template is not null then v_tpl.name end,
                             'parts', v_parts, 'counts', v_counts));
  return v_counts || jsonb_build_object('parts', v_parts);
end;
$$;
revoke all on function store_copy_setup(uuid, uuid, uuid, text[]) from public, anon;
grant execute on function store_copy_setup(uuid, uuid, uuid, text[]) to authenticated;
