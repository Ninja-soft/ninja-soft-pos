-- =============================================================================
-- 20260608530000_industry_presets  (F12 · H35 — onboarding por rubro)
-- -----------------------------------------------------------------------------
-- Una heladería / peluquería queda lista para cobrar su primera venta en
-- <10 min, sin Excel ni SQL: un wizard elige "qué vendés" + un preset de rubro
-- y esta RPC SIEMBRA el catálogo (categorías + un puñado de productos/servicios
-- de muestra, marcados favorito para la grilla rápida del POS · H36) y unos
-- defaults sensatos del POS.
--
--   apply_industry_preset(p_preset text, p_sells text) -> jsonb
--     p_preset : clave de preset (heladeria, cafeteria, panaderia, peluqueria,
--                estetica, lavadero, taller, servicios).
--     p_sells  : 'productos' | 'servicios' | 'ambos'  → filtra qué ítems sembrar.
--     returns  : { categories_created, items_created, skipped, settings_applied }.
--
-- SECURITY DEFINER + guard owner/manager del tenant activo (mismo patrón que
-- set_my_tenant_industry). NO toca tenants.industry (su CHECK sólo admite los 6
-- rubros base); el preset es ortogonal al vertical y sólo INSERTA datos por los
-- mecanismos existentes (categories/products/pos_settings).
--
-- IDEMPOTENTE: si el tenant ya tiene una categoría/producto con el mismo nombre
-- (no borrado), NO la duplica — la saltea y appendea sólo lo que falta. Nunca
-- pisa datos del usuario. Los defaults de pos_settings sólo se fijan cuando el
-- tenant TODAVÍA no tiene fila de settings (alta limpia); si ya configuró el POS,
-- no se toca nada de su configuración.
--
-- Servicios = sin stock: los ítems marcados como servicio se crean con
-- track_stock=false (no descuentan inventario en create_sale, ya respeta el flag).
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

  -- Catálogo de presets como JSON local. Cada fila:
  --   preset, cat (categoría), item (nombre), price, kind ('product'|'service')
  -- Las categorías se derivan de las filas (distinct por preset+cat). `kind`
  -- decide track_stock (service → false) y el filtro por p_sells.
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
    {"preset":"servicios","cat":"Consultoría","item":"Servicio mensual","price":40000,"kind":"service"}
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
    'estetica','lavadero','taller','servicios'
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
  -- lista. Cada ítem nuevo se marca favorito (botón rápido del POS · H36).
  for v_item in
    select
      elem ->> 'cat'              as cat,
      elem ->> 'item'            as item,
      (elem ->> 'price')::numeric as price,
      elem ->> 'kind'            as kind,
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
      track_stock, stock, is_active, is_favorite, favorite_order
    )
    values (
      v_tenant, v_cat_id, v_item.item, coalesce(v_item.price, 0),
      'un',
      -- Servicio = sin stock; producto = con control de stock.
      (v_item.kind <> 'service'),
      0, true, true, v_fav_ord
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

  -- ── 4) Auditoría de la aplicación del preset ────────────────────────────────
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (
    v_tenant, auth.uid(), 'tenants', v_tenant, 'industry_preset_applied',
    jsonb_build_object(
      'preset', p_preset,
      'sells', p_sells,
      'categories_created', v_cats_made,
      'items_created', v_items_made,
      'skipped', v_skipped,
      'settings_applied', v_settings
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
