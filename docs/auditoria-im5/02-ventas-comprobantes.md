# IM5 cap. 02 (Ventas: comprobantes y procesos masivos) vs NinjaSoft POS

Fuente: `ANDESMAR/docs/auditoria-im5/02-ventas-comprobantes.md` (leído completo, 910 líneas). Repo comparado: `pos-deploy` main (commit 30ca1316). Verificado con grep en `supabase/migrations`, `supabase/functions`, `components`, `app`, `lib`, `docs/02-roadmap.md` y `docs/17-decision-log.md`.

Diferencia de modelo a tener presente: IM5 es un ERP de escritorio donde la factura genera deuda, el remito mueve mercadería y el recibo registra la plata, en tres comprobantes separados. NinjaPOS es un POS donde la venta (`create_sale`) hace las tres cosas en una transacción y los demás documentos (remito, NC, recibo de cta. cte.) cuelgan de ella. Varias brechas vienen de ahí: los circuitos B2B "entrego hoy, facturo después" o "facturo varias entregas juntas".

Estados: HECHO · PARCIAL · EN ROADMAP · FALTA · NO APLICA.

## A. Arquitectura y circuito

| # | Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|---|
| 1 | Una pantalla declarativa para los diez comprobantes (definición por tipo con herencia) | PARCIAL | El render sí está unificado: motor de comprobantes único (ADR-112, ADR-119; `components/invoices/InvoiceDocument.tsx`), que también usan presupuesto (`QuoteDocument.tsx`) y remito (`RemitoDocument.tsx`) | La carga y la edición siguen separadas por entidad (sales, quotes, remitos, returns). Es una mejora de arquitectura, no algo que vea el cliente |
| 2 | Vínculos y trazabilidad entre comprobantes | HECHO | `quote_link_sale`, `returns.sale_id`, `fiscal_documents.assoc_document_id`, `dispatch_items` y remitos por entrega (ADR-136), ficha del cliente 360 con comprobantes (ADR-169) | No hay una solapa "Trazabilidad" única por comprobante |
| 3 | Saldos por renglón entre origen y derivados (pendiente de facturar, remitir o acreditar) | PARCIAL | Lo devuelto se controla por renglón en las devoluciones; las entregas partidas suman lo vendido (`delivery_qty_mismatch`, ADR-136) | Falta en presupuesto a venta (se convierte todo junto) y en remito a factura (no existe) |
| 4 | Remito antes de la factura y factura de varios remitos (camino único) | FALTA | El remito R sólo nace de una venta ya cobrada o facturada (`remito_issue` sobre la entrega, ADR-136) | Falta el circuito de distribuidora: entregar con remito, que la mercadería baje y la deuda quede pendiente, y después facturar uno o varios remitos del cliente |

## B. Presupuestos

| # | Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|---|
| 5 | Presupuesto numerado, con validez, estados y envío | HECHO (mejor que IM5) | `quotes`, `quote_save`, `quote_share`, link público de aceptación, revisiones, email con PDF, sin vencimiento opcional, reporte por emisor (ADR-122, ADR-123) | Ninguno. IM5 no tiene ni link de aceptación ni revisiones |
| 6 | Presupuesto confirmado o no confirmado | HECHO | Estados `draft, sent, accepted, rejected, converted` | |
| 7 | Generar factura o remito desde el presupuesto, también en partes | PARCIAL | `/pos?quote=` carga el carrito y `quote_link_sale` marca el presupuesto convertido | No se puede convertir en partes (pendiente por renglón) ni combinar varios presupuestos del mismo cliente en una venta |
| 8 | Actualizar precios al convertir | HECHO (mejor que IM5) | El precio acordado viaja como cambio de precio con motivo y PIN según la política (ADR-056, ADR-122 §6) | |
| 9 | Presupuesto que mueve stock a un depósito de reserva | FALTA | Las reservas de stock existen (ADR-091, H32) pero no se pueden crear desde el presupuesto | Opción "reservar al aceptar", con vencimiento |
| 10 | Rentabilidad del presupuesto (costo, margen por artículo, aviso si es negativo) | FALTA | Ya existe el costo final y la utilidad del producto (ADR-140) | Falta una vista de margen en el presupuesto y en la venta, oculta por permiso |
| 11 | Simulación de pago en el presupuesto (cuotas y recargos, sin cobrar) | FALTA | El motor de recargos y cuotas existe (H59) | Falta una solapa "Formas de pago" que muestre las cuotas con su recargo en el PDF |
| 12 | Modo app del vendedor de calle (sólo sus clientes y sus presupuestos, cámara, tarjetas) | PARCIAL | El POS es mobile-first y el vendedor puede armar Pedido o Presupuesto (H32, ADR-122) | Falta la cartera por vendedor ("ver sólo mis clientes" y "sólo mis comprobantes") y la toma de pedidos offline. Relacionado con roadmap l.1079 [~] |

## C. Pedidos de venta

| # | Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|---|
| 13 | Pedido que compromete stock | PARCIAL | Pedido de salón con reserva por minutos (`sale_orders`, `stock_reservations`, ADR-129) | Es un pedido de mostrador. Falta el pedido B2B con fecha de entrega por renglón y vigencia en días |
| 14 | Mapa de fechas: disponible = stock − comprometido + OC futuras | PARCIAL | El disponible ya resta lo reservado (ADR-091) | No proyecta los ingresos por órdenes de compra |
| 15 | Renglones sin stock que generan una orden de compra, con estado "A revisar" o postergado | FALTA | Compras v1/v2 tienen OC (ADR-050, ADR-059) pero no se pueden armar desde una venta o un pedido | Venta bajo pedido (backorder) |

## D. Remitos

| # | Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|---|
| 16 | Remito numerado por PV con bultos, transporte, precios ocultables y PDF | HECHO | `remitos`, `remito_points`, `remito_issue`, `remito_void`, COT cargado a mano con aviso por umbral (ADR-136) | |
| 17 | COT automático, remito electrónico o con CAI | EN ROADMAP | l.696 [~] (falta COT por ARBA o AGIP y remito CAI o electrónico); F22, criterio l.1553 | |
| 18 | Remito "No facturable" (muestra, préstamo, consignación) | FALTA | | Remito suelto sin venta, que baje el stock con un motivo |

## E. Facturas

| # | Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|---|
| 19 | Letra según el emisor y el cliente | HECHO | `cbte_letter_infer` e `inferLetter` (ADR-068, ADR-125, ADR-133) | |
| 20 | CAE por web service, número 0 hasta el CAE, cola y reintentos | HECHO | `fiscal_documents`, `arca_claim`, `arca_apply_result`, Edge `arca_wsfe` (ADR-072) | |
| 21 | Ventana de fechas de ARCA (±5 o ±10 días) y "cambiar fecha" | HECHO (mejor que IM5) | La fecha se ajusta sola dentro de la ventana y nunca queda antes del último autorizado (ADR-072 §3) | |
| 22 | Facturar después una venta que salió con ticket | HECHO | `arca_enqueue_sale_manual` y la opción factura o sólo ticket en cada venta (ADR-155) | |
| 23 | Una factura con varios remitos o ventas del cliente (factura resumen) | FALTA | | Facturar en una sola factura varios tickets no fiscales o remitos pendientes de un cliente |
| 24 | Concepto servicios con período y vencimiento del pago | HECHO | ADR-116, `create_sale` con `p_service` | |
| 25 | Moneda extranjera (MonId y MonCotiz) | EN ROADMAP | H107 l.1363 [~] y H100 l.1297 [~] (hoy `MonId` es siempre PES) | |
| 26 | FCE MiPyME (CBU, SCA o ADC, aceptación o rechazo) | EN ROADMAP | H107 l.1364 [ ] | |
| 27 | Factura E de exportación | EN ROADMAP | H107 l.1365 [ ] | |
| 28 | Comprobante en línea (CAE sacado en el portal de ARCA y cargado a mano) | FALTA | Ningún grep de `cae_manual` ni de "en línea" | Cargar a mano el CAE y el número de un comprobante emitido fuera del sistema |
| 29 | Columna de estado ARCA en el listado (pendiente, enviada, error) y filtro "Sin CAE" | PARCIAL | `ArcaMonitor.tsx`, `FiscalStatus.tsx`, reproceso `arca_document_retry` | El listado `/ventas` filtra por estado, medio, entrega, sucursal y canal, pero no por estado fiscal, letra ni tipo de comprobante |
| 30 | Cobro al grabar, botonera de cobro y cobro mixto | HECHO | Hoja de cobro única (ADR-036, ADR-042) | |
| 31 | Recargo de tarjeta como renglón | HECHO | H59 (recargos por medio, marca y proveedor) | |
| 32 | Tope del consumidor final sin identificar | HECHO | Parámetro con vigencia (ADR-068, ADR-105) | |
| 33 | Monto máximo por medio (efectivo o tarjeta) por factura | FALTA | No hay `max_cash` ni equivalente | Tope configurable por medio de pago |
| 34 | Control del disponible de cta. cte. y aviso o bloqueo del cliente moroso | HECHO | Cuenta corriente v2: límite, bloqueo por mora y PIN de supervisor (ADR-037) | |
| 35 | Copiar comprobante | PARCIAL | `quote_duplicate` | No se puede repetir o copiar una venta |
| 36 | Fecha valor (emitir con fecha pasada ±N días, con permiso) | FALTA | La fecha de la venta es la del servidor | Fecha retroactiva acotada, con permiso y auditoría |
| 37 | Seriados obligatorios | HECHO | `product_serials`, `20260531150000_create_sale_serials.sql` | |
| 38 | Unidad de venta (bulto × unidades) y unidad equivalente | FALTA | No hay columnas de presentación ni de pack en `products` del POS | Vender por caja o bulto y descontar unidades. Lo usan mayoristas y distribuidoras |
| 39 | Ítem libre | HECHO | Flag operativo de venta libre | |
| 40 | Vendedor por comprobante | HECHO | `sales.professional_id` y comisiones (H39) | |
| 41 | Vendedor por renglón | FALTA | | |
| 42 | Precio e IVA protegidos y validados contra el maestro | HECHO (mejor que IM5) | Precio autoritativo en `create_sale`, que rechaza un precio distinto con `price_mismatch` (ADR-056) | |
| 43 | Descuento sobre el tope con autorización de supervisor | HECHO | `security_settings` con PIN por umbral (l.1243), descuento máximo por rol (H30) | |
| 44 | Vistas configurables por usuario (columnas, campos, botones, plantillas por rol) | PARCIAL | Presets `pos_layout` (ADR-036) y menú personalizable (ADR-134) | Faltan columnas configurables en los listados y plantillas de vista por rol |
| 45 | Filtros por contenido (artículo en un renglón, detalle, cuenta) y en recibos (medio, banco) | FALTA | | Buscar ventas que incluyan un producto |
| 46 | Listado con conteo, tope y exportación | HECHO | Paginación (`useSalesPaged`) y XLSX (TX-2) | |

## F. Recibos y cobranza

| # | Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|---|
| 47 | Recibo correlativo con imputación FIFO o elegida, pago parcial y a cuenta | HECHO | `account_collect` y `CollectModal.tsx` (recibo #, imputación y saldo a favor), ADR-037 | |
| 48 | Varios medios en un mismo recibo | HECHO | `account_collect_multi` y `CollectModal` con líneas que cuadran y redondeo (H160, ADR-179) | |
| 49 | Cheques y e-cheqs del cliente en el cobro (banco, número, fechas, tipo, control de repetidos) | HECHO | Medios `cheque` y `echeq` en el POS y en el recibo, que dan de alta el cheque en cartera (H160, ADR-179) | El aviso de repetido sigue en el alta manual |
| 50 | Retenciones sufridas cargadas en el recibo (IIBB, Ganancias, IVA, SUSS) | HECHO | Línea de retención del recibo con `tax_suffered_register` (H160, ADR-179) | |
| 51 | Anticipos y saldo a favor | HECHO | `account_unapplied_credits`, vales (`20260531280000_store_credit_payment.sql`) | |
| 52 | Seña parcial | EN ROADMAP | H30 l.650 [ ] | |
| 53 | Recibo en dos monedas y NC/ND automáticas por diferencia de cotización | FALTA | Depende de la moneda extranjera (H107) | |

## G. Notas de crédito y débito, cambios

| # | Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|---|
| 54 | NC por devolución con reingreso de stock | HECHO (mejor que IM5) | `arca_enqueue_return` y el wizard de devolución con destino de stock y motivo (H29). IM5 deja el stock mal sin avisar si se elige el modo equivocado | |
| 55 | NC por anulación | HECHO | `arca_enqueue_void_nc` | |
| 56 | La NC no supera lo facturado por renglón | HECHO | Devolución por renglón contra la venta | |
| 57 | La NC no va a ARCA hasta que su factura tenga CAE | HECHO | `arca_claim` exige el asociado `aprobado` (`20261101100100_arca_facturacion.sql` l.1165) | |
| 58 | NC financiera (bonificación o error de importe sin mercadería, con o sin comprobante asociado, por período) | FALTA | `fiscal_documents.origin` sólo admite `sale, return, void` | NC por importe libre o por % sobre la factura, con permiso |
| 59 | ND (recargo por mora, financiera, diferencia) | EN ROADMAP | H107 l.1363 y F16 l.1066 ("Falta nota de débito"); el código ya mapea los tipos 2, 7, 12 y 52 en `arca_cbte_tipo` | Hoy los punitorios de la cta. cte. del comercio no generan una ND fiscal |
| 60 | Recibo de devolución "espejo" (por el mismo medio) | HECHO | Reintegro por Mercado Pago (ADR-067), efectivo o vale | |
| 61 | Límite de días para devolver o hacer la NC | HECHO | Plazo de devolución (`20260608240000_returns_overhaul.sql`) | |
| 62 | Reversa proporcional de las percepciones en la NC | EN ROADMAP | H105 l.1344 [~] | |
| 63 | Cambio de artículos con la diferencia documentada | HECHO | `exchange_sale`, `ExchangeFlow.tsx` | |

## H. Seguridad, edición y contingencia

| # | Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|---|
| 64 | Bloqueos por estado (con CAE, cobrada, con derivado) | HECHO | Venta inmutable: se anula con NC, con baja lógica y auditoría | |
| 65 | Permisos por pantalla × acción, con "propios" y "ver sólo los propios" | PARCIAL | Capacidades y roles a medida (ADR-138); el cajero borra sólo sus presupuestos (ADR-122) | Falta "ver sólo mis ventas y mis clientes" como restricción del rol |
| 66 | Auditoría de borrados | HECHO | `audit_logs` inmutable (ADR-083, ADR-160) | |
| 67 | Corrección de un comprobante cortado por el web service | HECHO | Al recuperar, la cola consulta el comprobante en ARCA antes de reintentar y nunca duplica el número (ADR-072 §2) | |
| 68 | CAEA | HECHO | ADR-072 §10 | El CAEA por cada PV queda en roadmap H98 l.1205 [~] |

## I. Procesos masivos

| # | Capacidad IM5 | Estado | Evidencia NinjaPOS | Gap |
|---|---|---|---|---|
| 69 | Facturación periódica (abonos tomados de la ficha del cliente, por lote, sin facturar dos veces) | FALTA | Sólo hay recurrencia SaaS (plataforma) y packs de sesiones (H41) | Relacionado con H41 l.782 [ ] (membresía recurrente) |
| 70 | Comprobantes en lote (presupuesto a remito, remito a factura, factura a recibo) con informe de errores | FALTA | | |
| 71 | Envío masivo por email y WhatsApp con historial | FALTA | El envío uno por uno está hecho (`send_receipt_email`, l.350) | Envío en tanda, con historial y reintento |
| 72 | Impresión múltiple y ZIP de PDFs | FALTA | Existe `lib/utils/zip.ts` (Libro IVA) | |
| 73 | Registración ARCA masiva | HECHO (mejor que IM5) | La cola es automática, registra en orden por serie y permite reprocesar (ADR-072) | |
| 74 | Importación de comprobantes históricos desde Excel | FALTA | El motor TX-4 (ADR-078) importa sólo datos maestros | Importar facturas, NC y ND históricas (migración desde otro sistema) |

## J. No aplica

| Capacidad IM5 | Motivo |
|---|---|
| CC1 / CC2 y destino Mostrador en CC2 | Doble circuito fiscal y no fiscal: no corresponde a un SaaS que audita todo |
| Destinos Manual y Preimpreso (talonario con CAI) | Comprobantes en papel heredados de IM4: el SaaS emite electrónico o ticket no fiscal |
| Controlador fiscal y "Facturas fiscales sin imprimir" | Hardware fiscal heredado, con agente local; NinjaPOS va por WSFE y CAEA |
| Recibo múltiple de intermediarios (corredores) | Circuito de acopio y corretaje propio de La Jamonera e IM4 |
| Nota de venta líquido producto | Liquidación de acopio o consignación al productor; nicho agro |
| Informe de recepción como comprobante aparte | NinjaPOS lo resuelve dentro de la devolución, con destino de stock |
| Tope de 20.000 o 50.000 filas y columnas "numeración IM4" en la importación | Limitaciones y compatibilidad propias de IM5 |
| Tope de renglones por comprobante | Limitación técnica de IM5 |

## Conteo

HECHO 34 · PARCIAL 12 · EN ROADMAP 7 · FALTA 21 · NO APLICA 8. Son filas de capacidad; los HECHO incluyen 6 donde NinjaPOS es mejor que IM5 (#5, #8, #21, #42, #54 y #73).
