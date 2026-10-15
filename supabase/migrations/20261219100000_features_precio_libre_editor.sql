-- =============================================================================
-- 20261219100000_features_precio_libre_editor  (ADR-151)
--
-- Features de plan nuevas (convención CLAUDE.md §6):
--   • precio_libre    BASE (is_basic = true): un producto o servicio puede
--                     tener "precio a definir al cobrar". El POS pide el precio
--                     al agregarlo (con mínimo, máximo y sugerido) y create_sale
--                     acepta el informado dentro de los límites, auditado. Es
--                     parte de vender servicios o productos a medida: lo necesita
--                     cualquier plan (un honorario variable no es un extra).
--   • editor_precios  BASE (is_basic = true): editor rápido de precios dentro de
--                     Productos (planilla con costo, precio, margen y precios por
--                     lista, edición masiva, deshacer y guardado en lote con
--                     vista previa y auditoría). Cambiar el precio de venta de los
--                     productos propios es básico (el asistente masivo del precio
--                     de venta ya es BASE desde ADR-058); las columnas por lista
--                     sólo aparecen y se guardan con listas_precios, que sigue
--                     siendo OPTIONAL. Por eso no va dentro de listas_precios_pro.
--
-- Idempotente: sólo escribe la key en los planes que todavía no la tienen.
-- El gating real vive en 20261219100100 (trigger de products, create_sale,
-- trg_order_item_price y las RPC del editor).
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('precio_libre', 'Precio a definir al cobrar',
   'Productos y servicios con precio libre: el POS pide el precio al agregarlo, con mínimo, máximo y sugerido, y queda auditado',
   'catalogo', true, 76),
  ('editor_precios', 'Editor rápido de precios',
   'Planilla para editar costo, precio, margen y precios por lista con edición masiva, deshacer, vista previa y guardado en lote',
   'catalogo', true, 77)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('precio_libre', true)
    || jsonb_build_object('editor_precios', true),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'precio_libre');
