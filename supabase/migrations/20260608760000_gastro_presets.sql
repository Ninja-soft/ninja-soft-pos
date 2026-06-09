-- =============================================================================
-- 20260608760000_gastro_presets  (F13 · H47 — presets gastronómicos que
--                                 enganchan la suite de gastronomía)
-- -----------------------------------------------------------------------------
-- Los presets de rubro (F12 · H35, RPC apply_industry_preset) sembraban
-- categorías + ítems + defaults del POS, pero NO configuraban la operación
-- gastronómica de F13 (mesas/cocina/delivery). Este tick cierra ese gap: agrega
-- 4 presets GASTRONÓMICOS que, además de sembrar el catálogo como hasta hoy,
-- ENCIENDEN la suite F13 según el rubro y dejan el salón/zona listos.
--
--   restaurante   → mesas + cocina (KDS): pos_settings.dining_enabled=true,
--                   salón "Salón" con mesas. Ítems de comida → station 'cocina',
--                   bebidas → station 'barra'.
--   resto_bar     → mesas + cocina + barra + delivery: dining_enabled=true,
--                   delivery_enabled=true, salón "Salón" con mesas + zona
--                   "Zona local". Tragos/cervezas → station 'barra'.
--   rotiseria     → mostrador + delivery: delivery_enabled=true + zona "Zona
--                   local". Comidas → station 'cocina'. (Sin mesas.)
--   dark_kitchen  → SOLO delivery (sin mostrador): delivery_enabled=true + zona
--                   "Zona local". Comidas → station 'cocina'. (Sin mesas.)
--
-- ESPEJA el resto de F13: el salón se siembra por INSERT directo a dining_areas/
-- dining_tables (CRUD abierto a cualquier miembro, igual que modules/dining), y
-- la zona por INSERT a delivery_zones (config comercial; la RPC corre SECURITY
-- DEFINER y ya valida owner/manager arriba, mismo guard que la escritura de
-- delivery_zones). Las estaciones usan products.station (KDS · H45/H46), así el
-- ruteo a cocina/barra queda armado de fábrica.
--
-- PRESERVA TODO el comportamiento previo (heladeria/cafeteria/panaderia/
-- peluqueria/estetica/lavadero/taller/servicios intactos): mismo flujo de
-- categorías/ítems/defaults; el bloque gastronómico nuevo SÓLO corre para los 4
-- presets gastronómicos. Los presets clásicos no tocan dining/delivery/salón.
--
-- IDEMPOTENTE / SEGURO (CLAUDE.md §3):
--   • Categorías/ítems: misma lógica que hoy (saltea por nombre, no duplica).
--   • dining_enabled/delivery_enabled: se ENCIENDEN (el preset es justamente para
--     activar esa operación); no se apaga ni se toca ningún otro setting del
--     usuario. La fila de pos_settings se crea si falta (respetando el default de
--     servicios) y luego se prende sólo el flag del módulo que el preset activa.
--   • Salón "Salón": si el tenant ya tiene un salón con ese nombre (no borrado),
--     se reusa y NO se duplican mesas (sólo completa hasta el mínimo si faltan).
--   • Zona "Zona local": si ya existe (no borrada), no se duplica.
--
-- types/database.ts NO se regenera (el front castea; la DB + RLS validan).
-- =============================================================================

create or replace function apply_industry_preset(p_preset text, p_sells text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant     uuid := current_tenant_id();
  v_cat_id     uuid;
  v_cats_made  int  := 0;
  v_items_made int  := 0;
  v_skipped    int  := 0;
  v_fav_ord    int  := 0;
  v_settings   boolean := false;
  v_cat        record;
  v_item       record;

  -- Flags de gastronomía (F13 · H47) que activa el preset elegido.
  v_wants_dining   boolean := p_preset in ('restaurante','resto_bar');
  v_wants_delivery boolean := p_preset in ('resto_bar','rotiseria','dark_kitchen');
  v_area_id        uuid;
  v_existing_tables int;
  v_n              int;

  -- Catálogo de presets como JSON local. Cada fila:
  --   preset, cat (categoría), item (nombre), price, kind ('product'|'service'),
  --   station (opcional, sólo gastronómicos: 'cocina'|'barra'|… o ausente=null).
  -- Las categorías se derivan de las filas (distinct por preset+cat). `kind`
  -- decide track_stock (service → false) y el filtro por p_sells. `station`
  -- snapshotea products.station (ruteo KDS · H45/H46) cuando viene.
  c_data constant jsonb := $json$
  [
    {"preset":"heladeria","cat":"Helados","item":"Helado 1/4 kg","price":2800,"kind":"product"},
    {"preset":"heladeria","cat":"Helados","item":"Helado 1/2 kg","price":4800,"kind":"product"},
    {"preset":"heladeria","cat":"Helados","item":"Helado 1 kg","price":8500,"kind":"product"},
    {"preset":"heladeria","cat":"Helados","item":"Cucurucho","price":1500,"kind":"product"},
    {"preset":"heladeria","cat":"Postres","item":"Vasito","price":1800,"kind":"product"},
    {"preset":"heladeria","cat":"Postres","item":"Postre helado","price":3500,"kind":"product"},
    {"preset":"heladeria","cat":"Bebidas","item":"Agua 500ml","price":1200,"kind":"product"},
    {"preset":"heladeria","cat":"Bebidas","item":"Gaseosa lata","price":1600,"kind":"product"},

    {"preset":"cafeteria","cat":"Café","item":"Café chico","price":1600,"kind":"product"},
    {"preset":"cafeteria","cat":"Café","item":"Café mediano","price":2000,"kind":"product"},
    {"preset":"cafeteria","cat":"Café","item":"Café grande","price":2400,"kind":"product"},
    {"preset":"cafeteria","cat":"Café","item":"Cortado","price":1800,"kind":"product"},
    {"preset":"cafeteria","cat":"Comidas","item":"Medialuna","price":1100,"kind":"product"},
    {"preset":"cafeteria","cat":"Comidas","item":"Tostado","price":3500,"kind":"product"},
    {"preset":"cafeteria","cat":"Bebidas frías","item":"Agua 500ml","price":1200,"kind":"product"},
    {"preset":"cafeteria","cat":"Bebidas frías","item":"Gaseosa lata","price":1600,"kind":"product"},

    {"preset":"panaderia","cat":"Panadería","item":"Pan (kg)","price":2500,"kind":"product"},
    {"preset":"panaderia","cat":"Panadería","item":"Criollos (kg)","price":4200,"kind":"product"},
    {"preset":"panaderia","cat":"Facturas","item":"Factura surtida","price":900,"kind":"product"},
    {"preset":"panaderia","cat":"Facturas","item":"Medialuna","price":1100,"kind":"product"},
    {"preset":"panaderia","cat":"Facturas","item":"Bizcocho","price":800,"kind":"product"},
    {"preset":"panaderia","cat":"Bebidas","item":"Gaseosa 1.5L","price":2600,"kind":"product"},

    {"preset":"peluqueria","cat":"Cortes","item":"Corte","price":6000,"kind":"service"},
    {"preset":"peluqueria","cat":"Cortes","item":"Corte + barba","price":8000,"kind":"service"},
    {"preset":"peluqueria","cat":"Color","item":"Color","price":12000,"kind":"service"},
    {"preset":"peluqueria","cat":"Color","item":"Reflejos","price":16000,"kind":"service"},
    {"preset":"peluqueria","cat":"Peinados","item":"Peinado","price":7000,"kind":"service"},
    {"preset":"peluqueria","cat":"Peinados","item":"Brushing","price":6500,"kind":"service"},

    {"preset":"estetica","cat":"Uñas","item":"Esmaltado semipermanente","price":7000,"kind":"service"},
    {"preset":"estetica","cat":"Uñas","item":"Kapping","price":9000,"kind":"service"},
    {"preset":"estetica","cat":"Tratamientos faciales","item":"Limpieza facial","price":11000,"kind":"service"},
    {"preset":"estetica","cat":"Depilación","item":"Media pierna","price":5000,"kind":"service"},
    {"preset":"estetica","cat":"Depilación","item":"Cejas","price":3000,"kind":"service"},

    {"preset":"lavadero","cat":"Lavados","item":"Lavado exterior","price":5000,"kind":"service"},
    {"preset":"lavadero","cat":"Lavados","item":"Lavado completo","price":8000,"kind":"service"},
    {"preset":"lavadero","cat":"Adicionales","item":"Encerado","price":6000,"kind":"service"},
    {"preset":"lavadero","cat":"Adicionales","item":"Limpieza de tapizados","price":12000,"kind":"service"},
    {"preset":"lavadero","cat":"Adicionales","item":"Aspirado","price":3000,"kind":"service"},

    {"preset":"taller","cat":"Mano de obra","item":"Service básico","price":15000,"kind":"service"},
    {"preset":"taller","cat":"Mano de obra","item":"Cambio de aceite","price":8000,"kind":"service"},
    {"preset":"taller","cat":"Mano de obra","item":"Diagnóstico","price":6000,"kind":"service"},
    {"preset":"taller","cat":"Mano de obra","item":"Mano de obra (hora)","price":9000,"kind":"service"},
    {"preset":"taller","cat":"Repuestos","item":"Aceite (litro)","price":7000,"kind":"product"},
    {"preset":"taller","cat":"Repuestos","item":"Filtro de aceite","price":5500,"kind":"product"},

    {"preset":"servicios","cat":"Servicios","item":"Hora de consultoría","price":15000,"kind":"service"},
    {"preset":"servicios","cat":"Servicios","item":"Visita técnica","price":12000,"kind":"service"},
    {"preset":"servicios","cat":"Servicios","item":"Presupuesto","price":0,"kind":"service"},
    {"preset":"servicios","cat":"Consultoría","item":"Servicio mensual","price":40000,"kind":"service"},

    {"preset":"restaurante","cat":"Entradas","item":"Empanada","price":1800,"kind":"product","station":"cocina"},
    {"preset":"restaurante","cat":"Entradas","item":"Provoleta","price":5500,"kind":"product","station":"cocina"},
    {"preset":"restaurante","cat":"Principales","item":"Milanesa con papas","price":9500,"kind":"product","station":"cocina"},
    {"preset":"restaurante","cat":"Principales","item":"Bife de chorizo","price":13000,"kind":"product","station":"cocina"},
    {"preset":"restaurante","cat":"Principales","item":"Ñoquis","price":8500,"kind":"product","station":"cocina"},
    {"preset":"restaurante","cat":"Postres","item":"Flan","price":3500,"kind":"product","station":"cocina"},
    {"preset":"restaurante","cat":"Postres","item":"Helado","price":3000,"kind":"product","station":"cocina"},
    {"preset":"restaurante","cat":"Bebidas","item":"Gaseosa lata","price":1600,"kind":"product","station":"barra"},
    {"preset":"restaurante","cat":"Bebidas","item":"Agua 500ml","price":1200,"kind":"product","station":"barra"},

    {"preset":"resto_bar","cat":"Para compartir","item":"Picada","price":12000,"kind":"product","station":"cocina"},
    {"preset":"resto_bar","cat":"Para compartir","item":"Rabas","price":11000,"kind":"product","station":"cocina"},
    {"preset":"resto_bar","cat":"Principales","item":"Bife de chorizo","price":13000,"kind":"product","station":"cocina"},
    {"preset":"resto_bar","cat":"Principales","item":"Hamburguesa completa","price":8500,"kind":"product","station":"cocina"},
    {"preset":"resto_bar","cat":"Tragos","item":"Fernet con cola","price":4500,"kind":"product","station":"barra"},
    {"preset":"resto_bar","cat":"Tragos","item":"Gin tonic","price":5000,"kind":"product","station":"barra"},
    {"preset":"resto_bar","cat":"Cervezas","item":"Cerveza pinta","price":3500,"kind":"product","station":"barra"},
    {"preset":"resto_bar","cat":"Cervezas","item":"Cerveza porrón","price":3000,"kind":"product","station":"barra"},
    {"preset":"resto_bar","cat":"Postres","item":"Flan","price":3500,"kind":"product","station":"cocina"},

    {"preset":"rotiseria","cat":"Rotisería","item":"Pollo al spiedo","price":9000,"kind":"product","station":"cocina"},
    {"preset":"rotiseria","cat":"Rotisería","item":"Medio pollo","price":5000,"kind":"product","station":"cocina"},
    {"preset":"rotiseria","cat":"Rotisería","item":"Milanesa","price":4500,"kind":"product","station":"cocina"},
    {"preset":"rotiseria","cat":"Empanadas","item":"Docena de empanadas","price":7200,"kind":"product","station":"cocina"},
    {"preset":"rotiseria","cat":"Empanadas","item":"Empanada","price":700,"kind":"product","station":"cocina"},
    {"preset":"rotiseria","cat":"Guarniciones","item":"Papas fritas","price":3500,"kind":"product","station":"cocina"},
    {"preset":"rotiseria","cat":"Guarniciones","item":"Ensalada mixta","price":3000,"kind":"product","station":"cocina"},
    {"preset":"rotiseria","cat":"Bebidas","item":"Gaseosa 1.5L","price":2600,"kind":"product"},

    {"preset":"dark_kitchen","cat":"Hamburguesas","item":"Hamburguesa completa","price":7000,"kind":"product","station":"cocina"},
    {"preset":"dark_kitchen","cat":"Hamburguesas","item":"Hamburguesa doble","price":8500,"kind":"product","station":"cocina"},
    {"preset":"dark_kitchen","cat":"Pizzas","item":"Pizza muzzarella","price":7500,"kind":"product","station":"cocina"},
    {"preset":"dark_kitchen","cat":"Pizzas","item":"Pizza especial","price":9000,"kind":"product","station":"cocina"},
    {"preset":"dark_kitchen","cat":"Acompañamientos","item":"Papas fritas","price":3500,"kind":"product","station":"cocina"},
    {"preset":"dark_kitchen","cat":"Acompañamientos","item":"Nuggets","price":4000,"kind":"product","station":"cocina"},
    {"preset":"dark_kitchen","cat":"Bebidas","item":"Gaseosa lata","price":1600,"kind":"product"},
    {"preset":"dark_kitchen","cat":"Bebidas","item":"Agua 500ml","price":1200,"kind":"product"}
  ]
  $json$::jsonb;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;

  -- Sólo el dueño/encargado del tenant activo siembra el catálogo.
  if not exists (
    select 1 from tenant_users
     where tenant_id = v_tenant
       and user_id = auth.uid()
       and status = 'active'
       and role in ('owner','manager')
  ) then
    raise exception 'forbidden';
  end if;

  if p_preset not in (
    'heladeria','cafeteria','panaderia','peluqueria',
    'estetica','lavadero','taller','servicios',
    -- F13 · H47 — presets gastronómicos.
    'restaurante','resto_bar','rotiseria','dark_kitchen'
  ) then
    raise exception 'invalid_preset';
  end if;

  if coalesce(p_sells, '') not in ('productos','servicios','ambos') then
    raise exception 'invalid_sells';
  end if;

  -- ── 1) Categorías del preset (distinct), idempotente por nombre ─────────────
  -- Sólo se siembran las categorías que tienen al menos un ítem visible según
  -- p_sells (no creamos "Repuestos" si el negocio sólo vende servicios). El
  -- orden preserva la aparición en c_data (ord = primera fila de la categoría).
  for v_cat in
    select cat, min(ord) as ord
    from (
      select
        elem ->> 'cat'  as cat,
        elem ->> 'kind' as kind,
        ord
      from jsonb_array_elements(c_data) with ordinality as t(elem, ord)
      where elem ->> 'preset' = p_preset
    ) s
    where (
      p_sells = 'ambos'
      or (p_sells = 'productos' and kind = 'product')
      or (p_sells = 'servicios' and kind = 'service')
    )
    group by cat
    order by min(ord)
  loop
    -- ¿Ya existe (no borrada)? → no duplicar.
    select id into v_cat_id
    from categories
    where tenant_id = v_tenant
      and lower(name) = lower(v_cat.cat)
      and deleted_at is null
    limit 1;

    if v_cat_id is null then
      insert into categories (tenant_id, name)
      values (v_tenant, v_cat.cat)
      returning id into v_cat_id;
      v_cats_made := v_cats_made + 1;
    end if;
  end loop;

  -- ── 2) Productos / servicios de muestra (favoritos), idempotente por nombre ──
  -- Orden estable por aparición en c_data → favorite_order coherente con la
  -- lista. Cada ítem nuevo se marca favorito (botón rápido del POS · H36) y, si
  -- la fila trae `station`, snapshotea products.station (ruteo KDS · H45/H46).
  for v_item in
    select
      elem ->> 'cat'              as cat,
      elem ->> 'item'            as item,
      (elem ->> 'price')::numeric as price,
      elem ->> 'kind'            as kind,
      nullif(btrim(elem ->> 'station'), '') as station,
      ord
    from jsonb_array_elements(c_data) with ordinality as t(elem, ord)
    where elem ->> 'preset' = p_preset
      and (
        p_sells = 'ambos'
        or (p_sells = 'productos' and elem ->> 'kind' = 'product')
        or (p_sells = 'servicios' and elem ->> 'kind' = 'service')
      )
    order by ord
  loop
    -- ¿Ya existe un producto/servicio con ese nombre (no borrado)? → saltear.
    if exists (
      select 1 from products
      where tenant_id = v_tenant
        and lower(name) = lower(v_item.item)
        and deleted_at is null
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Categoría a la que pertenece (creada arriba o preexistente del tenant).
    select id into v_cat_id
    from categories
    where tenant_id = v_tenant
      and lower(name) = lower(v_item.cat)
      and deleted_at is null
    limit 1;

    insert into products (
      tenant_id, category_id, name, price, unit,
      track_stock, stock, is_active, is_favorite, favorite_order, station
    )
    values (
      v_tenant, v_cat_id, v_item.item, coalesce(v_item.price, 0),
      'un',
      -- Servicio = sin stock; producto = con control de stock.
      (v_item.kind <> 'service'),
      0, true, true, v_fav_ord,
      -- Estación de cocina/barra (sólo gastronómicos; null en el resto).
      v_item.station
    );
    v_items_made := v_items_made + 1;
    v_fav_ord := v_fav_ord + 1;
  end loop;

  -- ── 3) Defaults sensatos del POS — sólo en alta limpia (sin fila previa) ─────
  -- No pisamos settings existentes (CLAUDE.md §3): si el tenant ya tiene fila de
  -- pos_settings, respetamos lo que configuró. En modo servicios arrancamos sin
  -- exigir cliente ni documento y con venta libre (cobro de monto manual) on.
  if not exists (select 1 from pos_settings where tenant_id = v_tenant) then
    if p_sells = 'servicios' then
      insert into pos_settings (tenant_id, require_customer, require_customer_doc, allow_free_sale)
      values (v_tenant, false, false, true);
    else
      insert into pos_settings (tenant_id)
      values (v_tenant);
    end if;
    v_settings := true;
  end if;

  -- ── 4) Suite gastronómica (F13 · H47) — sólo presets gastronómicos ───────────
  -- ENCENDER el módulo que el preset activa (dining/delivery) + sembrar salón/
  -- zona. ADITIVO y seguro: prende sólo el flag del módulo elegido (es el sentido
  -- del preset); no apaga ni toca ningún otro setting del usuario. La fila de
  -- pos_settings ya existe a esta altura (creada en el paso 3 si faltaba).
  if v_wants_dining or v_wants_delivery then
    -- Asegurar fila de settings (defensivo: el paso 3 ya la crea en alta limpia).
    if not exists (select 1 from pos_settings where tenant_id = v_tenant) then
      insert into pos_settings (tenant_id) values (v_tenant);
      v_settings := true;
    end if;

    update pos_settings
       set dining_enabled   = case when v_wants_dining   then true else dining_enabled   end,
           delivery_enabled = case when v_wants_delivery then true else delivery_enabled end
     where tenant_id = v_tenant;

    -- ── 4a) Salón "Salón" + mesas (restaurante / resto_bar) ──────────────────
    -- Idempotente: si ya hay un salón "Salón" (no borrado) se reusa y NO se
    -- duplican mesas (sólo completa hasta el mínimo si quedaron menos). Mesas
    -- 1..6 con capacidad 4. Espeja modules/dining (INSERT directo, RLS abierta a
    -- miembros; acá la RPC corre con guard owner/manager).
    if v_wants_dining then
      select id into v_area_id
        from dining_areas
       where tenant_id = v_tenant
         and lower(name) = lower('Salón')
         and deleted_at is null
       limit 1;

      if v_area_id is null then
        insert into dining_areas (tenant_id, name, sort)
        values (v_tenant, 'Salón', 0)
        returning id into v_area_id;
      end if;

      -- Mesas existentes de ese salón (no borradas).
      select count(*) into v_existing_tables
        from dining_tables
       where tenant_id = v_tenant
         and area_id = v_area_id
         and deleted_at is null;

      -- Completar hasta 6 mesas, sin pisar/duplicar etiquetas ya presentes.
      if v_existing_tables < 6 then
        for v_n in 1..6 loop
          if not exists (
            select 1 from dining_tables
             where tenant_id = v_tenant
               and area_id = v_area_id
               and lower(label) = lower('Mesa ' || v_n)
               and deleted_at is null
          ) then
            insert into dining_tables (tenant_id, area_id, label, capacity, sort)
            values (v_tenant, v_area_id, 'Mesa ' || v_n, 4, v_n);
          end if;
        end loop;
      end if;
    end if;

    -- ── 4b) Zona de envío "Zona local" (resto_bar / rotiseria / dark_kitchen) ─
    -- Idempotente: si ya existe (no borrada) no se duplica. Fee 0 (editable por
    -- el dueño en Configuración → Zonas de envío).
    if v_wants_delivery then
      if not exists (
        select 1 from delivery_zones
         where tenant_id = v_tenant
           and lower(name) = lower('Zona local')
           and deleted_at is null
      ) then
        insert into delivery_zones (tenant_id, name, fee, is_active, sort_order)
        values (v_tenant, 'Zona local', 0, true, 0);
      end if;
    end if;
  end if;

  -- ── 5) Auditoría de la aplicación del preset ────────────────────────────────
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (
    v_tenant, auth.uid(), 'tenants', v_tenant, 'industry_preset_applied',
    jsonb_build_object(
      'preset', p_preset,
      'sells', p_sells,
      'categories_created', v_cats_made,
      'items_created', v_items_made,
      'skipped', v_skipped,
      'settings_applied', v_settings,
      'dining_enabled', v_wants_dining,
      'delivery_enabled', v_wants_delivery
    )
  );

  return jsonb_build_object(
    'categories_created', v_cats_made,
    'items_created', v_items_made,
    'skipped', v_skipped,
    'settings_applied', v_settings
  );
end;
$$;

revoke execute on function apply_industry_preset(text, text) from public, anon;
grant  execute on function apply_industry_preset(text, text) to authenticated;
