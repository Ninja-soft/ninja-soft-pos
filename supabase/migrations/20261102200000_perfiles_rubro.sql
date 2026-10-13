-- =============================================================================
-- 20261102200000_perfiles_rubro  (F5 · perfiles por rubro · ADR-075)
-- -----------------------------------------------------------------------------
-- Un perfil por rubro es un PRESET que configura el negocio según su actividad
-- (kiosco, almacén, textil, ferretería, farmacia, gastronomía, cafetería,
-- verdulería, librería, servicios, otro):
--   * prende flags operativos de pos_settings (FLAG-OPERATIVO, CLAUDE.md §6):
--     dining_enabled, delivery_enabled, scale_enabled, plu_enabled,
--     allow_free_sale;
--   * fija el diseño del POS (pos_layout.preset) si el negocio nunca lo tocó;
--   * crea las categorías sugeridas que falten;
--   * alinea tenants.industry con el rubro del perfil;
--   * sugiere unidades, medios de pago, features de plan, atajos y ayuda
--     (sólo se informan en la UI; nada de eso se activa acá).
--
-- Reglas:
--   * NUNCA borra datos ni apaga flags: sólo prende y crea lo que falta.
--   * NO otorga features de plan. scale_enabled exige `balanza` (el trigger de
--     ADR-063 ya lo exige; acá se chequea antes con tenant_has_feature_for para
--     informarlo como bloqueado en vez de fallar). Las features sugeridas
--     (variantes, cuenta_corriente…) no se tocan.
--   * Sólo el DUEÑO aplica un perfil (rol owner del negocio activo).
--   * Todo queda en audit_logs (business_profile_applied, antes y después).
--
-- Datos versionados: la tabla de plataforma `business_profiles` se siembra acá
-- desde lib/profiles/business-profiles.json (tests/unit/businessProfiles.test.ts
-- compara las dos copias). Cambiar un perfil = migración nueva con version + 1.
--
-- RLS: business_profiles es catálogo de plataforma (lectura para logueados, sin
-- escritura por PostgREST). tenant_business_profiles es por negocio:
-- `tenant_id = current_tenant_id() or internal_scope()` (ADR-052), sin
-- escritura directa (sólo la RPC).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Catálogo de perfiles (plataforma)
-- -----------------------------------------------------------------------------
create table if not exists business_profiles (
  key         text primary key check (key ~ '^[a-z_]{2,40}$'),
  version     int not null default 1 check (version > 0),
  label       text not null check (char_length(label) between 1 and 60),
  definition  jsonb not null check (jsonb_typeof(definition) = 'object'),
  is_active   boolean not null default true,
  sort        int not null default 0,
  updated_at  timestamptz not null default now()
);

comment on table business_profiles is
  'F5 · ADR-075: perfiles por rubro (presets). Fuente: lib/profiles/business-profiles.json.';

alter table business_profiles enable row level security;

drop policy if exists business_profiles_select on business_profiles;
create policy business_profiles_select on business_profiles
  for select to authenticated using (true);

revoke insert, update, delete on business_profiles from anon, authenticated;

-- Semilla (misma lista que lib/profiles/business-profiles.json).
with src as (
  select elem, ord
  from jsonb_array_elements($profiles$
[
  {
    "key": "kiosco",
    "version": 1,
    "label": "Kiosco",
    "tagline": "Venta rápida de golosinas, bebidas y cigarrillos.",
    "vertical": "kiosco",
    "flags": ["allow_free_sale"],
    "scanner": true,
    "posPreset": "mostrador",
    "categories": ["Golosinas", "Bebidas", "Cigarrillos", "Snacks", "Almacén"],
    "units": ["un"],
    "payments": ["efectivo", "transferencia", "mercado_pago"],
    "planFeatures": ["pos_quick_keys_pro"],
    "shortcuts": [
      "F2 para buscar un producto y F12 para cobrar.",
      "Marcá como favoritos lo que más vendés: quedan como botones grandes arriba de la grilla.",
      "Venta libre para cobrar un monto sin cargar el producto."
    ],
    "tips": [
      "Con un lector de código de barras no hace falta configurar nada: escaneás y el producto entra al carrito.",
      "Los cigarrillos suelen tener precio fijo: cargalos con su código y actualizalos desde Productos."
    ]
  },
  {
    "key": "almacen",
    "version": 1,
    "label": "Almacén / minimercado",
    "tagline": "Almacén de barrio con fiambres por peso y fiado.",
    "vertical": "kiosco",
    "flags": ["allow_free_sale", "scale_enabled", "plu_enabled"],
    "scanner": true,
    "posPreset": "mostrador",
    "categories": ["Almacén", "Bebidas", "Lácteos", "Fiambres", "Limpieza", "Perfumería"],
    "units": ["un", "kg"],
    "payments": ["efectivo", "transferencia", "mercado_pago", "cuenta_corriente"],
    "planFeatures": ["cuenta_corriente"],
    "shortcuts": [
      "F2 para buscar y F12 para cobrar.",
      "Los productos por kilo tienen botones de ½ kg y 1 kg en el carrito.",
      "El PLU es un código corto para tipear fiambres y quesos sin buscarlos."
    ],
    "tips": [
      "Si tenés balanza etiquetadora, el POS lee las etiquetas con precio o peso.",
      "El fiado se lleva con la cuenta corriente de clientes."
    ]
  },
  {
    "key": "textil",
    "version": 1,
    "label": "Textil / indumentaria",
    "tagline": "Ropa y calzado con talles y colores.",
    "vertical": "textil",
    "flags": [],
    "scanner": true,
    "posPreset": "boutique",
    "categories": ["Remeras", "Pantalones", "Abrigos", "Calzado", "Accesorios"],
    "units": ["un"],
    "payments": ["efectivo", "transferencia", "mercado_pago", "mercadopago_point"],
    "planFeatures": ["variantes"],
    "shortcuts": [
      "El diseño Boutique muestra fotos grandes y las categorías a un costado.",
      "F2 para buscar por nombre o código y F12 para cobrar."
    ],
    "tips": [
      "Con variantes, cada talle y color tiene su propio stock y código.",
      "Los cambios de talle se hacen desde Devoluciones, sin anular la venta."
    ]
  },
  {
    "key": "ferreteria",
    "version": 1,
    "label": "Ferretería / corralón",
    "tagline": "Muchos artículos chicos, por metro, kilo o unidad.",
    "vertical": "retail",
    "flags": ["allow_free_sale"],
    "scanner": true,
    "posPreset": "mostrador",
    "categories": ["Herramientas", "Tornillería", "Electricidad", "Plomería", "Pinturas"],
    "units": ["un", "m", "kg", "l"],
    "payments": ["efectivo", "transferencia", "mercado_pago", "cuenta_corriente"],
    "planFeatures": ["medidas_bultos", "cuenta_corriente"],
    "shortcuts": [
      "F2 para buscar por nombre o código del proveedor y F12 para cobrar.",
      "Venta libre para cobrar un artículo suelto que no tenés cargado."
    ],
    "tips": [
      "Cargá la unidad de cada artículo (metro, kilo, litro) para vender cantidades con decimales.",
      "Con medidas y bultos vendés por caja o por unidad el mismo producto."
    ]
  },
  {
    "key": "farmacia",
    "version": 1,
    "label": "Farmacia / perfumería",
    "tagline": "Perfumería, cuidado personal y venta libre.",
    "vertical": "retail",
    "flags": [],
    "scanner": true,
    "posPreset": "mostrador",
    "categories": ["Perfumería", "Cuidado personal", "Bebés", "Dermocosmética", "Venta libre"],
    "units": ["un"],
    "payments": ["efectivo", "transferencia", "mercado_pago", "mercadopago_point"],
    "planFeatures": [],
    "shortcuts": [
      "Escaneá el código de barras del envase y F12 para cobrar."
    ],
    "tips": [
      "NinjaSoft no valida recetas ni obras sociales: usalo para el mostrador de perfumería y venta libre.",
      "Controlá vencimientos desde Compras si cargás lotes."
    ]
  },
  {
    "key": "gastronomia",
    "version": 1,
    "label": "Gastronomía / restaurante",
    "tagline": "Mesas, comandas a cocina y delivery propio.",
    "vertical": "restaurante",
    "flags": ["dining_enabled", "delivery_enabled"],
    "scanner": false,
    "posPreset": "salon",
    "categories": ["Entradas", "Principales", "Postres", "Bebidas", "Cafetería"],
    "units": ["un", "porción"],
    "payments": ["efectivo", "transferencia", "mercado_pago", "mercadopago_point"],
    "planFeatures": [],
    "shortcuts": [
      "El diseño Salón muestra las mesas, la carta y la cuenta en una sola pantalla.",
      "Los pedidos se mandan a cocina (KDS) al confirmar la comanda."
    ],
    "tips": [
      "Armá tus salones y mesas en Configuración, Salones y mesas.",
      "El delivery propio usa la sección Delivery: cargá zonas y costo de envío."
    ]
  },
  {
    "key": "cafeteria",
    "version": 1,
    "label": "Cafetería / take away",
    "tagline": "Mostrador rápido de café, pastelería y para llevar.",
    "vertical": "cafeteria",
    "flags": ["allow_free_sale"],
    "scanner": false,
    "posPreset": "mostrador",
    "categories": ["Café", "Pastelería", "Sándwiches", "Bebidas frías"],
    "units": ["un"],
    "payments": ["efectivo", "transferencia", "mercado_pago"],
    "planFeatures": [],
    "shortcuts": [
      "Marcá los cafés como favoritos para cobrarlos con un toque.",
      "Usá modificadores para tamaño y agregados (leche, extra shot)."
    ],
    "tips": [
      "Si también tenés mesas, prendé el modo gastronómico en Operación y productos.",
      "Los modificadores se cargan en la ficha de cada producto."
    ]
  },
  {
    "key": "verduleria",
    "version": 1,
    "label": "Verdulería / carnicería",
    "tagline": "Venta por peso con balanza y códigos PLU.",
    "vertical": "kiosco",
    "flags": ["scale_enabled", "plu_enabled", "allow_free_sale"],
    "scanner": false,
    "posPreset": "caja_rapida",
    "categories": ["Frutas", "Verduras", "Carnes", "Achuras", "Almacén"],
    "units": ["kg", "un"],
    "payments": ["efectivo", "transferencia", "mercado_pago"],
    "planFeatures": [],
    "shortcuts": [
      "Caja rápida: teclado numérico primero para tipear el PLU y el peso.",
      "Botones de ½ kg y 1 kg en cada producto por peso."
    ],
    "tips": [
      "Conectá la balanza a la caja para leer el peso en vivo, o leé las etiquetas de la balanza etiquetadora.",
      "Cargá los productos con unidad kg para que el precio sea por kilo."
    ]
  },
  {
    "key": "libreria",
    "version": 1,
    "label": "Librería / papelería",
    "tagline": "Artículos escolares, de oficina y libros.",
    "vertical": "retail",
    "flags": ["allow_free_sale"],
    "scanner": true,
    "posPreset": "mostrador",
    "categories": ["Escolar", "Oficina", "Libros", "Fotocopias", "Regalería"],
    "units": ["un"],
    "payments": ["efectivo", "transferencia", "mercado_pago"],
    "planFeatures": ["listas_precios"],
    "shortcuts": [
      "Escaneá el ISBN o el código del artículo y F12 para cobrar.",
      "Venta libre para fotocopias e impresiones."
    ],
    "tips": [
      "En temporada escolar, las listas de precios te permiten un precio mayorista para colegios."
    ]
  },
  {
    "key": "servicios",
    "version": 1,
    "label": "Servicios",
    "tagline": "Turnos, servicios por hora y abonos, sin stock.",
    "vertical": "servicios",
    "flags": ["allow_free_sale"],
    "scanner": false,
    "posPreset": "caja_rapida",
    "categories": ["Servicios", "Abonos"],
    "units": ["un", "h"],
    "payments": ["efectivo", "transferencia", "mercado_pago"],
    "planFeatures": ["agenda", "packs"],
    "shortcuts": [
      "Marcá tus servicios como favoritos para cobrarlos con un toque.",
      "Venta libre para cobrar un trabajo con monto a medida."
    ],
    "tips": [
      "Cargá los servicios sin control de stock: no descuentan inventario.",
      "La agenda de turnos vincula al cliente con el profesional y el cobro."
    ]
  },
  {
    "key": "otro",
    "version": 1,
    "label": "Otro rubro",
    "tagline": "Configuración general, sin adaptaciones específicas.",
    "vertical": "otro",
    "flags": [],
    "scanner": true,
    "posPreset": "mostrador",
    "categories": ["General"],
    "units": ["un"],
    "payments": ["efectivo", "transferencia"],
    "planFeatures": [],
    "shortcuts": [
      "F2 para buscar un producto y F12 para cobrar."
    ],
    "tips": [
      "Podés prender cada función a mano en Configuración, Operación y productos."
    ]
  }
]
$profiles$::jsonb) with ordinality as t(elem, ord)
)
insert into business_profiles (key, version, label, definition, is_active, sort, updated_at)
select elem ->> 'key', (elem ->> 'version')::int, elem ->> 'label', elem, true, ord::int, now()
from src
on conflict (key) do update
  set version    = excluded.version,
      label      = excluded.label,
      definition = excluded.definition,
      is_active  = true,
      sort       = excluded.sort,
      updated_at = now();

-- -----------------------------------------------------------------------------
-- B) Perfil aplicado por negocio
-- -----------------------------------------------------------------------------
create table if not exists tenant_business_profiles (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default current_tenant_id()
                     references tenants(id) on delete cascade,
  profile_key      text not null references business_profiles(key),
  profile_version  int not null check (profile_version > 0),
  previous_key     text,
  applied_at       timestamptz not null default now(),
  applied_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tenant_business_profiles_tenant_uniq unique (tenant_id)
);

create index if not exists tenant_business_profiles_profile_idx
  on tenant_business_profiles (profile_key);
create index if not exists tenant_business_profiles_applied_by_idx
  on tenant_business_profiles (applied_by) where applied_by is not null;

comment on table tenant_business_profiles is
  'F5 · ADR-075: perfil por rubro aplicado a cada negocio. Escritura sólo por apply_business_profile.';

alter table tenant_business_profiles enable row level security;

drop policy if exists tenant_business_profiles_select on tenant_business_profiles;
create policy tenant_business_profiles_select on tenant_business_profiles
  for select using (tenant_id = current_tenant_id() or internal_scope());

revoke insert, update, delete on tenant_business_profiles from anon, authenticated;

drop trigger if exists set_updated_at_tenant_business_profiles on tenant_business_profiles;
create trigger set_updated_at_tenant_business_profiles
  before update on tenant_business_profiles
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- C) apply_business_profile(p_key, p_create_categories) -> jsonb
--    Espejo en TS: lib/profiles/preview.ts (vista previa antes de confirmar).
-- -----------------------------------------------------------------------------
create or replace function apply_business_profile(
  p_key text,
  p_create_categories boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant        uuid := current_tenant_id();
  v_uid           uuid := auth.uid();
  v_profile       business_profiles%rowtype;
  v_def           jsonb;
  v_flag          text;
  v_activate      text[] := '{}';
  v_already       text[] := '{}';
  v_locked        text[] := '{}';
  v_before        jsonb;
  v_after         jsonb;
  v_layout        jsonb;
  v_preset        text;
  v_dining_after  boolean;
  v_apply_layout  boolean := false;
  v_cat           text;
  v_cats_made     text[] := '{}';
  v_sort          int;
  v_industry_from text;
  v_industry_to   text;
  v_prev_key      text;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  if not exists (
    select 1 from tenant_users
     where tenant_id = v_tenant
       and user_id = v_uid
       and status = 'active'
       and role = 'owner'
  ) then
    raise exception 'forbidden';
  end if;

  select * into v_profile
    from business_profiles
   where key = p_key and is_active;
  if not found then
    raise exception 'invalid_profile';
  end if;
  v_def := v_profile.definition;

  -- Un cambio de perfil por negocio a la vez.
  perform pg_advisory_xact_lock(hashtext('business_profile:' || v_tenant::text));

  -- Fila de settings (alta limpia: defaults de la tabla).
  insert into pos_settings (tenant_id) values (v_tenant)
  on conflict (tenant_id) do nothing;

  select jsonb_build_object(
           'dining_enabled',   dining_enabled,
           'delivery_enabled', delivery_enabled,
           'scale_enabled',    scale_enabled,
           'plu_enabled',      plu_enabled,
           'allow_free_sale',  allow_free_sale,
           'pos_layout',       pos_layout
         ),
         pos_layout
    into v_before, v_layout
    from pos_settings
   where tenant_id = v_tenant
   for update;

  -- ── 1) Flags operativos: sólo se prenden ──────────────────────────────────
  for v_flag in select jsonb_array_elements_text(coalesce(v_def -> 'flags', '[]'::jsonb))
  loop
    if v_flag not in ('dining_enabled','delivery_enabled','scale_enabled','plu_enabled','allow_free_sale') then
      continue;
    end if;
    if coalesce((v_before ->> v_flag)::boolean, false) then
      v_already := array_append(v_already, v_flag);
    elsif v_flag = 'scale_enabled' and not tenant_has_feature_for(v_tenant, 'balanza') then
      v_locked := array_append(v_locked, v_flag);
    else
      v_activate := array_append(v_activate, v_flag);
    end if;
  end loop;

  -- ── 2) Diseño del POS: sólo si nunca se personalizó ───────────────────────
  v_preset := v_def ->> 'posPreset';
  v_dining_after := coalesce((v_before ->> 'dining_enabled')::boolean, false)
                    or 'dining_enabled' = any(v_activate);
  v_apply_layout := coalesce(v_layout, '{}'::jsonb) = '{}'::jsonb
                    and v_preset is not null
                    and v_preset in ('boutique','salon','caja_rapida')
                    and (v_preset <> 'salon' or v_dining_after);

  update pos_settings
     set dining_enabled   = dining_enabled   or 'dining_enabled'   = any(v_activate),
         delivery_enabled = delivery_enabled or 'delivery_enabled' = any(v_activate),
         scale_enabled    = scale_enabled    or 'scale_enabled'    = any(v_activate),
         plu_enabled      = plu_enabled      or 'plu_enabled'      = any(v_activate),
         allow_free_sale  = allow_free_sale  or 'allow_free_sale'  = any(v_activate),
         pos_layout       = case when v_apply_layout
                                 then jsonb_build_object('preset', v_preset)
                                 else pos_layout end
   where tenant_id = v_tenant;

  -- ── 3) Categorías sugeridas que falten (nunca borra ni renombra) ──────────
  if coalesce(p_create_categories, true) then
    select coalesce(max(sort_order), 0) into v_sort
      from categories where tenant_id = v_tenant and deleted_at is null;
    for v_cat in select jsonb_array_elements_text(coalesce(v_def -> 'categories', '[]'::jsonb))
    loop
      if btrim(v_cat) = '' then continue; end if;
      if not exists (
        select 1 from categories
         where tenant_id = v_tenant
           and deleted_at is null
           and lower(btrim(name)) = lower(btrim(v_cat))
      ) then
        v_sort := v_sort + 1;
        insert into categories (tenant_id, name, sort_order)
        values (v_tenant, btrim(v_cat), v_sort);
        v_cats_made := array_append(v_cats_made, btrim(v_cat));
      end if;
    end loop;
  end if;

  -- ── 4) Rubro del negocio (tenants.industry) ───────────────────────────────
  select industry into v_industry_from from tenants where id = v_tenant;
  v_industry_to := v_def ->> 'vertical';
  if v_industry_to is not null and v_industry_to is distinct from v_industry_from then
    perform _assert_valid_industry(v_industry_to);
    update tenants set industry = v_industry_to, updated_at = now() where id = v_tenant;
  end if;

  -- ── 5) Perfil aplicado ────────────────────────────────────────────────────
  select profile_key into v_prev_key from tenant_business_profiles where tenant_id = v_tenant;

  insert into tenant_business_profiles (tenant_id, profile_key, profile_version, previous_key, applied_at, applied_by)
  values (v_tenant, v_profile.key, v_profile.version, v_prev_key, now(), v_uid)
  on conflict (tenant_id) do update
    set profile_key     = excluded.profile_key,
        profile_version = excluded.profile_version,
        previous_key    = tenant_business_profiles.profile_key,
        applied_at      = excluded.applied_at,
        applied_by      = excluded.applied_by;

  -- ── 6) Auditoría ──────────────────────────────────────────────────────────
  select jsonb_build_object(
           'dining_enabled',   dining_enabled,
           'delivery_enabled', delivery_enabled,
           'scale_enabled',    scale_enabled,
           'plu_enabled',      plu_enabled,
           'allow_free_sale',  allow_free_sale,
           'pos_layout',       pos_layout
         )
    into v_after
    from pos_settings where tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (
    v_tenant, v_uid, 'tenant_business_profiles', v_tenant, 'business_profile_applied',
    jsonb_build_object('profile', v_prev_key, 'industry', v_industry_from, 'settings', v_before),
    jsonb_build_object(
      'profile', v_profile.key,
      'version', v_profile.version,
      'industry', coalesce(v_industry_to, v_industry_from),
      'settings', v_after,
      'activated', to_jsonb(v_activate),
      'locked', to_jsonb(v_locked),
      'categories_created', to_jsonb(v_cats_made),
      'layout_applied', v_apply_layout
    )
  );

  return jsonb_build_object(
    'profile', v_profile.key,
    'version', v_profile.version,
    'activated', to_jsonb(v_activate),
    'already_on', to_jsonb(v_already),
    'locked', to_jsonb(v_locked),
    'categories_created', to_jsonb(v_cats_made),
    'layout_applied', v_apply_layout,
    'industry', coalesce(v_industry_to, v_industry_from)
  );
end;
$$;

revoke execute on function apply_business_profile(text, boolean) from public, anon;
grant execute on function apply_business_profile(text, boolean) to authenticated;
