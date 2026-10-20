# IM5 cap. 03 (Logística y Ecommerce) vs NinjaSoft POS

Fuente: `ANDESMAR/docs/auditoria-im5/03-logistica-y-ecommerce.md`. Comparado contra `pos-deploy` main (30ca1316), roadmap `docs/02-roadmap.md` (F19, F22, F5/H87/H141/H142, H66, H84), docs 38/41/42/43/45 y código (migraciones, Edges, componentes). Nota: buena parte del código de logística (L0 a L5) y de Mercado Libre está en main pero con migraciones "sin aplicar" o Edges "sin desplegar" según el roadmap; acá se clasifica como HECHO si el código existe.

Resumen: en **Hoja de Ruta**, NinjaPOS ya supera a IM5 (flota, paradas, app del repartidor offline, firma, foto, geo, mapa, planificación por zona, escaneo, entrega parcial). Lo que IM5 tiene y NinjaPOS no: **importe cobrado/pendiente por hoja**, **recepción desde la oficina** (sin app) y su corrección, **listado con rango, filtro por contenido y export**, **hoja de carga en bultos/sueltas por rubro**. En **Ecommerce**, Mercado Libre está muy avanzado en NinjaPOS (más que IM5 en facturación, posventa, Full), pero **Tienda Nube y WooCommerce no existen** y falta la capa transversal que IM5 resuelve bien: **solo lectura al conectar**, **panel "Para atender"**, **pantalla de Actividad con reintentos y "error resuelto"**, **comparación stock/precio POS vs tienda** y **crear productos desde publicaciones**.

## 1. Logística: Hoja de Ruta

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| La hoja agrupa remitos, no mueve stock ni emite comprobante | HECHO | `delivery_routes`, `route_stops`, `route_stop_dispatches` (`20261230100000_logistica_l2_flota.sql`, ADR-161); el stock lo mueve la entrega/remito | Ninguno |
| Numeración automática de hoja | HECHO | `delivery_routes.number` único por negocio | IM5 numera por CC (no aplica) |
| Transporte del maestro con patente y responsable | HECHO | `vehicles` (patente, carrier_name, carrier_cuit, capacidad, vencimientos VTV/seguro/SENASA), `driver_profiles` | Ninguno; NinjaPOS más completo |
| Turno de reparto (y filtrar remitos por turno) | EN ROADMAP | H146 "Quedan para después: ... ventanas horarias" | No hay fecha/turno pactado en `dispatches` |
| Modal de remitos disponibles con buscador | HECHO | `AddDispatchesModal.tsx` (buscar por cliente, dirección, localidad, número) | Sin contador "N seleccionados", "tildar todos" ni totales (importe, peso, bultos) para saber si entra en el camión |
| Un remito en una sola hoja viva; "No entregado" vuelve a disponibles | HECHO | índice único `route_stop_dispatches_open_key`; `_route_release` devuelve a Expedición con motivo; `max_attempts` | Ninguno |
| Estados por remito: Recibió conforme / No entregado / Con devolución | HECHO | `route_stops.status` (entregada, parcial, no_entregada, saltada); entrega parcial por producto, rotura a merma (L5, ADR-165) | Ninguno; NinjaPOS mejor (motivo, foto, firma, geo) |
| Recepción: no se graba con remitos "A entregar"; "Aplicar a todos" | PARCIAL | `route_close` marca lo no visitado como "saltada / No se visitó" automáticamente; los resultados se cargan desde `/reparto` | No hay recepción desde la oficina para el negocio cuyo chofer no usa la app (carga masiva de resultados al volver el camión) ni opción de exigir resultado explícito |
| Corregir la recepción de una hoja cerrada | FALTA | `route_close` devuelve `duplicate` si ya está cerrada; no hay reabrir/corregir | Corrección con permiso, sin volver a "pendiente" ni tocar lo que ya salió en otra hoja |
| Importe total / cobrado / pendiente de la hoja | EN ROADMAP | H149 "cobro contra entrega y rendición"; doc 45 §6 "rendición de cobros ... en L6"; `RouteSheetPrint` ya trae la firma "Recibió la rendición" | Sin importe a cobrar por parada ni cobrado. NinjaPOS debería hacerlo mejor que IM5: que el cobro genere recibo/caja (IM5 sólo guarda un número) |
| Editar con restricciones (con entregas, sólo fecha y detalle) | HECHO | guardas `route_not_editable` (4) en `delivery_route_save`/`route_add_dispatches` | Ninguno |
| Eliminar hoja libera remitos, con auditoría | HECHO | `route_cancel` + `audit_logs` | Sólo antes de salir (más estricto, correcto) |
| Listado: rango de fechas, filtro por contenido (remito, cliente, producto, estado), columnas de importes, export | FALTA | `RoutesPage.tsx` sólo navega por día; sin búsqueda ni export | Rango, buscador por contenido, export XLSX (`exportXlsx`), columnas total/cobrado/pendiente |
| 4 formatos de impresión (vertical, apaisada, detalle por remito, hoja de carga) | PARCIAL | `RouteSheetPrint.tsx`: un A4 apaisado con paradas, ítems, remito, hora y firma + planilla de carga | Sin importe por remito/columna "cobrado", sin variante vertical por cliente; no es editable en un diseñador de formatos |
| Hoja de carga por artículo agrupada por rubro en Bultos / U x bulto / Sueltas | PARCIAL | `loadSheet()` suma por producto y unidad; `product_packages.units_per_pack` existe | Agrupar por categoría y convertir a bultos + sueltas; alertar sueltas fraccionarias |
| Cantidad UME / peso total de la hoja | EN ROADMAP | H146 "Quedan para después: peso de productos para `capacity_kg`" | Totales de kg/UME en hoja y en la selección |
| Domicilio de entrega y zona en la grilla | HECHO | `customer_addresses`, `ship_to`, zonas por localidad (L1, ADR-157) | Ninguno |
| Remitos de varios centros de costo en una hoja | NO APLICA | NinjaPOS trabaja por sucursal; CC1/CC2 es práctica de IM4 | |
| Permisos por acción (ver, crear, recepcionar, imprimir, exportar) | HECHO | capacidades `logistics.*`, rol Repartidor (ADR-161) | Falta "exportar" porque no hay export |
| Sin conexión | HECHO | `/reparto` con cola offline idempotente (`delivery_events.id` generado en el teléfono) | IM5 no lo tiene; NinjaPOS mejor |
| Columnas configurables por usuario (ruedita) | MEJORA | No hay patrón genérico de columnas por usuario en grillas | Transversal (TX-3) |

## 2. Ecommerce: arquitectura común

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Mercado Libre | HECHO | H87/H141/H142, `ml_*` (12+ tablas), Edges `ml_api`, `ml_worker`, `ml_webhook`, `ml_oauth_*`, `ml_facturacion`, `ml_full`, `ml_gestor` | Falta app DevCenter y secrets para operar (bloqueo externo) |
| Tienda Nube | EN ROADMAP | F5 "[ ] Tienda Nube" (línea 287), H66, H84 | Nada de código (grep `tiendanube` sólo en `featureInfo.ts`/pagos) |
| WooCommerce | EN ROADMAP | H84 "Shopify/WooCommerce futuro" | Nada de código |
| Conector genérico (una pantalla por cuenta, solapas comunes) | EN ROADMAP | H84 "conectores configurables ... colas, dead-letter, replay, health por integración" | Hoy todo está acoplado a ML (`ml_sync_jobs`, `ml_accounts`); al sumar TN conviene extraer `channel_accounts`/`channel_jobs` |
| OAuth con renovación automática | HECHO | `ml_tokens.expires_at`, renovación con lock (H87) | |
| Webhooks sin datos que disparan relectura + barrido periódico | HECHO | `ml_notifications` (inbox idempotente), worker con GET, reconciliación `missed_feeds` | |
| Cola de tareas con backoff, 8 intentos, error definitivo | HECHO | `ml_sync_jobs` (`max_attempts` 8, `dead`, coalescing por `dedupe_key`) | |
| Estado "Error · resuelto" (falló pero luego corrió bien) | FALTA | estados `pending/running/done/error/dead/cancelled` | Marcar resueltos para no inflar el contador de errores |
| Pantalla Actividad (tareas + avisos, filtro por estado, Reintentar, export) para el dueño | FALTA | `ml_sync_jobs` no se lee en `app/`, `components/`, `modules/`; sólo salud de webhooks en internal (ADR-070) | Primera parada del dueño cuando "no se sincronizó" |
| Reintentar errores en lote por cuenta | FALTA | | Botón "Reintentar errores" |
| Panel Resumen "Para atender" por urgencia (sin acceso, no sincroniza >30 min, autorización por vencer, pagadas sin venta, errores, sin vincular) | PARCIAL | `MlSetupChecklist.tsx` (puesta en marcha); `ml_accounts.status reauth_required`, `last_sync_at` | Tablero diario con contadores y deep links a cada bandeja; aviso "no sincroniza" |
| Cuenta nace en solo lectura | FALTA | `ml_accounts.price_sync` y `stock_sync` default `true` | Riesgo: al conectar una cuenta con publicaciones vinculadas y stock POS sin cargar, se pisa el stock de ML con 0 |
| Pausar / reanudar cuenta, desconectar, eliminar | PARCIAL | switches `price_sync`/`stock_sync`; estado `disconnected`; pausa por publicación (`item_status`) | Pausa a nivel cuenta con verificación al reanudar |
| Cadencias (stock al grabar comprobante, órdenes al momento) | HECHO | triggers `ml_stock_movement_push`, `ml_warehouse_stock_push`, `ml_price_push`; cron `20261110400300` | |

## 3. Publicaciones

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Stock = Σ depósitos − stock de seguridad, con tope, nunca negativo | HECHO | `ml_location_map.reserve_qty`, `reserve_pct`, tope (H141), `greatest(...,0)` | |
| Precio = lista + ajuste % + redondeo | HECHO | `ml_accounts.price_list_id/markup/rounding`, `ml_listing_rules` por tipo, override por producto (ADR-132) | IM5 suma IVA porque sus listas son netas; NinjaPOS usa precio final (correcto) |
| Descuento de lista como precio promocional (regular tachado + oferta) | EN ROADMAP | H87 v3 "Central de promociones" | |
| No escribir donde ML no deja (Full, promo vigente, multiorigen) | HECHO | Full (ADR-142), `price_source = automation`, `selling_address` | Multi-origen en H87 v2 pendiente |
| Importar publicaciones de la tienda | HECHO | `importItems` en `MlItemsTab.tsx` | |
| Vinculación automática por SKU/GTIN con candidato único | HECHO | `20261208100000_ml_vincular_candidatos.sql`, sugerencias en `MlItemsTab` | |
| Columnas Stock tienda vs Stock POS, Precio tienda vs Precio POS, Sync (Pendiente / Al día / Error / Sin precio) | PARCIAL | `MlItem` trae `price`, `available_quantity`, `last_pushed_at`, `last_error` | No muestra lo que calcula el POS ni si hay diferencia; filtro "Pendientes de envío" |
| Sincronizar ahora (stock/precio, sólo cambios o todos) y por selección | HECHO | `ml_items_action` push_stock/push_price hasta 500 | |
| Crear productos del POS desde publicaciones (con categoría, IVA, precio neto) | FALTA | grep sin resultados | Onboarding del vendedor que ya vende en ML y tiene el POS vacío |
| Publicar desde el POS (categoría sugerida, atributos, tipo, condición, fotos, variantes) | HECHO | `MlPublishModal`, `MlQuickPublish` (H141), `/items/validate` | |
| Publicar en lote (por categoría o lista) | HECHO | H141 publicación rápida en lote | |
| Mapeo categoría del POS → categoría de la tienda | PARCIAL | `ml_category_memory`, predictor por título/GTIN | Árbol de categorías creable en la tienda (TN/Woo) |
| Atributos globales / precios mayoristas por rol (Woo) | EN ROADMAP | dentro de WooCommerce (H84) | |

## 4. Pedidos (órdenes)

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Orden → documento interno idempotente; carrito/pack = un documento | HECHO | orden o pack → UNA venta (H87), `pack_key` | NinjaPOS crea venta directa; IM5 pasa por presupuesto. Para TN conviene entrar como `sale_orders` con reserva (como `catalogo_pedidos`, ADR-130) |
| Cliente: por documento, alta automática con datos de facturación | HECHO | `20261212100000_ml_facturacion_ingest.sql` (busca por doc, inserta con condición IVA) | No excluye documentos de relleno (22222222) |
| Renglones sin vincular | HECHO | `unlinked_lines` + `needs_review` "la venta se registró sin descontar su stock" | Distinto criterio (IM5 bloquea); válido |
| Bandeja con filtros por estado, rango de fechas, búsqueda, "traer órdenes de N días", export, refresco | PARCIAL | `MlOrdersTab.tsx`: filtro por estado (pagadas, esperando pago, canceladas, revisar, facturar) | Sin rango, búsqueda por comprador/doc, export XLSX, ni "traer órdenes" manual |
| Envío como renglón de la factura | HECHO | H142 | |
| Recargo/interés como renglón | NO APLICA | sólo WooCommerce lo informa; ver Woo | |
| Factura automática (al pagar/despachar/a mano), letra automática, punto de venta, subir PDF | HECHO | H142, `ml_billing_settings`, `ml_fiscal_uploads` | NinjaPOS mejor (percepciones IIBB, cupones) |
| Factura sin CAE no se sube | HECHO | cola ARCA | |
| Etiqueta Mercado Envíos | HECHO | `MlShipmentsTab` ME2 PDF/ZPL | |
| Despacho y seguimiento ME1 / Flex | EN ROADMAP | H87 v2, H123 | |
| Cancelación: revierte stock, anula, NC si facturada | HECHO | reversión idempotente, NC por cancelación (H142) | |
| Reembolso parcial → NC parcial | EN ROADMAP | H142 "Deuda: devolución parcial con NC parcial automática" | |
| Asignar vendedor a órdenes en lote | FALTA | | Para comisiones por canal |
| Override por orden de depósito de origen / reserva | HECHO | sucursal y depósito por tipo de envío (ADR-145) | Override por orden no |
| Cuenta contable por renglón editable | NO APLICA | NinjaPOS asienta por mapeos automáticos (doc 31) | |
| Mail con la factura al comprador | NO APLICA (ML) | ML canaliza por su mensajería; para TN entra en su conector | |
| Destino Mostrador (CC2) sin IVA | NO APLICA | práctica IM4/La Jamonera | |

## 5. Clientes de la tienda (TN/Woo)

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Traer clientes registrados, vincular por CUIT/DNI o mail, alta sin duplicar, corregir datos, CABA = Capital Federal | FALTA | no hay conector TN/Woo; H84 no menciona clientes | Incluir en el conector de TN |

## 6. Cuentas y migración

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Varias cuentas por negocio, tarjeta con estado, última sync, autorización vence | PARCIAL | varias cuentas ML (H87), `last_sync_at`, `ml_tokens.expires_at` | Tarjeta con "envía / recibe: automático, a mano, apagado" |
| Woo con claves REST cifradas | EN ROADMAP | H84 | Patrón de secretos service_role ya existe (`shipping_secrets`, `payment_secrets`) |
| Migración desde IM4 | NO APLICA | específico de InfoManager | |

## 7. Bonus NinjaPOS que IM5 no tiene

Catálogo propio con pedidos (`/c/<slug>`, ADR-130), ML Full, reputación, reclamos y embudos (H141 B), percepciones IIBB en ML (H142), app del repartidor offline con evidencia, mapa y seguimiento (L2/L3), escaneo de carga (L5), carriers (F19, Andreani).

## Conteo

HECHO 33 · PARCIAL 9 · EN ROADMAP 11 · FALTA 9 · NO APLICA 6 (más 1 MEJORA transversal).
