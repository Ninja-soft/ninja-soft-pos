-- =============================================================================
-- 20260608110000_features_plans_addons  (SAAS Fase C — aplicada en remoto vía MCP)
--
-- A) features: catálogo de funcionalidades reales del sistema (key, label,
--    grupo, is_basic, sort). Lectura para todo authenticated (la UI de gating
--    la necesita); escritura solo staff interno. Seed idempotente.
-- B) plans: columnas icon / trial_days / sort para el creador dinámico.
-- C) plan_addons: addons contratables (ai_assistant, …). Seed idempotente.
-- D) subscription_addons: addons activos por tenant (granted | purchased),
--    materializados por el webhook MP. Lectura propio tenant o staff.
-- E) internal_save_plan(): alta/edición de planes GLOBALES (auditada). Los
--    custom por tenant siguen por internal_update_custom_plan.
-- F) internal_set_addon(): grant/cancel de un addon a un tenant (auditado).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Catálogo de features.
-- -----------------------------------------------------------------------------
create table if not exists features (
  key         text primary key,
  label       text not null,
  description text,
  grupo       text not null default 'general',
  is_basic    boolean not null default false,
  sort        int not null default 0
);

alter table features enable row level security;

-- Lectura para todo authenticated (gating UI); escritura solo staff interno.
create policy features_select on features
  for select using (true);
create policy features_insert on features
  for insert with check ((select is_internal()));
create policy features_update on features
  for update using ((select is_internal())) with check ((select is_internal()));

insert into features (key, label, description, grupo, is_basic, sort) values
  ('pos',               'Punto de venta',        'Pantalla de ventas / cobro',                 'ventas',        true,  10),
  ('caja',              'Caja',                  'Apertura, cierre y arqueo de caja',          'ventas',        true,  20),
  ('devoluciones',      'Devoluciones',          'Notas de crédito y devoluciones',            'ventas',        true,  30),
  ('garantias',         'Garantías',             'Gestión de garantías de productos',          'ventas',        false, 40),
  ('cuenta_corriente',  'Cuenta corriente',      'Cuentas corrientes de clientes',             'ventas',        false, 50),
  ('productos',         'Productos',             'Catálogo de productos',                      'catalogo',      true,  60),
  ('stock',             'Stock',                 'Control de stock e inventario',              'catalogo',      true,  70),
  ('variantes',         'Variantes',             'Variantes de producto (talle, color…)',      'catalogo',      false, 80),
  ('listas_precios',    'Listas de precios',     'Múltiples listas de precios',                'catalogo',      false, 90),
  ('catalogo_publico',  'Catálogo público',      'Catálogo web público del comercio',          'catalogo',      false, 100),
  ('importacion_excel', 'Importación Excel',     'Importar productos desde Excel',             'catalogo',      false, 110),
  ('clientes',          'Clientes',              'Gestión de clientes',                        'clientes',      true,  120),
  ('grupos_clientes',   'Grupos de clientes',    'Segmentación de clientes en grupos',         'clientes',      false, 130),
  ('tickets_pro',       'Tickets PRO',           'Diseñador avanzado de tickets',              'tickets',       false, 140),
  ('email_comprobantes','Email de comprobantes', 'Envío de comprobantes por email',            'tickets',       false, 150),
  ('reportes',          'Reportes',              'Reportes de ventas y métricas',              'reportes',      true,  160),
  ('export_xlsx',       'Exportar a Excel',      'Exportación de reportes a XLSX',             'reportes',      false, 170),
  ('mercado_pago',      'Mercado Pago',          'Cobros con Mercado Pago',                    'integraciones', false, 180),
  ('mobbex',            'Mobbex',                'Cobros con Mobbex',                           'integraciones', false, 190),
  ('multi_sucursal',    'Multi-sucursal',        'Gestión de múltiples sucursales',            'integraciones', false, 200),
  ('api_publica',       'API pública',           'Acceso a la API pública',                    'integraciones', false, 210),
  ('asistente_ia',      'Asistente IA',          'Asistente con IA para tu POS',               'extras',        false, 220),
  ('notificaciones',    'Notificaciones',        'Notificaciones in-app',                      'extras',        true,  230)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- B) Columnas para el creador dinámico de planes.
-- -----------------------------------------------------------------------------
alter table plans add column if not exists icon text;
alter table plans add column if not exists trial_days int not null default 14;
alter table plans add column if not exists sort int not null default 0;

-- -----------------------------------------------------------------------------
-- C) Addons contratables.
-- -----------------------------------------------------------------------------
create table if not exists plan_addons (
  id                uuid primary key default gen_random_uuid(),
  key               text not null,
  label             text not null,
  description       text,
  monthly_price_ars numeric(12,2) not null default 0,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (key)
);

alter table plan_addons enable row level security;

create policy plan_addons_select on plan_addons
  for select using (true);
create policy plan_addons_insert on plan_addons
  for insert with check ((select is_internal()));
create policy plan_addons_update on plan_addons
  for update using ((select is_internal())) with check ((select is_internal()));

insert into plan_addons (key, label, description, monthly_price_ars, is_active) values
  ('ai_assistant', 'Asistente IA', 'Asistente con IA para configurar y consultar tu POS', 0, true)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- D) Addons activos por tenant (materializados por el webhook MP).
-- -----------------------------------------------------------------------------
create table if not exists subscription_addons (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  addon_key    text not null,
  status       text not null default 'active' check (status in ('active','cancelled')),
  source       text not null default 'granted' check (source in ('granted','purchased')),
  provider_ref text,
  created_at   timestamptz not null default now(),
  unique (tenant_id, addon_key)
);
create index if not exists idx_subscription_addons_tenant on subscription_addons(tenant_id);

alter table subscription_addons enable row level security;

-- Lectura: miembro del propio tenant o staff interno. Escritura: solo interno
-- (el webhook/service_role saltea RLS).
create policy subscription_addons_select on subscription_addons
  for select using (
    tenant_id = (select current_tenant_id()) or (select is_internal())
  );
create policy subscription_addons_insert on subscription_addons
  for insert with check ((select is_internal()));
create policy subscription_addons_update on subscription_addons
  for update using ((select is_internal())) with check ((select is_internal()));

-- -----------------------------------------------------------------------------
-- E) Alta / edición de planes globales (auditada).
-- -----------------------------------------------------------------------------
create or replace function internal_save_plan(
  p_id            uuid,
  p_key           text,
  p_name          text,
  p_description   text,
  p_icon          text,
  p_monthly_price numeric,
  p_trial_days    int,
  p_limits        jsonb,
  p_is_active     boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old plans%rowtype;
  v_id  uuid;
  v_key text;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_monthly_price is null or p_monthly_price < 0 then
    raise exception 'invalid_price';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'invalid_name';
  end if;

  if p_id is null then
    -- Alta de plan global nuevo.
    v_key := coalesce(
      nullif(btrim(p_key), ''),
      regexp_replace(lower(p_name), '[^a-z0-9]+', '_', 'g') || '_'
        || substr(md5(random()::text), 1, 4)
    );

    insert into plans (key, name, description, icon, monthly_price_ars,
                       trial_days, limits, is_active, sort, tenant_id)
    values (v_key, btrim(p_name), p_description, p_icon, p_monthly_price,
            coalesce(p_trial_days, 14), coalesce(p_limits, '{}'::jsonb),
            coalesce(p_is_active, true), 0, null)
    returning id into v_id;

    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
    values (null, auth.uid(), 'plans', v_id, 'plan_saved',
            jsonb_build_object('key', v_key, 'name', btrim(p_name),
                               'monthly_price_ars', p_monthly_price,
                               'trial_days', coalesce(p_trial_days, 14),
                               'is_active', coalesce(p_is_active, true),
                               'limits', coalesce(p_limits, '{}'::jsonb)));
    return v_id;
  end if;

  -- Edición: solo planes globales (tenant_id null).
  select * into v_old from plans where id = p_id;
  if not found then
    raise exception 'plan_not_found';
  end if;
  if v_old.tenant_id is not null then
    raise exception 'not_global_plan';
  end if;

  update plans
     set name              = btrim(p_name),
         description        = p_description,
         icon              = p_icon,
         monthly_price_ars = p_monthly_price,
         trial_days        = coalesce(p_trial_days, v_old.trial_days),
         limits            = coalesce(p_limits, v_old.limits),
         is_active         = coalesce(p_is_active, v_old.is_active)
   where id = p_id;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action,
                          before_data, after_data)
  values (null, auth.uid(), 'plans', p_id, 'plan_saved',
          jsonb_build_object('name', v_old.name, 'description', v_old.description,
                             'icon', v_old.icon, 'monthly_price_ars', v_old.monthly_price_ars,
                             'trial_days', v_old.trial_days, 'is_active', v_old.is_active,
                             'limits', v_old.limits),
          jsonb_build_object('name', btrim(p_name), 'description', p_description,
                             'icon', p_icon, 'monthly_price_ars', p_monthly_price,
                             'trial_days', coalesce(p_trial_days, v_old.trial_days),
                             'is_active', coalesce(p_is_active, v_old.is_active),
                             'limits', coalesce(p_limits, v_old.limits)));
  return p_id;
end;
$$;
revoke all on function internal_save_plan(uuid, text, text, text, text, numeric, int, jsonb, boolean) from public, anon;
grant execute on function internal_save_plan(uuid, text, text, text, text, numeric, int, jsonb, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- F) Grant / cancelación de un addon a un tenant (auditado).
-- -----------------------------------------------------------------------------
create or replace function internal_set_addon(
  p_tenant_id uuid,
  p_addon_key text,
  p_active    boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  if not is_internal() then
    raise exception 'forbidden';
  end if;
  if coalesce(internal_level(), 'admin') = 'support' then
    raise exception 'forbidden';
  end if;
  if p_tenant_id is null then
    raise exception 'invalid_tenant';
  end if;
  if coalesce(btrim(p_addon_key), '') = '' then
    raise exception 'invalid_addon';
  end if;

  v_status := case when coalesce(p_active, false) then 'active' else 'cancelled' end;

  insert into subscription_addons (tenant_id, addon_key, status, source)
  values (p_tenant_id, p_addon_key, v_status, 'granted')
  on conflict (tenant_id, addon_key)
    do update set status = excluded.status, source = 'granted';

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant_id, auth.uid(), 'subscription_addons', p_tenant_id, 'addon_set',
          jsonb_build_object('addon', p_addon_key, 'status', v_status));
end;
$$;
revoke all on function internal_set_addon(uuid, text, boolean) from public, anon;
grant execute on function internal_set_addon(uuid, text, boolean) to authenticated;
