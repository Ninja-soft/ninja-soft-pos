-- =============================================================================
-- 20261207100000_features_costo_final_precios_usd  (ADR-140)
--
-- Features de plan nuevas (convención CLAUDE.md §6):
--   • costo_final  BASE (is_basic = true): componentes del costo del producto
--                  (impuestos internos y percepciones no recuperables, flete,
--                  otros, en % o en $) = costo final, y utilidad objetivo
--                  (markup sobre costo o margen sobre precio) con el precio
--                  sugerido. Es parte de cargar un producto: entra en todo plan
--                  salvo apagado explícito modules.costo_final = false.
--   • precios_usd  OPTIONAL (Pro, Business y Enterprise): costo del producto en
--                  dólares indexado por la cotización (oficial venta de la
--                  plataforma, ADR-135, o la del negocio), actualización masiva
--                  por dólar y actualización automática cuando el dólar se mueve
--                  más de X %. Funciona sobre el precio de venta (sin listas);
--                  con listas_precios además actualiza los precios fijos de las
--                  listas elegidas.
--
-- Lo de listas (base de costo "costo final", piso global de margen) queda en
-- listas_precios_pro, que ya existe (ADR-058).
--
-- Idempotente: sólo escribe la key en los planes que todavía no la tienen.
-- El gating real vive en 20261207100100 (trigger de products) y 20261207100200
-- (RPC del asistente y de la regla automática).
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('costo_final', 'Costo final y utilidad',
   'Componentes del costo (impuestos no recuperables, flete, otros), costo final, utilidad objetivo y precio sugerido',
   'catalogo', true, 75),
  ('precios_usd', 'Costos en dólares',
   'Costo del producto en dólares con la cotización oficial, actualización masiva por dólar y automática cuando cambia la cotización',
   'catalogo', false, 93)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('precios_usd', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'precios_usd');
