# IM5 cap. 05 (Consultas, Tablero Gerencial, IA, Exportaciones impositivas, Ultu) vs NinjaSoft POS

Fuente: `ANDESMAR/docs/auditoria-im5/05-consultas-gerencia-ia.md` (800 lineas, leido completo).
Repo comparado: `ninja-soft-pos` (main, HEAD 30ca1316).
Metodo: grep en `supabase/migrations`, `supabase/functions`, `app/`, `components/`, `lib/`, `modules/`, `types/database.ts`, y lectura de `docs/02-roadmap.md`.

Estados: HECHO, PARCIAL, ROADMAP (pendiente en 02-roadmap), FALTA, NO APLICA. "MEJORA" marca donde NinjaPOS ya tiene la funcion pero IM5 la resuelve mejor.

## Hallazgos transversales

1. **El costo no se congela en la venta.** `sale_items` no tiene columna de costo (`types/database.ts`, columnas agregadas por migraciones: list_price, net_amount, iva_amount, etc., ninguna de costo). Todo margen gerencial (`branch_compare_report`, ADR-057) usa `products.cost` de hoy. El unico costo historico es el asiento de CMV perpetuo de contabilidad (`20261029100200_contabilidad_asientos.sql` l.431), que es OPTIONAL. IM5 tiene "Costo al facturar", "Costo de lista", "Costo ultima compra" y "Costo maestro hoy" lado a lado. Sin el snapshot no hay rentabilidad, GMROI ni margen por producto confiables.
2. **Ya existe un motor generico de consulta de solo lectura** (`ai_query` + whitelist `ai__query_catalog`, `20261011220000_ai_acceso_total_historial.sql`, SECURITY INVOKER, filtros, 2 group by, 6 agregados, 200 filas). Hoy solo lo usa la IA. Es la base natural para Consultas Dinamicas sin escribir otro backend.
3. **Reportes armados a mano**: `app/(app)/reportes/page.tsx` tiene 2064 lineas con secciones hardcodeadas. IM5 sirve ~40 listados clasicos con un componente y una tabla declarativa. Conviene migrar a definiciones.
4. **La IA no respeta la capacidad `reports.costs`** (`20261204100100_permisos_capacidades.sql` l.199). `ai_assistant/index.ts` no chequea capacidades, `aiQuery.ts` l.151 expone `cost` por defecto en products y las RPC `ai_*` corren con service_role por tenant (ignoran la RLS restrictiva por sucursal). IM5 filtra por tema, oculta costos y respeta sucursal/CC.
5. **Aging con tramos fijos** (`lib/account/aging.ts`: no vencido/1-30/31-60/61-90/90+, por vencimiento) duplicado en clientes, proveedores (`lib/purchases/aging.ts`) y plataforma. IM5 usa una sola configuracion de 4 tramos editable que alimenta cta. cte., tableros y semaforos.

## A. Infraestructura de consultas y grillas

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Motor de Consulta Dinamica (catalogo de campos tipado y agrupado, columnas, filtros por tipo, orden multinivel, `/campos` `/ejecutar` `/valores`) | PARCIAL | Backend `ai_query` + `ai__query_catalog` (ADR-039) solo para IA | Falta UI de armado y endpoint para el usuario; catalogo por area (ventas, stock, compras, clientes, proveedores, OP, comisiones) |
| Totalizar = GROUP BY implicito, Agrupar con subtotales, Desglosar el pie, sumatoria al pie | PARCIAL | `ai_query` agrega hasta 2 columnas | Falta en UI, subtotales por grupo y desglose |
| Listados guardados (privado/compartido con perfiles o usuarios/publico, copiar, renombrar, favoritos, abrir por URL) | PARCIAL | TX-5: presets de filtros por usuario (`users.settings.report_presets`, ADR-100) | Falta compartir con roles/usuarios, copiar, URL |
| Listados de fabrica inmutables (solo copiar) | FALTA | No hay | Plantillas de sistema de solo lectura |
| Columnas calculadas (formula, fichas, concatenar, fecha +/- dias, diferencia de fechas) | FALTA | No hay | Motor de expresiones seguro |
| Limite 1000 a 10000, "Sin limite" solo con permiso exportar, aviso de totales parciales | FALTA | `ai_query` corta en 200; reportes por RPC agregada | Tope visible y aviso de parcialidad |
| Embudo por columna y busqueda palabra por palabra sin acentos | FALTA | `lib/utils/search.ts` solo sanea `ilike`; sin `unaccent` en migraciones | Busqueda multi palabra sin acentos (tambien util en POS) |
| Exportar Excel/CSV/PDF/HTML/JSON, "Vista actual" vs "Resultado completo" escrito en el archivo | PARCIAL | TX-2: XLSX con diseno (`lib/utils/xlsx.ts`); `jspdf` instalado pero reportes sin PDF | PDF/imprimir de reportes, CSV, rotulo de alcance |
| Ruedita de columnas por usuario; tarea que oculta columna costo | PARCIAL | Capacidad `reports.costs` existe | Sin selector de columnas por grilla |
| Fijar columnas (por listado y PC) | FALTA | `components/ui/Table.tsx` sin columnas fijas | Menor |
| Consultas Clasicas: un componente + tabla declarativa (filtros, columnas, totales, cortes, color, semaforo) | FALTA (MEJORA arquitectonica) | `reportes/page.tsx` 2064 lineas a mano | Definir reportes por metadatos |
| Zoom a comprobante desde informe, con control de permiso | PARCIAL | Detalles por modal en ventas, compras, remitos | No uniforme en reportes |
| Reportes pesados en cola con aviso | ROADMAP | F17/H97 l.1200 | Pendiente |

## B. Consultas clasicas

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Listado de presupuestos (confirmado, facturado NF/FP/F, consumido por) | PARCIAL | `/presupuestos`, reporte "Presupuestos por emisor" con conversion (ADR-122) | Filtros por estado de facturacion parcial y por articulo |
| Facturas pendientes de remitir / remitos pendientes de facturar | PARCIAL | Entregas partidas y remitos (`20261202100200_remitos.sql`, ADR-136), expedicion | Reporte por item de pendiente de entregar; el circuito remito antes que factura no existe |
| Listado de recibos con detalle por forma de pago y retenciones | FALTA | Cobros de cta. cte. (`CollectModal`), estado de cuenta | Listado global de cobranzas por medio, usuario, caja |
| Stock > Movimientos (todos los articulos, tipo, origen, usuario, rango) | PARCIAL | `StockHistoryModal` + `products.movements` (ultimos 50 por producto, sin rango) | Reporte global con rango y filtros |
| Stock > Existencias a fecha con anterior, entradas/salidas por origen que cierran | FALTA | Stock actual por sucursal (`StoreStockPanel`) | Existencia a fecha de corte y desglose por origen con invariante |
| Stock > Por articulo (kardex con saldo acumulado) | PARCIAL | `StockHistoryModal` sin saldo corrido ni rango | Saldo acumulado y rango |
| Stock > Por deposito (columna por deposito) | PARCIAL | Stock por sucursal/deposito (F17/H94, `/depositos`) | Matriz articulo x deposito exportable a fecha |
| Comparativo de precios de hasta 4 listas | FALTA | Listas H100; no hay reporte comparativo | Reporte simple |
| Conciliacion y acreditacion de tarjetas | HECHO | ADR-044 `/reportes/conciliacion`, ADR-061, `/tesoreria/a-acreditar` | Acreditacion estimada marcada "*" |
| Cheques en cartera, historico, seguimiento, emitidos, rechazados | PARCIAL | `components/treasury/ChequesView.tsx` (en cartera, entregado, depositar, rechazar) | Seguimiento de un cheque por todos sus comprobantes; vencidos vigentes/no vigentes; recupero de rechazado |
| Disponibilidad de moneda extranjera con saldo corrido | PARCIAL | `treasury_accounts.currency` (`20261022100300_tesoreria.sql`), movimientos | Saldo corrido con saldo anterior por cuenta en moneda |
| Listado de ordenes de pago | HECHO | ADR-059 compras v2 | Mostrar retenciones en el listado |
| Comprobantes pendientes por cliente a fecha de corte | PARCIAL | `account_aging(p_as_of)` acepta fecha pero la UI pasa null (`/clientes/cuentas`) | Selector de fecha de corte y corte por cliente |
| Comprobantes pendientes por proveedor | HECHO | `lib/purchases/aging.ts` FIFO, `SupplierDetailModal` | Fecha de corte e imputacion vs comprobante |
| Analisis de compra por proveedor/articulo con prorrateo de no gravado y percepciones | FALTA | Facturas de proveedor con lineas (ADR-050) | Reporte por item con prorrateo |
| Saldos de proveedores-clientes (neto) | FALTA | `suppliers` sin vinculo a `customers` | Vinculo y saldo neto |
| Cta. cte. de intermediarios | NO APLICA | | Circuito de corredores especifico |
| 18 clasicas ocultas "godOnly" | NO APLICA | | Herencia IM4 |

## C. Tablero gerencial > Cobranzas

| Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|
| Total a cobrar desde cta. cte., saldo a favor aparte | HECHO | `/clientes/cuentas` KPIs (Total a cobrar, Vencido, Vence en 7 dias, Punitorios), `account_aging` | |
| Tramos de antiguedad configurables (4, sin huecos) usados por todo el sistema | FALTA (MEJORA) | Tramos fijos en `lib/account/aging.ts` y `lib/purchases/aging.ts` | Configuracion unica |
| Conciliacion bruto de comprobantes vs saldo ("deuda sin comprobante abierto") | FALTA (MEJORA) | Aging FIFO sobre movimientos | Cuadre explicito y aviso |
| DSO, antiguedad promedio, concentracion top 5, flecha vs mes anterior | FALTA | Solo en panel interno de plataforma (`BillingKpisView.tsx`) | Llevar las mismas formulas al tenant |
| Lista priorizada por mora con acciones (cobrar, promesa, WhatsApp, estado de cuenta) | HECHO (NinjaPOS mejor) | `/clientes/cuentas`, cta. cte. v2 ADR-037 | |
| Calendario de cobros por cuota con cobertura | PARCIAL | Cuotas en cta. cte. v2; flujo de fondos proyectado `CashFlowView.tsx` (ADR-158) | Vista calendario mensual y cobertura |
| Cobrado en el periodo por medio y cuenta contable (sin cancela anticipo/redondeo) | FALTA | Reporte de medios de pago es de ventas | Reporte de cobranzas de cta. cte. |
| Ranking de clientes con concentracion (top 5, 6-10, 11-20, cuantos hacen 80 % y 50 %) | PARCIAL | "Top clientes" (10) en reportes | Curva de concentracion y neto/con IVA |
| Ventas del periodo (vendido, ticket promedio, devoluciones) | HECHO | `sales_report`, `branch_compare_report` | |
| Calendario de ventas por dia con % vs promedio, mejor dia | PARCIAL | "Ventas por dia y hora" (heatmap) | Vista calendario |
| Filtros por vendedor y zona del cliente | FALTA | `customers` sin vendedor asignado ni zona (solo `group_id`) | Campos y filtros |

## D. Tablero gerencial > Pagos

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Deuda con proveedores y antiguedad | HECHO | `/compras/facturas` aging por proveedor | Tramos configurables |
| Calendario de pagos | PARCIAL | `CashFlowView` proyectado | Vista calendario |
| Con que se paga / pagado del periodo por medio | FALTA | OP con medios (ADR-059) | Reporte |
| Cheques a fecha propios vs terceros | PARCIAL | `ChequesView` (ownPending, inWallet) | Total al corte |
| Percepciones y retenciones del periodo | HECHO | `/compras/retenciones`, `/impuestos/sufridas` | |
| Posicion neta | PARCIAL | `PositionView` tesoreria | |
| Lupa del proveedor (impagos + cta. cte. con saldo corrido) | HECHO | `SupplierDetailModal` | |

## E. Indicadores, Mercaderia, Rentabilidad

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Rotacion, DSI, GMROI, inventario promedio por cortes | FALTA | Sin snapshots de stock | Snapshot mensual de inventario valorizado |
| Margen bruto por rubro con drill a articulos | PARCIAL / ROADMAP | Margen estimado con costo actual y cobertura en `branch_compare_report`; TX-5 l.1607 "falta margen general por producto" | Depende del costo congelado |
| Costo en la venta (costo al facturar, ultima compra, maestro) | FALTA | `sale_items` sin costo | Snapshot de costo por linea |
| Avisos de confiabilidad (cobertura de costo, stock negativo, dispersion) | PARCIAL (MEJORA) | `cost_coverage_pct` en comparativo de sucursales | Extender a todo reporte con margen |
| Ticket promedio y devoluciones sobre ventas | HECHO | reportes y comparativo | |
| Que sale del deposito (mas/menos salida, unidades, N configurable) | PARCIAL | "Top productos" (10) | Menos vendidos y N configurable |
| Que esta parado (stock sin ventas en el periodo, valorizado, dias sin salida) | ROADMAP | F14/H67 l.976 "productos muertos" | Pendiente |
| Rentabilidad: ingresos - CMV - gastos = resultado; compras de mercaderia aparte | PARCIAL | Estado de resultados contable (`/contabilidad/libros`, ADR-066, OPTIONAL `contabilidad`) | Vista gerencial sin contabilidad, mes a mes, "quien se lleva el gasto", comparacion pareja |

## F. Mapa de clientes y proveedores

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Mapa de calor y puntos de clientes/proveedores, filtros por movimiento | FALTA | Base: `customer_addresses` lat/lng, `geocode_cache`, Edge `geo`, `components/geo/leaflet.ts`, `RouteMap` (`20261226100000_logistica_l1_direcciones.sql`) | Vista de clientes en mapa |
| "Sin ubicacion" y geocodificacion masiva a 1/s con confirmacion | FALTA | docs/45 l.411: Nominatim prohibe geocodificacion masiva | Usar proveedor que la permita |

## G. Tableros IA y Preguntar

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Preguntar en castellano, solo lectura, vistas curadas | HECHO | H88, `ai_assistant`, `ai_query` whitelist, RLS por usuario (ADR-039) | |
| Permisos por tema y "ocultar costo"; alcance de sucursal | FALTA (MEJORA seguridad) | Sin chequeo de `reports.costs`; RPC `ai_*` service_role por tenant | Respetar capacidades y sucursales |
| Mismos numeros que las pantallas (delegar a procedimientos oficiales) | PARCIAL (MEJORA) | RPC `ai_*` propias (`20260608630000_ai_tools.sql`) | Reusar `account_aging`, `sales_report` |
| Respuesta como tablero (Indicador, Lineas, Barras, Torta, Tabla) | FALTA | Chat markdown (`ChatMarkdown.tsx`); ECharts disponible | Paneles graficos |
| Tableros guardados re-ejecutables sin IA (sin gastar cupo), compartir | FALTA | Historial de chat 15 dias | Receta guardada |
| Ajustar tablero, hilo de versiones | FALTA | | |
| Periodo fijado que manda sobre la pregunta | FALTA | | |
| Adjuntos como referencia, dictado, escuchar | FALTA | | Nicho |
| Exportar tablero PDF/Excel | FALTA | | |
| Envio programado por mail con link revocable de 7 dias | FALTA | Infra de mail (`send_email`, Resend) | Programador de envios |
| Convertir en alerta / panel de alertas configurable | PARCIAL | `NotificationBell`, alertas de margen (ADR-092), contracargos, SLA KDS | Motor de alertas definido por el usuario |
| Cupo mensual de IA | HECHO | `ai_usage` (H88) | |
| Clave propia del cliente (BYOK) | NO APLICA | La key es de plataforma (`platform_secrets`) | Modelo addon |
| Export/import firmado `.im5tablero` | NO APLICA | | En SaaS se comparte dentro del tenant |

## H. Exportaciones impositivas

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Libro IVA Digital ventas/compras (CBTE + ALICUOTAS) | PARCIAL / ROADMAP | ADR-076, `components/tax/LibroIvaDigital.tsx`; H108 l.1370 | Prorrateo, COMPRAS_IMPORTACIONES, validar con contador |
| Revision previa antes de descargar | HECHO (NinjaPOS mejor) | Revisa el mes y bloquea la descarga con errores | Falta vista TXT cruda y totales al pie |
| SICORE retenciones practicadas | HECHO | `lib/tax/sicore.ts` (ADR-079) | Punto decimal ya cubierto por layout |
| SICORE percepciones practicadas | ROADMAP | H108 l.1371 | |
| SICORE retenciones sujeto (padron de retenidos) | FALTA | | Archivo de sujetos |
| IIBB practicadas por provincia (ARBA, AGIP, Salta, Jujuy, Tucuman, San Luis, Mendoza, CABA) | PARCIAL / ROADMAP | `arbaLine` retenciones; H108 l.1372 (ARBA, e-ARCIBA, SIFERE, SIRCAR) y l.1373 exportador por plantilla | Percepciones por provincia |
| SIFERE sufridas, IVA sufrida, Convenio Multilateral | ROADMAP | H108 l.1372; sufridas registradas (ADR-095) | Archivos |
| TEM Tucuman | NO APLICA | | Municipal nicho; cubrir con exportador por plantilla |
| No bajar archivo vacio (equivale a presentar en cero) | PARCIAL (MEJORA) | Retenciones avisa "No hay retenciones en el mes" | Regla uniforme en todos los exportadores |
| Carpeta de exportacion (File System Access API) | NO APLICA | | Descarga normal alcanza |

## I. Inicio, comisiones, consolidado, otros

| Capacidad IM5 | Estado | Evidencia | Gap |
|---|---|---|---|
| Inicio con pantalla favorita de arranque, manual buscable embebido | PARCIAL | Escuela F15, ayuda contextual, `dashboard` | Pantalla de inicio configurable |
| Comisiones sobre lo COBRADO sin IVA con % del vendedor a la fecha de la factura | PARCIAL (MEJORA) | H39: comision sobre la venta (`sales.professional_id`, `staff_productivity`) | Base cobrado neto y % historico |
| Vendedor de item vs de factura; ventas por vendedor con lista | PARCIAL | Vendedor en pedidos (l.688), productividad | Vendedor por linea |
| Consolidado de sucursales | HECHO | F17/H97, ADR-057 | |
| Multi empresa (varios CUIT) consolidado | ROADMAP | F17/H98 l.1126 razon social y CUIT por sucursal | |
| Color por centro de costo CC1/CC2 | NO APLICA | | Circuito propio de IM |
| Pesificacion con cotizacion del comprobante y aviso de excluidos | PARCIAL | Compras en USD con TC por comprobante (aging en pesos); ventas solo ARS | Aviso de comprobantes sin cotizacion cuando haya venta en moneda |
| Sincronizacion con Ultu (productores, liquidaciones) | NO APLICA | | Integracion propia de un cliente IM |

## Conteo

HECHO 15 · PARCIAL 33 · ROADMAP 5 · FALTA 30 · NO APLICA 8 (filas de las tablas; "PARCIAL / ROADMAP" cuenta como PARCIAL).
