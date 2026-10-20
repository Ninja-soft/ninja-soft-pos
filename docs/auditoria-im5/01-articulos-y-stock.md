# IM5 cap. 01 Artículos y Stock vs NinjaSoft POS

Fuente: `ANDESMAR/docs/auditoria-im5/01-articulos-y-stock.md`. Comparado contra `pos-deploy` (main, commit 30ca1316). Verificado con grep en `supabase/migrations`, `components/`, `lib/`, `app/` y `docs/02-roadmap.md`.

Estados: HECHO, PARCIAL, EN ROADMAP (pendiente), FALTA, NO APLICA.

## 1. Maestro de artículos (ABM)

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Baja lógica / inhabilitar, no borrar con movimientos | HECHO | `products.deleted_at`, `is_active` (`20260530130000_catalog_products.sql`, `ProductFormModal.tsx`) | - |
| Unicidad de código de barras y PLU | HECHO | índices `products_tenant_barcode_idx`, `products_tenant_plu_idx` (`20260608370000_product_plu.sql`) | Mejora: PLU "42" = "000042" (normalizar ceros); PLU fijo de 6 dígitos vs 4 a 6 de la balanza |
| Varios códigos de barras por artículo (principal + alternativos, por proveedor) | FALTA | sólo `products.barcode` y barcode por variante | Tabla de códigos alternativos, búsqueda por todos, código del fabricante buscable |
| Copiar / duplicar artículo | FALTA | sin acción de copia en `components/products` | Botón Duplicar con "(COPIA)" |
| Alta rápida en serie (grabar y continuar) | PARCIAL | import XLSX (`ImportProductsModal`, ADR-078) y alta completa | Ventana corta "grabar y seguir" |
| Imagen con cámara del dispositivo | PARCIAL | `ProductImages.tsx` sube archivo; cámara sólo en escáner/DNI | Opción "tomar foto" |
| Artículo de Compra / Venta / Ambos (insumo no vendible) | FALTA | no hay columna en `products` | Flag para ocultar insumos del POS y del catálogo |
| Concepto producto/servicio (servicio sin stock) | HECHO | `products.is_service`, `track_stock` | - |
| Pesable | HECHO | `unit='kg'` + balanza (ADR-063) | - |
| Seriado | HECHO | `product_serials`, `is_serialized` (`20260531140000`) | ver §5 |
| No bonificable (sin descuento manual, sin excepción de supervisor; promo sí) | FALTA | sin columna; `create_sale` sólo aplica tope por rol | Flag por producto validado en `create_sale` |
| % comisión del vendedor por artículo | HECHO | `products.commission_pct` (`20260608550000_commissions_tips`) | - |
| Unidades de venta con coeficiente (bulto/caja), excluyente con pesable | EN ROADMAP | H100 l.1298 "falta la unidad de venta por bulto o caja"; compra sí: `supplier_products.units_per_purchase` | - |
| Equivalencias de unidades de medida | EN ROADMAP | misma línea H100 l.1298 | - |
| Cuentas contables (compra, venta, CMV) por artículo | PARCIAL | mapeo global CMV y stock (H109, ADR-066) | Mapeo por categoría/artículo opcional |
| Nomenclador NCM por artículo | FALTA | NCM sólo por línea en hoja de importación (H102, ADR-050) | Campo NCM en ficha, reutilizable en importación y factura E |
| Moneda extranjera (costo/venta USD) | HECHO | `cost_usd`, `cost_fx_*` (ADR-140) | - |
| Precio con o sin IVA: el que se escribe manda | HECHO | ADR-068 lista con o sin IVA, reparto por resto mayor | - |
| Rentabilidad editable y aviso bajo costo | HECHO | `markup_pct`, `min_price`, `lib/prices/costing.ts`, `QuickPriceEditor` | - |
| Precios por lista desde la ficha con semáforo | HECHO | `ProductPricesPanel.tsx` | - |
| Punto de reposición / mín / máx por depósito, ubicación | HECHO | `product_stock(min_qty,max_qty,location)` H94; reposición del salón H33 | - |
| Características (talle, color, etc.) | HECHO | `product_attributes`, `AttributesEditor.tsx` | - |
| Ocultar costo por permiso | HECHO | capacidades `stock.valuation`, `reports.costs`, `products.price` (`lib/permissions/capabilities.ts`) | - |
| Búsqueda, filtros y exportación del listado | HECHO | `app/(app)/productos/page.tsx` (xlsx) | - |
| Alta provisoria sin conexión | FALTA | offline sólo vende (ADR-077) | P3 |
| Reemplazo de caracteres especiales en descripción | NO APLICA | herencia de impresoras fiscales IM4 | - |

## 2. Rubros y depósitos

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Rubros y subrubros | HECHO | `categories.parent_id` (árbol, `CategoryTreePicker`) | - |
| Ícono/color/foto del rubro para la grilla del POS | FALTA | `categories` sin icono ni color | P3 |
| Depósitos con tipo, tránsito, origen/destino | HECHO | `warehouses`, `warehouse_move_*` (ADR-085), tránsito como estado | - |
| Bloquear cambio de tipo con pendientes | NO APLICA | el tránsito es estado del movimiento, no tipo de depósito | - |

## 3. Precios

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Listas sobre compra / venta / base propia | HECHO (mejor) | `price_lists` derivadas de costo o de otra lista resueltas en vivo (ADR-058, `lib/prices/resolve.ts`) | IM5 necesita "recalcular"; NinjaPOS no se desactualiza |
| Atributos de costo (flete, bonificación, coeficientes) | HECHO | `products.cost_extras`, `final_cost` (ADR-140) | - |
| % masivo varias listas con redondeo | HECHO | `price_bulk_*`, asistente v2 (ADR-058, ADR-140) | - |
| Importar Excel a lista | HECHO | `import_*` (ADR-078) | - |
| Copiar lista / copiar desde otra lista | PARCIAL | listas derivadas de otra lista | Copia física (cabecera + detalle) |
| Historial y deshacer | HECHO | `product_price_history`, deshacer de lotes (ADR-056, ADR-058, ADR-151) | - |
| Modif. masiva de la ficha (costo manteniendo margen o venta) | HECHO | `BulkUpdateWizard.tsx` | Mejora: filtro "margen mayor/menor a" para excluir márgenes rotos |
| Revisar costos: regla de costo + aceptar en lote | PARCIAL | `purchase_settings.cost_basis` (last/average/replacement), `sync_product_cost`, `MarginAlertsPanel` (ADR-092) | Bandeja "costos nuevos" con precio de venta propuesto y aceptar marcados; reglas extra (promedio de proveedores vigentes, de últimas N compras, ponderado N días) |
| Matriz precios por proveedor (más barato, antigüedad) | FALTA | `supplier_products.last_cost/list_cost` existe, sin pantalla comparativa | Reporte comparativo |
| Bloqueo / desbloqueo de listas | NO APLICA | coexistencia IM4/IM5 | - |
| Recuperar copia nocturna de listas | NO APLICA | cubierto por historial + deshacer y backups | - |
| Promociones combos, por cantidad, tramos, días, lista, empresa | HECHO | motor ADR-074 | - |
| Precios por cantidad impresos en etiqueta | FALTA | Etiquetas PRO sin bloque de tramos | P3 |

## 4. Mostrador y etiquetas

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Consulta rápida / verificador de precios (scanner, cámara, lista con candado, promo, offline) | FALTA | sin ruta; sólo ficha pública QR `/p/[slug]/[code]` | Modo kiosco de consulta |
| Diseño de etiquetas con plantillas | HECHO | `components/labels/LabelStudio.tsx`, `label_templates` (ADR-148) | Expresiones calculadas: no hace falta |
| Impresión rollo/hoja, saltear posiciones, cola de precios cambiados | HECHO | ADR-148, cola por sucursal (ADR-058) | - |
| Imprimir etiqueta al capturar peso (peso propio sin balanza etiquetadora) | FALTA | - | Etiqueta pesable desde balanza de la caja |
| Stock por depósito del artículo en pantalla | HECHO | `StoreStockPanel`, `warehouse_stock_overview` | - |

## 5. Seriados y variantes

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Carga de series y lote en la recepción de compra | PARCIAL | series se cargan en la ficha (`SerialsEditor`); compras sin serie | Pedir serie al recibir |
| Seguimiento por serie (entradas/salidas, estado) | PARCIAL | `SerialWarrantyPanel` (garantías por serie, ADR-092) | Historia de movimientos por serie |
| Generación de variaciones | HECHO (mejor) | `VariantsEditor` matriz, SKU auto (H10) | Mejora: hoy máx 2 ejes |

## 6. Producción

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Recetas Combinar con insumos de stock | PARCIAL | `product_recipes` con insumo en texto libre; `register_production` sólo suma; kits sí descuentan (`product_kit_components`) | H50 l.859 descuento de insumos |
| Recetas Fraccionar (despiece) con % participación, merma, rango, genérica | EN ROADMAP | backlog l.1732 "Producción y recetas avanzadas" | Sin diseño |
| Transformaciones (baja insumos, sube productos, anula con contramovimiento) | EN ROADMAP | backlog l.1732 | - |
| Costo de producción, prorrateo por precio de venta, trasladar costos, costos adicionales | EN ROADMAP | backlog l.1732 | - |

## 7. Balanzas

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Lectura de peso | HECHO | `lib/hardware/scale/*` (ADR-063), presets sin validar | Validar con equipos |
| Envío de precios/PLU a balanza etiquetadora (Kretz Report, Systel Cuora, Cuora Neo) con relectura e historial | FALTA | ni código ni roadmap (H24 sólo lectura) | Agente local + drivers |
| Prefijos de balanza (reglas múltiples, máscara C/P/U/I/K, alcance, probar código) | PARCIAL | `lib/barcode/scaleLabel.ts`: un solo formato por negocio/sucursal, precio o peso | Varias reglas, unidades, alcance por balanza, "probar un código" |
| Control de tickets de balanza vs facturado | FALTA | - | P3 |

## 8. Stock

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Pedido interno con autorización por renglón | EN ROADMAP | H95 l.1183 "falta solicitud de transferencia desde la sucursal que necesita"; traslados con `pending_approval` | - |
| Interdepósito con tránsito, recepción y remito numerado | HECHO | `stock_transfers` (ADR-046), `warehouse_move_*` (ADR-085) | - |
| Entrada/salida manual | HECHO (mejor) | `stock_adjustments` con motivo, foto, aprobación por umbral (ADR-137) | - |
| Movimientos con origen; sólo manuales editables | HECHO | `stock_movements.reason/reference_id`, `MovementsTab` | - |
| Costo congelado en cada movimiento | PARCIAL | `unit_cost` en ajustes y traslados; `stock_movements` sin costo | Costo en todo movimiento (ventas, producción) |
| Stock a fecha / movimiento con fecha pasada | FALTA | - | Consulta de stock a una fecha |
| Ajuste masivo (inventario) multiusuario en vivo | PARCIAL | planilla Excel + conteo cíclico ABC (`CountTab`, ADR-092, ADR-137) | Sesión de conteo con scanner, parciales por usuario sumados, "total no diferencia" |
| Control de stock por proveedor | NO APLICA | prototipo interno de InfoManager | - |

## Conteo

HECHO 31 · PARCIAL 11 · EN ROADMAP 6 · FALTA 14 · NO APLICA 5 (total 67).
