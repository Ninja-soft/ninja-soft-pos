-- =============================================================================
-- 20261120100200_imagenes_ia.sql  (ADR-122)
--
-- Portadas de servicios y productos generadas con IA (modelo de imagen de
-- Gemini, "nano banana": gemini-2.5-flash-image) por la Edge Function
-- ai_cover_image, con la API key de la plataforma (platform_secrets
-- ai_config.gemini_api_key o el secret GEMINI_API_KEY), nunca en el front.
--
-- Clasificación (CLAUDE.md §6): ADDON. Es parte del complemento Asistente IA
-- (`asistente_ia` / `ai_assistant`): no entra por plan ni lleva key nueva.
-- Gating real: el trigger de ai_image_settings y _ai_image_reserve llaman a
-- tenant_has_feature_for(tenant, 'asistente_ia') (resuelve el alias del addon).
--
-- A) ai_image_settings: por negocio. auto_cover (generar la portada al crear
--    un servicio), estilo, color de acento opcional y prompt base editable.
-- B) ai_image_generations: historial y registro de consumo (una fila por
--    pedido: pending → ok | error). Insert/update sólo service_role (la Edge).
--    Es la base para cobrar o limitar por plan o addon.
-- C) ai_image_daily_limit(): tope diario por negocio (ai_config
--    .image_daily_limit, default 20). ai_image_usage_today(): uso del día.
-- D) _ai_image_reserve (service_role): addon, producto del negocio y tope del
--    día con lock por negocio (concurrente-seguro); deja la fila pending.
-- E) ai_image_choose (authenticated) / _ai_image_apply (service_role): pasa
--    una imagen del historial a la galería del producto como principal.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Configuración por negocio
-- -----------------------------------------------------------------------------
create table if not exists ai_image_settings (
  tenant_id   uuid primary key references tenants(id) on delete cascade,
  auto_cover  boolean not null default false,
  style       text not null default 'flat_icon'
              check (style in ('flat_icon', 'isometric', 'photo', 'soft_3d', 'line_minimal', 'watercolor',
                               'paper_cut', 'duotone')),
  accent      text check (accent is null or accent ~ '^#[0-9a-fA-F]{6}$'),
  base_prompt text check (base_prompt is null or char_length(base_prompt) <= 1500),
  updated_by  uuid default auth.uid() references public.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);
create index if not exists ai_image_settings_updated_by_idx on ai_image_settings (updated_by) where updated_by is not null;

drop trigger if exists set_updated_at_ai_image_settings on ai_image_settings;
create trigger set_updated_at_ai_image_settings
  before update on ai_image_settings
  for each row execute function set_updated_at();

alter table ai_image_settings enable row level security;
drop policy if exists ai_image_settings_select on ai_image_settings;
create policy ai_image_settings_select on ai_image_settings
  for select using (tenant_id = (select current_tenant_id()));
drop policy if exists ai_image_settings_insert on ai_image_settings;
create policy ai_image_settings_insert on ai_image_settings
  for insert with check (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
drop policy if exists ai_image_settings_update on ai_image_settings;
create policy ai_image_settings_update on ai_image_settings
  for update using (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()))
  with check (tenant_id = (select current_tenant_id()) and (select is_tenant_manager()));
revoke delete on ai_image_settings from anon, authenticated;
revoke all on ai_image_settings from anon;

drop trigger if exists role_write_guard on ai_image_settings;
create trigger role_write_guard before insert or update or delete on ai_image_settings
  for each row execute function trg_role_write_guard('manage');

-- Gating y auditoría: sin el complemento Asistente IA no se configura.
create or replace function _ai_image_settings_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not tenant_has_feature_for(new.tenant_id, 'asistente_ia') then
    raise exception 'addon_required' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function _ai_image_settings_guard() from public, anon, authenticated;

drop trigger if exists ai_image_settings_guard on ai_image_settings;
create trigger ai_image_settings_guard
  before insert or update on ai_image_settings
  for each row execute function _ai_image_settings_guard();

create or replace function _ai_image_settings_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (new.tenant_id, auth.uid(), 'ai_image_settings', new.tenant_id, 'ai_image_settings_updated',
          case when tg_op = 'UPDATE' then
            jsonb_build_object('auto_cover', old.auto_cover, 'style', old.style, 'accent', old.accent,
                               'base_prompt', old.base_prompt)
          end,
          jsonb_build_object('auto_cover', new.auto_cover, 'style', new.style, 'accent', new.accent,
                             'base_prompt', new.base_prompt));
  return null;
end;
$$;
revoke all on function _ai_image_settings_audit() from public, anon, authenticated;

drop trigger if exists ai_image_settings_audit on ai_image_settings;
create trigger ai_image_settings_audit
  after insert or update on ai_image_settings
  for each row execute function _ai_image_settings_audit();

comment on table ai_image_settings is
  'ADR-122: portadas con IA del negocio (complemento Asistente IA): generación automática al crear un servicio, estilo, acento y prompt base.';

-- -----------------------------------------------------------------------------
-- B) Historial y consumo
-- -----------------------------------------------------------------------------
create table if not exists ai_image_generations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  product_id  uuid references products(id) on delete set null,
  user_id     uuid references public.users(id) on delete set null,
  status      text not null default 'pending' check (status in ('pending', 'ok', 'error')),
  style       text not null,
  prompt      text not null check (char_length(prompt) <= 4000),
  model       text,
  path        text,
  url         text,
  bytes       int,
  error       text check (error is null or char_length(error) <= 500),
  -- Unidades de consumo (1 por imagen generada; para cobrar o limitar).
  units       int not null default 0 check (units >= 0),
  chosen_at   timestamptz,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists ai_image_generations_tenant_created_idx
  on ai_image_generations (tenant_id, created_at desc);
create index if not exists ai_image_generations_product_idx
  on ai_image_generations (product_id, created_at desc) where product_id is not null and deleted_at is null;
create index if not exists ai_image_generations_user_idx
  on ai_image_generations (user_id) where user_id is not null;

alter table ai_image_generations enable row level security;
drop policy if exists ai_image_generations_select on ai_image_generations;
create policy ai_image_generations_select on ai_image_generations
  for select using (tenant_id = (select current_tenant_id()));
-- Sin policies de escritura: sólo service_role (Edge ai_cover_image) y las RPC.
revoke insert, update, delete on ai_image_generations from anon, authenticated;
revoke all on ai_image_generations from anon;

comment on table ai_image_generations is
  'ADR-122: imágenes generadas con IA (historial por producto y registro de consumo por negocio). Escribe sólo la Edge ai_cover_image.';

-- -----------------------------------------------------------------------------
-- C) Tope diario y uso
-- -----------------------------------------------------------------------------
create or replace function ai_image_daily_limit()
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select case when (s.secrets ->> 'image_daily_limit') ~ '^[0-9]{1,5}$'
                 then (s.secrets ->> 'image_daily_limit')::int end
       from platform_secrets s where s.key = 'ai_config'),
    20)
$$;
revoke all on function ai_image_daily_limit() from public, anon;
grant execute on function ai_image_daily_limit() to authenticated, service_role;

create or replace function _ai_image_used_today(p_tenant uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int
    from ai_image_generations g
   where g.tenant_id = p_tenant
     and g.status in ('pending', 'ok')
     and g.created_at >= ((now() at time zone 'America/Argentina/Buenos_Aires')::date::timestamp
                          at time zone 'America/Argentina/Buenos_Aires')
$$;
revoke all on function _ai_image_used_today(uuid) from public, anon, authenticated;

-- Uso del día del negocio del JWT (para la UI): {used, limit, allowed}.
create or replace function ai_image_usage_today()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or member_role_in(v_tenant) is null then
    return null;
  end if;
  return jsonb_build_object(
    'used', _ai_image_used_today(v_tenant),
    'limit', ai_image_daily_limit(),
    'allowed', tenant_has_feature_for(v_tenant, 'asistente_ia'));
end;
$$;
revoke all on function ai_image_usage_today() from public, anon;
grant execute on function ai_image_usage_today() to authenticated;

-- -----------------------------------------------------------------------------
-- D) Reserva de una generación (sólo service_role: la Edge)
-- -----------------------------------------------------------------------------
create or replace function _ai_image_reserve(
  p_tenant  uuid,
  p_user    uuid,
  p_product uuid,
  p_style   text,
  p_prompt  text,
  p_model   text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not tenant_has_feature_for(p_tenant, 'asistente_ia') then
    raise exception 'addon_required';
  end if;
  if not exists (select 1 from products p where p.id = p_product and p.tenant_id = p_tenant and p.deleted_at is null) then
    raise exception 'product_not_found';
  end if;
  -- Dueño o encargado (el cajero no edita el catálogo, ADR-071). Sin usuario
  -- sólo la llama la Edge con un pedido ya validado.
  if p_user is not null and coalesce(
       (select tu.role from tenant_users tu
         where tu.tenant_id = p_tenant and tu.user_id = p_user and tu.status = 'active' limit 1), 'viewer')
       not in ('owner', 'manager') then
    raise exception 'forbidden';
  end if;
  perform pg_advisory_xact_lock(hashtext('ai_image:' || p_tenant::text));
  if _ai_image_used_today(p_tenant) >= ai_image_daily_limit() then
    raise exception 'daily_limit';
  end if;
  insert into ai_image_generations (tenant_id, product_id, user_id, status, style, prompt, model)
  values (p_tenant, p_product, p_user, 'pending', left(coalesce(p_style, 'flat_icon'), 40),
          left(coalesce(p_prompt, ''), 4000), left(p_model, 80))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function _ai_image_reserve(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function _ai_image_reserve(uuid, uuid, uuid, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- E) Usar una imagen del historial como foto principal del producto
-- -----------------------------------------------------------------------------
create or replace function _ai_image_apply(p_tenant uuid, p_generation uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_g    ai_image_generations%rowtype;
  v_sort int;
  v_img  uuid;
begin
  select * into v_g from ai_image_generations
   where id = p_generation and tenant_id = p_tenant and deleted_at is null and status = 'ok'
   for update;
  if not found or v_g.product_id is null or v_g.path is null then
    raise exception 'generation_not_found';
  end if;
  if not exists (select 1 from products p where p.id = v_g.product_id and p.tenant_id = p_tenant and p.deleted_at is null) then
    raise exception 'product_not_found';
  end if;
  -- Ya está en la galería: sólo pasa a principal.
  select pi.id into v_img from product_images pi
   where pi.product_id = v_g.product_id and pi.tenant_id = p_tenant and pi.path = v_g.path and pi.deleted_at is null
   limit 1;
  update product_images set is_primary = false
   where product_id = v_g.product_id and tenant_id = p_tenant and is_primary and id is distinct from v_img;
  if v_img is null then
    select coalesce(max(sort), -1) + 1 into v_sort from product_images
     where product_id = v_g.product_id and tenant_id = p_tenant and deleted_at is null;
    insert into product_images (tenant_id, product_id, path, url, is_primary, sort)
    values (p_tenant, v_g.product_id, v_g.path, v_g.url, true, v_sort)
    returning id into v_img;
  else
    update product_images set is_primary = true where id = v_img;
  end if;
  update products set image_url = v_g.url where id = v_g.product_id and tenant_id = p_tenant;
  update ai_image_generations set chosen_at = now() where id = p_generation;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (p_tenant, p_actor, 'products', v_g.product_id, 'ai_cover_applied',
          jsonb_build_object('generation_id', p_generation, 'style', v_g.style, 'url', v_g.url));
  return jsonb_build_object('product_id', v_g.product_id, 'image_id', v_img, 'url', v_g.url);
end;
$$;
revoke all on function _ai_image_apply(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function _ai_image_apply(uuid, uuid, uuid) to service_role;

create or replace function ai_image_choose(p_generation uuid)
returns jsonb
language plpgsql
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
  if v_role is null or v_role = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- El cajero no edita el catálogo (ADR-071).
  if v_role = 'cashier' then
    raise exception 'forbidden_role' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'asistente_ia') then
    raise exception 'addon_required' using errcode = '42501';
  end if;
  return _ai_image_apply(v_tenant, p_generation, auth.uid());
end;
$$;
revoke all on function ai_image_choose(uuid) from public, anon;
grant execute on function ai_image_choose(uuid) to authenticated;
